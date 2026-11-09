/**
 * Creeping vines' growth simulation and shapes, kept free of GL so they can be
 * tested. Vines (plants) grow from the frame edges as strands (a main stem,
 * branches and coiling tendrils) whose tips steer along a smoothly varying
 * curvature, away from the speaker's region, the frame edges and other vines.
 * Leaves and flowers are attached at stem points with a birth time and grow
 * with age. After growing for 1–3 min a plant holds, then withers: leaves
 * yellow and drop (handed over to a small falling-leaf sim), the stem fades,
 * and its slot is free for a new plant.
 *
 * Positions are in reference units (1080 per frame height). Each plant is
 * anchored to the left edge, the right edge or the centre (`anchor` 0, 1 or
 * 0.5 of the width) and stores its points relative to that x, so a resize
 * keeps vines on their own side of the frame.
 *
 * Time: each plant has its own clock (`age`, in "plant seconds"), advanced by
 * `dt * growth`, so the growth param speeds up the whole lifecycle at once.
 * Ages are bounded by a plant's lifetime, so they are safe to upload as floats.
 *
 * Pools are fixed and allocated up front: per plant, a slice of `PLANT_SEGS`
 * stem segments, `PLANT_STRANDS` strands, `PLANT_LEAVES` leaves and
 * `PLANT_FLOWERS` flowers; one ring of `MAX_FALLING` falling leaves.
 */
import type { Rgb } from "../color";
import {
  fallFactor,
  fanStrip,
  leafOutline,
  SHAPE_OVAL,
  SHAPE_ROUND_PETAL,
  swayOffset,
  swayTilt,
} from "../leaves/leaves-sim";
import { clamp, smoothstep } from "../math";
import { createNoise, createRng } from "../noise";
import { MAX_PLANTS } from "./vines.meta";

const TAU = Math.PI * 2;

// --- Pools ------------------------------------------------------------------

/** Stem segments per plant. */
export const PLANT_SEGS = 512;
/** Strands (main stem, branches, tendrils) per plant. */
const PLANT_STRANDS = 32;
/** Leaves per plant. */
export const PLANT_LEAVES = 110;
/** Flowers per plant. */
export const PLANT_FLOWERS = 8;
/** Florets drawn per flower for hanging racemes (wisteria). */
export const RACEME = 6;
/** Falling leaves at once (a ring: the oldest is overwritten when full). */
export const MAX_FALLING = 256;
/** Most sprites `writeSprites` can write: every leaf, floret and falling leaf. */
export const MAX_SPRITES = MAX_PLANTS * (PLANT_LEAVES + PLANT_FLOWERS * RACEME) + MAX_FALLING;

/**
 * Floats per stem segment instance: x0, y0, x1, y1 (plant-local ref px); h0, h1
 * (tangent heading in radians at each end), w0, w1 (mature width in ref px);
 * b0, b1 (birth at each end, plant seconds), plant index.
 */
export const SEG_FLOATS = 11;
/** Floats per plant uniform: x offset (ref px), age (plant s), stem alpha, wither. */
export const PLANT_FLOATS = 4;
/** Floats per sprite written by `writeSprites`, before the batch's spin pair. */
export const SPRITE_FLOATS = 7;

// --- Growth constants -------------------------------------------------------

const KIND_MAIN = 0;
const KIND_BRANCH = 1;
export const KIND_TENDRIL = 2;
/** Arc length between committed stem points, per strand kind (ref px). */
export const SEG_LEN = [7, 7, 3] as const;
/** Largest curvature (radians per ref px) per strand kind. */
export const KAPPA_MAX = [0.05, 0.05, 0.13] as const;
/** Tip speed in ref px per plant second, per strand kind. */
const KIND_SPEED = [6, 5, 4] as const;
/** Longest tip advance per substep (ref px), so steering stays smooth after a hitch. */
export const MAX_STEP = 2;
/** How far stem points may lie outside the frame (ref px): vines start just off-edge. */
export const OFF_FRAME = 40;
/** Distance ahead of the tip that steering looks (ref px). */
const LOOK = 45;
/** Steering starts this far (ref px) before the look-ahead point reaches the speaker's region. */
const MARGIN = 70;
/** Length (ref px) over which a stem's end curls into a tightening spiral. */
const CURL_LEN = 110;
/** Plant seconds for a tip to thicken (shader): see `vines.ts`. */
export const TIP_AGE = 4;
export const THICKEN_AGE = 50;

// --- Lifecycle (plant seconds) ---------------------------------------------

/** A leaf unfolds over this long after the tip passes. */
const LEAF_GROW = 3.5;
/** A flower opens over this long. */
const FLOWER_OPEN = 5;
/** Leaves start yellowing spread over this long after withering begins, oldest first. */
const WITHER_SPREAD = 14;
/** A leaf takes this long to yellow, then drops. */
const YELLOW = 7;
/** The stem starts fading this long after withering begins, and fades over `STEM_FADE`. */
const STEM_FADE_START = 11;
const STEM_FADE = 12;
/** A plant is retired this long after withering begins (every leaf has dropped by then). */
const RETIRE_AFTER = 24;
/** Plant seconds between spawns while below the density. */
const SPAWN_GAP = 3;
const SPAWN_GAP_RANGE = 5;
/** Seconds of simulated growth before the first frame, so the frame isn't bare. */
export const PREWARM = 30;

/** Falling-leaf constants (real seconds, ref px). */
const FALL_PX = 38;
const FALL_SWAY = 22;
const FALL_LIFE = 40;

/** A leaf's unfolding curve over `t` = age / LEAF_GROW: 0 to 1, monotonic, clamped. */
export function leafGrow(t: number): number {
  return smoothstep(0, 1, t);
}

/** A leaf's yellowing over `t` = time since it started / YELLOW: 0 to 1, monotonic, clamped. */
export function witherCurve(t: number): number {
  return smoothstep(0, 1, t);
}

// --- Region -----------------------------------------------------------------

/** Width of the side bands vines may grow in (ref px): at most a third of the width. */
export function bandWidth(refWidth: number, border: number): number {
  return refWidth * (0.08 + 0.25 * clamp(border, 0, 1));
}

