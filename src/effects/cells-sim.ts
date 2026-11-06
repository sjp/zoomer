/**
 * Pure logic for the dividing-cells effect, shared by `cells.ts` and its tests:
 * the cell simulation (soft-body packing, drift, growth, division and absorption),
 * the power-diagram maths the shader mirrors, and the palettes.
 *
 * Space: reference px, the frame `height` (1080) tall and `width` wide, y down.
 * Cells are discs; the image is their power (weighted Voronoi) diagram, where a
 * point belongs to the cell with the smallest `|p - c|² - r²`.
 */
import { createRng } from "./noise";
import { clamp, smoothstep } from "./math";
import { MAX_CELLS, MIN_CELLS } from "./cells.meta";
import { lookup } from "./lookup";

export { MAX_CELLS, MIN_CELLS };

/** Simulation step, seconds, and the most steps one frame may take. */
export const FIXED_DT = 1 / 60;
export const MAX_STEPS = 4;
/** Steps a dividing cell grows before it splits; an absorbed cell shrinks for as many. */
export const GROW_STEPS = Math.round(4 / FIXED_DT);
/** Seconds the daughters of a split render merged (pinching apart). */
export const MERGE_TIME = 5;
/** Disc area to frame area: just over the 1.21 that hexagonal discs need to cover the plane. */
export const FILL = 1.24;
/** Size spread between cells, as a radius multiplier range. */
const SIZE_MIN = 0.86;
const SIZE_MAX = 1.14;
/** Radius multiplier of cells in the calm centre. */
export const CENTRE_GROWTH = 1.35;
/** Seconds for a cell's radius to settle to its target. */
const RADIUS_TAU = 10;
/** Contact stiffness (1/s², per px of overlap), damping (1/s) and speed cap (px/s). */
const STIFFNESS = 3;
const DAMPING = 4;
const MAX_SPEED = 30;
/** Stiffness of the soft walls just beyond the frame edge (1/s²). */
const WALL = 10;
/** Drift acceleration at `motion` = 1, px/s², and its share left in the calm centre. */
const DRIFT = 30;
const CENTRE_DRIFT = 0.4;
/** How far, in base radii, cell centres may sit beyond the frame edge. */
const MARGIN = 0.35;
/** Daughter centres start this far either side of the parent, in daughter radii, moving apart this fast (px/s). */
const SPLIT_OFFSET = 0.4;
const SPLIT_SPEED = 6;
/** Nucleus strength of a parent just before it splits and of its daughters at birth. */
const NUCLEUS_LOW = 0.35;
/** Steps of relaxation before the first frame, so the cells start packed. */
const SETTLE_STEPS = 240;

export const MODE_NORMAL = 0;
export const MODE_GROWING = 1;
export const MODE_ABSORBING = 2;

export interface CellsSim {
  /** Live cells; indices 0..n-1 of every array are in use. */
  n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Current radius, px. */
  readonly r: Float64Array;
  /** Radius when the current growth or absorption started. */
  readonly r0: Float64Array;
  /** Own size multiplier, and colour tone 0..1. */
  readonly size: Float64Array;
  readonly tone: Float64Array;
  /** Drift: angular rates and phases per axis. */
  readonly wx: Float64Array;
  readonly wy: Float64Array;
  readonly px: Float64Array;
  readonly py: Float64Array;
  /** MODE_* and the steps left in that mode. */
  readonly mode: Uint8Array;
  readonly timer: Int32Array;
  /** 1 just after a split, falling to 0 over MERGE_TIME; and the split's serial, shared by both daughters. */
  readonly merge: Float64Array;
  readonly sister: Int32Array;
  /** Nucleus strength 0..1, and seconds since birth. */
  readonly nucleus: Float64Array;
  readonly age: Float64Array;
  width: number;
  height: number;
  /** Simulated seconds (float64, unwrapped) and the unspent part of a step. */
  time: number;
  acc: number;
  /** Divisions owed: grows by `division / 60` per second, one per event. */
  due: number;
  serial: number;
  readonly rng: () => number;
}

