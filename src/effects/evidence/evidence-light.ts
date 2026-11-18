/**
 * Detective Evidence Board's light and small motions: the desk lamp's warm
 * pool (in JS for the dust motes and as its GLSL twin for the board), the
 * lamp's faint hum, and when the loose clipping's corner lifts in the draught.
 *
 * Light positions are in board units from the frame's centre, y up (see
 * `evidence-layout.ts`).
 */
import { glslFloat as g } from "../gl";
import { hash32 } from "../noise";

/** The lamp pool's centre and its radii (board units, y up). */
const POOL_X = 0.2;
const POOL_Y = 0.12;
const POOL_RX = 0.85;
const POOL_RY = 0.62;

/** How much of the lamp's pool reaches (x, y), 0..1, brightest at its centre. */
export function poolAt(x: number, y: number): number {
  const dx = (x - POOL_X) / POOL_RX;
  const dy = (y - POOL_Y) / POOL_RY;
  return Math.exp(-dx * dx - dy * dy);
}

/** GLSL for `float poolAt(vec2 p)`, the shader twin of `poolAt`. */
export const POOL_GLSL = /* glsl */ `
float poolAt(vec2 p) {
  vec2 d = (p - vec2(${g(POOL_X)}, ${g(POOL_Y)})) * vec2(${g(1 / POOL_RX)}, ${g(1 / POOL_RY)});
  return exp(-dot(d, d));
}
`;

/**
 * Each lighting's values, eased as one block: ambient light (RGB), the lamp
 * pool's light (RGB), how bright the dust motes are, and how much the lamp hums.
 */
export const LIGHT_FLOATS = 8;
export const LIGHTINGS: Readonly<Record<string, readonly number[]>> = {
  // A dim room: the lamp's warm pool does the work, the edges fall away.
  lamp: [0.19, 0.18, 0.2, 1.02, 0.8, 0.52, 1, 1],
  // Even, cooler light from overhead and a window; no dust in the air to see.
  daylight: [0.82, 0.86, 0.92, 0.18, 0.19, 0.2, 0, 0],
};

/** The hum's largest swing in the lamp's brightness, as a fraction. */
export const HUM_DEPTH = 0.018;
const HUM_PERIOD_A = 2.3;
const HUM_PERIOD_B = 0.83;

/** The lamp's brightness at `time` seconds: 1 plus or minus HUM_DEPTH, a slow uneven wobble. */
export function humLevel(time: number): number {
  const t = Number.isFinite(time) ? time : 0;
  const a = Math.sin((2 * Math.PI * t) / HUM_PERIOD_A);
  const b = Math.sin((2 * Math.PI * t) / HUM_PERIOD_B + 1.7);
  return 1 + HUM_DEPTH * (0.6 * a + 0.4 * b);
}

/** Seconds per lift slot; a slot holds at most one lift. */
const LIFT_SLOT = 16;
/** Seconds a lift takes to rise and to settle. */
const LIFT_RISE = 0.9;
const LIFT_SETTLE = 2.2;
/** Share of slots without a lift, so the rhythm isn't regular. */
const LIFT_SKIP = 0.3;

/**
 * How far the loose clipping's corner is lifted at `time` seconds, 0..1: now
 * and then it rises over LIFT_RISE seconds and settles over LIFT_SETTLE, by a
 * seeded height. Zero most of the time.
 */
export function clippingLift(time: number, seed: number): number {
  if (!Number.isFinite(time) || time < 0) {
    return 0;
  }
  const slot = Math.floor(time / LIFT_SLOT);
  const h = hash32((Math.imul(Math.trunc(seed), 0x2c1b3c6d) ^ slot) >>> 0);
  const roll = (h & 0xffff) / 0x10000;
  if (roll < LIFT_SKIP) {
    return 0;
  }
  const start = ((h >>> 16) / 0x10000) * (LIFT_SLOT - LIFT_RISE - LIFT_SETTLE);
  const height = 0.55 + 0.45 * ((roll - LIFT_SKIP) / (1 - LIFT_SKIP));
  const t = time - slot * LIFT_SLOT - start;
  if (t <= 0 || t >= LIFT_RISE + LIFT_SETTLE) {
    return 0;
  }
  const x = t < LIFT_RISE ? t / LIFT_RISE : 1 - (t - LIFT_RISE) / LIFT_SETTLE;
  return height * x * x * (3 - 2 * x);
}
