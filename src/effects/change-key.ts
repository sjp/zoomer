/**
 * The inputs a cached result (a lookup table, an upload) was last built from, so
 * the work can be skipped while none of them changes. Each frame, write every
 * input with `set(index, value)`, then call `take()`: it returns true when any
 * input differs from the last frame (or on first use, or after `invalidate()`)
 * and clears the flag. Allocates nothing after creation.
 */
export interface ChangeKey {
  set: (index: number, value: number) => void;
  /** Whether anything changed since the last `take()`; clears the flag. */
  take: () => boolean;
  /** Forces the next `take()` to return true. */
  invalidate: () => void;
}

export function createChangeKey(length: number): ChangeKey {
  const values = new Float64Array(length);
  let dirty = true;
  return {
    set(index, value) {
      if (values[index] !== value) {
        values[index] = value;
        dirty = true;
      }
    },
    take() {
      const was = dirty;
      dirty = false;
      return was;
    },
    invalidate() {
      dirty = true;
    },
  };
}
