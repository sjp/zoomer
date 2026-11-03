/**
 * Pure JS side of the Sleeping Cat effect (cat.ts): the scene layout in its
 * corner, the breathing cycle, the ear-twitch and tail-flick schedules and
 * poses, the dust motes in the sunbeam, and the coat and time-of-day palettes.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up. The cat and its cushion live in a local "cat frame":
 * one unit is `size` height units, y = 0 is where the cat rests on the
 * cushion, and +x points towards the frame's centre (the cat's head end), so
 * the bottom-right corner is a mirror image of the bottom-left.
 */
import { clamp, smoothstep, wrap } from "./math";
import type { CoatId, TimeOfDayId } from "./cat.meta";
import { createRng } from "./noise";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- layout

/** The sill's top surface: its front edge and its back edge (the window's bottom), height units. */
export const SILL_FRONT_Y = 0.15;
export const SILL_BACK_Y = 0.27;
/** Where the cushion's base rests on the sill top. */
export const CUSHION_REST_Y = 0.175;
/** Cushion centre and half-size in the cat frame. */
export const CUSHION_Y = -0.11;
export const CUSHION_RX = 0.66;
export const CUSHION_RY = 0.17;
/** Gap between the frame edge and the cushion, height units. */
export const EDGE_GAP = 0.05;
/** The cat pass box in the cat frame: cushion and its shadow, the cat with a lifted tail and ears. */
export const BOX_LOCAL = [-0.74, -0.36, 0.74, 0.52] as const;
/** Cat size limits (height units per cat unit). */
export const SIZE_RANGE = [0.25, 0.55] as const;

/**
 * The window opening, measured from the cat's frame edge ("outer" x) in
 * height units: x0, y0, x1, y1. Frame width and the glazing bars' positions.
 */
export const WINDOW = [0.05, SILL_BACK_Y + 0.02, 0.95, 0.97] as const;
export const WINDOW_FRAME = 0.035;
export const WINDOW_BAR_X = 0.5;
export const WINDOW_BAR_Y = 0.66;

export interface CatLayout {
  /** +1: the cat is in the bottom-left corner (head to the right); -1: bottom-right. */
  side: 1 | -1;
  /** Height units per cat unit. */
  size: number;
  /** The cat frame's origin, height units. */
  x: number;
  y: number;
  /** Cat pass box, height units: x0, y0, x1, y1 (clamped to the frame). */
  box: [number, number, number, number];
}

export const createCatLayout = (): CatLayout => ({
  side: 1,
  size: 0.4,
  x: 0,
  y: 0,
  box: [0, 0, 0, 0],
});

/** Clamps the `size` param; non-finite values fall back to the default. */
export function catSize(size: number): number {
  return clamp(Number.isFinite(size) ? size : 0.4, SIZE_RANGE[0], SIZE_RANGE[1]);
}

/** Lays the cushion and cat out in their corner of an `aspect`-wide frame. */
export function catLayout(aspect: number, corner: string, size: number, out: CatLayout): CatLayout {
  const s = catSize(size);
  const side = corner === "right" ? -1 : 1;
  const a = Math.max(aspect, 1e-3);
  const outer = EDGE_GAP + CUSHION_RX * s;
  out.side = side;
  out.size = s;
  out.x = side > 0 ? outer : a - outer;
  out.y = CUSHION_REST_Y + (CUSHION_RY - CUSHION_Y) * s;
  const lx0 = side > 0 ? BOX_LOCAL[0] : -BOX_LOCAL[2];
  const lx1 = side > 0 ? BOX_LOCAL[2] : -BOX_LOCAL[0];
  out.box[0] = Math.max(0, out.x + lx0 * s);
  out.box[1] = Math.max(0, out.y + BOX_LOCAL[1] * s);
  out.box[2] = Math.min(a, out.x + lx1 * s);
  out.box[3] = Math.min(1, out.y + BOX_LOCAL[3] * s);
  return out;
}

// ---------------------------------------------------------------- breathing

/** Seconds per breath. */
export const BREATH_PERIOD = 3.6;
/** Share of the cycle spent breathing in. */
const INHALE = 0.42;

/**
 * Breath at time `t` (seconds): 0 fully out, 1 fully in. A slightly quicker
 * in-breath than out-breath, each half a smoothstep, so it is periodic and
 * smooth (C1) everywhere.
 */
