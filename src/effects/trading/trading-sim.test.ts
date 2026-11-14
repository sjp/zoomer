import { describe, expect, it } from "vitest";
import {
  asMood,
  bestAsk,
  bestBid,
  type Book,
  BOOK_LEVELS,
  bookIncrement,
  CANDLE_TICKS,
  candleSlot,
  createBook,
  createMarket,
  fillBook,
  HISTORY,
  INDEX_COUNT,
  type Market,
  MAX_STOCKS,
  type Mood,
  type Stock,
  stepMarket,
  tradeSlot,
  warmUp,
} from "./trading-sim";
import { DENIED_TICKERS, generateCompanies, tickerFor } from "./trading-names";

const MOODS: Mood[] = ["bull", "bear", "sideways", "choppy"];

describe("companies", () => {
  it.each([1, 2, 3, 42, 777])("are unique and never a real ticker for seed %d", (seed) => {
    const cs = generateCompanies(seed, MAX_STOCKS);
    const tickers = cs.map((c) => c.ticker);
    expect(new Set(tickers).size).toBe(MAX_STOCKS);
    expect(new Set(cs.map((c) => c.name)).size).toBe(MAX_STOCKS);
    for (const t of tickers) {
      expect(DENIED_TICKERS.has(t)).toBe(false);
      expect(t).toMatch(/^[A-Z]{3,5}$/);
    }
  });

  it("are prefix-stable as the count grows", () => {
    expect(generateCompanies(9, 4)).toEqual(generateCompanies(9, MAX_STOCKS).slice(0, 4));
  });

  it("checks every seed up to 300 against the deny list", () => {
    for (let seed = 0; seed < 300; seed++) {
      for (const c of generateCompanies(seed, MAX_STOCKS)) {
        expect(DENIED_TICKERS.has(c.ticker)).toBe(false);
      }
    }
  });

  it("builds tickers from the word's consonants", () => {
    expect(tickerFor("Quantex", "Systems", () => 0.9)).toBe("QNTX");
    expect(tickerFor("Holmer", "Foods", () => 0.9)).toBe("HLMR");
    expect(tickerFor("Aia", "Labs", () => 0.9)).toBe("AI");
  });
});

/** A warmed-up market. */
function market(seed: number, mood: Mood = "sideways", volatility = 1): Market {
  const m = createMarket(seed, 36000);
  warmUp(m, 40, mood, volatility, 1);
  return m;
}

