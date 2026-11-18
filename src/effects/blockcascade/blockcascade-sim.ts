/**
 * Block Cascade's game, pure and seeded: a nine-by-eighteen well, pieces from
 * a shuffled bag, an AI that picks each piece's rotation and column with a
 * one-piece lookahead, and full rows clearing. It never ends: when the stack
 * gets too high the well clears its bottom rows down to half height.
 *
 * Each piece is one `Drop`, planned in full the moment it appears: where it
 * goes, which rows it clears and when each step happens, with the speed and
 * skill latched for the whole drop. The well's board only changes between
 * drops, so the picture at any moment is the board plus the drop at its local
 * time, and the state after any span of time is the same however it is stepped.
 */
import { clamp } from "../math";
import { EASE_PEAK, MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import { hash32 } from "../noise";
import { MIN_SPEED, MAX_SPEED } from "./blockcascade.meta";
import { MAX_PIECE_CELLS, PIECES, type Rotation } from "./blockcascade-pieces";

export const WELL_W = 9;
export const WELL_H = 18;
/** Block colours in each palette; a piece's colour is an index into them. */
export const COLOURS = 6;

/** At or above this stack height (rows) the AI plays to clear rows... */
const RESCUE_HEIGHT = 12;
/** ...until the stack is back under this. Clear-downs also bring the stack down to it. */
export const SAFE_HEIGHT = 9;
/**
 * A stack this high when a piece is due is cleared down to `SAFE_HEIGHT` first.
 * Below it the top `MAX_PIECE_CELLS` rows are always empty, so every piece can
 * appear at the top in any rotation and move to any column.
 */
export const CLEARDOWN_HEIGHT = WELL_H - MAX_PIECE_CELLS + 1;

/** The well's height as a share of the frame's, at most (the layout keeps to it). */
export const MAX_WELL_FRACTION = 0.78;
/** A cell's height as a share of the frame's, at most. */
const MAX_CELL_FRACTION = MAX_WELL_FRACTION / WELL_H;

/** Seconds a one-cell step (a fall, a shift or the appearing glide) eases over, at most. */
const SLIDE = 0.3;
/** Seconds a full row brightens, then its cells shrink and fade. */
const GLOW = 0.3;
const SHRINK = 0.25;
/** The same for a clear-down, slower: it clears many rows at once. */
const CLEARDOWN_GLOW = 0.6;
const CLEARDOWN_SHRINK = 0.5;
/** Seconds the rows above a clear ease down, at least. */
const SETTLE_MIN = 0.4;
/** Seconds between a clear-down being due and its rows starting to glow. */
const CLEARDOWN_PAUSE = 0.4;
/** Seconds the score counts up over after a clear. */
const COUNT_UP = 0.6;
/** Points for clearing 0..5 rows with one piece. */
const POINTS = [0, 100, 300, 500, 800, 1200];

/**
 * The fastest the rows above a clear may fall, frame heights a second at their
 * eased peak: within the codec's per-frame limit.
 */
const MAX_SETTLE_SPEED = MAX_FEATURE_PX_PER_FRAME / pxPerReferenceFrame(1);

/**
 * The speed param, rows a second, clamped to its range and capped so a falling
 * piece's eased step stays within the codec's per-frame motion limit in the
 * biggest well the layout draws. Below 1 / SLIDE rows a second each step takes
 * SLIDE seconds; above it a step takes the whole tick, so the peak speed grows
 * with the rate.
 */
export function effectiveSpeed(speed: number): number {
  const s = clamp(Number.isFinite(speed) ? speed : MIN_SPEED, MIN_SPEED, MAX_SPEED);
  const cap = MAX_FEATURE_PX_PER_FRAME / pxPerReferenceFrame(EASE_PEAK * MAX_CELL_FRACTION);
  return Math.min(s, cap);
}

/** Seconds a one-cell step eases over at `speed` rows a second. */
const slideTime = (speed: number) => Math.min(SLIDE, 1 / speed);

/** Seconds rows falling `rows` cells ease down over, within the motion limit. */
export const settleTime = (rows: number) =>
  Math.max(SETTLE_MIN, (EASE_PEAK * rows * MAX_CELL_FRACTION) / MAX_SETTLE_SPEED);

/** Uniform 0..1 from three integers. */
function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x632be5ab))) / 4294967296;
}

