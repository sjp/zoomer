/**
 * Digital rain's column simulation, kept free of GL so it can be tested: each
 * column has a current drop and the previous one, whose trail can still be fading
 * below the current drop's head. `step` advances them and writes one instance per
 * visible drop (see `rain.ts`'s VERTEX for the layout).
 */

/** Floats per drop instance: column, head (rows), fall rate (rows/s), seed, first row, end row. */
export const DROP_FLOATS = 6;

/**
 * `a` if it already holds `n` elements, else a new array of the same type and
 * length `n` whose first `keep` elements are copied from `a` (the rest zero).
 */
export function growArray(
  a: Float32Array<ArrayBuffer>,
  n: number,
  keep: number,
): Float32Array<ArrayBuffer>;
export function growArray(
  a: Uint8Array<ArrayBuffer>,
  n: number,
  keep: number,
): Uint8Array<ArrayBuffer>;
export function growArray(
  a: Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer>,
  n: number,
  keep: number,
): Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer> {
  if (a.length >= n) {
    return a;
  }
  const b = a instanceof Float32Array ? new Float32Array(n) : new Uint8Array(n);
  b.set(a.subarray(0, Math.min(keep, a.length)));
  return b;
}

/**
 * Rows `[first, end)` a drop with its head at `head` (rows) still lights: from
 * `lead` rows above the head minus the trail (`trailAge` seconds at `rate` rows/s),
 * not above `minRow`, down to the head's row, clipped to the grid. Empty
 * (`end <= first`) once the whole drop has passed or faded.
 */
export function dropRows(
  out: Float64Array,
  head: number,
  rate: number,
  lead: number,
  trailAge: number,
  minRow: number,
  rows: number,
): void {
  out[0] = Math.max(minRow, Math.floor(head - lead - trailAge * rate));
  out[1] = Math.min(rows, Math.floor(head) + 1);
}

export interface RainSim {
  readonly cols: number;
  readonly rows: number;
  /** Current and previous drop per column: head row, pace, glyph seed, active flag. */
  readonly heads: Float32Array;
  readonly pace: Float32Array;
  readonly active: Uint8Array;
  readonly prevHeads: Float32Array;
  readonly prevActive: Uint8Array;
  /**
   * Fits the grid to `cols` x `rows`. With `restart` (a new cell size) every column
   * is re-scattered; otherwise (a resize) the columns already on screen keep
   * falling and only newly exposed ones are scattered, so dragging the window
   * edge doesn't restart the rain.
   */
  layout: (cols: number, rows: number, density: number, restart: boolean) => void;
  /**
   * Advances every drop by `dt` seconds at `speed` rows per second (times its
   * pace), starting a new drop in a column once the current one is well past the
   * bottom, and writes the visible drops into `data` (at most `2 * cols`
   * instances of DROP_FLOATS, at `stride` floats apart). Returns how many it wrote.
   */
  step: (
    dt: number,
    speed: number,
    density: number,
    lead: number,
    trailAge: number,
    data: Float32Array,
    stride: number,
  ) => number;
}

export function createRainSim(random: () => number): RainSim {
  let cols = 0;
  let rows = 0;
  let heads = new Float32Array(0);
  let pace = new Float32Array(0);
  let seed = new Float32Array(0);
  let active = new Uint8Array(0);
  let prevHeads = new Float32Array(0);
  let prevPace = new Float32Array(0);
  let prevSeed = new Float32Array(0);
  let prevActive = new Uint8Array(0);
  const span = new Float64Array(2);
  // The current step's output and trail, read by `emit`.
  let out: Float32Array = new Float32Array(0);
  let stride = DROP_FLOATS;
  let emitted = 0;
  let lead = 0;
  let trailAge = 0;

  /** Appends one drop instance covering its still-visible rows from `minRow` down. */
  const emit = (c: number, head: number, rate: number, s: number, minRow: number) => {
    dropRows(span, head, rate, lead, trailAge, minRow, rows);
    if (span[0] >= span[1]) {
      return;
    }
    const o = emitted++ * stride;
    out[o] = c;
    out[o + 1] = head;
    out[o + 2] = rate;
    out[o + 3] = s;
    out[o + 4] = span[0];
    out[o + 5] = span[1];
  };

  const resetColumn = (c: number, density: number, scatter: boolean) => {
    heads[c] = -random() * rows * (scatter ? 1.5 : 0.5);
    pace[c] = 0.6 + random() * 0.8;
    seed[c] = Math.floor(random() * 65536);
    active[c] = random() < density ? 1 : 0;
  };

  return {
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    get heads() {
      return heads;
    },
    get pace() {
      return pace;
    },
    get active() {
      return active;
    },
    get prevHeads() {
      return prevHeads;
    },
    get prevActive() {
      return prevActive;
    },
    layout(newCols, newRows, density, restart) {
      const keep = restart ? 0 : cols;
      cols = newCols;
      rows = newRows;
      heads = growArray(heads, cols, keep);
      pace = growArray(pace, cols, keep);
      seed = growArray(seed, cols, keep);
      active = growArray(active, cols, keep);
      prevHeads = growArray(prevHeads, cols, keep);
      prevPace = growArray(prevPace, cols, keep);
      prevSeed = growArray(prevSeed, cols, keep);
      prevActive = growArray(prevActive, cols, keep);
      for (let c = Math.min(keep, cols); c < cols; c++) {
        resetColumn(c, density, true);
        prevActive[c] = 0;
      }
    },
    step(dt, speed, density, headRows, trailSeconds, data, dataStride) {
      out = data;
      stride = dataStride;
      lead = headRows;
      trailAge = trailSeconds;
      emitted = 0;
      for (let c = 0; c < cols; c++) {
        heads[c] += dt * speed * pace[c];
        prevHeads[c] += dt * speed * prevPace[c];
        if (Math.floor(heads[c]) > rows + rows * 0.3 * pace[c]) {
          prevHeads[c] = heads[c];
          prevPace[c] = pace[c];
          prevSeed[c] = seed[c];
          prevActive[c] = active[c];
          resetColumn(c, density, false);
        }
        const head = heads[c];
        if (active[c]) {
          emit(c, head, speed * pace[c], seed[c], 0);
        }
        if (prevActive[c]) {
          // The current drop repaints the cells it has passed.
          const minRow = active[c] ? Math.max(0, Math.floor(head) + 1) : 0;
          emit(c, prevHeads[c], speed * prevPace[c], prevSeed[c], minRow);
        }
      }
      return emitted;
    },
  };
}
