/**
 * Loading Screen's clockwork, free of GL so it can be tested: the progress
 * curve (a pure function of time and seed, built from seeded segments that
 * crawl, stall, jump and slip back), the label each segment shows, the order
 * the tips come round in, the key art's slow Ken Burns drift, and the emblem's
 * turn.
 */
import { clamp } from "../math";
import { createRng, hash32 } from "../noise";

/** What a stretch of the progress curve does. */
export const SEGMENT = {
  /** Creeps up, quickly at first and ever more slowly towards the top. */
  crawl: 0,
  /** Sits still. */
  stall: 1,
  /** Lurches forward 10–20 %. */
  jump: 2,
  /** Slips back, with a new label. */
  slip: 3,
  /** Holds just short of 100 % with "Almost there…". */
  almost: 4,
  /** Eases back to 0 for a new phase. */
  reset: 5,
  /** Steady mode: rises evenly. */
  rise: 6,
  /** Steady mode: rests at 100 %. */
  done: 7,
} as const;
type SegmentKind = (typeof SEGMENT)[keyof typeof SEGMENT];

/** Every label the bar shows. The first is the usual one. */
export const LABELS = [
  "Loading…",
  "Almost there…",
  "Ready",
  "Verifying files…",
  "Compiling shaders…",
  "Reticulating grids…",
  "Unpacking textures…",
  "Warming up caches…",
  "Counting polygons…",
  "Rechecking the checksums…",
  "Untangling cables…",
] as const;
const LOADING = 0;
const ALMOST = 1;
const READY = 2;
/** The labels a slip back picks from. */
const FIRST_SLIP_LABEL = 3;

/** The highest the curve reaches in Never finishes; the bar shows the whole percent below. */
export const CEILING = 99.6;
/** Where a phase stops crawling and holds with "Almost there…". */
const ALMOST_AT = 99;
/** Seconds a jump, a slip and a reset take to ease over. */
const JUMP_SECONDS = 1.2;
const SLIP_SECONDS = 1.5;
const RESET_SECONDS = 4;
/** Steady mode's rest at 100 %, seconds. */
const DONE_SECONDS = 2;
/** At most this many seconds between stalls, and between slips once past `SLIP_FLOOR` %. */
const STALL_GAP = 45;
const SLIP_GAP = 70;
const SLIP_FLOOR = 15;
/** After this long, a phase stops slipping and crawls faster, so it always finishes. */
const PHASE_SOFT_LIMIT = 150;
/** Room for one phase's segments (a phase uses well under a hundred). */
const MAX_SEGMENTS = 256;

/** The curve's state at one moment. */
interface Progress {
  /** Percent, 0..100 (below `CEILING` in Never finishes). */
  value: number;
  /** Index into `LABELS`. */
  label: number;
  /** A `SEGMENT` value. */
  kind: number;
  /** Which phase (Never finishes) or loop (Steady) this is, from 0. */
  phase: number;
}

export const createProgress = (): Progress => ({
  value: 0,
  label: LOADING,
  kind: SEGMENT.crawl,
  phase: 0,
});

const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** One phase's segments, in typed arrays reused from phase to phase. */
interface Phase {
  index: number;
  /** Seconds since the curve started at which the phase starts. */
  start: number;
  duration: number;
  count: number;
  readonly t0: Float64Array;
  readonly dur: Float64Array;
  readonly from: Float64Array;
  readonly to: Float64Array;
  /** Crawl rate, 1/s. */
  readonly rate: Float64Array;
  readonly kind: Uint8Array;
  readonly label: Uint8Array;
}

const createPhase = (): Phase => ({
  index: -1,
  start: 0,
  duration: 0,
  count: 0,
  t0: new Float64Array(MAX_SEGMENTS),
  dur: new Float64Array(MAX_SEGMENTS),
  from: new Float64Array(MAX_SEGMENTS),
  to: new Float64Array(MAX_SEGMENTS),
  rate: new Float64Array(MAX_SEGMENTS),
  kind: new Uint8Array(MAX_SEGMENTS),
  label: new Uint8Array(MAX_SEGMENTS),
});

