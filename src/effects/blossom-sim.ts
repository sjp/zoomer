/**
 * Blossom branch's simulation, kept free of GL so it can be tested: the seeded
 * branch generator (a main branch and recursive twigs as tapering segments, kept
 * in a top corner), blossoms, buds and leaves attached along the twigs, the sway
 * (a rotation per segment from the shared swell in `sway.ts`, lagging with depth
 * and compounding towards the tips), the petal shedding schedule and the faint
 * out-of-focus tree behind.
 *
 * Branches are built in corner space: x in reference px (1 = 1080 device-independent
 * pixels) inwards from the side edge, y down from the top. Writers mirror the
 * right-hand branch onto the screen.
 */
import type { Rgb } from "./color";
import type { SpawnPoint } from "./leaves-sim";
import { SHAPE_PETAL, SHAPE_ROUND_PETAL, type Season } from "./leaves-sim";
import { createRng } from "./noise";
import { createSwell, swayAt, type Swell } from "./sway";
import type { BlossomId, CornerId, SkyId } from "./blossom.meta";

const TAU = Math.PI * 2;

/**
 * The breeze: a 10 s main period, a 12 s partner and a faint 5 s flutter,
 * repeating every 60 s.
 */
export const BREEZE_SWELL: Swell = createSwell(60, [
  { cycles: 6, amplitude: 1, offset: 0 },
  { cycles: 5, amplitude: 0.5, offset: 0.29 },
  { cycles: 12, amplitude: 0.2, offset: 0.63 },
]);

/** The corner region a branch stays in, reference px inwards from the side and down from the top. */
export const REGION_W = 620;
export const REGION_H = 440;
/** Twig ends keep at least this far inside the region, leaving room for blossoms and sway. */
const REGION_MARGIN = 40;
/** Highest a twig may reach: a little above the top edge, out of frame. */
const REGION_TOP = -30;

/** Most segments per branch. */
export const MAX_SEGMENTS_PER_BRANCH = 160;
/** Most blossoms (buds and leaves included) across the whole scene, one branch or both. */
export const MAX_BLOSSOMS = 360;
/** Blossoms per branch at density 1. */
export const BLOSSOMS_PER_BRANCH = 140;

/** Rotation per segment (radians) at breeze 1, by depth: the main branch barely moves. */
export const DEPTH_GAIN = [0.008, 0.04, 0.055, 0.065] as const;
/** Seconds of lag per level of depth, so the twigs trail the branch they grow from. */
export const LAG_PER_DEPTH = 0.45;

/** What sits on a twig. */
export const KIND_BLOSSOM = 0;
export const KIND_BUD = 1;
export const KIND_LEAF = 2;

export interface Segment {
  /** Index of the segment this one grows from (it starts at that one's end), or -1 for a root. */
  readonly parent: number;
  /** 0 for the main branch, 1 for its twigs, and so on. */
  readonly depth: number;
  /** 0 for the left-hand corner, 1 for the right (mirrored). */
  readonly side: number;
  /** Rest pose in corner space: start, end, direction (radians, y down) and length. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly angle: number;
  readonly length: number;
  /** Half thickness at the start and end, reference px. */
  readonly r0: number;
  readonly r1: number;
  /** Sway lag (seconds) and gain (radians at breeze 1). */
  readonly lag: number;
  readonly gain: number;
  /** True when no segment grows from this one's end. */
  readonly tip: boolean;
}

export interface Blossom {
  readonly segment: number;
  /** Position along the segment, 0..1, and offset across it (reference px, + = the segment's left). */
  readonly t: number;
  readonly across: number;
  readonly radius: number;
  readonly spin: number;
  readonly kind: number;
  /** Colour pick, 0..1. */
  readonly tone: number;
  /** Extra lag for the blossom's own flutter, seconds. */
  readonly lag: number;
}

export interface Scene {
  readonly segments: readonly Segment[];
  readonly blossoms: readonly Blossom[];
  /** Indices of the open blossoms (the ones that shed petals). */
  readonly open: readonly number[];
}

