/**
 * Starship Bridge panels: seeded layouts in the touch-panel style (flat colour
 * blocks on black, thick bars joined by rounded elbows, pill buttons, narrow
 * capital numbers), and the rasteriser that draws them into the panel atlas.
 *
 * Every shape belongs to a block, the unit that lights, dims and changes colour
 * (see `bridge-sim.ts`). The atlas holds shape coverage and the text, and a
 * parallel index map says which block each texel belongs to, so one small state
 * texture animates every panel at once. Coordinates are wall (s, y) metres.
 */
import type { Block, BlockKind } from "../console-blocks";
import {
  ATLAS_S0,
  ATLAS_Y0,
  type BridgeLayout,
  type PanelKind,
  type PanelSpec,
  type WallRect,
} from "./bridge-room";
import type { LiveKey } from "./bridge-live";
import { clamp } from "../math";
import { createRng, hash32 } from "../noise";

/**
 * Panel colours, as indices into `PALETTE` in `bridge-sim.ts`: peach-orange,
 * pale orange, tan, lilac, mauve, periwinkle, pale blue and red-orange.
 */
export const PEACH = 0;
export const PALE_ORANGE = 1;
export const TAN = 2;
export const LILAC = 3;
export const MAUVE = 4;
export const PERIWINKLE = 5;
export const PALE_BLUE = 6;
export const RED_ORANGE = 7;
export const COLOUR_COUNT = 8;

/** Weighted picks for frames and buttons: mostly the warm colours, some cool ones. */
const FRAME_COLOURS = [PEACH, PEACH, PALE_ORANGE, TAN, LILAC, MAUVE, PERIWINKLE];
const BUTTON_COLOURS = [PEACH, PALE_ORANGE, PALE_ORANGE, TAN, LILAC, MAUVE, PERIWINKLE, PALE_BLUE];
const TEXT_COLOURS = [PALE_ORANGE, PEACH, PALE_BLUE, PERIWINKLE, LILAC];

/** Rounded box, corner radii in the order bottom-left, bottom-right, top-right, top-left. */
export interface BoxShape {
  kind: "box";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: [number, number, number, number];
  block: number;
}

export type Corner = "bl" | "br" | "tl" | "tr";

/**
 * A bar turning a right angle: a vertical bar `barW` wide and a horizontal bar
 * `barH` thick, meeting at `corner` of the bounding box, with an outer radius
 * `ro` and an inner fillet of radius `ri`.
 */
export interface ElbowShape {
  kind: "elbow";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  corner: Corner;
  barW: number;
  barH: number;
  ro: number;
  ri: number;
  block: number;
}

export interface RingShape {
  kind: "ring";
  cx: number;
  cy: number;
  r: number;
  w: number;
  block: number;
}

/** A line segment `w` thick with round ends. */
export interface LineShape {
  kind: "line";
  ax: number;
  ay: number;
  bx: number;
  by: number;
  w: number;
  block: number;
}

export type Shape = BoxShape | ElbowShape | RingShape | LineShape;

export type TextAlign = "left" | "right" | "center";

/**
 * A run of text: `text`, or `alt` while its block shows its other reading (the
 * readouts tick between the two). `y` is the baseline and `size` the capital
 * height. `dark` text is cut out of the block's shape; the rest is lit in the
 * block's colour on black.
 */
export interface TextRun {
  text: string;
  alt: string;
  x: number;
  y: number;
  size: number;
  align: TextAlign;
  dark: boolean;
  block: number;
}

export type WidgetKind = "sweep" | "graph";

/** An area the composite shader animates itself: a sensor sweep or a scrolling graph. */
export interface Widget extends WallRect {
  kind: WidgetKind;
  block: number;
}

export interface PanelSet {
  /** Index 0 is "no block"; real blocks start at 1. */
  blocks: Block[];
  shapes: Shape[];
  texts: TextRun[];
  widgets: Widget[];
  /** Real readouts, drawn whenever their value changes. */
  live: LiveText[];
}

/**
 * Where a real readout's value goes: like a text run, but its string comes from
 * `bridge-live.ts` at draw time, and it may draw only inside `bounds` (which is
 * cleared before each redraw), squeezed to fit if need be.
 */
export interface LiveText {
  key: LiveKey;
  x: number;
  y: number;
  size: number;
  align: TextAlign;
  block: number;
  bounds: WallRect;
}

/** Most widgets the composite shader handles. */
export const MAX_WIDGETS = 4;
/** Most blocks, so indices fit the state texture's width. */
export const MAX_BLOCKS = 2048;

/**
 * Gap between neighbouring blocks. Frame bars and columns are cut into only a
 * few segments (none to two gaps each), so the frames read as mostly solid.
 */
const GAP = 0.008;
/** Panel titles and the band's labels, relative to the numbers beside them. */
const TITLE_SCALE = 1.5;
/** Inset of the graphics from the edge of their glass. */
const MARGIN = 0.025;

/**
 * Each panel's title, fixed by what it shows, so no two panels share one. Button
 * banks take OPERATIONS, and COMMS for a second bank (when the outside view is
 * off, both outer panels are banks). The display's title is in `displayHeader`.
 */
