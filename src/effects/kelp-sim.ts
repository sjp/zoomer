/**
 * Kelp forest's simulation, kept free of GL so it can be tested: the seeded
 * frond layout per depth layer, the blade width profiles, the swell (from the
 * shared `sway.ts`), drifting light shafts, fish-shadow schools and marine snow.
 *
 * Fish and snow positions are in height units (1 = the frame height, y down from
 * the top, x from 0 to the aspect ratio). Frond x is a fraction of the width.
 */
import type { Rgb } from "./color";
import { clamp } from "./math";
import { createRng } from "./noise";
import { createSwell, swayOffset, type Swell } from "./sway";

const TAU = Math.PI * 2;

/**
 * The forest's swell: a 10 s main period, a 12 s partner and a faint 6 s ripple,
 * repeating every 60 s at speed 1.
 */
export const KELP_SWELL: Swell = createSwell(60, [
  { cycles: 6, amplitude: 1, offset: 0 },
  { cycles: 5, amplitude: 0.55, offset: 0.37 },
  { cycles: 10, amplitude: 0.18, offset: 0.71 },
]);

/** Largest tip sway (fraction of the frond's height) at `swell` = 1, before the layer's scale. */
export const SWAY_MAX = 0.14;
/** Seconds the tip of a frond as tall as the frame trails its base. */
export const LAG_PER_HEIGHT = 2.6;
/** Seconds the swell takes to travel across the frame, so neighbours don't move in lockstep. */
export const SWELL_TRAVEL = 3;

/** Segments per frond strip, and the strip itself: (level, side) per vertex. */
export const SEGMENTS = 20;
export const FROND_STRIP: readonly number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    out.push(i, -1, i, 1);
  }
  return out;
})();

/** Floats per frond instance: (x, height, half width, profile row) and (phase, lag, lean, tone). */
export const FROND_FLOATS = 8;

export interface KelpLayer {
  /** Fronds at density 1. */
  readonly count: number;
  /** Sea-floor y of the bases, as a fraction of the height from the top. */
  readonly floor: number;
  /** Frond heights, fractions of the frame height. */
  readonly heightMin: number;
  readonly heightMax: number;
  /** Envelope half width at the base, px at 1080p (blades included). */
  readonly width: number;
  /** Share of fronds kept in the centre third, relative to the edges. */
  readonly centre: number;
  /** Fog towards the water colour, 0..1. */
  readonly fog: number;
  /** Edge softness, px at 1080p. */
  readonly blur: number;
  /** Sway multiplier: far fronds move less on screen. */
  readonly sway: number;
  /** Back-lit rim strength. */
  readonly rim: number;
}

/** Far to near. */
export const LAYERS: readonly KelpLayer[] = [
  {
    count: 24,
    floor: 0.86,
    heightMin: 0.4,
    heightMax: 0.72,
    width: 9,
    centre: 0.3,
    fog: 0.72,
    blur: 5,
    sway: 0.6,
    rim: 0,
  },
  {
    count: 18,
    floor: 0.93,
    heightMin: 0.55,
    heightMax: 0.92,
    width: 14,
    centre: 0.18,
    fog: 0.48,
    blur: 3.5,
    sway: 0.75,
    rim: 0.15,
  },
  {
    count: 12,
    floor: 1,
    heightMin: 0.72,
    heightMax: 1.12,
    width: 22,
    centre: 0.06,
    fog: 0.26,
    blur: 2,
    sway: 0.9,
    rim: 0.45,
  },
  {
    count: 7,
    floor: 1.06,
    heightMin: 0.95,
    heightMax: 1.35,
    width: 34,
    centre: 0,
    fog: 0.06,
    blur: 1.5,
    sway: 1,
    rim: 0.8,
  },
];

export const DENSITY_MAX = 2.5;
export const MAX_FRONDS = LAYERS.reduce((n, l) => n + Math.round(l.count * DENSITY_MAX), 0);
/** Base x stays this far inside the frame (fraction of the width). */
export const X_MARGIN = 0.01;

/** Fronds in a layer at `density` (clamped to [0, DENSITY_MAX]); at least 1. */
export function layerCount(layer: KelpLayer, density: number): number {
  const d = clamp(Number.isFinite(density) ? density : 1, 0, DENSITY_MAX);
  return Math.max(1, Math.round(layer.count * d));
}

