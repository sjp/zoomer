/**
 * Hyperspace's jump cycle, kept free of GL so it can be tested: a linear progress
 * from normal space (0) to full hyperspace (1), driven by the mode or an auto
 * cycle, with a flash as each jump in reaches full speed.
 */
import { approach } from "./math";

/** Seconds the flash takes to fade out. */
export const FLASH_SECONDS = 0.35;
/** Progress at which a jump in flashes. */
export const FLASH_AT = 0.9;

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
  /** Flash level, 1 at the moment of the jump fading to 0. */
  readonly flash: number;
  /** Advances by `dt` seconds, a jump taking `jumpSeconds` either way. */
  step: (dt: number, mode: string, jumpSeconds: number, cycleSeconds: number) => void;
}

export function createJump(): Jump {
  let cycleTime = 0;
  let progress = -1;
  let flash = 0;
  return {
    get progress() {
      return progress;
    },
    get flash() {
      return flash;
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
      if (before < FLASH_AT && progress >= FLASH_AT) {
        flash = 1;
      }
      flash = Math.max(0, flash - dt / FLASH_SECONDS);
    },
  };
}
