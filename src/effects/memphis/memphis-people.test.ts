import { describe, expect, it } from "vitest";
import { limbKnots } from "./memphis-people";

describe("corporate memphis people", () => {
  it("keeps sleeve ends, cuffs and folds their size on a stretched arm", () => {
    // Knots (a, lo, hi) on a bone usually 0.2 long: a sleeve end near the
    // start, a fold near the end, and the bone's two ends.
    const knots = [0, -1, 1, 0.05, -2, 2, 0.14, -3, 3, 0.2, -4, 4];
    const a = (k: readonly number[]) => k.filter((_, i) => i % 3 === 0);
    expect(a(limbKnots(knots, 0.2, 0.2))).toEqual([0, 0.05, 0.14, 0.2]);
    const stretched = Array.from(limbKnots(knots, 0.2, 0.8));
    expect(a(stretched)[0]).toBe(0);
    expect(a(stretched)[1]).toBeCloseTo(0.05, 12);
    expect(a(stretched)[2]).toBeCloseTo(0.74, 12);
    expect(a(stretched)[3]).toBeCloseTo(0.8, 12);
    // Widths are untouched.
    expect(stretched.filter((_, i) => i % 3 === 2)).toEqual([1, 2, 3, 4]);
    // A shorter bone scales the knots down in order.
    expect(a(limbKnots(knots, 0.2, 0.1)).map((v) => Math.round(v * 1000))).toEqual([
      0, 25, 70, 100,
    ]);
  });
});