const TITLES: Readonly<Record<Exclude<PanelKind, "bank" | "band" | "display">, string>> = {
  readout: "ENVIRONMENT",
  sweep: "SENSORS",
  schematic: "SYSTEMS",
  graph: "POWER",
};
const BANK_TITLES = ["OPERATIONS", "COMMS"] as const;

interface Builder {
  rng: () => number;
  set: PanelSet;
  busy: number;
  block: (kind: BlockKind, colour: number, group?: number, order?: number) => number;
  group: () => number;
}

const pick = <T>(rng: () => number, list: readonly T[]): T =>
  list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

/** `n` random digits. */
function digits(rng: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += String(Math.floor(rng() * 10));
  }
  return out;
}

/** A made-up number in the panels' style: "4", "27", "0381", "21-4893", "6.07". */
export function panelNumber(rng: () => number): string {
  const r = rng();
  if (r < 0.25) {
    return digits(rng, 2);
  }
  if (r < 0.5) {
    return digits(rng, 3 + Math.floor(rng() * 2));
  }
  if (r < 0.8) {
    return `${digits(rng, 2)}-${digits(rng, 2 + Math.floor(rng() * 3))}`;
  }
  return `${digits(rng, 1 + Math.floor(rng() * 2))}.${digits(rng, 2)}`;
}

/** A second reading of the same shape as `value`: the same layout, new digits. */
export function tickedNumber(value: string, rng: () => number): string {
  let out = "";
  let changed = false;
  for (const ch of value) {
    if (ch >= "0" && ch <= "9") {
      let d = String(Math.floor(rng() * 10));
      if (!changed && d === ch) {
        d = String((Number(ch) + 1 + Math.floor(rng() * 8)) % 10);
      }
      changed ||= d !== ch;
      out += d;
    } else {
      out += ch;
    }
  }
  return out;
}

function box(
  b: Builder,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  block: number,
  r: [number, number, number, number] = [0, 0, 0, 0],
): void {
  if (x1 - x0 > 1e-4 && y1 - y0 > 1e-4) {
    b.set.shapes.push({ kind: "box", x0, y0, x1, y1, r, block });
  }
}

function text(
  b: Builder,
  value: string,
  x: number,
  y: number,
  size: number,
  align: TextAlign,
  dark: boolean,
  block: number,
  ticks = false,
): void {
  b.set.texts.push({
    text: value,
    alt: ticks ? tickedNumber(value, b.rng) : value,
    x,
    y,
    size,
    align,
    dark,
    block,
  });
}

/** A button: a flat box with a small dark number in its lower right corner. */
function button(
  b: Builder,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  block: number,
  r: [number, number, number, number] = [0, 0, 0, 0],
  label = true,
): void {
  box(b, x0, y0, x1, y1, block, r);
  const h = y1 - y0;
  const size = clamp(h * 0.32, 0.008, 0.02);
  if (label && x1 - x0 > size * 2.2) {
    const inset = Math.max(r[1], r[2]) > 0 ? h * 0.45 : size * 0.45;
    text(b, panelNumber(b.rng), x1 - inset, y0 + size * 0.45, size, "right", true, block);
  }
}

/**
 * Splits [a, b] into `n` pieces with `GAP` between them, with random lengths
 * within a factor of three of each other. Returns n + 1 cut positions; piece i
 * runs from out[i] to out[i + 1] - GAP.
 */
function cuts(rng: () => number, a: number, b: number, n: number): number[] {
  const w: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const x = 1 + 2 * rng();
    w.push(x);
    total += x;
  }
  const span = b - a + GAP;
  const out = [a];
  let acc = a;
  for (const x of w) {
    acc += (x / total) * span;
    out.push(acc);
  }
  return out;
}

/** A horizontal bar from x0 to x1 in segments, the last with a rounded right end. */
function hbar(b: Builder, x0: number, x1: number, y0: number, y1: number, n: number): void {
  if (x1 - x0 < 0.02) {
    return;
  }
  const c = cuts(b.rng, x0, x1, n);
  const rr = (y1 - y0) / 2;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const id = b.block("frame", pick(b.rng, FRAME_COLOURS));
    const r: [number, number, number, number] =
      last && b.rng() < 0.6 ? [0, rr, rr, 0] : [0, 0, 0, 0];
    box(b, c[i], y0, c[i + 1] - GAP, y1, id, r);
  }
}

/** A vertical column of numbered segments from y1 down to y0: one chase group. */
function vcolumn(b: Builder, x0: number, x1: number, y0: number, y1: number, n: number): void {
  if (y1 - y0 < 0.03) {
    return;
  }
  const c = cuts(b.rng, y0, y1, n);
  const group = b.group();
  for (let i = 0; i < n; i++) {
    // Top to bottom, so the chase runs downwards.
    const k = n - 1 - i;
    const id = b.block("button", pick(b.rng, BUTTON_COLOURS), group, i);
    button(b, x0, c[k], x1, c[k + 1] - GAP, id);
  }
}

interface Frame {
  /** Area for the header content, beside the upper elbow. */
  upper: WallRect;
  /** Area for the main content, beside the lower elbow. */
  lower: WallRect;
}

/**
 * The panels' signature frame: two elbows facing each other across a thin gap,
 * the upper turning up into a short column and the lower turning down into a
 * long column of numbered segments, each with a segmented bar running right.
 * `split` is the height of the dividing gap, as a fraction from the bottom.
 */