// --- Generation -------------------------------------------------------------

/** Whether a segment ending at (x, y) with half thickness `r` stays inside the region. */
const fits = (x: number, y: number, r: number) =>
  x + r <= REGION_W - REGION_MARGIN && y + r <= REGION_H - REGION_MARGIN && y >= REGION_TOP;

interface MutableSegment {
  parent: number;
  depth: number;
  side: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  angle: number;
  length: number;
  r0: number;
  r1: number;
  lag: number;
  gain: number;
  tip: boolean;
}

/** Per depth: segments in a chain (min, max), segment length (min, max), end thickness, fork chance. */
const CHAIN = [
  { segs: [6, 6], len: [78, 96], rEnd: 4.5, fork: 0.95 },
  { segs: [3, 5], len: [40, 60], rEnd: 1.8, fork: 0.75 },
  { segs: [2, 3], len: [26, 40], rEnd: 1.3, fork: 0.5 },
  { segs: [1, 2], len: [18, 28], rEnd: 1, fork: 0 },
] as const;

/**
 * Builds one branch for `side` from `seed`: a main branch entering from the
 * corner and up to three levels of twigs forking from its joints, every segment
 * no thicker than the one it grows from, and every end inside the corner region.
 * Parents always come before their children.
 */
export function buildBranch(seed: number, side: number): Segment[] {
  const rng = createRng(seed);
  const segs: MutableSegment[] = [];
  const range = (r: readonly [number, number]) => r[0] + rng() * (r[1] - r[0]);

  /** Grows a chain from (x, y); returns the indices of its segments. */
  const chain = (
    parent: number,
    depth: number,
    x: number,
    y: number,
    angle: number,
    r0: number,
    bend: number,
  ): number[] => {
    const spec = CHAIN[depth];
    const n = Math.round(range(spec.segs));
    const out: number[] = [];
    const jitter = rng() * 0.3;
    let r = r0;
    for (let k = 0; k < n && segs.length < MAX_SEGMENTS_PER_BRANCH; k++) {
      const length = range(spec.len) * (1 - 0.08 * k);
      // Branches curve gently upwards, towards the light.
      angle += bend + (rng() - 0.5) * 0.28;
      const x1 = x + Math.cos(angle) * length;
      const y1 = y + Math.sin(angle) * length;
      const r1 = Math.min(r, r0 + (spec.rEnd - r0) * ((k + 1) / n));
      if (!fits(x1, y1, r1)) break;
      const parentOf: number = k === 0 ? parent : out[k - 1];
      segs.push({
        parent: parentOf,
        depth,
        side,
        x0: x,
        y0: y,
        x1,
        y1,
        angle,
        length,
        r0: r,
        r1,
        lag: LAG_PER_DEPTH * depth + 0.12 * k + jitter,
        gain: DEPTH_GAIN[depth] * (0.8 + 0.4 * rng()),
        tip: true,
      });
      if (parentOf >= 0) segs[parentOf].tip = false;
      out.push(segs.length - 1);
      x = x1;
      y = y1;
      r = r1;
    }
    return out;
  };

  /** Forks twigs from the joints of a chain, recursively. */
  const fork = (indices: readonly number[], depth: number) => {
    if (depth >= CHAIN.length) return;
    const chance = CHAIN[depth - 1].fork;
    // Every joint but the chain's own tip, alternating up and down with some randomness.
    let up = rng() < 0.5;
    for (let k = 0; k < indices.length - 1; k++) {
      if (rng() >= chance) continue;
      const s = segs[indices[k]];
      up = rng() < 0.75 ? !up : up;
      const turn = (0.45 + rng() * 0.45) * (up ? -1 : 1);
      const r0 = Math.min(s.r1 * 0.7, CHAIN[depth - 1].rEnd + 3);
      const twig = chain(indices[k], depth, s.x1, s.y1, s.angle + turn, r0, -0.05);
      fork(twig, depth + 1);
    }
  };

  // The main branch enters just off the side edge, heading inwards and a little down.
  const main = chain(-1, 0, -30, 30 + rng() * 80, 0.18 + rng() * 0.2, 15 + rng() * 3, -0.035);
  fork(main, 1);
  return segs;
}

