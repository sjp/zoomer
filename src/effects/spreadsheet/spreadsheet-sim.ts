/**
 * The Spreadsheet's made-up workbook and the off-screen typist editing it.
 *
 * A sheet holds one or two tables laid out by `sheetLayout`: an item table on the
 * left (labels in column A, then up to four number columns) and a region table on
 * the right. Each table has a header row, item rows and a totals row. Number
 * columns are inputs or simple formulas of earlier columns in the same row (a
 * sum, a difference, a ratio, a growth rate, a share of the column total); the
 * totals row sums each column, or applies the row's formula to the totals for
 * ratios. Every derived cell is recalculated after each edit, so totals are real
 * sums and percentages real ratios.
 *
 * The editor works through edits on a schedule: every `pace` seconds (latched per
 * edit) the selection walks to a cell one cell at a time (each step slow enough
 * for the codec limits), then either types a new figure into an input cell
 * character by character, fills a few cells down a column one after another, or
 * just rests on a formula cell so the formula bar shows it. Changing tables is a
 * jump (the renderer fades the selection across) rather than a walk through the
 * middle of the frame. After `EDITS_PER_SHEET` edits the sheet reports `done`, and
 * the renderer moves on to the next tab with a fresh sheet.
 *
 * Inputs random-walk around a base figure, so values stay plausible. Starting
 * values and labels come from hashes of the seed, sheet and cell, so a new layout
 * (a resize or zoom) keeps the cells it shares with the old one. Stepping
 * allocates nothing except the typed text, once per edit.
 */
