/**
 * The split-flap board's model, as pure functions so its timing can be tested:
 * the glyph drum, turning text into rows of glyph indices, the pages the board
 * cycles through, each cell's flips towards its target, the board's layout and
 * the clock row's once-a-minute label.
 */
import { hash32 } from "../noise";

/**
 * The characters on every cell's drum, in the order the flaps turn through them.
 * Index 0, the blank, is what any other character shows as.
 */
export const GLYPHS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:'-/!?&()+#@%";
export const GLYPH_COUNT = GLYPHS.length;

const GLYPH_INDEX = new Map<string, number>(Array.from(GLYPHS, (ch, i) => [ch, i]));

/** Flips per second of a cell, before its small per-cell jitter. */
export const FLIP_RATE = 10;
/** Per-cell flip-rate spread: each cell runs at FLIP_RATE × (1 ± RATE_JITTER). */
export const RATE_JITTER = 0.06;
/** Start delay per column and per row (s), so a change ripples across the board. */
export const STAGGER_COL = 0.035;
export const STAGGER_ROW = 0.12;
/** Extra random start delay per cell (s), up to this. */
export const STAGGER_JITTER = 0.15;

/** Steps a cell's drum takes from glyph `from` to glyph `to`, always forwards. */
export function stepsTo(from: number, to: number): number {
  return (((to - from) % GLYPH_COUNT) + GLYPH_COUNT) % GLYPH_COUNT;
}

/**
 * One line of text as `cols` glyph indices: uppercased, accents dropped (É shows
 * as E), anything else not on the drum shown blank, then truncated (never wrapped)
 * and padded with blanks. `align` places a short line in the row.
 */
export function boardLine(
  text: string,
  cols: number,
  out: Uint8Array,
  offset = 0,
  align: "left" | "centre" = "left",
): void {
  const chars = Array.from(text.toUpperCase().normalize("NFD").replace(/\p{M}/gu, ""));
  const n = Math.min(cols, chars.length);
  const start = align === "centre" ? Math.floor((cols - n) / 2) : 0;
  out.fill(0, offset, offset + cols);
  for (let i = 0; i < n; i++) {
    out[offset + start + i] = GLYPH_INDEX.get(chars[i]) ?? 0;
  }
}

/**
 * Splits the text into the pages the board cycles through, `perPage` lines each.
 * Trailing blank lines are dropped; there is always at least one (maybe empty) page.
 */
export function textPages(text: string, perPage: number): string[][] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  const per = Math.max(1, Math.floor(perPage));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += per) {
    pages.push(lines.slice(i, i + per));
  }
  if (pages.length === 0) {
    pages.push([]);
  }
  return pages;
}

/** Every cell's state; arrays are `cols × rows` long, row-major from the top-left. */
export interface FlapBoard {
  readonly cols: number;
  readonly rows: number;
  /** The glyph the cell shows (its lower half shows it until the flip ends). */
  readonly cur: Uint8Array;
  /** The glyph the cell is heading for. */
  readonly target: Uint8Array;
  /** Progress 0..1 through the current flip, from `cur` to the next glyph. */
  readonly phase: Float32Array;
  /** Seconds before the cell starts flipping. */
  readonly delay: Float32Array;
  /** The cell's flip-rate factor, around 1. */
  readonly rate: Float32Array;
}

const unit = (h: number) => h / 4294967296;

export function createBoard(cols: number, rows: number): FlapBoard {
  const n = cols * rows;
  const rate = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    rate[i] = 1 + RATE_JITTER * (2 * unit(hash32(i * 2 + 1)) - 1);
  }
  return {
    cols,
    rows,
    cur: new Uint8Array(n),
    target: new Uint8Array(n),
    phase: new Float32Array(n),
    delay: new Float32Array(n),
    rate,
  };
}

/** Whether a cell is at rest on its target. */
export function cellIdle(b: FlapBoard, i: number): boolean {
  return b.cur[i] === b.target[i] && b.phase[i] === 0;
}

/** The stagger before cell (col, row) starts, given a change number for the jitter. */
export function staggerDelay(col: number, row: number, change: number): number {
  const h = unit(hash32((row * 64 + col) * 7919 + change * 104729));
  return col * STAGGER_COL + row * STAGGER_ROW + STAGGER_JITTER * h;
}

/**
 * Points the first `count` cells at new glyphs. A resting cell whose glyph changes
 * waits its stagger delay before it starts; a cell already flipping keeps going
 * towards the new target. Returns whether any target changed.
 */
export function setTargets(
  b: FlapBoard,
  targets: Uint8Array,
  count: number,
  change: number,
): boolean {
  let changed = false;
  const n = Math.min(count, b.cur.length);
  for (let i = 0; i < n; i++) {
    const t = targets[i] % GLYPH_COUNT;
    if (b.target[i] === t) {
      continue;
    }
    if (cellIdle(b, i)) {
      b.delay[i] = staggerDelay(i % b.cols, Math.floor(i / b.cols), change);
    }
    b.target[i] = t;
    changed = true;
  }
  return changed;
}

/** Puts the first `count` cells straight onto their glyphs, at rest. */
export function resetCells(b: FlapBoard, glyphs: Uint8Array, count: number): void {
  for (let i = 0; i < Math.min(count, b.cur.length); i++) {
    b.cur[i] = b.target[i] = glyphs[i] % GLYPH_COUNT;
    b.phase[i] = 0;
    b.delay[i] = 0;
  }
}

/**
 * Advances the first `count` cells by `dt` seconds at `flipRate` flips per
 * second: each moving cell waits out its delay, then steps through the drum in
 * order and stops exactly on its target. Returns whether any cell is still moving.
 */
