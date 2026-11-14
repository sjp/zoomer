/**
 * Where everything sits in the Spreadsheet, in whole device pixels (y down), for
 * any canvas size and cell zoom. Sizes are set at 1080p and scaled. Pure layout
 * maths: no GL, no canvas.
 *
 * A toolbar and a formula bar run along the top and a sheet-tab strip along the
 * bottom. Between them is the grid: column letters across the top, row numbers
 * down the left, then cells. Row 1 is the frozen header row.
 *
 * The figures sit in the outer thirds, where they don't compete with the speaker:
 * an item table starts at column A on the left, and a smaller region table ends at
 * the last whole column on the right, with the chart floating below it. Each table
 * takes as many number columns as fit inside its third, so the middle third holds
 * plain, empty grid (`sparseMiddle`). Only on frames too narrow for that does the
 * left table spill into the middle.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });

/** Reference sizes (px at 1080p) of the chrome, which doesn't zoom. */
const TOOLBAR_H = 44;
const FORMULA_H = 36;
const TABS_H = 34;
/** Reference sizes at zoom 1 of the grid, which does. */
const HEAD_H = 26;
const GUTTER_W = 46;
export const ROW_H = 28;
const LABEL_W = 160;
const COL_W = 100;

/** Most columns and rows the grid draws (only absurdly thin frames reach them). */
export const MAX_COLS = 64;
export const MAX_ROWS = 64;
/** Number columns in each table at most, item rows in the left table and regions in the right. */
export const MAX_LEFT_COLS = 4;
export const MAX_RIGHT_COLS = 4;
export const MAX_ITEMS = 16;
export const MAX_REGIONS = 6;
/** Rows kept free below a table: the totals row and one blank row. */
const TABLE_TAIL = 2;
/** The chart's margin inside its area, and the smallest chart worth drawing (reference px). */
const CHART_MARGIN = 14;
const CHART_MIN_W = 220;
const CHART_MIN_H = 150;

export interface SheetLayout {
  width: number;
  height: number;
  scale: number;
  zoom: number;
  toolbar: Rect;
  formula: Rect;
  /** The cell-address box at the formula bar's left, and where its content starts. */
  address: Rect;
  formulaTextX: number;
  tabs: Rect;
  /** The column-letter band's top and height, and the row-number gutter's width. */
  headTop: number;
  headH: number;
  gutterW: number;
  /** Top of row 1, bottom of the grid, and row height. */
  cellsTop: number;
  cellsBottom: number;
  rowH: number;
  /** Column edges: column i spans `colX[i]` to `colX[i + 1]`. */
  readonly colX: Float64Array;
  /** Columns and rows drawn (the last may be cut off), and those wholly on screen. */
  colCount: number;
  fullCols: number;
  rowCount: number;
  fullRows: number;
  /** Number columns and item rows of the left table (its labels are column A). */
  leftCols: number;
  leftItems: number;
  /** The right table's label column (-1 for none), number columns and region rows. */
  rightStart: number;
  rightCols: number;
  rightItems: number;
  /** The floating chart (zero size for none). */
  chart: Rect;
  /** Whether both tables keep out of the middle third. */
  sparseMiddle: boolean;
}

export function createLayout(): SheetLayout {
  return {
    width: 1,
    height: 1,
    scale: 1,
    zoom: 1,
    toolbar: rect(),
    formula: rect(),
    address: rect(),
    formulaTextX: 0,
    tabs: rect(),
    headTop: 0,
    headH: 0,
    gutterW: 0,
    cellsTop: 0,
    cellsBottom: 0,
    rowH: 1,
    colX: new Float64Array(MAX_COLS + 1),
    colCount: 0,
    fullCols: 0,
    rowCount: 0,
    fullRows: 0,
    leftCols: 0,
    leftItems: 0,
    rightStart: -1,
    rightCols: 0,
    rightItems: 0,
    chart: rect(),
    sparseMiddle: true,
  };
}

function setRect(r: Rect, x: number, y: number, w: number, h: number): Rect {
  r.x = Math.round(x);
  r.y = Math.round(y);
  r.w = Math.max(0, Math.round(x + w) - r.x);
  r.h = Math.max(0, Math.round(y + h) - r.y);
  return r;
}

/** Column `col`'s width at zoom 1 (reference px). */
export const colRefWidth = (col: number): number => (col === 0 ? LABEL_W : COL_W);

/**
 * Fills `out` with the layout of a `width` x `height` frame at `scale` (px per
 * reference px) and cell `zoom`.
 */
