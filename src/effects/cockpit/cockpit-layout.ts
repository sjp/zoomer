/**
 * Freighter Cockpit layout: the console's outline and its seeded clutter of
 * panels (lamp grids, toggle rows, small screens, throttle levers and blank
 * plates), and the lamps they hold.
 *
 * Coordinates are in frame heights from the centre of the frame, x right and
 * y up, so the frame spans y in [-0.5, 0.5] and x in +-aspect / 2. The layout
 * is designed for 16:9 (x in +-0.89); wider frames show more bare console at
 * the sides, narrower ones crop the outer panels.
 */
import { glslFloat } from "../gl";
import { clamp } from "../math";
import { createRng } from "../noise";

/** Height of the console top at the centre, behind the speaker. */
export const CONSOLE_LOW = -0.31;
/** Height of the console top at the sides, where the clusters sit. */
export const CONSOLE_HIGH = -0.15;
/** |x| where the console top starts to rise, and where it stops. */
export const CONSOLE_RISE0 = 0.2;
export const CONSOLE_RISE1 = 0.75;
/** Depth of the glare shield along the console's top edge. */
export const LIP = 0.026;

/** Height of the console's top edge at `x`: flat in the middle, rising to the sides. */
export function consoleTop(x: number): number {
  const u = clamp((Math.abs(x) - CONSOLE_RISE0) / (CONSOLE_RISE1 - CONSOLE_RISE0), 0, 1);
  return CONSOLE_LOW + (CONSOLE_HIGH - CONSOLE_LOW) * u;
}

/** GLSL twin of `consoleTop`. */
export const CONSOLE_GLSL = /* glsl */ `
float consoleTop(float x) {
  float u = clamp((abs(x) - ${glslFloat(CONSOLE_RISE0)}) / ${glslFloat(CONSOLE_RISE1 - CONSOLE_RISE0)}, 0.0, 1.0);
  return ${glslFloat(CONSOLE_LOW)} + ${glslFloat(CONSOLE_HIGH - CONSOLE_LOW)} * u;
}
`;

/** Inner and outer |x| of each side's cluster of panels. */
export const CLUSTER_INNER = 0.21;
export const CLUSTER_OUTER = 0.67;
/** Bottom of the lower row of panels. */
const PANELS_BOTTOM = -0.485;
/** Gap between neighbouring panels. */
const GAP = 0.012;
/** Height of the upper row of panels. */
const UPPER_HEIGHT = 0.078;
/** Shortest lower panel; a column with less room is one tall panel. */
const MIN_LOWER = 0.07;

export const PANEL_LAMPS = 0;
export const PANEL_TOGGLES = 1;
export const PANEL_SCREEN = 2;
export const PANEL_LEVERS = 3;
export const PANEL_PLATE = 4;

/** Most panels, the size of the shader's uniform arrays. */
export const MAX_PANELS = 16;
/** Most lamps: their indices 1..MAX_LIGHTS fit the id target's 8-bit channel. */
export const MAX_LIGHTS = 239;
/** Id of screen 0 in the id target; screen n is SCREEN_ID + n. */
export const SCREEN_ID = 240;
/** Most screens. */
export const MAX_SCREENS = 3;

/** Lamp grid cell size (frame heights), and the most rows and columns of lamps. */
const LAMP_CELL = 0.021;
const LAMP_ROWS = 3;
const LAMP_COLS = 7;
/** Toggle cell width and height, and the most toggles in a row. */
const TOGGLE_W = 0.026;
const TOGGLE_H = 0.05;
const TOGGLE_COLS = 6;

export interface Panel {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** One of the PANEL_* kinds. */
  kind: number;
  /** Grid of lamps or toggles; 0 for other kinds. */
  cols: number;
  rows: number;
  /** Index of the first lamp, 1-based; lamp (r, c) is `base + r * cols + c`. */
  base: number;
  /** Grid cell size. */
  cellW: number;
  cellH: number;
  /** Plate tone, 0..1, so neighbouring panels don't quite match. */
  tone: number;
  /** Screen number for a screen; lever count for levers; else 0. */
  variant: number;
}

/** Lamp colours. */
export const LAMP_RED = 0;
export const LAMP_AMBER = 1;
export const LAMP_WHITE = 2;
export const LAMP_GREEN = 3;

export interface Lamp {
  colour: number;
  /** Never lights: a dead bulb. */
  dead: boolean;
  /** 0..1: lamps whose rank is below the lit fraction for the activity are on. */
  rank: number;
  /** 0..1: lamps whose rank is below the blinking fraction blink. */
  blinkRank: number;
  /** Blink period (s) and phase (0..1). */
  period: number;
  phase: number;
  /** Fraction of each blink period spent lit. */
  duty: number;
  /** Lamps in one row of a panel run sequences together; -1 for none. */
  group: number;
  order: number;
}

export interface CockpitLayout {
  panels: Panel[];
  /** Lamp i has index i + 1 in the panels and the id target. */
  lamps: Lamp[];
  /** Number of chase groups. */
  groups: number;
  /** Number of screens. */
  screens: number;
}

/** Splits [a, b] into `n` spans of random widths with `GAP` between them. */
function split(a: number, b: number, n: number, rand: () => number): number[] {
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.75 + 0.5 * rand();
    weights.push(w);
    sum += w;
  }
  const free = b - a - GAP * (n - 1);
  const edges = [a];
  let x = a;
  for (let i = 0; i < n; i++) {
    x += (weights[i] / sum) * free;
    edges.push(x);
    if (i < n - 1) {
      x += GAP;
      edges.push(x);
    }
  }
  return edges;
}