/** Height of the top band vines may grow in across the centre (ref px). */
export function bandHeight(border: number): number {
  return 1080 * (0.03 + 0.1 * clamp(border, 0, 1));
}

/**
 * How far (ref px) `x, y` lies inside the speaker's region, the part of the frame
 * outside the left and right bands and below the top band; negative outside it.
 * The centre third of the width is always inside the region below the top band.
 */
export function intrusion(x: number, y: number, refWidth: number, border: number): number {
  const rx = bandWidth(refWidth, border);
  return Math.min(x - rx, refWidth - rx - x, y - bandHeight(border));
}

/** How far (ref px) `x, y` lies outside the frame; negative inside it. */
export function offFrame(x: number, y: number, refWidth: number): number {
  return Math.max(-x, x - refWidth, -y, y - 1080);
}

/** Whether a stem point may be placed at `x, y` (world ref px). */
export function allowed(x: number, y: number, refWidth: number, border: number): boolean {
  return intrusion(x, y, refWidth, border) <= 0 && offFrame(x, y, refWidth) <= OFF_FRAME;
}

/** `a - b` wrapped to (-π, π]. */
export function angleDiff(a: number, b: number): number {
  const d = (a - b) % TAU;
  return d > Math.PI ? d - TAU : d <= -Math.PI ? d + TAU : d;
}

// --- Shapes -----------------------------------------------------------------

/** Indices into `VINE_SHAPES`. */
const SHAPE_HEART = 0;
const SHAPE_IVY = 1;
const SHAPE_LEAFLET = 2;
const SHAPE_FLOWER = 3;
const SHAPE_FLORET = 4;

const OUTLINE_POINTS = 72;

/** Angular distance from `a` to `b`, in [0, π]. */
const angleTo = (a: number, b: number) => Math.abs(angleDiff(a, b));
const bump = (t: number, at: number, width: number) => Math.exp(-((angleTo(t, at) / width) ** 2));

/** Samples `r(θ)` around the origin, scaled so the largest radius is 1. */
function polar(r: (theta: number) => number): number[] {
  const radii: number[] = [];
  for (let k = 0; k < OUTLINE_POINTS; k++) {
    radii.push(r((k * TAU) / OUTLINE_POINTS));
  }
  const max = Math.max(...radii);
  const out: number[] = [];
  radii.forEach((radius, k) => {
    const a = (k * TAU) / OUTLINE_POINTS;
    out.push((Math.cos(a) * radius) / max, (Math.sin(a) * radius) / max);
  });
  return out;
}

const UP = Math.PI / 2;
const DOWN = -Math.PI / 2;
/** A thin petiole spike down the -y axis (the tip is at +y). */
const petiole = (t: number, length: number) => length * Math.max(0, 1 - angleTo(t, DOWN) / 0.08);

/** Outlines in unit space, tip towards +y, petiole towards -y (as in `leaves-sim`). */
export function vineOutline(shape: number): number[] {
  switch (shape) {
    case SHAPE_HEART:
      // Rounded lobes either side of a notch at the base, narrowing to a point.
      return polar((t) => {
        const r = (0.74 + 0.26 * Math.sin(t)) * (1 - 0.42 * bump(t, DOWN, 0.22));
        return Math.max(r * (1 + 0.22 * bump(t, UP, 0.3)), petiole(t, 0.78));
      });
    case SHAPE_IVY:
      // Three pointed lobes (tip and two sides) and two small basal ones.
      return polar((t) => {
        let r = 0.42;
        const lobes = [
          [UP, 1],
          [0.25, 0.78],
          [Math.PI - 0.25, 0.78],
          [-0.75, 0.55],
          [Math.PI + 0.75, 0.55],
        ];
        for (const [a, len] of lobes) {
          r = Math.max(r, len * Math.cos(Math.min(1.5, angleTo(t, a) * 1.9)));
        }
        return Math.max(r * (1 - 0.3 * bump(t, DOWN, 0.18)), petiole(t, 0.72));
      });
    case SHAPE_FLOWER:
      // A nearly round trumpet face with five soft points.
      return polar((t) => 0.88 + 0.12 * Math.cos(5 * (t - UP)));
    case SHAPE_FLORET:
      return leafOutline(SHAPE_ROUND_PETAL);
    default:
      return leafOutline(SHAPE_OVAL);
  }
}

/** The triangle strips for every shape, in `SHAPE_*` order. */
export const VINE_SHAPES: readonly (readonly number[])[] = [
  SHAPE_HEART,
  SHAPE_IVY,
  SHAPE_LEAFLET,
  SHAPE_FLOWER,
  SHAPE_FLORET,
].map((s) => fanStrip(vineOutline(s)));

// --- Plant types --------------------------------------------------------------

interface PlantType {
  leafShape: number;
  /** Leaf radius (ref px), spacing along the stem (ref px) and angle off the stem (rad). */
  leafSize: number;
  leafSpacing: number;
  leafAngle: number;
  /** Leaf colours, 0..1. */
  palette: readonly Rgb[];
  /** Midrib strength, 0..1. */
  vein: number;
  flowerShape: number;
  flowerSize: number;
  flowerPalette: readonly Rgb[];
  /** Flower centre colour and how much of the face it tints. */
  core: Rgb;
  coreAmount: number;
  /** Flowers hang as racemes of `RACEME` florets. */
  raceme: boolean;
  /** Stem colour and mature base width (ref px). */
  stem: Rgb;
  stemWidth: number;
  /** Branch, tendril and wander rates relative to the defaults. */
  branchiness: number;
  tendrils: number;
  wander: number;
}