const crawlTo = (from: number, rate: number, t: number) =>
  CEILING - (CEILING - from) * Math.exp(-rate * t);

/**
 * Fills `p` with phase `index` of the curve for `seed`: from 0 up to
 * `ALMOST_AT`, a hold, then a reset to 0. Each phase has its own random
 * stream, so a phase depends only on the seed and its index.
 */
function buildPhase(seed: number, index: number, start: number, p: Phase): void {
  const rng = createRng(hash32(Math.floor(seed) * 7919 + index * 104729 + 0x10ad));
  const between = (lo: number, hi: number) => lo + (hi - lo) * rng();
  p.index = index;
  p.start = start;
  p.count = 0;
  let t = 0;
  let v = 0;
  let sinceStall = 0;
  let sinceSlip = 0;
  let label = LOADING;
  let labelHold = 0;
  const push = (kind: SegmentKind, dur: number, to: number, rate = 0) => {
    const i = p.count++;
    p.t0[i] = t;
    p.dur[i] = dur;
    p.from[i] = v;
    p.to[i] = to;
    p.rate[i] = rate;
    p.kind[i] = kind;
    p.label[i] = label;
    t += dur;
    v = to;
    sinceStall = kind === SEGMENT.stall ? 0 : sinceStall + dur;
    sinceSlip = kind === SEGMENT.slip ? 0 : sinceSlip + dur;
  };
  // Fast at first.
  const first = between(5, 9);
  const firstRate = between(0.05, 0.08);
  push(SEGMENT.crawl, first, crawlTo(0, firstRate, first), firstRate);
  // Room for the hold and the reset at the end.
  // Up to the hold, leaving room for it and the reset.
  for (;;) {
    if (v >= ALMOST_AT || p.count >= MAX_SEGMENTS - 3) {
      break;
    }
    const late = t > PHASE_SOFT_LIMIT;
    if (labelHold > 0) {
      labelHold--;
    } else {
      label = LOADING;
    }
    let kind: SegmentKind;
    if (sinceStall > STALL_GAP) {
      kind = SEGMENT.stall;
    } else if (!late && sinceSlip > SLIP_GAP && v > SLIP_FLOOR) {
      kind = SEGMENT.slip;
    } else {
      const r = rng();
      kind =
        r < 0.5
          ? SEGMENT.crawl
          : r < 0.72
            ? SEGMENT.stall
            : r < 0.86 && v < 85
              ? SEGMENT.jump
              : r >= 0.9 && !late && v > 25
                ? SEGMENT.slip
                : SEGMENT.crawl;
    }
    if (kind === SEGMENT.crawl) {
      const dur = between(4, 12);
      const rate = between(0.015, 0.05) * (late ? 2.5 : 1);
      push(kind, dur, crawlTo(v, rate, dur), rate);
    } else if (kind === SEGMENT.stall) {
      push(kind, between(3, 15), v);
    } else if (kind === SEGMENT.jump) {
      push(kind, JUMP_SECONDS, Math.min(ALMOST_AT - 0.5, v + between(10, 20)));
    } else {
      label = FIRST_SLIP_LABEL + Math.floor(rng() * (LABELS.length - FIRST_SLIP_LABEL));
      labelHold = 2;
      push(kind, SLIP_SECONDS, Math.max(0, v - between(8, 25)));
    }
  }
  if (v < ALMOST_AT) {
    // Out of room (never in practice): ease the rest of the way up.
    push(SEGMENT.jump, JUMP_SECONDS * 2, ALMOST_AT);
  }
  label = ALMOST;
  push(SEGMENT.almost, between(6, 14), v);
  label = LOADING;
  push(SEGMENT.reset, RESET_SECONDS, 0);
  p.duration = t;
}

/** Writes segment `i` of `p` at `t` seconds into the phase into `out`. */
function segmentAt(p: Phase, i: number, t: number, out: Progress): void {
  const local = t - p.t0[i];
  const kind = p.kind[i];
  const from = p.from[i];
  out.kind = kind;
  out.label = p.label[i];
  out.phase = p.index;
  if (kind === SEGMENT.crawl) {
    out.value = Math.min(p.to[i], crawlTo(from, p.rate[i], Math.max(0, local)));
  } else {
    out.value = from + (p.to[i] - from) * smooth(local / p.dur[i]);
  }
}

