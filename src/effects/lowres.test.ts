import { describe, expect, it } from "vitest";
import { lowResSize, qualityDivisor, rendersDirect } from "./lowres";

describe("lowResSize", () => {
  it("divides and rounds up", () => {
    expect(lowResSize(3840, 2)).toBe(1920);
    expect(lowResSize(3840, 3)).toBe(1280);
    expect(lowResSize(2160, 8)).toBe(270);
    expect(lowResSize(1081, 2)).toBe(541);
    expect(lowResSize(5, 4)).toBe(2);
  });

  it("supports fractional divisors without float rounding up", () => {
    expect(lowResSize(1080, 1.5)).toBe(720);
    expect(lowResSize(1081, 1.5)).toBe(721);
    expect(lowResSize(1920, 1.2)).toBe(1600);
  });

  it("is at least 1x1", () => {
    expect(lowResSize(0, 2)).toBe(1);
    expect(lowResSize(1, 8)).toBe(1);
    expect(lowResSize(-10, 2)).toBe(1);
    expect(lowResSize(Number.NaN, 2)).toBe(1);
  });

  it("treats invalid divisors as 1", () => {
    expect(lowResSize(100, 0)).toBe(100);
    expect(lowResSize(100, 0.5)).toBe(100);
    expect(lowResSize(100, Number.NaN)).toBe(100);
  });
});

describe("qualityDivisor", () => {
  it("maps labels to divisors", () => {
    expect(qualityDivisor("high")).toBe(1);
    expect(qualityDivisor("balanced")).toBe(2);
    expect(qualityDivisor("low")).toBe(3);
    expect(qualityDivisor("nonsense")).toBe(2);
    expect(qualityDivisor("low", { high: 4, balanced: 6, low: 8 })).toBe(8);
  });
});

describe("rendersDirect", () => {
  it("renders direct only for a full-size, plain-copy, 8-bit target", () => {
    expect(rendersDirect(3840, 2160, 3840, 2160, false, false)).toBe(true);
    expect(rendersDirect(3840, 2160, 1920, 1080, false, false)).toBe(false);
    expect(rendersDirect(3840, 2160, 3840, 2160, true, false)).toBe(false);
    expect(rendersDirect(3840, 2160, 3840, 2160, false, true)).toBe(false);
  });

  it("follows lowResSize at divisor 1", () => {
    expect(rendersDirect(1081, 7, lowResSize(1081, 1), lowResSize(7, 1), false, false)).toBe(true);
    expect(rendersDirect(1081, 7, lowResSize(1081, 1.01), lowResSize(7, 1), false, false)).toBe(
      false,
    );
  });
});
