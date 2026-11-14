import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../test/offscreen-canvas";
import { CLASHING_COLORS, clashingColors, createEmMeasure, drawOutlinedText } from "./meme-art";

describe("clashing colours", () => {
  const cases = [0, 1, 7, 42, 500, 999].flatMap((seed) =>
    [1, 2, 5, 28].map((count) => [seed, count] as const),
  );

  it.each(cases)("never repeat between neighbours (seed %i, %i items)", (seed, count) => {
    const colors = clashingColors(seed, count);
    expect(colors).toHaveLength(count);
    expect(colors.every((c) => c >= 0 && c < CLASHING_COLORS.length)).toBe(true);
    expect(colors.filter((c, i) => i > 0 && c === colors[i - 1])).toEqual([]);
  });

  it.each([1, 42])("keep earlier items' colours when items are added (seed %i)", (seed) => {
    expect(clashingColors(seed, 28).slice(0, 5)).toEqual(clashingColors(seed, 5));
  });

  it("change with the seed", () => {
    expect(clashingColors(1, 8)).not.toEqual(clashingColors(2, 8));
  });
});

describe("meme text on a canvas", () => {
  beforeEach(() => {
    MeasuringCanvas.reset(0.6);
    vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("measures in ems", () => {
    expect(createEmMeasure()("abcd")).toBeCloseTo(2.4);
  });

  it("strokes the outline before filling", () => {
    const canvas = new MeasuringCanvas(8, 8);
    const ctx = canvas.getContext() as unknown as OffscreenCanvasRenderingContext2D;
    MeasuringCanvas.calls.length = 0;
    drawOutlinedText(ctx, "hi", 1, 2, "#fff", "#000", 3);
    expect(MeasuringCanvas.calls.map((c) => c.method)).toEqual(["strokeText", "fillText"]);
  });
});
