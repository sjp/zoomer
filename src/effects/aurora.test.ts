import { describe, expect, it } from "vitest";
import {
  auroraStarCount,
  buildHorizonTable,
  buildPathTable,
  buildRayTable,
  BAND_BASE,
  buildStars,
  horizonMax,
  MAX_STARS,
  PATH_AMPLITUDE,
  PATH_COLS,
  STAR_STRIDE,
  TWINKLE_PERIOD,
} from "./aurora";
import { createNoise } from "./noise";

describe("buildPathTable", () => {
  const noise = createNoise(1337);
  const out = new Float32Array(PATH_COLS * 8);
  buildPathTable(out, PATH_COLS, 16 / 9, 3.2, noise);

  it("keeps band bases on screen and brightness in 0.25..1", () => {
    for (let i = 0; i < PATH_COLS; i++) {
      for (let b = 0; b < 3; b++) {
        const offset = out[i * 4 + b];
        const y = BAND_BASE[b] + offset;
        const a = out[PATH_COLS * 4 + i * 4 + b];
        expect(Math.abs(offset)).toBeLessThanOrEqual(PATH_AMPLITUDE);
        expect(y).toBeGreaterThan(0.15);
        expect(y).toBeLessThan(0.8);
        expect(a).toBeGreaterThanOrEqual(0.25);
        expect(a).toBeLessThanOrEqual(1);
      }
      expect(out[i * 4 + 3]).toBe(0);
    }
  });

  it("varies smoothly along x", () => {
    for (let i = 1; i < PATH_COLS; i++) {
      expect(Math.abs(out[i * 4] - out[(i - 1) * 4])).toBeLessThan(0.02);
    }
  });

  it("moves slowly with time", () => {
    const later = new Float32Array(out.length);
    buildPathTable(later, PATH_COLS, 16 / 9, 3.201, noise);
    let maxDiff = 0;
    let anyDiff = false;
    for (let i = 0; i < out.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(later[i] - out[i]));
      anyDiff ||= later[i] !== out[i];
    }
    expect(anyDiff).toBe(true);
    expect(maxDiff).toBeLessThan(0.005);
  });
});

describe("buildRayTable", () => {
  const cols = 2048;
  const rays = buildRayTable(cols);

  it("is normalised to 0..1", () => {
    let max = 0;
    for (const v of rays) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      max = Math.max(max, v);
    }
    expect(max).toBeCloseTo(1, 5);
  });

  it("wraps seamlessly", () => {
    let maxStep = 0;
    for (let i = 1; i < cols; i++) {
      for (let c = 0; c < 4; c++) {
        maxStep = Math.max(maxStep, Math.abs(rays[i * 4 + c] - rays[(i - 1) * 4 + c]));
      }
    }
    for (let c = 0; c < 4; c++) {
      expect(Math.abs(rays[c] - rays[(cols - 1) * 4 + c])).toBeLessThanOrEqual(maxStep + 1e-6);
    }
  });

  it("has distinct channels and is deterministic", () => {
    let diff = 0;
    for (let i = 0; i < cols; i++) {
      diff += Math.abs(rays[i * 4] - rays[i * 4 + 1]);
    }
    expect(diff / cols).toBeGreaterThan(0.01);
    expect(buildRayTable(cols)).toEqual(rays);
  });
});

