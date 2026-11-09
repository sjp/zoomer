/**
 * Pure JS side of the Lenia effect (lenia.ts): the species' parameters, the
 * convolution kernel and its tap table, the growth function, seeding, the
 * palettes, the life cycle (fade in, live, fade out and reseed), and a CPU twin
 * of one simulation step that documents the shader's maths.
 *
 * Lenia (Bert Wang-Chak Chan, "Lenia: Biology of Artificial Life", Complex
 * Systems 28(3), 2019) is a continuous cellular automaton. The state A is a field
 * of values in [0, 1] on a wrapping grid. Each step:
 *
 *   U = K * A                                (K a smooth ring kernel of radius R, sum 1)
 *   A <- clamp(A + dt * G(U), 0, 1)          (G(u) = 2 exp(-(u - mu)^2 / (2 sigma^2)) - 1)
 *
 * The kernel is the "exponential" kernel core of the paper (kn = 1),
 * K_C(r) = exp(4 - 1 / (r (1 - r))) for 0 < r < 1, a bump peaking at r = 1/2,
 * and the growth function its Gaussian (gn = 1). With several peaks b_i, the
 * radius is split into rings, ring i weighted by b_i.
 *
 * Species parameters: only the published numeric parameters (R, T, b, mu, sigma)
 * are used, from the species table that accompanies the paper (`animals.json`
 * in https://github.com/Chakazul/Lenia, Python/animals.json). No pattern arrays
 * ("cells") are copied: creatures grow from generated seeds (see `SEED_SHAPES`).
 *
 * The grid is GRID_W cells across whatever the screen size, so a creature
 * (about 20 cells long at R = 13) is the same fraction of the frame at any
 * resolution, about 150 px at 1080p.
 */
import { clamp } from "../math";
import { buildGradientLut } from "../color";
import { createRng } from "../noise";
import { lookup } from "../lookup";
import type { PALETTE_OPTIONS, SPECIES_OPTIONS } from "./lenia.meta";

export { type StepClock, takeSteps } from "../step-clock";

/** Grid cells across the frame. */
export const GRID_W = 256;
/** Grid height limits, for very tall or very wide frames. */
export const MIN_GRID_H = 64;
export const MAX_GRID_H = 256;
/** Simulation steps per second at speed 1; the effect never runs more than one a frame. */
export const MAX_STEP_RATE = 60;

/** Grid size for a canvas: GRID_W across, square cells. Written to `out`. */
export function gridSize(
  width: number,
  height: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const aspect = height > 0 && width > 0 ? height / width : 9 / 16;
  out[0] = GRID_W;
  out[1] = clamp(Math.round(GRID_W * aspect), MIN_GRID_H, MAX_GRID_H);
  return out;
}

/** One Lenia rule: published numeric parameters. */
export interface Rule {
  /** Name and code in the Lenia species table. */
  name: string;
  /** Kernel radius in cells. */
  R: number;
  /** Time resolution: dt = 1 / T. */
  T: number;
  /** Kernel ring peaks. */
  b: readonly number[];
  /** Growth centre. */
  mu: number;
  /** Growth width. */
  sigma: number;
}

/**
 * Rules used here, from Python/animals.json in https://github.com/Chakazul/Lenia
 * (Chan 2019). All share R = 13, T = 10, b = [1] and the exponential kernel and
 * Gaussian growth (kn = gn = 1), so they share one tap table and differ only in
 * mu and sigma.
 */
export const RULES = {
  /** O2u, the classic glider. */
  orbium: { name: "Orbium unicaudatus (O2u)", R: 13, T: 10, b: [1], mu: 0.15, sigma: 0.015 },
  /** OG2g, a glider that turns in circles. */
  gyrans: { name: "Gyrorbium gyrans (OG2g)", R: 13, T: 10, b: [1], mu: 0.156, sigma: 0.0224 },
  /** OG2r, a glider that circles back on itself. */
  revolvens: {
    name: "Gyrorbium revolvens (OG2r)",
    R: 13,
    T: 10,
    b: [1],
    mu: 0.133,
    sigma: 0.0177,
  },
} as const satisfies Record<string, Rule>;
export type RuleId = keyof typeof RULES;

