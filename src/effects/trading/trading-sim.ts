/**
 * The Trading Dashboard's simulated market: nine made-up stocks and four indices
 * that move together through a shared market factor, each a mean-reverting
 * random walk in log price around a slowly drifting fair value, so nothing runs
 * to zero or off to infinity however long it runs. Now and then one stock makes
 * a larger move that unfolds over several ticks.
 *
 * The market steps one tick at a time (one price update per stock; the effect
 * ticks every `pace` seconds) from a single seeded random stream, so it is
 * deterministic per seed and the same however the ticks are batched. Candles
 * cover `CANDLE_TICKS` ticks. The order book is derived from the price and a
 * smooth per-level noise rather than kept as state, and trades print at its
 * best bid or ask.
 *
 * All nine stocks always step, whatever the number shown, so changing the count
 * never changes the market. Allocates nothing per tick.
 */
import { clamp } from "../math";
import { createRng, hash32 } from "../noise";
import { type Company, generateCompanies, INDEX_NAMES } from "./trading-names";

/** Stocks simulated (the most the effect shows). */
export const MAX_STOCKS = 9;
/** Ticks per candle. */
export const CANDLE_TICKS = 5;
/** Candles kept per stock, including the one forming. */
export const HISTORY = 192;
/** Trades kept per stock, newest last. */
export const TRADE_ROWS = 16;
/** Price levels each side of the order book. */
export const BOOK_LEVELS = 8;
export const INDEX_COUNT = INDEX_NAMES.length;

/** The market's mood: the drift of fair value and how noisy prices are. */
export type Mood = "bull" | "bear" | "sideways" | "choppy";

/** Fair value relaxes back over this many ticks (half an hour at one a second). */
const FAIR_TICKS = 1800;
/** Where a lasting bull or bear market levels off, as a multiple of the start. */
const TREND_LEVEL = 2;
/** Per-tick noise of the fair value, the market factor, and each stock's own walk. */
const SIGMA_FAIR = 0.0003;
const SIGMA_MARKET = 0.0012;
const SIGMA_STOCK = 0.0015;
/** Ticks for the market to revert to fair value, and for a stock's own offset to. */
const MARKET_TICKS = 120;
const STOCK_TICKS = 300;
/** Each stock's slowly wandering fair offset: reversion ticks and noise. */
const OFFSET_TICKS = 3600;
const SIGMA_OFFSET = 0.0005;
/** Chance per stock per tick of a larger move, its size range and its length in ticks. */
const EVENT_CHANCE = 1 / 900;
const EVENT_MIN = 0.03;
const EVENT_MAX = 0.08;
const EVENT_MIN_TICKS = 4;
const EVENT_MAX_TICKS = 10;
/** Log price beyond which a stock is pulled back hard: about 3.5x or 1 / 3.5x the start. */
const LOG_LIMIT = Math.log(3.5);
/** Share of the way mood and volatility changes move each tick. */
const PARAM_EASE = 0.04;
/** Typical log move of a stock in one tick, for scaling volumes and wicks. */
const TYPICAL_MOVE = 0.002;

interface MoodSpec {
  /** Fair-value drift per tick. */
  drift: number;
  /** Noise multiplier. */
  noise: number;
  /** Mean-reversion multiplier: choppy markets snap back faster. */
  revert: number;
}

const MOODS: Record<Mood, MoodSpec> = {
  bull: { drift: Math.log(TREND_LEVEL) / FAIR_TICKS, noise: 1, revert: 1 },
  bear: { drift: -Math.log(TREND_LEVEL) / FAIR_TICKS, noise: 1, revert: 1 },
  sideways: { drift: 0, noise: 1, revert: 1 },
  choppy: { drift: 0, noise: 1.8, revert: 2 },
};

const isMood = (v: string): v is Mood => v in MOODS;

export const asMood = (v: string): Mood => (isMood(v) ? v : "sideways");

