/**
 * Marble run model: the whole loop (sloping tracks, the drops between them, an
 * optional return rail along the base and a screw lift back to the top) as one
 * closed path of segments with arc length, and marbles moving along it at a
 * rate that depends on the segment, keeping a minimum gap. Pure functions and
 * plain state, so the path and spacing can be tested without GL.
 *
 * Units are frame heights, y up, origin at the bottom-left of the frame. The
 * layout is built in "u", the distance from the run's side edge, and mirrored
 * for the right side.
 */
import { wrap } from "../math";

export type MarbleSide = "left" | "right";

/** Marble radius (frame heights). */
export const MARBLE_R = 0.019;
/** Minimum gap between marble centres along the path: a little more than a diameter. */
export const MIN_GAP = 2.4 * MARBLE_R;
/** Rolling speed on the tracks, frame heights per second at speed 1. */
export const ROLL_SPEED = 0.1;
/** Lift speed, frame heights per second at speed 1. */
export const LIFT_SPEED = 0.07;
/** Gravity for the drops (frame heights / s²), slowed for a calm look. */
export const DROP_GRAVITY = 3;

/** Rail half-thickness: a rail is 2 × this tall. */
export const RAIL_HALF = 0.007;
/** Lift screw half-width. */
export const LIFT_HALF = 0.024;
/** End-stop post half-width. */
export const POST_HALF = 0.006;

/** Distances from the side edge (u): frame, lift axis, track ends. */
export const FRAME_U0 = 0.025;
export const FRAME_U1 = 0.615;
export const FRAME_BORDER = 0.018;
export const LIFT_U = 0.072;
export const TRACK_U_OUT = 0.165;
export const TRACK_U_IN = 0.53;
/** Horizontal travel of a drop between tracks. */
export const DROP_DX = 0.024;
/** Base plank: bottom and top (y). */
export const BASE_Y0 = 0.04;
export const BASE_Y1 = 0.075;
/** Where the bottom track (or the return rail) ends: its marble centre height. */
export const BOTTOM_Y = 0.16;
/** Return rail: rise from its end to its start. */
export const RETURN_RISE = 0.012;

export const MIN_LEVELS = 3;
export const MAX_LEVELS = 6;

/** Segment kinds. */
export const SEG_ROLL = 0;
export const SEG_DROP = 1;
export const SEG_LIFT = 2;

/** Landing bounce: two hops over this much track, the second a quarter of the first. */
export const HOP_LEN = 0.05;
export const HOP_HEIGHT = 0.007;

export interface Segment {
  kind: number;
  /** Marble centre at the start and end. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Path coordinate at the start, and length in path units (the chord for drops). */
  s0: number;
  len: number;
  /** Path units per second at speed 1. */
  rate: number;
  /** Spin (radians) per path unit. */
  spin: number;
  /** Spin accumulated over the loop before this segment. */
  spin0: number;
  /** Whether a roll starts with a landing bounce. */
  hop: boolean;
}

/** A wooden piece: a box round the line A–B, `half` thick on each side. */
export interface Board {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  half: number;
  kind: number;
  /** Small per-piece variation, -1..1. */
  tint: number;
}

/** Board kinds, matching the shader. */
export const BOARD_PANEL = 0;
export const BOARD_FRAME = 1;
export const BOARD_RAIL = 2;
export const BOARD_POST = 3;
export const BOARD_LIFT = 4;

export interface Run {
  segments: Segment[];
  /** Total path length. */
  length: number;
  /** Spin accumulated over one lap. */
  loopSpin: number;
  /** Back layer (panel) then front layer (frame, lift, posts, rails). */
  back: Board[];
  front: Board[];
  /** Index in `front` of the lift screw. */
  liftIndex: number;
  /** Tracks drawn, including the return rail when there is one. */
  rails: number;
  hasReturn: boolean;
  /** The run's top (frame) edge and horizontal extent, frame heights. */
  top: number;
  x0: number;
  x1: number;
}

function clampLevels(levels: number): number {
  const n = Math.round(Number.isFinite(levels) ? levels : 5);
  return Math.min(MAX_LEVELS, Math.max(MIN_LEVELS, n));
}

/** Vertical pitch between rails for `levels` tracks (plus the return rail when odd). */
export function trackPitch(levels: number): number {
  const n = clampLevels(levels);
  return Math.min(0.16, 0.58 / (n + (n % 2) - 1));
}

interface Track {
  u0: number;
  y0: number;
  u1: number;
  y1: number;
}

