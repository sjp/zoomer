/**
 * Aquarium's simulation, kept free of GL so it can be tested: the gravel line,
 * the seeded hardscape (rocks, driftwood, air stone) and plant layout, the plant
 * swell (from the shared `sway.ts`), the light presets, the air-stone bubble mode
 * for `bubbles-sim.ts`, and the schooling fish.
 *
 * Fish positions are in height units (1 = the frame height, y down from the top,
 * x from 0 to the aspect ratio). Plant and hardscape x are fractions of the width.
 */
import type { BubbleMode } from "./bubbles-sim";
import { hexToUnitRgb, type Rgb } from "./color";
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { glslFloat } from "./gl";
import { clamp } from "./math";
import { createRng } from "./noise";
import { createSwell, type Swell } from "./sway";
import type { LightId, SpeciesId } from "./aquarium.meta";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Tank geometry

/** Mean top of the gravel bed, as a fraction of the height from the top. */
export const GRAVEL_Y = 0.8;
/** How much higher the bed rises towards the side walls (aquascapes slope up at the back corners). */
const GRAVEL_RISE = 0.035;
/** A gentle undulation along the bed. */
const GRAVEL_WAVE = 0.008;

/**
 * Top of the gravel at `u` (fraction of the width), as a fraction of the height
 * from the top: lowest in the middle, rising towards both sides.
 */
export function gravelTop(u: number): number {
  const s = 2 * u - 1;
  return GRAVEL_Y - GRAVEL_RISE * s * s + GRAVEL_WAVE * Math.sin(TAU * (u * 2.3 + 0.2));
}

/** GLSL twin of `gravelTop`: `float gravelTop(float u)`. */
export const GRAVEL_GLSL = /* glsl */ `
float gravelTop(float u) {
  float s = 2.0 * u - 1.0;
  return ${glslFloat(GRAVEL_Y)} - ${glslFloat(GRAVEL_RISE)} * s * s
    + ${glslFloat(GRAVEL_WAVE)} * sin(${glslFloat(TAU)} * (u * 2.3 + 0.2));
}
`;

// ---------------------------------------------------------------------------
// Hardscape

/** The air stone's x (fraction of the width), in the left front corner. */
export const AIRSTONE_X = 0.055;
/** Air stone half width and half height, px at 1080p. */
export const AIRSTONE_RX = 20;
export const AIRSTONE_RY = 8;
/** Air stone centre y, as a fraction of the height: sitting on the gravel. */
export const airstoneY = (): number => gravelTop(AIRSTONE_X) + 0.004;

export const MAX_ROCKS = 4;
export const MAX_WOOD = 2;

/**
 * The seeded hardscape. Rocks are `[cx, cy, rx, ry]` and driftwood `[ax, ay, bx,
 * by]` with x as fractions of the width, y as fractions of the height and radii
 * in px at 1080p; `woodRadius` holds each branch's radius at its two ends.
 */
export interface Hardscape {
  readonly rocks: Float32Array;
  readonly wood: Float32Array;
  readonly woodRadius: Float32Array;
}

/**
 * Rocks and driftwood on the gravel, kept to the outer thirds so the centre
 * behind the speaker stays plain.
 */
export function buildHardscape(seed: number): Hardscape {
  const rng = createRng((seed * 7919 + 0xa9a1) >>> 0);
  const rocks = new Float32Array(MAX_ROCKS * 4);
  for (let i = 0; i < MAX_ROCKS; i++) {
    // Alternate sides; the left side leaves room for the air stone.
    const left = i % 2 === 0;
    const u = left ? 0.1 + 0.18 * rng() : 0.7 + 0.22 * rng();
    const rx = 38 + 55 * rng();
    rocks[i * 4] = u;
    rocks[i * 4 + 1] = gravelTop(u) + 0.01 + 0.02 * rng();
    rocks[i * 4 + 2] = rx;
    rocks[i * 4 + 3] = rx * (0.55 + 0.25 * rng());
  }
  const wood = new Float32Array(MAX_WOOD * 4);
  const woodRadius = new Float32Array(MAX_WOOD * 2);
  for (let i = 0; i < MAX_WOOD; i++) {
    // One branch leaning up from each side's gravel.
    const left = i === 0;
    const u0 = left ? 0.12 + 0.06 * rng() : 0.82 + 0.06 * rng();
    const lean = (left ? 1 : -1) * (0.04 + 0.06 * rng());
    wood[i * 4] = u0;
    wood[i * 4 + 1] = gravelTop(u0) + 0.015;
    wood[i * 4 + 2] = u0 + lean;
    wood[i * 4 + 3] = gravelTop(u0) - 0.16 - 0.12 * rng();
    woodRadius[i * 2] = 13 + 6 * rng();
    woodRadius[i * 2 + 1] = 5 + 3 * rng();
  }
  return { rocks, wood, woodRadius };
}

