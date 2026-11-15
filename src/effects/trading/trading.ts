import { MONO_FONT_STACK, SANS_FONT_STACK } from "../canvas-texture";
import {
  autoRange,
  type AutoRangeOptions,
  type AxisRange,
  clipLine,
  createAxisRange,
  createChartRenderer,
  createStepSlide,
  createTicks,
  formatCompact,
  formatFixed,
  formatPercent,
  formatSigned,
  kickSlide,
  type LineClip,
  minTweenSeconds,
  niceTicks,
  priceDecimals,
  pushArc,
  pushArea,
  pushCandle,
  pushPolyline,
  pushGridlines,
  pushRect,
  rangeShiftPx,
  settleSlide,
  stepAxis,
  stepSlide,
  tickAt,
  valueY,
} from "../charts";
import { createColorEase, hexesToUnitRgb } from "../color";
import { createCountFade, createFadeThrough } from "../fade";
import { beginFrame, withScope } from "../gl";
import { approach, clamp, smoothstep } from "../math";
import { type StepClock, takeSteps } from "../step-clock";
import {
  createTextLayer,
  setTextPalette,
  TEXT_PALETTE_FLOATS,
  TEXT_ROLES,
  type TextLayer,
} from "../text-layer";
import { defineEffect } from "../types";
import {
  COLUMN_HEADS,
  createFocusLayout,
  focusLayout,
  gridTiles,
  PAD,
  PANEL_TITLE,
  type Rect,
  TILE_HEADER,
  tileTextWidths,
  TOP_BAR,
} from "./trading-layout";
import {
  asMood,
  BOOK_LEVELS,
  type Book,
  candleSlot,
  createBook,
  createMarket,
  fillBook,
  HISTORY,
  INDEX_COUNT,
  type Market,
  MAX_STOCKS,
  type Stock,
  stepMarket,
  TRADE_ROWS,
  tradeSlot,
  warmUp,
} from "./trading-sim";
import { MAX_COUNT, MAX_PACE, MIN_COUNT, MIN_PACE, tradingMeta } from "./trading.meta";

/** Candle spacing on the main chart (reference px), and a body's share of it. */
export const CANDLE_SPACING = 14;
const BODY = 0.62;
/** Candles across a grid tile's chart, and points in a watchlist sparkline. */
export const TILE_CANDLES = 40;
const SPARK_CANDLES = 30;
/** Seconds a chart takes to step left one candle, and a new trade row to slide in. */
export const STEP_SECONDS = 0.6;
export const SLIDE_SECONDS = 0.3;
/** Fewest seconds between new rows in the trades list. */
const TRADE_GAP = 1;
/** A time label under the main chart every this many candles. */
const LABEL_EVERY = 12;
/** Seconds for the layout crossfade, each half of a focus or variation swap, and colour eases. */
const LAYOUT_FADE = 1;
const SWAP_HALF = 0.5;
const COLOR_EASE = 1;
/** Seconds a chart-type change and the focus highlight take to ease. */
const TYPE_EASE = 0.8;
const HIGHLIGHT_EASE = 0.5;
/** Count fades: seconds for a row or tile to fade in or out. */
const COUNT_FADE = 0.6;
/** Changed-value tint: peak opacity, ramp in and total seconds. */
const TINT_PEAK = 0.22;
const TINT_RAMP = 0.12;
const TINT_SECONDS = 1.1;
/** Shortest re-tile move in the grid, s (longer moves are slowed to the motion limits). */
const RETILE_MIN = 0.8;
/** Most ticks run in one frame. */
const MAX_TICKS_PER_FRAME = 4;
/** Vertices of chart geometry, and text regions per layout. */
const MESH_CAPACITY = 30000;
const MAX_QUADS = 40;
/** Main chart: target gridline gap (reference px). */
const GRID_GAP = 70;
/** Sparkline and line-chart stroke widths (reference px). */
const SPARK_WIDTH = 1.4;
const LINE_WIDTH = 2;
/** Price tag height on the axis (reference px). */
const TAG_HEIGHT = 20;
/** Width of a grid tile's change chip (reference px). */
const CHIP_WIDTH = 96;
/** Margin either side of the time-axis band in the text canvas (reference px). */
const TIME_PAD = 40;
/**
 * Top bar, right to left (reference px): the clock's right edge in from the
 * screen edge, the LIVE label's right edge in from the clock's, and the live
 * dot's centre in from the label's.
 */
const CLOCK_INSET = PAD + 14;
const LIVE_GAP = 96;
const LIVE_DOT_GAP = 40;

const RANGE: AutoRangeOptions = {
  pad: 0.12,
  edge: 0.04,
  minFill: 0.45,
  minSpan: 0,
  minSeconds: 0.8,
};
/** The smallest price range a chart shows, as a share of the price. */
const MIN_SPAN_SHARE = 0.006;

/** Palette slots: one RGB triple each. */
const BG = 0;
const PANEL = 1;
const HEAD = 2;
const BORDER = 3;
const GRID = 4;
const TEXT = 5;
const MUTED = 6;
const UP = 7;
const DOWN = 8;
const HILITE = 9;
const ACCENT = 10;
const COLORS = 11;

const THEMES: Record<string, readonly string[]> = {
  terminal: [
    "#06080b",
    "#0b0f14",
    "#10161d",
    "#1c2530",
    "#151d27",
    "#d6dde6",
    "#6c7887",
    "#22b573",
    "#e0524a",
    "#13202e",
    "#3d8bfd",
  ],
  light: [
    "#dfe4ea",
    "#ffffff",
    "#f3f5f8",
    "#ccd3db",
    "#e9edf1",
    "#1d232a",
    "#69737f",
    "#138a4a",
    "#c9323a",
    "#e4eefc",
    "#2f6fde",
  ],
};
const THEME_RGB: Record<string, Float32Array> = {};
for (const [name, hexes] of Object.entries(THEMES)) {
  THEME_RGB[name] = hexesToUnitRgb(hexes, COLORS * 3);
}

/** "HH:MM:SS" (or "HH:MM") of `seconds` after midnight. */
function clockText(seconds: number, withSeconds: boolean): string {
  const t = ((Math.floor(seconds) % 86400) + 86400) % 86400;
  const two = (n: number) => (n < 10 ? "0" : "") + String(n);
  const hm = two(Math.floor(t / 3600)) + ":" + two(Math.floor((t % 3600) / 60));
  return withSeconds ? hm + ":" + two(t % 60) : hm;
}

/** Fonts at one scale, built on resize. */
interface Fonts {
  title: string;
  panel: string;
  head: string;
  ticker: string;
  name: string;
  num: string;
  small: string;
  bigTicker: string;
  bigPrice: string;
  change: string;
  axis: string;
}

function makeFonts(s: number): Fonts {
  const px = (n: number) => String(Math.max(4, Math.round(n * s))) + "px ";
  return {
    title: "700 " + px(15) + SANS_FONT_STACK,
    panel: "600 " + px(12) + SANS_FONT_STACK,
    head: "500 " + px(11) + SANS_FONT_STACK,
    ticker: "600 " + px(15) + SANS_FONT_STACK,
    name: "400 " + px(11.5) + SANS_FONT_STACK,
    num: "500 " + px(14) + MONO_FONT_STACK,
    small: "400 " + px(12) + MONO_FONT_STACK,
    bigTicker: "700 " + px(22) + SANS_FONT_STACK,
    bigPrice: "600 " + px(24) + MONO_FONT_STACK,
    change: "500 " + px(15) + MONO_FONT_STACK,
    axis: "400 " + px(11.5) + MONO_FONT_STACK,
  };
}

/** Changed-value tint opacity `age` seconds after the change. */
const tintAlpha = (age: number): number =>
  TINT_PEAK * smoothstep(0, TINT_RAMP, age) * (1 - smoothstep(TINT_RAMP, TINT_SECONDS, age));

/** Signed change of `now` against `ref` as text, with the role colour to draw it in. */
const roleOf = (delta: number): string => (delta < 0 ? TEXT_ROLES.down : TEXT_ROLES.up);

