/**
 * Scrolling graph widgets for the Scenes' consoles: a noisy random walk that
 * scrolls across each graph. Each row is a mean-reverting walk (so it wanders but stays on
 * the graph) with strong jitter on every sample, drawn from a seeded hash of
 * the sample's index, so the trace never repeats. Values are bytes, one row per
 * widget, ready to upload as an R8 texture. `walkWander` averages a row's
 * newest samples into a slowly wandering value, for gauge needles.
 */
import { clamp } from "./math";
import { hash32 } from "./noise";

/** Samples held per row: the graph shows `GRAPH_SAMPLES - 2` segments across its width. */
export const GRAPH_SAMPLES = 128;
/** New samples per second, so a sample crosses the graph in about 8 s. */
export const GRAPH_RATE = 16;
/** How far the walk is pulled back to the middle each sample. */
const REVERT = 0.05;
/** Size of each step of the walk, and of the jitter on top of it. */
const STEP = 0.045;
const JITTER = 0.08;
/** The trace keeps this far from the graph's top and bottom, easing off as it nears them. */
const MARGIN = 0.08;

export interface GraphWalk {
  rows: number;
  seed: number;
  /** `rows` rows of `GRAPH_SAMPLES` bytes, oldest sample first: 0 is the bottom, 255 the top. */
  values: Uint8Array;
  /** Each row's walk, about 0. */
  walk: Float64Array;
  /** Index of the next sample to make. */
  next: number;
}

/** A roughly normal number with unit spread, from three hashed uniforms. */
function gauss(seed: number, row: number, index: number, salt: number): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const h = hash32(
      hash32(seed + 0x7f4a) ^ Math.imul(row + 1, 0x9e3779b1) ^ hash32(index * 8 + salt * 3 + i),
    );
    sum += h / 4294967296;
  }
  return (sum - 1.5) * 2;
}

function push(g: GraphWalk): void {
  const n = GRAPH_SAMPLES;
  const index = g.next++;
  for (let row = 0; row < g.rows; row++) {
    const w = (g.walk[row] ?? 0) * (1 - REVERT) + STEP * gauss(g.seed, row, index, 0);
    g.walk[row] = w;
    const reach = 0.5 - MARGIN;
    const y = 0.5 + reach * Math.tanh((w + JITTER * gauss(g.seed, row, index, 1)) / reach);
    const base = row * n;
    g.values.copyWithin(base, base + 1, base + n);
    g.values[base + n - 1] = Math.round(y * 255);
  }
}

/** A walk for `rows` graphs, with a full graph's worth of history already made. */
export function createGraphWalk(rows: number, seed: number): GraphWalk {
  const g: GraphWalk = {
    rows,
    seed: Math.floor(seed),
    values: new Uint8Array(rows * GRAPH_SAMPLES),
    walk: new Float64Array(rows),
    next: 0,
  };
  for (let i = 0; i < GRAPH_SAMPLES; i++) {
    push(g);
  }
  return g;
}

/**
 * Brings the walk up to `t` seconds since it was made, adding a sample every
 * `1 / GRAPH_RATE` s (after a long pause, only the last graph's worth). Returns
 * whether any were added. Allocates nothing.
 */
export function advanceGraph(g: GraphWalk, t: number): boolean {
  const target = GRAPH_SAMPLES + Math.floor(Math.max(0, t) * GRAPH_RATE);
  if (target <= g.next) {
    return false;
  }
  g.next = Math.max(g.next, target - GRAPH_SAMPLES);
  while (g.next < target) {
    push(g);
  }
  return true;
}

/** How far (0 to 1 of a sample) the trace has scrolled past its newest sample at `t`. */
export function graphShift(t: number): number {
  const x = Math.max(0, t) * GRAPH_RATE;
  return x - Math.floor(x);
}

/** Samples of the random walk averaged into one wander value: about 3 s of the walk. */
export const WANDER_SAMPLES = 48;

/**
 * The newest `n` samples of `row` of a graph walk, averaged and centred:
 * about -1..1, wandering slowly where the walk's own samples jitter.
 */
export function walkWander(g: GraphWalk, row: number, n = WANDER_SAMPLES): number {
  const count = clamp(Math.floor(n), 1, GRAPH_SAMPLES);
  const base = row * GRAPH_SAMPLES + GRAPH_SAMPLES - count;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += g.values[base + i];
  }
  return (sum / (count * 255) - 0.5) * 2;
}
