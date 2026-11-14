import { defineEffectMeta } from "../types";

const LAYOUT_OPTIONS = [
  { value: "focus", label: "Focus" },
  { value: "grid", label: "Grid" },
] as const;

const MOOD_OPTIONS = [
  { value: "bull", label: "Bull" },
  { value: "bear", label: "Bear" },
  { value: "sideways", label: "Sideways" },
  { value: "choppy", label: "Choppy" },
] as const;

const CHART_OPTIONS = [
  { value: "candles", label: "Candles" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
] as const;

const COLOR_OPTIONS = [
  { value: "green-up", label: "Green up / red down" },
  { value: "red-up", label: "Red up / green down" },
] as const;

const THEME_OPTIONS = [
  { value: "terminal", label: "Terminal" },
  { value: "light", label: "Light" },
] as const;

const ROTATE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "2", label: "Every 2 min" },
  { value: "5", label: "Every 5 min" },
] as const;

/** Fewest and most stocks shown. */
export const MIN_COUNT = 4;
export const MAX_COUNT = 9;

/** Seconds between price ticks. */
export const MIN_PACE = 0.5;
export const MAX_PACE = 5;

export const tradingMeta = defineEffectMeta({
  id: "trading",
  name: "Trading Dashboard",
  description:
    "A dark trading terminal for a made-up market: a watchlist with sparklines, a big candlestick chart, an order book and recent trades, or a wall of tiles, all ticking along in calm, stepped updates.",
  params: {
    layout: { kind: "select", label: "Layout", options: LAYOUT_OPTIONS, default: "focus" },
    count: {
      kind: "number",
      label: "Stocks",
      min: MIN_COUNT,
      max: MAX_COUNT,
      step: 1,
      default: 8,
    },
    mood: { kind: "select", label: "Market mood", options: MOOD_OPTIONS, default: "sideways" },
    volatility: {
      kind: "number",
      label: "Volatility",
      min: 0.25,
      max: 2,
      step: 0.05,
      default: 1,
    },
    pace: {
      kind: "number",
      label: "Seconds per tick",
      min: MIN_PACE,
      max: MAX_PACE,
      step: 0.25,
      default: 1,
    },
    chart: { kind: "select", label: "Chart", options: CHART_OPTIONS, default: "candles" },
    colors: { kind: "select", label: "Colours", options: COLOR_OPTIONS, default: "green-up" },
    theme: { kind: "select", label: "Theme", options: THEME_OPTIONS, default: "terminal" },
    rotate: { kind: "select", label: "Rotate focus", options: ROTATE_OPTIONS, default: "2" },
    dim: { kind: "number", label: "Centre dim", min: 0, max: 0.6, step: 0.05, default: 0.25 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Work"],
  tags: [
    "stocks",
    "market",
    "finance",
    "trader",
    "candles",
    "ticker",
    "wall street",
    "shares",
    "day trading",
    "bloomberg",
  ],
  cost: "low",
  context: "webgl2",
});
