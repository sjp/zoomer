/**
 * Pure JS logic for Frost Ferns (`frost.ts`): the seeded fern growth that builds
 * the arrival-time field, the coverage and melt terms the shader applies to it,
 * and the blurred scene behind the glass. Nothing here touches GL.
 *
 * **The field** is a reduced-resolution grid (`FIELD_ROWS` rows, square texels)
 * holding two values per texel:
 *
 * - R, the arrival time (0..1, see `growth.ts`): when the frost reaches the texel.
 *   Unreached texels hold `NEVER`.
 * - G, the edge metric `m` (`edgeMetric`): 0 at the centre, 1 on the frame edges,
 *   more in the corners. The shader uses it for the coverage limit and to melt
 *   from the centre.
 *
 * **Growth** is a small event-driven L-system: fern fronds start on the frame
 * edges and corners at staggered times and grow inward; every few texels a frond
 * puts out side branches at about 60 degrees, alternating sides, whose length
 * tapers toward the frond's tip, and those put out short needles in turn. Tips
 * are advanced in arrival order (a binary heap), and a tip stops when it reaches
 * ice that another branch laid down first, leaves the frame or crosses the
 * coverage limit. A child starts at its parent's arrival time at the branch
 * point. A soft frost sheet along the edges, densest in the corners, fills in
 * behind the fronds.
 *
 * **Rasterising**: each skeleton segment stamps a capsule into the field whose
 * arrival is the skeleton's arrival plus a thickening term, so a branch appears
 * as a thin line and widens to its full width over `THICKEN`. Past the full
 * width the arrival climbs steeply, so the visible edge stays sharp under
 * bilinear filtering.
 */
import { finishBuild, type BuildSteps } from "../rebuild";
import { clamp } from "../math";
import { createNoise, createRng, hash32 } from "../noise";

// --- Field ------------------------------------------------------------------

/** Field rows (texels per frame height): one texel per 3 px at 1080p. */
export const FIELD_ROWS = 360;
/** Arrival of texels the frost never reaches (above any reveal threshold). */
export const NEVER = 2;
/** Latest skeleton arrival after normalising, leaving room to thicken before level 1. */
export const ARRIVAL_FILL = 0.9;
/** Arrival time a branch takes to widen from a line to its full width. */
export const THICKEN = 0.06;
/** Arrival per texel beyond a branch's full width: the steep outer edge. */
export const FALLOFF = 1;

/** Exponent of the superellipse edge metric. */
export const METRIC_POWER = 2.5;
/** Largest edge metric, in the corners: 2^(1/p). */
export const METRIC_MAX = Math.pow(2, 1 / METRIC_POWER);
/**
 * Smallest edge metric the frost may reach, at coverage 1. The centre third of the
 * frame (|2u - 1| and |2v - 1| both below 1/3) has m <= 0.44, so it stays clear.
 */
export const REACH_MIN = 0.5;
/** The frost's reach at coverage 0: a thin rim along the edges. */
export const REACH_MAX = 0.96;
/** Arrival added per unit of edge metric past the coverage limit (tapers branches out). */
export const REACH_PENALTY = 8;
/** Melt bias per unit of edge metric: the centre melts first. */
export const MELT_RADIAL = 0.8;
/** Largest melt bias, for `meltOffset`. */
export const MAX_MELT_BIAS = MELT_RADIAL * METRIC_MAX;

/** Field size for a frame of this aspect (width / height). */
export function fieldSize(aspect: number, rows = FIELD_ROWS): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? clamp(aspect, 0.25, 6) : 16 / 9;
  return { width: Math.max(8, Math.round(rows * a)), height: rows };
}

/**
 * Edge metric at normalised position (u, v), each 0..1 across the frame: a
 * superellipse, 0 at the centre and 1 at the middle of each edge, rising to
 * `METRIC_MAX` in the corners, so the frost reaches further in there.
 */
export function edgeMetric(u: number, v: number): number {
  const x = Math.abs(2 * u - 1);
  const y = Math.abs(2 * v - 1);
  return Math.pow(Math.pow(x, METRIC_POWER) + Math.pow(y, METRIC_POWER), 1 / METRIC_POWER);
}