/** The Never finishes curve for one seed, read at any time. */
export interface ProgressTrack {
  /** Writes the curve at `t` seconds (from 0) into `out` and returns it. */
  at: (t: number, out: Progress) => Progress;
}

/**
 * The Never finishes curve for `seed`. Reading it forward in time is cheap (it
 * keeps the current phase and builds the next one when it gets there); reading
 * it backwards rebuilds from the first phase. Allocates nothing after creation.
 */
export function createProgressTrack(seed: number): ProgressTrack {
  const phase = createPhase();
  buildPhase(seed, 0, 0, phase);
  return {
    at(time, out) {
      const t = Number.isFinite(time) && time > 0 ? time : 0;
      if (t < phase.start) {
        buildPhase(seed, 0, 0, phase);
      }
      while (t >= phase.start + phase.duration) {
        buildPhase(seed, phase.index + 1, phase.start + phase.duration, phase);
      }
      const local = t - phase.start;
      let i = 0;
      while (i < phase.count - 1 && phase.t0[i + 1] <= local) {
        i++;
      }
      segmentAt(phase, i, local, out);
      return out;
    },
  };
}

/**
 * The Steady curve: a loop of `loopSeconds` that rises evenly from 0 to 100 %,
 * rests a moment at 100 % ("Ready"), then eases back to 0 to wrap.
 */
export function steadyAt(t: number, loopSeconds: number, out: Progress): Progress {
  const loop = Math.max(RESET_SECONDS + DONE_SECONDS + 1, loopSeconds);
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const n = Math.floor(time / loop);
  const local = time - n * loop;
  const rise = loop - DONE_SECONDS - RESET_SECONDS;
  out.phase = n;
  if (local < rise) {
    out.kind = SEGMENT.rise;
    out.label = LOADING;
    out.value = (100 * local) / rise;
  } else if (local < rise + DONE_SECONDS) {
    out.kind = SEGMENT.done;
    out.label = READY;
    out.value = 100;
  } else {
    out.kind = SEGMENT.reset;
    out.label = LOADING;
    out.value = 100 * (1 - smooth((local - rise - DONE_SECONDS) / RESET_SECONDS));
  }
  return out;
}

/**
 * The built-in tips: made up, and mildly about calls. Each fits the `tips`
 * param's line length, so the owner's own tips look the same.
 */
export const DEFAULT_TIPS: readonly string[] = [
  "Unmuting before talking increases dialogue success by 100%.",
  "Nodding slowly counts as active listening.",
  "A mug held at chin height grants +5 thoughtfulness.",
  "Your camera can see more of the room than you think.",
  "The chat panel restores morale between long agenda items.",
  'Saying "you\'re on mute" first earns bonus party XP.',
  "Check your hair in the preview before joining the raid.",
  "Leaving early is easier from a meeting with no host.",
  "Two people talking at once is a stalemate. Yield first.",
  "Good lighting from the front hides most sleep debt.",
  '"Can everyone see my screen?" summons a short pause.',
  "Unlock the long weekend by finishing the action items.",
  "A slow connection is a valid excuse once per session.",
  "Snacks eaten off camera don't count against your stamina.",
];

/**
 * The tips to show: the owner's (one per line, trimmed, blank lines dropped),
 * or the built-in ones when there are none.
 */