/** Writes bag `bag`'s order (a shuffle of every piece index) for `seed` into `out`. */
export function bagOrder(seed: number, bag: number, out: Uint8Array): Uint8Array {
  const n = PIECES.length;
  for (let i = 0; i < n; i++) {
    out[i] = i;
  }
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand(seed, bag, i) * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/** The rotation a piece appears in: its flattest. */
export function spawnRotation(piece: number): number {
  const rots = PIECES[piece].rotations;
  let best = 0;
  for (let r = 1; r < rots.length; r++) {
    if (rots[r].height < rots[best].height) {
      best = r;
    }
  }
  return best;
}

/** The column a rotation appears at: centred, rounding left. */
const spawnColumn = (rot: Rotation) => Math.floor((WELL_W - rot.width) / 2);

/** One piece's fall, or a clear-down (`piece` -1), planned in full when it starts. */
interface Drop {
  /** Piece index, or -1 for a clear-down. */
  piece: number;
  /** Colour index, 0..COLOURS-1. */
  colour: number;
  /** Rotation it appears in, and where it lands; the columns it appears at in each. */
  spawnRot: number;
  rot: number;
  spawnX: number;
  startX: number;
  x: number;
  /** Bottom row it appears at (in `rot`; `spawnRot` shares its top row) and lands on. */
  topY: number;
  y: number;
  /** Seconds a row (or a sideways step) takes, and a step's eased glide. */
  tick: number;
  slide: number;
  /** When the rotation crossfade, the sideways steps and the fall start, s from the drop's start. */
  rotateAt: number;
  shiftAt: number;
  fallAt: number;
  /** When it comes to rest (the glow starts), the rows above start settling, and the drop ends. */
  landAt: number;
  settleAt: number;
  end: number;
  /** How long the cleared rows glow, and the settle eases over; they shrink from `landAt + glow` to `settleAt`. */
  glow: number;
  settle: number;
  /** 1 for each row (bottom first) that clears, with the piece in place. */
  cleared: Uint8Array;
  clearedCount: number;
  /** Points scored, counted up from `landAt`. */
  points: number;
  /** Whether the next-piece previews moved on at this drop's start. */
  advanced: boolean;
}

export interface Well {
  /** This well's own seed. */
  readonly seed: number;
  /** Colour index + 1 per cell, 0 for empty; row-major, row 0 at the bottom. */
  readonly board: Uint8Array;
  /** Pieces drawn from the bags so far. */
  drawn: number;
  /** The bag being drawn from. */
  readonly bag: Uint8Array;
  /** The next two pieces and their colours. */
  readonly next: Int8Array;
  readonly nextColour: Int8Array;
  score: number;
  /** Rows cleared by pieces, and clear-downs, so far. */
  lines: number;
  clearDowns: number;
  /** Playing to clear rows until the stack is back under half height. */
  rescue: boolean;
  /** Seconds into `drop`. */
  time: number;
  readonly drop: Drop;
}

function emptyDrop(): Drop {
  return {
    piece: -1,
    colour: 0,
    spawnRot: 0,
    rot: 0,
    spawnX: 0,
    startX: 0,
    x: 0,
    topY: 0,
    y: 0,
    tick: 1,
    slide: SLIDE,
    rotateAt: 0,
    shiftAt: 0,
    fallAt: 0,
    landAt: 0,
    settleAt: 0,
    end: 0,
    glow: GLOW,
    settle: SETTLE_MIN,
    cleared: new Uint8Array(WELL_H),
    clearedCount: 0,
    points: 0,
    advanced: false,
  };
}

/** Draws the next piece from the bags. */
function drawPiece(well: Well): number {
  const n = PIECES.length;
  const i = well.drawn % n;
  if (i === 0) {
    bagOrder(well.seed, well.drawn / n, well.bag);
  }
  well.drawn++;
  return well.bag[i];
}

/** A colour other than `previous`. */
function nextColour(well: Well, previous: number): number {
  return (previous + 1 + Math.floor(rand(well.seed, well.drawn, 7) * (COLOURS - 1))) % COLOURS;
}

/**
 * A new well for `seed` and its `index` (each well plays its own game), empty
 * and with its first piece appearing at the given speed and skill.
 */
export function createWell(seed: number, index: number, speed: number, skill: number): Well {
  const well: Well = {
    seed: hash32(Math.imul(Math.floor(seed), 0x2545f491) ^ hash32(index + 0x1b873593)),
    board: new Uint8Array(WELL_W * WELL_H),
    drawn: 0,
    bag: new Uint8Array(PIECES.length),
    next: new Int8Array(2),
    nextColour: new Int8Array(2),
    score: 0,
    lines: 0,
    clearDowns: 0,
    rescue: false,
    time: 0,
    drop: emptyDrop(),
  };
  well.next[0] = drawPiece(well);
  well.nextColour[0] = nextColour(well, Math.floor(rand(well.seed, 0, 3) * COLOURS));
  well.next[1] = drawPiece(well);
  well.nextColour[1] = nextColour(well, well.nextColour[0]);
  spawn(well, speed, skill);
  return well;
}

/** The stack's height: one above the highest filled row. */
export function stackHeight(board: Uint8Array): number {
  for (let y = WELL_H - 1; y >= 0; y--) {
    for (let x = 0; x < WELL_W; x++) {
      if (board[y * WELL_W + x] !== 0) {
        return y + 1;
      }
    }
  }
  return 0;
}

/** Whether `rot` fits with its bottom-left cell box at (`x`, `y`). */
export function fits(board: Uint8Array, rot: Rotation, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x + rot.width > WELL_W || y + rot.height > WELL_H) {
    return false;
  }
  const c = rot.cells;
  for (let i = 0; i < c.length; i += 2) {
    if (board[(y + c[i + 1]) * WELL_W + x + c[i]] !== 0) {
      return false;
    }
  }
  return true;
}

