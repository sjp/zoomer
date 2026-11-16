import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { createScope } from "../gl";
import type { AnyParamValues } from "../types";
import {
  createUptimeClock,
  formatUptime,
  frameGeometry,
  frameOverlay,
  TICKER_FADE_SECONDS,
  TICKER_TURN_SECONDS,
} from "./frame";
import type { OverlayCanvas, OverlayInstance, OverlayView } from "./overlay-layer";
import { computeOverlayLayout, type Rect } from "./overlay-layout";
import { streamOverlayParams } from "./overlay-params.meta";
import type { OverlaySlot } from "./overlay-types.meta";
import { createStreamEvents, type StreamEventKinds } from "./stream-events";

const DT = 1 / 60;

const inside = (r: Rect, outer: Rect) =>
  r.x >= outer.x &&
  r.y >= outer.y &&
  r.x + r.w <= outer.x + outer.w &&
  r.y + r.h <= outer.y + outer.h;

describe("frameGeometry", () => {
  it.each([
    [1920, 1080],
    [3840, 2160],
    [1440, 1080],
    [2560, 1080],
    [1080, 1920],
    [1000, 1000],
    [320, 180],
    [60, 40],
  ])("keeps the border and its glow inside the border slot at %ix%i", (w, h) => {
    const layout = computeOverlayLayout(w, h);
    const border = layout.border;
    const s = h / 1080;
    const { line, strip } = frameGeometry(border, s);
    expect(inside(line, border)).toBe(true);
    // Room for the glow and brackets outside the line, unless the slot is tiny.
    const room = Math.min(line.x - border.x, line.y - border.y);
    expect(room).toBeGreaterThanOrEqual(
      Math.min(Math.round(28 * s), Math.floor(Math.min(border.w, border.h) / 6)),
    );
    expect(line.x + line.w).toBe(border.x + border.w - (line.x - border.x));
    // The strips hold the line, and the opposite ones never overlap.
    expect(strip).toBeGreaterThan(line.x - border.x);
    expect(2 * strip).toBeLessThanOrEqual(Math.min(border.w, border.h));
    expect(inside(border, layout.speaker)).toBe(true);
  });
});

describe("formatUptime", () => {
  it.each([
    [0, "0:00:00"],
    [59.9, "0:00:59"],
    [5047, "1:24:07"],
    [86_399, "23:59:59"],
    [-5, "0:00:00"],
    [Number.NaN, "0:00:00"],
  ])("shows %f s as %s", (s, text) => {
    expect(formatUptime(s)).toBe(text);
  });
});

