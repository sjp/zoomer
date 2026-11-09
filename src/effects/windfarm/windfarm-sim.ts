/**
 * Pure JS parts of the wind farm effect (windfarm.ts): the hill table, the
 * time-of-day palettes, the turbine layout on the ridgelines and the rotor clock.
 * Nothing here touches GL, so it is all unit tested.
 *
 * Units: "height units", as in `ridges-sim.ts`: the canvas is 1 tall and `aspect`
 * wide, y up from the bottom edge. Hill layer 0 is the nearest. Turbine geometry
 * is in units of the turbine's tower height, with the origin at the tower's foot.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { clamp, wrap } from "../math";
import { createNoise, createRng, hash32 } from "../noise";
import { COLUMNS, latticePeriod, ridgeHeightAt, ridgeRaw, SPAN } from "../ridges/ridges-sim";
import { MAX_TURBINES, MIN_TURBINES, type SIDE_OPTIONS, type TIME_OPTIONS } from "./windfarm.meta";
import { lookup } from "../lookup";

export { COLUMNS, SPAN };

// ---------------------------------------------------------------------------
// Hills
// ---------------------------------------------------------------------------

/** Hill layers, nearest first. */
export const HILL_LAYERS = 4;

export interface HillShape {
  /** Height of the layer's lowest valley. */
  base: number;
  /** Height of its highest crest above `base`. */
  amp: number;
  /** Typical crest spacing (height units). */
  wavelength: number;
  /** How far its colour has faded toward the haze (0 nearest). */
  haze: number;
  /** Tower height of a turbine standing on it (height units). */
  turbine: number;
  /** Gaussian blur of the profile (sigma, height units): drops the small bumps, nearest most. */
  smooth: number;
}

/** Gentle, rolling layers: each sits higher, lower and tighter than the one in front. */
export const HILLS: readonly HillShape[] = [
  { base: 0.03, amp: 0.16, wavelength: 1.5, haze: 0, turbine: 0.3, smooth: 0.1 },
  { base: 0.17, amp: 0.12, wavelength: 1, haze: 0.28, turbine: 0.18, smooth: 0.04 },
  { base: 0.27, amp: 0.09, wavelength: 0.7, haze: 0.48, turbine: 0.11, smooth: 0.018 },
  { base: 0.34, amp: 0.07, wavelength: 0.5, haze: 0.64, turbine: 0.07, smooth: 0.012 },
];

/** Ridged-noise share of the hill profiles (`ridgeRaw`'s `peaks`): almost pure fBm, so rolling. */
const HILL_PEAKS = 0.1;

/** Gaussian blur of the periodic row `src` into `dst` (same length), sigma in samples. */
function blurPeriodic(src: Float32Array, dst: Float32Array, sigma: number): void {
  const n = src.length;
  const r = Math.ceil(3 * sigma);
  if (r < 1) {
    dst.set(src);
    return;
  }
  const kernel = new Float32Array(2 * r + 1);
  let total = 0;
  for (let k = -r; k <= r; k++) {
    total += kernel[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
  }
  for (let c = 0; c < n; c++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      sum += kernel[k + r] * src[(((c + k) % n) + n) % n];
    }
    dst[c] = sum / total;
  }
}

/**
 * Fills `out` (`HILL_LAYERS * COLUMNS` floats, row = layer, nearest first) with
 * the hill profiles for `seed`: absolute heights, each row spanning its layer's
 * band [base, base + amp] exactly after a blur that keeps it rolling, one `SPAN` wide and periodic (sample it with
 * `hillHeightAt` or a REPEAT-wrapped texture). Deterministic.
 */
export function fillHillTable(out: Float32Array, seed: number): void {
  const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const raw = new Float32Array(COLUMNS);
  for (let i = 0; i < HILL_LAYERS; i++) {
    const shape = HILLS[i];
    const noise = createNoise(s * 7919 + i * 104729 + 211);
    const p0 = latticePeriod(shape.wavelength);
    const row = i * COLUMNS;
    for (let c = 0; c < COLUMNS; c++) {
      raw[c] = ridgeRaw(noise, c / COLUMNS, p0, HILL_PEAKS);
    }
    blurPeriodic(raw, out.subarray(row, row + COLUMNS), (shape.smooth / SPAN) * COLUMNS);
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < COLUMNS; c++) {
      const v = out[row + c];
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
    const inv = hi > lo ? 1 / (hi - lo) : 0;
    for (let c = 0; c < COLUMNS; c++) {
      out[row + c] = shape.base + shape.amp * clamp((out[row + c] - lo) * inv, 0, 1);
    }
  }
}

