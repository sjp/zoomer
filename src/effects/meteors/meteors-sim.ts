/**
 * Pure JS side of Meteor Shower (meteors.ts): the seeded event schedule, where
 * each meteor starts and where it heads (away from the radiant, clear of the
 * centre and the ground), each meteor's pose as a pure function of its age, the
 * hillside's column table with its trees or tent, and the still sky's layout.
 * Nothing here touches GL.
 *
 * Coordinates: reference px of a 1080-tall frame, origin bottom-left, y up
 * (as `gl_FragCoord / scale`), unless a comment says "height units" (the frame
 * is 1 tall).
 */
import { clamp, smoothstep } from "../math";
import { createNoise, createRng } from "../noise";
import { bandThrough, type MilkyWayBand } from "../starfield-sim";

export const REF_HEIGHT = 1080;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Event schedule (a Poisson process, self-contained so other effects can copy it)
// ---------------------------------------------------------------------------

/** Events further than this (s) in the past are dropped rather than released at once. */
export const SCHEDULE_MAX_LAG = 2;

/**
 * A seeded Poisson process: exponential gaps at the current rate. Changing the
 * rate redraws the pending gap from "now", which is exact for a Poisson
 * process (it has no memory), so a slider never leaves a long wait behind.
 */
interface EventSchedule {
  /** Time (s) of the pending event; NaN before the first `takeEvent`. */
  next: number;
  /** Rate (events per s) `next` was drawn at; NaN before the first `takeEvent`. */
  rate: number;
  rand: () => number;
}

export const createEventSchedule = (seed: number): EventSchedule => ({
  next: Number.NaN,
  rate: Number.NaN,
  rand: createRng(Math.floor(seed) * 7907 + 17),
});

/** An exponential gap (s) with mean `1 / rate`. */
const eventGap = (rand: () => number, rate: number) => -Math.log(1 - rand()) / rate;

/**
 * Returns the time (s) of the next event due at or before `t` (s, float64,
 * non-decreasing between calls), advancing the schedule past it, or NaN when
 * none is due. Call it in a loop until NaN. `rate` is events per second; at 0
 * nothing is scheduled. The first call starts the process at `t`. A backlog
 * older than `SCHEDULE_MAX_LAG` (after a stall) is dropped. Deterministic for
 * the seed and the sequence of calls.
 */
export function takeEvent(s: EventSchedule, t: number, rate: number): number {
  if (!(rate > 0)) {
    s.rate = 0;
    s.next = Number.POSITIVE_INFINITY;
    return Number.NaN;
  }
  if (rate !== s.rate) {
    s.rate = rate;
    s.next = t + eventGap(s.rand, rate);
  }
  if (t - s.next > SCHEDULE_MAX_LAG) {
    s.next = t + eventGap(s.rand, rate);
  }
  if (t < s.next) {
    return Number.NaN;
  }
  const at = s.next;
  s.next = at + eventGap(s.rand, rate);
  return at;
}

// ---------------------------------------------------------------------------
// Sky layout
// ---------------------------------------------------------------------------

/** The (still) sky's pole sits this high (reference px), horizontally centred. Only the star layout uses it. */
const POLE_Y = 600;
/** Share of star cells occupied: a sparse field. */
export const STAR_DENSITY = 0.28;

/** Pole for a frame `refWidth` wide. */
export function skyPole(refWidth: number, out: [number, number]): [number, number] {
  out[0] = Math.max(1, refWidth) / 2;
  out[1] = POLE_Y;
  return out;
}

/**
 * The Milky Way: a faint diagonal band through the upper right, relative to the
 * pole, so it is the same at every width and its GLSL is built once.
 */
export const BAND: MilkyWayBand = bandThrough([0, POLE_Y], 470, 720, 1.1, 170);

