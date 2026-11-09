/**
 * Pure logic for the Retro Starship Bridge (retrobridge.ts): the round room's
 * geometry (the lower well, the deck and its railing, the chairs, the consoles
 * and the wall) and the camera looking into it, the ring of wall segments (a calm
 * stretch of wall behind the speaker, three stations, the lift door and plain
 * wall), the chairs and viewscreens over the stations, the
 * slow blinking of the lamps, and the red alert's eased wash, pulse and
 * turning beacons. Nothing here touches GL, so it is all unit tested.
 *
 * World units are metres. The bridge is round, centred on the y axis, with
 * the lower floor at y = 0; the camera stands in front of the command chair,
 * looking along +z at the back of the ring. Azimuth `theta` is
 * `atan(x, z)`: 0 straight ahead at the back wall, positive to the right.
 * Frame units have the origin at the frame's centre, y up and one unit the
 * frame's height.
 */
import { approach, clamp, fract, smoothstep } from "../math";
import { hash32 } from "../noise";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Room and camera
// ---------------------------------------------------------------------------

/** Radii (m): the step down to the lower floor, the railing, the chairs, the consoles' fronts and backs, the wall. */
export const R_DECK = 3.25;
export const R_RAIL = 3.32;
export const R_CHAIR = 3.68;
export const R_CONSOLE = 3.95;
export const R_CONSOLE_BACK = 4.45;
export const R_WALL = 4.6;
/**
 * Heights (m): the upper deck, the desks' front edge and back edge, the top of
 * the railing and its padded face's depth, the top of the black lamp face over
 * the desks, and the ceiling.
 */
export const DECK_H = 0.45;
export const CONSOLE_H = 0.9;
export const CONSOLE_BACK_H = 1.32;
export const RAIL_H = 1.24;
export const RAIL_T = 0.12;
export const FACE_TOP = 1.86;
export const CEILING_H = 3.2;
/** The camera: eye height and z (m), and the tangent of half the vertical field of view. */
export const EYE_H = 1.5;
export const CAMERA_Z = -2.5;
export const TAN_HALF_FOV = 0.33;

/**
 * Where the world point (x, y, z) lands in the frame, in frame units, or NaN
 * for both if it is behind the camera.
 */
export function project(x: number, y: number, z: number, out: Float64Array): Float64Array {
  const d = z - CAMERA_Z;
  if (d <= 0) {
    out[0] = Number.NaN;
    out[1] = Number.NaN;
    return out;
  }
  out[0] = x / d / (2 * TAN_HALF_FOV);
  out[1] = (y - EYE_H) / d / (2 * TAN_HALF_FOV);
  return out;
}

/** The frame position of the back wall at azimuth `theta` and height `y`. */
export function wallPoint(theta: number, y: number, out: Float64Array): Float64Array {
  return project(R_WALL * Math.sin(theta), y, R_WALL * Math.cos(theta), out);
}

// ---------------------------------------------------------------------------
// The ring of wall segments
// ---------------------------------------------------------------------------

/** Plain wall and the backs of consoles, behind the speaker: only slow lamps. */
export const CALM = 0;
/** A station: a console and chair, a black face of lamp tiles over its desk, and a large viewscreen above. */
export const STATION = 1;
/** The lift door, with a red call panel beside it and no console. */
export const DOOR = 2;
/** Plain wall past the stations: a bare black console stretch and pale panels, no lamps or screens. */
export const PLAIN = 3;

interface Segment {
  /** Azimuths (radians) of the segment's edges, a0 < a1. */
  a0: number;
  a1: number;
  kind: number;
}

/** Half the calm stretch's width (radians): at 16:9 it covers the middle third of the frame. */
export const CALM_HALF = 18 * DEG;
/** Width (radians) of a station, and of the lift door's bay. */
export const STATION_W = 15 * DEG;
const DOOR_W = 14 * DEG;
/** Stations on the side away from the door, and on the door's side. */
const STATIONS_FAR = 2;
const STATIONS_NEAR = 1;
/** Where the plain wall past the stations ends, either side: well past the edges of a 32:9 frame. */
const PLAIN_END = 90 * DEG;

