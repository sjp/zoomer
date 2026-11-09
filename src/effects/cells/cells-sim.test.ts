import { describe, expect, it } from "vitest";
import {
  advanceCells,
  baseRadius,
  CENTRE_AREA,
  CENTRE_GROWTH,
  centreWeight,
  createCellsSim,
  type CellsOptions,
  FIXED_DT,
  GROW_STEPS,
  MAX_CELLS,
  MAX_STEPS,
  MIN_CELLS,
  MODE_ABSORBING,
  MODE_GROWING,
  MODE_NORMAL,
  packCells,
  fastestSpeed,
  palette,
  PALETTES,
  plannedCount,
  powerSample,
  resizeCellsSim,
  splitCell,
  stepCells,
  targetCount,
} from "./cells-sim";
import { PALETTE_OPTIONS } from "./cells.meta";

const W = 1920;
const H = 1080;
/** Steps per simulated second. */
const SPS = Math.round(1 / FIXED_DT);
/** Index of the fastest live cell. */
const fastestCell = (sim: ReturnType<typeof createCellsSim>) => {
  let best = 0;
  for (let i = 1; i < sim.n; i++) {
    if (Math.hypot(sim.vx[i], sim.vy[i]) > Math.hypot(sim.vx[best], sim.vy[best])) {
      best = i;
    }
  }
  return best;
};

const opts = (o: Partial<CellsOptions> = {}): CellsOptions => ({
  count: 40,
  division: 3,
  motion: 0.5,
  calm: true,
  ...o,
});

describe("cell count", () => {
  it("clamps the target to MIN_CELLS..MAX_CELLS", () => {
    expect(targetCount(0)).toBe(MIN_CELLS);
    expect(targetCount(1000)).toBe(MAX_CELLS);
    expect(targetCount(Number.NaN)).toBe(MIN_CELLS);
    expect(targetCount(40.4)).toBe(40);
  });

  it("holds exactly through many paired divisions", () => {
    const o = opts({ division: 12, count: 64 });
    const sim = createCellsSim(1, o, W, H);
    const startSerial = sim.serial;
    let off = 0;
    for (let s = 0; s < SPS * 90; s++) {
      stepCells(sim, o);
      if (sim.n !== 64) {
        off++;
      }
    }
    expect(off).toBe(0);
    // About 12 per minute for 1.5 minutes.
    expect(sim.serial - startSerial).toBeGreaterThan(12);
  });

  it("stays within bounds while the target changes", () => {
    const o = opts({ division: 12 });
    const sim = createCellsSim(2, o, W, H);
    const targets = [64, 12, 50, 64, 20, 33];
    let bad = 0;
    for (const t of targets) {
      o.count = t;
      // Births need idle parents, so a big jump takes a few rounds of division.
      for (let s = 0; s < GROW_STEPS * 12 && (sim.n !== t || plannedCount(sim) !== t); s++) {
        stepCells(sim, o);
        if (sim.n > MAX_CELLS || sim.n < MIN_CELLS) {
          bad++;
        }
      }
      if (sim.n !== t) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });
});

describe("division", () => {
  it("conserves area and starts the daughters merged", () => {
    const sim = createCellsSim(4, opts(), W, H);
    const i = 5;
    const j = sim.n;
    const r = sim.r[i];
    const x = sim.x[i];
    const y = sim.y[i];
    splitCell(sim, i, j);
    sim.n++;
    expect(sim.r[i] ** 2 + sim.r[j] ** 2).toBeCloseTo(r * r, 9);
    expect(sim.r[i]).toBeCloseTo(sim.r[j], 12);
    // Either side of the parent's centre.
    expect((sim.x[i] + sim.x[j]) / 2).toBeCloseTo(x, 9);
    expect((sim.y[i] + sim.y[j]) / 2).toBeCloseTo(y, 9);
    expect(Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j])).toBeGreaterThan(0.5 * sim.r[i]);
    expect(sim.merge[i]).toBe(1);
    expect(sim.merge[j]).toBe(1);
    expect(sim.sister[i]).toBe(sim.sister[j]);
    expect(sim.mode[i]).toBe(MODE_NORMAL);
    expect(sim.mode[j]).toBe(MODE_NORMAL);
  });

  it("doubles the parent's area while it grows, and the victim shrinks to nothing", () => {
    const o = opts({ division: 0 });
    const sim = createCellsSim(5, o, W, H);
    o.division = 60; // One event due after a second.
    let parent = -1;
    let victim = -1;
    for (let s = 0; s < 60 && parent < 0; s++) {
      stepCells(sim, o);
      for (let i = 0; i < sim.n; i++) {
        if (sim.mode[i] === MODE_GROWING) {
          parent = i;
        }
        if (sim.mode[i] === MODE_ABSORBING) {
          victim = i;
        }
      }
    }
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(victim).toBeGreaterThanOrEqual(0);
    o.division = 0;
    const r0 = sim.r0[parent];
    const v0 = sim.r[victim];
    const timer = sim.timer[parent];
    for (let s = 1; s < timer; s++) {
      stepCells(sim, o);
    }
    // One step before the split: grown to (almost) twice the area; the victim almost gone.
    expect(sim.r[parent] / r0).toBeGreaterThan(Math.SQRT2 * 0.999);
    expect(sim.r[victim] / v0).toBeLessThan(0.01);
    const n = sim.n;
    stepCells(sim, o);
    expect(sim.n).toBe(n);
  });
});