/**
 * How much the centre third suppresses fronds at `x` (fraction of the width):
 * 1 across [0.36, 0.64], easing to 0 at 0.28 and 0.72.
 */
export function centreMask(x: number): number {
  const d = Math.abs(x - 0.5);
  return 1 - clamp((d - 0.14) / 0.08, 0, 1);
}

/** Relative frond density at `x`: highest at the edges, `centre` in the middle third. */
export function edgeWeight(x: number, centre: number): number {
  const edge = 0.6 + 0.4 * Math.abs(2 * x - 1);
  return edge * (1 + (centre - 1) * centreMask(x));
}

/** Width profile rows: each a different blade spacing and phase. */
export const PROFILE_ROWS = 4;
export const PROFILE_COLUMNS = 128;
/** Stipe half width as a share of the envelope. */
export const STIPE = 0.13;

/**
 * Blade width profiles, RG per texel (left and right half widths as shares of
 * the envelope, 0..1), `PROFILE_COLUMNS` along the frond (base to tip) by
 * `PROFILE_ROWS`. Blades alternate sides along a thin stipe and shrink near
 * the base, where giant kelp is mostly bare.
 */
export function buildBladeProfiles(seed: number): Float32Array {
  const out = new Float32Array(PROFILE_COLUMNS * PROFILE_ROWS * 2);
  const rng = createRng(seed);
  for (let r = 0; r < PROFILE_ROWS; r++) {
    const row = r * PROFILE_COLUMNS * 2;
    for (let c = 0; c < PROFILE_COLUMNS; c++) {
      out[row + c * 2] = STIPE;
      out[row + c * 2 + 1] = STIPE;
    }
    const blades = 7 + Math.floor(rng() * 4);
    let side = rng() < 0.5 ? 0 : 1;
    for (let b = 0; b < blades; b++) {
      // Start a little above the base; blades overlap a bit along the stipe.
      const t0 = 0.1 + (0.86 * (b + 0.15 * rng())) / blades;
      const len = (1.7 + 0.5 * rng()) / blades;
      const size = (0.75 + 0.25 * rng()) * (0.55 + 0.45 * Math.min(1, t0 / 0.35));
      for (let c = 0; c < PROFILE_COLUMNS; c++) {
        const t = c / (PROFILE_COLUMNS - 1);
        const u = (t - t0) / len;
        if (u <= 0 || u >= 1) {
          continue;
        }
        // A leaf: quick to widen from its attachment, long taper to its point.
        const w = size * Math.sin(Math.PI * Math.sqrt(u)) ** 1.2;
        const i = row + c * 2 + side;
        out[i] = Math.max(out[i], clamp(w, 0, 1));
      }
      side = 1 - side;
    }
  }
  return out;
}

export interface FrondLayout {
  /** Fronds per layer and the index each layer starts at (far layers first). */
  readonly counts: readonly number[];
  readonly starts: readonly number[];
  readonly total: number;
}

/**
 * Fills `out` (`FROND_FLOATS` per frond, layer by layer, far first) with a
 * seeded layout at `density`. Rejection sampling keeps fronds denser at the
 * edges and sparse in the centre third. Deterministic per (seed, density).
 */
export function buildFronds(seed: number, density: number, out: Float32Array): FrondLayout {
  const counts: number[] = [];
  const starts: number[] = [];
  let n = 0;
  for (let l = 0; l < LAYERS.length; l++) {
    const layer = LAYERS[l];
    const rng = createRng(Math.floor(seed) * 7919 + l * 104729);
    const want = Math.min(layerCount(layer, density), Math.floor(out.length / FROND_FLOATS) - n);
    starts.push(n);
    counts.push(Math.max(0, want));
    for (let k = 0; k < want; k++) {
      // Rejection sampling; the weight is 0.6 or more near the edges, so this
      // almost always accepts within a few tries. The fallback is an edge spot.
      let x = -1;
      for (let tries = 0; tries < 64 && x < 0; tries++) {
        const c = X_MARGIN + (1 - 2 * X_MARGIN) * rng();
        if (rng() < edgeWeight(c, layer.centre)) {
          x = c;
        }
      }
      if (x < 0) {
        x = rng() < 0.5 ? X_MARGIN + 0.2 * rng() : 1 - X_MARGIN - 0.2 * rng();
      }
      const h = layer.heightMin + (layer.heightMax - layer.heightMin) * rng();
      const o = (n + k) * FROND_FLOATS;
      out[o] = x;
      out[o + 1] = h;
      out[o + 2] = layer.width * (0.8 + 0.4 * rng());
      out[o + 3] = (Math.floor(rng() * PROFILE_ROWS) + 0.5) / PROFILE_ROWS;
      out[o + 4] = (x * SWELL_TRAVEL + 0.4 * rng()) / KELP_SWELL.period;
      out[o + 5] = LAG_PER_HEIGHT * h * (0.85 + 0.3 * rng());
      // A slight lean, mostly away from the centre, as if reaching for open water.
      out[o + 6] = (x < 0.5 ? -1 : 1) * 0.03 * rng() + 0.05 * (rng() - 0.5);
      out[o + 7] = rng();
    }
    n += Math.max(0, want);
  }
  return { counts, starts, total: n };
}

