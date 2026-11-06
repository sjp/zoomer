/**
 * Pure JS logic for the train window (train.ts): the camera and layer depths,
 * the train's speed and position, the periodic column tables for the hills, the
 * fields and hedgerows and the embankment, the farmhouses, the telegraph poles
 * and their sagging wires, the carriage sway and the time-of-day palette keys.
 * Nothing here touches GL, so it is all unit tested.
 *
 * Every layer scrolls by the train's position times `FOCAL / depth`, so the
 * screen speed of a layer is proportional to 1 / depth. Positions stay in
 * float64 on the CPU; only offsets wrapped to each layer's period are uploaded.
 */
import type { Rgb } from "./color";
import { approach, clamp, fract, smoothstep, wrap } from "./math";
import { createRng } from "./noise";
import { TIME_OPTIONS } from "./train.meta";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Camera and layer depths
// ---------------------------------------------------------------------------

/** The reference frame height: sizes are reference px, y up from the bottom. */
export const REF_HEIGHT = 1080;
/** Screen size of one world unit at depth 1, in reference px. */
export const FOCAL = 1000;
/** Height of the eye above the fields, in world units. */
export const CAM_H = 3;
/** Ground-plane horizon (eye level), reference px from the bottom. */
export const HORIZON_Y = 420;

/** Depths of the layers, in world units. */
export const CLOUD_Z = 6000;
export const FAR_HILL_Z = 1000;
export const NEAR_HILL_Z = 400;
/** The far hedgerow and tree line, at the far edge of the fields. */
export const FAR_LINE_Z = 200;
export const HOUSE_Z = 110;
/** A nearer hedgerow across the fields. */
export const MID_LINE_Z = 50;
export const BANK_Z = 8;
export const POLE_Z = 6;

/** All layer depths, back to front. */
export const LAYER_DEPTHS = [
  CLOUD_Z,
  FAR_HILL_Z,
  NEAR_HILL_Z,
  FAR_LINE_Z,
  HOUSE_Z,
  MID_LINE_Z,
  BANK_Z,
  POLE_Z,
] as const;

/** Screen height (reference px) of the ground at depth `z`. */
export const groundY = (z: number) => HORIZON_Y - (FOCAL * CAM_H) / z;
/** Depth of the ground seen at screen height `y` (below the horizon). */
export const groundDepth = (y: number) => (FOCAL * CAM_H) / (HORIZON_Y - y);

export const FAR_Y = groundY(FAR_LINE_Z);
export const MID_Y = groundY(MID_LINE_Z);
export const HOUSE_Y = groundY(HOUSE_Z);

/** Screen speed (reference px per second) of a layer at depth `z` for train speed `v`. */
export const screenSpeed = (v: number, z: number) => (v * FOCAL) / z;

/**
 * Scroll of a layer at depth `z` for train position `pos`, wrapped to its
 * period (reference px) and returned in periods, [0, 1): the texture offset.
 */
export const scrollOffset = (pos: number, z: number, period: number) =>
  fract((pos * FOCAL) / z / period);

/** Distance at which the air hazes half way to the horizon colour, world units. */
export const HAZE_HALF = 480;
/** Fraction of the way to the horizon colour at depth `z`. */
export const hazeAt = (z: number) => 1 - 2 ** (-z / HAZE_HALF);

/**
 * A daylight colour lit by `light` and hazed towards `horizon` at depth `z`,
 * written into `out`. Allocates nothing.
 */
