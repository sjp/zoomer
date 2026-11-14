import { describe, expect, it } from "vitest";
import { niceStep } from "../charts";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ } from "../motion-limits";
import { DENIED_TICKERS } from "../trading/trading-names";
import {
  arrowBob,
  BOB_HEIGHT,
  BOB_PERIOD,
  createChartView,
  createMarket,
  createTicker,
  DIP_STEPS,
  DRIFT,
  formatGain,
  formatPrice,
  GRID_X_POINTS,
  GRID_Y_LINES,
  headValue,
  layoutView,
  type Market,
  PAN_AT,
  pointValue,
  stepMarket,
  stepTicker,
  stepView,
  TICKER_ITEMS,
  TICKER_SPEED,
  TICKER_WORDS,
  viewX,
  viewY,
} from "./stonks-sim";
import { MAX_SPEED, MIN_SPEED } from "./stonks.meta";

const DT = 1 / 30;
const SEEDS = [0, 1, 2, 3, 7, 42, 99, 123, 500, 999];

/** Plot sizes (reference px) for frames from portrait to ultrawide, and a thin strip. */
const PLOTS = [
  ["16:9", 1650, 836],
  ["21:9", 2370, 836],
  ["4:3", 1280, 836],
  ["9:16", 350, 836],
  ["strip", 34000, 836],
] as const;

/** Every point made over `seconds`, in order, alongside the head value each frame. */
function run(
  seed: number,
  seconds: number,
  speed: number,
  crash: boolean,
): { points: number[]; heads: number[]; market: Market } {
  const m = createMarket(seed);
  const points: number[] = [];
  for (let i = 0; i < m.count; i++) {
    points.push(pointValue(m, i));
  }
  const heads: number[] = [headValue(m)];
  const frames = Math.round(seconds / DT);
  for (let f = 0; f < frames; f++) {
    stepMarket(m, DT, speed, crash);
    while (points.length < m.count) {
      points.push(pointValue(m, points.length));
    }
    heads.push(headValue(m));
  }
  return { points, heads, market: m };
}

