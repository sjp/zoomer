/**
 * Pure JS side of Desert Night Camp (desertcamp.ts): where the sky's pole and
 * Milky Way sit, the dune silhouettes (a column table), where the campfire and
 * tent stand, the fire's flicker, the rising sparks and the occasional meteor.
 * Nothing here touches GL.
 *
 * Coordinates: reference px of a 1080-tall frame, origin bottom-left, y up
 * (as `gl_FragCoord / scale`), unless a comment says "height units" (the frame
 * is 1 tall).
 */
import {
  createFlameMotion,
  draftAt,
  flameAt,
  type FlameMotion,
  BRIGHT_RANGE as CANDLE_BRIGHT_RANGE,
} from "./candle-sim";
import { profile, profileParams, type ProfileParams } from "./dunes-sim";
import { clamp, smoothstep } from "./math";
import { createRng, type Noise } from "./noise";
import { bandThrough, type MilkyWayBand } from "./starfield-sim";
import type { FireSide } from "./desertcamp.meta";

export const REF_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

/** The pole sits this far right of the frame's centre and this high (reference px), above the frame. */
export const POLE_DX = 300;
export const POLE_Y = 1350;

/** Pole for a frame `refWidth` wide. */
export function skyPole(refWidth: number, out: [number, number]): [number, number] {
  out[0] = refWidth / 2 + POLE_DX;
  out[1] = POLE_Y;
  return out;
}

/**
 * The Milky Way at rotation 0: rising from the horizon right of centre and
 * arcing up to the top left. Relative to the pole, so it is the same at every
 * width, and its GLSL can be built once.
 */
export const BAND: MilkyWayBand = bandThrough([POLE_DX, POLE_Y], -450, 700, -0.62, 190);

/** Lowest star the dunes can uncover, reference px: stars below it are never listed. */
export const SKY_FLOOR = 120;

/** Share of star cells occupied at a "Stars" setting of 1. */
export const DENSITY_MAX = 0.6;

// ---------------------------------------------------------------------------
// Dunes
// ---------------------------------------------------------------------------

/** Columns of the dune table across the frame width. */
export const DUNE_COLUMNS = 1024;
/** Floats per column: near, mid and far height (height units), and the near dune's slope. */
export const DUNE_CHANNELS = 4;
/** Dune layers, nearest first. */
export const DUNE_LAYERS = 3;
/** Each layer's trough height and dune height, height units, nearest first. */
export const DUNE_BASE = [0.055, 0.15, 0.235] as const;
export const DUNE_AMP = [0.2, 0.11, 0.065] as const;
/** Crest rounding (see `duneShape`): soft night silhouettes. */
const DUNE_SOFTNESS = 1.6;

/** Highest any dune can reach, height units. */
export const DUNE_TOP = Math.max(...DUNE_BASE.map((b, i) => b + DUNE_AMP[i]));

const profileScratch: ProfileParams[] = [];

/**
 * Fills `out` (`DUNE_COLUMNS * DUNE_CHANNELS`) with the three dune heights
 * (height units) at x = column / (DUNE_COLUMNS - 1) of the width, and the near
 * dune's slope (height per unit x, both in height units). The profiles come
 * from Sand Dunes' `profile`. Deterministic for a seed and width.
 */
export function fillDuneTable(out: Float32Array, seed: number, refWidth: number): void {
  const aspect = Math.max(1, refWidth) / REF_HEIGHT;
  for (let i = 0; i < DUNE_LAYERS; i++) {
    profileScratch[i] = profileParams(Math.floor(seed) + 101, i, DUNE_LAYERS, DUNE_SOFTNESS);
  }
  const last = DUNE_COLUMNS - 1;
  const h = aspect / last;
  const near = (x: number) => DUNE_BASE[0] + DUNE_AMP[0] * profile(x, profileScratch[0]);
  for (let c = 0; c < DUNE_COLUMNS; c++) {
    const x = (c / last - 0.5) * aspect;
    const o = c * DUNE_CHANNELS;
    for (let i = 0; i < DUNE_LAYERS; i++) {
      out[o + i] = DUNE_BASE[i] + DUNE_AMP[i] * profile(x, profileScratch[i]);
    }
    out[o + 3] = (near(x + h) - near(x - h)) / (2 * h);
  }
}