/**
 * The ring with the lift door on the right, from left to right: plain wall,
 * two stations, the calm stretch, the door's bay right beside it (so it is in
 * view even in narrow frames), one station, and plain wall again. A door on
 * the left mirrors the whole ring.
 */
export function ringSegments(): Segment[] {
  const out: Segment[] = [];
  const left = -CALM_HALF - STATIONS_FAR * STATION_W;
  out.push({ a0: -PLAIN_END, a1: left, kind: PLAIN });
  for (let i = 0; i < STATIONS_FAR; i++) {
    const a0 = left + i * STATION_W;
    out.push({ a0, a1: a0 + STATION_W, kind: STATION });
  }
  out.push({ a0: -CALM_HALF, a1: CALM_HALF, kind: CALM });
  out.push({ a0: CALM_HALF, a1: CALM_HALF + DOOR_W, kind: DOOR });
  let a = CALM_HALF + DOOR_W;
  for (let i = 0; i < STATIONS_NEAR; i++) {
    out.push({ a0: a, a1: a + STATION_W, kind: STATION });
    a += STATION_W;
  }
  out.push({ a0: a, a1: PLAIN_END, kind: PLAIN });
  return out;
}

/** Azimuths of the swivel chairs: one centred at each station, with the door on the right. */
export function chairAzimuths(): number[] {
  return ringSegments()
    .filter((s) => s.kind === STATION)
    .map((s) => 0.5 * (s.a0 + s.a1));
}

/** Screen pictures (the composite's types): a star field, a plot of speckles, a planet against stars. */
export const STARS = 0;
export const PLOT = 1;
export const PLANET = 2;

/** A station's viewscreen: its centre's azimuth and height, half sizes (m), picture type and variant. */
interface Viewscreen {
  theta: number;
  y: number;
  halfW: number;
  halfH: number;
  type: number;
  variant: number;
}

/** The viewscreens' centre height and half sizes (m), on the pale wall between the ledge and the soffit. */
export const SCREEN_Y = 2.32;
export const SCREEN_HW = 0.42;
export const SCREEN_HH = 0.25;
/** The soffit under the ceiling, where the pale wall ends. */
export const SOFFIT_Y = 2.72;

/**
 * One large framed viewscreen centred over each station's chair, for
 * variation `seed`. The three show different pictures: a star field, a plot
 * and a planet, in an order set by the seed.
 */
export function viewscreens(seed: number): Viewscreen[] {
  const s = Math.floor(Number.isFinite(seed) ? seed : 0);
  const h = hash32(s * 0x27d4eb2d + 0x165667b1);
  const types = [STARS, PLOT, PLANET];
  // Rotate by the seed, and swap the first two now and then, for all six orders.
  const r = (h >>> 1) % 3;
  const order = [types[r], types[(r + 1) % 3], types[(r + 2) % 3]];
  if (((h >>> 3) & 1) === 1) {
    [order[0], order[1]] = [order[1], order[0]];
  }
  return chairAzimuths().map((theta, i) => ({
    theta,
    y: SCREEN_Y,
    halfW: SCREEN_HW,
    halfH: SCREEN_HH,
    type: order[i % 3],
    variant: (hash32(h + i * 0x9e3779b1) >>> 4) % 16,
  }));
}

/** Most segments the room shader takes. */
export const MAX_SEGMENTS = 8;

/** Height (m) of the alert beacons' centres, on the band below the ceiling. */
export const BEACON_Y = 2.86;
/** Radius (m) of a beacon's dome. */
export const BEACON_R = 0.1;

/**
 * Azimuths of the two alert beacons with the door on the right: one over the
 * door, one over the nearer station on the other side, both clear of the calm
 * stretch.
 */
export function beaconAzimuths(): [number, number] {
  return [-CALM_HALF - STATION_W / 2, CALM_HALF + DOOR_W / 2];
}

// ---------------------------------------------------------------------------
// Lamps
// ---------------------------------------------------------------------------

