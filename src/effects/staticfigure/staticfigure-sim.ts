/**
 * Static Figure's clock and figure, kept pure for tests: when the tape breaks
 * up into static (a seeded schedule of bursts), how strongly each part of a
 * burst shows at a moment, and where the figure stands after each burst (a
 * seeded walk over stations at three depths in the scene).
 */
import { clamp } from "../math";
import { createRng, hash32 } from "../noise";

export type Place = "field" | "carpark" | "hallway";

/** The range of the average gap between bursts, seconds. */
export const INTERVAL_MIN = 20;
export const INTERVAL_MAX = 90;

// ---------------------------------------------------------------------------
// Bursts
// ---------------------------------------------------------------------------

/** A burst's length, seconds. */
export const BURST_MIN = 0.5;
export const BURST_MAX = 1.5;
/** The tape trouble's rise and fall at a burst's ends, seconds (raised cosines). */
const TROUBLE_RISE = 0.18;
const TROUBLE_FALL = 0.24;
/**
 * The heavy static that hides the swap, centred on the burst's middle: its
 * rise and fall (raised cosines) and its hold at full, seconds. Together they
 * fit in the shortest burst.
 */
export const COVER_RAMP = 0.2;
export const COVER_HOLD = 0.08;
/** First burst after this many seconds. */
export const FIRST_GAP = [8, 16] as const;
/** Gaps between bursts, as fractions of the interval: their mean is 1. */
export const GAP_SPREAD = [0.5, 1.5] as const;

/**
 * How the burst's static covers the picture (see the tape pass): the heavy
 * static's mix at full, the band's at full, and the band's half height (frame
 * heights; its profile is exp(-(d / half)^2)).
 */
export const COVER_MIX = 0.9;
export const BAND_MIX = 0.7;
export const BAND_HALF = 0.06;
/**
 * Static is the picture's brightness blurred sideways (b), lifted by
 * `STATIC_LIFT`, with zero-mean luma noise of `STATIC_GAIN * b + STATIC_NOISE`
 * from peak to peak (0..1 display values). The lift is at least half the
 * noise, so it never clips at black, and where static covers the picture fully
 * it raises the brightness by `STATIC_LIFT` on average. That is all a burst
 * does to the frame's mean: the blur, the colour split and the tracking wobble
 * only move brightness sideways.
 */
export const STATIC_LIFT = 0.08;
export const STATIC_NOISE = 0.16;
export const STATIC_GAIN = 1.2;
/**
 * The most the frame's mean brightness (0..1 display values) changes between
 * frames at 30 fps while a burst plays.
 */
export const MAX_MEAN_STEP = 0.03;
/** The band rolls up the frame at this speed, frame heights a second. */
export const BAND_SPEED = 0.25;
/** Where the band's centre starts, frame heights from the bottom. */
const BAND_START = [0.08, 0.55] as const;
/** Tracking wobble at full trouble: the rows' sideways swing (frame heights) and its rate (Hz). */
export const WOBBLE_AMP = 0.006;
export const WOBBLE_HZ = 2.5;
/** Waves of the wobble down the frame. */
export const WOBBLE_WAVES = 3;
/** The colour split at full trouble, frame heights. */
export const SPLIT = 0.005;

const lerp = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;
/** A raised-cosine ramp, 0 at u <= 0 to 1 at u >= 1. */
const ramp = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));

const intervalParam = (v: number) =>
  clamp(Number.isFinite(v) ? v : INTERVAL_MIN, INTERVAL_MIN, INTERVAL_MAX);
const unitParam = (v: number) => clamp(Number.isFinite(v) ? v : 0, 0, 1);

// ---------------------------------------------------------------------------
// The figure
// ---------------------------------------------------------------------------

