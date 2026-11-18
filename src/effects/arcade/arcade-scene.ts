/**
 * What the arcade game shows at a moment of the attract loop, as a list of
 * sprites for the low-res game image: the starfield, then the phase's
 * contents (the title logo, the demo, the high-score table or INSERT COIN),
 * and during a phase change both phases, each masked by the scanline wipe.
 * Pure, so a test can add up a frame's brightness.
 *
 * Positions are game px, y down. Each sprite is `STRIDE` floats: centre and
 * half size, the atlas rect (px), the premultiplied tint, the wipe layer, and
 * the spin pair (angle, flip) `createSpriteBatch` appends for rotation.
 */
import { hexesToUnitRgb } from "../color";
import { GLYPH_H } from "../dot-matrix";
import { clamp, smoothstep } from "../math";
import {
  ARCADE_PALETTE,
  CELL,
  type Cell,
  CYCLE,
  GLYPH_ADVANCE,
  glyphCell,
  type LogoLayout,
  luma,
  textWidth,
} from "./arcade-art";
import {
  CRATE_FADE,
  debrisPosition,
  type DemoPlan,
  minePosition,
  ordinal,
  PHASES,
  type PhaseState,
  phaseAt,
  type ScoreRow,
  scoreAt,
  STAR_COUNT,
  STAR_LEVELS,
  starAt,
  tugAt,
  WIPE_SECONDS,
  blinkLevel,
} from "./arcade-sim";

/** Floats per sprite: centre, half size, atlas rect, tint, layer, then angle and flip. */
export const STRIDE = 15;
export const MAX_SPRITES = 1400;

/** Wipe layers: always shown, the incoming phase (above the wipe's front) and the outgoing one (below). */
const SHOWN = 0;
const INCOMING = 1;
const OUTGOING = 2;
/** Lines over which the wipe's front fades from one phase to the other. */
export const WIPE_SOFT = 8;

/** Margin from the screen's edges for text, px: clear of the tube's curve. */
const MARGIN = 12;

/** One framing's game: its size and everything laid out for it. */
export interface GameView {
  width: number;
  height: number;
  /** Text in the outer thirds, round the speaker. */
  wide: boolean;
  seed: number;
  plan: DemoPlan;
  logo: LogoLayout;
  /** The logo's top-left, px. */
  logoX: number;
  logoY: number;
  /** The high-score table: each row's text, and where each row goes and at what scale. */
  rows: string[];
  owner: boolean;
  rowX: Float32Array;
  rowY: Float32Array;
  rowScale: number;
}

/** Text scale and spacing of the high-score table, and where each row goes. */
function layoutRows(view: GameView, chars: number): void {
  const { width: w, height: h, wide } = view;
  const n = view.rows.length;
  if (wide) {
    const perColumn = Math.ceil(n / 2);
    const top = Math.round(h * 0.3);
    const spacing = Math.max(10, Math.min(18, Math.floor((h - MARGIN - 10 - top) / perColumn)));
    const scale = textWidth(chars, 2) <= (w / 3) * 0.9 && spacing >= 22 ? 2 : 1;
    const tw = textWidth(chars, scale);
    for (let i = 0; i < n; i++) {
      const col = i < perColumn ? 0 : 1;
      view.rowX[i] = Math.round((col === 0 ? w / 6 : (5 * w) / 6) - tw / 2);
      view.rowY[i] = top + (i % perColumn) * spacing;
    }
    view.rowScale = scale;
    return;
  }
  let scale = 1;
  for (const s of [3, 2]) {
    if (textWidth(chars, s) <= w * 0.9 && h * 0.24 + n * 14 * s <= h - MARGIN - 4) {
      scale = s;
      break;
    }
  }
  const spacing = 14 * scale;
  const top = Math.round(Math.min(h * 0.24, h - MARGIN - n * spacing));
  const x = Math.round((w - textWidth(chars, scale)) / 2);
  for (let i = 0; i < n; i++) {
    view.rowX[i] = x;
    view.rowY[i] = top + i * spacing;
  }
  view.rowScale = scale;
}

