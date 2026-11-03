/**
 * Pure JS side of the slime mould effect (physarum.ts): the tuned constants,
 * agent tiers, palettes and their lookup table, the drifting food sources, the
 * calm-centre mask, agent seeding, the fixed-step clock, and a CPU twin of one
 * simulation step that documents the shaders' maths.
 *
 * The model is Jones' (2010) Physarum agent model. Each agent has a position and
 * a heading, senses the trail at three points ahead of it (forward, left, right),
 * turns towards the strongest, moves one step and deposits trail where it lands.
 * Each step the trail map is blurred (3x3, 1-2-1) and multiplied by `1 - decay`.
 *
 * Positions are in uv (0..1 across the trail grid, origin bottom-left) and wrap
 * at the edges; headings are radians in [0, 2pi). Lengths below are in trail
 * cells, one cell being BASE_CELL * scale reference (1080p) pixels.
 *
 * Tuning for a calm, codec-friendly look (thick, soft, slow veins), checked by
 * rendering this file's CPU twin to images on a 512x288 grid:
 * - Cells are 3.75 reference pixels by default (a 512x288 grid at 16:9 whatever
 *   the output resolution), so a vein two to three cells wide after the blur is
 *   8-11 px at 1080p, before the composite's glow, and the full-resolution
 *   composite upsamples it smoothly.
 * - A long sensor reach (SENSOR_DISTANCE = 12 cells, 45 px at 1080p) spaces the
 *   veins widely: the network's mesh is a few sensor distances across, about
 *   100-300 px. A 45 degree sensor angle with a smaller turn (0.4 rad) gives a
 *   reticulated network with rounded loops and bright junctions; a narrower
 *   sensor angle, or a turn as large as the sensor angle, collapses into a few
 *   long strands, and a turn larger than the sensor angle into dendrites.
 * - The 1-2-1 blur every step is strong diffusion, which widens and softens the
 *   veins and suppresses the fine filaments the model makes at low diffusion.
 * - A fairly fast decay (15% per step) keeps the network meshed: below about 10%
 *   per step it coarsens over a minute or two into a few thick tubes.
 * - Agents move half a cell per step at 30 steps per second (about 56 px/s at
 *   1080p), turning by at most TURN_ANGLE per step, so the network re-routes
 *   over tens of seconds rather than flickering.
 * - The calm centre both repels agents (subtracted from what they sense) and
 *   decays the trail faster, which leaves only a faint, sparse mesh there.
 */
import { clamp, fract, smoothstep } from "./math";
import { hexToRgb } from "./color";
import { createRng, hash32 } from "./noise";
import type { AGENT_OPTIONS, PALETTE_OPTIONS } from "./physarum.meta";

export { type StepClock, takeSteps } from "./reaction-sim";

/** Simulation steps per second, below the display rate to save power. */
export const STEP_RATE = 30;
/** Most simulation steps in one frame; owed steps beyond this are dropped. */
export const MAX_STEPS = 2;

/** Reference (1080p) pixels per trail cell at scale 1. */
export const BASE_CELL = 3;
/** Largest trail grid side. */
export const MAX_GRID = 1024;

/** Sensor reach, in cells. */
export const SENSOR_DISTANCE = 12;
/** Angle between the forward sensor and each side sensor, radians. */
export const SENSOR_ANGLE = Math.PI / 4;
/** Turn per step towards a stronger side sensor, radians. */
export const TURN_ANGLE = 0.4;
/** Random heading jitter per step, radians peak to peak, so no agent locks into a loop. */
export const JITTER = 0.1;
/**
 * Mean trail level the deposit is normalised to: each agent deposits
 * MEAN_TRAIL * decay * cells / agents, so the mean trail stays near this at every
 * agent tier and decay rate (the blur conserves mass). Veins gather several times
 * the mean.
 */