export function breathAt(t: number): number {
  const ph = wrap(t / BREATH_PERIOD, 0, 1);
  return ph < INHALE ? smoothstep(0, INHALE, ph) : 1 - smoothstep(INHALE, 1, ph);
}

// ---------------------------------------------------------------- events

/** A schedule of rare events: each gap is drawn from [minGap, maxGap]. */
export interface EventTrack {
  readonly minGap: number;
  readonly maxGap: number;
  readonly rng: () => number;
  /** Start of the latest event at or before the last `advanceTrack` time, or -Infinity. */
  last: number;
  /** Start of the next event. */
  next: number;
  /** A random value in [0, 1) for the latest event (which ear, how far). */
  variant: number;
  nextVariant: number;
}

export function createTrack(
  seed: number,
  minGap: number,
  maxGap: number,
  firstMin: number,
  firstMax: number,
): EventTrack {
  const rng = createRng(seed);
  return {
    minGap,
    maxGap,
    rng,
    last: Number.NEGATIVE_INFINITY,
    next: firstMin + rng() * (firstMax - firstMin),
    variant: 0,
    nextVariant: rng(),
  };
}

/** Moves the track on to time `t` (seconds, unwrapped; non-decreasing). */
export function advanceTrack(track: EventTrack, t: number): void {
  while (t >= track.next) {
    track.last = track.next;
    track.variant = track.nextVariant;
    track.next += track.minGap + track.rng() * (track.maxGap - track.minGap);
    track.nextVariant = track.rng();
  }
}

/** Ear twitches: gaps (s), first one, duration (s) and peak angle (rad, backwards). */
export const EAR_GAP = [20, 40] as const;
export const EAR_FIRST = [6, 14] as const;
export const EAR_DURATION = 0.55;
export const EAR_ANGLE = 0.5;
/** Tail flicks: gaps (s), first one, duration (s) and peak lift of the tip (rad). */
export const TAIL_GAP = [28, 55] as const;
export const TAIL_FIRST = [12, 22] as const;
export const TAIL_DURATION = 2.2;
export const TAIL_ANGLE = 0.5;

/**
 * The twitching ear's angle `tau` seconds into a twitch: flicked back in under
 * a tenth of a second, then eased home by EAR_DURATION; 0 outside the twitch.
 */
export function earTwitch(tau: number): number {
  if (!(tau > 0 && tau < EAR_DURATION)) return 0;
  return EAR_ANGLE * smoothstep(0, 0.07, tau) * (1 - smoothstep(0.12, EAR_DURATION, tau));
}

/**
 * The tail tip's lift `tau` seconds into a flick: a slow rise and fall
 * (sin squared, so it starts and ends at rest with no jolt) with a small curl
 * at the top; 0 outside the flick.
 */
export function tailFlick(tau: number): number {
  if (!(tau > 0 && tau < TAIL_DURATION)) return 0;
  const u = tau / TAIL_DURATION;
  const s = Math.sin(Math.PI * u);
  return TAIL_ANGLE * s * s * (1 + 0.25 * Math.sin(TAU * u));
}

export interface CatClock {
  ear: EventTrack;
  tail: EventTrack;
}

export function createCatClock(seed = 117): CatClock {
  return {
    ear: createTrack(seed, EAR_GAP[0], EAR_GAP[1], EAR_FIRST[0], EAR_FIRST[1]),
    tail: createTrack(seed + 1, TAIL_GAP[0], TAIL_GAP[1], TAIL_FIRST[0], TAIL_FIRST[1]),
  };
}

/** The pose at time `t`: breath (0..1), near-ear and far-ear angles, tail-tip lift (rad). */
export interface CatPose {
  breath: number;
  earNear: number;
  earFar: number;
  tail: number;
}

export const createPose = (): CatPose => ({ breath: 0, earNear: 0, earFar: 0, tail: 0 });

/** Advances the clock to `t` (seconds, unwrapped, non-decreasing) and writes the pose. */
export function catPose(clock: CatClock, t: number, out: CatPose): CatPose {
  advanceTrack(clock.ear, t);
  advanceTrack(clock.tail, t);
  out.breath = breathAt(t);
  const ear = earTwitch(t - clock.ear.last);
  // Mostly the near ear; now and then the far one.
  const near = clock.ear.variant < 0.65;
  out.earNear = near ? ear : 0;
  out.earFar = near ? 0 : ear;
  out.tail = tailFlick(t - clock.tail.last) * (0.75 + 0.25 * clock.tail.variant);
  return out;
}

