/**
 * Pure (GL-free) logic for This Is Fine: the room's layout, the flame anchors
 * along the room's edges and how far the fire has spread, the per-edge flame
 * height profile the shader reads, the smoke depth and the mug's steam
 * schedule. Lengths are reference px (the frame is 1080 tall), x from the left
 * and y down from the top.
 */
import { approach, clamp, fract, smoothstep } from "../math";
import { hash32, type Noise } from "../noise";

/** Frame height in reference px. */
export const REF_HEIGHT = 1080;

/**
 * The speaker's area, which flames, smoke and props keep out of: the middle
 * `1 - 2 * CLEAR_X` of the width and `1 - 2 * CLEAR_Y` of the height.
 */
export const CLEAR_X = 0.25;
export const CLEAR_Y = 0.2;

/** The edges flames burn along, in the order of the profile table's rows. */
export const EDGE_BOTTOM = 0;
export const EDGE_RIGHT = 1;
export const EDGE_TOP = 2;
export const EDGE_LEFT = 3;
export const EDGE_COUNT = 4;

/** Most anchors on one edge; a very wide frame spaces them further apart instead. */
export const MAX_PER_EDGE = 64;
/** Preferred distance between neighbouring anchors along an edge. */
const SPACING = 84;
/** A tongue's half-width, in anchor spacings. */
const TONGUE_W = 0.8;
/** The low flame bed under each tongue reaches this many tongue half-widths. */
const BED_W = 1.6;
/** Share of a tongue's height that is the bed rather than the pointed tongue. */
const BED_SHARE = 0.25;

/** Slow size flicker per anchor: fraction of its size at Motion 1, and noise rate per second. */
const FLICKER = 0.12;
const FLICKER_RATE = 0.35;
/**
 * The shader's noise displacement: flame depth varies by up to `WARP` of the
 * local flame height, and the along-edge position by up to `WARP_ALONG` px.
 */
export const WARP = 0.3;
export const WARP_ALONG = 14;
/** Side flames lean upwards: the along-edge offset per px of depth into the room. */
export const SIDE_SKEW = 0.6;

/** Headroom so a flame at full flicker and warp stays inside its band. */
const SAFE = 0.95 / ((1 + FLICKER) * (1 + WARP));
/** Flame heights where the edge runs outside the clear area: bottom and top, as fractions of the height. */
const FAR_BOTTOM = 0.4;
const FAR_TOP = 0.26;
/** Side flames are at most this fraction of the height deep, however wide the frame. */
const SIDE_CAP = 0.28;
/** Size jitter between anchors: sizes run from `1 - JITTER` to 1 of the anchor's limit. */
const JITTER = 0.4;

/** Along the fire's path, the distance over which a newly reached anchor grows to full size. */
const SPREAD_RAMP = 520;
/** Fire spread and smoke depth ease at most this much per second towards a new setting. */
export const PARAM_RATE = 0.25;
/** An anchor grows or shrinks at most this fraction of its limit per second. */
export const SIZE_RATE = 0.5;

/** Deepest smoke layer, as a fraction of the height. */
export const MAX_SMOKE = 0.2;

/** Columns per edge in the flame profile table, and its channels (height, glow). */
export const PROFILE_COLUMNS = 512;
export const PROFILE_CHANNELS = 2;
/** Glow channel: anchors within this many spacings light the wall; reference flame height for 1. */
const GLOW_REACH = 3;
const GLOW_REF = 220;

/**
 * Flame noise octaves: lattice cell size (px) and upward scroll (px/s at Motion
 * 1). Both cross a point well under `MAX_PATTERN_HZ` times a second.
 */
export const FLAME_OCTAVES = [
  { cell: 120, rise: 34 },
  { cell: 55, rise: 50 },
] as const;
/** Smoke noise: lattice cell (px), sideways drift and slow upward churn (px/s). */
export const SMOKE_NOISE = { cell: 260, drift: 8, churn: 5 } as const;

/** Mug steam: seconds per puff, and the share of it a puff is visible. */
export const STEAM_PERIOD = 4.5;
const STEAM_ACTIVE = 0.8;
/** The motion clock's start, so a still frame (Motion 0) shows a puff mid-rise. */
export const CLOCK_START = STEAM_PERIOD * STEAM_ACTIVE * 0.45;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the room's parts sit, for a frame `width` x `height`. */
export interface RoomLayout {
  width: number;
  height: number;
  /** Top of the floor; the skirting runs along it. */
  floorTop: number;
  /** The ceiling's cornice line. */
  cornice: number;
  /** The door's outer frame (trim included), on the left. */
  door: Rect;
  /** The picture (Office) or clock (Kitchen), upper right; tilted by `tilt` radians. */
  picture: Rect;
  tilt: number;
  /** The hat stand (Office) or fridge (Kitchen), beside the door. */
  stand: Rect;
  /** The table: top surface plus legs down to the floor. */
  table: Rect;
  mug: Rect;
  /** The pot plant on the table's far end. */
  plant: Rect;
  /** The speech bubble, upper left, and the tip of its tail. */
  bubble: Rect;
  tailX: number;
  tailY: number;
}