export const MEAN_TRAIL = 0.15;
/**
 * The diffuse pass clamps trail values to this, the R8 fallback's full scale.
 * Deposits land on top, so a cell can briefly exceed it (float targets only).
 * Veins sit at about 2-4, so the clamp flattens their cores a little, which
 * keeps them wide.
 */
export const TRAIL_MAX = 4;

/** Food sources: a few broad, invisible attractors near the edges. */
export const FOOD_COUNT = 3;
/** Peak attraction added to the sensed trail at a food source. */
export const FOOD_STRENGTH = 1;
/** Gaussian radius of a food source, in heights of the frame. */
export const FOOD_RADIUS = 0.12;
/** Repulsion subtracted from the sensed trail in the calm centre. */
export const CALM_REPEL = 1.5;
/** Extra trail decay in the calm centre, as a fraction of the decay rate's complement. */
export const CALM_DECAY = 0.15;

/** Agent count tiers, all powers of two so the agent buffers stay tidy. */
export type AgentTier = (typeof AGENT_OPTIONS)[number]["value"];
export const AGENT_TIERS = {
  low: { count: 65536 },
  medium: { count: 131072 },
  high: { count: 262144 },
} as const satisfies Record<AgentTier, { count: number }>;
/** Agent count for a select value; unknown values fall back to medium. */
export function agentCount(id: string): number {
  return Object.hasOwn(AGENT_TIERS, id)
    ? AGENT_TIERS[id as AgentTier].count
    : AGENT_TIERS.medium.count;
}

/** Floats per agent: x, y (uv) and heading (radians). */
export const AGENT_FLOATS = 3;

/** Trail grid size for a canvas, with `cell` device pixels per cell. */
export function gridSize(width: number, height: number, cell: number): [number, number] {
  const c = Math.max(1, cell);
  return [clamp(Math.ceil(width / c), 1, MAX_GRID), clamp(Math.ceil(height / c), 1, MAX_GRID)];
}

/** Per-agent deposit for the given decay rate, trail grid cells and agent count. */
export function depositAmount(decay: number, cells: number, agents: number): number {
  return agents > 0 ? (MEAN_TRAIL * decay * cells) / agents : 0;
}

export type PaletteId = (typeof PALETTE_OPTIONS)[number]["value"];

/** Palettes as colour stops from the background (t = 0) to the brightest node (t = 1). */
export const PALETTES = {
  gold: {
    stops: [
      [0, "#060508"],
      [0.3, "#2e1c07"],
      [0.65, "#b67a17"],
      [1, "#fff0c2"],
    ],
  },
  bioluminescent: {
    stops: [
      [0, "#02060e"],
      [0.3, "#062a36"],
      [0.65, "#1aa89c"],
      [1, "#d6fff2"],
    ],
  },
  ember: {
    stops: [
      [0, "#070304"],
      [0.3, "#360a0b"],
      [0.65, "#cf4318"],
      [1, "#ffd47c"],
    ],
  },
  mono: {
    stops: [
      [0, "#050506"],
      [0.35, "#26272c"],
      [0.72, "#9799a3"],
      [1, "#f4f5f8"],
    ],
  },
} as const satisfies Record<PaletteId, { stops: readonly (readonly [number, string])[] }>;

/** Texels in the palette lookup table. */
export const LUT_SIZE = 256;

/**
 * Fills `out` (LUT_SIZE RGBA8 texels) with palette `id`, smoothly interpolated
 * between its stops. Unknown ids fall back to gold.
 */
