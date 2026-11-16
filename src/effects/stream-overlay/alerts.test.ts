import { beforeEach, describe, expect, it } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { createScope } from "../gl";
import type { AnyParamValues } from "../types";
import { ALERT_HOLD_SECONDS, ALERT_IN_SECONDS, ALERT_OUT_SECONDS } from "./alert-schedule";
import { alertsOverlay } from "./alerts";
import type { OverlayCanvas, OverlayInstance, OverlayView } from "./overlay-layer";
import { computeOverlayLayout, type Rect } from "./overlay-layout";
import { streamOverlayParams } from "./overlay-params.meta";
import type { OverlaySlot } from "./overlay-types.meta";
import { createStreamEvents, type StreamEventKinds } from "./stream-events";

const DT = 1 / 60;
const SHOW = ALERT_IN_SECONDS + ALERT_HOLD_SECONDS + ALERT_OUT_SECONDS;

const inside = (r: Rect, outer: Rect) =>
  r.x >= outer.x &&
  r.y >= outer.y &&
  r.x + r.w <= outer.x + outer.w &&
  r.y + r.h <= outer.y + outer.h;

interface Quads {
  panels: number[][];
  /** [cell, cx, cy, half, angle, alpha, back (1 or 0), flip] */
  sprites: number[][];
}

function setup(width = 1920, height = 1080) {
  MeasuringCanvas.reset();
  const layout = computeOverlayLayout(width, height);
  const slot = (s: OverlaySlot): Rect =>
    s === "column" ? layout.columnLeft : s === "edges" ? layout.full : layout[s];
  const view: { -readonly [K in keyof OverlayView]: OverlayView[K] } = {
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
  const schema = streamOverlayParams({ ovAlerts: true });
  const values: AnyParamValues = Object.fromEntries(
    Object.entries(schema).map(([k, d]) => [k, d.default]),
  );
  const events = createStreamEvents();
  let firstCell = -1;
  const instance: OverlayInstance = alertsOverlay.create({
    gl: {} as WebGL2RenderingContext,
    scope: createScope(),
    reserveSprites: (count) => {
      firstCell = 10;
      expect(count).toBe(7);
      return firstCell;
    },
    events,
  });
  /** The stream's average gap and kinds, as the layer would read them. */
  const stream = { every: 20, kinds: "all" as StreamEventKinds };
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
    events.step(dt, stream.every, stream.kinds);
    instance.update(dt, values, view);
    pending = [];
    instance.draw2d(canvas, view, first);
    first = false;
    clears.push(pending);
  };
  const quads = (): Quads => {
    const out: Quads = { panels: [], sprites: [] };
    instance.drawGl?.(
      {
        panel: (...args) => {
          out.panels.push(args.slice(0, 9).map(Number));
        },
        sprite: (cell, cx, cy, half, angle, alpha, back = false, flip = 1) => {
          out.sprites.push([cell, cx, cy, half, angle, alpha, back ? 1 : 0, flip]);
        },
      },
      view,
    );
    return out;
  };
  /** Runs until an alert's banner is queued, returning the name in the latest event. */
  const untilAlert = (limit = 600) => {
    let name = "";
    for (let t = 0; t < limit; t += DT) {
      frame();
      name = events.fresh.at(-1)?.name ?? name;
      if (quads().panels.length > 0) {
        return name;
      }
    }
    throw new Error("No alert came");
  };
  const said = () =>
    MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));
  return { instance, events, stream, view, values, layout, clears, frame, quads, untilAlert, said };
}

