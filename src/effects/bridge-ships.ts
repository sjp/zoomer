/**
 * Starship Bridge visiting ships: now and then, while the outside view shows
 * stars, a ship cruises in from one side, comes to a stop and turns to face the
 * viewer, holds there, then turns and cruises off the other side. A few minutes
 * pass before the next. Pure, and a function of time alone, so it can be
 * tested without stepping.
 */
import { clamp, smoothstep } from "./math";
import { hash32 } from "./noise";

/** The visiting ships, in the order `SHIP_GLSL` numbers them. */
export const SHIP_KINDS = [
  "borg cube",
  "bird-of-prey",
  "federation starship",
  "warbird",
  "marauder",
  "galor",
  "shuttlecraft",
] as const;
export type ShipKind = (typeof SHIP_KINDS)[number];

/** Seconds of each part of a visit: cruising in, turning, holding, turning, cruising out. */
export const CRUISE = 14;
export const TURN = 5;
export const HOLD = 30;
export const VISIT = CRUISE + TURN + HOLD + TURN + CRUISE;
/** Seconds per slot; each slot has one visit, starting between `FIRST` and `FIRST + SPREAD` in. */
export const SHIP_SLOT = 300;
export const FIRST = 60;
export const SPREAD = 60;
/** Slots to step through `SHIP_KINDS` each time: coprime with its length, so every ship comes. */
const KIND_STEP = 3;

/** Size of each ship relative to the others (1 is about a ship length of 1). */
export const SHIP_SCALE: Readonly<Record<ShipKind, number>> = {
  "borg cube": 0.9,
  "bird-of-prey": 1,
  "federation starship": 1.1,
  warbird: 1.1,
  marauder: 1,
  galor: 1,
  shuttlecraft: 0.85,
};

/** Where a visiting ship is. `kind` is -1 when none is in view. */
export interface ShipPose {
  kind: number;
  /** -1 to 1 across: at ±1 the ship is just out of view on that side. */
  across: number;
  /** A small bob up and down, in ship lengths. */
  bob: number;
  /**
   * Turn (radians) about the vertical: 0 faces the viewer, +π/2 points to the
   * right (+x), -π/2 to the left.
   */
  yaw: number;
}

export function createShipPose(): ShipPose {
  return { kind: -1, across: 0, bob: 0, yaw: 0 };
}

function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x632be5ab))) / 4294967296;
}

/** Start (s) of the visit in slot `slot`. */
export function visitStart(slot: number, seed: number): number {
  return slot * SHIP_SLOT + FIRST + rand(slot, seed, 1) * SPREAD;
}

/** Which ship visits in slot `slot`, as an index into `SHIP_KINDS`. */
export function visitKind(slot: number, seed: number): number {
  const n = SHIP_KINDS.length;
  const start = hash32(Math.floor(seed) + 0x51ed) % n;
  return (((start + slot * KIND_STEP) % n) + n) % n;
}

/** +1 if the ship in slot `slot` travels left to right, -1 for right to left. */
export function visitDirection(slot: number, seed: number): number {
  return rand(slot, seed, 2) < 0.5 ? 1 : -1;
}

/**
 * The visiting ship's pose at time `t` (s), written into `out`. Allocates
 * nothing.
 */
export function shipAt(t: number, seed: number, out: ShipPose): ShipPose {
  const slot = Math.floor(t / SHIP_SLOT);
  const local = t - visitStart(slot, seed);
  if (!(local >= 0 && local < VISIT)) {
    out.kind = -1;
    out.across = 0;
    out.bob = 0;
    out.yaw = 0;
    return out;
  }
  const dir = visitDirection(slot, seed);
  out.kind = visitKind(slot, seed);
  const side = (dir * Math.PI) / 2;
  const turnIn = CRUISE;
  const hold = turnIn + TURN;
  const turnOut = hold + HOLD;
  const cruiseOut = turnOut + TURN;
  if (local < turnIn) {
    // In from off-screen, slowing to a stop in the middle.
    const k = local / CRUISE;
    out.across = -dir * (1 - k) * (1 - k);
    out.yaw = side;
  } else if (local < hold) {
    out.across = 0;
    out.yaw = side * (1 - smoothstep(turnIn, hold, local));
  } else if (local < turnOut) {
    out.across = 0;
    out.yaw = 0;
  } else if (local < cruiseOut) {
    out.across = 0;
    out.yaw = side * smoothstep(turnOut, cruiseOut, local);
  } else {
    // Away, gathering speed, off the other side.
    const k = (local - cruiseOut) / CRUISE;
    out.across = dir * k * k;
    out.yaw = side;
  }
  // A gentle bob that fades in and out with the hold.
  const still = smoothstep(turnIn, hold, local) * (1 - smoothstep(turnOut, cruiseOut, local));
  out.bob = 0.02 * Math.sin(((local - turnIn) * 2 * Math.PI) / 9) * clamp(still, 0, 1);
  return out;
}
