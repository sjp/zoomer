import { describe, expect, it } from "vitest";
import {
  assignColumns,
  computeOverlayLayout,
  createRectEase,
  freeCentre,
  MAX_BAND_FRACTION,
  type OverlayLayout,
  type Rect,
  rectsOverlap,
  SLOT_EASE_SECONDS,
  slotRect,
  type SlotUse,
} from "./overlay-layout";
import type { OverlaySide, OverlaySlot } from "./overlay-params.meta";

const ASPECTS = [
  ["16:9", 1920, 1080],
  ["4:3", 1440, 1080],
  ["21:9", 2520, 1080],
  ["9:16", 1080, 1920],
  ["16:9 4K", 3840, 2160],
  ["1:1", 1080, 1080],
  ["3:4", 1080, 1440],
] as const;

/** The planned overlays' slots, in registration order: two columns, the top band and border, alerts, emotes. */
const PLANNED: readonly (readonly OverlaySlot[])[] = [
  ["column"],
  ["column"],
  ["border", "topLeft", "topRight"],
  ["topCentre"],
  ["edges"],
];

const inside = (r: Rect, outer: Rect) =>
  r.x >= outer.x &&
  r.y >= outer.y &&
  r.x + r.w <= outer.x + outer.w &&
  r.y + r.h <= outer.y + outer.h;

const whole = (r: Rect) => [r.x, r.y, r.w, r.h].every((n) => Number.isInteger(n));

const SIDES: OverlaySide[] = ["left", "right"];

/** Every on/off combination of the planned overlays with every pair of wanted sides. */
const CASES = ASPECTS.flatMap(([name, w, h]) =>
  Array.from({ length: 32 }, (_, mask) =>
    SIDES.flatMap((a) => SIDES.map((b) => [name, mask, a, b, w, h] as const)),
  ).flat(),
);

/** Where each enabled overlay's pieces go: [overlay, slot, rect]. */
function place(layout: OverlayLayout, mask: number, wanted: OverlaySide[]) {
  const on = PLANNED.map((_, i) => (mask & (1 << i)) !== 0);
  const sides: (OverlaySide | null)[] = [null, null];
  assignColumns(wanted, [on[0], on[1]], sides);
  const pieces: [number, OverlaySlot, Rect][] = [];
  PLANNED.forEach((slots, i) => {
    if (!on[i]) {
      return;
    }
    for (const slot of slots) {
      if (slot === "edges") {
        pieces.push([i, slot, layout.edgeLeft], [i, slot, layout.edgeRight]);
      } else {
        pieces.push([i, slot, slotRect(layout, slot, sides[i] ?? "left")]);
      }
    }
  });
  return pieces;
}

