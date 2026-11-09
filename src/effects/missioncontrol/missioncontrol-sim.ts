/**
 * Mission Control's model, all pure functions of time so it can be tested
 * without stepping:
 *
 * - The ground track: a circular orbit, inclined to the equator, over an Earth
 *   that turns beneath it, as latitude and longitude of the craft, and the
 *   track binned by longitude for the wall map's shader.
 * - The launch schedule: a countdown from T-30 to zero at each liftoff, then the
 *   climb out on the launch screen and a new craft on the map.
 * - The clocks: mission elapsed time and local time, as the big clock shows them.
 * - Console activity: the Starship Bridge's block event stream, turned into
 *   CRT scrolling and push-button lights.
 */
import {
  type Block,
  blockEvent,
  type BlockEvent,
  CHASE_SLOT,
  chaseStart,
  chaseWeight,
  eventWeight,
  slotLength,
} from "../console-blocks";
import { clamp, wrap } from "../math";
import { hash32 } from "../noise";

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;

/* ----- Orbits and the ground track ----- */

/**
 * Earth turns this many times slower than the craft goes round, so each orbit's
 * track lands 360 / 16 = 22.5 degrees west of the last, as in a low orbit.
 */
export const EARTH_RATIO = 16;

export interface Orbit {
  /** Inclination to the equator (radians), below 60 degrees so the track runs ever eastward. */
  incl: number;
  /** Seconds per orbit. */
  period: number;
  /** Longitude (radians) the craft would cross the equator northbound at its time 0. */
  node: number;
  /** Argument of latitude (radians) at its time 0: 0 is northbound over the equator. */
  phase: number;
}

export interface LatLonDeg {
  lat: number;
  lon: number;
}

/** Unwrapped longitude (radians) of an orbit at argument of latitude `u`, `tau` s after its time 0. */
function rawLon(o: Orbit, u: number, tau: number): number {
  // atan2 with the turns added back, so it climbs smoothly with u.
  const turns = Math.round((u - Math.atan2(Math.sin(u), Math.cos(u))) / TAU);
  const along = Math.atan2(Math.cos(o.incl) * Math.sin(u), Math.cos(u)) + turns * TAU;
  return o.node + along - (TAU / (o.period * EARTH_RATIO)) * tau;
}

/** Argument of latitude `tau` seconds after the orbit's time 0. */
export function argumentAt(o: Orbit, tau: number): number {
  return o.phase + (TAU * tau) / o.period;
}

/** Seconds after the orbit's time 0 at argument of latitude `u`. */
export function timeAtArgument(o: Orbit, u: number): number {
  return ((u - o.phase) * o.period) / TAU;
}

/**
 * Where the craft is `tau` seconds after its orbit's time 0, in degrees, with
 * longitude wrapped to [-180, 180). Writes into `out`; allocates nothing.
 */
export function groundTrack(o: Orbit, tau: number, out: LatLonDeg): LatLonDeg {
  const u = argumentAt(o, tau);
  out.lat = Math.asin(clamp(Math.sin(o.incl) * Math.sin(u), -1, 1)) / DEG;
  out.lon = wrap(rawLon(o, u, tau) / DEG, -180, 360);
  return out;
}

/** Unwrapped longitude in degrees, `tau` seconds after the orbit's time 0. */
export function unwrappedLon(o: Orbit, tau: number): number {
  return rawLon(o, argumentAt(o, tau), tau) / DEG;
}

/** The main craft's orbit, from the seed: already in flight when the room opens. */
export function missionOrbit(seed: number): Orbit {
  const s = Math.floor(seed);
  const r = (k: number) => hash32(hash32(s + 0x2f6b) ^ (k * 0x9e3779b1)) / 4294967296;
  return {
    incl: (28 + 27 * r(1)) * DEG,
    period: 300 + 120 * r(2),
    node: (-180 + 360 * r(3)) * DEG,
    phase: 0,
  };
}