/**
 * Blossoms per branch for a corner choice and density: `BLOSSOMS_PER_BRANCH`
 * times the density, with "Both" splitting `MAX_BLOSSOMS` between its two branches.
 */
export function blossomBudget(corner: CornerId, density: number): number {
  const branches = corner === "both" ? 2 : 1;
  const want = Math.round(BLOSSOMS_PER_BRANCH * (Number.isFinite(density) ? density : 1));
  return Math.max(0, Math.min(want, Math.floor(MAX_BLOSSOMS / branches)));
}

/**
 * Places `count` blossoms, buds and leaves along the twigs of `segments` (from
 * index `first` on), denser towards the tips: a segment's share grows with its
 * depth and doubles at a tip, and positions along it lean towards its end.
 */
export function placeBlossoms(
  segments: readonly Segment[],
  count: number,
  seed: number,
  first = 0,
): Blossom[] {
  const rng = createRng(seed);
  const weights: number[] = [];
  let total = 0;
  for (let i = first; i < segments.length; i++) {
    const s = segments[i];
    // The main branch only flowers towards its far end.
    const depthWeight = s.depth === 0 ? (s.tip ? 0.6 : 0.08) : [0, 1, 1.4, 1.8][s.depth];
    total += s.length * depthWeight * (s.tip ? 2 : 1);
    weights.push(total);
  }
  const out: Blossom[] = [];
  if (!(total > 0)) return out;
  for (let n = 0; n < count; n++) {
    const pick = rng() * total;
    let k = 0;
    while (k < weights.length - 1 && weights[k] <= pick) k++;
    const segment = first + k;
    const s = segments[segment];
    const t = Math.pow(rng(), 0.6);
    const roll = rng();
    const kind = roll < 0.1 ? KIND_BUD : roll < 0.2 ? KIND_LEAF : KIND_BLOSSOM;
    const radius =
      kind === KIND_BLOSSOM ? 9 + rng() * 5 : kind === KIND_BUD ? 3.5 + rng() * 1.5 : 7 + rng() * 3;
    const thick = s.r0 + (s.r1 - s.r0) * t;
    const across = (rng() < 0.5 ? -1 : 1) * (thick + radius * (0.15 + rng() * 0.6));
    out.push({
      segment,
      t,
      across,
      radius,
      spin: rng() * TAU,
      kind,
      tone: rng(),
      lag: rng() * 0.8,
    });
  }
  return out;
}

/**
 * The whole scene for a corner choice: one branch per corner (the second from a
 * different seed, so "Both" isn't a mirror image) with the density's blossoms,
 * never more than `MAX_BLOSSOMS` in all. Blossoms use their own random stream,
 * so changing the density leaves the branches as they were.
 */
export function buildScene(corner: CornerId, seed: number, density: number): Scene {
  const sides = corner === "both" ? [0, 1] : corner === "topRight" ? [1] : [0];
  const budget = blossomBudget(corner, density);
  const segments: Segment[] = [];
  const blossoms: Blossom[] = [];
  const base = Math.floor(seed) * 7919;
  for (const side of sides) {
    const first = segments.length;
    for (const s of buildBranch(base + side * 104729 + 1, side)) {
      segments.push({ ...s, parent: s.parent < 0 ? -1 : s.parent + first });
    }
    blossoms.push(...placeBlossoms(segments, budget, base + side * 104729 + 2, first));
  }
  const open: number[] = [];
  blossoms.forEach((b, i) => {
    if (b.kind === KIND_BLOSSOM) open.push(i);
  });
  return { segments, blossoms, open };
}

// --- Sway -------------------------------------------------------------------

/** A segment's own rotation (radians) at swell `phase` and `breeze` (0..1). */
export const segmentAngle = (s: Segment, phase: number, breeze: number) =>
  breeze * s.gain * swayAt(BREEZE_SWELL, phase, s.lag);