describe("computeOverlayLayout", () => {
  it.each(ASPECTS)("puts every slot on whole pixels inside the %s frame", (_, w, h) => {
    const layout = computeOverlayLayout(w, h);
    const rects = [
      layout.speaker,
      layout.band,
      layout.topLeft,
      layout.topCentre,
      layout.topRight,
      layout.columnLeft,
      layout.columnRight,
      layout.border,
      layout.edgeLeft,
      layout.edgeRight,
    ];
    for (const r of rects) {
      expect(whole(r)).toBe(true);
      expect(inside(r, layout.full)).toBe(true);
      expect(r.w > 0 && r.h > 0).toBe(true);
    }
  });

  it.each(ASPECTS)("keeps the %s top band to 12 %% of the height", (_, w, h) => {
    const { band, topLeft, topCentre, topRight } = computeOverlayLayout(w, h);
    expect(band.y + band.h).toBeLessThanOrEqual(MAX_BAND_FRACTION * h + 0.5);
    for (const r of [topLeft, topCentre, topRight]) {
      expect(inside(r, band)).toBe(true);
    }
    expect(topCentre.w).toBeLessThanOrEqual(w / 3);
  });

  it.each(ASPECTS)("at %s, the speaker is the middle third below the band", (_, w, h) => {
    const { speaker, band, border, edgeLeft, edgeRight } = computeOverlayLayout(w, h);
    expect(speaker.x).toBe(Math.round(w / 3));
    expect(speaker.x + speaker.w).toBe(Math.round((2 * w) / 3));
    expect(speaker.y).toBe(band.y + band.h);
    expect(speaker.y + speaker.h).toBe(w < h ? Math.round(0.75 * h) : h);
    expect(inside(border, speaker)).toBe(true);
    expect(rectsOverlap(edgeLeft, speaker)).toBe(false);
    expect(rectsOverlap(edgeRight, speaker)).toBe(false);
  });

  it("stands the columns in the outer thirds on landscape frames", () => {
    const { columnLeft, columnRight, band } = computeOverlayLayout(1920, 1080);
    expect(columnLeft.x + columnLeft.w).toBeLessThanOrEqual(640);
    expect(columnRight.x).toBeGreaterThanOrEqual(1280);
    expect(columnLeft.y).toBeGreaterThan(band.y + band.h);
    expect(columnLeft.h).toBeGreaterThan(0.75 * 1080);
    expect(columnRight).toEqual({ ...columnLeft, x: columnRight.x });
  });

  it("moves the columns to the bottom quarter, side by side, on portrait frames", () => {
    const { columnLeft, columnRight } = computeOverlayLayout(1080, 1920);
    expect(columnLeft.y).toBeGreaterThanOrEqual(0.75 * 1920);
    expect(columnLeft.y).toBe(columnRight.y);
    expect(columnLeft.h).toBe(columnRight.h);
    expect(columnLeft.h).toBeLessThan(0.25 * 1920);
    expect(columnLeft.x + columnLeft.w).toBeLessThan(columnRight.x);
    expect(columnLeft.w).toBeGreaterThan(0.4 * 1080);
  });

  it("scales with the frame", () => {
    const hd = computeOverlayLayout(1920, 1080);
    const uhd = computeOverlayLayout(3840, 2160);
    expect(uhd.columnLeft.w).toBe(2 * hd.columnLeft.w);
    expect(uhd.band.h).toBeCloseTo(2 * hd.band.h, -1);
  });

  it("survives a degenerate frame", () => {
    const tiny = computeOverlayLayout(0, Number.NaN);
    expect(tiny.width).toBe(1);
    for (const r of [tiny.speaker, tiny.columnLeft, tiny.border, tiny.topCentre]) {
      expect(r.w >= 0 && r.h >= 0).toBe(true);
    }
  });
});

describe("placing every combination of overlays", () => {
  it.each(CASES)("%s, overlays %i, sides %s / %s: no overlaps", (_, mask, a, b, w, h) => {
    const layout = computeOverlayLayout(w, h);
    const pieces = place(layout, mask, [a, b]);
    const foreground = pieces.filter(([, slot]) => slot !== "edges" && slot !== "border");
    // Panels and bars keep out of the speaker area and off each other.
    for (const [i, slot, r] of foreground) {
      expect([i, slot, rectsOverlap(r, layout.speaker)]).toEqual([i, slot, false]);
    }
    for (let p = 0; p < foreground.length; p++) {
      for (let q = p + 1; q < foreground.length; q++) {
        expect(rectsOverlap(foreground[p][2], foreground[q][2])).toBe(false);
      }
    }
    // The border sits behind the speaker, clear of every panel; the edges stay out of the middle third.
    for (const [, slot, r] of pieces) {
      expect(slot === "border" ? inside(r, layout.speaker) : true).toBe(true);
      expect(slot === "edges" ? rectsOverlap(r, layout.speaker) : false).toBe(false);
    }
    for (const [, , r] of foreground) {
      expect(rectsOverlap(r, layout.border)).toBe(false);
    }
  });

  it("never covers the middle third below the band on landscape frames", () => {
    for (const [, w, h] of ASPECTS.filter(([, aw, ah]) => aw >= ah)) {
      const layout = computeOverlayLayout(w, h);
      const middle: Rect = {
        x: w / 3,
        y: layout.band.y + layout.band.h,
        w: w / 3,
        h: h - layout.band.y - layout.band.h,
      };
      for (const r of [layout.columnLeft, layout.columnRight, layout.edgeLeft, layout.edgeRight]) {
        expect(rectsOverlap(r, middle)).toBe(false);
      }
    }
  });
});

describe("assignColumns", () => {
  const assign = (wanted: OverlaySide[], occupying: boolean[]) => {
    const out: (OverlaySide | null)[] = wanted.map(() => null);
    assignColumns(wanted, occupying, out);
    return out;
  };

  it("gives each its own side when they differ", () => {
    expect(assign(["left", "right"], [true, true])).toEqual(["left", "right"]);
    expect(assign(["right", "left"], [true, true])).toEqual(["right", "left"]);
  });

  it("lets the earlier keep a shared side and moves the later", () => {
    expect(assign(["right", "right"], [true, true])).toEqual(["right", "left"]);
    expect(assign(["left", "left"], [true, true])).toEqual(["left", "right"]);
  });

  it("gives the later its own side back once the earlier is off", () => {
    expect(assign(["right", "right"], [false, true])).toEqual([null, "right"]);
    expect(assign(["left", "left"], [true, false])).toEqual(["left", null]);
    expect(assign(["left", "right"], [false, false])).toEqual([null, null]);
  });

  it("puts a third on a side already taken rather than dropping it", () => {
    expect(assign(["left", "left", "left"], [true, true, true])).toEqual(["left", "right", "left"]);
  });

  it("overwrites a reused output", () => {
    const out: (OverlaySide | null)[] = ["left", "left"];
    assignColumns(["right", "right"], [true, true], out);
    expect(out).toEqual(["right", "left"]);
  });
});

