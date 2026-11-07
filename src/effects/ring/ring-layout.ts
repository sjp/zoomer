/**
 * Station Ring geometry: the camera, the corridor (a section of the ring with a
 * rectangular cross-section), the windows along one wall and the seats.
 *
 * World space is in metres. The camera stands on the corridor's centre line
 * looking forward along +z, with x to the right and y up from the floor under
 * it. The ring turns about an axis parallel to x, `RING_R` above the floor
 * (y = RING_R, z = 0), so the floor is the inside of a cylinder of radius
 * `RING_R` that curves up ahead, and the ceiling a cylinder `CEILING_H` closer
 * to the axis. The side walls are the planes x = +-HALF_W.
 *
 * Positions along the ring are (s, h): s is arc length along the floor from
 * under the camera (positive ahead), h is height above the floor. Everything
 * here is pure, and the shaders use the same constants, so the tests can check
 * the framing. The scene is built with the windows on the right wall; the
 * "left" option mirrors the picture.
 */

/** Floor radius about the ring's axis. */
export const RING_R = 60;
/** Ceiling height above the floor. */
export const CEILING_H = 3;
/** Half the corridor's width: the walls are at x = +-HALF_W. */
export const HALF_W = 2.3;
/** Camera eye height above the floor, standing. */
export const EYE_Y = 1.45;
/** Upward camera pitch (radians), so the floor's curve sits near the middle of the frame. */
export const PITCH = (7 * Math.PI) / 180;
/** Vertical field of view (radians). */
export const FOV_Y = (58 * Math.PI) / 180;
export const TAN_HALF_FOV = Math.tan(FOV_Y / 2);

/** Window glass: centre of the first (s), spacing, half width, bottom, top and corner radius. */
export const WINDOW_FIRST = 3.2;
export const WINDOW_STEP = 2.6;
export const WINDOW_HALF = 0.5;
export const WINDOW_Y0 = 0.8;
export const WINDOW_Y1 = 2.4;
export const WINDOW_CORNER = 0.3;
/** Width of the thick white frame round each window's glass. */
export const WINDOW_FRAME = 0.14;

/** Ceiling light panels: half width of the luminous band, and the panel length along s. */
export const LIGHT_HALF = 0.55;
export const LIGHT_STEP = 1.3;

/** The small wall indicator on the windowless wall: centre (s, h), half size and lamp radius. */
export const INDICATOR_S = 3.1;
export const INDICATOR_H = 1.45;
export const INDICATOR_HALF: readonly [number, number] = [0.07, 0.11];
export const INDICATOR_LAMP = 0.035;

/** Seats: a cushion and a back, `SEAT_DEPTH` deep from `SEAT_GAP` off the wall. */
export const SEAT_GAP = 0.06;
export const SEAT_DEPTH = 0.62;
export const SEAT_H = 0.4;
export const BACK_H = 0.8;
export const BACK_T = 0.14;

export interface SeatSpec {
  /** Centre along the ring (arc length on the floor). */
  s: number;
  /** Length along the ring. */
  length: number;
  /** Which wall it stands against: -1 left (windowless), 1 right (windows). */
  side: -1 | 1;
  /** Whether its back is against the wall; otherwise it faces the wall (and the windows). */
  backToWall: boolean;
}

/**
 * The seats: benches along the windowless wall facing the windows, and a few
 * single chairs in the window bays looking out. All well to the sides, so the
 * middle of the frame stays clear.
 */
export const SEATS: readonly SeatSpec[] = [
  { s: 4.4, length: 1.5, side: -1, backToWall: true },
  { s: 9.6, length: 1.5, side: -1, backToWall: true },
  { s: 14.8, length: 1.5, side: -1, backToWall: true },
  { s: 20, length: 1.5, side: -1, backToWall: true },
  { s: WINDOW_FIRST + 2 * WINDOW_STEP, length: 0.7, side: 1, backToWall: false },
  { s: WINDOW_FIRST + 4 * WINDOW_STEP, length: 0.7, side: 1, backToWall: false },
];

/**
 * A seat's two boxes in its own frame (x across, y up from the floor, z along
 * the ring from its centre): the cushion and the back, each as
 * [x0, y0, z0, x1, y1, z1].
 */
export function seatBoxes(seat: SeatSpec): [number[], number[]] {
  const wall = seat.side * HALF_W;
  const near = wall - seat.side * SEAT_GAP;
  const far = wall - seat.side * (SEAT_GAP + SEAT_DEPTH);
  const backNear = seat.backToWall ? near : far + seat.side * BACK_T;
  const backFar = seat.backToWall ? near - seat.side * BACK_T : far;
  const hz = seat.length / 2;
  const box = (a: number, b: number, y1: number) => [
    Math.min(a, b),
    0,
    -hz,
    Math.max(a, b),
    y1,
    hz,
  ];
  return [box(near, far, SEAT_H), box(backNear, backFar, BACK_H)];
}

/** Camera basis: forward and up (right is +x), for this pitch. */
export const FORWARD = [0, Math.sin(PITCH), Math.cos(PITCH)] as const;
export const UP = [0, Math.cos(PITCH), -Math.sin(PITCH)] as const;