/** The smallest edge metric the frost reaches at `coverage` (0..1). */
export function reachLimit(coverage: number): number {
  const c = Number.isFinite(coverage) ? clamp(coverage, 0, 1) : 0.75;
  return REACH_MAX + (REACH_MIN - REACH_MAX) * c;
}

/** The arrival the shader compares: past the coverage limit it climbs steeply. */
export function effectiveArrival(arrival: number, metric: number, limit: number): number {
  return arrival + REACH_PENALTY * Math.max(0, limit - metric);
}

/** The seed for one growth cycle: a new pattern each cycle, the same for the same inputs. */
export function cycleSeed(seed: number, cycle: number): number {
  return hash32(Math.imul(Math.floor(seed), 0x9e3779b1) ^ hash32(cycle + 0x51ed));
}

// --- Growth -----------------------------------------------------------------

/** Branch depths: fronds, side branches, needles. */
export const MAX_DEPTH = 2;
/** Step length in texels. */
const STEP = 1;
/** Full half-width in texels by depth (at a branch's base; tips taper to half). */
export const HALF_WIDTH = [1.25, 0.7, 0.42] as const;
/** Clearance in texels: a tip stops when other ice is this close. */
const CLEARANCE = [3, 2.4, 1.8] as const;
/** Steps a new tip takes before it checks for other ice (it starts on its parent). */
const GRACE = 4;
/** Arrival (before normalising) per frame height of growth, by depth: children grow slower. */
const SLOWNESS = [1, 1.7, 2.6] as const;
/** Spacing of side branches along a branch, in frame heights, by parent depth. */
const SIDE_SPACING = [0.02, 0.0095] as const;
/** Side branch length: this fraction of the parent's remaining length, plus a base. */
const SIDE_RATIO = [0.42, 0.38] as const;
const SIDE_BASE = [0.012, 0.004] as const;
const SIDE_MAX = [0.1, 0.024] as const;
/** Side branch angle off the parent's heading, and its jitter (radians). */
const SIDE_ANGLE = (60 * Math.PI) / 180;
const SIDE_JITTER = (7 * Math.PI) / 180;
/** Chance per frame height that a frond forks into a second frond. */
const FORK_RATE = 2.2;
/** Random heading jitter per step, and the largest steady curl (radians per frame height). */
const WOBBLE = 0.035;
const CURL = 1.2;
/** Hard caps, so a pathological seed can't run away. */
const MAX_BRANCHES = 40000;
const MAX_STEPS = 400000;

/** One branch of the skeleton: a polyline with an arrival time at each point. */
export interface FrostBranch {
  /** Index of the parent branch, or -1 for a root frond. */
  parent: number;
  depth: number;
  /** Parent's arrival at the branch point (normalised); the root's start for a root. */
  parentArrival: number;
  /** Points as x, y (texels, origin at the field's corner) and arrival, flattened. */
  points: number[];
}

export interface FrostSkeleton {
  width: number;
  height: number;
  branches: FrostBranch[];
}

interface Tip {
  branch: number;
  x: number;
  y: number;
  heading: number;
  a: number;
  /** Remaining length in texels. */
  left: number;
  /** Texels until the next side branch. */
  nextSide: number;
  side: number;
  curl: number;
  steps: number;
}

/** A binary min-heap of tips keyed on arrival (deterministic: no ties depend on timing). */
class TipHeap {
  private items: Tip[] = [];
  get size() {
    return this.items.length;
  }
  private less(i: number, j: number) {
    return this.items[i].a < this.items[j].a;
  }
  private swap(i: number, j: number) {
    const t = this.items[i];
    this.items[i] = this.items[j];
    this.items[j] = t;
  }
  push(tip: Tip) {
    this.items.push(tip);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) {
        break;
      }
      this.swap(i, p);
      i = p;
    }
  }
  pop(): Tip {
    const top = this.items[0];
    const last = this.items.length - 1;
    this.swap(0, last);
    this.items.pop();
    let i = 0;
    const n = this.items.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) {
        m = l;
      }
      if (r < n && this.less(r, m)) {
        m = r;
      }
      if (m === i) {
        break;
      }
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/**
 * Grows the fern skeleton for `seed` on a `width` x `height` field. Arrival times
 * are normalised so the latest point arrives at `ARRIVAL_FILL`. Deterministic.
 */
