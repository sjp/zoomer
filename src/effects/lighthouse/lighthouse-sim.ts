/**
 * Pure logic for the Lighthouse in Fog effect: the beam's rotation and its 2D
 * projection, the flare as it faces the viewer, and the scene layout (headland
 * profile, tower and lantern), in height units (0 at the bottom, 1 at the top).
 */
import { approach, clamp, smoothstep, wrap } from "../math";

const TAU = Math.PI * 2;

/** Sky meets sea here. */
export const HORIZON = 0.31;
/** Where the headland meets the sea: below the horizon, so the sea shows in front of it. */
export const Y_WATER = 0.25;

/**
 * Headland silhouette: a plateau from the frame edge, a steep cliff, then a
 * low spit of rocks. `d` is the distance from the headland's frame edge.
 */
export const LAND_TOP = 0.405;
export const CLIFF_START = 0.33;
export const CLIFF_END = 0.43;
export const ROCK_HEIGHT = 0.022;
export const ROCK_START = 0.42;
export const ROCK_END = 0.56;
/** Beyond this distance the headland is below the waterline everywhere. */
export const LAND_END = 0.6;
/** Slow undulation along the top, two sines (amplitude, frequency, phase each). */
export const LAND_BUMPS = [0.01, 17, 0.6, 0.006, 41, 2.1] as const;

/** Tower: distance from the frame edge, height, half-widths at foot and top. */
export const TOWER_D = 0.24;
export const TOWER_HEIGHT = 0.19;
export const TOWER_FOOT = 0.024;
export const TOWER_TOP = 0.016;
/** Gallery (the balcony under the lantern): height and overhang. */
export const GALLERY_HEIGHT = 0.008;
export const GALLERY_OVERHANG = 0.007;
/** Lantern room height and half-width (share of the tower top's). */
export const LANTERN_HEIGHT = 0.034;
export const LANTERN_WIDTH = 0.78;
/** Conical cap height and base half-width (share of the tower top's). */
export const CAP_HEIGHT = 0.026;
export const CAP_WIDTH = 0.95;
/** The tower is sunk this far into the ground so its foot meets the slope. */
export const TOWER_SINK = 0.004;

/** Physical half-angle of the beam's cone, radians. */
export const BEAM_HALF_ANGLE = (4.5 * Math.PI) / 180;
/** On-screen beam length (height units): pointing at or away from the viewer, and side-on. */
export const BEAM_MIN_LENGTH = 0.1;
export const BEAM_MAX_LENGTH = 1.3;
/** Beam brightness side-on, and the extra pointing toward and away from the viewer. */
export const BEAM_SIDE = 0.3;
export const BEAM_FRONT = 0.7;
export const BEAM_BACK = 0.35;
/** Standard deviation of the flare's bump around facing the viewer (about 14° across at half height). */
export const FLARE_SIGMA = (6 * Math.PI) / 180;
/** Largest downward tilt of the beam, degrees, and how fast the beam eases to a new tilt, degrees per second. */
export const MAX_TILT = 30;
export const TILT_RATE = 2;

/** Height of the headland's top at distance `d` from its frame edge. */
export function headlandHeight(d: number): number {
  const [a1, f1, p1, a2, f2, p2] = LAND_BUMPS;
  const bumps = a1 * Math.sin(d * f1 + p1) + a2 * Math.sin(d * f2 + p2);
  const cliff = 1 - smoothstep(CLIFF_START, CLIFF_END, d);
  const rocks = 1 - smoothstep(ROCK_START, ROCK_END, d);
  return Y_WATER - 0.01 + (LAND_TOP - Y_WATER + bumps) * cliff + ROCK_HEIGHT * rocks;
}

/** Height of the tower's foot, sunk a little into the headland. */
export function towerBase(): number {
  return headlandHeight(TOWER_D) - TOWER_SINK;
}

/** Height of the lantern's centre, where the beam starts. */
export function lanternHeight(): number {
  return towerBase() + TOWER_HEIGHT + GALLERY_HEIGHT + LANTERN_HEIGHT * 0.5;
}

/** Advances the rotation phase (turns, wrapped to 0..1) by `dt` seconds at `period` seconds per turn. */
export function advancePhase(phase: number, dt: number, period: number): number {
  return period > 0 ? wrap(phase + dt / period, 0, 1) : phase;
}

/**
 * Azimuth of beam `index` (0 or 1, the second opposite the first) at rotation
 * `phase` (turns): 0 points at the viewer, π/2 to the right.
 */
