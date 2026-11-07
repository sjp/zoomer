/**
 * Bokeh's light simulation, kept free of GL so it can be tested: lights drift and
 * wander, wrap once fully off-screen, and fade in or out on a count change.
 * Positions are in reference units (1 = 1080 device-independent pixels).
 */
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";
import { wrap } from "../math";

/** Off-screen margin before a light wraps, relative to its radius. */
export const SPRITE_PAD = 1.25;
/** Reference drift speed in px/s at 1080p for a speed of 1. */
export const DRIFT_PX = 18;
/** Seconds a light takes to fade in after (re)appearing. */
export const FADE_IN = 2;
/** Floats per light instance: centre x, centre y, radius (device px), opacity, colour index. */
export const LIGHT_FLOATS = 5;
const TAU = Math.PI * 2;

/** Per-frame inputs to `step`; reuse one object rather than allocating per frame. */
export interface LightFrame {
  /** Screen width in reference px, and device px per reference px. */
  refWidth: number;
  scale: number;
  /** Lights wanted (see `bokehLightCount`). */
  target: number;
  /** Params: see bokeh.ts. */
  size: number;
  sizeVariation: number;
  direction: number;
  speed: number;
  wander: number;
  twinkle: number;
  brightness: number;
}

export interface Lights {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly life: Float32Array;
  /** Lights simulated: the target plus any still fading out after it dropped. */
  readonly live: number;
  /** Scales x positions by `k`, keeping lights in place relative to a resized width. */
  rescaleX: (k: number) => void;
  /**
   * Advances `dt` seconds and writes the visible lights to `data`, LIGHT_FLOATS
   * at `stride` floats apart. Returns how many.
   */
  step: (dt: number, f: LightFrame, data: Float32Array, stride: number) => number;
}

export function createLights(
  max: number,
  refWidth: number,
  random: () => number = Math.random,
): Lights {
  const xs = new Float32Array(max);
  const ys = new Float32Array(max);
  /** 0 = far/small, 1 = near/large. */
  const depth = new Float32Array(max);
  const hue = new Uint8Array(max);
  const heading = new Float32Array(max);
  const turnRate = new Float32Array(max);
  const turnPhase = new Float32Array(max);
  const twinkleRate = new Float32Array(max);
  const twinklePhase = new Float32Array(max);
  const life = new Float32Array(max);
  // Kept unwrapped: a wrap would jump every phase at once; doubles stay precise for weeks.
  let time = 0;
  let live = 0;

  for (let i = 0; i < max; i++) {
    xs[i] = random() * refWidth;
    ys[i] = random() * 1080;
    depth[i] = random();
    hue[i] = i % 3;
    heading[i] = random() * TAU;
    turnRate[i] = 0.05 + random() * 0.15;
    turnPhase[i] = random() * TAU;
    twinkleRate[i] = 0.3 + random() * 0.9;
    twinklePhase[i] = random() * TAU;
  }

  return {
    xs,
    ys,
    life,
    get live() {
      return live;
    },
    rescaleX(k) {
      for (let i = 0; i < max; i++) {
        xs[i] *= k;
      }
    },
    step(dt, f, data, stride) {
      time += dt;
      const { refWidth: w, scale, target } = f;
      const n = (live = growLive(life, live, target));

      const dir = (f.direction * Math.PI) / 180;
      const driftX = Math.cos(dir) * f.speed * DRIFT_PX;
      const driftY = -Math.sin(dir) * f.speed * DRIFT_PX;
      const wanderPx = f.wander * DRIFT_PX * 0.9;
      const spread = f.sizeVariation * 1.1;
      const fadeStep = dt / FADE_IN;
      const outStep = dt / FADE_OUT;

      let visible = 0;
      for (let i = 0; i < n; i++) {
        const z = depth[i];
        const e = spread * (z * 2 - 1);
        const radius = f.size * Math.exp(e);
        const pace = 0.45 + z * 0.9;

        heading[i] += Math.sin(time * turnRate[i] + turnPhase[i]) * dt * 0.6;
        const x = xs[i] + (driftX * pace + Math.cos(heading[i]) * wanderPx * pace) * dt;
        const y = ys[i] + (driftY * pace + Math.sin(heading[i]) * wanderPx * pace) * dt;
        // Wrap once fully off-screen, so the jump is never visible.
        const margin = radius * SPRITE_PAD;
        xs[i] = wrap(x, -margin, w + margin * 2);
        ys[i] = wrap(y, -margin, 1080 + margin * 2);

        const l = stepLife(life, i, target, fadeStep, outStep);

        const tw = 0.5 + 0.5 * Math.sin(time * twinkleRate[i] + twinklePhase[i]);
        const pulse = 1 - f.twinkle * 0.6 * tw;
        // Nearer, larger discs spread their light wider and look fainter.
        const alpha = 0.75 * Math.exp(-0.6 * e) * pulse * f.brightness * l * l;
        if (alpha <= 0.002) {
          continue;
        }
        const o = visible * stride;
        data[o] = xs[i] * scale;
        data[o + 1] = ys[i] * scale;
        data[o + 2] = radius * scale;
        data[o + 3] = Math.min(1, alpha);
        data[o + 4] = hue[i];
        visible++;
      }

      live = trimLive(life, live, target);
      return visible;
    },
  };
}