// ---------------------------------------------------------------------------
// Plants

/**
 * The tank's water movement from the filter: an 8 s main period, a 10 s partner
 * and a faint 4.4 s ripple, repeating every 40 s at speed 1.
 */
export const AQUARIUM_SWELL: Swell = createSwell(40, [
  { cycles: 5, amplitude: 1, offset: 0 },
  { cycles: 4, amplitude: 0.55, offset: 0.29 },
  { cycles: 9, amplitude: 0.2, offset: 0.63 },
]);

/** Largest tip sway, as a fraction of the plant's height. */
export const PLANT_SWAY = 0.09;
/** Seconds the tip of a plant as tall as the frame trails its base. */
export const LAG_PER_HEIGHT = 2;
/** Seconds the current takes to cross the frame, so neighbours don't move in lockstep. */
export const SWELL_TRAVEL = 2.5;

/** Segments per plant strip, and the strip: (level, side) per vertex. */
export const PLANT_SEGMENTS = 16;
export const PLANT_STRIP: readonly number[] = (() => {
  const out: number[] = [];
  for (let i = 0; i <= PLANT_SEGMENTS; i++) out.push(i, -1, i, 1);
  return out;
})();

/**
 * Floats per plant: (x, base y, height, half width) then (swell phase, lag, lean,
 * kind + 0.9 tone). x is a fraction of the width, base y and height fractions of
 * the frame height, the half width px at 1080p, the lag in seconds; kind 0 is a
 * ribbon (vallisneria-like) and 1 a bushy stem plant.
 */
export const PLANT_FLOATS = 8;

export const PLANT_RIBBON = 0;
export const PLANT_BUSHY = 1;

/** Plants at density 1 behind the fish, and in front of them. */
export const BACK_PLANTS = 34;
export const FRONT_PLANTS = 6;
export const MAX_PLANTS = BACK_PLANTS + FRONT_PLANTS;

export interface PlantLayout {
  readonly backCount: number;
  /** Front plants follow the back ones in the instance data. */
  readonly frontCount: number;
}

/**
 * Relative plant density at `u` (fraction of the width): full in the outer
 * fifths, easing down to a few percent across the centre third.
 */
export function plantWeight(u: number): number {
  const d = Math.abs(u - 0.5);
  return 0.04 + 0.96 * clamp((d - 0.17) / 0.15, 0, 1);
}

/** Draws a plant x from `plantWeight` by rejection. */
function sampleX(rng: () => number, lo = 0.01, hi = 0.99): number {
  for (let k = 0; k < 32; k++) {
    const u = lo + (hi - lo) * rng();
    if (rng() < plantWeight(u)) return u;
  }
  return rng() < 0.5 ? lo : hi;
}

function writePlant(
  out: Float32Array,
  i: number,
  u: number,
  baseY: number,
  height: number,
  halfWidth: number,
  kind: number,
  rng: () => number,
): void {
  const o = i * PLANT_FLOATS;
  out[o] = u;
  out[o + 1] = baseY;
  out[o + 2] = height;
  out[o + 3] = halfWidth;
  out[o + 4] = (u * SWELL_TRAVEL) / AQUARIUM_SWELL.period + 0.03 * rng();
  out[o + 5] = LAG_PER_HEIGHT * height * (0.8 + 0.4 * rng());
  out[o + 6] = (rng() - 0.5) * 0.08 + (u < 0.5 ? 0.02 : -0.02);
  out[o + 7] = kind + 0.9 * rng();
}

