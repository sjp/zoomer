import { describe, expect, it } from "vitest";
import {
  arcEnds,
  COMPLETED,
  createTruchet,
  easeInOut,
  FADE_DURATION,
  FLIP_DURATION,
  gridLayout,
  labelPaths,
  MAX_FLIPS,
  MIN_TILE_PX,
  nodeCount,
  palette,
  PALETTES,
  pathTone,
  STARTED,
  styleIndex,
  STYLES,
  TONES,
  type TruchetSim,
} from "./truchet-sim";
import { createRng } from "./noise";
import { PALETTE_OPTIONS, STYLE_OPTIONS } from "./truchet.meta";

const DT = 1 / 60;

describe("grid layout", () => {
  it("covers the frame, centred, with an even tile count, at any aspect ratio", () => {
    const bad: string[] = [];
    const sizes = [
      [1920, 1080],
      [3840, 2160],
      [1080, 1920],
      [1000, 1000],
      [2560, 1080],
      [300, 1700],
      [1, 1],
      [7, 3],
    ];
    for (const [w, h] of sizes) {
      for (const tile of [2, 4, 60, 110, 137.5, 360, 5000]) {
        const g = gridLayout(w, h, tile);
        const t = g.tilePx;
        const ok =
          t === Math.max(MIN_TILE_PX, tile) &&
          g.cols % 2 === 0 &&
          g.rows % 2 === 0 &&
          g.ox <= 0 &&
          g.oy <= 0 &&
          g.ox + g.cols * t >= w &&
          g.oy + g.rows * t >= h &&
          // At most one spare tile each side, and centred.
          g.cols * t - w < 2 * t &&
          g.rows * t - h < 2 * t &&
          Math.abs(g.ox + (g.cols * t) / 2 - w / 2) < 1e-9 &&
          Math.abs(g.oy + (g.rows * t) / 2 - h / 2) < 1e-9;
        if (!ok) bad.push(`${w}x${h} @ ${tile}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("path labelling", () => {
  it("arc ends are edge midpoints of the tile, and each midpoint has at most two arcs", () => {
    const cols = 5;
    const rows = 4;
    const uses = new Int32Array(nodeCount(cols, rows));
    const ends = [0, 0];
    const rng = createRng(4);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const o = rng() < 0.5 ? 0 : 1;
        for (let arc = 0; arc < 2; arc++) {
          arcEnds(cols, rows, i, j, o, arc, ends);
          uses[ends[0]]++;
          uses[ends[1]]++;
        }
      }
    }
    // Every midpoint is on one tile edge (border) or two (interior), and each tile
    // puts exactly one arc end on each of its four edges.
    expect(Math.max(...uses)).toBe(2);
    expect(Math.min(...uses)).toBe(1);
    expect(uses.reduce((a, b) => a + b, 0)).toBe(4 * cols * rows);
  });

  it("finds the expected paths in a hand-built 3x3 grid", () => {
    // 24 midpoints and 18 arcs with no loop: every path is open, so 24 - 18 = 6.
    const flat = new Uint8Array(9);
    const out = new Int32Array(18);
    expect(labelPaths(3, 3, flat, out)).toBe(6);
    // All orientation 0: the paths are staircases, one per diagonal. Arc B of
    // tile (0, 1) and arc A of tile (1, 1) share the midpoint between them.
    expect(out[2 * 3 + 1]).toBe(out[2 * 4]);

    // Four tiles around the vertex (1, 1) turned to close a circle round it: one
    // more path (a loop: nodes - arcs + loops).
    const loop = Uint8Array.from([0, 1, 0, 1, 0, 0, 0, 0, 0]);
    const lout = new Int32Array(18);
    expect(labelPaths(3, 3, loop, lout)).toBe(7);
    // The loop is B of (0, 0), B of (1, 0), A of (0, 1) and A of (1, 1).
    const ring = [lout[1], lout[3], lout[6], lout[8]];
    expect(new Set(ring).size).toBe(1);
    expect(lout.filter((l) => l === ring[0]).length).toBe(4);
  });

  it("labels each path with its smallest midpoint, so untouched paths keep theirs", () => {
    const cols = 12;
    const rows = 8;
    const rng = createRng(11);
    const orient = new Uint8Array(cols * rows);
    const before = new Int32Array(2 * cols * rows);
    const after = new Int32Array(2 * cols * rows);
    const ends = [0, 0];
    let changedUntouched = 0;
    let checked = 0;
    for (let trial = 0; trial < 40; trial++) {
      for (let t = 0; t < orient.length; t++) orient[t] = rng() < 0.5 ? 0 : 1;
      labelPaths(cols, rows, orient, before);
      const t = Math.floor(rng() * orient.length);
      const i = t % cols;
      const j = (t - i) / cols;
      // Paths through the flipped tile are the touched ones.
      const touched = new Set<number>([before[2 * t], before[2 * t + 1]]);
      orient[t] ^= 1;
      labelPaths(cols, rows, orient, after);
      for (let a = 0; a < after.length; a++) {
        if (touched.has(before[a])) continue;
        checked++;
        if (after[a] !== before[a]) changedUntouched++;
      }
      // Labels are smallest midpoints: no arc end is below its path's label.
      for (let k = 0; k < orient.length; k++) {
        const ki = k % cols;
        const kj = (k - ki) / cols;
        for (let arc = 0; arc < 2; arc++) {
          arcEnds(cols, rows, ki, kj, orient[k], arc, ends);
          if (Math.min(ends[0], ends[1]) < after[2 * k + arc]) changedUntouched++;
        }
      }
      expect(i + j * cols).toBe(t);
    }
    expect(checked).toBeGreaterThan(1000);
    expect(changedUntouched).toBe(0);
  });

  it("gives tones in range, deterministic per seed", () => {
    let bad = 0;
    const counts = new Array(TONES).fill(0);
    for (let label = 0; label < 3000; label++) {
      const a = pathTone(label, 3);
      if (!(a >= 0 && a < TONES && Number.isInteger(a)) || a !== pathTone(label, 3)) bad++;
      counts[a]++;
    }
    expect(bad).toBe(0);
    for (const c of counts) expect(c).toBeGreaterThan(800);
  });
});

/** Runs `sim` for `seconds`, checking slot invariants each step; returns problems found. */
function run(sim: TruchetSim, seconds: number, rate: number): string[] {
  const problems: string[] = [];
  const startOf = new Float64Array(sim.cols * sim.rows).fill(Number.NaN);
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    sim.step(DT, rate);
    const seen = new Set<number>();
    for (let s = 1; s <= MAX_FLIPS; s++) {
      const t = sim.slotTile[s];
      if (t < 0) continue;
      if (seen.has(t)) problems.push(`tile ${t} in two slots`);
      seen.add(t);
      if (sim.tileSlot[t] !== s) problems.push(`tile ${t} slot mismatch`);
      const prev = startOf[t];
      // A flipping tile is never restarted before its flip ends.
      if (!Number.isNaN(prev) && prev !== sim.slotStart[s] && sim.time - prev < FLIP_DURATION) {
        problems.push(`tile ${t} restarted mid-flip`);
      }
      startOf[t] = sim.slotStart[s];
    }
    if (problems.length > 5) break;
  }
  return problems;
}

describe("flip scheduler", () => {
  it("flips at the requested rate on average and never restarts a flipping tile", () => {
    const sim = createTruchet({ cols: 18, rows: 10, seed: 5 });
    const rate = 2;
    const seconds = 1000;
    expect(run(sim, seconds, rate)).toEqual([]);
    const expected = rate * seconds;
    const total = sim.started + sim.dropped;
    // Poisson: sd = sqrt(2000) ~ 45, so 5% is over 2 sd.
    expect(Math.abs(total - expected)).toBeLessThan(0.05 * expected);
    expect(sim.dropped).toBeLessThan(0.01 * expected);
  });

  it("is deterministic per seed, and different seeds differ", () => {
    const a = createTruchet({ cols: 12, rows: 8, seed: 9 });
    const b = createTruchet({ cols: 12, rows: 8, seed: 9 });
    const c = createTruchet({ cols: 12, rows: 8, seed: 10 });
    for (let k = 0; k < 1200; k++) {
      a.step(DT, 1.5);
      b.step(DT, 1.5);
      c.step(DT, 1.5);
    }
    expect(Array.from(a.orient)).toEqual(Array.from(b.orient));
    expect(Array.from(a.slotStart)).toEqual(Array.from(b.slotStart));
    expect(a.started).toBe(b.started);
    expect(Array.from(a.orient)).not.toEqual(Array.from(c.orient));
  });

  it("does nothing at rate 0, and copes with odd input", () => {
    const sim = createTruchet({ cols: 4, rows: 2, seed: 1 });
    const before = Array.from(sim.orient);
    let flags = 0;
    for (let k = 0; k < 600; k++) flags |= sim.step(DT, 0);
    flags |= sim.step(Number.NaN, Number.NaN);
    flags |= sim.step(-1, -5);
    expect(flags).toBe(0);
    expect(sim.started).toBe(0);
    expect(Array.from(sim.orient)).toEqual(before);
  });

  it("toggles a tile once its flip completes, easing in and out", () => {
    const sim = createTruchet({ cols: 6, rows: 4, seed: 2 });
    let flags = 0;
    while (!(flags & STARTED)) flags = sim.step(DT, 1);
    const s = sim.slotTile.findIndex((t, i) => i > 0 && t >= 0);
    const tile = sim.slotTile[s];
    const o = sim.orient[tile];
    const eases: number[] = [];
    while (sim.slotTile[s] === tile) {
      eases.push(sim.ease(s));
      // No new flips, so the slot can't be reused before we look.
      flags = sim.step(DT, 0);
    }
    expect(flags & COMPLETED).toBe(COMPLETED);
    expect(sim.orient[tile]).toBe(o ^ 1);
    expect(sim.tileSlot[tile]).toBe(0);
    expect(sim.ease(s)).toBe(0);
    let monotonic = true;
    for (let k = 1; k < eases.length; k++) if (eases[k] < eases[k - 1]) monotonic = false;
    expect(monotonic).toBe(true);
    expect(eases.length).toBeGreaterThanOrEqual(Math.floor(FLIP_DURATION / DT) - 7);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(1)).toBe(1);
  });
});

describe("colours and encoding", () => {
  it("relabels after a flip and cross-fades the arcs whose tone changed", () => {
    const sim = createTruchet({ cols: 16, rows: 10, seed: 8 });
    const fresh = new Int32Array(sim.labels.length);
    let fadeSeen = false;
    let bad = 0;
    for (let k = 0; k < 3000; k++) {
      const flags = sim.step(DT, 2);
      if (flags & COMPLETED) {
        labelPaths(sim.cols, sim.rows, sim.orient, fresh);
        for (let a = 0; a < fresh.length; a++) {
          if (fresh[a] !== sim.labels[a] || sim.toneTo[a] !== pathTone(fresh[a], sim.seed)) bad++;
        }
      }
      for (let t = 0; t < sim.fade.length; t++) {
        if (sim.fade[t] < 1) fadeSeen = true;
        if (!(sim.fade[t] >= 0 && sim.fade[t] <= 1)) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(fadeSeen).toBe(true);
    // With no new flips, the running ones complete and every fade finishes.
    const settle = Math.ceil((FLIP_DURATION + FADE_DURATION) / DT) + 2;
    for (let k = 0; k < settle; k++) sim.step(DT, 0);
    expect(Math.min(...sim.fade)).toBe(1);
  });

  it("packs orientation, slot, direction, tones and fade into each texel", () => {
    const sim = createTruchet({ cols: 8, rows: 6, seed: 4 });
    const data = new Uint8Array(4 * 48);
    let bad = 0;
    for (let k = 0; k < 900; k++) {
      sim.step(DT, 3);
      if (k % 10) continue;
      sim.encode(data);
      for (let t = 0; t < 48; t++) {
        const r = data[4 * t];
        const g = data[4 * t + 1];
        const slot = r >> 2;
        if ((r & 1) !== sim.orient[t] || slot !== sim.tileSlot[t]) bad++;
        if (slot && ((r >> 1) & 1) !== sim.slotDir[slot]) bad++;
        if ((g & 3) !== sim.toneFrom[2 * t] || ((g >> 2) & 3) !== sim.toneTo[2 * t]) bad++;
        if (((g >> 4) & 3) !== sim.toneFrom[2 * t + 1] || g >> 6 !== sim.toneTo[2 * t + 1]) bad++;
        if (Math.abs(data[4 * t + 2] / 255 - sim.fade[t]) > 0.5 / 255 + 1e-6) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("carries orientations over to a resized grid, matched from the centre", () => {
    const a = createTruchet({ cols: 10, rows: 6, seed: 6 });
    for (let k = 0; k < 1200; k++) a.step(DT, 3);
    const b = createTruchet({ cols: 14, rows: 4, seed: 6, from: a });
    let bad = 0;
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 14; i++) {
        const pi = i - 2;
        const pj = j + 1;
        if (pi < 0 || pi >= 10) continue;
        if (b.orient[i + j * 14] !== a.orient[pi + pj * 10]) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("has palettes and styles for every option, with fallbacks", () => {
    expect(PALETTE_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(PALETTES).sort());
    expect(STYLE_OPTIONS.map((o) => o.value)).toEqual([...STYLES]);
    for (const p of Object.values(PALETTES)) expect(p.bands.length).toBe(TONES);
    expect(palette("nope")).toBe(PALETTES.slate);
    expect(styleIndex("shaded")).toBe(2);
    expect(styleIndex("nope")).toBe(0);
  });
});