/**
 * The frond's horizontal offset at height `t` (0 base, 1 tip), as a fraction of
 * its own height: static lean plus the lagged swell, `swell * SWAY_MAX * layerSway`
 * at most. The vertex shader's twin is `frondX`.
 */
export function frondSway(
  phase: number,
  frondPhase: number,
  lag: number,
  t: number,
  swell: number,
  layerSway: number,
): number {
  return swayOffset(KELP_SWELL, phase + frondPhase, t, lag, swell * SWAY_MAX * layerSway);
}

// ---- Light shafts ----

export const MAX_SHAFTS = 6;

/** Shafts: top x (fraction of the width), slope (dx per dy), top width (heights), strength, drift. */
export interface Shaft {
  readonly x: number;
  readonly slope: number;
  readonly width: number;
  readonly strength: number;
  /** Drift half-amplitude (fraction of the width) and whole cycles per swell period. */
  readonly drift: number;
  readonly cycles: number;
  readonly offset: number;
}

export const SHAFTS: readonly Shaft[] = [
  { x: 0.12, slope: 0.22, width: 0.05, strength: 0.9, drift: 0.03, cycles: 1, offset: 0 },
  { x: 0.3, slope: 0.18, width: 0.035, strength: 0.6, drift: 0.025, cycles: 2, offset: 0.4 },
  { x: 0.52, slope: 0.25, width: 0.06, strength: 0.7, drift: 0.035, cycles: 1, offset: 0.7 },
  { x: 0.74, slope: 0.2, width: 0.04, strength: 0.8, drift: 0.02, cycles: 2, offset: 0.15 },
  { x: 0.9, slope: 0.16, width: 0.05, strength: 0.65, drift: 0.03, cycles: 1, offset: 0.55 },
];

/**
 * Writes the shafts at swell `phase` into `out` as vec4s: top x (px), slope,
 * top half width (px), strength. Each drifts by whole cycles per period, so the
 * wrap is seamless. Returns the number written.
 */
export function shaftUniforms(
  phase: number,
  width: number,
  height: number,
  out: Float32Array,
): number {
  const n = Math.min(SHAFTS.length, MAX_SHAFTS, Math.floor(out.length / 4));
  for (let i = 0; i < n; i++) {
    const s = SHAFTS[i];
    const x = s.x + s.drift * Math.sin(TAU * (s.cycles * phase + s.offset));
    out[i * 4] = x * width;
    out[i * 4 + 1] = s.slope;
    out[i * 4 + 2] = s.width * height;
    out[i * 4 + 3] = s.strength;
  }
  return n;
}

// ---- Fish shadows ----

export const FISH_PER_SCHOOL = 9;
/** Seconds between school spawns, and before the first. */
export const SCHOOL_INTERVAL_MIN = 60;
export const SCHOOL_INTERVAL_MAX = 120;
export const FIRST_SCHOOL = 20;
/** School speed, heights per second. */
export const SCHOOL_SPEED_MIN = 0.045;
export const SCHOOL_SPEED_MAX = 0.07;
/** Fish length (heights) and the school's spread around its centre (heights). */
export const FISH_LENGTH = 0.022;
export const SCHOOL_SPREAD_X = 0.12;
export const SCHOOL_SPREAD_Y = 0.05;
/** Schools start and end this far outside the frame (heights), past the furthest fish. */
export const SCHOOL_MARGIN = SCHOOL_SPREAD_X + 2 * FISH_LENGTH;
/** Floats per fish instance: (x, y, length, dir), (wiggle phase, alpha). */
export const FISH_FLOATS = 6;

