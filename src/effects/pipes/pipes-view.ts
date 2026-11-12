/**
 * The 3D Pipes camera, meshes and speed limits: a fixed perspective camera
 * looking into the node volume so its front face covers the frame, an optional
 * slow orbit about the vertical axis, and the cap on growth speed that keeps a
 * sliding pipe end (and its highlight) within the codec's per-frame limit.
 * World units are node spacings, with the volume centred on the origin.
 */
import { GRID_X, GRID_Y, GRID_Z } from "./pipes-sim";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";

/** Vertical field of view: narrow, for a mild perspective. */
const FOV_Y = (25 * Math.PI) / 180;
const TAN_HALF = Math.tan(FOV_Y / 2);
/** The volume's furthest reach from the vertical axis: half the plan's diagonal. */
const HALF_DIAGONAL = Math.hypot(GRID_X, GRID_Z) / 2;
/** Closest the camera comes to a corner of the volume, for very wide frames. */
const MIN_CLEARANCE = 4;
/** Orbit rate when on: one turn in four minutes. */
export const ORBIT_RATE = (2 * Math.PI) / 240;

/**
 * Distance from the camera to the volume's centre at this aspect: far enough
 * back that the front face just covers the frame, but never closer to the
 * axis than a corner swinging round in the orbit.
 */
function cameraDistance(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const front = Math.min(GRID_Y / 2 / TAN_HALF, GRID_X / 2 / (a * TAN_HALF));
  return Math.max(GRID_Z / 2 + front, HALF_DIAGONAL + MIN_CLEARANCE);
}

/** How far the volume reaches towards a camera at `yaw`: its plan's half-extent along the view. */
function reachTowards(yaw: number): number {
  return (GRID_X / 2) * Math.abs(Math.sin(yaw)) + (GRID_Z / 2) * Math.abs(Math.cos(yaw));
}

/**
 * Fastest growth, in segments a second, that keeps the sliding pipe end within
 * `MAX_FEATURE_PX_PER_FRAME` at the nearest point of the volume, at this aspect
 * and camera yaw, with the orbit turning at `omega` rad/s (its motion adds to
 * the end's).
 */
export function maxSegmentRate(aspect: number, yaw: number, omega: number): number {
  const nearest = Math.max(1e-3, cameraDistance(aspect) - reachTowards(yaw));
  // Reference px per frame of something moving one node a second at that depth.
  const perUnit = pxPerReferenceFrame(1 / (2 * nearest * TAN_HALF));
  return Math.max(0, MAX_FEATURE_PX_PER_FRAME / perUnit - Math.abs(omega) * HALF_DIAGONAL);
}

/**
 * The camera at `yaw` round the vertical axis for this aspect. Writes the
 * column-major view-projection matrix into `viewProj` and the eye position
 * into `eye`.
 */
export function cameraMatrix(
  aspect: number,
  yaw: number,
  viewProj: Float32Array,
  eye: Float32Array,
): void {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const dist = cameraDistance(a);
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  eye[0] = dist * s;
  eye[1] = 0;
  eye[2] = dist * c;
  const near = Math.max(0.25, dist - HALF_DIAGONAL - 1);
  const far = dist + HALF_DIAGONAL + 1;
  const f = 1 / TAN_HALF;
  // View: right = (c, 0, -s), up = y, back = (s, 0, c); eye along back.
  // Projection (standard GL perspective) applied to the view-space point.
  const px = f / a;
  const py = f;
  const pz = (far + near) / (near - far);
  const pw = (2 * far * near) / (near - far);
  // Columns: world x, y, z, w -> clip.
  // view x = c*x - s*z; view y = y; view z = s*x + c*z - dist.
  viewProj[0] = px * c;
  viewProj[1] = 0;
  viewProj[2] = pz * s;
  viewProj[3] = -s;
  viewProj[4] = 0;
  viewProj[5] = py;
  viewProj[6] = 0;
  viewProj[7] = 0;
  viewProj[8] = -px * s;
  viewProj[9] = 0;
  viewProj[10] = pz * c;
  viewProj[11] = -c;
  viewProj[12] = 0;
  viewProj[13] = 0;
  viewProj[14] = -pz * dist + pw;
  viewProj[15] = dist;
}

/**
 * A tube of `bands` bands round `sides` sides, closed by a disc at each end, as
 * a triangle list of `vec4(u, angle, radial, disc)`: `u` 0 to 1 along it, the
 * angle round it, `radial` 1 on the rim and 0 at a disc's centre, and `disc`
 * -1 or 1 on the start or end disc (0 on the side). The vertex shader bends it
 * into a straight tube, an elbow or a sphere.
 */
export function tubeMesh(bands: number, sides: number): Float32Array {
  const out = new Float32Array((bands * 6 + 6) * sides * 4);
  let o = 0;
  const put = (u: number, k: number, radial: number, disc: number) => {
    out[o++] = u;
    out[o++] = (k * 2 * Math.PI) / sides;
    out[o++] = radial;
    out[o++] = disc;
  };
  for (let b = 0; b < bands; b++) {
    const u0 = b / bands;
    const u1 = (b + 1) / bands;
    for (let k = 0; k < sides; k++) {
      put(u0, k, 1, 0);
      put(u0, k + 1, 1, 0);
      put(u1, k + 1, 1, 0);
      put(u0, k, 1, 0);
      put(u1, k + 1, 1, 0);
      put(u1, k, 1, 0);
    }
  }
  for (let k = 0; k < sides; k++) {
    put(0, k, 0, -1);
    put(0, k + 1, 1, -1);
    put(0, k, 1, -1);
    put(1, k, 0, 1);
    put(1, k, 1, 1);
    put(1, k + 1, 1, 1);
  }
  return out;
}