/**
 * The seeded console: on each side, three columns of panels in two rows (one
 * tall panel where the console is too low for two). Each side's upper row has
 * a screen; the middle lower panel on one side holds the throttle levers; the rest are lamp grids, toggle rows and blank plates. Now
 * and then a lower panel is a third screen. Deterministic per seed.
 */
export function cockpitLayout(seed: number): CockpitLayout {
  const rand = createRng(Math.floor(seed) * 7919 + 17);
  const panels: Panel[] = [];
  const lamps: Lamp[] = [];
  let groups = 0;
  let screens = 0;
  const leverSide = rand() < 0.5 ? -1 : 1;
  const thirdScreen = rand() < 0.5 ? (rand() < 0.5 ? -1 : 1) : 0;

  const addGrid = (p: Panel, cols: number, rows: number, toggles: boolean) => {
    if (cols < 1 || rows < 1 || lamps.length + cols * rows > MAX_LIGHTS) {
      p.kind = PANEL_PLATE;
      return;
    }
    p.cols = cols;
    p.rows = rows;
    p.base = lamps.length + 1;
    for (let r = 0; r < rows; r++) {
      const group = rand() < 0.5 ? groups++ : -1;
      for (let c = 0; c < cols; c++) {
        const pick = rand();
        const colour = toggles
          ? pick < 0.5
            ? LAMP_GREEN
            : pick < 0.8
              ? LAMP_AMBER
              : LAMP_RED
          : pick < 0.35
            ? LAMP_AMBER
            : pick < 0.65
              ? LAMP_RED
              : pick < 0.9
                ? LAMP_WHITE
                : LAMP_GREEN;
        lamps.push({
          colour,
          dead: rand() < 0.1,
          rank: rand(),
          blinkRank: rand(),
          period: 1.6 + 5 * rand(),
          phase: rand(),
          duty: 0.35 + 0.4 * rand(),
          group,
          order: c,
        });
      }
    }
  };

  for (const side of [-1, 1]) {
    const edges = split(CLUSTER_INNER, CLUSTER_OUTER, 3, rand);
    const screenCol = 1 + Math.floor(rand() * 2);
    const thirdCol = thirdScreen === side ? 2 : -1;
    for (let col = 0; col < 3; col++) {
      const inner = edges[col * 2];
      const outer = edges[col * 2 + 1];
      const x0 = side < 0 ? -outer : inner;
      const x1 = side < 0 ? -inner : outer;
      // The console top rises outwards, so its inner edge sets the panel's top.
      const top = consoleTop(inner) - LIP - 0.016;
      const mid = top - UPPER_HEIGHT;
      // Where the console is low, a column is one tall panel instead of two.
      const single = mid - GAP - PANELS_BOTTOM < MIN_LOWER;
      for (let row = single ? 1 : 0; row < 2; row++) {
        const p: Panel = {
          x0,
          y0: row === 0 ? mid : PANELS_BOTTOM,
          x1,
          y1: row === 0 ? top : single ? top : mid - GAP,
          kind: PANEL_PLATE,
          cols: 0,
          rows: 0,
          base: 0,
          cellW: 0,
          cellH: 0,
          tone: rand(),
          variant: 0,
        };
        const w = p.x1 - p.x0 - 0.02;
        const h = p.y1 - p.y0 - 0.02;
        const pick = rand();
        const upper = row === 0 || single;
        if ((upper && col === screenCol) || (row === 1 && col === thirdCol)) {
          if (screens < MAX_SCREENS) {
            p.kind = PANEL_SCREEN;
            p.variant = screens++;
          }
        } else if (row === 1 && col === 1 && side === leverSide) {
          p.kind = PANEL_LEVERS;
          p.variant = 2 + Math.floor(rand() * 3);
        } else if (pick < 0.5) {
          p.kind = PANEL_LAMPS;
          p.cellW = p.cellH = LAMP_CELL;
          const cols = Math.min(LAMP_COLS, Math.floor(w / LAMP_CELL));
          const rows = Math.min(row === 0 ? 2 : LAMP_ROWS, Math.floor(h / LAMP_CELL));
          addGrid(p, cols, rows, false);
        } else if (pick < 0.85) {
          p.kind = PANEL_TOGGLES;
          p.cellW = TOGGLE_W;
          p.cellH = TOGGLE_H;
          const cols = Math.min(TOGGLE_COLS, Math.floor(w / TOGGLE_W));
          const rows = Math.min(row === 0 ? 1 : 2, Math.floor(h / TOGGLE_H));
          addGrid(p, cols, rows, true);
        }
        panels.push(p);
      }
    }
  }
  return { panels, lamps, groups, screens };
}

/** Floats per panel in `packPanels`: three vec4s. */
export const PANEL_FLOATS = 12;

/**
 * Packs panels into three vec4 uniform arrays' worth of floats, panel after
 * panel: (x0, y0, x1, y1), (kind, cols, rows, base), (cellW, cellH, tone, variant).
 */
export function packPanels(panels: readonly Panel[], out: Float32Array): void {
  out.fill(0);
  const n = Math.min(panels.length, MAX_PANELS);
  for (let i = 0; i < n; i++) {
    const p = panels[i];
    out.set([p.x0, p.y0, p.x1, p.y1], i * 4);
    out.set([p.kind, p.cols, p.rows, p.base], (MAX_PANELS + i) * 4);
    out.set([p.cellW, p.cellH, p.tone, p.variant], (2 * MAX_PANELS + i) * 4);
  }
}
