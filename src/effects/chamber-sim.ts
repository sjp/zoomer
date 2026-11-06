/**
 * Pure JS side of Cloud Chamber (chamber.ts): the seeded event schedule (a
 * local copy of Meteor Shower's), the particle mix, each track's polyline built
 * at spawn (straight alphas and muons, scattering or spiralling electrons), and
 * each track's look as a pure function of its age. Nothing here touches GL.
 *
 * Coordinates: reference px of a 1080-tall frame, origin bottom-left, y up
 * (as `gl_FragCoord / scale`).
 */
import { clamp, smoothstep } from "./math";
import { createRng } from "./noise";
import type { MixId } from "./chamber.meta";
import { lookup } from "./lookup";

export const REF_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Event schedule (a local copy of the one in meteors-sim.ts)
// ---------------------------------------------------------------------------

/** Events further than this (s) in the past are dropped rather than released at once. */
export const SCHEDULE_MAX_LAG = 2;

/**
 * A seeded Poisson process: exponential gaps at the current rate. Changing the
 * rate redraws the pending gap from "now", which is exact for a Poisson
 * process (it has no memory), so a slider never leaves a long wait behind.
 */
export interface EventSchedule {
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
export const eventGap = (rand: () => number, rate: number) => -Math.log(1 - rand()) / rate;

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
  if (t - s.next > SCHEDULE_MAX_LAG) s.next = t + eventGap(s.rand, rate);
  if (t < s.next) return Number.NaN;
  const at = s.next;
  s.next = at + eventGap(s.rand, rate);
  return at;
}

// ---------------------------------------------------------------------------
// Particle mix
// ---------------------------------------------------------------------------

export const ALPHA = 0;
export const ELECTRON = 1;
export const MUON = 2;
export type TrackKind = typeof ALPHA | typeof ELECTRON | typeof MUON;

/** Share of alphas, electrons and muons for each mix; each row sums to 1. */
export const MIX_WEIGHTS: Record<MixId, readonly [number, number, number]> = {
  natural: [0.3, 0.45, 0.25],
  alpha: [0.6, 0.25, 0.15],
  muon: [0.15, 0.35, 0.5],
};