/**
 * Writes the plant instances for `density` (0..1) into `out`: back plants first
 * (ribbons in clumps, bushes in front of them), then a few large front plants at
 * the very edges. The same seed always gives the same tank; a lower density keeps
 * a prefix of the same plants.
 */
export function buildPlants(seed: number, density: number, out: Float32Array): PlantLayout {
  const d = clamp(Number.isFinite(density) ? density : 0, 0, 1);
  const rng = createRng((seed * 104729 + 0x9a47) >>> 0);
  const backCount = Math.round(BACK_PLANTS * d);
  const frontCount = Math.round(FRONT_PLANTS * d);
  let clumpX = 0.1;
  for (let i = 0; i < BACK_PLANTS; i++) {
    // Every plant draws the same numbers whether or not it is kept.
    if (i % 4 === 0) clumpX = sampleX(rng, 0.02, 0.98);
    const bushy = i % 4 === 3 || rng() < 0.2;
    const u = clamp(clumpX + (rng() - 0.5) * (bushy ? 0.06 : 0.035), 0.005, 0.995);
    const h = bushy ? 0.16 + 0.2 * rng() : 0.32 + 0.38 * rng();
    const w = bushy ? 24 + 14 * rng() : 5 + 3.5 * rng();
    const base = gravelTop(u) + 0.01 + 0.02 * rng();
    if (i < backCount) writePlant(out, i, u, base, h, w, bushy ? PLANT_BUSHY : PLANT_RIBBON, rng);
    else for (let k = 0; k < 4; k++) rng();
  }
  for (let j = 0; j < FRONT_PLANTS; j++) {
    const left = j % 2 === 0;
    const u = left ? 0.01 + 0.09 * rng() : 0.9 + 0.09 * rng();
    const bushy = j >= 4 || rng() < 0.35;
    const h = bushy ? 0.3 + 0.15 * rng() : 0.55 + 0.3 * rng();
    const w = bushy ? 44 + 16 * rng() : 9 + 4 * rng();
    if (j < frontCount) {
      writePlant(out, backCount + j, u, 1.03, h, w, bushy ? PLANT_BUSHY : PLANT_RIBBON, rng);
    } else for (let k = 0; k < 4; k++) rng();
  }
  return { backCount, frontCount };
}

// ---------------------------------------------------------------------------
// Light presets

export interface AquariumLight {
  /** Water at the top and at the gravel; the back wall's tint. */
  readonly top: Rgb;
  readonly deep: Rgb;
  readonly wall: Rgb;
  /** Gravel light and dark, rock, driftwood and air-stone colours. */
  readonly gravelA: Rgb;
  readonly gravelB: Rgb;
  readonly rock: Rgb;
  readonly wood: Rgb;
  /** Caustic and ray light. */
  readonly light: Rgb;
  readonly caustics: number;
  readonly rays: number;
  /** Plant colours, dark and light. */
  readonly plantDark: Rgb;
  readonly plantLight: Rgb;
  /** Light on the fish, and the neon stripe's own glow. */
  readonly fishLight: number;
  readonly stripeGlow: number;
  /** Bubble highlight colour. */
  readonly bubble: Rgb;
}

const rgb = (hex: string): Rgb => hexToUnitRgb(hex);