/** A row of the table: rank, initials and a six-digit score. */
const rowText = (i: number, r: ScoreRow) =>
  `${ordinal(i + 1).padEnd(4)} ${r.name.padEnd(3)}  ${String(r.score).padStart(6, "0")}`;

/** Lays a view out: the logo's position and the table's rows. */
export function createView(
  width: number,
  height: number,
  seed: number,
  plan: DemoPlan,
  logo: LogoLayout,
  scores: readonly ScoreRow[],
  wide: boolean,
): GameView {
  const view: GameView = {
    width,
    height,
    wide,
    seed,
    plan,
    logo,
    logoX: Math.round((width - logo.cols * logo.size) / 2),
    logoY: Math.round(height * (wide ? 0.16 : 0.2)),
    rows: scores.map((r, i) => rowText(i, r)),
    owner: scores[0]?.owner ?? false,
    rowX: new Float32Array(scores.length),
    rowY: new Float32Array(scores.length),
    rowScale: 1,
  };
  layoutRows(view, Math.max(0, ...view.rows.map((r) => r.length)));
  return view;
}

/** The sprites of one frame. */
interface Scene {
  data: Float32Array;
  /** Each sprite's light: cell luminance x tint luminance x opacity x area. */
  light: Float32Array;
  count: number;
  /** The wipe's front, px from the top (past the bottom when no wipe is under way). */
  front: number;
}

export function createScene(): Scene {
  return {
    data: new Float32Array(MAX_SPRITES * STRIDE),
    light: new Float32Array(MAX_SPRITES),
    count: 0,
    front: 1e6,
  };
}

const RGB = hexesToUnitRgb(ARCADE_PALETTE);
const WHITE = 5;
const PALE = 4;
const SKY = 11;
const ORANGE = 7;
const YELLOW = 8;
/** The table's colour per rank. */
const ROW_COLOURS = [8, 7, 6, 14, 13, 12, 11, 10, 9, 4] as const;

/** Scratch for positions; nothing is allocated per frame. */
const pos = new Float64Array(4);
const minePos = [0, 0];
const phase: PhaseState = { index: 0, local: 0 };
const tint = new Float32Array(3);

function put(
  scene: Scene,
  cells: readonly Cell[],
  cell: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number,
  layer: number,
  angle = 0,
): void {
  if (scene.count >= MAX_SPRITES || a <= 0.002) {
    return;
  }
  const c = cells[cell];
  const o = scene.count * STRIDE;
  const d = scene.data;
  d[o] = cx;
  d[o + 1] = cy;
  d[o + 2] = w / 2;
  d[o + 3] = h / 2;
  d[o + 4] = c.x;
  d[o + 5] = c.y;
  d[o + 6] = c.x + c.w;
  d[o + 7] = c.y + c.h;
  d[o + 8] = r * a;
  d[o + 9] = g * a;
  d[o + 10] = b * a;
  d[o + 11] = a;
  d[o + 12] = layer;
  d[o + 13] = angle;
  d[o + 14] = 1;
  scene.light[scene.count] = c.lum * luma(r * 255, g * 255, b * 255) * a * w * h;
  scene.count++;
}

/** An unrotated sprite at its cell's size, scaled, with its top-left at (x, y). */
function putAt(
  scene: Scene,
  cells: readonly Cell[],
  cell: number,
  x: number,
  y: number,
  scale: number,
  colour: number,
  a: number,
  layer: number,
): void {
  const c = cells[cell];
  const w = c.w * scale;
  const h = c.h * scale;
  const k = colour * 3;
  put(scene, cells, cell, x + w / 2, y + h / 2, w, h, RGB[k], RGB[k + 1], RGB[k + 2], a, layer);
}