export interface Fish {
  /** Seconds until the next school may spawn (counts down from the last spawn). */
  timer: number;
  active: boolean;
  /** School centre (heights), direction (+1 right), speed (heights/s), age (s). */
  x: number;
  y: number;
  dir: number;
  speed: number;
  age: number;
  /** Offsets of each fish from the centre, and their wiggle phases. */
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  readonly wiggle: Float32Array;
  /** Schools spawned so far. */
  spawned: number;
  readonly rng: () => number;
}

export function createFish(seed: number): Fish {
  return {
    timer: FIRST_SCHOOL,
    active: false,
    x: 0,
    y: 0,
    dir: 1,
    speed: 0,
    age: 0,
    dx: new Float32Array(FISH_PER_SCHOOL),
    dy: new Float32Array(FISH_PER_SCHOOL),
    wiggle: new Float32Array(FISH_PER_SCHOOL),
    spawned: 0,
    rng: createRng(seed ^ 0x51f15),
  };
}

function spawnSchool(f: Fish, aspect: number): void {
  const r = f.rng;
  f.active = true;
  f.dir = r() < 0.5 ? 1 : -1;
  f.x = f.dir > 0 ? -SCHOOL_MARGIN : aspect + SCHOOL_MARGIN;
  f.y = 0.25 + 0.3 * r();
  f.speed = SCHOOL_SPEED_MIN + (SCHOOL_SPEED_MAX - SCHOOL_SPEED_MIN) * r();
  f.age = 0;
  for (let i = 0; i < FISH_PER_SCHOOL; i++) {
    f.dx[i] = SCHOOL_SPREAD_X * (2 * r() - 1);
    f.dy[i] = SCHOOL_SPREAD_Y * (2 * r() - 1);
    f.wiggle[i] = r();
  }
  f.timer = SCHOOL_INTERVAL_MIN + (SCHOOL_INTERVAL_MAX - SCHOOL_INTERVAL_MIN) * r();
  f.spawned++;
}

/** True once every fish of the school is past the far edge of a frame `aspect` wide. */
export function schoolGone(f: Fish, aspect: number): boolean {
  return f.dir > 0 ? f.x > aspect + SCHOOL_MARGIN : f.x < -SCHOOL_MARGIN;
}

/**
 * Advances the fish by `dt` seconds: one school at a time, spawned when the
 * timer runs out and no school is still crossing, despawned once it has left.
 */
export function stepFish(f: Fish, dt: number, aspect: number): void {
  if (!(dt > 0)) {
    return;
  }
  f.timer -= dt;
  if (f.active) {
    f.age += dt;
    f.x += f.dir * f.speed * dt;
    // A gentle rise and fall, so the school doesn't cross on a ruler.
    f.y += 0.006 * Math.sin(f.age * 0.4) * dt;
    if (schoolGone(f, aspect)) {
      f.active = false;
    }
  }
  if (!f.active && f.timer <= 0) {
    spawnSchool(f, aspect);
  }
}

/** Writes the active school's fish into `out` (`FISH_FLOATS` each); returns how many. */
export function fishInstances(f: Fish, aspect: number, out: Float32Array): number {
  if (!f.active) {
    return 0;
  }
  const n = Math.min(FISH_PER_SCHOOL, Math.floor(out.length / FISH_FLOATS));
  for (let i = 0; i < n; i++) {
    const o = i * FISH_FLOATS;
    const x = f.x + f.dx[i];
    out[o] = x;
    out[o + 1] = f.y + f.dy[i] + 0.004 * Math.sin(f.age * 0.9 + TAU * f.wiggle[i]);
    out[o + 2] = FISH_LENGTH * (0.8 + 0.4 * f.wiggle[i]);
    out[o + 3] = f.dir;
    out[o + 4] = TAU * f.wiggle[i] + f.age * 7;
    // Fade in and out over the last stretch outside the frame edges.
    out[o + 5] =
      clamp((x + FISH_LENGTH) / 0.1, 0, 1) * clamp((aspect + FISH_LENGTH - x) / 0.1, 0, 1);
  }
  return n;
}

// ---- Marine snow ----

export const SNOW_COUNT = 140;
/** Sinking speed range, heights per second. */
export const SNOW_SINK_MIN = 0.006;
export const SNOW_SINK_MAX = 0.018;
/** Floats per snow instance: (x, y, radius px at 1080p, alpha). */
export const SNOW_FLOATS = 4;

