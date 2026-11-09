/**
 * Shared growth helpers for effects that precompute *when* each part of a pattern
 * appears and then reveal it over time, instead of simulating every frame (frost
 * ferns, coral). JS and GLSL twins.
 *
 * **Arrival times.** Each texel of a field, or each end of a skeleton segment,
 * stores an arrival time in [0, 1]: the growth level at which it appears. Values
 * of 1 or more never appear.
 *
 * **The clock** runs a repeating cycle of three phases (durations in seconds at
 * speed 1):
 *
 * - **grow:** `level` rises linearly from 0 to 1, `melt` is 0;
 * - **hold:** `level` is 1, `melt` 0;
 * - **melt:** `level` stays 1 and `melt` rises from 0 to 1.
 *
 * A pattern has fully melted by the end of the cycle and has not started growing
 * at its start, so nothing is visible on either side of the wrap: that is when an
 * effect reseeds (when `cycle` changes). With looping off the clock grows to the
 * hold and stays there, running a melt in progress backwards.
 *
 * **The reveal threshold** combines the two: `growthThreshold(level, meltOffset,
 * bias) = min(level, 1 + bias - meltOffset)`, with `meltOffset = melt * (1 +
 * maxBias)` from `meltOffset`. A part is visible where its arrival is below the
 * threshold. `bias` (0..maxBias) delays the melt locally: parts with a small bias
 * melt first (frost melts from the centre), and at `melt` = 1 the threshold is
 * at or below 0 everywhere. At `melt` = 0 the bias has no effect, so the melt
 * starts without a jump. Effects that fade out instead of melting (coral) can use
 * `melt` as their fade and leave `meltOffset` at 0.
 *
 * - `growthCover(arrival, threshold, soft)`: a soft 0..1 coverage edge for fields;
 *   exactly 0 at or below the threshold's arrival, so an arrival >= 0 is hidden
 *   at `level` = 0.
 * - `segmentReveal(t0, t1, threshold)`: the visible fraction (0..1) of a segment
 *   whose ends arrive at `t0` <= `t1`, for skeletons drawn as growing capsules.
 *
 * Typical use:
 *
 * ```ts
 * const clock = createGrowthClock({ grow: 180, hold: 60, melt: 60 });
 * // frame:
 * const s = clock.advance(dt, speed, loop);
 * if (s.cycle !== lastCycle) reseed(hash(seed, s.cycle));
 * u.f2("uGrowth", s.level, meltOffset(s.melt, MAX_BIAS));
 * // shader: ${GROWTH_GLSL} ... growthCover(a, growthThreshold(uGrowth, bias), soft)
 * ```
 */

/** Phase durations in seconds at speed 1. */
interface GrowthCycle {
  readonly grow: number;
  readonly hold: number;
  readonly melt: number;
}

type GrowthPhase = "grow" | "hold" | "melt";

export interface GrowthState {
  phase: GrowthPhase;
  /** Completed cycles; changes exactly at the wrap, when nothing is visible. */
  cycle: number;
  /** Growth level, 0..1 (1 during hold and melt). */
  level: number;
  /** Melt progress, 0..1 (0 during grow and hold). */
  melt: number;
  /** Seconds into the current cycle, at speed 1. */
  time: number;
}

/** Seconds per cycle at speed 1. Throws unless every phase is finite, grow and melt positive. */
export function cyclePeriod(c: GrowthCycle): number {
  if (!(c.grow > 0) || !(c.melt > 0) || !(c.hold >= 0)) {
    throw new Error("growth: grow and melt must be positive and hold non-negative");
  }
  const p = c.grow + c.hold + c.melt;
  if (!Number.isFinite(p)) {
    throw new TypeError("growth: phase durations must be finite");
  }
  return p;
}

/** A fresh state object, for `growthStateAt`'s `out`. */
function createGrowthState(): GrowthState {
  return { phase: "grow", cycle: 0, level: 0, melt: 0, time: 0 };
}

/**
 * The state `t` seconds (at speed 1, >= 0; negative counts as 0) after the start
 * of cycle 0. Writes into `out` (allocating nothing) and returns it.
 */
