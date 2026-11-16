/**
 * The emote wall's simulation: little emotes rising up the outer thirds of the
 * frame on a slow sway, as a stream's emote wall does when chat gets excited.
 * Pure and deterministic; it allocates nothing once built.
 *
 * Most of the time it is a light trickle. Trickle emotes come from a fixed
 * clock of candidates (`MAX_TRICKLE_PER_SECOND`), each spawning only if its
 * own hash falls under the rate when it comes due. So a rate change adds or
 * leaves out emotes from then on, and never touches one already rising. Now
 * and then a "hype" burst sends a cluster of one emote up together, staggered
 * over a couple of seconds; the wall times its own, and the overlay queues
 * more after a gift or a sub (`eventBurstCount`).
 *
 * Every emote keeps its exact birth time, so where it is depends only on how
 * long it has been rising, not on how the time was cut into frames. Its place
 * across its third is a share of the room there, worked out when it is posed,
 * so on any frame it stays clear of the middle third (`emotePose`).
 */
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import { EMOTE_IDS, emoteIndex } from "./emote-art";
import type { OverlayLayout } from "./overlay-layout";
import type { StreamEvent } from "./stream-events";

/** Most emotes in flight at once, bursts included. */
export const MAX_EMOTES = 192;

/** Trickle emotes a second at rate 1 (and the candidate clock's rate). */
const MAX_TRICKLE_PER_SECOND = 2.5;

/** An emote's half size at 1080p and size 1, before its own spread. */
const EMOTE_HALF = 26;
const SIZE_SPREAD_LO = 0.85;
const SIZE_SPREAD_HI = 1.15;

/** Rise speeds, in frame heights a second. */
const RISE_MIN = 0.07;
export const RISE_MAX = 0.11;

/** Where an emote starts (its centre, as a share of the height down), and where it has faded out. */
const START_LO = 0.9;
const START_HI = 0.97;
const END = 0.12;
/** How far above `END` (a share of the height) its fade near the top begins. */
const TOP_FADE = 0.22;

/** Seconds an emote takes to scale in, and the size it starts from. */
const SCALE_IN_SECONDS = 0.6;
const SCALE_FROM = 0.5;

/** The sway: its reach (a share of the half size) and rates in Hz. */
const SWAY = 0.5;
const SWAY_HZ_MIN = 0.15;
const SWAY_HZ_MAX = 0.3;

/** The tilt that follows the sway, in radians, and how far a tilted emote's quad reaches. */
const MAX_TILT = 0.15;
export const TILT_REACH = Math.cos(MAX_TILT) + Math.sin(MAX_TILT);

/** The longest an emote lives, in seconds. */
const MAX_LIFE = (START_HI - END) / RISE_MIN;

const PEAK_ALPHA = 0.95;

/** A burst's copies, and the seconds they are staggered over. */
export const BURST_MIN = 8;
export const BURST_MAX = 20;
const BURST_SPREAD_SECONDS = 2;
/** Bursts waiting or under way at once; more are dropped. */
export const MAX_BURSTS = 4;
/** The wall's own hype bursts come this many seconds apart. */
export const HYPE_GAP_MIN = 45;
export const HYPE_GAP_MAX = 150;
/** A hype burst more than this many seconds overdue (a long frame) is skipped. */
const STALE_SECONDS = 3;

/** Share of subs that bring a burst; every gift does. */
const SUB_BURST_SHARE = 0.5;

/** Emotes a burst can be: the excited ones. */
const HYPE_CELLS = [
  "heart",
  "hearteyes",
  "fire",
  "party",
  "star",
  "lol",
  "laugh",
  "wow",
  "gg",
  "trophy",
].map((id) => emoteIndex(id));

const SEED = 0xe307;
const SALT_TRICKLE = 1;
const SALT_HYPE = 20;
const SALT_BURST = 30;
const SALT_COPY = 40;
const SALT_EVENT = 60;

function hashOf(salt: number, i: number): number {
  return hash32(hash32(SEED ^ Math.imul(salt, 0x9e3779b1)) ^ hash32(i + 0x632be5ab));
}

const unit = (salt: number, i: number) => hashOf(salt, i) / 4294967296;

/** Copies in a burst after `event`: by gift size for a gift, half of subs, else 0. */
export function eventBurstCount(event: StreamEvent): number {
  if (event.kind === "gift") {
    return clamp(6 + 2 * event.amount, BURST_MIN, BURST_MAX);
  }
  if (event.kind === "sub" && unit(SALT_EVENT, event.index) < SUB_BURST_SHARE) {
    return BURST_MIN + (hashOf(SALT_EVENT + 1, event.index) % 5);
  }
  return 0;
}

