/**
 * Pure JS side of the Plasma Globe effect (plasma.ts): the globe's layout in its
 * corner, the filaments' wandering end points, their 3D paths from the
 * electrode to the glass, their slow brightness, and the colour palettes.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up, as in globe-sim.ts. The filaments live in "globe
 * units": centred on the sphere's centre and scaled by its radius, x right, y up
 * and z towards the viewer, so the glass is the unit sphere. The view is
 * orthographic: a point's screen position is its x and y.
 *
 * Nothing here is random per frame. End points move by integrating smooth noise
 * and a weak repulsion, paths are smooth noise of the end point and a slowly
 * scrolling phase, and brightness follows slow noise, so the globe never flickers.
 */
import type { Rgb } from "./color";
import { clamp } from "./math";
import { createNoise, createRng, type Noise } from "./noise";
import { MAX_FILAMENTS, SIZE_MAX, SIZE_MIN } from "./plasma.meta";

/** The electrode's radius, where filaments start (globe units). */
export const CORE_R = 0.1;
/** Where filaments end: just inside the glass (globe units). */
export const GLASS_IN = 0.97;
/** Segments per filament path, and per branch. */
export const PATH_SEGMENTS = 24;
export const BRANCH_SEGMENTS = 8;
/** Most branches per filament. */
export const MAX_BRANCHES = 2;

/*
 * Globe-unit geometry of the black base, shared with the shaders: a tapered drum
 * seen a little from above. Its top and bottom are ellipses of ratio BASE_K, and
 * the sphere's foot sits in the top one.
 */
export const BASE_TOP = -0.8;
export const BASE_BOT = -1.45;
export const BASE_TW = 0.55;
export const BASE_BW = 0.8;
export const BASE_K = 0.22;
/** Where the base's bottom sits (height units): on the table, near the frame's bottom. */
export const SEAT_Y = 0.06;
/** The table's back edge, where it meets the wall (height units). */
export const TABLE_Y = 0.2;

/** Distance of the globe's centre from its frame edge: a margin plus this many radii. */
const EDGE_MARGIN = 0.05;
const EDGE_RADII = 1.02;
/** Slack around the box for the antialiased edges (height units). */
const BOX_PAD = 0.004;

export interface PlasmaLayout {
  /** +1 if the globe is in the bottom-right corner, -1 bottom-left. */
  side: 1 | -1;
  /** Sphere radius, centre x and y (height units). */
  r: number;
  cx: number;
  cy: number;
  /** The globe passes' bounds: x0, y0, x1, y1 (height units). */
  box: [number, number, number, number];
}

export const createLayout = (): PlasmaLayout => ({
  side: 1,
  r: 0.2,
  cx: 0,
  cy: 0,
  box: [0, 0, 0, 0],
});

/** Sphere radius (height units) for a `size` param value (the globe's diameter). */
export function globeRadius(size: number): number {
  const s = Number.isFinite(size) ? size : 0.42;
  return clamp(s, SIZE_MIN, SIZE_MAX) / 2;
}

/** Lays the globe out in its corner of an `aspect`-wide frame. */
export function plasmaLayout(
  aspect: number,
  corner: string,
  size: number,
  out: PlasmaLayout,
): PlasmaLayout {
  const side = corner === "left" ? -1 : 1;
  const r = globeRadius(size);
  const edge = EDGE_MARGIN + EDGE_RADII * r;
  const a = Math.max(Number.isFinite(aspect) ? aspect : 1, 2 * edge);
  out.side = side;
  out.r = r;
  out.cx = side > 0 ? a - edge : edge;
  out.cy = SEAT_Y - BASE_BOT * r;
  const half = r * Math.max(1, BASE_BW) + BOX_PAD;
  out.box[0] = out.cx - half;
  out.box[1] = out.cy + r * (BASE_BOT - BASE_BW * BASE_K) - BOX_PAD;
  out.box[2] = out.cx + half;
  out.box[3] = out.cy + r + BOX_PAD;
  return out;
}