export const LIGHTS: Readonly<Record<LightId, AquariumLight>> = {
  daylight: {
    top: rgb("#3d9c8c"),
    deep: rgb("#0c3b36"),
    wall: rgb("#235f55"),
    gravelA: rgb("#9a8a6e"),
    gravelB: rgb("#4f4334"),
    rock: rgb("#6f6d66"),
    wood: rgb("#4d3524"),
    light: rgb("#fff3d2"),
    caustics: 1,
    rays: 1,
    plantDark: rgb("#18491d"),
    plantLight: rgb("#78c247"),
    fishLight: 1,
    stripeGlow: 0.15,
    bubble: rgb("#effffb"),
  },
  night: {
    top: rgb("#173a62"),
    deep: rgb("#030a1a"),
    wall: rgb("#0d2445"),
    gravelA: rgb("#3c4a63"),
    gravelB: rgb("#151b2a"),
    rock: rgb("#323a4c"),
    wood: rgb("#1c1a24"),
    light: rgb("#9cbcff"),
    caustics: 0.45,
    rays: 0.35,
    plantDark: rgb("#0a2230"),
    plantLight: rgb("#2f6f74"),
    fishLight: 0.45,
    stripeGlow: 0.6,
    bubble: rgb("#c8dcff"),
  },
  warm: {
    top: rgb("#7d8d4c"),
    deep: rgb("#1f2510"),
    wall: rgb("#4a5126"),
    gravelA: rgb("#b0895c"),
    gravelB: rgb("#55391f"),
    rock: rgb("#7a6650"),
    wood: rgb("#55331a"),
    light: rgb("#ffd596"),
    caustics: 0.9,
    rays: 0.8,
    plantDark: rgb("#2b4314"),
    plantLight: rgb("#a8b844"),
    fishLight: 0.95,
    stripeGlow: 0.15,
    bubble: rgb("#fff1d8"),
  },
};

// ---------------------------------------------------------------------------
// Air-stone bubbles

/** Bubbles in the air-stone column and their size param (radius scale, px at 1080p). */
export const AIRSTONE_BUBBLES = 46;
export const AIRSTONE_SIZE = 4;

/** A `bubbles-sim.ts` mode with one in-frame emitter at the air stone. */
export const AIRSTONE_MODE: BubbleMode = {
  top: "#3d9c8c",
  bottom: "#0c3b36",
  light: "#effffb",
  density: 1,
  sizeMul: 1,
  sizeLo: 0.55,
  sizeHi: 1.9,
  pace: 1,
  shafts: 0,
  streamShare: 1,
  emitters: [AIRSTONE_X],
  emitY: airstoneY() - AIRSTONE_RY / 1080,
  emitJitter: 10,
};

// ---------------------------------------------------------------------------
// Fish

/** Fish swim inside these bounds (height units; x from the side walls). */
export const TANK_X = 0.05;
export const TANK_TOP = 0.08;
export const TANK_BOTTOM = GRAVEL_Y - 0.1;
/** Width of the soft zone inside the bounds where the walls push back. */
export const WALL_ZONE = 0.1;
/** Half width of the soft central band, as a fraction of the width. */
export const BAND_HALF = 0.14;

/** Cruising speed range, the top speed of a dart and the slowest a fish ever swims (heights/s). */
export const CRUISE_MAX = 0.09;
export const DART_MAX = 0.3;
export const SPEED_MIN = 0.025;
/** Speed at which a school heads for a new goal (heights/s). */
export const GOAL_SPEED = 0.085;
/** Largest steering acceleration (heights/s^2), darts included. */
export const FORCE_MAX = 0.6;
/** Vertical speed at most this share of the speed: fish swim mostly level. */
export const VERTICAL_SHARE = 0.45;
/** Darts start this often per fish per second, and last this long (s). */
export const DART_RATE = 1 / 45;
export const DART_TIME = 0.45;
/** Seconds a fish takes to turn round (flip through edge-on). */
export const TURN_TIME = 0.3;
/** A fish turns round once it swims backwards faster than this (heights/s). */
export const TURN_HYSTERESIS = 0.012;
/** Separation radius, heights. */
export const SEPARATION_R = 0.045;
/** Fish length at depth 1 (nearest), heights. */
export const FISH_LENGTH = 0.036;
/** Seconds between new goals for a school. */
export const GOAL_MIN = 25;
export const GOAL_MAX = 55;
/** Seconds a newly added fish takes to fade in. */
export const FISH_FADE_IN = 1.5;
/** Simulation steps never exceed this (s), so a long frame can't tunnel through a wall. */
const MAX_STEP = 1 / 20;