function frame(b: Builder, g: WallRect, split: number): Frame {
  const x0 = g.s0 + MARGIN;
  const x1 = g.s1 - MARGIN;
  const y0 = g.y0 + MARGIN;
  const y1 = g.y1 - MARGIN;
  const barW = clamp(0.17 * (x1 - x0), 0.06, 0.1);
  const barH = clamp(0.3 * barW, 0.018, 0.026);
  const ro = barW * 0.95;
  const ri = barH * 1.2;
  const yd = y0 + (y1 - y0) * split;
  const elbowW = barW + ri + 0.03 + b.rng() * 0.04;
  const elbowH = ro + 0.01;

  // Upper elbow: corner at the bottom left, column going up.
  const ue = b.block("frame", pick(b.rng, FRAME_COLOURS));
  const uy0 = yd + GAP / 2;
  b.set.shapes.push({
    kind: "elbow",
    x0,
    y0: uy0,
    x1: x0 + elbowW,
    y1: uy0 + elbowH,
    corner: "bl",
    barW,
    barH,
    ro,
    ri,
    block: ue,
  });
  vcolumn(b, x0, x0 + barW, uy0 + elbowH + GAP, y1, b.rng() < 0.25 ? 2 : 1);
  hbar(b, x0 + elbowW + GAP, x1, uy0, uy0 + barH, 1 + Math.floor(b.rng() * 3));

  // Lower elbow: corner at the top left, column going down.
  const le = b.block("frame", pick(b.rng, FRAME_COLOURS));
  const ly1 = yd - GAP / 2;
  b.set.shapes.push({
    kind: "elbow",
    x0,
    y0: ly1 - elbowH,
    x1: x0 + elbowW,
    y1: ly1,
    corner: "tl",
    barW,
    barH,
    ro,
    ri,
    block: le,
  });
  hbar(b, x0 + elbowW + GAP, x1, ly1 - barH, ly1, 1 + Math.floor(b.rng() * 3));
  const closed = b.rng() < 0.5;
  const colBottom = closed ? y0 + elbowH + GAP : y0;
  vcolumn(b, x0, x0 + barW, colBottom, ly1 - elbowH - GAP, 2 + Math.floor(b.rng() * 2));
  if (closed) {
    // A bottom elbow closes the frame.
    const be = b.block("frame", pick(b.rng, FRAME_COLOURS));
    b.set.shapes.push({
      kind: "elbow",
      x0,
      y0,
      x1: x0 + elbowW,
      y1: y0 + elbowH,
      corner: "bl",
      barW,
      barH,
      ro,
      ri,
      block: be,
    });
    hbar(b, x0 + elbowW + GAP, x1, y0, y0 + barH, b.rng() < 0.75 ? 2 : 1);
  }

  const cx0 = x0 + barW + 0.025;
  return {
    upper: { s0: cx0, s1: x1, y0: uy0 + barH + 0.014, y1 },
    lower: { s0: cx0, s1: x1, y0: closed ? y0 + barH + 0.014 : y0, y1: ly1 - barH - 0.014 },
  };
}

/** Header content: a title and a line of small numbers, right-aligned. */
function header(b: Builder, r: WallRect, label: string): void {
  const h = r.y1 - r.y0;
  if (h < 0.03) {
    return;
  }
  const numbers = clamp(h * 0.28, 0.014, 0.034);
  const size = numbers * TITLE_SCALE;
  const title = b.block("text", pick(b.rng, TEXT_COLOURS));
  // Draw as the old random title did, so the rest of each seed's layout is unchanged.
  b.rng();
  text(b, label, r.s1, r.y1 - size * 1.15, size, "right", false, title);
  const small = numbers * 0.55;
  let y = r.y1 - size * 1.15 - small * 2;
  while (y > r.y0 + small * 0.2) {
    const id = b.block("readout", pick(b.rng, TEXT_COLOURS));
    text(b, panelNumber(b.rng), r.s1, y, small, "right", false, id, true);
    y -= small * 1.9;
  }
}

/** A grid of buttons: each column a chase group, rounded on its outer side. */
function bank(b: Builder, r: WallRect): void {
  const cols = r.s1 - r.s0 > 0.4 ? 3 : 2;
  const rows = 5 + Math.floor(b.rng() * 4);
  const cw = (r.s1 - r.s0 - GAP * 3 * (cols - 1)) / cols;
  const rh = (r.y1 - r.y0 + GAP) / rows;
  for (let c = 0; c < cols; c++) {
    const x0 = r.s0 + c * (cw + GAP * 3);
    const group = b.group();
    const colour = pick(b.rng, BUTTON_COLOURS);
    for (let k = 0; k < rows; k++) {
      const y1 = r.y1 - k * rh;
      const y0 = y1 - rh + GAP;
      const rr = (y1 - y0) / 2;
      const round: [number, number, number, number] =
        c === cols - 1 ? [0, rr, rr, 0] : c === 0 && cols > 2 ? [rr, 0, 0, rr] : [0, 0, 0, 0];
      // Some cells are empty black, which keeps the grid from looking solid.
      if (b.rng() < 0.18) {
        continue;
      }
      const id = b.block("button", b.rng() < 0.25 ? pick(b.rng, BUTTON_COLOURS) : colour, group, k);
      button(b, x0, y0, x0 + cw, y1, id, round);
    }
  }
}

