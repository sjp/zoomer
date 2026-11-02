import { describe, expect, it } from "vitest";
import {
  arcPosition,
  BACK_BASE,
  buildHills,
  CLOCK_READ_INTERVAL,
  createDayClock,
  createSkyState,
  FRONT_BASE,
  HILL_COLUMNS,
  hillHeightAt,
  localDayPhase,
  lunarPhase,
  MAX_LAYERS,
  moonTerminator,
  nightAmount,
  placeTrees,
  sampleSky,
  SKY_KEYS,
  type SkyState,
  TREE_FLOATS,
} from "./horizon-sim";

const MEADOW = { amp: 1, ridge: 0, freq: 1 };
const MOUNTAINS = { amp: 1.9, ridge: 0.8, freq: 1.3 };

/** Smallest distance between two phases on the [0, 1) circle. */
const circDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
};

describe("localDayPhase", () => {
  it("maps midnight to 0, noon to 0.5 and the last millisecond to just under 1", () => {
    expect(localDayPhase(new Date(2026, 10, 2, 0, 0, 0, 0))).toBe(0);
    expect(localDayPhase(new Date(2026, 10, 2, 12, 0, 0, 0))).toBe(0.5);
    const last = localDayPhase(new Date(2026, 10, 2, 23, 59, 59, 999));
    expect(last).toBeLessThan(1);
    expect(last).toBeGreaterThan(0.99999);
  });
});

describe("createDayClock", () => {
  it("fixed mode follows the hour, with 24 wrapping to midnight", () => {
    const clock = createDayClock(() => 0);
    expect(clock.step(0.016, "fixed", 10, 6)).toBe(0.25);
    expect(clock.step(0.016, "fixed", 10, 18)).toBe(0.75);
    expect(clock.step(0.016, "fixed", 10, 24)).toBe(0);
  });

  it("cycle mode runs one day per cycleMins and wraps", () => {
    const clock = createDayClock(() => 0, 0.9);
    clock.step(0, "cycle", 2, 0);
    // A 2-minute day: 24 s is a fifth of it.
    let phase = 0;
    for (let i = 0; i < 240; i++) phase = clock.step(0.1, "cycle", 2, 0);
    expect(phase).toBeCloseTo(0.1, 9);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
  });

  it("cycle mode continues from the current phase and doesn't jump when the speed changes", () => {
    const clock = createDayClock(() => 0);
    clock.step(0, "fixed", 10, 15);
    expect(clock.step(0, "cycle", 10, 15)).toBeCloseTo(15 / 24, 12);
    const before = clock.step(0.1, "cycle", 10, 15);
    const after = clock.step(0.1, "cycle", 60, 15);
    expect(circDist(before, after)).toBeLessThan(1e-4);
  });

  it("local mode reads the clock about once a second and interpolates between", () => {
    let reads = 0;
    let wall = 0.5;
    const clock = createDayClock(() => {
      reads++;
      return wall;
    });
    expect(clock.step(0.016, "local", 10, 0)).toBe(0.5);
    expect(reads).toBe(1);
    let phase = 0.5;
    for (let i = 0; i < 9; i++) phase = clock.step(0.1, "local", 10, 0);
    expect(reads).toBe(1);
    expect(phase).toBeCloseTo(0.5 + 0.9 / 86400, 12);
    wall = 0.6;
    for (let t = 0; t < CLOCK_READ_INTERVAL + 0.2; t += 0.1)
      phase = clock.step(0.1, "local", 10, 0);
    expect(reads).toBe(2);
    expect(phase).toBeGreaterThanOrEqual(0.6);
  });

  it("local mode wraps through midnight between reads and on the next read", () => {
    let wall = 1 - 0.05 / 86400;
    const clock = createDayClock(() => wall);
    clock.step(0, "local", 10, 0);
    const phase = clock.step(0.1, "local", 10, 0);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeCloseTo(0.05 / 86400, 9);
    wall = 1.5 / 86400;
    let next = phase;
    for (let i = 0; i < 12; i++) next = clock.step(0.1, "local", 10, 0);
    expect(next).toBeLessThan(0.001);
  });
});

