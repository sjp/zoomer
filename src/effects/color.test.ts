import { describe, expect, it } from "vitest";
import { hexToRgb, hexToUnitRgb, unitRgbMemo } from "./color";

describe("hexToRgb", () => {
  it("parses six-digit hex, with or without #", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("0A0B0c")).toEqual([10, 11, 12]);
  });

  it("falls back to black on bad input", () => {
    expect(hexToRgb("#fff")).toEqual([0, 0, 0]);
    expect(hexToRgb("nonsense")).toEqual([0, 0, 0]);
  });
});

describe("unitRgbMemo", () => {
  it("returns hexToUnitRgb, reusing the array while the colour is unchanged", () => {
    const memo = unitRgbMemo();
    const a = memo("#ff0000");
    expect(a).toEqual(hexToUnitRgb("#ff0000"));
    expect(memo("#ff0000")).toBe(a);
    const b = memo("#00ff00");
    expect(b).toEqual([0, 1, 0]);
    expect(b).not.toBe(a);
  });

  it("keeps separate memos independent", () => {
    const m1 = unitRgbMemo();
    const m2 = unitRgbMemo();
    expect(m1("#ffffff")).toEqual([1, 1, 1]);
    expect(m2("#000000")).toEqual([0, 0, 0]);
    expect(m1("#ffffff")).toEqual([1, 1, 1]);
  });
});