/** Depths of the stations: far, mid and near. */
export const DEPTHS = 3;
export const NEAR = 2;
/** The figure's height at each depth, frame heights: never more than about a third. */
export const FIGURE_HEIGHT = [0.085, 0.17, 0.31] as const;
/** Half the figure's width (its arms hang a little out), as a fraction of its height. */
export const FIGURE_HALF_WIDTH = 0.15;
/** Eye level over the figure's height: its feet sit this many of its heights below the horizon. */
const EYE_RATIO = 1.6 / 2.2;
/** Stations at each depth; their indices run far first. */
const STATION_COUNTS = [3, 3, 2] as const;
const DEPTH_FIRST = [0, 3, 6] as const;
export const STATIONS = 8;
/** The range of the figure's head tilt, radians, either way. */
const TILT = [0.08, 0.14] as const;
/** After a burst that brings it: the chance it comes a step nearer from far and from mid. */
const ADVANCE = [0.55, 0.35] as const;
/** The chance it's gone after a burst that finds it near. */
const LEAVE_NEAR = 0.6;
/** Keep-outs, frame heights: from the frame's sides, and from the middle third. */
const EDGE = 0.02;
const GAP = 0.01;

/** Each place's horizon (eye level), frame heights above the middle. */
export const HORIZON: Readonly<Record<Place, number>> = {
  field: 0.08,
  carpark: 0.06,
  hallway: 0.05,
};
/** The hallway's vanishing point, as a fraction of the frame's width (one minus it when flipped). */
const HALL_VP = 0.22;
/** The hallway's half width over eye height. */
export const HALL_HALF_WIDTH = 0.75;
/** How far out across the hallway's floor the figure may stand, of its half width. */
const HALL_REACH = 0.8;

export const placeParam = (v: string): Place => (v === "carpark" || v === "hallway" ? v : "field");

/** Whether variation `seed` mirrors the hallway (its vanishing point on the right). */
export const hallFlipped = (seed: number) => (hash32(Math.floor(seed) ^ 0x2f6b1d93) & 1) === 1;

/** The height of the figure's feet at `depth`, frame heights above the middle. */
export const feetY = (place: Place, depth: number) =>
  HORIZON[place] - FIGURE_HEIGHT[depth] * EYE_RATIO;

/** The hallway's vanishing point's x, frame heights from the middle. */
export const hallVanishX = (aspect: number, flipped: boolean) =>
  ((flipped ? 1 - HALL_VP : HALL_VP) - 0.5) * aspect;

/**
 * The figure's x (frame heights from the middle) at `depth` on `side` (-1
 * left, 1 right), `u` (0..1) of the way across the room it has there, in a
 * frame `aspect` wide: always in an outer third with its whole width, inside
 * the frame, and in the hallway on its floor. Takes the other side when its
 * own has no room; NaN when neither has (frames far narrower than 9:16).
 */
export function figureX(
  place: Place,
  depth: number,
  side: number,
  u: number,
  aspect: number,
  flipped: boolean,
): number {
  const hw = FIGURE_HEIGHT[depth] * FIGURE_HALF_WIDTH;
  const half = aspect / 2;
  const third = aspect / 6;
  let lo = -Infinity;
  let hi = Infinity;
  if (place === "hallway") {
    const xv = hallVanishX(aspect, flipped);
    const floor = HALL_REACH * HALL_HALF_WIDTH * (HORIZON.hallway - feetY(place, depth));
    lo = xv - floor;
    hi = xv + floor;
  }
  for (let k = 0; k < 2; k++) {
    const s = (k === 0) === side < 0 ? -1 : 1;
    const a = Math.max(lo, s < 0 ? -half + EDGE + hw : third + GAP + hw);
    const b = Math.min(hi, s < 0 ? -third - GAP - hw : half - EDGE - hw);
    if (a <= b) {
      return a + (b - a) * clamp(u, 0, 1);
    }
  }
  return Number.NaN;
}

// ---------------------------------------------------------------------------
// The tape
// ---------------------------------------------------------------------------

export interface Tape {
  /** Gaps and bursts; the figure's walk. */
  scheduleRng: () => number;
  walkRng: () => number;
  /** Seconds since the start, unwrapped. */
  time: number;
  /** While idle: seconds until the next burst. */
  wait: number;
  /** Seconds into the burst under way, or -1 while idle. */
  at: number;
  /** The burst's length, the band's starting height (frame heights from the bottom), the split's sign. */
  duration: number;
  bandStart: number;
  split: number;
  /** A seed for the burst's static and wobble. */
  noise: number;
  /** Whether the burst under way has made its swap. */
  swapped: boolean;
  /** A burst is wanted as soon as possible (a place or variation change). */
  forced: boolean;
  /** Bursts begun, and swaps made. */
  bursts: number;
  swaps: number;
  /** The figure's station, or -1 while it's gone. */
  station: number;
  /** Per station: side (-1, 1), position across that side (0..1) and head tilt (radians). */
  readonly side: Int8Array;
  readonly u: Float64Array;
  readonly tilt: Float64Array;
}

