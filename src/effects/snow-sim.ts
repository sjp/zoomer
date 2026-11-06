/**
 * Snow's flake simulation, kept free of GL so it can be tested: three depth
 * layers of flakes falling and drifting in a gusty wind, wrapping once fully
 * off-screen, and fading in or out on a count change. Positions are in reference
 * units (1 = 1080 device-independent pixels).
 */
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { createNoise, createRng } from "./noise";

/** Reference fall speed in px/s at 1080p for the middle layer at a speed of 1. */
export const FALL_PX = 70;
/** Reference horizontal drift in px/s at 1080p for a wind (or gust) of 1. */
export const WIND_PX = 120;
/** Reference sway amplitude in px at 1080p for a sway of 1. */
export const SWAY_PX = 28;
/** Seconds a flake takes to fade in when the flake count is raised. */
export const FADE_IN = 1.5;
const TAU = Math.PI * 2;

/**
 * Per depth layer (far, mid, near): size, fall pace, opacity, how much the
 * steady wind and the gusts push it, and how much of the flake count it gets.
 */
export const LAYERS = [
  { size: 0.5, pace: 0.5, alpha: 0.5, wind: 0.55, gust: 0.35, share: 0.5 },
  { size: 1, pace: 0.8, alpha: 0.85, wind: 0.8, gust: 0.65, share: 0.32 },
  { size: 2.3, pace: 1.3, alpha: 0.75, wind: 1, gust: 1, share: 0.18 },
] as const;

/** Edge softness of each layer's sprite for a given depth blur. Mid is in focus. */
export const layerSoftness = (layer: number, blur: number) =>
  layer === 0 ? 0.2 + blur * 0.3 : layer === 1 ? 0.12 + blur * 0.1 : 0.25 + blur * 0.75;

/** Sprite half-size beyond the flake radius and its soft edge, in radii. */
export const PAD_MARGIN = 0.05;
/**
 * Sprite half-size relative to the flake radius, leaving room for the soft edge.
 * The flake vertex shader computes the same from `PAD_MARGIN`.
 */
export const spritePad = (softness: number) => 1 + softness + PAD_MARGIN;

/** Floats per flake instance: centre x, centre y, half-width, half-height, opacity, softness. */
export const FLAKE_FLOATS = 6;

/** Per-frame inputs to `step`; reuse one object rather than allocating per frame. */
export interface FlakeFrame {
  /** Screen width in reference px, and device px per reference px. */
  refWidth: number;
  scale: number;
  /** Params: see snow.ts. */
  count: number;
  speed: number;
  wind: number;
  gustiness: number;
  sway: number;
  size: number;
  depthBlur: number;
  brightness: number;
}

export interface Flakes {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly layer: Uint8Array;
  readonly life: Float32Array;
  /** Flakes simulated: the count plus any still fading out after it dropped. */
  readonly live: number;
  /** First instance of the near layer in the last `step`, drawn in front of the mist. */
  readonly nearStart: number;
  /** Scales x positions by `k`, keeping flakes in place relative to a resized width. */
  rescaleX: (k: number) => void;
  /**
   * Advances `dt` seconds and writes the visible flakes to `data`, far layer
   * first, FLAKE_FLOATS at `stride` floats apart. Returns how many.
   */
  step: (dt: number, f: FlakeFrame, data: Float32Array, stride: number) => number;
}

