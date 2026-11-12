/**
 * Points that bounce around the frame, as in the Mystify and Béziers screensavers:
 * each moves in a straight line at its own constant speed and reflects off the
 * edges, with a tiny random turn on every bounce so the figure never settles into
 * a loop.
 *
 * Positions are normalised to the frame, `[0, 1]` on both axes (y down), so a
 * resize keeps every point where it was relative to the frame. Velocities are in
 * frame heights per second, so a point crosses a wide frame no faster in pixels
 * than a tall one; `step` converts with the frame's aspect.
 *
 * Pure and allocation-free after creation.
 */

/** Largest random turn on a bounce, radians. */
export const BOUNCE_JITTER = 0.12;

/** Directions stay at least this far (radians) from either axis, so a point never skims an edge. */
const MIN_AXIS_ANGLE = 0.2;
const MIN_COMPONENT = Math.sin(MIN_AXIS_ANGLE);
const MAX_COMPONENT = Math.cos(MIN_AXIS_ANGLE);

/** Slowest point's speed as a fraction of the fastest: points drift at different rates. */
export const MIN_SPEED_FACTOR = 0.6;

interface BouncePoints {
  readonly count: number;
  /** Position, normalised to the frame, after the latest step. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Position before the latest step, to draw between steps. */
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  /**
   * Velocity per unit of speed, in frame heights: a direction scaled by the
   * point's own speed factor, in `[MIN_SPEED_FACTOR, 1]`.
   */
  readonly vx: Float32Array;
  readonly vy: Float32Array;
}

/** `count` points at random positions with random directions and speed factors. */
export function createBouncePoints(count: number, rng: () => number): BouncePoints {
  const p: BouncePoints = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    prevX: new Float32Array(count),
    prevY: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    // Keep starts off the very edge and directions off the axes.
    p.x[i] = 0.05 + 0.9 * rng();
    p.y[i] = 0.05 + 0.9 * rng();
    const quadrant = Math.floor(rng() * 4);
    const angle = MIN_AXIS_ANGLE + rng() * (Math.PI / 2 - 2 * MIN_AXIS_ANGLE);
    const factor = MIN_SPEED_FACTOR + (1 - MIN_SPEED_FACTOR) * rng();
    p.vx[i] = (quadrant & 1 ? -1 : 1) * Math.cos(angle) * factor;
    p.vy[i] = (quadrant & 2 ? -1 : 1) * Math.sin(angle) * factor;
  }
  p.prevX.set(p.x);
  p.prevY.set(p.y);
  return p;
}

/** Folds `v` into `[0, 1]` as reflections off both ends, however far outside it is. */
function fold(v: number): number {
  const m = v - 2 * Math.floor(v / 2);
  return m > 1 ? 2 - m : m;
}

/** Whether a value folded by `fold` ends up moving the other way. */
function flipped(v: number): boolean {
  return v - 2 * Math.floor(v / 2) > 1;
}

/**
 * Moves every point by `dt` seconds at `speed` frame heights per second (times
 * its own factor) in a frame `aspect` (width / height) wide, reflecting off the
 * edges. Any `dt` keeps the points inside the frame. A point that bounced turns
 * by a random angle of up to `BOUNCE_JITTER`, staying pointed into the frame.
 */
export function stepBouncePoints(
  p: BouncePoints,
  dt: number,
  speed: number,
  aspect: number,
  rng: () => number,
): void {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const s = Number.isFinite(speed) && speed > 0 ? speed * d : 0;
  const ax = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  p.prevX.set(p.x);
  p.prevY.set(p.y);
  for (let i = 0; i < p.count; i++) {
    const nx = p.x[i] + (p.vx[i] * s) / ax;
    const ny = p.y[i] + p.vy[i] * s;
    p.x[i] = fold(nx);
    p.y[i] = fold(ny);
    let vx = flipped(nx) ? -p.vx[i] : p.vx[i];
    let vy = flipped(ny) ? -p.vy[i] : p.vy[i];
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      // Turn by a small random angle, then keep the direction's quadrant (so the
      // point still heads away from the edge it hit) and its distance from the axes.
      const factor = Math.hypot(vx, vy);
      const turn = (rng() * 2 - 1) * BOUNCE_JITTER;
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      const rx = (vx * c - vy * sn) / factor;
      const cx = Math.min(MAX_COMPONENT, Math.max(MIN_COMPONENT, Math.abs(rx)));
      const cy = Math.sqrt(1 - cx * cx);
      vx = (vx < 0 ? -cx : cx) * factor;
      vy = (vy < 0 ? -cy : cy) * factor;
    }
    p.vx[i] = vx;
    p.vy[i] = vy;
  }
}

/** Puts point `to` where point `from` is (now and before the latest step), keeping its own velocity. */
export function placeBouncePoint(p: BouncePoints, to: number, from: number): void {
  p.x[to] = p.x[from];
  p.y[to] = p.y[from];
  p.prevX[to] = p.prevX[from];
  p.prevY[to] = p.prevY[from];
}
