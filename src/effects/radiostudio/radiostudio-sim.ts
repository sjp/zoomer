/**
 * Pure logic for the Radio Studio (radiostudio.ts): the booth's layout, the
 * ON AIR light's schedule and fade, the meters' music-like envelope and needle
 * ballistics, the tape reels and the studio clock's hands. Nothing here touches
 * GL, so it is all unit tested.
 *
 * Layout units are "frame units": the origin at the frame's centre, y up, and
 * one unit the frame's height, so y runs -0.5..0.5 and x -aspect/2..aspect/2.
 * The layout is drawn for 16:9 with the microphone on the left; the effect
 * mirrors it for a microphone on the right. Narrower frames squeeze it sideways.
 */
import { approach, clamp, fract } from "../math";
import { hash32 } from "../noise";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The aspect the layout is drawn for. */
export const DESIGN_ASPECT = 16 / 9;

/** A box: centre x, y and half width, half height. */
export type Box = [number, number, number, number];
/** A disc: centre x, y and radius. */
export type Disc = [number, number, number];

export interface StudioLayout {
  aspect: number;
  /** The ON AIR sign's lit face; its housing is `SIGN_RIM` bigger all round. */
  sign: Box;
  /** The glass into the control room, inside its wooden frame. */
  window: Box;
  /** The equipment rack, and in it the two VU meters' faces and the two LED bars. */
  rack: Box;
  meters: [Box, Box];
  bars: [Box, Box];
  /** The two reel-to-reel machines' cabinets, and their four reels (two per machine, left to right). */
  decks: [Box, Box];
  reels: [Disc, Disc, Disc, Disc];
  /** The studio clock's face. */
  clock: Disc;
  /** The microphone: the windscreen's centre, half width and half height. */
  mic: Box;
  /** The boom arm: its mount (off the top), elbow and tip, as x, y pairs. */
  arm: [number, number, number, number, number, number];
  /** The record shelf under the rack. */
  records: Box;
  /** The turntable's platter on the desk: centre and radii. */
  platter: Box;
  /** The desk's back edge, and the top of its front lip. */
  deskTop: number;
  deskLip: number;
}

/**
 * Where each part of the layout sits in the room shader's `uL` array, in vec4
 * slots: boxes as (x, y, half width, half height), discs as (x, y, radius, 0).
 * The four reels take four slots from `reel0`; the clock's w is 1 when shown;
 * `arm0` holds the arm's mount and elbow, `arm1` its tip then the desk's top
 * and lip.
 */
export const STUDIO_SLOT = {
  sign: 0,
  window: 1,
  rack: 2,
  meter0: 3,
  meter1: 4,
  bar0: 5,
  bar1: 6,
  deck0: 7,
  deck1: 8,
  reel0: 9,
  clock: 13,
  mic: 14,
  arm0: 15,
  arm1: 16,
  records: 17,
  platter: 18,
} as const;
/** vec4 slots in the room shader's `uL` array. */
export const STUDIO_SLOTS = 19;

/** Packs `l` into the room shader's `uL` slots: `STUDIO_SLOTS * 4` floats of `out`. */
export function packStudioLayout(l: StudioLayout, showClock: boolean, out: Float32Array): void {
  out.fill(0, 0, STUDIO_SLOTS * 4);
  const put = (slot: number, v: readonly number[], w = v[3] ?? 0) => {
    const o = slot * 4;
    out[o] = v[0] ?? 0;
    out[o + 1] = v[1] ?? 0;
    out[o + 2] = v[2] ?? 0;
    out[o + 3] = w;
  };
  const S = STUDIO_SLOT;
  put(S.sign, l.sign);
  put(S.window, l.window);
  put(S.rack, l.rack);
  put(S.meter0, l.meters[0]);
  put(S.meter1, l.meters[1]);
  put(S.bar0, l.bars[0]);
  put(S.bar1, l.bars[1]);
  put(S.deck0, l.decks[0]);
  put(S.deck1, l.decks[1]);
  l.reels.forEach((r, i) => {
    put(S.reel0 + i, r, 0);
  });
  put(S.clock, l.clock, showClock ? 1 : 0);
  put(S.mic, l.mic);
  put(S.arm0, l.arm);
  put(S.arm1, [l.arm[4], l.arm[5], l.deskTop, l.deskLip]);
  put(S.records, l.records);
  put(S.platter, l.platter);
}

/** How far the sign's housing reaches past its face. */
export const SIGN_RIM = 0.012;
/** The window's wooden frame. */
export const WINDOW_FRAME = 0.018;

/**
 * The booth for a frame of `aspect`, with the microphone on the left. The
 * middle, behind the speaker, is plain foam; the sign is high on the far side,
 * clear of their head, with the control-room window and the tape machines under
 * it; the rack, records and clock are on the microphone's side.
 */