/** Rows of numbers in columns, lit on black, with a column of pills on the right. */
function readout(b: Builder, r: WallRect): void {
  const pillW = clamp((r.s1 - r.s0) * 0.22, 0.04, 0.08);
  const x1 = r.s1 - pillW - GAP * 3;
  const size = 0.016;
  const rowH = size * 1.75;
  const cols = 3;
  const colW = (x1 - r.s0) / cols;
  const colours = [pick(b.rng, TEXT_COLOURS), pick(b.rng, TEXT_COLOURS), PALE_ORANGE];
  for (let y = r.y1 - size * 1.2; y > r.y0; y -= rowH) {
    for (let c = 0; c < cols; c++) {
      if (b.rng() < 0.12) {
        continue;
      }
      const id = b.block("readout", colours[c]);
      text(b, panelNumber(b.rng), r.s0 + (c + 1) * colW - 0.006, y, size, "right", false, id, true);
    }
  }
  const n = 4 + Math.floor(b.rng() * 3);
  const c = cuts(b.rng, r.y0, r.y1, n);
  const group = b.group();
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i;
    const y0 = c[k];
    const y1 = c[k + 1] - GAP;
    const rr = Math.min(pillW, y1 - y0) / 2;
    const id = b.block("button", pick(b.rng, BUTTON_COLOURS), group, i);
    button(b, r.s1 - pillW, y0, r.s1, y1, id, [rr, rr, rr, rr]);
  }
}

/** A sensor sweep: concentric rings and a cross, with buttons below. */
function sweep(b: Builder, r: WallRect): void {
  const btnH = 0.05;
  const area = { s0: r.s0, s1: r.s1, y0: r.y0 + btnH + GAP * 3, y1: r.y1 };
  const radius = Math.min(area.s1 - area.s0, area.y1 - area.y0) / 2 - 0.01;
  const cx = (area.s0 + area.s1) / 2;
  const cy = (area.y0 + area.y1) / 2;
  const ring = b.block("frame", MAUVE);
  for (const f of [1, 0.66, 0.33]) {
    b.set.shapes.push({ kind: "ring", cx, cy, r: radius * f, w: 0.003, block: ring });
  }
  const cross = b.block("frame", PERIWINKLE);
  b.set.shapes.push(
    { kind: "line", ax: cx - radius, ay: cy, bx: cx + radius, by: cy, w: 0.002, block: cross },
    { kind: "line", ax: cx, ay: cy - radius, bx: cx, by: cy + radius, w: 0.002, block: cross },
  );
  const wedge = b.block("widget", PALE_BLUE);
  b.set.widgets.push({
    kind: "sweep",
    s0: cx - radius,
    s1: cx + radius,
    y0: cy - radius,
    y1: cy + radius,
    block: wedge,
  });
  const n = 4;
  const c = cuts(b.rng, r.s0, r.s1, n);
  const group = b.group();
  for (let i = 0; i < n; i++) {
    const id = b.block("button", pick(b.rng, BUTTON_COLOURS), group, i);
    const rr = btnH / 2;
    const round: [number, number, number, number] =
      i === 0 ? [rr, 0, 0, rr] : i === n - 1 ? [0, rr, rr, 0] : [0, 0, 0, 0];
    button(b, c[i], r.y0, c[i + 1] - GAP, r.y0 + btnH, id, round);
  }
}

/** A scrolling graph between two thin rules, with a row of pills below. */
function graph(b: Builder, r: WallRect): void {
  const btnH = 0.045;
  const g0 = r.y0 + btnH + GAP * 4;
  const rule = b.block("frame", pick(b.rng, FRAME_COLOURS));
  box(b, r.s0, r.y1 - 0.006, r.s1, r.y1, rule);
  box(b, r.s0, g0, r.s1, g0 + 0.006, rule);
  // Tick marks stand on the lower rule, so they share its block.
  for (let i = 1; i < 8; i++) {
    const x = r.s0 + ((r.s1 - r.s0) * i) / 8;
    box(b, x - 0.001, g0 + 0.006, x + 0.001, g0 + 0.02, rule);
  }
  const line = b.block("widget", pick(b.rng, [PALE_BLUE, PALE_ORANGE, LILAC]));
  b.set.widgets.push({
    kind: "graph",
    s0: r.s0,
    s1: r.s1,
    y0: g0 + 0.01,
    y1: r.y1 - 0.01,
    block: line,
  });
  const n = 3 + Math.floor(b.rng() * 2);
  const c = cuts(b.rng, r.s0, r.s1, n);
  const group = b.group();
  for (let i = 0; i < n; i++) {
    const rr = btnH / 2;
    const id = b.block("button", pick(b.rng, BUTTON_COLOURS), group, i);
    button(b, c[i], r.y0, c[i + 1] - GAP, r.y0 + btnH, id, [rr, rr, rr, rr]);
  }
}

/**
 * A made-up systems schematic: a rounded hull outline in thin lines, cut by deck
 * lines, with a few lit compartments and labelled callouts.
 */
