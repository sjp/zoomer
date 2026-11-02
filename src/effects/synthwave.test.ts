import { describe, expect, it } from "vitest";
import { generateRidge } from "./synthwave";

describe("generateRidge", () => {
  it("spans exactly 0..1", () => {
    const out = new Float32Array(129);
    generateRidge(out, 150405, 0.55);
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBe(1);
  });

  it("is deterministic for a seed and differs between seeds", () => {
    const a = new Float32Array(129);
    const b = new Float32Array(129);
    const c = new Float32Array(129);
    generateRidge(a, 57466, 0.5);
    generateRidge(b, 57466, 0.5);
    generateRidge(c, 57467, 0.5);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });
});
