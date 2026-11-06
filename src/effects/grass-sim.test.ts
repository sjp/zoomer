import { describe, expect, it } from "vitest";
import {
  BEND_BASE,
  BEND_GUST,
  BEND_LIMIT,
  BEND_SWAY,
  BLADE_FLOATS,
  BLADE_STRIP,
  bendPoints,
  bladeCount,
  buildBlades,
  FIELDS,
  gustUv,
  HEIGHT_MAX,
  HEIGHT_MIN,
  MAX_BLADES,
  NOISE_CHANNELS,
  NOISE_SIZE,
  sampleRepeat,
  SEGMENTS,
  SUNS,
  SWAY_CYCLES_MAX,
  SWAY_CYCLES_MIN,
  tipAngle,
  WIDTH_MAX,
  WIDTH_MIN,
  windBend,
  windRate,
  windWave,
  X_MARGIN,
  Z_FAR,
  Z_NEAR,
} from "./grass-sim";
import { buildPeriodicNoiseTexture } from "./noise";

const noise = buildPeriodicNoiseTexture(NOISE_SIZE, NOISE_CHANNELS);
const uv: [number, number] = [0, 0];
/** The full JS twin of the shader's windAt, texture fetch included. */
const windAt = (x: number, z: number, phase: number, wind: number, gusts: number) => {
  gustUv(x, z, phase, uv);
  const r = sampleRepeat(noise, NOISE_SIZE, 4, 0, uv[0], uv[1]);
  const g = sampleRepeat(noise, NOISE_SIZE, 4, 1, uv[0], uv[1]);
  return windBend(x, z, phase, wind, gusts, r * 0.7 + g * 0.3);
};

describe("bladeCount", () => {
  it("scales with density and aspect, clamped", () => {
    expect(bladeCount(1, 16 / 9)).toBe(18000);
    expect(bladeCount(2, 16 / 9)).toBe(36000);
    expect(bladeCount(1, 32 / 9)).toBe(36000);
    expect(bladeCount(10, 10)).toBe(MAX_BLADES);
    expect(bladeCount(0, 16 / 9)).toBe(0);
    expect(bladeCount(Number.NaN, 1)).toBe(0);
  });
});

describe("buildBlades", () => {
  const build = (seed: number, count: number) => {
    const out = new Float32Array(MAX_BLADES * BLADE_FLOATS);
    const n = buildBlades(seed, count, out);
    return { n, out: out.slice(0, n * BLADE_FLOATS) };
  };

  it("is deterministic per seed and writes the configured count", () => {
    const a = build(5, 3000);
    expect(a.n).toBe(3000);
    expect(build(5, 3000).out).toEqual(a.out);
    expect(build(6, 3000).out).not.toEqual(a.out);
  });

  it("clamps to the output's size", () => {
    expect(buildBlades(1, 100, new Float32Array(10 * BLADE_FLOATS))).toBe(10);
    expect(buildBlades(1, -5, new Float32Array(10 * BLADE_FLOATS))).toBe(0);
  });

  it("sorts back to front and keeps every value in range", () => {
    const { n, out } = build(9, 5000);
    const within = (v: number, lo: number, hi: number) => v >= lo - 1e-6 && v <= hi + 1e-6;
    const bad: number[] = [];
    for (let j = 0; j < n; j++) {
      const o = j * BLADE_FLOATS;
      const ok =
        (j === 0 || out[o + 1] <= out[o + 1 - BLADE_FLOATS]) &&
        within(out[o], -X_MARGIN, 1 + X_MARGIN) &&
        within(out[o + 1], Z_NEAR, Z_FAR) &&
        within(out[o + 2], HEIGHT_MIN, HEIGHT_MAX) &&
        within(out[o + 3], WIDTH_MIN, WIDTH_MAX) &&
        Number.isInteger(out[o + 5]) &&
        out[o + 5] >= SWAY_CYCLES_MIN &&
        out[o + 5] < SWAY_CYCLES_MAX;
      if (!ok) bad.push(j);
    }
    expect(bad).toEqual([]);
  });

  it("keeps existing blades when the count grows", () => {
    const key = (out: Float32Array) => {
      const s = new Set<string>();
      for (let o = 0; o < out.length; o += BLADE_FLOATS)
        s.add(`${String(out[o])},${String(out[o + 1])}`);
      return s;
    };
    const small = key(build(3, 1000).out);
    const large = key(build(3, 2000).out);
    expect([...small].filter((k) => !large.has(k))).toEqual([]);
  });
});