/** Floats per fish instance: (x, y, length, turn scale), (tail phase, fog, species, alpha). */
export const FISH_FLOATS = 8;

export const SPECIES_NEON = 0;
export const SPECIES_SILVER = 1;

/** Schools for `count` fish: one small group, or two or three larger ones. */
export function schoolCount(count: number): number {
  return count < 12 ? 1 : count < 26 ? 2 : 3;
}

/** Fish `i`'s species for the species param, given its school and the school count. */
export function speciesOf(species: SpeciesId, i: number, school: number, schools: number): number {
  if (species === "neon") return SPECIES_NEON;
  if (species === "silver") return SPECIES_SILVER;
  return schools > 1 ? school % 2 : i % 2;
}

/** The on-screen width factor of a fish turned by `theta` (0 facing right, pi facing left). */
export const turnScale = (theta: number): number => Math.cos(theta);

export interface FishEnv {
  aspect: number;
  count: number;
  species: SpeciesId;
  /** Simulation speed (1 = real time). */
  speed: number;
}

export interface FishSim {
  readonly max: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Depth 0 (far) .. 1 (near). */
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Steering force of the last step, before integration (heights/s^2). */
  readonly fx: Float32Array;
  readonly fy: Float32Array;
  /** Turn angle, 0 (facing right) .. pi (facing left). */
  readonly turn: Float32Array;
  /** +1 facing right, -1 facing left: where `turn` is heading. */
  readonly facing: Int8Array;
  readonly tail: Float32Array;
  readonly life: Float32Array;
  /** Fish simulated: the count plus any still fading out. */
  live: number;
  /** Draw order of the last `fishInstances`: far fish, then near ones. */
  readonly order: Uint8Array;
  /** Of the instances written last, how many are far (drawn behind the bubbles). */
  farCount: number;
  // Internal state.
  readonly wander: Float32Array;
  readonly dart: Float32Array;
  readonly size: Float32Array;
  readonly zv: Float32Array;
  readonly goals: Float32Array;
  readonly goalTimer: Float32Array;
  readonly rng: () => number;
}

const SCHOOLS_MAX = 3;

/** Picks a new goal for school `s`: a point in one of the outer zones, usually the other side. */
function pickGoal(sim: FishSim, s: number): void {
  const prev = sim.goals[s * 2];
  const r = sim.rng;
  const wasLeft = prev < 0.5;
  const left = r() < 0.5 ? !wasLeft : wasLeft;
  // Fractions of the width and height, so a resize keeps the goal in place.
  sim.goals[s * 2] = left ? 0.08 + 0.22 * r() : 0.7 + 0.22 * r();
  sim.goals[s * 2 + 1] = TANK_TOP + 0.08 + (TANK_BOTTOM - TANK_TOP - 0.16) * r();
  sim.goalTimer[s] = GOAL_MIN + (GOAL_MAX - GOAL_MIN) * r();
}

export function createFishSim(seed: number, max: number, aspect = 16 / 9): FishSim {
  const rng = createRng((seed * 2654435761 + 0xf15) >>> 0);
  const sim: FishSim = {
    max,
    x: new Float32Array(max),
    y: new Float32Array(max),
    z: new Float32Array(max),
    vx: new Float32Array(max),
    vy: new Float32Array(max),
    fx: new Float32Array(max),
    fy: new Float32Array(max),
    turn: new Float32Array(max),
    facing: new Int8Array(max),
    tail: new Float32Array(max),
    life: new Float32Array(max),
    live: 0,
    order: new Uint8Array(max),
    farCount: 0,
    wander: new Float32Array(max),
    dart: new Float32Array(max),
    size: new Float32Array(max),
    zv: new Float32Array(max),
    goals: new Float32Array(SCHOOLS_MAX * 2),
    goalTimer: new Float32Array(SCHOOLS_MAX),
    rng,
  };
  for (let s = 0; s < SCHOOLS_MAX; s++) {
    sim.goals[s * 2] = s % 2 === 0 ? 0.8 : 0.2;
    pickGoal(sim, s);
    // Stagger the first changes.
    sim.goalTimer[s] *= 0.3 + 0.2 * s;
  }
  for (let i = 0; i < max; i++) {
    // Start each school around its goal, already swimming.
    const s = i % SCHOOLS_MAX;
    sim.x[i] = clamp(
      sim.goals[s * 2] * aspect + (rng() - 0.5) * 0.3,
      TANK_X,
      Math.max(TANK_X, aspect - TANK_X),
    );
    sim.y[i] = clamp(sim.goals[s * 2 + 1] + (rng() - 0.5) * 0.15, TANK_TOP, TANK_BOTTOM);
    sim.z[i] = rng();
    const dir = rng() < 0.5 ? -1 : 1;
    sim.vx[i] = dir * (0.04 + 0.03 * rng());
    sim.vy[i] = (rng() - 0.5) * 0.01;
    sim.facing[i] = dir;
    sim.turn[i] = dir > 0 ? 0 : Math.PI;
    sim.tail[i] = rng() * TAU;
    sim.wander[i] = rng() * TAU;
    sim.size[i] = 0.85 + 0.3 * rng();
    sim.order[i] = i;
  }
  return sim;
}

