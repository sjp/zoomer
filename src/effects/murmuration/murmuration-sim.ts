/**
 * Pure JS side of the starling murmuration (murmuration.ts): tuned constants,
 * the bird-count tiers, the steering weights, the global steering (wandering
 * attractor, swirl, edges and the soft central exclusion zone), the predator
 * schedule, the field-grid encoding, the sky palettes and the horizon
 * silhouettes, plus GLSL twins of the functions the shaders also compute.
 *
 * Units: positions are in frame heights, x in [0, aspect] and y in [0, 1] from
 * the bottom-left; velocities in heights per second, accelerations in heights
 * per second squared. Times are simulation seconds (already scaled by `speed`).
 *
 * The flocking is "boids via fields": each step every bird splats its velocity
 * and a count into a coarse grid (one cell per 1/GRID_H heights), the grid is
 * blurred, and each bird then steers towards the local mean velocity
 * (alignment), up the density gradient while the local density is below a
 * target and down it above (cohesion and separation in one term), plus the
 * global terms here. No sorting and no neighbour lists.
 */
import { glslFloat as f } from "../gl";
import { clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { MAX_BIRDS, type SKY_OPTIONS } from "./murmuration.meta";
import { lookup } from "../lookup";

export { type StepClock, takeSteps } from "../step-clock";

/** Simulation steps per second; the draw extrapolates positions between steps. */
export const STEP_RATE = 30;
/** Most simulation steps in one frame; owed steps beyond this are dropped. */
export const MAX_STEPS = 2;

/** Field-grid rows; one cell is 1/GRID_H heights (24 px at 1080p). */
export const GRID_H = 45;
/** Widest field grid, for extreme aspect ratios. */
export const MAX_GRID_W = 256;

/** Floats per bird: x, y, vx, vy. */
export const BIRD_FLOATS = 4;

/** Cruising speed, heights per second, at speed 1. */
export const CRUISE = 0.2;
/** Speed cap; also the full scale of the velocity encoding in the field grid. */
export const VMAX = 0.6;
/** Rate at which a bird's speed relaxes back to CRUISE, per second. */
export const SPEED_K = 1.5;
/** Peak-to-peak random acceleration per bird per step. */
export const NOISE_ACCEL = 0.3;
/** Cap on the cohesion / separation term. */
export const FLOCK_MAX = 0.8;
/** Cap on the attractor's pull. */
export const ATTRACT_MAX = 0.5;
/** Cap on the swirl term's lever arm, heights. */
export const SWIRL_REACH = 0.4;
/** Peak swirl, per second squared (tangential acceleration per height of lever arm). */
export const SWIRL = 0.8;
/** Swirl reversal period, seconds. */
const SWIRL_PERIOD = 53;
/** The attractor's anisotropy ("breathing") period: ribbon, then ball, then ribbon. */
const BREATH_PERIOD = 37;
/** Fraction by which the attractor's x and y pulls swing in antiphase. */
const BREATH_DEPTH = 0.6;

/** Edge push: margin (heights) and peak acceleration. */
const EDGE_MARGIN = 0.08;
const EDGE_ACCEL = 0.8;
/** Below this height birds are pushed up, fully by LOW_Y - LOW_RAMP. */
const LOW_Y = 0.38;
const LOW_RAMP = 0.2;
/**
 * Soft exclusion ellipse over the speaker: centred at (aspect / 2, EX_Y) with
 * half-axes EX_RX and EX_RY, pushing outwards at up to EX_ACCEL, fading from
 * full at EX_INNER of the radius to nothing at the rim. The centre sits below the
 * frame, so inside the frame the push always has an upward part; the rim
 * crosses y = 0.5 about a sixth of the width either side of the centre.
 */
export const EX_Y = -0.1;
const EX_RX = 0.4;
const EX_RY = 0.88;
const EX_INNER = 0.6;
const EX_ACCEL = 0.9;
/** Bound on |boundaryForce|: the edge terms on both axes plus the exclusion. */
export const BOUNDARY_MAX = Math.hypot(EDGE_ACCEL, EDGE_ACCEL * 2) + EX_ACCEL;

/** Predator passes: one per slot, starting 10-20 s into it, so 20-40 s apart. */
const PRED_SLOT = 30;
export const PRED_DURATION = 6;
/** Peak repulsion and its Gaussian radius (heights). */
export const PRED_ACCEL = 2.5;
export const PRED_RADIUS = 0.13;

// --- Bird counts -----------------------------------------------------------

/** Fraction of the `birds` param drawn at each quality. */
const QUALITY_BIRDS = { high: 1, balanced: 0.7, low: 0.4 } as const;

export interface BirdCounts {
  /** Birds drawn and splatted into the field. */
  draw: number;
  /** Birds updated: the quality tier's cap, at least `draw`, so a slider move shows birds already flocking. */
  update: number;
}

/** Bird counts for the `birds` and `quality` params; unknown qualities count as high. */
export function birdCounts(birds: number, quality: string, out: BirdCounts): BirdCounts {
  const share = lookup(QUALITY_BIRDS, quality, "high");
  const b = Number.isFinite(birds) ? clamp(birds, 0, MAX_BIRDS) : MAX_BIRDS;
  out.draw = Math.round(b * share);
  out.update = Math.max(out.draw, Math.round(MAX_BIRDS * share));
  return out;
}

/** Field grid size for a frame of `aspect` = width / height, written to `out`. */
export function gridSize(aspect: number, out: [number, number] = [0, 0]): [number, number] {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  out[0] = clamp(Math.round(a * GRID_H), 1, MAX_GRID_W);
  out[1] = GRID_H;
  return out;
}

// --- Field encoding --------------------------------------------------------

/**
 * Splatted birds in the 8-bit fallback, at most: every `stride`-th bird splats,
 * so a dense cell stays below the 127 birds an RGBA8 channel holds.
 */
export const SPLAT_8BIT_BIRDS = 8000;

export interface FieldEncoding {
  /** Only birds whose index is a multiple of this splat. */
  stride: number;
  /** The B (count) channel each splatting bird adds. */
  deposit: number;
  /** Multiplies the stored B channel to give the density (see `fieldDensity`). */
  rhoScale: number;
  /** 1 for the 8-bit fallback's stochastic rounding of the velocity channels. */
  quantise: number;
}

/**
 * The field encoding for `birds` drawn birds on a grid of `cells` cells. Each
 * splatting bird adds `deposit * ((1 + vx / VMAX) / 2, (1 + vy / VMAX) / 2, 1)` to
 * RGB, so the mean velocity is `(2 * RG / B - 1) * VMAX` whatever the scale, and
 * the density `B * rhoScale` is birds per cell relative to the frame's mean
 * (1 = birds spread evenly over the whole frame).
 *
 * Half float: every bird splats `cells / birds`, so B is the density itself.
 * RGBA8 fallback: every `stride`-th bird splats exactly 2/255 to B and 0, 1 or
 * 2/255 to each velocity channel (stochastically rounded, unbiased), so sums are
 * exact until a channel saturates.
 */
export function fieldEncoding(
  float: boolean,
  birds: number,
  cells: number,
  out: FieldEncoding,
): FieldEncoding {
  const n = Math.max(1, birds);
  if (float) {
    out.stride = 1;
    out.deposit = cells / n;
    out.rhoScale = 1;
    out.quantise = 0;
  } else {
    out.stride = Math.max(1, Math.ceil(n / SPLAT_8BIT_BIRDS));
    const splatted = Math.ceil(n / out.stride);
    out.deposit = 2 / 255;
    out.rhoScale = (127.5 * cells) / splatted;
    out.quantise = 1;
  }
  return out;
}

// --- Steering --------------------------------------------------------------

export interface SteeringWeights {
  /** Alignment rate towards the local mean velocity, per second. */
  align: number;
  /** Cohesion / separation gain on the log-density gradient. */
  flock: number;
  /** Target density (see `fieldEncoding`): denser repels, sparser attracts. */
  rhoEq: number;
  /** Attractor spring rate, per second squared. */
  attract: number;
}

/** Steering weights for `cohesion` in 0..1 (clamped; non-finite counts as 0.5). */
export function steeringWeights(cohesion: number, out: SteeringWeights): SteeringWeights {
  const c = Number.isFinite(cohesion) ? clamp(cohesion, 0, 1) : 0.5;
  out.align = 1.2 + 1.3 * c;
  out.flock = 0.006 + 0.008 * c;
  out.rhoEq = 4 + 12 * c;
  out.attract = 0.4 + 0.5 * c;
  return out;
}

/** Periods (s) and phases of the attractor's Lissajous path. */
const ATTR_PX = 83;
const ATTR_PY = 29;
const ATTR_PHASE = 0.7;
/** Horizontal swing as a fraction of the width either side of the centre. */
const ATTR_SWING = 0.3;
const ATTR_BASE_Y = 0.6;
/** Extra height when over the centre, to clear the exclusion zone. */
const ATTR_LIFT = 0.2;
const ATTR_BOB = 0.06;

/** Lowest point of the attractor path. */
export const ATTR_MIN_Y = ATTR_BASE_Y - ATTR_BOB;

/**
 * The wandering attractor at time `t` on a frame of `aspect`, written to
 * out[0..1]: a slow Lissajous path over the upper frame that rises as it crosses
 * the centre, so the flock passes over the speaker's head rather than in front.
 */
export function attractorAt(t: number, aspect: number, out: Float32Array): Float32Array {
  const sx = Math.sin((t * 2 * Math.PI) / ATTR_PX + ATTR_PHASE);
  out[0] = aspect * (0.5 + ATTR_SWING * sx);
  out[1] =
    ATTR_BASE_Y + ATTR_LIFT * (1 - sx * sx) + ATTR_BOB * Math.sin((t * 2 * Math.PI) / ATTR_PY);
  return out;
}

/**
 * The attractor's spring rates (x, y) at time `t` for base rate `k`, written to
 * out[0..1]. They swing in antiphase, so the flock stretches into a ribbon along
 * the weaker axis and then balls up again. Also writes the swirl (signed, per
 * second squared) to out[2]: a tangential pull around the attractor that slowly
 * reverses, folding the flock over itself.
 */
export function steeringAt(t: number, k: number, out: Float32Array): Float32Array {
  const b = BREATH_DEPTH * Math.sin((t * 2 * Math.PI) / BREATH_PERIOD);
  out[0] = k * (1 + b);
  out[1] = k * (1 - b);
  out[2] = SWIRL * Math.sin((t * 2 * Math.PI) / SWIRL_PERIOD + 1);
  return out;
}

/**
 * Steering away from the frame edges, the bottom third and the soft exclusion
 * ellipse over the speaker, at (x, y) on a frame of `aspect`, written to
 * out[0..1]. Points inwards and is at most BOUNDARY_MAX. GLSL twin:
 * BOUNDARY_GLSL.
 */
export function boundaryForce(
  x: number,
  y: number,
  aspect: number,
  out: Float32Array,
): Float32Array {
  let fx =
    EDGE_ACCEL * (1 - smoothstep(0, EDGE_MARGIN, x) - smoothstep(aspect - EDGE_MARGIN, aspect, x));
  let fy =
    EDGE_ACCEL *
    (2 * (1 - smoothstep(LOW_Y - LOW_RAMP, LOW_Y, y)) - smoothstep(1 - EDGE_MARGIN, 1, y));
  const dx = x - aspect / 2;
  const dy = y - EX_Y;
  const q = Math.hypot(dx / EX_RX, dy / EX_RY);
  if (q < 1) {
    // Outward normal of the ellipse through (dx, dy).
    const nx = dx / (EX_RX * EX_RX);
    const ny = dy / (EX_RY * EX_RY);
    const len = Math.hypot(nx, ny);
    const s = (EX_ACCEL * (1 - smoothstep(EX_INNER, 1, q))) / Math.max(len, 1e-6);
    // At the exact centre the normal is undefined: push straight up.
    fx += len > 1e-6 ? nx * s : 0;
    fy += len > 1e-6 ? ny * s : EX_ACCEL;
  }
  out[0] = fx;
  out[1] = fy;
  return out;
}

/** GLSL twin of `boundaryForce`: `vec2 boundaryForce(vec2 p, float aspect)`. */
export const BOUNDARY_GLSL = /* glsl */ `
vec2 boundaryForce(vec2 p, float aspect) {
  float fx = ${f(EDGE_ACCEL)} * (1.0 - smoothstep(0.0, ${f(EDGE_MARGIN)}, p.x)
    - smoothstep(aspect - ${f(EDGE_MARGIN)}, aspect, p.x));
  float fy = ${f(EDGE_ACCEL)} * (2.0 * (1.0 - smoothstep(${f(LOW_Y - LOW_RAMP)}, ${f(LOW_Y)}, p.y))
    - smoothstep(${f(1 - EDGE_MARGIN)}, 1.0, p.y));
  vec2 d = p - vec2(0.5 * aspect, ${f(EX_Y)});
  float q = length(d / vec2(${f(EX_RX)}, ${f(EX_RY)}));
  if (q < 1.0) {
    vec2 n = d / vec2(${f(EX_RX * EX_RX)}, ${f(EX_RY * EX_RY)});
    float len = length(n);
    float s = ${f(EX_ACCEL)} * (1.0 - smoothstep(${f(EX_INNER)}, 1.0, q));
    if (len > 1e-6) {
      fx += n.x * s / len;
      fy += n.y * s / len;
    } else {
      fy += ${f(EX_ACCEL)};
    }
  }
  return vec2(fx, fy);
}
`;

/**
 * The predator at time `t` on a frame of `aspect`, written to out[0..2] as x, y
 * and repulsion strength (0 between passes). One pass per PRED_SLOT seconds,
 * starting at a hashed 10-20 s into its slot, so passes come 20-40 s apart. Each
 * crosses the upper frame in a straight line from one side to the other over
 * PRED_DURATION seconds, its strength easing in and out.
 */
export function predatorAt(t: number, aspect: number, out: Float32Array): Float32Array {
  const k = Math.floor(t / PRED_SLOT);
  const h = hash32((k * 2654435761 + 977) >>> 0);
  const start = k * PRED_SLOT + 10 + ((h & 0xffff) / 65536) * 10;
  const s = (t - start) / PRED_DURATION;
  if (k < 0 || !(s >= 0 && s < 1)) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const h2 = hash32(h);
  const y0 = 0.55 + ((h2 & 0xff) / 255) * 0.4;
  const y1 = 0.55 + (((h2 >>> 8) & 0xff) / 255) * 0.4;
  const leftToRight = (h2 & 0x10000) === 0;
  const u = leftToRight ? s : 1 - s;
  out[0] = -0.15 + u * (aspect + 0.3);
  out[1] = y0 + (y1 - y0) * s;
  out[2] = PRED_ACCEL * Math.sin(Math.PI * s);
  return out;
}

/**
 * Writes `count` birds (BIRD_FLOATS each) to `out`: a loose ball around the
 * attractor's starting point, all heading roughly the same way at cruising speed.
 */
export function seedBirds(
  seed: number,
  count: number,
  aspect: number,
  out: Float32Array,
): Float32Array {
  const rng = createRng(seed * 7919 + 13);
  const start = attractorAt(0, aspect, new Float32Array(2));
  const heading = rng() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const r = 0.12 * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    const h = heading + (rng() - 0.5) * 1.5;
    const o = i * BIRD_FLOATS;
    out[o] = start[0] + r * Math.cos(a) * 1.6;
    out[o + 1] = start[1] + r * Math.sin(a);
    out[o + 2] = CRUISE * Math.cos(h);
    out[o + 3] = CRUISE * Math.sin(h);
  }
  return out;
}

