/**
 * The flow field's noise, baked into a small lattice so particles read it with a
 * cheap bilinear lookup instead of evaluating 3D simplex noise each per frame.
 *
 * The lattice is anchored at the noise-space origin with `FIELD_RES` samples per
 * noise unit, and covers the rectangle the particles can occupy. Time (the noise's
 * z axis) is sliced every `FIELD_DZ`: the table keeps the slices either side of the
 * current time and blends them once per frame, so the field scrolls smoothly
 * through time, while the slice after those is built a few rows per frame, so the
 * noise cost is spread out rather than spiking when time crosses a slice.
 *
 * The interpolated noise is within about 0.007 of the exact value on average (0.035
 * at worst) on a [-1, 1] range, so the flow looks the same. At the default detail
 * the lattice is about 50 x 30 samples; at the maximum detail on a 32:9 screen
 * about 400 x 120. Building a slice costs one noise evaluation per sample, every
 * FIELD_DZ / (time rate) seconds (1.6 s at the default change speed), against one
 * per particle per frame before; the per-frame blend is one multiply-add per sample.
 */

/** Lattice samples per noise unit, in x and y. */
export const FIELD_RES = 16;
/** Noise-time units between baked slices. */
export const FIELD_DZ = 1 / 16;

export type Noise3 = (x: number, y: number, z: number) => number;

interface FlowField {
  /**
   * Fits the lattice to noise-space `[x0, x1] x [y0, y1]` and the field to noise
   * time `time`, rebuilding what changed. A new `noise` function (a new seed) or
   * cover rebuilds everything; a time step blends the current slices and builds a
   * little more of the next one. Allocates only when the lattice grows.
   */
  update: (noise: Noise3, x0: number, y0: number, x1: number, y1: number, time: number) => void;
  /**
   * The noise at noise-space (x, y) and the last `update` time, bilinearly
   * interpolated. Points outside the cover read its nearest edge.
   */
  sample: (x: number, y: number) => number;
}

export function createFlowField(): FlowField {
  let noise: Noise3 | undefined;
  /** Lattice origin (in samples) and size. */
  let gx0 = 0;
  let gy0 = 0;
  let cols = 0;
  let rows = 0;
  /** Slices at baseK * DZ (a), (baseK + 1) * DZ (b) and, being built, (baseK + 2) * DZ (c). */
  let a = new Float32Array(0);
  let b = new Float32Array(0);
  let c = new Float32Array(0);
  /** The blend of a and b at the last update time, read by `sample`. */
  let blend = new Float32Array(0);
  let baseK = 0;
  /** Rows of c built so far. */
  let cRows = 0;
  let blendT = Number.NaN;

  const fillRows = (out: Float32Array, k: number, from: number, to: number) => {
    const fn = noise;
    if (!fn) {
      return;
    }
    const z = k * FIELD_DZ;
    for (let j = from; j < to; j++) {
      const y = (gy0 + j) / FIELD_RES;
      const o = j * cols;
      for (let i = 0; i < cols; i++) {
        out[o + i] = fn((gx0 + i) / FIELD_RES, y, z);
      }
    }
  };

  return {
    update(fn, x0, y0, x1, y1, time) {
      const nx0 = Math.floor(x0 * FIELD_RES);
      const ny0 = Math.floor(y0 * FIELD_RES);
      const nCols = Math.max(2, Math.ceil(x1 * FIELD_RES) - nx0 + 1);
      const nRows = Math.max(2, Math.ceil(y1 * FIELD_RES) - ny0 + 1);
      const k = Math.floor(time / FIELD_DZ);
      let rebuilt = false;
      if (
        fn !== noise ||
        nx0 !== gx0 ||
        ny0 !== gy0 ||
        nCols !== cols ||
        nRows !== rows ||
        k < baseK ||
        k > baseK + 1
      ) {
        noise = fn;
        gx0 = nx0;
        gy0 = ny0;
        cols = nCols;
        rows = nRows;
        const n = cols * rows;
        if (a.length < n) {
          a = new Float32Array(n);
          b = new Float32Array(n);
          c = new Float32Array(n);
          blend = new Float32Array(n);
        }
        baseK = k;
        fillRows(a, k, 0, rows);
        fillRows(b, k + 1, 0, rows);
        cRows = 0;
        rebuilt = true;
      } else if (k === baseK + 1) {
        // Crossed into the next slice: finish it and rotate the slices.
        fillRows(c, baseK + 2, cRows, rows);
        const old = a;
        a = b;
        b = c;
        c = old;
        baseK = k;
        cRows = 0;
        rebuilt = true;
      }

      const t = time / FIELD_DZ - baseK;
      // Build the next slice in step with time, a row ahead, so it is ready in time.
      const due = Math.min(rows, Math.ceil(t * rows) + 1);
      if (due > cRows) {
        fillRows(c, baseK + 2, cRows, due);
        cRows = due;
      }

      if (rebuilt || t !== blendT) {
        blendT = t;
        const n = cols * rows;
        for (let i = 0; i < n; i++) {
          blend[i] = a[i] + (b[i] - a[i]) * t;
        }
      }
    },

    sample(x, y) {
      let fx = x * FIELD_RES - gx0;
      let fy = y * FIELD_RES - gy0;
      const maxX = cols - 1;
      const maxY = rows - 1;
      fx = fx < 0 ? 0 : fx > maxX ? maxX : fx;
      fy = fy < 0 ? 0 : fy > maxY ? maxY : fy;
      let ix = Math.floor(fx);
      let iy = Math.floor(fy);
      if (ix > maxX - 1) {
        ix = maxX - 1;
      }
      if (iy > maxY - 1) {
        iy = maxY - 1;
      }
      const tx = fx - ix;
      const ty = fy - iy;
      const o = iy * cols + ix;
      const v00 = blend[o];
      const v10 = blend[o + 1];
      const v01 = blend[o + cols];
      const v11 = blend[o + cols + 1];
      const top = v00 + (v10 - v00) * tx;
      const bottom = v01 + (v11 - v01) * tx;
      return top + (bottom - top) * ty;
    },
  };
}