describe("price walk", () => {
  it.each(SEEDS.flatMap((s) => [MIN_SPEED, MAX_SPEED].map((v) => [s, v] as const)))(
    "never ends a 10 s window lower than it started without crash (seed %d, speed %d)",
    (seed, speed) => {
      const { heads } = run(seed, 600, speed, false);
      const window = Math.round(10 / DT);
      for (let j = 0; j + window < heads.length; j++) {
        expect(heads[j + window]).toBeGreaterThanOrEqual(heads[j] - 1e-12);
      }
    },
  );

  it.each(SEEDS)(
    "has the occasional tiny red step, always followed by a big green one (seed %d)",
    (seed) => {
      const { points } = run(seed, 600, MAX_SPEED, false);
      let reds = 0;
      let deepest = 0;
      let weakestSurge = Infinity;
      for (let i = 1; i + 1 < points.length; i++) {
        const step = points[i] - points[i - 1];
        if (step < 0) {
          reds++;
          deepest = Math.max(deepest, -step);
          weakestSurge = Math.min(weakestSurge, points[i + 1] - points[i]);
        }
      }
      expect(reds).toBeGreaterThan(0);
      expect(deepest).toBeLessThanOrEqual(0.25 * DRIFT + 1e-12);
      expect(weakestSurge).toBeGreaterThanOrEqual(2 * DRIFT);
    },
  );

  it.each(SEEDS)("recovers from every dip to a new high with crash on (seed %d)", (seed) => {
    const { points, market } = run(seed, 1800, MAX_SPEED, true);
    expect(market.dips).toBeGreaterThan(2);
    let checked = 0;
    for (let i = 1; i + DIP_STEPS.length < points.length; i++) {
      if (Math.abs(points[i] - points[i - 1] - DIP_STEPS[0] * DRIFT) > 1e-9) {
        continue;
      }
      const before = Math.max(...points.slice(0, i));
      const after = points[i + DIP_STEPS.length - 1];
      expect(Math.min(...points.slice(i, i + DIP_STEPS.length - 1))).toBeLessThan(before);
      expect(after).toBeGreaterThan(before);
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });

  it("plans no dip while crash is off, and drops a planned one when it turns off", () => {
    const m = createMarket(5);
    stepMarket(m, DT, 1, true);
    expect(m.nextDip).toBeGreaterThan(0);
    stepMarket(m, DT, 1, false);
    expect(m.nextDip).toBe(-1);
    for (let f = 0; f < 3000; f++) {
      stepMarket(m, 0.5, MAX_SPEED, false);
    }
    expect(m.dips).toBe(0);
  });

  it("is the same for the same seed and differs between seeds", () => {
    expect(run(4, 60, 1, true).points).toEqual(run(4, 60, 1, true).points);
    expect(run(4, 60, 1, true).points).not.toEqual(run(5, 60, 1, true).points);
  });

  it("clamps the speed to the slider and eases between speeds", () => {
    const m = createMarket(1);
    stepMarket(m, DT, 99, false);
    expect(m.rate).toBeCloseTo(MAX_SPEED, 9);
    stepMarket(m, DT, MIN_SPEED, false);
    expect(m.rate).toBeLessThan(MAX_SPEED);
    expect(m.rate).toBeGreaterThan(MIN_SPEED);
  });
});

/** Steps market and view together, calling `check` after every frame. */
function drive(
  seed: number,
  plotW: number,
  plotH: number,
  seconds: number,
  dt: number,
  check: (m: Market, v: ReturnType<typeof createChartView>) => void,
): void {
  const m = createMarket(seed);
  const v = createChartView();
  layoutView(v, m, plotW, plotH);
  const frames = Math.round(seconds / dt);
  for (let f = 0; f < frames; f++) {
    stepMarket(m, dt, MAX_SPEED, true);
    stepView(v, m, dt);
    check(m, v);
  }
}

describe("chart view", () => {
  it.each(PLOTS)("keeps the line inside the plot (%s)", (_, w, h) => {
    // The least room left on each side of the plot, px (negative when outside).
    let headRoom = Infinity;
    let pointRoom = Infinity;
    drive(3, w, h, 600, DT, (m, v) => {
      const hx = viewX(v, m.pos);
      const hy = viewY(v, headValue(m));
      headRoom = Math.min(headRoom, hx, w - hx, hy, h - hy);
      // Every point the view is heading for (it may still be panning away from older ones).
      for (let i = Math.ceil(v.x.toLo); i < m.pos; i++) {
        const y = viewY(v, pointValue(m, i));
        pointRoom = Math.min(pointRoom, y, h - y);
      }
    });
    expect(headRoom).toBeGreaterThanOrEqual(0);
    expect(pointRoom).toBeGreaterThanOrEqual(-1);
  });

  it.each(PLOTS)("stays inside and precise over hours (%s)", (_, w, h) => {
    let last: Market | null = null;
    let room = Infinity;
    drive(11, w, h, 6 * 3600, 0.5, (m, v) => {
      const hx = viewX(v, m.pos);
      const hy = viewY(v, headValue(m));
      room = Math.min(room, hx, w - hx, hy + 1, h + 1 - hy);
      last = m;
    });
    expect(room).toBeGreaterThanOrEqual(0);
    const m = last as unknown as Market;
    // Hours in, a single step still resolves to its exact size.
    const i = m.count - 3;
    const step = pointValue(m, i) - pointValue(m, i - 1);
    expect(Math.abs(step)).toBeGreaterThan(0.05 * DRIFT);
    expect(formatPrice(headValue(m))).toMatch(/^\d+\.\d\de\d+$/);
  });

  it.each(PLOTS)(
    "pans and rescales within the codec motion limits at top speed (%s)",
    (_, w, h) => {
      let px = Number.NaN;
      let py = Number.NaN;
      let lo = Number.NaN;
      let ylo = Number.NaN;
      let yhi = Number.NaN;
      const worst = { head: 0, pan: 0, panHz: 0, rescale: 0, rescaleHz: 0 };
      drive(8, w, h, 900, DT, (m, v) => {
        const hx = viewX(v, m.pos);
        const hy = viewY(v, headValue(m));
        if (Number.isFinite(px)) {
          worst.head = Math.max(worst.head, Math.hypot(hx - px, hy - py));
          // A fixed point on the chart (and so the time gridlines) moves with the pan.
          const pan = Math.abs(((v.x.lo - lo) / v.span) * w);
          worst.pan = Math.max(worst.pan, pan);
          worst.panHz = Math.max(worst.panHz, pan / DT / ((GRID_X_POINTS * w) / v.span));
          // The price gridlines move with the rescale: check both ends of the old range.
          const span = v.y.hi - v.y.lo;
          const shift = Math.max(Math.abs(viewY(v, ylo) - h), Math.abs(viewY(v, yhi)));
          worst.rescale = Math.max(worst.rescale, shift);
          const gridYPx = (niceStep(span, GRID_Y_LINES) / span) * h;
          worst.rescaleHz = Math.max(worst.rescaleHz, shift / DT / gridYPx);
        }
        px = hx;
        py = hy;
        lo = v.x.lo;
        ylo = v.y.lo;
        yhi = v.y.hi;
      });
      expect(worst.head).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      expect(worst.pan).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      expect(worst.panHz).toBeLessThanOrEqual(MAX_PATTERN_HZ);
      expect(worst.rescale).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      expect(worst.rescaleHz).toBeLessThanOrEqual(MAX_PATTERN_HZ);
      // Both happen in the run.
      expect(worst.pan).toBeGreaterThan(0);
      expect(worst.rescale).toBeGreaterThan(0);
    },
  );

  it("pans once the head passes the pan point, and starts the line at the left edge", () => {
    const m = createMarket(1);
    const v = createChartView();
    layoutView(v, m, 1600, 800);
    expect(v.x.lo).toBe(0);
    let panned = false;
    for (let f = 0; f < 3000 && !panned; f++) {
      stepMarket(m, DT, 1, false);
      stepView(v, m, DT);
      panned = v.x.t < 1;
    }
    expect(panned).toBe(true);
    expect(m.pos).toBeGreaterThan(PAN_AT * v.span);
  });
});

describe("labels", () => {
  it.each([
    [Math.log10(420.69), "420.69"],
    [Math.log10(12345.6), "12,345.60"],
    [Math.log10(1.234e6), "1.23M"],
    [Math.log10(45.6e9), "45.6B"],
    [Math.log10(789e12), "789T"],
    [Math.log10(9.999e6), "10.0M"],
    [18.09, "1.23e18"],
    [5000, "1.00e5000"],
  ])("formats price 10^%d as %s", (log, text) => {
    expect(formatPrice(log)).toBe(text);
  });

  it("formats gains, however large", () => {
    expect(formatGain(2, 2 + Math.log10(1.123))).toBe("+12.3%");
    expect(formatGain(2, 2 + Math.log10(13.5))).toBe("+1,250%");
    expect(formatGain(1, 1000)).toMatch(/^\+[\d.]+e\d+%$/);
    expect(formatGain(3, 2)).toBe("+0.0%");
  });
});

/** Real tickers a silly word could collide with, beyond the trading dashboard's list. */
const MORE_REAL_TICKERS = ["MEME", "YOLO", "HODL", "MOON", "BULL", "GAIN", "PUMP", "UP", "WOW"];

describe("ticker tape", () => {
  it("uses only silly words, none a real ticker", () => {
    for (const word of TICKER_WORDS) {
      expect(word).toMatch(/^[A-Z]{5,6}$/);
      expect(DENIED_TICKERS.has(word)).toBe(false);
      expect(MORE_REAL_TICKERS).not.toContain(word);
    }
    expect(new Set(TICKER_WORDS).size).toBe(TICKER_WORDS.length);
  });

  it.each(SEEDS)("shows distinct symbols for seed %d", (seed) => {
    const t = createTicker(seed);
    expect(t.items).toHaveLength(TICKER_ITEMS);
    expect(new Set(t.items.map((i) => i.symbol)).size).toBe(TICKER_ITEMS);
  });

  it("only ticks prices up, tinting each change", () => {
    const t = createTicker(3);
    const start = t.items.map((i) => i.price);
    for (const item of t.items) {
      item.changed = false;
    }
    let tinted = 0;
    let falls = 0;
    let untinted = 0;
    for (let f = 0; f < 300; f++) {
      const before = t.items.map((i) => i.price);
      stepTicker(t, DT);
      for (let k = 0; k < t.items.length; k++) {
        const item = t.items[k];
        falls += item.price < before[k] ? 1 : 0;
        if (item.price > before[k]) {
          tinted++;
          untinted += item.tint === 1 && item.changed ? 0 : 1;
        }
      }
    }
    expect(falls).toBe(0);
    expect(untinted).toBe(0);
    expect(tinted).toBeGreaterThan(TICKER_ITEMS);
    expect(t.items.every((item, k) => item.price > start[k])).toBe(true);
  });

  it("scrolls slowly enough for the codec", () => {
    expect(TICKER_SPEED * DT).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });
});

describe("arrow bob", () => {
  it("rises and settles once a period, slowly", () => {
    expect(arrowBob(0)).toBe(0);
    expect(arrowBob(BOB_PERIOD * 0.12)).toBeCloseTo(1, 9);
    expect(arrowBob(BOB_PERIOD * 0.75)).toBe(0);
    let peak = 0;
    for (let t = 0; t < BOB_PERIOD; t += DT) {
      peak = Math.max(peak, Math.abs(arrowBob(t + DT) - arrowBob(t)) * BOB_HEIGHT);
    }
    expect(peak).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });
});
