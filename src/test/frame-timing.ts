import { defaults } from "../effects/params";
import type { AnyParamValues, EffectDefinition, Viewport } from "../effects/types";
import { createFakeGl } from "./fake-gl";

const viewport = (width: number, height: number): Viewport => ({
  width,
  height,
  scale: height / 1080,
});

interface TimedRun {
  /** CPU milliseconds each `frame` call took, in order. */
  times: number[];
  /** The slowest frame from `from` (an index into `times`) on. */
  worst: (from?: number) => number;
}

/**
 * Frame timing for `*.perf.test.ts` files, which `npm run test:perf` runs one at a
 * time: wall-clock times are only meaningful without other test files competing
 * for the machine.
 *
 * Runs `effect` on the fake GL context (so only CPU work is timed) for `frames`
 * frames of `dt` seconds, calling `script(i)` before each frame to get its params
 * and, optionally, a new viewport. The run is repeated and each frame keeps its
 * fastest time: a stall built into the effect hits the same frame every run, while
 * a garbage-collection pause or first-run compilation lands on different frames.
 */
export function timeFrames(
  effect: EffectDefinition,
  frames: number,
  dt: number,
  script: (
    i: number,
    base: AnyParamValues,
  ) => { params?: AnyParamValues; viewport?: Viewport } = () => ({}),
  start: Viewport = viewport(1920, 1080),
): TimedRun {
  const times = runFrames(effect, frames, dt, script, start);
  for (let run = 1; run < RUNS; run++) {
    const again = runFrames(effect, frames, dt, script, start);
    for (let i = 0; i < frames; i++) {
      times[i] = Math.min(times[i], again[i]);
    }
  }
  return {
    times,
    worst: (from = 0) => Math.max(0, ...times.slice(from)),
  };
}

/** How many times `timeFrames` repeats a run. */
const RUNS = 3;

function runFrames(
  effect: EffectDefinition,
  frames: number,
  dt: number,
  script: (i: number, base: AnyParamValues) => { params?: AnyParamValues; viewport?: Viewport },
  start: Viewport,
): number[] {
  const fake = createFakeGl({ extensions: ["EXT_color_buffer_float"] });
  const instance = effect.create(fake.gl);
  const base = defaults(effect.params);
  const times: number[] = [];
  instance.resize(start);
  let params = base;
  try {
    for (let i = 0; i < frames; i++) {
      const step = script(i, base);
      params = step.params ?? params;
      if (step.viewport) {
        instance.resize(step.viewport);
      }
      const t0 = performance.now();
      instance.frame(dt, params);
      times.push(performance.now() - t0);
    }
  } finally {
    instance.dispose?.();
  }
  return times;
}