/** Radiant position (reference px) for a frame `refWidth` wide. */
function radiantPoint(id: string, refWidth: number, out: [number, number]): [number, number] {
  const w = Math.max(1, refWidth);
  if (id === "topRight") {
    out[0] = 0.86 * w;
    out[1] = 0.86 * REF_HEIGHT;
  } else if (id === "offFrame") {
    out[0] = 0.36 * w;
    out[1] = 1.6 * REF_HEIGHT;
  } else {
    out[0] = 0.14 * w;
    out[1] = 0.86 * REF_HEIGHT;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Meteors
// ---------------------------------------------------------------------------

/** Most meteors (with their trails) alive at once; a new one is dropped while full. */
export const MAX_ACTIVE = 8;
/** Direction jitter about the line from the radiant, ± radians. */
export const DIRECTION_JITTER = 3 * DEG;
/** Starts no nearer the radiant than this, reference px (meteors there are foreshortened to dots). */
const RADIANT_CLEARANCE = 70;
/** Faint and bright meteors: base length (reference px), flight time (s) and peak brightness. */
const FAINT_LENGTH = [130, 280] as const;
const BRIGHT_LENGTH = [260, 460] as const;
const FAINT_DURATION = [0.2, 0.55] as const;
const BRIGHT_DURATION = [0.55, 1] as const;
const FAINT_PEAK = [0.35, 0.7] as const;
const BRIGHT_PEAK = 1;
/** Bright meteors' trails glow on for this long after the flight, s. */
const TRAIL_LIFE = [2, 4] as const;
/** Shortest path worth drawing, reference px; shorter (after clipping) is redrawn. */
const MIN_LENGTH = 50;
/** Tries at a valid path before an event is skipped. */
const SPAWN_TRIES = 8;
/** Keep meteor paths this far (reference px) above the ground's top. */
export const FLOOR_MARGIN = 24;
/** The visible streak behind the head, as a share of the path length (once grown). */
const STREAK_SHARE = 0.45;
/** Where (share of the flight) the streak reaches its full length. */
const STREAK_GROW = 0.35;
/** Bright meteors flare over the last part of the flight, from this share on. */
const FLARE_FROM = 0.78;
/** Peak glow of a trail, as a share of its meteor's peak. */
export const TRAIL_PEAK = 0.35;

/**
 * Central exclusion zone, where the speaker sits: an ellipse centred at
 * (0.5 w, `EXCLUDE_Y` H) with radii `EXCLUDE_RX` w and `EXCLUDE_RY` H, scaled per
 * meteor by `EXCLUDE_SOFT`, so its edge is soft.
 */
export const EXCLUDE_Y = 0.4;
export const EXCLUDE_RX = 0.2;
export const EXCLUDE_RY = 0.44;
export const EXCLUDE_SOFT = [0.85, 1.1] as const;

const WHITE = [0.95, 0.97, 1] as const;
const GREEN = [0.62, 1, 0.7] as const;
const ORANGE = [1, 0.74, 0.5] as const;

interface Meteor {
  /** Start time, s. */
  start: number;
  /** Flight time, s. */
  duration: number;
  /** Trail glow time after the flight, s (0 for faint meteors). */
  trailLife: number;
  /** Start point (reference px) and unit direction. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Path length, reference px. */
  length: number;
  /** Peak brightness. */
  peak: number;
  /** Whether it flares and leaves a trail. */
  bright: boolean;
  /** Colour, 0..1. */
  r: number;
  g: number;
  b: number;
}

const createMeteor = (): Meteor => ({
  start: 0,
  duration: 1,
  trailLife: 0,
  x: 0,
  y: 0,
  dx: 0,
  dy: -1,
  length: 0,
  peak: 0,
  bright: false,
  r: 1,
  g: 1,
  b: 1,
});

/** Where meteors may go in the current frame. Rebuild with `setSkyFrame` when an input changes. */
interface SkyFrame {
  refWidth: number;
  /** Radiant, reference px. */
  radiantX: number;
  radiantY: number;
  /** Lowest height (reference px) a path may reach: the ground's top plus a margin, or 0. */
  floor: number;
}

export const createSkyFrame = (): SkyFrame => ({
  refWidth: 1920,
  radiantX: 0,
  radiantY: 0,
  floor: 0,
});

const radiantScratch: [number, number] = [0, 0];

export function setSkyFrame(
  f: SkyFrame,
  refWidth: number,
  radiant: string,
  groundTop: number,
): SkyFrame {
  f.refWidth = Math.max(1, refWidth);
  radiantPoint(radiant, f.refWidth, radiantScratch);
  f.radiantX = radiantScratch[0];
  f.radiantY = radiantScratch[1];
  f.floor = groundTop > 0 ? groundTop + FLOOR_MARGIN : 0;
  return f;
}

/**
 * Distance (reference px) along the ray from (x, y) in unit direction (dx, dy)
 * to where it enters the ellipse centred (cx, cy) with radii (rx, ry): 0 if
 * (x, y) is inside, Infinity if the ray misses it.
 */
export function ellipseEntry(
  x: number,
  y: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): number {
  const px = (x - cx) / rx;
  const py = (y - cy) / ry;
  const qx = dx / rx;
  const qy = dy / ry;
  const c = px * px + py * py - 1;
  if (c <= 0) {
    return 0;
  }
  const a = qx * qx + qy * qy;
  const b = 2 * (px * qx + py * qy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) {
    return Number.POSITIVE_INFINITY;
  }
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 ? t : Number.POSITIVE_INFINITY;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Fills `m` with a new meteor starting at time `at` for frame `f`, drawing from
 * `rand`: a start point anywhere in the sky clear of the central zone, heading
 * away from the radiant (± `DIRECTION_JITTER`), longer further from the
 * radiant, and cut short before the central zone or the floor. Bright with
 * probability `brightShare`. Returns false (leaving `m` unspecified) if no
 * valid path turned up in a few tries.
 */
export function spawnMeteor(
  m: Meteor,
  at: number,
  f: SkyFrame,
  brightShare: number,
  rand: () => number,
): boolean {
  const w = f.refWidth;
  const bright = rand() < clamp(brightShare, 0, 1);
  const yLo = Math.max(f.floor + 40, 0.12 * REF_HEIGHT);
  const yHi = 0.97 * REF_HEIGHT;
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const x = w * (0.02 + 0.96 * rand());
    const y = lerp(yLo, yHi, rand());
    const soft = lerp(EXCLUDE_SOFT[0], EXCLUDE_SOFT[1], rand());
    const jitter = (rand() * 2 - 1) * DIRECTION_JITTER;
    const base = bright
      ? lerp(BRIGHT_LENGTH[0], BRIGHT_LENGTH[1], rand())
      : lerp(FAINT_LENGTH[0], FAINT_LENGTH[1], rand());
    const rx0 = x - f.radiantX;
    const ry0 = y - f.radiantY;
    const dist = Math.hypot(rx0, ry0);
    if (dist < RADIANT_CLEARANCE) {
      continue;
    }
    const c = Math.cos(jitter);
    const s = Math.sin(jitter);
    const ux = rx0 / dist;
    const uy = ry0 / dist;
    const dx = c * ux - s * uy;
    const dy = s * ux + c * uy;
    let length = base * clamp(0.35 + dist / 700, 0.35, 1.3);
    const cut = ellipseEntry(
      x,
      y,
      dx,
      dy,
      0.5 * w,
      EXCLUDE_Y * REF_HEIGHT,
      EXCLUDE_RX * w * soft,
      EXCLUDE_RY * REF_HEIGHT * soft,
    );
    if (cut === 0) {
      continue;
    }
    length = Math.min(length, cut - 10);
    if (dy < 0) {
      length = Math.min(length, (y - f.floor) / -dy);
    }
    if (length < MIN_LENGTH) {
      continue;
    }
    m.start = at;
    m.x = x;
    m.y = y;
    m.dx = dx;
    m.dy = dy;
    m.length = length;
    m.bright = bright;
    if (bright) {
      m.duration = lerp(BRIGHT_DURATION[0], BRIGHT_DURATION[1], rand());
      m.peak = BRIGHT_PEAK;
      m.trailLife = lerp(TRAIL_LIFE[0], TRAIL_LIFE[1], rand());
    } else {
      m.duration = lerp(FAINT_DURATION[0], FAINT_DURATION[1], rand());
      m.peak = lerp(FAINT_PEAK[0], FAINT_PEAK[1], rand());
      m.trailLife = 0;
    }
    // White, a little green (more often for bright ones) or a little orange.
    const toGreen = rand() < (bright ? 0.6 : 0.35);
    const tint = rand() * (bright ? 0.7 : 0.5);
    const to = toGreen ? GREEN : ORANGE;
    m.r = lerp(WHITE[0], to[0], tint);
    m.g = lerp(WHITE[1], to[1], tint);
    m.b = lerp(WHITE[2], to[2], tint);
    return true;
  }
  return false;
}

/** A meteor's whole life, s: its flight plus its trail. */
export const meteorLife = (m: Meteor) => m.duration + m.trailLife;

/**
 * Core brightness envelope at `u`, the share of the flight (0..1): a quick
 * rise and a fade to nothing at the end, plus a flare over the last part for a
 * bright meteor. 0 at and outside both ends, never above 1.
 */
export function coreEnvelope(u: number, bright: boolean): number {
  if (!(u > 0 && u < 1)) {
    return 0;
  }
  const base = smoothstep(0, 0.12, u) * (1 - smoothstep(0.65, 1, u));
  if (!bright) {
    return base;
  }
  const f = u > FLARE_FROM ? Math.sin((Math.PI * (u - FLARE_FROM)) / (1 - FLARE_FROM)) : 0;
  return Math.min(1, 0.7 * base + 0.95 * f * f);
}

/**
 * Trail glow at age `age` (s) of a meteor that flies for `duration` and whose
 * trail lasts `trailLife` after that: it builds up behind the head during the
 * flight, then fades out (quadratically) to nothing. 0 at and outside both ends,
 * never above 1; always 0 without a trail.
 */
export function trailEnvelope(age: number, duration: number, trailLife: number): number {
  if (!(trailLife > 0) || !(age > 0) || age >= duration + trailLife) {
    return 0;
  }
  if (age < duration) {
    return smoothstep(0, 1, age / duration);
  }
  const s = (age - duration) / trailLife;
  return (1 - s) * (1 - s);
}

/** A meteor's pose at one time. Positions are reference px. */
interface MeteorPose {
  headX: number;
  headY: number;
  /** End of the visible streak behind the head. */
  tailX: number;
  tailY: number;
  /** Core brightness (peak times `coreEnvelope`); 0 when the streak isn't visible. */
  core: number;
  /** Trail: from the start point to `trailEnd`. */
  trailEndX: number;
  trailEndY: number;
  /** Trail brightness (`TRAIL_PEAK` x peak x `trailEnvelope`); 0 with no trail. */
  trail: number;
  /** How far the trail has spread, 0 at the end of the flight to 1 when it is gone. */
  spread: number;
}

export const createMeteorPose = (): MeteorPose => ({
  headX: 0,
  headY: 0,
  tailX: 0,
  tailY: 0,
  core: 0,
  trailEndX: 0,
  trailEndY: 0,
  trail: 0,
  spread: 0,
});

/** Distance of the head along the path at flight share `u` (0..1): slowing slightly. */
const headDistance = (length: number, u: number) => {
  const v = clamp(u, 0, 1);
  return length * v * (1.15 - 0.15 * v);
};

/**
 * Meteor `m` at time `t` (s): a pure function of its age. The head runs along
 * the path; the streak grows from a point behind it to `STREAK_SHARE` of the
 * length; the core brightness follows `coreEnvelope`; a bright meteor's trail
 * covers the path flown so far and glows per `trailEnvelope`.
 */
export function meteorAt(m: Meteor, t: number, out: MeteorPose): MeteorPose {
  const age = t - m.start;
  const u = age / m.duration;
  const head = headDistance(m.length, u);
  const streak = STREAK_SHARE * m.length * Math.min(1, Math.max(0, u) / STREAK_GROW);
  const tail = Math.max(0, head - streak);
  out.headX = m.x + m.dx * head;
  out.headY = m.y + m.dy * head;
  out.tailX = m.x + m.dx * tail;
  out.tailY = m.y + m.dy * tail;
  out.core = m.peak * coreEnvelope(u, m.bright);
  out.trailEndX = out.headX;
  out.trailEndY = out.headY;
  out.trail = TRAIL_PEAK * m.peak * trailEnvelope(age, m.duration, m.trailLife);
  out.spread = m.trailLife > 0 ? clamp((age - m.duration) / m.trailLife, 0, 1) : 0;
  return out;
}

/** The live meteors (the first `count` of `list`), the schedule and the spawn RNG. */
interface MeteorShower {
  list: Meteor[];
  count: number;
  schedule: EventSchedule;
  rand: () => number;
  /** Meteors started so far. */
  started: number;
  /** Events dropped because the list was full or no path fitted. */
  dropped: number;
}

export function createShower(seed: number): MeteorShower {
  const list: Meteor[] = [];
  for (let i = 0; i < MAX_ACTIVE; i++) {
    list.push(createMeteor());
  }
  return {
    list,
    count: 0,
    schedule: createEventSchedule(seed),
    rand: createRng(Math.floor(seed) * 613 + 101),
    started: 0,
    dropped: 0,
  };
}

/**
 * Advances the shower to time `t` (s, float64): drops meteors whose trail has
 * faded, then starts every meteor due at `ratePerMin`. Allocates nothing.
 */
export function stepShower(
  s: MeteorShower,
  t: number,
  ratePerMin: number,
  brightShare: number,
  f: SkyFrame,
): void {
  for (let i = 0; i < s.count; i++) {
    const m = s.list[i];
    if (t - m.start < meteorLife(m)) {
      continue;
    }
    const last = --s.count;
    s.list[i] = s.list[last];
    s.list[last] = m;
    i--;
  }
  const rate = Math.max(0, ratePerMin) / 60;
  for (let at = takeEvent(s.schedule, t, rate); !Number.isNaN(at);) {
    if (s.count < MAX_ACTIVE && spawnMeteor(s.list[s.count], at, f, brightShare, s.rand)) {
      s.count++;
      s.started++;
    } else {
      s.dropped++;
    }
    at = takeEvent(s.schedule, t, rate);
  }
}

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/** Columns of the hill table across the frame width. */
export const HILL_COLUMNS = 1024;
/** Floats per column: near and far hill heights, height units. */
export const HILL_CHANNELS = 2;
/** Near hill: trough height and the noise and side-rise amplitudes, height units. */
const NEAR_BASE = 0.06;
const NEAR_AMP = 0.05;
const NEAR_RISE = 0.07;
/** Far hill: base and amplitude, height units. */
const FAR_BASE = 0.115;
const FAR_AMP = 0.06;
/** Highest a hill can reach, height units. */
export const HILL_TOP = Math.max(NEAR_BASE + NEAR_AMP + NEAR_RISE, FAR_BASE + FAR_AMP);

/** The hillside rises toward the left (-1) or the right (1) for this seed. */
const hillSide = (seed: number) => (createRng(Math.floor(seed) * 31 + 5)() < 0.5 ? -1 : 1);

/**
 * Fills `out` (`HILL_COLUMNS * HILL_CHANNELS`) with the near and far hill heights
 * (height units) at x = column / (HILL_COLUMNS - 1) of the width: rolling fBm,
 * with the near hill rising toward one side. Features are sized in height units,
 * so wider frames show more hill, not wider hills. Deterministic for a seed and width.
 */
export function fillHillTable(out: Float32Array, seed: number, refWidth: number): void {
  const aspect = Math.max(1, refWidth) / REF_HEIGHT;
  const noise = createNoise(Math.floor(seed) * 4099 + 211);
  const side = hillSide(seed);
  const last = HILL_COLUMNS - 1;
  const fbm = (x: number, row: number) =>
    (noise.noise2(x, row) * 0.6 +
      noise.noise2(x * 2.1, row + 7) * 0.28 +
      noise.noise2(x * 4.3, row + 13) * 0.12) *
      0.5 +
    0.5;
  for (let c = 0; c < HILL_COLUMNS; c++) {
    const u = c / last;
    const x = u * aspect;
    const sideU = side < 0 ? 1 - u : u;
    const rise = smoothstep(0.45, 1, sideU);
    out[c * HILL_CHANNELS] = NEAR_BASE + NEAR_AMP * fbm(x * 1.3, 0.5) + NEAR_RISE * rise;
    out[c * HILL_CHANNELS + 1] = FAR_BASE + FAR_AMP * fbm(x * 0.8 + 3.7, 21.5);
  }
}

/** Hill `layer`'s height (height units) at `u` (0..1 of the width), interpolated as the GPU does. */
export function hillHeightAt(table: Float32Array, layer: number, u: number): number {
  const f = clamp(u, 0, 1) * (HILL_COLUMNS - 1);
  const c = Math.min(Math.floor(f), HILL_COLUMNS - 2);
  const t = f - c;
  const a = table[c * HILL_CHANNELS + layer];
  const b = table[(c + 1) * HILL_CHANNELS + layer];
  return a + (b - a) * t;
}

/** Most trees, and floats per tree: x, base y, height (reference px). */
export const MAX_TREES = 8;
export const TREE_FLOATS = 3;
/** Tree height range, reference px. */
const TREE_HEIGHT = [55, 125] as const;
/** Tent half-width and height, reference px; how far its base sits below the crest. */
export const TENT_HALF_W = 58;
export const TENT_H = 74;
const TENT_SINK = 10;
const TREE_SINK = 4;

/** The ground's extras: trees and a tent, placed on the near hill. */
interface GroundLayout {
  trees: Float32Array;
  treeCount: number;
  tent: boolean;
  /** Tent centre x and base y, reference px. */
  tentX: number;
  tentY: number;
  /** Highest point of the ground (hills, trees, tent), reference px; 0 with no ground. */
  top: number;
}

export const createGroundLayout = (): GroundLayout => ({
  trees: new Float32Array(MAX_TREES * TREE_FLOATS),
  treeCount: 0,
  tent: false,
  tentX: 0,
  tentY: 0,
  top: 0,
});

/**
 * Places the trees (a small stand toward the hill's high side and a couple on the
 * other side, all in the outer thirds) or the tent (on the high side's slope)
 * for `ground`, and finds the ground's top. Deterministic for a seed and width.
 */
export function layoutGround(
  out: GroundLayout,
  table: Float32Array,
  ground: string,
  seed: number,
  refWidth: number,
): GroundLayout {
  const w = Math.max(1, refWidth);
  out.treeCount = 0;
  out.tent = false;
  if (ground === "none") {
    out.top = 0;
    return out;
  }
  let top = 0;
  for (let c = 0; c < HILL_COLUMNS * HILL_CHANNELS; c++) {
    top = Math.max(top, table[c]);
  }
  top *= REF_HEIGHT;
  const side = hillSide(seed);
  const rand = createRng(Math.floor(seed) * 977 + 3);
  const edge = (u: number) => (side < 0 ? u : 1 - u);
  if (ground === "trees") {
    const stand = 4 + Math.floor(rand() * 3);
    const other = 2;
    for (let i = 0; i < stand + other && out.treeCount < MAX_TREES; i++) {
      const far = i >= stand;
      // The stand clusters 0.05..0.27 of the width in from its edge; the others 0.04..0.2 from the opposite edge.
      const u = far ? 1 - edge(0.04 + 0.16 * rand()) : edge(0.05 + 0.22 * rand());
      const h = lerp(TREE_HEIGHT[0], TREE_HEIGHT[1], rand()) * (far ? 0.75 : 1);
      const o = out.treeCount++ * TREE_FLOATS;
      out.trees[o] = u * w;
      out.trees[o + 1] = hillHeightAt(table, 0, u) * REF_HEIGHT - TREE_SINK;
      out.trees[o + 2] = h;
      top = Math.max(top, out.trees[o + 1] + h);
    }
  } else if (ground === "tent") {
    const u = edge(0.17 + 0.06 * rand());
    out.tent = true;
    out.tentX = u * w;
    out.tentY = hillHeightAt(table, 0, u) * REF_HEIGHT - TENT_SINK;
    top = Math.max(top, out.tentY + TENT_H);
  }
  out.top = top;
  return out;
}
