import { describe, expect, it } from "vitest";
import {
  type BoxShape,
  buildPanels,
  createAtlasImage,
  MAX_BLOCKS,
  MAX_WIDGETS,
  panelNumber,
  rasterisePanels,
  type Shape,
  shapeBounds,
  shapeDistance,
  tickedNumber,
} from "./bridge-panels";
import { ATLAS_S0, ATLAS_Y0, bridgeLayout, type WallRect } from "./bridge-room";
import { createRng } from "./noise";

const layout = bridgeLayout("left", true);

const inside = (r: WallRect, p: WallRect, eps = 1e-6) =>
  r.s0 >= p.s0 - eps && r.s1 <= p.s1 + eps && r.y0 >= p.y0 - eps && r.y1 <= p.y1 + eps;

const overlap = (a: WallRect, b: WallRect) =>
  Math.min(a.s1, b.s1) - Math.max(a.s0, b.s0) > -0.01 &&
  Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > -0.01;

describe("bridge panels", () => {
  it("are deterministic per seed, and differ between seeds", () => {
    expect(buildPanels(layout, 5)).toEqual(buildPanels(layout, 5));
    expect(buildPanels(layout, 5)).not.toEqual(buildPanels(layout, 6));
  });

  it("stay inside their panel's glass", () => {
    for (const seed of [0, 1, 2, 12, 999]) {
      for (const view of [true, false]) {
        const l = bridgeLayout(seed % 2 === 0 ? "left" : "right", view);
        const set = buildPanels(l, seed);
        for (const s of set.shapes) {
          const b = shapeBounds(s);
          expect(l.panels.some((p) => inside(b, p))).toBe(true);
        }
        for (const w of set.widgets) {
          expect(l.panels.some((p) => inside(w, p))).toBe(true);
        }
      }
    }
  });

  it("keep black gaps between the blocks of solid shapes", () => {
    /** Smallest distance from inside one shape to the other, sampled every 1 mm where their bounds meet. */
    const closest = (a: Shape, b: Shape) => {
      const A = shapeBounds(a);
      const B = shapeBounds(b);
      const pad = 0.01;
      const r = {
        s0: Math.max(A.s0, B.s0) - pad,
        s1: Math.min(A.s1, B.s1) + pad,
        y0: Math.max(A.y0, B.y0) - pad,
        y1: Math.min(A.y1, B.y1) + pad,
      };
      let best = Number.POSITIVE_INFINITY;
      for (let s = r.s0; s <= r.s1; s += 0.001) {
        for (let y = r.y0; y <= r.y1; y += 0.001) {
          if (shapeDistance(a, s, y) < 0) {
            best = Math.min(best, shapeDistance(b, s, y));
          }
        }
      }
      return best;
    };
    for (const seed of [0, 3, 12, 77]) {
      const set = buildPanels(layout, seed);
      const solid = set.shapes.filter(
        (s): s is Extract<Shape, { kind: "box" | "elbow" }> =>
          s.kind === "box" || s.kind === "elbow",
      );
      let nearest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < solid.length; i++) {
        for (let j = i + 1; j < solid.length; j++) {
          const a = solid[i] as Shape;
          const b = solid[j] as Shape;
          if (a.block !== b.block && overlap(shapeBounds(a), shapeBounds(b))) {
            nearest = Math.min(nearest, closest(a, b));
          }
        }
      }
      expect(nearest).toBeGreaterThan(0.004);
    }
  });

  it("stay within the block and widget limits", () => {
    for (const seed of [0, 12, 500]) {
      const set = buildPanels(layout, seed);
      expect(set.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
      expect(set.widgets.length).toBeLessThanOrEqual(MAX_WIDGETS);
      expect(set.widgets.map((w) => w.kind).toSorted()).toEqual(["graph", "sweep"]);
      for (const s of set.shapes) {
        expect(s.block).toBeGreaterThan(0);
        expect(s.block).toBeLessThan(set.blocks.length);
      }
    }
  });

  it("number chase groups from the top", () => {
    const set = buildPanels(layout, 12);
    const groups = new Map<number, number[]>();
    set.blocks.forEach((b) => {
      if (b.group >= 0) {
        groups.set(b.group, [...(groups.get(b.group) ?? []), b.order]);
      }
    });
    expect(groups.size).toBeGreaterThan(5);
    for (const orders of groups.values()) {
      expect(orders).toEqual(orders.toSorted((x, y) => x - y));
    }
  });

  it("rasterise coverage and block indices", () => {
    const set = buildPanels(layout, 12);
    const tpm = 200;
    const atlas = createAtlasImage(1200, 320, tpm);
    rasterisePanels(set, atlas);
    const box = set.shapes.find(
      (s): s is BoxShape => s.kind === "box" && s.x1 - s.x0 > 0.04 && s.y1 - s.y0 > 0.04,
    );
    if (!box) {
      throw new Error("no box big enough to test");
    }
    const at = (s: number, y: number) => {
      const i = Math.floor((s - ATLAS_S0) * tpm);
      const j = Math.floor((y - ATLAS_Y0) * tpm);
      return j * atlas.width + i;
    };
    const centre = at((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
    expect(atlas.rgba[centre * 4]).toBe(255);
    expect(atlas.index[centre]).toBe(box.block);
    // Far outside every panel: nothing.
    const wall = at(ATLAS_S0 + 0.01, ATLAS_Y0 + 0.01);
    expect(atlas.rgba[wall * 4]).toBe(0);
    expect(atlas.index[wall]).toBe(0);
  });

  it("make numbers that tick to a new reading of the same shape", () => {
    const rng = createRng(3);
    for (let i = 0; i < 200; i++) {
      const n = panelNumber(rng);
      expect(n).toMatch(/^[0-9][0-9.-]*[0-9]$|^[0-9]+$/);
      const t = tickedNumber(n, rng);
      expect(t).toHaveLength(n.length);
      expect(t).not.toBe(n);
      expect(t.replace(/[0-9]/g, "0")).toBe(n.replace(/[0-9]/g, "0"));
    }
  });
});
