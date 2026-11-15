/**
 * The Stonks market, with no GL: a price that only ever goes up, the chart's
 * view of it (panning along and rescaling a log axis so the line climbs
 * forever), the made-up tickers along the bottom, and the arrow's bob.
 *
 * Prices are kept as log10 values in float64, so hours of compounding growth
 * never overflow or lose precision; only the labels turn them back into money.
 *
 * The walk is built so that it never falls over any two points' worth of time:
 * every step is up except for the occasional tiny red one, which is always
 * followed by a big green one, and the down step is smaller than any up step
 * either side of it. The optional dip is the one exception, and it always
 * recovers to a new high.
 */
import {
  autoRange,
  type AutoRangeOptions,
  type AxisRange,
  createAxisRange,
  minTweenSeconds,
  snapAxis,
  stepAxis,
  tweenAxis,
} from "../charts";
import { clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { MAX_SPEED, MIN_SPEED } from "./stonks.meta";

/** Layout is in reference px: the frame is 1080 tall. */
export const REF_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// The price walk

/** Chart points a second at speed 1. */
const POINTS_PER_SECOND = 1;
/** The average climb per point, log10. */
export const DRIFT = 0.006;
/** Chance a step is a tiny red one. */
const RED_CHANCE = 0.08;
/** Step sizes, in multiples of `DRIFT`: a normal up step, a red one, and the green after a red. */
const UP_MIN = 0.5;
const UP_MAX = 1.6;
const RED_MIN = 0.1;
const RED_MAX = 0.25;
const SURGE_MIN = 2.2;
const SURGE_MAX = 3;
/** A dip, step by step in multiples of `DRIFT`: down, hold for a beat, then shoot up past the old high. */
export const DIP_STEPS = [-4, -3, 0.15, -0.1, 0.1, 6, 5] as const;
/** Points between dips: a few minutes at the default speed. */
const DIP_GAP_MIN = 120;
const DIP_GAP_SPAN = 180;
/** Points held: the view's widest span plus room for the pan. */
export const MARKET_CAPACITY = 1024;
/** Points of history before the head when the chart starts. */
const START_POINTS = 8;

export interface Market {
  seed: number;
  /** Each point's price, log10, by index modulo `MARKET_CAPACITY`. */
  values: Float64Array;
  /** Points made: indices `count - MARKET_CAPACITY .. count - 1` are held. */
  count: number;
  /** Where the line's head is, in points; at least two points ahead of it are made. */
  pos: number;
  /** Points a second, easing towards the speed slider. */
  rate: number;
  /** Whether the last step was red, so the next one surges. */
  red: boolean;
  /** The next step of a dip under way, or -1. */
  dipStep: number;
  /** The point the next dip starts at, or -1 when none is planned. */
  nextDip: number;
  /** Dips started so far. */
  dips: number;
}

/** A uniform 0..1 from the seed, a point index and a salt. */
const unit = (seed: number, i: number, salt: number) =>
  hash32(hash32(Math.floor(seed) * 7919 + salt) ^ Math.imul(i + 1, 0x9e3779b1)) / 4294967296;

/** The step from point `i - 1` to point `i` (log10), and the walk's state after it. */
function nextStep(m: Market, crash: boolean): number {
  const i = m.count;
  if (m.dipStep < 0 && crash && m.nextDip >= 0 && i >= m.nextDip) {
    m.dipStep = 0;
    m.nextDip = -1;
    m.dips++;
  }
  if (m.dipStep >= 0) {
    const step = DIP_STEPS[m.dipStep] * DRIFT;
    m.dipStep = m.dipStep + 1 < DIP_STEPS.length ? m.dipStep + 1 : -1;
    m.red = false;
    return step;
  }
  const u = unit(m.seed, i, 1);
  if (m.red) {
    m.red = false;
    return (SURGE_MIN + (SURGE_MAX - SURGE_MIN) * u) * DRIFT;
  }
  if (i > 1 && unit(m.seed, i, 2) < RED_CHANCE) {
    m.red = true;
    return -(RED_MIN + (RED_MAX - RED_MIN) * u) * DRIFT;
  }
  return (UP_MIN + (UP_MAX - UP_MIN) * u) * DRIFT;
}

function makePoint(m: Market, crash: boolean): void {
  const v =
    m.count === 0 ? 1 + unit(m.seed, 0, 3) : pointValue(m, m.count - 1) + nextStep(m, crash);
  m.values[m.count % MARKET_CAPACITY] = v;
  m.count++;
}

/** A market for `seed`, with a few points of history before the head. */
export function createMarket(seed: number): Market {
  const m: Market = {
    seed: Math.floor(seed),
    values: new Float64Array(MARKET_CAPACITY),
    count: 0,
    pos: START_POINTS,
    rate: 0,
    red: false,
    dipStep: -1,
    nextDip: -1,
    dips: 0,
  };
  while (m.count < START_POINTS + 2) {
    makePoint(m, false);
  }
  return m;
}

/** Point `i`'s price (log10), clamped to the points held. */
export function pointValue(m: Market, i: number): number {
  const j = clamp(Math.floor(i), Math.max(0, m.count - MARKET_CAPACITY), m.count - 1);
  return m.values[j % MARKET_CAPACITY];
}

/** The price (log10) at position `pos` along the line, between its points. */
function valueAt(m: Market, pos: number): number {
  const i = Math.floor(pos);
  const a = pointValue(m, i);
  return a + (pointValue(m, i + 1) - a) * (pos - i);
}

/** The price (log10) at the line's head. */
export const headValue = (m: Market): number => valueAt(m, m.pos);

/** Seconds for the climb rate to settle on a new speed. */
const RATE_EASE = 0.6;

/**
 * Advances the market by `dt` seconds at `speed` (clamped to the slider), with
 * the occasional dip when `crash` is on. A dip is planned when crash turns on
 * and dropped if it turns off first; one under way always finishes.
 */
export function stepMarket(m: Market, dt: number, speed: number, crash: boolean): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const target = clamp(Number.isFinite(speed) ? speed : MIN_SPEED, MIN_SPEED, MAX_SPEED);
  const goal = target * POINTS_PER_SECOND;
  m.rate = m.rate <= 0 ? goal : m.rate + (goal - m.rate) * Math.min(1, step / RATE_EASE);
  if (!crash) {
    m.nextDip = -1;
  } else if (m.nextDip < 0 && m.dipStep < 0) {
    m.nextDip = m.count + DIP_GAP_MIN + Math.floor(unit(m.seed, m.dips, 4) * DIP_GAP_SPAN);
  }
  m.pos += step * m.rate;
  const need = Math.floor(m.pos) + 2;
  while (m.count < need) {
    makePoint(m, crash);
  }
}

