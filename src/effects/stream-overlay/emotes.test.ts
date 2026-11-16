import { describe, expect, it } from "vitest";
import { createScope } from "../gl";
import type { AnyParamValues } from "../types";
import { EMOTE_IDS, paintEmote } from "./emote-art";
import { BURST_MIN } from "./emote-sim";
import { emotesOverlay } from "./emotes";
import type { OverlayCanvas, OverlayInstance, OverlayView } from "./overlay-layer";
import { computeOverlayLayout } from "./overlay-layout";
import { streamOverlayParams } from "./overlay-params.meta";
import { createStreamEvents, type StreamEventKinds } from "./stream-events";

const DT = 1 / 30;
const FIRST_CELL = 7;

/** [cell, cx, cy, half, angle, alpha, back (1 or 0)] */
type Sprite = number[];

function setup(width = 1920, height = 1080) {
  const layout = computeOverlayLayout(width, height);
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
    target: () => layout.full,
    shown: () => layout.full,
  };
  const schema = streamOverlayParams({ ovEmotes: true });
  const values: AnyParamValues = Object.fromEntries(
    Object.entries(schema).map(([k, d]) => [k, d.default]),
  );
  const events = createStreamEvents();
  const reserved: { count: number; paint: unknown }[] = [];
  const instance: OverlayInstance = emotesOverlay.create({
    gl: {} as WebGL2RenderingContext,
    scope: createScope(),
    reserveSprites: (count, paint) => {
      reserved.push({ count, paint });
      return FIRST_CELL;
    },
    events,
  });
  const stream = { every: 20, kinds: "all" as StreamEventKinds };
  let panels = 0;
  const frame = (dt = DT) => {
    events.step(dt, stream.every, stream.kinds);
    instance.update(dt, values, view);
  };
  const sprites = (): Sprite[] => {
    const out: Sprite[] = [];
    instance.drawGl?.(
      {
        panel: () => {
          panels++;
        },
        sprite: (cell, cx, cy, half, angle, alpha, back = false) => {
          out.push([cell, cx, cy, half, angle, alpha, back ? 1 : 0]);
        },
      },
      view,
    );
    return out;
  };
  return {
    instance,
    events,
    stream,
    view,
    values,
    layout,
    reserved,
    frame,
    sprites,
    panels: () => panels,
  };
}

describe("emotesOverlay", () => {
  it("reserves the shared emote designs in the sprite atlas", () => {
    const { reserved } = setup();
    expect(reserved).toEqual([{ count: EMOTE_IDS.length, paint: paintEmote }]);
  });

  it("draws nothing on the canvas", () => {
    const { instance, view, frame } = setup();
    const clears: number[][] = [];
    const canvas: OverlayCanvas = {
      ctx: {} as OffscreenCanvasRenderingContext2D,
      clear: (...args) => {
        clears.push(args);
      },
    };
    for (let i = 0; i < 60; i++) {
      frame();
      instance.draw2d(canvas, view, i === 0);
    }
    expect(clears).toEqual([]);
  });

  it.each([
    [1920, 1080],
    [1080, 1920],
  ])("sends emotes up the outer thirds, behind the panels, at %ix%i", (w, h) => {
    const { frame, sprites, layout, panels, values } = setup(w, h);
    values.emoteRate = 1;
    let seen = 0;
    let lowest = Infinity;
    for (let i = 0; i < 600; i++) {
      frame();
      for (const [cell, x, y, , , alpha, back] of sprites()) {
        seen++;
        lowest = Math.min(lowest, y);
        expect(cell).toBeGreaterThanOrEqual(FIRST_CELL);
        expect(cell).toBeLessThan(FIRST_CELL + EMOTE_IDS.length);
        expect(back).toBe(1);
        expect(alpha).toBeGreaterThan(0);
        expect(alpha).toBeLessThanOrEqual(1);
        expect(x < layout.edgeLeft.w || x > layout.edgeRight.x).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(100);
    // They rise most of the way up.
    expect(lowest).toBeLessThan(0.3 * h);
    expect(panels()).toBe(0);
  });

  it("fades with the overlay", () => {
    const { frame, sprites, view, values } = setup();
    values.emoteRate = 1;
    for (let i = 0; i < 300; i++) {
      frame();
    }
    const full = sprites();
    view.fade = 0.5;
    const half = sprites();
    expect(full.length).toBeGreaterThan(0);
    expect(half.map((s) => s[5])).toEqual(full.map((s) => s[5] * 0.5));
  });

  it("sends a burst of one emote a moment after a gift, and none with bursts off", () => {
    const counts = [true, false].map((bursts) => {
      const { frame, sprites, stream, values, events } = setup();
      values.emoteRate = 0;
      values.emoteBursts = bursts;
      stream.kinds = "gifts";
      let giftAt = -1;
      let t = 0;
      while (giftAt < 0 && t < 40) {
        frame();
        t += DT;
        if (events.fresh.some((e) => e.kind === "gift")) {
          giftAt = t;
        }
      }
      expect(giftAt).toBeGreaterThan(0);
      // The wall's own hype comes later than this.
      expect(giftAt).toBeLessThan(40);
      let before = 0;
      for (let i = 0; i < Math.round(0.9 / DT); i++) {
        frame();
        before += sprites().length;
      }
      expect(before).toBe(0);
      for (let i = 0; i < Math.round(2.5 / DT); i++) {
        frame();
      }
      const now = sprites();
      return { count: now.length, emotes: new Set(now.map((s) => s[0])).size };
    });
    expect(counts[0].count).toBeGreaterThanOrEqual(BURST_MIN);
    expect(counts[0].emotes).toBe(1);
    expect(counts[1].count).toBe(0);
  });

  it("eases a size change rather than jumping", () => {
    const steady = setup();
    const changed = setup();
    const both = (n: number) => {
      for (let i = 0; i < n; i++) {
        steady.frame();
        changed.frame();
      }
    };
    steady.values.emoteRate = 1;
    changed.values.emoteRate = 1;
    both(300);
    changed.values.emoteSize = 1.5;
    both(1);
    const halves = (s: Sprite[]) => s.map((x) => x[3]);
    const a = halves(steady.sprites());
    const b = halves(changed.sprites());
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBe(a.length);
    const grew = b.map((h, i) => h / a[i]);
    expect(Math.max(...grew)).toBeGreaterThan(1);
    expect(Math.max(...grew)).toBeLessThan(1.05);
    both(30);
    const later = halves(changed.sprites()).map((h, i) => h / halves(steady.sprites())[i]);
    expect(Math.min(...later)).toBeGreaterThan(1.3);
  });
});
