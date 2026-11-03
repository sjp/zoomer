/**
 * Pure JS side of the Snowy Hot Spring effect (hotspring.ts): the layout of the
 * pool, the rocks around it and the lantern, the rock column table, the steam
 * emitters (configuring the smoke model in smoke-sim.ts), the snow's fade mask
 * over the steam, the ripple phases and the time-of-day palettes.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up, so the scene keeps its shape at any aspect ratio. The
 * pool fills the bottom of the frame, its far edge at WATERLINE; boulders frame
 * it at both sides, their mass widening with the aspect ratio so the middle
 * third (behind the speaker) stays open water and steam.
 */
import { clamp, smoothstep, wrap } from "./math";
import { createRng } from "./noise";
import type { Rgb } from "./color";
import type { SpringTime } from "./hotspring.meta";
import type { Flow } from "./smoke-sim";

/** The pool's far edge: water below, the snowy bank above. */
export const WATERLINE = 0.25;

/** Rock column table: columns across the frame, and rows (near rocks, far rim). */
export const ROCK_COLUMNS = 2048;
export const ROCK_ROWS = 2;
/** Floats per column: top, bottom, snow-cap depth, crease (0..1). */
export const ROCK_CHANNELS = 4;
/** Top of an empty column: below everything. Bottom of one: above everything. */
const EMPTY_TOP = -1;
const EMPTY_BOTTOM = 2;

/** A boulder: a half-ellipse resting on `base`, `rx` wide and `ry` tall (height units). */
export interface Boulder {
  x: number;
  base: number;
  rx: number;
  ry: number;
}

/**
 * Hand-placed boulders for each side, from the frame edge inwards: centre (as a
 * share of the side mass's width, 0 at the frame edge), half-width (share of the
 * mass width), top height (height units) and height / half-width. The innermost
 * ones stand in the water, their bases above the bottom of the frame.
 */
const SIDE_BOULDERS = {
  left: [
    [0.02, 0.3, 0.5, 0.7],
    [0.3, 0.22, 0.41, 0.75],
    [0.52, 0.18, 0.33, 0.8],
    [0.72, 0.14, 0.24, 0.8],
    [0.9, 0.09, 0.17, 0.75],
    [1.04, 0.05, 0.135, 0.7],
  ],
  right: [
    [0.0, 0.28, 0.47, 0.75],
    [0.26, 0.2, 0.42, 0.7],
    [0.47, 0.21, 0.32, 0.75],
    [0.7, 0.15, 0.25, 0.8],
    [0.88, 0.1, 0.18, 0.8],
  ],
} as const;
/** The right-hand boulder the lantern stands on. */
const LANTERN_BOULDER = 1;
/** How far the lantern's foot sinks into the snow on its boulder. */
const LANTERN_SINK = 0.006;
/** Lantern height, height units. Its parts are laid out in hotspring.ts. */
export const LANTERN_H = 0.13;
/** Firebox centre above the lantern's foot, as a share of LANTERN_H. */
export const LANTERN_FIRE = 0.6;
/**
 * A snow-covered bank under the boulders of each side mass, so no gaps open
 * between them: its top above the waterline at the frame edge, and where it
 * ends (share of the mass width).
 */
const BANK_RISE = 0.14;
const BANK_END = 0.8;

/** Side mass width (height units) for an aspect ratio. */
export function sideMass(aspect: number): number {
  return clamp(0.2 * aspect + 0.05, 0.3, 0.55);
}

export interface SpringLayout {
  aspect: number;
  /** Width of each side's rock mass; the open pool lies between. */
  mass: number;
  /** The open pool between the rock masses, x. */
  poolX0: number;
  poolX1: number;
  near: Boulder[];
  far: Boulder[];
  /** Lantern foot centre (height units). */
  lanternX: number;
  lanternY: number;
  /** Highest rock or lantern top, for the silhouette pass's scissor. */
  top: number;
  /** Steam box (height units): x0, y0, x1, y1. */
  steam: [number, number, number, number];
}

/** Near-rock envelope at x: the bank and every boulder (EMPTY_TOP where there's none). */
export function nearTopAt(l: SpringLayout, x: number): number {
  return envelope(l, x).top;
}

const env = { top: 0, bottom: 0, id: 0 };

