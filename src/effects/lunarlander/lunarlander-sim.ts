/**
 * Pure logic for the Lunar Lander Cabin (lunarlander.ts): the cabin's layout
 * (the two triangular windows, the panels, gauges and master alarm lamp), the
 * camera looking out, the gauges' needles, the slow sun, and the schedules of
 * the warning lamp, the distant dust plume, the drifting dust and the optional
 * lift-off. Nothing here touches GL, so it is all unit tested.
 *
 * Layout units are "frame units": the origin at the frame's centre, y up, and
 * one unit the frame's height, so y runs -0.5..0.5 and x -aspect/2..aspect/2.
 * Everything is laid out for 16:9 and mirrored left and right; narrower frames
 * squeeze it sideways, wider ones stretch the outer panels to the edges.
 */
import { clamp, fract, smoothstep } from "../math";
import { hash32 } from "../noise";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** Eye height above the ground (m), the downward pitch, and the vertical field of view. */
export const EYE_H = 4.5;
export const PITCH = 11 * DEG;
const FOV_Y = 60 * DEG;
export const TAN_HALF_FOV = Math.tan(FOV_Y / 2);
/** The Moon's radius (m). */
export const MOON_R = 1737400;

/** Frame-units height of a direction `elevation` radians above the horizontal, on the frame's centre line. */
export function elevationY(elevation: number): number {
  return Math.tan(elevation + PITCH) / (2 * TAN_HALF_FOV);
}

/** Where the (flat) horizon crosses the frame. */
export const HORIZON_Y = elevationY(0);

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The aspect the layout is drawn for. */
const DESIGN_ASPECT = 16 / 9;
/** Width of the windows' frames, round the glass. */
export const FRAME_W = 0.04;

export const SWITCHES = 0;
export const BREAKERS = 1;
export const LAMPS = 2;
export const CHECKLIST = 3;

interface Panel {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  kind: number;
}

interface Dial {
  x: number;
  y: number;
  r: number;
}

export interface CabinLayout {
  aspect: number;
  /** The right window's glass: inner top, outer top and bottom corners (x, y pairs). The left mirrors it. */
  window: [number, number, number, number, number, number];
  panels: Panel[];
  dials: Dial[];
  /** The master alarm lamp: centre and half sizes. */
  lamp: [number, number, number, number];
  /** The Earth's centre in the right window (the left mirrors it), and its radius. */
  earth: [number, number, number];
}

/** Most panels and dials the cabin shader takes. */
export const MAX_PANELS = 16;
export const MAX_DIALS = 8;

/**
 * The cabin for a frame of `aspect`. The middle, where the speaker stands, is a
 * plain bulkhead; the windows sit either side of their head, the busy panels
 * below and above them and out at the edges.
 */
export function cabinLayout(aspect: number): CabinLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  const k = Math.min(1, a / DESIGN_ASPECT);
  const edge = a / 2;
  const x = (v: number) => v * k;
  // Right-hand side; the left mirrors it.
  const right: Panel[] = [
    { x0: x(0.24), y0: 0.45, x1: edge, y1: 0.5, kind: BREAKERS },
    { x0: x(0.845), y0: -0.135, x1: edge, y1: 0.45, kind: SWITCHES },
    { x0: x(0.4), y0: -0.135, x1: x(0.845), y1: 0.4, kind: SWITCHES },
    { x0: x(0.3), y0: -0.28, x1: x(0.6), y1: -0.145, kind: SWITCHES },
    { x0: x(0.6), y0: -0.28, x1: edge, y1: -0.145, kind: LAMPS },
    { x0: x(0.3), y0: -0.5, x1: edge, y1: -0.29, kind: SWITCHES },
  ];
  const left = right.map((p, i) => ({
    x0: -p.x1,
    y0: p.y0,
    x1: -p.x0,
    y1: p.y1,
    // Breakers rather than lamps on the left, for variety.
    kind: i === 4 ? BREAKERS : p.kind,
  }));
  const rightDials: Dial[] = [
    { x: x(0.665), y: -0.03, r: 0.042 },
    { x: x(0.775), y: 0.1, r: 0.034 },
    { x: x(0.47), y: -0.395, r: 0.046 },
    { x: x(0.615), y: -0.395, r: 0.046 },
  ];
  const leftDials = rightDials.map((d) => ({ x: -d.x, y: d.y, r: d.r }));
  return {
    aspect: a,
    window: [x(0.3), 0.405, x(0.8), 0.405, x(0.37), -0.1],
    panels: [
      ...right,
      ...left,
      // Two checklists strapped to the bulkhead beside the speaker, one high, one low.
      { x0: x(-0.262), y0: 0.13, x1: x(-0.152), y1: 0.37, kind: CHECKLIST },
      { x0: x(0.155), y0: -0.03, x1: x(0.25), y1: 0.15, kind: CHECKLIST },
    ],
    dials: [...rightDials, ...leftDials],
    lamp: [x(0.555), -0.2125, 0.02, 0.016],
    earth: [x(0.49), 0.29, 0.03],
  };
}

