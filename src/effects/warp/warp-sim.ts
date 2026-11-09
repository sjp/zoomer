/**
 * Warp's starfield simulation, kept free of GL so it can be tested: stars fly
 * towards the camera from depth 1, are projected to streaks, and respawn at the
 * back once they pass the camera or leave the screen.
 *
 * A negative speed runs it backwards, for a camera looking back the way it
 * came: stars come in from just outside the screen's edge, drift in towards
 * the centre as they recede, fade with depth and respawn at an edge once they
 * reach the back.
 */
import type { Rgb } from "../color";
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";
import { STREAK_FLOATS } from "../streaks";

/** Seconds a star added by a higher count takes to fade in. */
export const FADE_IN = 0.8;
/** Depth at which a star has passed the camera and respawns. */
export const NEAR_Z = 0.01;
/** Nearest and farthest depth at which a receding star comes in at the edge. */
const EDGE_NEAR = 0.1;
export const EDGE_FAR = 0.7;

/** Per-frame inputs to `step`; reuse one object rather than allocating per frame. */
export interface StarFrame {
  width: number;
  height: number;
  scale: number;
  /** Params: see warp.ts. Negative runs the stars backwards, receding. */
  speed: number;
  count: number;
  streak: number;
  size: number;
  tintAmount: number;
  star: Rgb;
  tint: Rgb;
}

interface Starfield {
  /**
   * Star positions (x, y, in units of the focal length at depth 1) and depth
   * (0, 1]; colour mix and count-fade life. Filled on the first step.
   */
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  readonly life: Float32Array;
  /** Stars simulated: the count plus any still fading out after it dropped. */
  readonly live: number;
  /** Advances `dt` seconds and writes the visible streaks to `data`. Returns how many. */
  step: (dt: number, f: StarFrame, data: Float32Array) => number;
}

export function createStarfield(max: number, random: () => number): Starfield {
  const xs = new Float32Array(max);
  const ys = new Float32Array(max);
  const zs = new Float32Array(max);
  const mix = new Float32Array(max);
  const life = new Float32Array(max);
  let live = 0;
  /** Half the kept view (screen plus margin) at depth 1, in star units; set each step. */
  let spanX = 1;
  let spanY = 1;
  /** False until the first step, which fills the field for the screen it sees. */
  let primed = false;

  /** Spawns star `i` at depth `z`, somewhere in view. */
  const spawn = (i: number, z: number) => {
    xs[i] = (random() * 2 - 1) * spanX * z;
    ys[i] = (random() * 2 - 1) * spanY * z;
    zs[i] = z;
    mix[i] = random();
  };
  /** Respawns star `i` just outside the screen's edge, ready to recede in. */
  const spawnAtEdge = (i: number, w: number, h: number, focal: number, inset: number) => {
    const z = EDGE_NEAR + (EDGE_FAR - EDGE_NEAR) * random();
    let u = random() * 2 * (w + h);
    let ex: number;
    let ey: number;
    if (u < w) {
      ex = u;
      ey = -inset;
    } else if ((u -= w) < w) {
      ex = u;
      ey = h + inset;
    } else if ((u -= w) < h) {
      ex = -inset;
      ey = u;
    } else {
      ex = w + inset;
      ey = u - h;
    }
    xs[i] = ((ex - w / 2) * z) / focal;
    ys[i] = ((ey - h / 2) * z) / focal;
    zs[i] = z;
    mix[i] = random();
  };

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
      const reverse = dz < 0;
      spanX = (cx + margin) / focal;
      spanY = (cy + margin) / focal;
      if (!primed) {
        // Mid-flight, as the field settles into: stars spawned at the back
        // across the view, then thinned towards the camera as they leave it
        // (depth density 3z^2).
        primed = true;
        for (let i = 0; i < max; i++) {
          spawn(i, Math.max(NEAR_Z, Math.cbrt(random())));
        }
      }

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
        } else if (reverse && z >= 1) {
          spawnAtEdge(i, width, height, focal, margin / 2);
          z = zs[i];
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
          // Receding stars drift in from off screen, so they are kept.
          if (!reverse) {
            spawn(i, 1);
          }
          continue;
        }
        const fzt = focal / (z + tail);
        const depth = 1 - z;
        const alpha = Math.min(1, depth * 1.6) * l;
        if (alpha <= 0) {
          continue;
        }
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