/** The posed scene, written by `poseScene`; preallocate with `createPose`. */
export interface Pose {
  /** Per segment, corner space: start, end, and the rotation accumulated from the root. */
  readonly sx: Float64Array;
  readonly sy: Float64Array;
  readonly ex: Float64Array;
  readonly ey: Float64Array;
  readonly turn: Float64Array;
  /** Per blossom, screen reference px: centre and in-plane angle. */
  readonly bx: Float64Array;
  readonly by: Float64Array;
  readonly bspin: Float64Array;
}

export function createPose(segments: number, blossoms: number): Pose {
  return {
    sx: new Float64Array(segments),
    sy: new Float64Array(segments),
    ex: new Float64Array(segments),
    ey: new Float64Array(segments),
    turn: new Float64Array(segments),
    bx: new Float64Array(blossoms),
    by: new Float64Array(blossoms),
    bspin: new Float64Array(blossoms),
  };
}

/**
 * Poses the scene at swell `phase` and `breeze`: each segment turns by its own
 * angle plus everything above it, about the end of the segment it grows from, so
 * the motion compounds and lags towards the tips. Blossoms ride their segments
 * with a little flutter of their own, and land in screen reference px for a
 * frame `refWidth` wide. Allocates nothing.
 */
export function poseScene(
  scene: Scene,
  phase: number,
  breeze: number,
  refWidth: number,
  pose: Pose,
): void {
  const { segments, blossoms } = scene;
  const { sx, sy, ex, ey, turn } = pose;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const p = s.parent;
    const a = (p >= 0 ? turn[p] : 0) + segmentAngle(s, phase, breeze);
    const x = p >= 0 ? ex[p] : s.x0;
    const y = p >= 0 ? ey[p] : s.y0;
    turn[i] = a;
    sx[i] = x;
    sy[i] = y;
    ex[i] = x + Math.cos(s.angle + a) * s.length;
    ey[i] = y + Math.sin(s.angle + a) * s.length;
  }
  for (let j = 0; j < blossoms.length; j++) {
    const b = blossoms[j];
    const i = b.segment;
    const s = segments[i];
    const dx = (ex[i] - sx[i]) / s.length;
    const dy = (ey[i] - sy[i]) / s.length;
    // Left of the direction of travel, in y-down space.
    const x = sx[i] + dx * s.length * b.t + dy * b.across;
    const y = sy[i] + dy * s.length * b.t - dx * b.across;
    const flutter = 0.25 * breeze * swayAt(BREEZE_SWELL, phase, s.lag + b.lag);
    const spin = b.spin + turn[i] + flutter;
    pose.bx[j] = s.side === 1 ? refWidth - x : x;
    pose.by[j] = y;
    pose.bspin[j] = s.side === 1 ? -spin : spin;
  }
}

// --- Colours ----------------------------------------------------------------

