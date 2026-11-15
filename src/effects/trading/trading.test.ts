import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { tweenPeakPxPerFrame } from "../charts";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { TEXT_ROLES } from "../text-layer";
import { CANDLE_SPACING, SLIDE_SECONDS, STEP_SECONDS, TILE_CANDLES, trading } from "./trading";
import { createFocusLayout, focusLayout, gridTiles, PAD } from "./trading-layout";
import { HISTORY, MAX_STOCKS } from "./trading-sim";
import { MAX_COUNT, MIN_COUNT } from "./trading.meta";

describe("trading motion", () => {
  const ASPECTS = [
    [1920, 1080],
    [1440, 1080],
    [2560, 1080],
    [1080, 1080],
    [1080, 1920],
  ];

  it.each(ASPECTS)(
    "steps the main chart one candle within the codec motion limits at %d x %d",
    (w, h) => {
      const s = h / 1080;
      const layout = createFocusLayout();
      focusLayout(w, h, s, layout);
      // The effect's candle spacing: at least CANDLE_SPACING, wider to fill a wide plot.
      const spacingRef = Math.max(CANDLE_SPACING, layout.plot.w / s / (HISTORY - 4));
      expect(tweenPeakPxPerFrame(spacingRef, STEP_SECONDS)).toBeLessThanOrEqual(
        MAX_FEATURE_PX_PER_FRAME,
      );
    },
  );

  it.each(ASPECTS)(
    "steps every grid tile's chart one candle within the codec motion limits at %d x %d",
    (w, h) => {
      const s = h / 1080;
      const tiles = new Float64Array(4 * MAX_STOCKS);
      for (let count = MIN_COUNT; count <= MAX_COUNT; count++) {
        gridTiles(count, w, h, s, tiles);
        for (let i = 0; i < count; i++) {
          const spacingRef = (tiles[4 * i + 2] - 2 * PAD * s) / TILE_CANDLES / s;
          expect(tweenPeakPxPerFrame(spacingRef, STEP_SECONDS)).toBeLessThanOrEqual(
            MAX_FEATURE_PX_PER_FRAME,
          );
        }
      }
    },
  );

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

  it("repaints only the live watchlist rows whose text changed", () => {
    run([30, { count: 4, rotate: "off" }]);
    const rows = MeasuringCanvas.calls.filter(
      (c) => c.method === "fillText" && c.font.startsWith("600 15px"),
    );
    // The four live rows' tickers, never the hidden rows', at most once a tick (30) plus the first paint.
    expect(new Set(rows.map((c) => c.args[0])).size).toBe(4);
    expect(rows.length).toBeLessThanOrEqual(4 * 31);
  });

  it("paints watchlist rows and tiles as a higher count fades them in", () => {
    // One tick every 5 s, so nothing between ticks repaints the rows already shown.
    const slow = { pace: 5, rotate: "off" };
    const marks = run(
      [6, { ...slow, count: 4 }],
      [2, { ...slow, count: 6 }],
      [1.5, { ...slow, count: 6, layout: "grid" }],
    );
    const texts = (from: number, to: number | undefined, font: string) =>
      MeasuringCanvas.calls
        .slice(from, to)
        .filter((c) => c.method === "fillText" && c.font.startsWith(font))
        .map((c) => c.args[0]);
    // The two rows faded in, at once, between ticks.
    expect(texts(marks[1], marks[2], "600 15px")).toHaveLength(2);
    // The Grid layout's first paint: every live tile (and the Focus header as it fades out).
    expect(new Set(texts(marks[2], undefined, "700 22px")).size).toBe(6);
  });
});
