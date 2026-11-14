import { describe, expect, it } from "vitest";
import {
  BAR_GROUPS,
  countTo,
  createCountUp,
  createDashboard,
  createWalk,
  type Dashboard,
  DONUT_SEGMENTS,
  KPI_COUNT,
  kpiChange,
  LINE_SERIES,
  snapCount,
  stepCount,
  stepDashboard,
  stepWalk,
  TABLE_ROWS,
  UPDATE_BARS,
  UPDATE_DONUT,
  UPDATE_KPI,
  UPDATE_LINE,
  UPDATE_TABLE,
  type Walk,
  walkAt,
  walkBounds,
  WALK_HISTORY,
} from "./dashboard-sim";

const allWalks = (d: Dashboard): Walk[] => [
  ...d.kpiWalks,
  ...d.lineWalks,
  ...d.barWalks,
  ...d.donutWalks,
  ...d.tableWalks,
];

describe("walks", () => {
  it("are deterministic per seed and key", () => {
    const a = createWalk(5, 3, 100, 0.1, 10);
    const b = createWalk(5, 3, 100, 0.1, 10);
    const c = createWalk(5, 4, 100, 0.1, 10);
    expect(walkAt(a, 0)).toBe(walkAt(b, 0));
    expect(walkAt(a, 0)).not.toBe(walkAt(c, 0));
  });

  it("keeps the newest values, oldest falling off", () => {
    const w = createWalk(1, 0, 100, 0.1, 0);
    expect(walkAt(w, 0)).toBe(100);
    const first = stepWalk(w);
    expect(walkAt(w, 0)).toBe(first);
    expect(walkAt(w, 5)).toBe(first);
    for (let i = 0; i < WALK_HISTORY + 3; i++) {
      stepWalk(w);
    }
    expect(walkAt(w, WALK_HISTORY + 10)).toBe(walkAt(w, WALK_HISTORY - 1));
  });

  it("rises and falls with the week", () => {
    // Over many weeks, the mean by day of week varies by about the seasonal amplitude.
    const w = createWalk(9, 0, 100, 0.1, 0);
    const sums = new Float64Array(7);
    for (let i = 0; i < 7 * 4000; i++) {
      sums[i % 7] += stepWalk(w);
    }
    const means = Array.from(sums, (s) => s / 4000);
    const spread = Math.max(...means) / Math.min(...means);
    expect(spread).toBeGreaterThan(1.12);
    expect(spread).toBeLessThan(1.3);
  });
});

