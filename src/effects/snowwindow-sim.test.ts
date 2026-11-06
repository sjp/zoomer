import { describe, expect, it } from "vitest";
import {
  buildCondensation,
  condensationSize,
  faceArea,
  interior,
  layoutId,
  MAX_PANES,
  paneAt,
  type Rect,
  sceneIndex,
  windowPanes,
} from "./snowwindow-sim";
import { LAYOUT_OPTIONS, SCENE_OPTIONS } from "./snowwindow.meta";

const ASPECTS = [16 / 9, 4 / 3, 21 / 9, 1, 9 / 16];
const LAYOUTS = LAYOUT_OPTIONS.map((o) => o.value);

const area = ([x0, y0, x1, y1]: Rect) => (x1 - x0) * (y1 - y0);
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const contains = (outer: Rect, inner: Rect, eps = 1e-9) =>
  inner[0] >= outer[0] - eps &&
  inner[1] >= outer[1] - eps &&
  inner[2] <= outer[2] + eps &&
  inner[3] <= outer[3] + eps;

describe("window layouts", () => {
  it("maps every select option, with fallbacks for unknown values", () => {
    expect(LAYOUTS.map(layoutId)).toEqual(LAYOUTS);
    expect(layoutId("nope")).toBe("four");
    expect(SCENE_OPTIONS.map((o) => sceneIndex(o.value))).toEqual([0, 1, 2]);
    expect(sceneIndex("nope")).toBe(0);
  });

  it("gives panes inside the opening that don't overlap and leave only bars between them", () => {
    const bad: string[] = [];
    for (const aspect of ASPECTS) {
      const open = interior(aspect);
      for (const layout of LAYOUTS) {
        const panes = windowPanes(layoutId(layout), aspect);
        const tag = `${layout} @ ${aspect.toFixed(2)}`;
        if (panes.length < 1 || panes.length > MAX_PANES)
          bad.push(`${tag}: ${String(panes.length)} panes`);
        let sum = 0;
        for (let i = 0; i < panes.length; i++) {
          const p = panes[i];
          if (!(p[2] > p[0] && p[3] > p[1])) bad.push(`${tag}: empty pane ${String(i)}`);
          if (!contains(open, p)) bad.push(`${tag}: pane ${String(i)} outside the opening`);
          sum += area(p);
          for (let j = 0; j < i; j++) {
            if (overlap(p, panes[j]) > 1e-12)
              bad.push(`${tag}: panes ${String(i)} and ${String(j)} overlap`);
          }
        }
        // Glass plus bars fills the opening: bars are at most a few BAR-wide strips.
        const glass = sum / area(open);
        if (glass < 0.8 || glass > 1 + 1e-9) bad.push(`${tag}: glass covers ${String(glass)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps bars out of the face area for four panes and the bare frame", () => {
    const bad: string[] = [];
    for (const aspect of ASPECTS) {
      const face = faceArea(aspect);
      for (const layout of ["four", "frame"] as const) {
        const panes = windowPanes(layout, aspect);
        if (!panes.some((p) => contains(p, face))) bad.push(`${layout} @ ${aspect.toFixed(2)}`);
      }
    }
    expect(bad).toEqual([]);
    // Six panes is labelled as crossing the centre, and does.
    const face = faceArea(16 / 9);
    expect(windowPanes("six", 16 / 9).some((p) => contains(p, face))).toBe(false);
  });

  it("finds the pane under a point, and none on the frame or a bar", () => {
    const aspect = 16 / 9;
    const panes = windowPanes("four", aspect);
    expect(paneAt(panes, aspect / 2, 0.4)).toBe(0);
    expect(paneAt(panes, 0.01, 0.5)).toBe(-1);
    // On the high bar.
    const barY = panes[0][3] + 0.01;
    expect(paneAt(panes, aspect / 2, barY)).toBe(-1);
  });
});

describe("condensation mask", () => {
  const aspect = 16 / 9;
  const { width, height } = condensationSize(aspect);
  const build = (layout: "four" | "six" | "frame", seed: number) => {
    const out = new Uint8Array(width * height * 4);
    buildCondensation(out, width, height, aspect, windowPanes(layout, aspect), seed);
    return out;
  };
  const texel = (out: Uint8Array, x: number, y: number, c = 0) => {
    const i = Math.min(width - 1, Math.floor((x / aspect) * width));
    const j = Math.min(height - 1, Math.floor(y * height));
    return out[(j * width + i) * 4 + c] / 255;
  };

  it("sizes the mask to the aspect ratio, and survives a bad one", () => {
    expect(condensationSize(16 / 9)).toEqual({ width: 640, height: 360 });
    expect(condensationSize(Number.NaN).height).toBe(360);
    expect(condensationSize(100).width).toBe(2048);
  });

  it("is deterministic per seed", () => {
    const a = build("four", 4);
    const b = build("four", 4);
    const c = build("four", 5);
    expect(a.every((v, i) => v === b[i])).toBe(true);
    expect(a.some((v, i) => v !== c[i])).toBe(true);
  });

  it("is strongest in the lower pane corners, clear in the middle and empty on the frame", () => {
    const bad: string[] = [];
    for (const layout of LAYOUTS) {
      const panes = windowPanes(layoutId(layout), aspect);
      const out = build(layoutId(layout), 9);
      for (const [x0, y0, x1, y1] of panes) {
        const inset = 0.006;
        const left = texel(out, x0 + inset, y0 + inset);
        const right = texel(out, x1 - inset, y0 + inset);
        const mid = texel(out, (x0 + x1) / 2, (y0 + y1) / 2);
        if (!(left > 0.6 && right > 0.6))
          bad.push(`${layout}: corners ${String(left)}, ${String(right)}`);
        if (!(mid < left && mid < right && mid < 0.2)) bad.push(`${layout}: middle ${String(mid)}`);
      }
      const [ix0, iy0] = interior(aspect);
      if (texel(out, ix0 / 2, 0.5) !== 0 || texel(out, aspect / 2, iy0 / 2) !== 0) {
        bad.push(`${layout}: fog on the frame`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("places a few droplets, only where there is fog", () => {
    const out = build("four", 2);
    let drops = 0;
    let stray = 0;
    for (let o = 0; o < out.length; o += 4) {
      if (out[o + 1] >= 128) {
        drops++;
        if (out[o] < 60) stray++;
      }
    }
    // Some texels of droplet, but nowhere near the whole pane.
    expect(drops).toBeGreaterThan(20);
    expect(drops).toBeLessThan(width * height * 0.05);
    expect(stray).toBe(0);
  });
});