export function tipList(text: string): string[] {
  const own = (typeof text === "string" ? text : "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return own.length > 0 ? own : [...DEFAULT_TIPS];
}

/** Round `cycle` of the tip order before any fix-up: a seeded shuffle of 0..count-1. */
function rawOrder(seed: number, cycle: number, count: number): number[] {
  const rng = createRng(hash32(Math.floor(seed) * 31337 + cycle * 7727 + 0x7195));
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

/**
 * Which tip (an index below `count`) the `slot`th tip shown is: every tip once
 * in a seeded order, then every tip again in a new order, never showing the
 * same tip twice in a row.
 */
export function tipAt(seed: number, slot: number, count: number): number {
  const n = Math.max(1, Math.floor(count));
  const s = Math.max(0, Math.floor(slot));
  if (n === 1) {
    return 0;
  }
  if (n === 2) {
    return (s + (hash32(Math.floor(seed) + 0x7195) & 1)) % 2;
  }
  const cycle = Math.floor(s / n);
  const pos = s - cycle * n;
  const order = rawOrder(seed, cycle, n);
  // Only the first two of a round ever swap, so the previous round's last is its raw last.
  if (cycle > 0 && order[0] === rawOrder(seed, cycle - 1, n)[n - 1]) {
    const tmp = order[0];
    order[0] = order[1];
    order[1] = tmp;
  }
  return order[pos];
}

/** The art's Ken Burns drift: seconds each way, and how far in it zooms at most. */
const DRIFT_SECONDS = 60;
export const MAX_ZOOM = 1.06;
/**
 * How much bigger than the frame the painting is (each way), so the drift
 * never shows its edge.
 */
export const OVERSCAN = 1.1;
/** How far across the overscan's slack the drift reaches, each way (0..1). */
export const DRIFT_REACH = 0.7;

/** Where the drift has got to. */
interface Drift {
  /** The window's centre across the slack the overscan leaves, -1..1 each way. */
  x: number;
  y: number;
  /** 1..MAX_ZOOM. */
  zoom: number;
}

export const createDrift = (): Drift => ({ x: 0, y: 0, zoom: 1 });

/**
 * The drift at `t` seconds for `seed`: an eased glide between two seeded
 * framings (one zoomed in, one out) over `DRIFT_SECONDS`, and back.
 */
export function driftAt(seed: number, t: number, out: Drift): Drift {
  const h = hash32(Math.floor(seed) * 2654435761 + 0xd71f);
  const a = ((h & 0xff) / 255) * Math.PI * 2;
  const b = a + Math.PI * (0.6 + 0.8 * (((h >>> 8) & 0xff) / 255));
  const zoomInFirst = (h >>> 16) & 1;
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const e = 0.5 - 0.5 * Math.cos((Math.PI * (time % (2 * DRIFT_SECONDS))) / DRIFT_SECONDS);
  const ax = DRIFT_REACH * Math.cos(a);
  const ay = 0.5 * Math.sin(a);
  const bx = DRIFT_REACH * Math.cos(b);
  const by = 0.5 * Math.sin(b);
  const za = zoomInFirst ? MAX_ZOOM : 1;
  const zb = zoomInFirst ? 1 : MAX_ZOOM;
  out.x = ax + (bx - ax) * e;
  out.y = ay + (by - ay) * e;
  out.zoom = za + (zb - za) * e;
  return out;
}

/** The part of the painting (0..1 texture coordinates, y down) the frame shows. */
interface DriftWindow {
  u0: number;
  v0: number;
  /** Its width and height, as a share of the painting's. */
  size: number;
}

export const createDriftWindow = (): DriftWindow => ({ u0: 0, v0: 0, size: 1 });

/** The window `d` shows of a painting `OVERSCAN` times the frame's size. */
export function driftWindow(d: Drift, out: DriftWindow): DriftWindow {
  const size = 1 / (OVERSCAN * d.zoom);
  const slack = (1 - size) / 2;
  out.size = size;
  out.u0 = 0.5 + d.x * slack - size / 2;
  out.v0 = 0.5 + d.y * slack - size / 2;
  return out;
}

/** The emblem turns once in this many seconds (at most one turn per 2 s). */
export const EMBLEM_TURN_SECONDS = 4;

/** The emblem's angle at `t` seconds, radians in [0, 2π). */
export function emblemAngle(t: number): number {
  const time = Number.isFinite(t) ? t : 0;
  const turns = time / EMBLEM_TURN_SECONDS;
  return (turns - Math.floor(turns)) * Math.PI * 2;
}
