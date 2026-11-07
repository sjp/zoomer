/**
 * Pure JS side of Star Trails (startrails.ts): the trail lookup over the shared
 * ring-and-sector star layout (`starfield-sim.ts`; a JS twin of the shader's
 * cell lookup), the trail profile, the pole positions and the foreground
 * silhouette. Nothing here touches GL.
 *
 * Coordinates: reference pixels of a 1080-tall frame, y up. Around the pole a
 * pixel has radius `r` and a sky angle `phi` (its screen angle minus the sky's
 * rotation, in [0, 2π)). The plane is split into rings `RING_WIDTH` wide; ring
 * `ring` is split into `n` equal sectors, and each (ring, sector) cell holds at
 * most one star. A star's head sits at sky angle `a0`; its trail covers the sky
 * angles `[a0 - L, a0]` behind it, so it trails the counter-clockwise rotation.
 *
 * Loop bound: sectors are never narrower than `L / (SECTORS_CHECKED - 1)` (see
 * `maxSectors`). A trail reaching a pixel in sector `j` has its head at most `L`
 * ahead, so its cell is one of sectors `j .. j + ceil(L / s)`, which is at most
 * `SECTORS_CHECKED` sectors. Stars sit inside their ring with a margin wider than
 * their half-width plus anti-aliasing, so no trail crosses into another ring, and
 * a pixel checks only its own ring.
 */
import { buildHills, HILL_COLUMNS, type HillShape, hillHeightAt } from "../horizon/horizon-sim";
import { clamp, smoothstep } from "../math";
import { createRng } from "../noise";
import { MAX_LAYERS, MIN_LAYERS } from "../horizon/horizon.meta";
import {
  cellStar,
  createStar,
  EDGE_AA,
  RING_WIDTH,
  sectorCount,
  type Star,
  TAU,
} from "../starfield-sim";

// ---------------------------------------------------------------------------
// Trails (the star layout itself is in starfield-sim.ts)
// ---------------------------------------------------------------------------

/** Sectors a pixel checks: its own and the next ones ahead. */
export const SECTORS_CHECKED = 3;
/** Arc length (reference px) over which each end of a trail fades in. */
export const END_TAPER = 1.5;
/** Comet style: tail weight (fading to 0 at the tail), head boost and its arc length (reference px). */
export const COMET_TAIL = 0.9;
export const COMET_HEAD = 1.2;
export const HEAD_LENGTH = 8;
/** Upper bound of `tailProfile`. */
export const PROFILE_MAX = COMET_TAIL + COMET_HEAD;

/**
 * Most sectors a ring may have for trails `trailLength` radians long: sectors
 * are at least `trailLength / (SECTORS_CHECKED - 1)` wide, which bounds the loop.
 */
export function maxSectors(trailLength: number): number {
  return Math.max(1, Math.floor(((SECTORS_CHECKED - 1) * TAU) / trailLength));
}

/**
 * Trail brightness profile at `delta` radians behind the head of a trail
 * `length` radians long, on a circle of `radius` reference px. 0 outside
 * (0, length); both ends fade in over `END_TAPER` px of arc, so it is
 * continuous. Comet style adds a bright head and a tail fading to nothing.
 * In [0, PROFILE_MAX].
 */
export function tailProfile(delta: number, length: number, radius: number, comet: boolean): number {
  if (!(delta > 0 && delta < length)) {
    return 0;
  }
  const arcHead = delta * radius;
  const ends =
    smoothstep(0, END_TAPER, arcHead) * smoothstep(0, END_TAPER, (length - delta) * radius);
  if (!comet) {
    return ends;
  }
  const t = 1 - delta / length;
  return ends * (COMET_TAIL * t * t + COMET_HEAD * 2 ** (-arcHead / HEAD_LENGTH));
}

/** Radial coverage of a trail of `halfWidth` at `dist` reference px from its centre line. */
export const radialCoverage = (dist: number, halfWidth: number) =>
  1 - smoothstep(halfWidth - EDGE_AA, halfWidth + EDGE_AA, Math.abs(dist));

export interface TrailSettings {
  /** Radians. */
  length: number;
  density: number;
  salt: number;
  comet: boolean;
}

const scratch = createStar();