/** End-point wander speed (globe units/s) at drift 1, and the noise's rate along the drift phase. */
const WANDER = 0.22;
const WANDER_RATE = 0.3;
/**
 * Repulsion between end points, falling off as the cube of the chord so it
 * only matters near neighbours, and its softening (squared chord).
 */
const REPEL = 0.01;
const REPEL_SOFT = 0.01;
/** End points below this height are pushed back up, out of the base's collar. */
export const FLOOR_Y = -0.4;
const FLOOR_K = 4;
/** How fast a filament fades in or out when the count changes (1/s). */
export const FADE_RATE = 0.6;
/** Brightness: base level, slow noise depth, and the noise's rate (1/s, real time). */
export const BRIGHT_BASE = 0.85;
export const BRIGHT_DEPTH = 0.15;
const BRIGHT_RATE = 0.1;
/** Path shape: sideways bend, its noise frequency along the path, scroll and evolve rates. */
const BEND = 0.32;
const BEND_FREQ = 1.6;
const SCROLL = 0.2;
const EVOLVE = 0.08;
/** Second, finer bend octave: share of the bend, and frequency multiplier. */
const FINE = 0.3;
const FINE_FREQ = 2.7;
/** Branches: start range along the path, end spread from the main end, bend. */
const BRANCH_START = [0.55, 0.78] as const;
const BRANCH_SPREAD = 0.55;
const BRANCH_BEND = 0.12;
/** Largest integration step (s), and the longest frame the step accepts (s). */
const MAX_STEP = 1 / 60;
const MAX_DT = 0.25;

export interface Plasma {
  readonly noise: Noise;
  /** End-point unit vectors, x, y, z per filament (all `MAX_FILAMENTS` simulated). */
  readonly ends: Float64Array;
  /** Visibility 0..1 per filament, easing towards whether it is in the count. */
  readonly fade: Float64Array;
  /** Branch count and branch start positions (fraction along the path) per filament. */
  readonly branches: Uint8Array;
  readonly branchStart: Float64Array;
  /** Drift-scaled time (s): drives the wander and the paths' scroll. Unwrapped. */
  phase: number;
  /** Real time (s): drives brightness and the rainbow hue. Unwrapped. */
  time: number;
  /** Scratch force per filament. */
  readonly force: Float64Array;
}

/** Seeded filaments with end points spread over the upper part of the sphere, all hidden. */
export function createPlasma(seed: number): Plasma {
  const rng = createRng(seed);
  const n = MAX_FILAMENTS;
  const ends = new Float64Array(3 * n);
  const branches = new Uint8Array(n);
  const branchStart = new Float64Array(n * MAX_BRANCHES);
  for (let i = 0; i < n; i++) {
    // Uniform on the sphere above FLOOR_Y.
    const y = FLOOR_Y + (1 - FLOOR_Y) * rng();
    const a = rng() * 2 * Math.PI;
    const h = Math.sqrt(1 - y * y);
    ends[3 * i] = h * Math.cos(a);
    ends[3 * i + 1] = y;
    ends[3 * i + 2] = h * Math.sin(a);
    branches[i] = 1 + (rng() < 0.5 ? 1 : 0);
    for (let b = 0; b < MAX_BRANCHES; b++) {
      branchStart[i * MAX_BRANCHES + b] =
        BRANCH_START[0] + (BRANCH_START[1] - BRANCH_START[0]) * rng();
    }
  }
  return {
    noise: createNoise(seed),
    ends,
    fade: new Float64Array(n),
    branches,
    branchStart,
    phase: 0,
    time: 0,
    force: new Float64Array(3 * n),
  };
}

/** The number of filaments shown for a `filaments` param value. */
export function filamentCount(value: number): number {
  return Number.isFinite(value) ? clamp(Math.round(value), 1, MAX_FILAMENTS) : 9;
}