/** The kernel radius every rule shares (the tap table is built once). */
export const KERNEL_R = 13;
/** The kernel peaks every rule shares. */
export const KERNEL_B: readonly number[] = [1];

export type SpeciesId = (typeof SPECIES_OPTIONS)[number]["value"];

/**
 * What each species option runs: the rules it cycles through (the next one on
 * each reseed, and every MIXED_SECONDS when there are several) and whether it
 * seeds random soup instead of creatures. "Rotators" runs the Gyrorbium rules;
 * gyrans has no generated seed that forms, so it runs as soup (see
 * PATCH_SEEDS). "Mixed" keeps to the rules that form creatures.
 */
export const SPECIES = {
  orbium: { rules: ["orbium"], soup: false },
  mixed: { rules: ["orbium", "revolvens"], soup: false },
  rotators: { rules: ["revolvens", "gyrans"], soup: false },
  soup: { rules: ["orbium"], soup: true },
} as const satisfies Record<SpeciesId, { rules: readonly RuleId[]; soup: boolean }>;

export function speciesFor(id: string): (typeof SPECIES)[SpeciesId] {
  return lookup(SPECIES, id, "mixed");
}

/** The kernel core, a smooth bump on (0, 1) peaking at 1 for r = 1/2. */
export function kernelCore(r: number): number {
  return r <= 0 || r >= 1 ? 0 : Math.exp(4 - 1 / (r * (1 - r)));
}

/** The unnormalised kernel shell at normalised radius r (0..1) for peaks `b`. */
export function kernelShell(r: number, b: readonly number[]): number {
  if (r <= 0 || r >= 1) {
    return 0;
  }
  const br = r * b.length;
  const i = Math.floor(br);
  return b[i] * kernelCore(br - i);
}

/** The growth function: 1 at u = mu, falling to -1 far from it. */
export function growth(u: number, mu: number, sigma: number): number {
  const d = u - mu;
  return 2 * Math.exp(-(d * d) / (2 * sigma * sigma)) - 1;
}

/**
 * The kernel as the shader samples it: a list of horizontal tap pairs over half
 * the disc, each read with one bilinear fetch on either side of the cell.
 *
 * K is point-symmetric (K(-d) = K(d)), so U = sum over half the disc of
 * w(d) * (A(p + d) + A(p - d)). Within each row of that half, neighbouring
 * cells (dx, dy) and (dx + 1, dy) with weights w1 and w2 are read together with
 * one linear-filtered fetch at dx + w2 / (w1 + w2), weighted w1 + w2; the
 * mirrored pair is then exactly the fetch at -(dx + w2 / (w1 + w2), dy). A row
 * with an odd number of cells ends with a single (w2 = 0). This halves the
 * fetches twice over: about 133 fetches of each sign for R = 13, against 528
 * cells in the disc.
 */
export interface TapTable {
  /** Pairs. */
  count: number;
  /** Per pair: x offset (fractional), y offset, weight. */
  data: Float32Array;
}

/** Builds the tap table for radius R and peaks b, normalised so the full kernel sums to 1. */
export function buildTaps(R: number, b: readonly number[]): TapTable {
  const pairs: number[] = [];
  let total = 0;
  for (let dy = 0; dy <= R; dy++) {
    // Cells of this row in the half disc: dy > 0 takes the whole row, dy = 0 the right half.
    const row: [number, number][] = [];
    for (let dx = dy === 0 ? 1 : -R; dx <= R; dx++) {
      const w = kernelShell(Math.hypot(dx, dy) / R, b);
      if (w > 0) {
        row.push([dx, w]);
      }
    }
    for (let i = 0; i < row.length; i += 2) {
      const [x1, w1] = row[i];
      const next = row.at(i + 1);
      // Only cells next to each other can share a fetch (the shell is contiguous per row).
      if (next?.[0] === x1 + 1) {
        const w = w1 + next[1];
        pairs.push(x1 + next[1] / w, dy, w);
        total += w;
      } else {
        pairs.push(x1, dy, w1);
        total += w1;
        if (next) {
          i--;
        }
      }
    }
  }
  const data = new Float32Array(pairs);
  // Each pair is read at +d and -d, so the full kernel sums to 2 * total.
  for (let i = 2; i < data.length; i += 3) {
    data[i] /= 2 * total;
  }
  return { count: data.length / 3, data };
}