/** Top, bottom and topmost contributor (-1 bank, -2 none) of the near rocks at x. */
function envelope(l: SpringLayout, x: number): typeof env {
  let top = EMPTY_TOP;
  let bottom = EMPTY_BOTTOM;
  let id = -2;
  // The bank under each side mass, sloping down to the waterline.
  const t = Math.min(x, l.aspect - x) / l.mass;
  if (t < BANK_END) {
    top = WATERLINE + BANK_RISE * Math.pow(1 - t / BANK_END, 1.5);
    bottom = -1;
    id = -1;
  }
  for (let i = 0; i < l.near.length; i++) {
    const b = l.near[i];
    const u = (x - b.x) / b.rx;
    if (u <= -1 || u >= 1) continue;
    const h = b.base + b.ry * Math.sqrt(1 - u * u);
    bottom = Math.min(bottom, b.base);
    if (h > top) {
      top = h;
      id = i;
    }
  }
  env.top = top;
  env.bottom = bottom;
  env.id = id;
  return env;
}

/** Lays out the pool, rocks, lantern and steam box for an `aspect`-wide frame. */
export function springLayout(aspect: number): SpringLayout {
  const a = Math.max(aspect, 0.5);
  const mass = sideMass(a);
  const near: Boulder[] = [];
  for (const [t, w, top, k] of SIDE_BOULDERS.left) {
    const rx = w * mass;
    near.push({ x: t * mass, base: top - rx * k, rx, ry: rx * k });
  }
  for (const [t, w, top, k] of SIDE_BOULDERS.right) {
    const rx = w * mass;
    near.push({ x: a - t * mass, base: top - rx * k, rx, ry: rx * k });
  }

  // A low rim of stones along the far edge, with gaps, behind the open pool.
  const far: Boulder[] = [];
  const rng = createRng(0x0915e);
  for (let x = mass * 0.6; x < a - mass * 0.6;) {
    const rx = 0.012 + 0.03 * rng();
    const cx = x + rx;
    if (rng() < 0.72) {
      const ry = rx * (0.45 + 0.3 * rng());
      far.push({ x: cx, base: WATERLINE - 0.008, rx, ry });
    }
    x = cx + rx * (0.6 + 0.8 * rng());
  }

  const right = near[SIDE_BOULDERS.left.length + LANTERN_BOULDER];
  const lanternX = right.x;
  const l: SpringLayout = {
    aspect: a,
    mass,
    poolX0: mass,
    poolX1: a - mass,
    near,
    far,
    lanternX,
    lanternY: 0,
    top: 0,
    steam: [0, 0, 0, 0],
  };
  l.lanternY = nearTopAt(l, lanternX) - LANTERN_SINK;
  let top = l.lanternY + LANTERN_H;
  for (const b of near) top = Math.max(top, b.base + b.ry);
  l.top = Math.min(1, top + 0.01);
  l.steam[0] = Math.max(0, l.poolX0 - STEAM_SPILL);
  l.steam[1] = WATERLINE - STEAM_BELOW;
  l.steam[2] = Math.min(a, l.poolX1 + STEAM_SPILL);
  l.steam[3] = Math.min(1, WATERLINE + STEAM_ABOVE);
  return l;
}

/**
 * Fills the rock column table (ROCK_COLUMNS x ROCK_ROWS x ROCK_CHANNELS floats):
 * per column, each row's top and bottom, the depth of snow on top (thinning on
 * steep flanks, gone on cliffs) and a crease (1 where two boulders meet).
 */
export function buildRockTable(l: SpringLayout, out: Float32Array): void {
  const n = ROCK_COLUMNS;
  const dx = l.aspect / n;
  const ids = new Int32Array(n);
  const tops = new Float64Array(n);
  // Row 0: near rocks.
  for (let c = 0; c < n; c++) {
    const e = envelope(l, (c + 0.5) * dx);
    const o = c * ROCK_CHANNELS;
    out[o] = e.top;
    out[o + 1] = e.bottom;
    tops[c] = e.top;
    ids[c] = e.id;
  }
  capsAndCreases(out, 0, tops, ids, dx);
  // Row 1: the far rim.
  for (let c = 0; c < n; c++) {
    const x = (c + 0.5) * dx;
    let top = EMPTY_TOP;
    let bottom = EMPTY_BOTTOM;
    let id = -2;
    for (let i = 0; i < l.far.length; i++) {
      const b = l.far[i];
      const u = (x - b.x) / b.rx;
      if (u <= -1 || u >= 1) continue;
      const h = b.base + b.ry * Math.sqrt(1 - u * u);
      bottom = Math.min(bottom, b.base);
      if (h > top) {
        top = h;
        id = i;
      }
    }
    const o = (n + c) * ROCK_CHANNELS;
    out[o] = top;
    out[o + 1] = bottom;
    tops[c] = top;
    ids[c] = id;
  }
  capsAndCreases(out, n * ROCK_CHANNELS, tops, ids, dx);
}

