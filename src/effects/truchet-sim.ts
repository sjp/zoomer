/**
 * Pure logic for the Truchet weave effect, shared by `truchet.ts` and its tests:
 * the tile grid layout, seeded initial orientations, the flip scheduler (a Poisson
 * process over the whole frame), path labelling with union-find, per-arc colour
 * fades, and the texel encoding the shader reads.
 *
 * Grid space: tile (i, j) covers [i, i + 1] x [j, j + 1], y up (row 0 at the
 * bottom, as `gl_FragCoord` and `texelFetch` count). Each tile holds two arcs of
 * radius 1/2 around opposite corners, joining the midpoints of adjacent edges:
 *
 * - orientation 0: arc A around corner (0, 0) joins left and bottom; arc B around
 *   (1, 1) joins top and right;
 * - orientation 1 (the mirror image, or the same tile turned 90 degrees): arc A
 *   around (1, 0) joins bottom and right; arc B around (0, 1) joins left and top.
 *
 * Arc A is always the one around a bottom corner.
 */
import { createRng, hash32 } from "./noise";

export interface TruchetPalette {
  /** Background tones of the two region parities (the regions between arcs are two-colourable). */
  bgA: string;
  bgB: string;
  /** Arc tones; paths pick one each when "Colour each path" is on, else the first. */
  bands: readonly [string, string, string];
}

export const PALETTES = {
  slate: { bgA: "#262b33", bgB: "#2c323b", bands: ["#56677a", "#6a7d8f", "#7f8f9e"] },
  sand: { bgA: "#e3d6c0", bgB: "#dccdb4", bands: ["#b79d78", "#a98e6c", "#c4ad8a"] },
  ocean: { bgA: "#0d2633", bgB: "#112c3a", bands: ["#2d7a8c", "#3a929c", "#56aaa8"] },
  mono: { bgA: "#1d1e20", bgB: "#222325", bands: ["#5e6064", "#717378", "#4f5155"] },
  neon: { bgA: "#0c0a18", bgB: "#100d20", bands: ["#e0479e", "#38c6e8", "#9a62f0"] },
} as const satisfies Record<string, TruchetPalette>;
export type PaletteName = keyof typeof PALETTES;

/** Number of arc tones in every palette. */
export const TONES = 3;

/** The named palette, or Slate for an unknown name. */
export function palette(name: string): TruchetPalette {
  return name in PALETTES ? PALETTES[name as PaletteName] : PALETTES.slate;
}

export const STYLES = ["bands", "outlines", "shaded"] as const;
export type StyleName = (typeof STYLES)[number];

/** Shader index of a style name; Bands for an unknown name. */
export function styleIndex(name: string): number {
  return Math.max(0, STYLES.indexOf(name as StyleName));
}

/** Seconds a tile takes to turn 90 degrees. */
export const FLIP_DURATION = 1.6;
/** Seconds a path's colour takes to cross-fade after a flip rewires it. */
export const FADE_DURATION = 1.2;
/** Flips that can run at once; slot 0 means "not flipping", so slots fit in 4 bits. */
export const MAX_FLIPS = 15;
/** Random picks tried for a tile that isn't already flipping before a flip is dropped. */
const PICK_TRIES = 16;
/** Smallest tile in device px, so a tiny canvas can't ask for a huge grid. */
export const MIN_TILE_PX = 4;

/** `step` result flags. */
export const STARTED = 1;
export const COMPLETED = 2;
export const FADING = 4;

export interface GridLayout {
  cols: number;
  rows: number;
  /** Device px of the grid's bottom-left corner (at most 0, so the grid covers the frame). */
  ox: number;
  oy: number;
  /** Tile size in device px. */
  tilePx: number;
}

/**
 * The smallest even number of tiles in each direction that covers a `width` x
 * `height` frame, centred on it, so a tile corner sits at the frame centre and
 * resizing keeps the middle of the pattern in place.
 */
export function gridLayout(width: number, height: number, tilePx: number): GridLayout {
  const t = Math.max(MIN_TILE_PX, tilePx);
  const cols = 2 * Math.max(1, Math.ceil(width / (2 * t)));
  const rows = 2 * Math.max(1, Math.ceil(height / (2 * t)));
  return { cols, rows, ox: (width - cols * t) / 2, oy: (height - rows * t) / 2, tilePx: t };
}

