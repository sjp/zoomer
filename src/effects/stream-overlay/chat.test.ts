import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { beginFrame, createScope } from "../gl";
import type { AnyParamValues } from "../types";
import { CHAT_STEP_EASE_SECONDS, chatOverlay, wrapChatTokens } from "./chat";
import { CHAT_STEP_SECONDS, chatTokens } from "./chat-feed";
import { emoteIndex } from "./emote-art";
import {
  createStreamOverlays,
  type OverlayCanvas,
  type OverlayDraw,
  type OverlayInstance,
  type OverlayView,
} from "./overlay-layer";
import { computeOverlayLayout, type Rect } from "./overlay-layout";
import { streamOverlayParams } from "./overlay-params.meta";
import { createStreamEvents } from "./stream-events";

const DT = 1 / 60;

/** Measures 10 px per character, as a fixed-width font would. */
const measure = (text: string) => Array.from(text).length * 10;

describe("wrapChatTokens", () => {
  it("joins the words of a line into one run", () => {
    const out = wrapChatTokens(chatTokens("hi there chat"), 50, 300, measure, 22, 16);
    expect(out.lines).toBe(1);
    expect(out.placed).toEqual([
      { x: 60, line: 0, text: "hi there chat", emote: -1, maxWidth: 131 },
    ]);
  });

  it("wraps onto a second line and places emotes between runs", () => {
    const out = wrapChatTokens(chatTokens("one two :heart: three four"), 100, 260, measure, 20, 16);
    expect(out.lines).toBe(2);
    expect(out.placed.map((p) => [p.line, p.text, p.emote])).toEqual([
      [0, "one two", -1],
      [0, ":heart:", emoteIndex("heart")],
      [1, "three four", -1],
    ]);
    expect(out.placed[1].x).toBe(100 + 10 + 70 + 10);
    expect(out.placed[2].x).toBe(0);
  });

  it("cuts what doesn't fit on the second line, for the ellipsis", () => {
    const words = Array.from({ length: 12 }, () => "word").join(" ");
    const out = wrapChatTokens(chatTokens(words), 100, 200, measure, 20, 16);
    expect(out.lines).toBe(2);
    const last = out.placed.at(-1);
    expect(last?.line).toBe(1);
    // The whole rest of the message, to be cut to the room left.
    expect(last?.maxWidth).toBe(200);
    expect(measure(last?.text ?? "")).toBeGreaterThan(200);
  });

  it("ends with an ellipsis when an emote doesn't fit on the second line", () => {
    const tokens = chatTokens(`${"x".repeat(10)} ${"y".repeat(17)} :fire:`);
    const out = wrapChatTokens(tokens, 50, 200, measure, 30, 16);
    expect(out.placed.at(-1)).toMatchObject({ line: 1, text: "…", emote: -1 });
  });

  it("puts everything on one line without text metrics", () => {
    const out = wrapChatTokens(chatTokens("a b c :wow: d e f"), 0, 100, () => 0, 0, 16);
    expect(out.lines).toBe(1);
  });
});