/** The shared tap table (all rules have R = KERNEL_R, b = KERNEL_B). */
export const TAPS = buildTaps(KERNEL_R, KERNEL_B);

/** Largest representable 16-bit state value: the GPU stores A in two bytes. */
const Q16 = 65535;
export const quantise16 = (v: number) => Math.round(clamp(v, 0, 1) * Q16) / Q16;

/**
 * Reads A at fractional (x, y), linearly filtered between whole cells along x,
 * wrapping, as the shader's `texture()` reads it. `fracBits` > 0 rounds the
 * filter weight to that many bits, as GPU texture units do (8 on most).
 */
function sampleX(A: Float32Array, w: number, h: number, x: number, y: number, fracBits: number) {
  const x0 = Math.floor(x);
  let f = x - x0;
  if (fracBits > 0) {
    const s = 1 << fracBits;
    f = Math.round(f * s) / s;
  }
  const row = (((y % h) + h) % h) * w;
  const a = A[row + (((x0 % w) + w) % w)];
  if (f === 0) {
    return a;
  }
  const b = A[row + ((((x0 + 1) % w) + w) % w)];
  return a + (b - a) * f;
}

/** U = K * A at cell (x, y), via the tap table, as the step shader computes it. */
export function potential(
  A: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number,
  taps: TapTable,
  fracBits = 0,
): number {
  const d = taps.data;
  let u = 0;
  for (let i = 0; i < taps.count; i++) {
    const ox = d[i * 3];
    const oy = d[i * 3 + 1];
    u +=
      d[i * 3 + 2] *
      (sampleX(A, w, h, x + ox, y + oy, fracBits) + sampleX(A, w, h, x - ox, y - oy, fracBits));
  }
  return u;
}

/** Settings for one CPU step. */
export interface StepOptions {
  /** Round the result to 16 bits, as the GPU stores it. */
  quantise?: boolean;
  /** Filter weight bits (see `sampleX`); 0 for exact. */
  fracBits?: number;
}

/**
 * One Lenia step on a `w` x `h` wrapping grid, the CPU twin of the step shader in
 * lenia.ts: out = clamp(A + G(K * A) / T, 0, 1). `A` is read, `out` written.
 */
export function leniaStep(
  A: Float32Array,
  out: Float32Array,
  w: number,
  h: number,
  rule: Rule,
  taps: TapTable = TAPS,
  opts: StepOptions = {},
): void {
  const dt = 1 / rule.T;
  const fracBits = opts.fracBits ?? 0;
  // `potential` for every cell, unrolled: each fetch (a tap at +d or -d) has the
  // same whole-cell offset and filter weight at every cell.
  const n = taps.count * 2;
  const ox = new Int32Array(n);
  const oy = new Int32Array(n);
  const fr = new Float64Array(n);
  const wt = new Float64Array(n);
  const rows = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i & 1 ? -1 : 1;
    const t = i >> 1;
    const x = s * taps.data[t * 3];
    ox[i] = Math.floor(x);
    fr[i] = x - ox[i];
    if (fracBits > 0) {
      fr[i] = Math.round(fr[i] * (1 << fracBits)) / (1 << fracBits);
    }
    oy[i] = s * taps.data[t * 3 + 1];
    wt[i] = taps.data[t * 3 + 2];
  }
  for (let y = 0; y < h; y++) {
    for (let i = 0; i < n; i++) {
      rows[i] = ((((y + oy[i]) % h) + h) % h) * w;
    }
    for (let x = 0; x < w; x++) {
      let u = 0;
      for (let i = 0; i < n; i++) {
        let x0 = x + ox[i];
        if (x0 < 0) {
          x0 += w;
        } else if (x0 >= w) {
          x0 -= w;
        }
        const x1 = x0 + 1 === w ? 0 : x0 + 1;
        const a = A[rows[i] + x0];
        u += wt[i] * (a + (A[rows[i] + x1] - a) * fr[i]);
      }
      const v = clamp(A[y * w + x] + dt * growth(u, rule.mu, rule.sigma), 0, 1);
      out[y * w + x] = opts.quantise === true ? quantise16(v) : v;
    }
  }
}