export interface Snow {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly sink: Float32Array;
  readonly size: Float32Array;
  readonly phase: Float32Array;
  t: number;
}

/** Snow spread over a frame up to `maxAspect` wide (x wraps to the current aspect). */
export function createSnow(seed: number, maxAspect = 4): Snow {
  const rng = createRng(seed ^ 0x5a0);
  const s: Snow = {
    x: new Float32Array(SNOW_COUNT),
    y: new Float32Array(SNOW_COUNT),
    sink: new Float32Array(SNOW_COUNT),
    size: new Float32Array(SNOW_COUNT),
    phase: new Float32Array(SNOW_COUNT),
    t: 0,
  };
  for (let i = 0; i < SNOW_COUNT; i++) {
    s.x[i] = rng() * maxAspect;
    s.y[i] = rng();
    s.sink[i] = SNOW_SINK_MIN + (SNOW_SINK_MAX - SNOW_SINK_MIN) * rng();
    s.size[i] = 1.2 + 1.8 * rng() * rng();
    s.phase[i] = TAU * rng();
  }
  return s;
}

/** Sinks the snow by `dt` seconds, wrapping each particle from the bottom back to the top. */
export function stepSnow(s: Snow, dt: number): void {
  if (!(dt > 0)) {
    return;
  }
  s.t += dt;
  for (let i = 0; i < SNOW_COUNT; i++) {
    let y = s.y[i] + s.sink[i] * dt;
    if (y > 1.02) {
      y -= 1.04;
    }
    s.y[i] = y;
  }
}

/** Writes snow instances for a frame `aspect` wide into `out`; returns how many. */
export function snowInstances(s: Snow, aspect: number, out: Float32Array): number {
  const n = Math.min(SNOW_COUNT, Math.floor(out.length / SNOW_FLOATS));
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = s.x[i];
    if (x > aspect + 0.02) {
      continue;
    }
    const o = k * SNOW_FLOATS;
    out[o] = x + 0.008 * Math.sin(s.t * 0.25 + s.phase[i]);
    out[o + 1] = s.y[i];
    out[o + 2] = s.size[i];
    // Fades in from the top and out near the floor.
    const y = s.y[i];
    out[o + 3] = 0.55 * clamp((y + 0.02) / 0.08, 0, 1) * clamp((1.02 - y) / 0.1, 0, 1);
    k++;
  }
  return k;
}

// ---- Palettes ----

export type PaletteId = "temperate" | "tropical" | "dusk";

export interface KelpPalette {
  /** Water: bright surface glow, mid water, deep water. */
  readonly surface: Rgb;
  readonly mid: Rgb;
  readonly deep: Rgb;
  readonly shaft: Rgb;
  /** Kelp stipe (dark) and back-lit blade colour, and the warm rim. */
  readonly stipe: Rgb;
  readonly blade: Rgb;
  readonly rim: Rgb;
  readonly fish: Rgb;
  readonly snow: Rgb;
}

export const PALETTES: Readonly<Record<PaletteId, KelpPalette>> = {
  temperate: {
    surface: [0.62, 0.8, 0.62],
    mid: [0.13, 0.33, 0.29],
    deep: [0.02, 0.08, 0.08],
    shaft: [0.65, 0.85, 0.62],
    stipe: [0.07, 0.07, 0.02],
    blade: [0.3, 0.28, 0.07],
    rim: [1, 0.74, 0.32],
    fish: [0.03, 0.08, 0.08],
    snow: [0.75, 0.85, 0.75],
  },
  tropical: {
    surface: [0.55, 0.88, 0.96],
    mid: [0.05, 0.36, 0.55],
    deep: [0.01, 0.06, 0.16],
    shaft: [0.62, 0.9, 1],
    stipe: [0.04, 0.07, 0.05],
    blade: [0.2, 0.32, 0.14],
    rim: [1, 0.86, 0.5],
    fish: [0.02, 0.07, 0.14],
    snow: [0.8, 0.92, 1],
  },
  dusk: {
    surface: [0.88, 0.58, 0.42],
    mid: [0.2, 0.17, 0.3],
    deep: [0.03, 0.03, 0.08],
    shaft: [1, 0.72, 0.48],
    stipe: [0.05, 0.03, 0.04],
    blade: [0.28, 0.16, 0.09],
    rim: [1, 0.55, 0.25],
    fish: [0.04, 0.03, 0.07],
    snow: [0.95, 0.8, 0.7],
  },
};