export function createFlakes(max: number, initialWidth: number, seed = 0x5e0f): Flakes {
  const rng = createRng(seed);
  const noise = createNoise(seed);

  // Positions are in reference units (1 = 1080 device-independent pixels).
  const xs = new Float32Array(max);
  const ys = new Float32Array(max);
  const layer = new Uint8Array(max);
  const sizeJitter = new Float32Array(max);
  const paceJitter = new Float32Array(max);
  const shade = new Float32Array(max);
  const swayRate = new Float32Array(max);
  const swayPhase = new Float32Array(max);
  const tumbleRate = new Float32Array(max);
  const tumblePhase = new Float32Array(max);
  const life = new Float32Array(max);

  // Kept unwrapped so sway phases never jump; doubles stay precise for weeks.
  let time = 0;
  /** Items simulated: the count plus any still fading out after it dropped. */
  let live = 0;

  // Interleave layers by index so any flake count keeps the same proportions.
  const pattern: number[] = [];
  for (let l = 0; l < LAYERS.length; l++) {
    for (let k = 0; k < Math.round(LAYERS[l].share * 50); k++) {
      pattern.push(l);
    }
  }
  for (let i = pattern.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pattern[i], pattern[j]] = [pattern[j], pattern[i]];
  }

  for (let i = 0; i < max; i++) {
    layer[i] = pattern[i % pattern.length];
    xs[i] = rng() * initialWidth;
    ys[i] = rng() * 1080;
    sizeJitter[i] = 0.7 + rng() * 0.6;
    paceJitter[i] = 0.8 + rng() * 0.4;
    shade[i] = 0.7 + rng() * 0.3;
    swayRate[i] = TAU * (0.12 + rng() * 0.22);
    swayPhase[i] = rng() * TAU;
    tumbleRate[i] = (0.4 + rng() * 0.8) * (rng() < 0.5 ? -1 : 1);
    tumblePhase[i] = rng() * TAU;
  }

  let nearStart = 0;

  return {
    xs,
    ys,
    layer,
    life,
    get live() {
      return live;
    },
    get nearStart() {
      return nearStart;
    },
    rescaleX(k) {
      for (let i = 0; i < max; i++) {
        xs[i] *= k;
      }
    },
    step(dt, f, data, stride) {
      time += dt;
      const { refWidth, scale } = f;
      const target = Math.min(Math.floor(f.count), max);
      const n = (live = growLive(life, live, target));
      const fadeStep = dt / FADE_IN;
      const outStep = dt / FADE_OUT;

      // One slow, smooth gust signal shared by the whole scene.
      const gust = noise.noise2(time * 0.07, 0.5) * 0.7 + noise.noise2(time * 0.19, 9.3) * 0.3;
      const gustPx = gust * f.gustiness * WIND_PX * 1.4;
      const windPx = f.wind * WIND_PX;
      const fallPx = f.speed * FALL_PX;
      const swayPx = f.sway * SWAY_PX;

      let visible = 0;
      nearStart = 0;
      for (let l = 0; l < LAYERS.length; l++) {
        if (l === 2) {
          nearStart = visible;
        }
        const L = LAYERS[l];
        const softness = layerSoftness(l, f.depthBlur);
        const pad = spritePad(softness);
        const baseRadius = f.size * L.size;
        const amp = swayPx * (0.5 + L.size * 0.4);
        // Wrap once fully off-screen (including sway), so the jump is never visible.
        const margin = (baseRadius * pad + amp) * 1.3;
        const spanX = refWidth + margin * 2;
        const spanY = 1080 + margin * 2;
        const vxLayer = windPx * L.wind;
        const alphaLayer = L.alpha * f.brightness;

        for (let i = 0; i < n; i++) {
          if (layer[i] !== l) {
            continue;
          }

          // A little local variation so the flakes don't move as one sheet.
          const local = noise.noise2(xs[i] * 0.0007 + time * 0.05, ys[i] * 0.0009);
          const vx = vxLayer + gustPx * L.gust * (1 + local * 0.4);
          const vy = fallPx * L.pace * paceJitter[i];
          let x = xs[i] + vx * dt;
          let y = ys[i] + vy * dt;
          if (x < -margin) {
            x += spanX;
          } else if (x > refWidth + margin) {
            x -= spanX;
          }
          if (y > 1080 + margin) {
            y -= spanY;
            x = -margin + rng() * spanX;
          } else if (y < -margin) {
            y += spanY;
          }
          xs[i] = x;
          ys[i] = y;

          const life01 = stepLife(life, i, target, fadeStep, outStep);

          // Tumbling: the flake turns edge-on now and then, narrowing and dimming.
          const tumble = Math.cos(time * tumbleRate[i] + tumblePhase[i]);
          const turn = 0.8 + 0.2 * Math.abs(tumble);
          const alpha = alphaLayer * shade[i] * (0.85 + 0.15 * turn) * life01 * life01;
          if (alpha <= 0.003) {
            continue;
          }

          const sx = x + Math.sin(time * swayRate[i] + swayPhase[i]) * amp * sizeJitter[i];
          const half = baseRadius * sizeJitter[i] * pad * scale;
          const o = visible * stride;
          data[o] = sx * scale;
          data[o + 1] = y * scale;
          data[o + 2] = half * turn;
          data[o + 3] = half;
          data[o + 4] = Math.min(1, alpha);
          data[o + 5] = softness;
          visible++;
        }
      }

      live = trimLive(life, live, target);
      return visible;
    },
  };
}
