/**
 * Starship Bridge visiting ships: now and then, while the outside view shows
 * stars or a planet, a ship cruises in from one side, comes to a stop and turns
 * to face the viewer, holds there, then turns and cruises off the other side.
 * After a gap the next comes. It can instead be one chosen ship, and it can
 * stay once it has arrived. Pure, and a function of time alone, so it can be
 * tested without stepping.
 */
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";

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
type ShipKind = (typeof SHIP_KINDS)[number];

/** Seconds of each part of a visit: cruising in, turning, holding, turning, cruising out. */
export const CRUISE = 14;
export const TURN = 5;
export const HOLD = 30;
export const VISIT = CRUISE + TURN + HOLD + TURN + CRUISE;
/** Seconds from the start (or a change of ship settings) to the first arrival. */
export const ARRIVE = 5;
/** Default seconds between one ship leaving and the next arriving. */
export const GAP = 240;
/** Visits to step through `SHIP_KINDS` each time: coprime with its length, so every ship comes. */
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
interface ShipPose {
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

/**
 * Start (s) of visit `visit` (0 is the first), with `gap` seconds between visits
 * from visit `baseVisit` on, which starts at `baseStart` (see `ShipPlan`).
 */
export function visitStart(visit: number, gap: number, baseVisit = 0, baseStart = ARRIVE): number {
  return baseStart + (visit - baseVisit) * (VISIT + Math.max(0, gap));
}

/** Which ship comes on visit `visit` when cycling, as an index into `SHIP_KINDS`. */
export function visitKind(visit: number, seed: number): number {
  const n = SHIP_KINDS.length;
  const start = hash32(Math.floor(seed) + 0x51ed) % n;
  return (((start + visit * KIND_STEP) % n) + n) % n;
}

/** +1 if the ship on visit `visit` travels left to right, -1 for right to left. */
export function visitDirection(visit: number, seed: number): number {
  return rand(visit, seed, 2) < 0.5 ? 1 : -1;
}

/** Which ships come and how. */
export interface ShipPlan {
  /** An index into `SHIP_KINDS` for that ship alone, or -1 to cycle through them all. */
  kind: number;
  /** Whether the first ship stays, facing the viewer, once it has arrived. */
  stay: boolean;
  /** Seconds between one ship leaving and the next arriving. */
  gap: number;
  /**
   * The visit `gap` applies from, and its start (s): earlier visits kept the
   * gap they had (see `setShipGap`). Default to the first visit, at `ARRIVE`.
   */
  baseVisit?: number;
  baseStart?: number;
  /**
   * When the visit before `baseVisit` ended, so a gap change before it starts
   * can time it again; unset before the first visit, whose arrival is fixed.
   */
  gapFrom?: number | undefined;
}

/** The visit under way (or the last one, during a gap) at `t`, and when it starts. */
function visitAt(t: number, plan: ShipPlan): number {
  const gap = Math.max(0, plan.gap);
  const base = plan.baseVisit ?? 0;
  const start = plan.baseStart ?? ARRIVE;
  return plan.stay ? 0 : base + Math.max(0, Math.floor((t - start) / (VISIT + gap)));
}

/**
 * Changes the gap between visits at `t` without disturbing the ship in view:
 * the gap is latched at each visit's start, so the visit under way (or about
 * to start) keeps its time, and only the visits after it use the new gap. In a
 * gap, the next ship comes the new gap after the last one left, or now if that
 * has passed.
 */
export function setShipGap(plan: ShipPlan, gap: number, t: number): void {
  const g = Math.max(0, gap);
  if (plan.stay || g === Math.max(0, plan.gap)) {
    plan.gap = gap;
    return;
  }
  const visit = visitAt(t, plan);
  const start = visitStart(visit, plan.gap, plan.baseVisit, plan.baseStart);
  if (t < start) {
    // Waiting for the next ship: time it from when the last one left.
    plan.baseVisit = visit;
    plan.baseStart = plan.gapFrom === undefined ? start : Math.max(t, plan.gapFrom + g);
  } else if (t - start < VISIT) {
    plan.baseVisit = visit;
    plan.baseStart = start;
  } else {
    plan.gapFrom = start + VISIT;
    plan.baseVisit = visit + 1;
    plan.baseStart = Math.max(t, plan.gapFrom + g);
  }
  plan.gap = gap;
}

function clear(out: ShipPose): ShipPose {
  out.kind = -1;
  out.across = 0;
  out.bob = 0;
  out.yaw = 0;
  return out;
}

/**
 * The visiting ship's pose `t` seconds after the start (or after the plan last
 * changed), written into `out`. Allocates nothing.
 */
export function shipAt(t: number, seed: number, plan: ShipPlan, out: ShipPose): ShipPose {
  const visit = visitAt(t, plan);
  const local = plan.stay
    ? t - ARRIVE
    : t - visitStart(visit, plan.gap, plan.baseVisit, plan.baseStart);
  if (!(local >= 0 && (plan.stay || local < VISIT))) {
    return clear(out);
  }
  const dir = visitDirection(visit, seed);
  out.kind = plan.kind >= 0 && plan.kind < SHIP_KINDS.length ? plan.kind : visitKind(visit, seed);
  const side = (dir * Math.PI) / 2;
  const turnIn = CRUISE;
  const hold = turnIn + TURN;
  // Staying, the hold never ends.
  const turnOut = plan.stay ? Number.POSITIVE_INFINITY : hold + HOLD;
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
  const leaving = plan.stay ? 0 : smoothstep(turnOut, cruiseOut, local);
  const still = smoothstep(turnIn, hold, local) * (1 - leaving);
  out.bob = 0.02 * Math.sin(((local - turnIn) * 2 * Math.PI) / 9) * clamp(still, 0, 1);
  return out;
}
