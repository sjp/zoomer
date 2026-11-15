import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { tweenPeakPxPerFrame } from "../charts";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { TEXT_ROLES } from "../text-layer";
import { CANDLE_SPACING, SLIDE_SECONDS, STEP_SECONDS, trading } from "./trading";
import { createFocusLayout, focusLayout } from "./trading-layout";

describe("trading motion", () => {
  it("steps the chart one candle within the codec motion limits", () => {
    expect(tweenPeakPxPerFrame(CANDLE_SPACING, STEP_SECONDS)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
  });

  it.each([
    [1920, 1080],
    [1440, 1080],
    [2560, 1080],
  ])("slides a new trade row in within the codec motion limits at %d x %d", (w, h) => {
    const layout = createFocusLayout();
    focusLayout(w, h, h / 1080, layout);
    const rowRef = layout.tradeRow / (h / 1080);
    expect(rowRef).toBeGreaterThan(10);
    expect(tweenPeakPxPerFrame(rowRef, SLIDE_SECONDS)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
  });
});

const DEFAULTS = {
  layout: "focus",
  count: 8,
  mood: "sideways",
  volatility: 1,
  pace: 1,
  chart: "candles",
  colors: "green-up",
  theme: "terminal",
  rotate: "2",
  dim: 0.25,
  seed: 1,
};

describe("trading renderer", () => {
  beforeEach(() => {
    MeasuringCanvas.reset(0.5);
    vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Runs the effect at 1920 x 1080 and 30 fps for each `[seconds, params]` in
   * turn. Returns the number of canvas calls recorded before each step.
   */
  const run = (...steps: [number, Partial<typeof DEFAULTS>][]) => {
    const fake = createFakeGl();
    const effect = trading.create(fake.gl);
    effect.resize({ width: 1920, height: 1080, scale: 1 });
    const marks: number[] = [];
    for (const [seconds, params] of steps) {
      marks.push(MeasuringCanvas.calls.length);
      for (let i = 0; i < seconds * 30; i++) {
        effect.frame(1 / 30, { ...DEFAULTS, ...params });
      }
    }
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
    return marks;
  };

  it("keeps the Grid layout's tiles when the hidden focus stock rotates", () => {
    run([130, { layout: "grid" }]);
    // Grid alone has one text canvas, cleared whole only for its first paint.
    expect(MeasuringCanvas.made).toHaveLength(1);
    const { width, height } = MeasuringCanvas.made[0];
    const whole = MeasuringCanvas.calls.filter(
      (c) =>
        c.method === "clearRect" &&
        c.args[0] === 0 &&
        c.args[1] === 0 &&
        c.args[2] === width &&
        c.args[3] === height,
    );
    expect(whole).toHaveLength(1);
  });

  it("fits the price axis to the market again on coming back from the Grid layout", () => {
    const market = { mood: "bull", volatility: 2, pace: 0.5, rotate: "off" };
    const marks = run([5, market], [180, { ...market, layout: "grid" }], [2, market]);
    const calls = MeasuringCanvas.calls.slice(marks[2]);
    // The first price tag painted after the return, and the axis labels painted with it.
    const tag = calls.findIndex(
      (c) => c.method === "fillText" && c.fillStyle === TEXT_ROLES.inverse,
    );
    expect(tag).toBeGreaterThan(0);
    const price = Number(calls[tag].args[0]);
    const labels: number[] = [];
    for (let i = tag - 1; i >= 0; i--) {
      const c = calls[i];
      if (
        c.method !== "fillText" ||
        c.fillStyle !== TEXT_ROLES.muted ||
        c.font !== calls[tag].font
      ) {
        break;
      }
      labels.push(Number(c.args[0]));
    }
    expect(labels.length).toBeGreaterThan(1);
    expect(Math.min(...labels)).toBeLessThan(price);
    expect(Math.max(...labels)).toBeGreaterThan(price);
  });
});
