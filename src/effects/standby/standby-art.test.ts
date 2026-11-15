import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { createMeasure, paintCard, paintParts, paintSign, PART_CELLS } from "./standby-art";
import { layoutSign, type StandbyStyle } from "./standby-sim";

beforeEach(() => {
  MeasuringCanvas.reset(0.6);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const STYLES: StandbyStyle[] = ["analogue", "digital", "cartoon"];

describe("standby art", () => {
  it("measures text in ems of the style's font", () => {
    expect(createMeasure("analogue")("abcd", "title")).toBeCloseTo(2.4);
  });

  const sizes = STYLES.flatMap((style) =>
    [
      [1280, 720],
      [3840, 2160],
      [1080, 1920],
    ].map(([w, h]) => [style, w, h] as const),
  );

  it.each(sizes)("paints the %s sign's lines at %i x %i", (style, w, h) => {
    const scale = h / 1080;
    const layout = layoutSign(
      "PLEASE\nSTAND BY",
      "We are experiencing technical difficulties",
      w / scale,
      createMeasure(style),
    );
    const art = paintSign(layout, style, scale);
    const canvas = art.canvas as unknown as MeasuringCanvas;
    expect(canvas.width).toBeLessThanOrEqual(4096);
    expect(canvas.height).toBeLessThanOrEqual(4096);
    expect(art.left).toBeLessThanOrEqual(layout.x - layout.width / 2);
    expect(art.left + art.width).toBeGreaterThanOrEqual(layout.x + layout.width / 2);
    expect(art.top + art.height).toBeGreaterThanOrEqual(layout.top + layout.height);
    const drawn = MeasuringCanvas.calls
      .filter((c) => c.method === "fillText")
      .map((c) => c.args[0]);
    expect(drawn).toEqual(["PLEASE", "STAND BY", "We are experiencing technical difficulties"]);
  });

  it.each(sizes)("paints the %s card and parts at %i x %i within texture limits", (style, w, h) => {
    const card = paintCard(style, w, h) as unknown as MeasuringCanvas;
    // Painted one to one up to 4K, never past the texture limit.
    expect([card.width, card.height]).toEqual([w, h]);
    expect(card.width / card.height).toBeCloseTo(w / h, 2);
    const parts = paintParts(style, (220 * h) / 1080) as unknown as MeasuringCanvas;
    expect(parts.width).toBe(parts.height * PART_CELLS);
    expect(parts.width).toBeLessThanOrEqual(4096);
  });

  it("puts NO SIGNAL on the Digital card only", () => {
    const labels = (style: StandbyStyle) => {
      MeasuringCanvas.reset(0.6);
      paintCard(style, 1920, 1080);
      return MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => c.args[0]);
    };
    expect(labels("digital")).toEqual(["NO SIGNAL"]);
    expect(labels("analogue")).toEqual([]);
    expect(labels("cartoon")).toEqual([]);
  });

  it("paints nothing for an empty sign", () => {
    const layout = layoutSign("", "", 1920, createMeasure("digital"));
    expect(paintSign(layout, "digital", 1).canvas).toBeNull();
  });
});