/** The kind for a uniform draw `r` (0..1) under `mix` (unknown ids count as natural). */
export function pickKind(mix: string, r: number): TrackKind {
  const w = lookup(MIX_WEIGHTS, mix, "natural");
  if (r < w[0]) return ALPHA;
  if (r < w[0] + w[1]) return ELECTRON;
  return MUON;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** Most tracks alive at once; an event is dropped while full. */
export const MAX_TRACKS = 40;
/** Most polyline points per track. */
export const MAX_POINTS = 128;
/** Tracks keep this far (reference px) inside the frame. */
export const FRAME_MARGIN = 10;
/** Shortest track worth drawing, reference px; shorter ones are redrawn. */
export const MIN_LENGTH = 40;
/** Tries at a valid track before an event is skipped. */
const SPAWN_TRIES = 12;

/**
 * The central band, where the speaker sits: anchors within `CENTRE_HALF` of the
 * width from the centre line are kept with probability `CENTRE_KEEP` (otherwise
 * redrawn), so the band sees fewer tracks while the overall rate holds.
 */
export const CENTRE_HALF = 0.17;
export const CENTRE_KEEP = 0.35;

/** Alpha tracks: length (5–10% of a 16:9 frame's diagonal), reference px. */
export const ALPHA_LENGTH = [110, 220] as const;
/** Muon tracks span at least this much (reference px), and arc this gently (radius) in the field. */
export const MUON_MIN = 0.55 * REF_HEIGHT;
export const MUON_RADIUS = [1600, 3200] as const;
const MUON_STEPS = 16;
/** Scattering electrons: path length, step (reference px), and the heading kick's sd (radians) at the start and the end. */
export const ELECTRON_LENGTH = [200, 520] as const;
export const ELECTRON_STEP = 9;
const SCATTER = [0.12, 0.6] as const;
/** Spiralling electrons: starting radius and path length as a multiple of it, smallest radius, reference px. */
export const SPIRAL_RADIUS = [40, 180] as const;
export const SPIRAL_LENGTH = [3, 5] as const;
export const SPIRAL_MIN_RADIUS = 5;
/** Spiral steps turn by about this much (radians), within these lengths (reference px). */
const SPIRAL_TURN = 0.3;
const SPIRAL_STEP = [1.2, 14] as const;

/** Time (s) a track takes to appear along its path, and its whole life, by kind. */
export const GROW = [
  [0.12, 0.25],
  [0.2, 0.45],
  [0.15, 0.3],
] as const;
export const LIFE = [
  [2.5, 4.5],
  [2, 4],
  [2, 3.5],
] as const;
/** Peak brightness and core half width (reference px), by kind. */
export const PEAK = [1, 0.62, 0.42] as const;
export const HALF_WIDTH = [2.6, 0.9, 0.7] as const;
/** By the end of its life a trail is this many times wider. */
export const WIDEN = 3;
/** Mist and trails drift together, reference px per s. */
export const DRIFT_X = 5;
export const DRIFT_Y = -2.5;

export interface Track {
  kind: TrackKind;
  /** Start time, s. */
  start: number;
  /** Time to appear along the path, s. */
  grow: number;
  /** Whole life, s (it has faded to nothing by then). */
  life: number;
  /** Peak brightness and core half width at birth (reference px). */
  peak: number;
  halfWidth: number;
  /** Whether it spirals (electrons in the field). */
  spiral: boolean;
  /** Points (x, y pairs, reference px); the first `count` are used. */
  pts: Float32Array;
  /** Path length (reference px) from the first point to each point. */
  dist: Float32Array;
  count: number;
  /** Total path length, reference px. */
  length: number;
}

const createTrack = (): Track => ({
  kind: ALPHA,
  start: 0,
  grow: 0.2,
  life: 3,
  peak: 0,
  halfWidth: 1,
  spiral: false,
  pts: new Float32Array(MAX_POINTS * 2),
  dist: new Float32Array(MAX_POINTS),
  count: 0,
  length: 0,
});

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** A roughly normal draw with sd 1 (sum of three uniforms). */
const gauss = (rand: () => number) => (rand() + rand() + rand() - 1.5) * 2;

/** Whether (x, y) is inside the frame `w` wide, less the margin. */
export const inFrame = (x: number, y: number, w: number) =>
  x >= FRAME_MARGIN && x <= w - FRAME_MARGIN && y >= FRAME_MARGIN && y <= REF_HEIGHT - FRAME_MARGIN;

function resetPath(tr: Track, x: number, y: number) {
  tr.pts[0] = x;
  tr.pts[1] = y;
  tr.dist[0] = 0;
  tr.count = 1;
  tr.length = 0;
}

function pushPoint(tr: Track, x: number, y: number) {
  const i = tr.count;
  const px = tr.pts[2 * i - 2];
  const py = tr.pts[2 * i - 1];
  tr.length += Math.hypot(x - px, y - py);
  tr.pts[2 * i] = x;
  tr.pts[2 * i + 1] = y;
  tr.dist[i] = tr.length;
  tr.count = i + 1;
}

/**
 * Distance along the line from (x, y) in unit direction (dx, dy) to the edge of
 * the frame less its margin, from inside it.
 */
function toEdge(x: number, y: number, dx: number, dy: number, w: number): number {
  let t = Number.POSITIVE_INFINITY;
  const lo = FRAME_MARGIN;
  if (dx > 1e-9) t = Math.min(t, (w - lo - x) / dx);
  else if (dx < -1e-9) t = Math.min(t, (lo - x) / dx);
  if (dy > 1e-9) t = Math.min(t, (REF_HEIGHT - lo - y) / dy);
  else if (dy < -1e-9) t = Math.min(t, (lo - y) / dy);
  return Math.max(0, t);
}

/** How `walk` steps and turns. */
const ARC = 0;
const SPIRAL = 1;
const SCATTERING = 2;
type WalkMode = typeof ARC | typeof SPIRAL | typeof SCATTERING;

/**
 * Walks a path from (x, y) at `heading` for up to `length`, stopping at the
 * frame's edge or the point limit. `ARC`: steps of `a`, curvature `b` (a
 * circle, or a line at 0). `SPIRAL`: starting radius `a`, shrinking over a
 * length `b` (see `spiralRadius`), turning toward `sign`. `SCATTERING`: steps
 * of `ELECTRON_STEP` with random kicks growing toward the end.
 */
function walk(
  tr: Track,
  mode: WalkMode,
  x: number,
  y: number,
  heading: number,
  length: number,
  w: number,
  a: number,
  b: number,
  sign: number,
  rand: () => number,
) {
  resetPath(tr, x, y);
  let s = 0;
  let h = heading;
  while (s < length && tr.count < MAX_POINTS) {
    let ds: number;
    if (mode === ARC) {
      ds = Math.min(a, length - s);
      h += b * ds;
    } else if (mode === SPIRAL) {
      const step = clamp(SPIRAL_TURN * spiralRadius(a, b, s), SPIRAL_STEP[0], SPIRAL_STEP[1]);
      ds = Math.min(step, length - s);
      // Turn by the curvature at the step's midpoint.
      h += (sign * ds) / spiralRadius(a, b, s + ds / 2);
    } else {
      ds = Math.min(ELECTRON_STEP, length - s);
      // Multiple scattering: small random kicks, growing as the electron slows.
      h += gauss(rand) * lerp(SCATTER[0], SCATTER[1], (s / length) ** 2);
    }
    // A sliver left at the end isn't worth a point (and could round to nothing in float32).
    if (!(ds > 0.05)) break;
    const nx = x + Math.cos(h) * ds;
    const ny = y + Math.sin(h) * ds;
    if (!inFrame(nx, ny, w)) break;
    pushPoint(tr, nx, ny);
    x = nx;
    y = ny;
    s += ds;
  }
}

/** A spiral's radius of curvature (reference px) at distance `s` along it: shrinking as it loses energy. */
export const spiralRadius = (r0: number, length: number, s: number) =>
  Math.max(SPIRAL_MIN_RADIUS, r0 * (1 - s / length));

/**
 * Fills `tr` with a new track of `kind` starting at time `at` in a frame
 * `refWidth` wide, drawing from `rand`. Its anchor (an alpha's or muon's
 * midpoint, an electron's start) avoids the central band (see `CENTRE_KEEP`).
 * Electrons spiral when `magnetic` is on; muons arc gently; alphas stay
 * straight. Returns false (leaving `tr` unspecified) if no valid track turned up
 * in a few tries.
 */
export function spawnTrack(
  tr: Track,
  kind: TrackKind,
  at: number,
  refWidth: number,
  magnetic: boolean,
  rand: () => number,
): boolean {
  const w = Math.max(4 * FRAME_MARGIN, refWidth);
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const ax = lerp(FRAME_MARGIN, w - FRAME_MARGIN, rand());
    const ay = lerp(FRAME_MARGIN, REF_HEIGHT - FRAME_MARGIN, rand());
    const keep = rand();
    if (Math.abs(ax / w - 0.5) < CENTRE_HALF && keep >= CENTRE_KEEP) continue;
    const heading = rand() * 2 * Math.PI;
    const dx = Math.cos(heading);
    const dy = Math.sin(heading);
    if (kind === ALPHA) {
      const half = lerp(ALPHA_LENGTH[0], ALPHA_LENGTH[1], rand()) / 2;
      const x0 = ax - dx * half;
      const y0 = ay - dy * half;
      const x1 = ax + dx * half;
      const y1 = ay + dy * half;
      if (!inFrame(x0, y0, w) || !inFrame(x1, y1, w)) continue;
      resetPath(tr, x0, y0);
      pushPoint(tr, x1, y1);
      tr.spiral = false;
    } else if (kind === MUON) {
      // The whole chord through the anchor, then (in the field) a gentle arc from its start.
      const back = toEdge(ax, ay, -dx, -dy, w);
      const fwd = toEdge(ax, ay, dx, dy, w);
      const chord = back + fwd;
      if (chord < MUON_MIN) continue;
      const x0 = ax - dx * back;
      const y0 = ay - dy * back;
      if (magnetic) {
        const k = (rand() < 0.5 ? -1 : 1) / lerp(MUON_RADIUS[0], MUON_RADIUS[1], rand());
        walk(tr, ARC, x0, y0, heading, chord, w, chord / MUON_STEPS, k, 1, rand);
      } else {
        resetPath(tr, x0, y0);
        pushPoint(tr, ax + dx * fwd, ay + dy * fwd);
      }
      tr.spiral = false;
    } else if (magnetic) {
      const r0 = lerp(SPIRAL_RADIUS[0], SPIRAL_RADIUS[1], rand());
      const length = r0 * lerp(SPIRAL_LENGTH[0], SPIRAL_LENGTH[1], rand());
      const sign = rand() < 0.5 ? -1 : 1;
      // Ends where the radius reaches its minimum.
      const end = length * (1 - SPIRAL_MIN_RADIUS / r0);
      walk(tr, SPIRAL, ax, ay, heading, end, w, r0, length, sign, rand);
      tr.spiral = true;
    } else {
      const length = lerp(ELECTRON_LENGTH[0], ELECTRON_LENGTH[1], rand());
      walk(tr, SCATTERING, ax, ay, heading, length, w, 0, 0, 1, rand);
      tr.spiral = false;
    }
    if (tr.length < MIN_LENGTH) continue;
    tr.kind = kind;
    tr.start = at;
    tr.grow = lerp(GROW[kind][0], GROW[kind][1], rand());
    tr.life = lerp(LIFE[kind][0], LIFE[kind][1], rand());
    tr.peak = PEAK[kind] * lerp(0.8, 1, rand());
    tr.halfWidth = HALF_WIDTH[kind] * lerp(0.85, 1.15, rand());
    return true;
  }
  return false;
}

