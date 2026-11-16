/**
 * Gamer Den's wall of hexagonal light panels: the cluster's layout, the
 * neighbour graph the Reactive ripples spread along, and each mode's colours.
 *
 * Everything here is in design units (frame heights at 16:9, see `fitScale`),
 * with the cluster on the right; the scene mirrors it for the left. Colours are
 * unit RGB. The show steps on the CPU and hands the renderer one colour per
 * panel each frame.
 */
import { createColorEase, type Rgb } from "../color";
import { clamp, fract, smoothstep } from "../math";
import { MAX_PATTERN_HZ } from "../motion-limits";
import { hash32 } from "../noise";
import { fitScale } from "../scene-layout";

export type PanelMode = "wave" | "breathe" | "static" | "reactive";
export type PaletteId = "rainbow" | "synth" | "ocean" | "ember" | "forest" | "mono";

/**
 * The panels' cells on a flat-topped hexagon grid, in axial coordinates
 * (q to the right, r up and to the left): an irregular cluster stepping down
 * from top left to bottom right, with a spur at the top.
 */
export const PANEL_CELLS: readonly (readonly [number, number])[] = [
  [0, 2],
  [1, 1],
  [1, 2],
  [2, 0],
  [2, 1],
  [3, 0],
  [3, -1],
  [4, -1],
  [4, 0],
  [4, -2],
  [2, 2],
];
export const PANEL_COUNT = PANEL_CELLS.length;

/** Centre to corner of a grid cell (design units). */
export const PANEL_SPACING = 0.058;
/** Centre to corner of a panel: a little smaller than its cell, leaving a gap. */
export const PANEL_RADIUS = PANEL_SPACING * 0.92;
/** Gap between the cluster's outer edge and the frame's side, and its top and the design frame's top. */
const CLUSTER_MARGIN_X = 0.05;
const CLUSTER_TOP = 0.45;

const SQRT3 = Math.sqrt(3);

/** A cell's centre relative to cell (0, 0), in grid spacings. */
function cellX(q: number): number {
  return 1.5 * q;
}
function cellY(q: number, r: number): number {
  return SQRT3 * (r + q / 2);
}

/** The cluster's extent around cell (0, 0), in grid spacings, panels' corners included. */
const EXTENT = (() => {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [q, r] of PANEL_CELLS) {
    x0 = Math.min(x0, cellX(q) - 1);
    x1 = Math.max(x1, cellX(q) + 1);
    y0 = Math.min(y0, cellY(q, r) - SQRT3 / 2);
    y1 = Math.max(y1, cellY(q, r) + SQRT3 / 2);
  }
  return { x0, x1, y0, y1 };
})();

/** Half the frame's width in design units, at aspect ratio `aspect`. */
function halfWidth(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return (0.5 * a) / fitScale(a);
}

/**
 * Writes each panel's centre (x, y pairs, design units) for a frame of aspect
 * ratio `aspect`, with the cluster in the upper right: its right edge a margin
 * in from the frame's side, so a wider frame moves it outwards with the edge.
 */
export function panelCentres(aspect: number, out: Float32Array): Float32Array {
  const right = halfWidth(aspect) - CLUSTER_MARGIN_X;
  const ox = right - EXTENT.x1 * PANEL_SPACING;
  const oy = CLUSTER_TOP - EXTENT.y1 * PANEL_SPACING;
  for (let i = 0; i < PANEL_COUNT; i++) {
    const [q, r] = PANEL_CELLS[i];
    out[2 * i] = ox + cellX(q) * PANEL_SPACING;
    out[2 * i + 1] = oy + cellY(q, r) * PANEL_SPACING;
  }
  return out;
}

/** Each panel's position across the cluster, 0 at its left edge to 1 at its right, for the Wave. */
const PANEL_ACROSS: Float32Array = (() => {
  const out = new Float32Array(PANEL_COUNT);
  for (let i = 0; i < PANEL_COUNT; i++) {
    out[i] = (cellX(PANEL_CELLS[i][0]) - EXTENT.x0) / (EXTENT.x1 - EXTENT.x0);
  }
  return out;
})();

const AXIAL_STEPS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
];