describe("createUptimeClock", () => {
  beforeAll(() => {
    vi.stubEnv("TZ", "Europe/London");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 10, d, h, m, s).getTime();
  const pageLoad = at(16, 9, 0);

  it.each([
    ["19:30", at(16, 20, 54, 7), 5047],
    ["7:30pm", at(16, 20, 54, 7), 5047],
    // Before midnight, the start was earlier today; after it, yesterday.
    ["23:30", at(16, 23, 45), 15 * 60],
    ["23:30", at(17, 0, 15), 45 * 60],
    ["0:30", at(17, 0, 15), 23 * 3600 + 45 * 60],
    ["0:30", at(17, 0, 30), 0],
  ])("counts from %s", (from, now, seconds) => {
    expect(createUptimeClock(pageLoad).read(from, now)).toBe(seconds);
  });

  it.each(["", "soon", "25:00", "9:60", "13:00pm"])("counts from page load given %j", (from) => {
    expect(createUptimeClock(pageLoad).read(from, at(16, 10, 2, 3))).toBe(3723);
  });

  it("stays under a day, starting again when the time comes round", () => {
    const clock = createUptimeClock(pageLoad);
    expect(clock.read("8:00", at(16, 8, 0))).toBe(0);
    expect(clock.read("8:00", at(17, 7, 59, 59))).toBe(86_399);
    expect(clock.read("8:00", at(17, 8, 0))).toBe(0);
    expect(clock.read("8:00", at(17, 8, 0, 9))).toBe(9);
  });

  it("follows an edit on its next reading", () => {
    const clock = createUptimeClock(pageLoad);
    expect(clock.read("9:00", at(16, 10, 0))).toBe(3600);
    expect(clock.read("9:30", at(16, 10, 0))).toBe(1800);
    expect(clock.read("", at(16, 10, 0))).toBe(3600);
  });
});

function setup(width = 1920, height = 1080) {
  MeasuringCanvas.reset();
  const layout = computeOverlayLayout(width, height);
  const slot = (s: OverlaySlot): Rect =>
    s === "column" ? layout.columnLeft : s === "edges" ? layout.full : layout[s];
  const view: OverlayView = {
    width,
    height,
    scale: height / 1080,
    layout,
    on: true,
    fade: 1,
    side: null,
    accent: "#a48cf0",
    accentRgb: [0.64, 0.55, 0.94],
    opacity: 0.85,
    target: slot,
    shown: slot,
  };
  const schema = streamOverlayParams({ ovFrame: true });
  const values: AnyParamValues = Object.fromEntries(
    Object.entries(schema).map(([k, d]) => [k, d.default]),
  );
  const events = createStreamEvents();
  const instance: OverlayInstance = frameOverlay.create({
    gl: {} as WebGL2RenderingContext,
    scope: createScope(),
    reserveSprites: () => 0,
    events,
  });
  /** The stream's average gap and kinds, as the layer would read them. */
  const stream = { every: 60, kinds: "all" as StreamEventKinds };
  const clears: Rect[][] = [];
  let pending: Rect[] = [];
  const canvas: OverlayCanvas = {
    ctx: new MeasuringCanvas(
      width,
      height,
    ).getContext() as unknown as OffscreenCanvasRenderingContext2D,
    clear: (x, y, w, h) => {
      pending.push({ x, y, w, h });
    },
  };
  let first = true;
  const frame = (dt = DT) => {
    vi.advanceTimersByTime(dt * 1000);
    events.step(dt, stream.every, stream.kinds);
    instance.update(dt, values, view);
    pending = [];
    instance.draw2d(canvas, view, first);
    first = false;
    clears.push(pending);
  };
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      frame();
    }
  };
  /** The quads queued this frame: [sx, sy, sw, sh, dx, dy, dw, dh, alpha, back]. */
  const quads = () => {
    const out: (number | boolean)[][] = [];
    instance.drawGl?.(
      {
        panel: (...args) => {
          out.push([...args.slice(0, 9).map(Number), args[9] === true]);
        },
        sprite: () => undefined,
      },
      view,
    );
    return out;
  };
  const said = () =>
    MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));
  return { instance, events, stream, view, values, layout, clears, frame, run, quads, said };
}

const asRect = (q: (number | boolean)[]) => ({
  x: Number(q[0]),
  y: Number(q[1]),
  w: Number(q[2]),
  h: Number(q[3]),
});

