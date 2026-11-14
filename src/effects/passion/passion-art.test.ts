import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { createMeasure, paintCaption } from "./passion-art";
import { type CaptionStyle, layoutCaption } from "./passion-sim";

beforeEach(() => {
  MeasuringCanvas.reset(0.6);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("caption art", () => {
  it("measures words in ems of the caption font", () => {
    expect(createMeasure("meme")("abcd")).toBeCloseTo(2.4);
  });

  const cases = (["meme", "wordart"] as const).flatMap((style) =>
    [40, 400, 4000].map((px) => [style, px] as const),
  );

  it.each(cases)("packs every %s word inside the atlas at %i px", (style: CaptionStyle, px) => {
    const text = "graphic design is my passion\nWWWWWWWWWWWWWWWWWWWWWWWWWWWW";
    const layout = layoutCaption(text, style, 1, 1920, createMeasure(style));
    const art = paintCaption(layout, style, px);
    const canvas = art.canvas as unknown as MeasuringCanvas;
    expect(canvas.width).toBeLessThanOrEqual(4096);
    expect(canvas.height).toBeLessThanOrEqual(4096);
    expect(art.uv).toHaveLength(layout.words.length * 4);
    expect(Array.from(art.uv).every((v) => v >= 0 && v <= 1)).toBe(true);
    const drawn = MeasuringCanvas.calls
      .filter((c) => c.method === "fillText")
      .map((c) => c.args[0]);
    expect(drawn).toEqual(layout.words.map((w) => w.text));
  });

  it("paints nothing for an empty caption", () => {
    const layout = layoutCaption("", "meme", 1, 1920, createMeasure("meme"));
    expect(paintCaption(layout, "meme", 96).canvas).toBeNull();
  });
});