// --- Look -------------------------------------------------------------------

type SkyId = (typeof SKY_OPTIONS)[number]["value"];

interface Sky {
  /** Gradient stops: at the horizon, a third of the way up, and at the top. */
  low: string;
  mid: string;
  top: string;
  /** The birds' colour. */
  bird: string;
  /** The horizon silhouette's colour. */
  land: string;
}

export const SKIES = {
  dusk: { low: "#f2b38c", mid: "#d79c98", top: "#6c7c9f", bird: "#1a1720", land: "#2a2230" },
  overcast: { low: "#cfcdc8", mid: "#b2b3b4", top: "#868d98", bird: "#202228", land: "#383b40" },
  wintergold: { low: "#f4c77a", mid: "#d6a46c", top: "#7a8aa0", bird: "#21190f", land: "#2b2218" },
} as const satisfies Record<SkyId, Sky>;

/** The sky for a select value; unknown values fall back to dusk. */
export function skyFor(id: string): Sky {
  return lookup(SKIES, id, "dusk");
}

/** Columns in the horizon silhouette table. */
export const HORIZON_COLUMNS = 1024;
/** Tallest silhouette point, heights. */
export const HORIZON_MAX = 0.24;

/**
 * Fills `out` (HORIZON_COLUMNS heights, in frame heights, column c at
 * x = (c + 0.5) / HORIZON_COLUMNS of the width) with the silhouette for `kind`
 * on a frame of `aspect`: a low bank with reed stalks, or a line of rounded tree
 * crowns, or nothing. Deterministic. Unknown kinds count as none.
 */
