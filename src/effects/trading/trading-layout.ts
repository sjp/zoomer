/**
 * Panel rects for the Trading Dashboard's two layouts, in whole device pixels
 * (y down), for any canvas size:
 *
 * - Focus: a top bar; the watchlist on the left; the main chart (header, price
 *   plot, volume pane, price axis and time axis) in the middle; the order book
 *   above the recent trades on the right; and the index strip along the bottom.
 *   Narrow frames drop the right column, then the watchlist.
 * - Grid: a top bar over `count` equal tiles, the grid's shape chosen to keep
 *   the tiles near a landscape card's proportions.
 *
 * Sizes are set at 1080p and scaled. Pure layout maths: no GL, no canvas.
 */
import { clamp } from "../math";
import { BOOK_LEVELS, MAX_STOCKS, TRADE_ROWS } from "./trading-sim";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const rect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });

/** Reference sizes (px at 1080p). */
const MARGIN = 14;
const GAP = 10;
export const TOP_BAR = 40;
const STRIP = 64;
/** A panel's title strip, and the column headings under it. */
export const PANEL_TITLE = 30;
export const COLUMN_HEADS = 22;
const CHART_HEADER = 58;
const PRICE_AXIS = 78;
const TIME_AXIS = 24;
const VOLUME_SHARE = 0.2;
const VOLUME_GAP = 6;
/** Padding inside panels. */
export const PAD = 12;
const MAX_WATCH_ROW = 66;
/** Narrowest frames (reference px across) that keep the right column, and the watchlist. */
const KEEP_RIGHT = 1250;
const KEEP_WATCH = 800;
/** Grid: the tile proportions aimed for, and the cost of each empty cell. */
const TILE_ASPECT = 1.5;
const EMPTY_CELL_COST = 0.3;
/** Grid tile header: the text strip at the top of each tile. */
export const TILE_HEADER = 56;
const TILE_LEFT = 300;
const TILE_RIGHT = 190;

interface FocusLayout {
  top: Rect;
  watch: Rect;
  /** The watchlist's first row's top and the row height (`MAX_STOCKS` rows fit). */
  watchRowsY: number;
  watchRow: number;
  chart: Rect;
  /** Inside the chart panel: the title strip, price plot, volume pane, price axis and time axis. */
  chartHeader: Rect;
  plot: Rect;
  volume: Rect;
  axis: Rect;
  timeAxis: Rect;
  book: Rect;
  /** The book's first row's top and row height (`2 * BOOK_LEVELS + 1` rows: asks, spread, bids). */
  bookRowsY: number;
  bookRow: number;
  trades: Rect;
  /** The trades list's rows area and row height. */
  tradeRows: Rect;
  tradeRow: number;
  strip: Rect;
}

export function createFocusLayout(): FocusLayout {
  return {
    top: rect(),
    watch: rect(),
    watchRowsY: 0,
    watchRow: 0,
    chart: rect(),
    chartHeader: rect(),
    plot: rect(),
    volume: rect(),
    axis: rect(),
    timeAxis: rect(),
    book: rect(),
    bookRowsY: 0,
    bookRow: 0,
    trades: rect(),
    tradeRows: rect(),
    tradeRow: 0,
    strip: rect(),
  };
}

function set(r: Rect, x: number, y: number, w: number, h: number): void {
  r.x = Math.round(x);
  r.y = Math.round(y);
  r.w = Math.max(0, Math.round(x + w) - r.x);
  r.h = Math.max(0, Math.round(y + h) - r.y);
}