const hex = (h: string): Rgb => {
  const n = Number.parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export interface Sky {
  readonly top: Rgb;
  readonly bottom: Rgb;
  /** Bark colour, a little lifted towards the sky's light. */
  readonly bark: Rgb;
}

export const SKIES: Readonly<Record<SkyId, Sky>> = {
  morning: { top: hex("#94bfe6"), bottom: hex("#eef2f4"), bark: hex("#3d2d27") },
  haze: { top: hex("#d5dbe2"), bottom: hex("#f6f0ea"), bark: hex("#4a3d38") },
  dusk: { top: hex("#a99bc4"), bottom: hex("#f3c6bf"), bark: hex("#3a2630") },
};

export interface BlossomPalette {
  /** Petal colours, the bud colour, and the pale centre. */
  readonly petals: readonly Rgb[];
  readonly bud: Rgb;
  readonly centre: Rgb;
}

export const BLOSSOM_PALETTES: Readonly<Record<BlossomId, BlossomPalette>> = {
  pink: {
    petals: ["#f7c4d3", "#f9d3de", "#f2b2c6"].map(hex),
    bud: hex("#e27f9f"),
    centre: hex("#fff3e6"),
  },
  white: {
    petals: ["#fdf6f7", "#f8eaee", "#ffffff"].map(hex),
    bud: hex("#f0bccb"),
    centre: hex("#fbf3dc"),
  },
  deep: {
    petals: ["#ec8fae", "#e8799f", "#f2a3bc"].map(hex),
    bud: hex("#c94f7a"),
    centre: hex("#fde0e6"),
  },
};

/** Fresh young leaves. */
export const LEAF_GREEN: Rgb = hex("#8fb565");

/** Falling-petal seasons (see `leaves-sim.ts`) in each blossom colour. */
export const PETAL_SEASONS: Readonly<Record<BlossomId, Season>> = (() => {
  const season = (p: BlossomPalette): Season => ({
    shapes: [SHAPE_PETAL, SHAPE_ROUND_PETAL],
    vein: false,
    palette: p.petals,
    backShade: 0.93,
    sizeMul: 1,
    countMul: 1,
    top: "#ffffff",
    bottom: "#ffffff",
    foliage: [],
  });
  return {
    pink: season(BLOSSOM_PALETTES.pink),
    white: season(BLOSSOM_PALETTES.white),
    deep: season(BLOSSOM_PALETTES.deep),
  };
})();

// --- Instance writers ---------------------------------------------------------

/** Floats per segment instance: start x, y, end x, y (device px); r0, r1 (device px), shade, bark seed. */
export const SEGMENT_FLOATS = 8;

/** Writes the posed segments, mirrored onto the screen, to `data`. Returns how many. */
export function writeSegments(
  scene: Scene,
  pose: Pose,
  refWidth: number,
  scale: number,
  data: Float32Array,
): number {
  const { segments } = scene;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const flip = s.side === 1;
    const o = i * SEGMENT_FLOATS;
    data[o] = (flip ? refWidth - pose.sx[i] : pose.sx[i]) * scale;
    data[o + 1] = pose.sy[i] * scale;
    data[o + 2] = (flip ? refWidth - pose.ex[i] : pose.ex[i]) * scale;
    data[o + 3] = pose.ey[i] * scale;
    data[o + 4] = s.r0 * scale;
    data[o + 5] = s.r1 * scale;
    // Thin twigs are a touch lighter and redder than the old wood.
    data[o + 6] = 1 + 0.08 * s.depth;
    data[o + 7] = (i * 0.618034) % 1;
  }
  return segments.length;
}

/** Floats per blossom instance: x, y, radius (device px), spin; r, g, b, kind. */
export const BLOSSOM_FLOATS = 8;

/** Writes the posed blossoms, buds and leaves to `data`. Returns how many. */
export function writeBlossoms(
  scene: Scene,
  pose: Pose,
  palette: BlossomPalette,
  scale: number,
  data: Float32Array,
): number {
  const { blossoms } = scene;
  const petals = palette.petals;
  for (let j = 0; j < blossoms.length; j++) {
    const b = blossoms[j];
    const o = j * BLOSSOM_FLOATS;
    data[o] = pose.bx[j] * scale;
    data[o + 1] = pose.by[j] * scale;
    data[o + 2] = b.radius * scale;
    data[o + 3] = pose.bspin[j];
    const rgb =
      b.kind === KIND_LEAF
        ? LEAF_GREEN
        : b.kind === KIND_BUD
          ? palette.bud
          : petals[Math.min(petals.length - 1, Math.floor(b.tone * petals.length))];
    data[o + 4] = rgb[0];
    data[o + 5] = rgb[1];
    data[o + 6] = rgb[2];
    data[o + 7] = b.kind;
  }
  return blossoms.length;
}

// --- Shedding -----------------------------------------------------------------

/** Shed petals waiting for a free piece; more are dropped rather than burst out later. */
export const MAX_PENDING = 4;