describe("wind", () => {
  it("is bounded", () => {
    for (const wind of [0, 0.5, 1]) {
      for (const gusts of [0, 0.6, 1]) {
        for (let i = 0; i < 400; i++) {
          const b = windAt(i * 0.37 - 60, 0.8 + (i % 40) * 1.3, (i * 0.0137) % 1, wind, gusts);
          expect(b).toBeGreaterThanOrEqual(wind * (BEND_BASE - BEND_SWAY) - 1e-9);
          expect(b).toBeLessThanOrEqual(wind * (BEND_BASE + BEND_SWAY + BEND_GUST) + 1e-9);
        }
      }
    }
  });

  it("is continuous in space and time, including where the phase wraps", () => {
    const step = 1e-4;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.41 - 40;
      const z = 1 + (i % 30) * 0.7;
      const t = (i * 0.031) % 1;
      const b = windAt(x, z, t, 1, 1);
      expect(Math.abs(windAt(x + step, z, t, 1, 1) - b)).toBeLessThan(0.01);
      expect(Math.abs(windAt(x, z + step, t, 1, 1) - b)).toBeLessThan(0.01);
      expect(Math.abs(windAt(x, z, t + step / 100, 1, 1) - b)).toBeLessThan(0.01);
      // Phase 1 is phase 0: every term is whole cycles per period.
      expect(windAt(x, z, 1 - 1e-9, 1, 1)).toBeCloseTo(windAt(x, z, 0, 1, 1), 4);
    }
  });

  it("waves stay in [-1, 1] and the rate rises with wind", () => {
    for (let i = 0; i < 100; i++)
      expect(Math.abs(windWave(i * 1.7, i * 0.3, i * 0.01))).toBeLessThanOrEqual(1);
    expect(windRate(1)).toBeGreaterThan(windRate(0));
    expect(windRate(0)).toBeGreaterThan(0);
  });
});

describe("bend curve", () => {
  const pts = new Float64Array(2 * (SEGMENTS + 1));
  const length = (p: Float64Array) => {
    let sum = 0;
    for (let k = 0; k < SEGMENTS; k++) {
      sum += Math.hypot(p[2 * k + 2] - p[2 * k], p[2 * k + 3] - p[2 * k + 1]);
    }
    return sum;
  };

  it("keeps the blade's length at every bend, with the tip moving most", () => {
    let lastChord = Infinity;
    for (const angle of [0, 0.3, 0.7, 1.1, BEND_LIMIT]) {
      bendPoints(angle, 2, pts);
      expect(length(pts)).toBeCloseTo(2, 9);
      const chord = Math.hypot(pts[2 * SEGMENTS], pts[2 * SEGMENTS + 1]);
      expect(chord).toBeLessThanOrEqual(lastChord + 1e-12);
      lastChord = chord;
      // Lateral displacement grows towards the tip.
      for (let k = 1; k <= SEGMENTS; k++) expect(pts[2 * k]).toBeGreaterThanOrEqual(pts[2 * k - 2]);
    }
  });

  it("clamps the tip angle", () => {
    expect(tipAngle(10, 1.25, 0.1, 0.2)).toBe(BEND_LIMIT);
    expect(tipAngle(-10, 1.25, 0, 0)).toBe(-BEND_LIMIT);
    expect(tipAngle(0, 1, 0, 0.1)).toBeCloseTo(0.1);
  });
});

describe("palettes and strip", () => {
  it("has a 7-vertex strip ending in a single tip", () => {
    expect(BLADE_STRIP.length).toBe(14);
    expect(BLADE_STRIP.slice(-2)).toEqual([SEGMENTS, 0]);
  });

  it("keeps colours in range", () => {
    const channels = [...Object.values(FIELDS), ...Object.values(SUNS)].flatMap((p) =>
      Object.values(p).flatMap((v: unknown) => (Array.isArray(v) ? (v as number[]) : [])),
    );
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.filter((c) => !(c >= 0 && c <= 1))).toEqual([]);
  });
});
