/**
 * Neon-Noir Apartment model, all pure so the tests can check it:
 *
 * - The room: the window wall, the window and its slats, in 1080p reference px
 *   (y down), and the camera that turns them into 3D for the light on the walls.
 * - Flying-car lanes and the cars on them, a direct function of time.
 * - The searchlight's sweeps and the advert's scenes, both on fixed-length
 *   slots so the state at any time is found without walking earlier events.
 * - The neon signs on the nearest towers.
 */
import type { Rgb } from "../color";
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import { type CityLayout, LAYERS, REF_HEIGHT } from "../city/city-sim";
import type { AdvertSide } from "./noir.meta";

/** Uniform 0..1 from three integers. */
function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x5bd1e995))) / 4294967296;
}

/* ----- Room ----- */

/** The room in reference px (y down), for a frame `refWidth` wide. */
export interface Room {
  refWidth: number;
  /** The window wall's visible rectangle; outside it are the side walls, ceiling and desk. */
  wallX0: number;
  wallX1: number;
  wallY0: number;
  wallY1: number;
  /** The glass, inside the frame. */
  glassX0: number;
  glassX1: number;
  glassY0: number;
  glassY1: number;
  /** Frame width round the glass. */
  frame: number;
  /** Centres of the two vertical mullions, and their half-width. */
  mullion1: number;
  mullion2: number;
  mullionHalf: number;
  /** Distance between slats. */
  pitch: number;
  /** Focal length (reference px) and the window wall's distance (m): a 3D point (x, y, z) shows at (W/2 + F x / z, 540 - F y / z). */
  focal: number;
  depth: number;
}

/** Window wall, glass and mullions as fractions of the frame width. */
const WALL_X = 0.1;
const GLASS_X = 0.128;
const MULLION_X = 0.3;
const WALL_TOP = 34;
const WALL_BOTTOM = 872;
const GLASS_TOP = 74;
const GLASS_BOTTOM = 816;
const FRAME = 16;
const MULLION_HALF = 6;
const SLAT_PITCH = 34;
/** The window wall is this far away (m), and its edges are this far either side (m). */
const DEPTH = 4;
const HALF_ROOM = 2.1;

export function roomLayout(refWidth: number): Room {
  const W = Math.max(200, refWidth);
  const cx = W / 2;
  const half = cx - WALL_X * W;
  return {
    refWidth: W,
    wallX0: WALL_X * W,
    wallX1: W - WALL_X * W,
    wallY0: WALL_TOP,
    wallY1: WALL_BOTTOM,
    glassX0: GLASS_X * W,
    glassX1: W - GLASS_X * W,
    glassY0: GLASS_TOP,
    glassY1: GLASS_BOTTOM,
    frame: FRAME,
    mullion1: MULLION_X * W,
    mullion2: W - MULLION_X * W,
    mullionHalf: MULLION_HALF,
    pitch: SLAT_PITCH,
    focal: (half * DEPTH) / HALF_ROOM,
    depth: DEPTH,
  };
}

/**
 * Half the width of each gap between slats, in slat pitches, for `blinds`
 * (0 open, the slats edge-on; 1 closed, only hairline gaps).
 */
export function slatHalfGap(blinds: number): number {
  const cover = 0.06 + 0.9 * clamp(Number.isFinite(blinds) ? blinds : 0.5, 0, 1);
  return 0.5 * (1 - cover);
}

/** The skyline is drawn this much larger than City at Night's, so its towers rise up the window. */
export const CITY_ZOOM = 1.4;
/** Reference y of the buildings' feet, below the sill so they never show. */
export const CITY_BASE = 900;

/* ----- Advert ----- */

