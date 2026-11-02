import { describe, expect, it } from "vitest";
import { growArray } from "./rain";

describe("growArray", () => {
  it("returns the same array when it is already long enough", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(growArray(a, 2, 2)).toBe(a);
    expect(growArray(a, 3, 0)).toBe(a);
  });

  it("grows into a new array of the same type, keeping the first elements", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = growArray(a, 5, 2);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(Array.from(b)).toEqual([1, 2, 0, 0, 0]);
  });

  it("copies no more than the old array holds", () => {
    const b = growArray(new Float32Array([4, 5]), 4, 10);
    expect(Array.from(b)).toEqual([4, 5, 0, 0]);
  });
});