/**
 * Builds the loop for `levels` tracks (3–6) on `side` of a frame `aspect` wide.
 * Track 0 leaves the lift's top and runs inwards; tracks alternate direction,
 * joined by short drops onto the next track's start under the end. An even
 * count ends back at the lift; an odd one drops onto a return rail on the base.
 */
export function buildRun(levels: number, side: MarbleSide, aspect: number): Run {
  const n = clampLevels(levels);
  const pitch = trackPitch(n);
  const dropH = 0.6 * pitch;
  const slope = (0.4 * pitch) / (TRACK_U_IN - TRACK_U_OUT);
  const hasReturn = n % 2 === 1;

  // Tracks top-down from y = 0, shifted afterwards so the last one ends at BOTTOM_Y.
  const tracks: Track[] = [];
  let u = LIFT_U;
  let y = 0;
  for (let k = 0; k < n; k++) {
    const inward = k % 2 === 0;
    const end = inward ? TRACK_U_IN : k === n - 1 ? LIFT_U : TRACK_U_OUT;
    const y1 = y - slope * Math.abs(end - u);
    tracks.push({ u0: u, y0: y, u1: end, y1 });
    u = end + (inward ? DROP_DX : -DROP_DX);
    y = y1 - dropH;
  }
  const lastEnd = tracks[n - 1].y1;
  const shift = BOTTOM_Y - lastEnd;
  for (const t of tracks) {
    t.y0 += shift;
    t.y1 += shift;
  }
  if (hasReturn) {
    // The return rail sits on the base plank and runs gently back to the lift.
    const yEnd = BASE_Y1 + RAIL_HALF * 2 + MARBLE_R;
    tracks.push({ u0: u, y0: yEnd + RETURN_RISE, u1: LIFT_U, y1: yEnd });
  }

  const mirror = side === "right";
  const X = (uu: number) => (mirror ? aspect - uu : uu);

  const segments: Segment[] = [];
  let s = 0;
  const push = (seg: Omit<Segment, "s0" | "spin0">) => {
    segments.push({ ...seg, s0: s, spin0: 0 });
    s += seg.len;
  };
  for (let k = 0; k < tracks.length; k++) {
    const t = tracks[k];
    const x0 = X(t.u0);
    const x1 = X(t.u1);
    const len = Math.hypot(x1 - x0, t.y1 - t.y0);
    const dir = Math.sign(x1 - x0);
    push({
      kind: SEG_ROLL,
      x0,
      y0: t.y0,
      x1,
      y1: t.y1,
      len,
      rate: ROLL_SPEED,
      spin: -dir / MARBLE_R,
      hop: k > 0,
    });
    const next = tracks.at(k + 1);
    if (next) {
      const nx = X(next.u0);
      const h = t.y1 - next.y0;
      const chord = Math.hypot(nx - x1, h);
      const time = Math.sqrt((2 * h) / DROP_GRAVITY);
      const rate = chord / time;
      // Angular velocity carries on through the fall.
      push({
        kind: SEG_DROP,
        x0: x1,
        y0: t.y1,
        x1: nx,
        y1: next.y0,
        len: chord,
        rate,
        spin: (-dir * ROLL_SPEED) / MARBLE_R / rate,
        hop: false,
      });
    }
  }
  const last = tracks[tracks.length - 1];
  const top = tracks[0];
  push({
    kind: SEG_LIFT,
    x0: X(LIFT_U),
    y0: last.y1,
    x1: X(LIFT_U),
    y1: top.y0,
    len: top.y0 - last.y1,
    rate: LIFT_SPEED,
    spin: 0,
    hop: false,
  });
  let spin = 0;
  for (const seg of segments) {
    seg.spin0 = spin;
    spin += seg.spin * seg.len;
  }

  // Wooden pieces.
  const frameTop = top.y0 + 0.07;
  const back: Board[] = [];
  const front: Board[] = [];
  const midY = (BASE_Y0 + frameTop) / 2;
  back.push({
    ax: X(FRAME_U0),
    ay: midY,
    bx: X(FRAME_U1),
    by: midY,
    half: (frameTop - BASE_Y0) / 2,
    kind: BOARD_PANEL,
    tint: 0,
  });
  // Frame: two uprights, a top bar and the base plank.
  const fb = FRAME_BORDER / 2;
  front.push(
    {
      ax: X(FRAME_U0 + fb),
      ay: BASE_Y0,
      bx: X(FRAME_U0 + fb),
      by: frameTop,
      half: fb,
      kind: BOARD_FRAME,
      tint: 0.3,
    },
    {
      ax: X(FRAME_U1 - fb),
      ay: BASE_Y0,
      bx: X(FRAME_U1 - fb),
      by: frameTop,
      half: fb,
      kind: BOARD_FRAME,
      tint: -0.2,
    },
    {
      ax: X(FRAME_U0),
      ay: frameTop - fb,
      bx: X(FRAME_U1),
      by: frameTop - fb,
      half: fb,
      kind: BOARD_FRAME,
      tint: 0.1,
    },
    {
      ax: X(FRAME_U0 - 0.012),
      ay: (BASE_Y0 + BASE_Y1) / 2,
      bx: X(FRAME_U1 + 0.012),
      by: (BASE_Y0 + BASE_Y1) / 2,
      half: (BASE_Y1 - BASE_Y0) / 2,
      kind: BOARD_FRAME,
      tint: -0.4,
    },
  );
  // The lift screw, from the base to just above the top track's start, with a cap.
  const liftIndex = front.length;
  front.push({
    ax: X(LIFT_U),
    ay: BASE_Y1,
    bx: X(LIFT_U),
    by: top.y0 + MARBLE_R + 0.012,
    half: LIFT_HALF,
    kind: BOARD_LIFT,
    tint: 0,
  });
  front.push({
    ax: X(LIFT_U - LIFT_HALF - 0.006),
    ay: top.y0 + MARBLE_R + 0.02,
    bx: X(LIFT_U + LIFT_HALF + 0.006),
    by: top.y0 + MARBLE_R + 0.02,
    half: 0.008,
    kind: BOARD_POST,
    tint: 0.2,
  });
  // End stops beyond each drop's landing point, from the lower rail to above the upper one.
  for (let k = 0; k + 1 < tracks.length; k++) {
    const t = tracks[k];
    const next = tracks[k + 1];
    const dir = Math.sign(t.u1 - t.u0);
    const pu = next.u0 + dir * (MARBLE_R + 0.004 + POST_HALF);
    front.push({
      ax: X(pu),
      ay: next.y0 - MARBLE_R - 2 * RAIL_HALF - 0.012,
      bx: X(pu),
      by: t.y1 + MARBLE_R + 0.03,
      half: POST_HALF,
      kind: BOARD_POST,
      tint: k % 3 === 0 ? -0.3 : 0.1,
    });
  }
  // Rails: under the marble's path by its radius plus the rail's half-thickness.
  for (let k = 0; k < tracks.length; k++) {
    const t = tracks[k];
    const dir = Math.sign(t.u1 - t.u0);
    const len = Math.abs(t.u1 - t.u0);
    const dy = (t.y1 - t.y0) / len;
    // Unit normal pointing up from the slope, in u-space.
    const nl = Math.hypot(1, dy);
    const nu = (-dy * dir) / nl;
    const ny = 1 / nl;
    const off = MARBLE_R + RAIL_HALF;
    const back0 = k === 0 ? 0 : MARBLE_R + 0.006;
    const fwd = k === tracks.length - 1 ? 0 : 0.3 * MARBLE_R;
    const ua = t.u0 - dir * back0;
    const ub = t.u1 + dir * fwd;
    const ya = t.y0 - dy * back0;
    const yb = t.y1 + dy * fwd;
    front.push({
      ax: X(ua - nu * off),
      ay: ya - ny * off,
      bx: X(ub - nu * off),
      by: yb - ny * off,
      half: RAIL_HALF,
      kind: BOARD_RAIL,
      tint: hasReturn && k === tracks.length - 1 ? -0.6 : ((k * 0.37) % 0.6) - 0.3,
    });
  }

  return {
    segments,
    length: s,
    loopSpin: spin,
    back,
    front,
    liftIndex,
    rails: tracks.length,
    hasReturn,
    top: frameTop,
    x0: Math.min(X(FRAME_U0), X(FRAME_U1)),
    x1: Math.max(X(FRAME_U0), X(FRAME_U1)),
  };
}

