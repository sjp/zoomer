import { describe, expect, it } from "vitest";
import { hexToRgb, hexToUnitRgb, unitRgbMemo } from "./color";

describe("hexToRgb", () => {
  it("parses six-digit hex, with or without #", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("0A0B0c")).toEqual([10, 11, 12]);
  });

  it("falls back to black on bad input", () => {
    for (const bad of [
      "#fff",
      "nonsense",
      "",
      "#",
      "#ff00zz",
      "#fffffff",
      " #ffffff",
      "#ff ff ff",
    ]) {
      expect(hexToRgb(bad)).toEqual([0, 0, 0]);
    }
  });

  it("round-trips every channel value through hex", () => {
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    for (let v = 0; v < 256; v++) {
      const rgb: [number, number, number] = [v, 255 - v, (v * 7) & 255];
      expect(hexToRgb(`#${rgb.map((c) => hex(c)).join("")}`)).toEqual(rgb);
    }
  });

  it("maps to unit channels", () => {
    expect(hexToUnitRgb("#ff0033")).toEqual([1, 0, 0.2]);
    expect(hexToUnitRgb("bad")).toEqual([0, 0, 0]);
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