/** The row `rot` comes to rest on, dropped straight down column `x` from the top; -1 if it can't appear there. */
export function dropRow(board: Uint8Array, rot: Rotation, x: number): number {
  let y = WELL_H - rot.height;
  if (!fits(board, rot, x, y)) {
    return -1;
  }
  while (y > 0 && fits(board, rot, x, y - 1)) {
    y--;
  }
  return y;
}

/** Scratch for the AI's trial placements. */
const trial = new Uint8Array(WELL_W * WELL_H);
const heights = new Int8Array(WELL_W);

/** Feature weights: the well-known hand-tuned set for line-clearing AIs. */
const W_HEIGHT = -0.51;
const W_LINES = 0.76;
const W_HOLES = -0.36;
const W_BUMP = -0.18;
/** In rescue: clearing counts this many times over, and each row of peak height costs this. */
const RESCUE_LINES = 4;
const W_RESCUE_PEAK = -0.6;
/** Noise added to each candidate's score at skill 0, either way; it falls with (1 - skill)^2. */
const NOISE = 6;
/** In rescue the noise is scaled by this, so even a careless AI digs itself out. */
const RESCUE_NOISE = 0.2;

/** Writes `board` with `rot` placed at (x, y) in colour `value` into `out`. */
function place(
  board: Uint8Array,
  rot: Rotation,
  x: number,
  y: number,
  value: number,
  out: Uint8Array,
): void {
  out.set(board);
  const c = rot.cells;
  for (let i = 0; i < c.length; i += 2) {
    out[(y + c[i + 1]) * WELL_W + x + c[i]] = value;
  }
}

/** Whether row `y` of `board` is full. */
const rowFull = (board: Uint8Array, y: number) => {
  for (let x = 0; x < WELL_W; x++) {
    if (board[y * WELL_W + x] === 0) {
      return false;
    }
  }
  return true;
};

/** Scratch: 1 for each full row of the trial board. */
const fullRows = new Uint8Array(WELL_H);

/** The AI's score for `board` after a placement that cleared `lines` rows (full rows still in it). */
function evaluate(board: Uint8Array, lines: number, rescue: boolean): number {
  for (let y = 0; y < WELL_H; y++) {
    fullRows[y] = lines > 0 && rowFull(board, y) ? 1 : 0;
  }
  // Column heights and holes among the rows that stay.
  let holes = 0;
  let agg = 0;
  let bump = 0;
  let peak = 0;
  for (let x = 0; x < WELL_W; x++) {
    let h = 0;
    let empty = 0;
    let row = 0;
    for (let y = 0; y < WELL_H; y++) {
      if (fullRows[y] !== 0) {
        continue;
      }
      row++;
      if (board[y * WELL_W + x] !== 0) {
        h = row;
        holes += empty;
        empty = 0;
      } else {
        empty++;
      }
    }
    heights[x] = h;
    agg += h;
    peak = Math.max(peak, h);
    if (x > 0) {
      bump += Math.abs(h - heights[x - 1]);
    }
  }
  return (
    W_HEIGHT * agg +
    W_LINES * lines * (rescue ? RESCUE_LINES : 1) +
    W_HOLES * holes +
    W_BUMP * bump +
    (rescue ? W_RESCUE_PEAK * peak : 0)
  );
}

/** A placement: rotation, column and landing row. */
export interface Placement {
  rot: number;
  x: number;
  y: number;
}