export function buildHorizon(kind: string, aspect: number, out: Float32Array): Float32Array {
  out.fill(0);
  if (kind !== "reeds" && kind !== "trees") {
    return out;
  }
  const rng = createRng(kind === "reeds" ? 4211 : 5323);
  const n = out.length;
  /** Width of one column, heights. */
  const colW = aspect / n;
  // A gently rolling bank under either.
  const p1 = rng() * 6.283;
  const p2 = rng() * 6.283;
  for (let c = 0; c < n; c++) {
    const x = (c + 0.5) / n;
    out[c] = 0.03 + 0.008 * Math.sin(x * 7.1 + p1) + 0.006 * Math.sin(x * 17.3 + p2);
  }
  if (kind === "reeds") {
    // Stalks in loose beds: a slow envelope sets how tall they grow along the bank.
    const stalks = Math.round(360 * aspect);
    const p3 = rng() * 6.283;
    for (let i = 0; i < stalks; i++) {
      const x = rng() * aspect;
      const bed = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(x * 5.3 + p3));
      const h = (0.035 + 0.085 * rng() ** 1.5) * bed;
      const halfW = 0.0025 + 0.002 * rng();
      raise(out, colW, x, halfW, h);
    }
  } else {
    // Crowns of varied size, the treeline rising towards the sides.
    let x = rng() * 0.05;
    while (x < aspect + 0.1) {
      const side = Math.min(1, Math.abs(x / aspect - 0.5) * 2);
      const r = (0.03 + 0.06 * rng()) * (0.7 + 0.3 * side);
      const trunk = (0.02 + 0.08 * rng()) * (0.5 + 0.5 * side);
      dome(out, colW, x, r, trunk + r * 0.8);
      x += r * (0.8 + 0.9 * rng());
    }
  }
  for (let c = 0; c < n; c++) {
    out[c] = Math.min(out[c], HORIZON_MAX);
  }
  return out;
}

/** Raises `out` to a tapering stalk of height `h` and base half-width `halfW` at x (heights). */
function raise(out: Float32Array, colW: number, x: number, halfW: number, h: number) {
  const c0 = Math.max(0, Math.floor((x - halfW) / colW));
  const c1 = Math.min(out.length - 1, Math.ceil((x + halfW) / colW));
  for (let c = c0; c <= c1; c++) {
    const d = Math.abs((c + 0.5) * colW - x) / halfW;
    if (d < 1) {
      out[c] = Math.max(out[c], h * (1 - d));
    }
  }
}

/** Raises `out` to a round crown of radius r whose top is at height `top`. */
function dome(out: Float32Array, colW: number, x: number, r: number, top: number) {
  const c0 = Math.max(0, Math.floor((x - r) / colW));
  const c1 = Math.min(out.length - 1, Math.ceil((x + r) / colW));
  for (let c = c0; c <= c1; c++) {
    const d = ((c + 0.5) * colW - x) / r;
    if (Math.abs(d) < 1) {
      out[c] = Math.max(out[c], top - r + r * Math.sqrt(1 - d * d));
    }
  }
}