export interface Stock {
  readonly ticker: string;
  readonly name: string;
  /** Price at the start, which changes are measured against. */
  readonly ref: number;
  readonly beta: number;
  /** Own-noise multiplier. */
  readonly idio: number;
  /** Typical shares traded per tick. */
  readonly lot: number;
  /** Own log offset, its fair value, and the event move still to come. */
  e: number;
  h: number;
  eventLeft: number;
  eventTicks: number;
  price: number;
  /** Price before the last tick. */
  prev: number;
  /** Candles in a ring of `HISTORY`: candle k is at slot `k % HISTORY`. */
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  /** Market time each candle opened, seconds after midnight. */
  readonly time: Float64Array;
  /** Trades in a ring of `TRADE_ROWS`: trade n is at slot `n % TRADE_ROWS`. */
  readonly tradePrice: Float64Array;
  readonly tradeSize: Float64Array;
  readonly tradeTime: Float64Array;
  /** 1 for a buy (at the ask), -1 for a sell (at the bid). */
  readonly tradeSide: Int8Array;
  /** Trades so far. */
  trades: number;
}

interface MarketIndex {
  readonly name: string;
  readonly ref: number;
  readonly beta: number;
  own: number;
  value: number;
}

export interface Market {
  readonly seed: number;
  /** Ticks so far. */
  tick: number;
  /** Candles started so far; the forming one is `candles - 1`. */
  candles: number;
  /** Ticks into the forming candle, 0 when the next tick starts a new one. */
  inCandle: number;
  /** Fair value and the market factor (log). */
  fair: number;
  factor: number;
  /** Eased mood drift, noise and reversion. */
  drift: number;
  noise: number;
  revert: number;
  /** Market time, seconds after midnight (unwrapped). */
  time: number;
  readonly stocks: Stock[];
  readonly indices: MarketIndex[];
  readonly rng: () => number;
}

/** A standard normal from `rng` (Box-Muller, one of the pair). */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function createStock(seed: number, i: number, company: Company): Stock {
  const rng = createRng(hash32(hash32(Math.floor(seed) ^ 0x51ac) + i * 0x85ebca6b));
  // Prices from about 8 to 400, spread on a log scale.
  const ref = Math.round(Math.exp(Math.log(8) + rng() * Math.log(50)) * 100) / 100;
  return {
    ticker: company.ticker,
    name: company.name,
    ref,
    beta: 0.6 + 0.8 * rng(),
    idio: 0.7 + 0.7 * rng(),
    lot: Math.round((200 + 1800 * rng()) * (ref < 30 ? 4 : 1)),
    e: 0,
    h: 0,
    eventLeft: 0,
    eventTicks: 0,
    price: ref,
    prev: ref,
    open: new Float64Array(HISTORY),
    high: new Float64Array(HISTORY),
    low: new Float64Array(HISTORY),
    close: new Float64Array(HISTORY),
    volume: new Float64Array(HISTORY),
    time: new Float64Array(HISTORY),
    tradePrice: new Float64Array(TRADE_ROWS),
    tradeSize: new Float64Array(TRADE_ROWS),
    tradeTime: new Float64Array(TRADE_ROWS),
    tradeSide: new Int8Array(TRADE_ROWS),
    trades: 0,
  };
}

/**
 * A fresh market for `seed` whose clock reads `startTime` (seconds after
 * midnight). Every stock starts at its reference price with no candles; call
 * `warmUp` to fill the history.
 */
export function createMarket(seed: number, startTime: number): Market {
  const companies = generateCompanies(seed, MAX_STOCKS);
  const irng = createRng(hash32(Math.floor(seed) ^ 0x1d3c));
  return {
    seed,
    tick: 0,
    candles: 0,
    inCandle: 0,
    fair: 0,
    factor: 0,
    drift: 0,
    noise: 1,
    revert: 1,
    time: startTime,
    stocks: companies.map((c, i) => createStock(seed, i, c)),
    indices: INDEX_NAMES.map((name, k) => {
      const ref = Math.round((800 + 30000 * irng() ** 2) * 100) / 100;
      return { name, ref, beta: [1, 1.3, 1.15, 0.85][k] ?? 1, own: 0, value: ref };
    }),
    rng: createRng(hash32(Math.floor(seed) ^ 0x6d61726b)),
  };
}