// ---------------------------------------------------------------- palettes

export interface CoatLook {
  /** Main fur colour, tabby stripe colour and stripe strength (0: none). */
  fur: string;
  stripe: string;
  stripes: number;
  /** Pale fur (muzzle, chest, paws) and how strongly it shows there (0..1). */
  pale: string;
  paleAmount: number;
  /** Inside of the ears, the nose, and the closed-eye lines. */
  ear: string;
  nose: string;
  line: string;
  /** Rim light strength: dark coats need more to read against the window. */
  rim: number;
}

export const COATS: Readonly<Record<CoatId, CoatLook>> = {
  ginger: {
    fur: "#e0914c",
    stripe: "#b0602c",
    stripes: 0.6,
    pale: "#f6d6ad",
    paleAmount: 0.75,
    ear: "#e7a597",
    nose: "#cf7b72",
    line: "#5a2e1a",
    rim: 0.8,
  },
  tabby: {
    fur: "#9a9a9c",
    stripe: "#4c4d53",
    stripes: 0.8,
    pale: "#e6e0d6",
    paleAmount: 0.7,
    ear: "#d6a59c",
    nose: "#b9807c",
    line: "#2e2a28",
    rim: 0.8,
  },
  black: {
    fur: "#302b2c",
    stripe: "#302b2c",
    stripes: 0,
    pale: "#302b2c",
    paleAmount: 0,
    ear: "#4e3a3a",
    nose: "#3e2e2e",
    line: "#8a7c78",
    rim: 1.6,
  },
  tuxedo: {
    fur: "#2a2525",
    stripe: "#2a2525",
    stripes: 0,
    pale: "#ece7df",
    paleAmount: 1,
    ear: "#4e3a3a",
    nose: "#d19a94",
    line: "#8a7c78",
    rim: 1.5,
  },
};

/** The coat for a select value; unknown values fall back to ginger. */
export function coatFor(id: string): CoatLook {
  return Object.hasOwn(COATS, id) ? COATS[id as CoatId] : COATS.ginger;
}

export interface TimeLook {
  /** Sky at the top and bottom of the window, and the garden outside. */
  skyTop: string;
  skyBottom: string;
  garden: string;
  /** Sunlight, the room's ambient light, and the wall and sill paint. */
  sun: string;
  ambient: string;
  wall: string;
  sill: string;
  /** Sunbeam slant (inwards per unit of drop) and haze strength. */
  slope: number;
  haze: number;
}

export const TIMES: Readonly<Record<TimeOfDayId, TimeLook>> = {
  morning: {
    skyTop: "#a8c8e8",
    skyBottom: "#f2ecdc",
    garden: "#86a678",
    sun: "#fff2d6",
    ambient: "#a9a9b4",
    wall: "#d8cdbf",
    sill: "#ece6dc",
    slope: 0.35,
    haze: 0.16,
  },
  afternoon: {
    skyTop: "#92bfe6",
    skyBottom: "#eaf0ee",
    garden: "#759a5e",
    sun: "#ffe6b4",
    ambient: "#b3a597",
    wall: "#dac6ac",
    sill: "#efe7da",
    slope: 0.55,
    haze: 0.2,
  },
  golden: {
    skyTop: "#d99c7c",
    skyBottom: "#ffd49a",
    garden: "#6f7444",
    sun: "#ffbe76",
    ambient: "#8f7468",
    wall: "#c0957a",
    sill: "#e6cdb4",
    slope: 0.95,
    haze: 0.26,
  },
};

/** The look for a select value; unknown values fall back to afternoon. */
export function timeFor(id: string): TimeLook {
  return Object.hasOwn(TIMES, id) ? TIMES[id as TimeOfDayId] : TIMES.afternoon;
}

// ---------------------------------------------------------------- sunbeam

/** Beam half-width across its axis, height units, and the height at which it fades out on top. */
export const BEAM_HALF_WIDTH = 0.2;
export const BEAM_TOP = WINDOW[3];
/** Where the beam's axis meets the sill, past the cat's centre (cat units). */
const BEAM_LAND = 0.25;

