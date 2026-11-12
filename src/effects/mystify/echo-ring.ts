/**
 * A fixed-size history of samples, newest first, for drawing echo trails: each
 * sample is `stride` floats (an outline's vertices, its colour, ...) in one flat
 * array. Pushing past the capacity overwrites the oldest sample. Allocation-free
 * after creation.
 */
interface EchoRing {
  readonly capacity: number;
  readonly stride: number;
  /** Samples held, up to `capacity`. */
  readonly count: number;
  /** All samples; read sample `k` at `offset(k)`. */
  readonly data: Float32Array;
  /**
   * Makes room for a new newest sample (dropping the oldest when full) and
   * returns its offset in `data`, for the caller to fill.
   */
  push: () => number;
  /** Offset in `data` of the `k`-th newest sample: 0 is the newest. `k` must be below `count`. */
  offset: (k: number) => number;
  /** Forgets every sample. */
  clear: () => void;
}

export function createEchoRing(capacity: number, stride: number): EchoRing {
  const cap = Math.max(1, Math.floor(capacity));
  const data = new Float32Array(cap * stride);
  /** Slot of the newest sample. */
  let head = cap - 1;
  let count = 0;
  return {
    capacity: cap,
    stride,
    data,
    get count() {
      return count;
    },
    push() {
      head = head + 1 < cap ? head + 1 : 0;
      if (count < cap) {
        count++;
      }
      return head * stride;
    },
    offset(k) {
      const slot = head - k;
      return (slot < 0 ? slot + cap : slot) * stride;
    },
    clear() {
      head = cap - 1;
      count = 0;
    },
  };
}