/** Total of A. */
export function mass(A: Float32Array): number {
  let m = 0;
  for (const a of A) {
    m += a;
  }
  return m;
}

/**
 * Centre of mass on the wrapping grid, in cells: each axis is the angle of the
 * mass-weighted mean of points on a circle, so a creature straddling an edge
 * still has its centre on it. Writes [x, y] to `out`.
 */
export function centreOfMass(A: Float32Array, w: number, h: number, out: Float64Array): void {
  let sx = 0;
  let cx = 0;
  let sy = 0;
  let cy = 0;
  for (let y = 0; y < h; y++) {
    const ay = (2 * Math.PI * y) / h;
    for (let x = 0; x < w; x++) {
      const v = A[y * w + x];
      if (v === 0) {
        continue;
      }
      const ax = (2 * Math.PI * x) / w;
      sx += v * Math.sin(ax);
      cx += v * Math.cos(ax);
      sy += v * Math.sin(ay);
      cy += v * Math.cos(ay);
    }
  }
  const wrapTo = (a: number, n: number) => ((((a / (2 * Math.PI)) * n) % n) + n) % n;
  out[0] = wrapTo(Math.atan2(sx, cx), w);
  out[1] = wrapTo(Math.atan2(sy, cy), h);
}

/**
 * Seeds. Every seed is a patch: a disc PATCH_DIAMETER * R across of uniform
 * random values in [0, 1), the classic Lenia "soup" initial condition, drawn
 * from `createRng(patchSeed * 31 + 7)` in row-major order (see `fillPatch`).
 * Most patches fizzle out (or, under a growthy rule, spread); a few settle into
 * a creature of the rule.
 *
 * `PATCH_SEEDS` lists, per rule, generator seeds whose patch settles into a
 * single moving creature, found by running this file's CPU twin on a 72 x 72
 * grid for 400 steps and kept only if the result also held with GPU-like
 * arithmetic (16-bit state, 8-bit filter weights, float32 sums) and in other
 * orientations. These are generator inputs, not patterns: the creature itself is
 * never stored. A patch can be drawn in any of the eight orientations of the
 * square grid, which the rule treats alike, so each seed gives eight headings.
 *
 * Results of that search (patches of diameter 3.2 R):
 * - Orbium: seeds 30, 32, 33, 35, 39 and 41 of 1-60 form an Orbium (mass about
 *   71 cells, gliding about 0.6 cells per step).
 * - Gyrorbium revolvens: seed 34 of 1-140 forms a glider (mass about 74).
 * - Gyrorbium gyrans: none of 1-140 at diameters 1.2-3.6 R formed a creature,
 *   so its seeding falls back to random soup, as do the "soup" species and
 *   any rule with no listed seeds.
 */
export const PATCH_DIAMETER = 3.2;
/** Patch radius in cells, for R = KERNEL_R. */
export const PATCH_RADIUS = (PATCH_DIAMETER * KERNEL_R) / 2;
/** Side of the square buffer one patch is drawn into. */
export const PATCH_SIZE = 2 * Math.ceil(PATCH_RADIUS) + 1;

export const PATCH_SEEDS: Record<RuleId, readonly number[]> = {
  orbium: [30, 32, 33, 35, 39, 41],
  gyrans: [],
  revolvens: [34],
};

/** Mass (sum of A) of one settled creature of each rule, for counting creatures from the total. */
export const CREATURE_MASS: Record<RuleId, number> = {
  orbium: 71,
  gyrans: 71,
  revolvens: 74,
};

/**
 * Draws the patch for generator seed `patchSeed` into `out` (PATCH_SIZE^2, row
 * 0 at the bottom), in orientation `orient` (0-7: bit 2 mirrors x, bit 0 turns a
 * quarter, bit 1 a half). Cells outside the disc are 0.
 */