export interface CellsOptions {
  /** Target cell count (clamped to MIN_CELLS..MAX_CELLS). */
  count: number;
  /** Divisions per minute. */
  division: number;
  /** Drift strength 0..1. */
  motion: number;
  /** Larger, calmer cells in the centre third. */
  calm: boolean;
}

export const targetCount = (count: number) =>
  clamp(Math.round(Number.isFinite(count) ? count : MIN_CELLS), MIN_CELLS, MAX_CELLS);

/**
 * Weight of the calm centre at `u` (x as a fraction of the frame width): 1 in
 * the middle third, fading to 0 by the outer thirds. The shader uses the same curve.
 */
export const CENTRE_EDGES = [0.12, 0.26] as const;
export const centreWeight = (u: number) =>
  1 - smoothstep(CENTRE_EDGES[0], CENTRE_EDGES[1], Math.abs(u - 0.5));

/** Base radius for `count` cells filling a `width` x `height` frame. */
export const baseRadius = (width: number, height: number, count: number) =>
  Math.sqrt((FILL * width * height) / (Math.PI * targetCount(count)));

/** Smooth 0..1 ease used for growth, absorption and merging. */
const ease = (u: number) => smoothstep(0, 1, u);

export function createCellsSim(
  seed: number,
  opts: CellsOptions,
  width: number,
  height: number,
): CellsSim {
  const f64 = () => new Float64Array(MAX_CELLS);
  const sim: CellsSim = {
    n: 0,
    x: f64(),
    y: f64(),
    vx: f64(),
    vy: f64(),
    r: f64(),
    r0: f64(),
    size: f64(),
    tone: f64(),
    wx: f64(),
    wy: f64(),
    px: f64(),
    py: f64(),
    mode: new Uint8Array(MAX_CELLS),
    timer: new Int32Array(MAX_CELLS),
    merge: f64(),
    sister: new Int32Array(MAX_CELLS),
    nucleus: f64(),
    age: f64(),
    width: Math.max(1, width),
    height: Math.max(1, height),
    time: 0,
    acc: 0,
    due: 0,
    serial: 0,
    rng: createRng(Math.floor(seed) * 7919 + 74),
  };
  const n = targetCount(opts.count);
  const w = sim.width;
  const h = sim.height;
  // Jittered grid, so the cells start roughly even, then settle into packing.
  const cols = Math.max(1, Math.round(Math.sqrt((n * w) / h)));
  const rows = Math.ceil(n / cols);
  const rb = baseRadius(w, h, n);
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const row = Math.floor(i / cols);
    const lastRow = row === rows - 1 ? n - (rows - 1) * cols : cols;
    const cw = w / lastRow;
    sim.x[i] = (c + 0.5 + 0.5 * (sim.rng() - 0.5)) * cw;
    sim.y[i] = (row + 0.5 + 0.5 * (sim.rng() - 0.5)) * (h / rows);
    sim.size[i] = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * sim.rng();
    sim.tone[i] = sim.rng();
    sim.age[i] = 200 * sim.rng();
    sim.nucleus[i] = 1;
    sim.sister[i] = -1;
    randomiseDrift(sim, i);
    sim.r[i] = targetRadius(sim, i, rb, opts.calm);
  }
  sim.n = n;
  const settle: CellsOptions = { count: n, division: 0, motion: 0, calm: opts.calm };
  for (let s = 0; s < SETTLE_STEPS; s++) {
    stepCells(sim, settle);
  }
  sim.time = 0;
  return sim;
}

function randomiseDrift(sim: CellsSim, i: number) {
  const rng = sim.rng;
  sim.wx[i] = (2 * Math.PI) / (12 + 16 * rng());
  sim.wy[i] = (2 * Math.PI) / (12 + 16 * rng());
  sim.px[i] = 2 * Math.PI * rng();
  sim.py[i] = 2 * Math.PI * rng();
}

/** Mean of the calm-centre area factor across the frame width, to keep the total area. */
export const CENTRE_AREA = (() => {
  const steps = 1000;
  let sum = 0;
  for (let k = 0; k < steps; k++) {
    sum += (1 + (CENTRE_GROWTH - 1) * centreWeight((k + 0.5) / steps)) ** 2;
  }
  return sum / steps;
})();