export function studioLayout(aspect: number): StudioLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  const k = Math.min(1, a / DESIGN_ASPECT);
  const x = (v: number) => v * k;
  const box = (cx: number, cy: number, hw: number, hh: number): Box => [x(cx), cy, hw * k, hh];
  const deckY = -0.225;
  const reelY = -0.15;
  const reelR = 0.048 * Math.min(1, 0.6 + 0.4 * k);
  return {
    aspect: a,
    sign: box(0.585, 0.385, 0.135, 0.046),
    window: box(0.6, 0.115, 0.25, 0.135),
    rack: box(-0.725, 0.0, 0.145, 0.17),
    meters: [box(-0.79, 0.105, 0.056, 0.042), box(-0.66, 0.105, 0.056, 0.042)],
    bars: [box(-0.725, 0.03, 0.12, 0.0065), box(-0.725, 0.009, 0.12, 0.0065)],
    decks: [box(0.472, deckY, 0.118, 0.145), box(0.728, deckY, 0.118, 0.145)],
    reels: [
      [x(0.417), reelY, reelR],
      [x(0.527), reelY, reelR],
      [x(0.673), reelY, reelR],
      [x(0.783), reelY, reelR],
    ],
    clock: [x(-0.72), 0.3, 0.088],
    mic: box(-0.42, 0.115, 0.033, 0.068),
    arm: [x(-0.61), 0.53, x(-0.53), 0.31, x(-0.372), 0.02],
    records: box(-0.725, -0.29, 0.145, 0.09),
    platter: box(0.72, -0.428, 0.085, 0.021),
    deskTop: -0.4,
    deskLip: -0.468,
  };
}

// ---------------------------------------------------------------------------
// The ON AIR light
// ---------------------------------------------------------------------------

/** In "Auto", one short break with the light off in every slot of this many seconds… */
export const BREAK_GAP = 240;
/** …this long, and starting somewhere in this middle share of the slot, so breaks never bunch up. */
export const BREAK_LENGTH = 9;
export const BREAK_SPREAD = 0.7;
/** Seconds for the light to fade fully on or off. */
export const LIGHT_FADE = 0.3;

/**
 * Whether "Auto" has the light on at `t` seconds: on, except for a short break
 * at a hashed moment in each slot of `BREAK_GAP` s, as between songs. The first
 * slot has no break, so the scene opens on air.
 */
export function autoOnAir(t: number): boolean {
  if (!(t > 0)) {
    return true;
  }
  const slot = Math.floor(t / BREAK_GAP);
  if (slot < 1) {
    return true;
  }
  const u = hash32(hash32(slot + 0x0a1e) ^ 0x5bd1e995) / 4294967296;
  const start =
    slot * BREAK_GAP + BREAK_GAP * ((1 - BREAK_SPREAD) / 2 + BREAK_SPREAD * u) - BREAK_LENGTH / 2;
  return t < start || t >= start + BREAK_LENGTH;
}

/** The light's target (1 on, 0 off) for `mode` ("on", "off" or "auto") at `t`. Unknown modes count as "auto". */
export function onAirTarget(mode: string, t: number): number {
  if (mode === "on") {
    return 1;
  }
  if (mode === "off") {
    return 0;
  }
  return autoOnAir(t) ? 1 : 0;
}

/** Moves the light (0..1) towards `target`, taking `LIGHT_FADE` s for a full fade. */
export function stepLight(light: number, target: number, dt: number): number {
  const from = Number.isFinite(light) ? clamp(light, 0, 1) : 0;
  return approach(
    from,
    clamp(target, 0, 1),
    Math.max(0, Number.isFinite(dt) ? dt : 0) / LIGHT_FADE,
  );
}

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

/** Random-walk samples averaged for the meters' envelope: a quarter second, so it bounces. */
export const MUSIC_SAMPLES = 4;
/** The envelope's middle and swing, as a share of the meters' scale. */
export const MUSIC_BASE = 0.58;
export const MUSIC_SWING = 0.55;

/**
 * The meters' target reading (0..1) for the walk's wander (about -1..1) and how
 * loud the programme is (0 when off air, 1 on air).
 */
export function musicLevel(wander: number, loud: number): number {
  const w = Number.isFinite(wander) ? wander : 0;
  const l = Number.isFinite(loud) ? clamp(loud, 0, 1) : 0;
  return clamp(l * (MUSIC_BASE + MUSIC_SWING * w), 0, 1);
}

/** A VU needle's natural frequency (Hz) and damping: a little overshoot, settling in about half a second. */
export const NEEDLE_FREQ = 1.8;
export const NEEDLE_DAMPING = 0.62;
/** The longest step the needle model takes at once. */
const NEEDLE_STEP = 1 / 240;

export interface Needle {
  /** Reading, 0..1 across the scale. */
  pos: number;
  /** Reading per second. */
  vel: number;
}

export const createNeedle = (): Needle => ({ pos: 0, vel: 0 });

/**
 * Moves a needle towards `target` for `dt` seconds as a damped spring, so it
 * has a needle's mechanical inertia. The scale's ends are stops: the needle
 * never leaves 0..1 and loses its speed against them.
 */