function setup(busy = 1) {
  MeasuringCanvas.reset();
  const layout = computeOverlayLayout(1920, 1080);
  const target = layout.columnLeft;
  const view: OverlayView = {
    width: 1920,
    height: 1080,
    scale: 1,
    layout,
    on: true,
    fade: 1,
    side: "left",
    accent: "#a48cf0",
    accentRgb: [0.64, 0.55, 0.94],
    opacity: 0.85,
    target: () => target,
    shown: () => target,
  };
  const schema = streamOverlayParams({ ovChat: true });
  const values: AnyParamValues = Object.fromEntries(
    Object.entries(schema).map(([k, d]) => [k, d.default]),
  );
  values.chatBusy = busy;
  const events = createStreamEvents();
  /** The stream's average gap, as the layer would read it. */
  const stream = { every: 60 };
  const instance: OverlayInstance = chatOverlay.create({
    gl: {} as WebGL2RenderingContext,
    scope: createScope(),
    reserveSprites: () => 0,
    events,
  });
  const clears: Rect[][] = [];
  let pending: Rect[] = [];
  const canvas: OverlayCanvas = {
    ctx: new MeasuringCanvas(
      1920,
      1080,
    ).getContext() as unknown as OffscreenCanvasRenderingContext2D,
    clear: (x, y, w, h) => {
      pending.push({ x, y, w, h });
    },
  };
  let first = true;
  const frame = (dt = DT) => {
    events.step(dt, stream.every, "all");
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
  /** The panel quads queued this frame, as [sx, sy, sw, sh, dx, dy, dw, dh, alpha]. */
  const quads = (v: OverlayView = view) => {
    const out: number[][] = [];
    const draw: OverlayDraw = {
      panel: (...args) => {
        out.push(args.slice(0, 9).map(Number));
      },
      sprite: () => undefined,
    };
    instance.drawGl?.(draw, v);
    return out;
  };
  return { instance, events, stream, view, values, clears, frame, run, quads, target };
}

describe("chatOverlay", () => {
  beforeEach(() => {
    MeasuringCanvas.reset();
  });

  it("draws the header, the messages and the footer whole at first", () => {
    const { frame, clears, target } = setup();
    frame();
    expect(clears[0]).toHaveLength(3);
    const [header, messages, footer] = clears[0];
    expect(header.y).toBe(target.y);
    expect(messages.y).toBe(header.y + header.h);
    expect(footer.y).toBe(messages.y + messages.h);
    expect(footer.y + footer.h).toBe(target.y + target.h);
    const said = MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => c.args[0]);
    expect(said).toContain("Chat");
    // The column starts full of messages.
    expect(said.filter((t) => t === ":").length).toBeGreaterThan(10);
  });

  it("shows the stream's events as highlighted lines under the same names", () => {
    const { events, stream, frame } = setup(0);
    stream.every = 20;
    const names: string[] = [];
    for (let t = 0; t < 120; t += DT) {
      frame();
      for (const e of events.fresh) {
        names.push(e.name);
      }
    }
    expect(names.length).toBeGreaterThan(2);
    const said = MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => c.args[0]);
    for (const name of names) {
      expect(said).toContain(name);
    }
    expect(said.some((t) => /^(followed|subscribed|gifted|hosting)/.test(String(t)))).toBe(true);
  });

  it("redraws the messages once per step, never while they move, under twice a second", () => {
    const { run, clears } = setup(1);
    run(30);
    // After the first frame's whole drawing, only the message area.
    const redraws = clears.slice(1).map((c) => c.length);
    expect(Math.max(...redraws)).toBe(1);
    const at = redraws.flatMap((n, i) => (n > 0 ? [i * DT] : []));
    expect(at.length).toBeGreaterThan(30);
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(CHAT_STEP_SECONDS - 2 * DT);
    }
  });

  it("stays within its column, copying texel for texel at rest", () => {
    const { frame, run, quads, target } = setup(0);
    frame();
    run(0.2);
    const qs = quads();
    // Header, background, footer, then the message bands.
    expect(qs.length).toBeGreaterThan(5);
    for (const [sx, sy, sw, sh, dx, dy, dw, dh] of qs) {
      expect(sx).toBe(target.x);
      expect(sw).toBe(target.w);
      expect(dx).toBe(target.x);
      expect(dw).toBe(target.w);
      expect(sy).toBeGreaterThanOrEqual(target.y);
      expect(sy + sh).toBeLessThanOrEqual(target.y + target.h + 1e-9);
      expect(dy).toBeGreaterThanOrEqual(target.y);
      expect(dy + dh).toBeLessThanOrEqual(target.y + target.h + 1e-9);
    }
    const bands = qs.slice(3);
    const shift = bands[0][5] - bands[0][1];
    for (const [, sy, , sh, , dy, , dh] of bands) {
      expect(dh).toBe(sh);
      expect(dy - sy).toBe(shift);
      expect(Number.isInteger(dy)).toBe(true);
    }
    // The bands run on from the header to the footer without a gap, fading in at the top.
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i][5]).toBe(bands[i - 1][5] + bands[i - 1][7]);
      expect(bands[i][8]).toBeGreaterThanOrEqual(bands[i - 1][8]);
    }
    expect(bands[0][8]).toBeLessThan(0.2);
    expect(bands.at(-1)?.[8]).toBe(1);
  });

  it("steps up by the new lines' height, eased, with the new lines fading in", () => {
    const { frame, quads, clears } = setup(1);
    frame();
    const rest = quads().slice(3);
    const restShift = rest[0][5] - rest[0][1];
    let guard = 0;
    while (clears.at(-1)?.length !== 1 && guard++ < 600) {
      frame();
    }
    const offsets: number[] = [];
    const fades: number[] = [];
    for (let t = 0; t <= CHAT_STEP_EASE_SECONDS + 3 * DT; t += DT) {
      const bands = quads().slice(3);
      const last = bands.at(-1) ?? [];
      // The bottom band's shift from its canvas row, beyond its shift at rest: the step to go.
      offsets.push(last[5] - last[1] - restShift);
      fades.push(last[8]);
      frame();
    }
    // Starts where the old lines were and eases to rest, never back.
    expect(offsets[0]).toBeGreaterThan(20);
    expect(offsets.at(-1)).toBe(0);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeLessThanOrEqual(offsets[i - 1]);
    }
    // The new lines start hidden below the old ones, then fade in as they rise.
    expect(fades[0]).toBe(1);
    expect(fades[1]).toBeLessThan(0.1);
    for (let i = 2; i < fades.length; i++) {
      expect(fades[i]).toBeGreaterThan(fades[i - 1]);
    }
  });

  it("redraws only the header when the title changes", () => {
    const { frame, values, clears, target } = setup(0);
    frame();
    values.chatTitle = "Friends";
    frame();
    expect(clears.at(-1)).toEqual([{ x: target.x, y: target.y, w: target.w, h: 40 }]);
    const said = MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => c.args[0]);
    expect(said.at(-1)).toBe("Friends");
  });

  it("shows the viewer's own lines", () => {
    const { values, run } = setup(1);
    values.chatLines = "hello from the owner";
    run(60);
    const said = MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => c.args[0]);
    expect(said).toContain("hello from the owner");
  });
});