export function growFrost(seed: number, width: number, height: number): FrostSkeleton {
  return finishBuild(growFrostSteps(seed, width, height));
}

/** Tip steps between yields of `growFrostSteps`. */
const GROW_CHUNK = 512;

/** `growFrost` as build steps, yielding every `GROW_CHUNK` tip steps. */
export function* growFrostSteps(
  seed: number,
  width: number,
  height: number,
): BuildSteps<FrostSkeleton> {
  const rng = createRng(seed);
  const H = height;
  const owner = new Int32Array(width * height).fill(-1);
  const branches: FrostBranch[] = [];
  const heap = new TipHeap();
  const limit = REACH_MIN;

  const addBranch = (
    parent: number,
    depth: number,
    x: number,
    y: number,
    heading: number,
    a: number,
    length: number,
  ) => {
    if (branches.length >= MAX_BRANCHES || length < 1.5) {
      return;
    }
    const id = branches.length;
    branches.push({ parent, depth, parentArrival: a, points: [x, y, a] });
    heap.push({
      branch: id,
      x,
      y,
      heading,
      a,
      left: length,
      nextSide: depth < MAX_DEPTH ? SIDE_SPACING[depth] * H * (0.3 + 0.5 * rng()) : Infinity,
      side: rng() < 0.5 ? 1 : -1,
      curl: ((rng() * 2 - 1) * CURL) / H,
      steps: 0,
    });
  };

  // Roots: fronds along each edge, heading inward, and a fan from each corner.
  const edge = (
    x0: number,
    y0: number,
    dx: number,
    dy: number,
    len: number,
    nx: number,
    ny: number,
  ) => {
    const spacing = 0.13 * H;
    let s = spacing * rng() * 0.6;
    while (s < len) {
      const x = x0 + dx * s;
      const y = y0 + dy * s;
      const heading = Math.atan2(ny, nx) + (rng() * 2 - 1) * 0.6;
      addBranch(-1, 0, x, y, heading, rng() * 0.08, H * (0.22 + 0.3 * rng()));
      s += spacing * (0.65 + 0.7 * rng());
    }
  };
  const inset = 0.5;
  edge(inset, inset, 1, 0, width, 0, 1);
  edge(inset, height - inset, 1, 0, width, 0, -1);
  edge(inset, inset, 0, 1, height, 1, 0);
  edge(width - inset, inset, 0, 1, height, -1, 0);
  for (const [cx, cy] of [
    [inset, inset],
    [width - inset, inset],
    [inset, height - inset],
    [width - inset, height - inset],
  ]) {
    const diag = Math.atan2(height / 2 - cy, width / 2 - cx);
    const n = 2 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      const off = (k / (n - 1) - 0.5) * 0.9 + (rng() * 2 - 1) * 0.1;
      addBranch(-1, 0, cx, cy, diag + off, rng() * 0.03, H * (0.4 + 0.25 * rng()));
    }
  }

  const step = STEP;
  let steps = 0;
  while (heap.size > 0 && steps < MAX_STEPS) {
    steps++;
    if (steps % GROW_CHUNK === 0) {
      yield;
    }
    const tip = heap.pop();
    const b = branches[tip.branch];
    const depth = b.depth;
    tip.heading += tip.curl * step + (rng() * 2 - 1) * WOBBLE;
    const nx = tip.x + Math.cos(tip.heading) * step;
    const ny = tip.y + Math.sin(tip.heading) * step;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
      continue;
    }
    if (edgeMetric(nx / width, ny / height) < limit) {
      continue;
    }
    tip.steps++;
    if (
      tip.steps > GRACE &&
      blocked(owner, branches, width, nx, ny, CLEARANCE[depth], tip.branch)
    ) {
      continue;
    }
    tip.x = nx;
    tip.y = ny;
    tip.a += (SLOWNESS[depth] * step) / H;
    tip.left -= step;
    b.points.push(nx, ny, tip.a);
    owner[Math.floor(ny) * width + Math.floor(nx)] = tip.branch;

    if (depth < MAX_DEPTH) {
      tip.nextSide -= step;
      if (tip.nextSide <= 0) {
        // Alternate sides, half the spacing apart, so each side gets one per spacing.
        tip.nextSide += SIDE_SPACING[depth] * H * (0.4 + 0.2 * rng());
        tip.side = -tip.side;
        const len =
          Math.min(SIDE_MAX[depth], SIDE_BASE[depth] + (SIDE_RATIO[depth] * tip.left) / H) *
          H *
          (0.75 + 0.5 * rng());
        const angle = tip.heading + tip.side * (SIDE_ANGLE + (rng() * 2 - 1) * SIDE_JITTER);
        addBranch(tip.branch, depth + 1, nx, ny, angle, tip.a, len);
      }
    }
    if (depth === 0 && rng() < (FORK_RATE * step) / H && tip.left > 0.08 * H) {
      const sign = rng() < 0.5 ? 1 : -1;
      addBranch(
        tip.branch,
        0,
        nx,
        ny,
        tip.heading + sign * (0.45 + 0.25 * rng()),
        tip.a,
        tip.left * 0.75,
      );
    }
    if (tip.left > 0) {
      heap.push(tip);
    }
  }

  // Normalise arrivals so the latest point arrives at ARRIVAL_FILL.
  let maxA = 0;
  for (const b of branches) {
    for (let i = 2; i < b.points.length; i += 3) {
      maxA = Math.max(maxA, b.points[i]);
    }
  }
  const k = maxA > 0 ? ARRIVAL_FILL / maxA : 1;
  for (const b of branches) {
    b.parentArrival *= k;
    for (let i = 2; i < b.points.length; i += 3) {
      b.points[i] *= k;
    }
  }
  return { width, height, branches };
}