describe("frameOverlay", () => {
  beforeEach(() => {
    MeasuringCanvas.reset();
    vi.setSystemTime(new Date(2026, 10, 16, 20, 0, 0, 500));
  });

  it("draws the goal, the clock and the ticker", () => {
    const { frame, said } = setup();
    frame();
    const text = said().join("");
    expect(text).toContain("Follower goal");
    expect(text).toContain("80 / 100");
    expect(text).toContain("LIVE");
    expect(said()).toContain("Latest follower:");
  });

  it("counts the uptime from uptimeFrom", () => {
    const { values, frame, said } = setup();
    values.uptimeFrom = "18:35";
    frame();
    expect(said().join("")).toContain("1:25:00");
  });

  it.each([
    [1920, 1080],
    [1080, 1920],
    [2560, 1080],
  ])("queues each part inside its own slot at %ix%i", (w, h) => {
    const { frame, quads, layout } = setup(w, h);
    frame();
    const qs = quads();
    expect(qs).toHaveLength(7);
    const border = qs.filter((q) => q[9] === true);
    expect(border).toHaveLength(4);
    for (const q of border) {
      expect(inside(asRect(q), layout.border)).toBe(true);
    }
    // Strips round the edge, leaving the middle empty.
    const strip = Math.min(...border.map((q) => Math.min(Number(q[2]), Number(q[3]))));
    const b = layout.border;
    expect((b.w - 2 * strip) * (b.h - 2 * strip)).toBeGreaterThan(0.4 * b.w * b.h);
    const [goal, clock, ticker] = qs.filter((q) => q[9] === false);
    expect(inside(asRect(goal), layout.topLeft)).toBe(true);
    expect(inside(asRect(clock), layout.topRight)).toBe(true);
    expect(inside(asRect(ticker), layout.topRight)).toBe(true);
    expect(Number(ticker[1])).toBeGreaterThanOrEqual(Number(clock[1]) + Number(clock[3]));
    for (const q of qs) {
      // At rest, texel for texel at full fade.
      expect(q.slice(4, 8)).toEqual(q.slice(0, 4));
      expect(q[8]).toBe(1);
    }
  });

  it("redraws only the clock's rect, once a second, between events", () => {
    const { frame, run, clears } = setup();
    frame();
    run(10);
    const all = clears.slice(1).flat();
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(all.length).toBeLessThanOrEqual(11);
    for (const r of all) {
      expect(r).toEqual(all[0]);
    }
    expect(all[0].h).toBe(36);
  });

  it("ticks the goal and cross-fades the ticker to each new follower from the stream", () => {
    const { events, stream, frame, run, clears, said } = setup();
    stream.kinds = "follows";
    stream.every = 20;
    frame();
    const before = said().filter((t) => t === "Latest follower:").length;
    const firstName = said()[said().indexOf("Latest follower:") + 1];
    expect(firstName).toBe(events.latestFollow.name);
    const named: string[] = [];
    while (events.follows < 2) {
      frame();
      if (events.fresh.length > 0) {
        named.push(events.fresh[0].name);
      }
    }
    run(1);
    expect(said().join("")).toContain("82 / 100");
    const names = new Set(
      said().flatMap((t, i, all) => (all[i - 1] === "Latest follower:" ? [t] : [])),
    );
    expect([...names]).toEqual([firstName, ...named]);
    // The ticker's rect is redrawn for the fades' length, not for ever.
    const ticker = clears.flat().filter((r) => r.w > 300 && r.h === 36);
    const redraws = said().filter((t) => t === "Latest follower:").length - before;
    expect(ticker.length).toBeGreaterThanOrEqual(2 * (TICKER_FADE_SECONDS / DT));
    expect(ticker.length).toBeLessThan(6 * (TICKER_FADE_SECONDS / DT));
    // Mid-fade, both names are drawn.
    expect(redraws).toBeGreaterThan(ticker.length);
  });

  it("turns the ticker to the latest supporter and back", () => {
    const { events, stream, frame, run, said } = setup();
    stream.every = 300;
    frame();
    run(TICKER_TURN_SECONDS + 1);
    expect(said()).toContain("Latest supporter:");
    const supporter = said()[said().indexOf("Latest supporter:") + 1];
    expect(supporter).toBe(events.latestSupport.name);
    const from = said().length;
    run(TICKER_TURN_SECONDS);
    expect(said().slice(from)).toContain("Latest follower:");
  });

  it("turns the ticker to a new supporter as soon as one arrives", () => {
    const { events, stream, frame, said } = setup();
    stream.kinds = "gifts";
    stream.every = 20;
    frame();
    while (events.count === 0) {
      frame();
    }
    const from = said().length;
    frame();
    const after = said().slice(from);
    expect(after[after.indexOf("Latest supporter:") + 1]).toBe(events.latestSupport.name);
    expect(events.latestSupport.index).toBe(0);
  });

  it("fades a switched-off part out in place and stops redrawing it", () => {
    const { values, frame, run, quads, clears } = setup();
    frame();
    values.uptime = false;
    frame();
    const alpha = Number(quads()[5][8]);
    expect(alpha).toBeGreaterThan(0.9);
    expect(alpha).toBeLessThan(1);
    run(0.6);
    expect(quads()[5][8]).toBe(0);
    const from = clears.length;
    run(3);
    expect(clears.slice(from).flat()).toEqual([]);
    values.uptime = true;
    frame();
    // Back with the right time at once.
    expect(clears.at(-1)).toHaveLength(1);
  });

  it("dips the border out and in on a style change, redrawing only its strips", () => {
    const { values, frame, quads, clears, layout } = setup();
    frame();
    values.frameStyle = "neon";
    const alphas: number[] = [];
    let swapped: Rect[] = [];
    for (let i = 0; i < 60; i++) {
      frame();
      alphas.push(Number(quads()[0][8]));
      const big = (clears.at(-1) ?? []).filter((r) => inside(r, layout.border));
      if (big.length > 0) {
        swapped = big;
      }
    }
    const low = alphas.indexOf(Math.min(...alphas));
    expect(alphas[low]).toBeLessThan(0.05);
    expect(low * DT).toBeGreaterThan(0.3);
    expect(alphas.at(-1)).toBe(1);
    for (let i = 1; i <= low; i++) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1]);
    }
    expect(swapped).toHaveLength(4);
  });

  it("shows no border with the None style", () => {
    const { values, frame, quads } = setup();
    values.frameStyle = "none";
    frame();
    expect(quads().filter((q) => q[9] === true)).toEqual([]);
  });
});