function schematic(b: Builder, r: WallRect): void {
  const outline = b.block("frame", PERIWINKLE);
  const w = r.s1 - r.s0;
  const h = r.y1 - r.y0;
  const cx = r.s0 + w * 0.42;
  const cy = r.y0 + h / 2;
  const hw = w * 0.32;
  const hh = h * 0.44;
  // A hull profile: half-widths from top to bottom, smooth, tapering at both ends.
  const n = 12;
  const half: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const base = Math.sin(Math.PI * Math.pow(t, 0.8));
    half.push(hw * Math.max(0.12, base * (0.75 + 0.25 * b.rng())));
  }
  const yAt = (i: number) => cy + hh - (2 * hh * i) / n;
  for (let i = 0; i < n; i++) {
    for (const side of [-1, 1]) {
      b.set.shapes.push({
        kind: "line",
        ax: cx + side * half[i],
        ay: yAt(i),
        bx: cx + side * half[i + 1],
        by: yAt(i + 1),
        w: 0.0025,
        block: outline,
      });
    }
  }
  const decks = b.block("frame", MAUVE);
  for (let i = 2; i < n - 1; i += 2) {
    const hx = half[i] * 0.92;
    b.set.shapes.push({
      kind: "line",
      ax: cx - hx,
      ay: yAt(i),
      bx: cx + hx,
      by: yAt(i),
      w: 0.0015,
      block: decks,
    });
  }
  // Lit compartments between the deck lines, and callouts to labels on the right.
  let callouts = 0;
  for (let i = 2; i < n - 3; i += 2) {
    if (b.rng() < 0.35) {
      continue;
    }
    const hx = Math.min(half[i], half[i + 2]) * 0.7;
    const x0 = cx - hx * (0.2 + 0.6 * b.rng());
    const x1 = x0 + hx * (0.3 + 0.4 * b.rng());
    const id = b.block("button", pick(b.rng, BUTTON_COLOURS));
    box(b, x0, yAt(i + 2) + 0.006, x1, yAt(i) - 0.006, id);
    if (callouts < 4) {
      const ly = (yAt(i) + yAt(i + 2)) / 2;
      const lx = r.s1 - 0.11;
      b.set.shapes.push({ kind: "line", ax: x1, ay: ly, bx: lx, by: ly, w: 0.0015, block: id });
      const label = b.block("readout", pick(b.rng, TEXT_COLOURS));
      text(b, panelNumber(b.rng), r.s1, ly - 0.007, 0.014, "right", false, label, true);
      callouts++;
    }
  }
}

/** The display's header: a bar with an elbow over the picture, and a title. */
function displayHeader(b: Builder, g: WallRect, viewport: WallRect): void {
  const x0 = g.s0 + MARGIN;
  const x1 = g.s1 - MARGIN;
  const y1 = g.y1 - MARGIN;
  const y0 = viewport.y1 + 0.02;
  const barW = 0.07;
  const barH = 0.022;
  const e = b.block("frame", pick(b.rng, FRAME_COLOURS));
  const ew = barW + 0.06;
  b.set.shapes.push({
    kind: "elbow",
    x0,
    y0,
    x1: x0 + ew,
    y1,
    corner: "bl",
    barW,
    barH,
    ro: Math.min(barW, y1 - y0) * 0.9,
    ri: barH,
    block: e,
  });
  hbar(b, x0 + ew + GAP, x1, y0, y0 + barH, 2);
  const title = b.block("text", PALE_ORANGE);
  const numbers = clamp((y1 - y0 - barH) * 0.42, 0.014, 0.03);
  const size = numbers * TITLE_SCALE;
  text(b, "EXTERIOR", x1, y1 - size * 1.1, size, "right", false, title);
  const id = b.block("readout", PALE_BLUE);
  text(
    b,
    panelNumber(b.rng),
    x0 + ew + 0.02,
    y1 - size * 1.1,
    numbers * 0.7,
    "left",
    false,
    id,
    true,
  );
}

/**
 * The band's real readouts, in order out from each end of the band, with their
 * width (m) and value size. They are packed against the band's ends, towards
 * the sides of the frame, away from the speaker; a hidden one leaves no gap.
 * With all of them shown, the status reaches a little way into the middle
 * third and the date sits inside it, beside the time.
 */
const LIVE_WINDOWS: readonly {
  key: LiveKey;
  label: string;
  from: "left" | "right";
  w: number;
  size: number;
}[] = [
  { key: "stardate", label: "STARDATE", from: "left", w: 0.72, size: 0.1 },
  { key: "time", label: "LOCAL TIME", from: "left", w: 0.69, size: 0.1 },
  { key: "date", label: "LOCAL DATE", from: "left", w: 0.69, size: 0.075 },
  { key: "location", label: "LOCATION", from: "right", w: 0.91, size: 0.075 },
  { key: "status", label: "STATUS", from: "right", w: 0.93, size: 0.075 },
];
/** Space (m) between the band's end and its outermost readout, and between readouts. */
const LIVE_SPACING = 0.04;

/** Thickness of the thin bars in the band's window frames. */
const BAND_BAR = 0.012;

/** A block that never dims, swaps or flashes. */
function steady(b: Builder, kind: BlockKind, colour: number): number {
  const id = b.block(kind, colour);
  b.set.blocks[id].busy = 0;
  return id;
}