/**
 * Shows the first `count` filaments at once, without a fade, and lets the end
 * points spread out under the repulsion alone for `seconds`. For the first frame.
 */
export function settlePlasma(p: Plasma, count: number, seconds = 3): void {
  const n = filamentCount(count);
  for (let i = 0; i < MAX_FILAMENTS; i++) p.fade[i] = i < n ? 1 : 0;
  for (let t = 0; t < seconds; t += MAX_STEP) moveEnds(p, MAX_STEP, 0);
}

/** Advances the filaments by `dt` seconds with `count` shown, wandering at `drift`. */
export function stepPlasma(p: Plasma, dt: number, count: number, drift: number): void {
  const d = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0;
  if (d <= 0) return;
  const n = filamentCount(count);
  const w = Number.isFinite(drift) ? Math.max(drift, 0) : 0;
  p.time += d;
  for (let i = 0; i < MAX_FILAMENTS; i++) {
    const target = i < n ? 1 : 0;
    const f = p.fade[i];
    p.fade[i] =
      f < target ? Math.min(target, f + FADE_RATE * d) : Math.max(target, f - FADE_RATE * d);
  }
  const steps = Math.ceil(d / MAX_STEP);
  const h = d / steps;
  for (let s = 0; s < steps; s++) {
    p.phase += h * w;
    moveEnds(p, h, w);
  }
}

/**
 * One explicit step of the end points: noise wander (scaled by `drift`), the
 * repulsion from shown filaments (weighted by their fade) and the floor push,
 * all kept tangent to the sphere, then renormalised onto it.
 */
function moveEnds(p: Plasma, h: number, drift: number): void {
  const { ends, fade, force, noise } = p;
  const n = MAX_FILAMENTS;
  const z = p.phase * WANDER_RATE;
  for (let i = 0; i < n; i++) {
    const ex = ends[3 * i];
    const ey = ends[3 * i + 1];
    const ez = ends[3 * i + 2];
    const k = WANDER * drift;
    let fx = k * noise.noise3(i * 7.13, 0.5, z);
    let fy = k * noise.noise3(i * 7.13 + 2.9, 3.7, z);
    let fz = k * noise.noise3(i * 7.13 + 5.3, 6.1, z);
    for (let j = 0; j < n; j++) {
      if (j === i || fade[j] <= 0) continue;
      const dx = ex - ends[3 * j];
      const dy = ey - ends[3 * j + 1];
      const dz = ez - ends[3 * j + 2];
      const q = dx * dx + dy * dy + dz * dz + REPEL_SOFT;
      const s = (REPEL * fade[j]) / (q * q);
      fx += dx * s;
      fy += dy * s;
      fz += dz * s;
    }
    if (ey < FLOOR_Y) fy += FLOOR_K * (FLOOR_Y - ey);
    // Tangent part only: the end point slides over the glass.
    const radial = fx * ex + fy * ey + fz * ez;
    force[3 * i] = fx - radial * ex;
    force[3 * i + 1] = fy - radial * ey;
    force[3 * i + 2] = fz - radial * ez;
  }
  for (let i = 0; i < 3 * n; i += 3) {
    const x = ends[i] + force[i] * h;
    const y = ends[i + 1] + force[i + 1] * h;
    const zz = ends[i + 2] + force[i + 2] * h;
    const len = Math.hypot(x, y, zz) || 1;
    ends[i] = x / len;
    ends[i + 1] = y / len;
    ends[i + 2] = zz / len;
  }
}

/** Slow brightness of filament `i`, fade included: 0..1, never changing faster than slow noise. */
export function filamentBrightness(p: Plasma, i: number): number {
  const wobble = p.noise.noise3(i * 5.17, 91.3, p.time * BRIGHT_RATE);
  return p.fade[i] * (BRIGHT_BASE + BRIGHT_DEPTH * wobble);
}

/** Sum of the shown filaments' brightness: what the tests bound the change of. */
export function totalBrightness(p: Plasma): number {
  let sum = 0;
  for (let i = 0; i < MAX_FILAMENTS; i++) sum += filamentBrightness(p, i);
  return sum;
}