/** Seconds from hype burst `n - 1` to `n` (from the start for 0). */
export function hypeGap(n: number): number {
  return HYPE_GAP_MIN + (HYPE_GAP_MAX - HYPE_GAP_MIN) * unit(SALT_HYPE, n);
}

/** When trickle candidate `i` comes due: on a jittered grid, so always in order. */
function candidateTime(i: number): number {
  return (i + 0.8 * unit(SALT_TRICKLE, i)) / MAX_TRICKLE_PER_SECOND;
}

/** An emote in flight. */
interface Emote {
  live: boolean;
  /** Its spawn number, unique while the wall runs. */
  id: number;
  birth: number;
  life: number;
  cell: number;
  /** 0 left, 1 right. */
  side: number;
  /** Where across its third, 0 to 1 of the room there. */
  across: number;
  rise: number;
  start: number;
  swayHz: number;
  phase: number;
  size: number;
}

/** A burst waiting or under way. */
interface Burst {
  live: boolean;
  serial: number;
  start: number;
  count: number;
  spawned: number;
}

/** Where an emote is this frame, in device pixels. */
export interface EmotePose {
  /** Its spawn number: the same emote keeps it from frame to frame. */
  id: number;
  /** Which emote (an index into `EMOTE_IDS`). */
  cell: number;
  x: number;
  y: number;
  half: number;
  angle: number;
  alpha: number;
}

export interface EmoteWall {
  /** Seconds since it started. */
  readonly time: number;
  /** Emotes in flight. */
  readonly count: number;
  /** Bursts started so far. */
  readonly bursts: number;
  /**
   * Advances `dt` seconds with trickle `rate` (0 to 1) and hype bursts on or
   * off, each latched as an emote or burst comes due.
   */
  step: (dt: number, rate: number, bursts: boolean) => void;
  /**
   * Queues a burst of `count` copies (clamped to `BURST_MIN`..`BURST_MAX`)
   * starting `delay` seconds from now. False if `MAX_BURSTS` are already queued.
   */
  burst: (delay: number, count: number) => boolean;
  /**
   * Writes slot `i`'s emote (`i` below `MAX_EMOTES`) as placed in `layout`, at
   * `scale` pixels per 1080p pixel and the viewer's `size`. False (leaving
   * `out` alone) for an empty slot or one that would not show.
   */
  pose: (i: number, layout: OverlayLayout, scale: number, size: number, out: EmotePose) => boolean;
}