/** Index of the segment holding path coordinate `s` (wrapped onto the loop). */
export function segmentAt(run: Run, s: number): number {
  const segs = run.segments;
  let i = segs.length - 1;
  while (i > 0 && segs[i].s0 > s) {
    i--;
  }
  return i;
}

/** The landing bounce height `d` path units into a roll. */
export function hopOffset(d: number): number {
  if (d <= 0 || d >= HOP_LEN) {
    return 0;
  }
  const split = HOP_LEN * (2 / 3);
  if (d < split) {
    const t = d / split;
    return HOP_HEIGHT * 4 * t * (1 - t);
  }
  const t = (d - split) / (HOP_LEN - split);
  return HOP_HEIGHT * t * (1 - t);
}

/** Writes the marble centre at path coordinate `s` into out[0], out[1]. */
export function pointAt(run: Run, s: number, out: Float64Array | number[]): void {
  const w = wrap(s, 0, run.length);
  const seg = run.segments[segmentAt(run, w)];
  const d = Math.min(Math.max(w - seg.s0, 0), seg.len);
  const t = seg.len > 0 ? d / seg.len : 0;
  out[0] = seg.x0 + (seg.x1 - seg.x0) * t;
  if (seg.kind === SEG_DROP) {
    // Ballistic: constant horizontal speed, falling from rest vertically.
    out[1] = seg.y0 + (seg.y1 - seg.y0) * t * t;
  } else {
    out[1] = seg.y0 + (seg.y1 - seg.y0) * t + (seg.hop ? hopOffset(d) : 0);
  }
}

