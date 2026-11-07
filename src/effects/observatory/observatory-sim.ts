/**
 * Pure logic for the Observatory Dome (observatory.ts): the room's layout and
 * camera, the German equatorial mount's geometry (the tube's direction from
 * its two axis angles, and back), the schedule of slews between targets as a
 * pure function of time (the telescope's two axes and the dome's azimuth,
 * eased, with the dome lagging the telescope and settling after it), the desk
 * screen's images and the slow meteors glimpsed through the slit. Nothing here
 * touches GL, so it is all unit tested.
 *
 * World units are metres, y up. The dome's centre is on the floor at the
 * origin, where the pier stands, and north (where the polar axis points) is
 * -z, straight ahead of the camera. The scene is laid out with the telescope
 * on the left; the shader mirrors it for the right. Screen positions are
 * reference px of a 1080-high frame, y up.
 */
import { type Meteor, meteorGap } from "../desertcamp/desertcamp-sim";
import { approach, clamp } from "../math";
import { createRng, hash32 } from "../noise";
import { MAX_SLEW_GAP, MIN_SLEW_GAP } from "./observatory.meta";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
export const REF_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Room and camera
// ---------------------------------------------------------------------------

/** Dome radius, and the height of its centre (the top of the drum wall below it). */
export const DOME_R = 6;
export const WALL_H = 2.2;
/** Half width of the slit (m), the dome elevation of its lower end, and how far it runs past the zenith (m). */
export const SLIT_HALF = 1.35;
export const SLIT_FROM = 17 * DEG;
export const SLIT_PAST = 1.4;
/** Width of the shutters' edges along the slit, m. */
export const SLIT_LIP = 0.16;
/** Meridian ribs round the dome, and the dome elevation between its rings. */
export const RIBS = 24;
export const RING_STEP = 15 * DEG;

/** Camera position (telescope on the left), upward pitch and focal length (frame heights). */
export const CAM_X = 3;
export const CAM_Y = 1.35;
export const CAM_Z = 4.6;
export const PITCH = 15 * DEG;
export const FOCAL = 0.8;

/** Camera basis: right, up and forward (unit vectors). */
export const CAM_RIGHT = [1, 0, 0] as const;
export const CAM_UP = [0, Math.cos(PITCH), Math.sin(PITCH)] as const;
export const CAM_FWD = [0, Math.sin(PITCH), -Math.cos(PITCH)] as const;

/** Mirrors a reference-px x for the telescope on `side`. */
export const sideX = (x: number, refWidth: number, side: string) =>
  side === "right" ? refWidth - x : x;

/**
 * Screen position (reference px, y up, telescope on the left) of world point
 * `(x, y, z)` in a frame `refWidth` wide; false if it is behind the camera.
 */
export function project(
  x: number,
  y: number,
  z: number,
  refWidth: number,
  out: [number, number],
): boolean {
  const dx = x - CAM_X;
  const dy = y - CAM_Y;
  const dz = z - CAM_Z;
  const depth = dx * CAM_FWD[0] + dy * CAM_FWD[1] + dz * CAM_FWD[2];
  if (!(depth > 1e-6)) {
    return false;
  }
  const f = (FOCAL * REF_HEIGHT) / depth;
  out[0] = refWidth / 2 + f * (dx * CAM_RIGHT[0] + dy * CAM_RIGHT[1] + dz * CAM_RIGHT[2]);
  out[1] = REF_HEIGHT / 2 + f * (dx * CAM_UP[0] + dy * CAM_UP[1] + dz * CAM_UP[2]);
  return true;
}

/** Point on the dome at azimuth `az` (from -z towards +x) and dome elevation `el`. */
export function domePoint(az: number, el: number, out: number[]): number[] {
  out[0] = DOME_R * Math.sin(az) * Math.cos(el);
  out[1] = WALL_H + DOME_R * Math.sin(el);
  out[2] = -DOME_R * Math.cos(az) * Math.cos(el);
  return out;
}