/** Height of hill `layer` at x (height units), interpolated like the GPU's linear filter. */
export const hillHeightAt = (table: Float32Array, layer: number, x: number) =>
  ridgeHeightAt(table, layer, x);

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

export type TimeOfDay = (typeof TIME_OPTIONS)[number]["value"];

export interface FarmPalette {
  skyTop: Rgb;
  skyHorizon: Rgb;
  /** Sun glow colour, centre (x as a fraction of the width, y in height units), radius, strength. */
  glow: Rgb;
  sunX: number;
  sunY: number;
  glowRadius: number;
  glowStrength: number;
  cloudLight: Rgb;
  cloudShade: Rgb;
  /** Grass colour of each hill layer before haze, nearest first. */
  grass: readonly Rgb[];
  /** What distance fades toward. */
  haze: Rgb;
  /** Sunlit and shaded sides of the white turbines. */
  turbineLit: Rgb;
  turbineShade: Rgb;
  /** Light direction across the scene, -1 (from the left) to 1 (from the right). */
  lightX: number;
  /** How much a cloud shadow darkens the hills, 0..1. */
  shadow: number;
}

const palette = (p: {
  skyTop: string;
  skyHorizon: string;
  glow: string;
  sunX: number;
  sunY: number;
  glowRadius: number;
  glowStrength: number;
  cloudLight: string;
  cloudShade: string;
  grass: readonly string[];
  haze: string;
  turbineLit: string;
  turbineShade: string;
  lightX: number;
  shadow: number;
}): FarmPalette => ({
  ...p,
  skyTop: hexToUnitRgb(p.skyTop),
  skyHorizon: hexToUnitRgb(p.skyHorizon),
  glow: hexToUnitRgb(p.glow),
  cloudLight: hexToUnitRgb(p.cloudLight),
  cloudShade: hexToUnitRgb(p.cloudShade),
  grass: p.grass.map(hexToUnitRgb),
  haze: hexToUnitRgb(p.haze),
  turbineLit: hexToUnitRgb(p.turbineLit),
  turbineShade: hexToUnitRgb(p.turbineShade),
});

export const PALETTES: Readonly<Record<TimeOfDay, FarmPalette>> = {
  morning: palette({
    skyTop: "#6d8ec4",
    skyHorizon: "#f1dcc6",
    glow: "#ffe2b0",
    sunX: 0.16,
    sunY: 0.58,
    glowRadius: 0.32,
    glowStrength: 0.5,
    cloudLight: "#fff3e4",
    cloudShade: "#a9a8bc",
    grass: ["#41703a", "#5a8450", "#77956f", "#90a096"],
    haze: "#c9c9d0",
    turbineLit: "#fff4e8",
    turbineShade: "#9ca2b6",
    lightX: -0.8,
    shadow: 0.3,
  }),
  midday: palette({
    skyTop: "#4a83c6",
    skyHorizon: "#cfe3f2",
    glow: "#fffbea",
    sunX: 0.62,
    sunY: 1.25,
    glowRadius: 0.55,
    glowStrength: 0.22,
    cloudLight: "#ffffff",
    cloudShade: "#b3bfce",
    grass: ["#4d7c37", "#618d4a", "#7c9c6c", "#93a78f"],
    haze: "#b9cad7",
    turbineLit: "#f7f8f9",
    turbineShade: "#aab3c0",
    lightX: 0.35,
    shadow: 0.34,
  }),
  evening: palette({
    skyTop: "#3c5990",
    skyHorizon: "#f5b88c",
    glow: "#ffb072",
    sunX: 0.84,
    sunY: 0.52,
    glowRadius: 0.34,
    glowStrength: 0.6,
    cloudLight: "#ffd6b2",
    cloudShade: "#8b7b98",
    grass: ["#3a592d", "#526b41", "#6e7b5d", "#8a8a80"],
    haze: "#c8aaa0",
    turbineLit: "#ffe3c8",
    turbineShade: "#8f8ba2",
    lightX: 0.85,
    shadow: 0.28,
  }),
};

