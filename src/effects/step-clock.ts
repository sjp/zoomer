/**
 * Fixed-rate simulation steps from variable frame times: the GPU and CPU sims
 * (reaction-diffusion, smoke, physarum, murmuration, Lenia and the scenes that
 * reuse them) step at a set rate whatever the display's frame rate.
 *
 * Drawing between steps: on a 120 or 144 Hz display a 60 Hz sim holds each state
 * for two or three frames, so anything that visibly travels judders. A sim whose
 * features travel draws between steps using the time since the last step (the
 * fraction of a step in `acc`): it blends its last two states (Incense Smoke's
 * density field) or extrapolates along velocities (Murmuration's birds, Dividing
 * Cells). Sims whose patterns grow or creep rather than travel (reaction-diffusion,
 * Lenia, physarum) and the small, soft steam plumes of the scenes draw the latest
 * step.
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