/**
 * Seeded starting orientation of tile (i, j), keyed by its position relative to
 * the grid centre so it doesn't change when the grid grows or shrinks.
 */
export function initialOrientation(
  i: number,
  j: number,
  cols: number,
  rows: number,
  seed: number,
): number {
  const x = (i - cols / 2) & 0xffff;
  const y = (j - rows / 2) & 0xffff;
  return hash32((x | (y << 16)) ^ hash32(Math.floor(seed) ^ 0x7f4a7c15)) & 1;
}

/** Edge-midpoint nodes of a grid: vertical edges first, then horizontal ones. */
export function nodeCount(cols: number, rows: number): number {
  return (cols + 1) * rows + cols * (rows + 1);
}

/**
 * Writes the two end nodes of arc `arc` (0 = A, 1 = B) of tile (i, j) with
 * orientation `o` to `out[0..1]`.
 */
export function arcEnds(
  cols: number,
  rows: number,
  i: number,
  j: number,
  o: number,
  arc: number,
  out: number[],
): number[] {
  const nv = (cols + 1) * rows;
  const left = i + j * (cols + 1);
  const right = left + 1;
  const bottom = nv + i + j * cols;
  const top = bottom + cols;
  if (o === 0) {
    out[0] = arc === 0 ? left : top;
    out[1] = arc === 0 ? bottom : right;
  } else {
    out[0] = arc === 0 ? bottom : left;
    out[1] = arc === 0 ? right : top;
  }
  return out;
}

function find(parent: Int32Array, x: number): number {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
}

const ends = [0, 0];

/**
 * Labels every arc with its path: union-find over edge midpoints, always keeping
 * the smaller index as the root, so a path's label is the smallest midpoint on it.
 * A path that a change doesn't touch keeps its label. Writes arc A and B labels of
 * tile `t = i + j * cols` to `out[2t]` and `out[2t + 1]`, uses `parent` (at least
 * `nodeCount` long) as scratch, and returns the number of paths.
 */
export function labelPaths(
  cols: number,
  rows: number,
  orient: Uint8Array,
  out: Int32Array,
  parent: Int32Array = new Int32Array(nodeCount(cols, rows)),
): number {
  const n = nodeCount(cols, rows);
  for (let k = 0; k < n; k++) parent[k] = k;
  let paths = n;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const o = orient[i + j * cols];
      for (let arc = 0; arc < 2; arc++) {
        arcEnds(cols, rows, i, j, o, arc, ends);
        const a = find(parent, ends[0]);
        const b = find(parent, ends[1]);
        if (a === b) continue;
        if (a < b) parent[b] = a;
        else parent[a] = b;
        paths--;
      }
    }
  }
  for (let t = 0; t < cols * rows; t++) {
    const o = orient[t];
    const i = t % cols;
    const j = (t - i) / cols;
    for (let arc = 0; arc < 2; arc++) {
      arcEnds(cols, rows, i, j, o, arc, ends);
      out[2 * t + arc] = find(parent, ends[0]);
    }
  }
  return paths;
}

/** Arc tone (0..TONES-1) of the path with label `label`. */
export function pathTone(label: number, seed: number): number {
  return hash32(label ^ hash32(Math.floor(seed) ^ 0x51ed270b)) % TONES;
}

/** Cubic ease in and out of `p` (0..1). */
export function easeInOut(p: number): number {
  const x = Math.min(Math.max(p, 0), 1);
  return x * x * (3 - 2 * x);
}

export interface TruchetOptions {
  cols: number;
  rows: number;
  seed: number;
  /** A previous grid whose committed orientations carry over, matched by position from the centre. */
  from?: TruchetSim | undefined;
}