/** The clear area as a rect. */
export function clearArea(width: number, height: number): Rect {
  return {
    x: width * CLEAR_X,
    y: height * CLEAR_Y,
    w: width * (1 - 2 * CLEAR_X),
    h: height * (1 - 2 * CLEAR_Y),
  };
}

/** A unit-interval hash of `seed` and `salt`. */
const unit = (seed: number, salt: number) =>
  hash32((Math.round(seed) * 7919 + salt * 104729) >>> 0) / 4294967296;

/** Lays the room out: props stay in the side bands, outside the clear area. */
export function roomLayout(width: number, height: number, seed: number): RoomLayout {
  const band = width * CLEAR_X;
  const floorTop = height - 80;
  const doorW = Math.min(band * 0.56, 260);
  const door = { x: band * 0.1, y: height * 0.3, w: doorW, h: floorTop - height * 0.3 };
  const standW = Math.min(band * 0.2, 90);
  const stand = {
    x: band * 0.84 - standW / 2,
    y: height * 0.42,
    w: standW,
    h: floorTop - height * 0.42,
  };
  const picW = Math.min(band * 0.62, 250);
  const picH = Math.min(picW * 0.8, height * 0.2);
  const picture = { x: width - band * 0.5 - picW / 2, y: height * 0.3, w: picW, h: picH };
  const tilt = (unit(seed, 1) < 0.5 ? -1 : 1) * (0.05 + 0.04 * unit(seed, 2));
  const table = {
    x: width - band * 0.93,
    y: height * 0.7,
    w: band * 0.8,
    h: floorTop - height * 0.7,
  };
  const mugW = Math.min(table.w * 0.16, 62);
  const mugH = mugW * 1.05;
  const mug = { x: table.x + table.w * 0.22, y: table.y - mugH, w: mugW, h: mugH };
  const plantW = Math.min(table.w * 0.3, 140);
  const plantH = Math.min(plantW * 1.5, height * 0.24);
  const plant = {
    x: table.x + table.w * 0.92 - plantW,
    y: table.y - plantH,
    w: plantW,
    h: plantH,
  };
  const bubbleW = Math.min(band * 0.86, 420);
  const bubble = {
    x: band * 0.06,
    y: height * 0.05,
    w: bubbleW,
    h: Math.min(bubbleW * 0.42, height * 0.14),
  };
  return {
    width,
    height,
    floorTop,
    cornice: 26,
    door,
    picture,
    tilt,
    stand,
    table,
    mug,
    plant,
    bubble,
    tailX: Math.min(bubble.x + bubble.w + 40, band * 0.98),
    tailY: bubble.y + bubble.h + height * 0.05,
  };
}

/** The flame anchors along the four edges, and the eased fire and smoke settings. */
export interface Fire {
  width: number;
  height: number;
  seed: number;
  /** Anchors per edge, their spacing and the edge's length. */
  readonly count: Int32Array;
  readonly spacing: Float64Array;
  readonly length: Float64Array;
  /** Per anchor slot (edge * MAX_PER_EDGE + index): position along its edge. */
  readonly t: Float64Array;
  /** Distance round the room from where the fire started. */
  readonly dist: Float64Array;
  /** The largest size the anchor may reach, jitter included. */
  readonly limit: Float64Array;
  /** The size the current spread asks for, and the eased size drawn. */
  readonly target: Float64Array;
  readonly size: Float64Array;
  /** Scratch: each anchor's flickering size this frame. */
  readonly drawn: Float64Array;
  /** Eased fire spread and smoke depth, 0..1. */
  intensity: number;
  smoke: number;
  /** False until the first step, which starts everything at its target. */
  started: boolean;
}

const SLOTS = EDGE_COUNT * MAX_PER_EDGE;

export function createFire(): Fire {
  return {
    width: 0,
    height: 0,
    seed: Number.NaN,
    count: new Int32Array(EDGE_COUNT),
    spacing: new Float64Array(EDGE_COUNT),
    length: new Float64Array(EDGE_COUNT),
    t: new Float64Array(SLOTS),
    dist: new Float64Array(SLOTS),
    limit: new Float64Array(SLOTS),
    target: new Float64Array(SLOTS),
    size: new Float64Array(SLOTS),
    drawn: new Float64Array(SLOTS),
    intensity: 0,
    smoke: 0,
    started: false,
  };
}

