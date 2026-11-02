/**
 * Warp's starfield simulation, kept free of GL so it can be tested: stars fly
 * towards the camera from depth 1, are projected to streaks, and respawn at the
 * back once they pass the camera or leave the screen.
 */
import type { Rgb } from "./color";
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { STREAK_FLOATS } from "./streaks";

/** Seconds a star added by a higher count takes to fade in. */
export const FADE_IN = 0.8;
/** Depth at which a star has passed the camera and respawns. */
export const NEAR_Z = 0.01;

/** Per-frame inputs to `step`; reuse one object rather than allocating per frame. */
export interface StarFrame {
  width: number;
  height: number;
  scale: number;
  /** Params: see warp.ts. */
  speed: number;
  count: number;
  streak: number;
  size: number;
  tintAmount: number;
  star: Rgb;
  tint: Rgb;
}

export interface Starfield {
  /** Star positions in [-1, 1] (x, y) and depth (0, 1]; colour mix and count-fade life. */
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  readonly life: Float32Array;
  /** Stars simulated: the count plus any still fading out after it dropped. */
  readonly live: number;
  /** Advances `dt` seconds and writes the visible streaks to `data`. Returns how many. */
  step(dt: number, f: StarFrame, data: Float32Array): number;
}

export function createStarfield(max: number, random: () => number = Math.random): Starfield {
  const xs = new Float32Array(max);
  const ys = new Float32Array(max);
  const zs = new Float32Array(max);
  const mix = new Float32Array(max);
  const life = new Float32Array(max);
  let live = 0;

  const spawn = (i: number, z: number) => {
    xs[i] = random() * 2 - 1;
    ys[i] = random() * 2 - 1;
    zs[i] = z;
    mix[i] = random();
  };
  for (let i = 0; i < max; i++) spawn(i, random());

  return {
    xs,
    ys,
    zs,
    life,
    get live() {
      return live;
    },
    step(dt, f, data) {
      const { width, height, scale } = f;
      const cx = width / 2;
      const cy = height / 2;
      const focal = Math.max(width, height) / 2;
      const dz = f.speed * dt * 0.25;
      const tail = f.streak * f.speed * 0.03;
      const sr = f.star[0];
      const sg = f.star[1];
      const sb = f.star[2];
      const tr = f.tint[0];
      const tg = f.tint[1];
      const tb = f.tint[2];
      const margin = 50 * scale;
      const sizePx = f.size * scale;

      const target = Math.min(Math.floor(f.count), max);
      const n = (live = growLive(life, live, target));
      const fadeStep = dt / FADE_IN;
      const outStep = dt / FADE_OUT;
      let count = 0;
      for (let i = 0; i < n; i++) {
        let z = zs[i] - dz;
        if (z <= NEAR_Z) {
          spawn(i, 1);
          z = 1;
        }
        zs[i] = z;
        // Added stars appear mid-flight, so they fade in rather than pop.
        const l = stepLife(life, i, target, fadeStep, outStep);

        const x = xs[i];
        const y = ys[i];
        const fz = focal / z;
        const hx = cx + x * fz;
        const hy = cy + y * fz;
        if (hx < -margin || hx > width + margin || hy < -margin || hy > height + margin) {
          spawn(i, 1);
          continue;
        }
        const fzt = focal / (z + tail);
        const depth = 1 - z;
        const alpha = Math.min(1, depth * 1.6) * l;
        if (alpha <= 0) continue;
        const t = mix[i] * f.tintAmount;
        const o = count * STREAK_FLOATS;
        data[o] = cx + x * fzt;
        data[o + 1] = cy + y * fzt;
        data[o + 2] = hx;
        data[o + 3] = hy;
        data[o + 4] = (sr + (tr - sr) * t) * alpha;
        data[o + 5] = (sg + (tg - sg) * t) * alpha;
        data[o + 6] = (sb + (tb - sb) * t) * alpha;
        data[o + 7] = Math.max(0.5, sizePx * (0.2 + depth)) / 2;
        count++;
      }
      live = trimLive(life, live, target);
      return count;
    },
  };
}