export function stepBoard(b: FlapBoard, dt: number, count: number, flipRate = FLIP_RATE): boolean {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  let moving = false;
  const n = Math.min(count, b.cur.length);
  for (let i = 0; i < n; i++) {
    if (cellIdle(b, i)) {
      continue;
    }
    let left = step;
    if (b.delay[i] > 0) {
      const wait = Math.min(b.delay[i], left);
      b.delay[i] -= wait;
      left -= wait;
    }
    if (left > 0) {
      let phase = b.phase[i] + left * flipRate * b.rate[i];
      while (phase >= 1) {
        phase -= 1;
        b.cur[i] = (b.cur[i] + 1) % GLYPH_COUNT;
        if (b.cur[i] === b.target[i]) {
          phase = 0;
          break;
        }
      }
      b.phase[i] = phase;
    }
    if (!cellIdle(b, i)) {
      moving = true;
    }
  }
  return moving;
}

/** The glyph a cell flips to next (its upper half shows it during a flip). */
export function nextGlyph(b: FlapBoard, i: number): number {
  return cellIdle(b, i) ? b.cur[i] : (b.cur[i] + 1) % GLYPH_COUNT;
}

/**
 * The flap's angle (radians) at flip progress `phase`: 0 when the upper half of the
 * old glyph stands up, π/2 edge-on, π when it lies over the lower half showing the
 * new glyph. It accelerates as it falls, like a flap dropping off its stop.
 */
export function flapAngle(phase: number): number {
  const t = Math.min(1, Math.max(0, phase));
  return Math.PI * t * Math.sqrt(t);
}

/** Longest a change can take: the largest stagger plus a full turn of the drum. */
export function maxChangeTime(cols: number, rows: number, flipRate = FLIP_RATE): number {
  const stagger = (cols - 1) * STAGGER_COL + (rows - 1) * STAGGER_ROW + STAGGER_JITTER;
  return stagger + (GLYPH_COUNT - 1) / (flipRate * (1 - RATE_JITTER));
}

/** Cell width over height. */
export const CELL_ASPECT = 0.7;
/** Gaps between cells, as fractions of the cell's width (across) and height (down). */
export const GAP_X = 0.1;
export const GAP_Y = 0.14;
/** The housing's margin around the cells, in cell heights. */
export const MARGIN = 0.35;
/** The board's top edge, and its height at MAX_ROWS rows (height units). */
export const BOARD_TOP = 0.045;
export const MAX_BOARD_H = 0.46;
/** Widest the board gets, as a fraction of the frame width. */
export const MAX_BOARD_W = 0.9;

/** Where the board sits, in height units (frame height 1), y down from the top. */
export interface BoardLayout {
  /** Top-left of the first cell. */
  x: number;
  y: number;
  /** Cell size and the pitch between neighbouring cells. */
  cellW: number;
  cellH: number;
  pitchX: number;
  pitchY: number;
  /** The housing: left, top, right, bottom. */
  housing: [number, number, number, number];
}

export function createLayout(): BoardLayout {
  return { x: 0, y: 0, cellW: 0, cellH: 0, pitchX: 0, pitchY: 0, housing: [0, 0, 0, 0] };
}

/**
 * Centres the board across the top of a frame `aspect` wide. The cell size depends
 * only on the frame, so changing `rows` grows the board downwards.
 */
export function boardLayout(
  aspect: number,
  cols: number,
  rows: number,
  maxRows: number,
  out: BoardLayout,
): BoardLayout {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  // Width and height of the cells and housing, in cell heights.
  const spanW = (cols * (1 + GAP_X) - GAP_X) * CELL_ASPECT + 2 * MARGIN;
  const spanH = (r: number) => r * (1 + GAP_Y) - GAP_Y + 2 * MARGIN;
  const cellH = Math.min(MAX_BOARD_H / spanH(maxRows), (MAX_BOARD_W * a) / spanW);
  const cellW = cellH * CELL_ASPECT;
  const left = (a - spanW * cellH) / 2;
  out.cellW = cellW;
  out.cellH = cellH;
  out.pitchX = cellW * (1 + GAP_X);
  out.pitchY = cellH * (1 + GAP_Y);
  out.x = left + MARGIN * cellH;
  out.y = BOARD_TOP + MARGIN * cellH;
  out.housing[0] = left;
  out.housing[1] = BOARD_TOP;
  out.housing[2] = a - left;
  out.housing[3] = BOARD_TOP + spanH(rows) * cellH;
  return out;
}

/** "HH:MM" for a time of day in minutes since midnight. */
export function clockLabel(minutesOfDay: number): string {
  const m = ((Math.floor(minutesOfDay) % 1440) + 1440) % 1440;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** The clock row's state: the label and when (epoch ms) to look at the time again. */
export interface MinuteClock {
  label: string;
  next: number;
}

export function createMinuteClock(): MinuteClock {
  return { label: "", next: Number.NEGATIVE_INFINITY };
}

/**
 * Reads the time only when a new minute starts (or the wall clock jumped back),
 * calling `localMinutes(nowMs)` for the minutes since local midnight. Returns
 * whether the label changed.
 */
export function tickClock(
  c: MinuteClock,
  nowMs: number,
  localMinutes: (ms: number) => number,
): boolean {
  if (nowMs < c.next && nowMs >= c.next - 60000) {
    return false;
  }
  c.next = (Math.floor(nowMs / 60000) + 1) * 60000;
  const label = clockLabel(localMinutes(nowMs));
  if (label === c.label) {
    return false;
  }
  c.label = label;
  return true;
}