/** The depth of `station`, or -1 for none. */
export const stationDepth = (station: number) =>
  station < 0 ? -1 : station < DEPTH_FIRST[1] ? 0 : station < DEPTH_FIRST[2] ? 1 : 2;

/** Lays out the stations and restarts the walk and the schedule's streams from `seed`; the figure is gone. */
function seedTape(tape: Tape, seed: number) {
  const s = Math.floor(Number.isFinite(seed) ? seed : 0);
  tape.scheduleRng = createRng(hash32(s ^ 0x5b1c3e7d));
  tape.walkRng = createRng(hash32(s ^ 0x1f84a2c9));
  const rng = createRng(hash32(s ^ 0x63d0b5a1));
  for (let d = 0; d < DEPTHS; d++) {
    // Alternate sides from a random one, so every depth has a station on each.
    const first = rng() < 0.5 ? -1 : 1;
    for (let k = 0; k < STATION_COUNTS[d]; k++) {
      const i = DEPTH_FIRST[d] + k;
      tape.side[i] = k % 2 === 0 ? first : -first;
      tape.u[i] = rng();
      tape.tilt[i] = lerp(TILT, rng()) * (rng() < 0.5 ? -1 : 1);
    }
  }
  tape.station = -1;
}

export function createTape(seed: number): Tape {
  const tape: Tape = {
    // Placeholders: seedTape sets both from the seed.
    scheduleRng: createRng(0),
    walkRng: createRng(0),
    time: 0,
    wait: 0,
    at: -1,
    duration: BURST_MIN,
    bandStart: BAND_START[0],
    split: 1,
    noise: 0,
    swapped: false,
    forced: false,
    bursts: 0,
    swaps: 0,
    station: -1,
    side: new Int8Array(STATIONS),
    u: new Float64Array(STATIONS),
    tilt: new Float64Array(STATIONS),
  };
  seedTape(tape, seed);
  tape.wait = lerp(FIRST_GAP, tape.scheduleRng());
  return tape;
}

/**
 * A new variation, applied at a swap: new stations and streams, and the figure
 * gone. The burst under way and the gap after it carry on.
 */
export function reseedTape(tape: Tape, seed: number): void {
  seedTape(tape, seed);
}

/**
 * Asks for a burst as soon as possible, to hide a change of place or
 * variation: at once while idle, or right after the burst under way if that
 * one has already made its swap (otherwise its swap will do).
 */
export function requestBurst(tape: Tape): void {
  if (tape.at < 0 || tape.swapped) {
    tape.forced = true;
  }
}

function startBurst(tape: Tape, at: number) {
  const rng = tape.scheduleRng;
  tape.at = at;
  tape.duration = lerp([BURST_MIN, BURST_MAX], rng());
  tape.bandStart = lerp(BAND_START, rng());
  tape.split = rng() < 0.5 ? -1 : 1;
  tape.noise = Math.floor(rng() * 0x10000);
  tape.swapped = false;
  tape.forced = false;
  tape.bursts++;
}

/** One step of the figure's walk, made at a burst's swap. */
function walk(tape: Tape, presence: number) {
  const rng = tape.walkRng;
  const there = rng() < presence;
  const roll = rng();
  const pick = rng();
  const was = stationDepth(tape.station);
  let depth = was;
  if (!there) {
    depth = -1;
  } else if (was < 0) {
    depth = 0;
  } else if (was === NEAR) {
    depth = roll < LEAVE_NEAR ? -1 : NEAR;
  } else if (roll < (was === 0 ? ADVANCE[0] : ADVANCE[1])) {
    depth = was + 1;
  }
  if (depth < 0) {
    tape.station = -1;
    return;
  }
  const n = STATION_COUNTS[depth];
  const first = DEPTH_FIRST[depth];
  // At the same depth it moves to another of that depth's stations.
  const k =
    depth === was
      ? (tape.station - first + 1 + Math.floor(pick * (n - 1))) % n
      : Math.floor(pick * n);
  tape.station = first + k;
}