export function shadeLayer(out: Rgb, base: Rgb, light: Rgb, horizon: Rgb, z: number): Rgb {
  const h = hazeAt(z);
  for (let c = 0; c < 3; c++) {
    const lit = base[c] * light[c];
    out[c] = lit + (horizon[c] - lit) * h;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The train
// ---------------------------------------------------------------------------

/** Train speed (world units per second) at speed 1: the poles then pass at 480 px/s. */
export const V_MAX = 2.88;
/** Acceleration, world units per second squared. */
export const ACCEL = 0.6;

export interface Train {
  /** Position along the track, world units, unwrapped float64. */
  pos: number;
  /** Velocity, world units per second; NaN until the first step. */
  v: number;
}

export const createTrain = (): Train => ({ pos: 0, v: Number.NaN });

/**
 * Advances the train by `dt` seconds towards `speed` (0..1 of `V_MAX`) in
 * direction `dir` (+1 moves the scenery left, -1 right). The velocity eases at
 * `ACCEL`, so a change of speed or direction never jerks; the first step starts
 * at full speed. Returns the new position.
 */
export function stepTrain(train: Train, dt: number, speed: number, dir: number): number {
  const target = Math.sign(dir) * clamp(speed, 0, 1) * V_MAX;
  train.v = Number.isNaN(train.v) ? target : approach(train.v, target, ACCEL * dt);
  train.pos += train.v * dt;
  return train.pos;
}

// ---------------------------------------------------------------------------
// Periodic column tables
// ---------------------------------------------------------------------------

/** Hills: two ridges (R far, G near), heights in reference px above the horizon. */
export const HILL_COLUMNS = 1024;
export const HILL_CHANNELS = 2;
/** Period of the hill table, reference px. */
export const HILL_PERIOD = 4096;

/**
 * Fields: R hedgerow and tree height (world units), G field tone (0..1), B
 * darkness of the hedges between fields, A foliage tone (0..1). The far and mid
 * hedgerow lines read R and A at their depth; the ground reads G and B.
 */
export const FIELD_COLUMNS = 2048;
export const FIELD_CHANNELS = 4;
/** Period of the field table, world units. */
export const FIELD_PERIOD = 480;
/** Table offsets (in periods) of the mid hedgerow line and the ground, so they differ from the far line. */
export const MID_SHIFT = 0.37;
export const GROUND_SHIFT = 0.71;

/** Embankment: R top (reference px), G grass tone (0..1). */
export const BANK_COLUMNS = 1024;
export const BANK_CHANNELS = 2;
/** Period of the embankment table, reference px. */
export const BANK_PERIOD = 2048;
export const BANK_BASE = 175;

/** Seed for one table, so each table and seed get their own stream. */
const tableSeed = (seed: number, salt: number) => Math.floor(seed) * 7919 + salt;

/** Distance from `x` to `at` on a circle of circumference `period`, signed, in [-period / 2, period / 2]. */
const wrapDist = (x: number, at: number, period: number) => {
  const d = x - at;
  return d - period * Math.round(d / period);
};

/**
 * A periodic sum of `n` sines with whole-number cycles per period (so it tiles),
 * octave weights halving; returns the harmonics and phases for `sumWaves`.
 */
function makeWaves(rand: () => number, n: number, base: number): Float64Array {
  const w = new Float64Array(n * 2);
  for (let o = 0; o < n; o++) {
    w[o * 2] = Math.max(1, Math.round(base * 2 ** o * (0.8 + rand() * 0.4)));
    w[o * 2 + 1] = rand() * TAU;
  }
  return w;
}

/** The waves at `x` (0..1 of the period), shaped towards ridges by `ridge` and normalised to [-1, 1]. */
function sumWaves(waves: Float64Array, x: number, ridge: number): number {
  let v = 0;
  let norm = 0;
  for (let o = 0; o * 2 < waves.length; o++) {
    const s = Math.sin(TAU * waves[o * 2] * x + waves[o * 2 + 1]);
    v += (s + (1 - 2 * Math.abs(s) - s) * ridge) * 0.5 ** o;
    norm += 0.5 ** o;
  }
  return v / norm;
}

/**
 * Fills `out` (`HILL_COLUMNS * HILL_CHANNELS` floats) with the two hill
 * ridges for `seed`, sampled at texel centres so the table tiles seamlessly
 * with REPEAT wrapping.
 */
export function fillHillTable(out: Float32Array, seed: number): void {
  const rand = createRng(tableSeed(seed, 11));
  const far = makeWaves(rand, 4, 2.5);
  const near = makeWaves(rand, 4, 3.5);
  for (let c = 0; c < HILL_COLUMNS; c++) {
    const x = (c + 0.5) / HILL_COLUMNS;
    out[c * 2] = 74 + 44 * sumWaves(far, x, 0.3);
    out[c * 2 + 1] = 40 + 28 * sumWaves(near, x, 0);
  }
}

/** Field tones the segments pick from: pasture, lighter grass, young crops, stubble. */
const FIELD_TONES = [0.05, 0.3, 0.6, 0.95] as const;
const HEDGE_BASE = 0.45;
/** Half-width of the hedges between fields, world units. */
const HEDGE_HALF = 0.8;
const TREE_CLUMPS = 18;

/**
 * Fills `out` (`FIELD_COLUMNS * FIELD_CHANNELS` floats) with the fields for
 * `seed`: segments of different crops with a hedge at each boundary, and a
 * hedgerow with clumps of round-crowned trees. Every feature is placed by
 * wrapped distance, so the table tiles. Returns the tallest height (R).
 */
export function fillFieldTable(out: Float32Array, seed: number): number {
  const rand = createRng(tableSeed(seed, 23));
  const P = FIELD_PERIOD;

  // Field boundaries: widths of 12-38 units, scaled to fill the period exactly.
  const widths: number[] = [];
  let sum = 0;
  while (sum < P) {
    const w = 12 + rand() * 26;
    widths.push(w);
    sum += w;
  }
  const k = P / sum;
  const bounds = new Float64Array(widths.length + 1);
  const tones = new Float64Array(widths.length);
  let prevTone = -1;
  for (let i = 0; i < widths.length; i++) {
    bounds[i + 1] = bounds[i] + widths[i] * k;
    let t = Math.floor(rand() * FIELD_TONES.length);
    if (t === prevTone) {
      t = (t + 1) % FIELD_TONES.length;
    }
    tones[i] = FIELD_TONES[t];
    prevTone = t;
  }
  bounds[widths.length] = P;

  // Trees, in clumps: x, crown radius, height, tone.
  const trees: number[] = [];
  for (let c = 0; c < TREE_CLUMPS; c++) {
    const at = rand() * P;
    const n = 1 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const r = 0.9 + rand() * 1.3;
      trees.push(at + (rand() - 0.5) * 8, r, r * 1.2 + 1 + rand() * 1.8, rand());
    }
  }
  const hedgeWaves = makeWaves(rand, 3, 40);

  let seg = 0;
  let max = 0;
  for (let c = 0; c < FIELD_COLUMNS; c++) {
    const x = ((c + 0.5) / FIELD_COLUMNS) * P;
    while (seg < widths.length - 1 && x >= bounds[seg + 1]) {
      seg++;
    }
    let hedgeD = Infinity;
    for (let b = 0; b < widths.length; b++) {
      hedgeD = Math.min(hedgeD, Math.abs(wrapDist(x, bounds[b], P)));
    }
    let h = HEDGE_BASE + 0.15 * sumWaves(hedgeWaves, x / P, 0);
    let tone = 0.3;
    for (let t = 0; t < trees.length; t += 4) {
      const dx = wrapDist(x, trees[t], P);
      const r = trees[t + 1];
      if (Math.abs(dx) >= r) {
        continue;
      }
      const crown = trees[t + 2] - r + Math.sqrt(r * r - dx * dx);
      if (crown > h) {
        h = crown;
        tone = trees[t + 3];
      }
    }
    const o = c * FIELD_CHANNELS;
    out[o] = h;
    out[o + 1] = tones[seg];
    out[o + 2] = 0.75 * (1 - smoothstep(0.3 * HEDGE_HALF, HEDGE_HALF, hedgeD));
    out[o + 3] = tone;
    max = Math.max(max, h);
  }
  return max;
}

const TUFTS = 150;

/**
 * Fills `out` (`BANK_COLUMNS * BANK_CHANNELS` floats) with the embankment for
 * `seed`: a gently rolling top with grass tufts, and a streaky grass tone.
 * Periodic like the other tables. Returns the highest top.
 */
export function fillBankTable(out: Float32Array, seed: number): number {
  const rand = createRng(tableSeed(seed, 37));
  const roll = makeWaves(rand, 3, 1.5);
  const streaks = makeWaves(rand, 3, 55);
  const tufts = new Float64Array(TUFTS * 3);
  for (let i = 0; i < TUFTS; i++) {
    tufts[i * 3] = rand() * BANK_PERIOD;
    tufts[i * 3 + 1] = 5 + rand() * 8;
    tufts[i * 3 + 2] = 3 + rand() * 7;
  }
  let max = 0;
  for (let c = 0; c < BANK_COLUMNS; c++) {
    const x = ((c + 0.5) / BANK_COLUMNS) * BANK_PERIOD;
    let tuft = 0;
    for (let i = 0; i < TUFTS; i++) {
      const u = wrapDist(x, tufts[i * 3], BANK_PERIOD) / tufts[i * 3 + 1];
      if (Math.abs(u) >= 1) {
        continue;
      }
      const q = 1 - u * u;
      tuft = Math.max(tuft, tufts[i * 3 + 2] * q * q);
    }
    const top = BANK_BASE + 12 * sumWaves(roll, x / BANK_PERIOD, 0) + tuft;
    out[c * 2] = top;
    out[c * 2 + 1] = 0.5 + 0.5 * sumWaves(streaks, x / BANK_PERIOD, 0);
    max = Math.max(max, top);
  }
  return max;
}

/** Linearly interpolated, wrapped read of channel `ch` of a periodic table at `u` periods (like REPEAT filtering). */
export function sampleTable(
  table: Float32Array,
  columns: number,
  channels: number,
  ch: number,
  u: number,
): number {
  const t = fract(u) * columns - 0.5;
  const i = Math.floor(t);
  const f = t - i;
  const a = table[(((i % columns) + columns) % columns) * channels + ch];
  const b = table[((((i + 1) % columns) + columns) % columns) * channels + ch];
  return a + (b - a) * f;
}

// ---------------------------------------------------------------------------
// Farmhouses
// ---------------------------------------------------------------------------

/** Houses per field period; at most this many are ever in view. */
export const MAX_HOUSES = 3;
/** Floats per house: x (world), half width, wall height, roof height (world units), lit (0/1), roof tone. */
export const HOUSE_FLOATS = 6;

/** Places `MAX_HOUSES` farmhouses spread along the field period for `seed`. */
export function placeHouses(out: Float64Array, seed: number): void {
  const rand = createRng(tableSeed(seed, 53));
  for (let i = 0; i < MAX_HOUSES; i++) {
    const o = i * HOUSE_FLOATS;
    out[o] = ((i + 0.15 + 0.7 * rand()) * FIELD_PERIOD) / MAX_HOUSES;
    out[o + 1] = 2.2 + rand() * 1.4;
    out[o + 2] = 2.2 + rand() * 0.9;
    out[o + 3] = 1.4 + rand() * 0.9;
    out[o + 4] = rand() < 0.75 ? 1 : 0;
    out[o + 5] = rand();
  }
}

/** Tallest house (wall and roof), world units. */
export const HOUSE_MAX_H = 3.1 + 2.3;

/**
 * Projects the houses to the screen for train position `pos`: per visible
 * house, writes centre x, half width, wall height and roof height (reference
 * px) into `out` and window light (`lit` times its flag), roof tone into
 * `look`, 4 floats each. Uses the repetition nearest the centre of the view.
 * Returns the count.
 */
export function viewHouses(
  houses: Float64Array,
  pos: number,
  refWidth: number,
  lit: number,
  out: Float32Array,
  look: Float32Array,
): number {
  const k = FOCAL / HOUSE_Z;
  const cx = refWidth / 2;
  let n = 0;
  for (let i = 0; i < MAX_HOUSES; i++) {
    const h = i * HOUSE_FLOATS;
    const x = cx + wrap(houses[h] - pos, -FIELD_PERIOD / 2, FIELD_PERIOD) * k;
    const hw = houses[h + 1] * k;
    if (Math.abs(x - cx) > cx + hw * 1.4 + 2) {
      continue;
    }
    const o = n * 4;
    out[o] = x;
    out[o + 1] = hw;
    out[o + 2] = houses[h + 2] * k;
    out[o + 3] = houses[h + 3] * k;
    look[o] = houses[h + 4] * lit;
    look[o + 1] = houses[h + 5];
    look[o + 2] = 0;
    look[o + 3] = 0;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Telegraph poles and wires
// ---------------------------------------------------------------------------

/** Screen distance between poles, reference px. */
export const POLE_SPACING = 760;
export const POLE_TOP = 930;
export const POLE_HALF_W = 9;
/** Crossarm centre height, half length and half thickness. */
export const ARM_Y = 912;
export const ARM_HALF = 40;
export const ARM_HALF_H = 4;
/** Per wire: attachment x relative to the pole, attachment height, sag at mid-span (reference px). */
export const WIRE_DX = [-30, 30, 0] as const;
export const WIRE_Y = [921, 921, 852] as const;
export const WIRE_SAG = [64, 64, 50] as const;
export const WIRE_HALF_W = 1.1;
export const WIRE_LOW = Math.min(...WIRE_Y.map((y, i) => y - WIRE_SAG[i]));
export const WIRE_HIGH = Math.max(...WIRE_Y);

/** Pole scroll for train position `pos`: reference px, wrapped to [0, POLE_SPACING). */
export const poleOffset = (pos: number) => wrap((pos * FOCAL) / POLE_Z, 0, POLE_SPACING);

/**
 * Writes the screen x of every pole within one spacing of the view into `out`,
 * left to right, and returns the count. Pole k stands at k * spacing - offset.
 */
export function polePositions(offset: number, refWidth: number, out: Float64Array): number {
  let n = 0;
  for (let k = -1; n < out.length; k++) {
    const x = k * POLE_SPACING - offset;
    if (x > refWidth + POLE_SPACING) {
      break;
    }
    out[n++] = x;
  }
  return n;
}

/**
 * Height of wire `w` at screen x for pole offset `offset`: a parabola (a close
 * stand-in for the catenary) between consecutive poles' attachments. Matches
 * the overlay shader.
 */
export function wireHeight(w: number, x: number, offset: number): number {
  const t = fract((x + offset - WIRE_DX[w]) / POLE_SPACING);
  return WIRE_Y[w] - 4 * WIRE_SAG[w] * t * (1 - t);
}

// ---------------------------------------------------------------------------
// Carriage sway
// ---------------------------------------------------------------------------

/** Largest vertical rock of the view, reference px, at sway 1. */
export const SWAY_AMP = 5;

/**
 * Vertical rock of the view at `time` seconds: two slow, incommensurate sines,
 * scaled by `sway` (0..1) and eased out as the train slows (`speed` 0..1), so a
 * standing train is still. Within +-`SWAY_AMP * sway`.
 */
export function swayOffset(time: number, sway: number, speed: number): number {
  const s = clamp(sway, 0, 1) * smoothstep(0, 0.2, Math.abs(speed));
  if (s === 0) {
    return 0;
  }
  return (
    s * SWAY_AMP * (0.65 * Math.sin((TAU * time) / 3.3) + 0.35 * Math.sin((TAU * time) / 5.1 + 1.3))
  );
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

/** Per time of day (in `TIME_OPTIONS` order): the hour for `sampleSky`, and the sun's x and y (fractions of the frame). */
export const TIME_KEYS = [
  { hour: 7.6, sunX: 0.18, sunY: 0.64 },
  { hour: 14.5, sunX: 0.7, sunY: 0.86 },
  { hour: 17.6, sunX: 0.84, sunY: 0.52 },
  { hour: 18.8, sunX: 0.8, sunY: 0.33 },
] as const;

/** Time-of-day keys per second a change travels through. */
export const TIME_RATE = 1.5;

/** Index of a `timeOfDay` value; unknown values fall back to golden hour. */
export function timeIndex(value: string): number {
  const i = TIME_OPTIONS.findIndex((o) => o.value === value);
  return i < 0 ? 2 : i;
}

export interface TimeState {
  /** Position along `TIME_KEYS`, fractional while changing; NaN until the first step. */
  pos: number;
}

export const createTimeState = (): TimeState => ({ pos: Number.NaN });

/** Moves towards key `index`; the first step snaps to it. Returns the position. */
export function stepTime(state: TimeState, dt: number, index: number): number {
  state.pos = Number.isNaN(state.pos) ? index : approach(state.pos, index, TIME_RATE * dt);
  return state.pos;
}

export interface TimeLook {
  hour: number;
  sunX: number;
  sunY: number;
}

/** The hour and sun position at key position `pos`, eased between neighbouring keys. */
export function sampleTime(pos: number, out: TimeLook): TimeLook {
  const n = TIME_KEYS.length;
  const p = clamp(pos, 0, n - 1);
  const i = Math.min(Math.floor(p), n - 2);
  const f = smoothstep(0, 1, p - i);
  const a = TIME_KEYS[i];
  const b = TIME_KEYS[i + 1];
  out.hour = a.hour + (b.hour - a.hour) * f;
  out.sunX = a.sunX + (b.sunX - a.sunX) * f;
  out.sunY = a.sunY + (b.sunY - a.sunY) * f;
  return out;
}

/** How brightly the farmhouse windows and carriage lamps glow, 0 by day to 1 at dusk, from the light on the land. */
export function lampAmount(light: Rgb): number {
  const lum = 0.2126 * light[0] + 0.7152 * light[1] + 0.0722 * light[2];
  return smoothstep(0.55, 0.25, lum);
}