/**
 * Brightness envelope at `age` (s) of a track that appears over `grow` and has
 * faded by `life`: a quick rise while it appears, then a quadratic fade as it
 * diffuses. 0 at and outside both ends, never above 1.
 */
export function trackEnvelope(age: number, grow: number, life: number): number {
  if (!(age > 0) || !(age < life)) return 0;
  const s = trackSpread(age, grow, life);
  return smoothstep(0, grow, age) * (1 - s) * (1 - s);
}

/** How far a track has diffused: 0 until it has appeared, 1 at the end of its life. */
export const trackSpread = (age: number, grow: number, life: number) =>
  clamp((age - grow) / Math.max(1e-6, life - grow), 0, 1);

/** A track's look at one time. */
export interface TrackPose {
  /** Path length revealed so far, reference px. */
  reveal: number;
  /** Brightness (peak times `trackEnvelope`). */
  brightness: number;
  /** Diffusion, 0..1 (see `trackSpread`). */
  spread: number;
  /** Core half width, reference px. */
  halfWidth: number;
  /** Drift offset, reference px. */
  dx: number;
  dy: number;
}

export const createTrackPose = (): TrackPose => ({
  reveal: 0,
  brightness: 0,
  spread: 0,
  halfWidth: 0,
  dx: 0,
  dy: 0,
});