export function growthStateAt(
  c: GrowthCycle,
  t: number,
  out: GrowthState = createGrowthState(),
): GrowthState {
  const period = cyclePeriod(c);
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  let cycle = Math.floor(time / period);
  let tau = time - cycle * period;
  // Rounding can land a hair outside [0, period).
  if (tau >= period) {
    cycle++;
    tau = 0;
  } else if (tau < 0) {
    cycle--;
    tau += period;
  }
  out.cycle = cycle;
  out.time = tau;
  if (tau < c.grow) {
    out.phase = "grow";
    out.level = tau / c.grow;
    out.melt = 0;
  } else if (tau < c.grow + c.hold) {
    out.phase = "hold";
    out.level = 1;
    out.melt = 0;
  } else {
    out.phase = "melt";
    out.level = 1;
    out.melt = Math.min(1, (tau - c.grow - c.hold) / c.melt);
  }
  return out;
}

/**
 * A running growth clock. Time is kept unwrapped in float64 (CPU only); the values
 * an effect uploads (`level`, `melt`) are bounded.
 */
interface GrowthClock {
  readonly durations: GrowthCycle;
  /** Seconds since the start of cycle 0, at speed 1. */
  readonly time: number;
  /** The current state; the same object every call, updated in place. */
  readonly state: GrowthState;
  /**
   * Advances by `dt * speed` seconds (non-finite or negative steps count as 0).
   * With `loop` false the clock stops at the start of the hold, and a melt in
   * progress runs backwards to it, so the pattern returns to full growth smoothly.
   */
  advance: (dt: number, speed?: number, loop?: boolean) => GrowthState;
  /** Jumps to `t` seconds after the start of cycle 0. */
  set: (t: number) => GrowthState;
}

export function createGrowthClock(c: GrowthCycle, start = 0): GrowthClock {
  const period = cyclePeriod(c);
  const state = createGrowthState();
  let time = 0;
  const set = (t: number) => {
    time = Number.isFinite(t) && t > 0 ? t : 0;
    return growthStateAt(c, time, state);
  };
  set(start);
  return {
    durations: c,
    get time() {
      return time;
    },
    state,
    set,
    advance(dt, speed = 1, loop = true) {
      const raw = dt * speed;
      const step = Number.isFinite(raw) && raw > 0 ? raw : 0;
      if (loop) {
        return set(time + step);
      }
      const base = state.cycle * period;
      const holdStart = base + c.grow;
      if (time < holdStart) {
        return set(Math.min(holdStart, time + step));
      }
      return set(Math.max(holdStart, time - step));
    },
  };
}

/** `melt * (1 + maxBias)`: the melt term of the threshold, for a bias range of 0..maxBias. */
export function meltOffset(melt: number, maxBias: number): number {
  return melt * (1 + Math.max(0, maxBias));
}

/**
 * Reveal threshold: `min(level, 1 + bias - meltOffset)`. Equal to `level` while
 * `meltOffset` is 0; at or below 0 once `melt` is 1 for every bias in 0..maxBias.
 */
export function growthThreshold(level: number, melt: number, bias: number): number {
  return Math.min(level, 1 + bias - melt);
}

/**
 * Soft coverage of a part arriving at `arrival` under `threshold`: 0 at or below
 * `threshold - arrival = 0`, 1 from `soft` on, a smoothstep between. `soft` > 0.
 */
export function growthCover(arrival: number, threshold: number, soft: number): number {
  const x = Math.min(1, Math.max(0, (threshold - arrival) / soft));
  return x * x * (3 - 2 * x);
}

/**
 * Visible fraction of a segment whose start and end arrive at `t0` <= `t1`: 0
 * until the threshold passes `t0`, 1 once it passes `t1`, linear between (so the
 * tip extends at the segment's growth speed). A zero-length span is a step at `t0`.
 */
export function segmentReveal(t0: number, t1: number, threshold: number): number {
  const span = t1 - t0;
  if (!(span > 1e-6)) {
    return threshold > t0 ? 1 : 0;
  }
  return Math.min(1, Math.max(0, (threshold - t0) / span));
}

/**
 * GLSL twins of `growthThreshold`, `growthCover` and `segmentReveal`:
 *
 * - `float growthThreshold(vec2 growth, float bias)`, `growth` = (level, meltOffset)
 * - `float growthCover(float arrival, float threshold, float soft)`
 * - `float segmentReveal(float t0, float t1, float threshold)`
 */
export const GROWTH_GLSL = /* glsl */ `
float growthThreshold(vec2 growth, float bias) {
  return min(growth.x, 1.0 + bias - growth.y);
}
float growthCover(float arrival, float threshold, float soft) {
  return smoothstep(0.0, soft, threshold - arrival);
}
float segmentReveal(float t0, float t1, float threshold) {
  float span = t1 - t0;
  if (span <= 1e-6) return threshold > t0 ? 1.0 : 0.0;
  return clamp((threshold - t0) / span, 0.0, 1.0);
}
`;