describe("alertsOverlay", () => {
  beforeEach(() => {
    MeasuringCanvas.reset();
  });

  it("shows nothing until an event comes", () => {
    const { frame, quads, clears } = setup();
    frame();
    frame();
    expect(quads()).toEqual({ panels: [], sprites: [] });
    expect(clears.flat()).toEqual([]);
  });

  it.each([
    [1920, 1080],
    [3840, 2160],
    [1080, 1920],
    [2560, 1080],
  ])(
    "drops a banner naming the event's viewer into the top centre, once drawn, at %ix%i",
    (w, h) => {
      const { frame, quads, untilAlert, said, clears, layout } = setup(w, h);
      const name = untilAlert();
      const text = said().join(" ");
      expect(name).not.toBe("");
      expect(text).toContain(name);
      const [panel] = quads().panels;
      const src = { x: panel[0], y: panel[1], w: panel[2], h: panel[3] };
      expect(inside(src, layout.topCentre)).toBe(true);
      expect(src.w).toBeLessThanOrEqual(w / 3);
      // Coming in from above, faint at first.
      expect(panel[5]).toBeLessThan(panel[1]);
      expect(panel[8]).toBeLessThan(0.2);
      for (let t = 0; t < ALERT_IN_SECONDS + 1; t += DT) {
        frame();
      }
      // At rest: texel for texel, fully shown.
      const [rest] = quads().panels;
      expect(rest.slice(4, 8)).toEqual(rest.slice(0, 4));
      expect(rest[8]).toBe(1);
      // The canvas was touched for this alert once.
      expect(clears.filter((c) => c.length > 0)).toHaveLength(1);
    },
  );

  it("throws confetti behind the panels, and a sheen across the banner", () => {
    const { frame, quads, untilAlert } = setup();
    untilAlert();
    let confetti = 0;
    let sheen = 0;
    for (let t = 0; t < SHOW; t += DT) {
      frame();
      const { sprites } = quads();
      const back = sprites.filter((s) => s[6] === 1);
      confetti = Math.max(confetti, back.length);
      sheen += sprites.filter((s) => s[6] === 0).length;
      for (const s of back) {
        expect(s[0]).toBeGreaterThanOrEqual(10);
        expect(s[0]).toBeLessThan(16);
      }
      for (const s of sprites.filter((x) => x[6] === 0)) {
        expect(s[0]).toBe(16);
        expect(s[5]).toBeLessThanOrEqual(0.2);
      }
    }
    expect(confetti).toBeGreaterThanOrEqual(20);
    expect(confetti).toBeLessThanOrEqual(60);
    expect(sheen).toBeGreaterThan(30);
  });

  it("throws no confetti and no sheen in the minimal style", () => {
    const { values, frame, quads, untilAlert } = setup();
    values.alertStyle = "minimal";
    untilAlert();
    for (let t = 0; t < SHOW; t += DT) {
      frame();
      expect(quads().sprites).toEqual([]);
    }
  });

  it("only shows the picked kinds", () => {
    const { events, values, stream, frame, quads } = setup();
    // The stream still holds every kind (as it would just after a change).
    values.alertKinds = "gifts";
    let shown = 0;
    let gifts = 0;
    for (let t = 0; t < 400; t += DT) {
      frame();
      gifts += events.fresh.filter((e) => e.kind === "gift").length;
      if (quads().panels.length > 0) {
        shown++;
      }
    }
    expect(stream.kinds).toBe("all");
    expect(events.count).toBeGreaterThan(gifts);
    expect(shown * DT).toBeLessThanOrEqual(gifts * (SHOW + 0.1));
  });

  it("uses the viewer's own lines with a made-up name", () => {
    const { values, frame, said } = setup();
    values.alertText = "Welcome in, {name}!";
    for (let t = 0; t < 600; t += DT) {
      frame();
    }
    expect(said().some((t) => /^Welcome in, \w+!$/.test(t))).toBe(true);
    expect(said().some((t) => t.includes("{name}"))).toBe(false);
  });

  it("lets the banner go smoothly when switched off mid-alert, and queues nothing while off", () => {
    const { view, frame, quads, untilAlert, events } = setup();
    untilAlert();
    for (let t = 0; t < 2; t += DT) {
      frame();
    }
    view.on = false;
    const alphas: number[] = [];
    for (let t = 0; t < 0.5; t += DT) {
      frame();
      alphas.push(quads().panels[0]?.[8] ?? 0);
    }
    expect(alphas[0]).toBeGreaterThan(0.9);
    expect(alphas.at(-1)).toBe(0);
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1]);
      expect(alphas[i - 1] - alphas[i]).toBeLessThan(0.15);
    }
    const before = events.count;
    for (let t = 0; t < 120; t += DT) {
      frame();
    }
    expect(events.count).toBeGreaterThan(before);
    view.on = true;
    frame();
    expect(quads().panels).toEqual([]);
  });
});