/** Lamp slots: every lamp in the room shows one slot's brightness. */
export const LAMP_SLOTS = 256;
/** Slots come in groups of eight: a row of lamps maps onto a group, so it can chase or alternate. */
export const LAMP_GROUP = 8;
/** The last slots are calm: slower and softer, for the lamps behind the speaker. */
export const CALM_SLOT0 = 224;
/** Seconds a lamp takes to fade on or off (busy and calm slots). */
export const LAMP_RAMP = 0.35;
export const CALM_RAMP = 1.2;
/** Blink rates (Hz) of busy slots at full activity; at zero activity they run at `IDLE_RATE` of this. */
export const MIN_RATE = 0.22;
export const MAX_RATE = 0.6;
const IDLE_RATE = 0.45;
/** Blink rates (Hz) of calm slots, whatever the activity. */
const CALM_MIN_RATE = 0.05;
export const CALM_MAX_RATE = 0.1;
/** How fast (per second) the eased activity follows the setting. */
const ACTIVITY_RATE = 0.2;
/** Share of busy slots that blink at zero and at full activity; the rest hold steady. */
const BLINK_SHARE_IDLE = 0.3;
const BLINK_SHARE_BUSY = 0.95;
/** Width of the activity band over which a slot changes from steady to blinking. */
const BLINK_SOFT = 0.08;

/** Row modes: 0 and 1 blink independently, 2 chase along the row, 3 alternate odd and even. */
const CHASE = 2;
const ALTERNATE = 3;

export interface LampBank {
  seed: number;
  /** The eased activity, 0..1, or NaN until the first step. */
  activity: number;
  /** Each slot's progress through its blink cycles, integrated so a rate change never jumps. */
  cycles: Float64Array;
  /** Each slot's rate at full activity (Hz). */
  rate: Float64Array;
  /** Each slot's phase offset in its cycle, and the share of the cycle it is lit. */
  offset: Float64Array;
  duty: Float64Array;
  /** The activity above which the slot blinks rather than holds steady. */
  threshold: Float64Array;
  /** Level the slot holds while steady: 0 or 1. */
  steady: Float64Array;
  /** Each slot's brightness, 0..1, after the last step. */
  level: Float64Array;
}

function unit(h: number): number {
  return h / 4294967296;
}

function slotHash(seed: number, i: number, salt: number): number {
  return unit(hash32(hash32(seed * 0x9e3779b1 + salt) ^ Math.imul(i + 1, 0x85ebca6b)));
}

/** Whether slot `i` is one of the calm slots. */
export function isCalmSlot(i: number): boolean {
  return i >= CALM_SLOT0;
}

/** A bank of lamp slots for variation `seed`, all at their start. */
export function createLampBank(seed: number): LampBank {
  const s = Math.floor(seed);
  const n = LAMP_SLOTS;
  const b: LampBank = {
    seed: s,
    activity: Number.NaN,
    cycles: new Float64Array(n),
    rate: new Float64Array(n),
    offset: new Float64Array(n),
    duty: new Float64Array(n),
    threshold: new Float64Array(n),
    steady: new Float64Array(n),
    level: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const group = Math.floor(i / LAMP_GROUP);
    const k = i % LAMP_GROUP;
    if (isCalmSlot(i)) {
      b.rate[i] = CALM_MIN_RATE + (CALM_MAX_RATE - CALM_MIN_RATE) * slotHash(s, i, 1);
      b.offset[i] = slotHash(s, i, 2);
      b.duty[i] = 0.4 + 0.2 * slotHash(s, i, 3);
      b.threshold[i] = -1;
      b.steady[i] = 1;
      continue;
    }
    const mode = Math.floor(slotHash(s, group, 10) * 4);

    // Chasing and alternating rows share one rate, duty and threshold; others pick their own.
    const own = mode === CHASE || mode === ALTERNATE ? group + 1000 : i;
    b.rate[i] = MIN_RATE + (MAX_RATE - MIN_RATE) * slotHash(s, own, 11);
    b.duty[i] = 0.42 + 0.16 * slotHash(s, own, 12);
    b.threshold[i] = slotHash(s, own, 13);
    b.steady[i] = slotHash(s, i, 14) < 0.7 ? 1 : 0;
    const groupPhase = slotHash(s, group, 15);
    b.offset[i] = fract(
      mode === CHASE
        ? groupPhase - k / LAMP_GROUP
        : mode === ALTERNATE
          ? groupPhase + (k % 2) * 0.5
          : slotHash(s, i, 16),
    );
  }
  return b;
}