// Per-step scratch, shared by every sim (steps never interleave).
const cx = new Float64Array(SCHOOLS_MAX);
const cy = new Float64Array(SCHOOLS_MAX);
const cz = new Float64Array(SCHOOLS_MAX);
const avx = new Float64Array(SCHOOLS_MAX);
const avy = new Float64Array(SCHOOLS_MAX);
const members = new Float64Array(SCHOOLS_MAX);

/**
 * Advances the fish by `dt` seconds of wall time (scaled by `env.speed`), in
 * substeps of at most 1/20 s. Each fish steers toward its school's centre and
 * goal, aligns with its school, keeps clear of every fish, wanders, and is pushed
 * back softly by the glass and the central band, with an occasional dart. The
 * force is capped at FORCE_MAX, the speed kept in [SPEED_MIN, DART_MAX], and the
 * position clamped inside the tank. Fades run on wall time.
 */
export function stepFishSim(sim: FishSim, dt: number, env: FishEnv): void {
  const wall = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const target = clamp(Math.round(env.count), 1, sim.max);
  sim.live = growLive(sim.life, sim.live, target);
  const inStep = wall / FISH_FADE_IN;
  const outStep = wall / FADE_OUT;
  for (let i = 0; i < sim.live; i++) stepLife(sim.life, i, target, inStep, outStep);

  let left = wall * Math.max(0, env.speed);
  while (left > 1e-6) {
    const h = Math.min(MAX_STEP, left);
    left -= h;
    substep(sim, h, env, target);
  }
  sim.live = trimLive(sim.life, sim.live, target);
}