export interface TruchetSim {
  readonly cols: number;
  readonly rows: number;
  readonly seed: number;
  /** Committed orientation (0 or 1) of each tile, `i + j * cols`. */
  readonly orient: Uint8Array;
  /** Flip slot (1..MAX_FLIPS) of each tile, 0 when it isn't flipping. */
  readonly tileSlot: Uint8Array;
  /** Tile of each slot (index 0 unused), -1 when free. */
  readonly slotTile: Int32Array;
  /** Start time of each slot's flip, in sim seconds. */
  readonly slotStart: Float64Array;
  /** Turn direction of each slot's flip: 0 anticlockwise, 1 clockwise. */
  readonly slotDir: Uint8Array;
  /** Path label of each arc, `2t` (A) and `2t + 1` (B). */
  readonly labels: Int32Array;
  /** Tone each arc fades from and to, and each tile's fade progress (1 = done). */
  readonly toneFrom: Uint8Array;
  readonly toneTo: Uint8Array;
  readonly fade: Float32Array;
  /** Sim time in seconds (float64, unwrapped). */
  readonly time: number;
  /** Flips started, and flips dropped because every slot or every tried tile was busy. */
  readonly started: number;
  readonly dropped: number;
  /** Paths after the latest relabel. */
  readonly paths: number;
  /**
   * Advances by `dt` seconds with `rate` flips per second over the whole grid:
   * completes finished flips (relabelling paths), advances colour fades and
   * starts new flips. Returns STARTED | COMPLETED | FADING flags for whatever
   * changed the tile texture. Allocates nothing.
   */
  step(dt: number, rate: number): number;
  /** Eased progress (0..1) of slot `s`'s flip; 0 for a free slot. */
  ease(s: number): number;
  /** Writes the eased progress of every slot (index 0 = 0) to `out`, `MAX_FLIPS + 1` long. */
  flipProgress(out: Float32Array): Float32Array;
  /**
   * Writes the tile texels (RGBA8UI, `4 * cols * rows` bytes), row 0 at the bottom:
   *
   * - R: orientation (bit 0), turn direction (bit 1) and flip slot (bits 2-5);
   * - G: arc A's from and to tones (bits 0-1, 2-3), arc B's (bits 4-5, 6-7);
   * - B: colour fade progress, 0..255.
   */
  encode(out: Uint8Array): Uint8Array;
}