export function beamAngle(phase: number, index: number): number {
  return TAU * (phase + index * 0.5);
}

/** A beam as drawn: a soft 2D wedge from the lantern. */
export interface BeamProjection {
  /** On-screen direction, a unit vector (y up). Level beams point straight left or right. */
  dirX: number;
  dirY: number;
  /** Cosine of the wedge's on-screen half-angle. */
  cosHalf: number;
  /** On-screen length (height units), the distance falloff's scale. */
  length: number;
  /** Brightness, 0..1. */
  brightness: number;
  /**
   * How far the wedge has opened into a round glow (0 a pure wedge, 1 round).
   * It is 1 exactly where a level beam's `dirX` flips, so the drawn beam is continuous.
   */
  roundness: number;
}

export function createBeamProjection(): BeamProjection {
  return { dirX: 1, dirY: 0, cosHalf: 1, length: BEAM_MIN_LENGTH, brightness: 0, roundness: 1 };
}

/** Degrees to radians. */
function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Projects the beam at azimuth `theta`, tilted `tilt` degrees below level, onto
 * the screen, into `out`. Side-on, the beam is long, narrow and faint. Turning
 * toward (or away from) the viewer, it foreshortens: shorter, wider and
 * brighter, until (when level) it is a round glow. A tilted beam never points
 * straight at the viewer, so it sweeps down through the frame instead.
 */
export function projectBeam(theta: number, out: BeamProjection, tilt = 0): BeamProjection {
  const d = rad(clamp(tilt, 0, 90));
  const cd = Math.cos(d);
  // The beam's direction: x right, y up, z toward the viewer.
  const vx = Math.sin(theta) * cd;
  const vy = -Math.sin(d);
  const vz = Math.cos(theta) * cd;
  const side = Math.min(Math.hypot(vx, vy), 1);
  if (side > 1e-9) {
    out.dirX = vx / side;
    out.dirY = vy / side;
  } else {
    out.dirX = vx < 0 ? -1 : 1;
    out.dirY = 0;
  }
  // A cone of half-angle α whose axis makes a screen-plane share `side` spans atan(tan α / side) on screen.
  out.cosHalf = Math.cos(Math.atan2(Math.tan(BEAM_HALF_ANGLE), side));
  out.length = BEAM_MIN_LENGTH + (BEAM_MAX_LENGTH - BEAM_MIN_LENGTH) * side;
  const front = Math.max(vz, 0);
  const back = Math.max(-vz, 0);
  out.brightness = BEAM_SIDE + BEAM_FRONT * front * front + BEAM_BACK * back * back;
  const open = 1 - side;
  out.roundness = open * open * open * open;
  return out;
}

/**
 * Flare from beam azimuth `theta` and `tilt` (degrees below level): a smooth bump
 * in the angle between the beam and the viewer (level with the lantern), 1
 * facing the viewer, about 0 elsewhere. Tilting the beam down dims it.
 */
export function flareAt(theta: number, tilt = 0): number {
  const d = rad(clamp(tilt, 0, 90));
  const cd = Math.cos(d);
  const a = Math.atan2(Math.hypot(Math.sin(theta) * cd, Math.sin(d)), Math.cos(theta) * cd);
  return Math.exp(-0.5 * (a / FLARE_SIGMA) ** 2);
}

/** Eases the drawn tilt toward the `target` tilt (degrees) over `dt` seconds; NaN starts at the target. */
export function easeTilt(current: number, target: number, dt: number): number {
  const t = clamp(Number.isFinite(target) ? target : 0, 0, MAX_TILT);
  if (Number.isNaN(current)) {
    return t;
  }
  return approach(current, t, Math.max(dt, 0) * TILT_RATE);
}

/** Total flare of `beams` (1 or 2) at rotation `phase` and `tilt` (degrees), 0..1. */
export function flareTotal(phase: number, beams: number, tilt = 0): number {
  let f = flareAt(beamAngle(phase, 0), tilt);
  if (beams > 1) {
    f += flareAt(beamAngle(phase, 1), tilt);
  }
  return clamp(f, 0, 1);
}

/** Fog layers: centre height, half-thickness, density gain, drift speed (noise tiles per second at drift 1). */
export const FOG_LAYERS = [
  [0.3, 0.13, 1.0, 0.012],
  [0.53, 0.14, 0.8, 0.008],
  [0.8, 0.12, 0.5, 0.005],
] as const;