export function sheetLayout(
  width: number,
  height: number,
  scale: number,
  zoom: number,
  out: SheetLayout,
): SheetLayout {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const s = scale > 0 ? scale : H / 1080;
  const z = zoom > 0 ? zoom : 1;
  out.width = W;
  out.height = H;
  out.scale = s;
  out.zoom = z;

  setRect(out.toolbar, 0, 0, W, TOOLBAR_H * s);
  setRect(out.formula, 0, out.toolbar.h, W, FORMULA_H * s);
  setRect(out.address, 8 * s, out.formula.y + 6 * s, 84 * s, FORMULA_H * s - 12 * s);
  out.formulaTextX = out.address.x + out.address.w + Math.round(18 * s);
  const tabsH = Math.round(TABS_H * s);
  setRect(out.tabs, 0, H - tabsH, W, tabsH);

  out.headTop = out.formula.y + out.formula.h;
  out.headH = Math.max(1, Math.round(HEAD_H * s * z));
  out.gutterW = Math.max(1, Math.round(GUTTER_W * s * z));
  out.cellsTop = out.headTop + out.headH;
  out.cellsBottom = Math.max(out.cellsTop, out.tabs.y);
  out.rowH = Math.max(1, Math.round(ROW_H * s * z));

  // Columns from the gutter to the right edge.
  const colX = out.colX;
  colX[0] = out.gutterW;
  let n = 0;
  let full = 0;
  while (n < MAX_COLS && colX[n] < W) {
    colX[n + 1] = colX[n] + Math.max(1, Math.round(colRefWidth(n) * s * z));
    if (colX[n + 1] <= W) {
      full = n + 1;
    }
    n++;
  }
  out.colCount = n;
  out.fullCols = full;
  const gridH = Math.max(0, out.cellsBottom - out.cellsTop);
  out.rowCount = Math.min(MAX_ROWS, Math.ceil(gridH / out.rowH));
  out.fullRows = Math.min(MAX_ROWS, Math.floor(gridH / out.rowH));

  // Left table: labels in column A, then the number columns that fit the left third.
  const third = W / 3;
  let left = 0;
  while (left < MAX_LEFT_COLS && left + 2 <= full && colX[left + 2] <= third) {
    left++;
  }
  if (left === 0 && full >= 2) {
    // Too narrow for the thirds: one number column anyway, spilling past the first third.
    left = 1;
  }
  out.leftCols = full >= 1 ? left : 0;
  out.leftItems = out.leftCols > 0 ? clampInt(out.fullRows - 1 - TABLE_TAIL, 0, MAX_ITEMS) : 0;

  // Right table: ends at the last whole column, starting inside the right third,
  // with at least one empty column between it and the left table.
  out.rightStart = -1;
  out.rightCols = 0;
  out.rightItems = 0;
  const last = full - 1;
  for (let k = MAX_RIGHT_COLS; k >= 1; k--) {
    const start = last - k;
    if (start >= out.leftCols + 2 && colX[start] >= 2 * third) {
      out.rightStart = start;
      out.rightCols = k;
      break;
    }
  }
  if (out.rightStart >= 0) {
    out.rightItems = clampInt(out.fullRows - 1 - TABLE_TAIL, 0, MAX_REGIONS);
    if (out.rightItems === 0) {
      out.rightStart = -1;
      out.rightCols = 0;
    }
  }
  out.sparseMiddle = out.leftCols === 0 || colX[out.leftCols + 1] <= third;

  // The chart floats below the right table, out to the frame's right edge.
  out.chart.x = out.chart.y = out.chart.w = out.chart.h = 0;
  if (out.rightStart >= 0) {
    const m = CHART_MARGIN * s;
    const x0 = colX[out.rightStart] + m;
    const y0 = out.cellsTop + (out.rightItems + 1 + TABLE_TAIL) * out.rowH + m;
    const w = W - m - x0;
    const h = out.cellsBottom - m - y0;
    if (w >= CHART_MIN_W * s && h >= CHART_MIN_H * s) {
      setRect(out.chart, x0, y0, w, h);
    }
  }
  return out;
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The rect of grid cell (`row`, `col`) (row 0 is row 1 of the sheet). */
export function cellRect(L: SheetLayout, row: number, col: number, out: Rect): Rect {
  out.x = L.colX[col];
  out.y = L.cellsTop + row * L.rowH;
  out.w = L.colX[col + 1] - L.colX[col];
  out.h = L.rowH;
  return out;
}

/** Whether any of column `col` lies in the frame's middle third. */
export const inMiddleThird = (L: SheetLayout, col: number): boolean =>
  L.colX[col + 1] > L.width / 3 && L.colX[col] < (2 * L.width) / 3;