describe("chat and splits together", () => {
  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
    MeasuringCanvas.reset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["right", "right"],
    ["left", "left"],
  ])("take a column each when both want the %s (splits keeps it)", (side) => {
    const fake = createFakeGl();
    const scope = createScope();
    const layer = createStreamOverlays(fake.gl, scope);
    layer.resize({ width: 1920, height: 1080, scale: 1 });
    const schema = streamOverlayParams({ ovChat: true, ovSplits: true });
    const values: AnyParamValues = Object.fromEntries(
      Object.entries(schema).map(([k, d]) => [k, d.default]),
    );
    values.chatSide = side;
    values.splitsSide = side;
    for (let i = 0; i < 30; i++) {
      beginFrame(fake.gl, 1920, 1080);
      layer.frame(DT, values);
    }
    const textX = (text: string) =>
      MeasuringCanvas.calls.find((c) => c.method === "fillText" && c.args[0] === text)?.args[1];
    const layout = layer.layout;
    const splits = side === "left" ? layout.columnLeft : layout.columnRight;
    const chat = side === "left" ? layout.columnRight : layout.columnLeft;
    const inside = (x: unknown, r: Rect) => Number(x) > r.x && Number(x) < r.x + r.w;
    expect(inside(textX("Chat"), chat)).toBe(true);
    expect(inside(textX("Speedrun"), splits)).toBe(true);
    scope.dispose();
    expect(fake.live()).toEqual([]);
    expect(fake.errors).toEqual([]);
  });
});