describe("packing", () => {
  it("never collapses two cells onto one point, and keeps overlaps bounded", () => {
    const o = opts({ division: 6, motion: 1 });
    const sim = createCellsSim(6, o, W, H);
    const rb = baseRadius(W, H, o.count);
    let minD = Infinity;
    let maxOverlap = 0;
    let overlapSum = 0;
    let pairs = 0;
    for (let s = 0; s < SPS * 120; s++) {
      stepCells(sim, o);
      if (s % 30) {
        continue;
      }
      for (let i = 0; i < sim.n; i++) {
        for (let j = i + 1; j < sim.n; j++) {
          const d = Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j]);
          const sisters = sim.merge[i] > 0 && sim.sister[i] === sim.sister[j];
          if (!sisters) {
            minD = Math.min(minD, d);
          }
          const settled =
            !sisters &&
            sim.mode[i] === MODE_NORMAL &&
            sim.mode[j] === MODE_NORMAL &&
            sim.merge[i] === 0 &&
            sim.merge[j] === 0;
          if (!settled) {
            continue;
          }
          const ov = Math.max(0, (sim.r[i] + sim.r[j] - d) / (sim.r[i] + sim.r[j]));
          maxOverlap = Math.max(maxOverlap, ov);
          overlapSum += ov;
          pairs++;
        }
      }
    }
    expect(minD).toBeGreaterThan(0.5 * rb);
    expect(maxOverlap).toBeLessThan(0.5);
    // Packed, not piled up: the average contact is a light press.
    expect(overlapSum / pairs).toBeLessThan(0.02);
  });

  it("keeps cells near the frame", () => {
    const o = opts({ motion: 1 });
    const sim = createCellsSim(7, o, W, H);
    const rb = baseRadius(W, H, o.count);
    let worst = 0;
    for (let s = 0; s < SPS * 60; s++) {
      stepCells(sim, o);
      for (let i = 0; i < sim.n; i++) {
        // Daughters may briefly start a little further out, when the parent was at the edge.
        if (sim.merge[i] > 0) {
          continue;
        }
        const out = Math.max(-sim.x[i], sim.x[i] - W, -sim.y[i], sim.y[i] - H);
        worst = Math.max(worst, out);
      }
    }
    expect(worst).toBeLessThan(0.6 * rb);
  });

  it("makes centre cells larger when calm, keeping the total area", () => {
    expect(centreWeight(0.5)).toBe(1);
    expect(centreWeight(0)).toBe(0);
    expect(centreWeight(1)).toBe(0);
    expect(CENTRE_AREA).toBeGreaterThan(1);
    expect(CENTRE_AREA).toBeLessThan(CENTRE_GROWTH ** 2);
    const o = opts({ division: 0 });
    const sim = createCellsSim(8, o, W, H);
    let centre = 0;
    let nc = 0;
    let edge = 0;
    let ne = 0;
    for (let i = 0; i < sim.n; i++) {
      const u = sim.x[i] / W;
      if (Math.abs(u - 0.5) < 0.1) {
        centre += sim.r[i] / sim.size[i];
        nc++;
      } else if (Math.abs(u - 0.5) > 0.3) {
        edge += sim.r[i] / sim.size[i];
        ne++;
      }
    }
    expect(centre / nc / (edge / ne)).toBeGreaterThan(1.2);
  });
});