/** A line of text with its top-left at (x, y). */
function text(
  scene: Scene,
  cells: readonly Cell[],
  str: string,
  x: number,
  y: number,
  scale: number,
  colour: number,
  a: number,
  layer: number,
): void {
  for (let i = 0; i < str.length; i++) {
    const cell = glyphCell(str[i]);
    if (cell >= 0) {
      putAt(scene, cells, cell, x + i * GLYPH_ADVANCE * scale, y, scale, colour, a, layer);
    }
  }
}

/** `value` as `digits` zero-padded digits with the top-left at (x, y). */
function number(
  scene: Scene,
  cells: readonly Cell[],
  value: number,
  digits: number,
  x: number,
  y: number,
  colour: number,
  a: number,
  layer: number,
): void {
  let v = Math.max(0, Math.floor(value));
  for (let i = digits - 1; i >= 0; i--) {
    putAt(scene, cells, glyphCell("0") + (v % 10), x + i * GLYPH_ADVANCE, y, 1, colour, a, layer);
    v = Math.floor(v / 10);
  }
}

/** "CREDIT 0" in the bottom-right corner. */
function credit(scene: Scene, cells: readonly Cell[], view: GameView, layer: number): void {
  const s = "CREDIT 0";
  const x = view.width - MARGIN - textWidth(s.length, 1);
  text(scene, cells, s, x, view.height - MARGIN - GLYPH_H, 1, PALE, 0.85, layer);
}

/** The logo's colour for dot column `col` at `local` s: a slow cycle through the palette. */
function cycleColour(col: number, local: number): void {
  const p = col * 0.05 + local * 0.3;
  const i = Math.floor(p);
  const f = smoothstep(0, 1, p - i);
  const a = CYCLE[i % CYCLE.length] * 3;
  const b = CYCLE[(i + 1) % CYCLE.length] * 3;
  for (let c = 0; c < 3; c++) {
    tint[c] = RGB[a + c] + (RGB[b + c] - RGB[a + c]) * f;
  }
}

function drawTitle(
  scene: Scene,
  cells: readonly Cell[],
  view: GameView,
  local: number,
  layer: number,
): void {
  const logo = view.logo;
  const s = logo.size;
  const cell = CELL.block1 + s - 1;
  for (let i = 0; i < logo.count; i++) {
    const col = logo.dots[i * 2];
    const row = logo.dots[i * 2 + 1];
    cycleColour(col, local);
    const x = view.logoX + col * s;
    const y = view.logoY + row * s;
    put(scene, cells, cell, x + s / 2, y + s / 2, s, s, tint[0], tint[1], tint[2], 1, layer);
  }
  // "© 198X", centred below.
  const label = " 198X";
  const width = cells[CELL.copyright].w + textWidth(label.length, 1);
  const x = Math.round((view.width - width) / 2);
  const y = Math.round(view.height * 0.8);
  putAt(scene, cells, CELL.copyright, x, y, 1, PALE, 0.9, layer);
  text(scene, cells, label, x + cells[CELL.copyright].w, y, 1, PALE, 0.9, layer);
  credit(scene, cells, view, layer);
}

/** Seconds a collected crate's sparkle lasts, and its sparks. */
const SPARKLE = 0.6;
const SPARKS = 6;