/** The palette for a `timeOfDay` value; unknown values fall back to midday. */
export function paletteFor(id: string): FarmPalette {
  return lookup(PALETTES, id, "midday");
}

/** Writes each hill layer's colour, its grass faded toward the haze by depth, as RGB triples. */
export function fillHillColors(out: Float32Array, pal: FarmPalette): void {
  for (let i = 0; i < HILL_LAYERS; i++) {
    const k = HILLS[i].haze;
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = pal.grass[i][c] + (pal.haze[c] - pal.grass[i][c]) * k;
    }
  }
}

/** Seconds for a change of time of day to crossfade. */
export const PALETTE_FADE = 1.5;

/**
 * Offsets into a packed palette (see `packPalette`): colours are RGB triples,
 * `HILLS` holds each hill layer's hazed colour, and `SCALARS` the sun's place,
 * glow radius and strength, light direction and cloud shadow, in that order.
 */
export const PACKED = {
  skyTop: 0,
  skyHorizon: 3,
  glow: 6,
  cloudLight: 9,
  cloudShade: 12,
  haze: 15,
  turbineLit: 18,
  turbineShade: 21,
  hills: 24,
  scalars: 24 + HILL_LAYERS * 3,
} as const;
export const PALETTE_FLOATS = PACKED.scalars + 6;

/**
 * Writes everything a palette sets into `out` as flat floats, so a change of
 * time of day can ease as one block (`createColorEase`).
 */
export function packPalette(out: Float32Array, pal: FarmPalette): void {
  out.set(pal.skyTop, PACKED.skyTop);
  out.set(pal.skyHorizon, PACKED.skyHorizon);
  out.set(pal.glow, PACKED.glow);
  out.set(pal.cloudLight, PACKED.cloudLight);
  out.set(pal.cloudShade, PACKED.cloudShade);
  out.set(pal.haze, PACKED.haze);
  out.set(pal.turbineLit, PACKED.turbineLit);
  out.set(pal.turbineShade, PACKED.turbineShade);
  fillHillColors(out.subarray(PACKED.hills, PACKED.scalars), pal);
  const k = PACKED.scalars;
  out[k] = pal.sunX;
  out[k + 1] = pal.sunY;
  out[k + 2] = pal.glowRadius;
  out[k + 3] = pal.glowStrength;
  out[k + 4] = pal.lightX;
  out[k + 5] = pal.shadow;
}

// ---------------------------------------------------------------------------
// Turbine geometry (units of tower height, origin at the tower's foot, y up)
// ---------------------------------------------------------------------------

/** Hub height. */
export const HUB_Y = 1;
/** Hub offset across, toward the side the rotor faces. */
export const HUB_X = -0.02;
/** Blade length, from the hub. */
export const BLADE = 0.62;
/**
 * The rotors face a little to the left of the viewer, all the same way: the rotor
 * plane is turned about the vertical, so its x is foreshortened by this cosine.
 */
export const YAW_COS = 0.9;
/** Tower half-width at the foot and at the top. */
export const TOWER_FOOT = 0.032;
export const TOWER_TOP = 0.017;
/** How far the tower's foot sinks below the ridge, so it meets the slope on both sides. */
export const SINK = 0.03;
/** Half-width of a turbine's silhouette about its tower: the rotor disc, foreshortened. */
export const HALF_WIDTH = BLADE * YAW_COS + Math.abs(HUB_X) + 0.01;
/** Clear gap kept between turbine silhouettes (height units). */
export const GAP = 0.012;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Side = (typeof SIDE_OPTIONS)[number]["value"];

/** The speaker covers the middle third of the frame: turbines keep out of it. */
export const BAND = 1 / 3;

export interface Farm {
  /** Turbines placed, sorted farthest first (the draw order). */
  count: number;
  /** Tower x and foot height (height units). */
  readonly x: Float64Array;
  readonly base: Float64Array;
  /** Tower height (height units). */
  readonly size: Float64Array;
  /** Hill layer the turbine stands on (0 = nearest). */
  readonly layer: Int32Array;
  /** Rotor speed relative to the farm's, and the current rotor angle (radians, in [0, 2π)). */
  readonly speed: Float64Array;
  readonly angle: Float64Array;
  /**
   * Which turbine of the layout each is (its place in the layer sequence,
   * 0..count-1 before sorting), so a relayout can tell which turbines stay.
   */
  readonly id: Int32Array;
  /** How far each has faded in, 0..1: one a relayout adds starts at 0. */
  readonly shown: Float64Array;
}