/**
 * A trading terminal for a made-up market. Two layouts share one simulation:
 * Focus (watchlist, one big chart, order book, trades and an index strip) and
 * Grid (a tile per stock). Panel chrome and every chart mark are triangles from
 * one chart mesh, rebuilt each frame (a few thousand vertices); all text sits on
 * a device-pixel canvas per layout (`text-layer.ts`) that redraws only the rows
 * a tick changed and copies to the screen texel for texel. Text is drawn in role
 * colours, so theme and colour swaps ease on the GPU. Motion is stepped and
 * eased: a candle step, a trade row sliding in, an axis rescale, a tint fading.
 */
export const trading = defineEffect(tradingMeta, {
  create(gl) {
    return withScope((scope) => {
      const chart = createChartRenderer(gl, scope, MESH_CAPACITY);
      const mesh = chart.mesh;
      const focusText = createTextLayer(gl, scope, MAX_QUADS);
      const gridText = createTextLayer(gl, scope, MAX_QUADS);
      const ease = createColorEase(COLORS * 3);
      const target = new Float32Array(COLORS * 3);
      const col: Float32Array[] = [];
      for (let i = 0; i < COLORS; i++) {
        col.push(ease.value.subarray(i * 3, i * 3 + 3));
      }
      const textPalette = new Float32Array(TEXT_PALETTE_FLOATS);

      const layout = createFocusLayout();
      const range: AutoRangeOptions = { ...RANGE };
      const fade = createCountFade(MAX_STOCKS);
      const ticks = createTicks();
      const book: Book = createBook();
      const bookShown = new Float64Array(2 * BOOK_LEVELS);
      const clock: StepClock = { acc: 0 };
      const mainRange = createAxisRange();
      const tileRanges: AxisRange[] = [];
      for (let i = 0; i < MAX_STOCKS; i++) {
        tileRanges.push(createAxisRange());
      }
      const mainSlide = createStepSlide(STEP_SECONDS);
      const gridSlide = createStepSlide(STEP_SECONDS);
      const tradeSlide = createStepSlide(SLIDE_SECONDS);
      const xs = new Float32Array(HISTORY + 4);
      const ys = new Float32Array(HISTORY + 4);
      const tintAge = new Float32Array(MAX_STOCKS).fill(99);
      const tintUp = new Uint8Array(MAX_STOCKS);
      const indexAge = new Float32Array(INDEX_COUNT).fill(99);
      const indexUp = new Uint8Array(INDEX_COUNT);
      const highlight = new Float32Array(MAX_STOCKS);
      const middleDim = new Float32Array(MAX_STOCKS);
      const typeWeight = new Float32Array(3);
      /** Grid tiles: shown rects, and the tween from / to (x, y, w, h each). */
      const tileNow = new Float64Array(4 * MAX_STOCKS);
      const tileFrom = new Float64Array(4 * MAX_STOCKS);
      const tileTo = new Float64Array(4 * MAX_STOCKS);
      const indexPrev = new Float64Array(INDEX_COUNT);

      let width = 1;
      let height = 1;
      let scale = 1;
      let fonts = makeFonts(1);
      let market: Market | null = null;
      let focus = 0;
      let nextFocus = 0;
      /** Focus swap: fades the focus panels out, moves the focus, and fades them back in. */
      const focusFade = createFadeThrough(SWAP_HALF);
      /** Variation swap, the same way, for the whole screen. */
      const swap = createFadeThrough(SWAP_HALF);
      let focusWeight = 1;
      let started = false;
      let rotateTimer = 0;
      let shownCandles = 0;
      let shownTrades = 0;
      let tradeTimer = 0;
      let volMax = 1;
      let bookMax = 1;
      let tileMiddle = -1;
      let tileCount = 0;
      let tileT = 1;
      let tileSeconds = 1;
      let leftWidth = 1;
      let rightWidth = 1;
      let focusPainted = false;
      let gridPainted = false;
      /**
       * What each text block shows (its changing values), so a tick repaints only
       * the blocks whose text changed; "" until painted. Watchlist rows and tiles
       * are painted up to `watchRows` / `tileRows`, the live count when last painted.
       */
      const watchKeys: string[] = Array.from({ length: MAX_STOCKS }, () => "");
      const tileKeys: string[] = Array.from({ length: MAX_STOCKS }, () => "");
      const indexKeys: string[] = Array.from({ length: INDEX_COUNT }, () => "");
      let headerKey = "";
      let bookKey = "";
      let watchRows = 0;
      let tileRows = 0;
      let paintedLo = 0;
      let paintedHi = 0;
      let paintedPrice = 0;
      let paintedClock = "";
      let dimLevel = 0;
      /** Text canvas extras: the trades band and the time-axis band, below the frame. */
      let tradesBandY = 0;
      let timeBandY = 0;

      const C = (i: number) => col[i];
      const bodyTop = () => Math.round(PANEL_TITLE * scale);

      // ---- Text painters (they run on a tick or a change, never every frame).

      const fill = (
        ctx: OffscreenCanvasRenderingContext2D,
        text: string,
        x: number,
        y: number,
        role: string,
        align: CanvasTextAlign,
        font: string,
        maxWidth?: number,
      ) => {
        ctx.font = font;
        ctx.fillStyle = role;
        ctx.textAlign = align;
        ctx.textBaseline = "middle";
        if (maxWidth !== undefined && maxWidth > 0) {
          ctx.fillText(text, x, y, maxWidth);
        } else {
          ctx.fillText(text, x, y);
        }
      };

      const paintTopBar = (layer: TextLayer) => {
        const ctx = layer.ctx;
        if (!ctx) {
          return;
        }
        const h = Math.round(TOP_BAR * scale);
        layer.clear(0, 0, Math.round(width * 0.6), h);
        const x = Math.round((PAD + 14) * scale);
        fill(ctx, "MARKETS", x, h / 2, TEXT_ROLES.primary, "left", fonts.title);
        fill(
          ctx,
          "Equities  ·  Indices  ·  Watchlists",
          x + Math.round(110 * scale),
          h / 2,
          TEXT_ROLES.muted,
          "left",
          fonts.head,
        );
      };

      const paintClock = (layer: TextLayer, text: string) => {
        const ctx = layer.ctx;
        if (!ctx) {
          return;
        }
        const h = Math.round(TOP_BAR * scale);
        const x0 = Math.round(width * 0.6);
        layer.clear(x0, 0, width - x0, h);
        const right = width - Math.round(CLOCK_INSET * scale);
        fill(ctx, text, right, h / 2, TEXT_ROLES.primary, "right", fonts.num);
        fill(
          ctx,
          "LIVE",
          right - Math.round(LIVE_GAP * scale),
          h / 2,
          TEXT_ROLES.up,
          "right",
          fonts.head,
        );
      };

      const panelTitle = (layer: TextLayer, r: Rect, title: string, heads: readonly string[]) => {
        const ctx = layer.ctx;
        if (!ctx || r.w <= 0) {
          return;
        }
        const top = bodyTop();
        const pad = Math.round(PAD * scale);
        layer.clear(r.x, r.y, r.w, top + Math.round(COLUMN_HEADS * scale));
        fill(ctx, title, r.x + pad, r.y + top / 2, TEXT_ROLES.muted, "left", fonts.panel);
        const y = r.y + top + (COLUMN_HEADS * scale) / 2;
        // Headings: the first on the left, the last on the right, any between at 62%.
        heads.forEach((h, i) => {
          const last = i === heads.length - 1;
          const x = i === 0 ? r.x + pad : last ? r.x + r.w - pad : r.x + Math.round(r.w * 0.62) + 0;
          fill(ctx, h, x, y, TEXT_ROLES.muted, i === 0 ? "left" : "right", fonts.head);
        });
      };

      /** Watchlist column positions: sparkline span, and the right edges of last and change. */
      const cols = { sparkX: 0, sparkW: 0, lastX: 0, chgX: 0, pad: 0 };
      const watchCols = (r: Rect) => {
        const pad = Math.round(PAD * scale);
        cols.sparkX = r.x + Math.round(r.w * 0.34);
        cols.sparkW = Math.round(r.w * 0.22);
        cols.lastX = r.x + Math.round(r.w * 0.79);
        cols.chgX = r.x + r.w - pad;
        cols.pad = pad;
        return cols;
      };

      const paintWatchRow = (m: Market, i: number) => {
        const ctx = focusText.ctx;
        const r = layout.watch;
        if (!ctx || r.w <= 0) {
          return;
        }
        const s = m.stocks[i];
        const d = priceDecimals(s.price);
        const delta = s.price - s.ref;
        const price = formatFixed(s.price, d);
        const change = formatPercent(delta / s.ref);
        const key = price + " " + change;
        if (key === watchKeys[i]) {
          return;
        }
        watchKeys[i] = key;
        const h = layout.watchRow;
        const y = layout.watchRowsY + i * h;
        focusText.clear(r.x, y, r.w, h);
        const c = watchCols(r);
        fill(ctx, s.ticker, r.x + c.pad, y + h * 0.36, TEXT_ROLES.primary, "left", fonts.ticker);
        fill(
          ctx,
          s.name,
          r.x + c.pad,
          y + h * 0.72,
          TEXT_ROLES.muted,
          "left",
          fonts.name,
          r.w * 0.31,
        );
        fill(ctx, price, c.lastX, y + h * 0.5, TEXT_ROLES.primary, "right", fonts.num);
        fill(ctx, change, c.chgX, y + h * 0.36, roleOf(delta), "right", fonts.num);
        fill(
          ctx,
          formatSigned(delta, d),
          c.chgX,
          y + h * 0.72,
          roleOf(delta),
          "right",
          fonts.small,
        );
      };

      const paintChartHeader = (m: Market) => {
        const ctx = focusText.ctx;
        const r = layout.chartHeader;
        if (!ctx || r.w <= 0) {
          return;
        }
        const s = m.stocks[focus];
        const d = priceDecimals(s.price);
        const delta = s.price - s.ref;
        const price = formatFixed(s.price, d);
        const change = formatSigned(delta, d) + "  " + formatPercent(delta / s.ref);
        const key = s.ticker + " " + price + " " + change;
        if (key === headerKey) {
          return;
        }
        headerKey = key;
        focusText.clear(r.x, r.y, r.w, r.h);
        const pad = Math.round(PAD * scale);
        fill(
          ctx,
          s.ticker,
          r.x + pad,
          r.y + r.h * 0.36,
          TEXT_ROLES.primary,
          "left",
          fonts.bigTicker,
        );
        fill(
          ctx,
          s.name,
          r.x + pad,
          r.y + r.h * 0.76,
          TEXT_ROLES.muted,
          "left",
          fonts.name,
          r.w * 0.4,
        );
        const right = layout.plot.x + layout.plot.w;
        fill(ctx, price, right, r.y + r.h * 0.38, TEXT_ROLES.primary, "right", fonts.bigPrice);
        fill(ctx, change, right, r.y + r.h * 0.8, roleOf(delta), "right", fonts.change);
      };

      const tagY = (m: Market) =>
        clamp(
          valueY(m.stocks[focus].price, mainRange, layout.plot.y, layout.plot.y + layout.plot.h),
          layout.plot.y,
          layout.plot.y + layout.plot.h,
        );

      const paintPriceAxis = (m: Market) => {
        const ctx = focusText.ctx;
        const a = layout.axis;
        const p = layout.plot;
        if (!ctx || a.w <= 0 || !mainRange.ready) {
          return;
        }
        focusText.clear(a.x, a.y, a.w, a.h);
        const x = a.x + Math.round(8 * scale);
        const ty = tagY(m);
        const tagH = TAG_HEIGHT * scale;
        niceTicks(
          mainRange.lo,
          mainRange.hi,
          Math.max(2, Math.floor(p.h / (GRID_GAP * scale))),
          ticks,
        );
        for (let i = 0; i < ticks.count; i++) {
          const v = tickAt(ticks, i);
          const y = valueY(v, mainRange, p.y, p.y + p.h);
          if (y >= p.y && y <= p.y + p.h && Math.abs(y - ty) > tagH * 0.9) {
            fill(ctx, formatFixed(v, ticks.decimals), x, y, TEXT_ROLES.muted, "left", fonts.axis);
          }
        }
        const s = m.stocks[focus];
        fill(
          ctx,
          formatFixed(s.price, priceDecimals(s.price)),
          x,
          ty,
          TEXT_ROLES.inverse,
          "left",
          fonts.axis,
        );
        paintedLo = mainRange.lo;
        paintedHi = mainRange.hi;
        paintedPrice = s.price;
      };

      /** Main chart: candle spacing and how many candles fit. */
      const mainSpacing = () => Math.max(CANDLE_SPACING * scale, layout.plot.w / (HISTORY - 4));
      const mainCount = () => Math.max(4, Math.floor(layout.plot.w / mainSpacing()));

      const paintTimeAxis = (m: Market) => {
        const ctx = focusText.ctx;
        const p = layout.plot;
        if (!ctx || p.w <= 0) {
          return;
        }
        const pad = Math.round(TIME_PAD * scale);
        const h = layout.timeAxis.h;
        focusText.clear(0, timeBandY, p.w + 2 * pad, h);
        const sp = mainSpacing();
        const last = m.candles - 1;
        const first = Math.max(0, last - mainCount() - 2, m.candles - HISTORY + 1);
        for (let k = first; k <= last; k++) {
          if (k % LABEL_EVERY === 0) {
            const x = pad + p.w - (last - k + 0.5) * sp;
            const t = m.stocks[0].time[candleSlot(k)];
            fill(
              ctx,
              clockText(t, false),
              x,
              timeBandY + h / 2,
              TEXT_ROLES.muted,
              "center",
              fonts.axis,
            );
          }
        }
      };

      /** The book's text: ask price and size, then bid price and size per level, then spread and last. */
      const bookText: string[] = Array.from({ length: 4 * BOOK_LEVELS + 2 }, () => "");
      const paintBook = (m: Market) => {
        const ctx = focusText.ctx;
        const r = layout.book;
        if (!ctx || r.w <= 0) {
          return;
        }
        const s = m.stocks[focus];
        const d = priceDecimals(s.price);
        const t = bookText;
        for (let l = 0; l < BOOK_LEVELS; l++) {
          t[4 * l] = formatFixed(book.askPrice[l], d);
          t[4 * l + 1] = formatCompact(book.askSize[l]);
          t[4 * l + 2] = formatFixed(book.bidPrice[l], d);
          t[4 * l + 3] = formatCompact(book.bidSize[l]);
        }
        const n = 4 * BOOK_LEVELS;
        t[n] = "Spread " + formatFixed(book.askPrice[0] - book.bidPrice[0], d);
        t[n + 1] = formatFixed(s.price, d);
        const key = t.join(" ");
        if (key === bookKey) {
          return;
        }
        bookKey = key;
        const pad = Math.round(PAD * scale);
        const h = layout.bookRow;
        const y0 = layout.bookRowsY;
        focusText.clear(r.x, y0, r.w, (2 * BOOK_LEVELS + 1) * h);
        const left = r.x + pad;
        const right = r.x + r.w - pad;
        for (let l = 0; l < BOOK_LEVELS; l++) {
          const ya = y0 + (BOOK_LEVELS - 1 - l) * h + h / 2;
          fill(ctx, t[4 * l], left, ya, TEXT_ROLES.down, "left", fonts.num);
          fill(ctx, t[4 * l + 1], right, ya, TEXT_ROLES.primary, "right", fonts.num);
          const yb = y0 + (BOOK_LEVELS + 1 + l) * h + h / 2;
          fill(ctx, t[4 * l + 2], left, yb, TEXT_ROLES.up, "left", fonts.num);
          fill(ctx, t[4 * l + 3], right, yb, TEXT_ROLES.primary, "right", fonts.num);
        }
        const ys0 = y0 + BOOK_LEVELS * h + h / 2;
        fill(ctx, t[n], left, ys0, TEXT_ROLES.muted, "left", fonts.head);
        fill(ctx, t[n + 1], right, ys0, TEXT_ROLES.primary, "right", fonts.num);
      };

      const paintTrades = (m: Market) => {
        const ctx = focusText.ctx;
        const r = layout.trades;
        if (!ctx || r.w <= 0) {
          return;
        }
        const pad = Math.round(PAD * scale);
        const h = layout.tradeRow;
        const rows = Math.min(TRADE_ROWS - 1, Math.round(layout.tradeRows.h / h) + 1);
        focusText.clear(0, tradesBandY, r.w, rows * h);
        const s = m.stocks[focus];
        const d = priceDecimals(s.price);
        for (let j = 0; j < rows && j < s.trades; j++) {
          const n = tradeSlot(s.trades - 1 - j);
          const y = tradesBandY + j * h + h / 2;
          fill(ctx, clockText(s.tradeTime[n], true), pad, y, TEXT_ROLES.muted, "left", fonts.small);
          const role = s.tradeSide[n] > 0 ? TEXT_ROLES.up : TEXT_ROLES.down;
          fill(
            ctx,
            formatFixed(s.tradePrice[n], d),
            Math.round(r.w * 0.62),
            y,
            role,
            "right",
            fonts.num,
          );
          fill(
            ctx,
            formatCompact(s.tradeSize[n]),
            r.w - pad,
            y,
            TEXT_ROLES.primary,
            "right",
            fonts.num,
          );
        }
      };

      const paintIndex = (m: Market, k: number) => {
        const ctx = focusText.ctx;
        const r = layout.strip;
        if (!ctx || r.w <= 0) {
          return;
        }
        const idx = m.indices[k];
        const delta = idx.value - idx.ref;
        const value = formatFixed(idx.value, 2);
        const change = formatSigned(delta, 2) + "  " + formatPercent(delta / idx.ref);
        const key = value + " " + change;
        if (key === indexKeys[k]) {
          return;
        }
        indexKeys[k] = key;
        const cw = r.w / INDEX_COUNT;
        const x = Math.round(r.x + k * cw);
        const pad = Math.round(PAD * scale) + 4;
        focusText.clear(x, r.y, Math.round(cw), r.h);
        fill(
          ctx,
          idx.name.toUpperCase(),
          x + pad,
          r.y + r.h * 0.3,
          TEXT_ROLES.muted,
          "left",
          fonts.panel,
        );
        fill(ctx, value, x + pad, r.y + r.h * 0.68, TEXT_ROLES.primary, "left", fonts.num);
        fill(
          ctx,
          change,
          x + Math.round(cw) - pad,
          r.y + r.h * 0.68,
          roleOf(delta),
          "right",
          fonts.num,
        );
      };

      /** Repaints the Focus layout's ticking text that changed: live watchlist rows, header, book and indices. */
      const paintFocusTicked = (m: Market) => {
        for (let i = 0; i < fade.live; i++) {
          paintWatchRow(m, i);
        }
        watchRows = fade.live;
        paintChartHeader(m);
        paintBook(m);
        for (let k = 0; k < INDEX_COUNT; k++) {
          paintIndex(m, k);
        }
      };

      const paintFocusAll = (m: Market) => {
        const bandH = layout.tradeRow * TRADE_ROWS + layout.timeAxis.h + Math.round(4 * scale);
        tradesBandY = height;
        timeBandY = height + layout.tradeRow * TRADE_ROWS;
        const w = Math.max(width, layout.plot.w + 2 * Math.round(TIME_PAD * scale));
        if (!focusText.resize(w, height + bandH)) {
          return;
        }
        focusText.clear(0, 0, focusText.width, focusText.height);
        watchKeys.fill("");
        indexKeys.fill("");
        headerKey = "";
        bookKey = "";
        paintTopBar(focusText);
        paintClock(focusText, paintedClock);
        panelTitle(focusText, layout.watch, "WATCHLIST", ["Symbol", "Last", "Chg"]);
        panelTitle(focusText, layout.book, "ORDER BOOK", ["Price", "Size"]);
        panelTitle(focusText, layout.trades, "TRADES", ["Time", "Price", "Size"]);
        paintFocusTicked(m);
        paintPriceAxis(m);
        paintTimeAxis(m);
        paintTrades(m);
      };

      const paintTile = (m: Market, i: number) => {
        const ctx = gridText.ctx;
        if (!ctx) {
          return;
        }
        const s = m.stocks[i];
        const delta = s.price - s.ref;
        const price = formatFixed(s.price, priceDecimals(s.price));
        const change = formatPercent(delta / s.ref);
        const key = price + " " + change;
        if (key === tileKeys[i]) {
          return;
        }
        tileKeys[i] = key;
        const h = Math.round(TILE_HEADER * scale);
        const y = Math.round(TOP_BAR * scale) + i * h;
        gridText.clear(0, y, leftWidth + rightWidth, h);
        fill(
          ctx,
          s.ticker,
          0,
          y + h * 0.32,
          TEXT_ROLES.primary,
          "left",
          fonts.bigTicker,
          leftWidth,
        );
        fill(ctx, s.name, 0, y + h * 0.74, TEXT_ROLES.muted, "left", fonts.name, leftWidth);
        const right = leftWidth + rightWidth;
        fill(
          ctx,
          price,
          right,
          y + h * 0.32,
          TEXT_ROLES.primary,
          "right",
          fonts.bigPrice,
          rightWidth,
        );
        fill(
          ctx,
          change,
          right - Math.round(8 * scale),
          y + h * 0.76,
          roleOf(delta),
          "right",
          fonts.num,
        );
      };

      /** Repaints the live tiles whose text changed. */
      const paintGridTicked = (m: Market) => {
        for (let i = 0; i < fade.live; i++) {
          paintTile(m, i);
        }
        tileRows = fade.live;
      };

      const paintGridAll = (m: Market) => {
        const h = Math.round(TILE_HEADER * scale);
        if (
          !gridText.resize(
            Math.max(width, leftWidth + rightWidth),
            Math.round(TOP_BAR * scale) + MAX_STOCKS * h,
          )
        ) {
          return;
        }
        gridText.clear(0, 0, gridText.width, gridText.height);
        tileKeys.fill("");
        paintTopBar(gridText);
        paintClock(gridText, paintedClock);
        paintGridTicked(m);
      };

      // ---- Market events.

      const startMarket = (seed: number) => {
        const now = new Date();
        const startTime = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        const m = createMarket(seed, startTime);
        warmUp(m, HISTORY - 2, "sideways", 1, 1);
        return m;
      };

      /** Resets everything that follows the focus stock, without easing: the Focus layout's chart, book and trades. */
      const adoptFocus = (m: Market) => {
        shownTrades = m.stocks[focus].trades;
        settleSlide(mainSlide);
        settleSlide(tradeSlide);
        mainRange.ready = false;
        fillBook(m, focus, book);
        for (let l = 0; l < BOOK_LEVELS; l++) {
          bookShown[l] = book.askSize[l];
          bookShown[BOOK_LEVELS + l] = book.bidSize[l];
        }
        bookMax = 0;
        for (const v of bookShown) {
          bookMax = Math.max(bookMax, v);
        }
        volMax = 0;
        focusPainted = false;
      };

      /** Resets everything that follows the market, without easing: both layouts. */
      const adoptMarket = (m: Market) => {
        shownCandles = m.candles;
        adoptFocus(m);
        settleSlide(gridSlide);
        for (const r of tileRanges) {
          r.ready = false;
        }
        for (let k = 0; k < INDEX_COUNT; k++) {
          indexPrev[k] = m.indices[k].value;
        }
        paintedClock = clockText(m.time, true);
        gridPainted = false;
      };

      /** After a tick: tints for changed values, new candles and the rows to redraw. */
      const onTicks = (m: Market) => {
        for (let i = 0; i < MAX_STOCKS; i++) {
          const s = m.stocks[i];
          const d = priceDecimals(s.price);
          if (s.price.toFixed(d) !== s.prev.toFixed(d)) {
            tintAge[i] = 0;
            tintUp[i] = s.price > s.prev ? 1 : 0;
          }
        }
        for (let k = 0; k < INDEX_COUNT; k++) {
          const v = m.indices[k].value;
          if (v.toFixed(2) !== indexPrev[k].toFixed(2)) {
            indexAge[k] = 0;
            indexUp[k] = v > indexPrev[k] ? 1 : 0;
          }
          indexPrev[k] = v;
        }
        if (m.candles !== shownCandles) {
          for (; shownCandles < m.candles; shownCandles++) {
            kickSlide(mainSlide, 1);
            kickSlide(gridSlide, 1);
          }
          // A burst of candles at once never glides more than one step.
          mainSlide.from = Math.min(mainSlide.from, 1);
          mainSlide.offset = Math.min(mainSlide.offset, 1);
          gridSlide.from = Math.min(gridSlide.from, 1);
          gridSlide.offset = Math.min(gridSlide.offset, 1);
          paintTimeAxis(m);
        }
        fillBook(m, focus, book);
        const text = clockText(m.time, true);
        if (text !== paintedClock) {
          paintedClock = text;
          if (focusPainted) {
            paintClock(focusText, text);
          }
          if (gridPainted) {
            paintClock(gridText, text);
          }
        }
        if (focusPainted) {
          paintFocusTicked(m);
        }
        if (gridPainted) {
          paintGridTicked(m);
        }
      };

      /** Shows a newer trade, sliding the list down one row. */
      const showTrade = (m: Market) => {
        shownTrades = m.stocks[focus].trades;
        tradeTimer = 0;
        if (focusPainted) {
          paintTrades(m);
        }
        kickSlide(tradeSlide, 1);
        tradeSlide.from = Math.min(tradeSlide.from, 1);
        tradeSlide.offset = Math.min(tradeSlide.offset, 1);
      };

      // ---- Geometry.

      /** A panel: fill, a hairline border, and a rule under its title strip. */
      const panel = (r: Rect, a: number, titled: boolean) => {
        if (r.w <= 0 || r.h <= 0) {
          return;
        }
        const t = Math.max(1, Math.round(scale));
        pushRect(mesh, r.x, r.y, r.x + r.w, r.y + r.h, C(PANEL), a);
        pushRect(mesh, r.x, r.y, r.x + r.w, r.y + t, C(BORDER), a);
        pushRect(mesh, r.x, r.y + r.h - t, r.x + r.w, r.y + r.h, C(BORDER), a);
        pushRect(mesh, r.x, r.y + t, r.x + t, r.y + r.h - t, C(BORDER), a);
        pushRect(mesh, r.x + r.w - t, r.y + t, r.x + r.w, r.y + r.h - t, C(BORDER), a);
        if (titled) {
          const y = r.y + bodyTop();
          pushRect(mesh, r.x + t, r.y + t, r.x + r.w - t, y, C(HEAD), a);
          pushRect(mesh, r.x + t, y, r.x + r.w - t, y + t, C(BORDER), a);
        }
      };

      const topBar = (a: number) => {
        const h = Math.round(TOP_BAR * scale);
        pushRect(mesh, 0, 0, width, h, C(HEAD), a);
        pushRect(mesh, 0, h - Math.max(1, Math.round(scale)), width, h, C(BORDER), a);
        // The live dot: steady, never blinking.
        const r = 4 * scale;
        const x = width - (CLOCK_INSET + LIVE_GAP + LIVE_DOT_GAP) * scale;
        pushArc(mesh, x, h / 2, 0, r, 0, 2 * Math.PI, C(UP), a);
      };

      const clip: LineClip = { from: 0, count: 0 };

      /** Lowest low and highest high of a stock's last `n` candles. */
      let dataLo = 0;
      let dataHi = 0;
      const dataRange = (m: Market, s: Stock, n: number) => {
        dataLo = Infinity;
        dataHi = -Infinity;
        const last = m.candles - 1;
        for (let k = Math.max(0, last - n + 1, m.candles - HISTORY + 1); k <= last; k++) {
          const c = candleSlot(k);
          dataLo = Math.min(dataLo, s.low[c]);
          dataHi = Math.max(dataHi, s.high[c]);
        }
      };

      /**
       * A stock's price series in a plot (candles, line or area by the eased chart
       * type), `n` candles across at `sp` px spacing, shifted right by `off` px.
       * Candles fade at the plot's sides as they step in and out.
       */
      const series = (
        m: Market,
        s: Stock,
        left: number,
        top: number,
        w: number,
        h: number,
        r: AxisRange,
        sp: number,
        n: number,
        off: number,
        a: number,
      ) => {
        if (w <= 0 || h <= 0 || !r.ready) {
          return;
        }
        const right = left + w;
        const bottom = top + h;
        const last = m.candles - 1;
        const first = Math.max(0, last - n - 1, m.candles - HISTORY + 1);
        const wc = typeWeight[0] * a;
        const wl = Math.max(typeWeight[1], typeWeight[2]) * a;
        const wa = typeWeight[2] * a;
        const wick = Math.max(1, Math.round(scale));
        let np = 0;
        for (let k = first; k <= last; k++) {
          const c = candleSlot(k);
          const x = right - (last - k + 0.5) * sp + off;
          const y = clamp(valueY(s.close[c], r, top, bottom), top, bottom);
          if (wc > 0) {
            const edge = clamp(Math.min(x - left, right - x) / (0.5 * sp), 0, 1);
            if (edge > 0) {
              pushCandle(
                mesh,
                x,
                sp * BODY,
                wick,
                clamp(valueY(s.open[c], r, top, bottom), top, bottom),
                y,
                clamp(valueY(s.high[c], r, top, bottom), top, bottom),
                clamp(valueY(s.low[c], r, top, bottom), top, bottom),
                s.close[c] >= s.open[c] ? C(UP) : C(DOWN),
                wc * edge,
              );
            }
          }
          xs[np] = x;
          ys[np] = y;
          np++;
        }
        if (wl > 0 && np >= 2) {
          clipLine(xs, ys, np, left, right, clip);
          if (clip.count >= 2) {
            pushArea(mesh, xs, ys, clip.from, clip.count, bottom, C(ACCENT), 0.3 * wa, 0.02 * wa);
            pushPolyline(mesh, xs, ys, clip.from, clip.count, LINE_WIDTH * scale, C(ACCENT), wl);
          }
        }
      };

      /** Horizontal gridlines at nice values across a plot. */
      const gridlines = (
        r: AxisRange,
        x: number,
        y: number,
        w: number,
        h: number,
        steps: number,
        a: number,
      ) => {
        if (!r.ready || h <= 0) {
          return;
        }
        niceTicks(r.lo, r.hi, steps, ticks);
        pushGridlines(mesh, ticks, r, x, y, w, h, C(GRID), a);
      };

      const drawFocus = (m: Market, la: number, ca: number, fa: number) => {
        pushRect(mesh, 0, 0, width, height, C(BG), la);
        topBar(ca);
        const L = layout;
        panel(L.watch, ca, true);
        panel(L.chart, ca, false);
        panel(L.book, ca, true);
        panel(L.trades, ca, true);
        panel(L.strip, ca, false);

        // Watchlist rows.
        const wr = L.watch;
        if (wr.w > 0) {
          const c = watchCols(wr);
          const h = L.watchRow;
          const t = Math.max(1, Math.round(scale));
          for (let i = 0; i < fade.live; i++) {
            const a = ca * fade.life[i];
            if (a <= 0) {
              continue;
            }
            const y = L.watchRowsY + i * h;
            const s = m.stocks[i];
            pushRect(mesh, wr.x + t, y, wr.x + wr.w - t, y + h, C(HILITE), a * highlight[i]);
            pushRect(
              mesh,
              wr.x + t,
              y,
              wr.x + t + Math.round(3 * scale),
              y + h,
              C(ACCENT),
              a * highlight[i],
            );
            pushRect(mesh, wr.x + c.pad, y + h - t, wr.x + wr.w - c.pad, y + h, C(BORDER), a * 0.6);
            const tint = tintAlpha(tintAge[i]);
            if (tint > 0) {
              pushRect(
                mesh,
                c.lastX - Math.round(wr.w * 0.2),
                y + 2 * t,
                c.chgX + Math.round(c.pad * 0.5),
                y + h - 2 * t,
                tintUp[i] === 1 ? C(UP) : C(DOWN),
                a * tint,
              );
            }
            // The sparkline: recent candle closes, scaled to their own range.
            const last = m.candles - 1;
            const n = Math.min(SPARK_CANDLES, m.candles);
            let lo = Infinity;
            let hi = -Infinity;
            for (let k = last - n + 1; k <= last; k++) {
              const v = s.close[candleSlot(k)];
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
            const span = Math.max(hi - lo, s.price * 0.002);
            const mid = (hi + lo) / 2;
            const sy = y + h / 2;
            const sh = h * 0.56;
            for (let j = 0; j < n; j++) {
              const v = s.close[candleSlot(last - n + 1 + j)];
              xs[j] = c.sparkX + (c.sparkW * j) / Math.max(1, n - 1);
              ys[j] = sy - ((v - mid) / span) * sh;
            }
            pushPolyline(
              mesh,
              xs,
              ys,
              0,
              n,
              SPARK_WIDTH * scale,
              s.price >= s.ref ? C(UP) : C(DOWN),
              a,
            );
          }
        }

        // The main chart.
        const p = L.plot;
        if (p.w > 0 && p.h > 0) {
          const s = m.stocks[focus];
          const sp = mainSpacing();
          const off = mainSlide.offset * sp;
          gridlines(
            mainRange,
            p.x,
            p.y,
            p.w,
            p.h,
            Math.max(2, Math.floor(p.h / (GRID_GAP * scale))),
            fa,
          );
          // Time gridlines at the labelled candles, moving with them.
          const last = m.candles - 1;
          const n = mainCount();
          const first = Math.max(0, last - n - 1, m.candles - HISTORY + 1);
          const v = L.volume;
          for (let k = first; k <= last; k++) {
            if (k % LABEL_EVERY === 0) {
              const x = Math.round(p.x + p.w - (last - k + 0.5) * sp + off);
              const edge = clamp(Math.min(x - p.x, p.x + p.w - x) / (0.5 * sp), 0, 1);
              pushRect(mesh, x, p.y, x + 1, v.y + v.h, C(GRID), fa * edge);
            }
          }
          // Volume bars.
          if (v.h > 0 && volMax > 0) {
            for (let k = first; k <= last; k++) {
              const c = candleSlot(k);
              const x = p.x + p.w - (last - k + 0.5) * sp + off;
              const edge = clamp(Math.min(x - p.x, p.x + p.w - x) / (0.5 * sp), 0, 1);
              const bh = Math.min(1, s.volume[c] / volMax) * v.h;
              const bw = Math.max(1, Math.round(sp * BODY));
              const bx = Math.round(x - bw / 2);
              pushRect(
                mesh,
                bx,
                v.y + v.h - bh,
                bx + bw,
                v.y + v.h,
                s.close[c] >= s.open[c] ? C(UP) : C(DOWN),
                fa * edge * 0.45,
              );
            }
          }
          series(m, s, p.x, p.y, p.w, p.h, mainRange, sp, n, off, fa);
          // The last price: a faint line across the plot, then the dim, then the tag.
          const ty = Math.round(tagY(m));
          const tagColor = s.price >= s.open[candleSlot(last)] ? C(UP) : C(DOWN);
          pushRect(mesh, p.x, ty, p.x + p.w, ty + 1, tagColor, fa * 0.5);
          pushRect(mesh, p.x, p.y, p.x + p.w, v.y + v.h, C(PANEL), ca * dimLevel);
          const a = L.axis;
          const th = Math.round(TAG_HEIGHT * scale);
          pushRect(
            mesh,
            a.x + 2,
            ty - th / 2,
            a.x + a.w - Math.round(PAD * scale * 0.5),
            ty + th / 2,
            tagColor,
            fa,
          );
        }

        // Order book depth bars, behind the numbers.
        const br = L.book;
        if (br.w > 0) {
          const h = L.bookRow;
          const t = Math.max(1, Math.round(scale));
          const inner = br.w - 2 * t;
          for (let l = 0; l < BOOK_LEVELS; l++) {
            const ya = L.bookRowsY + (BOOK_LEVELS - 1 - l) * h;
            const wa = (inner * bookShown[l]) / Math.max(1, bookMax);
            pushRect(
              mesh,
              br.x + br.w - t - wa,
              ya + t,
              br.x + br.w - t,
              ya + h - t,
              C(DOWN),
              fa * 0.16,
            );
            const yb = L.bookRowsY + (BOOK_LEVELS + 1 + l) * h;
            const wb = (inner * bookShown[BOOK_LEVELS + l]) / Math.max(1, bookMax);
            pushRect(
              mesh,
              br.x + br.w - t - wb,
              yb + t,
              br.x + br.w - t,
              yb + h - t,
              C(UP),
              fa * 0.16,
            );
          }
          const ys0 = L.bookRowsY + BOOK_LEVELS * h;
          pushRect(mesh, br.x + t, ys0, br.x + br.w - t, ys0 + h, C(HEAD), ca);
        }

        // Index strip: separators and change tints.
        const sr = L.strip;
        if (sr.w > 0) {
          const cw = sr.w / INDEX_COUNT;
          const pad = Math.round(PAD * scale);
          for (let k = 0; k < INDEX_COUNT; k++) {
            const x = Math.round(sr.x + k * cw);
            if (k > 0) {
              pushRect(mesh, x, sr.y + pad, x + 1, sr.y + sr.h - pad, C(BORDER), ca);
            }
            const tint = tintAlpha(indexAge[k]);
            if (tint > 0) {
              pushRect(
                mesh,
                x + pad,
                sr.y + sr.h * 0.48,
                x + Math.round(cw) - pad,
                sr.y + sr.h * 0.88,
                indexUp[k] === 1 ? C(UP) : C(DOWN),
                ca * tint,
              );
            }
          }
        }
      };

      /** Queues the Focus layout's text regions. */
      const focusQuads = (la: number, fa: number) => {
        const L = layout;
        const q = focusText;
        const top = Math.round(TOP_BAR * scale);
        q.quad(0, 0, width, top, 0, 0, width, top, la);
        const w = L.watch;
        if (w.w > 0) {
          const hh = L.watchRowsY - w.y;
          q.quad(w.x, w.y, w.w, hh, w.x, w.y, w.w, hh, la);
          for (let i = 0; i < fade.live; i++) {
            const y = L.watchRowsY + i * L.watchRow;
            q.quad(w.x, y, w.w, L.watchRow, w.x, y, w.w, L.watchRow, la * fade.life[i]);
          }
        }
        const ch = L.chartHeader;
        q.quad(ch.x, ch.y, ch.w, ch.h, ch.x, ch.y, ch.w, ch.h, fa);
        const a = L.axis;
        q.quad(a.x, a.y, a.w, a.h, a.x, a.y, a.w, a.h, fa);
        // Time labels: the band, offset with the candles, cropped to the chart.
        const p = L.plot;
        const ta = L.timeAxis;
        if (p.w > 0) {
          const pad = Math.round(TIME_PAD * scale);
          const off = Math.round(mainSlide.offset * mainSpacing());
          const clipL = L.chart.x + 2;
          const clipR = p.x + p.w + Math.round(pad * 0.5);
          const dx = p.x - pad + off;
          const x0 = Math.max(dx, clipL);
          const x1 = Math.min(dx + p.w + 2 * pad, clipR);
          if (x1 > x0) {
            q.quad(x0 - dx, timeBandY, x1 - x0, ta.h, x0, ta.y, x1 - x0, ta.h, fa);
          }
        }
        const b = L.book;
        if (b.w > 0) {
          const hh = L.bookRowsY - b.y;
          q.quad(b.x, b.y, b.w, hh, b.x, b.y, b.w, hh, la);
          const rh = (2 * BOOK_LEVELS + 1) * L.bookRow;
          q.quad(b.x, L.bookRowsY, b.w, rh, b.x, L.bookRowsY, b.w, rh, fa);
        }
        const t = L.trades;
        const tr = L.tradeRows;
        if (t.w > 0) {
          const hh = tr.y - t.y;
          q.quad(t.x, t.y, t.w, hh, t.x, t.y, t.w, hh, la);
          // The rows: the band, showing from one row down while a new row slides in.
          const off = Math.round(tradeSlide.offset * L.tradeRow);
          q.quad(0, tradesBandY + off, tr.w, tr.h, tr.x, tr.y, tr.w, tr.h, fa);
        }
        const s = L.strip;
        q.quad(s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h, la);
      };

      const tileRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
      const drawGrid = (m: Market, la: number, ca: number) => {
        pushRect(mesh, 0, 0, width, height, C(BG), la);
        topBar(ca);
        const pad = Math.round(PAD * scale);
        const headH = Math.round(TILE_HEADER * scale);
        for (let i = 0; i < fade.live; i++) {
          const a = ca * fade.life[i];
          if (a <= 0) {
            continue;
          }
          const o = 4 * i;
          const x = Math.round(tileNow[o]);
          const y = Math.round(tileNow[o + 1]);
          const w = Math.round(tileNow[o + 2]);
          const h = Math.round(tileNow[o + 3]);
          tileRect.x = x;
          tileRect.y = y;
          tileRect.w = w;
          tileRect.h = h;
          panel(tileRect, a, false);
          const s = m.stocks[i];
          const delta = s.price - s.ref;
          const t = Math.max(1, Math.round(scale));
          pushRect(mesh, x + pad, y + pad + headH, x + w - pad, y + pad + headH + t, C(BORDER), a);
          // The change chip, and a tint behind the price when it changes.
          const right = x + w - pad;
          const chipTop = y + pad + Math.round(headH * 0.56);
          pushRect(
            mesh,
            right - Math.round(CHIP_WIDTH * scale),
            chipTop,
            right,
            chipTop + Math.round(headH * 0.38),
            delta < 0 ? C(DOWN) : C(UP),
            a * 0.16,
          );
          const tint = tintAlpha(tintAge[i]);
          if (tint > 0) {
            pushRect(
              mesh,
              right - rightWidth,
              y + pad + 2 * t,
              right,
              y + pad + Math.round(headH * 0.52),
              tintUp[i] === 1 ? C(UP) : C(DOWN),
              a * tint,
            );
          }
          // The chart.
          const cx = x + pad;
          const cy = y + 2 * pad + headH;
          const cw = w - 2 * pad;
          const chh = h - 3 * pad - headH;
          if (cw > 0 && chh > 0) {
            const sp = cw / TILE_CANDLES;
            gridlines(tileRanges[i], cx, cy, cw, chh, 3, a);
            series(
              m,
              s,
              cx,
              cy,
              cw,
              chh,
              tileRanges[i],
              sp,
              TILE_CANDLES,
              gridSlide.offset * sp,
              a,
            );
            const ty = Math.round(
              clamp(valueY(s.price, tileRanges[i], cy, cy + chh), cy, cy + chh),
            );
            pushRect(mesh, cx, ty, cx + cw, ty + 1, delta < 0 ? C(DOWN) : C(UP), a * 0.4);
            pushRect(mesh, cx, cy, cx + cw, cy + chh, C(PANEL), a * dimLevel * middleDim[i]);
          }
        }
      };
      const gridQuads = (la: number) => {
        const q = gridText;
        const top = Math.round(TOP_BAR * scale);
        q.quad(0, 0, width, top, 0, 0, width, top, la);
        const pad = Math.round(PAD * scale);
        const h = Math.round(TILE_HEADER * scale);
        for (let i = 0; i < fade.live; i++) {
          const a = la * fade.life[i];
          const o = 4 * i;
          const x = Math.round(tileNow[o]) + pad;
          const y = Math.round(tileNow[o + 1]) + pad;
          const right = Math.round(tileNow[o]) + Math.round(tileNow[o + 2]) - pad;
          const sy = top + i * h;
          q.quad(0, sy, leftWidth, h, x, y, leftWidth, h, a);
          q.quad(leftWidth, sy, rightWidth, h, right - rightWidth, y, rightWidth, h, a);
        }
      };

      /** Re-tiles the grid for `count` tiles, moving tiles that stay and placing new ones. */
      const retile = (count: number, animate: boolean) => {
        const was = tileCount;
        tileMiddle = gridTiles(count, width, height, scale, tileTo);
        let far = 0;
        for (let i = 0; i < MAX_STOCKS; i++) {
          const o = 4 * i;
          if (i >= count) {
            // Leaving (or never shown): stay put while fading out.
            for (let k = 0; k < 4; k++) {
              tileTo[o + k] = tileNow[o + k];
            }
          } else if (!animate || i >= was || i >= fade.live) {
            for (let k = 0; k < 4; k++) {
              tileNow[o + k] = tileTo[o + k];
            }
          }
          for (let k = 0; k < 4; k++) {
            tileFrom[o + k] = tileNow[o + k];
            far = Math.max(far, Math.abs(tileTo[o + k] - tileNow[o + k]));
          }
        }
        tileCount = count;
        tileSeconds = Math.max(RETILE_MIN, minTweenSeconds(far / scale));
        tileT = animate && far > 0 ? 0 : 1;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          fonts = makeFonts(scale);
          focusLayout(width, height, scale, layout);
          [leftWidth, rightWidth] = tileTextWidths(width, height, scale);
          if (tileCount > 0) {
            retile(tileCount, false);
          }
          focusPainted = false;
          gridPainted = false;
          if (market) {
            mainRange.ready = false;
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const count = clamp(Math.round(p.count), MIN_COUNT, MAX_COUNT);
          const mood = asMood(p.mood);
          const pace = clamp(p.pace, MIN_PACE, MAX_PACE);
          const wantGrid = p.layout === "grid";

          if (!started || !market) {
            // Allocates: the first frame builds the market and the layouts.
            started = true;
            market = startMarket(p.seed);
            fade.snap(count);
            focusWeight = wantGrid ? 0 : 1;
            typeWeight[0] = p.chart === "candles" ? 1 : 0;
            typeWeight[1] = p.chart === "line" ? 1 : 0;
            typeWeight[2] = p.chart === "area" ? 1 : 0;
            dimLevel = clamp(p.dim, 0, 0.6);
            highlight[focus] = 1;
            retile(count, false);
            adoptMarket(market);
            ease.snap();
          }

          // A new variation fades the screen out, swaps the market, and fades back in.
          if (swap.idle && market.seed !== p.seed) {
            swap.start();
          }
          if (swap.step(step)) {
            // Allocates: a new market, once per variation change.
            market = startMarket(p.seed);
            focus = Math.min(focus, count - 1);
            focusFade.cancel();
            adoptMarket(market);
          }
          const m = market;

          // The market ticks every `pace` seconds.
          const n = takeSteps(clock, 1 / pace, step, MAX_TICKS_PER_FRAME);
          if (n > 0) {
            stepMarket(m, n, mood, p.volatility, pace);
            onTicks(m);
          }

          // Focus stock: rotates on a timer, or moves when the count drops below it.
          const period = p.rotate === "2" ? 120 : p.rotate === "5" ? 300 : 0;
          rotateTimer = period > 0 ? rotateTimer + step : 0;
          if (focusFade.idle && swap.idle) {
            if (focus >= count) {
              nextFocus = 0;
              focusFade.start();
            } else if (period > 0 && rotateTimer >= period) {
              rotateTimer = 0;
              nextFocus = (focus + 1) % count;
              if (nextFocus !== focus) {
                focusFade.start();
              }
            }
          }
          if (focusFade.step(step)) {
            focus = nextFocus;
            adoptFocus(m);
          }
          const chartAlpha = focusFade.alpha;
          const swapAlpha = swap.alpha;

          // Eased state: layout, counts, chart type, highlight, dim, tints, colours.
          focusWeight = approach(focusWeight, wantGrid ? 0 : 1, step / LAYOUT_FADE);
          fade.step(count, step, COUNT_FADE, COUNT_FADE);
          typeWeight[0] = approach(typeWeight[0], p.chart === "candles" ? 1 : 0, step / TYPE_EASE);
          typeWeight[1] = approach(typeWeight[1], p.chart === "line" ? 1 : 0, step / TYPE_EASE);
          typeWeight[2] = approach(typeWeight[2], p.chart === "area" ? 1 : 0, step / TYPE_EASE);
          dimLevel = approach(dimLevel, clamp(p.dim, 0, 0.6), step / COLOR_EASE);
          for (let i = 0; i < MAX_STOCKS; i++) {
            highlight[i] = approach(highlight[i], i === focus ? 1 : 0, step / HIGHLIGHT_EASE);
            middleDim[i] = approach(middleDim[i], i === tileMiddle ? 1 : 0, step / COLOR_EASE);
            tintAge[i] += step;
          }
          for (let k = 0; k < INDEX_COUNT; k++) {
            indexAge[k] += step;
          }
          const theme = THEME_RGB[p.theme] ?? THEME_RGB.terminal;
          target.set(theme);
          if (p.colors === "red-up") {
            for (let k = 0; k < 3; k++) {
              target[UP * 3 + k] = theme[DOWN * 3 + k];
              target[DOWN * 3 + k] = theme[UP * 3 + k];
            }
          }
          ease.step(target, step, COLOR_EASE);
          setTextPalette(textPalette, col[TEXT], col[MUTED], col[UP], col[DOWN], col[BG]);

          // Slides: candle steps, and a new trade row at most once a second.
          stepSlide(mainSlide, step);
          stepSlide(gridSlide, step);
          stepSlide(tradeSlide, step);
          tradeTimer += step;
          if (
            m.stocks[focus].trades !== shownTrades &&
            tradeTimer >= TRADE_GAP &&
            tradeSlide.t >= 1
          ) {
            showTrade(m);
          }

          // Grid tiles re-tile for a new count, moving no faster than the codec limits.
          if (count !== tileCount) {
            retile(count, focusWeight < 1);
          }
          if (tileT < 1) {
            tileT = Math.min(1, tileT + step / tileSeconds);
            const f = smoothstep(0, 1, tileT);
            for (let k = 0; k < 4 * MAX_STOCKS; k++) {
              tileNow[k] = tileFrom[k] + (tileTo[k] - tileFrom[k]) * f;
            }
          }

          const needFocus = focusWeight > 0 || !wantGrid;
          const needGrid = focusWeight < 1 || wantGrid;

          // Main chart: axis range, volume scale and book depth.
          if (needFocus && layout.plot.w > 0) {
            const s = m.stocks[focus];
            dataRange(m, s, mainCount());
            range.minSpan = s.price * MIN_SPAN_SHARE;
            autoRange(mainRange, dataLo, dataHi, layout.plot.h, scale, range);
            stepAxis(mainRange, step);
            let vm = 0;
            const last = m.candles - 1;
            for (let k = Math.max(0, last - mainCount()); k <= last; k++) {
              vm = Math.max(vm, s.volume[candleSlot(k)]);
            }
            volMax = volMax > 0 ? volMax + (vm - volMax) * Math.min(1, step / 0.6) : vm;
            let bm = 0;
            for (let l = 0; l < BOOK_LEVELS; l++) {
              bookShown[l] += (book.askSize[l] - bookShown[l]) * Math.min(1, step / 0.4);
              bookShown[BOOK_LEVELS + l] +=
                (book.bidSize[l] - bookShown[BOOK_LEVELS + l]) * Math.min(1, step / 0.4);
              bm = Math.max(bm, book.askSize[l], book.bidSize[l]);
            }
            bookMax += (bm - bookMax) * Math.min(1, step / 0.6);
          }
          if (needGrid) {
            for (let i = 0; i < fade.live; i++) {
              const s = m.stocks[i];
              dataRange(m, s, TILE_CANDLES);
              range.minSpan = s.price * MIN_SPAN_SHARE;
              const chh = tileNow[4 * i + 3] - 3 * PAD * scale - TILE_HEADER * scale;
              autoRange(tileRanges[i], dataLo, dataHi, Math.max(1, chh), scale, range);
              stepAxis(tileRanges[i], step);
            }
            // Tiles faded out stop following their stock: snap when they come back.
            for (let i = fade.live; i < MAX_STOCKS; i++) {
              tileRanges[i].ready = false;
            }
          }

          // Text canvases: painted whole when first needed, freed when hidden. A
          // hidden layout's axes stop following the market, so they snap on return.
          if (needFocus && !focusPainted) {
            paintFocusAll(m);
            focusPainted = true;
          } else if (!needFocus && (focusPainted || focusText.width > 0)) {
            focusText.release();
            focusPainted = false;
            mainRange.ready = false;
          }
          if (needGrid && !gridPainted) {
            paintGridAll(m);
            gridPainted = true;
          } else if (!needGrid && (gridPainted || gridText.width > 0)) {
            gridText.release();
            gridPainted = false;
            for (const r of tileRanges) {
              r.ready = false;
            }
          }
          // Rows and tiles coming back into the live range catch up with the market.
          if (focusPainted) {
            for (let i = watchRows; i < fade.live; i++) {
              paintWatchRow(m, i);
            }
          }
          watchRows = fade.live;
          if (gridPainted) {
            for (let i = tileRows; i < fade.live; i++) {
              paintTile(m, i);
            }
          }
          tileRows = fade.live;
          if (focusPainted) {
            const moved =
              rangeShiftPx(paintedLo, paintedHi, mainRange.lo, mainRange.hi, layout.plot.h) >= 0.5;
            if (moved || paintedPrice !== m.stocks[focus].price) {
              paintPriceAxis(m);
            }
            focusText.flush();
          }
          if (gridPainted) {
            gridText.flush();
          }

          // Geometry: the layout being left underneath, the one arriving on top.
          mesh.count = 0;
          const f = smoothstep(0, 1, focusWeight);
          const focusOnTop = !wantGrid;
          const focusLa = focusOnTop ? f : 1;
          const gridLa = focusOnTop ? 1 : 1 - f;
          const ca = swapAlpha;
          let focusFirst = 0;
          let focusEnd = 0;
          let gridFirst = 0;
          let gridEnd = 0;
          for (let pass = 0; pass < 2; pass++) {
            const isFocus = (pass === 1) === focusOnTop;
            if (isFocus && needFocus && focusLa > 0) {
              focusFirst = mesh.count;
              drawFocus(m, focusLa, focusLa * ca, focusLa * ca * chartAlpha);
              focusEnd = mesh.count;
            } else if (!isFocus && needGrid && gridLa > 0) {
              gridFirst = mesh.count;
              drawGrid(m, gridLa, gridLa * ca);
              gridEnd = mesh.count;
            }
          }
          chart.upload();

          gl.clearColor(col[BG][0], col[BG][1], col[BG][2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          for (let pass = 0; pass < 2; pass++) {
            const isFocus = (pass === 1) === focusOnTop;
            if (isFocus && focusEnd > focusFirst) {
              chart.draw(width, height, focusFirst, focusEnd - focusFirst);
              if (focusPainted) {
                focusQuads(focusLa * ca, focusLa * ca * chartAlpha);
                focusText.draw(width, height, textPalette);
              }
            } else if (!isFocus && gridEnd > gridFirst) {
              chart.draw(width, height, gridFirst, gridEnd - gridFirst);
              if (gridPainted) {
                gridQuads(gridLa * ca);
                gridText.draw(width, height, textPalette);
              }
            }
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
