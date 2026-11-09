import { describe, expect, it } from "vitest";
import {
  type BoxShape,
  buildPanels,
  copyText,
  createAtlasImage,
  liveColumns,
  liveRows,
  MAX_BLOCKS,
  MAX_WIDGETS,
  panelNumber,
  rasterisePanels,
  type PanelSet,
  type Shape,
  shapeBounds,
  shapeDistance,
  textBounds,
  tickedNumber,
} from "./bridge-panels";
import {
  ATLAS_S0,
  ATLAS_S1,
  ATLAS_Y0,
  ATLAS_Y1,
  atlasTexelsPerMetre,
  bridgeLayout,
  type WallRect,
} from "./bridge-room";
import { createRng } from "../noise";

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
      "left,true": ["EXTERIOR", "ENVIRONMENT", "SENSORS", "SYSTEMS", "POWER", "OPERATIONS"],
      "right,true": ["OPERATIONS", "ENVIRONMENT", "SENSORS", "SYSTEMS", "POWER", "EXTERIOR"],
      "left,false": ["COMMS", "ENVIRONMENT", "SENSORS", "SYSTEMS", "POWER", "OPERATIONS"],
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

describe("live readout redraws", () => {
  const atlasFor = (height: number) => {
    const tpm = atlasTexelsPerMetre(height);
    return createAtlasImage(
      Math.ceil((ATLAS_S1 - ATLAS_S0) * tpm),
      Math.ceil((ATLAS_Y1 - ATLAS_Y0) * tpm),
      tpm,
    );
  };

  /** Static text runs whose ink reaches into a readout's redrawn texels. */
  const erased = (set: PanelSet, height: number): string[] => {
    const atlas = atlasFor(height);
    const { tpm } = atlas;
    const [r0, rows] = liveRows(set, atlas);
    const r1 = r0 + rows - 1;
    const hits: string[] = [];
    for (const t of set.texts) {
      // Rows the run's ink reaches: capitals sit on the baseline (round ones
      // overshoot it a little), lowercase may descend.
      const b = textBounds(t);
      const descent = (/[a-z,;]/.test(t.text + t.alt) ? 0.25 : 0.02) * t.size;
      const t0 = Math.floor((t.y - descent - ATLAS_Y0) * tpm);
      const t1 = Math.ceil((b.y1 - ATLAS_Y0) * tpm);
      const s0 = Math.floor((b.s0 - ATLAS_S0) * tpm);
      const s1 = Math.ceil((b.s1 - ATLAS_S0) * tpm);
      if (t1 < r0 || t0 > r1) {
        continue;
      }
      for (const live of set.live) {
        const [c0, c1] = liveColumns(live, atlas);
        if (s1 >= c0 && s0 <= c1) {
          hits.push(`${t.text} under ${live.key} at ${String(height)}p`);
        }
      }
    }
    return hits;
  };

  it("cover every readout's bounds and stay inside the atlas", () => {
    for (const height of [720, 1080, 2160]) {
      const atlas = atlasFor(height);
      const set = buildPanels(layout, 12);
      const [r0, rows] = liveRows(set, atlas);
      // No more than the rows the bounds reach.
      const top = Math.max(...set.live.map((t) => t.bounds.y1));
      expect(r0 + rows - 1).toBeLessThan((top - ATLAS_Y0) * atlas.tpm);
      expect(r0).toBeGreaterThanOrEqual(0);
      expect(r0 + rows).toBeLessThanOrEqual(atlas.height);
      for (const t of set.live) {
        expect(r0).toBeLessThanOrEqual((t.bounds.y0 - ATLAS_Y0) * atlas.tpm);
        expect(r0 + rows).toBeGreaterThanOrEqual((t.bounds.y1 - ATLAS_Y0) * atlas.tpm);
        const [c0, c1] = liveColumns(t, atlas);
        expect(c0).toBeGreaterThanOrEqual(0);
        expect(c1).toBeLessThan(atlas.width);
        expect(c0).toBeLessThanOrEqual((t.bounds.s0 - ATLAS_S0) * atlas.tpm);
        expect(c1).toBeGreaterThanOrEqual((t.bounds.s1 - ATLAS_S0) * atlas.tpm);
      }
    }
  });

  it("are empty with no readouts", () => {
    const set = buildPanels(
      layout,
      12,
      new Set(["stardate", "time", "date", "status", "location"]),
    );
    expect(set.live).toEqual([]);
    expect(liveRows(set, atlasFor(1080))).toEqual([0, 0]);
  });

  it("never clear static text in the readouts' columns", () => {
    // The redraw copies the union of all readouts' rows over each one's columns,
    // so a taller readout elsewhere must not reach a neighbour's label.
    const hits: string[] = [];
    for (const side of ["left", "right"] as const) {
      for (const view of [true, false]) {
        for (const seed of [0, 12, 77]) {
          for (const height of [360, 480, 720, 1080, 2160]) {
            hits.push(...erased(buildPanels(bridgeLayout(side, view), seed), height));
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("catch a label pushed into the readouts' rows", () => {
    const set = buildPanels(layout, 12);
    const live = set.live[0];
    const label = set.texts.find(
      (t) => t.x >= live.bounds.s0 && t.x <= live.bounds.s1 && t.y > live.bounds.y1,
    );
    expect(label).toBeDefined();
    if (label) {
      label.y = live.bounds.y1 - 0.005;
    }
    expect(erased(set, 1080).length).toBeGreaterThan(0);
  });
});

describe("copyText", () => {
  it("copies red and green into G and B over the given columns, flipping rows", () => {
    const atlas = createAtlasImage(4, 5, 1);
    atlas.rgba.fill(9);
    const rows = 2;
    // Canvas pixels, top down: row 0 has red = 10 + column, green = 20 + column;
    // row 1 has red = 30 + column, green = 40 + column.
    const data = new Uint8ClampedArray(4 * rows * 4);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 4; c++) {
        data[(r * 4 + c) * 4] = 10 + 20 * r + c;
        data[(r * 4 + c) * 4 + 1] = 20 + 20 * r + c;
      }
    }
    copyText(data, atlas, 1, rows, 1, 2);
    const px = (row: number, col: number) =>
      Array.from(atlas.rgba.slice((row * 4 + col) * 4, (row * 4 + col) * 4 + 4));
    // Atlas row 1 (lower) takes the canvas's bottom row, row 2 its top row.
    expect(px(1, 1)).toEqual([9, 31, 41, 9]);
    expect(px(1, 2)).toEqual([9, 32, 42, 9]);
    expect(px(2, 1)).toEqual([9, 11, 21, 9]);
    expect(px(2, 2)).toEqual([9, 12, 22, 9]);
    // Columns and rows outside the range are untouched.
    for (const [row, col] of [
      [1, 0],
      [1, 3],
      [2, 0],
      [2, 3],
      [0, 1],
      [3, 1],
    ]) {
      expect(px(row, col)).toEqual([9, 9, 9, 9]);
    }
  });
});