/**
 * The tallest flame an anchor at `x` on the bottom or top edge may have: low
 * where its tongue (and bed, and warp) could reach over the clear area's
 * columns, taller once it is far enough out to the side.
 */
function horizontalLimit(x: number, width: number, height: number, spacing: number, far: number) {
  const near = height * CLEAR_Y * SAFE;
  const outside = Math.max(width * CLEAR_X - x, x - width * (1 - CLEAR_X));
  const m0 = BED_W * TONGUE_W * spacing + WARP_ALONG + 4;
  const tall = Math.max(near, height * far * SAFE);
  return near + (tall - near) * smoothstep(m0, m0 + 2 * spacing, outside);
}

/**
 * Places the anchors for a `width` x `height` frame and `seed`: evenly spaced
 * along each edge, with hashed sizes (one hash per edge and index, so a resize
 * keeps each anchor's look) and their distance round the room from the
 * starting corner. Eased sizes carry over by edge and index.
 */
export function layoutFire(fire: Fire, width: number, height: number, seed: number): void {
  fire.width = width;
  fire.height = height;
  fire.seed = seed;
  const perimeter = 2 * (width + height);
  const fromRight = unit(seed, 3) < 0.5;
  const origin = fromRight ? width : 0;
  const sideBand = Math.min(width * CLEAR_X, height * SIDE_CAP) * SAFE;
  for (let e = 0; e < EDGE_COUNT; e++) {
    const len = e === EDGE_BOTTOM || e === EDGE_TOP ? width : height;
    const n = clamp(Math.round(len / SPACING), 2, MAX_PER_EDGE);
    const sp = len / n;
    fire.count[e] = n;
    fire.spacing[e] = sp;
    fire.length[e] = len;
    for (let i = 0; i < n; i++) {
      const s = e * MAX_PER_EDGE + i;
      const t = (i + 0.5) * sp;
      fire.t[s] = t;
      // Round the room: along the bottom, up the right, back along the top, down the left.
      let loop: number;
      if (e === EDGE_BOTTOM) {
        loop = t;
      } else if (e === EDGE_RIGHT) {
        loop = width + (height - t);
      } else if (e === EDGE_TOP) {
        loop = width + height + (width - t);
      } else {
        loop = 2 * width + height + t;
      }
      const d = Math.abs(loop - origin);
      fire.dist[s] = Math.min(d, perimeter - d);
      let lim: number;
      if (e === EDGE_BOTTOM) {
        lim = horizontalLimit(t, width, height, sp, FAR_BOTTOM);
      } else if (e === EDGE_TOP) {
        lim = horizontalLimit(t, width, height, sp, FAR_TOP);
      } else {
        lim = sideBand;
      }
      fire.limit[s] = lim * (1 - JITTER * unit(seed, 100 + e * 1000 + i));
    }
  }
}

/** The spread front's distance round the room for a spread of `intensity`. */
function spreadFront(fire: Fire, intensity: number): number {
  const cover = 0.04 + 0.96 * clamp(intensity, 0, 1);
  return cover * (fire.width + fire.height + SPREAD_RAMP);
}

/** Sets each anchor's target size from the eased spread. */
function updateTargets(fire: Fire): void {
  const front = spreadFront(fire, fire.intensity);
  for (let e = 0; e < EDGE_COUNT; e++) {
    for (let i = 0; i < fire.count[e]; i++) {
      const s = e * MAX_PER_EDGE + i;
      fire.target[s] = fire.limit[s] * smoothstep(0, SPREAD_RAMP, front - fire.dist[s]);
    }
  }
}

/**
 * Advances the eased spread and smoke towards their settings and each anchor's
 * size towards its target, by `dt` seconds. The first step starts everything at
 * its target. Returns whether anything changed.
 */