// ---------------------------------------------------------------------------
// The view

/** Reference px between chart points. */
const POINT_PX = 40;
/** Fewest and most points across the chart. */
const MIN_SPAN = 8;
export const MAX_SPAN = 400;
/** The view pans when the head passes this share of the width, so it ends at `PAN_TO`. */
export const PAN_AT = 0.85;
const PAN_TO = 0.4;
/** The shortest pan, s; longer ones as the codec limits need. */
const PAN_MIN_SECONDS = 5;
/**
 * Pans and rescales run this much longer than the codec limits require, so
 * the two together still stay within them: a pan moves points sideways at most
 * 0.75 of the limit and a rescale up or down at most 0.65 of it, so even when
 * they overlap a point moves under hypot(0.75, 0.65) < 1 of it. The pan gets
 * the larger share, as it must outrun the head on the widest plots.
 */
const PAN_SLACK = 1 / 0.75;
const RESCALE_SLACK = 1 / 0.65;
/** The least share of its speed a pan keeps once it has outrun the head. */
const MIN_OUTRUN = 0.2;
/** Seconds of the fastest climb the log axis keeps room for above the head. */
const LEAD_SECONDS = 3;
/** Points between the time gridlines. */
export const GRID_X_POINTS = 5;

/** How the log axis fits the climbing line: a wide pad, so it rescales only now and then. */
const Y_RANGE: AutoRangeOptions = {
  pad: 0.3,
  edge: 0.1,
  minFill: 0.4,
  minSpan: 30 * DRIFT,
  minSeconds: 1.5,
};

interface ChartView {
  /** The points shown across the plot. */
  x: AxisRange;
  /** The prices shown up the plot, log10. */
  y: AxisRange;
  /** Points across the plot. */
  span: number;
  /** Plot size, reference px. */
  width: number;
  height: number;
}

export const createChartView = (): ChartView => ({
  x: createAxisRange(),
  y: createAxisRange(),
  span: MIN_SPAN,
  width: 1,
  height: 1,
});

/**
 * Fits the view to a `width` x `height` plot (reference px). The first call
 * starts the line at the left edge; later ones keep the left edge where it is,
 * unless that would push the head off the right.
 */
export function layoutView(v: ChartView, m: Market, width: number, height: number): void {
  v.width = Math.max(1, width);
  v.height = Math.max(1, height);
  const span = clamp(Math.round(v.width / POINT_PX), MIN_SPAN, MAX_SPAN);
  if (v.x.ready && span === v.span) {
    return;
  }
  v.span = span;
  let lo = v.x.ready ? v.x.toLo : 0;
  if (m.pos > lo + PAN_AT * span) {
    lo = m.pos - PAN_TO * span;
  }
  snapAxis(v.x, lo, lo + span);
}

