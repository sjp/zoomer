/**
 * Shared wave wash timeline: a swell line rolls in at constant speed, breaks,
 * runs up the sand with constant deceleration, stops and drains back with
 * constant acceleration. Distances are along the shore normal `n`, positive
 * landward, with the still-water line at n = 0. Each effect picks its own break
 * point and approach distance, and its own projection.
 *
 * Used by "Beach from above" (seen from overhead) and "Bioluminescent shore"
 * (seen from the side).
 */
import { clamp } from "./math";

/** Seconds a swell line takes to roll in from its approach distance out to the break point. */
export const T_APPROACH = 4;
/** Seconds from breaking to the top of the run-up (decelerating, ballistic). */
export const T_RUNUP = 2.4;
/** Seconds the sheet takes to drain from the top of the run-up back to the shoreline. */
export const T_DRAIN = 3.5;
/** Seconds from a wave's start to the top of its run-up. */
export const T_STOP = T_APPROACH + T_RUNUP;
/** Seconds from a wave's start until its front is back at the shoreline. */
export const T_ACTIVE = T_STOP + T_DRAIN;
/** e-folding time (s) of the wet band drying once the water has drained off it. */
export const T_DRY = 4;

/**
 * Position of a wave's front (n) `tau` seconds after it starts, for a run-up of
 * `reach`: approaching from -`approachDist` at constant speed, then breaking at
 * -`breakAt` and running up with constant deceleration to `reach`, stopping, and
 * draining back with constant acceleration to the shoreline, where it stays.
 * Continuous, bounded by [-approachDist, reach], and 0 from T_ACTIVE on.
 */
export function washFront(
  tau: number,
  reach: number,
  breakAt: number,
  approachDist: number,
): number {
  const t = Math.max(0, tau);
  if (t < T_APPROACH) {
    return -breakAt - ((approachDist - breakAt) / T_APPROACH) * (T_APPROACH - t);
  }
  if (t < T_STOP) {
    const x = 1 - (t - T_APPROACH) / T_RUNUP;
    return -breakAt + (reach + breakAt) * (1 - x * x);
  }
  if (t < T_ACTIVE) {
    const x = (t - T_STOP) / T_DRAIN;
    return reach * (1 - x * x);
  }
  return 0;
}

/**
 * Seconds since the draining sheet uncovered `n`, for a wave `tau` seconds old
 * whose highest reach so far is `m` (> 0, with n <= m); negative while `n` is
 * still covered. The drain reaches n when reach * (1 - x²) = n, so
 * x = sqrt((m - n) / m).
 */
export function washSinceUncovered(n: number, tau: number, m: number): number {
  const q = clamp((m - n) / m, 0, 1);
  return tau - T_STOP - T_DRAIN * Math.sqrt(q);
}
