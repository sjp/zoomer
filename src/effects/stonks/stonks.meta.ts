import { defineEffectMeta } from "../types";

const STYLE_OPTIONS = [
  { value: "terminal", label: "Terminal" },
  { value: "clipart", label: "Clip art" },
] as const;

const CHART_OPTIONS = [
  { value: "line", label: "Line" },
  { value: "candles", label: "Candles" },
] as const;

const COLOR_OPTIONS = [
  { value: "green", label: "Green" },
  { value: "cyan", label: "Cyan" },
  { value: "gold", label: "Gold" },
] as const;

/** Code points in the one-line caption. */
const CAPTION_LENGTH = 16;
/** The climb speed slider's ends: multiples of one new chart point a second. */
export const MIN_SPEED = 0.2;
export const MAX_SPEED = 1.5;

export const stonksMeta = defineEffectMeta({
  id: "stonks",
  name: "Stonks",
  description:
    "A dark trading terminal where the line only ever goes up: a glowing chart climbs forever on a log scale, a big bevelled arrow bobs beside it, made-up tickers scroll along the bottom (all up), and a confidently misspelt caption sits on top.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "terminal" },
    text: {
      kind: "text",
      label: "Caption",
      default: "STONKS",
      maxLength: CAPTION_LENGTH,
      maxLines: 1,
    },
    chart: { kind: "select", label: "Chart", options: CHART_OPTIONS, default: "line" },
    color: { kind: "select", label: "Colour", options: COLOR_OPTIONS, default: "green" },
    ticker: { kind: "boolean", label: "Ticker tape", default: true },
    crash: { kind: "boolean", label: "Occasional dip", default: false },
    speed: {
      kind: "number",
      label: "Climb speed",
      min: MIN_SPEED,
      max: MAX_SPEED,
      step: 0.05,
      default: 0.6,
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "stocks",
    "finance",
    "line goes up",
    "ironic",
    "candlesticks",
    "investing",
    "bull market",
    "wordart",
    "2010s",
  ],
  cost: "very low",
  context: "webgl2",
});
