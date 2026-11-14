/**
 * Made-up listed companies for the Trading Dashboard: a pronounceable invented
 * word plus a line of business ("Quantex Systems"), and a ticker made from the
 * word's consonants ("QNTX"). Each company comes from its own hash of the seed
 * and its index, so a market's first n companies stay the same whatever its size.
 */
import { createRng, hash32 } from "../noise";

const ONSETS = [
  "b",
  "br",
  "c",
  "cl",
  "d",
  "dr",
  "f",
  "fl",
  "g",
  "gr",
  "h",
  "k",
  "l",
  "m",
  "n",
  "p",
  "pr",
  "qu",
  "r",
  "s",
  "st",
  "t",
  "tr",
  "v",
  "w",
  "z",
];
const VOWELS = ["a", "e", "i", "o", "u", "a", "e", "o"];
const MIDDLES = ["l", "m", "n", "r", "t", "v", "x", "nt", "rd", "lm", "st", "nd", "rv", "ss"];
const ENDINGS = ["", "a", "ex", "en", "on", "er", "is", "ar", "ia", "ix", "o", "um"];

const SECTORS = [
  "Systems",
  "Foods",
  "Holdings",
  "Energy",
  "Labs",
  "Logistics",
  "Pharma",
  "Industries",
  "Motors",
  "Networks",
  "Materials",
  "Robotics",
  "Biotech",
  "Retail",
  "Mining",
  "Aerospace",
  "Software",
  "Utilities",
  "Semiconductor",
  "Brands",
];

/**
 * Tickers of well-known listed companies and funds that a made-up market must
 * never show, so nothing reads as a real quote.
 */
export const DENIED_TICKERS: ReadonlySet<string> = new Set([
  "AAPL",
  "MSFT",
  "GOOG",
  "GOOGL",
  "AMZN",
  "META",
  "TSLA",
  "NVDA",
  "NFLX",
  "INTC",
  "AMD",
  "IBM",
  "ORCL",
  "CSCO",
  "ADBE",
  "CRM",
  "PYPL",
  "UBER",
  "LYFT",
  "DIS",
  "KO",
  "PEP",
  "WMT",
  "TGT",
  "COST",
  "HD",
  "LOW",
  "NKE",
  "MCD",
  "SBUX",
  "JPM",
  "BAC",
  "WFC",
  "GS",
  "MS",
  "AXP",
  "BRK",
  "XOM",
  "CVX",
  "BP",
  "SHEL",
  "PFE",
  "MRK",
  "JNJ",
  "ABBV",
  "LLY",
  "UNH",
  "CVS",
  "VZ",
  "TMUS",
  "GE",
  "GM",
  "BA",
  "CAT",
  "DE",
  "MMM",
  "HON",
  "LMT",
  "RTX",
  "NOC",
  "QCOM",
  "TXN",
  "AVGO",
  "MU",
  "SNAP",
  "SPOT",
  "SHOP",
  "ZM",
  "BABA",
  "TSM",
  "SONY",
  "TM",
  "HMC",
  "NIO",
  "RIVN",
  "PLTR",
  "COIN",
  "HOOD",
  "GME",
  "AMC",
  "NOK",
  "SPY",
  "QQQ",
  "DIA",
  "IWM",
  "VTI",
  "VOO",
  "ARKK",
  "ABNB",
  "DELL",
  "HPQ",
  "SAP",
  "ASML",
  "NVO",
  "TTWO",
  "EA",
  "ROKU",
  "PINS",
  "SQ",
  "MA",
  "V",
  "T",
  "F",
  "C",
  "X",
]);

/** Words of well-known brands an invented name must not spell. */
const DENIED_WORDS: ReadonlySet<string> = new Set([
  "tesla",
  "intel",
  "oracle",
  "amazon",
  "apple",
  "google",
  "meta",
  "nike",
  "sony",
  "nokia",
  "pepsi",
  "visa",
  "shell",
  "boeing",
  "cisco",
  "adobe",
  "uber",
  "zoom",
  "lyft",
  "dell",
  "sega",
  "nintendo",
  "toyota",
  "honda",
  "volvo",
  "lego",
  "ikea",
  "rolex",
  "prada",
  "gucci",
  "tata",
  "bosch",
  "dove",
  "lidl",
  "aldi",
  "sanofi",
  "bayer",
  "merck",
  "pfizer",
  "nestle",
  "danone",
]);

export interface Company {
  ticker: string;
  name: string;
}

const pick = <T>(list: readonly T[], rng: () => number): T => list[Math.floor(rng() * list.length)];

/** An invented word of two or three syllables, capitalised. */
function inventWord(rng: () => number): string {
  let w = pick(ONSETS, rng) + pick(VOWELS, rng) + pick(MIDDLES, rng) + pick(ENDINGS, rng);
  if (w.length < 5) {
    w += pick(MIDDLES, rng) + pick(VOWELS, rng);
  }
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * A ticker for `word` (and its sector): the first letter and the consonants
 * after it, three or four letters, sometimes with the sector's initial added.
 */
export function tickerFor(word: string, sector: string, rng: () => number): string {
  const letters = word.toUpperCase().replace(/[^A-Z]/g, "");
  let t = letters.charAt(0);
  for (const ch of letters.slice(1)) {
    if (!"AEIOU".includes(ch) && ch !== t.charAt(t.length - 1)) {
      t += ch;
    }
  }
  t = t.slice(0, rng() < 0.5 ? 3 : 4);
  // Too few consonants: fill from the word's other letters.
  for (let i = 1; t.length < 3 && i < letters.length; i++) {
    if (!t.includes(letters.charAt(i))) {
      t += letters.charAt(i);
    }
  }
  if (t.length < 5 && rng() < 0.15) {
    t += sector.charAt(0).toUpperCase();
  }
  return t;
}

/** Companies `0 .. count - 1` of the market for `seed`: unique, and none denied. */
export function generateCompanies(seed: number, count: number): Company[] {
  const out: Company[] = [];
  const tickers = new Set<string>();
  const words = new Set<string>();
  for (let i = 0; i < count; i++) {
    const rng = createRng(hash32(hash32(Math.floor(seed) ^ 0x7a11c3) + i * 0x9e3779b1));
    for (let attempt = 0; ; attempt++) {
      const word = inventWord(rng);
      const sector = pick(SECTORS, rng);
      const ticker = tickerFor(word, sector, rng);
      const lower = word.toLowerCase();
      const ok =
        !words.has(lower) &&
        !tickers.has(ticker) &&
        !DENIED_TICKERS.has(ticker) &&
        ![...DENIED_WORDS].some((d) => lower.includes(d)) &&
        ticker.length >= 3;
      // The word space is huge; the cap only guards against a broken generator.
      if (ok || attempt > 200) {
        tickers.add(ticker);
        words.add(lower);
        out.push({ ticker, name: `${word} ${sector}` });
        break;
      }
    }
  }
  return out;
}

/** The market indices shown along the bottom: generic names, no real index. */
export const INDEX_NAMES = ["Composite", "Tech Leaders", "Small Caps", "Industrials"] as const;
