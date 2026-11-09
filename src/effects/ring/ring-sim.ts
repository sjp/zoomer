/**
 * Station Ring motion: the station's turn, the planet (or moon) outside and
 * when it is in view, and the wall indicator's rare colour changes. Pure, so
 * the tests can check the timing.
 *
 * Directions outside are in two frames. The station frame is the room's world
 * frame (see ring-layout.ts). The sky frame is fixed to the stars; the station
 * turns about the ring's axis (x), so a direction with azimuth psi in the sky
 * frame (`azimuth`, 0 straight ahead, positive upwards) has azimuth
 * psi + spinAngle(phase) in the station frame.
 */
import { clamp, smoothstep, wrap } from "../math";
import { hash32 } from "../noise";
import { MAX_SPIN, MIN_SPIN, type BodyId } from "./ring.meta";
import { windowAzimuths } from "./ring-layout";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** The turn's phase at start: the planet is just below the windows, about to rise. */
export const START_PHASE = 0.93;

/** Seconds per turn for the `spin` param, clamped to its range. */
export const spinSeconds = (spin: number) =>
  clamp(Number.isFinite(spin) ? spin : MIN_SPIN, MIN_SPIN, MAX_SPIN);

/**
 * Advances the turn's phase (turns, in [0, 1)) by `dt` seconds at `spin`
 * seconds per turn. Keeping the phase rather than time means a change of
 * `spin` changes only the speed, never the angle.
 */
export function advanceSpin(phase: number, dt: number, spin: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  return wrap(phase + step / spinSeconds(spin), 0, 1);
}

/** The station's rotation angle (radians, [0, 2pi)) at this phase. */
export const spinAngle = (phase: number) => TAU * wrap(phase, 0, 1);

/** How a body looks from the station. */
interface BodySpec {
  /** Angular radius (radians). */
  radius: number;
  /** Longitude and latitude (radians) of the point facing the station. */
  lon: number;
  lat: number;
  /** Roll of its north pole from the sky's "up" (radians). */
  roll: number;
}

export const BODIES: Readonly<Record<Exclude<BodyId, "none">, BodySpec>> = {
  // Africa and Europe facing, a large disc: the station is in a fairly low orbit.
  earth: { radius: 16 * DEG, lon: 18 * DEG, lat: 18 * DEG, roll: -20 * DEG },
  moon: { radius: 8 * DEG, lon: 0, lat: 0, roll: 10 * DEG },
};

/** Angle (radians) of the body's centre from the ring's axis (+x, towards the window wall). */
export const BODY_POLAR = 70 * DEG;
/** Its azimuth in the sky frame. */
export const BODY_AZIMUTH = 0;

/** A body's placement in the sky frame, all unit vectors. */
interface BodyFrame {
  /** Towards the body's centre. */
  centre: [number, number, number];
  /** Towards the sun. */
  sun: [number, number, number];
  /** Rows of the sky-to-body rotation: east, north and the (lon 0, lat 0) axis. */
  basis: [number, number, number, number, number, number, number, number, number];
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: V3): V3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** Unit direction at `polar` from +x and `azimuth` about it (0 along +z, positive towards +y). */
export function skyDirection(polar: number, az: number): V3 {
  const r = Math.sin(polar);
  return [Math.cos(polar), r * Math.sin(az), r * Math.cos(az)];
}

/**
 * Where a body sits and how it is turned. The sun lights it from above and a
 * little to the side, so it shows a broad gibbous phase while it passes.
 */
export function bodyFrame(spec: BodySpec): BodyFrame {
  const centre = skyDirection(BODY_POLAR, BODY_AZIMUTH);
  const f = scale(centre, -1);
  // "Up" across the disc: the sky's y, made perpendicular to the line of sight.
  const up = normalize(add([0, 1, 0], scale(f, -f[1])));
  const side = cross(f, up);
  const sun = normalize(add(add(scale(f, 0.5), scale(up, 0.75)), scale(side, 0.35)));
  const n0 = add(scale(up, Math.cos(spec.roll)), scale(side, Math.sin(spec.roll)));
  const north = normalize(add(scale(n0, Math.cos(spec.lat)), scale(f, Math.sin(spec.lat))));
  const g = normalize(add(f, scale(north, -dot(f, north))));
  const east = cross(north, g);
  const bz = add(scale(g, Math.cos(spec.lon)), scale(east, -Math.sin(spec.lon)));
  const bx = add(scale(g, Math.sin(spec.lon)), scale(east, Math.cos(spec.lon)));
  return { centre, sun, basis: [...bx, ...north, ...bz] };
}

/** The body's centre azimuth in the station frame at this phase, in (-pi, pi]. */
export function bodyAzimuth(phase: number): number {
  const a = wrap(BODY_AZIMUTH + spinAngle(phase), -Math.PI, TAU);
  return a === -Math.PI ? Math.PI : a;
}

/** The windows' azimuth range from the eye, computed once. */
export const WINDOW_AZIMUTHS = windowAzimuths();

/**
 * How far the body is in view through the windows (0..1) at this phase: 1
 * while its centre is within the windows' azimuth range, easing to 0 as its
 * disc leaves it. Above 0 for (span + 2 radius) / 2pi of each turn.
 */
export function bodyInView(phase: number, radius: number): number {
  const a = bodyAzimuth(phase);
  const [lo, hi] = WINDOW_AZIMUTHS;
  return smoothstep(lo - radius, lo + radius, a) * (1 - smoothstep(hi - radius, hi + radius, a));
}

/** Strength of the blue wash a body casts on the floor at full view. */
export const WASH: Readonly<Record<BodyId, number>> = { earth: 0.08, moon: 0.035, none: 0 };

/** The wall indicator: seconds between chances to change, and the crossfade's length. */
export const INDICATOR_PERIOD = 75;
export const INDICATOR_FADE = 3;
/** Its soft lamp colours (linear-ish RGB, 0..1). */
const INDICATOR_COLOURS: readonly (readonly [number, number, number])[] = [
  [0.35, 0.85, 0.5],
  [1.0, 0.7, 0.25],
  [0.45, 0.7, 1.0],
];

const indicatorIndex = (slot: number) =>
  hash32((Math.floor(slot) * 0x9e3779b1) >>> 0) % INDICATOR_COLOURS.length;

/**
 * The indicator's colour at time `t` (seconds, unwrapped): each period picks a
 * colour (often the same one again), and a change crossfades over
 * `INDICATOR_FADE` seconds at the start of the period.
 */
export function indicatorColour(t: number, out: V3): V3 {
  const slot = Math.floor(t / INDICATOR_PERIOD);
  const k = smoothstep(0, INDICATOR_FADE, t - slot * INDICATOR_PERIOD);
  const a = INDICATOR_COLOURS[indicatorIndex(slot - 1)];
  const b = INDICATOR_COLOURS[indicatorIndex(slot)];
  for (let i = 0; i < 3; i++) {
    out[i] = a[i] + (b[i] - a[i]) * k;
  }
  return out;
}
