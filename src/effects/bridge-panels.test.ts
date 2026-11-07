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
  textBounds,
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

  it("give lit titles their block across their full width, wide letters included", () => {
    const set = buildPanels(layout, 12);
    const tpm = 300;
    const atlas = createAtlasImage(Math.ceil(5.52 * tpm), Math.ceil(1.5 * tpm), tpm);
    rasterisePanels(set, atlas);
    const power = set.texts.find((t) => t.text === "POWER");
    if (!power) {
      throw new Error("no POWER title");
    }
    // Arial at weight 600, squeezed so digits are half their height wide, sets
    // POWER about 3.4 capital heights wide: more than five narrow digits.
    const left = power.x - 3.6 * power.size;
    const i = Math.floor((left - ATLAS_S0) * tpm);
    const j = Math.floor((power.y + power.size / 2 - ATLAS_Y0) * tpm);
    expect(atlas.index[j * atlas.width + i]).toBe(power.block);
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
  it("give the band one window per real readout, beside the speaker", () => {
    const set = buildPanels(layout, 12);
    expect(set.live.map((t) => t.key).toSorted()).toEqual([
      "date",
      "location",
      "stardate",
      "status",
      "time",
    ]);
    const band = layout.panels.find((p) => p.kind === "band");
    for (const t of set.live) {
      expect(band && inside(t.bounds, band)).toBe(true);
      // Each reaches out into a side third, away from the speaker, except the
      // date, which sits inside the middle third beside the time.
      const outer = Math.max(Math.abs(t.bounds.s0), Math.abs(t.bounds.s1));
      expect(outer).toBeGreaterThan(t.key === "date" ? 0.9 : 1.6);
      expect(set.blocks[t.block]?.busy).toBe(0);
    }
    const spans = set.live.map((t) => t.bounds).toSorted((a, c) => a.s0 - c.s0);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].s0).toBeGreaterThan(spans[i - 1].s1);
    }
  });

  it("title every panel by what it shows, never twice", () => {
    const expected = {
      "left,true": ["EXTERIOR", "ENVIRONMENT", "SENSORS", "SYSTEMS", "POWER", "NAVIGATION"],
      "right,true": ["NAVIGATION", "ENVIRONMENT", "SENSORS", "SYSTEMS", "POWER", "EXTERIOR"],
      "left,false": ["COMMS", "ENVIRONMENT", "SENSORS", "SYSTEMS", "POWER", "NAVIGATION"],
    };
    for (const [key, titles] of Object.entries(expected)) {
      const [side, view] = key.split(",");
      const l = bridgeLayout(side === "right" ? "right" : "left", view === "true");
      for (const seed of [0, 12, 500]) {
        const set = buildPanels(l, seed);
        const found = l.panels
          .filter((p) => p.kind !== "band")
          .map((p) => {
            const words = set.texts.filter(
              (t) => /^[A-Z]{4,}$/.test(t.text) && inside(textBounds(t), p, 0.05),
            );
            return words.map((t) => t.text).join(" ");
          });
        expect(found).toEqual(titles);
      }
    }
  });

  it("leave hidden readouts out of the band, closing up the rest", () => {
    const all = buildPanels(layout, 12);
    const noTime = buildPanels(layout, 12, new Set(["time"]));
    const neither = buildPanels(layout, 12, new Set(["time", "date"]));
    expect(noTime.live.map((t) => t.key).toSorted()).toEqual([
      "date",
      "location",
      "stardate",
      "status",
    ]);
    expect(neither.live.map((t) => t.key).toSorted()).toEqual(["location", "stardate", "status"]);
    for (const set of [noTime, neither]) {
      expect(set.texts.map((t) => t.text)).not.toContain("LOCAL TIME");
    }
    expect(neither.texts.map((t) => t.text)).not.toContain("LOCAL DATE");
    // The date moves out to where the time was.
    const at = (set: typeof all, key: string) => set.live.find((t) => t.key === key)?.bounds.s0;
    expect(at(noTime, "date")).toBeCloseTo(at(all, "time") ?? 0, 6);
  });

  it("show only steady information in the band", () => {
    const band = layout.panels.find((p) => p.kind === "band");
    if (!band) {
      throw new Error("no band");
    }
    const set = buildPanels(layout, 12);
    const inBand = set.shapes.filter((s) => inside(shapeBounds(s), band));
    expect(inBand.length).toBeGreaterThan(0);
    expect(inBand.filter((s) => set.blocks[s.block]?.busy !== 0)).toEqual([]);
    // Its only text is the readouts' labels.
    const labels = set.texts.filter((t) => t.y > band.y0 && t.y < band.y1).map((t) => t.text);
    expect(labels.toSorted()).toEqual([
      "LOCAL DATE",
      "LOCAL TIME",
      "LOCATION",
      "STARDATE",
      "STATUS",
    ]);
  });

  it("keep other blocks' shapes out of the readouts' windows", () => {
    for (const seed of [0, 12, 77]) {
      const set = buildPanels(layout, seed);
      const intruders: string[] = [];
      for (const t of set.live) {
        const r = t.bounds;
        for (const shape of set.shapes) {
          const sb = shapeBounds(shape);
          if (
            shape.block === t.block ||
            sb.s1 < r.s0 ||
            sb.s0 > r.s1 ||
            sb.y1 < r.y0 ||
            sb.y0 > r.y1
          ) {
            continue;
          }
          for (let s = r.s0; s <= r.s1; s += 0.002) {
            for (let y = r.y0; y <= r.y1; y += 0.002) {
              if (shapeDistance(shape, s, y) < 0) {
                intruders.push(`${t.key}: ${shape.kind} ${String(shape.block)}`);
                s = r.s1 + 1;
                break;
              }
            }
          }
        }
      }
      expect(intruders).toEqual([]);
    }
  });
});