/**
 * Whether ice laid by another branch lies within `r` texels of (x, y). The branch's
 * own ice, its parent's and its children's don't count: they meet at branch points.
 */
function blocked(
  owner: Int32Array,
  branches: readonly FrostBranch[],
  width: number,
  x: number,
  y: number,
  r: number,
  self: number,
): boolean {
  const height = owner.length / width;
  const parent = branches[self].parent;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(width - 1, Math.floor(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(height - 1, Math.floor(y + r));
  const r2 = r * r;
  for (let j = y0; j <= y1; j++) {
    const dy = j + 0.5 - y;
    for (let i = x0; i <= x1; i++) {
      const o = owner[j * width + i];
      if (o < 0 || o === self || o === parent || branches[o].parent === self) {
        continue;
      }
      const dx = i + 0.5 - x;
      if (dx * dx + dy * dy <= r2) {
        return true;
      }
    }
  }
  return false;
}

// --- Rasterising ------------------------------------------------------------

/** Depth of the edge sheet in frame heights, its extra depth in the corners, and its noise. */
const SHEET_DEPTH = 0.014;
const SHEET_CORNER = 0.07;
const SHEET_NOISE = 0.012;
/** Corner influence radius in frame heights. */
const SHEET_CORNER_RADIUS = 0.55;
/** Sheet arrival at the very edge, and the extra arrival to its full depth. */
const SHEET_START = 0.12;
const SHEET_SPAN = 0.6;
/** How far the hard clip sits inside the reach limit (in edge-metric units). */
const CLIP_MARGIN = 0.03;

/**
 * Stamps one tapered capsule segment into `arrival` (one float per texel), keeping
 * the earlier arrival per texel: `a + THICKEN * d / w` inside the half-width `w`,
 * then climbing by `FALLOFF` per texel.
 */
export function stampSegment(
  arrival: Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  a0: number,
  w0: number,
  x1: number,
  y1: number,
  a1: number,
  w1: number,
): void {
  const reach = Math.max(w0, w1) + (1 + THICKEN) / FALLOFF;
  const i0 = Math.max(0, Math.floor(Math.min(x0, x1) - reach));
  const i1 = Math.min(width - 1, Math.floor(Math.max(x0, x1) + reach));
  const j0 = Math.max(0, Math.floor(Math.min(y0, y1) - reach));
  const j1 = Math.min(height - 1, Math.floor(Math.max(y0, y1) + reach));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const inv = len2 > 1e-12 ? 1 / len2 : 0;
  for (let j = j0; j <= j1; j++) {
    const py = j + 0.5 - y0;
    for (let i = i0; i <= i1; i++) {
      const px = i + 0.5 - x0;
      const t = clamp((px * dx + py * dy) * inv, 0, 1);
      const ex = px - dx * t;
      const ey = py - dy * t;
      const d = Math.hypot(ex, ey);
      const w = w0 + (w1 - w0) * t;
      const a = a0 + (a1 - a0) * t;
      const v = d <= w ? a + (THICKEN * d) / w : a + THICKEN + (d - w) * FALLOFF;
      const k = j * width + i;
      if (v < arrival[k]) {
        arrival[k] = v;
      }
    }
  }
}

/** Half-width at arc length `s` of a branch `len` long: full at the base, half at the tip. */
export function branchHalfWidth(depth: number, s: number, len: number): number {
  const f = len > 0 ? clamp(s / len, 0, 1) : 0;
  return HALF_WIDTH[Math.min(MAX_DEPTH, depth)] * (1 - 0.5 * f);
}

export interface FrostField {
  width: number;
  height: number;
  /** RG per texel, row 0 first: arrival, edge metric. Upload as RG16F. */
  data: Float32Array;
  skeleton: FrostSkeleton;
}

/** Builds the full field for `seed` (see the module comment). Deterministic. */
export function buildFrostField(seed: number, width: number, height: number): FrostField {
  return finishBuild(buildFrostFieldSteps(seed, width, height));
}

/** Branches stamped, and field rows finished, between yields of `buildFrostFieldSteps`. */
const STAMP_CHUNK = 24;
const ROW_CHUNK = 16;

/**
 * `buildFrostField` as build steps, so the effect can spread a build over many
 * frames: every chunk of growth, of branches stamped and of rows finished yields.
 */
export function* buildFrostFieldSteps(
  seed: number,
  width: number,
  height: number,
): BuildSteps<FrostField> {
  const skeleton = yield* growFrostSteps(seed, width, height);
  const n = width * height;
  const arrival = new Float32Array(n).fill(NEVER);

  let stamped = 0;
  for (const b of skeleton.branches) {
    if (++stamped % STAMP_CHUNK === 0) {
      yield;
    }
    const p = b.points;
    let len = 0;
    for (let i = 3; i < p.length; i += 3) {
      len += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
    }
    let s = 0;
    let w0 = branchHalfWidth(b.depth, 0, len);
    for (let i = 3; i < p.length; i += 3) {
      s += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
      const w1 = branchHalfWidth(b.depth, s, len);
      stampSegment(
        arrival,
        width,
        height,
        p[i - 3],
        p[i - 2],
        p[i - 1],
        w0,
        p[i],
        p[i + 1],
        p[i + 2],
        w1,
      );
      w0 = w1;
    }
  }

  // The edge sheet, and the edge metric with the hard clip.
  const noise = createNoise(seed ^ 0x5eed);
  const H = height;
  const maxDepth = SHEET_DEPTH + SHEET_CORNER + SHEET_NOISE + (1 + THICKEN) / (FALLOFF * H);
  const data = new Float32Array(n * 2);
  for (let j = 0; j < height; j++) {
    if (j % ROW_CHUNK === ROW_CHUNK - 1) {
      yield;
    }
    const y = j + 0.5;
    const v = y / height;
    for (let i = 0; i < width; i++) {
      const x = i + 0.5;
      const k = j * width + i;
      const m = edgeMetric(x / width, v);
      let a = arrival[k];
      const e = Math.min(x, width - x, y, height - y) / H;
      if (e < maxDepth) {
        const cx = Math.min(x, width - x) / H;
        const cy = Math.min(y, height - y) / H;
        const c = Math.max(0, 1 - Math.hypot(cx, cy) / SHEET_CORNER_RADIUS);
        const nz = noise.noise2(x / (0.09 * H), y / (0.09 * H));
        const depth = Math.max(0.006, SHEET_DEPTH + SHEET_CORNER * c * c + SHEET_NOISE * nz);
        const fine = noise.noise2(x / (0.025 * H) + 31.7, y / (0.025 * H) - 17.3);
        const sheet =
          SHEET_START +
          (SHEET_SPAN * Math.min(e, depth)) / depth +
          Math.max(0, e - depth) * H * FALLOFF +
          0.05 * fine;
        if (sheet < a) {
          a = sheet;
        }
      }
      if (m < REACH_MIN - CLIP_MARGIN) {
        a = NEVER;
      }
      data[k * 2] = Math.max(0, Math.min(NEVER, a));
      data[k * 2 + 1] = m;
    }
  }
  return { width, height, data, skeleton };
}

// --- The scene behind the glass ----------------------------------------------

/** Most bokeh lights and trees the scene shader takes. */
export const MAX_LIGHTS = 12;
export const MAX_TREES = 10;

const WARM = ["#ffb35c", "#ffcf7a", "#ff9447", "#ffd9a0", "#ffc069"] as const;
const COOL = "#cfe0ff";

export interface SceneLayout {
  /** Per light: x (0..1 across), y (0..1 up), radius (frame heights), intensity. */
  lights: Float32Array;
  /** Per light: sRGB colour, 0..1. */
  lightColors: Float32Array;
  lightCount: number;
  /**
   * Per tree, far to near: x (0..1 across), base y (0..1 up), height (frame
   * heights), distance (0 near, 1 far).
   */
  trees: Float32Array;
  treeCount: number;
}

function unitHex(hex: string, out: Float32Array, o: number): void {
  const v = Number.parseInt(hex.slice(1), 16);
  out[o] = ((v >> 16) & 255) / 255;
  out[o + 1] = ((v >> 8) & 255) / 255;
  out[o + 2] = (v & 255) / 255;
}

/** The blurred scene for a `scene` select value and seed. Unknown scenes are plain. */
export function sceneLayout(scene: string, seed: number): SceneLayout {
  const rng = createRng(hash32(seed + 0x5ce4e));
  const lights = new Float32Array(MAX_LIGHTS * 4);
  const lightColors = new Float32Array(MAX_LIGHTS * 3);
  const trees = new Float32Array(MAX_TREES * 4);
  let lightCount = 0;
  let treeCount = 0;
  const light = (x: number, y: number, r: number, intensity: number, color: string) => {
    if (lightCount >= MAX_LIGHTS) {
      return;
    }
    lights.set([x, y, r, intensity], lightCount * 4);
    unitHex(color, lightColors, lightCount * 3);
    lightCount++;
  };

  if (scene === "lights") {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.15 + 0.7 * rng()) / n;
      const y = 0.1 + 0.4 * rng() * rng();
      const cool = rng() < 0.15;
      light(
        x,
        y,
        0.025 + 0.04 * rng(),
        0.35 + 0.55 * rng(),
        cool ? COOL : WARM[Math.floor(rng() * WARM.length)],
      );
    }
  } else if (scene === "trees") {
    // Drawn in order, so sort far to near.
    const list: number[][] = [];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const far = rng();
      const x = (i + 0.1 + 0.8 * rng()) / n;
      list.push([x, 0.08 + 0.1 * far, (0.42 - 0.22 * far) * (0.8 + 0.4 * rng()), far]);
    }
    list.sort((a, b) => b[3] - a[3]);
    for (const t of list) {
      trees.set(t, treeCount++ * 4);
    }
    for (let i = 0; i < 3; i++) {
      light((i + 0.2 + 0.6 * rng()) / 3, 0.1 + 0.06 * rng(), 0.02 + 0.015 * rng(), 0.3, WARM[i]);
    }
  }
  return { lights, lightColors, lightCount, trees, treeCount };
}