/** The launch site, on a made-up coast in the subtropics. */
export const LAUNCH_SITE: Readonly<LatLonDeg> = { lat: 28.5, lon: -80.6 };

/**
 * The orbit of a craft launched from `LAUNCH_SITE`, with its time 0 at liftoff:
 * northbound over the site, so the new track starts there and heads north-east.
 */
export function launchOrbit(seed: number, launch: number): Orbit {
  const r =
    hash32(hash32(Math.floor(seed) + 0x61c8) ^ Math.imul(launch + 1, 0x85ebca6b)) / 4294967296;
  const incl = (LAUNCH_SITE.lat + 4 + 20 * r) * DEG;
  const phase = Math.asin(Math.sin(LAUNCH_SITE.lat * DEG) / Math.sin(incl));
  const along = Math.atan2(Math.cos(incl) * Math.sin(phase), Math.cos(phase));
  return { incl, period: 330, node: LAUNCH_SITE.lon * DEG - along, phase };
}

/** Which orbit (counting northbound equator crossings from 0) the craft is on at `tau`. */
export function orbitNumber(o: Orbit, tau: number): number {
  return Math.floor(argumentAt(o, tau) / TAU);
}

/** Longitude bins across the wall map, from -180 to 180 degrees. */
export const TRACK_BINS = 512;
/** Marks a bin edge the track doesn't reach. Fits a half float. */
export const NO_TRACK = 1000;

/**
 * Fills one track row: for each of `TRACK_BINS + 1` bin edges (longitude
 * -180 + 360 i / TRACK_BINS), the latitude in degrees where the craft crosses
 * it while its argument of latitude runs from `u0` to `u1`, or `NO_TRACK`. The
 * span must cover less than a full turn of longitude, which holds for up to one
 * orbit, since the Earth turns under it. Writes `out[offset + i * stride]`.
 */
function fillTrackEdges(
  o: Orbit,
  u0: number,
  u1: number,
  out: Float32Array,
  offset: number,
  stride: number,
): void {
  const t0 = timeAtArgument(o, u0);
  const t1 = timeAtArgument(o, u1);
  const l0 = unwrappedLon(o, t0);
  const l1 = unwrappedLon(o, t1);
  for (let i = 0; i <= TRACK_BINS; i++) {
    const edge = -180 + (360 * i) / TRACK_BINS;
    const target = l0 + wrap(edge - l0, 0, 360);
    let lat = NO_TRACK;
    if (t1 > t0 && target <= l1) {
      // Longitude only ever grows along the orbit, so bisect for the crossing.
      let a = t0;
      let b = t1;
      for (let k = 0; k < 28; k++) {
        const m = 0.5 * (a + b);
        if (unwrappedLon(o, m) < target) {
          a = m;
        } else {
          b = m;
        }
      }
      const u = argumentAt(o, 0.5 * (a + b));
      lat = Math.asin(clamp(Math.sin(o.incl) * Math.sin(u), -1, 1)) / DEG;
    }
    out[offset + i * stride] = lat;
  }
}

/**
 * Builds one craft's row of the track texture: RGBA per bin, the latitude at
 * its left and right edge on the previous orbit, then on the current orbit
 * (`NO_TRACK` where it isn't drawn). The current orbit is drawn from
 * `start` (an argument of latitude: the orbit's start, or liftoff), and the
 * orbits overlap by a couple of bins so the joins have no gaps.
 */
