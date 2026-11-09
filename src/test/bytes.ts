/**
 * Where two typed arrays first differ, comparing their bytes: -1 when they hold the
 * same kind of array and the same bytes. Use `expect(firstDifference(a, b)).toBe(-1)`
 * in place of `toEqual` on large arrays, which compares element by element through
 * the matcher machinery and takes hundreds of milliseconds on a texture-sized array.
 *
 * Differs from `toEqual` only at the edges: a different array type or length is a
 * difference at index 0 or the shorter length, and floats compare by bit pattern
 * (so 0 and -0 differ, as they do for `toEqual`, and NaNs match only bit for bit).
 */
export function firstDifference(a: ArrayBufferView, b: ArrayBufferView): number {
  if (a.constructor !== b.constructor) {
    return 0;
  }
  const size = "BYTES_PER_ELEMENT" in a ? (a.BYTES_PER_ELEMENT as number) : 1;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) {
      return Math.floor(i / size);
    }
  }
  return x.length === y.length ? -1 : Math.floor(n / size);
}