function drawDemo(
  scene: Scene,
  cells: readonly Cell[],
  view: GameView,
  t: number,
  layer: number,
): void {
  const plan = view.plan;
  // Debris, dim, behind everything.
  for (const d of plan.debris) {
    debrisPosition(d, plan, t, pos);
    const c = cells[CELL.debris0 + d.kind];
    put(
      scene,
      cells,
      CELL.debris0 + d.kind,
      pos[0],
      pos[1],
      c.w,
      c.h,
      0.62,
      0.62,
      0.66,
      1,
      layer,
      pos[2],
    );
  }
  // Crates fade in, glow gently and burst into a small sparkle when collected.
  const crate = cells[CELL.crate];
  for (let k = 0; k < plan.crates; k++) {
    const tin = plan.crateIn[k];
    const tout = plan.crateOut[k];
    const x = Math.round(plan.crateX[k]);
    const y = Math.round(plan.crateY[k]);
    if (t >= tin && t < tout) {
      const a = smoothstep(tin, tin + CRATE_FADE, t);
      const glow = 0.82 + 0.18 * Math.sin(Math.PI * t + k);
      put(scene, cells, CELL.crate, x, y, crate.w, crate.h, glow, glow, glow, a, layer);
    } else if (t >= tout && t < tout + SPARKLE) {
      const s = t - tout;
      const a = smoothstep(0, 0.08, s) * (1 - smoothstep(0.2, SPARKLE, s)) * 0.9;
      for (let j = 0; j < SPARKS; j++) {
        const ang = (j / SPARKS) * Math.PI * 2 + k;
        const r = 3 + 28 * s;
        const colour = (j & 1) === 0 ? YELLOW : WHITE;
        const cell = (j & 1) === 0 ? CELL.spark : CELL.dot;
        const cw = cells[cell].w;
        const kk = colour * 3;
        put(
          scene,
          cells,
          cell,
          Math.round(x + Math.cos(ang) * r),
          Math.round(y + Math.sin(ang) * r),
          cw,
          cw,
          RGB[kk],
          RGB[kk + 1],
          RGB[kk + 2],
          a,
          layer,
        );
      }
    }
  }
  const mine = cells[CELL.mine];
  for (const m of plan.mines) {
    minePosition(m, t, minePos);
    put(
      scene,
      cells,
      CELL.mine,
      minePos[0],
      minePos[1],
      mine.w,
      mine.h,
      1,
      1,
      1,
      1,
      layer,
      m.spin * t,
    );
  }
  // The tug turns in sixteenth-turn steps, as sprites did.
  tugAt(plan, t, pos);
  const step = Math.PI / 8;
  const heading = Math.round(pos[2] / step) * step;
  const tug = cells[CELL.tug];
  const flame = cells[CELL.flame];
  const thrust = clamp(pos[3], 0, 1);
  const back = tug.w / 2 + flame.w / 2 - 1;
  put(
    scene,
    cells,
    CELL.flame,
    pos[0] - Math.cos(heading) * back,
    pos[1] - Math.sin(heading) * back,
    flame.w,
    flame.h,
    1,
    1,
    1,
    0.3 + 0.6 * thrust,
    layer,
    heading,
  );
  put(scene, cells, CELL.tug, pos[0], pos[1], tug.w, tug.h, 1, 1, 1, 1, layer, heading);
  // The HUD, in the top corners.
  const top = MARGIN - 3;
  text(scene, cells, "SCORE", MARGIN, top, 1, SKY, 1, layer);
  number(scene, cells, scoreAt(plan, t), 6, MARGIN + textWidth(6, 1) + 1, top, WHITE, 1, layer);
  const demo = "DEMO PLAY";
  text(
    scene,
    cells,
    demo,
    view.width - MARGIN - textWidth(demo.length, 1),
    top,
    1,
    ORANGE,
    1,
    layer,
  );
}

/** Loop seconds into the table at which row `i` starts to appear, and how long it takes. */
const ROW_START = 0.7;
const ROW_STEP = 0.35;
const ROW_FADE = 0.25;

function drawScores(
  scene: Scene,
  cells: readonly Cell[],
  view: GameView,
  local: number,
  layer: number,
): void {
  const header = "HIGH SCORES";
  const hs = view.wide ? 1 : view.rowScale;
  const hx = Math.round((view.width - textWidth(header.length, hs)) / 2);
  text(scene, cells, header, hx, Math.round(view.height * 0.1), hs, WHITE, 1, layer);
  for (let i = 0; i < view.rows.length; i++) {
    const start = ROW_START + i * ROW_STEP;
    const a = smoothstep(start, start + ROW_FADE, local);
    const colour = i === 0 && view.owner ? WHITE : ROW_COLOURS[i % ROW_COLOURS.length];
    text(scene, cells, view.rows[i], view.rowX[i], view.rowY[i], view.rowScale, colour, a, layer);
  }
}