/**
 * Advances the tape by `dt` seconds. The gap to the next burst is drawn when a
 * burst ends, from `interval` then (so a new interval applies from the next
 * gap); the figure walks at each burst's swap, with `presence` the chance it's
 * there after it. Returns whether a swap happened in this step.
 */
export function advanceTape(tape: Tape, dt: number, interval: number, presence: number): boolean {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  tape.time += step;
  if (tape.at < 0) {
    tape.wait -= step;
    if (tape.forced) {
      startBurst(tape, 0);
    } else if (tape.wait <= 0) {
      startBurst(tape, Math.min(-tape.wait, BURST_MIN / 2));
    } else {
      return false;
    }
  } else {
    tape.at += step;
  }
  let swapped = false;
  if (!tape.swapped && tape.at >= tape.duration / 2) {
    tape.swapped = true;
    tape.swaps++;
    walk(tape, unitParam(presence));
    swapped = true;
  }
  if (tape.at >= tape.duration) {
    tape.wait = intervalParam(interval) * lerp(GAP_SPREAD, tape.scheduleRng());
    tape.at = -1;
  }
  return swapped;
}

/** The burst's tape trouble (band, wobble, colour split), 0..1: 0 while idle. */
export function troubleLevel(tape: Tape): number {
  if (tape.at < 0) {
    return 0;
  }
  return ramp(Math.min(tape.at / TROUBLE_RISE, (tape.duration - tape.at) / TROUBLE_FALL));
}

/** The heavy static over the whole picture, 0..1, full round the burst's swap: 0 while idle. */
export function coverLevel(tape: Tape): number {
  if (tape.at < 0) {
    return 0;
  }
  const d = Math.abs(tape.at - tape.duration / 2) - COVER_HOLD / 2;
  return d <= 0 ? 1 : ramp(1 - d / COVER_RAMP);
}

/** The band's centre, frame heights from the bottom (rolling up through the burst). */
export const bandCentre = (tape: Tape) => tape.bandStart + BAND_SPEED * Math.max(0, tape.at);

/** The band's strength at height `y` (frame heights from the bottom) with its centre at `centre`. */
export function bandProfile(y: number, centre: number): number {
  const d = (y - centre) / BAND_HALF;
  return Math.exp(-d * d);
}

// ---------------------------------------------------------------------------
// Idle wear
// ---------------------------------------------------------------------------

/** The picture's vertical jitter: steps a second, and its size, px at 1080p. */
export const JITTER_HZ = 3;
export const JITTER_PX = 1;
/** The tape grain re-seeds this many times a second (each cell easing between two). */
export const GRAIN_HZ = 4;

/**
 * The picture's vertical jitter at `time`: -1, 0 or 1 (times `JITTER_PX`),
 * held for a step at a time. More steps are off the line the more worn the
 * tape; none at `tape` 0.
 */
export function jitterAt(time: number, seed: number, tape: number): number {
  const p = 0.5 * unitParam(tape);
  const r = hash32(Math.floor(time * JITTER_HZ) ^ hash32(Math.floor(seed) ^ 0x7a3d)) / 4294967296;
  return r < p / 2 ? -1 : r < p ? 1 : 0;
}

/**
 * The start of the date stamp for variation `seed` at `place`, as local time
 * in ms: an autumn evening or night in the 1990s, at dusk in the field, late
 * in the car park and small hours in the hallway.
 */
export function stampStart(seed: number, place: Place): number {
  const h = hash32(Math.floor(seed) ^ 0x3e9b);
  const year = 1991 + (h % 9);
  const month = 8 + ((h >>> 4) % 3);
  const day = 1 + ((h >>> 6) % 28);
  const hour = place === "field" ? 18 + ((h >>> 11) % 2) : place === "carpark" ? 22 : 3;
  const minute = (h >>> 13) % 60;
  return new Date(year, month, day, hour, minute, (h >>> 19) % 60).getTime();
}
