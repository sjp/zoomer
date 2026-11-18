/**
 * Where Block Cascade's wells sit, and the sprites that draw them: one list of
 * cells and panels a frame, built from each well's board and its current drop
 * at the drop's local time. Pure, so the layout and the frame's brightness can
 * be tested without a GPU.
 */
import { PIECES } from "./blockcascade-pieces";
import {
  glide,
  piecePose,
  type PiecePose,
  spawnRotation,
  type Well,
  WELL_H,
  WELL_W,
} from "./blockcascade-sim";

/** Floats per sprite: centre x, y and half width, height (px, y down), then opacity, glow, colour, kind. */
export const STRIDE = 8;
/** Sprite kinds. */
const KIND_CELL = 0;
const KIND_PANEL = 1;
/** Two wells' cells, falling pieces (twice while turning), previews (twice while moving on) and panels. */
export const MAX_SPRITES = 2 * (WELL_W * WELL_H + 2 * 5 + 4 * 5 + 2);

/** How far a glowing cell's colour moves towards white at full glow; the shader uses the same. */
export const GLOW_GAIN = 0.45;
/** Seconds the next-piece previews crossfade when they move on. */
const PREVIEW_FADE = 0.4;

/** In cells: the frame round the well, the header's height and the gap under it. */
const PAD = 0.3;
const HEADER_H = 2.2;
const HEADER_GAP = 0.35;
/** Preview cells, as a share of a well cell, and the previews' slots (cells from the header's left). */
const PREVIEW_CELL = 0.36;
const PREVIEW_SLOTS = [5.55, 7.75] as const;
/** The whole stack's height, cells: header, gap, framed well. */
const STACK_H = HEADER_H + HEADER_GAP + WELL_H + 2 * PAD;
/** Half the framed well's width, cells. */
const HALF_W = WELL_W / 2 + PAD;

/** The well's height as a share of the frame's, landscape; and in portrait, where it sits low. */
const WELL_SHARE = 0.76;
const PORTRAIT_SHARE = 0.58;
const PORTRAIT_BOTTOM = 0.04;
/** Two wells need at least this aspect; narrower frames show one. */
const TWO_WELL_ASPECT = 1.2;
/** The framed well keeps this share of its third clear on each side. */
const THIRD_MARGIN = 0.06;

/** One well's place on the canvas, px, y down. */
interface WellBox {
  /** The well's inside: top-left corner. */
  x: number;
  y: number;
  /** The header (score and next pieces) above it: top-left and size, framed like the well. */
  headerX: number;
  headerY: number;
  headerW: number;
  headerH: number;
}

interface Layout {
  /** Wells shown: 1 or 2. */
  count: number;
  /** A cell's size, px. */
  cell: number;
  /** The frame round the well, px. */
  pad: number;
  readonly boxes: [WellBox, WellBox];
}

const box = (): WellBox => ({ x: 0, y: 0, headerX: 0, headerY: 0, headerW: 0, headerH: 0 });

export const createLayout = (): Layout => ({ count: 1, cell: 1, pad: 0, boxes: [box(), box()] });

/** Places a well's stack centred on `cx` with its top at `top`. */
function placeBox(b: WellBox, cx: number, top: number, cell: number) {
  b.headerX = cx - HALF_W * cell;
  b.headerY = top;
  b.headerW = 2 * HALF_W * cell;
  b.headerH = HEADER_H * cell;
  b.x = cx - (WELL_W / 2) * cell;
  b.y = top + (HEADER_H + HEADER_GAP + PAD) * cell;
}

/**
 * Lays out the wells for a `width` x `height` frame: two in the outer thirds
 * when there's room (`two` asked for and the frame wide enough), else one,
 * centred, and low in a portrait frame.
 */
export function layoutWells(width: number, height: number, two: boolean, out: Layout): Layout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const fitHeight = Math.min((WELL_SHARE * h) / WELL_H, (0.96 * h) / STACK_H);
  if (two && w >= TWO_WELL_ASPECT * h) {
    const third = w / 3;
    const cell = Math.min(fitHeight, (third * (1 - 2 * THIRD_MARGIN)) / (2 * HALF_W));
    const top = (h - STACK_H * cell) / 2;
    out.count = 2;
    out.cell = cell;
    placeBox(out.boxes[0], third / 2, top, cell);
    placeBox(out.boxes[1], w - third / 2, top, cell);
  } else if (h > w) {
    const cell = Math.min((PORTRAIT_SHARE * h) / WELL_H, (0.86 * w) / (2 * HALF_W));
    const top = h * (1 - PORTRAIT_BOTTOM) - STACK_H * cell;
    out.count = 1;
    out.cell = cell;
    placeBox(out.boxes[0], w / 2, top, cell);
  } else {
    const cell = Math.min(fitHeight, (0.86 * w) / (2 * HALF_W));
    out.count = 1;
    out.cell = cell;
    placeBox(out.boxes[0], w / 2, (h - STACK_H * cell) / 2, cell);
  }
  out.pad = PAD * out.cell;
  return out;
}

