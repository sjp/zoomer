import { describe, expect, it } from "vitest";
import { advanceGraph, createGraphWalk, GRAPH_RATE, GRAPH_SAMPLES, graphShift } from "./graph-walk";

const N = GRAPH_SAMPLES;

/** Every sample of row `row` from the start to `seconds` in. */
function trace(seconds: number, seed = 12, row = 0): number[] {
  const g = createGraphWalk(2, seed);
  const out = Array.from(g.values.subarray(row * N, row * N + N));
  for (let i = 1; i <= seconds * GRAPH_RATE; i++) {
    advanceGraph(g, i / GRAPH_RATE);
    out.push(g.values[row * N + N - 1] ?? 0);
  }
  return out;
}

describe("bridge POWER graph", () => {
  it("is the same for the same seed and differs between seeds and rows", () => {
    expect(trace(10)).toEqual(trace(10));
    expect(trace(10, 13)).not.toEqual(trace(10));
    expect(trace(10, 12, 1)).not.toEqual(trace(10));
  });

  it("scrolls: each new sample pushes the rest one place left", () => {
    const g = createGraphWalk(1, 3);
    const before = Array.from(g.values);
    expect(advanceGraph(g, 0.5 / GRAPH_RATE)).toBe(false);
    expect(advanceGraph(g, 1 / GRAPH_RATE)).toBe(true);
    expect(Array.from(g.values.subarray(0, N - 1))).toEqual(before.slice(1));
    expect(graphShift(1.5 / GRAPH_RATE)).toBeCloseTo(0.5, 9);
  });

  it("stays on the graph, wanders over it, and is noisy from sample to sample", () => {
    const t = trace(600);
    const min = Math.min(...t);
    const max = Math.max(...t);
    expect(min).toBeGreaterThanOrEqual(Math.round(0.08 * 255));
    expect(max).toBeLessThanOrEqual(Math.round(0.92 * 255));
    expect(max - min).toBeGreaterThan(0.5 * 255);
    let jump = 0;
    for (let i = 1; i < t.length; i++) {
      jump += Math.abs((t[i] ?? 0) - (t[i - 1] ?? 0));
    }
    expect(jump / (t.length - 1)).toBeGreaterThan(0.05 * 255);
  });

  it("never repeats", () => {
    const t = trace(600);
    const window = t.slice(0, N);
    for (let lag = 1; lag + N <= t.length; lag++) {
      expect(t.slice(lag, lag + N)).not.toEqual(window);
    }
  });

  it("catches up after a long pause with only a graph's worth of new samples", () => {
    const g = createGraphWalk(1, 5);
    expect(advanceGraph(g, 3600)).toBe(true);
    expect(g.next).toBe(N + 3600 * GRAPH_RATE);
  });
});