/** The price step between order book levels near `price`: 1, 2 or 5 of a power of ten, at least 0.01. */
export function bookIncrement(price: number): number {
  const raw = Math.max(price, 0.01) * 0.0004;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const m = raw / mag >= 5 ? 5 : raw / mag >= 2 ? 2 : 1;
  return Math.max(0.01, m * mag);
}

/** The best bid just below `price`, on a whole increment (as `Math.round`ed cents avoid drift). */
export function bestBid(price: number): number {
  const inc = bookIncrement(price);
  let bid = Math.floor(price / inc + 1e-9) * inc;
  if (bid >= price) {
    bid -= inc;
  }
  return Math.round(bid * 1e6) / 1e6;
}

/** The best ask: one or two increments above the best bid, by tick. */
export function bestAsk(price: number, tick: number, stock: number): number {
  const inc = bookIncrement(price);
  const wide = hash32(tick * 31 + stock * 7919) % 4 === 0 ? 2 : 1;
  return Math.round((bestBid(price) + wide * inc) * 1e6) / 1e6;
}

/** Applies one tick to `m` under `mood` with noise scaled by `volatility`, the clock advancing `seconds`. */
function tickOnce(m: Market, mood: Mood, volatility: number, seconds: number): void {
  const spec = MOODS[mood];
  const rng = m.rng;
  m.drift += (spec.drift - m.drift) * PARAM_EASE;
  m.noise += (spec.noise * clamp(volatility, 0.1, 3) - m.noise) * PARAM_EASE;
  m.revert += (spec.revert - m.revert) * PARAM_EASE;

  m.fair += m.drift - m.fair / FAIR_TICKS + SIGMA_FAIR * normal(rng);
  m.factor +=
    ((m.fair - m.factor) * m.revert) / MARKET_TICKS + SIGMA_MARKET * m.noise * normal(rng);

  const newCandle = m.inCandle === 0;
  const k = newCandle ? m.candles : m.candles - 1;
  const slot = k % HISTORY;
  if (newCandle) {
    m.candles++;
  }
  m.inCandle = (m.inCandle + 1) % CANDLE_TICKS;

  for (let i = 0; i < m.stocks.length; i++) {
    const s = m.stocks[i];
    s.h += -s.h / OFFSET_TICKS + SIGMA_OFFSET * normal(rng);
    const x0 = s.beta * m.factor + s.e;
    if (s.eventTicks > 0) {
      const step = s.eventLeft / s.eventTicks;
      s.e += step;
      s.eventLeft -= step;
      s.eventTicks--;
    } else if (rng() < EVENT_CHANCE) {
      // Larger moves lean back towards the start when the price is already far out.
      const lean = clamp(x0 / LOG_LIMIT, -1, 1);
      const sign = rng() < 0.5 - 0.35 * lean ? 1 : -1;
      const size = EVENT_MIN + (EVENT_MAX - EVENT_MIN) * rng();
      s.eventLeft = Math.log(1 + sign * size);
      s.eventTicks = EVENT_MIN_TICKS + Math.floor(rng() * (EVENT_MAX_TICKS - EVENT_MIN_TICKS + 1));
    }
    s.e += ((s.h - s.e) * m.revert) / STOCK_TICKS + SIGMA_STOCK * s.idio * m.noise * normal(rng);
    let x = s.beta * m.factor + s.e;
    if (Math.abs(x) > LOG_LIMIT) {
      s.e -= (x - Math.sign(x) * LOG_LIMIT) * 0.2;
      x = s.beta * m.factor + s.e;
    }
    s.prev = s.price;
    s.price = s.ref * Math.exp(x);

    // The candle: a new one opens at the last close.
    if (newCandle) {
      s.open[slot] = s.prev;
      s.high[slot] = s.prev;
      s.low[slot] = s.prev;
      s.volume[slot] = 0;
      s.time[slot] = m.time;
    }
    const move = Math.abs(Math.log(s.price / s.prev));
    const wick = 0.4 * TYPICAL_MOVE * m.noise * Math.abs(normal(rng));
    s.high[slot] = Math.max(s.high[slot], Math.max(s.prev, s.price) * (1 + wick));
    s.low[slot] = Math.min(s.low[slot], Math.min(s.prev, s.price) * (1 - wick));
    s.close[slot] = s.price;
    const shares = s.lot * (0.6 + (0.8 * move) / TYPICAL_MOVE) * Math.exp(0.35 * normal(rng));
    s.volume[slot] += shares;

    // One trade a tick, mostly in the direction of the move, at the best bid or ask.
    const buy = s.price > s.prev ? rng() < 0.75 : s.price < s.prev ? rng() < 0.25 : rng() < 0.5;
    const n = s.trades % TRADE_ROWS;
    s.tradePrice[n] = buy ? bestAsk(s.price, m.tick, i) : bestBid(s.price);
    s.tradeSize[n] = Math.max(1, Math.round((shares * (0.05 + 0.25 * rng())) / 10) * 10);
    s.tradeTime[n] = m.time;
    s.tradeSide[n] = buy ? 1 : -1;
    s.trades++;
  }

  for (const idx of m.indices) {
    idx.own += -idx.own / 600 + 0.0004 * normal(rng);
    idx.value = idx.ref * Math.exp(idx.beta * m.factor + idx.own);
  }
  m.tick++;
  m.time += seconds;
}

