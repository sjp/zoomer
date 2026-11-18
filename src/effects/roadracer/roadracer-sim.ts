/**
 * Road Racer's CPU side, kept free of GL so it can be tested: the seeded
 * course (curves, hills, roadside scenery, traffic), the camera's drive along
 * it, the segment projection the road shader reads a row at a time, sprite
 * projection, the lane changes, the lap clock and the HUD's course map.
 *
 * World units are camera heights (at 16:9 and wider); the road runs along `s`,
 * one unit per segment, and loops every `LAP` units. Screen positions are in
 * frame heights from the centre of the frame (x right) and from the horizon (y
 * down).
 */
import { clamp, smoothstep } from "../math";
import { capPatternSpeed, EASE_PEAK, MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { createRng, hash32 } from "../noise";
import { MAX_SPEED, MIN_SPEED } from "./roadracer.meta";

/** Segments in a lap; each is one world unit long. */
export const SEGMENTS = 300;
export const LAP = SEGMENTS;
/** The horizon, as a share of the frame height from the top. */
export const HORIZON = 0.45;
/** Focal length, frame heights. */
export const FOCAL = 1;
/** Half the road's width, the lane centres' offset, and the rumble strips' width. */
export const ROAD_HALF = 1.4;
const LANE_X = 0.7;
export const RUMBLE = 0.22;
/** Length of one light or dark band of the rumble strips, verges and lane dashes. */
export const BAND = 0.5;
/** Where the sand gives way to the sea, on the Coast's left side. */
export const SEA_X = 3.6;
/** Nearest and farthest road drawn. */
export const NEAR = 0.3;
export const DRAW = 70;
/** Projected boundaries per frame, one a unit from `NEAR` to past `DRAW`. */
export const BOUNDARIES = 72;
/** The sharpest curve, 1 / world units. */
export const K_MAX = 0.1;
/** Cruising speed at the top of the speed slider, world units a second. */
export const V_TOP = 1.6;
/** How fast the cruising speed changes, units per second squared. */
const ACCEL = 0.2;
/** The car's base on screen, frame heights below the horizon. */
const CAR_BASE = 0.47;
/** The player's car: width, and the length kept clear when passing. */
export const CAR_W = 1.3;
export const CAR_LENGTH = 2;
/** Seconds a lane change takes (a smoothstep, so it peaks at 1.5x its mean speed). */
const LANE_SECONDS = 5;
/** Shown speed at `V_TOP`, km/h. */
const KMH_AT_TOP = 180;
/** Parallax: how much of the camera's turn each background layer follows. */
export const PARALLAX = { far: 0.2, near: 0.5, clouds: 0.1 } as const;
/** Width round each background layer's loop, frame heights. */
export const LAYER_PERIOD = { far: 4, near: 2.6, clouds: 1 / 0.35 } as const;
/** Width of a column of lit windows in the night skyline, frame heights (dividing its layer's period). */
export const WINDOW_WIDTH = { far: 0.0125, near: 0.02 } as const;
/** The clouds' own drift, frame heights a second. */
export const CLOUD_WIND = 0.004;

/** The per-frame motion limit, frame heights per reference frame (1/30 s). */
const LIMIT = MAX_FEATURE_PX_PER_FRAME / 1080;
/** Seconds in one reference frame of the motion limit. */
const REF_FRAME = 1 / 30;

/**
 * How far the view is zoomed out on narrow frames, 1 at 16:9 and wider: the
 * camera rises by its inverse, so the road and car fit across the frame.
 */
export const viewScale = (width: number, height: number) =>
  height > 0 && width > 0 ? Math.min(1, width / height / (16 / 9)) : 1;

/** The camera's height above the road for a view scale. */
export const cameraHeight = (scale: number) => 1 / clamp(scale, 0.1, 1);

/** The player car's distance ahead of the camera. */
export const carDistance = (camHeight: number) => (camHeight * FOCAL) / CAR_BASE;

// ---------------------------------------------------------------------------
// The course

/** Scenery rows: beside the road, farther out, street lamps, and curve signs. */
export const ROW = { near: 0, far: 1, lamp: 2, sign: 3 } as const;

/** Traffic: a car is on the road for `TRAFFIC_SPAN` units of the player's travel in every `TRAFFIC_PERIOD`. */
export const TRAFFIC_PERIOD = 230;

export interface Course {
  seed: number;
  /** Curvature at each segment's start, 1 / units (positive bends right). */
  curve: Float32Array;
  /** Height of the road at each segment's start. */
  elev: Float32Array;
  /** Scenery, sorted by `itemS`: position along the road, signed offset from its centre, row and hash. */
  itemS: Float32Array;
  itemX: Float32Array;
  itemRow: Uint8Array;
  itemHash: Uint32Array;
  itemCount: number;
  /** The curves' starts and directions, for the signs and tests. */
  curveStarts: number[];
  /** The course map: x, y per segment in 0..1, closed, aspect kept (see `mapAspect`). */
  map: Float32Array;
  /** Map width over height. */
  mapAspect: number;
}

/** Linear lookup of a per-segment loop at `s` (any real). */
export function sampleLoop(values: Float32Array, s: number): number {
  const n = values.length;
  const f = s - Math.floor(s / n) * n;
  const i = Math.floor(f);
  const t = f - i;
  const a = values[i % n];
  const b = values[(i + 1) % n];
  return a + (b - a) * t;
}

interface CurveSection {
  start: number;
  ease: number;
  hold: number;
  peak: number;
}

/** Eases a section's peak in over `ease` segments, holds, and eases out again. */
function sectionShape(j: number, ease: number, hold: number): number {
  const len = 2 * ease + hold;
  if (j <= 0 || j >= len) {
    return 0;
  }
  if (j < ease) {
    return smoothstep(0, ease, j);
  }
  if (j <= ease + hold) {
    return 1;
  }
  return smoothstep(0, ease, len - j);
}

function buildCurves(seed: number, curve: Float32Array): CurveSection[] {
  const rng = createRng(hash32(seed * 4 + 1));
  const sections: CurveSection[] = [];
  // A straight through the start line.
  let i = 14 + Math.floor(rng() * 8);
  for (;;) {
    const ease = 8 + Math.floor(rng() * 7);
    const hold = 4 + Math.floor(rng() * 20);
    const len = 2 * ease + hold;
    if (i + len + 10 > SEGMENTS) {
      break;
    }
    const right = rng() < 0.7;
    const peak = (right ? 1 : -1) * (right ? 0.04 + rng() * 0.06 : 0.03 + rng() * 0.05);
    sections.push({ start: i, ease, hold, peak });
    i += len + 6 + Math.floor(rng() * 22);
  }
  // A circuit turns once round: scale the bends towards a net turn of 2 pi,
  // within the sharpest curve allowed, so the course map closes nicely.
  // Mostly right-handers: mirror a course that came out mostly left.
  let net = 0;
  for (const c of sections) {
    net += c.peak * (c.ease + c.hold);
  }
  if (net < 0) {
    for (const c of sections) {
      c.peak = -c.peak;
    }
  }
  let pos = 0;
  let neg = 0;
  let maxPos = 0;
  for (const c of sections) {
    const turn = Math.abs(c.peak) * (c.ease + c.hold);
    if (c.peak > 0) {
      pos += turn;
      maxPos = Math.max(maxPos, c.peak);
    } else {
      neg += turn;
    }
  }
  if (pos > 0) {
    const a = Math.min((2 * Math.PI + neg) / pos, K_MAX / maxPos);
    const b = neg > 0 ? clamp((pos * a - 2 * Math.PI) / neg, 0, 1) : 1;
    for (const c of sections) {
      c.peak *= c.peak > 0 ? a : b;
    }
  }
  for (const c of sections) {
    const len = 2 * c.ease + c.hold;
    for (let j = 0; j <= len; j++) {
      curve[(c.start + j) % SEGMENTS] = c.peak * sectionShape(j, c.ease, c.hold);
    }
  }
  return sections.filter((c) => c.peak !== 0);
}

function buildHills(seed: number, elev: Float32Array): void {
  const rng = createRng(hash32(seed * 4 + 2));
  // Flat through the start line.
  let i = 18 + Math.floor(rng() * 10);
  for (;;) {
    const len = 30 + Math.floor(rng() * 40);
    if (i + len + 4 > SEGMENTS) {
      break;
    }
    const amp = (rng() < 0.55 ? 1 : -1) * (0.6 + rng() * 1.6);
    for (let j = 0; j <= len; j++) {
      elev[i + j] = (amp * (1 - Math.cos((2 * Math.PI * j) / len))) / 2;
    }
    i += len + 8 + Math.floor(rng() * 24);
  }
}

interface Item {
  s: number;
  x: number;
  row: number;
  hash: number;
}

/** Places one seeded row of scenery along one side of the road. */
function placeRow(
  seed: number,
  side: number,
  row: number,
  minGap: number,
  maxGap: number,
  x0: number,
  x1: number,
  out: Item[],
): void {
  const stream = hash32(seed * 16 + (side > 0 ? 8 : 0) + row);
  const rng = createRng(stream);
  let s = rng() * maxGap;
  let k = 0;
  while (s < LAP - minGap) {
    out.push({ s, x: side * (x0 + rng() * (x1 - x0)), row, hash: hash32(stream ^ (k * 0x9e37)) });
    s += minGap + rng() * (maxGap - minGap);
    k++;
  }
}

const EDGE = ROAD_HALF + RUMBLE;

function buildItems(seed: number, curves: CurveSection[]): Item[] {
  const items: Item[] = [];
  for (const side of [-1, 1]) {
    placeRow(seed, side, ROW.near, 2.5, 6, EDGE + 0.5, EDGE + 1.3, items);
    placeRow(seed, side, ROW.far, 3, 8, 3.8, 7, items);
    // Street lamps every 8 units, staggered side to side.
    for (let s = side > 0 ? 4 : 0; s < LAP; s += 8) {
      items.push({ s, x: side * (EDGE + 0.3), row: ROW.lamp, hash: hash32(s * 2 + side) });
    }
  }
  // Two chevron signs on the outside of each bend, the arrow pointing into it.
  for (const c of curves) {
    const side = c.peak > 0 ? -1 : 1;
    for (const ahead of [-5, c.ease]) {
      const s = (c.start + ahead + LAP) % LAP;
      items.push({ s, x: side * (EDGE + 0.45), row: ROW.sign, hash: c.peak > 0 ? 1 : 0 });
    }
  }
  items.sort((a, b) => a.s - b.s);
  return items;
}

/** The course's outline for the map: heading integrated, the drift closed, fitted into 0..1. */
function buildMap(curve: Float32Array): { map: Float32Array; aspect: number } {
  const n = curve.length;
  const px = new Float64Array(n + 1);
  const py = new Float64Array(n + 1);
  let heading = -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const k = (curve[i] + curve[(i + 1) % n]) / 2;
    const mid = heading + k / 2;
    px[i + 1] = px[i] + Math.cos(mid);
    py[i + 1] = py[i] + Math.sin(mid);
    heading += k;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    // Spread the gap between the end and the start over the lap.
    px[i] -= (px[n] * i) / n;
    py[i] -= (py[n] * i) / n;
    minX = Math.min(minX, px[i]);
    maxX = Math.max(maxX, px[i]);
    minY = Math.min(minY, py[i]);
    maxY = Math.max(maxY, py[i]);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const map = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    map[i * 2] = (px[i] - minX) / span;
    map[i * 2 + 1] = (py[i] - minY) / span;
  }
  return { map, aspect: Math.max(0.2, (maxX - minX) / Math.max(maxY - minY, 1e-6)) };
}