/**
 * The AI's pick for `piece` on `board`: every rotation in every column,
 * dropped straight down from the top, scored on the board it leaves (aggregate
 * height, holes, bumpiness, rows cleared), plus seeded noise that grows as
 * `skill` falls (lower skill leaves more holes). In `rescue` it weights
 * clearing and a low peak heavily and the noise lightly. Writes `out`, and
 * returns false if the piece fits nowhere (never so below `CLEARDOWN_HEIGHT`).
 */
export function choosePlacement(
  board: Uint8Array,
  piece: number,
  skill: number,
  rescue: boolean,
  noiseSeed: number,
  out: Placement,
): boolean {
  const rots = PIECES[piece].rotations;
  const k = 1 - clamp(Number.isFinite(skill) ? skill : 1, 0, 1);
  const noise = NOISE * k * k * (rescue ? RESCUE_NOISE : 1);
  let best = -Infinity;
  let found = false;
  let candidate = 0;
  for (let r = 0; r < rots.length; r++) {
    const rot = rots[r];
    for (let x = 0; x + rot.width <= WELL_W; x++) {
      const y = dropRow(board, rot, x);
      candidate++;
      if (y < 0) {
        continue;
      }
      place(board, rot, x, y, 1, trial);
      let lines = 0;
      for (let yy = y; yy < y + rot.height; yy++) {
        if (rowFull(trial, yy)) {
          lines++;
        }
      }
      let score = evaluate(trial, lines, rescue);
      if (noise > 0) {
        score += noise * (2 * rand(noiseSeed, candidate, 11) - 1);
      }
      if (score > best) {
        best = score;
        out.rot = r;
        out.x = x;
        out.y = y;
        found = true;
      }
    }
  }
  return found;
}

const chosen: Placement = { rot: 0, x: 0, y: 0 };

/** Plans a clear-down of the bottom rows, bringing a stack of `height` down to `SAFE_HEIGHT`. */
function planClearDown(well: Well, height: number): void {
  const d = well.drop;
  d.piece = -1;
  d.advanced = false;
  d.cleared.fill(0);
  d.clearedCount = Math.max(1, height - SAFE_HEIGHT);
  for (let y = 0; y < d.clearedCount; y++) {
    d.cleared[y] = 1;
  }
  d.points = 0;
  d.rotateAt = d.shiftAt = d.fallAt = 0;
  d.landAt = CLEARDOWN_PAUSE;
  d.glow = CLEARDOWN_GLOW;
  d.settle = settleTime(d.clearedCount);
  d.settleAt = d.landAt + CLEARDOWN_GLOW + CLEARDOWN_SHRINK;
  d.end = d.settleAt + d.settle + CLEARDOWN_PAUSE;
  well.clearDowns++;
}

/** Starts the next drop: a clear-down if the stack is too high, else the next piece. */
function spawn(well: Well, speed: number, skill: number): void {
  const board = well.board;
  const height = stackHeight(board);
  if (height >= RESCUE_HEIGHT) {
    well.rescue = true;
  } else if (height < SAFE_HEIGHT) {
    well.rescue = false;
  }
  if (height >= CLEARDOWN_HEIGHT) {
    planClearDown(well, height);
    return;
  }
  const piece = well.next[0];
  const colour = well.nextColour[0];
  if (!choosePlacement(board, piece, skill, well.rescue, hash32(well.seed ^ well.drawn), chosen)) {
    // Unreachable below CLEARDOWN_HEIGHT; clear down rather than end the game.
    planClearDown(well, Math.max(height, SAFE_HEIGHT + 1));
    return;
  }
  well.next[0] = well.next[1];
  well.nextColour[0] = well.nextColour[1];
  well.next[1] = drawPiece(well);
  well.nextColour[1] = nextColour(well, well.nextColour[0]);

  const d = well.drop;
  const rots = PIECES[piece].rotations;
  const v = effectiveSpeed(speed);
  d.piece = piece;
  d.colour = colour;
  d.advanced = true;
  d.spawnRot = spawnRotation(piece);
  d.rot = chosen.rot;
  d.spawnX = spawnColumn(rots[d.spawnRot]);
  d.startX = spawnColumn(rots[d.rot]);
  d.x = chosen.x;
  d.topY = WELL_H - rots[d.rot].height;
  d.y = chosen.y;
  d.tick = 1 / v;
  d.slide = slideTime(v);
  // Appear (one tick), turn (one tick, if it turns), slide across, fall.
  d.rotateAt = d.tick;
  d.shiftAt = d.rotateAt + (d.rot === d.spawnRot ? 0 : d.tick);
  d.fallAt = d.shiftAt + Math.abs(d.x - d.startX) * d.tick;
  const rows = d.topY - d.y;
  d.landAt = rows > 0 ? d.fallAt + (rows - 1) * d.tick + d.slide : d.fallAt;

  place(board, rots[d.rot], d.x, d.y, colour + 1, trial);
  d.cleared.fill(0);
  d.clearedCount = 0;
  for (let y = d.y; y < d.y + rots[d.rot].height; y++) {
    if (rowFull(trial, y)) {
      d.cleared[y] = 1;
      d.clearedCount++;
    }
  }
  d.points = POINTS[d.clearedCount];
  d.glow = GLOW;
  if (d.clearedCount > 0) {
    d.settle = settleTime(d.clearedCount);
    d.settleAt = d.landAt + GLOW + SHRINK;
    d.end = d.settleAt + d.settle + 0.5 * d.tick;
  } else {
    d.settle = 0;
    d.settleAt = d.landAt;
    d.end = d.landAt + 0.5 * d.tick;
  }
}