/**
 * Steps `m` by `ticks` ticks under `mood` (eased into over a few dozen ticks)
 * with noise scaled by `volatility`, the clock advancing `seconds` per tick.
 * Stepping n ticks at once is the same as n single steps.
 */
export function stepMarket(
  m: Market,
  ticks: number,
  mood: Mood,
  volatility: number,
  seconds: number,
): void {
  for (let i = 0; i < ticks; i++) {
    tickOnce(m, mood, volatility, seconds);
  }
}

/** Fills the history with `candles` candles before the clock's start time, ending on a whole candle. */
export function warmUp(
  m: Market,
  candles: number,
  mood: Mood,
  volatility: number,
  seconds: number,
): void {
  m.time -= candles * CANDLE_TICKS * seconds;
  stepMarket(m, candles * CANDLE_TICKS, mood, volatility, seconds);
}

/** A stock's order book: `BOOK_LEVELS` prices and sizes each side, best first. */
export interface Book {
  readonly bidPrice: Float64Array;
  readonly bidSize: Float64Array;
  readonly askPrice: Float64Array;
  readonly askSize: Float64Array;
}

export const createBook = (): Book => ({
  bidPrice: new Float64Array(BOOK_LEVELS),
  bidSize: new Float64Array(BOOK_LEVELS),
  askPrice: new Float64Array(BOOK_LEVELS),
  askSize: new Float64Array(BOOK_LEVELS),
});

/** Smooth noise in 0..1 along `t` for one stream: hashed values eased between whole steps. */
function smoothNoise(stream: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash32(stream ^ hash32(i)) / 4294967296;
  const b = hash32(stream ^ hash32(i + 1)) / 4294967296;
  return a + (b - a) * f * f * (3 - 2 * f);
}

/**
 * Fills `out` with stock `i`'s order book now: levels an increment apart out from
 * the best bid and ask, sizes growing with depth and wandering smoothly from
 * tick to tick.
 */
export function fillBook(m: Market, i: number, out: Book): Book {
  const s = m.stocks[i];
  const inc = bookIncrement(s.price);
  const bid = bestBid(s.price);
  const ask = bestAsk(s.price, m.tick - 1, i);
  const base = hash32(Math.floor(m.seed) * 977 + i * 131);
  for (let l = 0; l < BOOK_LEVELS; l++) {
    out.bidPrice[l] = Math.round((bid - l * inc) * 1e6) / 1e6;
    out.askPrice[l] = Math.round((ask + l * inc) * 1e6) / 1e6;
    const depth = s.lot * 0.6 * (1 + 0.35 * l);
    out.bidSize[l] =
      Math.round((depth * (0.3 + 1.4 * smoothNoise(base + l, m.tick / 6))) / 10) * 10;
    out.askSize[l] =
      Math.round((depth * (0.3 + 1.4 * smoothNoise(base + 97 + l, m.tick / 6))) / 10) * 10;
  }
  return out;
}

/** Ring slot of candle `k`. */
export const candleSlot = (k: number): number => k % HISTORY;
/** Ring slot of trade `n`. */
export const tradeSlot = (n: number): number => n % TRADE_ROWS;