describe("freeCentre", () => {
  const out: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const use = (left: boolean, right: boolean, top: boolean): SlotUse => ({ left, right, top });

  it.each(ASPECTS)("at %s stays centred and clear of the slots in use", (_, w, h) => {
    const layout = computeOverlayLayout(w, h);
    for (let m = 0; m < 8; m++) {
      const u = use((m & 1) !== 0, (m & 2) !== 0, (m & 4) !== 0);
      const r = freeCentre(layout, u, out);
      expect(r.x + r.w / 2).toBeCloseTo(w / 2, 6);
      expect(r.w > 0 && r.h > 0).toBe(true);
      expect(inside(r, layout.full)).toBe(true);
      const used = [
        ...(u.left ? [layout.columnLeft] : []),
        ...(u.right ? [layout.columnRight] : []),
        ...(u.top ? [layout.topLeft, layout.topCentre, layout.topRight] : []),
      ];
      for (const slot of used) {
        expect(rectsOverlap(r, slot)).toBe(false);
      }
    }
  });

  it("narrows with a column on either side, and drops below the band", () => {
    const layout = computeOverlayLayout(1920, 1080);
    const open = { ...freeCentre(layout, use(false, false, false), out) };
    const one = { ...freeCentre(layout, use(false, true, false), out) };
    const banded = { ...freeCentre(layout, use(false, false, true), out) };
    expect(one.w).toBeLessThan(open.w);
    expect(banded.y).toBeGreaterThan(open.y);
    expect(banded.w).toBe(open.w);
  });
});

describe("createRectEase", () => {
  const A: Rect = { x: 20, y: 140, w: 400, h: 900 };
  const B: Rect = { x: 1500, y: 140, w: 400, h: 900 };

  it("jumps on a snap", () => {
    const ease = createRectEase();
    ease.set(A, true);
    expect(ease.rect).toEqual(A);
    expect(ease.moving).toBe(false);
  });

  it("slides over the ease time, smoothly, and lands exactly", () => {
    const ease = createRectEase();
    ease.set(A, true);
    ease.set(B, false);
    expect(ease.moving).toBe(true);
    const dt = 1 / 60;
    let last = ease.rect.x;
    let steps = 0;
    let biggest = 0;
    while (ease.moving) {
      ease.step(dt);
      biggest = Math.max(biggest, ease.rect.x - last);
      expect(ease.rect.x).toBeGreaterThanOrEqual(last);
      last = ease.rect.x;
      steps++;
    }
    expect(steps).toBeGreaterThanOrEqual(Math.floor(SLOT_EASE_SECONDS / dt) - 1);
    expect(steps).toBeLessThanOrEqual(Math.ceil(SLOT_EASE_SECONDS / dt) + 1);
    // Never a jump: the fastest step is the eased curve's peak, 1.5x the average.
    expect(biggest).toBeLessThan(1.6 * (B.x - A.x) * (dt / SLOT_EASE_SECONDS));
    expect(ease.rect).toEqual(B);
  });

  it("turns round mid-slide from where it is", () => {
    const ease = createRectEase();
    ease.set(A, true);
    ease.set(B, false);
    for (let i = 0; i < 18; i++) {
      ease.step(1 / 60);
    }
    const mid = ease.rect.x;
    ease.set(A, false);
    ease.step(1 / 60);
    expect(Math.abs(ease.rect.x - mid)).toBeLessThan(10);
    for (let i = 0; i < 60; i++) {
      ease.step(1 / 60);
    }
    expect(ease.rect).toEqual(A);
  });

  it("ignores a repeat of its target and a bad dt", () => {
    const ease = createRectEase();
    ease.set(A, true);
    ease.set(B, false);
    ease.step(0.1);
    const x = ease.rect.x;
    ease.set(B, false);
    ease.step(Number.NaN);
    ease.step(-1);
    expect(ease.rect.x).toBe(x);
  });
});