/** Ends the current drop: locks the piece, removes the cleared rows and banks the points. */
function commit(well: Well): void {
  const d = well.drop;
  const board = well.board;
  if (d.piece >= 0) {
    place(board, PIECES[d.piece].rotations[d.rot], d.x, d.y, d.colour + 1, trial);
    board.set(trial);
    well.score += d.points;
    well.lines += d.clearedCount;
  }
  let to = 0;
  for (let y = 0; y < WELL_H; y++) {
    if (d.cleared[y] === 0) {
      if (to !== y) {
        board.copyWithin(to * WELL_W, y * WELL_W, (y + 1) * WELL_W);
      }
      to++;
    }
  }
  board.fill(0, to * WELL_W);
}

/**
 * Advances the well by `dt` seconds: drops that end are committed and the next
 * ones start, each latching `speed` (rows a second) and `skill`.
 */
export function stepWell(well: Well, dt: number, speed: number, skill: number): void {
  if (!(dt > 0) || !Number.isFinite(dt)) {
    return;
  }
  well.time += dt;
  while (well.time >= well.drop.end) {
    well.time -= well.drop.end;
    commit(well);
    spawn(well, speed, skill);
  }
}

/** The falling piece's place at a drop's local time `t`: cell-box origin, opacity and turn. */
export interface PiecePose {
  x: number;
  y: number;
  /** Opacity of the whole piece (it fades in as it appears). */
  alpha: number;
  /** Weight of `rot` against `spawnRot` in the turn's crossfade, 0..1. */
  turn: number;
  /** Where `spawnRot` sits while it fades out. */
  spawnX: number;
  spawnY: number;
}

/** Smoothstep of how far `t` is through a glide starting at `start` and lasting `length`. */
export function glide(t: number, start: number, length: number): number {
  const u = clamp((t - start) / length, 0, 1);
  return u * u * (3 - 2 * u);
}

/** Position of a run of one-cell steps from `from` towards `to`, one a tick from `start`. */
function steps(t: number, from: number, to: number, start: number, d: Drop): number {
  const n = Math.abs(to - from);
  if (n === 0) {
    return from;
  }
  const k = clamp(Math.floor((t - start) / d.tick), 0, n - 1);
  const done = t < start ? 0 : k + glide(t, start + k * d.tick, d.slide);
  return from + Math.sign(to - from) * Math.min(n, done);
}

/** Writes the falling piece's pose at local time `t` into `out` (meaningless for a clear-down). */
export function piecePose(d: Drop, t: number, out: PiecePose): PiecePose {
  const rots = PIECES[Math.max(0, d.piece)].rotations;
  const appear = glide(t, 0, d.slide);
  const turn = d.rot === d.spawnRot ? 1 : glide(t, d.rotateAt, d.slide);
  const x = t < d.shiftAt ? d.startX : steps(t, d.startX, d.x, d.shiftAt, d);
  const y = t < d.fallAt ? d.topY : steps(t, d.topY, d.y, d.fallAt, d);
  // It glides in from one row above the top.
  out.x = x;
  out.y = y + 1 - appear;
  out.alpha = appear;
  out.turn = turn;
  out.spawnX = d.spawnX;
  out.spawnY = WELL_H - rots[d.spawnRot].height + 1 - appear;
  return out;
}

/** The score shown at local time `t`: the banked score, plus this drop's points counting up. */
export function shownScore(well: Well, t: number): number {
  const d = well.drop;
  if (d.points === 0) {
    return well.score;
  }
  return well.score + Math.round((d.points * glide(t, d.landAt, COUNT_UP)) / 10) * 10;
}