/** Radius cell `i` settles to: its size, larger in the calm centre (same total area). */
export function targetRadius(sim: CellsSim, i: number, rb: number, calm: boolean) {
  if (!calm) {
    return rb * sim.size[i];
  }
  const c = centreWeight(sim.x[i] / sim.width);
  return ((rb * sim.size[i]) / Math.sqrt(CENTRE_AREA)) * (1 + (CENTRE_GROWTH - 1) * c);
}

/** Rescales positions to a new frame size, so the layout stretches with it. */
export function resizeCellsSim(sim: CellsSim, width: number, height: number) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (w === sim.width && h === sim.height) {
    return;
  }
  const kx = w / sim.width;
  const ky = h / sim.height;
  for (let i = 0; i < sim.n; i++) {
    sim.x[i] *= kx;
    sim.y[i] *= ky;
  }
  sim.width = w;
  sim.height = h;
}

/**
 * Advances by `dt` seconds in fixed steps (at most MAX_STEPS; the rest is dropped).
 * Returns the steps taken.
 */
export function advanceCells(sim: CellsSim, dt: number, opts: CellsOptions): number {
  if (!(dt > 0)) {
    return 0;
  }
  sim.acc = Math.min(sim.acc + dt, MAX_STEPS * FIXED_DT);
  let steps = 0;
  while (sim.acc >= FIXED_DT) {
    sim.acc -= FIXED_DT;
    stepCells(sim, opts);
    steps++;
  }
  return steps;
}

/** One fixed step: schedule events, grow / shrink / split, then move. */
export function stepCells(sim: CellsSim, opts: CellsOptions) {
  const dt = FIXED_DT;
  sim.time += dt;
  const target = targetCount(opts.count);
  scheduleEvents(sim, opts, target);
  updateLifecycles(sim, opts, target);
  move(sim, opts, target);
}

/** Cell count once every pending growth and absorption has finished. */
export function plannedCount(sim: CellsSim): number {
  let planned = sim.n;
  for (let i = 0; i < sim.n; i++) {
    if (sim.mode[i] === MODE_GROWING) {
      planned++;
    } else if (sim.mode[i] === MODE_ABSORBING) {
      planned--;
    }
  }
  return planned;
}

function scheduleEvents(sim: CellsSim, opts: CellsOptions, target: number) {
  let planned = plannedCount(sim);
  // Count changes: births by division, deaths by absorption.
  while (planned < target && startGrowth(sim, pickParent(sim, opts.calm))) {
    planned++;
  }
  while (planned > target && startAbsorb(sim, pickVictim(sim, -1, opts.calm))) {
    planned--;
  }
  // Scheduled divisions, each paired with an absorption elsewhere so the count holds.
  sim.due = Math.min(1, sim.due + (FIXED_DT * Math.max(0, opts.division)) / 60);
  if (sim.due >= 1 && planned === target) {
    const parent = pickParent(sim, opts.calm);
    const victim = pickVictim(sim, parent, opts.calm);
    if (parent >= 0 && victim >= 0) {
      startGrowth(sim, parent);
      startAbsorb(sim, victim);
      sim.due -= 1;
    }
  }
}

/** A cell may start an event when it is idle and has finished pinching apart. */
const eligible = (sim: CellsSim, i: number) => sim.mode[i] === MODE_NORMAL && sim.merge[i] === 0;

/** Calm cells in the centre divide and get absorbed less often. */
const centrePenalty = (sim: CellsSim, i: number, calm: boolean) =>
  calm ? 1 - 0.8 * centreWeight(sim.x[i] / sim.width) : 1;