import { formatFixed, minTweenSeconds } from "../charts";
import { smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import {
  colRefWidth,
  MAX_ITEMS,
  MAX_LEFT_COLS,
  MAX_REGIONS,
  MAX_RIGHT_COLS,
  ROW_H,
  type SheetLayout,
} from "./spreadsheet-layout";

/** Column operations. */
export const OP_IN = 0;
export const OP_SUM = 1;
export const OP_DIFF = 2;
const OP_RATIO = 3;
const OP_GROWTH = 4;
export const OP_SHARE = 5;

const FMT_MONEY = 0;
const FMT_PERCENT = 1;

/**
 * A number column: an input, or a formula over earlier columns `a` and `b` of the
 * same row: `SUM` adds columns a..b, `DIFF` is b - a, `RATIO` a / b, `GROWTH`
 * (b - a) / a, and `SHARE` a over column a's total.
 */
interface ColSpec {
  readonly header: string;
  readonly op: number;
  readonly a: number;
  readonly b: number;
  readonly fmt: number;
}

const input = (header: string): ColSpec => ({ header, op: OP_IN, a: 0, b: 0, fmt: FMT_MONEY });
const formula = (header: string, op: number, a: number, b: number, fmt: number): ColSpec => ({
  header,
  op,
  a,
  b,
  fmt,
});

/** The sheet tabs, in order; each has its own item-table template. */
export const TAB_NAMES = ["Q3", "Budget", "Forecast"] as const;

/** Item-table columns per tab. Each formula uses only earlier columns, so any prefix works. */
const LEFT_TEMPLATES: readonly (readonly ColSpec[])[] = [
  [input("Jul"), input("Aug"), input("Sep"), formula("Q3 total", OP_SUM, 0, 2, FMT_MONEY)],
  [
    input("Budget"),
    input("Actual"),
    formula("Variance", OP_DIFF, 0, 1, FMT_MONEY),
    formula("Var %", OP_RATIO, 2, 0, FMT_PERCENT),
  ],
  [input("Oct"), input("Nov"), input("Dec"), formula("Growth", OP_GROWTH, 0, 2, FMT_PERCENT)],
];

const RIGHT_TEMPLATE: readonly ColSpec[] = [
  input("Sales"),
  formula("Share", OP_SHARE, 0, 0, FMT_PERCENT),
  input("Target"),
  formula("vs target", OP_GROWTH, 2, 0, FMT_PERCENT),
];

const ITEMS = [
  "Rent",
  "Salaries",
  "Software",
  "Travel",
  "Marketing",
  "Utilities",
  "Insurance",
  "Equipment",
  "Training",
  "Consulting",
  "Office supplies",
  "Hosting",
  "Legal",
  "Catering",
  "Recruitment",
  "Maintenance",
  "Telephone",
  "Subscriptions",
  "Freight",
  "Packaging",
  "Licences",
  "Events",
  "Printing",
  "Cleaning",
  "Security",
  "Advertising",
  "Contractors",
  "Bank fees",
  "Postage",
  "Research",
] as const;

const REGIONS = [
  "North",
  "South",
  "East",
  "West",
  "Central",
  "Online",
  "Coastal",
  "Metro",
] as const;

export interface Table {
  /** The label column's sheet column; number column c is at `col0 + 1 + c`. */
  readonly col0: number;
  readonly cols: number;
  /** Item rows; the totals row follows them. */
  readonly items: number;
  /** The label column's header. */
  readonly title: string;
  readonly labels: readonly string[];
  readonly specs: readonly ColSpec[];
  /** Values row-major, `cols` per row: `items` item rows, then the totals. */
  readonly values: Float64Array;
  /** Each input's resting figure, laid out like `values`. */
  readonly base: Float64Array;
  /** Values before the last recalculation, to find what it changed. */
  readonly prev: Float64Array;
  readonly rng: () => number;
}

const EDIT_TYPE = 0;
const EDIT_INSPECT = 1;
const EDIT_FILL = 2;

export const PHASE_IDLE = 0;
const PHASE_MOVE = 1;
export const PHASE_TYPE = 2;
const PHASE_FILL = 3;
const PHASE_HOLD = 4;

/** Edits on a sheet before it is full and the next tab takes over. */
export const EDITS_PER_SHEET = 36;
/** Seconds per typed character, and the pause after the last before it commits. */
const CHAR_SECONDS = 0.11;
const COMMIT_PAUSE = 0.3;
/** Shortest selection step, and the selection's fade across to the other table, s. */
const MIN_STEP_SECONDS = 0.3;
const JUMP_SECONDS = 0.6;
/** Rows a new target lies from the current one at most, so walks stay short. */
const REACH_ROWS = 3;
/** Chance an edit moves to the other table, inspects a formula, or fills down. */
const SWITCH_CHANCE = 0.2;
const INSPECT_CHANCE = 0.15;
const FILL_CHANCE = 0.15;
/** Changed cells buffered between drains. */
const MAX_CHANGES = 256;

interface Editor {
  readonly rng: () => number;
  phase: number;
  kind: number;
  /** The table the selection is in. */
  table: number;
  /** The selected cell (sheet row and column) and the cell the current step left. */
  row: number;
  col: number;
  fromRow: number;
  fromCol: number;
  /** Progress (0..1) and length of the current step, and whether it is a jump. */
  stepT: number;
  stepSeconds: number;
  jump: boolean;
  /** Where the edit is going (sheet coordinates), and in which table. */
  targetTable: number;
  targetRow: number;
  targetCol: number;
  /** The figure being typed as raw characters, the value it commits, and characters shown. */
  text: string;
  pending: number;
  chars: number;
  charT: number;
  /** Rows the selection extends below the selected cell, easing from `extFrom` by `extT`. */
  ext: number;
  extFrom: number;
  extT: number;
  extSeconds: number;
  /** Fill-down cells still to come. */
  fillLeft: number;
  /** Seconds since this edit began, and the pace it latched. */
  since: number;
  pace: number;
  edits: number;
  /** All edits made: the renderer moves to the next tab. */
  done: boolean;
}

export interface Sheet {
  readonly seed: number;
  readonly tab: number;
  /** Fresh sheets shown so far; each gets its own figures. */
  readonly generation: number;
  readonly zoom: number;
  readonly tables: readonly Table[];
  /** The right table's index (-1 for none) and the column the chart plots. */
  readonly chartTable: number;
  readonly chartCol: number;
  readonly editor: Editor;
  /** Cells changed since the last drain (`packCell`), and how many. */
  readonly changes: Int32Array;
  changeCount: number;
  /** More changed than fit: repaint every cell. */
  changesOverflow: boolean;
  /** Commits so far. */
  version: number;
}

const packCell = (t: number, r: number, c: number): number => (t << 16) | (r << 8) | c;
export const cellTable = (p: number): number => p >>> 16;
export const cellRow = (p: number): number => (p >>> 8) & 0xff;
export const cellCol = (p: number): number => p & 0xff;

/** A unit float in [0, 1) from a hash. */
const unit = (h: number): number => (h >>> 0) / 4294967296;

/** A standard normal from `rng` (Box-Muller, one of the pair). */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** A figure rounded as people type them: to the nearest 10, at least 10. */
const roundFigure = (v: number): number => Math.max(10, Math.round(v / 10) * 10);

/** Labels picked from `list` by a seeded shuffle; a prefix of the shuffle, so more rows keep the first. */
function pickLabels(list: readonly string[], seed: number, n: number): string[] {
  const order = list.slice();
  const rng = createRng(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order.slice(0, n);
}

function createTable(
  key: number,
  col0: number,
  cols: number,
  items: number,
  title: string,
  labels: readonly string[],
  specs: readonly ColSpec[],
  lo: number,
  hi: number,
): Table {
  const n = (items + 1) * cols;
  const t: Table = {
    col0,
    cols,
    items,
    title,
    labels,
    specs: specs.slice(0, cols),
    values: new Float64Array(n),
    base: new Float64Array(n),
    prev: new Float64Array(n),
    rng: createRng(hash32(key ^ 0x51ed)),
  };
  // Each row has a size; its inputs sit near it, each from its own hash.
  for (let r = 0; r < items; r++) {
    const rowSize = lo * Math.pow(hi / lo, unit(hash32(key + Math.imul(r + 1, 0x9e3779b1))));
    for (let c = 0; c < cols; c++) {
      if (t.specs[c].op !== OP_IN) {
        continue;
      }
      const h = hash32(key ^ hash32(r * 64 + c + 1));
      const b = roundFigure(rowSize * (0.85 + 0.3 * unit(h)));
      t.base[r * cols + c] = b;
      t.values[r * cols + c] = roundFigure(b * (0.92 + 0.16 * unit(hash32(h))));
    }
  }
  recalc(t);
  return t;
}

const ratio = (a: number, b: number): number => (b !== 0 && Number.isFinite(a / b) ? a / b : 0);

/** Recalculates every formula and total of `t` from its inputs. */
function recalc(t: Table): void {
  const v = t.values;
  const k = t.cols;
  const totals = t.items * k;
  for (let r = 0; r < t.items; r++) {
    rowFormulas(t, r * k, false);
  }
  // Column totals of the inputs and additive formulas.
  for (let c = 0; c < k; c++) {
    const op = t.specs[c].op;
    if (op === OP_IN || op === OP_SUM || op === OP_DIFF) {
      let sum = 0;
      for (let r = 0; r < t.items; r++) {
        sum += v[r * k + c];
      }
      v[totals + c] = sum;
    }
  }
  // Shares need their column's total; then the totals row's own ratios.
  for (let c = 0; c < k; c++) {
    const s = t.specs[c];
    if (s.op === OP_SHARE) {
      let sum = 0;
      for (let r = 0; r < t.items; r++) {
        v[r * k + c] = ratio(v[r * k + s.a], v[totals + s.a]);
        sum += v[r * k + c];
      }
      v[totals + c] = sum;
    }
  }
  rowFormulas(t, totals, true);
}

/** Row formulas for the row starting at `o`; on the totals row only the ratios. */
function rowFormulas(t: Table, o: number, totalsRow: boolean): void {
  const v = t.values;
  for (let c = 0; c < t.cols; c++) {
    const s = t.specs[c];
    switch (s.op) {
      case OP_SUM:
        if (!totalsRow) {
          let sum = 0;
          for (let i = s.a; i <= s.b; i++) {
            sum += v[o + i];
          }
          v[o + c] = sum;
        }
        break;
      case OP_DIFF:
        if (!totalsRow) {
          v[o + c] = v[o + s.b] - v[o + s.a];
        }
        break;
      case OP_RATIO:
        v[o + c] = ratio(v[o + s.a], v[o + s.b]);
        break;
      case OP_GROWTH:
        v[o + c] = ratio(v[o + s.b] - v[o + s.a], v[o + s.a]);
        break;
      default:
        break;
    }
  }
}

/** Table `t`'s value at item row `r` (`t.items` for the totals) and number column `c`. */
export const valueAt = (t: Table, r: number, c: number): number => t.values[r * t.cols + c];

/** A sheet for `layout`: tab `tab`'s template, figures from `seed` and `generation`. */
export function createSheet(
  seed: number,
  tab: number,
  generation: number,
  layout: SheetLayout,
): Sheet {
  const tabIndex = ((Math.floor(tab) % TAB_NAMES.length) + TAB_NAMES.length) % TAB_NAMES.length;
  const key = hash32(hash32(Math.floor(seed) ^ 0x5eed) + Math.imul(generation + 1, 0x85ebca6b));
  const tables: Table[] = [];
  const leftCols = Math.min(layout.leftCols, MAX_LEFT_COLS);
  const leftItems = Math.min(layout.leftItems, MAX_ITEMS);
  if (leftCols > 0 && leftItems > 0) {
    const leftKey = hash32(key + 1);
    tables.push(
      createTable(
        leftKey,
        0,
        leftCols,
        leftItems,
        "Item",
        pickLabels(ITEMS, leftKey, leftItems),
        LEFT_TEMPLATES[tabIndex],
        400,
        24000,
      ),
    );
  }
  let chartTable = -1;
  let chartCol = 0;
  const rightCols = Math.min(layout.rightCols, MAX_RIGHT_COLS);
  const rightItems = Math.min(layout.rightItems, MAX_REGIONS);
  if (layout.rightStart >= 0 && rightCols > 0 && rightItems > 0) {
    const rightKey = hash32(key + 2);
    chartTable = tables.length;
    // The chart plots sales or, where it fits, the targets.
    chartCol = rightCols > 2 && unit(hash32(rightKey ^ 0xc4a7)) < 0.4 ? 2 : 0;
    tables.push(
      createTable(
        rightKey,
        layout.rightStart,
        rightCols,
        rightItems,
        "Region",
        pickLabels(REGIONS, rightKey, rightItems),
        RIGHT_TEMPLATE,
        20000,
        120000,
      ),
    );
  }
  const editor: Editor = {
    rng: createRng(hash32(key + 3)),
    phase: PHASE_IDLE,
    kind: EDIT_TYPE,
    table: 0,
    row: 1,
    col: 1,
    fromRow: 1,
    fromCol: 1,
    stepT: 1,
    stepSeconds: MIN_STEP_SECONDS,
    jump: false,
    targetTable: 0,
    targetRow: 1,
    targetCol: 1,
    text: "",
    pending: 0,
    chars: 0,
    charT: 0,
    ext: 0,
    extFrom: 0,
    extT: 1,
    extSeconds: MIN_STEP_SECONDS,
    fillLeft: 0,
    since: 0,
    pace: 0,
    edits: 0,
    done: false,
  };
  if (tables.length > 0) {
    const t = tables[0];
    editor.phase = PHASE_HOLD;
    editor.row = editor.fromRow = editor.targetRow = 1;
    editor.col = editor.fromCol = editor.targetCol = t.col0 + 1;
  }
  return {
    seed,
    tab: tabIndex,
    generation,
    zoom: layout.zoom,
    tables,
    chartTable,
    chartCol,
    editor,
    changes: new Int32Array(MAX_CHANGES),
    changeCount: 0,
    changesOverflow: false,
    version: 0,
  };
}

/**
 * `old`'s sheet for a new layout: the same tab and figures where the tables
 * overlap, and the same count of edits made. The selection starts over.
 */
export function reshapeSheet(old: Sheet, layout: SheetLayout): Sheet {
  const s = createSheet(old.seed, old.tab, old.generation, layout);
  for (const t of s.tables) {
    const o = old.tables.find((x) => x.title === t.title);
    if (!o) {
      continue;
    }
    for (let r = 0; r < Math.min(t.items, o.items); r++) {
      for (let c = 0; c < Math.min(t.cols, o.cols); c++) {
        if (t.specs[c].op === OP_IN) {
          t.values[r * t.cols + c] = o.values[r * o.cols + c];
        }
      }
    }
    recalc(t);
  }
  s.editor.edits = old.editor.edits;
  return s;
}

/** The table holding sheet cell (`row`, `col`), or -1. */
function tableAt(s: Sheet, row: number, col: number): number {
  for (let i = 0; i < s.tables.length; i++) {
    const t = s.tables[i];
    if (col >= t.col0 && col <= t.col0 + t.cols && row >= 0 && row <= t.items + 1) {
      return i;
    }
  }
  return -1;
}

const randInt = (rng: () => number, n: number): number => Math.min(n - 1, Math.floor(rng() * n));

/** A random column of `t` with operation `op` (or any formula for -1), or -1 for none. */
function pickColumn(t: Table, rng: () => number, wantInput: boolean): number {
  let n = 0;
  for (let c = 0; c < t.cols; c++) {
    if ((t.specs[c].op === OP_IN) === wantInput) {
      n++;
    }
  }
  if (n === 0) {
    return -1;
  }
  let k = randInt(rng, n);
  for (let c = 0; c < t.cols; c++) {
    if ((t.specs[c].op === OP_IN) === wantInput && k-- === 0) {
      return c;
    }
  }
  return -1;
}

/** An item row within reach of `near` (an item row index), in [lo, hi]. */
function pickRow(rng: () => number, near: number, lo: number, hi: number): number {
  const to = Math.min(hi, Math.max(lo, near + REACH_ROWS));
  const from = Math.max(lo, Math.min(to, near - REACH_ROWS));
  return from + randInt(rng, to - from + 1);
}

/** A new figure for input (`r`, `c`) of `t`: a step of its walk, pulled towards its base. */
function nextFigure(t: Table, r: number, c: number): number {
  const i = r * t.cols + c;
  const v = t.values[i];
  const b = t.base[i] > 0 ? t.base[i] : v;
  return roundFigure(v * (1 + 0.07 * normal(t.rng)) + (b - v) * 0.3);
}

function beginEdit(s: Sheet, pace: number): void {
  const e = s.editor;
  const rng = e.rng;
  e.since = 0;
  e.pace = pace;
  e.edits++;
  let ti = e.table;
  if (s.tables.length > 1 && rng() < SWITCH_CHANCE) {
    ti = 1 - ti;
  }
  const t = s.tables[ti];
  // Item row the walk starts near: the current one in this table, else the top.
  const near = ti === e.table ? Math.min(e.row - 1, t.items - 1) : 0;
  const u = rng();
  let kind =
    u < INSPECT_CHANCE ? EDIT_INSPECT : u < INSPECT_CHANCE + FILL_CHANCE ? EDIT_FILL : EDIT_TYPE;
  if (kind === EDIT_FILL && t.items < 3) {
    kind = EDIT_TYPE;
  }
  let r = 0;
  let c = 0;
  if (kind === EDIT_INSPECT) {
    const fc = pickColumn(t, rng, false);
    if (fc >= 0 && rng() < 0.7) {
      c = fc;
      r = pickRow(rng, near, 0, t.items - 1);
    } else {
      // The totals row, in any column.
      c = randInt(rng, t.cols);
      r = t.items;
    }
  } else {
    c = Math.max(0, pickColumn(t, rng, true));
    if (kind === EDIT_FILL) {
      e.fillLeft = Math.min(2 + randInt(rng, 3), t.items - 1);
      r = pickRow(rng, near, 0, t.items - 1 - e.fillLeft);
    } else if (ti === e.table && e.row < t.items && e.col === t.col0 + 1 + c && rng() < 0.5) {
      // Enter, then the next row down: the usual rhythm of typing in figures.
      r = e.row;
    } else {
      r = pickRow(rng, near, 0, t.items - 1);
    }
    e.pending = nextFigure(t, r, c);
    e.text = String(e.pending);
  }
  e.kind = kind;
  e.targetTable = ti;
  e.targetRow = 1 + r;
  e.targetCol = t.col0 + 1 + c;
  e.chars = 0;
  e.charT = 0;
  // A selection left extended by a fill shrinks back before the walk starts.
  setExtent(s, 0);
  e.phase = PHASE_MOVE;
}

function setExtent(s: Sheet, ext: number): void {
  const e = s.editor;
  if (ext === e.ext) {
    return;
  }
  e.extFrom = extentNow(e);
  e.ext = ext;
  e.extT = 0;
  e.extSeconds = Math.max(
    MIN_STEP_SECONDS,
    minTweenSeconds(Math.abs(ext - e.extFrom) * ROW_H * s.zoom),
  );
}

/** Rows the selection extends below the selected cell right now (eased). */
export const extentNow = (e: Editor): number =>
  e.extFrom + (e.ext - e.extFrom) * smoothstep(0, 1, e.extT);

function startJump(s: Sheet): void {
  const e = s.editor;
  e.fromRow = e.row;
  e.fromCol = e.col;
  e.row = e.targetRow;
  e.col = e.targetCol;
  e.table = e.targetTable;
  e.jump = true;
  e.stepT = 0;
  e.stepSeconds = JUMP_SECONDS;
}

/** Starts the next one-cell step towards the target: rows first, then columns. */
function startStep(s: Sheet): void {
  const e = s.editor;
  e.fromRow = e.row;
  e.fromCol = e.col;
  e.jump = false;
  let px: number;
  if (e.row !== e.targetRow) {
    e.row += e.row < e.targetRow ? 1 : -1;
    px = ROW_H;
  } else {
    e.col += e.col < e.targetCol ? 1 : -1;
    // Each edge moves by the width of the column it crosses.
    px = Math.max(colRefWidth(e.col), colRefWidth(e.fromCol));
  }
  e.stepT = 0;
  e.stepSeconds = Math.max(MIN_STEP_SECONDS, minTweenSeconds(px * s.zoom));
}

function pushChange(s: Sheet, p: number): void {
  if (s.changeCount < s.changes.length) {
    s.changes[s.changeCount++] = p;
  } else {
    s.changesOverflow = true;
  }
}

/** Sets input (`r`, `c`) of table `ti` to `v`, recalculates, and records every cell that changed. */
function commit(s: Sheet, ti: number, r: number, c: number, v: number): void {
  const t = s.tables[ti];
  t.prev.set(t.values);
  t.values[r * t.cols + c] = v;
  recalc(t);
  pushChange(s, packCell(ti, r, c));
  for (let i = 0; i < t.values.length; i++) {
    if (t.values[i] !== t.prev[i] && i !== r * t.cols + c) {
      pushChange(s, packCell(ti, Math.floor(i / t.cols), i % t.cols));
    }
  }
  s.version++;
}

/** Starts the selection one more row down a fill. */
function startFill(s: Sheet): void {
  setExtent(s, s.editor.ext + 1);
}

/** Advances the editor by `dt` seconds; a new edit starts every `pace` seconds at most. */
export function stepSheet(s: Sheet, dt: number, pace: number): void {
  const e = s.editor;
  if (e.phase === PHASE_IDLE || !(dt >= 0)) {
    return;
  }
  e.since += dt;
  e.stepT = Math.min(1, e.stepT + dt / e.stepSeconds);
  e.extT = Math.min(1, e.extT + dt / e.extSeconds);
  const t = s.tables[e.table];
  const c = e.col - t.col0 - 1;
  switch (e.phase) {
    case PHASE_MOVE:
      // The selection shrinks back from a fill before it walks on.
      if (e.stepT >= 1 && e.extT >= 1) {
        if (e.table !== e.targetTable) {
          startJump(s);
        } else if (e.row === e.targetRow && e.col === e.targetCol) {
          e.phase = e.kind === EDIT_INSPECT ? PHASE_HOLD : PHASE_TYPE;
        } else {
          startStep(s);
        }
      }
      break;
    case PHASE_TYPE:
      e.charT += dt;
      while (e.chars < e.text.length && e.charT >= CHAR_SECONDS) {
        e.charT -= CHAR_SECONDS;
        e.chars++;
      }
      if (e.chars >= e.text.length && e.charT >= COMMIT_PAUSE) {
        commit(s, e.table, e.row - 1, c, e.pending);
        if (e.kind === EDIT_FILL && e.fillLeft > 0) {
          e.phase = PHASE_FILL;
          startFill(s);
        } else {
          e.phase = PHASE_HOLD;
        }
      }
      break;
    case PHASE_FILL:
      if (e.extT >= 1) {
        const r = e.row - 1 + e.ext;
        commit(s, e.table, r, c, nextFigure(t, r, c));
        e.fillLeft--;
        if (e.fillLeft > 0) {
          startFill(s);
        } else {
          e.phase = PHASE_HOLD;
        }
      }
      break;
    default:
      if (e.since >= e.pace && !e.done && e.stepT >= 1) {
        if (e.edits >= EDITS_PER_SHEET) {
          e.done = true;
        } else {
          beginEdit(s, pace);
        }
      }
      break;
  }
}

/** Sheet column `col`'s letters: A..Z, then AA, AB... */
export function columnName(col: number): string {
  let n = Math.max(0, Math.floor(col)) + 1;
  let out = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCodePoint(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A cell's address, such as "C7", for sheet (`row`, `col`). */
export const cellAddress = (row: number, col: number): string => columnName(col) + String(row + 1);

/** A money figure: "$12,340", "-$1,230". */
export function formatMoney(v: number): string {
  const s = formatFixed(Math.abs(v), 0);
  return (v < 0 && s !== "0" ? "-$" : "$") + s;
}

/** A ratio as a percentage: 0.124 → "12.4%". */
export const formatRatio = (v: number): string => formatFixed(v * 100, 1) + "%";

/** The text shown in item row `r` (or the totals) and column `c` of `t`. */
export function cellText(t: Table, r: number, c: number): string {
  const v = valueAt(t, r, c);
  return t.specs[c].fmt === FMT_PERCENT ? formatRatio(v) : formatMoney(v);
}

/** Whether the cell shows a negative figure (drawn in red). */
export function cellNegative(t: Table, r: number, c: number): boolean {
  return cellText(t, r, c).startsWith("-");
}

export const HIGHLIGHT_NONE = 0;
export const HIGHLIGHT_GOOD = 1;
const HIGHLIGHT_BAD = 2;

/** Conditional formatting: a pale fill on notable percentages in the item rows. */
export function cellHighlight(t: Table, r: number, c: number): number {
  if (r >= t.items) {
    return HIGHLIGHT_NONE;
  }
  const v = valueAt(t, r, c);
  switch (t.specs[c].op) {
    case OP_RATIO:
    case OP_GROWTH:
      return v >= 0.1 ? HIGHLIGHT_GOOD : v <= -0.1 ? HIGHLIGHT_BAD : HIGHLIGHT_NONE;
    case OP_SHARE:
      return v >= 0.25 ? HIGHLIGHT_GOOD : HIGHLIGHT_NONE;
    default:
      return HIGHLIGHT_NONE;
  }
}

/** What the formula bar shows for item row `r` (or the totals) and column `c` of `t`. */
export function cellFormula(t: Table, r: number, c: number): string {
  const s = t.specs[c];
  const row = r + 1;
  const ref = (cc: number, rr = row) => cellAddress(rr, t.col0 + 1 + cc);
  const totals = r >= t.items;
  if (s.op === OP_IN && !totals) {
    return String(Math.round(valueAt(t, r, c)));
  }
  if (totals && s.op !== OP_RATIO && s.op !== OP_GROWTH) {
    return "=SUM(" + ref(c, 1) + ":" + ref(c, t.items) + ")";
  }
  switch (s.op) {
    case OP_SUM:
      return "=SUM(" + ref(s.a) + ":" + ref(s.b) + ")";
    case OP_DIFF:
      return "=" + ref(s.b) + "-" + ref(s.a);
    case OP_RATIO:
      return "=" + ref(s.a) + "/" + ref(s.b);
    case OP_GROWTH:
      return "=(" + ref(s.b) + "-" + ref(s.a) + ")/" + ref(s.a);
    default: {
      const total = ref(s.a, t.items + 1);
      return "=" + ref(s.a) + "/" + total.replace(/(\d+)$/, "$$$1");
    }
  }
}

/** The formula bar's text for sheet cell (`row`, `col`), from `s`'s tables (labels and headers too). */
export function formulaBarText(s: Sheet, row: number, col: number): string {
  const ti = tableAt(s, row, col);
  if (ti < 0) {
    return "";
  }
  const t = s.tables[ti];
  const c = col - t.col0 - 1;
  if (row === 0) {
    return c < 0 ? t.title : t.specs[c].header;
  }
  if (row > t.items + 1) {
    return "";
  }
  if (c < 0) {
    return row === t.items + 1 ? "Total" : t.labels[row - 1];
  }
  return cellFormula(t, row - 1, c);
}