/** Work lights: red lamps low on the drum wall (x, y, z), and one on the pier. */
export const WALL_LAMPS = [
  [-3.9, 0.45, -4.4],
  [1.4, 0.45, -5.75],
  [5.1, 0.45, -3.0],
] as const;
export const PIER_LAMP = [0.12, 0.7, 0.3] as const;

/** The desk in the near corner: its box (min and max corners) and the screen standing on it. */
export const DESK_MIN = [3.3, 0, 1.7] as const;
export const DESK_MAX = [4.9, 0.76, 2.9] as const;
/** Screen centre and half size (width, height); it faces the camera (+z). */
export const SCREEN_AT = [3.9, 0.95, 2.1] as const;
export const SCREEN_HALF = [0.21, 0.14] as const;

// ---------------------------------------------------------------------------
// The mount
// ---------------------------------------------------------------------------

/** Latitude: the polar axis's elevation, pointing north. */
export const LATITUDE = 40 * DEG;
/** Pier radius and height, and where the two axes cross. */
export const PIER_R = 0.26;
export const PIER_H = 1.2;
export const HEAD = [0, 1.66, 0] as const;
/** Tube: its centre's offset along the declination axis, length behind and ahead of it, radius. */
export const DEC_OFFSET = 0.52;
export const TUBE_BACK = 0.95;
export const TUBE_FRONT = 1.9;
export const TUBE_R = 0.27;
/** Counterweight bar's reach and the weight's span along it, from the head. */
export const BAR_REACH = 1.05;
export const WEIGHT_SPAN = [0.7, 0.92] as const;

/** Polar axis (north, up at the latitude) and two unit vectors square to it. */
export const POLAR = [0, Math.sin(LATITUDE), -Math.cos(LATITUDE)] as const;
const AXIS_U = [1, 0, 0] as const;
const AXIS_V = [0, -Math.cos(LATITUDE), -Math.sin(LATITUDE)] as const;

/** The tube's unit direction at hour angle `ha` and declination `dec`. */
export function pointing(ha: number, dec: number, out: number[]): number[] {
  const ch = Math.cos(ha);
  const sh = Math.sin(ha);
  const cd = Math.cos(dec);
  const sd = Math.sin(dec);
  for (let i = 0; i < 3; i++) {
    out[i] = cd * (ch * AXIS_U[i] + sh * AXIS_V[i]) + sd * POLAR[i];
  }
  return out;
}

/** The declination axis's unit direction at hour angle `ha`: the tube's side of the mount. */
export function decAxis(ha: number, out: number[]): number[] {
  const ch = Math.cos(ha);
  const sh = Math.sin(ha);
  for (let i = 0; i < 3; i++) {
    out[i] = -sh * AXIS_U[i] + ch * AXIS_V[i];
  }
  return out;
}

/** The axis angles (`[ha, dec]`) that point the tube along unit `dir`; the inverse of `pointing`. */
export function axesFor(dir: readonly number[], out: [number, number]): [number, number] {
  const sd = clamp(dir[0] * POLAR[0] + dir[1] * POLAR[1] + dir[2] * POLAR[2], -1, 1);
  let eu = 0;
  let ev = 0;
  for (let i = 0; i < 3; i++) {
    const e = dir[i] - sd * POLAR[i];
    eu += e * AXIS_U[i];
    ev += e * AXIS_V[i];
  }
  out[0] = Math.atan2(ev, eu);
  out[1] = Math.asin(sd);
  return out;
}

/** Unit direction at azimuth `az` (from -z towards +x) and altitude `alt`. */
export function azAltDir(az: number, alt: number, out: number[]): number[] {
  out[0] = Math.sin(az) * Math.cos(alt);
  out[1] = Math.sin(alt);
  out[2] = -Math.cos(az) * Math.cos(alt);
  return out;
}