/**
 * Track `tr` at time `t` (s): a pure function of its age. It appears along its
 * path over `grow` (fast, then slowing), then widens, fades and drifts.
 */
export function trackAt(tr: Track, t: number, out: TrackPose): TrackPose {
  const age = t - tr.start;
  const u = clamp(age / tr.grow, 0, 1);
  out.reveal = tr.length * (1 - (1 - u) * (1 - u));
  out.brightness = tr.peak * trackEnvelope(age, tr.grow, tr.life);
  out.spread = trackSpread(age, tr.grow, tr.life);
  out.halfWidth = tr.halfWidth * (1 + (WIDEN - 1) * out.spread);
  const a = Math.max(0, age);
  out.dx = DRIFT_X * a;
  out.dy = DRIFT_Y * a;
  return out;
}

/** The live tracks (the first `count` of `list`), the schedule and the spawn RNG. */
export interface Chamber {
  list: Track[];
  count: number;
  schedule: EventSchedule;
  rand: () => number;
  /** Tracks started so far, by kind. */
  started: [number, number, number];
  /** Events dropped because the list was full or no track fitted. */
  dropped: number;
}

export function createChamber(seed: number): Chamber {
  const list: Track[] = [];
  for (let i = 0; i < MAX_TRACKS; i++) list.push(createTrack());
  return {
    list,
    count: 0,
    schedule: createEventSchedule(seed),
    rand: createRng(Math.floor(seed) * 613 + 101),
    started: [0, 0, 0],
    dropped: 0,
  };
}

/**
 * Advances the chamber to time `t` (s, float64): drops tracks that have faded,
 * then starts every track due at `rate` (per s) with the `mix`. Allocates nothing.
 */
export function stepChamber(
  c: Chamber,
  t: number,
  rate: number,
  mix: string,
  magnetic: boolean,
  refWidth: number,
): void {
  for (let i = 0; i < c.count; i++) {
    const tr = c.list[i];
    if (t - tr.start < tr.life) continue;
    const last = --c.count;
    c.list[i] = c.list[last];
    c.list[last] = tr;
    i--;
  }
  for (let at = takeEvent(c.schedule, t, Math.max(0, rate)); !Number.isNaN(at);) {
    const kind = pickKind(mix, c.rand());
    if (c.count < MAX_TRACKS && spawnTrack(c.list[c.count], kind, at, refWidth, magnetic, c.rand)) {
      c.count++;
      c.started[kind]++;
    } else {
      c.dropped++;
    }
    at = takeEvent(c.schedule, t, Math.max(0, rate));
  }
}