/**
 * Writes the sideways part (perpendicular to `e`) of a smooth noise vector into
 * `out[o..o+2]`, sampled at `x` along a path. `key` separates filaments and branches.
 */
function bendAt(
  noise: Noise,
  key: number,
  x: number,
  z: number,
  ex: number,
  ey: number,
  ez: number,
  out: Float64Array,
  o: number,
): void {
  const fx = x * FINE_FREQ;
  const dx = noise.noise3(x, key, z) + FINE * noise.noise3(fx, key + 40.1, z);
  const dy = noise.noise3(x + 13.7, key + 3.3, z) + FINE * noise.noise3(fx + 13.7, key + 43.4, z);
  const dz = noise.noise3(x + 27.1, key + 6.6, z) + FINE * noise.noise3(fx + 27.1, key + 46.7, z);
  const radial = dx * ex + dy * ey + dz * ez;
  out[o] = dx - radial * ex;
  out[o + 1] = dy - radial * ey;
  out[o + 2] = dz - radial * ez;
}

/** Pulls a point at `out[o..o+2]` back inside radius GLASS_IN if it strayed out. */
function keepInside(out: Float64Array, o: number): void {
  const len = Math.hypot(out[o], out[o + 1], out[o + 2]);
  if (len > GLASS_IN) {
    const k = GLASS_IN / len;
    out[o] *= k;
    out[o + 1] *= k;
    out[o + 2] *= k;
  }
}

/**
 * Filament `i`'s path, PATH_SEGMENTS + 1 points (x, y, z, globe units) into
 * `out`: the straight line from the electrode to the end point on the glass,
 * bent sideways by low-frequency noise that is zero at both ends, largest in
 * the middle, and scrolls outwards with the drift phase.
 */
export function filamentPath(p: Plasma, i: number, out: Float64Array): Float64Array {
  const ex = p.ends[3 * i];
  const ey = p.ends[3 * i + 1];
  const ez = p.ends[3 * i + 2];
  const z = p.phase * EVOLVE;
  const scroll = p.phase * SCROLL;
  const key = i * 19.31;
  for (let k = 0; k <= PATH_SEGMENTS; k++) {
    const s = k / PATH_SEGMENTS;
    const o = 3 * k;
    const along = CORE_R + s * (GLASS_IN - CORE_R);
    bendAt(p.noise, key, s * BEND_FREQ - scroll, z, ex, ey, ez, out, o);
    const a = BEND * Math.sin(Math.PI * s);
    out[o] = ex * along + a * out[o];
    out[o + 1] = ey * along + a * out[o + 1];
    out[o + 2] = ez * along + a * out[o + 2];
    keepInside(out, o);
  }
  return out;
}

/**
 * Branch `b`'s end direction for filament `i` into `out[0..2]`: the main end
 * pushed sideways by slow noise, renormalised onto the sphere.
 */
export function branchEnd(p: Plasma, i: number, b: number, out: Float64Array): Float64Array {
  const ex = p.ends[3 * i];
  const ey = p.ends[3 * i + 1];
  const ez = p.ends[3 * i + 2];
  bendAt(p.noise, 200 + i * 7.7 + b * 3.1, 0, p.phase * WANDER_RATE, ex, ey, ez, out, 0);
  const x = ex + BRANCH_SPREAD * out[0];
  const y = ey + BRANCH_SPREAD * out[1];
  const z = ez + BRANCH_SPREAD * out[2];
  const len = Math.hypot(x, y, z) || 1;
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  return out;
}

/**
 * Branch `b` of filament `i`: BRANCH_SEGMENTS + 1 points into `out`, from the
 * point on the main `path` (as written by `filamentPath`) where the branch
 * starts out to its own end on the glass, gently bent. `end` is scratch for
 * the branch's end direction.
 */