/** Snow depth on a flat top, height units, and where creases fade out. */
export const CAP_DEPTH = 0.024;
const CREASE_WIDTH = 0.012;

function capsAndCreases(
  out: Float32Array,
  offset: number,
  tops: Float64Array,
  ids: Int32Array,
  dx: number,
): void {
  const n = tops.length;
  // Distance to the nearest place where one boulder (or the bank) meets another,
  // both ways. A rock's outer edge, next to an empty column, is not a crease.
  const meets = (a: number, b: number) => a !== b && a !== -2 && b !== -2;
  let last = -1e9;
  const dist = new Float64Array(n);
  for (let c = 0; c < n; c++) {
    if (c > 0 && meets(ids[c], ids[c - 1])) last = c - 0.5;
    dist[c] = (c - last) * dx;
  }
  last = 1e9;
  for (let c = n - 1; c >= 0; c--) {
    if (c < n - 1 && meets(ids[c], ids[c + 1])) last = c + 0.5;
    dist[c] = Math.min(dist[c], (last - c) * dx);
  }
  for (let c = 0; c < n; c++) {
    const o = offset + c * ROCK_CHANNELS;
    if (ids[c] === -2) {
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }
    // Snow lies thick on flat tops and slides off steep flanks.
    const l = tops[Math.max(0, c - 1)];
    const r = tops[Math.min(n - 1, c + 1)];
    const slope = Math.abs((r - l) / (2 * dx));
    const flat = clamp(1 - slope / 1.6, 0, 1);
    const wobble = 0.85 + 0.15 * Math.sin(c * dx * 47) * Math.sin(c * dx * 13 + 1);
    out[o + 2] = CAP_DEPTH * Math.pow(flat, 0.7) * wobble;
    out[o + 3] = 1 - smoothstep(0, CREASE_WIDTH, dist[c]);
  }
}

/** Steam box beyond the pool's sides, below the waterline and above it. */
export const STEAM_SPILL = 0.12;
export const STEAM_BELOW = 0.14;
export const STEAM_ABOVE = 0.5;
/** Sim units per height unit. */
export const STEAM_SCALE = 1.4;
/** Steam grid cell size, 1080p reference px; the grid is the same at every resolution. */
export const STEAM_CELL_REF = 4;

/** The steam box in sim units (x0, y0, width, height), centred on the pool's far edge. */
export function steamRegion(l: SpringLayout, out: Float64Array): void {
  const cx = 0.5 * l.aspect;
  out[0] = (l.steam[0] - cx) * STEAM_SCALE;
  out[1] = (l.steam[1] - WATERLINE) * STEAM_SCALE;
  out[2] = (l.steam[2] - l.steam[0]) * STEAM_SCALE;
  out[3] = (l.steam[3] - l.steam[1]) * STEAM_SCALE;
}

/** Steam grid size in cells, written to `out`: fixed, from the box at 1080p. */
export function steamGrid(l: SpringLayout, out: Int32Array | number[]): void {
  out[0] = Math.max(1, Math.ceil(((l.steam[2] - l.steam[0]) * 1080) / STEAM_CELL_REF));
  out[1] = Math.max(1, Math.ceil(((l.steam[3] - l.steam[1]) * 1080) / STEAM_CELL_REF));
}

/** Emitter settings for the smoke field, sim units. */
export interface SpringEmitters {
  /** Far and near emitters: (x, y, segment half-width, strength), as `uEmit0` / `uEmit1`. */
  far: [number, number, number, number];
  near: [number, number, number, number];
  /** Seconds for density to fall by e at the surface. */
  life: number;
  /** Wisp modulation along the surface. */
  wisp: number;
}

export const createEmitters = (): SpringEmitters => ({
  far: [0, 0, 0, 0],
  near: [0, 0, 0, 0],
  life: 1,
  wisp: 0,
});