/**
 * A blink's brightness `u` of the way through its cycle: fading on over the
 * first `ramp` of the cycle, holding, fading off to end at `duty`, then dark.
 * `ramp` (a share of the cycle) must be at most `duty / 2`.
 */
export function blinkShape(u: number, duty: number, ramp: number): number {
  if (u >= duty) {
    return 0;
  }
  const x = Math.min(u, duty - u) / ramp;
  return smoothstep(0, 1, x);
}

/** A busy slot's rate (Hz) at eased activity `a`. */
export function slotRate(rate: number, a: number): number {
  return rate * (IDLE_RATE + (1 - IDLE_RATE) * a);
}

/** How much a busy slot with `threshold` blinks (rather than holds steady) at eased activity `a`. */
function blinkWeight(threshold: number, a: number): number {
  const share = BLINK_SHARE_IDLE + (BLINK_SHARE_BUSY - BLINK_SHARE_IDLE) * a;
  return smoothstep(threshold - BLINK_SOFT, threshold + BLINK_SOFT, share);
}

/**
 * Advances every slot by `dt` seconds towards activity `target` (0..1), and
 * writes their brightness as bytes into `out` (one per slot). The activity
 * eases at `ACTIVITY_RATE`, and each slot integrates its own cycle, so moving
 * the slider changes the rates smoothly rather than jumping. Allocates nothing.
 */
export function stepLamps(b: LampBank, dt: number, target: number, out: Uint8Array): void {
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
  const want = clamp(Number.isFinite(target) ? target : 0.5, 0, 1);
  b.activity = Number.isNaN(b.activity) ? want : approach(b.activity, want, ACTIVITY_RATE * step);
  const a = b.activity;
  for (let i = 0; i < LAMP_SLOTS; i++) {
    let v: number;
    if (isCalmSlot(i)) {
      const rate = b.rate[i];
      b.cycles[i] = (b.cycles[i] + rate * step) % 1;
      const u = fract(b.cycles[i] + b.offset[i]);
      v = 0.35 + 0.65 * blinkShape(u, b.duty[i], CALM_RAMP * rate);
    } else {
      const rate = slotRate(b.rate[i], a);
      b.cycles[i] = (b.cycles[i] + rate * step) % 1;
      const u = fract(b.cycles[i] + b.offset[i]);
      const blink = blinkShape(u, b.duty[i], LAMP_RAMP * rate);
      v = b.steady[i] + (blink - b.steady[i]) * blinkWeight(b.threshold[i], a);
    }
    b.level[i] = v;
    out[i] = Math.round(clamp(v, 0, 1) * 255);
  }
}

// ---------------------------------------------------------------------------
// Red alert
// ---------------------------------------------------------------------------

/** Seconds the alert takes to come fully on or off. */
export const ALERT_EASE = 2;
/** Seconds per pulse of the red wash, and per turn of the beacons. */
export const PULSE_PERIOD = 3.2;
export const BEACON_PERIOD = 2.8;
/** Share of the red wash that pulses; the rest holds while the alert is on. */
const PULSE_DEPTH = 0.4;

/** The alert level after `dt` seconds heading for `on`, never faster than `ALERT_EASE` allows. */
export function stepAlert(level: number, on: boolean, dt: number): number {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  return approach(clamp(level, 0, 1), on ? 1 : 0, step / ALERT_EASE);
}

/** The red wash's strength (0..1) at alert `level` and time `t`: eased in, with a slow pulse. */
export function alertWash(level: number, t: number): number {
  const e = smoothstep(0, 1, level);
  const pulse = 0.5 - 0.5 * Math.cos((TAU * t) / PULSE_PERIOD);
  return e * (1 - PULSE_DEPTH + PULSE_DEPTH * pulse);
}

/** The beacons' turn (radians, 0..2π) at time `t`. */
export function beaconAngle(t: number): number {
  return TAU * fract(t / BEACON_PERIOD);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

/** The screens' animation clock wraps at this many seconds; every screen motion repeats a whole number of times in it. */
export const SCREEN_PERIOD = 600;

/** The screens' clock at time `t` (s), wrapped to `SCREEN_PERIOD`. */
export function screenTime(t: number): number {
  const w = t % SCREEN_PERIOD;
  return w < 0 ? w + SCREEN_PERIOD : w;
}