export function buildPaletteLut(id: string, out: Uint8Array): Uint8Array {
  const stops = (Object.hasOwn(PALETTES, id) ? PALETTES[id as PaletteId] : PALETTES.gold).stops;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const [t0, c0] = stops[s];
    const [t1, c1] = stops[s + 1];
    const f = smoothstep(t0, t1, t);
    const a = hexToRgb(c0);
    const b = hexToRgb(c1);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Seconds per lap of each food source's swing, and its swing half-width (radians). */
const FOOD_PERIODS = [97, 131, 113];
const FOOD_SWING = 0.6;
/** Centre of each food source's arc on the edge ellipse: right, top, left. */
const FOOD_ANGLES = [0, Math.PI / 2, Math.PI];
const FOOD_PHASES = [0.3, 2.1, 4.4];
/** Half-axes of the ellipse the food sources ride on, in uv. */
const FOOD_RX = 0.42;
const FOOD_RY = 0.4;

/**
 * Writes the FOOD_COUNT food positions (uv pairs) at simulation time `t` seconds
 * to `out`. Each swings slowly back and forth along an arc of an ellipse near the
 * frame's edge: one at each side and one along the top, never down at the bottom
 * centre, where the speaker sits.
 */
export function foodPositions(t: number, out: Float32Array): Float32Array {
  for (let i = 0; i < FOOD_COUNT; i++) {
    const a =
      FOOD_ANGLES[i] + FOOD_SWING * Math.sin((t * 2 * Math.PI) / FOOD_PERIODS[i] + FOOD_PHASES[i]);
    out[i * 2] = 0.5 + FOOD_RX * Math.cos(a);
    out[i * 2 + 1] = 0.5 + FOOD_RY * Math.sin(a);
  }
  return out;
}

/**
 * The calm-centre mask at uv (x, y), 1 where the speaker sits (the middle third
 * of the width, below the top of their head) fading to 0 outside. The shaders
 * compute the same.
 */
export function calmMask(x: number, y: number): number {
  return (1 - smoothstep(0.1, 0.22, Math.abs(x - 0.5))) * (1 - smoothstep(0.7, 0.88, y));
}

/** Attraction to the food at uv (x, y), on a frame `aspect` = width / height. */
export function foodField(x: number, y: number, aspect: number, food: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < FOOD_COUNT; i++) {
    const dx = (x - food[i * 2]) * aspect;
    const dy = y - food[i * 2 + 1];
    sum += Math.exp(-(dx * dx + dy * dy) / (FOOD_RADIUS * FOOD_RADIUS));
  }
  return FOOD_STRENGTH * sum;
}

/** Writes `count` agents at random positions and headings to `out`, deterministically. */
export function seedAgents(seed: number, count: number, out: Float32Array): Float32Array {
  const rng = createRng(seed * 7907 + 11);
  for (let i = 0; i < count; i++) {
    out[i * AGENT_FLOATS] = rng();
    out[i * AGENT_FLOATS + 1] = rng();
    out[i * AGENT_FLOATS + 2] = rng() * Math.PI * 2;
  }
  return out;
}

/**
 * The per-step salt for agent random numbers: the shaders get it as a uniform and
 * compute `hash32(agentIndex + salt)`, as `agentRandom` does.
 */
export const stepSalt = (step: number) => hash32(step >>> 0);
/** The random bits agent `i` uses in the step with salt `salt`. */
export const agentRandom = (i: number, salt: number) => hash32((i + salt) >>> 0);

/** Settings for one step, shared by the shaders (as uniforms) and the CPU twin. */
export interface StepConfig {
  /** Agent speed, cells per step. */
  speed: number;
  /** Trail decay rate per step, 0..1. */
  decay: number;
  /** Per-agent deposit (see `depositAmount`). */
  deposit: number;
  /** Food positions (see `foodPositions`), or null for none. */
  food: Float32Array | null;
  calmCentre: boolean;
  /** The step's random salt (see `stepSalt`). */
  salt: number;
}

const TAU = Math.PI * 2;

/**
 * The turn an agent makes from its three sensor readings (forward, left, right)
 * and its random bits, in radians (positive = left, anticlockwise). Jones' rule:
 * keep going if forward is strongest, turn at random if forward is weakest, else
 * turn towards the stronger side; plus a small jitter.
 */