/** Azimuth of direction `dir`, from -z towards +x. */
export const azimuthOf = (dir: readonly number[]) => Math.atan2(dir[0], -dir[2]);

/** `b - a` wrapped to (-π, π]. */
export function angleDiff(a: number, b: number): number {
  const d = b - a;
  return d - TAU * Math.ceil((d - Math.PI) / TAU);
}

/** Sky pole (reference px, telescope on the left) for a frame `refWidth` wide: the polar axis on screen. */
export function skyPole(refWidth: number, out: [number, number]): [number, number] {
  const depth = POLAR[1] * CAM_FWD[1] + POLAR[2] * CAM_FWD[2];
  const f = (FOCAL * REF_HEIGHT) / depth;
  out[0] = refWidth / 2;
  out[1] = REF_HEIGHT / 2 + f * (POLAR[1] * CAM_UP[1] + POLAR[2] * CAM_UP[2]);
  return out;
}

// ---------------------------------------------------------------------------
// Targets and slews
// ---------------------------------------------------------------------------

/** Targets' azimuth and altitude ranges (towards the frame's centre, through the slit). */
export const AZ_RANGE = [6 * DEG, 40 * DEG] as const;
export const ALT_RANGE = [50 * DEG, 74 * DEG] as const;
/** Kinds of target the desk screen shows. */
export const TARGET_KINDS = 3;
export const GALAXY = 0;
export const NEBULA = 1;
export const CLUSTER = 2;

/** A slew starts at a random point in the first `SLEW_JITTER` of its slot of `slewGap` seconds. */
export const SLEW_JITTER = 0.3;
/** Shortest and longest slew, s. */
export const SLEW_MIN = 10;
export const SLEW_MAX = 20;
/** The dome starts turning this long after the telescope, and settles this long after it stops. */
export const DOME_LAG = 1.5;
export const DOME_SETTLE = 5;
/** Tracking: the hour angle grows at the sidereal rate, radians per second. */
export const SIDEREAL = TAU / 86164;

/** One target: where it is in the sky (when its slew starts) and how its image looks. */
export interface Target {
  az: number;
  alt: number;
  /** GALAXY, NEBULA or CLUSTER. */
  kind: number;
  /** The image's tilt (radians), and two shape values (0..1). */
  angle: number;
  shapeA: number;
  shapeB: number;
}

export const createTarget = (): Target => ({
  az: 0,
  alt: 0,
  kind: 0,
  angle: 0,
  shapeA: 0,
  shapeB: 0,
});

/** A uniform 0..1 for slew or target `k` of `seed`, salted by `salt`. */
function rand(seed: number, k: number, salt: number): number {
  const s = hash32(Math.imul(Math.floor(seed), 0x9e3779b1) ^ salt);
  return hash32(s ^ Math.imul(k, 0x85ebca6b)) / 4294967296;
}

const GOLDEN = 0.6180339887;
const SILVER = 0.4142135624;

/**
 * Target `k` of `seed`. Successive targets step through the azimuth and
 * altitude ranges by roughly the golden and silver ratios, so each slew moves
 * a fair way and none repeats the last.
 */
export function targetOf(seed: number, k: number, out: Target): Target {
  const fa = k * GOLDEN + 0.25 * rand(seed, k, 11) + rand(seed, 0, 12);
  const fb = k * SILVER + 0.2 * rand(seed, k, 13) + rand(seed, 0, 14);
  out.az = AZ_RANGE[0] + (AZ_RANGE[1] - AZ_RANGE[0]) * (fa - Math.floor(fa));
  out.alt = ALT_RANGE[0] + (ALT_RANGE[1] - ALT_RANGE[0]) * (fb - Math.floor(fb));
  out.kind = Math.min(TARGET_KINDS - 1, Math.floor(TARGET_KINDS * rand(seed, k, 15)));
  out.angle = Math.PI * rand(seed, k, 16);
  out.shapeA = rand(seed, k, 17);
  out.shapeB = rand(seed, k, 18);
  return out;
}