/** Inset of the readout windows' frames from the band's glass edges. */
const BAND_INSET = 0.01;
/** Width of the thick left bracket and the narrow right one round each readout. */
const BRACKET_LEFT = 0.05;
const BRACKET_RIGHT = 0.022;

/** One steady elbow of a readout's bracket. */
function bracketElbow(
  b: Builder,
  corner: Corner,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  barW: number,
  colour: number,
): void {
  const h = y1 - y0;
  b.set.shapes.push({
    kind: "elbow",
    x0,
    y0,
    x1,
    y1,
    corner,
    barW,
    barH: BAND_BAR,
    ro: Math.min(barW * 0.95, h),
    ri: BAND_BAR * 1.2,
    block: steady(b, "frame", colour),
  });
}

/** A horizontal run of steady segments from x0 to x1, with gaps between them. */
function bracketRail(b: Builder, x0: number, x1: number, y0: number, y1: number, n: number): void {
  if (x1 - x0 < 0.02) {
    return;
  }
  const c = cuts(b.rng, x0, x1, n);
  for (let i = 0; i < n; i++) {
    box(b, c[i], y0, c[i + 1] - GAP, y1, steady(b, "frame", pick(b.rng, FRAME_COLOURS)));
  }
}

/**
 * A window for one real readout, framed in the panels' style: a thick bracket on
 * the left, its two elbows turning into thin segmented bars along the top and
 * bottom, closed by a narrow bracket on the right. A small label sits at the top
 * left and the value at the bottom right. The value is drawn later, whenever it
 * changes, so it is a live run rather than a text run.
 */
function liveWindow(
  b: Builder,
  r: WallRect,
  w: (typeof LIVE_WINDOWS)[number],
  x0: number,
  x1: number,
): void {
  const y0 = r.y0 + BAND_INSET;
  const y1 = r.y1 - BAND_INSET;
  const mid = (y0 + y1) / 2;
  const left = pick(b.rng, FRAME_COLOURS);
  const right = pick(b.rng, FRAME_COLOURS);
  const lw = BRACKET_LEFT + BAND_BAR * 1.2 + 0.03;
  const rw = BRACKET_RIGHT + BAND_BAR * 1.2 + 0.02;
  bracketElbow(b, "tl", x0, mid + GAP / 2, x0 + lw, y1, BRACKET_LEFT, left);
  bracketElbow(b, "bl", x0, y0, x0 + lw, mid - GAP / 2, BRACKET_LEFT, left);
  bracketElbow(b, "tr", x1 - rw, mid + GAP / 2, x1, y1, BRACKET_RIGHT, right);
  bracketElbow(b, "br", x1 - rw, y0, x1, mid - GAP / 2, BRACKET_RIGHT, right);
  bracketRail(b, x0 + lw + GAP, x1 - rw - GAP, y1 - BAND_BAR, y1, b.rng() < 0.5 ? 2 : 1);
  bracketRail(b, x0 + lw + GAP, x1 - rw - GAP, y0, y0 + BAND_BAR, b.rng() < 0.25 ? 2 : 1);
  const c0 = x0 + BRACKET_LEFT + 0.022;
  const c1 = x1 - BRACKET_RIGHT - 0.014;
  const labelId = steady(b, "text", LILAC);
  const labelSize = 0.034 * TITLE_SCALE;
  text(b, w.label, c0, y1 - BAND_BAR - 0.01 - labelSize, labelSize, "left", false, labelId);
  const valueId = steady(b, "text", PALE_ORANGE);
  const y = y0 + BAND_BAR + 0.014;
  b.set.live.push({
    key: w.key,
    x: c1,
    y,
    size: w.size,
    align: "right",
    block: valueId,
    bounds: { s0: c0, s1: c1, y0: y0 + BAND_BAR + 0.003, y1: y + w.size * 1.12 },
  });
}

/**
 * The long strip above the stations: bordered windows with the real stardate,
 * local time, ship status and location, on plain black glass. Nothing in it
 * flickers: it only shows information.
 */
function band(b: Builder, r: WallRect, hidden: ReadonlySet<LiveKey>): void {
  let left = r.s0 + LIVE_SPACING;
  let right = r.s1 - LIVE_SPACING;
  for (const w of LIVE_WINDOWS) {
    if (hidden.has(w.key)) {
      continue;
    }
    if (w.from === "left") {
      liveWindow(b, r, w, left, left + w.w);
      left += w.w + LIVE_SPACING;
    } else {
      liveWindow(b, r, w, right - w.w, right);
      right -= w.w + LIVE_SPACING;
    }
  }
}

function buildPanel(
  b: Builder,
  p: PanelSpec,
  layout: BridgeLayout,
  title: string,
  hidden: ReadonlySet<LiveKey>,
): void {
  if (p.kind === "band") {
    band(b, p, hidden);
    return;
  }
  if (p.kind === "display") {
    if (layout.viewport) {
      displayHeader(b, p, layout.viewport);
    }
    return;
  }
  const split = p.kind === "schematic" || p.kind === "sweep" ? 0.82 : 0.74;
  const f = frame(b, p, split);
  header(b, f.upper, title);
  const content = f.lower;
  switch (p.kind) {
    case "bank":
      bank(b, content);
      break;
    case "readout":
      readout(b, content);
      break;
    case "sweep":
      sweep(b, content);
      break;
    case "graph":
      graph(b, content);
      break;
    case "schematic":
      schematic(b, content);
      break;
  }
}