describe("dashboard data", () => {
  it.each([1, 2, 3, 42, 999])("is deterministic per seed (seed %d)", (seed) => {
    const a = createDashboard(seed);
    const b = createDashboard(seed);
    for (let i = 0; i < 50; i++) {
      expect(stepDashboard(a)).toBe(stepDashboard(b));
    }
    expect(allWalks(a).map((w) => walkAt(w, 0))).toEqual(allWalks(b).map((w) => walkAt(w, 0)));
    expect(a.kpis).toEqual(b.kpis);
  });

  it("differs between seeds", () => {
    const a = createDashboard(1);
    const b = createDashboard(2);
    expect(walkAt(a.lineWalks[0], 0)).not.toBe(walkAt(b.lineWalks[0], 0));
  });

  it.each([1, 2, 3, 42, 999])("labels every card from the vocabulary (seed %d)", (seed) => {
    const d = createDashboard(seed);
    expect(d.kpis).toHaveLength(KPI_COUNT);
    expect(new Set(d.kpis.map((k) => k.label)).size).toBe(KPI_COUNT);
    expect(d.lineNames).toHaveLength(LINE_SERIES);
    expect(d.barGroups).toHaveLength(BAR_GROUPS);
    expect(d.donutNames).toHaveLength(DONUT_SEGMENTS);
    expect(d.tableNames).toHaveLength(TABLE_ROWS);
    for (const s of [d.lineTitle, d.barTitle, d.donutTitle, d.tableTitle, ...d.tableNames]) {
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it.each([1, 2, 3, 7, 42, 500, 999])(
    "stays within plausible bounds over hours of updates (seed %d)",
    (seed) => {
      const d = createDashboard(seed);
      const walks = allWalks(d);
      // Four hours at one update a second; checked against each walk's limits.
      let outside = 0;
      for (let t = 0; t < 4 * 3600; t++) {
        stepDashboard(d);
        for (const w of walks) {
          const v = walkAt(w, 0);
          const [lo, hi] = walkBounds(w);
          if (!(v >= lo * (1 - 1e-12) && v <= hi * (1 + 1e-12))) {
            outside++;
          }
        }
      }
      expect(outside).toBe(0);
      // Bounds sit within a factor of two of the base.
      for (const w of walks) {
        const [lo, hi] = walkBounds(w);
        expect(lo).toBeGreaterThan(w.base * 0.5);
        expect(hi).toBeLessThan(w.base * 2);
      }
    },
  );

  it("updates the line every tick, each KPI every fourth, each card every third", () => {
    const d = createDashboard(3);
    const kpiTicks: number[][] = [[], [], [], []];
    const cardTicks: number[][] = [[], [], []];
    for (let t = 0; t < 24; t++) {
      const f = stepDashboard(d);
      expect(f & UPDATE_LINE).toBe(UPDATE_LINE);
      for (let i = 0; i < KPI_COUNT; i++) {
        if (f & (UPDATE_KPI << i)) {
          kpiTicks[i].push(t);
        }
      }
      [UPDATE_BARS, UPDATE_DONUT, UPDATE_TABLE].forEach((flag, c) => {
        if (f & flag) {
          cardTicks[c].push(t);
        }
      });
    }
    kpiTicks.forEach((ticks, i) => {
      expect(ticks).toEqual([i, i + 4, i + 8, i + 12, i + 16, i + 20]);
    });
    cardTicks.forEach((ticks, c) => {
      expect(ticks).toEqual([0, 3, 6, 9, 12, 15, 18, 21].map((t) => t + c));
    });
  });

  it("keeps the previous bar values for comparison", () => {
    const d = createDashboard(4);
    const before = Array.from(d.barNow);
    stepDashboard(d);
    expect(Array.from(d.barPrev)).toEqual(before);
    expect(Array.from(d.barNow)).toEqual(d.barWalks.map((w) => walkAt(w, 0)));
  });

  it("measures KPI change against a week before", () => {
    const d = createDashboard(5);
    const w = d.kpiWalks[0];
    expect(kpiChange(w)).toBeCloseTo((walkAt(w, 0) - walkAt(w, 7)) / walkAt(w, 7), 12);
  });
});

describe("count-up", () => {
  it.each([
    [1, 1 / 60],
    [1, 1 / 144],
    [1.2, 0.017],
    [0.9, 0.3],
  ])("ends exactly on the target (%d s at %d s per frame)", (seconds, dt) => {
    const c = createCountUp(1234.5, seconds);
    countTo(c, 98_765.4321);
    let frames = 0;
    while (stepCount(c, dt)) {
      frames++;
      expect(c.value).toBeGreaterThanOrEqual(1234.5);
      expect(c.value).toBeLessThanOrEqual(98_765.4321);
    }
    expect(c.value).toBe(98_765.4321);
    expect(frames).toBeGreaterThanOrEqual(Math.floor(seconds / dt) - 1);
  });

  it("counts on from wherever it is when retargeted", () => {
    const c = createCountUp(0, 1);
    countTo(c, 100);
    stepCount(c, 0.5);
    const mid = c.value;
    expect(mid).toBeCloseTo(50, 6);
    countTo(c, 0);
    expect(c.from).toBe(mid);
    stepCount(c, 0.01);
    expect(c.value).toBeLessThan(mid);
    snapCount(c, 7);
    expect(stepCount(c, 0.1)).toBe(false);
    expect(c.value).toBe(7);
  });
});