/** The panels touching each panel (sharing an edge), by index. */
export const PANEL_NEIGHBOURS: readonly (readonly number[])[] = PANEL_CELLS.map(([q, r]) =>
  AXIAL_STEPS.map(([dq, dr]) =>
    PANEL_CELLS.findIndex(([q2, r2]) => q2 === q + dq && r2 === r + dr),
  ).filter((i) => i >= 0),
);

/** Hops from panel `a` to panel `b` along the neighbour graph, at `a * PANEL_COUNT + b`; 255 if unreachable. */
export const PANEL_HOPS: Uint8Array = (() => {
  const hops = new Uint8Array(PANEL_COUNT * PANEL_COUNT).fill(255);
  for (let a = 0; a < PANEL_COUNT; a++) {
    const row = a * PANEL_COUNT;
    hops[row + a] = 0;
    const queue = [a];
    // An array iterator sees what is pushed while it walks, so this is a breadth-first search.
    for (const at of queue) {
      for (const n of PANEL_NEIGHBOURS[at]) {
        if (hops[row + n] === 255) {
          hops[row + n] = hops[row + at] + 1;
          queue.push(n);
        }
      }
    }
  }
  return hops;
})();

/** Colours per palette, sampled as a loop (the last blends back into the first). */
export const PALETTE_STOPS = 6;

const PALETTES: Readonly<Record<Exclude<PaletteId, "mono">, readonly Rgb[]>> = {
  rainbow: [
    [1, 0.2, 0.25],
    [1, 0.62, 0.12],
    [0.55, 0.95, 0.2],
    [0.1, 0.85, 0.85],
    [0.25, 0.35, 1],
    [0.8, 0.25, 1],
  ],
  synth: [
    [1, 0.22, 0.68],
    [0.72, 0.3, 1],
    [0.2, 0.85, 1],
    [0.1, 0.95, 0.9],
    [0.4, 0.5, 1],
    [0.95, 0.3, 0.9],
  ],
  ocean: [
    [0.05, 0.45, 0.9],
    [0.1, 0.75, 0.85],
    [0.2, 0.95, 0.75],
    [0.15, 0.6, 1],
    [0.3, 0.35, 0.95],
    [0.1, 0.55, 0.7],
  ],
  ember: [
    [1, 0.32, 0.08],
    [1, 0.55, 0.12],
    [1, 0.78, 0.3],
    [0.95, 0.2, 0.15],
    [0.85, 0.12, 0.3],
    [1, 0.42, 0.2],
  ],
  forest: [
    [0.25, 0.85, 0.35],
    [0.6, 0.9, 0.25],
    [0.15, 0.7, 0.55],
    [0.9, 0.85, 0.35],
    [0.35, 0.95, 0.6],
    [0.2, 0.6, 0.3],
  ],
};

/** Mono's stops as brightness and whiteness of the accent colour. */
const MONO_SHADES: readonly (readonly [number, number])[] = [
  [1, 0],
  [0.7, 0],
  [1, 0.35],
  [0.55, 0],
  [0.85, 0.15],
  [0.4, 0],
];

/** Writes the palette's stops (PALETTE_STOPS RGB triples) into `out`; Mono shades `accent`. */
export function paletteStops(
  id: PaletteId,
  accent: Readonly<Rgb>,
  out: Float32Array,
): Float32Array {
  for (let s = 0; s < PALETTE_STOPS; s++) {
    for (let c = 0; c < 3; c++) {
      if (id === "mono") {
        const [level, white] = MONO_SHADES[s];
        out[3 * s + c] = level * (accent[c] + (1 - accent[c]) * white);
      } else {
        out[3 * s + c] = PALETTES[id][s][c];
      }
    }
  }
  return out;
}

/** Writes the colour at `u` (wrapping, one loop of the palette per unit) into `out` at `o`. */
export function samplePalette(
  stops: ArrayLike<number>,
  u: number,
  out: Float32Array,
  o: number,
): void {
  const x = fract(u) * PALETTE_STOPS;
  const s0 = Math.min(PALETTE_STOPS - 1, Math.floor(x));
  const s1 = (s0 + 1) % PALETTE_STOPS;
  const f = smoothstep(0, 1, x - s0);
  for (let c = 0; c < 3; c++) {
    out[o + c] = stops[3 * s0 + c] + (stops[3 * s1 + c] - stops[3 * s0 + c]) * f;
  }
}