/** One star's contribution (brightness x profile x coverage) at (r, phi), `delta` behind its head. */
function contribution(star: Star, r: number, delta: number, s: TrailSettings): number {
  if (!star.occupied) {
    return 0;
  }
  const cov = radialCoverage(r - star.radius, star.halfWidth);
  return cov > 0 ? star.bright * cov * tailProfile(delta, s.length, star.radius, s.comet) : 0;
}

/**
 * Summed trail brightness at radius `r` and sky angle `phi` (in [0, 2π]), the
 * way the shader computes it: only `SECTORS_CHECKED` sectors of the pixel's ring.
 */
export function trailsAt(r: number, phi: number, s: TrailSettings): number {
  const ring = Math.floor(r / RING_WIDTH);
  const n = sectorCount(ring, maxSectors(s.length));
  const sector = TAU / n;
  const x = phi / sector;
  const j = Math.floor(x);
  const f = x - j;
  let sum = 0;
  for (let i = 0; i < SECTORS_CHECKED; i++) {
    const star = cellStar(ring, j + i, n, s.density, s.salt, scratch);
    sum += contribution(star, r, (i + star.u - f) * sector, s);
  }
  return sum;
}

/** Reference for tests: every cell of every ring, with the angle difference wrapped. */
export function trailsAtBruteForce(r: number, phi: number, s: TrailSettings): number {
  const cap = maxSectors(s.length);
  let sum = 0;
  const ring0 = Math.floor(r / RING_WIDTH);
  for (let ring = Math.max(0, ring0 - 1); ring <= ring0 + 1; ring++) {
    const n = sectorCount(ring, cap);
    for (let k = 0; k < n; k++) {
      const star = cellStar(ring, k, n, s.density, s.salt, scratch);
      let delta = (star.angle - phi) % TAU;
      if (delta < 0) {
        delta += TAU;
      }
      sum += contribution(star, r, delta, s);
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Pole
// ---------------------------------------------------------------------------

export const POLES = {
  topLeft: [0.14, 0.86],
  topRight: [0.86, 0.86],
  above: [0.5, 1.2],
  centre: [0.5, 0.6],
} as const satisfies Record<string, readonly [number, number]>;

export type PoleId = keyof typeof POLES;

const isPoleId = (v: string): v is PoleId => Object.hasOwn(POLES, v);

/** Pole position in reference px (y up) for a frame `refWidth` wide; unknown ids fall back to top right. */
export function polePosition(pole: string, refWidth: number, out: [number, number]) {
  const [fx, fy] = isPoleId(pole) ? POLES[pole] : POLES.topRight;
  out[0] = fx * refWidth;
  out[1] = fy * 1080;
  return out;
}

// ---------------------------------------------------------------------------
// Foreground
// ---------------------------------------------------------------------------

export type ForegroundKind = "treeline" | "mountains" | "tree" | "none";
export const FOREGROUND_KINDS: readonly ForegroundKind[] = [
  "treeline",
  "mountains",
  "tree",
  "none",
];

/** Columns of the silhouette table across the width (fine enough for conifer tips). */
export const FG_COLUMNS = 2048;
/** Circles in the lone tree's crown. */
export const TREE_BLOBS = 6;

interface GroundStyle {
  shape: HillShape;
  /** Added to the front hill's height, fraction of the frame height. */
  lift: number;
}

const GROUND: Record<Exclude<ForegroundKind, "none">, GroundStyle> = {
  treeline: { shape: { amp: 0.5, ridge: 0, freq: 0.7 }, lift: -0.04 },
  mountains: { shape: { amp: 2.4, ridge: 0.85, freq: 1.2 }, lift: 0.05 },
  tree: { shape: { amp: 0.9, ridge: 0, freq: 0.5 }, lift: -0.03 },
};

const isGroundKind = (v: string): v is keyof typeof GROUND => Object.hasOwn(GROUND, v);

/** The lone tree, in reference px (y up). */
export interface LoneTree {
  /** x, y, radius per crown circle. */
  blobs: Float32Array;
  /** Trunk centre x, bottom y, top y, half-width. */
  trunk: Float32Array;
  /** Bounding box x0, y0, x1, y1, padded for anti-aliasing. */
  box: Float32Array;
}

export const createLoneTree = (): LoneTree => ({
  blobs: new Float32Array(TREE_BLOBS * 3),
  trunk: new Float32Array(4),
  box: new Float32Array(4),
});

/** Crown circle offsets (x, y) and radii as fractions of the tree height, before jitter. */
const CROWN = [
  [0, 0.12, 0.2],
  [-0.24, -0.02, 0.16],
  [0.25, 0.01, 0.17],
  [-0.12, 0.2, 0.15],
  [0.14, 0.22, 0.15],
  [0.02, -0.08, 0.16],
] as const;

/**
 * Fills `out` (`FG_COLUMNS` floats) with the silhouette height (fraction of the
 * frame height) at x = column / (FG_COLUMNS - 1) of the width, for a frame
 * `refWidth` reference px wide. The ground is the front row of `buildHills`;
 * the treeline adds conifers (taller at the sides). For "tree", fills `tree` and
 * returns true. "none" zeroes `out`. Deterministic for a seed.
 */
export function buildForeground(
  out: Float32Array,
  kind: string,
  seed: number,
  refWidth: number,
  tree: LoneTree,
): boolean {
  out.fill(0);
  if (!isGroundKind(kind)) {
    return false;
  }
  const style = GROUND[kind];
  const profiles = new Float32Array(MAX_LAYERS * HILL_COLUMNS);
  const lo = new Float64Array(MAX_LAYERS);
  const hi = new Float64Array(MAX_LAYERS);
  buildHills(profiles, MIN_LAYERS, seed, style.shape, lo, hi);
  const front = MIN_LAYERS - 1;
  const last = FG_COLUMNS - 1;
  for (let c = 0; c < FG_COLUMNS; c++) {
    out[c] = hillHeightAt(profiles, front, c / last) + style.lift;
  }
  const w = Math.max(1, refWidth);
  const rand = createRng(Math.floor(seed) * 977 + 31);

  if (kind === "treeline") {
    // Conifers as triangles over the ground, in reference px, sunk a little into it.
    const ground = Float32Array.from(out);
    for (let x = -20 + rand() * 10; x < w + 20; x += 5 + rand() * 12) {
      const side = Math.abs(x / w - 0.5) * 2;
      const h = (22 + rand() * 40) * (0.6 + 0.8 * side) * (rand() < 0.15 ? 1.4 : 1);
      const half = h * (0.2 + rand() * 0.08);
      const c0 = Math.max(0, Math.ceil(((x - half) / w) * last));
      const c1 = Math.min(last, Math.floor(((x + half) / w) * last));
      const baseAt = ground[clamp(Math.round((x / w) * last), 0, last)] - 4 / 1080;
      for (let c = c0; c <= c1; c++) {
        const dx = Math.abs((c / last) * w - x);
        out[c] = Math.max(out[c], baseAt + (h * (1 - dx / half)) / 1080);
      }
    }
    return false;
  }

  if (kind === "tree") {
    const fx = rand() < 0.5 ? 0.17 : 0.83;
    const x = fx * w;
    const groundY = hillHeightAt(profiles, front, fx) * 1080 + style.lift * 1080;
    const h = 250 + rand() * 60;
    const crownY = groundY + h * 0.66;
    const b = tree.blobs;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < TREE_BLOBS; i++) {
      const [ox, oy, or] = CROWN[i];
      const bx = x + (ox + (rand() - 0.5) * 0.05) * h;
      const by = crownY + (oy + (rand() - 0.5) * 0.05) * h;
      const br = (or + (rand() - 0.5) * 0.03) * h;
      b[i * 3] = bx;
      b[i * 3 + 1] = by;
      b[i * 3 + 2] = br;
      x0 = Math.min(x0, bx - br);
      x1 = Math.max(x1, bx + br);
      y1 = Math.max(y1, by + br);
    }
    const t = tree.trunk;
    t[0] = x;
    t[1] = groundY - 12;
    t[2] = crownY;
    t[3] = 6 + h * 0.012;
    const pad = 2;
    tree.box[0] = Math.min(x0, x - t[3]) - pad;
    tree.box[1] = t[1] - pad;
    tree.box[2] = Math.max(x1, x + t[3]) + pad;
    tree.box[3] = y1 + pad;
    return true;
  }
  return false;
}