describe("market", () => {
  it("parses moods, defaulting to sideways", () => {
    expect(asMood("bull")).toBe("bull");
    expect(asMood("nope")).toBe("sideways");
  });

  it("ends warm-up on a whole candle with the clock at the start time", () => {
    const m = market(1);
    expect(m.indices.length).toBe(INDEX_COUNT);
    expect(m.candles).toBe(40);
    expect(m.inCandle).toBe(0);
    expect(m.time).toBe(36000);
    expect(m.tick).toBe(40 * CANDLE_TICKS);
  });

  it.each([1, 5, 99])(
    "is deterministic per seed and the same in one chunk or many (%d)",
    (seed) => {
      const a = createMarket(seed, 0);
      const b = createMarket(seed, 0);
      stepMarket(a, 500, "choppy", 1.5, 1);
      for (let i = 0; i < 500; i++) {
        stepMarket(b, 1, "choppy", 1.5, 1);
      }
      expect(a.stocks.map((s) => s.price)).toEqual(b.stocks.map((s) => s.price));
      expect(a.stocks[3].close).toEqual(b.stocks[3].close);
      expect(a.indices.map((x) => x.value)).toEqual(b.indices.map((x) => x.value));
    },
  );

  it("differs between seeds", () => {
    expect(market(1).stocks[0].price).not.toBe(market(2).stocks[0].price);
  });

  it.each(MOODS.flatMap((mood) => [1, 2, 3].map((seed) => [mood, seed] as const)))(
    "keeps %s prices plausible over four hours (seed %d)",
    (mood, seed) => {
      const m = createMarket(seed, 0);
      let lo = Infinity;
      let hi = 0;
      for (let t = 0; t < 4 * 3600; t++) {
        stepMarket(m, 1, mood, 2, 1);
        for (const s of m.stocks) {
          const r = s.price / s.ref;
          lo = Math.min(lo, r);
          hi = Math.max(hi, r);
        }
      }
      expect(lo).toBeGreaterThan(0.2);
      expect(hi).toBeLessThan(5);
    },
  );

  it.each(["bull", "bear"] as const)("trends in a %s market", (mood) => {
    let sum = 0;
    for (let seed = 0; seed < 6; seed++) {
      const m = createMarket(seed, 0);
      stepMarket(m, 1800, mood, 1, 1);
      sum += m.factor;
    }
    expect(mood === "bull" ? sum : -sum).toBeGreaterThan(0.5);
  });

  it.each([1, 7])("keeps candles consistent (seed %d)", (seed) => {
    const m = createMarket(seed, 0);
    stepMarket(m, HISTORY * CANDLE_TICKS + 3, "choppy", 2, 1);
    const stocks: Stock[] = m.stocks;
    for (const s of stocks) {
      for (let k = m.candles - HISTORY + 1; k < m.candles; k++) {
        const c = candleSlot(k);
        expect(s.low[c]).toBeLessThanOrEqual(Math.min(s.open[c], s.close[c]));
        expect(s.high[c]).toBeGreaterThanOrEqual(Math.max(s.open[c], s.close[c]));
        expect(s.volume[c]).toBeGreaterThan(0);
      }
      for (let k = m.candles - HISTORY + 2; k < m.candles; k++) {
        expect(s.open[candleSlot(k)]).toBe(s.close[candleSlot(k - 1)]);
      }
    }
  });

  it("moves the stocks together", () => {
    const m = createMarket(3, 0);
    const n = 3000;
    const returns = m.stocks.map(() => new Float64Array(n));
    for (let t = 0; t < n; t++) {
      stepMarket(m, 1, "sideways", 1, 1);
      m.stocks.forEach((s, i) => {
        returns[i][t] = Math.log(s.price / s.prev);
      });
    }
    const corr = (a: Float64Array, b: Float64Array) => {
      const ma = a.reduce((x, y) => x + y, 0) / n;
      const mb = b.reduce((x, y) => x + y, 0) / n;
      let ab = 0;
      let aa = 0;
      let bb = 0;
      for (let t = 0; t < n; t++) {
        ab += (a[t] - ma) * (b[t] - mb);
        aa += (a[t] - ma) ** 2;
        bb += (b[t] - mb) ** 2;
      }
      return ab / Math.sqrt(aa * bb);
    };
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < MAX_STOCKS; i++) {
      for (let j = i + 1; j < MAX_STOCKS; j++) {
        total += corr(returns[i], returns[j]);
        pairs++;
      }
    }
    expect(total / pairs).toBeGreaterThan(0.15);
  });

  it("makes larger moves over several ticks, never in one", () => {
    const m = createMarket(11, 0);
    let biggest = 0;
    for (let t = 0; t < 20000; t++) {
      stepMarket(m, 1, "sideways", 1, 1);
      for (const s of m.stocks) {
        biggest = Math.max(biggest, Math.abs(Math.log(s.price / s.prev)));
      }
    }
    expect(biggest).toBeLessThan(0.03);
  });
});

describe("order book and trades", () => {
  it.each([5.003, 99.99, 100, 123.456, 401.2])(
    "quotes a bid below and an ask above %d",
    (price) => {
      const bid = bestBid(price);
      expect(bid).toBeLessThan(price);
      expect(price - bid).toBeLessThanOrEqual(bookIncrement(price) + 1e-9);
      for (let tick = 0; tick < 8; tick++) {
        expect(bestAsk(price, tick, 0)).toBeGreaterThanOrEqual(price);
      }
    },
  );

  it("picks increments of 1, 2 or 5", () => {
    expect(bookIncrement(5)).toBe(0.01);
    expect(bookIncrement(100)).toBeCloseTo(0.02, 12);
    expect(bookIncrement(400)).toBeCloseTo(0.1, 12);
  });

  it.each([1, 4])(
    "brackets the price and prints trades at the best bid or ask (seed %d)",
    (seed) => {
      const m = market(seed, "choppy");
      const book: Book = createBook();
      for (let t = 0; t < 50; t++) {
        stepMarket(m, 1, "choppy", 1, 1);
        for (let i = 0; i < MAX_STOCKS; i++) {
          const s = m.stocks[i];
          fillBook(m, i, book);
          expect(book.bidPrice[0]).toBeLessThan(s.price);
          expect(book.askPrice[0]).toBeGreaterThanOrEqual(s.price);
          for (let l = 1; l < BOOK_LEVELS; l++) {
            expect(book.bidPrice[l]).toBeLessThan(book.bidPrice[l - 1]);
            expect(book.askPrice[l]).toBeGreaterThan(book.askPrice[l - 1]);
            expect(book.bidSize[l]).toBeGreaterThan(0);
          }
          const n = tradeSlot(s.trades - 1);
          const at = s.tradeSide[n] > 0 ? book.askPrice[0] : book.bidPrice[0];
          expect(s.tradePrice[n]).toBe(at);
          expect(s.tradeTime[n]).toBe(m.time - 1);
        }
      }
    },
  );
});