export function fillTrackRow(
  o: Orbit,
  orbit: number,
  start: number,
  edges: Float32Array,
  out: Float32Array,
  offset: number,
): void {
  const overlap = (4 * TAU) / TRACK_BINS;
  const n0 = orbit * TAU;
  const prevStart = Math.max(start, n0 - TAU);
  edges.fill(NO_TRACK);
  if (prevStart < n0) {
    fillTrackEdges(o, prevStart, Math.min(n0 + overlap, n0 + TAU), edges, 0, 2);
  }
  fillTrackEdges(o, Math.max(start, n0 - overlap), n0 + TAU, edges, 1, 2);
  for (let j = 0; j < TRACK_BINS; j++) {
    const k = offset + j * 4;
    out[k] = edges[j * 2] ?? NO_TRACK;
    out[k + 1] = edges[(j + 1) * 2] ?? NO_TRACK;
    out[k + 2] = edges[j * 2 + 1] ?? NO_TRACK;
    out[k + 3] = edges[(j + 1) * 2 + 1] ?? NO_TRACK;
  }
}

/** Scratch for `fillTrackRow`: two interleaved rows of bin edges. */
export function createTrackEdges(): Float32Array {
  return new Float32Array((TRACK_BINS + 1) * 2);
}

/* ----- Launches ----- */

/** Seconds of the countdown, from T-30 to liftoff. */
export const COUNTDOWN = 30;
/** Seconds from the start (or turning launches on) to the first liftoff. */
export const FIRST_LIFTOFF = COUNTDOWN + 20;
/** Seconds after liftoff when the launch screen cuts back to a new rocket on the pad, at most. */
const PAD_RESET = 120;
/** Seconds the cut to the pad takes, fading through black. */
export const PAD_CUT = 1;

type LaunchPhase = "idle" | "countdown" | "flight";

interface LaunchState {
  phase: LaunchPhase;
  /** Which launch this is (0 is the first), or the last one when idle after a flight. -1 before any. */
  index: number;
  /** Seconds since the liftoff of `index` (negative during its countdown). */
  sinceLiftoff: number;
  /** What the countdown reads, in whole seconds: 30 down to 0 at liftoff, then counting up. */
  display: number;
  /** Liftoff time (s) of `index`, and of the next launch. */
  liftoff: number;
  next: number;
  /** Seconds after liftoff when `index`'s launch screen cuts back to the pad. */
  reset: number;
}

export function createLaunchState(): LaunchState {
  const s: LaunchState = {
    phase: "idle",
    index: -1,
    sinceLiftoff: 0,
    display: 0,
    liftoff: 0,
    next: 0,
    reset: 0,
  };
  resetLaunch(s);
  return s;
}

/** Starts the schedule again: the first liftoff comes `FIRST_LIFTOFF` seconds after time 0. */
export function resetLaunch(s: LaunchState): void {
  s.phase = "idle";
  s.index = -1;
  s.sinceLiftoff = Number.NEGATIVE_INFINITY;
  s.display = 0;
  s.liftoff = Number.NEGATIVE_INFINITY;
  s.next = FIRST_LIFTOFF;
  s.reset = 0;
}

/** Liftoff time (s) of launch `n`, with `gap` seconds between liftoffs. */
export function liftoffTime(n: number, gap: number): number {
  return FIRST_LIFTOFF + n * launchStep(gap);
}

/** Seconds between liftoffs for a gap: room for the countdown and the cut to the pad. */
const launchStep = (gap: number) => Math.max(COUNTDOWN + PAD_CUT * 2, gap);

/** Seconds after liftoff when the launch screen cuts back to the pad, for this gap. */
export function padReset(gap: number): number {
  return clamp(gap - COUNTDOWN - 5, 20, PAD_RESET);
}

/**
 * Advances the launch schedule to `t` seconds after it started (`t` never
 * decreasing): liftoffs every `gap` seconds, each after a 30 s countdown that
 * reads 0 exactly at liftoff. After liftoff the countdown counts up until the
 * launch screen cuts back to the pad, then idles until the next countdown.
 *
 * Each launch latches the gap when its countdown begins: a change during a
 * countdown or flight leaves it, its cut to the pad and the next liftoff
 * alone. Once back on the pad, the next liftoff follows the new gap (from the
 * last liftoff), starting its countdown at once if that time has passed.
 * Writes into `s`; allocates nothing.
 */
