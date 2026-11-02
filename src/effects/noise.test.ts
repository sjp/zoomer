import { describe, expect, it } from "vitest";
import { buildPeriodicNoiseTexture, createNoise, hash32 } from "./noise";

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
      for (let i = 0; i < 16 * 16; i++) expect(tex[i * 3 + c]).toBe(single[i]);
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