export function createFarm(): Farm {
  return {
    count: 0,
    x: new Float64Array(MAX_TURBINES),
    base: new Float64Array(MAX_TURBINES),
    size: new Float64Array(MAX_TURBINES),
    layer: new Int32Array(MAX_TURBINES),
    speed: new Float64Array(MAX_TURBINES),
    angle: new Float64Array(MAX_TURBINES),
    id: new Int32Array(MAX_TURBINES),
    shown: new Float64Array(MAX_TURBINES),
  };
}

/** Clamps a `turbines` param to a whole number. */
export const turbineCount = (n: number) =>
  clamp(Math.round(Number.isFinite(n) ? n : MIN_TURBINES), MIN_TURBINES, MAX_TURBINES);

/** Hub height above the ground line, in height units, of a turbine `size` tall on `base`. */
const hubY = (base: number, size: number) => base + HUB_Y * size;

/** Distance from point (px, py) to the vertical segment x = sx, y in [y0, y1]. */
function segmentDistance(px: number, py: number, sx: number, y0: number, y1: number): number {
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  return Math.hypot(px - sx, dy);
}

/**
 * Whether two turbines' silhouettes (tower, and rotor disc of radius BLADE) come
 * within `GAP` of each other: disc against disc, disc against tower, or tower
 * against tower.
 */
export function silhouettesOverlap(
  ax: number,
  aBase: number,
  aSize: number,
  bx: number,
  bBase: number,
  bSize: number,
): boolean {
  const ar = BLADE * aSize;
  const br = BLADE * bSize;
  const ay = hubY(aBase, aSize);
  const by = hubY(bBase, bSize);
  if (Math.hypot(ax - bx, ay - by) < ar + br + GAP) {
    return true;
  }
  if (segmentDistance(ax, ay, bx, bBase, by) < ar + GAP) {
    return true;
  }
  if (segmentDistance(bx, by, ax, aBase, ay) < br + GAP) {
    return true;
  }
  return Math.abs(ax - bx) < GAP && aBase < by && bBase < ay;
}

/** Radius kept clear around a farther turbine's hub and nacelle, in units of its tower height. */
export const HUB_CLEAR = 0.1;

/**
 * Whether two turbines collide in the layout. On the same layer, their whole
 * silhouettes must stay apart (`silhouettesOverlap`). Across layers, a nearer
 * turbine may sweep in front of a farther one's blades (as on any real wind farm,
 * and the only way a dozen fit beside the speaker), but never hides its hub and
 * nacelle: those stay `GAP` clear of the nearer turbine's tower, hub and nacelle.
 */
export function turbinesClash(
  ax: number,
  aBase: number,
  aSize: number,
  aLayer: number,
  bx: number,
  bBase: number,
  bSize: number,
  bLayer: number,
): boolean {
  if (aLayer === bLayer) {
    return silhouettesOverlap(ax, aBase, aSize, bx, bBase, bSize);
  }
  const near = aLayer < bLayer;
  const nx = near ? ax : bx;
  const nBase = near ? aBase : bBase;
  const nSize = near ? aSize : bSize;
  const fx = near ? bx : ax;
  const fSize = near ? bSize : aSize;
  const fy = hubY(near ? bBase : aBase, fSize);
  const clear = HUB_CLEAR * fSize + GAP;
  const ny = hubY(nBase, nSize);
  if (Math.hypot(fx - nx, fy - ny) < HUB_CLEAR * nSize + clear) {
    return true;
  }
  return segmentDistance(fx, fy, nx, nBase, ny) < clear;
}

/**
 * The range of tower x positions open to a turbine of half-width `hw` on a
 * canvas `aspect` wide, written to `zone` as [lo, hi] pairs (empty when lo > hi).
 * Turbines may hang a little off the outer edges but never into the central band.
 */
function zones(zone: Float64Array, side: Side, aspect: number, hw: number): number {
  const bandLo = aspect * BAND;
  const bandHi = aspect * (1 - BAND);
  let n = 0;
  if (side !== "right") {
    zone[n++] = 0.4 * hw;
    zone[n++] = bandLo - hw;
  }
  if (side !== "left") {
    zone[n++] = bandHi + hw;
    zone[n++] = aspect - 0.4 * hw;
  }
  return n / 2;
}