export function stepLaunch(s: LaunchState, t: number, gap: number): LaunchState {
  const step = launchStep(gap);
  if (s.index >= 0 && t - s.liftoff >= s.reset && t < s.next - COUNTDOWN) {
    s.next = Math.max(s.liftoff + step, t + COUNTDOWN);
  }
  while (t >= s.next - COUNTDOWN) {
    s.index++;
    s.liftoff = s.next;
    s.reset = padReset(gap);
    s.next = s.liftoff + step;
  }
  if (s.index < 0) {
    s.phase = "idle";
    s.sinceLiftoff = Number.NEGATIVE_INFINITY;
    s.display = 0;
    return s;
  }
  const since = t - s.liftoff;
  s.sinceLiftoff = since;
  if (since < 0) {
    s.phase = "countdown";
    s.display = Math.ceil(-since);
    return s;
  }
  s.phase = since < s.reset ? "flight" : "idle";
  s.display = s.phase === "flight" ? Math.floor(since) : 0;
  return s;
}

/** The schedule at `t` with a fixed `gap` from the start, written into `out`. */
export function launchAt(t: number, gap: number, out: LaunchState): LaunchState {
  resetLaunch(out);
  return stepLaunch(out, t, gap);
}

/** "t-00:30", "t+01:05" or "HOLD", for the seven-segment countdown. */
export function countdownText(s: LaunchState, enabled: boolean): string {
  if (!enabled || s.phase === "idle") {
    return " HOLD";
  }
  const v = Math.max(0, s.display);
  const sign = s.phase === "countdown" || v === 0 ? "-" : "+";
  return `t${sign}${two(Math.floor(v / 60) % 100)}:${two(v % 60)}`;
}