const gapOf = (slewGap: number) =>
  clamp(Number.isFinite(slewGap) ? slewGap : MIN_SLEW_GAP, MIN_SLEW_GAP, MAX_SLEW_GAP);

/** Start time (s) of slew `k`: at a random point early in slot `k` of `slewGap` seconds. */
export function slewStart(seed: number, slewGap: number, k: number): number {
  return (k + SLEW_JITTER * rand(seed, k, 1)) * gapOf(slewGap);
}

/** Seconds slew `k` takes. */
export function slewDuration(seed: number, k: number): number {
  return SLEW_MIN + (SLEW_MAX - SLEW_MIN) * rand(seed, k, 2);
}

/** Smootherstep of `u` (clamped): eases in and out with no jolt at either end. */
export function ease(u: number): number {
  const x = clamp(u, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** The telescope's two axes, the dome's azimuth and the desk screen's images at one time. */
export interface ScopePose {
  ha: number;
  dec: number;
  /** Azimuth the dome's slit faces. */
  dome: number;
  /** The previous target and the current (or next) one. */
  from: number;
  to: number;
  /** Desk screen cross-fade from `from`'s image to `to`'s, 0..1. */
  image: number;
  /** Slew progress, 0..1 (1 once it has arrived). */
  slew: number;
}

export const createPose = (): ScopePose => ({
  ha: 0,
  dec: 0,
  dome: 0,
  from: -1,
  to: 0,
  image: 1,
  slew: 1,
});

const tScratch = createTarget();
const dirScratch = [0, 0, 0];
const axesScratch: [number, number] = [0, 0];

/** Tracks target `k` at time `t`: writes its axes to `axesScratch` and returns its azimuth. */
function track(seed: number, slewGap: number, k: number, t: number): number {
  targetOf(seed, k, tScratch);
  axesFor(azAltDir(tScratch.az, tScratch.alt, dirScratch), axesScratch);
  axesScratch[0] += SIDEREAL * (t - slewStart(seed, slewGap, k));
  return azimuthOf(pointing(axesScratch[0], axesScratch[1], dirScratch));
}

/**
 * The pose at `time` seconds, a pure function of its arguments. Between slews
 * the telescope tracks its target (the hour angle creeps at the sidereal
 * rate) and the dome follows; slew `k` starts once in each `slewGap`-second
 * slot and swings both axes from target `k - 1` to target `k`, eased in and
 * out; the dome starts a moment later and settles a few seconds after the
 * telescope, ending in line with it. Allocates nothing.
 */
export function poseAt(seed: number, slewGap: number, time: number, out: ScopePose): ScopePose {
  const t = Number.isFinite(time) ? time : 0;
  const slot = Math.floor(t / gapOf(slewGap));
  const k = t >= slewStart(seed, slewGap, slot) ? slot : slot - 1;
  const start = slewStart(seed, slewGap, k);
  const duration = slewDuration(seed, k);
  const az0 = track(seed, slewGap, k - 1, t);
  const ha0 = axesScratch[0];
  const dec0 = axesScratch[1];
  const az1 = track(seed, slewGap, k, t);
  const u = clamp((t - start) / duration, 0, 1);
  const e = ease(u);
  out.ha = ha0 + angleDiff(ha0, axesScratch[0]) * e;
  out.dec = dec0 + (axesScratch[1] - dec0) * e;
  const ud = (t - start - DOME_LAG) / (duration + DOME_SETTLE - DOME_LAG);
  out.dome = az0 + angleDiff(az0, az1) * ease(ud);
  out.from = k - 1;
  out.to = k;
  out.image = e;
  out.slew = u;
  return out;
}

/** Blends pose `b` into `a` by `w` (0..1), angles the short way round, into `out`. */
export function blendPose(a: ScopePose, b: ScopePose, w: number, out: ScopePose): ScopePose {
  const k = clamp(w, 0, 1);
  out.ha = a.ha + angleDiff(a.ha, b.ha) * k;
  out.dec = a.dec + (b.dec - a.dec) * k;
  out.dome = a.dome + angleDiff(a.dome, b.dome) * k;
  out.from = b.from;
  out.to = b.to;
  out.image = b.image;
  out.slew = b.slew;
  return out;
}

/** Seconds a change of seed or slew gap takes to swing over to the new schedule. */
export const RESCHEDULE_TIME = 12;

/** Seconds the work lights take to come on or go off. */
export const LIGHT_FADE = 2;

/** Eases the work lights' level towards `target`, over at most `LIGHT_FADE` s. */
export function easeLights(current: number, target: number, dt: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt / LIGHT_FADE : 0;
  return approach(current, target, step);
}

// ---------------------------------------------------------------------------
// Meteors through the slit
// ---------------------------------------------------------------------------

/** Duration (s), length (reference px) and peak brightness ranges: slow and soft. */
export const METEOR_DURATION = [1.4, 2.4] as const;
export const METEOR_LENGTH = [150, 280] as const;
export const METEOR_BRIGHT = [0.3, 0.55] as const;
/** Dome elevation at which a meteor starts, in the slit, and its spread across it (reference px). */
export const METEOR_EL = 62 * DEG;
export const METEOR_SPREAD = 90;

export interface SlitMeteors {
  /** The latest meteor (at most one at a time). */
  current: Meteor;
  /** Time of the next start, s. */
  next: number;
  started: number;
  rand: () => number;
}

export function createSlitMeteors(seed: number): SlitMeteors {
  const r = createRng(Math.floor(Number.isFinite(seed) ? seed : 0) * 523 + 41);
  return {
    current: { start: -Infinity, duration: 1, x: 0, y: 0, dx: 0, dy: -1, length: 0, bright: 0 },
    next: 30 + 60 * r(),
    started: 0,
    rand: r,
  };
}

const slitScratch = [0, 0, 0];
const slitScreen: [number, number] = [0, 0];

/**
 * Advances the meteors to time `t` (s): starts each one that is due (when
 * `on`; otherwise due slots pass with nothing), high in the slit as it faces
 * azimuth `dome`, heading down it at a slant. Positions are reference px for
 * the telescope on `side` in a frame `refWidth` wide.
 */
export function stepSlitMeteors(
  m: SlitMeteors,
  t: number,
  on: boolean,
  dome: number,
  refWidth: number,
  side: string,
): void {
  while (t >= m.next) {
    const at = m.next;
    m.next += meteorGap(m.rand);
    if (!on) {
      continue;
    }
    const r = m.rand;
    const c = m.current;
    domePoint(dome, METEOR_EL, slitScratch);
    if (!project(slitScratch[0], slitScratch[1], slitScratch[2], refWidth, slitScreen)) {
      continue;
    }
    c.start = at;
    c.duration = METEOR_DURATION[0] + (METEOR_DURATION[1] - METEOR_DURATION[0]) * r();
    c.length = METEOR_LENGTH[0] + (METEOR_LENGTH[1] - METEOR_LENGTH[0]) * r();
    c.bright = METEOR_BRIGHT[0] + (METEOR_BRIGHT[1] - METEOR_BRIGHT[0]) * r();
    c.x = sideX(slitScreen[0] + METEOR_SPREAD * (2 * r() - 1), refWidth, side);
    c.y = Math.min(slitScreen[1], REF_HEIGHT * 0.95);
    // 55..80 degrees below the horizontal, either way.
    const a = (55 + 25 * r()) * DEG;
    c.dx = (r() < 0.5 ? -1 : 1) * Math.cos(a);
    c.dy = -Math.sin(a);
    m.started++;
  }
}

// ---------------------------------------------------------------------------
// Smooth rescheduling
// ---------------------------------------------------------------------------

/**
 * An offset that fades out after the schedule changes (a new seed or slew
 * gap), so the telescope and dome swing over to the new schedule's pose
 * instead of jumping to it.
 */
export interface Reschedule {
  ha: number;
  dec: number;
  dome: number;
  /** When the change happened, s; -Infinity for none. */
  start: number;
}

export const createReschedule = (): Reschedule => ({
  ha: 0,
  dec: 0,
  dome: 0,
  start: -Infinity,
});

/** Starts a swing at `time` from the pose on show, `shown`, to the new schedule's pose there, `next`. */
export function reschedule(r: Reschedule, shown: ScopePose, next: ScopePose, time: number): void {
  r.ha = angleDiff(next.ha, shown.ha);
  r.dec = shown.dec - next.dec;
  r.dome = angleDiff(next.dome, shown.dome);
  r.start = time;
}

/** The pose to show at `time`: the schedule's `pose` plus what is left of the swing, into `out`. */
export function applyReschedule(
  r: Reschedule,
  pose: ScopePose,
  time: number,
  out: ScopePose,
): ScopePose {
  const k = 1 - ease((time - r.start) / RESCHEDULE_TIME);
  out.ha = pose.ha + r.ha * k;
  out.dec = pose.dec + r.dec * k;
  out.dome = pose.dome + r.dome * k;
  out.from = pose.from;
  out.to = pose.to;
  out.image = pose.image;
  out.slew = pose.slew;
  return out;
}

// ---------------------------------------------------------------------------
// The slit on screen
// ---------------------------------------------------------------------------

/** Points sampled along each edge of the slit, and the margin added round them (reference px). */
const SLIT_SAMPLES = 12;
export const SLIT_MARGIN = 24;

const boundPoint = [0, 0, 0];
const boundScreen: [number, number] = [0, 0];

/**
 * Screen box (reference px: x0, y0, x1, y1, clipped to the frame) round the
 * slit and its shutter edges while it faces azimuth `dome`, for the telescope
 * on `side`: the only place the sky can show.
 */
export function slitBounds(dome: number, refWidth: number, side: string, out: number[]): number[] {
  const fx = Math.sin(dome);
  const fz = -Math.cos(dome);
  const half = SLIT_HALF + SLIT_LIP;
  const lo = -SLIT_PAST - SLIT_LIP;
  const hi = DOME_R * Math.cos(SLIT_FROM) - 0.02;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let s = -1; s <= 1; s++) {
    for (let i = 0; i <= SLIT_SAMPLES; i++) {
      const a = lo + ((hi - lo) * i) / SLIT_SAMPLES;
      const up = Math.sqrt(Math.max(0, DOME_R * DOME_R - a * a - half * half));
      boundPoint[0] = fx * a - fz * s * half;
      boundPoint[1] = WALL_H + up;
      boundPoint[2] = fz * a + fx * s * half;
      if (!project(boundPoint[0], boundPoint[1], boundPoint[2], refWidth, boundScreen)) {
        // Behind the camera: be safe and take the whole frame's width and top.
        x0 = -Infinity;
        x1 = Infinity;
        y1 = Infinity;
        continue;
      }
      x0 = Math.min(x0, boundScreen[0]);
      x1 = Math.max(x1, boundScreen[0]);
      y0 = Math.min(y0, boundScreen[1]);
      y1 = Math.max(y1, boundScreen[1]);
    }
  }
  const ax = sideX(x0, refWidth, side);
  const bx = sideX(x1, refWidth, side);
  out[0] = clamp(Math.min(ax, bx) - SLIT_MARGIN, 0, refWidth);
  out[1] = clamp(y0 - SLIT_MARGIN, 0, REF_HEIGHT);
  out[2] = clamp(Math.max(ax, bx) + SLIT_MARGIN, 0, refWidth);
  out[3] = clamp(y1 + SLIT_MARGIN, 0, REF_HEIGHT);
  return out;
}