/** Fills `out` with the Focus layout for a `width` x `height` frame at `scale` (px per reference px). */
export function focusLayout(width: number, height: number, scale: number, out: FocusLayout): void {
  const s = scale > 0 ? scale : height / 1080;
  const refWidth = width / s;
  const m = MARGIN * s;
  const g = GAP * s;
  set(out.top, 0, 0, width, TOP_BAR * s);
  const bodyTop = TOP_BAR * s + g * 0.5;
  const stripH = STRIP * s;
  set(out.strip, m, height - m - stripH, width - 2 * m, stripH);
  const bodyBottom = out.strip.y - g;
  const bodyH = Math.max(0, bodyBottom - bodyTop);

  const keepRight = refWidth >= KEEP_RIGHT;
  const keepWatch = refWidth >= KEEP_WATCH;
  const watchW = keepWatch ? Math.min(420, Math.max(300, 0.21 * refWidth)) * s : 0;
  const rightW = keepRight ? Math.min(380, Math.max(260, 0.19 * refWidth)) * s : 0;
  set(out.watch, m, bodyTop, watchW, bodyH);
  const chartX = m + (keepWatch ? watchW + g : 0);
  const chartW = width - m - (keepRight ? rightW + g : 0) - chartX;
  set(out.chart, chartX, bodyTop, chartW, bodyH);
  const rightX = width - m - rightW;
  const bookH = keepRight ? (bodyH - g) * 0.56 : 0;
  set(out.book, rightX, bodyTop, rightW, bookH);
  set(out.trades, rightX, bodyTop + bookH + g, rightW, keepRight ? bodyH - bookH - g : 0);

  // Watchlist rows under the title and column heads, sized for the most stocks.
  const w = out.watch;
  out.watchRowsY = w.y + Math.round((PANEL_TITLE + COLUMN_HEADS) * s);
  out.watchRow = Math.max(
    1,
    Math.floor(Math.min(MAX_WATCH_ROW * s, (w.y + w.h - out.watchRowsY - PAD * s) / MAX_STOCKS)),
  );

  // The chart panel.
  const c = out.chart;
  const pad = PAD * s;
  set(out.chartHeader, c.x, c.y, c.w, CHART_HEADER * s);
  const plotX = c.x + pad;
  const plotTop = c.y + CHART_HEADER * s;
  const plotW = Math.max(0, c.w - 2 * pad - PRICE_AXIS * s);
  const paneBottom = c.y + c.h - TIME_AXIS * s;
  const paneH = Math.max(0, paneBottom - plotTop);
  const volH = paneH * VOLUME_SHARE;
  set(out.plot, plotX, plotTop, plotW, Math.max(0, paneH - volH - VOLUME_GAP * s));
  set(out.volume, plotX, paneBottom - volH, plotW, volH);
  set(out.axis, plotX + plotW, plotTop - 10 * s, c.x + c.w - (plotX + plotW), paneH + 10 * s);
  set(out.timeAxis, plotX, paneBottom, plotW, TIME_AXIS * s);

  // The order book: title, column heads, then asks, the spread row and bids.
  const b = out.book;
  out.bookRowsY = b.y + Math.round((PANEL_TITLE + COLUMN_HEADS) * s);
  out.bookRow = Math.max(
    1,
    Math.floor((b.y + b.h - out.bookRowsY - pad * 0.5) / (2 * BOOK_LEVELS + 1)),
  );

  // Recent trades: as many whole rows as fit, the same height as the book's.
  const t = out.trades;
  out.tradeRow = out.bookRow;
  const rowsTop = t.y + Math.round((PANEL_TITLE + COLUMN_HEADS) * s);
  // Two rows of the trade history spare: one sliding in, one sliding out.
  const rows = clamp(
    Math.floor((t.y + t.h - rowsTop - pad * 0.5) / out.tradeRow),
    0,
    TRADE_ROWS - 2,
  );
  set(out.tradeRows, t.x, rowsTop, t.w, rows * out.tradeRow);
}

/** Columns and rows of the grid for `count` tiles in a `width` x `height` area. */
export function gridShape(count: number, width: number, height: number): [number, number] {
  const n = Math.max(1, Math.floor(count));
  let best: [number, number] = [n, 1];
  let bestScore = Infinity;
  for (let rows = 1; rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    if ((rows - 1) * cols >= n) {
      continue;
    }
    const aspect = width / cols / (height / rows);
    const score = Math.abs(Math.log(aspect / TILE_ASPECT)) + EMPTY_CELL_COST * (cols * rows - n);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = [cols, rows];
    }
  }
  return best;
}

/** The area the grid's tiles share, below the top bar. */
export function gridArea(width: number, height: number, scale: number, out: Rect): Rect {
  const s = scale > 0 ? scale : height / 1080;
  const m = MARGIN * s;
  const top = TOP_BAR * s + GAP * s * 0.5;
  set(out, m, top, width - 2 * m, height - m - top);
  return out;
}

/**
 * Writes the rects of tiles `0 .. count - 1` (x, y, w, h each) into `out`, row by
 * row, the last row centred if it is short. Returns the index of the tile in the
 * middle of the grid, or -1 when no tile sits there.
 */
export function gridTiles(
  count: number,
  width: number,
  height: number,
  scale: number,
  out: Float64Array,
): number {
  const s = scale > 0 ? scale : height / 1080;
  const area = gridArea(width, height, scale, rect());
  const n = Math.max(1, Math.min(MAX_STOCKS, Math.floor(count)));
  const [cols, rows] = gridShape(n, area.w, area.h);
  const g = GAP * s;
  const tw = Math.max(1, (area.w - (cols - 1) * g) / cols);
  const th = Math.max(1, (area.h - (rows - 1) * g) / rows);
  const r = rect();
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    const offset = ((cols - inRow) * (tw + g)) / 2;
    set(r, area.x + offset + col * (tw + g), area.y + row * (th + g), tw, th);
    out[4 * i] = r.x;
    out[4 * i + 1] = r.y;
    out[4 * i + 2] = r.w;
    out[4 * i + 3] = r.h;
  }
  if (cols % 2 === 1 && rows % 2 === 1 && (rows === 1 ? n === cols : true)) {
    return ((rows - 1) / 2) * cols + (cols - 1) / 2;
  }
  return -1;
}

/**
 * The fixed widths of a tile header's two text blocks (ticker and name on the
 * left, price and change on the right), in device px: small enough to fit the
 * narrowest tile any count gives this frame, so they never need rescaling while
 * the tiles move.
 */
export function tileTextWidths(width: number, height: number, scale: number): [number, number] {
  const s = scale > 0 ? scale : height / 1080;
  const tiles = new Float64Array(4 * MAX_STOCKS);
  let narrowest = Infinity;
  for (let count = 4; count <= MAX_STOCKS; count++) {
    gridTiles(count, width, height, scale, tiles);
    for (let i = 0; i < count; i++) {
      narrowest = Math.min(narrowest, tiles[4 * i + 2]);
    }
  }
  const inner = Math.max(2, narrowest - 2 * PAD * s);
  const left = Math.max(1, Math.floor(Math.min(TILE_LEFT * s, inner * 0.6)));
  const right = Math.max(1, Math.floor(Math.min(TILE_RIGHT * s, inner - left)));
  return [left, right];
}