/** Spin accumulated from the loop's start to `s` (within one lap). */
export function spinAt(run: Run, s: number): number {
  const w = wrap(s, 0, run.length);
  const seg = run.segments[segmentAt(run, w)];
  return seg.spin0 + seg.spin * (w - seg.s0);
}

/**
 * How far (path units) a free marble at `s` moves in `time` seconds at speed 1,
 * crossing segment boundaries at each one's rate.
 */
export function freeAdvance(run: Run, s: number, time: number): number {
  let w = wrap(s, 0, run.length);
  let i = segmentAt(run, w);
  let left = time;
  let moved = 0;
  const segs = run.segments;
  for (let guard = 0; guard < 4 * segs.length && left > 0; guard++) {
    const seg = segs[i];
    const room = seg.s0 + seg.len - w;
    const need = room / seg.rate;
    if (left < need) {
      moved += left * seg.rate;
      break;
    }
    moved += room;
    left -= need;
    i = (i + 1) % segs.length;
    w = segs[i].s0;
  }
  return moved;
}

export interface Marbles {
  count: number;
  /** Path coordinate in [0, length), in loop order: marble i + 1 is ahead of i. */
  s: Float64Array;
  /** Spin angle, wrapped to [0, 2π). */
  spin: Float64Array;
  /** Scratch: each step's advance. */
  move: Float64Array;
}

export function createMarbles(max: number): Marbles {
  return {
    count: 0,
    s: new Float64Array(max),
    spin: new Float64Array(max),
    move: new Float64Array(max),
  };
}

/**
 * Spreads `count` marbles evenly round the loop (at least `MIN_GAP` apart if
 * they fit; the count is cut to what does), with staggered spins.
 */
export function placeMarbles(run: Run, m: Marbles, count: number): void {
  const fit = Math.floor(run.length / (MIN_GAP * 1.5));
  const n = Math.max(0, Math.min(Math.floor(count), m.s.length, fit));
  m.count = n;
  for (let i = 0; i < n; i++) {
    m.s[i] = (run.length * (i + 0.5)) / n;
    m.spin[i] = wrap(i * 2.399963, 0, Math.PI * 2);
  }
}

/** Distance along the loop from `a` forwards to `b`, in (0, length] (length when equal). */
function ahead(run: Run, a: number, b: number): number {
  const d = wrap(b - a, 0, run.length);
  return d > 0 ? d : run.length;
}

/**
 * Advances every marble by `time` seconds at speed 1. A marble that would come
 * closer than `MIN_GAP` to the one ahead waits behind it instead, so a queue
 * builds where the path slows (the lift's foot) and the order never changes.
 */
export function stepMarbles(run: Run, m: Marbles, time: number): void {
  const n = m.count;
  if (n === 0 || !(time > 0)) {
    return;
  }
  const t = Math.min(time, 0.25);
  const { s, move } = m;
  for (let i = 0; i < n; i++) {
    move[i] = freeAdvance(run, s[i], t);
  }
  if (n > 1) {
    // Two passes backwards round the ring settle every limit (leaders never move back).
    for (let k = 0; k < 2 * n; k++) {
      const i = (((n - 1 - k) % n) + n) % n;
      const j = (i + 1) % n;
      const limit = ahead(run, s[i], s[j]) + move[j] - MIN_GAP;
      if (move[i] > limit) {
        move[i] = Math.max(0, limit);
      }
    }
  }
  const tau = Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const from = s[i];
    const to = from + move[i];
    const lap = to >= run.length;
    const w = wrap(to, 0, run.length);
    const turn = spinAt(run, w) - spinAt(run, from) + (lap ? run.loopSpin : 0);
    s[i] = w;
    m.spin[i] = wrap(m.spin[i] + turn, 0, tau);
  }
}