/** Share of the turbines on each layer (nearest first), before the near cap. */
const LAYER_SHARE = [0.12, 0.2, 0.3, 0.38];
/** Placement attempts per turbine before it moves back a layer. */
const ATTEMPTS = 60;
/** Half-width of the window searched for the local crest, height units. */
const CREST_WINDOW = 0.08;
/** Nearer hills may rise this far up a tower (share of its height) at most. */
const MAX_HIDDEN = 0.3;
/** Share of a zone, from its outer edge, open to turbines on the nearest layer. */
const NEAR_OUTER = 0.4;
/** Base rotor speed at `wind` 1, revolutions per second. */
export const ROTOR_REVS = 0.16;

/** Seconds a turbine a relayout adds takes to fade in. */
export const TURBINE_FADE = 1.5;

/**
 * The hill layer (0 = nearest) of each of the first `n` turbines, written to
 * `out`: the first stands nearest, then each goes to the layer furthest below
 * its share (`LAYER_SHARE`) of the turbines so far, the nearest holding at most
 * `nearCap`. A fixed sequence, so a higher count only adds turbines at the end.
 */
export function layerSequence(n: number, nearCap: number, out: Int32Array): void {
  const counts = new Int32Array(HILL_LAYERS);
  for (let t = 0; t < n; t++) {
    let best = 0;
    if (t > 0) {
      let most = -Infinity;
      for (let i = 0; i < HILL_LAYERS; i++) {
        const behind = (t + 1) * LAYER_SHARE[i] - counts[i];
        if ((i > 0 || counts[0] < nearCap) && behind > most) {
          most = behind;
          best = i;
        }
      }
    }
    out[t] = best;
    counts[best]++;
  }
}

/**
 * Places up to `count` turbines on the hill crests of `table` for a canvas
 * `aspect` wide, deterministically for `seed`: each on a local crest within
 * the `side` zones of its layer (`layerSequence`), clear of the central band
 * and of every turbine placed before it, with nearer hills hiding no more than
 * the foot of its tower. A turbine that finds no room moves back a layer; one
 * that finds none on the farthest is dropped. Sorts the result farthest first
 * and returns how many were placed.
 *
 * The layout is prefix-stable: each turbine draws from its own random stream
 * and is placed in sequence order, so raising the count keeps every turbine
 * already placed. A turbine that was in the farm's previous layout keeps its
 * rotor angle and fade; a new one fades in from 0 (unless the farm was empty).
 */
export function layoutFarm(
  farm: Farm,
  table: Float32Array,
  aspect: number,
  count: number,
  side: Side,
  seed: number,
): number {
  const n = turbineCount(count);
  const base = hash32((Number.isFinite(seed) ? Math.floor(seed) : 0) * 2654435761 + 97);
  const zone = new Float64Array(4);
  const layers = new Int32Array(n);
  layerSequence(n, side === "spread" ? 2 : 1, layers);
  // The previous layout's rotor angles and fades, by id.
  const fresh = farm.count === 0;
  const angle = new Float64Array(MAX_TURBINES).fill(Number.NaN);
  const shown = new Float64Array(MAX_TURBINES);
  for (let i = 0; i < farm.count; i++) {
    angle[farm.id[i]] = farm.angle[i];
    shown[farm.id[i]] = farm.shown[i];
  }
  let placed = 0;
  for (let t = 0; t < n; t++) {
    const rand = createRng(hash32(base ^ hash32(t + 1)));
    for (let layer = layers[t]; layer < HILL_LAYERS; layer++) {
      if (placeOne(farm, placed, table, aspect, side, layer, rand, zone)) {
        farm.id[placed] = t;
        if (!Number.isNaN(angle[t])) {
          farm.angle[placed] = angle[t];
          farm.shown[placed] = shown[t];
        } else {
          farm.shown[placed] = fresh ? 1 : 0;
        }
        placed++;
        break;
      }
    }
  }
  farm.count = placed;
  sortFarthestFirst(farm);
  return placed;
}