/** Where a header's text goes, px: the left edges of the score and of NEXT, and the rows' centres. */
export interface HeaderText {
  x: number;
  nextX: number;
  labelY: number;
  scoreY: number;
}

export function headerText(b: WellBox, cell: number, out: HeaderText): HeaderText {
  out.x = b.headerX + 0.45 * cell;
  out.nextX = b.headerX + 4.6 * cell;
  out.labelY = b.headerY + 0.6 * cell;
  out.scoreY = b.headerY + 1.45 * cell;
  return out;
}

/** The sprites of one frame. */
interface Scene {
  readonly data: Float32Array;
  count: number;
}

export const createScene = (): Scene => ({
  data: new Float32Array(MAX_SPRITES * STRIDE),
  count: 0,
});

function put(
  scene: Scene,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  alpha: number,
  glow: number,
  colour: number,
  kind: number,
) {
  if (!(alpha > 0.002) || scene.count >= MAX_SPRITES) {
    return;
  }
  const o = scene.count * STRIDE;
  const d = scene.data;
  d[o] = cx;
  d[o + 1] = cy;
  d[o + 2] = hw;
  d[o + 3] = hh;
  d[o + 4] = alpha;
  d[o + 5] = glow;
  d[o + 6] = colour;
  d[o + 7] = kind;
  scene.count++;
}

const pose: PiecePose = { x: 0, y: 0, alpha: 0, turn: 0, spawnX: 0, spawnY: 0 };
/** Rows each row falls by once the drop's cleared rows go. */
const fallBy = new Int8Array(WELL_H);

/** Draws a piece's rotation `rot` with its cell box at grid (gx, gy). */
function putPiece(
  scene: Scene,
  b: WellBox,
  cell: number,
  piece: number,
  rot: number,
  gx: number,
  gy: number,
  colour: number,
  alpha: number,
) {
  const c = PIECES[piece].rotations[rot].cells;
  for (let i = 0; i < c.length; i += 2) {
    const x = b.x + (gx + c[i] + 0.5) * cell;
    const y = b.y + (WELL_H - gy - c[i + 1] - 0.5) * cell;
    put(scene, x, y, cell / 2, cell / 2, alpha, 0, colour, KIND_CELL);
  }
}

/** Draws a next-piece preview centred in slot `slot` of the header. */
function putPreview(
  scene: Scene,
  b: WellBox,
  cell: number,
  slot: number,
  piece: number,
  colour: number,
  alpha: number,
) {
  const rot = PIECES[piece].rotations[spawnRotation(piece)];
  const p = PREVIEW_CELL * cell;
  const cx = b.headerX + PREVIEW_SLOTS[slot] * cell;
  const cy = b.headerY + 1.3 * cell;
  const c = rot.cells;
  for (let i = 0; i < c.length; i += 2) {
    const x = cx + (c[i] + 0.5 - rot.width / 2) * p;
    const y = cy - (c[i + 1] + 0.5 - rot.height / 2) * p;
    put(scene, x, y, p / 2, p / 2, alpha, 0, colour, KIND_CELL);
  }
}

/**
 * Draws a settled cell at grid (gx, gy): in a cleared row (once landed) it
 * glows, then shrinks and fades; above one it eases down as the rows go.
 */
function putBoardCell(
  scene: Scene,
  b: WellBox,
  cell: number,
  cleared: Uint8Array,
  gx: number,
  gy: number,
  colour: number,
  alpha: number,
  landed: boolean,
  glow: number,
  shrink: number,
  settle: number,
) {
  let a = alpha;
  let g = 0;
  let half = cell / 2;
  let row = gy;
  if (landed && cleared[gy] !== 0) {
    g = glow;
    half *= 1 - 0.85 * shrink;
    a *= 1 - shrink;
  } else {
    row = gy - fallBy[gy] * settle;
  }
  const x = b.x + (gx + 0.5) * cell;
  const y = b.y + (WELL_H - row - 0.5) * cell;
  put(scene, x, y, half, half, a, g, colour, KIND_CELL);
}