/** Wave: palette loops per second per unit of speed. At speed 1 one loop takes about 8 s. */
const WAVE_RATE = 0.12;
/** How much of the palette's loop the cluster spans at once, left to right. */
const WAVE_SPAN = 0.45;
/** Breathe: the slowest cycle's length (s) at speed 1; slower speeds stretch it. */
export const BREATHE_PERIOD = 6;
/** Breathe breathes between these two stops. */
const BREATHE_STOPS = [0, 3] as const;

/** Wave: panel `i`'s colour at `phase` (palette loops travelled). */
export function waveColour(
  stops: ArrayLike<number>,
  i: number,
  phase: number,
  out: Float32Array,
  o: number,
): void {
  samplePalette(stops, phase - PANEL_ACROSS[i] * WAVE_SPAN, out, o);
}

/** Breathe: every panel's colour at `phase` (breaths taken). */
export function breatheColour(
  stops: ArrayLike<number>,
  phase: number,
  out: Float32Array,
  o: number,
): void {
  const f = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  const a = 3 * BREATHE_STOPS[0];
  const b = 3 * BREATHE_STOPS[1];
  for (let c = 0; c < 3; c++) {
    out[o + c] = stops[a + c] + (stops[b + c] - stops[a + c]) * f;
  }
}

/** Static: panel `i`'s own colour, spread round the palette (golden-ratio steps). */
export function staticColour(
  stops: ArrayLike<number>,
  i: number,
  out: Float32Array,
  o: number,
): void {
  samplePalette(stops, fract(i * 0.618034) + 0.5 / PALETTE_STOPS, out, o);
}

/** Reactive: how bright the panels rest between ripples (share of full). */
const CALM_LEVEL = 0.4;
/** A ripple's rise and fade at each panel (s). */
export const RIPPLE_RISE = 0.3;
export const RIPPLE_FADE = 1.6;
/** Delay per hop as a ripple spreads (s). */
const RIPPLE_HOP = 0.2;
/** Each hop weakens the ripple by this factor. */
const RIPPLE_HOP_DECAY = 0.82;
/** Longest a ripple lasts anywhere on the cluster (s). */
export const RIPPLE_LIFE =
  RIPPLE_HOP * Math.max(...PANEL_HOPS.filter((h) => h < 255)) + RIPPLE_RISE + RIPPLE_FADE;
/** Gap between ripples at speed 1 (s); slower speeds stretch it. */
export const RIPPLE_GAP_MIN = 1.5;
const RIPPLE_GAP_MAX = 4;
/** Ripples remembered at once; the gaps keep the oldest finished before it is reused. */
export const MAX_RIPPLES = 4;

/** A ripple's strength at a panel `tau` seconds after it reached it: rises over RIPPLE_RISE, fades over RIPPLE_FADE. */
export function rippleEnvelope(tau: number): number {
  if (!(tau > 0)) {
    return 0;
  }
  if (tau < RIPPLE_RISE) {
    return smoothstep(0, 1, tau / RIPPLE_RISE);
  }
  return 1 - smoothstep(0, 1, (tau - RIPPLE_RISE) / RIPPLE_FADE);
}

/** The gap (s) before ripple `n`, latched from `speed` when the ripple before it starts. */
export function rippleGap(n: number, speed: number): number {
  const u = hash32(n * 2 + 1) / 4294967296;
  return (RIPPLE_GAP_MIN + (RIPPLE_GAP_MAX - RIPPLE_GAP_MIN) * u) / clampSpeed(speed);
}

const SPEED_MIN = 0.1;
const SPEED_MAX = 1;
function clampSpeed(speed: number): number {
  return Number.isFinite(speed) ? clamp(speed, SPEED_MIN, SPEED_MAX) : SPEED_MIN;
}

/** The Reactive mode's ripples: when each started, where, and in which palette colour. */
interface Ripples {
  /** Seconds since the show started. */
  readonly time: number;
  /** Ripples started so far. */
  readonly count: number;
  step: (dt: number, speed: number) => void;
  /** Writes panel `i`'s Reactive colour (calm colour plus the ripples passing) into `out` at `o`. */
  colour: (stops: ArrayLike<number>, i: number, out: Float32Array, o: number) => void;
}