export function createTruchet(options: TruchetOptions): TruchetSim {
  const cols = Math.max(1, Math.floor(options.cols));
  const rows = Math.max(1, Math.floor(options.rows));
  const seed = Math.floor(options.seed);
  const n = cols * rows;
  const orient = new Uint8Array(n);
  const tileSlot = new Uint8Array(n);
  const slotTile = new Int32Array(MAX_FLIPS + 1).fill(-1);
  const slotStart = new Float64Array(MAX_FLIPS + 1);
  const slotDir = new Uint8Array(MAX_FLIPS + 1);
  const labels = new Int32Array(2 * n);
  const parent = new Int32Array(nodeCount(cols, rows));
  const toneFrom = new Uint8Array(2 * n);
  const toneTo = new Uint8Array(2 * n);
  const fade = new Float32Array(n).fill(1);
  const rng = createRng(hash32(seed ^ 0x2545f491));
  /** Exponential(1) waiting time, so `rate * dt` accumulates towards the next event. */
  const unitWait = () => -Math.log(1 - rng());

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++)
      orient[i + j * cols] = initialOrientation(i, j, cols, rows, seed);
  }
  const from = options.from;
  if (from) {
    // Same position from the grid centre in both grids (both sizes are even).
    const di = (from.cols - cols) / 2;
    const dj = (from.rows - rows) / 2;
    for (let j = 0; j < rows; j++) {
      const pj = j + dj;
      if (pj < 0 || pj >= from.rows) continue;
      for (let i = 0; i < cols; i++) {
        const pi = i + di;
        if (pi >= 0 && pi < from.cols) orient[i + j * cols] = from.orient[pi + pj * from.cols];
      }
    }
  }

  let time = 0;
  let clock = 0;
  let nextEvent = unitWait();
  let started = 0;
  let dropped = 0;
  let fading = false;
  let paths = 0;

  function relabel(initial: boolean) {
    paths = labelPaths(cols, rows, orient, labels, parent);
    for (let t = 0; t < n; t++) {
      const a = pathTone(labels[2 * t], seed);
      const b = pathTone(labels[2 * t + 1], seed);
      if (initial) {
        toneFrom[2 * t] = toneTo[2 * t] = a;
        toneFrom[2 * t + 1] = toneTo[2 * t + 1] = b;
        continue;
      }
      if (a === toneTo[2 * t] && b === toneTo[2 * t + 1]) continue;
      // Fade from what is on screen now (the nearer end of a fade in progress).
      const late = fade[t] >= 0.5;
      for (let k = 2 * t; k < 2 * t + 2; k++) {
        if (late) toneFrom[k] = toneTo[k];
      }
      toneTo[2 * t] = a;
      toneTo[2 * t + 1] = b;
      fade[t] = 0;
      fading = true;
    }
  }
  relabel(true);

  function start(at: number): boolean {
    let slot = 0;
    for (let s = 1; s <= MAX_FLIPS; s++) {
      if (slotTile[s] < 0) {
        slot = s;
        break;
      }
    }
    if (slot === 0) return false;
    for (let k = 0; k < PICK_TRIES; k++) {
      const t = Math.min(n - 1, Math.floor(rng() * n));
      if (tileSlot[t] !== 0) continue;
      tileSlot[t] = slot;
      slotTile[slot] = t;
      slotStart[slot] = at;
      slotDir[slot] = rng() < 0.5 ? 0 : 1;
      return true;
    }
    return false;
  }

  function complete(s: number) {
    const t = slotTile[s];
    // Turning maps arc A onto the new tile's arc B (and back) when the bottom
    // corner it circles turns to the top: keep each arc's colour with the arc.
    if ((orient[t] ^ slotDir[s]) === 1) {
      const a = 2 * t;
      const b = a + 1;
      let x = toneFrom[a];
      toneFrom[a] = toneFrom[b];
      toneFrom[b] = x;
      x = toneTo[a];
      toneTo[a] = toneTo[b];
      toneTo[b] = x;
    }
    orient[t] ^= 1;
    tileSlot[t] = 0;
    slotTile[s] = -1;
  }

  const ease = (s: number) =>
    slotTile[s] < 0 ? 0 : easeInOut((time - slotStart[s]) / FLIP_DURATION);

  return {
    cols,
    rows,
    seed,
    orient,
    tileSlot,
    slotTile,
    slotStart,
    slotDir,
    labels,
    toneFrom,
    toneTo,
    fade,
    get time() {
      return time;
    },
    get started() {
      return started;
    },
    get dropped() {
      return dropped;
    },
    get paths() {
      return paths;
    },
    step(dt, rate) {
      const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
      const r = Number.isFinite(rate) && rate > 0 ? rate : 0;
      time += d;
      let flags = 0;

      for (let s = 1; s <= MAX_FLIPS; s++) {
        if (slotTile[s] >= 0 && time - slotStart[s] >= FLIP_DURATION) {
          complete(s);
          flags |= COMPLETED;
        }
      }
      if (flags & COMPLETED) relabel(false);

      if (fading) {
        let any = false;
        const k = d / FADE_DURATION;
        for (let t = 0; t < n; t++) {
          if (fade[t] < 1) {
            fade[t] = Math.min(1, fade[t] + k);
            any = true;
          }
        }
        fading = any;
        if (any) flags |= FADING;
      }

      clock += r * d;
      while (r > 0 && clock >= nextEvent) {
        // Back-date the flip to the event's own time within this step.
        const at = time - (clock - nextEvent) / r;
        nextEvent += unitWait();
        if (start(at)) {
          started++;
          flags |= STARTED;
        } else {
          dropped++;
        }
      }
      return flags;
    },
    ease,
    flipProgress(out) {
      out[0] = 0;
      for (let s = 1; s <= MAX_FLIPS; s++) out[s] = ease(s);
      return out;
    },
    encode(out) {
      for (let t = 0; t < n; t++) {
        const slot = tileSlot[t];
        const a = 2 * t;
        const o = 4 * t;
        out[o] = orient[t] | ((slot ? slotDir[slot] : 0) << 1) | (slot << 2);
        out[o + 1] = toneFrom[a] | (toneTo[a] << 2) | (toneFrom[a + 1] << 4) | (toneTo[a + 1] << 6);
        out[o + 2] = Math.round(fade[t] * 255);
        out[o + 3] = 0;
      }
      return out;
    },
  };
}