/** World-space ray direction (not normalised) through NDC (x, y). */
export function rayDir(x: number, y: number, aspect: number): [number, number, number] {
  const ax = x * TAN_HALF_FOV * aspect;
  const ay = y * TAN_HALF_FOV;
  return [ax, FORWARD[1] + ay * UP[1], FORWARD[2] + ay * UP[2]];
}

/** Projects a world point to NDC (y up) for this aspect ratio, with its depth along the view axis. */
export function project(
  p: readonly [number, number, number],
  aspect: number,
): { x: number; y: number; depth: number } {
  const ry = p[1] - EYE_Y;
  const depth = ry * FORWARD[1] + p[2] * FORWARD[2];
  const up = ry * UP[1] + p[2] * UP[2];
  return { x: p[0] / depth / (TAN_HALF_FOV * aspect), y: up / depth / TAN_HALF_FOV, depth };
}

/** The world point at ring position (s, h), at x across. */
export function ringPoint(s: number, h: number, x: number): [number, number, number] {
  const a = s / RING_R;
  const r = RING_R - h;
  return [x, RING_R - r * Math.cos(a), r * Math.sin(a)];
}

/** Ring position (s, h) of a world point. */
export function ringCoords(p: readonly [number, number, number]): { s: number; h: number } {
  const vy = p[1] - RING_R;
  return { s: RING_R * Math.atan2(p[2], -vy), h: RING_R - Math.hypot(vy, p[2]) };
}

/**
 * Signed distance (metres, negative inside) from ring position (s, h) on the
 * window wall to the nearest window's glass: a rounded rectangle repeating
 * every `WINDOW_STEP` from `WINDOW_FIRST` on (none behind the camera).
 */
export function windowDistance(s: number, h: number): number {
  const k = Math.max(0, Math.round((s - WINDOW_FIRST) / WINDOW_STEP));
  const ls = s - (WINDOW_FIRST + k * WINDOW_STEP);
  const hc = (WINDOW_Y0 + WINDOW_Y1) / 2;
  const qx = Math.abs(ls) - (WINDOW_HALF - WINDOW_CORNER);
  const qy = Math.abs(h - hc) - ((WINDOW_Y1 - WINDOW_Y0) / 2 - WINDOW_CORNER);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - WINDOW_CORNER;
}

export type SurfaceKind = "floor" | "ceiling" | "left" | "right";

/**
 * Distance along `d` (from the eye) to a cylinder of radius r about the ring's
 * axis: the far root when the eye is inside it (`far`), else the near root.
 * -1 if the ray misses.
 */
export function cylinderHit(d: readonly [number, number, number], r: number, far: boolean): number {
  const oy = EYE_Y - RING_R;
  const a = d[1] * d[1] + d[2] * d[2];
  const b = oy * d[1];
  const c = oy * oy - r * r;
  const disc = b * b - a * c;
  if (a <= 0 || disc < 0) {
    return -1;
  }
  const t = (far ? -b + Math.sqrt(disc) : -b - Math.sqrt(disc)) / a;
  return t > 0 ? t : -1;
}

/**
 * The corridor surface a ray from the eye meets first (seats aside), and where.
 * The JS twin of the room shader's trace.
 */
export function traceCorridor(d: readonly [number, number, number]): {
  kind: SurfaceKind;
  t: number;
  point: [number, number, number];
} {
  let t = cylinderHit(d, RING_R, true);
  let kind: SurfaceKind = "floor";
  const tc = cylinderHit(d, RING_R - CEILING_H, false);
  if (tc > 0 && tc < t) {
    t = tc;
    kind = "ceiling";
  }
  if (d[0] !== 0) {
    const tw = HALF_W / Math.abs(d[0]);
    if (tw < t) {
      t = tw;
      kind = d[0] > 0 ? "right" : "left";
    }
  }
  return { kind, t, point: [d[0] * t, EYE_Y + d[1] * t, d[2] * t] };
}

/**
 * NDC height of the far end of the visible corridor on the frame's centre line:
 * the highest point where the floor still shows below the ceiling's curve.
 */
export function vanishingY(aspect: number): number {
  let lo = -1;
  let hi = 1;
  // The floor is below the ceiling's curve, so bisect on the hit kind.
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (traceCorridor(rayDir(0, mid, aspect)).kind === "floor") {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Azimuth about the ring's axis of a direction: 0 straight ahead, positive upwards. */
export const azimuth = (d: readonly [number, number, number]) => Math.atan2(d[1], d[2]);

/**
 * Range of azimuths [lo, hi] (radians) the visible windows span, from the eye:
 * every window whose centre isn't hidden by the ceiling's curve, corner to corner.
 */
export function windowAzimuths(): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 64; k++) {
    const sc = WINDOW_FIRST + k * WINDOW_STEP;
    const centre = ringPoint(sc, (WINDOW_Y0 + WINDOW_Y1) / 2, HALF_W);
    const dir: [number, number, number] = [centre[0], centre[1] - EYE_Y, centre[2]];
    if (traceCorridor(dir).kind !== "right") {
      break;
    }
    for (const s of [sc - WINDOW_HALF, sc + WINDOW_HALF]) {
      for (const h of [WINDOW_Y0, WINDOW_Y1]) {
        const p = ringPoint(s, h, HALF_W);
        const a = azimuth([p[0], p[1] - EYE_Y, p[2]]);
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
    }
  }
  return [lo, hi];
}
