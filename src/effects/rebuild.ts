/**
 * Keeping heavy CPU builds (textures, tables, geometry) out of a single `frame`:
 *
 * - `createSettledValue` debounces an input such as a seed slider or the canvas
 *   aspect, so dragging or resizing rebuilds once, after the input stops changing.
 * - `BuildSteps` is a build written as a generator that yields every so often;
 *   `createBackgroundBuild` steps one within a per-frame time budget and hands
 *   back the result when it completes, while the effect keeps drawing the old one.
 *   `finishBuild` runs the same steps in one go, so tests and fallbacks get exactly
 *   the result the incremental path produces.
 *
 * Stepping a generator allocates an iterator result per step; that only happens
 * while a build is in flight, never in steady state.
 */

/** A build that yields between chunks of work and returns its result. */
export type BuildSteps<T> = Generator<void, T, void>;

/** Runs `steps` to completion and returns the result. */
export function finishBuild<T>(steps: BuildSteps<T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done === true) {
      return r.value;
    }
  }
}

/** Debounces an input on frame time. Values are compared with `===`. */
export interface SettledValue<T> {
  /**
   * Feeds this frame's value after `dt` seconds and returns the settled one: the
   * first value at once, then each new value once it has held for the settle time.
   */
  update: (value: T, dt: number) => T;
  /** The settled value, or undefined before the first update. */
  readonly value: T | undefined;
  /** Whether the latest value differs from the settled one (a change is pending). */
  readonly pending: boolean;
}

export function createSettledValue<T>(settleSeconds: number): SettledValue<T> {
  /** Undefined until the first update. */
  let state: { settled: T; latest: T; held: number } | undefined;
  return {
    update(value, dt) {
      if (state === undefined) {
        state = { settled: value, latest: value, held: 0 };
        return value;
      }
      if (value !== state.latest) {
        state.latest = value;
        state.held = 0;
      } else if (value !== state.settled) {
        state.held += Number.isFinite(dt) && dt > 0 ? dt : 0;
      }
      if (value !== state.settled && state.held >= settleSeconds) {
        state.settled = value;
      }
      return state.settled;
    },
    get value() {
      return state?.settled;
    },
    get pending() {
      return state !== undefined && state.latest !== state.settled;
    },
  };
}

/** Milliseconds, monotonic. */
export type Clock = () => number;

const defaultClock: Clock = () => performance.now();

/**
 * One build at a time, identified by a key (a seed, a size, or both as a string),
 * stepped a little each frame.
 */
export interface BackgroundBuild<K, T> {
  /**
   * Starts building `key` with the steps from `make`, unless that key is already
   * being built. Replaces any build in flight; asking for the latest finished
   * result's key just drops the build in flight.
   */
  request: (key: K, make: () => BuildSteps<T>) => void;
  /**
   * Works on the build in flight for up to `budgetMs`, and returns its result if it
   * completed during this call (otherwise undefined).
   */
  step: (budgetMs: number) => T | undefined;
  /** Completes the build in flight now, and returns its result (undefined if none). */
  finish: () => T | undefined;
  /** Drops the build in flight. */
  cancel: () => void;
  /** The key being built, or undefined when idle. */
  readonly building: K | undefined;
  /** The key of the latest finished result, or undefined before the first. */
  readonly built: K | undefined;
}

export function createBackgroundBuild<K, T>(clock: Clock = defaultClock): BackgroundBuild<K, T> {
  let steps: BuildSteps<T> | null = null;
  let building: K | undefined;
  let built: K | undefined;
  let hasBuilt = false;
  const done = (value: T) => {
    built = building;
    hasBuilt = true;
    steps = null;
    building = undefined;
    return value;
  };
  return {
    request(key, make) {
      if (steps !== null && building === key) {
        return;
      }
      if (hasBuilt && built === key) {
        // Back to what's already built: whatever was in flight is no longer wanted.
        steps = null;
        building = undefined;
        return;
      }
      steps = make();
      building = key;
    },
    step(budgetMs) {
      if (steps === null) {
        return undefined;
      }
      const end = clock() + budgetMs;
      do {
        const r = steps.next();
        if (r.done === true) {
          return done(r.value);
        }
      } while (clock() < end);
      return undefined;
    },
    finish() {
      return steps === null ? undefined : done(finishBuild(steps));
    },
    cancel() {
      steps = null;
      building = undefined;
    },
    get building() {
      return building;
    },
    get built() {
      return built;
    },
  };
}