/** Builds the course for a seed. Deterministic, and the same course every time. */
export function buildCourse(seed: number): Course {
  const s = Math.floor(Number.isFinite(seed) ? seed : 0);
  const curve = new Float32Array(SEGMENTS);
  const elev = new Float32Array(SEGMENTS);
  const sections = buildCurves(s, curve);
  buildHills(s, elev);
  const items = buildItems(s, sections);
  const { map, aspect } = buildMap(curve);
  return {
    seed: s,
    curve,
    elev,
    itemS: Float32Array.from(items, (it) => it.s),
    itemX: Float32Array.from(items, (it) => it.x),
    itemRow: Uint8Array.from(items, (it) => it.row),
    itemHash: Uint32Array.from(items, (it) => it.hash),
    itemCount: items.length,
    curveStarts: sections.map((c) => c.start * Math.sign(c.peak)),
    map,
    mapAspect: aspect,
  };
}

/** The first item at or after `s` (0..LAP), or `itemCount`. */
export function firstItemAt(course: Course, s: number): number {
  let lo = 0;
  let hi = course.itemCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (course.itemS[mid] < s) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Traffic

/** Closing rate alongside (a share of the player's speed), and its growth far ahead. */
const CLOSE_MIN = 0.2;
const CLOSE_MAX = 0.7;
/** Progress coordinate where a car appears: gap = CLOSE_MIN w + A w^3. */
const W_START = 95;
const CUBIC = (CLOSE_MAX - CLOSE_MIN) / (3 * W_START * W_START);
const gapAt = (w: number) => CLOSE_MIN * w + CUBIC * w * w * w;
/** Gap (behind the player) at which a passed car is gone. */
const GAP_GONE = -6;
/** Units of the player's travel a car is on the road. */
export const TRAFFIC_SPAN = (() => {
  let lo = -W_START;
  let hi = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (gapAt(mid) < GAP_GONE) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return W_START - hi;
})();
/** The gap a car first appears at, ahead of the player's car. */
export const GAP_START = gapAt(W_START);

/** A traffic car at a moment: its gap ahead of the player's car (units), closing rate and look. */
export interface TrafficState {
  active: boolean;
  gap: number;
  /** How fast the gap closes, as a share of the player's speed. */
  closing: number;
  /** 0..1, how far it has faded in. */
  appear: number;
  hash: number;
}

/**
 * The traffic car on the road when the player has driven `distance`: at most
 * one at a time, a pure function of the distance and the seed. Each slower car
 * appears far ahead, is caught quickly, then eased past slowly.
 */
export function trafficAt(seed: number, distance: number, out: TrafficState): TrafficState {
  out.active = false;
  if (!(distance >= 0)) {
    return out;
  }
  const k = Math.floor(distance / TRAFFIC_PERIOD);
  const hash = hash32(seed * 7919 + k + 1);
  const start = k * TRAFFIC_PERIOD + (hash / 4294967296) * (TRAFFIC_PERIOD - TRAFFIC_SPAN);
  const p = distance - start;
  if (p < 0 || p > TRAFFIC_SPAN) {
    return out;
  }
  const w = W_START - p;
  out.active = true;
  out.gap = gapAt(w);
  out.closing = CLOSE_MIN + 3 * CUBIC * w * w;
  out.appear = smoothstep(0, 6, p);
  out.hash = hash;
  return out;
}

/** The fastest a traffic gap closes, as a share of the player's speed. */
const MAX_CLOSING = CLOSE_MAX;

// ---------------------------------------------------------------------------
// Driving

export interface Drive {
  /** Distance driven, units (float64; never wrapped). */
  distance: number;
  /** Speed, units a second. */
  speed: number;
  /** Seconds since the start line was last crossed. */
  lapTime: number;
  /** The lane change: from and to lanes (-1 left, 1 right) and its progress 0..1. */
  laneFrom: number;
  laneTo: number;
  laneT: number;
}

export const createDrive = (lane: number): Drive => ({
  distance: 0,
  speed: 0,
  lapTime: 0,
  laneFrom: lane,
  laneTo: lane,
  laneT: 1,
});

/** The cruising speed for the slider, eased off on sharp bends ahead, within the stripes' rate cap. */
export function cruiseSpeed(course: Course, distance: number, slider: number): number {
  const share = clamp(Number.isFinite(slider) ? slider : 0.5, MIN_SPEED, MAX_SPEED);
  const bend = Math.abs(sampleLoop(course.curve, distance + 6)) / K_MAX;
  return capPatternSpeed(share * V_TOP * (1 - 0.25 * clamp(bend, 0, 1)), 2 * BAND);
}

/** The gap kept clear before starting a lane change: the car's length plus how far traffic can close in one. */
export const LANE_CLEAR = CAR_LENGTH + MAX_CLOSING * V_TOP * LANE_SECONDS;

const scratchTraffic: TrafficState = { active: false, gap: 0, closing: 0, appear: 0, hash: 0 };

/** Whether a traffic car is too close to start a lane change (for any of the given seeds' traffic). */
export function laneBlocked(seed: number, distance: number): boolean {
  const t = trafficAt(seed, distance, scratchTraffic);
  return t.active && t.gap > -CAR_LENGTH && t.gap < LANE_CLEAR;
}

/**
 * Steps the drive by `dt`: speed eases towards the cruise, distance and lap
 * clock advance (the clock restarting at the start line), and a wanted lane
 * change starts once no traffic is near.
 */
export function stepDrive(
  drive: Drive,
  course: Course,
  slider: number,
  wantLane: number,
  blocked: boolean,
  dt: number,
): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const target = cruiseSpeed(course, drive.distance, slider);
  const dv = ACCEL * step;
  drive.speed =
    target > drive.speed ? Math.min(target, drive.speed + dv) : Math.max(target, drive.speed - dv);
  const before = drive.distance;
  drive.distance += drive.speed * step;
  const lapsBefore = Math.floor(before / LAP);
  if (Math.floor(drive.distance / LAP) > lapsBefore) {
    const past = drive.distance - (lapsBefore + 1) * LAP;
    drive.lapTime = drive.speed > 0 ? past / drive.speed : 0;
  } else {
    drive.lapTime += step;
  }
  if (drive.laneT >= 1 && wantLane !== drive.laneTo && !blocked) {
    drive.laneFrom = drive.laneTo;
    drive.laneTo = wantLane;
    drive.laneT = 0;
  }
  if (drive.laneT < 1) {
    drive.laneT = Math.min(1, drive.laneT + step / LANE_SECONDS);
  }
}