function substep(sim: FishSim, dt: number, env: FishEnv, target: number): void {
  const { x, y, z, vx, vy, fx, fy, rng } = sim;
  const n = sim.live;
  const aspect = Math.max(2 * TANK_X + 0.01, env.aspect);
  const xMax = aspect - TANK_X;
  const schools = schoolCount(target);

  for (let s = 0; s < schools; s++) {
    sim.goalTimer[s] -= dt;
    if (sim.goalTimer[s] <= 0) pickGoal(sim, s);
  }

  cx.fill(0);
  cy.fill(0);
  cz.fill(0);
  avx.fill(0);
  avy.fill(0);
  members.fill(0);
  for (let i = 0; i < n; i++) {
    const s = i % schools;
    cx[s] += x[i];
    cy[s] += y[i];
    cz[s] += z[i];
    avx[s] += vx[i];
    avy[s] += vy[i];
    members[s]++;
  }
  for (let s = 0; s < schools; s++) {
    const m = Math.max(1, members[s]);
    cx[s] /= m;
    cy[s] /= m;
    cz[s] /= m;
    avx[s] /= m;
    avy[s] /= m;
  }

  const bandC = aspect * 0.5;
  const bandHalf = aspect * BAND_HALF;
  const r2 = SEPARATION_R * SEPARATION_R;
  for (let i = 0; i < n; i++) {
    const s = i % schools;
    let ax = 0;
    let ay = 0;
    // Goal: steer toward a velocity that heads for it and slows on arrival, so a
    // school cruises across, then mills about its goal.
    const gx = sim.goals[s * 2] * aspect - x[i];
    const gy = sim.goals[s * 2 + 1] - y[i];
    const gl = Math.hypot(gx, gy);
    const want = gl > 1e-6 ? Math.min(GOAL_SPEED, gl * 0.35) / gl : 0;
    ax += 0.5 * (gx * want - vx[i]);
    ay += 0.5 * (gy * want - vy[i]);
    // Cohesion and alignment within the school.
    ax += 0.3 * (cx[s] - x[i]) + 0.6 * (avx[s] - vx[i]);
    ay += 0.3 * (cy[s] - y[i]) + 0.6 * (avy[s] - vy[i]);
    // Separation from every fish nearby.
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2 || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const k = (0.5 * (1 - d / SEPARATION_R)) / d;
      ax += dx * k;
      ay += dy * k * 1.5;
    }
    // Wander: a slowly turning preferred heading, mostly level.
    sim.wander[i] += (rng() - 0.5) * 3 * dt;
    ax += 0.03 * Math.cos(sim.wander[i]);
    ay += 0.012 * Math.sin(sim.wander[i]);
    // Glass and gravel: soft walls inside the bounds.
    ax += 0.5 * clamp((TANK_X + WALL_ZONE - x[i]) / WALL_ZONE, 0, 1);
    ax -= 0.5 * clamp((x[i] - (xMax - WALL_ZONE)) / WALL_ZONE, 0, 1);
    ay += 0.4 * clamp((TANK_TOP + WALL_ZONE - y[i]) / WALL_ZONE, 0, 1);
    ay -= 0.4 * clamp((y[i] - (TANK_BOTTOM - WALL_ZONE)) / WALL_ZONE, 0, 1);
    // The central band in front of the speaker: a weak push outwards, so fish still cross.
    const bd = x[i] - bandC;
    if (Math.abs(bd) < bandHalf) ax += 0.03 * Math.sign(bd || 1) * (1 - Math.abs(bd) / bandHalf);
    // Darts: a short burst along the current heading.
    if (sim.dart[i] > 0) {
      sim.dart[i] = Math.max(0, sim.dart[i] - dt);
      ax += 0.5 * sim.facing[i];
    } else if (rng() < DART_RATE * dt) {
      sim.dart[i] = DART_TIME;
    }

    const al = Math.hypot(ax, ay);
    if (al > FORCE_MAX) {
      ax *= FORCE_MAX / al;
      ay *= FORCE_MAX / al;
    }
    fx[i] = ax;
    fy[i] = ay;
  }

  for (let i = 0; i < n; i++) {
    let ux = vx[i] + fx[i] * dt;
    let uy = vy[i] + fy[i] * dt;
    let sp = Math.hypot(ux, uy);
    const vmax = Math.min(DART_MAX, Math.max(CRUISE_MAX, sp * Math.exp(-2.5 * dt)));
    // Mostly level swimming.
    uy = clamp(uy, -VERTICAL_SHARE * sp, VERTICAL_SHARE * sp);
    sp = Math.hypot(ux, uy);
    if (sp < SPEED_MIN) {
      // Too slow to keep its heading: a fish braking against the force swings round
      // to follow it, rather than the speed floor pushing it on the way it was going.
      ux += fx[i] * 0.4;
      uy += fy[i] * 0.4;
      uy = clamp(uy, -VERTICAL_SHARE * Math.abs(ux), VERTICAL_SHARE * Math.abs(ux));
      sp = Math.hypot(ux, uy);
    }
    const want = clamp(sp, SPEED_MIN, sim.dart[i] > 0 ? DART_MAX : vmax);
    if (sp > 1e-9) {
      ux *= want / sp;
      uy *= want / sp;
    } else {
      ux = sim.facing[i] * want;
      uy = 0;
    }
    let px = x[i] + ux * dt;
    let py = y[i] + uy * dt;
    if (px < TANK_X || px > xMax) {
      // Off the glass: turn back along x, keeping the speed.
      px = clamp(px, TANK_X, xMax);
      ux = Math.abs(ux) * (px <= TANK_X ? 1 : -1);
    }
    if (py < TANK_TOP || py > TANK_BOTTOM) {
      // Level out along the surface or the gravel, keeping the speed.
      py = clamp(py, TANK_TOP, TANK_BOTTOM);
      ux = (ux < 0 ? -1 : 1) * Math.hypot(ux, uy);
      uy = 0;
    }
    x[i] = px;
    y[i] = py;
    vx[i] = ux;
    vy[i] = uy;

    // Depth: a slow random walk, drawn toward the school's depth.
    const s = i % schools;
    sim.zv[i] = clamp(sim.zv[i] + (rng() - 0.5) * 0.3 * dt, -0.05, 0.05);
    let zz = z[i] + (sim.zv[i] + 0.15 * (cz[s] - z[i])) * dt;
    if (zz < 0 || zz > 1) {
      zz = clamp(zz, 0, 1);
      sim.zv[i] = -sim.zv[i];
    }
    z[i] = zz;

    // Turning round: flip through edge-on at a fixed rate.
    if (ux * sim.facing[i] < -TURN_HYSTERESIS) sim.facing[i] = sim.facing[i] > 0 ? -1 : 1;
    const goal = sim.facing[i] > 0 ? 0 : Math.PI;
    const step = (Math.PI / TURN_TIME) * dt;
    const t0 = sim.turn[i];
    sim.turn[i] = goal > t0 ? Math.min(goal, t0 + step) : Math.max(goal, t0 - step);

    // Tail beat: faster when swimming fast.
    const rate = 1.5 + 15 * want;
    sim.tail[i] = (sim.tail[i] + TAU * rate * dt) % TAU;
  }
}