/**
 * Every panel's shapes, text, widgets and blocks, deterministic per seed. The
 * band leaves out the `hidden` readouts.
 */
export function buildPanels(
  layout: BridgeLayout,
  seed: number,
  hidden: ReadonlySet<LiveKey> = new Set(),
): PanelSet {
  const set: PanelSet = {
    blocks: [{ kind: "frame", colour: 0, alt: 0, level: 0, busy: 0, group: -1, order: 0 }],
    shapes: [],
    texts: [],
    widgets: [],
    live: [],
  };
  let groups = 0;
  // Banks are titled right to left, so a lone bank is always OPERATIONS.
  const titles = layout.panels.map((p) =>
    p.kind === "bank" || p.kind === "band" || p.kind === "display" ? "" : TITLES[p.kind],
  );
  let banks = 0;
  for (let i = layout.panels.length - 1; i >= 0; i--) {
    if (layout.panels[i]?.kind === "bank") {
      titles[i] = BANK_TITLES[Math.min(banks++, BANK_TITLES.length - 1)];
    }
  }
  layout.panels.forEach((p, i) => {
    const rng = createRng(hash32((Math.floor(seed) * 31 + i) >>> 0));
    const b: Builder = {
      rng,
      set,
      busy: p.busy,
      block(kind, colour, group = -1, order = 0) {
        let alt = pick(rng, BUTTON_COLOURS);
        if (alt === colour) {
          alt = (colour + 3) % COLOUR_COUNT;
        }
        set.blocks.push({
          kind,
          colour,
          alt,
          level: 0.8 + 0.2 * rng(),
          busy: p.busy * (kind === "frame" ? 0.25 : 1),
          group,
          order,
        });
        return set.blocks.length - 1;
      },
      group: () => groups++,
    };
    buildPanel(b, p, layout, titles[i] ?? "", hidden);
  });
  if (set.blocks.length > MAX_BLOCKS) {
    throw new Error(
      `Starship Bridge: ${String(set.blocks.length)} blocks, at most ${String(MAX_BLOCKS)}`,
    );
  }
  set.widgets.length = Math.min(set.widgets.length, MAX_WIDGETS);
  return set;
}

/** Number of chase groups in a panel set. */
export function groupCount(set: PanelSet): number {
  let n = 0;
  for (const b of set.blocks) {
    n = Math.max(n, b.group + 1);
  }
  return n;
}

/* ----- Signed distances, in metres (negative inside) ----- */

