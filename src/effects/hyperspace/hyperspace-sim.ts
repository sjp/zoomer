/**
 * Hyperspace's simulation, kept free of GL so it can be tested: the jump cycle (a
 * linear progress from normal space (0) to full hyperspace (1), driven by the
 * mode or an auto cycle, with a soft bloom as each jump in reaches full speed)
 * and the streaks flying out from the centre.
 */
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";
import { approach, smoothstep } from "../math";

/** Seconds the bloom takes to rise to its peak. */
export const BLOOM_RISE_SECONDS = 1;
/** Seconds the bloom takes to fall from its peak back to nothing. */
export const BLOOM_FALL_SECONDS = 1.5;
/**
 * Peak luminance the bloom adds at the centre of the frame. Kept small so a
 * jump never reads as a flash, and so the codec sees a gentle ramp rather than
 * every block changing at once.
 */
export const BLOOM_PEAK = 0.15;
/** Progress at which a jump in blooms. */
export const BLOOM_AT = 0.9;

/**
 * Whether the effect should be heading into hyperspace at `cycleTime` seconds:
 * always for mode "in", never for "out", and in the auto cycle for the 60% of
 * each `cycleSeconds` after the first quarter.
 */
export function wantsHyperspace(mode: string, cycleTime: number, cycleSeconds: number): boolean {
  if (mode === "in") {
    return true;
  }
  if (mode === "out") {
    return false;
  }
  const phase = (cycleTime % cycleSeconds) / cycleSeconds;
  return phase >= 0.25 && phase < 0.85;
}

interface Jump {
  /** Linear jump progress, 0..1; -1 before the first step. */
  readonly progress: number;
  /**
   * Bloom added at the centre of the frame, 0..`BLOOM_PEAK`: eases up over
   * `BLOOM_RISE_SECONDS` from the moment of the jump, then back down over
   * `BLOOM_FALL_SECONDS`.
   */
  readonly bloom: number;
  /** Advances by `dt` seconds, a jump taking `jumpSeconds` either way. */
  step: (dt: number, mode: string, jumpSeconds: number, cycleSeconds: number) => void;
}

export function createJump(): Jump {
  let cycleTime = 0;
  let progress = -1;
  /** Linear envelope position, 0..1, eased on output. */
  let level = 0;
  let rising = false;
  return {
    get progress() {
      return progress;
    },
    get bloom() {
      return BLOOM_PEAK * smoothstep(0, 1, level);
    },
    step(dt, mode, jumpSeconds, cycleSeconds) {
      cycleTime += dt;
      const target = wantsHyperspace(mode, cycleTime, cycleSeconds) ? 1 : 0;
      // The first frame starts in its target state rather than jumping into it.
      if (progress < 0) {
        progress = target;
      }
      const before = progress;
      progress = approach(progress, target, dt / jumpSeconds);
      if (before < BLOOM_AT && progress >= BLOOM_AT) {
        // A retrigger mid-fall rises again from the current level: no jump.
        rising = true;
      }
      if (rising) {
        level = Math.min(1, level + dt / BLOOM_RISE_SECONDS);
        rising = level < 1;
      } else {
        level = Math.max(0, level - dt / BLOOM_FALL_SECONDS);
      }
    },
  };
}

/** Seconds a streak added by a higher count takes to fade in. */
export const STREAK_FADE_IN = 0.8;
/** Distance (0 = centre, 1 = corner) past which a streak respawns near the centre. */
export const RESPAWN_DIST = 1.1;
/** Respawned streaks start between these distances from the centre. */
export const RESPAWN_MIN = 0.02;
export const RESPAWN_MAX = 0.27;

interface StreakField {
  /** Unit direction of each streak, fixed for its lifetime. */
  readonly dirX: Float32Array;
  readonly dirY: Float32Array;
  /** Distance of each streak's head from the centre (0 = centre, 1 = corner). */
  readonly dist: Float32Array;
  /** Each streak's share of the glow colour, 0..1. */
  readonly mix: Float32Array;
  /**
   * Each streak's visibility after the last step: faded in from the centre and
   * by the count fade.
   */
  readonly alpha: Float32Array;
  /** Streaks simulated: the count plus any still fading out after it dropped. */
  readonly live: number;
  /**
   * Advances `dt` seconds with `wanted` streaks at `velocity` (distance per
   * second at distance 0.9, scaled by each streak's pace). Streaks that fly off
   * respawn near the centre; added ones fade in, removed ones fade out. Returns
   * how many streaks to draw (indices 0 to n - 1). Allocates nothing.
   */
  step: (dt: number, wanted: number, velocity: number) => number;
}

/**
 * `max` streaks scattered at random distances, laid out by `random` (a seeded
 * RNG, so the field is the same on every load).
 */
export function createStreakField(max: number, random: () => number): StreakField {
  const dirX = new Float32Array(max);
  const dirY = new Float32Array(max);
  const dist = new Float32Array(max);
  const pace = new Float32Array(max);
  const mix = new Float32Array(max);
  const life = new Float32Array(max);
  const alpha = new Float32Array(max);
  let live = 0;

  const spawn = (i: number, d: number) => {
    const angle = random() * Math.PI * 2;
    dirX[i] = Math.cos(angle);
    dirY[i] = Math.sin(angle);
    dist[i] = d;
    pace[i] = 0.6 + random() * 0.8;
    mix[i] = random();
  };
  for (let i = 0; i < max; i++) {
    spawn(i, random());
  }

  return {
    dirX,
    dirY,
    dist,
    mix,
    alpha,
    get live() {
      return live;
    },
    step(dt, wanted, velocity) {
      const target = Math.max(0, Math.min(max, wanted));
      const n = (live = growLive(life, live, target));
      const fadeStep = dt / STREAK_FADE_IN;
      const outStep = dt / FADE_OUT;
      for (let i = 0; i < n; i++) {
        let d = dist[i] + dt * velocity * pace[i] * (0.1 + dist[i]);
        if (d > RESPAWN_DIST) {
          spawn(i, RESPAWN_MIN + random() * (RESPAWN_MAX - RESPAWN_MIN));
          d = dist[i];
        }
        dist[i] = d;
        // Added streaks appear mid-flight, so they fade in rather than pop.
        alpha[i] = Math.min(1, d * 3) * stepLife(life, i, target, fadeStep, outStep);
      }
      live = trimLive(life, live, target);
      return n;
    },
  };
}
