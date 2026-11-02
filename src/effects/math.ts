/** Small scalar helpers shared by the effects' CPU code. They allocate nothing. */

/** `x` limited to `[lo, hi]`. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** GLSL `smoothstep`: 0 at or below `a`, 1 at or beyond `b`, a cubic ease between. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Moves `x` towards `target` by at most `step` (non-negative), without overshooting. */
export function approach(x: number, target: number, step: number): number {
  return target > x ? Math.min(target, x + step) : Math.max(target, x - step);
}

/** GLSL `fract`: `x - floor(x)`, in [0, 1) for finite `x`. */
export function fract(x: number): number {
  return x - Math.floor(x);
}

/**
 * Wraps `v` into `[lo, lo + span)`, however far outside it is. A value already in
 * range comes back unchanged, so `wrap(v, lo, span) !== v` exactly when it wrapped
 * (when a moving point jumped to the other side and may need to fade back in).
 * `span` must be positive.
 */
export function wrap(v: number, lo: number, span: number): number {
  const hi = lo + span;
  if (v >= lo && v < hi) return v;
  let w = lo + ((v - lo) % span);
  if (w < lo) w += span;
  // Rounding can land a value just below `lo` exactly on `hi`.
  return w >= hi ? lo : w;
}
