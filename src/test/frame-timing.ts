import { defaults } from "../effects/params";
import type { AnyParamValues, EffectWebGL2, Viewport } from "../effects/types";
import { createFakeGl } from "./fake-gl";

export const viewport = (width: number, height: number): Viewport => ({
  width,
  height,
  scale: height / 1080,
});

export interface TimedRun {
  /** CPU milliseconds each `frame` call took, in order. */
  times: number[];
  /** The slowest frame from `from` (an index into `times`) on. */
  worst: (from?: number) => number;
}

/**
 * Runs `effect` on the fake GL context (so only CPU work is timed) for `frames`
 * frames of `dt` seconds, calling `script(i)` before each frame to get its params
 * and, optionally, a new viewport.
 */
export function timeFrames(
  effect: EffectWebGL2,
  frames: number,
  dt: number,
  script: (
    i: number,
    base: AnyParamValues,
  ) => { params?: AnyParamValues; viewport?: Viewport } = () => ({}),
  start: Viewport = viewport(1920, 1080),
): TimedRun {
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
  return {
    times,
    worst: (from = 0) => Math.max(0, ...times.slice(from)),
  };
}
