/**
 * Steam rising off a hot drink, as Steaming Mug draws it with the smoke model
 * (`smoke/smoke-sim.ts` and `smoke/smoke-field.ts`): the emitter and flow
 * settings in sim units, and how the composite turns density into opacity and
 * a lit edge. The effect picks the sim space's scale and the emitter's width
 * to suit its cup.
 */
import { clamp } from "./math";
import type { Flow } from "./smoke/smoke-sim";

/** Steam density to opacity: alpha = 1 - exp(-STEAM_OPACITY * density). */
export const STEAM_OPACITY = 1.8;
/** Lit-edge gain per unit of density drop towards the light, and the fetch offset in cells. */
export const LIT_GAIN = 6;
export const LIT_CELLS = 1.5;

/** Emitter settings for the smoke field, in sim units. */
export interface SteamEmitter {
  /** Splat strength (0: no new steam). */
  strength: number;
  /** Seconds for density to fall by e at the surface. */
  life: number;
  /** Wisp modulation along the surface (see `wispFactor` in smoke-sim.ts). */
  wisp: number;
}

/** Splat radius, sim units. */
export const STEAM_RADIUS = 0.018;
/** Life at steam 0 and 1, and the extra fade per sim unit of height. */
export const STEAM_LIFE = [1.1, 2.1] as const;
export const STEAM_HEIGHT_DECAY = 0.5;
/** Wisp amount at steam 0 and 1: more steam fills in between the wisps. */
export const STEAM_WISP = [0.9, 0.6] as const;
/** Wisps per sim unit along the surface, and their drift (rad/s). */
export const WISP_K = 70;
export const WISP_SPEED = 0.5;

/** Maps the `steam` param (0..1) to bounded emitter values. */
export function steamEmitter(steam: number, out: SteamEmitter): SteamEmitter {
  const s = clamp(Number.isFinite(steam) ? steam : 0, 0, 1);
  out.strength = s;
  out.life = STEAM_LIFE[0] + (STEAM_LIFE[1] - STEAM_LIFE[0]) * s;
  out.wisp = STEAM_WISP[0] + (STEAM_WISP[1] - STEAM_WISP[0]) * s;
  return out;
}

/** Steam rise (sim units/s), curl strength, and the band over which the curl sets in. */
const STEAM_RISE = 0.3;
const STEAM_CURL = 3.2;
const STEAM_ONSET = [0, 0.45] as const;

/** Fills the parts of the smoke flow that don't depend on time. */
export function steamFlow(out: Flow): Flow {
  out.rise = STEAM_RISE;
  out.curl = STEAM_CURL;
  out.onset0 = STEAM_ONSET[0];
  out.onset1 = STEAM_ONSET[1];
  return out;
}