/* ----- Clocks ----- */

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** Mission elapsed time as "DDD:HH:MM:SS", from whole seconds (negative reads as 0). */
export function missionTimeText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400) % 1000;
  return `${String(d).padStart(3, "0")}:${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** Local time as 24-hour "HH:MM:SS". */
export function localTimeText(date: Date): string {
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** Seconds the mission has run when the room opens: between 2 h and 5 days, from the seed. */
export function missionOffset(seed: number): number {
  const r = hash32(Math.floor(seed) + 0x4d1f) / 4294967296;
  return Math.round(7200 + r * (5 * 86400 - 7200));
}

/* ----- Console activity ----- */

/** Per-block scratch for `consoleStates`, which keeps each CRT's scroll count between frames. */
export interface ConsoleScratch {
  event: BlockEvent;
  /** Slot each block's events were last read for, and how many lines it has scrolled. */
  slot: Float64Array;
  scroll: Float64Array;
  chase: Float64Array;
  chaseSlot: Float64Array;
}

export function createConsoleScratch(blocks: number, groups: number): ConsoleScratch {
  return {
    event: { kind: "none", start: 0, length: 0 },
    slot: new Float64Array(blocks).fill(Number.NaN),
    scroll: new Float64Array(blocks),
    chase: new Float64Array(Math.max(1, groups)),
    chaseSlot: new Float64Array(Math.max(1, groups)).fill(Number.NaN),
  };
}

/** Most event slots caught up in one frame, after a long pause. */
const CATCH_UP = 4;

/**
 * Every block's state at `t`, as RGBA8 texels in `out` (4 bytes per block):
 *
 * - Readouts (CRTs and telemetry lines): R their brightness, G how many lines
 *   they have scrolled (mod 256), one more at the start of each "tick" event.
 * - Buttons: R how brightly lit, G how far swapped to their other colour, B a
 *   brief flash (pressed, or a finger running along the row), A their colour
 *   plus 8 times the colour they swap to.
 *
 * Events come from the Starship Bridge's activity schedule, so the rate scales
 * with `activity` and each block's busyness. Allocates nothing.
 */
export function consoleStates(
  blocks: readonly Block[],
  seed: number,
  activity: number,
  t: number,
  scratch: ConsoleScratch,
  out: Uint8Array,
): void {
  const ev = scratch.event;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const o = i * 4;
    if (i === 0 || b.kind === "widget") {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      continue;
    }
    const slot = Math.floor(t / slotLength(i, seed));
    if (b.kind === "readout") {
      const last = scratch.slot[i];
      if (last !== slot) {
        if (!Number.isNaN(last)) {
          for (let s = Math.max(last, slot - CATCH_UP); s < slot; s++) {
            if (blockEvent(b, i, seed, activity, s, ev).kind === "tick") {
              scratch.scroll[i]++;
            }
          }
        }
        scratch.slot[i] = slot;
      }
      blockEvent(b, i, seed, activity, slot, ev);
      const shown = scratch.scroll[i] + (ev.kind === "tick" && t >= ev.start ? 1 : 0);
      out[o] = Math.round(clamp(b.level, 0, 1) * 255);
      out[o + 1] = shown % 256;
      out[o + 2] = 0;
      out[o + 3] = 255;
      continue;
    }
    blockEvent(b, i, seed, activity, slot, ev);
    const w = eventWeight(ev, t);
    let level = b.level;
    let swap = 0;
    let flash = 0;
    if (ev.kind === "dim") {
      // An unlit button lights instead.
      level = b.level > 0 ? level * (1 - 0.85 * w) : 0.8 * w;
    } else if (ev.kind === "swap") {
      swap = w;
    } else if (ev.kind === "flash") {
      flash = w;
    }
    if (b.group >= 0) {
      const g = b.group;
      const cs = Math.floor(t / CHASE_SLOT);
      if (scratch.chaseSlot[g] !== cs) {
        scratch.chaseSlot[g] = cs;
        scratch.chase[g] = chaseStart(g, seed, activity * 0.5, cs);
      }
      flash = Math.max(flash, 0.8 * chaseWeight(scratch.chase[g], b.order, t));
    }
    out[o] = Math.round(clamp(Math.max(level, flash), 0, 1) * 255);
    out[o + 1] = Math.round(clamp(swap, 0, 1) * 255);
    out[o + 2] = Math.round(clamp(flash, 0, 1) * 255);
    // Which lens colours it has: its own, and the one it swaps to.
    out[o + 3] = (b.colour % 8) + 8 * (b.alt % 8);
  }
}

/**
 * How far the launch screen's rocket has climbed `s` seconds after liftoff, in
 * screen heights: the engines build for 3 s, then it rises ever faster and is
 * gone from view by about 16 s.
 */
export function rocketClimb(s: number): number {
  const k = Math.max(0, s - IGNITION);
  return 0.012 * k * k;
}

/** Seconds from liftoff (engine start) until the rocket moves. */
const IGNITION = 3;

/* ----- The shaders' clock ----- */

/** Seconds the shaders' clock repeats over; every periodic motion in them makes whole cycles of it. */
export const SHADER_PERIOD = 1000;
/** The CRTs' two flicker rates (Hz). */
export const CRT_FLICKER_RATES = [1.3, 2.9] as const;
/** Breaths per second of the ring round each craft on the map. */
export const RING_RATE = 0.4;
/** Frames per second of the launch screen's film grain: each is freshly random, at a pace the codec can follow. */
export const TV_GRAIN_RATE = 6;
/** Noise cells per second the venting vapour drifts by. */
export const VAPOUR_DRIFT = 0.6;
/** Noise cells after which the vapour's noise repeats across its drift: one shader period's worth. */
export const VAPOUR_TILE = Math.round(VAPOUR_DRIFT * SHADER_PERIOD);
/** Every rate (per second) the shaders' periodic motions run at, as cycles of SHADER_PERIOD. */
export const SHADER_RATES: readonly number[] = [
  ...CRT_FLICKER_RATES,
  RING_RATE,
  TV_GRAIN_RATE,
  VAPOUR_DRIFT,
];