/**
 * The sunbeam's axis, in height units: the point where it lands on the sill,
 * and its unit direction pointing up towards the window. It slants down and
 * inwards, across the cat.
 */
export interface Beam {
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Axis length from the sill to the window's top. */
  length: number;
}

export const createBeam = (): Beam => ({ x: 0, y: 0, dx: 0, dy: 1, length: 1 });

export function beamFor(layout: CatLayout, slope: number, out: Beam): Beam {
  out.x = layout.x + layout.side * BEAM_LAND * layout.size;
  out.y = SILL_FRONT_Y;
  const l = Math.hypot(slope, 1);
  out.dx = (-layout.side * slope) / l;
  out.dy = 1 / l;
  out.length = (BEAM_TOP - out.y) / out.dy;
  return out;
}

/**
 * Light in the beam at `along` (0..length from the sill) and `across` (height
 * units from the axis): a soft cross profile, faded in at both ends. 0..1.
 */
export function beamLight(beam: Beam, along: number, across: number): number {
  const c = clamp(1 - (across / BEAM_HALF_WIDTH) ** 2, 0, 1);
  const ends =
    smoothstep(0, 0.12, along) * (1 - smoothstep(beam.length - 0.25, beam.length, along));
  return c * c * ends;
}

// ---------------------------------------------------------------- motes

/** Mote drift speed (height units/s), settling speed, radius range (1080p px). */
export const MOTE_SPEED = 0.006;
export const MOTE_SETTLE = 0.0015;
export const MOTE_RADIUS = [3, 8] as const;

export interface Motes {
  /** Beam coordinates: along the axis (0..1 of its length) and across (-1..1 of the half-width). */
  along: Float32Array;
  across: Float32Array;
  /** Heading phase, wobble rate, size (0..1) and twinkle phase. */
  phase: Float32Array;
  rate: Float32Array;
  size: Float32Array;
  twinkle: Float32Array;
}

export function createMotes(count: number, seed = 0x117): Motes {
  const rng = createRng(seed);
  const m: Motes = {
    along: new Float32Array(count),
    across: new Float32Array(count),
    phase: new Float32Array(count),
    rate: new Float32Array(count),
    size: new Float32Array(count),
    twinkle: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    m.along[i] = rng();
    m.across[i] = rng() * 2 - 1;
    m.phase[i] = rng() * TAU;
    m.rate[i] = 0.05 + rng() * 0.12;
    m.size[i] = rng();
    m.twinkle[i] = rng() * TAU;
  }
  return m;
}

/**
 * Drifts the motes for `dt` seconds at time `t`: a slow wandering heading per
 * mote plus a gentle settle, wrapping round the beam so the count stays put.
 */
export function stepMotes(m: Motes, beam: Beam, t: number, dt: number): void {
  const n = m.along.length;
  const invL = 1 / Math.max(beam.length, 1e-3);
  const invW = 1 / BEAM_HALF_WIDTH;
  for (let i = 0; i < n; i++) {
    const h = m.phase[i] + 2.2 * Math.sin(t * m.rate[i] + m.twinkle[i]);
    const vx = Math.cos(h) * MOTE_SPEED;
    const vy = Math.sin(h) * MOTE_SPEED - MOTE_SETTLE;
    // Screen velocity into beam coordinates (the axis is a unit vector).
    const va = vx * beam.dx + vy * beam.dy;
    const vc = vx * beam.dy - vy * beam.dx;
    m.along[i] = wrap(m.along[i] + va * invL * dt, 0, 1);
    m.across[i] = wrap(m.across[i] + vc * invW * dt, -1, 2);
  }
}

/**
 * Brightness of mote `i` (0..1) at time `t` for the `amount` param: the beam's
 * light where it is, a slow twinkle as it turns, and a fade-in by index so the
 * count follows the param smoothly.
 */
export function moteBrightness(m: Motes, beam: Beam, i: number, t: number, amount: number): number {
  const a = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  const k = clamp(a * m.along.length - i, 0, 1);
  if (k <= 0) return 0;
  const light = beamLight(beam, m.along[i] * beam.length, m.across[i] * BEAM_HALF_WIDTH);
  return k * light * (0.65 + 0.35 * Math.sin(t * 0.9 + m.twinkle[i]));
}
