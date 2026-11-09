import { hexToRgb } from "./color";

/**
 * The inputs a cached result (a lookup table, an upload) was last built from, so
 * the work can be skipped while none of them changes. Each frame, write every
 * input with `set(index, value)`, then call `take()`: it returns true when any
 * input differs from the last frame (or on first use, or after `invalidate()`)
 * and clears the flag. Allocates nothing after creation.
 */
export interface ChangeKey {
  set: (index: number, value: number) => void;
  /**
   * Sets an input from a string, such as a select param's value. Meant for small
   * fixed sets of strings: each distinct one is remembered for good.
   */
  setText: (index: number, value: string) => void;
  /**
   * Sets an input from a `#rrggbb` colour, as its packed RGB value. The string is
   * parsed only when it differs from the last one set at this index.
   */
  setColor: (index: number, hex: string) => void;
  /**
   * Sets an input from free text, such as a text param: any string at all, which
   * `setText` would remember for good. Compared with the last string set at this
   * index, so the steady case costs one comparison.
   */
  setString: (index: number, value: string) => void;
  /** Whether anything changed since the last `take()`; clears the flag. */
  take: () => boolean;
  /** Forces the next `take()` to return true. */
  invalidate: () => void;
}

/** Each string passed to `setText`, numbered in the order first seen. */
const textIds = new Map<string, number>();

export function createChangeKey(length: number): ChangeKey {
  const values = new Float64Array(length);
  const strings: (string | undefined)[] = Array.from({ length });
  let dirty = true;
  const set = (index: number, value: number) => {
    if (values[index] !== value) {
      values[index] = value;
      dirty = true;
    }
  };
  return {
    set,
    setText(index, value) {
      let id = textIds.get(value);
      if (id === undefined) {
        id = textIds.size;
        textIds.set(value, id);
      }
      set(index, id);
    },
    setColor(index, hex) {
      if (strings[index] !== hex) {
        strings[index] = hex;
        const [r, g, b] = hexToRgb(hex);
        set(index, (r << 16) | (g << 8) | b);
      }
    },
    setString(index, value) {
      if (strings[index] !== value) {
        strings[index] = value;
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
