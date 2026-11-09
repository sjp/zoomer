import { describe, expect, it } from "vitest";
import { buildGradientLut, hexToRgb, hexToUnitRgb, unitRgbMemo } from "./color";

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

describe("buildGradientLut", () => {
  const texel = (lut: Uint8Array, i: number) => [...lut.subarray(i * 4, i * 4 + 4)];

  it("runs from the first stop to the last, opaque", () => {
    const lut = buildGradientLut(
      [
        [0, "#000000"],
        [1, "#ff8000"],
      ],
      new Uint8Array(5 * 4),
    );
    expect(texel(lut, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(lut, 4)).toEqual([255, 128, 0, 255]);
    // Smoothstep-eased: halfway in position is halfway in colour.
    expect(texel(lut, 2)).toEqual([128, 64, 0, 255]);
    // and a quarter of the way in is less than a quarter of the colour.
    expect(texel(lut, 1)[0]).toBeLessThan(64);
  });

  it("passes through every stop and holds before the first", () => {
    const lut = buildGradientLut(
      [
        [0.25, "#ff0000"],
        [0.5, "#00ff00"],
        [1, "#0000ff"],
      ],
      new Uint8Array(9 * 4),
    );
    expect(texel(lut, 0)).toEqual([255, 0, 0, 255]);
    expect(texel(lut, 2)).toEqual([255, 0, 0, 255]);
    expect(texel(lut, 4)).toEqual([0, 255, 0, 255]);
    expect(texel(lut, 8)).toEqual([0, 0, 255, 255]);
  });
});