/** Fog of a fish against the water at depth `z`: far fish fade into the haze. */
export const fishFog = (z: number): number => 0.6 * (1 - z) * (1 - z);
/** Length of fish `i` in heights, given its species. */
export const fishLength = (size: number, z: number, species: number): number =>
  FISH_LENGTH * size * (0.55 + 0.45 * z) * (species === SPECIES_SILVER ? 1.25 : 1);

/** Sort key: live fish by depth, then the rest by index. */
const depthKey = (i: number, n: number, z: Float32Array): number => (i < n ? z[i] : 2 + i);

/**
 * Writes the live fish to `out` (FISH_FLOATS each, `stride` apart) sorted far to
 * near, and sets `sim.farCount` to how many have depth below 0.5. Returns the
 * number written. Allocates nothing.
 */
export function fishInstances(
  sim: FishSim,
  env: FishEnv,
  out: Float32Array,
  stride = FISH_FLOATS,
): number {
  const n = sim.live;
  const { order, z } = sim;
  // Insertion sort of the whole permutation, live fish by depth and the rest after
  // them; the order barely changes between frames, so this is nearly linear.
  for (let i = 1; i < sim.max; i++) {
    const v = order[i];
    const kv = depthKey(v, n, z);
    let j = i - 1;
    while (j >= 0 && depthKey(order[j], n, z) > kv) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = v;
  }

  const target = clamp(Math.round(env.count), 1, sim.max);
  const schools = schoolCount(target);
  let far = 0;
  let written = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const l = sim.life[i];
    if (l <= 0) continue;
    const sp = speciesOf(env.species, i, i % schools, schools);
    const o = written * stride;
    out[o] = sim.x[i];
    out[o + 1] = sim.y[i];
    out[o + 2] = fishLength(sim.size[i], z[i], sp);
    out[o + 3] = turnScale(sim.turn[i]);
    out[o + 4] = sim.tail[i];
    out[o + 5] = fishFog(z[i]);
    out[o + 6] = sp;
    out[o + 7] = l * l * (3 - 2 * l);
    if (z[i] < 0.5) far++;
    written++;
  }
  sim.farCount = far;
  return written;
}