export function fillPatch(patchSeed: number, orient: number, out: Float32Array): Float32Array {
  out.fill(0);
  const rng = createRng(patchSeed * 31 + 7);
  const c = Math.ceil(PATCH_RADIUS);
  const r2 = PATCH_RADIUS * PATCH_RADIUS;
  for (let dy = -c; dy <= c; dy++) {
    for (let dx = -c; dx <= c; dx++) {
      if (dx * dx + dy * dy >= r2) {
        continue;
      }
      const v = rng();
      let x = orient & 4 ? -dx : dx;
      let y = dy;
      if (orient & 1) {
        const t = x;
        x = -y;
        y = t;
      }
      if (orient & 2) {
        x = -x;
        y = -y;
      }
      out[(y + c) * PATCH_SIZE + x + c] = v;
    }
  }
  return out;
}

/**
 * Draws one seed patch into `out` for `rule`: a listed creature seed in a random
 * orientation, or, if `soup` or the rule has none, a fresh random patch.
 * `pick` is a random number in [0, 1) choosing the seed and orientation.
 */
export function spawnPatch(pick: number, ruleId: RuleId, soup: boolean, out: Float32Array) {
  const seeds = PATCH_SEEDS[ruleId];
  const n = Math.floor(clamp(pick, 0, 0.999999) * 8 * 1e6);
  const orient = n & 7;
  if (soup || seeds.length === 0) {
    return fillPatch(1000 + (n >>> 3), orient, out);
  }
  return fillPatch(seeds[(n >>> 3) % seeds.length], orient, out);
}

/** Random-soup patches seeded at once. */
export const SOUP_PATCHES = 8;
/** Minimum distance between seeded patch centres, in cells: no overlap, and a kernel's reach apart. */
export const PATCH_SPACING = 2 * PATCH_RADIUS + KERNEL_R;

/**
 * A random cell, biased towards the sides of the frame (where creatures are
 * least in the speaker's way): x is folded away from the centre.
 */
function sideBiased(rng: () => number, w: number, h: number, out: Int32Array): void {
  const side = rng() < 0.5 ? -1 : 1;
  out[0] = clamp(Math.floor(w / 2 + side * (w / 2) * Math.sqrt(rng())), 0, w - 1);
  out[1] = Math.floor(rng() * h);
}

/**
 * Fills `out` (w x h) with a fresh field: `count` creature patches of the rule,
 * or SOUP_PATCHES random patches if `soup` or the rule has no listed seeds.
 * Patches keep PATCH_SPACING apart (rejection sampling; one with no room is
 * skipped, and the life cycle tops it up later). Deterministic per seed.
 */
export function seedField(
  seed: number,
  ruleId: RuleId,
  soup: boolean,
  count: number,
  w: number,
  h: number,
  out: Float32Array,
): Float32Array {
  out.fill(0);
  const rng = createRng(seed * 7919 + 101);
  const asSoup = soup || PATCH_SEEDS[ruleId].length === 0;
  const n = asSoup ? SOUP_PATCHES : clamp(Math.round(count), 1, 64);
  const patch = new Float32Array(PATCH_SIZE * PATCH_SIZE);
  const cell = new Int32Array(2);
  const placed: number[] = [];
  const c = Math.ceil(PATCH_RADIUS);
  for (let i = 0; i < n; i++) {
    let found = false;
    for (let tries = 0; tries < 40 && !found; tries++) {
      sideBiased(rng, w, h, cell);
      found = true;
      for (let j = 0; j < placed.length; j += 2) {
        const dx = Math.abs(cell[0] - placed[j]);
        const dy = Math.abs(cell[1] - placed[j + 1]);
        if (Math.hypot(Math.min(dx, w - dx), Math.min(dy, h - dy)) < PATCH_SPACING) {
          found = false;
          break;
        }
      }
    }
    if (!found) {
      continue;
    }
    placed.push(cell[0], cell[1]);
    spawnPatch(rng(), ruleId, asSoup, patch);
    for (let py = 0; py < PATCH_SIZE; py++) {
      const y = (((cell[1] + py - c) % h) + h) % h;
      for (let px = 0; px < PATCH_SIZE; px++) {
        const v = patch[py * PATCH_SIZE + px];
        if (v > 0) {
          out[y * w + ((((cell[0] + px - c) % w) + w) % w)] = v;
        }
      }
    }
  }
  return out;
}

/**
 * Picks where to write a top-up patch: the bottom-left cell of a PATCH_SIZE
 * square, inside the grid, whose surroundings (the square grown by KERNEL_R)
 * are empty in the stats readback (`bytes`: STATS_SIZE^2 RGBA8 texels of tile
 * mean, max, has-cells). Writes it to `out` and returns true, or false if no
 * empty spot turned up.
 */