/** Where the advert's tower and screen stand in the view (reference px), for a side. */
export interface AdvertRect {
  /** Tower left, right and roof. */
  towerX0: number;
  towerX1: number;
  towerY0: number;
  /** Screen left, right, top and bottom. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function advertRect(side: AdvertSide, refWidth: number, out: AdvertRect): AdvertRect {
  const W = Math.max(200, refWidth);
  const cx = side === "right" ? 0.81 * W : 0.19 * W;
  const half = 0.07 * W;
  out.towerX0 = cx - half - 0.018 * W;
  out.towerX1 = cx + half + 0.018 * W;
  out.towerY0 = 150;
  out.x0 = cx - half;
  out.x1 = cx + half;
  out.y0 = 205;
  out.y1 = 480;
  return out;
}

/** Seconds between scene changes on average, the most either way, and the cross-fade. */
const ADVERT_PERIOD = 15;
const ADVERT_JITTER = 2.5;
export const ADVERT_FADE = 3;
/** Number of scene patterns the shader knows. */
export const ADVERT_PATTERNS = 4;

/** Soft colour pairs for the advert's scenes. */
export const ADVERT_PALETTES: readonly (readonly [Rgb, Rgb])[] = [
  [
    [0.95, 0.2, 0.7],
    [0.35, 0.15, 0.9],
  ],
  [
    [0.1, 0.85, 0.95],
    [0.1, 0.3, 0.8],
  ],
  [
    [1, 0.6, 0.15],
    [0.95, 0.2, 0.35],
  ],
  [
    [0.2, 0.95, 0.75],
    [0.9, 0.25, 0.8],
  ],
  [
    [0.55, 0.3, 1],
    [0.1, 0.75, 1],
  ],
  [
    [1, 0.35, 0.5],
    [1, 0.75, 0.3],
  ],
];

/** When scene `k` starts fading in (s): every `ADVERT_PERIOD`, give or take `ADVERT_JITTER`. */
export function advertChange(k: number, seed: number): number {
  return k * ADVERT_PERIOD + ADVERT_JITTER * (2 * rand(k, seed, 31) - 1);
}

/** Scene `k`'s pattern, 0..ADVERT_PATTERNS - 1. */
export function advertPattern(k: number, seed: number): number {
  return Math.floor(rand(k, seed, 32) * ADVERT_PATTERNS) % ADVERT_PATTERNS;
}

/**
 * Scene `k`'s palette. The scenes step through the palettes backwards from a
 * seeded start, so neighbouring scenes never share one.
 */
export function advertPalette(k: number, seed: number): number {
  const n = ADVERT_PALETTES.length;
  const start = Math.floor(rand(seed, 0, 33) * n);
  return (((k * (n - 1) + start) % n) + n) % n;
}

interface AdvertState {
  /** The scene showing (or fading in), and the one before it. */
  scene: number;
  prev: number;
  /** 0..1: how far `scene` has faded in over `prev`. */
  mix: number;
}

export function createAdvertState(): AdvertState {
  return { scene: 0, prev: -1, mix: 1 };
}

/** The advert at `t` seconds, written into `out`. Allocates nothing. */
export function advertAt(t: number, seed: number, out: AdvertState): AdvertState {
  let k = Math.floor(t / ADVERT_PERIOD) + 1;
  while (advertChange(k, seed) > t) {
    k--;
  }
  out.scene = k;
  out.prev = k - 1;
  out.mix = smoothstep(0, ADVERT_FADE, t - advertChange(k, seed));
  return out;
}

/** The average colour of scene `k`, for the light it throws into the room. */
export function advertGlow(k: number, seed: number, out: Rgb): Rgb {
  const [a, b] = ADVERT_PALETTES[advertPalette(k, seed)];
  for (let i = 0; i < 3; i++) {
    out[i] = 0.5 * (a[i] + b[i]);
  }
  return out;
}

/* ----- Searchlight ----- */

/** Each sweep has a slot this long and starts up to `SEARCH_JITTER` into it. */
const SEARCH_SLOT = 60;
const SEARCH_JITTER = 30;
/** Fewest and most seconds from one sweep's start to the next. */
export const MIN_SEARCH_GAP = SEARCH_SLOT - SEARCH_JITTER;
export const MAX_SEARCH_GAP = SEARCH_SLOT + SEARCH_JITTER;
/** Seconds a sweep takes, and the share of it the beam takes to fade in and out at its ends. */
export const SEARCH_SECONDS = 16;
const SEARCH_EDGE = 0.15;
/** Widest beam angle from straight down (radians), at either end of a sweep. */
const SEARCH_ANGLE = (55 * Math.PI) / 180;
/** Width (in sweep units, -1..1) of the stretch where the beam shines into the room. */
const ROOM_WIDTH = 0.2;
/** Chance that a sweep passes over the apartment. */
const ROOM_CHANCE = 0.65;
/** How far the room light's direction swings sideways per unit of sweep past the window. */
const SLIDE = 1.6;

interface SearchState {
  /** Whether a sweep is under way. */
  active: boolean;
  /** The sweep under way, or the last one (-1 before the first). */
  sweep: number;
  /** 0..1: how strongly the beam shows in the view. */
  beam: number;
  /** Beam angle from straight down (radians), positive to the right. */
  angle: number;
  /** Beam source, as a fraction of the frame width (it stands above the frame). */
  originX: number;
  /** 0..1: how much of the beam falls into the room. */
  room: number;
  /** Sideways direction of the light in the room (x per unit of depth). */
  slide: number;
  /**
   * Where the beam's spot is across the window wall, in spot widths from the
   * middle of the frame (negative left): it slides across while the room is lit.
   */
  spot: number;
}

export function createSearchState(): SearchState {
  return { active: false, sweep: -1, beam: 0, angle: 0, originX: 0.5, room: 0, slide: 0, spot: 0 };
}

/** When sweep `k` starts (s). */
export function searchStart(k: number, seed: number): number {
  return k * SEARCH_SLOT + SEARCH_JITTER * rand(k, seed, 41);
}

/**
 * The searchlight at `t` seconds, written into `out`. Each sweep crosses the
 * city once in `SEARCH_SECONDS`, fading in and out at the ends. About two in
 * three pass over the apartment, when the room light rises and falls as a
 * smooth bell lasting a few seconds while its spot crosses the window and its
 * direction swings sideways, so the stripes slide across the walls. Allocates nothing.
 */
export function searchAt(t: number, seed: number, out: SearchState): SearchState {
  out.active = false;
  out.beam = 0;
  out.room = 0;
  out.slide = 0;
  out.spot = 0;
  const k = Math.floor(t / SEARCH_SLOT);
  const start = searchStart(k, seed);
  out.sweep = t >= start ? k : k - 1;
  const q = (t - start) / SEARCH_SECONDS;
  if (!(q >= 0 && q <= 1)) {
    return out;
  }
  out.active = true;
  const dir = rand(k, seed, 42) < 0.5 ? -1 : 1;
  const u = dir * (2 * q - 1);
  out.originX = 0.3 + 0.4 * rand(k, seed, 43);
  out.angle = u * SEARCH_ANGLE;
  out.beam = smoothstep(0, SEARCH_EDGE, q) * (1 - smoothstep(1 - SEARCH_EDGE, 1, q));
  if (rand(k, seed, 44) < ROOM_CHANCE) {
    const u0 = 0.6 * rand(k, seed, 45) - 0.3;
    const x = (u - u0) / ROOM_WIDTH;
    out.room = Math.exp(-x * x) * out.beam;
    out.slide = (u - u0) * SLIDE;
    out.spot = x;
  }
  return out;
}

/* ----- Flying cars ----- */

export const LANE_COUNT = 6;
/** Cars start and end this far outside the frame (reference px), past their glow. */
const CAR_MARGIN = 90;
/** A car's length at depth 1 (reference px). */
export const CAR_LENGTH = 34;
/** Most cars `carsAt` writes. */
export const MAX_CARS = 64;
/** Floats per car: x, y, depth, direction (+1 right), opacity, slot id (lane * 1000 + slot). */
export const CAR_STRIDE = 6;

export interface Lane {
  /** Reference y at the frame's left edge, and its rise per px (y down). */
  y: number;
  slope: number;
  /** 0..1: far (small, slow, hazy) to near. */
  depth: number;
  /** Reference px per second, positive to the right. */
  speed: number;
  /** Distance between car slots, and the loop length (a whole number of slots). */
  spacing: number;
  span: number;
  /** Where slot 0 is at t = 0, along the loop. */
  phase: number;
}

/**
 * Lanes for a variation: two far, two middle and two near. Near lanes run low
 * in the window, where the speaker's shoulders hide the middle of them.
 */
export function carLanes(seed: number, refWidth: number): Lane[] {
  const W = Math.max(200, refWidth);
  const lanes: Lane[] = [];
  for (let l = 0; l < LANE_COUNT; l++) {
    const tier = Math.floor(l / 2);
    const r = (n: number) => rand(l, seed, 50 + n);
    const depth = [0.38, 0.62, 0.9][tier] + 0.08 * (r(0) - 0.5);
    const yBase = [
      [210, 330],
      [380, 500],
      [560, 700],
    ][tier];
    const y = yBase[0] + (yBase[1] - yBase[0]) * (l % 2 === 0 ? r(1) * 0.5 : 0.5 + r(1) * 0.5);
    const speed = (12 + 34 * depth) * (0.85 + 0.3 * r(2)) * (r(3) < 0.5 ? -1 : 1);
    const spacing = (240 + 300 * r(4)) * (0.7 + 0.5 * depth);
    const slots = Math.max(1, Math.ceil((W + 2 * CAR_MARGIN) / spacing));
    lanes.push({
      y,
      slope: 0.05 * (r(5) - 0.5),
      depth,
      speed,
      spacing,
      span: slots * spacing,
      phase: r(6) * spacing,
    });
  }
  return lanes;
}

/** Share of car slots filled at `traffic` 0..1. */
function carChance(traffic: number): number {
  return 0.85 * clamp(Number.isFinite(traffic) ? traffic : 0, 0, 1);
}

/**
 * Writes the cars in view at `t` seconds into `out` (`CAR_STRIDE` floats each)
 * and returns how many. Each lane's cars sit in slots a fixed `spacing` apart
 * that all move together, so cars in a lane never overlap. A slot holds a car
 * on a given trip round its loop with chance `carChance(traffic)`, decided
 * while the slot is off screen; as `traffic` moves, cars fade in or out over
 * the last tenth of that chance rather than popping. Allocates nothing.
 */
export function carsAt(
  lanes: readonly Lane[],
  seed: number,
  traffic: number,
  t: number,
  refWidth: number,
  out: Float32Array,
): number {
  const chance = carChance(traffic);
  const max = Math.min(MAX_CARS, Math.floor(out.length / CAR_STRIDE));
  let n = 0;
  for (let l = 0; l < lanes.length; l++) {
    const lane = lanes[l];
    const slots = Math.round(lane.span / lane.spacing);
    const travel = Math.abs(lane.speed) * t + lane.phase;
    for (let j = 0; j < slots && n < max; j++) {
      const s = j * lane.spacing + travel;
      const trip = Math.floor(s / lane.span);
      const along = s - trip * lane.span - CAR_MARGIN;
      if (along > refWidth + CAR_MARGIN) {
        continue;
      }
      const r = rand(hash32(l * 4099 + j), seed, trip);
      const alpha = clamp((chance - r) / 0.1, 0, 1);
      if (alpha <= 0) {
        continue;
      }
      const x = lane.speed > 0 ? along : refWidth - along;
      const o = n * CAR_STRIDE;
      out[o] = x;
      out[o + 1] = lane.y + lane.slope * x;
      out[o + 2] = lane.depth;
      out[o + 3] = lane.speed > 0 ? 1 : -1;
      out[o + 4] = alpha;
      out[o + 5] = l * 1000 + j;
      n++;
    }
  }
  return n;
}

/* ----- Neon signs ----- */

export const MAX_SIGNS = 8;
/** Floats per sign: x, y, width, height (city reference px), colour index, glyph seed. */
export const SIGN_STRIDE = 6;
/** Sign colours: magenta, cyan and amber. */
export const SIGN_COLOURS: readonly Rgb[] = [
  [1, 0.25, 0.75],
  [0.25, 0.9, 1],
  [1, 0.65, 0.2],
];

/**
 * Up to `MAX_SIGNS` vertical neon signs on the nearest towers, in the skyline's
 * own reference px, written into `out`. Towers whose middle is in the middle
 * fifth of the frame get none, so the brightest ones flank the speaker.
 */
export function signLayout(city: CityLayout, seed: number, out: Float32Array): number {
  const near = LAYERS.length - 1;
  const W = city.refWidth;
  let n = 0;
  for (let b = 0; b < city.buildings.length && n < MAX_SIGNS; b++) {
    const bd = city.buildings[b];
    const mid = (bd.x + bd.width / 2) / W;
    if (bd.layer !== near || Math.abs(mid - 0.5) < 0.1 || bd.width < 50) {
      continue;
    }
    if (rand(b, seed, 60) > 0.45) {
      continue;
    }
    const w = 11 + 6 * rand(b, seed, 61);
    const h = w * (4 + Math.floor(3 * rand(b, seed, 62)));
    const top = REF_HEIGHT - bd.height;
    const o = n * SIGN_STRIDE;
    out[o] = bd.x + (0.15 + 0.7 * rand(b, seed, 63)) * (bd.width - w);
    out[o + 1] = top + 18 + (0.1 + 0.3 * rand(b, seed, 64)) * bd.height * 0.5;
    out[o + 2] = w;
    out[o + 3] = h;
    out[o + 4] = Math.floor(rand(b, seed, 65) * SIGN_COLOURS.length) % SIGN_COLOURS.length;
    out[o + 5] = Math.floor(rand(b, seed, 66) * 1000);
    n++;
  }
  return n;
}
