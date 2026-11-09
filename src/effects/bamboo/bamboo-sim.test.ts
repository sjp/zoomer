import { describe, expect, it } from "vitest";
import {
  BAMBOO_SWELL,
  buildLeaves,
  buildStems,
  CLUSTER_TOP,
  DENSITY_MAX,
  FLUTTER_MAX,
  FLUTTER_MIN,
  flutterAngle,
  flutterStrength,
  gustAt,
  layerCount,
  LAYERS,
  LEAF_ATTRIBUTES,
  LEAF_FLOATS,
  LIGHTS,
  MAX_LEAVES,
  MAX_STEMS,
  OPENING_HALF,
  type OpeningId,
  REFERENCE_ASPECT,
  SEGMENTS,
  STEM_ATTRIBUTES,
  STEM_FLOATS,
  STEM_STRIP,
  STRIP_TOP,
  stemClearance,
  stemSway,
  swayDriver,
  SWAY_MAX,
  swaySpeed,
  X_MARGIN,
} from "./bamboo-sim";
import { advanceSwell } from "../sway";
import { firstDifference } from "../../test/bytes";

const stems = (seed: number, density: number, opening: OpeningId = "centre") => {
  const data = new Float32Array(MAX_STEMS * STEM_FLOATS);
  return { data, layout: buildStems(seed, density, opening, data) };
};