/**
 * Where the right window's glass crosses height `y`: its inner and outer x, or
 * NaN for both outside it. The left window spans the same, negated.
 */
export function windowSpan(layout: CabinLayout, y: number, out: Float64Array): Float64Array {
  const [ax, ay, bx, , cx, cy] = layout.window;
  if (y > ay || y < cy) {
    out[0] = Number.NaN;
    out[1] = Number.NaN;
    return out;
  }
  const u = (y - cy) / (ay - cy);
  out[0] = cx + (ax - cx) * u;
  out[1] = cx + (bx - cx) * u;
  return out;
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

/** The sun's mean elevation, how far it creeps either way, and over how long (s). */
export const SUN_ELEVATION = 9 * DEG;
export const SUN_CREEP = 1.5 * DEG;
const SUN_PERIOD = 3 * 3600;
/** The sun's bearing, from the camera's forward direction towards its right. */
export const SUN_AZIMUTH = 110 * DEG;

/** The sun's elevation at `t` seconds: low, creeping very slowly up and down. */
export function sunElevation(t: number): number {
  return SUN_ELEVATION + SUN_CREEP * Math.sin((TAU * (Number.isFinite(t) ? t : 0)) / SUN_PERIOD);
}

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** Needle angle (radians, counter-clockwise from +x) at the bottom of a dial's scale, and the scale's sweep. */
export const DIAL_START = (5 * Math.PI) / 4;
export const DIAL_SWEEP = (3 * Math.PI) / 2;
/** How far the wander moves a needle, as a share of its scale. */
export const NEEDLE_WANDER = 0.06;

/** Dial `i`'s resting reading for `seed`: somewhere in the middle of its scale. */
export function dialBase(seed: number, i: number): number {
  return 0.25 + (0.5 * hash32(hash32(Math.floor(seed) + 0x51ed) ^ (i * 0x9e3779b1))) / 4294967296;
}

/** A dial's reading (0..1) for its resting reading and the walk's wander (about -1..1). */
export function needleReading(base: number, wander: number): number {
  return clamp(base + NEEDLE_WANDER * (Number.isFinite(wander) ? wander : 0), 0, 1);
}

/** The needle angle for a reading of 0..1 (clamped) on a dial's scale. */
export function needleAngle(reading: number): number {
  return DIAL_START - DIAL_SWEEP * clamp(Number.isFinite(reading) ? reading : 0, 0, 1);
}

// ---------------------------------------------------------------------------
// Occasional events
// ---------------------------------------------------------------------------

/** A uniform 0..1 for slot `slot` of the event stream `salt`. */
function slotRandom(seed: number, salt: number, slot: number, k = 0): number {
  return (
    hash32(
      hash32(Math.floor(seed) * 4 + salt) ^ Math.imul(slot + 1, 0x9e3779b1) ^ (k * 0x85ebca6b),
    ) / 4294967296
  );
}

/**
 * An event `length` s long once in every `gap` s slot of time, at a seeded
 * moment within it (never in the very first slot, so the scene opens quiet):
 * how far through the event `t` is (0..1), or -1 between events.
 */
export function eventPhase(
  t: number,
  seed: number,
  salt: number,
  gap: number,
  length: number,
): number {
  if (!(t > 0)) {
    return -1;
  }
  const slot = Math.floor(t / gap);
  if (slot < 1) {
    return -1;
  }
  const start = slot * gap + slotRandom(seed, salt, slot) * (gap - length);
  const u = (t - start) / length;
  return u >= 0 && u <= 1 ? u : -1;
}

/** Which slot `t` is in, for picking an event's details. */
const eventSlot = (t: number, gap: number) => Math.floor(Math.max(0, t) / gap);

/** The master alarm: every few minutes, three slow blinks (each ramping over 1.5 s). */
export const WARNING_GAP = 210;
const WARNING_LENGTH = 9;
const WARNING_BLINKS = 3;
const WARNING_SALT = 1;

/** The master alarm's glow (0..1) at `t`. */
export function warningGlow(t: number, seed: number): number {
  const u = eventPhase(t, seed, WARNING_SALT, WARNING_GAP, WARNING_LENGTH);
  if (u < 0) {
    return 0;
  }
  const s = Math.sin(Math.PI * WARNING_BLINKS * u);
  return s * s;
}

/** A distant dust plume: every few minutes, rising for a while and settling slowly. */
const PLUME_GAP = 170;
const PLUME_LENGTH = 50;
const PLUME_SALT = 2;

interface Plume {
  /** Density, 0 when there's none. */
  amount: number;
  /** How far it has risen, 0..1. */
  rise: number;
  /** Which window (+1 right, -1 left), and where across it (0..1). */
  side: number;
  across: number;
}

export const createPlume = (): Plume => ({ amount: 0, rise: 0, side: 1, across: 0.5 });

/** The plume at `t`. */
export function plumeAt(t: number, seed: number, out: Plume): Plume {
  const u = eventPhase(t, seed, PLUME_SALT, PLUME_GAP, PLUME_LENGTH);
  if (u < 0) {
    out.amount = 0;
    out.rise = 0;
    return out;
  }
  const slot = eventSlot(t, PLUME_GAP);
  out.rise = smoothstep(0, 0.35, u);
  out.amount = smoothstep(0, 0.1, u) * (1 - smoothstep(0.3, 1, u));
  out.side = slotRandom(seed, PLUME_SALT, slot, 1) < 0.5 ? -1 : 1;
  out.across = 0.2 + 0.6 * slotRandom(seed, PLUME_SALT, slot, 2);
  return out;
}

/** Fine dust drifting down past the windows, now and then. */
const DUST_GAP = 130;
const DUST_LENGTH = 40;
const DUST_SALT = 3;

/** How much dust is drifting past at `t` (0..1). */
export function dustLevel(t: number, seed: number): number {
  const u = eventPhase(t, seed, DUST_SALT, DUST_GAP, DUST_LENGTH);
  return u < 0 ? 0 : smoothstep(0, 0.25, u) * (1 - smoothstep(0.6, 1, u));
}

// ---------------------------------------------------------------------------
// Lift-off
// ---------------------------------------------------------------------------

/** One lift-off every this many seconds, starting a whole period in. */
export const ASCENT_PERIOD = 1800;
/** Seconds climbing to orbit, holding there, and descending back. */
export const ASCENT_RISE = 60;
const ASCENT_HOLD = 150;
const ASCENT_DESCENT = 120;
export const ASCENT_LENGTH = ASCENT_RISE + ASCENT_HOLD + ASCENT_DESCENT;
/** The orbit's height (m). */
export const ORBIT_HEIGHT = 110000;
/** The most the climb may change per second, when the setting is switched mid-flight. */
export const CLIMB_RATE = 1 / 60;

/** Smootherstep: 0 at 0, 1 at 1, with zero slope and curvature at both ends. */
function smoother(x: number): number {
  const u = clamp(x, 0, 1);
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/**
 * How far through the climb to orbit the lander is at `t` (0 on the surface, 1
 * in orbit): every `ASCENT_PERIOD`, an eased rise, a hold and a slower eased
 * descent that lands exactly back on 0.
 */
export function ascentAt(t: number): number {
  if (!(t > 0)) {
    return 0;
  }
  const cycle = Math.floor(t / ASCENT_PERIOD);
  if (cycle < 1) {
    return 0;
  }
  const u = t - cycle * ASCENT_PERIOD;
  if (u < ASCENT_RISE) {
    return smoother(u / ASCENT_RISE);
  }
  if (u < ASCENT_RISE + ASCENT_HOLD) {
    return 1;
  }
  if (u < ASCENT_LENGTH) {
    return 1 - smoother((u - ASCENT_RISE - ASCENT_HOLD) / ASCENT_DESCENT);
  }
  return 0;
}

/** Height above the surface (m) for a climb of 0..1: slow off the ground, then up to orbit. */
export function climbHeight(climb: number): number {
  const c = clamp(climb, 0, 1);
  return ORBIT_HEIGHT * c * c * c;
}

/** How far the horizon dips below the horizontal (radians) from `height` metres up. */
export function horizonDip(height: number): number {
  return Math.acos(MOON_R / (MOON_R + Math.max(0, height)));
}

/** The Earth's spin: one turn in this many seconds, and its turn (0..1) at `t`. */
const EARTH_TURN = 1800;
export const earthTurn = (t: number) => fract(t / EARTH_TURN);