export function turn(f: number, l: number, r: number, bits: number): number {
  let a = 0;
  if (f >= l && f >= r) a = 0;
  else if (f < l && f < r) a = (bits & 1) === 0 ? TURN_ANGLE : -TURN_ANGLE;
  else if (l > r) a = TURN_ANGLE;
  else a = -TURN_ANGLE;
  return a + ((bits >>> 16) / 65536 - 0.5) * JITTER;
}

/**
 * One simulation step on a `w` x `h` trail grid, the CPU twin of the diffuse and
 * agent passes in physarum.ts. `trail` is read, `out` receives the new trail and
 * `agents` (AGENT_FLOATS each) is updated in place.
 *
 * 1. Diffuse and decay: out = clamp(blur121(trail) * keep, 0, TRAIL_MAX), with
 *    keep = 1 - decay, less in the calm centre. Edges wrap.
 * 2. Each agent senses the old trail (plus the food and calm terms) at three
 *    points, turns, moves `speed` cells, wraps, and deposits into `out`.
 *
 * The GPU samples the sensors bilinearly; this twin uses the nearest cell.
 */
export function physarumStep(
  trail: Float32Array,
  out: Float32Array,
  w: number,
  h: number,
  agents: Float32Array,
  count: number,
  cfg: StepConfig,
): void {
  const keep = 1 - clamp(cfg.decay, 0, 1);
  for (let y = 0; y < h; y++) {
    const ym = ((y + h - 1) % h) * w;
    const y0 = y * w;
    const yp = ((y + 1) % h) * w;
    const calmY = cfg.calmCentre ? (y + 0.5) / h : 0;
    for (let x = 0; x < w; x++) {
      const xm = (x + w - 1) % w;
      const xp = (x + 1) % w;
      const blur =
        (4 * trail[y0 + x] +
          2 * (trail[y0 + xm] + trail[y0 + xp] + trail[ym + x] + trail[yp + x]) +
          trail[ym + xm] +
          trail[ym + xp] +
          trail[yp + xm] +
          trail[yp + xp]) /
        16;
      const k = cfg.calmCentre ? keep * (1 - CALM_DECAY * calmMask((x + 0.5) / w, calmY)) : keep;
      out[y0 + x] = clamp(blur * k, 0, TRAIL_MAX);
    }
  }

  const aspect = w / h;
  const sense = (x: number, y: number) => {
    const u = fract(x);
    const v = fract(y);
    let s = trail[Math.min(h - 1, Math.floor(v * h)) * w + Math.min(w - 1, Math.floor(u * w))];
    if (cfg.food) s += foodField(u, v, aspect, cfg.food);
    if (cfg.calmCentre) s -= CALM_REPEL * calmMask(u, v);
    return s;
  };
  const sx = SENSOR_DISTANCE / w;
  const sy = SENSOR_DISTANCE / h;
  for (let i = 0; i < count; i++) {
    const o = i * AGENT_FLOATS;
    const x = agents[o];
    const y = agents[o + 1];
    const a = agents[o + 2];
    const f = sense(x + Math.cos(a) * sx, y + Math.sin(a) * sy);
    const l = sense(x + Math.cos(a + SENSOR_ANGLE) * sx, y + Math.sin(a + SENSOR_ANGLE) * sy);
    const r = sense(x + Math.cos(a - SENSOR_ANGLE) * sx, y + Math.sin(a - SENSOR_ANGLE) * sy);
    const na = fract((a + turn(f, l, r, agentRandom(i, cfg.salt))) / TAU) * TAU;
    const nx = fract(x + (Math.cos(na) * cfg.speed) / w);
    const ny = fract(y + (Math.sin(na) * cfg.speed) / h);
    agents[o] = nx;
    agents[o + 1] = ny;
    agents[o + 2] = na;
    const cell = Math.min(h - 1, Math.floor(ny * h)) * w + Math.min(w - 1, Math.floor(nx * w));
    out[cell] += cfg.deposit;
  }
}