describe("buildHorizonTable", () => {
  it("is flat zero for none", () => {
    const t = buildHorizonTable("none", 64, 16 / 9);
    expect(t.every((v) => v === 0)).toBe(true);
    expect(horizonMax(t)).toBe(0);
  });

  it.each(["hills", "pines"] as const)("%s stays low on screen", (kind) => {
    const t = buildHorizonTable(kind, 960, 16 / 9);
    for (let i = 0; i < 960; i++) {
      expect(t[i * 2]).toBeGreaterThan(0.005);
      expect(t[i * 2]).toBeLessThan(0.2);
      expect(Number.isFinite(t[i * 2 + 1])).toBe(true);
    }
    expect(horizonMax(t)).toBeLessThan(0.2);
  });

  it("pines are jagged, hills are smooth", () => {
    const steepest = (kind: "hills" | "pines") => {
      const t = buildHorizonTable(kind, 960, 16 / 9);
      let max = 0;
      for (let i = 0; i < 960; i++) {
        max = Math.max(max, Math.abs(t[i * 2 + 1]));
      }
      return max;
    };
    expect(steepest("hills")).toBeLessThan(0.5);
    expect(steepest("pines")).toBeGreaterThan(1);
  });

  it("stores the slope as a central difference in px per px", () => {
    const cols = 400;
    const aspect = 2;
    const t = buildHorizonTable("hills", cols, aspect);
    const colW = aspect / cols;
    const i = 200;
    expect(t[i * 2 + 1]).toBeCloseTo((t[(i + 1) * 2] - t[(i - 1) * 2]) / (2 * colW), 5);
  });
});

describe("buildStars", () => {
  it("places stars above the silhouette with valid attributes", () => {
    const horizon = buildHorizonTable("pines", 512, 16 / 9);
    const out = new Float32Array(MAX_STARS * STAR_STRIDE);
    const n = buildStars(out, 300, horizon);
    expect(n).toBe(300);
    for (let s = 0; s < n; s++) {
      const o = s * STAR_STRIDE;
      const [x, y, r, b, , rate] = out.subarray(o, o + STAR_STRIDE);
      const col = Math.min(511, Math.floor(x * 512));
      expect(y).toBeGreaterThan(horizon[col * 2]);
      expect(y).toBeLessThan(1);
      expect(r).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(0);
      expect(b).toBeLessThanOrEqual(1);
      // Whole cycles per twinkle period, so wrapping time is seamless.
      const cycles = (rate * TWINKLE_PERIOD) / (2 * Math.PI);
      expect(cycles).toBeCloseTo(Math.round(cycles), 3);
    }
  });

  it("keeps existing stars when the count grows", () => {
    const horizon = buildHorizonTable("none", 1, 16 / 9);
    const a = new Float32Array(MAX_STARS * STAR_STRIDE);
    const b = new Float32Array(MAX_STARS * STAR_STRIDE);
    buildStars(a, 100, horizon);
    buildStars(b, 200, horizon);
    expect(b.subarray(0, 100 * STAR_STRIDE)).toEqual(a.subarray(0, 100 * STAR_STRIDE));
  });

  it("returns 0 for no stars and respects the buffer size", () => {
    const horizon = new Float32Array(2);
    expect(buildStars(new Float32Array(60), 0, horizon)).toBe(0);
    expect(buildStars(new Float32Array(10 * STAR_STRIDE), 50, horizon)).toBe(10);
  });
});

describe("auroraStarCount", () => {
  it("draws MAX_STARS at full density on a 16:9 screen, at any resolution", () => {
    expect(auroraStarCount(1, 1920, 1080)).toBe(MAX_STARS);
    expect(auroraStarCount(1, 3840, 2160)).toBe(MAX_STARS);
    expect(auroraStarCount(0.5, 1920, 1080)).toBe(MAX_STARS / 2);
    expect(auroraStarCount(0, 1920, 1080)).toBe(0);
  });

  it("scales with the aspect, up to 1.5 times wider, capped at MAX_STARS", () => {
    // 4:3 is three quarters as wide as 16:9.
    expect(auroraStarCount(1, 1440, 1080)).toBe(MAX_STARS * 0.75);
    expect(auroraStarCount(0.5, 3840, 1080)).toBe(MAX_STARS * 0.75);
    expect(auroraStarCount(0.5, 10000, 1080)).toBe(MAX_STARS * 0.75);
    expect(auroraStarCount(1, 3840, 1080)).toBe(MAX_STARS);
    expect(auroraStarCount(1, 1080, 1920)).toBe(Math.round(MAX_STARS * (1080 / 1920) ** 2));
  });

  it("returns a whole count for any canvas, including an empty one", () => {
    for (const [w, h] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [333, 77],
    ]) {
      const n = auroraStarCount(0.37, w, h);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(MAX_STARS);
    }
  });
});