export function stepNeedle(n: Needle, target: number, dt: number): Needle {
  const goal = Number.isFinite(target) ? clamp(target, 0, 1) : 0;
  if (!Number.isFinite(n.pos) || !Number.isFinite(n.vel)) {
    n.pos = goal;
    n.vel = 0;
  }
  // A long pause (a hidden tab) needn't be replayed in full: the needle has long settled.
  let left = Math.min(Math.max(0, Number.isFinite(dt) ? dt : 0), 2);
  const w = TAU * NEEDLE_FREQ;
  while (left > 0) {
    const h = Math.min(left, NEEDLE_STEP);
    left -= h;
    n.vel += (w * w * (goal - n.pos) - 2 * NEEDLE_DAMPING * w * n.vel) * h;
    n.pos += n.vel * h;
    if (n.pos < 0) {
      n.pos = 0;
      n.vel = Math.max(0, n.vel);
    } else if (n.pos > 1) {
      n.pos = 1;
      n.vel = Math.min(0, n.vel);
    }
  }
  return n;
}

/** The LED bars rise quickly and fall back slowly (time constants, s). */
export const BAR_ATTACK = 0.05;
export const BAR_RELEASE = 0.4;
/** Segments in each LED bar. */
export const BAR_SEGMENTS = 16;

/** An LED bar's level (0..1) after `dt` seconds chasing `target`. */
export function stepBar(level: number, target: number, dt: number): number {
  const from = Number.isFinite(level) ? clamp(level, 0, 1) : 0;
  const goal = Number.isFinite(target) ? clamp(target, 0, 1) : 0;
  const tau = goal > from ? BAR_ATTACK : BAR_RELEASE;
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  return goal + (from - goal) * Math.exp(-step / tau);
}

// ---------------------------------------------------------------------------
// Tape reels
// ---------------------------------------------------------------------------

/** The bare hub's radius and a full reel's, as shares of the flange's radius. */
export const REEL_HUB = 0.3;
export const REEL_FULL = 0.94;
/** How far the tape winds each way: from this fill of the take-up reel to its complement. */
export const TAPE_MIN = 0.08;
/** Seconds to wind from one end of that range to the other. */
export const TAPE_RUN = 1500;
/** Fill within which the machine eases to a stop before reversing, and the slowest it goes there. */
export const TAPE_EASE = 0.03;
const TAPE_CRAWL = 0.08;
/** Tape speed, in flange radii per second: a reel's turning speed is this over its pack's radius. */
export const TAPE_SPEED = 0.45;

export interface Tape {
  /** How full the right-hand (take-up) reel is, `TAPE_MIN`..1 - `TAPE_MIN`. */
  fill: number;
  /** +1 winding onto the right-hand reel, -1 back onto the left. */
  dir: number;
  /** The two reels' angles (radians, counter-clockwise), wrapped to 0..2π. */
  left: number;
  right: number;
}

export const createTape = (fill: number): Tape => ({
  fill: clamp(fill, TAPE_MIN, 1 - TAPE_MIN),
  dir: 1,
  left: 0,
  right: 0,
});

/** A reel's pack radius (share of the flange's radius) when it holds `fill` (0..1) of the tape. */
export function packRadius(fill: number): number {
  const f = clamp(Number.isFinite(fill) ? fill : 0, 0, 1);
  return Math.sqrt(REEL_HUB * REEL_HUB + f * (REEL_FULL * REEL_FULL - REEL_HUB * REEL_HUB));
}

/**
 * Winds the tape for `dt` seconds at `speed` (0..1; 0 stops the reels): one
 * reel fills as the other empties, both turning clockwise (or back, once the
 * tape reaches its end and the machine reverses), each at the tape's speed
 * over its own pack's radius. The machine slows to a crawl as it nears either
 * end, so it never reverses at full speed.
 */
export function stepTape(tape: Tape, dt: number, speed: number): Tape {
  const s = clamp(Number.isFinite(speed) ? speed : 0, 0, 1);
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  if (s === 0 || step === 0) {
    return tape;
  }
  const lo = TAPE_MIN;
  const hi = 1 - TAPE_MIN;
  const room = tape.dir > 0 ? hi - tape.fill : tape.fill - lo;
  const ease = TAPE_CRAWL + (1 - TAPE_CRAWL) * clamp(room / TAPE_EASE, 0, 1);
  const v = s * ease;
  tape.fill += (tape.dir * v * step * (hi - lo)) / TAPE_RUN;
  if (tape.fill >= hi) {
    tape.fill = hi;
    tape.dir = -1;
  } else if (tape.fill <= lo) {
    tape.fill = lo;
    tape.dir = 1;
  }
  // Clockwise is negative; reversing turns both reels back.
  const turn = -tape.dir * v * TAPE_SPEED * step;
  tape.left = fract((tape.left + turn / packRadius(1 - tape.fill)) / TAU) * TAU;
  tape.right = fract((tape.right + turn / packRadius(tape.fill)) / TAU) * TAU;
  return tape;
}