describe("stepping", () => {
  it("is deterministic per seed", () => {
    const o = opts({ division: 8 });
    const a = createCellsSim(9, o, W, H);
    const b = createCellsSim(9, o, W, H);
    const c = createCellsSim(10, o, W, H);
    for (let s = 0; s < SPS * 30; s++) {
      stepCells(a, o);
      stepCells(b, o);
      stepCells(c, o);
    }
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.r)).toEqual(Array.from(b.r));
    expect(a.serial).toBe(b.serial);
    expect(Array.from(a.x)).not.toEqual(Array.from(c.x));
  });

  it("takes fixed steps, capped per frame", () => {
    const sim = createCellsSim(11, opts(), W, H);
    expect(advanceCells(sim, 0, opts())).toBe(0);
    expect(advanceCells(sim, Number.NaN, opts())).toBe(0);
    expect(advanceCells(sim, 10, opts())).toBe(MAX_STEPS);
    let steps = 0;
    for (let f = 0; f < 120; f++) {
      steps += advanceCells(sim, 1 / 120, opts());
    }
    expect(Math.abs(steps - 1 / FIXED_DT)).toBeLessThanOrEqual(1);
  });

  it("stretches positions on resize", () => {
    const sim = createCellsSim(12, opts(), W, H);
    const x = sim.x[3];
    const y = sim.y[3];
    resizeCellsSim(sim, W * 1.5, H);
    expect(sim.x[3]).toBeCloseTo(x * 1.5, 9);
    expect(sim.y[3]).toBe(y);
    expect(sim.width).toBe(W * 1.5);
  });
});

describe("power diagram", () => {
  it("packs cells as the shader reads them", () => {
    const sim = createCellsSim(13, opts(), W, H);
    const cells = new Float32Array(MAX_CELLS * 4);
    const info = new Float32Array(MAX_CELLS * 4);
    expect(packCells(sim, cells, info)).toBe(sim.n);
    expect(cells[2]).toBeCloseTo(sim.r[0] ** 2, 1);
    expect(cells[3]).toBeCloseTo(sim.r[0], 3);
    expect(info[2]).toBe(0);
  });

  it("extrapolates positions by the lead, so a 144 Hz display moves every frame", () => {
    const o = opts({ motion: 1, division: 0 });
    const sim = createCellsSim(21, o, W, H);
    for (let i = 0; i < 120; i++) {
      advanceCells(sim, 1 / 60, o);
    }
    const cells = new Float32Array(MAX_CELLS * 4);
    const info = new Float32Array(MAX_CELLS * 4);
    const moves: number[] = [];
    const k = fastestCell(sim);
    let prevX = 0;
    let prevY = 0;
    for (let f = 0; f <= 72; f++) {
      advanceCells(sim, 1 / 144, o);
      packCells(sim, cells, info, sim.acc);
      if (f > 0) {
        moves.push(Math.hypot(cells[k * 4] - prevX, cells[k * 4 + 1] - prevY));
      }
      prevX = cells[k * 4];
      prevY = cells[k * 4 + 1];
    }
    const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
    expect(mean).toBeGreaterThan(0.01);
    // Whole steps alone would give 0, 1 or 2 steps' worth a frame (a 2-3-2 cadence).
    for (const m of moves) {
      expect(Math.abs(m - mean)).toBeLessThan(0.25 * mean);
    }
    expect(fastestSpeed(sim)).toBeGreaterThan(0);
  });

  it("puts the edge on the radical line, which favours the larger cell", () => {
    // Radii 100 and 50, centres 200 apart: the radical line is at x = (200² + 100² - 50²) / 400.
    const cells = new Float32Array([0, 0, 100 * 100, 100, 200, 0, 50 * 50, 50]);
    const line = (200 * 200 + 100 * 100 - 50 * 50) / 400;
    expect(line).toBeGreaterThan(100);
    const a = powerSample(cells, 2, line - 10, 30);
    expect(a.best).toBe(0);
    expect(a.edge).toBeCloseTo(10, 6);
    const b = powerSample(cells, 2, line + 4, -20);
    expect(b.best).toBe(1);
    expect(b.edge).toBeCloseTo(4, 6);
  });
});

describe("palettes", () => {
  it("has an option per palette, five colours each, and falls back to stain", () => {
    expect(PALETTE_OPTIONS.map((o) => o.value).toSorted()).toEqual(
      Object.keys(PALETTES).toSorted(),
    );
    for (const colors of Object.values(PALETTES)) {
      expect(colors).toHaveLength(5);
    }
    expect(palette("nope")).toBe(PALETTES.stain);
    expect(palette("mono")).toBe(PALETTES.mono);
  });
});