describe("sway", () => {
  it("is zero at the root and grows with height within amplitude t^2", () => {
    let bad = 0;
    for (let i = 0; i < 200; i++) {
      const phase = i / 200;
      const x = (i * 0.37) % 1;
      if (stemSway(phase, 0.1, x, 1.8, 0, 0.1) !== 0) {
        bad++;
      }
      if (stemSway(phase, 0.1, x, 1.8, -0.5, 0.1) !== 0) {
        bad++;
      }
      let prev = 0;
      for (let k = 1; k <= 20; k++) {
        const t = k / 20;
        const s = stemSway(phase, 0.1, x, 1.8, t, 0.1);
        if (Math.abs(s) > 0.1 * t * t + 1e-12) {
          bad++;
        }
        // Without lag every point reads the same driver, so |sway| grows with t.
        const s0 = Math.abs(stemSway(phase, 0.1, x, 0, t, 0.1));
        if (s0 < prev - 1e-12) {
          bad++;
        }
        prev = s0;
      }
    }
    expect(bad).toBe(0);
    // It does move somewhere.
    expect(Math.abs(stemSway(0.3, 0, 0.2, 1.8, 1, 0.1))).toBeGreaterThan(0);
  });

  it("is continuous in time, including across the phase wrap", () => {
    let phase = 0.9;
    let prev = stemSway(phase, 0.05, 0.3, 1.8, 0.8, 0.1);
    let worst = 0;
    let wrapped = false;
    for (let i = 0; i < 2000; i++) {
      const next = advanceSwell(BAMBOO_SWELL, phase, 1 / 60, swaySpeed(1));
      if (next < phase) {
        wrapped = true;
      }
      phase = next;
      const s = stemSway(phase, 0.05, 0.3, 1.8, 0.8, 0.1);
      worst = Math.max(worst, Math.abs(s - prev));
      prev = s;
    }
    expect(wrapped).toBe(true);
    // 0.1 heights at most, moving with periods of several seconds: tiny per frame.
    expect(worst).toBeLessThan(0.002);
  });

  it("keeps the driver in [-1, 1] and gusts in [0, 1], travelling sideways", () => {
    let bad = 0;
    for (let i = 0; i < 500; i++) {
      const phase = i / 500;
      const x = (i * 0.618) % 1;
      const d = swayDriver(phase, 0.2, x, 1);
      const g = gustAt(x, phase);
      if (!(d >= -1 && d <= 1)) {
        bad++;
      }
      if (!(g >= 0 && g <= 1)) {
        bad++;
      }
      if (Math.abs(gustAt(x, phase + 1) - g) > 1e-9) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    // A gust peak further right arrives later: the field moves left to right.
    const peak = (x: number) => {
      let best = 0;
      let at = 0;
      for (let i = 0; i < 600; i++) {
        const p = i / 600 / 4;
        const g = gustAt(x, p);
        if (g > best) {
          best = g;
          at = p;
        }
      }
      return at;
    };
    expect(peak(0.6)).toBeGreaterThan(peak(0.2));
  });

  it("speeds up with wind and tolerates bad input", () => {
    expect(swaySpeed(1)).toBeGreaterThan(swaySpeed(0));
    expect(swaySpeed(Number.NaN)).toBe(swaySpeed(0));
    expect(swaySpeed(5)).toBe(swaySpeed(1));
  });
});

describe("buildStems", () => {
  it("is deterministic per seed, density and opening", () => {
    const a = stems(7, 1);
    const b = stems(7, 1);
    expect(a.layout).toEqual(b.layout);
    expect(a.data).toEqual(b.data);
    expect(stems(8, 1).data).not.toEqual(a.data);
    expect(stems(7, 1, "none").data).not.toEqual(a.data);
  });

  it("fits the batch at maximum density, layers far to near and thin to wide", () => {
    const { data, layout } = stems(3, DENSITY_MAX);
    expect(layout.total).toBeLessThanOrEqual(MAX_STEMS);
    expect(STEM_ATTRIBUTES.reduce((a, b) => a + b, 0)).toBe(STEM_FLOATS);
    let bad = 0;
    for (let l = 0; l < LAYERS.length; l++) {
      if (layout.counts[l] !== layerCount(LAYERS[l], DENSITY_MAX)) {
        bad++;
      }
      if (l > 0 && layout.starts[l] !== layout.starts[l - 1] + layout.counts[l - 1]) {
        bad++;
      }
      for (let k = 1; k < layout.counts[l]; k++) {
        const o = (layout.starts[l] + k) * STEM_FLOATS;
        if (data[o + 3] < data[o - STEM_FLOATS + 3]) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("scales with density and never drops a layer", () => {
    expect(stems(1, 2).layout.total).toBeGreaterThan(stems(1, 1).layout.total);
    expect(Math.min(...stems(1, 0).layout.counts)).toBeGreaterThanOrEqual(1);
    expect(stems(1, Number.NaN).layout.total).toBe(stems(1, 1).layout.total);
  });

  it("keeps every stem's swaying band out of the centre opening", () => {
    let bad = 0;
    let checked = 0;
    for (const seed of [0, 1, 2, 42, 500, 999]) {
      for (const density of [0.3, 1, DENSITY_MAX]) {
        const { data, layout } = stems(seed, density, "centre");
        for (let l = 0; l < LAYERS.length; l++) {
          for (let k = 0; k < layout.counts[l]; k++) {
            const o = (layout.starts[l] + k) * STEM_FLOATS;
            const reach = stemClearance(data[o + 1], data[o + 2], data[o + 6], data[o + 3]);
            if (Math.abs(data[o] - 0.5) - reach < OPENING_HALF) {
              bad++;
            }
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(bad).toBe(0);
  });

  it("keeps stems out of the opening as they actually sway at full wind", () => {
    let bad = 0;
    const { data, layout } = stems(17, DENSITY_MAX, "centre");
    for (let i = 0; i < layout.total; i++) {
      const o = i * STEM_FLOATS;
      const [x, ground, length, hw, phase0, lag, sway] = data.subarray(o, o + 7);
      for (let k = 0; k <= 8; k++) {
        const y = STRIP_TOP + (k / 8) * (Math.min(1, ground) - STRIP_TOP);
        const t = (ground - y) / length;
        for (let p = 0; p < 60; p++) {
          const off = stemSway(p / 60, phase0, x, lag, t, SWAY_MAX * sway);
          const cx = x + off / REFERENCE_ASPECT;
          const edge = (hw * 1.08) / 1080 / REFERENCE_ASPECT;
          if (Math.abs(cx - 0.5) - edge < OPENING_HALF) {
            bad++;
          }
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("places stems inside the frame and mostly towards the sides", () => {
    let bad = 0;
    let centre = 0;
    let total = 0;
    for (const seed of [4, 5, 6]) {
      const { data, layout } = stems(seed, 1.5, "none");
      for (let i = 0; i < layout.total; i++) {
        const x = data[i * STEM_FLOATS];
        if (x < X_MARGIN || x > 1 - X_MARGIN) {
          bad++;
        }
        if (Math.abs(x - 0.5) < 1 / 6) {
          centre++;
        }
        total++;
      }
    }
    expect(bad).toBe(0);
    // The middle third holds well under a third of the stems.
    expect(centre / total).toBeLessThan(0.28);
    // Without an opening, some do stand in the middle.
    expect(centre).toBeGreaterThan(0);
  });
});

describe("buildLeaves", () => {
  it("attaches clusters to stems in the upper frame, within the batch", () => {
    for (const seed of [0, 9, 77]) {
      const s = stems(seed, DENSITY_MAX);
      const out = new Float32Array(MAX_LEAVES * LEAF_FLOATS);
      const leaves = buildLeaves(seed, s.data, s.layout, out);
      expect(LEAF_ATTRIBUTES.reduce((a, b) => a + b, 0)).toBe(LEAF_FLOATS);
      expect(leaves.total).toBeLessThanOrEqual(MAX_LEAVES);
      expect(leaves.total).toBeGreaterThan(100);
      let bad = 0;
      let twigs = 0;
      for (let l = 0; l < LAYERS.length; l++) {
        const xs = new Set<number>();
        for (let k = 0; k < s.layout.counts[l]; k++) {
          xs.add(s.data[(s.layout.starts[l] + k) * STEM_FLOATS]);
        }
        for (let k = 0; k < leaves.counts[l]; k++) {
          const o = (leaves.starts[l] + k) * LEAF_FLOATS;
          // On one of this layer's stems, above its root, in the upper half.
          if (!xs.has(out[o])) {
            bad++;
          }
          if (!(out[o + 3] >= CLUSTER_TOP && out[o + 3] < 0.5 && out[o + 3] < out[o + 1])) {
            bad++;
          }
          const cycles = out[o + 13];
          if (!Number.isInteger(cycles) || cycles < FLUTTER_MIN || cycles > FLUTTER_MAX) {
            bad++;
          }
          if (!(out[o + 10] > 0 && out[o + 11] > 0)) {
            bad++;
          }
          if (out[o + 15] === 1) {
            twigs++;
          }
        }
      }
      expect(bad).toBe(0);
      expect(twigs).toBeGreaterThan(0);
    }
  });

  it("is deterministic and stops at the buffer's end", () => {
    const s = stems(5, 1);
    const a = new Float32Array(MAX_LEAVES * LEAF_FLOATS);
    const b = new Float32Array(MAX_LEAVES * LEAF_FLOATS);
    expect(buildLeaves(5, s.data, s.layout, a)).toEqual(buildLeaves(5, s.data, s.layout, b));
    expect(firstDifference(a, b)).toBe(-1);
    const small = new Float32Array(20 * LEAF_FLOATS);
    expect(buildLeaves(5, s.data, s.layout, small).total).toBeLessThanOrEqual(20);
  });
});

describe("flutter", () => {
  it("is periodic in the swell phase and bounded by its strength", () => {
    let bad = 0;
    for (let i = 0; i < 300; i++) {
      const p = i / 300;
      const a = flutterAngle(p, 0.3, 31, 0.2);
      if (Math.abs(a) > 0.2 + 1e-12) {
        bad++;
      }
      if (Math.abs(flutterAngle(p + 1, 0.3, 31, 0.2) - a) > 1e-9) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    expect(flutterStrength(1, 1)).toBeGreaterThan(flutterStrength(0, 0));
  });
});

describe("geometry and presets", () => {
  it("builds a strip of SEGMENTS + 1 vertex pairs", () => {
    expect(STEM_STRIP.length).toBe((SEGMENTS + 1) * 4);
  });

  it("has every light preset with colours in range", () => {
    let bad = 0;
    for (const light of Object.values(LIGHTS)) {
      for (const v of Object.values(light)) {
        if (Array.isArray(v)) {
          for (const c of v) {
            if (!(c >= 0 && c <= 1)) {
              bad++;
            }
          }
        }
      }
    }
    expect(Object.keys(LIGHTS).toSorted()).toEqual(["midday", "misty", "morning"]);
    expect(bad).toBe(0);
  });
});
