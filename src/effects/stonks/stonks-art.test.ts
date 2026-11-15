import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { TEXT_ROLES } from "../text-layer";
import {
  createMeasure,
  drawTickerItem,
  paintArrow,
  paintCaption,
  TICKER_INDENT_EM,
  tickerSlotWidth,
} from "./stonks-art";
import { createTicker } from "./stonks-sim";

beforeEach(() => {
  MeasuringCanvas.reset(0.5);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Ctx = OffscreenCanvasRenderingContext2D;

const fontPx = (font: string) => Number(/([\d.]+)px/.exec(font)?.[1]);

describe("caption", () => {
  it("keeps its size when it fits, and shrinks to fit when it doesn't", () => {
    const measure = createMeasure();
    MeasuringCanvas.reset(0.5);
    paintCaption("STONKS", "terminal", 150, 1000, measure);
    const big = MeasuringCanvas.calls.find((c) => c.method === "fillText");
    expect(fontPx(big?.font ?? "")).toBe(150);
    MeasuringCanvas.reset(0.5);
    paintCaption("STONKS", "terminal", 150, 225, measure);
    const small = MeasuringCanvas.calls.find((c) => c.method === "fillText");
    expect(fontPx(small?.font ?? "")).toBe(75);
  });

  it("is plain white on the terminal and outlined WordArt on the slide", () => {
    const measure = createMeasure();
    MeasuringCanvas.reset(0.5);
    paintCaption("STONKS", "terminal", 100, 1000, measure);
    expect(MeasuringCanvas.calls.some((c) => c.method === "strokeText")).toBe(false);
    MeasuringCanvas.reset(0.5);
    paintCaption("STONKS", "clipart", 100, 1000, measure);
    const methods = MeasuringCanvas.calls.map((c) => c.method);
    expect(methods).toContain("strokeText");
    expect(methods).toContain("setTransform");
  });

  it("leaves room for the text in its canvas", () => {
    const canvas = paintCaption(
      "STONKS",
      "clipart",
      100,
      1000,
      createMeasure(),
    ) as unknown as MeasuringCanvas;
    expect(canvas.width).toBeGreaterThan(6 * 50);
    expect(canvas.height).toBeGreaterThan(100);
  });
});

describe("arrow", () => {
  it.each(["terminal", "clipart"] as const)("paints a square %s arrow", (style) => {
    const canvas = paintArrow(style, 200.4) as unknown as MeasuringCanvas;
    expect([canvas.width, canvas.height]).toEqual([200, 200]);
    expect(MeasuringCanvas.calls.some((c) => c.method === "fill")).toBe(true);
  });
});

describe("ticker items", () => {
  it("draws the symbol in the primary role and the rising figures in the up role", () => {
    const item = createTicker(1).items[0];
    const ctx = new MeasuringCanvas(800, 40).getContext() as unknown as Ctx;
    MeasuringCanvas.reset(0.5);
    drawTickerItem(ctx, item, 10, 20, 30);
    const texts = MeasuringCanvas.calls.filter((c) => c.method === "fillText");
    expect(texts.map((c) => c.fillStyle)).toEqual([TEXT_ROLES.primary, TEXT_ROLES.up]);
    expect(texts[0].args[0]).toBe(item.symbol);
    expect(String(texts[1].args[0])).toMatch(/^▲ [\d,.]+ \+[\d.]+%$/);
  });

  it("reserves a slot wide enough for any price, so a tick never moves the tape", () => {
    const measure = createMeasure();
    const px = 30;
    const slot = tickerSlotWidth(px, measure);
    const indent = TICKER_INDENT_EM * px;
    const item = createTicker(2).items[0];
    // Up to a five-digit exponent on both price and gain (over a year of uptime).
    for (const log of [0, 2.5, 5.99, 9, 30, 400, 99_999]) {
      item.price = log;
      item.open = 0;
      const ctx = new MeasuringCanvas(1, 1).getContext() as unknown as Ctx;
      MeasuringCanvas.reset(0.5);
      drawTickerItem(ctx, item, indent, 0, px);
      const texts = MeasuringCanvas.calls.filter((c) => c.method === "fillText");
      const end = Number(texts[1].args[1]) + Array.from(String(texts[1].args[0])).length * px * 0.5;
      // The item plus its trailing half gap stays inside the slot.
      expect(end + indent).toBeLessThanOrEqual(slot);
    }
  });
});