function sdBox(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const qx = Math.abs(px - (x0 + x1) / 2) - (x1 - x0) / 2;
  const qy = Math.abs(py - (y0 + y1) / 2) - (y1 - y0) / 2;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

function sdRoundBox(px: number, py: number, s: BoxShape): number {
  const cx = (s.x0 + s.x1) / 2;
  const cy = (s.y0 + s.y1) / 2;
  const hx = (s.x1 - s.x0) / 2;
  const hy = (s.y1 - s.y0) / 2;
  const dx = px - cx;
  const dy = py - cy;
  const r = dx < 0 ? (dy < 0 ? s.r[0] : s.r[3]) : dy < 0 ? s.r[1] : s.r[2];
  const rr = Math.min(r, hx, hy);
  const qx = Math.abs(dx) - hx + rr;
  const qy = Math.abs(dy) - hy + rr;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
}

function sdElbow(px: number, py: number, e: ElbowShape): number {
  // Into the frame where the corner is at the origin and the bars run +x and +y.
  const flipX = e.corner === "br" || e.corner === "tr";
  const flipY = e.corner === "tl" || e.corner === "tr";
  const x = flipX ? e.x1 - px : px - e.x0;
  const y = flipY ? e.y1 - py : py - e.y0;
  const w = e.x1 - e.x0;
  const h = e.y1 - e.y0;
  let d = Math.min(sdBox(x, y, 0, 0, e.barW, h), sdBox(x, y, 0, 0, w, e.barH));
  // Rounded outer corner.
  const ro = Math.min(e.ro, e.barW, h);
  if (x < ro && y < ro) {
    d = Math.max(d, Math.hypot(ro - x, ro - y) - ro);
  }
  // Inner fillet between the two bars.
  const fx = x - e.barW;
  const fy = y - e.barH;
  const fillet = Math.max(sdBox(fx, fy, 0, 0, e.ri, e.ri), e.ri - Math.hypot(fx - e.ri, fy - e.ri));
  return Math.min(d, fillet);
}

function sdLine(px: number, py: number, s: LineShape): number {
  const bax = s.bx - s.ax;
  const bay = s.by - s.ay;
  const pax = px - s.ax;
  const pay = py - s.ay;
  const len2 = bax * bax + bay * bay;
  const t = len2 > 0 ? clamp((pax * bax + pay * bay) / len2, 0, 1) : 0;
  return Math.hypot(pax - bax * t, pay - bay * t) - s.w / 2;
}

/** Signed distance from a point to a shape, in metres. */
export function shapeDistance(s: Shape, px: number, py: number): number {
  if (s.kind === "box") {
    return sdRoundBox(px, py, s);
  }
  if (s.kind === "elbow") {
    return sdElbow(px, py, s);
  }
  if (s.kind === "ring") {
    return Math.abs(Math.hypot(px - s.cx, py - s.cy) - s.r) - s.w / 2;
  }
  return sdLine(px, py, s);
}

/** A shape's bounding box. */
export function shapeBounds(s: Shape): WallRect {
  if (s.kind === "box" || s.kind === "elbow") {
    return { s0: s.x0, s1: s.x1, y0: s.y0, y1: s.y1 };
  }
  if (s.kind === "ring") {
    const r = s.r + s.w;
    return { s0: s.cx - r, s1: s.cx + r, y0: s.cy - r, y1: s.cy + r };
  }
  return {
    s0: Math.min(s.ax, s.bx) - s.w,
    s1: Math.max(s.ax, s.bx) + s.w,
    y0: Math.min(s.ay, s.by) - s.w,
    y1: Math.max(s.ay, s.by) + s.w,
  };
}

/**
 * Generous advance of one character, in capital heights, for a text run's
 * bounds. Digits are squeezed to about half their height, but letters keep
 * their proportions, and W and M are nearly twice as wide.
 */
function advance(ch: string): number {
  if (ch === "W" || ch === "M") {
    return 1.05;
  }
  if (ch >= "A" && ch <= "Z") {
    return 0.82;
  }
  return ch === " " ? 0.4 : 0.62;
}

/** A text run's extent, erring wide, for its block index. */
export function textBounds(t: TextRun): WallRect {
  let w = 0;
  for (const value of [t.text, t.alt]) {
    let len = 0;
    for (const ch of value) {
      len += advance(ch);
    }
    w = Math.max(w, len * t.size);
  }
  const x0 = t.align === "right" ? t.x - w : t.align === "center" ? t.x - w / 2 : t.x;
  return {
    s0: x0 - t.size * 0.15,
    s1: x0 + w + t.size * 0.15,
    y0: t.y - t.size * 0.15,
    y1: t.y + t.size * 1.15,
  };
}

export interface AtlasImage {
  width: number;
  height: number;
  /** Texels per metre. */
  tpm: number;
  /**
   * RGBA8, row 0 at the bottom (y = `ATLAS_Y0`): R is shape coverage, G and B the
   * text's two readings (filled in by the caller, which has a canvas), A unused.
   */
  rgba: Uint8Array;
  /** Block index per texel (0 for none), same layout. */
  index: Uint16Array;
}

/** An atlas of `width` x `height` texels at `tpm` texels per metre, all clear. */
export function createAtlasImage(width: number, height: number, tpm: number): AtlasImage {
  return {
    width,
    height,
    tpm,
    rgba: new Uint8Array(width * height * 4),
    index: new Uint16Array(width * height),
  };
}

/**
 * Draws every shape's antialiased coverage into the atlas's red channel and its
 * block into the index wherever the shape reaches within half a texel; later
 * shapes win. Lit text runs get their block over their generous bounds, on
 * empty glass only (text on a button keeps the button's block). Clears the atlas first.
 */
export function rasterisePanels(set: PanelSet, atlas: AtlasImage): void {
  const { width, height, tpm, rgba, index } = atlas;
  rgba.fill(0);
  index.fill(0);
  const px = 1 / tpm;
  const toCol = (s: number) => (s - ATLAS_S0) * tpm - 0.5;
  const toRow = (y: number) => (y - ATLAS_Y0) * tpm - 0.5;
  for (const shape of set.shapes) {
    const r = shapeBounds(shape);
    const c0 = Math.max(0, Math.floor(toCol(r.s0)) - 1);
    const c1 = Math.min(width - 1, Math.ceil(toCol(r.s1)) + 1);
    const r0 = Math.max(0, Math.floor(toRow(r.y0)) - 1);
    const r1 = Math.min(height - 1, Math.ceil(toRow(r.y1)) + 1);
    for (let j = r0; j <= r1; j++) {
      const y = ATLAS_Y0 + (j + 0.5) * px;
      for (let i = c0; i <= c1; i++) {
        const d = shapeDistance(shape, ATLAS_S0 + (i + 0.5) * px, y) * tpm;
        if (d >= 0.75) {
          continue;
        }
        const k = j * width + i;
        const cov = Math.round(clamp(0.5 - d, 0, 1) * 255);
        if (cov > rgba[k * 4]) {
          rgba[k * 4] = cov;
        }
        if (d < 0.5) {
          index[k] = shape.block;
        }
      }
    }
  }
  const runs = [
    ...set.texts.filter((t) => !t.dark).map((t) => ({ r: textBounds(t), block: t.block })),
    ...set.live.map((t) => ({ r: t.bounds, block: t.block })),
  ];
  for (const { r, block } of runs) {
    const c0 = Math.max(0, Math.floor(toCol(r.s0)));
    const c1 = Math.min(width - 1, Math.ceil(toCol(r.s1)));
    const r0 = Math.max(0, Math.floor(toRow(r.y0)));
    const r1 = Math.min(height - 1, Math.ceil(toRow(r.y1)));
    // Only on empty glass, so wide bounds can't take texels from a neighbouring shape.
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        const k = j * width + i;
        if (rgba[k * 4] === 0) {
          index[k] = block;
        }
      }
    }
  }
}
