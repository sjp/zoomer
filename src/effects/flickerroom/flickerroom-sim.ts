/**
 * Pure logic for the Flicker Room (flickerroom.ts): where the room's things
 * are, how the ceiling tubes light it, the tints, the failing tube's flicker
 * schedule and brightness curve, and the deck of small changes swapped in
 * while that tube is dark. Nothing here touches GL (the tubes' light pool is
 * also given as GLSL source), so it is all unit tested.
 *
 * Layout units are "design units": the origin at the frame's centre, y up, and
 * one unit the frame's height at 16:9 (see `fitScale` in `scene-layout.ts`), so
 * the 16:9 frame runs x -0.89..0.89, y -0.5..0.5. Wider frames show more wall at
 * the sides; narrower ones show the whole room smaller.
 */
import { glslFloat as g } from "../gl";
import { clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Where the wall meets the floor. */
export const FLOOR_Y = -0.1;

/** A box: centre x, y and half width, half height. */
type Box = readonly [number, number, number, number];

/** The things that change, each an index into `THING_BOXES` and the room's state. */
export const THING_SHIFT = 0;
export const THING_TURN = 1;
export const THING_DOOR = 2;
export const THING_COAT = 3;
export const THING_MAGAZINE = 4;
export const THING_CLOCK = 5;
export const THING_PAPER = 6;
export const THING_FIGURE = 7;
export const THINGS = 8;

/**
 * The box round everything each thing draws, in every one of its states, with
 * its shadows: a change redraws just this box of the cached room.
 *
 * - shift: the row's left-hand chair, pulled forward and askew;
 * - turn: the lone chair in front of the coat hooks, side-on, then facing out;
 * - door: the door on the left, shut, ajar, then further ajar;
 * - coat: a coat on the middle hook;
 * - magazine: the top magazine of the table's pile, then on the floor;
 * - clock: the clock above the door, its hands jumped forward;
 * - paper: a paper on the noticeboard, then on the floor below it;
 * - figure: the shape at the far end of the corridor, then nearer.
 */
export const THING_BOXES: readonly Box[] = [
  [-0.42, -0.085, 0.115, 0.19],
  [0.38, -0.19, 0.11, 0.18],
  [-0.6, 0.105, 0.13, 0.23],
  [0.37, 0.07, 0.085, 0.17],
  [-0.6, -0.32, 0.2, 0.14],
  [-0.6, 0.42, 0.07, 0.07],
  [-0.33, -0.02, 0.12, 0.31],
  [0.65, 0.105, 0.125, 0.215],
];

/** The ceiling tubes' x, all just out of shot above the camera; tube 0 is the failing one. */
export const TUBE_X = [-0.52, 0.08, 0.66] as const;
/** How wide each tube's pool of light is (its Gaussian's sigma). */
const POOL_SIGMA = 0.32;
/** The centre of the pools on the floor. */
const POOL_FLOOR_Y = -0.3;

/**
 * How much of tube `i`'s light reaches the room at (x, y), 0..1: a pool round
 * the tube's x, brightest high on the wall and in a band across the floor. The
 * room's shader bakes the same function (`POOL_GLSL`) into its light masks.
 */
export function tubePool(i: number, x: number, y: number): number {
  const dx = x - TUBE_X[i];
  const lateral = Math.exp((-dx * dx) / (2 * POOL_SIGMA * POOL_SIGMA));
  if (y >= FLOOR_Y) {
    return lateral * (0.45 + 0.55 * smoothstep(FLOOR_Y, 0.5, y));
  }
  const dy = (y - POOL_FLOOR_Y) / 0.14;
  return lateral * (0.35 + 0.5 * Math.exp(-0.5 * dy * dy));
}

/** GLSL for `float tubePool(float tubeX, vec2 p)`, the shader twin of `tubePool`. */
export const POOL_GLSL = /* glsl */ `
float tubePool(float tubeX, vec2 p) {
  float dx = p.x - tubeX;
  float lateral = exp(-dx * dx / ${g(2 * POOL_SIGMA * POOL_SIGMA)});
  if (p.y >= ${g(FLOOR_Y)}) {
    return lateral * (0.45 + 0.55 * smoothstep(${g(FLOOR_Y)}, 0.5, p.y));
  }
  float dy = (p.y - ${g(POOL_FLOOR_Y)}) / 0.14;
  return lateral * (0.35 + 0.5 * exp(-0.5 * dy * dy));
}
`;

// ---------------------------------------------------------------------------
// Tints
// ---------------------------------------------------------------------------

/**
 * Floats per tint, eased as one block: the ambient light's RGB, the tubes' RGB,
 * each tube's strength, and the corridor's and exit sign's own light.
 */
export const TINT_FLOATS = 10;

/**
 * The room's light per tint. Hospital green and office beige light the room with
 * all three tubes; at night only the failing tube is on, so the corridor's light
 * and a dim ambient keep the room from going black when it flickers.
 */
export const TINTS: Readonly<Record<string, readonly number[]>> = {
  green: [0.3, 0.36, 0.31, 0.52, 0.62, 0.54, 1, 1, 1, 1],
  beige: [0.36, 0.33, 0.28, 0.66, 0.6, 0.48, 1, 1, 1, 0.9],
  night: [0.08, 0.1, 0.11, 0.55, 0.63, 0.57, 1.1, 0, 0, 1.3],
};

/** The brightest any surface's colour is in the room's art, for brightness budgets. */
export const ALBEDO_MAX = 0.75;

// ---------------------------------------------------------------------------
// The flicker curve
// ---------------------------------------------------------------------------

/** Dips in one flicker, at most. */
const MAX_DIPS = 4;
/** A flicker's length, seconds. */
export const FLICKER_MIN = 0.6;
export const FLICKER_MAX = 1.2;
/**
 * The fastest the failing tube's brightness changes, in full swings a second.
 * Together with the tube's share of the frame's light this bounds how fast the
 * frame's mean brightness can change.
 */
export const MAX_SLOPE = 5.5;
/** Below this the failing tube counts as dark: changes are swapped in only then. */
export const DARK_LEVEL = 0.1;
/** The deepest dip's depth and its hold at the bottom, seconds. */
const MAIN_DEPTH = [0.93, 0.97] as const;
const MAIN_HOLD = [0.08, 0.16] as const;
/** The stutters' depths, and the gaps between dips, seconds. */
const STUTTER_DEPTH = [0.25, 0.65] as const;
const DIP_GAP = [0.03, 0.1] as const;
/** How much longer than the steepest allowed a dip may be. */
const WIDTH_SLACK = 0.3;
/** Where in the main dip's hold the change is swapped in (0 its start, 1 its end). */
const SWAP_AT = 0.25;

const lerp = (range: readonly [number, number], u: number) => range[0] + (range[1] - range[0]) * u;

/**
 * One flicker's shape: a stutter of 2-4 raised-cosine dips, one of them (never
 * the first) the deep "main" dip that holds near off for a moment.
 */
interface FlickerShape {
  dips: number;
  main: number;
  /** Per dip: start time, width (excluding the hold), depth, hold at the bottom. */
  readonly start: Float64Array;
  readonly width: Float64Array;
  readonly depth: Float64Array;
  readonly hold: Float64Array;
  /** Per dip: the gap after it before the next. */
  readonly gap: Float64Array;
  duration: number;
  /** When the change is swapped in, seconds into the flicker. */
  swapAt: number;
}

export function createFlickerShape(): FlickerShape {
  return {
    dips: 0,
    main: 0,
    start: new Float64Array(MAX_DIPS),
    width: new Float64Array(MAX_DIPS),
    depth: new Float64Array(MAX_DIPS),
    hold: new Float64Array(MAX_DIPS),
    gap: new Float64Array(MAX_DIPS),
    duration: 0,
    swapAt: 0,
  };
}

/**
 * Fills `s` with a new flicker from `rng`. Each dip is as wide as its depth
 * allows at `MAX_SLOPE` (plus a little), so no dip changes the light faster
 * than that; stutters shrink, keeping their slope, if the flicker would run
 * over `FLICKER_MAX`, and the gaps stretch if it would be under `FLICKER_MIN`.
 */
export function shapeFlicker(s: FlickerShape, rng: () => number): FlickerShape {
  const n = 2 + Math.min(2, Math.floor(rng() * 3));
  s.dips = n;
  s.main = 1 + Math.min(n - 2, Math.floor(rng() * (n - 1)));
  let fixed = 0;
  let stutter = 0;
  for (let i = 0; i < n; i++) {
    const main = i === s.main;
    const d = main ? lerp(MAIN_DEPTH, rng()) : lerp(STUTTER_DEPTH, rng());
    s.depth[i] = d;
    s.width[i] = ((d * Math.PI) / MAX_SLOPE) * (1 + WIDTH_SLACK * rng());
    s.hold[i] = main ? lerp(MAIN_HOLD, rng()) : 0;
    if (main) {
      fixed += s.width[i] + s.hold[i];
    } else {
      stutter += s.width[i];
    }
  }
  const gaps = s.gap;
  gaps.fill(0);
  for (let i = 0; i < n - 1; i++) {
    gaps[i] = lerp(DIP_GAP, rng());
    fixed += gaps[i];
  }
  if (fixed + stutter > FLICKER_MAX) {
    const f = Math.max(0, (FLICKER_MAX - fixed) / stutter);
    for (let i = 0; i < n; i++) {
      if (i !== s.main) {
        s.width[i] *= f;
        s.depth[i] *= f;
      }
    }
    stutter *= f;
  }
  const total = fixed + stutter;
  if (total < FLICKER_MIN) {
    const extra = (FLICKER_MIN - total) / (n - 1);
    for (let i = 0; i < n - 1; i++) {
      gaps[i] += extra;
    }
  }
  let t = 0;
  for (let i = 0; i < n; i++) {
    s.start[i] = t;
    t += s.width[i] + s.hold[i] + (i < n - 1 ? gaps[i] : 0);
  }
  s.duration = t;
  const m = s.main;
  s.swapAt = s.start[m] + 0.5 * s.width[m] + SWAP_AT * s.hold[m];
  return s;
}

/** The failing tube's brightness `t` seconds into flicker `s`, 0..1 (1 outside it). */
export function flickerLevel(s: FlickerShape, t: number): number {
  for (let i = 0; i < s.dips; i++) {
    const u = t - s.start[i];
    const w = s.width[i];
    const h = s.hold[i];
    if (u < 0 || u > w + h) {
      continue;
    }
    // Down over half the width, hold, then back up over the other half.
    const v = u < 0.5 * w ? u / (0.5 * w) : u < 0.5 * w + h ? 1 : (w + h - u) / (0.5 * w);
    return 1 - s.depth[i] * 0.5 * (1 - Math.cos(Math.PI * v));
  }
  return 1;
}

/** The hum's deepest dimming, a fraction of the tube's light, at a hum of 1. */
export const HUM_DEPTH = 0.02;
/** The hum's two slow periods, seconds. */
const HUM_PERIODS = [6.3, 9.7] as const;

/** The failing tube's slow hum at `time`, 1 - up to `HUM_DEPTH * hum`. */
export function humLevel(time: number, hum: number, phase: number): number {
  const h = clamp(Number.isFinite(hum) ? hum : 0, 0, 1);
  const w =
    0.6 * Math.sin((2 * Math.PI * time) / HUM_PERIODS[0] + phase) +
    0.4 * Math.sin((2 * Math.PI * time) / HUM_PERIODS[1] + 2.1 * phase);
  return 1 - HUM_DEPTH * h * 0.5 * (1 + w);
}

// ---------------------------------------------------------------------------
// The deck of changes
// ---------------------------------------------------------------------------

/**
 * The cards: each sets one thing to a state. Chains (the door opening further,
 * the coat coming then going, the figure coming nearer then going) are played
 * in order within a deck.
 */
const CARD_THING = [
  THING_SHIFT,
  THING_TURN,
  THING_DOOR,
  THING_DOOR,
  THING_COAT,
  THING_COAT,
  THING_MAGAZINE,
  THING_CLOCK,
  THING_PAPER,
  THING_FIGURE,
  THING_FIGURE,
  THING_FIGURE,
] as const;
const CARD_STATE = [1, 1, 1, 2, 1, 0, 1, 1, 1, 1, 2, 0] as const;
export const CARDS = CARD_THING.length;
/** The figure's cards, the last three: dealt only when the deck's presence roll says so. */
const FIGURE_CARDS = 3;
const CHAINS: readonly (readonly number[])[] = [
  [2, 3],
  [4, 5],
  [9, 10, 11],
];

/** The thing a card changes and the state it sets. */
export const cardThing = (card: number) => CARD_THING[card];
export const cardState = (card: number) => CARD_STATE[card];

/** Clock jumps: whole hours forward, plus some minutes. */
const JUMP_HOURS = [2, 9] as const;

/** First flicker after this many seconds (or sooner with a short interval). */
const FIRST_GAP = [6, 14] as const;
/** Gaps between flickers, as fractions of the interval: their mean is 1. */
const GAP_SPREAD = [0.5, 1.5] as const;
/** The interval's range, seconds. */
export const INTERVAL_MIN = 15;
export const INTERVAL_MAX = 120;

export interface FlickerRoom {
  readonly seed: number;
  /** Gaps and flicker shapes, and the deck's shuffles: two streams. */
  readonly scheduleRng: () => number;
  readonly deckRng: () => number;
  /** Seconds since the room was made, for the hum. */
  time: number;
  humPhase: number;
  /** Seconds to the next flicker, while none is under way. */
  wait: number;
  active: boolean;
  /** Seconds into the flicker under way. */
  t: number;
  swapped: boolean;
  readonly shape: FlickerShape;
  /** Each thing's state, 0 when it's as it should be. */
  readonly state: Uint8Array;
  /** The deck being dealt, `deckLength` cards, the next at `deckPos`. */
  readonly deck: Int8Array;
  deckLength: number;
  deckPos: number;
  /** Decks dealt so far. */
  decks: number;
  /** After a deck: the things put back to normal, one a flicker. */
  restoring: boolean;
  readonly restore: Int8Array;
  restoreLength: number;
  restorePos: number;
  /** The clock's time, minutes past twelve, and how far it has jumped. */
  clockBase: number;
  clockJump: number;
  /** Flickers so far. */
  flickers: number;
}

/** Shuffles the first `n` entries of `a` in place (Fisher-Yates). */
function shuffle(a: Int8Array, n: number, rng: () => number): void {
  for (let i = n - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

/**
 * Deals a new deck: every card once in a shuffled order, the figure's only if
 * a roll comes in under `presence`; each chain's cards then take the places its
 * cards fell in, in chain order.
 */
export function dealDeck(room: FlickerRoom, presence: number): void {
  const rng = room.deckRng;
  const p = clamp(Number.isFinite(presence) ? presence : 0, 0, 1);
  const withFigure = rng() < p;
  const n = withFigure ? CARDS : CARDS - FIGURE_CARDS;
  for (let i = 0; i < n; i++) {
    room.deck[i] = i;
  }
  shuffle(room.deck, n, rng);
  for (const chain of CHAINS) {
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (chain.includes(room.deck[i])) {
        room.deck[i] = chain[k++];
      }
    }
  }
  room.deckLength = n;
  room.deckPos = 0;
  room.restoring = false;
  room.decks++;
}

/** Plays the next change (a card, or a thing put back): returns the thing changed. */
function nextChange(room: FlickerRoom, presence: number): number {
  for (;;) {
    if (room.restoring) {
      if (room.restorePos < room.restoreLength) {
        const thing = room.restore[room.restorePos++];
        room.state[thing] = 0;
        if (thing === THING_CLOCK) {
          room.clockJump = 0;
        }
        return thing;
      }
      dealDeck(room, presence);
      continue;
    }
    if (room.deckPos < room.deckLength) {
      const card = room.deck[room.deckPos++];
      const thing = CARD_THING[card];
      room.state[thing] = CARD_STATE[card];
      if (thing === THING_CLOCK) {
        const rng = room.deckRng;
        room.clockJump = 60 * Math.round(lerp(JUMP_HOURS, rng())) + Math.floor(rng() * 60);
      }
      return thing;
    }
    // The deck is spent: put back whatever is still out of place, in a shuffled order.
    room.restoring = true;
    room.restoreLength = 0;
    room.restorePos = 0;
    for (let i = 0; i < THINGS; i++) {
      if (room.state[i] !== 0) {
        room.restore[room.restoreLength++] = i;
      }
    }
    shuffle(room.restore, room.restoreLength, room.deckRng);
  }
}

/** Seconds to wait for the next flicker after one, latched from `interval`. */
function nextGap(rng: () => number, interval: number): number {
  const i = clamp(Number.isFinite(interval) ? interval : INTERVAL_MIN, INTERVAL_MIN, INTERVAL_MAX);
  return i * lerp(GAP_SPREAD, rng());
}

/** A room for `seed`, as it should be, its first flicker latched from `interval`. */
export function createRoom(seed: number, interval: number): FlickerRoom {
  const s = Math.floor(Number.isFinite(seed) ? seed : 0);
  const scheduleRng = createRng(hash32(s ^ 0x2f6b1c3d));
  const deckRng = createRng(hash32(s ^ 0x51ed270b));
  return {
    seed: s,
    scheduleRng,
    deckRng,
    time: 0,
    humPhase: scheduleRng() * Math.PI * 2,
    // The first flicker comes soon, whatever the interval.
    wait: Math.min(lerp(FIRST_GAP, scheduleRng()), nextGap(scheduleRng, interval)),
    active: false,
    t: 0,
    swapped: false,
    shape: createFlickerShape(),
    state: new Uint8Array(THINGS),
    deck: new Int8Array(CARDS),
    deckLength: 0,
    deckPos: 0,
    decks: 0,
    restoring: false,
    restore: new Int8Array(THINGS),
    restoreLength: 0,
    restorePos: 0,
    // Any time on the dial; the second hand is stopped (see stoppedSecond).
    clockBase: Math.floor(deckRng() * 720),
    clockJump: 0,
    flickers: 0,
  };
}

/**
 * Runs the room for `dt` seconds: waits, flickers, and at each flicker's
 * darkest moment plays the next change. A gap latches `interval` when it
 * starts, and a deck latches `presence` when it's dealt. Returns a bit per
 * thing that changed (1 << thing), 0 for none.
 */
export function advanceRoom(
  room: FlickerRoom,
  dt: number,
  interval: number,
  presence: number,
): number {
  let left = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  room.time += left;
  let changed = 0;
  for (;;) {
    if (!room.active) {
      if (left < room.wait) {
        room.wait -= left;
        return changed;
      }
      left -= room.wait;
      room.wait = 0;
      room.active = true;
      room.t = 0;
      room.swapped = false;
      shapeFlicker(room.shape, room.scheduleRng);
      room.flickers++;
      continue;
    }
    const t = room.t + left;
    if (!room.swapped && t >= room.shape.swapAt) {
      room.swapped = true;
      changed |= 1 << nextChange(room, presence);
    }
    if (t < room.shape.duration) {
      room.t = t;
      return changed;
    }
    left = t - room.shape.duration;
    room.active = false;
    room.t = 0;
    room.wait = nextGap(room.scheduleRng, interval);
  }
}

/** The failing tube's brightness now, 0..1: its flicker, if one is under way, and its hum. */
export function failingLevel(room: FlickerRoom, hum: number): number {
  const f = room.active ? flickerLevel(room.shape, room.t) : 1;
  return f * humLevel(room.time, hum, room.humPhase);
}

/** The clock's time, minutes past twelve (0..720). */
export function clockMinutes(room: FlickerRoom): number {
  return (room.clockBase + room.clockJump) % 720;
}

/** Where the clock's stopped second hand points, 0..1 of a turn, from the seed. */
export const stoppedSecond = (seed: number) => (hash32(Math.floor(seed) ^ 0x7c3a9e15) % 60) / 60;