export function pickSpawnSpot(
  bytes: Uint8Array,
  w: number,
  h: number,
  rng: () => number,
  out: Int32Array,
): boolean {
  if (w < PATCH_SIZE || h < PATCH_SIZE) {
    return false;
  }
  const [tx, ty] = statsTile(w, h);
  const cell = SPOT_SCRATCH;
  for (let tries = 0; tries < 24; tries++) {
    sideBiased(rng, w, h, cell);
    const x0 = clamp(cell[0] - (PATCH_SIZE >> 1), 0, w - PATCH_SIZE);
    const y0 = clamp(cell[1] - (PATCH_SIZE >> 1), 0, h - PATCH_SIZE);
    let empty = true;
    // Tiles touched by the square plus a kernel radius, wrapping.
    const ax = Math.floor((x0 - KERNEL_R) / tx);
    const bx = Math.floor((x0 + PATCH_SIZE + KERNEL_R) / tx);
    const ay = Math.floor((y0 - KERNEL_R) / ty);
    const by = Math.floor((y0 + PATCH_SIZE + KERNEL_R) / ty);
    const nx = Math.ceil(w / tx);
    const ny = Math.ceil(h / ty);
    for (let j = ay; j <= by && empty; j++) {
      const row = ((j % ny) + ny) % ny;
      for (let i = ax; i <= bx; i++) {
        const col = ((i % nx) + nx) % nx;
        if (bytes[(row * STATS_SIZE + col) * 4 + 1] > EMPTY_TILE_MAX) {
          empty = false;
          break;
        }
      }
    }
    if (empty) {
      out[0] = x0;
      out[1] = y0;
      return true;
    }
  }
  return false;
}

const SPOT_SCRATCH = new Int32Array(2);

/** A tile whose largest value is at most this (in 8-bit steps) counts as empty. */
export const EMPTY_TILE_MAX = 3;

/**
 * Packs a field into the GPU's RGBA8 state layout: A as 16 bits (r = high byte,
 * g = low byte), b = trail (starts at 0), a = 255.
 */
