/**
 * The Rollercoaster's two cameras and the speed each lets the train show.
 *
 * Side view: a fixed camera far back from the circuit, a few degrees above it
 * and looking slightly down, close enough that the whole circuit spans the
 * frame on landscape screens (on portrait it keeps the lift and the loop and
 * lets the turnarounds run off the sides). Ride along: a camera in the front
 * seat, looking a little down the track.
 *
 * The train's shown speed is its physical speed soft-capped per view, so the
 * motion stays within the codec limits: in the side view the train's own
 * motion across the screen; riding along, the turning of the whole view, the
 * passing of scenery at a few car lengths, and the ties going by.
 */
import { frameAt, type Track, trackBounds } from "./rollercoaster-track";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";

export interface Camera {
  readonly eye: Float32Array;
  /** Unit basis: right, up and forward (into the screen). */
  readonly right: Float32Array;
  readonly up: Float32Array;
  readonly fwd: Float32Array;
  /** tan of half the vertical field of view. */
  tanHalf: number;
  aspect: number;
  /** Column-major view-projection matrix. */
  readonly viewProj: Float32Array;
}

export const createCamera = (): Camera => ({
  eye: new Float32Array(3),
  right: new Float32Array(3),
  up: new Float32Array(3),
  fwd: new Float32Array(3),
  tanHalf: 1,
  aspect: 1,
  viewProj: new Float32Array(16),
});

/** Side view: vertical field of view and how far the camera looks down. */
const SIDE_TAN_HALF = Math.tan((13 * Math.PI) / 180);
const SIDE_PITCH = (3 * Math.PI) / 180;
/** Where the track's middle height sits on screen, in NDC (negative is below centre). */
const SIDE_TRACK_NDC = -0.3;
/** The frame's half-width the track's ends reach, in NDC. */
const SIDE_FIT = 1.08;
/** At aspects below this, the side view frames a narrower stretch of the circuit. */
const SIDE_FULL_ASPECT = 1.25;

/** Ride along: vertical field of view, look-down angle, and the seat's eye point. */
const RIDE_TAN_HALF = Math.tan((29 * Math.PI) / 180);
const RIDE_PITCH = (12 * Math.PI) / 180;
/** Eye height above the rails and distance ahead of the front car's middle, metres. */
const RIDE_EYE_UP = 1.45;
const RIDE_EYE_AHEAD = 0.6;
/** Nearest scenery the speed cap keeps codec-friendly while riding along, metres. */
const RIDE_NEAR = 20;
/** Spacing of the ties along the track, metres. */
export const TIE_SPACING = 1.6;

const NEAR = { side: 40, ride: 0.08 };
const FAR = 2400;

/** Writes the column-major view-projection matrix for the camera's eye and basis. */
function writeViewProj(cam: Camera, near: number, far: number): void {
  const { eye, right: r, up: u, fwd: f, viewProj: m } = cam;
  const px = 1 / (cam.tanHalf * cam.aspect);
  const py = 1 / cam.tanHalf;
  const pz = (far + near) / (near - far);
  const pw = (2 * far * near) / (near - far);
  // View rows: right, up, back (= -fwd); translation -basis·eye.
  const tx = -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]);
  const ty = -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]);
  const tz = f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2];
  for (let c = 0; c < 3; c++) {
    m[c * 4] = px * r[c];
    m[c * 4 + 1] = py * u[c];
    m[c * 4 + 2] = -pz * f[c];
    m[c * 4 + 3] = f[c];
  }
  m[12] = px * tx;
  m[13] = py * ty;
  m[14] = pz * tz + pw;
  m[15] = -tz;
}

/** The side-view camera for this aspect. Allocates; call on resize only. */
export function sideCamera(track: Track, aspect: number, cam: Camera): void {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const b = trackBounds(track);
  const cx = (b[0] + b[3]) / 2;
  const cy = (b[1] + b[4]) / 2;
  const cz = (b[2] + b[5]) / 2;
  const halfSpan = (b[3] - b[0]) / 2;
  const half = halfSpan * Math.min(1, Math.sqrt(a / SIDE_FULL_ASPECT));
  const sp = Math.sin(SIDE_PITCH);
  const cp = Math.cos(SIDE_PITCH);
  // Far enough back that the ends of the front row reach the fit width.
  const frontDepthOffset = (b[5] - cz) * cp;
  const dist = half / (SIDE_FIT * SIDE_TAN_HALF * a) + frontDepthOffset;
  // Aim above the track's middle so it sits low in the frame.
  const ty = cy - SIDE_TRACK_NDC * dist * SIDE_TAN_HALF;
  cam.tanHalf = SIDE_TAN_HALF;
  cam.aspect = a;
  cam.fwd.set([0, -sp, -cp]);
  cam.up.set([0, cp, -sp]);
  cam.right.set([1, 0, 0]);
  cam.eye.set([cx, ty + sp * dist, cz + cp * dist]);
  writeViewProj(cam, Math.max(1, dist - 120), FAR + dist);
}

/** Scratch frame for the ride camera. */
const rideFrame = new Float64Array(12);