export function branchPath(
  p: Plasma,
  i: number,
  b: number,
  path: Float64Array,
  end: Float64Array,
  out: Float64Array,
): Float64Array {
  const start = p.branchStart[i * MAX_BRANCHES + b] * PATH_SEGMENTS;
  const k0 = Math.min(Math.floor(start), PATH_SEGMENTS - 1);
  const f = start - k0;
  const sx = path[3 * k0] + f * (path[3 * k0 + 3] - path[3 * k0]);
  const sy = path[3 * k0 + 1] + f * (path[3 * k0 + 4] - path[3 * k0 + 1]);
  const sz = path[3 * k0 + 2] + f * (path[3 * k0 + 5] - path[3 * k0 + 2]);
  branchEnd(p, i, b, end);
  const tx = end[0] * GLASS_IN;
  const ty = end[1] * GLASS_IN;
  const tz = end[2] * GLASS_IN;
  const key = 400 + i * 11.9 + b * 5.3;
  const z = p.phase * EVOLVE;
  const scroll = p.phase * SCROLL;
  for (let k = 0; k <= BRANCH_SEGMENTS; k++) {
    const u = k / BRANCH_SEGMENTS;
    const o = 3 * k;
    bendAt(p.noise, key, u * BEND_FREQ - scroll, z, end[0], end[1], end[2], out, o);
    const a = BRANCH_BEND * Math.sin(Math.PI * u);
    out[o] = sx + u * (tx - sx) + a * out[o];
    out[o + 1] = sy + u * (ty - sy) + a * out[o + 1];
    out[o + 2] = sz + u * (tz - sz) + a * out[o + 2];
    keepInside(out, o);
  }
  return out;
}

/** A filament palette: the colour near the electrode, at the tips, and of the wide glow. */
export interface PlasmaPalette {
  root: Rgb;
  tip: Rgb;
  glow: Rgb;
}

/** Fixed palettes (unit sRGB). Rainbow's are per filament, from `rainbowPalette`. */
export const PALETTES: Readonly<Record<string, PlasmaPalette>> = {
  violet: { root: [0.78, 0.62, 1], tip: [1, 0.55, 0.85], glow: [0.55, 0.25, 1] },
  blue: { root: [0.6, 0.75, 1], tip: [0.7, 0.95, 1], glow: [0.2, 0.4, 1] },
  green: { root: [0.6, 1, 0.7], tip: [0.85, 1, 0.6], glow: [0.15, 0.85, 0.35] },
};

/** The glow the globe casts on the room, per colour; rainbow casts a soft lavender. */
export function roomGlow(colour: string): Rgb {
  return colour === "rainbow" ? [0.6, 0.45, 0.85] : (PALETTES[colour] ?? PALETTES.violet).glow;
}

/** One channel of an HSV colour: `n` is 5 for red, 3 for green, 1 for blue. */
function hsvChannel(n: number, h: number, s: number, v: number): number {
  const k = (n + h * 6) % 6;
  return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
}

/** Writes an HSV colour (h in turns, 0 or more; s and v 0..1) as unit RGB into `out`. */
export function hsvToRgb(h: number, s: number, v: number, out: Rgb): Rgb {
  out[0] = hsvChannel(5, h, s, v);
  out[1] = hsvChannel(3, h, s, v);
  out[2] = hsvChannel(1, h, s, v);
  return out;
}

/** Rainbow hue drift (turns/s): a full cycle every few minutes. */
const HUE_RATE = 0.004;

/** Filament `i`'s rainbow palette into `out`, its hue spread by index and drifting slowly. */
export function rainbowPalette(p: Plasma, i: number, out: PlasmaPalette): PlasmaPalette {
  const h = (((i * 0.381966 + p.time * HUE_RATE) % 1) + 1) % 1;
  hsvToRgb(h, 0.4, 1, out.root);
  hsvToRgb(h + 0.05, 0.5, 1, out.tip);
  hsvToRgb(h, 0.85, 1, out.glow);
  return out;
}