/**
 * Adds one well's sprites at its drop's local time: its panels, the board
 * (cleared rows glowing, shrinking and fading, the rows above easing down),
 * the falling piece and the next two pieces, all at opacity `alpha`.
 */
export function buildWell(scene: Scene, well: Well, b: WellBox, cell: number, alpha: number) {
  const d = well.drop;
  const t = well.time;
  const pad = PAD * cell;
  // The well's frame and the header's.
  put(
    scene,
    b.x + (WELL_W / 2) * cell,
    b.y + (WELL_H / 2) * cell,
    (WELL_W / 2) * cell + pad,
    (WELL_H / 2) * cell + pad,
    alpha,
    0,
    0,
    KIND_PANEL,
  );
  put(
    scene,
    b.headerX + b.headerW / 2,
    b.headerY + b.headerH / 2,
    b.headerW / 2,
    b.headerH / 2,
    alpha,
    0,
    0,
    KIND_PANEL,
  );

  const landed = d.piece < 0 || t >= d.landAt;
  const cleared = landed && d.clearedCount > 0;
  const glow = cleared ? glide(t, d.landAt, d.glow) : 0;
  const shrink = cleared ? glide(t, d.landAt + d.glow, d.settleAt - d.landAt - d.glow) : 0;
  const settle = d.settle > 0 ? glide(t, d.settleAt, d.settle) : 0;
  let below = 0;
  for (let y = 0; y < WELL_H; y++) {
    fallBy[y] = below;
    below += d.cleared[y];
  }
  const board = well.board;
  for (let gy = 0; gy < WELL_H; gy++) {
    for (let gx = 0; gx < WELL_W; gx++) {
      const v = board[gy * WELL_W + gx];
      if (v !== 0) {
        putBoardCell(scene, b, cell, d.cleared, gx, gy, v - 1, alpha, landed, glow, shrink, settle);
      }
    }
  }

  if (d.piece >= 0) {
    if (landed) {
      const c = PIECES[d.piece].rotations[d.rot].cells;
      for (let i = 0; i < c.length; i += 2) {
        putBoardCell(
          scene,
          b,
          cell,
          d.cleared,
          d.x + c[i],
          d.y + c[i + 1],
          d.colour,
          alpha,
          landed,
          glow,
          shrink,
          settle,
        );
      }
    } else {
      piecePose(d, t, pose);
      putPiece(
        scene,
        b,
        cell,
        d.piece,
        d.rot,
        pose.x,
        pose.y,
        d.colour,
        alpha * pose.alpha * pose.turn,
      );
      if (pose.turn < 1) {
        putPiece(
          scene,
          b,
          cell,
          d.piece,
          d.spawnRot,
          pose.spawnX,
          pose.spawnY,
          d.colour,
          alpha * pose.alpha * (1 - pose.turn),
        );
      }
    }
  }

  // The next two pieces; when they've just moved on, the old pair fades out.
  const f = d.advanced ? glide(t, 0, PREVIEW_FADE) : 1;
  putPreview(scene, b, cell, 0, well.next[0], well.nextColour[0], alpha * f);
  putPreview(scene, b, cell, 1, well.next[1], well.nextColour[1], alpha * f);
  if (f < 1) {
    putPreview(scene, b, cell, 0, d.piece, d.colour, alpha * (1 - f));
    putPreview(scene, b, cell, 1, well.next[0], well.nextColour[0], alpha * (1 - f));
  }
}

/**
 * The cells' share of the frame's mean brightness (0..1 display values), given
 * each colour's luma: their area times opacity times their glowing luma. The
 * background and panels hold still, so changes in this are the frame's changes.
 */
export function meanLevel(
  scene: Scene,
  lumas: ArrayLike<number>,
  width: number,
  height: number,
): number {
  let sum = 0;
  const d = scene.data;
  for (let i = 0; i < scene.count; i++) {
    const o = i * STRIDE;
    if (d[o + 7] !== KIND_CELL) {
      continue;
    }
    const lum = lumas[d[o + 6]];
    const g = d[o + 5] * GLOW_GAIN;
    sum += 4 * d[o + 2] * d[o + 3] * d[o + 4] * (lum + (1 - lum) * g);
  }
  return sum / (Math.max(1, width) * Math.max(1, height));
}