/**
 * The ride-along camera with the front car's middle at arc length `s`. Writes
 * into `cam`; allocates nothing, so it runs every frame.
 */
export function rideCamera(track: Track, s: number, aspect: number, cam: Camera): void {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  frameAt(track, s + RIDE_EYE_AHEAD, rideFrame);
  const f = rideFrame;
  const sp = Math.sin(RIDE_PITCH);
  const cp = Math.cos(RIDE_PITCH);
  for (let k = 0; k < 3; k++) {
    const t = f[3 + k];
    const n = f[6 + k];
    cam.eye[k] = f[k] + n * RIDE_EYE_UP;
    cam.fwd[k] = t * cp - n * sp;
    cam.up[k] = n * cp + t * sp;
    cam.right[k] = f[9 + k];
  }
  cam.tanHalf = RIDE_TAN_HALF;
  cam.aspect = a;
  writeViewProj(cam, NEAR.ride, FAR);
}

/** Reference px per frame per (frame height a second): the motion budget in frame heights/s. */
const MAX_HEIGHTS_PER_SECOND = MAX_FEATURE_PX_PER_FRAME / pxPerReferenceFrame(1);

/** Soft cap: about `v` well below `cap`, never above it. */
const softCap = (v: number, cap: number) => cap * Math.tanh(v / cap);

/**
 * The speed the train shows at each sample in the side view at this aspect:
 * its physical speed, soft-capped so it never crosses the screen faster than
 * the codec limit. Allocates; call on resize only.
 */
export function sideSpeeds(track: Track, aspect: number, out: Float64Array): void {
  const cam = createCamera();
  sideCamera(track, aspect, cam);
  const m = cam.viewProj;
  const ndc = (i: number, o: number[]) => {
    const p = track.pos;
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    o[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    o[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  };
  const a = [0, 0];
  const b = [0, 0];
  for (let i = 0; i < track.count; i++) {
    ndc(i, a);
    ndc((i + 1) % track.count, b);
    // Frame heights moved per metre along the track (NDC spans 2 heights tall, 2·aspect wide).
    const heightsPerMetre = Math.hypot((b[0] - a[0]) * cam.aspect, b[1] - a[1]) / 2 / track.step;
    const cap = MAX_HEIGHTS_PER_SECOND / Math.max(heightsPerMetre, 1e-6);
    out[i] = softCap(track.speed[i], cap);
  }
}

/**
 * The speed the train shows at each sample when riding along at this aspect:
 * soft-capped so the view turns no faster than the codec limit allows at the
 * frame's corners, scenery `RIDE_NEAR` away passes no faster, and the ties
 * pass under at most `MAX_PATTERN_HZ`. Allocates; call on resize only.
 */
export function rideSpeeds(track: Track, aspect: number, out: Float64Array): void {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  // Frame heights a point moves per radian of turn: at the centre 1/(2·tanHalf), at a
  // corner (rolling) half the diagonal over the height.
  const heightsPerRadian = Math.max(1 / (2 * RIDE_TAN_HALF), Math.hypot(a, 1) / 2);
  const maxTurn = MAX_HEIGHTS_PER_SECOND / heightsPerRadian;
  const linear = Math.min(maxTurn * RIDE_NEAR, MAX_PATTERN_HZ * TIE_SPACING);
  const fa = new Float64Array(12);
  const fb = new Float64Array(12);
  for (let i = 0; i < track.count; i++) {
    const s = i * track.step;
    frameAt(track, s, fa);
    frameAt(track, s + track.step, fb);
    // Rotation angle between the two frames: each basis vector moves by angle·|axis × e|,
    // and those squared sum to 2·angle².
    let sum = 0;
    for (let k = 3; k < 12; k++) {
      const d = fb[k] - fa[k];
      sum += d * d;
    }
    const turnPerMetre = Math.sqrt(sum / 2) / track.step;
    const cap = Math.min(linear, maxTurn / Math.max(turnPerMetre, 1e-6));
    out[i] = softCap(track.speed[i], cap);
  }
  // The caps change sharply where a turn starts: ease them along the track so
  // the ride slows down and speeds up smoothly. A running minimum then a box
  // blur of the same radius never rises above the local cap: every value in
  // the blur's window is the minimum of a window that contains this sample.
  const n = track.count;
  const radius = Math.max(1, Math.round(8 / track.step));
  const eroded = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    for (let k = -radius; k <= radius; k++) {
      lo = Math.min(lo, out[(i + k + n) % n]);
    }
    eroded[i] = lo;
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += eroded[(i + k + n) % n];
    }
    out[i] = sum / (2 * radius + 1);
  }
}

/** Looks up a per-sample table at arc length `s` (wrapping), linearly. */
export function tableAt(track: Track, table: Float64Array, s: number): number {
  const u = (((s / track.step) % track.count) + track.count) % track.count;
  const i = Math.min(track.count - 1, Math.floor(u));
  const j = (i + 1) % track.count;
  return table[i] + (table[j] - table[i]) * (u - i);
}