export interface Shedder {
  /** Petals due but not yet taken. */
  readonly pending: number;
  /** Advances `dt` seconds at `rate` petals per second (a Poisson process). */
  advance(dt: number, rate: number): void;
  /** Takes one due petal, if any. */
  take(): boolean;
}

/**
 * A Poisson shedding schedule: the wait between petals is exponential with mean
 * `1 / rate`, measured in rate-scaled time so a rate change takes effect smoothly.
 */
export function createShedder(seed: number): Shedder {
  const rng = createRng(seed);
  const wait = () => -Math.log(1 - rng());
  let clock = 0;
  let next = wait();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    advance(dt, rate) {
      if (!(dt > 0) || !(rate > 0) || !Number.isFinite(dt * rate)) return;
      clock += dt * rate;
      while (clock >= next) {
        clock -= next;
        next = wait();
        if (pending < MAX_PENDING) pending++;
      }
    },
    take() {
      if (pending <= 0) return false;
      pending--;
      return true;
    },
  };
}

/**
 * The spawn callback for `createPieces`: takes a due petal from `shedder` and
 * starts it at a random open blossom of `state`'s current scene and pose. The far depth layer
 * is declined, since the petals come from a branch in front.
 */
export function createPetalSource(
  shedder: Shedder,
  seed: number,
  state: { readonly scene: Scene; readonly pose: Pose },
): (out: SpawnPoint, layer: number) => boolean {
  const rng = createRng(seed);
  return (out, layer) => {
    if (layer === 0) return false;
    const { scene, pose } = state;
    if (scene.open.length === 0 || !shedder.take()) return false;
    const j = scene.open[Math.floor(rng() * scene.open.length)];
    out.x = pose.bx[j];
    out.y = pose.by[j];
    return true;
  };
}

// --- Background tree ----------------------------------------------------------

/** Floats per backdrop blob: x, y, radius (device px), opacity; r, g, b. */
export const BACKDROP_FLOATS = 7;

/**
 * The faint, out-of-focus tree far behind: x as a fraction of the width in from
 * its side, y as a fraction of the height, radius in reference px, and 0 for
 * trunk or 1 for canopy.
 */
const BACKDROP = [
  [0.1, 1.02, 70, 0],
  [0.105, 0.86, 58, 0],
  [0.11, 0.72, 50, 0],
  [0.1, 0.5, 190, 1],
  [0.02, 0.58, 160, 1],
  [0.2, 0.55, 170, 1],
  [0.13, 0.38, 150, 1],
  [0.25, 0.68, 120, 1],
  [-0.02, 0.4, 140, 1],
  [0.06, 0.7, 130, 1],
] as const;
export const MAX_BACKDROP = BACKDROP.length;

/**
 * Writes the backdrop tree on `side` (0 = left, 1 = right), breathing slowly
 * with `time`, tinted from the sky towards the blossom and bark colours.
 * Returns how many blobs.
 */
export function writeBackdrop(
  data: Float32Array,
  side: number,
  time: number,
  refWidth: number,
  scale: number,
  sky: Sky,
  palette: BlossomPalette,
): number {
  const haze = sky.bottom;
  const bloom = palette.petals[0];
  for (let b = 0; b < BACKDROP.length; b++) {
    const [fx, fy, r, canopy] = BACKDROP[b];
    const x = side === 1 ? refWidth * (1 - fx) : refWidth * fx;
    const o = b * BACKDROP_FLOATS;
    const drift = canopy ? Math.sin(time * (0.07 + b * 0.009) + b * 1.3) * 6 : 0;
    data[o] = (x + drift) * scale;
    data[o + 1] = fy * 1080 * scale;
    data[o + 2] = r * scale;
    data[o + 3] = canopy ? 0.45 : 0.3;
    const tint = canopy ? bloom : sky.bark;
    const mix = canopy ? 0.45 : 0.3;
    for (let k = 0; k < 3; k++) data[o + 4 + k] = haze[k] + (tint[k] - haze[k]) * mix;
  }
  return BACKDROP.length;
}
