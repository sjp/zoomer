/**
 * First-person walks through a grid of square cells, shared by the 3D Maze and
 * the Backrooms: the camera pose along a path of cell-to-cell walks and on-the-
 * spot quarter turns, the motion-limit sizing of those moves, and the GLSL grid
 * DDA that casts the view rays through the cells.
 *
 * Cell (x, y) covers [x, x + 1] x [y, y + 1] and y points north. Headings are
 * 0..3 for east, north, west and south; a left turn adds 1.
 */
import { capPatternSpeed, EASE_PEAK } from "./motion-limits";

/** Unit steps for the headings east, north, west, south. */
export const DIR_X: readonly number[] = [1, 0, -1, 0];
export const DIR_Y: readonly number[] = [0, 1, 0, -1];

/**
 * Seconds for an eased move of `span` (a cell, or a quarter turn in radians) at
 * a mean `rate` per second, slowed if need be so that its smoothstep peak moves
 * a pattern repeating every `period` (in the move's units) past a point at most
 * MAX_PATTERN_HZ times a second.
 */
export function easedMoveSeconds(span: number, rate: number, period: number): number {
  return (EASE_PEAK * span) / capPatternSpeed(EASE_PEAK * rate, period);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Fraction of a cell walked at `t`: smoothstep when starting and stopping, a
 * cubic that starts from rest and leaves at the cruising rate (and its mirror)
 * when only one end stops, and a straight line when cruising through.
 */
export function walkEase(t: number, easeIn: boolean, easeOut: boolean): number {
  if (easeIn && easeOut) {
    return smooth(t);
  }
  if (easeIn) {
    return t * t * (2 - t);
  }
  if (easeOut) {
    const u = 1 - t;
    return 1 - u * u * (2 - u);
  }
  return t;
}

/** Standing still at a cell centre. */
export const SEG_HOLD = 0;
/** Turning on the spot by `turn` quarter turns to `dir`. */
export const SEG_TURN = 1;
/** Walking from the cell centre to the next along `dir`. */
export const SEG_WALK = 2;

/** A walker's place on its path, and the camera pose that follows from it. */
export interface GridPose {
  /** Current cell (the one a walk leaves from). */
  cx: number;
  cy: number;
  /** Heading, 0..3; during a turn, the heading it turns to. */
  dir: number;
  /** `SEG_*`; any other kind stands still like SEG_HOLD. */
  kind: number;
  /** 0..1 through the current segment. */
  progress: number;
  /** Quarter turns of the current turn (+ is left). */
  turn: number;
  /** Whether the current walk speeds up from rest and slows to rest. */
  easeIn: boolean;
  easeOut: boolean;
  /** The camera pose: position in cells and heading in radians. */
  x: number;
  y: number;
  angle: number;
}

/**
 * Sets the camera pose from the segment: on the cell centre turning with a
 * smoothstep, or along the heading with `walkEase`, or standing still.
 */
export function updateGridPose(w: GridPose): void {
  const q = Math.PI / 2;
  const cx = w.cx + 0.5;
  const cy = w.cy + 0.5;
  if (w.kind === SEG_TURN) {
    w.x = cx;
    w.y = cy;
    w.angle = (w.dir - w.turn + w.turn * smooth(w.progress)) * q;
  } else if (w.kind === SEG_WALK) {
    const s = walkEase(w.progress, w.easeIn, w.easeOut);
    w.x = cx + DIR_X[w.dir] * s;
    w.y = cy + DIR_Y[w.dir] * s;
    w.angle = w.dir * q;
  } else {
    w.x = cx;
    w.y = cy;
    w.angle = w.dir * q;
  }
}

/**
 * GLSL for an Amanatides-Woo DDA through the unit cell grid:
 *
 * - `GridRay gridRay(vec2 origin, vec2 dir)` starts a ray in the cell holding
 *   `origin`; distances are in units of `dir` (so `origin + dir * t`).
 * - `float gridNext(GridRay r)`: distance to the next cell boundary.
 * - `int gridStep(inout GridRay r, out float t)` steps into the next cell,
 *   returning the axis crossed (0 a line of constant x, 1 of constant y) and
 *   the distance at the crossing. Ties step across y.
 *
 * `r.cell` is the current cell and `r.stp` the step direction on each axis.
 */
export const GRID_DDA_GLSL = /* glsl */ `
struct GridRay {
  ivec2 cell;
  ivec2 stp;
  vec2 tDelta;
  vec2 tMax;
};
GridRay gridRay(vec2 origin, vec2 dir) {
  GridRay r;
  r.cell = ivec2(floor(origin));
  vec2 dd = vec2(abs(dir.x) < 1e-6 ? 1e-6 : dir.x, abs(dir.y) < 1e-6 ? 1e-6 : dir.y);
  r.stp = ivec2(dd.x > 0.0 ? 1 : -1, dd.y > 0.0 ? 1 : -1);
  r.tDelta = abs(1.0 / dd);
  r.tMax = (vec2(r.cell) + vec2(greaterThan(dd, vec2(0.0))) - origin) / dd;
  return r;
}
float gridNext(GridRay r) {
  return min(r.tMax.x, r.tMax.y);
}
int gridStep(inout GridRay r, out float t) {
  if (r.tMax.x < r.tMax.y) {
    t = r.tMax.x;
    r.cell.x += r.stp.x;
    r.tMax.x += r.tDelta.x;
    return 0;
  }
  t = r.tMax.y;
  r.cell.y += r.stp.y;
  r.tMax.y += r.tDelta.y;
  return 1;
}
`;