const hex = (h: string): Rgb => {
  const n = Number.parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const PLANTS: Readonly<Record<string, PlantType>> = {
  ivy: {
    leafShape: SHAPE_IVY,
    leafSize: 13,
    leafSpacing: 17,
    leafAngle: 1.1,
    palette: ["#2f5a2a", "#3b6b2f", "#2a4d27", "#46773a"].map((v) => hex(v)),
    vein: 1,
    flowerShape: SHAPE_FLOWER,
    flowerSize: 6,
    flowerPalette: ["#d8d79a", "#c9cf86"].map((v) => hex(v)),
    core: hex("#8e9a4c"),
    coreAmount: 0.6,
    raceme: false,
    stem: hex("#5b5a33"),
    stemWidth: 3.2,
    branchiness: 1.2,
    tendrils: 0.3,
    wander: 1,
  },
  morningGlory: {
    leafShape: SHAPE_HEART,
    leafSize: 15,
    leafSpacing: 30,
    leafAngle: 0.9,
    palette: ["#4f8a35", "#5e9a3e", "#46802f"].map((v) => hex(v)),
    vein: 1,
    flowerShape: SHAPE_FLOWER,
    flowerSize: 13,
    flowerPalette: ["#4f6fd8", "#7a54c9", "#c95a9e", "#5d86e0"].map((v) => hex(v)),
    core: hex("#f4f0e6"),
    coreAmount: 1,
    raceme: false,
    stem: hex("#6d8a3a"),
    stemWidth: 2.2,
    branchiness: 0.8,
    tendrils: 1.4,
    wander: 1.3,
  },
  wisteria: {
    leafShape: SHAPE_LEAFLET,
    leafSize: 8,
    leafSpacing: 12,
    leafAngle: 1.2,
    palette: ["#5d7f34", "#6a8c3b", "#56772f"].map((v) => hex(v)),
    vein: 0.6,
    flowerShape: SHAPE_FLORET,
    flowerSize: 5,
    flowerPalette: ["#9b87d6", "#b49ee0", "#8a73c9"].map((v) => hex(v)),
    core: hex("#efe6fb"),
    coreAmount: 0.5,
    raceme: true,
    stem: hex("#6b5b4b"),
    stemWidth: 4.2,
    branchiness: 1,
    tendrils: 0.6,
    wander: 0.8,
  },
};

/** Withered leaf colours: yellow first, then brown. */
const YELLOWED: Rgb = [0.83, 0.68, 0.24];
const BROWNED: Rgb = [0.52, 0.35, 0.17];

// --- Simulation ---------------------------------------------------------------

/** Per-frame inputs to `step`; reuse one object rather than allocating per frame. */
export interface VineFrame {
  /** Screen width in reference px. */
  refWidth: number;
  type: PlantType;
  /** Params: see vines.ts. */
  growth: number;
  density: number;
  border: number;
  flowers: number;
}

export interface Vines {
  /** Stem segment instances, `SEG_FLOATS` each; plant `p` owns slots `p * PLANT_SEGS ..`. */
  readonly segData: Float32Array;
  /** Strand kind of each segment slot (`KIND_*`), for tests. */
  readonly segKind: Uint8Array;
  /** Segment slots used per plant (drawn), including live tip segments. */
  readonly segUsed: Int32Array;
  /**
   * Per plant, the range of segment slots (within its slice) changed since the
   * last `clearDirty`, inclusive; `dirtyLo > dirtyHi` when clean.
   */
  readonly dirtyLo: Int32Array;
  readonly dirtyHi: Int32Array;
  /** Per-plant uniforms, `PLANT_FLOATS` each (see `PLANT_FLOATS`). */
  readonly plantData: Float32Array;
  /** 1 while a plant slot is in use. */
  readonly active: Uint8Array;
  /** Plants in use. */
  readonly plants: number;
  /** Plants spawned so far (for tests). */
  readonly spawned: number;
  /** Falling leaves in flight. */
  readonly falling: number;
  /** Leaves currently attached, per plant. */
  readonly leafCount: Int32Array;
  /** Sprites in each group from the last `writeSprites`: leaves (attached and falling), then flowers. */
  readonly leafSprites: number;
  readonly flowerSprites: number;
  /**
   * Stem segments per density grid cell (`crowdCell`), which steers growth
   * away from crowded spots; for tests.
   */
  readonly crowd: Uint16Array;
  /**
   * Sets the screen width (ref px); call before the first `step` and on resize.
   * Plants keep their points relative to their anchor edge, so the density grid
   * is rebuilt at their new world positions.
   */
  resize: (refWidth: number) => void;
  /** Advances `dt` real seconds. */
  step: (dt: number, f: VineFrame) => void;
  /** Starts a new plant, recycling the oldest when every slot is in use. Returns its slot. */
  spawn: (f: VineFrame) => number;
  /** Marks every plant's segments clean, after the caller has uploaded the dirty ranges. */
  clearDirty: () => void;
  /**
   * Writes the visible leaves, then flowers, to `data` (`SPRITE_FLOATS` then the
   * spin pair at `spinOffset`, `stride` floats apart) in device px at `scale`.
   * Returns the total; see `leafSprites` and `flowerSprites` for the groups.
   */
  writeSprites: (
    data: Float32Array,
    stride: number,
    spinOffset: number,
    scale: number,
    type: PlantType,
  ) => number;
}

/** Density grid cell (ref px) and size: wide enough for a 4.4:1 frame. */
const CELL = 40;
const GRID_COLS = 120;
const GRID_ROWS = 28;

/** The density grid cell holding world point (`wx`, `wy`) in ref px, clamped to the grid. */
export function crowdCell(wx: number, wy: number): number {
  const c = clamp(Math.floor(wx / CELL), 0, GRID_COLS - 1);
  const r = clamp(Math.floor(wy / CELL), 0, GRID_ROWS - 1);
  return r * GRID_COLS + c;
}

export function createVines(seed = 0x7173): Vines {
  const rng = createRng(seed);
  const noise = createNoise(seed);

  // Segments.
  const segData = new Float32Array(MAX_PLANTS * PLANT_SEGS * SEG_FLOATS);
  const segKind = new Uint8Array(MAX_PLANTS * PLANT_SEGS);
  const segCell = new Int32Array(MAX_PLANTS * PLANT_SEGS).fill(-1);
  const segUsed = new Int32Array(MAX_PLANTS);
  const dirtyLo = new Int32Array(MAX_PLANTS).fill(PLANT_SEGS);
  const dirtyHi = new Int32Array(MAX_PLANTS).fill(-1);
  const grid = new Uint16Array(GRID_COLS * GRID_ROWS);

  // Plants.
  const active = new Uint8Array(MAX_PLANTS);
  const growing = new Uint8Array(MAX_PLANTS);
  const witherInit = new Uint8Array(MAX_PLANTS);
  const anchor = new Float32Array(MAX_PLANTS);
  const age = new Float64Array(MAX_PLANTS);
  const growDur = new Float32Array(MAX_PLANTS);
  const holdDur = new Float32Array(MAX_PLANTS);
  const endGrow = new Float64Array(MAX_PLANTS);
  const witherStart = new Float64Array(MAX_PLANTS);
  const order = new Float64Array(MAX_PLANTS);
  const startX = new Float32Array(MAX_PLANTS);
  const startY = new Float32Array(MAX_PLANTS);
  const plantData = new Float32Array(MAX_PLANTS * PLANT_FLOATS);

  // Strands, `PLANT_STRANDS` per plant.
  const NS = MAX_PLANTS * PLANT_STRANDS;
  const strandCount = new Int32Array(MAX_PLANTS);
  const sAlive = new Uint8Array(NS);
  const sKind = new Uint8Array(NS);
  const sx = new Float64Array(NS);
  const sy = new Float64Array(NS);
  const sh = new Float64Array(NS);
  const sArc = new Float64Array(NS);
  const sSince = new Float64Array(NS);
  const sMax = new Float32Array(NS);
  const sWidth = new Float32Array(NS);
  const sSign = new Float32Array(NS);
  const sNoise = new Float32Array(NS);
  const sLeafNext = new Float32Array(NS);
  const sLeafSide = new Float32Array(NS);
  const sSlot = new Int32Array(NS);
  const sLast = new Int32Array(NS);
  // The last committed point (the start of the tip segment).
  const ax = new Float64Array(NS);
  const ay = new Float64Array(NS);
  const ah = new Float64Array(NS);
  const aw = new Float32Array(NS);
  const ab = new Float64Array(NS);

  // Leaves, `PLANT_LEAVES` per plant.
  const NL = MAX_PLANTS * PLANT_LEAVES;
  const leafCount = new Int32Array(MAX_PLANTS);
  const lOn = new Uint8Array(NL);
  const lx = new Float32Array(NL);
  const ly = new Float32Array(NL);
  const la = new Float32Array(NL);
  const lr = new Float32Array(NL);
  const lb = new Float32Array(NL);
  const lFlip = new Float32Array(NL);
  const lShade = new Float32Array(NL);
  const lPick = new Float32Array(NL);
  const lPhase = new Float32Array(NL);
  const lWither = new Float32Array(NL);

  // Flowers, `PLANT_FLOWERS` per plant.
  const NF = MAX_PLANTS * PLANT_FLOWERS;
  const flowerCount = new Int32Array(MAX_PLANTS);
  const fx = new Float32Array(NF);
  const fy = new Float32Array(NF);
  const fa = new Float32Array(NF);
  const fr = new Float32Array(NF);
  const fb = new Float32Array(NF);
  const fPick = new Float32Array(NF);

  // Falling leaves (world ref px), a ring.
  const gOn = new Uint8Array(MAX_FALLING);
  const gx = new Float32Array(MAX_FALLING);
  const gy = new Float32Array(MAX_FALLING);
  const gr = new Float32Array(MAX_FALLING);
  const ga = new Float32Array(MAX_FALLING);
  const gFlip = new Float32Array(MAX_FALLING);
  const gAge = new Float32Array(MAX_FALLING);
  const gRate = new Float32Array(MAX_FALLING);
  const gSpin = new Float32Array(MAX_FALLING);
  const gFlipRate = new Float32Array(MAX_FALLING);
  const gPace = new Float32Array(MAX_FALLING);
  const gDrift = new Float32Array(MAX_FALLING);
  const gRgb = new Float32Array(MAX_FALLING * 3);
  let fallNext = 0;
  let falling = 0;

  let refWidth = 1920;
  let border = 0.6;
  let plants = 0;
  let spawned = 0;
  let spawnTimer = 0;
  // Real seconds, unwrapped (float64), for the gentle sway of attached leaves.
  let time = 0;
  let leafSprites = 0;
  let flowerSprites = 0;

  const cellOf = crowdCell;
  const crowd = (wx: number, wy: number) => grid[cellOf(wx, wy)];

  const markDirty = (p: number, slot: number) => {
    const k = slot - p * PLANT_SEGS;
    if (k < dirtyLo[p]) {
      dirtyLo[p] = k;
    }
    if (k > dirtyHi[p]) {
      dirtyHi[p] = k;
    }
  };

  /** Writes segment `slot` of plant `p` from strand `i`'s last point to its tip. */
  const writeSeg = (p: number, i: number, slot: number, tipWidth: number) => {
    const o = slot * SEG_FLOATS;
    segData[o] = ax[i];
    segData[o + 1] = ay[i];
    segData[o + 2] = sx[i];
    segData[o + 3] = sy[i];
    segData[o + 4] = ah[i];
    segData[o + 5] = sh[i];
    segData[o + 6] = aw[i];
    segData[o + 7] = tipWidth;
    segData[o + 8] = ab[i];
    segData[o + 9] = age[p];
    segData[o + 10] = p;
    segKind[slot] = sKind[i];
    markDirty(p, slot);
  };

  /** Mature stem width (ref px) of strand `i` at arc length `s`: thinner towards its end. */
  const widthAt = (i: number, s: number) => sWidth[i] * (1 - 0.55 * Math.min(1, s / sMax[i]));

  const allocSlot = (p: number) => (segUsed[p] < PLANT_SEGS ? p * PLANT_SEGS + segUsed[p]++ : -1);

  /** Starts a strand of plant `p` at a point; returns its index, or -1 when the pools are full. */
  const addStrand = (
    p: number,
    kind: number,
    x: number,
    y: number,
    h: number,
    width: number,
    maxLen: number,
  ) => {
    if (strandCount[p] >= PLANT_STRANDS) {
      return -1;
    }
    const slot = allocSlot(p);
    if (slot < 0) {
      return -1;
    }
    const i = p * PLANT_STRANDS + strandCount[p]++;
    sAlive[i] = 1;
    sKind[i] = kind;
    sx[i] = ax[i] = x;
    sy[i] = ay[i] = y;
    sh[i] = ah[i] = h;
    sArc[i] = 0;
    sSince[i] = 0;
    sMax[i] = maxLen;
    sWidth[i] = width;
    aw[i] = width;
    ab[i] = age[p];
    sSign[i] = rng() < 0.5 ? -1 : 1;
    sNoise[i] = rng() * 100;
    sLeafNext[i] = 4 + rng() * 8;
    sLeafSide[i] = rng() < 0.5 ? -1 : 1;
    sSlot[i] = slot;
    sLast[i] = -1;
    writeSeg(p, i, slot, width);
    return i;
  };

  /** Stops strand `i`, tapering its end to a point. */
  const killStrand = (p: number, i: number) => {
    if (!sAlive[i]) {
      return;
    }
    sAlive[i] = 0;
    if (sSince[i] > 0.5) {
      writeSeg(p, i, sSlot[i], 0);
    } else if (sLast[i] >= 0) {
      // The tip slot is still a point: taper the last committed segment instead.
      segData[sLast[i] * SEG_FLOATS + 7] = 0;
      markDirty(p, sLast[i]);
    }
  };

  const addLeaf = (p: number, i: number, type: PlantType) => {
    if (leafCount[p] >= PLANT_LEAVES) {
      return;
    }
    const j = p * PLANT_LEAVES + leafCount[p]++;
    const side = (sLeafSide[i] = -sLeafSide[i]);
    const r = type.leafSize * (0.8 + 0.4 * rng()) * (sKind[i] === KIND_MAIN ? 1 : 0.88);
    const L = sh[i] + side * type.leafAngle * (0.8 + 0.4 * rng());
    lOn[j] = 1;
    lx[j] = sx[i] + Math.cos(L) * r * 0.8;
    ly[j] = sy[i] + Math.sin(L) * r * 0.8;
    // The unit outline's tip is +y; rotate it onto direction L.
    la[j] = L - Math.PI / 2;
    lr[j] = r;
    lb[j] = age[p];
    lFlip[j] = side;
    lShade[j] = 0.85 + 0.3 * rng();
    lPick[j] = rng();
    lPhase[j] = rng() * TAU;
    lWither[j] = 0;
  };

  const addFlower = (p: number, i: number, type: PlantType) => {
    if (flowerCount[p] >= PLANT_FLOWERS) {
      return;
    }
    const j = p * PLANT_FLOWERS + flowerCount[p]++;
    const side = -sLeafSide[i];
    const r = type.flowerSize * (0.85 + 0.3 * rng());
    const n = sh[i] + side * Math.PI * 0.5;
    fx[j] = sx[i] + Math.cos(n) * r * (type.raceme ? 0.2 : 0.7);
    fy[j] = sy[i] + Math.sin(n) * r * (type.raceme ? 0.2 : 0.7);
    fa[j] = rng() * TAU;
    fr[j] = r;
    fb[j] = age[p];
    fPick[j] = rng();
  };

  /** Commits strand `i`'s tip as a stem point, then sprouts whatever grows there. */
  const commit = (p: number, i: number, f: VineFrame) => {
    const kind = sKind[i];
    const w = widthAt(i, sArc[i]);
    const slot = sSlot[i];
    writeSeg(p, i, slot, w);
    const cell = cellOf(sx[i] + anchor[p] * refWidth, sy[i]);
    segCell[slot] = cell;
    if (grid[cell] < 65535) {
      grid[cell]++;
    }
    sLast[i] = slot;
    ax[i] = sx[i];
    ay[i] = sy[i];
    ah[i] = sh[i];
    aw[i] = w;
    ab[i] = age[p];
    sSince[i] = 0;
    const next = allocSlot(p);
    if (next < 0) {
      killStrand(p, i);
      return;
    }
    sSlot[i] = next;
    writeSeg(p, i, next, w);
    if (kind === KIND_TENDRIL) {
      return;
    }

    const type = f.type;
    if (sArc[i] >= sLeafNext[i]) {
      addLeaf(p, i, type);
      sLeafNext[i] = sArc[i] + type.leafSpacing * (0.8 + 0.4 * rng());
    }
    const late = age[p] > 0.45 * growDur[p];
    if (late && f.flowers > 0 && rng() < f.flowers * 0.035) {
      addFlower(p, i, type);
    }
    // Branches fork off at 0.5–0.9 rad; branches of branches are rarer.
    const remaining = sMax[i] - sArc[i];
    if (remaining > CURL_LEN && rng() < 0.02 * type.branchiness * (kind === KIND_MAIN ? 1 : 0.4)) {
      const h = sh[i] + (rng() < 0.5 ? -1 : 1) * (0.5 + 0.4 * rng());
      addStrand(p, KIND_BRANCH, sx[i], sy[i], h, w * 0.75, 120 + rng() * 300);
    }
    if (rng() < 0.012 * type.tendrils) {
      const h = sh[i] + (rng() < 0.5 ? -1 : 1) * (0.9 + 0.5 * rng());
      addStrand(p, KIND_TENDRIL, sx[i], sy[i], h, Math.min(1.3, w * 0.35), 35 + rng() * 40);
    }
  };

  /**
   * The free curvature of strand `i` (radians per ref px) before steering: a slow
   * wander, and a tightening spiral over a stem's last `CURL_LEN`; tendrils coil
   * ever tighter.
   */
  const freeCurvature = (i: number, type: PlantType) => {
    const s = sArc[i];
    if (sKind[i] === KIND_TENDRIL) {
      return sSign[i] * Math.min(KAPPA_MAX[KIND_TENDRIL], 0.02 + 0.004 * s);
    }
    const wander = noise.noise2(s * 0.006, sNoise[i]) * 0.014 * type.wander;
    const remaining = sMax[i] - s;
    const curl = remaining < CURL_LEN ? sSign[i] * 0.045 * (1 - remaining / CURL_LEN) : 0;
    return wander + curl;
  };

  /**
   * Curvature that turns a stem tip at world `wx, wy` heading `h` away from the
   * speaker's region, the frame edges and crowded cells, with its weight (0..1)
   * in `steerWeight`.
   */
  let steerWeight = 0;
  const steer = (wx: number, wy: number, h: number) => {
    const c = Math.cos(h);
    const s = Math.sin(h);
    const qx = wx + c * LOOK;
    const qy = wy + s * LOOK;
    let dx = 0;
    let dy = 0;
    // Away from the speaker's region, along its nearest side.
    const rx = bandWidth(refWidth, border);
    const left = qx - rx;
    const right = refWidth - rx - qx;
    const top = qy - bandHeight(border);
    const inside = Math.min(left, right, top);
    const wi = clamp((inside + MARGIN) / MARGIN, 0, 1);
    if (wi > 0) {
      if (inside === left) {
        dx -= wi;
      } else if (inside === right) {
        dx += wi;
      } else {
        dy -= wi;
      }
    }
    // Back into the frame.
    dx += clamp((10 - qx) / 50, 0, 1) - clamp((qx - refWidth + 10) / 50, 0, 1);
    dy += clamp((10 - qy) / 50, 0, 1) - clamp((qy - 1070) / 50, 0, 1);
    const m = Math.hypot(dx, dy);
    steerWeight = Math.min(1, m);
    let k = 0;
    if (m > 0) {
      const ux = dx / m;
      const uy = dy / m;
      // Positive curvature turns the heading towards (-sin h, cos h).
      const cross = c * uy - s * ux;
      const dot = c * ux + s * uy;
      k = KAPPA_MAX[KIND_MAIN] * steerWeight * (dot < 0 ? (cross >= 0 ? 1 : -1) : cross);
    }
    // Towards the less crowded side.
    const dp = crowd(qx - s * 25, qy + c * 25);
    const dm = crowd(qx + s * 25, qy - c * 25);
    return k + 0.012 * clamp((dm - dp) / 3, -1, 1);
  };

  /** Grows plant `p`'s live strands by `pdt` plant seconds. */
  const grow = (p: number, pdt: number, f: VineFrame) => {
    const xOff = anchor[p] * refWidth;
    // Strands added while iterating start growing next frame.
    const n = strandCount[p];
    let alive = 0;
    for (let k = 0; k < n; k++) {
      const i = p * PLANT_STRANDS + k;
      if (!sAlive[i]) {
        continue;
      }
      const kind = sKind[i];
      const kmax = KAPPA_MAX[kind];
      const dist = KIND_SPEED[kind] * pdt;
      const steps = Math.max(1, Math.ceil(dist / MAX_STEP));
      const ds = dist / steps;
      for (let st = 0; st < steps && sAlive[i]; st++) {
        let kappa = freeCurvature(i, f.type);
        if (kind !== KIND_TENDRIL) {
          const ks = steer(sx[i] + xOff, sy[i], sh[i]);
          kappa = kappa * (1 - steerWeight) + ks;
        }
        kappa = clamp(kappa, -kmax, kmax);
        const h = sh[i] + kappa * ds;
        const mid = sh[i] + kappa * ds * 0.5;
        const x = sx[i] + Math.cos(mid) * ds;
        const y = sy[i] + Math.sin(mid) * ds;
        if (!allowed(x + xOff, y, refWidth, border)) {
          killStrand(p, i);
          break;
        }
        sx[i] = x;
        sy[i] = y;
        sh[i] = h;
        sArc[i] += ds;
        sSince[i] += ds;
        if (sSince[i] >= SEG_LEN[kind]) {
          commit(p, i, f);
        }
        if (sAlive[i] && sArc[i] >= sMax[i]) {
          killStrand(p, i);
        }
      }
      if (sAlive[i]) {
        writeSeg(p, i, sSlot[i], widthAt(i, sArc[i]));
        alive++;
      }
    }
    return alive;
  };

  const endGrowth = (p: number) => {
    for (let k = 0; k < strandCount[p]; k++) {
      killStrand(p, p * PLANT_STRANDS + k);
    }
    growing[p] = 0;
    endGrow[p] = Math.max(age[p], 1);
    witherStart[p] = age[p] + holdDur[p];
  };

  const retire = (p: number) => {
    const base = p * PLANT_SEGS;
    for (let k = 0; k < segUsed[p]; k++) {
      const c = segCell[base + k];
      if (c >= 0 && grid[c] > 0) {
        grid[c]--;
      }
      segCell[base + k] = -1;
    }
    segData.fill(0, base * SEG_FLOATS, (base + PLANT_SEGS) * SEG_FLOATS);
    if (segUsed[p] > 0) {
      dirtyLo[p] = 0;
      dirtyHi[p] = segUsed[p] - 1;
    }
    for (let k = 0; k < strandCount[p]; k++) {
      sAlive[p * PLANT_STRANDS + k] = 0;
    }
    segUsed[p] = 0;
    strandCount[p] = 0;
    leafCount[p] = 0;
    flowerCount[p] = 0;
    active[p] = 0;
    growing[p] = 0;
    plantData.fill(0, p * PLANT_FLOATS, (p + 1) * PLANT_FLOATS);
    plants--;
  };

  /** A start point on an edge, in world ref px, with its heading and anchor in `start`. */
  const start = { x: 0, y: 0, h: 0, anchor: 0 };
  const pickStart = () => {
    const W = refWidth;
    const rx = bandWidth(W, border);
    const r = rng();
    const tilt = (rng() - 0.5) * 1.2;
    if (r < 0.36) {
      start.x = -4;
      start.y = 30 + rng() * 1020;
      start.h = tilt;
      start.anchor = 0;
    } else if (r < 0.72) {
      start.x = W + 4;
      start.y = 30 + rng() * 1020;
      start.h = Math.PI + tilt;
      start.anchor = 1;
    } else if (r < 0.9) {
      start.x = rng() * W;
      start.y = -4;
      const centre = start.x > rx && start.x < W - rx;
      // Across the centre the band is thin: run along it, angled slightly down.
      start.h = centre ? (start.x < W / 2 ? 0.3 : Math.PI - 0.3) : Math.PI / 2 + tilt;
      start.anchor = start.x < W / 3 ? 0 : start.x > (2 * W) / 3 ? 1 : 0.5;
    } else {
      const left = rng() < 0.5;
      const x = rng() * rx * 0.8;
      start.x = left ? x : W - x;
      start.y = 1084;
      start.h = -Math.PI / 2 + tilt * 0.8;
      start.anchor = left ? 0 : 1;
    }
  };

  const spawn = (f: VineFrame) => {
    let p = active.indexOf(0);
    if (p < 0) {
      // Every slot in use: recycle the oldest plant.
      p = 0;
      for (let q = 1; q < MAX_PLANTS; q++) {
        if (order[q] < order[p]) {
          p = q;
        }
      }
      retire(p);
    }
    // The best of a few candidate starts: furthest from other plants' starts.
    let best = -1;
    let bx = 0;
    let by = 0;
    let bh = 0;
    let bAnchor = 0;
    for (let c = 0; c < 6; c++) {
      pickStart();
      let d = 1e9;
      for (let q = 0; q < MAX_PLANTS; q++) {
        if (!active[q]) {
          continue;
        }
        d = Math.min(
          d,
          Math.hypot(startX[q] + anchor[q] * refWidth - start.x, startY[q] - start.y),
        );
      }
      if (d > best) {
        best = d;
        bx = start.x;
        by = start.y;
        bh = start.h;
        bAnchor = start.anchor;
      }
    }
    active[p] = 1;
    growing[p] = 1;
    witherInit[p] = 0;
    anchor[p] = bAnchor;
    age[p] = 0;
    growDur[p] = 60 + rng() * 120;
    holdDur[p] = 20 + rng() * 20;
    endGrow[p] = 0;
    witherStart[p] = Infinity;
    order[p] = spawned++;
    startX[p] = bx - bAnchor * refWidth;
    startY[p] = by;
    segUsed[p] = 0;
    strandCount[p] = 0;
    leafCount[p] = 0;
    flowerCount[p] = 0;
    plants++;
    addStrand(p, KIND_MAIN, startX[p], by, bh, f.type.stemWidth, 700 + rng() * 700);
    return p;
  };

  /** Hands attached leaf `j` (plant `p`) over to the falling sim, at its current pose. */
  const drop = (p: number, j: number, type: PlantType) => {
    lOn[j] = 0;
    const g = fallNext;
    fallNext = (fallNext + 1) % MAX_FALLING;
    if (!gOn[g]) {
      falling++;
    }
    gOn[g] = 1;
    gx[g] = lx[j] + anchor[p] * refWidth;
    gy[g] = ly[j];
    gr[g] = lr[j];
    ga[g] = la[j] + 0.05 * Math.sin(time * 0.8 + lPhase[j]);
    gFlip[g] = lFlip[j];
    gAge[g] = 0;
    gRate[g] = TAU * (0.15 + rng() * 0.15);
    gSpin[g] = (0.1 + rng() * 0.3) * (rng() < 0.5 ? -1 : 1);
    gFlipRate[g] = 0.4 + rng() * 0.8;
    gPace[g] = 0.8 + rng() * 0.4;
    gDrift[g] = (rng() - 0.5) * 12;
    leafColor(j, type, 1);
    gRgb[g * 3] = rgbOut[0];
    gRgb[g * 3 + 1] = rgbOut[1];
    gRgb[g * 3 + 2] = rgbOut[2];
  };

  /** Leaf `j`'s colour at wither `w` (0..1) into `rgbOut`. */
  const rgbOut: Rgb = [0, 0, 0];
  const leafColor = (j: number, type: PlantType, w: number) => {
    const pal = type.palette;
    const base = pal[Math.floor(lPick[j] * pal.length) % pal.length];
    const brown = smoothstep(0.55, 1, w);
    for (let k = 0; k < 3; k++) {
      const green = Math.min(1, base[k] * lShade[j]);
      const yellow = green + (YELLOWED[k] - green) * w;
      rgbOut[k] = yellow + (BROWNED[k] - yellow) * brown;
    }
  };

  const stepFalling = (dt: number) => {
    for (let g = 0; g < MAX_FALLING; g++) {
      if (!gOn[g]) {
        continue;
      }
      gAge[g] += dt;
      const psi = gAge[g] * gRate[g];
      gy[g] += FALL_PX * gPace[g] * fallFactor(psi) * dt;
      gx[g] += gDrift[g] * dt;
      if (gy[g] - gr[g] * 2 - FALL_SWAY > 1080 || gAge[g] > FALL_LIFE) {
        gOn[g] = 0;
        falling--;
      }
    }
  };

  let currentType: PlantType = PLANTS.ivy;

  return {
    segData,
    segKind,
    segUsed,
    dirtyLo,
    dirtyHi,
    plantData,
    active,
    leafCount,
    crowd: grid,
    get plants() {
      return plants;
    },
    get spawned() {
      return spawned;
    },
    get falling() {
      return falling;
    },
    get leafSprites() {
      return leafSprites;
    },
    get flowerSprites() {
      return flowerSprites;
    },
    resize(w) {
      if (w === refWidth) {
        return;
      }
      refWidth = w;
      // Rebuild the density grid at the new world positions.
      grid.fill(0);
      for (let p = 0; p < MAX_PLANTS; p++) {
        if (!active[p]) {
          continue;
        }
        const xOff = anchor[p] * refWidth;
        for (let k = 0; k < segUsed[p]; k++) {
          const slot = p * PLANT_SEGS + k;
          if (segCell[slot] < 0) {
            continue;
          }
          const o = slot * SEG_FLOATS;
          const cell = cellOf(segData[o + 2] + xOff, segData[o + 3]);
          segCell[slot] = cell;
          if (grid[cell] < 65535) {
            grid[cell]++;
          }
        }
      }
    },
    spawn,
    step(dt, f) {
      if (!(dt > 0)) {
        dt = 0;
      }
      time += dt;
      border = clamp(f.border, 0, 1);
      currentType = f.type;
      const pdt = dt * Math.max(0, f.growth);
      const density = clamp(Math.round(f.density), 0, MAX_PLANTS);

      spawnTimer -= pdt;
      if (plants < density && spawnTimer <= 0) {
        spawn(f);
        spawnTimer = SPAWN_GAP + rng() * SPAWN_GAP_RANGE;
      }

      for (let p = 0; p < MAX_PLANTS; p++) {
        if (!active[p]) {
          continue;
        }
        age[p] += pdt;
        const a = age[p];
        if (growing[p]) {
          const alive = grow(p, pdt, f);
          if (a >= growDur[p] || alive === 0) {
            endGrowth(p);
          }
        }
        const ws = witherStart[p];
        if (a >= ws) {
          if (!witherInit[p]) {
            // Oldest leaves wither first, with some spread.
            witherInit[p] = 1;
            for (let k = 0; k < leafCount[p]; k++) {
              const j = p * PLANT_LEAVES + k;
              lWither[j] = clamp(0.65 * (lb[j] / endGrow[p]) + 0.35 * rng(), 0, 1);
            }
          }
          for (let k = 0; k < leafCount[p]; k++) {
            const j = p * PLANT_LEAVES + k;
            if (lOn[j] && a >= ws + lWither[j] * WITHER_SPREAD + YELLOW) {
              drop(p, j, currentType);
            }
          }
          if (a >= ws + RETIRE_AFTER) {
            retire(p);
            continue;
          }
        }
        const o = p * PLANT_FLOATS;
        plantData[o] = anchor[p] * refWidth;
        plantData[o + 1] = a;
        // Before withering `ws` is Infinity, so `a - ws` is -Infinity.
        plantData[o + 2] = 1 - clamp((a - ws - STEM_FADE_START) / STEM_FADE, 0, 1);
        plantData[o + 3] = clamp((a - ws) / (WITHER_SPREAD + YELLOW), 0, 1);
      }
      stepFalling(dt);
    },
    clearDirty() {
      dirtyLo.fill(PLANT_SEGS);
      dirtyHi.fill(-1);
    },
    writeSprites(data, stride, spinOffset, scale, type) {
      let n = 0;
      // Attached leaves.
      for (let p = 0; p < MAX_PLANTS; p++) {
        if (!active[p]) {
          continue;
        }
        const a = age[p];
        const ws = witherStart[p];
        const xOff = anchor[p] * refWidth;
        for (let k = 0; k < leafCount[p]; k++) {
          const j = p * PLANT_LEAVES + k;
          if (!lOn[j]) {
            continue;
          }
          const g = leafGrow((a - lb[j]) / LEAF_GROW);
          if (g <= 0) {
            continue;
          }
          const w = a >= ws ? witherCurve((a - ws - lWither[j] * WITHER_SPREAD) / YELLOW) : 0;
          leafColor(j, type, w);
          const o = n * stride;
          data[o] = (lx[j] + xOff) * scale;
          data[o + 1] = ly[j] * scale;
          data[o + 2] = lr[j] * (0.12 + 0.88 * g) * scale;
          data[o + 3] = 1;
          data[o + 4] = rgbOut[0];
          data[o + 5] = rgbOut[1];
          data[o + 6] = rgbOut[2];
          // Unfolding: the leaf opens out (flip) and swings out from the stem.
          data[o + spinOffset] =
            la[j] + lFlip[j] * (1 - g) * 0.6 + 0.05 * Math.sin(time * 0.8 + lPhase[j]);
          data[o + spinOffset + 1] = lFlip[j] * (0.2 + 0.8 * g);
          n++;
        }
      }
      // Falling leaves, in front of the attached ones.
      for (let g = 0; g < MAX_FALLING; g++) {
        if (!gOn[g]) {
          continue;
        }
        const t = gAge[g];
        const psi = t * gRate[g];
        const c = Math.cos(t * gFlipRate[g]);
        const flip = c < 0 ? Math.min(c, -0.06) : Math.max(c, 0.06);
        const light = 0.6 + 0.4 * Math.abs(c);
        const o = n * stride;
        data[o] = (gx[g] + swayOffset(psi) * FALL_SWAY) * scale;
        data[o + 1] = gy[g] * scale;
        data[o + 2] = gr[g] * scale;
        data[o + 3] = 1 - smoothstep(FALL_LIFE - 3, FALL_LIFE, t);
        data[o + 4] = gRgb[g * 3] * light;
        data[o + 5] = gRgb[g * 3 + 1] * light;
        data[o + 6] = gRgb[g * 3 + 2] * light;
        data[o + spinOffset] = ga[g] + gSpin[g] * t + 0.45 * (swayTilt(psi) - 1);
        data[o + spinOffset + 1] = gFlip[g] * flip;
        n++;
      }
      leafSprites = n;
      // Flowers, or racemes of florets hanging below their stem point.
      const florets = type.raceme ? RACEME : 1;
      const pal = type.flowerPalette;
      for (let p = 0; p < MAX_PLANTS; p++) {
        if (!active[p]) {
          continue;
        }
        const a = age[p];
        const fade = 1 - witherCurve((a - witherStart[p]) / 6);
        if (fade <= 0) {
          continue;
        }
        const xOff = anchor[p] * refWidth;
        for (let k = 0; k < flowerCount[p]; k++) {
          const j = p * PLANT_FLOWERS + k;
          const rgb = pal[Math.floor(fPick[j] * pal.length) % pal.length];
          const sway = Math.sin(time * 0.5 + fPick[j] * 20);
          for (let q = 0; q < florets; q++) {
            const open = leafGrow((a - fb[j] - q * 0.6) / FLOWER_OPEN) * fade;
            if (open <= 0) {
              continue;
            }
            const r = fr[j] * (1 - 0.09 * q);
            const lighten = 0.07 * q;
            const o = n * stride;
            data[o] = (fx[j] + xOff + sway * q * 0.6) * scale;
            data[o + 1] = (fy[j] + (type.raceme ? (q + 0.8) * fr[j] * 1.3 : 0)) * scale;
            data[o + 2] = r * (0.2 + 0.8 * open) * scale;
            data[o + 3] = Math.min(1, open * 2);
            data[o + 4] = rgb[0] + (1 - rgb[0]) * lighten;
            data[o + 5] = rgb[1] + (1 - rgb[1]) * lighten;
            data[o + 6] = rgb[2] + (1 - rgb[2]) * lighten;
            data[o + spinOffset] = fa[j] + q * 1.3 + sway * 0.05;
            data[o + spinOffset + 1] = 0.35 + 0.65 * open;
            n++;
          }
        }
      }
      flowerSprites = n - leafSprites;
      return n;
    },
  };
}