/** The near emitter: below the far edge (height units) and its share of the far one's output. */
export const NEAR_DROP = 0.09;
export const NEAR_SHARE = 0.55;
/** Life at steam 0 and 1, and the extra fade per sim unit of height. */
export const STEAM_LIFE = [1.6, 3.6] as const;
export const STEAM_HEIGHT_DECAY = 0.7;
/** Wisp amount at steam 0 and 1: more steam fills in between the wisps. */
export const STEAM_WISP = [0.75, 0.5] as const;
/** Wisps per sim unit along the surface, and their drift (rad/s). */
export const WISP_K = 22;
export const WISP_SPEED = 0.25;
/** Splat radius, sim units. */
export const STEAM_RADIUS = 0.03;

/** Maps the `steam` param (0..1) to bounded emitter values for this layout. */
export function springEmitters(l: SpringLayout, steam: number, out: SpringEmitters): void {
  const s = clamp(Number.isFinite(steam) ? steam : 0, 0, 1);
  const hw = (0.5 * (l.poolX1 - l.poolX0) + 0.03) * STEAM_SCALE;
  out.far[0] = 0;
  out.far[1] = 0;
  out.far[2] = hw;
  out.far[3] = s;
  out.near[0] = 0;
  out.near[1] = -NEAR_DROP * STEAM_SCALE;
  out.near[2] = hw * 0.85;
  out.near[3] = s * NEAR_SHARE;
  out.life = STEAM_LIFE[0] + (STEAM_LIFE[1] - STEAM_LIFE[0]) * s;
  out.wisp = STEAM_WISP[0] + (STEAM_WISP[1] - STEAM_WISP[0]) * s;
}

/** Steam rise (sim units/s), curl strength, and the band over which the curl sets in. */
export const STEAM_RISE = 0.12;
export const STEAM_CURL = 1.4;
export const STEAM_ONSET = [0, 0.4] as const;

/** Fills the parts of the smoke flow that don't depend on time. */
export function steamFlow(out: Flow): Flow {
  out.rise = STEAM_RISE;
  out.curl = STEAM_CURL;
  out.onset0 = STEAM_ONSET[0];
  out.onset1 = STEAM_ONSET[1];
  return out;
}

/** Steady sideways lean and peak gust, sim units/s per sim unit of height. */
export const DRAFT_LEAN = 0.12;
export const DRAFT_GUST = 0.18;
const TAU = Math.PI * 2;

/**
 * The breeze across the pool at time `t` (seconds, unwrapped), for the smoke
 * flow's `draft`: a steady lean plus slow gusts (a product of two sines, squared
 * keeping its sign), so the steam drifts sideways and now and then leans harder
 * or straightens. Smooth in `t`.
 */
export function springDraft(t: number): number {
  const g = Math.sin((TAU * t) / 53) * Math.sin((TAU * t) / 131 + 1);
  return DRAFT_LEAN + DRAFT_GUST * g * Math.abs(g);
}

/**
 * Where falling snow melts: 0 in the steam over the pool and in the water, 1
 * elsewhere. Over the pool (fading out over the rocks at the sides) flakes fade
 * through a band above the far edge, deeper with more steam, and are gone just
 * below it. Smooth in x and y, so no flake pops.
 */
export function meltMask(l: SpringLayout, steam: number, x: number, y: number): number {
  const s = clamp(Number.isFinite(steam) ? steam : 0, 0, 1);
  const pool =
    smoothstep(l.poolX0 - MASK_EDGE, l.poolX0 + MASK_EDGE, x) *
    (1 - smoothstep(l.poolX1 - MASK_EDGE, l.poolX1 + MASK_EDGE, x));
  const band = MELT_BAND[0] + (MELT_BAND[1] - MELT_BAND[0]) * s;
  const melt = 1 - smoothstep(WATERLINE - MELT_BELOW, WATERLINE + band, y);
  return 1 - pool * melt;
}

/** Melt band above the far edge at steam 0 and 1, and where it ends below it. */
export const MELT_BAND = [0.05, 0.3] as const;
export const MELT_BELOW = 0.03;
/** Half-width of the mask's fade across each side of the pool. */
export const MASK_EDGE = 0.1;
/** Mask texture size: smooth, so a small texture with bilinear filtering is enough. */
export const MASK_W = 96;
export const MASK_H = 64;