/** An empty wall. */
export function createEmoteWall(): EmoteWall {
  const emotes: Emote[] = Array.from({ length: MAX_EMOTES }, () => ({
    live: false,
    id: 0,
    birth: 0,
    life: 0,
    cell: 0,
    side: 0,
    across: 0,
    rise: 0,
    start: 0,
    swayHz: 0,
    phase: 0,
    size: 1,
  }));
  const queue: Burst[] = Array.from({ length: MAX_BURSTS }, () => ({
    live: false,
    serial: 0,
    start: 0,
    count: 0,
    spawned: 0,
  }));
  let time = 0;
  let count = 0;
  let spawns = 0;
  let serials = 0;
  let candidate = 0;
  let hypes = 0;
  let hypeAt = hypeGap(0);

  /** Takes a free slot for an emote born at `birth`, its look from hashes of `key` under `salt`. */
  const spawn = (birth: number, salt: number, key: number): Emote | null => {
    let e: Emote | null = null;
    for (const s of emotes) {
      if (!s.live) {
        e = s;
        break;
      }
    }
    if (e === null) {
      return null;
    }
    e.live = true;
    e.id = spawns++;
    e.birth = birth;
    e.rise = RISE_MIN + (RISE_MAX - RISE_MIN) * unit(salt, key);
    e.start = START_LO + (START_HI - START_LO) * unit(salt + 1, key);
    e.life = (e.start - END) / e.rise;
    e.swayHz = SWAY_HZ_MIN + (SWAY_HZ_MAX - SWAY_HZ_MIN) * unit(salt + 2, key);
    e.phase = 2 * Math.PI * unit(salt + 3, key);
    e.size = SIZE_SPREAD_LO + (SIZE_SPREAD_HI - SIZE_SPREAD_LO) * unit(salt + 4, key);
    e.cell = Math.floor(unit(salt + 5, key) * EMOTE_IDS.length);
    e.side = unit(salt + 6, key) < 0.5 ? 0 : 1;
    e.across = unit(salt + 7, key);
    count++;
    return e;
  };

  /** Starts copies of `b` that are due. */
  const runBurst = (b: Burst) => {
    const cell = HYPE_CELLS[Math.floor(unit(SALT_BURST, b.serial) * HYPE_CELLS.length)];
    const side = unit(SALT_BURST + 1, b.serial) < 0.5 ? 0 : 1;
    const centre = 0.2 + 0.6 * unit(SALT_BURST + 2, b.serial);
    while (b.spawned < b.count) {
      const key = b.serial * BURST_MAX + b.spawned;
      const at =
        b.start + ((b.spawned + 0.6 * unit(SALT_COPY + 9, key)) / b.count) * BURST_SPREAD_SECONDS;
      if (at > time) {
        return;
      }
      b.spawned++;
      const e = spawn(at, SALT_COPY, key);
      if (e !== null) {
        // One emote, clustered on one side.
        e.cell = cell;
        e.side = side;
        e.across = clamp(centre + 0.5 * (unit(SALT_COPY + 10, key) - 0.5), 0, 1);
      }
    }
    b.live = false;
  };

  const enqueue = (start: number, n: number) => {
    let b: Burst | null = null;
    for (const q of queue) {
      if (!q.live) {
        b = q;
        break;
      }
    }
    if (b === null) {
      return false;
    }
    b.live = true;
    b.serial = serials++;
    b.start = start;
    b.count = clamp(Math.round(n), BURST_MIN, BURST_MAX);
    b.spawned = 0;
    return true;
  };

  return {
    get time() {
      return time;
    },
    get count() {
      return count;
    },
    get bursts() {
      return serials;
    },
    step(dt, rate, bursts) {
      time += Number.isFinite(dt) && dt > 0 ? dt : 0;
      const r = Number.isFinite(rate) ? rate : 0;

      // The trickle, skipping candidates that would already have gone (a long frame).
      if (time - candidateTime(candidate) > MAX_LIFE) {
        candidate = Math.max(candidate, Math.floor((time - MAX_LIFE) * MAX_TRICKLE_PER_SECOND));
      }
      for (let t = candidateTime(candidate); t <= time; t = candidateTime(candidate)) {
        if (unit(SALT_TRICKLE + 1, candidate) < r) {
          spawn(t, SALT_TRICKLE + 2, candidate);
        }
        candidate++;
      }

      // The wall's own hype, on its clock whether or not bursts are on.
      while (time >= hypeAt) {
        if (bursts && time - hypeAt < STALE_SECONDS) {
          enqueue(hypeAt, BURST_MIN + (hashOf(SALT_HYPE + 1, hypes) % (BURST_MAX - BURST_MIN + 1)));
        }
        hypes++;
        hypeAt += hypeGap(hypes);
      }

      for (const b of queue) {
        if (b.live) {
          runBurst(b);
        }
      }

      for (const e of emotes) {
        if (e.live && time - e.birth >= e.life) {
          e.live = false;
          count--;
        }
      }
    },
    burst(delay, n) {
      return enqueue(time + (Number.isFinite(delay) ? Math.max(0, delay) : 0), n);
    },
    pose(i, layout, scale, size, out) {
      const e = emotes[i] as Emote | undefined;
      if (e === undefined || !e.live) {
        return false;
      }
      const age = time - e.birth;
      const band = e.side === 0 ? layout.edgeLeft : layout.edgeRight;
      const inner = layout.margin;
      const reach = TILT_REACH + SWAY;
      // As big as asked, but never so big it can't stay inside its third.
      const fit = (band.w - 2 * inner) / (2 * reach);
      const full = Math.min(EMOTE_HALF * e.size * size * scale, fit);
      if (!(full > 0)) {
        return false;
      }
      const lo = band.x + inner + full * reach;
      const hi = band.x + band.w - inner - full * reach;
      const turn = 2 * Math.PI * e.swayHz * age + e.phase;
      const height = layout.height;
      const y = height * (e.start - e.rise * age);
      const grow = smoothstep(0, SCALE_IN_SECONDS, age);
      const alpha = PEAK_ALPHA * grow * smoothstep(END, END + TOP_FADE, y / height);
      if (!(alpha > 0)) {
        return false;
      }
      out.id = e.id;
      out.cell = e.cell;
      out.x = lo + (hi - lo) * e.across + SWAY * full * Math.sin(turn);
      out.y = y;
      out.half = full * (SCALE_FROM + (1 - SCALE_FROM) * grow);
      // Leaning into the sway.
      out.angle = -MAX_TILT * Math.cos(turn);
      out.alpha = alpha;
      return true;
    },
  };
}
