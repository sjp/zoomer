/**
 * The follower goal, without any drawing: when made-up follows arrive, and
 * the goal they count towards.
 *
 * The goal and its source of follows are kept apart. `createFollowSchedule`
 * is a seeded stand-in source; anything else that produces follows (a stream
 * of events shared with other overlays, say) can drive the goal instead by
 * calling `add` for each one.
 *
 * The count starts at `goalStart` of `goalTarget` and goes up with each
 * follow, never past the target. On reaching it the bar holds full, glowing,
 * for `GOAL_HOLD_SECONDS`; then the target goes up (never down by itself) and
 * the bar eases back to the new fraction. The bar's fill eases over
 * `GOAL_FILL_SECONDS` whatever moved it, a follow or a param change.
 */
import { approach, smoothstep } from "../math";
import { hash32 } from "../noise";

/** Average seconds between made-up follows; each gap is 50 % to 150 % of it. */
export const FOLLOW_GAP_SECONDS = 45;

/** Seconds the bar's fill takes to ease to a new fraction, and its glow to come or go. */
export const GOAL_FILL_SECONDS = 1;

/** Seconds a reached goal holds full before its target goes up. */
export const GOAL_HOLD_SECONDS = 15;

/** Seconds between follow `index` (0-based) and the one before it (or the start). */
export function followGap(seed: number, index: number): number {
  const u = hash32(hash32(seed ^ 0x6f11) ^ Math.imul(index + 1, 0x9e3779b1)) / 0x1_0000_0000;
  return FOLLOW_GAP_SECONDS * (0.5 + u);
}

/** A seeded stream of follows, at `followGap` intervals. */
interface FollowSchedule {
  /** Follows so far. Follow number `n` (1-based) is the `n`th. */
  readonly follows: number;
  /** Advances by `dt` seconds and returns how many follows arrived. Allocates nothing. */
  step: (dt: number) => number;
}

export function createFollowSchedule(seed: number): FollowSchedule {
  let follows = 0;
  let wait = followGap(seed, 0);
  return {
    get follows() {
      return follows;
    },
    step(dt) {
      wait -= Number.isFinite(dt) && dt > 0 ? dt : 0;
      let n = 0;
      while (wait <= 0) {
        n++;
        follows++;
        wait += followGap(seed, follows);
      }
      return n;
    },
  };
}

/** How much the target goes up each time it is reached: half the base target, in tens. */
export function goalRaise(base: number): number {
  return Math.max(10, Math.round(base / 20) * 10);
}

/** The follower goal's state. */
interface Goal {
  /** The count shown: never above `target`. */
  readonly count: number;
  readonly target: number;
  /** The bar's eased fill, 0..1. */
  readonly fill: number;
  /** The reached goal's glow, easing 0..1. */
  readonly glow: number;
  /** Whether it is holding a reached goal. */
  readonly holding: boolean;
  /** Changes whenever `count` or `target` does: the text needs redrawing. */
  readonly version: number;
  /**
   * Reads the params: `start` (0..1) of `base` is the count before any
   * follows, and `base` the first target. A change eases the bar.
   */
  configure: (start: number, base: number) => void;
  /** Counts `n` follows. */
  add: (n: number) => void;
  /** Advances the hold, the ease and the glow by `dt` seconds. Allocates nothing. */
  step: (dt: number) => void;
}

export function createGoal(): Goal {
  let base = 100;
  let first = 0;
  let follows = 0;
  let raises = 0;
  let holdLeft = 0;
  let holding = false;
  let count = -1;
  let target = -1;
  let version = 0;
  // The fill's ease: from, to, and how far through.
  let from = 0;
  let to = 0;
  let t = 1;
  let fill = 0;
  let glow = 0;
  let started = false;

  const targetFor = (r: number) => base + r * goalRaise(base);

  /** Recomputes the count and target, and starts the fill easing if they moved it. */
  const settle = () => {
    const raw = first + follows;
    let tgt = targetFor(raises);
    if (holding && raw < tgt) {
      // A param change took the goal out of reach: no longer reached.
      holding = false;
    }
    if (!holding && raw >= tgt) {
      holding = true;
      holdLeft = GOAL_HOLD_SECONDS;
    }
    tgt = targetFor(raises);
    const shown = Math.min(raw, tgt);
    if (shown !== count || tgt !== target) {
      count = shown;
      target = tgt;
      version++;
      const goal = target > 0 ? count / target : 0;
      if (!started) {
        // The first reading is where it starts: no ease in from empty.
        started = true;
        from = goal;
        to = goal;
        fill = goal;
        t = 1;
      } else if (goal !== to) {
        from = fill;
        to = goal;
        t = 0;
      }
    }
  };

  return {
    get count() {
      return count;
    },
    get target() {
      return target;
    },
    get fill() {
      return fill;
    },
    get glow() {
      return glow;
    },
    get holding() {
      return holding;
    },
    get version() {
      return version;
    },
    configure(start, newBase) {
      const b = Number.isFinite(newBase) ? Math.max(1, Math.round(newBase)) : 100;
      const s = Number.isFinite(start) ? Math.min(1, Math.max(0, start)) : 0;
      const f = Math.round(s * b);
      if (b === base && f === first && started) {
        return;
      }
      base = b;
      first = f;
      settle();
    },
    add(n) {
      if (n > 0) {
        follows += Math.floor(n);
        settle();
      }
    },
    step(dt) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (!started) {
        settle();
      }
      if (holding) {
        holdLeft -= step;
        if (holdLeft <= 0) {
          // Up to the first target past the count, so it isn't reached again at once.
          const raw = first + follows;
          do {
            raises++;
          } while (targetFor(raises) <= raw);
          holding = false;
          settle();
        }
      }
      if (t < 1) {
        t = Math.min(1, t + step / GOAL_FILL_SECONDS);
        fill = t >= 1 ? to : from + (to - from) * smoothstep(0, 1, t);
      }
      glow = approach(glow, holding ? 1 : 0, step / GOAL_FILL_SECONDS);
    },
  };
}