/**
 * Fills the snow fade mask (MASK_W x MASK_H bytes, row 0 at the top, as the
 * flake renderer samples it) with `meltMask` at each texel's centre.
 */
export function buildFadeMask(l: SpringLayout, steam: number, out: Uint8Array): void {
  for (let j = 0; j < MASK_H; j++) {
    const y = 1 - (j + 0.5) / MASK_H;
    for (let i = 0; i < MASK_W; i++) {
      const x = ((i + 0.5) / MASK_W) * l.aspect;
      out[j * MASK_W + i] = Math.round(meltMask(l, steam, x, y) * 255);
    }
  }
}

/**
 * Ripples on the water: wave numbers along x and in depth, amplitude, and whole
 * laps per RIPPLE_PERIOD (so phases wrap seamlessly). Slow and long.
 */
export const RIPPLES = [
  { kx: 9, kz: 2.1, amp: 0.5, laps: 31 },
  { kx: -14, kz: 2.9, amp: 0.3, laps: 47 },
  { kx: 23, kz: 4.3, amp: 0.2, laps: 71 },
  { kx: -5, kz: 1.3, amp: 0.4, laps: 19 },
] as const;
export const RIPPLE_PERIOD = 240;

/** Writes each ripple's phase at time `t` seconds (unwrapped), wrapped to [0, 2pi). */
export function ripplePhases(t: number, out: Float32Array | Float64Array): void {
  const tw = wrap(t, 0, RIPPLE_PERIOD);
  for (let i = 0; i < RIPPLES.length; i++) {
    out[i] = wrap((TAU * RIPPLES[i].laps * tw) / RIPPLE_PERIOD + i * 1.7, 0, TAU);
  }
}

/** Colours (unit RGB) and light levels for a time of day. */
export interface SpringPalette {
  skyTop: Rgb;
  skyLow: Rgb;
  /** Afterglow low over the mountains. */
  glow: Rgb;
  mountain: Rgb;
  pine: Rgb;
  snow: Rgb;
  rock: Rgb;
  water: Rgb;
  steam: Rgb;
  flake: Rgb;
  /** Lantern light strength (0 dims it to nothing against a bright day). */
  lantern: number;
}

export const PALETTES: Readonly<Record<SpringTime, SpringPalette>> = {
  dusk: {
    skyTop: [0.09, 0.12, 0.27],
    skyLow: [0.42, 0.42, 0.6],
    glow: [0.78, 0.55, 0.52],
    mountain: [0.36, 0.4, 0.56],
    pine: [0.06, 0.09, 0.14],
    snow: [0.6, 0.65, 0.8],
    rock: [0.13, 0.13, 0.16],
    water: [0.03, 0.15, 0.17],
    steam: [0.72, 0.75, 0.86],
    flake: [0.88, 0.91, 1.0],
    lantern: 1,
  },
  night: {
    skyTop: [0.015, 0.025, 0.07],
    skyLow: [0.08, 0.11, 0.22],
    glow: [0.12, 0.14, 0.26],
    mountain: [0.12, 0.15, 0.25],
    pine: [0.02, 0.03, 0.06],
    snow: [0.26, 0.3, 0.42],
    rock: [0.05, 0.05, 0.07],
    water: [0.01, 0.06, 0.08],
    steam: [0.38, 0.41, 0.52],
    flake: [0.7, 0.74, 0.86],
    lantern: 1.15,
  },
  day: {
    skyTop: [0.35, 0.55, 0.82],
    skyLow: [0.75, 0.83, 0.93],
    glow: [0.85, 0.88, 0.95],
    mountain: [0.68, 0.74, 0.86],
    pine: [0.1, 0.17, 0.17],
    snow: [0.9, 0.92, 0.97],
    rock: [0.27, 0.26, 0.27],
    water: [0.08, 0.33, 0.36],
    steam: [0.94, 0.95, 0.98],
    flake: [0.97, 0.98, 1.0],
    lantern: 0.35,
  },
};

/** The palette for a select value; unknown values fall back to dusk. */
export function paletteFor(id: string): SpringPalette {
  return Object.hasOwn(PALETTES, id) ? PALETTES[id as SpringTime] : PALETTES.dusk;
}

/** Index of a time value for change keys (0 dusk, 1 night, 2 day). */
export function timeIndex(id: string): number {
  return id === "night" ? 1 : id === "day" ? 2 : 0;
}
