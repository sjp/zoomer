import { describe, expect, it } from "vitest";
import { buildGradientLut, createColorEase, hexToRgb, hexToUnitRgb, unitRgbMemo } from "./color";

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

describe("createColorEase", () => {
  it("snaps on the first step, then crossfades over the given time", () => {
    const ease = createColorEase(2);
    expect([...ease.step([1, 0.5], 1 / 60, 1)]).toEqual([1, 0.5]);
    expect(ease.moving).toBe(false);
    const v = ease.step([0, 1], 0.5, 1);
    // Halfway in time is halfway in value on a smoothstep.
    expect(v[0]).toBeCloseTo(0.5, 6);
    expect(v[1]).toBeCloseTo(0.75, 6);
    expect(ease.moving).toBe(true);
    ease.step([0, 1], 0.25, 1);
    expect(v[0]).toBeLessThan(0.5);
    expect(v[0]).toBeGreaterThan(0);
    ease.step([0, 1], 0.25, 1);
    expect([...v]).toEqual([0, 1]);
    expect(ease.moving).toBe(false);
  });

  it("restarts from the current values when the target changes mid-way", () => {
    const ease = createColorEase(1);
    ease.step([0], 0, 1);
    const v = ease.step([1], 0.5, 1);
    expect(v[0]).toBeCloseTo(0.5, 6);
    ease.step([0], 0, 1);
    expect(v[0]).toBeCloseTo(0.5, 6);
    ease.step([0], 1, 1);
    expect(v[0]).toBe(0);
  });

  it("jumps after snap, and with no duration or a non-finite step", () => {
    const ease = createColorEase(1);
    ease.step([0], 0, 1);
    ease.snap();
    expect(ease.step([0.25], 0, 1)[0]).toBe(0.25);
    expect(ease.step([0.75], 0, 0)[0]).toBe(0.75);
    expect(ease.step([0.5], Number.POSITIVE_INFINITY, 1)[0]).toBe(0.5);
  });

  it("allocates nothing per step and keeps returning the same array", () => {
    const ease = createColorEase(3);
    const first = ease.step([0, 0, 0], 0, 1);
    expect(ease.step([1, 1, 1], 0.1, 1)).toBe(first);
    expect(ease.value).toBe(first);
  });
});