describe("sampleSky", () => {
  const flat = (s: SkyState) => [...s.zenith, ...s.horizon, ...s.glow, ...s.light, s.glowStrength];

  it("hits each keyframe exactly at its hour", () => {
    const s = createSkyState();
    for (const k of SKY_KEYS) {
      sampleSky(k.hour / 24, s);
      expect(flat(s)).toEqual(
        [...k.zenith, ...k.horizon, ...k.glow, ...k.light, k.glowStrength].map((v) =>
          expect.closeTo(v, 9),
        ),
      );
    }
  });

  it("is continuous over the whole day, including across midnight", () => {
    const a = createSkyState();
    const b = createSkyState();
    const step = 1 / 24 / 600;
    for (let phase = -0.01; phase < 1.01; phase += step) {
      sampleSky(phase, a);
      sampleSky(phase + step, b);
      const fa = flat(a);
      const fb = flat(b);
      for (let i = 0; i < fa.length; i++) expect(Math.abs(fa[i] - fb[i])).toBeLessThan(0.01);
    }
    sampleSky(1 - 1e-9, a);
    sampleSky(0, b);
    flat(a).forEach((v, i) => expect(v).toBeCloseTo(flat(b)[i], 6));
  });

  it("is dark at midnight, bright at noon and warm at sunset", () => {
    const s = createSkyState();
    sampleSky(0, s);
    expect(Math.max(...s.zenith)).toBeLessThan(0.15);
    expect(s.glowStrength).toBe(0);
    sampleSky(0.5, s);
    expect(s.zenith[2]).toBeGreaterThan(0.7);
    expect(s.light).toEqual([1, 1, 1]);
    sampleSky(18.15 / 24, s);
    expect(s.horizon[0]).toBeGreaterThan(s.horizon[2]);
  });

  it("keeps the keyframes in increasing hour order within a day", () => {
    for (let i = 1; i < SKY_KEYS.length; i++) {
      expect(SKY_KEYS[i].hour).toBeGreaterThan(SKY_KEYS[i - 1].hour);
    }
    expect(SKY_KEYS.at(-1)!.hour).toBeLessThan(24);
  });
});

describe("arcPosition", () => {
  const pt = { x: 0, elevation: 0 };

  it("rises at the left at 06:00, peaks at the centre at noon and sets at the right at 18:00", () => {
    arcPosition(0.25, false, pt);
    expect(pt.elevation).toBeCloseTo(0, 12);
    expect(pt.x).toBeLessThan(0.1);
    arcPosition(0.5, false, pt);
    expect(pt.elevation).toBeCloseTo(1, 12);
    expect(pt.x).toBeCloseTo(0.5, 12);
    arcPosition(0.75, false, pt);
    expect(pt.elevation).toBeCloseTo(0, 12);
    expect(pt.x).toBeGreaterThan(0.9);
    arcPosition(0, false, pt);
    expect(pt.elevation).toBeCloseTo(-1, 12);
  });

  it("puts the moon opposite the sun, highest at midnight", () => {
    const sun = { x: 0, elevation: 0 };
    for (let phase = 0; phase < 1; phase += 0.01) {
      arcPosition(phase, false, sun);
      arcPosition(phase, true, pt);
      expect(pt.elevation).toBeCloseTo(-sun.elevation, 9);
      expect(pt.x).toBeCloseTo(1 - sun.x, 9);
    }
    arcPosition(0, true, pt);
    expect(pt.elevation).toBeCloseTo(1, 12);
  });

  it("brings the night in only once the sun has set", () => {
    expect(nightAmount(0.2)).toBe(0);
    expect(nightAmount(-0.02)).toBe(0);
    expect(nightAmount(-0.5)).toBe(1);
  });
});