/** The idle cell to divide next, favouring large, old cells; -1 if none. */
export function pickParent(sim: CellsSim, calm: boolean): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < sim.n; i++) {
    if (!eligible(sim, i)) {
      continue;
    }
    const score =
      (sim.size[i] + Math.min(sim.age[i], 120) / 240 + 0.6 * sim.rng()) *
      centrePenalty(sim, i, calm);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** The idle cell to absorb, favouring old cells far from `parent` (if >= 0); -1 if none. */
export function pickVictim(sim: CellsSim, parent: number, calm: boolean): number {
  let best = -1;
  let bestScore = -Infinity;
  const diag = Math.hypot(sim.width, sim.height);
  for (let i = 0; i < sim.n; i++) {
    if (i === parent || !eligible(sim, i)) {
      continue;
    }
    const far = parent >= 0 ? Math.hypot(sim.x[i] - sim.x[parent], sim.y[i] - sim.y[parent]) : 0;
    const score =
      (far / diag + Math.min(sim.age[i], 300) / 300 + 0.4 * sim.rng()) *
      centrePenalty(sim, i, calm);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function startGrowth(sim: CellsSim, i: number): boolean {
  if (i < 0) {
    return false;
  }
  sim.mode[i] = MODE_GROWING;
  sim.timer[i] = GROW_STEPS;
  sim.r0[i] = sim.r[i];
  return true;
}

function startAbsorb(sim: CellsSim, i: number): boolean {
  if (i < 0) {
    return false;
  }
  sim.mode[i] = MODE_ABSORBING;
  sim.timer[i] = GROW_STEPS;
  sim.r0[i] = sim.r[i];
  return true;
}

function updateLifecycles(sim: CellsSim, opts: CellsOptions, target: number) {
  const dt = FIXED_DT;
  const rb = baseRadius(sim.width, sim.height, target);
  const relax = 1 - Math.exp(-dt / RADIUS_TAU);
  for (let i = 0; i < sim.n; i++) {
    sim.age[i] += dt;
    if (sim.merge[i] > 0) {
      sim.merge[i] = Math.max(0, sim.merge[i] - dt / MERGE_TIME);
    }
    const mode = sim.mode[i];
    if (mode === MODE_NORMAL) {
      sim.r[i] += (targetRadius(sim, i, rb, opts.calm) - sim.r[i]) * relax;
      sim.nucleus[i] = Math.min(1, sim.nucleus[i] + dt / MERGE_TIME);
      continue;
    }
    sim.timer[i]--;
    const u = ease(1 - sim.timer[i] / GROW_STEPS);
    if (mode === MODE_GROWING) {
      // Area doubles, so each daughter starts with the parent's old area.
      sim.r[i] = sim.r0[i] * (1 + (Math.SQRT2 - 1) * u);
      sim.nucleus[i] = 1 - (1 - NUCLEUS_LOW) * u;
    } else {
      sim.r[i] = sim.r0[i] * (1 - u);
    }
  }
  // Absorptions finish before splits, so a paired event never overshoots the count.
  for (let i = sim.n - 1; i >= 0; i--) {
    if (sim.mode[i] === MODE_ABSORBING && sim.timer[i] <= 0) {
      removeCell(sim, i);
    }
  }
  const n = sim.n;
  for (let i = 0; i < n; i++) {
    if (sim.mode[i] === MODE_GROWING && sim.timer[i] <= 0 && sim.n < MAX_CELLS) {
      splitCell(sim, i, sim.n);
      sim.n++;
    }
  }
}

/** Removes cell `i` by moving the last cell into its slot. */
export function removeCell(sim: CellsSim, i: number) {
  const last = sim.n - 1;
  if (i !== last) {
    copyCell(sim, last, i);
  }
  sim.n = last;
}

function copyCell(sim: CellsSim, from: number, to: number) {
  sim.x[to] = sim.x[from];
  sim.y[to] = sim.y[from];
  sim.vx[to] = sim.vx[from];
  sim.vy[to] = sim.vy[from];
  sim.r[to] = sim.r[from];
  sim.r0[to] = sim.r0[from];
  sim.size[to] = sim.size[from];
  sim.tone[to] = sim.tone[from];
  sim.wx[to] = sim.wx[from];
  sim.wy[to] = sim.wy[from];
  sim.px[to] = sim.px[from];
  sim.py[to] = sim.py[from];
  sim.mode[to] = sim.mode[from];
  sim.timer[to] = sim.timer[from];
  sim.merge[to] = sim.merge[from];
  sim.sister[to] = sim.sister[from];
  sim.nucleus[to] = sim.nucleus[from];
  sim.age[to] = sim.age[from];
}

/**
 * Splits cell `i` into itself and slot `j` along a random axis: each daughter
 * has half the parent's area, starts either side of its centre moving apart, and
 * renders merged with its sister while `merge` falls from 1.
 */
export function splitCell(sim: CellsSim, i: number, j: number) {
  copyCell(sim, i, j);
  const a = 2 * Math.PI * sim.rng();
  const ax = Math.cos(a);
  const ay = Math.sin(a);
  const rd = sim.r[i] * Math.SQRT1_2;
  const off = SPLIT_OFFSET * rd;
  const serial = (sim.serial = (sim.serial + 1) & 0xffff);
  initDaughter(sim, i, ax, ay, rd, off, serial);
  initDaughter(sim, j, -ax, -ay, rd, off, serial);
}

function initDaughter(
  sim: CellsSim,
  k: number,
  ax: number,
  ay: number,
  rd: number,
  off: number,
  serial: number,
) {
  sim.r[k] = rd;
  sim.mode[k] = MODE_NORMAL;
  sim.timer[k] = 0;
  sim.merge[k] = 1;
  sim.sister[k] = serial;
  sim.nucleus[k] = NUCLEUS_LOW;
  sim.age[k] = 0;
  sim.size[k] = clamp(sim.size[k] * (0.95 + 0.1 * sim.rng()), SIZE_MIN, SIZE_MAX);
  sim.tone[k] = clamp(sim.tone[k] + 0.12 * (sim.rng() - 0.5), 0, 1);
  sim.x[k] += off * ax;
  sim.y[k] += off * ay;
  sim.vx[k] += SPLIT_SPEED * ax;
  sim.vy[k] += SPLIT_SPEED * ay;
  randomiseDrift(sim, k);
}

function move(sim: CellsSim, opts: CellsOptions, target: number) {
  const dt = FIXED_DT;
  const n = sim.n;
  const { x, y, vx, vy, r } = sim;
  const motion = DRIFT * clamp(Number.isFinite(opts.motion) ? opts.motion : 0, 0, 1);
  const t = sim.time;
  for (let i = 0; i < n; i++) {
    const calm = opts.calm ? 1 - (1 - CENTRE_DRIFT) * centreWeight(x[i] / sim.width) : 1;
    vx[i] += motion * calm * Math.sin(t * sim.wx[i] + sim.px[i]) * dt;
    vy[i] += motion * calm * Math.sin(t * sim.wy[i] + sim.py[i]) * dt;
  }
  // Soft-body contacts: overlapping discs push apart in proportion to the overlap.
  // Sisters still pinching apart push gently, so the split takes a few seconds.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const reach = r[i] + r[j];
      const d2 = dx * dx + dy * dy;
      if (d2 >= reach * reach) {
        continue;
      }
      let d = Math.sqrt(d2);
      let ux: number;
      let uy: number;
      if (d > 1e-6) {
        ux = dx / d;
        uy = dy / d;
      } else {
        // Coincident centres: separate along a fixed, index-dependent axis.
        const a = (i * 2.399963 + j) % (2 * Math.PI);
        ux = Math.cos(a);
        uy = Math.sin(a);
        d = 0;
      }
      let k = STIFFNESS * (reach - d) * dt * 0.5;
      if (sim.merge[i] > 0 && sim.sister[i] === sim.sister[j] && sim.merge[j] > 0) {
        k *= 1 - 0.8 * sim.merge[i];
      }
      vx[i] -= k * ux;
      vy[i] -= k * uy;
      vx[j] += k * ux;
      vy[j] += k * uy;
    }
  }
  const rb = baseRadius(sim.width, sim.height, target);
  const m = MARGIN * rb;
  const damp = Math.exp(-DAMPING * dt);
  for (let i = 0; i < n; i++) {
    // Soft walls a little beyond the frame, so cells cover the edges.
    const lo = -m;
    const hiX = sim.width + m;
    const hiY = sim.height + m;
    if (x[i] < lo) {
      vx[i] += WALL * (lo - x[i]) * dt;
    } else if (x[i] > hiX) {
      vx[i] -= WALL * (x[i] - hiX) * dt;
    }
    if (y[i] < lo) {
      vy[i] += WALL * (lo - y[i]) * dt;
    } else if (y[i] > hiY) {
      vy[i] -= WALL * (y[i] - hiY) * dt;
    }
    vx[i] *= damp;
    vy[i] *= damp;
    const sp = Math.hypot(vx[i], vy[i]);
    if (sp > MAX_SPEED) {
      vx[i] *= MAX_SPEED / sp;
      vy[i] *= MAX_SPEED / sp;
    }
    x[i] += vx[i] * dt;
    y[i] += vy[i] * dt;
  }
}

/**
 * Packs the live cells for the shader: per cell `(x, y, r², r)` in reference px,
 * and `(tone, sister serial, eased merge, nucleus)`. Cells not pinching apart get
 * merge 0, so the shader never pairs them.
 */
export function packCells(sim: CellsSim, cells: Float32Array, info: Float32Array): number {
  for (let i = 0; i < sim.n; i++) {
    const o = i * 4;
    const r = sim.r[i];
    cells[o] = sim.x[i];
    cells[o + 1] = sim.y[i];
    cells[o + 2] = r * r;
    cells[o + 3] = r;
    info[o] = sim.tone[i];
    info[o + 1] = sim.sister[i];
    info[o + 2] = ease(sim.merge[i]);
    info[o + 3] = ease(sim.nucleus[i]);
  }
  return sim.n;
}

/**
 * Power-diagram sample at (px, py) over the packed cells, as the shader does it:
 * the nearest cell by `|p - c|² - r²`, and the exact distance to its boundary
 * (the nearest radical line with any other cell). Used by the tests.
 */
export function powerSample(
  cells: Float32Array,
  n: number,
  px: number,
  py: number,
): { best: number; edge: number } {
  let best = -1;
  let d1 = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = px - cells[i * 4];
    const dy = py - cells[i * 4 + 1];
    const pd = dx * dx + dy * dy - cells[i * 4 + 2];
    if (pd < d1) {
      d1 = pd;
      best = i;
    }
  }
  let edge = Infinity;
  for (let k = 0; k < n; k++) {
    if (k === best) {
      continue;
    }
    const dx = px - cells[k * 4];
    const dy = py - cells[k * 4 + 1];
    const pd = dx * dx + dy * dy - cells[k * 4 + 2];
    const L = Math.hypot(cells[k * 4] - cells[best * 4], cells[k * 4 + 1] - cells[best * 4 + 1]);
    edge = Math.min(edge, (pd - d1) / (2 * Math.max(L, 1e-2)));
  }
  return { best, edge };
}

/** Palette colours: medium, body (tone 0 and 1), membrane, nucleus. */
export const PALETTES = {
  // H&E: pale pink ground, pink-violet cytoplasm, light membranes, purple nuclei.
  stain: ["#f1dfe8", "#e7a9c9", "#cf8fc0", "#fbeaf3", "#6a3d8f"],
  // Fluorescence: dark ground, dim green bodies, bright green membranes, blue (DAPI) nuclei.
  fluorescent: ["#04080b", "#123f33", "#163a48", "#7cf2a8", "#2f4fb8"],
  // Phase contrast: grey ground, lighter cells with bright halos.
  mono: ["#7f8489", "#a3a8ac", "#959a9e", "#e9edf0", "#666b70"],
  pastel: ["#f5eee6", "#f2c8b6", "#c8dcef", "#fffaf4", "#b49bc8"],
} as const satisfies Record<string, readonly string[]>;

export type PaletteId = keyof typeof PALETTES;

export function palette(name: string): readonly string[] {
  return lookup(PALETTES, name, "stain");
}