/** Layer `layer`'s height (height units) at `u` (0..1 of the width), interpolated as the GPU does. */
export function duneHeightAt(table: Float32Array, layer: number, u: number): number {
  const f = clamp(u, 0, 1) * (DUNE_COLUMNS - 1);
  const c = Math.min(Math.floor(f), DUNE_COLUMNS - 2);
  const t = f - c;
  const a = table[c * DUNE_CHANNELS + layer];
  const b = table[(c + 1) * DUNE_CHANNELS + layer];
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Camp layout
// ---------------------------------------------------------------------------

/** Fire distance from its edge, fraction of the width. */
export const FIRE_EDGE = 0.085;
/** The fire sits on the near dune's face, this far (reference px) below its crest line, and no lower than `FIRE_MIN_Y`. */
export const FIRE_BELOW_CREST = 36;
export const FIRE_MIN_Y = 42;
/** Tent centre's distance from the fire, towards the frame centre, fraction of the width. */
export const TENT_OFFSET = 0.11;
/** Tent half-width and height, reference px. */
export const TENT_HALF_W = 70;
export const TENT_H = 92;
/** The tent stands this far below the crest line, reference px. */
const TENT_BELOW_CREST = 22;

export interface CampLayout {
  /** Whether there is a fire. */
  fire: boolean;
  /** -1 for a fire at the left edge, 1 at the right. The tent's side when there is no fire. */
  side: number;
  /** Fire base, reference px. */
  fireX: number;
  fireY: number;
  /** Tent centre x and base y, reference px. */
  tentX: number;
  tentY: number;
}

export const createCampLayout = (): CampLayout => ({
  fire: true,
  side: -1,
  fireX: 0,
  fireY: 0,
  tentX: 0,
  tentY: 0,
});

/**
 * Places the fire at its edge on the near dune and the tent next to it, nearer
 * the centre but still in the outer third. With no fire, the tent stands where
 * a left fire would put it.
 */
export function layoutCamp(
  out: CampLayout,
  table: Float32Array,
  fire: FireSide | string,
  refWidth: number,
): CampLayout {
  const w = Math.max(1, refWidth);
  out.fire = fire === "left" || fire === "right";
  out.side = fire === "right" ? 1 : -1;
  const fu = out.side < 0 ? FIRE_EDGE : 1 - FIRE_EDGE;
  out.fireX = fu * w;
  out.fireY = Math.max(FIRE_MIN_Y, duneHeightAt(table, 0, fu) * REF_HEIGHT - FIRE_BELOW_CREST);
  const tu = fu - out.side * TENT_OFFSET;
  out.tentX = tu * w;
  out.tentY = Math.max(FIRE_MIN_Y, duneHeightAt(table, 0, tu) * REF_HEIGHT - TENT_BELOW_CREST);
  return out;
}

// ---------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------

/** Flame tongues. */
export const TONGUES = 3;
/** Tongue x offsets from the fire's centre, lengths and half-widths, reference px. */
export const TONGUE_X = [-7, 0, 8] as const;
export const TONGUE_L = [34, 48, 30] as const;
export const TONGUE_W = [7, 10, 6.5] as const;
/** How often the shared draft leans the flames (candle-sim's `draftAt`). */
const DRAFT = 0.25;
/** Largest |brightness - 1| of the fire's light. */
export const FIRE_FLICKER_RANGE = CANDLE_BRIGHT_RANGE;

export interface FireState {
  motion: FlameMotion;
  /** Shared lean, -1..1. */
  lean: number;
  /** Light multiplier, the mean of the tongues' brightness. */
  light: number;
}

export const createFireState = (): FireState => ({
  motion: createFlameMotion(),
  lean: 0,
  light: 1,
});

/**
 * The fire at time `t` (s): each tongue's sway, stretch and brightness from the
 * candle flicker curves (all under 2 Hz, a few percent), and the light it
 * throws. Stateless, so continuous in `t`.
 */
export function fireAt(noise: Noise, t: number, out: FireState): FireState {
  out.lean = draftAt(noise, t, DRAFT);
  let sum = 0;
  for (let i = 0; i < TONGUES; i++) {
    flameAt(noise, i, t, 1, out.lean, out.motion);
    sum += out.motion.bright[i];
  }
  out.light = sum / TONGUES;
  return out;
}

/** Firelight falloff radius on the sand, reference px. */
export const LIGHT_R = 230;
/** The sand is seen at a grazing angle, so the light pool is squashed vertically by this. */
export const LIGHT_SQUASH = 2.2;
/** How strongly a dune face turned towards the fire brightens (per unit of slope), and the clamp. */
export const FACING_GAIN = 1.4;
export const FACING_RANGE = [0.35, 1.8] as const;

/**
 * Firelight on the near dune at offset (dx, dy) from the fire (reference px),
 * where the dune's slope is `slope` (height per unit x): a soft inverse-square
 * falloff, brighter on faces that turn towards the fire. The shader's twin.
 */
export function sandLight(dx: number, dy: number, slope: number): number {
  const ex = dx / LIGHT_R;
  const ey = (dy * LIGHT_SQUASH) / LIGHT_R;
  const q = 1 + ex * ex + ey * ey;
  const facing = clamp(1 + FACING_GAIN * slope * Math.sign(dx), FACING_RANGE[0], FACING_RANGE[1]);
  return facing / (q * q);
}

// ---------------------------------------------------------------------------
// Sparks
// ---------------------------------------------------------------------------

export const MAX_SPARKS = 24;
/** New sparks per second. */
export const SPARK_RATE = 5;
/** Lifetime range, s. */
export const SPARK_LIFE = [1.2, 2.8] as const;
/** Launch speed range (reference px / s), upward. */
export const SPARK_SPEED = [45, 95] as const;
/** Upward speed lost per second (drag on the launch speed). */
const SPARK_DRAG = 0.6;
/** Slowest rise the hot air keeps up, reference px / s. */
const SPARK_BUOYANCY = 22;
/** Sideways wobble, reference px / s, and drift per unit of lean. */
const SPARK_WOBBLE = 9;
const SPARK_LEAN_DRIFT = 30;

export interface Sparks {
  count: number;
  x: Float64Array;
  y: Float64Array;
  vy: Float64Array;
  age: Float64Array;
  life: Float64Array;
  phase: Float64Array;
  /** Fractional spark owed by the spawn rate. */
  owed: number;
  rand: () => number;
}

export function createSparks(seed: number): Sparks {
  return {
    count: 0,
    x: new Float64Array(MAX_SPARKS),
    y: new Float64Array(MAX_SPARKS),
    vy: new Float64Array(MAX_SPARKS),
    age: new Float64Array(MAX_SPARKS),
    life: new Float64Array(MAX_SPARKS),
    phase: new Float64Array(MAX_SPARKS),
    owed: 0,
    rand: createRng(Math.floor(seed) * 613 + 29),
  };
}

/**
 * Moves the sparks on by `dt` s: they rise from the fire at (`fireX`, `fireY`),
 * slow to a gentle drift, wobble and lean with the draft, and die at the end of
 * their life. New ones spawn only while `on`. Dead sparks are swapped out, so
 * the live ones are always the first `count`.
 */
export function stepSparks(
  s: Sparks,
  dt: number,
  on: boolean,
  fireX: number,
  fireY: number,
  lean: number,
): void {
  const step = clamp(dt, 0, 0.1);
  for (let i = 0; i < s.count; i++) {
    s.age[i] += step;
    if (s.age[i] >= s.life[i]) {
      const last = --s.count;
      s.x[i] = s.x[last];
      s.y[i] = s.y[last];
      s.vy[i] = s.vy[last];
      s.age[i] = s.age[last];
      s.life[i] = s.life[last];
      s.phase[i] = s.phase[last];
      i--;
      continue;
    }
    s.vy[i] = SPARK_BUOYANCY + (s.vy[i] - SPARK_BUOYANCY) * Math.exp(-SPARK_DRAG * step);
    s.y[i] += s.vy[i] * step;
    const wobble = Math.sin(s.age[i] * 2.1 + s.phase[i]) * SPARK_WOBBLE;
    s.x[i] += (wobble + lean * SPARK_LEAN_DRIFT) * step;
  }
  if (!on) {
    s.owed = 0;
    return;
  }
  s.owed += SPARK_RATE * step;
  while (s.owed >= 1) {
    s.owed -= 1;
    if (s.count >= MAX_SPARKS) continue;
    const i = s.count++;
    const r = s.rand;
    s.x[i] = fireX + (r() - 0.5) * 16;
    s.y[i] = fireY + 6 + r() * 14;
    s.vy[i] = SPARK_SPEED[0] + (SPARK_SPEED[1] - SPARK_SPEED[0]) * r();
    s.age[i] = 0;
    s.life[i] = SPARK_LIFE[0] + (SPARK_LIFE[1] - SPARK_LIFE[0]) * r();
    s.phase[i] = r() * Math.PI * 2;
  }
}

/** Spark `i`'s brightness, 0..1: a quick flare, then a fade to nothing at the end of its life. */
export function sparkGlow(s: Sparks, i: number): number {
  const u = s.age[i] / s.life[i];
  return smoothstep(0, 0.08, u) * (1 - u) * (1 - u);
}

// ---------------------------------------------------------------------------
// Meteors
// ---------------------------------------------------------------------------

/** Shortest gap between meteors and the mean extra gap (exponential), s: one every few minutes. */
export const METEOR_MIN_GAP = 40;
export const METEOR_MEAN_EXTRA = 110;
/** Mean gap, s. */
export const METEOR_MEAN_GAP = METEOR_MIN_GAP + METEOR_MEAN_EXTRA;
/** Duration (s), length (reference px) and peak brightness ranges: short and soft. */
export const METEOR_DURATION = [0.5, 0.9] as const;
export const METEOR_LENGTH = [110, 220] as const;
export const METEOR_BRIGHT = [0.3, 0.55] as const;

export interface Meteor {
  /** Start time, s; -Infinity before the first. */
  start: number;
  duration: number;
  /** Start point (reference px) and unit direction. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  length: number;
  bright: number;
}

export interface Meteors {
  /** The latest meteor (at most one at a time, since the gap dwarfs a meteor's life). */
  current: Meteor;
  /** Time of the next start, s. */
  next: number;
  /** Meteors started so far. */
  started: number;
  rand: () => number;
}

export function createMeteors(seed: number): Meteors {
  const rand = createRng(Math.floor(seed) * 389 + 7);
  return {
    current: { start: -Infinity, duration: 1, x: 0, y: 0, dx: 0, dy: -1, length: 0, bright: 0 },
    // The first one comes a little sooner than the average.
    next: METEOR_MIN_GAP * 0.5 + rand() * METEOR_MEAN_EXTRA,
    started: 0,
    rand,
  };
}

/** The next gap, s: `METEOR_MIN_GAP` plus an exponential with mean `METEOR_MEAN_EXTRA`. */
export const meteorGap = (rand: () => number) =>
  METEOR_MIN_GAP - METEOR_MEAN_EXTRA * Math.log(1 - rand());

/**
 * Advances the schedule to time `t` (s, float64): starts each meteor that is
 * due, when `on` (when off, due slots pass with nothing). Each starts in the
 * upper sky of an outer third and heads down and outwards, so it never crosses
 * the centre.
 */
export function stepMeteors(m: Meteors, t: number, on: boolean, refWidth: number): void {
  const w = Math.max(1, refWidth);
  while (t >= m.next) {
    const at = m.next;
    m.next += meteorGap(m.rand);
    if (!on) continue;
    const r = m.rand;
    const c = m.current;
    const left = r() < 0.5;
    c.start = at;
    c.duration = METEOR_DURATION[0] + (METEOR_DURATION[1] - METEOR_DURATION[0]) * r();
    c.length = METEOR_LENGTH[0] + (METEOR_LENGTH[1] - METEOR_LENGTH[0]) * r();
    c.bright = METEOR_BRIGHT[0] + (METEOR_BRIGHT[1] - METEOR_BRIGHT[0]) * r();
    c.y = REF_HEIGHT * (0.62 + 0.3 * r());
    const fx = 0.06 + 0.22 * r();
    c.x = (left ? fx : 1 - fx) * w;
    // 20..65 degrees below the horizontal, outwards.
    const a = (20 + 45 * r()) * (Math.PI / 180);
    c.dx = (left ? -1 : 1) * Math.cos(a);
    c.dy = -Math.sin(a);
    m.started++;
  }
}

/** A meteor's head and tail (reference px) and brightness at one time. */
export interface MeteorPose {
  headX: number;
  headY: number;
  tailX: number;
  tailY: number;
  /** 0 when not visible. */
  bright: number;
}

export const createMeteorPose = (): MeteorPose => ({
  headX: 0,
  headY: 0,
  tailX: 0,
  tailY: 0,
  bright: 0,
});

/**
 * Meteor `m` at time `t`: the head runs along its path, the tail follows
 * behind it up to half the length, and the brightness swells and fades
 * smoothly, 0 at both ends.
 */
export function meteorAt(m: Meteor, t: number, out: MeteorPose): MeteorPose {
  const u = (t - m.start) / m.duration;
  if (!(u > 0 && u < 1)) {
    out.bright = 0;
    return out;
  }
  const head = m.length * u;
  const tail = Math.max(0, head - 0.5 * m.length * Math.min(1, u * 2.5));
  out.headX = m.x + m.dx * head;
  out.headY = m.y + m.dy * head;
  out.tailX = m.x + m.dx * tail;
  out.tailY = m.y + m.dy * tail;
  out.bright = m.bright * Math.sin(Math.PI * u) ** 2;
  return out;
}