export function packState(A: Float32Array, out: Uint8Array): Uint8Array {
  for (let i = 0; i < A.length; i++) {
    const q = Math.round(clamp(A[i], 0, 1) * Q16);
    out[i * 4] = q >> 8;
    out[i * 4 + 1] = q & 255;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Trail fade per step: the wake left behind a creature fades out over about this many steps. */
export const TRAIL_STEPS = 90;

// Life cycle -----------------------------------------------------------------

/** Seconds to fade a fresh field in, or an old one out before reseeding. */
export const FADE_SECONDS = 2.5;
/** Seconds between stats readbacks. */
export const STATS_SECONDS = 2;
/**
 * Steps after seeding (or a top-up) before the stats are trusted: patches take
 * about 100 steps to fizzle out or settle into creatures, and a fresh patch
 * holds several creatures' worth of mass.
 */
export const SETTLE_STEPS = 160;
/** "Mixed" moves on to the next rule after this many seconds. */
export const MIXED_SECONDS = 180;
/** Below this largest value, the field is empty. */
export const DEAD_MAX = 0.08;
/** Above this mean value, the field has filled up (a growthy rule spreading). */
export const FULL_MEAN = 0.12;
/** Most top-up patches written after one readback. */
export const MAX_SPAWNS = 2;

/** Stats readback: one texel per tile of the grid. */
export const STATS_SIZE = 16;

/** Grid cells per stats tile along each axis, so STATS_SIZE tiles cover the grid. */
export function statsTile(w: number, h: number): [number, number] {
  return [Math.max(1, Math.ceil(w / STATS_SIZE)), Math.max(1, Math.ceil(h / STATS_SIZE))];
}

export interface FieldStats {
  /** Mean A over the grid. */
  mean: number;
  /** Largest A. */
  max: number;
}

/**
 * Reads the stats texels (RGBA8, STATS_SIZE^2: r = tile mean, g = tile max,
 * b = 1 if the tile has cells) into `out`.
 */
export function readStats(bytes: Uint8Array, out: FieldStats): FieldStats {
  let sum = 0;
  let tiles = 0;
  let max = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    if (bytes[i + 2] === 0) {
      continue;
    }
    sum += bytes[i];
    tiles++;
    max = Math.max(max, bytes[i + 1]);
  }
  out.mean = tiles > 0 ? sum / tiles / 255 : 0;
  out.max = max / 255;
  return out;
}

export type LifePhase = "in" | "live" | "out";

export interface Life {
  phase: LifePhase;
  /** Display brightness, 0..1. */
  fade: number;
  /** Seconds since seeding. */
  age: number;
  /** Steps since seeding or the last top-up. */
  quiet: number;
}

export const createLife = (): Life => ({ phase: "in", fade: 0, age: 0, quiet: 0 });

/** Restarts the cycle on a freshly seeded field. */
export function restartLife(life: Life): void {
  life.phase = "in";
  life.fade = 0;
  life.age = 0;
  life.quiet = 0;
}

/**
 * Advances the fades by `dt` seconds. Returns true when a fade-out has finished
 * and the field should be reseeded. `cycle` > 0 starts a fade-out once the field
 * is that many seconds old ("mixed").
 */
export function advanceLife(life: Life, dt: number, cycle: number): boolean {
  const t = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  life.age += t;
  if (life.phase === "in") {
    life.fade = Math.min(1, life.fade + t / FADE_SECONDS);
    if (life.fade >= 1) {
      life.phase = "live";
    }
  } else if (life.phase === "out") {
    life.fade = Math.max(0, life.fade - t / FADE_SECONDS);
    return life.fade <= 0;
  }
  if (cycle > 0 && life.age >= cycle) {
    life.phase = "out";
  }
  return false;
}

/**
 * Judges a stats readback once the field has settled: starts a fade-out if it
 * has died or filled up. Returns how many top-up patches to write (0 to
 * MAX_SPAWNS): the creatures missing from `count`, estimated from the total
 * mass over `cells` cells and the rule's creature mass.
 */
export function judgeStats(
  life: Life,
  s: FieldStats,
  count: number,
  ruleId: RuleId,
  cells: number,
): number {
  if (life.phase === "out" || life.quiet < SETTLE_STEPS) {
    return 0;
  }
  if (s.max < DEAD_MAX || s.mean > FULL_MEAN) {
    life.phase = "out";
    return 0;
  }
  const creatures = (s.mean * cells) / CREATURE_MASS[ruleId];
  return clamp(Math.round(count - creatures), 0, MAX_SPAWNS);
}

// Palettes -------------------------------------------------------------------

export type PaletteId = (typeof PALETTE_OPTIONS)[number]["value"];

/** Palettes as colour stops from empty (t = 0) to the densest core (t = 1). */
export const PALETTES = {
  bioluminescent: [
    [0, "#030812"],
    [0.25, "#08263a"],
    [0.55, "#14889a"],
    [0.8, "#7fe8d6"],
    [1, "#effff8"],
  ],
  ink: [
    [0, "#ece6da"],
    [0.3, "#b9b4b0"],
    [0.6, "#4e5a72"],
    [1, "#141a2c"],
  ],
  ember: [
    [0, "#080305"],
    [0.3, "#3d0c10"],
    [0.6, "#c2421a"],
    [0.85, "#ffb04a"],
    [1, "#fff1c4"],
  ],
  pastel: [
    [0, "#f4eef6"],
    [0.3, "#e4cfe8"],
    [0.6, "#a8c4ec"],
    [0.85, "#7ccfc0"],
    [1, "#fdf7d8"],
  ],
} as const satisfies Record<PaletteId, readonly (readonly [number, string])[]>;

/** Palettes on a light background (the emboss shades them a little more). */
export const isLightPalette = (id: string) => id === "ink" || id === "pastel";

/** Texels in the palette lookup table. */
export const LUT_SIZE = 256;

/**
 * Fills `out` (LUT_SIZE RGBA8 texels) with palette `id`, smoothly interpolated
 * between its stops. Unknown ids fall back to bioluminescent.
 */
export function buildPaletteLut(id: string, out: Uint8Array): Uint8Array {
  return buildGradientLut(lookup(PALETTES, id, "bioluminescent"), out);
}
