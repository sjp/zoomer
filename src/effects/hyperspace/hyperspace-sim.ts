/**
 * Hyperspace's jump cycle, kept free of GL so it can be tested: a linear progress
 * from normal space (0) to full hyperspace (1), driven by the mode or an auto
 * cycle, with a soft bloom as each jump in reaches full speed.
 */
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

export interface Jump {
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