describe("moon", () => {
  it("computes the lunar phase from a known full moon", () => {
    // Full moon: 2024-01-25 17:54 UTC.
    expect(circDist(lunarPhase(Date.UTC(2024, 0, 25, 17, 54)), 0.5)).toBeLessThan(0.02);
    // New moon: 2024-02-09 22:59 UTC.
    expect(circDist(lunarPhase(Date.UTC(2024, 1, 9, 22, 59)), 0)).toBeLessThan(0.02);
  });

  it("lights none of the disc when new, all when full and the right half at first quarter", () => {
    const t = { k: 0, side: 0, lit: 0 };
    expect(moonTerminator(0, t)).toMatchObject({ k: 1, lit: 0 });
    moonTerminator(0.5, t);
    expect(t.k).toBeCloseTo(-1, 12);
    expect(t.lit).toBeCloseTo(1, 12);
    moonTerminator(0.25, t);
    expect(t.k).toBeCloseTo(0, 12);
    expect(t.side).toBe(1);
    moonTerminator(0.75, t);
    expect(t.side).toBe(-1);
  });
});

describe("buildHills", () => {
  const build = (layers: number, seed: number, shape = MEADOW) => {
    const out = new Float32Array(MAX_LAYERS * HILL_COLUMNS);
    const min = new Float64Array(MAX_LAYERS);
    const max = new Float64Array(MAX_LAYERS);
    buildHills(out, layers, seed, shape, min, max);
    return { out, min, max };
  };
  const mean = (out: Float32Array, l: number) => {
    let s = 0;
    for (let c = 0; c < HILL_COLUMNS; c++) s += out[l * HILL_COLUMNS + c];
    return s / HILL_COLUMNS;
  };

  it("is deterministic for a seed and differs between seeds", () => {
    expect(build(4, 7).out).toEqual(build(4, 7).out);
    expect(build(4, 8).out).not.toEqual(build(4, 7).out);
  });

  it.each([3, 4, 5])("orders %i layers back (high) to front (low)", (layers) => {
    for (const shape of [MEADOW, MOUNTAINS]) {
      const { out, min, max } = build(layers, 42, shape);
      for (let l = 1; l < layers; l++) {
        expect(mean(out, l)).toBeLessThan(mean(out, l - 1));
      }
      expect(mean(out, 0)).toBeCloseTo(BACK_BASE, 1);
      expect(mean(out, layers - 1)).toBeCloseTo(FRONT_BASE, 1);
      for (let l = 0; l < layers; l++) {
        const row = out.subarray(l * HILL_COLUMNS, (l + 1) * HILL_COLUMNS);
        expect(Math.min(...row)).toBeCloseTo(min[l], 6);
        expect(Math.max(...row)).toBeCloseTo(max[l], 6);
        expect(min[l]).toBeGreaterThan(0);
        expect(max[l]).toBeLessThan(0.7);
      }
      // Unused rows stay empty.
      for (let i = layers * HILL_COLUMNS; i < out.length; i++) expect(out[i]).toBe(0);
    }
  });

  it("clamps the layer count to 3..5", () => {
    expect(build(1, 3).max[2]).toBeGreaterThan(0);
    expect(build(1, 3).max[3]).toBe(0);
    expect(build(9, 3).max[4]).toBeGreaterThan(0);
  });
});

describe("placeTrees", () => {
  it("plants trees on the front ridge, fewer in the middle, deterministically", () => {
    const out = new Float32Array(MAX_LAYERS * HILL_COLUMNS);
    buildHills(out, 4, 7, MEADOW, new Float64Array(MAX_LAYERS), new Float64Array(MAX_LAYERS));
    const trees = new Float32Array(48 * TREE_FLOATS);
    const n = placeTrees(trees, 48, out, 3, 7);
    expect(n).toBeGreaterThan(20);
    expect(n).toBeLessThanOrEqual(48);
    let middle = 0;
    for (let i = 0; i < n; i++) {
      const o = i * TREE_FLOATS;
      expect(trees[o + 1]).toBeCloseTo(hillHeightAt(out, 3, trees[o]), 6);
      expect(trees[o + 2]).toBeGreaterThan(trees[o + 3]);
      if (Math.abs(trees[o] - 0.5) < 0.2) middle++;
    }
    expect(middle).toBeLessThan(n * 0.25);
    const again = new Float32Array(48 * TREE_FLOATS);
    expect(placeTrees(again, 48, out, 3, 7)).toBe(n);
    expect(again).toEqual(trees);
  });
});