function placeOne(
  farm: Farm,
  k: number,
  table: Float32Array,
  aspect: number,
  side: Side,
  layer: number,
  rand: () => number,
  zone: Float64Array,
): boolean {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const size = HILLS[layer].turbine * (0.9 + 0.2 * rand());
    const hw = HALF_WIDTH * size;
    const nz = zones(zone, side, aspect, hw);
    const z = Math.floor(rand() * nz);
    let lo = zone[z * 2];
    let hi = zone[z * 2 + 1];
    if (!(hi > lo)) {
      continue;
    }
    if (layer === 0) {
      // The big near turbines frame the scene from the outer edges.
      if (hi < aspect / 2) {
        hi = lo + NEAR_OUTER * (hi - lo);
      } else {
        lo = hi - NEAR_OUTER * (hi - lo);
      }
    }
    // Climb to the highest point nearby: turbines stand on the crests.
    let x = lo + (hi - lo) * rand();
    let best = hillHeightAt(table, layer, x);
    const x0 = x;
    for (let s = -4; s <= 4; s++) {
      const xs = clamp(x0 + (s / 4) * CREST_WINDOW, lo, hi);
      const h = hillHeightAt(table, layer, xs);
      if (h > best) {
        best = h;
        x = xs;
      }
    }
    const base = best - SINK * size;
    let ok = true;
    for (let j = 0; j < layer && ok; j++) {
      if (hillHeightAt(table, j, x) > base + MAX_HIDDEN * size) {
        ok = false;
      }
    }
    for (let o = 0; o < k && ok; o++) {
      const o2 = farm.layer[o];
      if (turbinesClash(x, base, size, layer, farm.x[o], farm.base[o], farm.size[o], o2)) {
        ok = false;
      }
    }
    if (!ok) {
      continue;
    }
    farm.x[k] = x;
    farm.base[k] = base;
    farm.size[k] = size;
    farm.layer[k] = layer;
    farm.speed[k] = 0.85 + 0.3 * rand();
    farm.angle[k] = rand() * Math.PI * 2;
    return true;
  }
  return false;
}

/** Insertion sort by layer, farthest first, then smallest first; stable and allocation-free. */
function sortFarthestFirst(f: Farm): void {
  const later = (a: number, b: number) =>
    f.layer[a] < f.layer[b] || (f.layer[a] === f.layer[b] && f.size[a] > f.size[b]);
  for (let i = 1; i < f.count; i++) {
    for (let j = i; j > 0 && later(j - 1, j); j--) {
      swap(f.x, j, j - 1);
      swap(f.base, j, j - 1);
      swap(f.size, j, j - 1);
      swap(f.layer, j, j - 1);
      swap(f.speed, j, j - 1);
      swap(f.angle, j, j - 1);
      swap(f.id, j, j - 1);
      swap(f.shown, j, j - 1);
    }
  }
}

function swap(a: Float64Array | Int32Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

// ---------------------------------------------------------------------------
// Rotors
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/**
 * Turns every rotor by `dt` seconds at `wind` (clockwise, as seen from the front),
 * keeping each angle wrapped to [0, 2π) so float32 uploads stay precise.
 */
export function advanceRotors(farm: Farm, dt: number, wind: number): void {
  const w = Number.isFinite(wind) ? Math.max(0, wind) : 0;
  const step = -dt * w * ROTOR_REVS * TAU;
  const fade = Math.max(0, dt) / TURBINE_FADE;
  for (let i = 0; i < farm.count; i++) {
    farm.angle[i] = wrap(farm.angle[i] + step * farm.speed[i], 0, TAU);
    farm.shown[i] = Math.min(1, farm.shown[i] + fade);
  }
}

/** Floats per turbine instance: [x, foot y, tower height (px), rotor angle], [haze, layer, opacity, 0]. */
export const TURBINE_FLOATS = 8;

/** Writes the farm's turbines as instances for a canvas `height` px tall; returns how many. */
export function writeTurbines(farm: Farm, out: Float32Array, height: number): number {
  for (let i = 0; i < farm.count; i++) {
    const o = i * TURBINE_FLOATS;
    out[o] = farm.x[i] * height;
    out[o + 1] = farm.base[i] * height;
    out[o + 2] = farm.size[i] * height;
    out[o + 3] = farm.angle[i];
    out[o + 4] = HILLS[farm.layer[i]].haze;
    out[o + 5] = farm.layer[i];
    const s = farm.shown[i];
    out[o + 6] = s * s * (3 - 2 * s);
    out[o + 7] = 0;
  }
  return farm.count;
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/** Cloud density threshold (unit-variance noise) for a cover of 0..1. */
export const cloudThreshold = (cover: number) => 1.8 - 2.6 * clamp(cover, 0, 1);
