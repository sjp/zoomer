import { describe, expect, it } from "vitest";
import { createRng } from "./noise";
import { createRainSim, dropRows, DROP_FLOATS, growArray } from "./rain-sim";

describe("growArray", () => {
  it("returns the same array when it is already long enough", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(growArray(a, 2, 2)).toBe(a);
    expect(growArray(a, 3, 0)).toBe(a);
  });

  it("grows into a new array of the same type, keeping the first elements", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = growArray(a, 5, 2);
    expect(b).toBeInstanceOf(Uint8Array);
    expect(Array.from(b)).toEqual([1, 2, 0, 0, 0]);
  });

  it("copies no more than the old array holds", () => {
    const b = growArray(new Float32Array([4, 5]), 4, 10);
    expect(Array.from(b)).toEqual([4, 5, 0, 0]);
  });
});

describe("dropRows", () => {
  const out = new Float64Array(2);
  const rows = 40;

  it("covers the trail behind the head down to the head's row", () => {
    // Head in row 12, a 2s trail at 3 rows/s, one lead row.
    dropRows(out, 12.4, 3, 1, 2, 0, rows);
    expect(Array.from(out)).toEqual([5, 13]);
  });

  it("starts no higher than minRow, where a newer drop has repainted", () => {
    dropRows(out, 30.5, 3, 1, 2, 25, rows);
    expect(Array.from(out)).toEqual([25, 31]);
  });

  it("clips to the grid and is empty once the drop has passed or faded", () => {
    dropRows(out, 45, 2, 1, 1, 0, rows);
    expect(Array.from(out)).toEqual([42, 40]);
    expect(out[0]).toBeGreaterThanOrEqual(out[1]);
    dropRows(out, -3.5, 2, 1, 1, 0, rows);
    expect(out[1]).toBeLessThanOrEqual(out[0]);
    dropRows(out, 10, 2, 0, 1, 11, rows);
    expect(out[1]).toBeLessThanOrEqual(out[0]);
  });
});

describe("createRainSim", () => {
  const stride = DROP_FLOATS;
  const run = (sim: ReturnType<typeof createRainSim>, frames: number, density = 0.7) => {
    const data = new Float32Array(sim.cols * 2 * stride);
    let n = 0;
    for (let i = 0; i < frames; i++) n = sim.step(1 / 60, 14, density, 1, 1.5, data, stride);
    return { data, n };
  };

  it("emits at most two drops per column, each inside the grid", () => {
    const sim = createRainSim(createRng(1));
    sim.layout(50, 30, 0.7, true);
    const data = new Float32Array(100 * stride);
    for (let f = 0; f < 600; f++) {
      const n = sim.step(1 / 60, 14, 0.7, 1, 1.5, data, stride);
      expect(n).toBeLessThanOrEqual(100);
      const perColumn = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const o = i * stride;
        const [c, , rate, , r0, r1] = data.subarray(o, o + stride);
        perColumn.set(c, (perColumn.get(c) ?? 0) + 1);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(50);
        expect(rate).toBeGreaterThan(0);
        expect(r0).toBeGreaterThanOrEqual(0);
        expect(r0).toBeLessThan(r1);
        expect(r1).toBeLessThanOrEqual(30);
      }
      expect(Math.max(0, ...perColumn.values())).toBeLessThanOrEqual(2);
    }
  });

  it("keeps a column's two drops from overlapping", () => {
    const sim = createRainSim(createRng(2));
    sim.layout(20, 30, 1, true);
    const data = new Float32Array(40 * stride);
    let pairs = 0;
    let overlaps = 0;
    for (let f = 0; f < 900; f++) {
      const n = sim.step(1 / 60, 20, 1, 1, 3, data, stride);
      const spans = new Map<number, number[][]>();
      for (let i = 0; i < n; i++) {
        const o = i * stride;
        const list = spans.get(data[o]) ?? [];
        list.push([data[o + 4], data[o + 5]]);
        spans.set(data[o], list);
      }
      for (const list of spans.values()) {
        if (list.length === 2) {
          pairs++;
          if (list[1][0] < list[0][1]) overlaps++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(100);
    expect(overlaps).toBe(0);
  });

  it("starts a new drop once the current one is well past the bottom", () => {
    const sim = createRainSim(createRng(3));
    sim.layout(10, 20, 1, true);
    sim.heads.fill(19);
    sim.pace.fill(1);
    const data = new Float32Array(20 * stride);
    // One row per step. 20 rows + 30% of 20 at pace 1: restarts once past row 26.
    const step = () => sim.step(0.05, 20, 1, 1, 1, data, stride);
    for (let i = 0; i < 7; i++) step();
    expect(sim.heads[0]).toBeCloseTo(26, 4);
    step();
    expect(sim.heads[0]).toBeLessThanOrEqual(0);
    expect(sim.prevHeads[0]).toBeCloseTo(27, 4);
    expect(sim.prevActive[0]).toBe(1);
  });

  it("activates columns in proportion to the density", () => {
    const sim = createRainSim(createRng(4));
    sim.layout(2000, 20, 0.25, true);
    const share = sim.active.reduce((a, b) => a + b, 0) / 2000;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);
  });

  it("keeps the columns on screen across a resize and scatters only new ones", () => {
    const sim = createRainSim(createRng(5));
    sim.layout(10, 20, 1, true);
    run(sim, 30);
    const before = sim.heads.slice(0, 10);
    sim.layout(15, 25, 1, false);
    expect(sim.cols).toBe(15);
    expect(sim.rows).toBe(25);
    expect(sim.heads.slice(0, 10)).toEqual(before);
    for (let c = 10; c < 15; c++) {
      expect(sim.heads[c]).toBeLessThanOrEqual(0);
      expect(sim.heads[c]).toBeGreaterThanOrEqual(-1.5 * 25);
      expect(sim.prevActive[c]).toBe(0);
    }
    // A restart re-scatters every column above the top.
    sim.layout(15, 25, 1, true);
    for (let c = 0; c < 15; c++) expect(sim.heads[c]).toBeLessThanOrEqual(0);
  });
});