/** The player's offset from the road's centre, units. */
export const laneOffset = (drive: Drive) =>
  LANE_X * (drive.laneFrom + (drive.laneTo - drive.laneFrom) * smoothstep(0, 1, drive.laneT));

/** Shown speed, whole km/h. */
export const speedKmh = (speed: number) => Math.round((Math.max(0, speed) / V_TOP) * KMH_AT_TOP);

/** A lap time as "M:SS.T" (tenths, rounded down), up to 99:59.9. */
export function formatLapTime(seconds: number): string {
  const tenths = Math.min(
    59999,
    Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 10),
  );
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${String(m)}:${String(s).padStart(2, "0")}.${String(tenths % 10)}`;
}

/** Background pan rate, frame heights a second, of a layer following `share` of the camera's turn. */
export const panRate = (curve: number, speed: number, share: number) =>
  curve * speed * FOCAL * share;

// ---------------------------------------------------------------------------
// Projection

export interface RoadFrame {
  /** Low-res rows. */
  rows: number;
  /**
   * The row table: plane 0 (texel row 0) holds, per row, the road centre's x
   * and half width (frame heights), the road position s (0..LAP) and depth
   * (0 for no ground); plane 1 the stripes' contrast and the fog.
   */
  table: Float32Array;
  /** Per boundary: distance, road centre's x (units, camera space), camera height above the road, screen y, and the ground's top so far. */
  d: Float32Array;
  x: Float32Array;
  y: Float32Array;
  sy: Float32Array;
  clip: Float32Array;
  /** Camera height over the road at the camera, and its height above the course's zero. */
  camHeight: number;
  camY: number;
  /** The distance driven this frame was projected for, and the curvature at the camera. */
  distance: number;
  curve0: number;
  /** Distance travelled in one reference frame of the motion limit, and the camera's height then. */
  refStep: number;
  camYNext: number;
  /** How far the camera is turned towards the road at the car, radians (right positive). */
  yaw: number;
}

export function createRoadFrame(maxRows: number): RoadFrame {
  return {
    rows: 0,
    table: new Float32Array(maxRows * 8),
    d: new Float32Array(BOUNDARIES),
    x: new Float32Array(BOUNDARIES),
    y: new Float32Array(BOUNDARIES),
    sy: new Float32Array(BOUNDARIES),
    clip: new Float32Array(BOUNDARIES),
    camHeight: 1,
    camY: 1,
    distance: 0,
    curve0: 0,
    refStep: 0,
    camYNext: 1,
    yaw: 0,
  };
}

/** Fog over the road and scenery, 0..1 by distance. */
const fogAt = (z: number) => 0.92 * (1 - Math.exp(-Math.max(0, z - 4) / 26));

/** Screen y (frame heights below the horizon) of a point `height` below the camera at distance `z`. */
export const projectY = (height: number, z: number) => (height * FOCAL) / z;

/** Screen x (frame heights right of centre) of a point `x` units right of the camera at distance `z`. */
export const projectX = (x: number, z: number) => (x * FOCAL) / z;

/**
 * Projects the road ahead for the camera `distance` along it, `camHeight`
 * above the road and moving at `speed`: the boundaries one unit apart, then
 * each of `rows` low-res rows' nearest visible ground (none above the hills'
 * crest or the horizon). Rows whose stripes would move faster than the codec's
 * per-frame limit, or crowd closer than a couple of rows, fade their stripes'
 * contrast out, the way motion blur would.
 */
export function projectRoad(
  frame: RoadFrame,
  course: Course,
  distance: number,
  camHeight: number,
  speed: number,
  rows: number,
): void {
  const n = Math.max(1, Math.min(rows, frame.table.length / 8));
  frame.rows = n;
  frame.distance = distance;
  frame.camHeight = camHeight;
  const camY = sampleLoop(course.elev, distance) + camHeight;
  frame.camY = camY;
  const k0 = sampleLoop(course.curve, distance);
  frame.curve0 = k0;
  const refStep = Math.max(0, speed) * REF_FRAME;
  frame.refStep = refStep;
  frame.camYNext = sampleLoop(course.elev, distance + refStep) + camHeight;

  const { d, x, y, sy, clip } = frame;
  let theta = k0 * NEAR;
  let lateral = (k0 * NEAR * NEAR) / 2;
  let kPrev = sampleLoop(course.curve, distance + NEAR);
  for (let i = 0; i < BOUNDARIES; i++) {
    const di = NEAR + i;
    if (i > 0) {
      const k = sampleLoop(course.curve, distance + di);
      const next = theta + (kPrev + k) / 2;
      lateral += (theta + next) / 2;
      theta = next;
      kPrev = k;
    }
    d[i] = di;
    x[i] = lateral;
    y[i] = camY - sampleLoop(course.elev, distance + di);
    sy[i] = projectY(y[i], di);
    clip[i] = i === 0 ? sy[0] : Math.min(clip[i - 1], sy[i]);
  }
  // Turn the camera to face the road at the car, so the car stays in its lane
  // on screen through the bends (most noticeable on narrow frames, where the
  // car is farther ahead).
  const fi = clamp(carDistance(camHeight) - NEAR, 0, BOUNDARIES - 1.001);
  const ci = Math.floor(fi);
  const yaw = (x[ci] + (x[ci + 1] - x[ci]) * (fi - ci)) / (NEAR + fi);
  frame.yaw = yaw;
  for (let i = 0; i < BOUNDARIES; i++) {
    x[i] -= yaw * d[i];
  }

  const table = frame.table;
  const plane = n * 4;
  let row = n - 1;
  // Sharp up to 65 % of the limit and blurred out by 95 %, a margin for the
  // row table's straight steps between boundaries.
  const lowLimit = 0.65 * LIMIT;
  const highLimit = 0.95 * LIMIT;
  for (let i = 0; i + 1 < BOUNDARIES && row >= 0; i++) {
    const far = sy[i + 1];
    if (far >= clip[i]) {
      continue;
    }
    const near = sy[i];
    const span = far - near;
    const invA = 1 / d[i];
    const invB = 1 / d[i + 1];
    const xa = x[i] * invA;
    const xb = x[i + 1] * invB;
    const slope = y[i] - y[i + 1];
    while (row >= 0) {
      const yh = (row + 0.5) / n - HORIZON;
      if (yh <= far) {
        break;
      }
      const w = clamp((yh - near) / span, 0, 1);
      const inv = invA + (invB - invA) * w;
      const z = 1 / inv;
      const o = row * 4;
      table[o] = (xa + (xb - xa) * w) * FOCAL;
      table[o + 1] = ROAD_HALF * FOCAL * inv;
      const s = distance + z;
      table[o + 2] = s - Math.floor(s / LAP) * LAP;
      table[o + 3] = z;
      // The ground point under the row, now and a reference frame later.
      const ground = sampleLoop(course.elev, s);
      const zNext = Math.max(NEAR * 0.5, z - refStep);
      const moved = Math.abs(projectY(frame.camYNext - ground, zNext) - projectY(camY - ground, z));
      // Rows a band spans: the screen y's change along the road times the band's length.
      const bandRows = Math.abs((yh + slope * FOCAL) * inv) * BAND * n;
      table[plane + o] =
        (1 - smoothstep(lowLimit, highLimit, moved)) * smoothstep(1.2, 3, bandRows);
      table[plane + o + 1] = fogAt(z);
      table[plane + o + 2] = 0;
      table[plane + o + 3] = 0;
      row--;
    }
  }
  for (; row >= 0; row--) {
    const o = row * 4;
    table[o] = 0;
    table[o + 1] = 0;
    table[o + 2] = 0;
    table[o + 3] = 0;
    table[plane + o] = 0;
    table[plane + o + 1] = 1;
    table[plane + o + 2] = 0;
    table[plane + o + 3] = 0;
  }
}

/** A sprite projected for a frame: centre x, base y, half width, height (frame heights), the ground's top in front of it, and its motion. */
export interface SpriteProjection {
  x: number;
  base: number;
  halfWidth: number;
  height: number;
  /** Screen y below which nearer ground hides it. */
  clip: number;
  /** How far its farthest corner moves in one reference frame, px at 1080p. */
  motion: number;
  fog: number;
}

/**
 * Projects a `width` x `height` sprite standing `d` units ahead, `lateral`
 * units right of the road's centre, onto the frame. `advance` is how far it
 * moves forward itself in one reference frame (traffic). Returns false when it
 * is out of the drawn range.
 */
export function projectSprite(
  frame: RoadFrame,
  d: number,
  lateral: number,
  width: number,
  height: number,
  advance: number,
  out: SpriteProjection,
): boolean {
  const fi = d - NEAR;
  if (!(fi >= 0) || fi >= BOUNDARIES - 1) {
    return false;
  }
  const i = Math.floor(fi);
  const f = fi - i;
  const roadX = frame.x[i] + (frame.x[i + 1] - frame.x[i]) * f;
  const below = frame.y[i] + (frame.y[i + 1] - frame.y[i]) * f;
  const scale = FOCAL / d;
  out.x = (roadX + lateral) * scale;
  out.base = below * scale;
  out.halfWidth = (width / 2) * scale;
  out.height = height * scale;
  out.clip = frame.clip[i];
  out.fog = fogAt(d);

  // The same sprite one reference frame later: the camera has moved on and turned.
  const step = frame.refStep;
  const dNext = d - step + advance;
  if (dNext <= NEAR * 0.5) {
    out.motion = Infinity;
    return true;
  }
  const turn = frame.curve0 * step;
  const xNext =
    roadX + frame.yaw * step - (frame.curve0 * step * step) / 2 - dNext * turn + lateral;
  const sNext = FOCAL / dNext;
  const cx = xNext * sNext - out.x;
  const hw = (width / 2) * sNext - out.halfWidth;
  const baseNext = (below + frame.camYNext - frame.camY) * sNext;
  const db = baseNext - out.base;
  const dt = db - (height * sNext - out.height);
  const mx = Math.abs(cx) + Math.abs(hw);
  const my = Math.max(Math.abs(db), Math.abs(dt));
  out.motion = Math.hypot(mx, my) * 1080;
  return true;
}

/** Opacity for a sprite's motion: fades it out before it moves faster than the codec's per-frame limit. */
export const motionFade = (motionPx: number) =>
  1 - smoothstep(0.7 * MAX_FEATURE_PX_PER_FRAME, MAX_FEATURE_PX_PER_FRAME, motionPx);

/** Opacity of scenery near the draw distance, so it fades in out of the fog. */
export const distanceFade = (d: number) => 1 - smoothstep(DRAW - 12, DRAW - 1, d);

/**
 * The player car's screen x: its lane offset beside the road centre at its
 * distance, so it follows the bends.
 */
export function carScreenX(frame: RoadFrame, lane: number, carZ: number): number {
  const fi = clamp(carZ - NEAR, 0, BOUNDARIES - 1.001);
  const i = Math.floor(fi);
  const f = fi - i;
  const roadX = frame.x[i] + (frame.x[i + 1] - frame.x[i]) * f;
  return projectX(roadX + lane, carZ);
}

/** The peak screen speed of a lane change, frame heights a second, for a car at `carZ`. */
export const laneChangePeak = (carZ: number) =>
  (EASE_PEAK * 2 * LANE_X * FOCAL) / (LANE_SECONDS * carZ);
