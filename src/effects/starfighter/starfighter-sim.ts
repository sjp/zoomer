/**
 * Starfighter Cockpit model, all pure functions of time so it can be tested
 * without stepping:
 *
 * - The droid's dome: it holds a pose, then every 10 to 30 s turns, eased, to
 *   a new one within ±60° of straight ahead.
 * - Its indicator light: a slow blink, alternating red and blue.
 * - The wingman: now and then a fighter slides in from the side, holds
 *   formation off the upper corner for a while, then banks and peels away.
 *   Each visit starts and ends fully out of frame, with a clear gap before the
 *   next.
 *
 * Positions are in frame heights from the frame's centre, y up.
 */
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";

/** Uniform 0..1 from three integers. */
function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x5bd1e995))) / 4294967296;
}

/** Eases 0..1 with zero speed and acceleration at both ends. */
export function ease(u: number): number {
  const x = clamp(u, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/* ----- Layout ----- */

/** The droid's dome: its centre (x for the left side; mirrored on the right) and radius. */
export const DROID_X = -0.5;
export const DROID_Y = 0.14;
export const DROID_R = 0.095;
/** How far the view looks down on the droid (radians), showing the top of its dome. */
export const DROID_PITCH = 0.32;
/** The dome's rest heading (radians, towards the frame's centre): a three-quarter view. */
export const DROID_REST = 0.45;

/* ----- The dome's turns ----- */

/** Each turn starts in its own slot, `TURN_JITTER` either side of the slot's middle. */
export const TURN_SLOT = 20;
export const TURN_JITTER = 5;
/** So turns start between these many seconds apart. */
export const MIN_TURN_GAP = TURN_SLOT - 2 * TURN_JITTER;
export const MAX_TURN_GAP = TURN_SLOT + 2 * TURN_JITTER;
/** Shortest and longest turn (s). */
export const TURN_MIN_SECONDS = 1.6;
export const TURN_MAX_SECONDS = 2.6;
/** The farthest the dome turns from its rest heading (radians). */
export const MAX_TURN = Math.PI / 3;
/** A pose is at least this far from straight ahead, unless it looks straight ahead. */
const MIN_POSE = 0.25 * MAX_TURN;
/** Chance a pose looks straight ahead again. */
const AHEAD_CHANCE = 0.2;

export interface DomeState {
  /** Heading relative to rest (radians), within ±`MAX_TURN`. */
  angle: number;
  /** Whether a turn is under way. */
  turning: boolean;
  /** The turn under way, or the last one made (-1 before the first). */
  turn: number;
}

export function createDomeState(): DomeState {
  return { angle: 0, turning: false, turn: -1 };
}

/** When turn `k` starts (s). */
export function turnStart(k: number, seed: number): number {
  return (k + 0.5) * TURN_SLOT + TURN_JITTER * (2 * rand(k, seed, 1) - 1);
}

/** How long turn `k` takes (s). */
export function turnSeconds(k: number, seed: number): number {
  return TURN_MIN_SECONDS + (TURN_MAX_SECONDS - TURN_MIN_SECONDS) * rand(k, seed, 2);
}

/** The heading the dome holds after turn `k` (0, straight ahead, before the first). */
export function domePose(k: number, seed: number): number {
  if (k < 0 || rand(k, seed, 3) < AHEAD_CHANCE) {
    return 0;
  }
  const side = rand(k, seed, 4) < 0.5 ? -1 : 1;
  return side * (MIN_POSE + (MAX_TURN - MIN_POSE) * rand(k, seed, 5));
}

/** The dome's heading at `t` seconds, written into `out`. Allocates nothing. */
export function domeAt(t: number, seed: number, out: DomeState): DomeState {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  const k = Math.floor(time / TURN_SLOT);
  const start = turnStart(k, seed);
  // A slot's turn ends before the next slot begins, so the last finished
  // turn is this slot's or the one before.
  const done = time < start ? k - 1 : k;
  const u = (time - start) / turnSeconds(k, seed);
  if (time >= start && u < 1) {
    const from = domePose(k - 1, seed);
    out.turning = true;
    out.turn = k;
    out.angle = from + (domePose(k, seed) - from) * ease(u);
  } else {
    out.turning = false;
    out.turn = done;
    out.angle = domePose(done, seed);
  }
  return out;
}

/* ----- The indicator light ----- */

/** Seconds per blink, how long it stays lit, and how long it takes to fade on or off. */
export const BLINK_PERIOD = 4.5;
const BLINK_ON = 1.8;
const BLINK_FADE = 0.45;

export interface Indicator {
  /** 0..1: how brightly it is lit. */
  level: number;
  /** Whether this blink is blue rather than red. */
  blue: boolean;
}

export function createIndicator(): Indicator {
  return { level: 0, blue: false };
}

/** The indicator at `t` seconds, written into `out`: red and blue blinks in turn. */
export function indicatorAt(t: number, out: Indicator): Indicator {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  const n = Math.floor(time / BLINK_PERIOD);
  const s = time - n * BLINK_PERIOD;
  out.level = smoothstep(0, BLINK_FADE, s) * (1 - smoothstep(BLINK_ON, BLINK_ON + BLINK_FADE, s));
  out.blue = n % 2 === 1;
  return out;
}

/* ----- The wingman ----- */

/** Seconds per visit slot: at most one visit in each. */
export const WING_SLOT = 100;
/** Chance a slot has a visit. */
const WING_CHANCE = 0.7;
/** Seconds sliding in, holding formation (shortest and longest) and peeling away. */
export const WING_ENTER = 10;
export const WING_HOLD_MIN = 20;
export const WING_HOLD_MAX = 40;
export const WING_PEEL = 9;
/** The fewest seconds between one visit's end and the next one's start. */
export const WING_MIN_GAP = 20;
/** Where the wingman holds formation: this far in from the side edge, at this height. */
const HOLD_IN = 0.21;
const HOLD_Y = 0.29;
/** The wingman's bounding sphere, in frame heights on screen, while it holds. */
export const WING_SCREEN_R = 0.085;
/** Off-frame, its centre is this many screen radii beyond the edge (its sphere spreads off-axis). */
const OFF_MARGIN = 1.6;
/** The view's focal length (frame heights) and the wingman's distance while holding, for the shader. */
export const WING_FOCAL = 1.8;
export const WING_DISTANCE = 6;

export interface Wingman {
  /** Whether a visit is under way. */
  visible: boolean;
  /** Centre on screen, and its bounding sphere's radius on screen. */
  x: number;
  y: number;
  radius: number;
  /** Its turn away from the camera and its bank (radians). */
  yaw: number;
  roll: number;
}

export function createWingman(): Wingman {
  return { visible: false, x: 0, y: 0, radius: 0, yaw: 0, roll: 0 };
}

/** Visit in slot `slot`: its start and length (s), or length 0 for none. */
export function wingmanVisit(
  slot: number,
  seed: number,
  out: { start: number; length: number },
): { start: number; length: number } {
  out.start = slot * WING_SLOT;
  out.length = 0;
  if (rand(slot, seed, 40) >= WING_CHANCE) {
    return out;
  }
  const hold = WING_HOLD_MIN + (WING_HOLD_MAX - WING_HOLD_MIN) * rand(slot, seed, 41);
  const length = WING_ENTER + hold + WING_PEEL;
  // Leaves room for the gap before the next slot begins.
  out.start += (WING_SLOT - length - WING_MIN_GAP) * rand(slot, seed, 42);
  out.length = length;
  return out;
}

const visit = { start: 0, length: 0 };

/**
 * The wingman at `t` seconds for a frame `aspect` wide, written into `out`.
 * It flies on the side `side` (-1 left, 1 right). Allocates nothing.
 */
export function wingmanAt(
  t: number,
  seed: number,
  aspect: number,
  side: number,
  out: Wingman,
): Wingman {
  out.visible = false;
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  wingmanVisit(Math.floor(time / WING_SLOT), seed, visit);
  const s = time - visit.start;
  if (visit.length <= 0 || s < 0 || s >= visit.length) {
    return out;
  }
  const half = aspect / 2;
  const holdX = side * (half - HOLD_IN);
  const offX = (r: number) => side * (half + r * OFF_MARGIN);
  const peelAt = visit.length - WING_PEEL;
  out.visible = true;
  out.yaw = 0;
  if (s < WING_ENTER) {
    // Slides in from beyond the side, closing up from a little behind and below.
    const e = ease(s / WING_ENTER);
    const r = WING_SCREEN_R * (0.8 + 0.2 * e);
    out.radius = r;
    out.x = offX(r) + (holdX - offX(r)) * e;
    out.y = HOLD_Y - 0.05 * (1 - e);
    out.roll = -side * 0.22 * Math.sin(Math.PI * e);
  } else if (s < peelAt) {
    // Holds formation, bobbing gently, the bob easing in and out.
    const u = s - WING_ENTER;
    const k = smoothstep(0, 3, u) * smoothstep(0, 3, peelAt - s);
    const ph = 6.283 * rand(Math.floor(time / WING_SLOT), seed, 43);
    out.radius = WING_SCREEN_R;
    out.x = holdX + 0.006 * k * Math.sin((6.283 * u) / 7.3 + ph);
    out.y = HOLD_Y + 0.009 * k * Math.sin((6.283 * u) / 5.1 + 2 * ph);
    out.roll = 0.035 * k * Math.sin((6.283 * u) / 6.2 + ph);
  } else {
    // Banks away, turning out and climbing, faster and faster until it is gone.
    const u = (s - peelAt) / WING_PEEL;
    const a = u * u;
    const r = WING_SCREEN_R * (1 - 0.3 * a);
    out.radius = r;
    out.x = holdX + (offX(r) - holdX) * a;
    out.y = HOLD_Y + 0.1 * a;
    out.roll = side * 0.9 * smoothstep(0, 0.5, u);
    out.yaw = side * 0.6 * a;
  }
  return out;
}
