/**
 * Fixed-rate simulation steps from variable frame times: the GPU and CPU sims
 * (reaction-diffusion, smoke, physarum, murmuration, Lenia and the scenes that
 * reuse them) step at a set rate whatever the display's frame rate.
 */

/** Fractional steps owed, carried between frames. */
export interface StepClock {
  acc: number;
}

/**
 * Steps to run this frame at `rate` steps per second, at most `cap`. The fraction
 * left over carries to the next frame; whole steps beyond the cap are dropped, so
 * a long frame or a hidden tab never triggers a burst of catch-up steps.
 */
export function takeSteps(clock: StepClock, rate: number, dt: number, cap: number): number {
  const owed = clock.acc + Math.max(0, rate * dt);
  if (!Number.isFinite(owed)) {
    clock.acc = 0;
    return 0;
  }
  const whole = Math.floor(owed);
  const n = Math.min(whole, cap);
  clock.acc = owed - whole;
  return n;
}