function drawCoin(
  scene: Scene,
  cells: readonly Cell[],
  view: GameView,
  local: number,
  layer: number,
): void {
  const a = blinkLevel(local);
  const w = view.width;
  if (view.wide) {
    const third = w / 3;
    const scale = clamp(Math.floor((third * 0.8) / textWidth(6, 1)), 1, 4);
    const y = Math.round(view.height * 0.4);
    text(
      scene,
      cells,
      "INSERT",
      Math.round(third / 2 - textWidth(6, scale) / 2),
      y,
      scale,
      YELLOW,
      a,
      layer,
    );
    text(
      scene,
      cells,
      "COIN",
      Math.round(w - third / 2 - textWidth(4, scale) / 2),
      y,
      scale,
      YELLOW,
      a,
      layer,
    );
  } else {
    const msg = "INSERT COIN";
    const scale = clamp(Math.floor((w * 0.85) / textWidth(msg.length, 1)), 1, 4);
    const y = Math.round(view.height * 0.4);
    text(
      scene,
      cells,
      msg,
      Math.round((w - textWidth(msg.length, scale)) / 2),
      y,
      scale,
      YELLOW,
      a,
      layer,
    );
  }
  credit(scene, cells, view, layer);
}

function drawPhase(
  scene: Scene,
  cells: readonly Cell[],
  view: GameView,
  index: number,
  local: number,
  layer: number,
): void {
  switch (PHASES[index].id) {
    case "title":
      drawTitle(scene, cells, view, local, layer);
      break;
    case "demo":
      drawDemo(scene, cells, view, local, layer);
      break;
    case "scores":
      drawScores(scene, cells, view, local, layer);
      break;
    case "coin":
      drawCoin(scene, cells, view, local, layer);
      break;
  }
}

/**
 * Fills `scene` with the sprites at loop time `loopTime`, the starfield at
 * star time `starTime` (the loop clock unwrapped, so the stars never jump).
 */
export function buildScene(
  scene: Scene,
  cells: readonly Cell[],
  view: GameView,
  loopTime: number,
  starTime: number,
): void {
  scene.count = 0;
  const dot = cells[CELL.dot];
  for (let i = 0; i < STAR_COUNT; i++) {
    starAt(i, view.seed, view.width, view.height, starTime, pos);
    const k = PALE * 3;
    const a = STAR_LEVELS[pos[2]];
    put(
      scene,
      cells,
      CELL.dot,
      Math.floor(pos[0]) + 0.5,
      Math.floor(pos[1]) + 0.5,
      dot.w,
      dot.h,
      RGB[k],
      RGB[k + 1],
      RGB[k + 2],
      a,
      SHOWN,
    );
  }
  phaseAt(loopTime, phase);
  const { index, local } = phase;
  if (local < WIPE_SECONDS) {
    const prev = (index + PHASES.length - 1) % PHASES.length;
    scene.front = (local / WIPE_SECONDS) * (view.height + WIPE_SOFT);
    drawPhase(scene, cells, view, prev, PHASES[prev].seconds + local, OUTGOING);
    drawPhase(scene, cells, view, index, local, INCOMING);
  } else {
    scene.front = 1e6;
    drawPhase(scene, cells, view, index, local, SHOWN);
  }
}

/** How much of the incoming phase shows at line `y` (px from the top) for a wipe front at `front`. */
export const wipeIn = (y: number, front: number) => clamp((front - y) / WIPE_SOFT, 0, 1);

/** The frame's mean brightness (0..1) as the sprites draw it on black: for testing flashes. */
export function meanLevel(scene: Scene, width: number, height: number): number {
  let sum = 0;
  for (let i = 0; i < scene.count; i++) {
    const layer = scene.data[i * STRIDE + 12];
    const y = scene.data[i * STRIDE + 1];
    const m =
      layer === SHOWN
        ? 1
        : layer === INCOMING
          ? wipeIn(y, scene.front)
          : 1 - wipeIn(y, scene.front);
    sum += scene.light[i] * m;
  }
  return sum / (width * height);
}
