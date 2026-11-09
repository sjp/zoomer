import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { drawTicker, MAX_TICKER_TEXELS } from "./newsdesk-graphics";
import { DESIGN_ASPECT, graphicsLayout, TICKER_ROW } from "./newsdesk-sim";

describe("drawTicker", () => {
  const g = graphicsLayout(DESIGN_ASPECT);

  beforeEach(() => {
    MeasuringCanvas.reset(0.5);
    vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The text lines the strip draws: their x and y. */
  const fills = () =>
    MeasuringCanvas.calls
      .filter((c) => c.method === "fillText")
      .map((c) => [c.args[1], c.args[2]] as [number, number]);

  it("draws nothing for no stories", () => {
    expect(drawTicker("   ", g, 1080)).toBeNull();
  });

  it("fits a short strip on one row exactly one period wide", () => {
    const strip = drawTicker("Markets steady", g, 1080);
    expect(strip).not.toBeNull();
    if (!strip) {
      return;
    }
    expect(strip.rowH).toBe(Math.round(g.tickerH * 1080));
    expect(strip.period).toBeLessThan(TICKER_ROW);
    // The shader wraps the scroll by the period and reads row `i / TICKER_ROW`.
    expect(strip.width).toBe(strip.period);
    expect(strip.height).toBe(strip.rowH);
    expect(strip.canvas.width).toBe(strip.width);
    expect(strip.canvas.height).toBe(strip.height);
    expect(fills()).toHaveLength(1);
    expect(Math.abs(fills()[0][0])).toBe(0);
  });

  it("matches its period to the measured text plus the join back to the start", () => {
    const text = "Rain later";
    const strip = drawTicker(text, g, 1080);
    const call = MeasuringCanvas.calls.findLast((c) => c.method === "fillText");
    const size = Number(/([\d.]+)px/.exec(call?.font ?? "")?.[1]);
    const drawn = String(call?.args[0]);
    expect(drawn.startsWith(text)).toBe(true);
    expect(strip?.period).toBe(Math.ceil(Array.from(drawn).length * 0.5 * size));
  });

  it("wraps a long strip onto rows of TICKER_ROW texels, each row drawn shifted", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Story number ${String(i)} today`).join(
      "   ",
    );
    const strip = drawTicker(text, g, 1080);
    expect(strip).not.toBeNull();
    if (!strip) {
      return;
    }
    const rows = Math.ceil(strip.period / TICKER_ROW);
    expect(rows).toBeGreaterThan(1);
    expect(strip.width).toBe(TICKER_ROW);
    expect(strip.height).toBe(rows * strip.rowH);
    expect(strip.height).toBeLessThanOrEqual(MAX_TICKER_TEXELS);
    const xs = fills().map(([x]) => x);
    expect(xs).toEqual(Array.from({ length: rows }, (_, r) => -r * TICKER_ROW));
    // Each row's baseline sits the same way within its row.
    const ys = fills().map(([, y]) => y);
    for (let r = 1; r < rows; r++) {
      expect(ys[r] - ys[r - 1]).toBeCloseTo(strip.rowH, 9);
    }
  });

  it("shrinks the text rather than stack rows past the texture limit", () => {
    const text = Array.from({ length: 400 }, (_, i) => `A long running story ${String(i)}`).join(
      "   ",
    );
    for (const frameH of [1080, 2160, 4320]) {
      MeasuringCanvas.reset(0.5);
      const strip = drawTicker(text, g, frameH);
      expect(strip).not.toBeNull();
      if (!strip) {
        continue;
      }
      const rows = Math.ceil(strip.period / TICKER_ROW);
      expect(strip.width).toBe(Math.min(strip.period, TICKER_ROW));
      expect(rows * strip.rowH).toBeLessThanOrEqual(MAX_TICKER_TEXELS);
      expect(strip.height).toBe(rows * strip.rowH);
      // Shrunk: smaller than the size a short line gets at this height.
      const call = MeasuringCanvas.calls.findLast((c) => c.method === "fillText");
      const size = Number(/([\d.]+)px/.exec(call?.font ?? "")?.[1]);
      expect(size).toBeLessThan((0.38 * strip.rowH) / 0.72);
    }
  });
});
