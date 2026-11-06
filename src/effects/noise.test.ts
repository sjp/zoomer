import { describe, expect, it } from "vitest";
import {
  MAX_PERIOD,
  buildPeriodicNoiseTexture,
  createNoise,
  createRng,
  fbm2,
  fbm3,
  fbmPeriodic2,
  hash32,
  toPeriod,
} from "./noise";

/** Reference lowbias32 in BigInt arithmetic, independent of Math.imul. */
function reference(x: number): number {
  const M = 0xffffffffn;
  let h = BigInt(x >>> 0);
  h ^= h >> 16n;
  h = (h * 0x7feb352dn) & M;
  h ^= h >> 15n;
  h = (h * 0x846ca68bn) & M;
  h ^= h >> 16n;
  return Number(h);
}

describe("hash32", () => {
  it("matches lowbias32", () => {
    for (const x of [0, 1, 2, 42, 0x7fffffff, 0x80000000, 0xffffffff, 123456789]) {
      expect(hash32(x)).toBe(reference(x));
    }
  });

  it("returns unsigned 32-bit integers", () => {
    for (let x = 0; x < 1000; x++) {
      const h = hash32(x);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it("wraps inputs to 32 bits, as the shader's uint does", () => {
    expect(hash32(-1)).toBe(hash32(0xffffffff));
    expect(hash32(2 ** 32 + 5)).toBe(hash32(5));
  });
});

describe("createRng", () => {
  it("is deterministic per seed and truncates fractional seeds", () => {
    const take = (rng: () => number) => Array.from({ length: 20 }, rng);
    expect(take(createRng(42))).toEqual(take(createRng(42)));
    expect(take(createRng(42.9))).toEqual(take(createRng(42)));
    expect(take(createRng(43))).not.toEqual(take(createRng(42)));
  });

  it("returns floats in [0, 1) spread across the range", () => {
    // Plain comparisons in the hot loop: an expect per draw costs far more than the check.
    const outside: string[] = [];
    for (const seed of [0, 1, -7, 2 ** 40, Number.NaN]) {
      const rng = createRng(seed);
      const buckets = Array.from({ length: 10 }, () => 0);
      for (let i = 0; i < 10000; i++) {
        const v = rng();
        if (!(v >= 0 && v < 1) && outside.length < 10) {
          outside.push(`seed ${String(seed)}, draw ${String(i)}: ${String(v)}`);
        }
        buckets[Math.floor(v * 10)]++;
      }
      for (const n of buckets) {
        expect(n).toBeGreaterThan(800);
      }
    }
    expect(outside).toEqual([]);
  });
});

describe("noise2", () => {
  it("is deterministic per seed", () => {
    const a = createNoise(4);
    const b = createNoise(4);
    const c = createNoise(5);
    let differs = false;
    for (let i = 0; i < 100; i++) {
      const x = i * 0.37 - 5;
      const y = i * -0.73 + 3;
      expect(b.noise2(x, y)).toBe(a.noise2(x, y));
      if (c.noise2(x, y) !== a.noise2(x, y)) {
        differs = true;
      }
    }
    expect(differs).toBe(true);
  });

  it("stays roughly within [-1, 1] and uses most of it", () => {
    const noise = createNoise(8);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < 20000; i++) {
      const v = noise.noise2(i * 0.173, i * 0.0291);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThan(-0.6);
    expect(hi).toBeGreaterThan(0.6);
  });
});

describe("noise3", () => {
  it("keeps its field (flowfield's particle paths depend on it)", () => {
    const noise = createNoise(1);
    expect(noise.noise3(0.3, 1.7, 2.9)).toBeCloseTo(0.0318509966748971, 12);
    expect(noise.noise3(-4.2, 0.5, 10.1)).toBeCloseTo(0.1361191769547316, 12);
    expect(noise.noise3(12.5, -3.25, 0.75)).toBeCloseTo(0.25162646604938455, 12);
  });

  it("stays roughly within [-1, 1]", () => {
    const noise = createNoise(3);
    for (let i = 0; i < 2000; i++) {
      const v = noise.noise3(i * 0.37, i * -0.11, i * 0.053);
      expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
  });
});

describe("buildPeriodicNoiseTexture", () => {
  it("interleaves one byte per channel per texel", () => {
    const channels = [
      { period: 4, seed: 1 },
      { period: 8, seed: 2 },
      { period: 4, seed: 3 },
    ];
    const tex = buildPeriodicNoiseTexture(16, channels);
    expect(tex).toHaveLength(16 * 16 * 3);
    // Each channel matches the same channel built on its own.
    channels.forEach((ch, c) => {
      const single = buildPeriodicNoiseTexture(16, [ch]);
      for (let i = 0; i < 16 * 16; i++) {
        expect(tex[i * 3 + c]).toBe(single[i]);
      }
    });
  });

  it("maps zero noise to mid-grey at lattice points", () => {
    // Gradient noise is zero on its lattice, which a period of 4 over 16 texels hits
    // every 4th texel.
    const tex = buildPeriodicNoiseTexture(16, [{ period: 4, seed: 9 }]);
    expect(tex[0]).toBe(128);
    expect(tex[4 * 16 + 8]).toBe(128);
  });
});

describe("toPeriod", () => {
  it("passes valid periods through", () => {
    for (const p of [1, 2, 7, 100, MAX_PERIOD]) {
      expect(toPeriod(p)).toBe(p);
    }
  });

  it("rounds, clamps and replaces NaN", () => {
    expect(toPeriod(2.4)).toBe(2);
    expect(toPeriod(2.6)).toBe(3);
    expect(toPeriod(0)).toBe(1);
    expect(toPeriod(-5)).toBe(1);
    expect(toPeriod(1000)).toBe(MAX_PERIOD);
    expect(toPeriod(Infinity)).toBe(MAX_PERIOD);
    expect(toPeriod(Number.NaN)).toBe(1);
  });
});

describe("periodic2", () => {
  const noise = createNoise(5);

  it("tiles with its period", () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.731;
      const y = i * 0.419;
      expect(noise.periodic2(x + 12, y - 7, 12, 7)).toBeCloseTo(noise.periodic2(x, y, 12, 7), 12);
    }
  });

  it("stays finite for out-of-range and fractional periods", () => {
    for (const p of [0, -3, 2.5, 257, 300, 1000, Number.NaN, Infinity]) {
      for (let i = 0; i < 200; i++) {
        const v = noise.periodic2(i * 1.37 + 0.2, i * 0.91 + 0.4, p, p);
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("treats an out-of-range period as its coerced one", () => {
    expect(noise.periodic2(3.3, 5.7, 1000, 2.6)).toBe(noise.periodic2(3.3, 5.7, MAX_PERIOD, 3));
  });
});

describe("fbm", () => {
  const noise = createNoise(6);

  it("stays roughly within [-1, 1]", () => {
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.311;
      const y = i * -0.177;
      expect(Math.abs(fbm2(noise, x, y, 5))).toBeLessThanOrEqual(1);
      expect(Math.abs(fbm3(noise, x, y, i * 0.05, 4))).toBeLessThanOrEqual(1);
      expect(Math.abs(fbmPeriodic2(noise, x, y, 16, 4))).toBeLessThanOrEqual(1);
    }
  });

  it("returns 0 for zero octaves rather than NaN", () => {
    expect(fbm2(noise, 1.3, 2.7, 0)).toBe(0);
    expect(fbm3(noise, 1.3, 2.7, 0.4, 0)).toBe(0);
    expect(fbmPeriodic2(noise, 1.3, 2.7, 8, 0)).toBe(0);
  });

  it("drops fbmPeriodic2 octaves whose period would pass MAX_PERIOD", () => {
    // 64 * 2^2 = 256 is the last octave that fits, so 3 and 9 octaves match.
    for (let i = 0; i < 50; i++) {
      const x = i * 0.53;
      const y = i * 1.21;
      const v = fbmPeriodic2(noise, x, y, 64, 9);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(fbmPeriodic2(noise, x, y, 64, 3));
    }
  });

  it("keeps fbmPeriodic2 tiling with its period when octaves are dropped", () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.53;
      const y = i * 1.21;
      expect(fbmPeriodic2(noise, x + 100, y + 100, 100, 6)).toBeCloseTo(
        fbmPeriodic2(noise, x, y, 100, 6),
        12,
      );
    }
  });
});