/** The lowest and highest price (log10) from point `from` to the head. */
function dataRange(m: Market, from: number, out: { lo: number; hi: number }): void {
  const head = headValue(m);
  let lo = head;
  let hi = head;
  const first = Math.max(0, Math.floor(from), m.count - MARKET_CAPACITY);
  for (let i = first; i <= m.pos; i++) {
    const p = pointValue(m, i);
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  out.lo = lo;
  out.hi = hi;
}

const range = { lo: 0, hi: 0 };

/**
 * Moves the view on by `dt` seconds: once the head passes `PAN_AT` of the
 * width, a slow eased pan brings it back to `PAN_TO` (allowing for the head's
 * own progress meanwhile), and the log axis rescales whenever the line nears
 * its top or the data shrinks well inside it. Every move stays within the codec
 * motion limits. Call `layoutView` first.
 */
export function stepView(v: ChartView, m: Market, dt: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const x = v.x;
  const pointPx = v.width / v.span;
  if (x.t >= 1 && m.pos > x.lo + PAN_AT * v.span) {
    const lag = m.pos - x.lo - PAN_TO * v.span;
    // The pan must also cover the head's progress while it runs: solve
    // T = k (lag + rate T) px for T, where a move of d px needs k d seconds.
    const k = minTweenSeconds(1) * PAN_SLACK;
    const outrun = Math.max(MIN_OUTRUN, 1 - k * m.rate * pointPx);
    const seconds = Math.max(PAN_MIN_SECONDS, (k * lag * pointPx) / outrun);
    const lo = x.lo + lag + m.rate * seconds;
    tweenAxis(x, lo, lo + v.span, seconds);
  }
  stepAxis(x, step);
  dataRange(m, x.lo, range);
  // Room above the head for the next few seconds of the steepest climb.
  const lead = LEAD_SECONDS * m.rate * Math.max(SURGE_MAX, DIP_STEPS[DIP_STEPS.length - 2]) * DRIFT;
  autoRange(v.y, range.lo, range.hi + lead, v.height, 1 / RESCALE_SLACK, Y_RANGE);
  stepAxis(v.y, step);
}

/** Plot x (reference px from its left) of point position `pos`. */
export const viewX = (v: ChartView, pos: number): number => ((pos - v.x.lo) / v.span) * v.width;

/** Plot y (reference px down from its top) of price `value` (log10). */
export const viewY = (v: ChartView, value: number): number =>
  v.height * (1 - (value - v.y.lo) / (v.y.hi - v.y.lo));

/** Price gridlines up the plot, about. */
export const GRID_Y_LINES = 5;

// ---------------------------------------------------------------------------
// Candles

/** A candle's wick above and below its body, log10, from its own hash. */
export function candleWicks(m: Market, i: number, out: { up: number; down: number }): void {
  out.up = (0.1 + 0.4 * unit(m.seed, i, 5)) * DRIFT;
  out.down = (0.1 + 0.3 * unit(m.seed, i, 6)) * DRIFT;
}

// ---------------------------------------------------------------------------
// Labels

const UNITS = ["", "K", "M", "B", "T"] as const;

/**
 * A price given as log10, in a few characters: "420.69" and "12,345.60" up to
 * a million, then "1.23M", "45.6B", "789T", and past that "1.23e18". Works from
 * the log, so no price is ever too big to show.
 */
export function formatPrice(log10: number): string {
  if (!Number.isFinite(log10)) {
    return "-";
  }
  if (log10 < 6) {
    const v = 10 ** log10;
    const s = v.toFixed(v < 1 ? 4 : 2);
    const dot = s.indexOf(".");
    return s.slice(0, dot).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + s.slice(dot);
  }
  if (log10 < 15) {
    let group = Math.floor(log10 / 3);
    let v = 10 ** (log10 - 3 * group);
    if (v >= 999.5) {
      group++;
      v /= 1000;
    }
    if (group < UNITS.length) {
      return v.toFixed(v < 9.995 ? 2 : v < 99.95 ? 1 : 0) + UNITS[group];
    }
  }
  let e = Math.floor(log10);
  let mant = 10 ** (log10 - e);
  if (mant >= 9.995) {
    mant /= 10;
    e++;
  }
  return mant.toFixed(2) + "e" + String(e);
}

/** A rise from log10 `from` to log10 `to` as a percentage: "+12.3%", "+1,250%", "+45.6K%". */
export function formatGain(from: number, to: number): string {
  const pct = (10 ** Math.max(0, to - from) - 1) * 100;
  if (!Number.isFinite(pct)) {
    return "+" + formatPrice(Math.log10(100) + Math.max(0, to - from)) + "%";
  }
  if (pct < 100) {
    return "+" + pct.toFixed(1) + "%";
  }
  if (pct < 1e4) {
    return "+" + String(Math.round(pct)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "%";
  }
  return "+" + formatPrice(Math.log10(pct)) + "%";
}

// ---------------------------------------------------------------------------
// The ticker tape

/**
 * The made-up symbols, all silly words of five letters or more (real listings
 * use four or fewer, so none can read as a real quote).
 */
export const TICKER_WORDS = [
  "STONK",
  "GAINZ",
  "LAMBO",
  "TENDY",
  "MOOON",
  "HODLR",
  "BRRRR",
  "WAGMI",
  "ROKET",
  "BULLZ",
  "DIAMND",
  "LINEUP",
  "NOLOSS",
  "TOMOON",
  "PUMPP",
  "MUCHUP",
  "BIGLY",
  "NUMBR",
] as const;

/** Symbols on the tape. */
export const TICKER_ITEMS = 8;
/** Scroll speed, reference px a second: large text, slowly. */
export const TICKER_SPEED = 36;
/** Seconds between an item's price ticks: this plus up to `TICK_SPAN`. */
const TICK_MIN = 2.5;
const TICK_SPAN = 4.5;
/** Each tick's rise, log10: about 0.1% to 1%. */
const TICK_RISE_MIN = 0.0004;
const TICK_RISE_SPAN = 0.0036;
/** Seconds a changed price's tint takes to fade. */
const TINT_SECONDS = 1.2;

export interface TickerItem {
  symbol: string;
  /** The price now, and where it opened, log10. */
  price: number;
  open: number;
  /** Ticks so far. */
  ticks: number;
  /** Seconds to the next tick. */
  next: number;
  /** The change tint, 1 just after a tick, fading to 0. */
  tint: number;
  /** Set when the price changes; the renderer clears it once it has repainted. */
  changed: boolean;
}

interface Ticker {
  seed: number;
  items: TickerItem[];
  /** How far the tape has scrolled, reference px (unwrapped). */
  scroll: number;
}

/** A tape of `TICKER_ITEMS` distinct symbols for `seed`, each opening at its own price. */
export function createTicker(seed: number): Ticker {
  const s = Math.floor(seed);
  const words: string[] = [...TICKER_WORDS];
  const rng = createRng(s * 31 + 17);
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const w = words[i];
    words[i] = words[j];
    words[j] = w;
  }
  const items: TickerItem[] = [];
  for (let i = 0; i < TICKER_ITEMS; i++) {
    const open = 1 + 2 * unit(s, i, 7);
    items.push({
      symbol: words[i],
      price: open,
      open,
      ticks: 0,
      next: TICK_MIN + TICK_SPAN * unit(s, i, 8),
      tint: 0,
      changed: true,
    });
  }
  return { seed: s, items, scroll: 0 };
}

/** Scrolls the tape on by `dt` seconds and ticks each price up when its time comes. */
export function stepTicker(t: Ticker, dt: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  t.scroll += step * TICKER_SPEED;
  for (let i = 0; i < t.items.length; i++) {
    const it = t.items[i];
    it.tint = Math.max(0, it.tint - step / TINT_SECONDS);
    it.next -= step;
    // After a long pause, only the last tick tints; the price catches up in one go.
    while (it.next <= 0) {
      const salt = it.ticks * TICKER_ITEMS + i;
      it.price += TICK_RISE_MIN + TICK_RISE_SPAN * unit(t.seed, salt, 9);
      it.ticks++;
      it.next += TICK_MIN + TICK_SPAN * unit(t.seed, salt, 10);
      it.tint = 1;
      it.changed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// The arrow

/** Seconds between the arrow's bobs, and how far it rises, reference px. */
export const BOB_PERIOD = 4;
export const BOB_HEIGHT = 8;
/** Shares of the period: a quick rise, then a slower settle. */
const BOB_RISE = 0.12;
const BOB_SETTLE = 0.5;

/** How far up the arrow is at `t` seconds, 0..1 of `BOB_HEIGHT`. */
export function arrowBob(t: number): number {
  const p = (((t / BOB_PERIOD) % 1) + 1) % 1;
  return p < BOB_RISE ? smoothstep(0, BOB_RISE, p) : 1 - smoothstep(BOB_RISE, BOB_SETTLE, p);
}