export function createRipples(): Ripples {
  const start = new Float64Array(MAX_RIPPLES).fill(-Infinity);
  const source = new Uint8Array(MAX_RIPPLES);
  const hue = new Float32Array(MAX_RIPPLES);
  const tint = new Float32Array(3);
  let time = 0;
  let count = 0;
  /** When the next ripple starts; set by the first step, from its speed. */
  let next = Number.NaN;
  return {
    get time() {
      return time;
    },
    get count() {
      return count;
    },
    step(dt, speed) {
      time += Number.isFinite(dt) ? Math.max(0, dt) : 0;
      if (Number.isNaN(next)) {
        next = rippleGap(0, speed);
      }
      while (time >= next) {
        const slot = count % MAX_RIPPLES;
        const h = hash32(count * 2 + 0x51);
        start[slot] = next;
        source[slot] = h % PANEL_COUNT;
        hue[slot] = ((h >>> 8) % PALETTE_STOPS) / PALETTE_STOPS;
        count++;
        next += rippleGap(count, speed);
      }
    },
    colour(stops, i, out, o) {
      staticColour(stops, i, out, o);
      let sum = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < MAX_RIPPLES; k++) {
        const hops = PANEL_HOPS[source[k] * PANEL_COUNT + i];
        const e = rippleEnvelope(time - start[k] - hops * RIPPLE_HOP) * RIPPLE_HOP_DECAY ** hops;
        if (e > 0) {
          samplePalette(stops, hue[k], tint, 0);
          sum += e;
          r += e * tint[0];
          g += e * tint[1];
          b += e * tint[2];
        }
      }
      // Overlapping ripples share one full-strength flash between them.
      const norm = sum > 1 ? 1 / sum : 1;
      const rest = CALM_LEVEL * (1 - sum * norm);
      out[o] = out[o] * rest + r * norm;
      out[o + 1] = out[o + 1] * rest + g * norm;
      out[o + 2] = out[o + 2] * rest + b * norm;
    },
  };
}

/** A mode or palette change eases over this long (s). */
const SHOW_EASE = 1.2;
/**
 * The fastest any panel's colour channel may change (per second): a full
 * swing at MAX_PATTERN_HZ, sinusoidal, peaks at this slope.
 */
export const MAX_PANEL_RATE = Math.PI * MAX_PATTERN_HZ;

/** The panels' colours over time, mode by mode, with eased mode and palette changes. */
interface PanelShow {
  /** Each panel's colour, RGB triples, after the latest step. */
  readonly colours: Float32Array;
  step: (
    dt: number,
    mode: PanelMode,
    palette: PaletteId,
    accent: Readonly<Rgb>,
    speed: number,
  ) => Float32Array;
}

export function createPanelShow(): PanelShow {
  const colours = new Float32Array(3 * PANEL_COUNT);
  const live = new Float32Array(3 * PANEL_COUNT);
  const from = new Float32Array(3 * PANEL_COUNT);
  const target = new Float32Array(3 * PALETTE_STOPS);
  const palette = createColorEase(3 * PALETTE_STOPS);
  const ripples = createRipples();
  let wave = 0;
  let breath = 0;
  let mode: PanelMode | null = null;
  /** Progress of the change into `mode`, 0..1. */
  let blend = 1;
  return {
    colours,
    step(dt, nextMode, paletteId, accent, speed) {
      const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
      const s = clampSpeed(speed);
      wave += step * s * WAVE_RATE;
      breath += (step * s) / BREATHE_PERIOD;
      ripples.step(step, s);
      const stops = palette.step(paletteStops(paletteId, accent, target), step, SHOW_EASE);
      if (mode === null) {
        mode = nextMode;
      } else if (nextMode !== mode) {
        // Ease from where the panels are now, even part-way through another change.
        from.set(colours);
        mode = nextMode;
        blend = 0;
      }
      for (let i = 0; i < PANEL_COUNT; i++) {
        const o = 3 * i;
        switch (mode) {
          case "breathe":
            breatheColour(stops, breath, live, o);
            break;
          case "static":
            staticColour(stops, i, live, o);
            break;
          case "reactive":
            ripples.colour(stops, i, live, o);
            break;
          case "wave":
            waveColour(stops, i, wave, live, o);
        }
      }
      blend = Math.min(1, blend + step / SHOW_EASE);
      const f = smoothstep(0, 1, blend);
      for (let k = 0; k < colours.length; k++) {
        colours[k] = blend >= 1 ? live[k] : from[k] + (live[k] - from[k]) * f;
      }
      return colours;
    },
  };
}
