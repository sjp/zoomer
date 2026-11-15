import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { createMeasure, logLineHeight, paintLog, paintScreen } from "./bluescreen-art";
import { layoutClassic, layoutKernel, layoutModern } from "./bluescreen-layout";
import { bluescreenMeta } from "./bluescreen.meta";

beforeEach(() => {
  MeasuringCanvas.reset(0.55);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const MESSAGE = bluescreenMeta.params.text.default;
const CODE = bluescreenMeta.params.code.default;

describe("blue screen art", () => {
  it("measures text in ems", () => {
    expect(createMeasure()("abcd", "sans")).toBeCloseTo(2.2);
  });

  it("paints Modern's face, message and stop code at device size", () => {
    const layout = layoutModern(MESSAGE, CODE, 1920, createMeasure());
    const canvas = paintScreen(layout, "blue", 1, 3840, 2160, 2) as unknown as MeasuringCanvas;
    expect([canvas.width, canvas.height]).toEqual([3840, 2160]);
    const texts = MeasuringCanvas.calls.filter((c) => c.method === "fillText");
    expect(texts.map((c) => c.args[0])).toContain(":(");
    expect(texts.some((c) => String(c.args[0]).includes(CODE))).toBe(true);
  });

  it("paints Classic in the dot font, with no system text", () => {
    const layout = layoutClassic(MESSAGE, CODE, 1920);
    paintScreen(layout, "blue", 1, 1920, 1080, 1);
    const methods = new Set(MeasuringCanvas.calls.map((c) => c.method));
    expect(methods.has("fillText")).toBe(false);
    // Whole-pixel dots at 1080p.
    const rects = MeasuringCanvas.calls.filter((c) => c.method === "fillRect").slice(2);
    expect(rects.length).toBeGreaterThan(500);
    for (const r of rects) {
      expect((r.args as number[]).every((n) => Number.isInteger(n))).toBe(true);
    }
  });

  it("paints the kernel log one line under another", () => {
    const layout = layoutKernel(CODE, 1920, createMeasure());
    const canvas = paintLog(layout, ["a", "b", "c"], 1) as unknown as MeasuringCanvas;
    const lh = logLineHeight(layout, 1);
    expect(canvas.height).toBe(3 * lh);
    const ys = MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => c.args[2]);
    expect(ys).toEqual([0, lh, 2 * lh]);
  });

  it.each([1, 1.25, 1.5, 2])("steps the kernel log in whole device px at scale %d", (scale) => {
    const layout = layoutKernel(CODE, 1920, createMeasure());
    const lh = logLineHeight(layout, scale);
    expect(Number.isInteger(lh)).toBe(true);
    expect(Math.abs(lh - layout.lineHeight * scale)).toBeLessThanOrEqual(0.5);
  });
});