export function stepFire(fire: Fire, dt: number, intensity: number, smoke: number): boolean {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (!fire.started) {
    fire.started = true;
    fire.intensity = clamp(intensity, 0, 1);
    fire.smoke = clamp(smoke, 0, 1);
    updateTargets(fire);
    fire.size.set(fire.target);
    return true;
  }
  const was = fire.intensity;
  const wasSmoke = fire.smoke;
  fire.intensity = approach(fire.intensity, clamp(intensity, 0, 1), PARAM_RATE * step);
  fire.smoke = approach(fire.smoke, clamp(smoke, 0, 1), PARAM_RATE * step);
  let changed = fire.intensity !== was || fire.smoke !== wasSmoke;
  updateTargets(fire);
  for (let e = 0; e < EDGE_COUNT; e++) {
    const maxStep = SIZE_RATE * step;
    for (let i = 0; i < fire.count[e]; i++) {
      const s = e * MAX_PER_EDGE + i;
      // Rate relative to the anchor's band, so a big anchor doesn't take longer.
      const band = Math.max(fire.limit[s], 1);
      const size = approach(fire.size[s], fire.target[s], maxStep * band);
      if (size !== fire.size[s]) {
        fire.size[s] = size;
        changed = true;
      }
    }
  }
  return changed;
}

/** Total target flame size round the room: grows with the spread. */
export function fireCoverage(fire: Fire): number {
  let sum = 0;
  for (let e = 0; e < EDGE_COUNT; e++) {
    for (let i = 0; i < fire.count[e]; i++) {
      sum += fire.target[e * MAX_PER_EDGE + i];
    }
  }
  return sum;
}

/** A pointed tongue over a low bed, 1 tall at its centre, at `u` half-widths off-centre. */
export function tongue(u: number): number {
  const a = Math.abs(u);
  const tip = a < 1 ? (1 - a) ** 1.5 : 0;
  const bed = a < BED_W ? 1 - a / BED_W : 0;
  return (1 - BED_SHARE) * tip + BED_SHARE * bed;
}

/** One anchor's slow flicker factor at motion-clock `time`. */
function flicker(noise: Noise, slot: number, time: number, amount: number): number {
  return 1 + FLICKER * amount * noise.noise2(time * FLICKER_RATE, slot * 3.17);
}

/**
 * Fills `out` (PROFILE_COLUMNS x EDGE_COUNT x 2 floats) with each edge's flame
 * height and wall glow along it: the tallest flickering tongue over each column,
 * and a broad sum of the nearby flames. `amount` scales the flicker (Motion).
 */
export function buildProfile(
  fire: Fire,
  out: Float32Array,
  noise: Noise,
  time: number,
  amount: number,
): void {
  for (let e = 0; e < EDGE_COUNT; e++) {
    for (let i = 0; i < fire.count[e]; i++) {
      const s = e * MAX_PER_EDGE + i;
      fire.drawn[s] = fire.size[s] > 0 ? fire.size[s] * flicker(noise, s, time, amount) : 0;
    }
  }
  for (let e = 0; e < EDGE_COUNT; e++) {
    const n = fire.count[e];
    const sp = fire.spacing[e];
    const len = fire.length[e];
    const base = e * MAX_PER_EDGE;
    const row = e * PROFILE_COLUMNS * PROFILE_CHANNELS;
    const invW = 1 / (TONGUE_W * sp);
    const invG = 1 / (GLOW_REACH * sp);
    for (let c = 0; c < PROFILE_COLUMNS; c++) {
      const t = ((c + 0.5) / PROFILE_COLUMNS) * len;
      const near = Math.floor(t / sp);
      let h = 0;
      let g = 0;
      const k0 = Math.max(0, near - GLOW_REACH);
      const k1 = Math.min(n - 1, near + GLOW_REACH);
      for (let k = k0; k <= k1; k++) {
        const s = base + k;
        const size = fire.drawn[s];
        if (size <= 0) {
          continue;
        }
        const dt = t - fire.t[s];
        const flame = size * tongue(dt * invW);
        if (flame > h) {
          h = flame;
        }
        const w = 1 - Math.abs(dt) * invG;
        if (w > 0) {
          g += size * w * w;
        }
      }
      out[row + c * PROFILE_CHANNELS] = h;
      out[row + c * PROFILE_CHANNELS + 1] = g / GLOW_REF;
    }
  }
}

/** Smoke layer depth in px for the eased smoke setting. */
export const smokeDepth = (fire: Fire) => fire.smoke * MAX_SMOKE * fire.height;

/** A steam puff: opacity, and how far up its curl has risen (0..1). */
export interface SteamPuff {
  alpha: number;
  rise: number;
}

/** The mug's steam at motion-clock `time`: a puff curls up and fades every `STEAM_PERIOD` s. */
export function steamPuff(time: number, out: SteamPuff): SteamPuff {
  const u = fract(time / STEAM_PERIOD);
  if (u >= STEAM_ACTIVE) {
    out.alpha = 0;
    out.rise = 1;
    return out;
  }
  const v = u / STEAM_ACTIVE;
  const s = Math.sin(Math.PI * v);
  out.alpha = s * s;
  out.rise = v;
  return out;
}
