import { describe, expect, it } from "vitest";
import { hash32 } from "./noise";

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
