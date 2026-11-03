import { describe, expect, it } from "vitest";
import {
  coreEnvelope,
  createEventSchedule,
  createGroundLayout,
  createMeteorPose,
  createShower,
  createSkyFrame,
  DIRECTION_JITTER,
  ellipseEntry,
  EXCLUDE_RX,
  EXCLUDE_RY,
  EXCLUDE_SOFT,
  EXCLUDE_Y,
  fillHillTable,
  FLOOR_MARGIN,
  HILL_CHANNELS,
  HILL_COLUMNS,
  HILL_TOP,
  hillHeightAt,
  layoutGround,
  MAX_ACTIVE,
  MAX_TREES,
  meteorAt,
  meteorLife,
  REF_HEIGHT,
  SCHEDULE_MAX_LAG,
  setSkyFrame,
  spawnMeteor,
  stepShower,
  takeEvent,
  TRAIL_PEAK,
  trailEnvelope,
  TREE_FLOATS,
} from "./meteors-sim";
import { createRng } from "./noise";

/** Event times from `t0` to `t1` (s), polled every `dt`. */
function collect(seed: number, rate: number, t1: number, dt = 1 / 30): number[] {
  const s = createEventSchedule(seed);
  const out: number[] = [];
  for (let t = 0; t <= t1; t += dt) {
    for (let at = takeEvent(s, t, rate); !Number.isNaN(at); at = takeEvent(s, t, rate)) {
      out.push(at);
    }
  }
  return out;
}

describe("event schedule", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    expect(collect(4, 0.2, 300)).toEqual(collect(4, 0.2, 300));
    expect(collect(4, 0.2, 300)).not.toEqual(collect(5, 0.2, 300));
  });

  it("matches the rate on average", () => {
    const rate = 12 / 60;
    const span = 20000;
    const n = collect(9, rate, span, 0.5).length;
    // Poisson: sd = sqrt(4000) ~ 63, so ±5% is about 3 sd.
    expect(Math.abs(n / (rate * span) - 1)).toBeLessThan(0.05);
  });

  it("releases events in order, each no later than the poll that returned it", () => {
    const s = createEventSchedule(2);
    let last = -Infinity;
    let ok = true;
    for (let t = 0; t <= 600; t += 0.25) {
      for (let at = takeEvent(s, t, 1); !Number.isNaN(at); at = takeEvent(s, t, 1)) {
        if (!(at >= last && at <= t)) ok = false;
        last = at;
      }
    }
    expect(ok).toBe(true);
  });

  it("schedules nothing at rate 0 and drops a stale backlog", () => {
    const s = createEventSchedule(1);
    expect(takeEvent(s, 0, 0)).toBeNaN();
    expect(takeEvent(s, 1000, 0)).toBeNaN();
    takeEvent(s, 0, 5);
    let released = 0;
    for (let at = takeEvent(s, 1000, 5); !Number.isNaN(at); at = takeEvent(s, 1000, 5)) {
      released++;
      expect(at).toBeGreaterThanOrEqual(1000 - SCHEDULE_MAX_LAG);
    }
    expect(released).toBeLessThan(5 * SCHEDULE_MAX_LAG * 4);
  });
});

describe("meteor paths", () => {
  const frame = (radiant: string, top = 200) => setSkyFrame(createSkyFrame(), 1920, radiant, top);

  it("point away from the radiant, clear of the centre and above the floor", () => {
    let bad = 0;
    let spawned = 0;
    for (const radiant of ["topLeft", "topRight", "offFrame"]) {
      const f = frame(radiant);
      const rand = createRng(11);
      const m = createShower(0).list[0];
      for (let i = 0; i < 400; i++) {
        if (!spawnMeteor(m, 0, f, 0.3, rand)) continue;
        spawned++;
        const ox = m.x - f.radiantX;
        const oy = m.y - f.radiantY;
        const cos = (ox * m.dx + oy * m.dy) / Math.hypot(ox, oy);
        if (cos < Math.cos(DIRECTION_JITTER) - 1e-9) bad++;
        if (Math.abs(Math.hypot(m.dx, m.dy) - 1) > 1e-9) bad++;
        // The whole path stays out of the smallest exclusion ellipse and above the floor.
        const ex = m.x + m.dx * m.length;
        const ey = m.y + m.dy * m.length;
        const k = EXCLUDE_SOFT[0];
        const entry = ellipseEntry(
          m.x,
          m.y,
          m.dx,
          m.dy,
          960,
          EXCLUDE_Y * REF_HEIGHT,
          EXCLUDE_RX * 1920 * k,
          EXCLUDE_RY * REF_HEIGHT * k,
        );
        if (entry < m.length) bad++;
        if (Math.min(m.y, ey) < f.floor - 1e-6) bad++;
        if (ex === m.x && ey === m.y) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(spawned).toBeGreaterThan(1000);
  });

  it("raises the floor above the ground", () => {
    expect(frame("topLeft", 300).floor).toBe(300 + FLOOR_MARGIN);
    expect(frame("topLeft", 0).floor).toBe(0);
  });

  it("finds where a ray enters an ellipse", () => {
    expect(ellipseEntry(0, 0, 1, 0, 10, 0, 2, 3)).toBeCloseTo(8);
    expect(ellipseEntry(10, 0, 1, 0, 10, 0, 2, 3)).toBe(0);
    expect(ellipseEntry(0, 10, 1, 0, 10, 0, 2, 3)).toBe(Infinity);
    expect(ellipseEntry(20, 0, 1, 0, 10, 0, 2, 3)).toBe(Infinity);
  });
});

describe("envelopes", () => {
  it("start and end at zero and stay in [0, 1]", () => {
    for (const bright of [false, true]) {
      expect(coreEnvelope(0, bright)).toBe(0);
      expect(coreEnvelope(1, bright)).toBe(0);
      expect(coreEnvelope(-0.5, bright)).toBe(0);
      expect(coreEnvelope(1.5, bright)).toBe(0);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      for (const bright of [false, true]) {
        const v = coreEnvelope(i / 1000, bright);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const g = trailEnvelope(i / 100, 0.8, 3);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    expect(lo).toBe(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi).toBeGreaterThan(0.9);
    expect(trailEnvelope(0, 0.8, 3)).toBe(0);
    expect(trailEnvelope(3.8, 0.8, 3)).toBe(0);
    expect(trailEnvelope(0.5, 0.8, 0)).toBe(0);
  });

  it("flares near the end of a bright meteor's flight", () => {
    expect(coreEnvelope(0.9, true)).toBeGreaterThan(coreEnvelope(0.5, true));
    expect(coreEnvelope(0.9, false)).toBeLessThan(coreEnvelope(0.5, false));
  });

  it("pose grows from a point, ends dark and keeps the trail on the path", () => {
    const f = setSkyFrame(createSkyFrame(), 1920, "topLeft", 200);
    const m = createShower(0).list[0];
    const rand = createRng(3);
    while (!spawnMeteor(m, 10, f, 1, rand));
    const p = createMeteorPose();
    meteorAt(m, 10, p);
    expect(p.core).toBe(0);
    expect(Math.hypot(p.headX - p.tailX, p.headY - p.tailY)).toBeCloseTo(0);
    meteorAt(m, 10 + m.duration * 0.5, p);
    expect(p.core).toBeGreaterThan(0);
    expect(p.trail).toBeGreaterThan(0);
    expect(p.trail).toBeLessThanOrEqual(TRAIL_PEAK * m.peak);
    meteorAt(m, 10 + m.duration + 0.01, p);
    expect(p.core).toBe(0);
    expect(p.trail).toBeGreaterThan(0);
    expect(Math.hypot(p.trailEndX - m.x, p.trailEndY - m.y)).toBeCloseTo(m.length, 3);
    meteorAt(m, 10 + meteorLife(m), p);
    expect(p.trail).toBe(0);
    expect(p.spread).toBe(1);
  });
});

describe("shower", () => {
  it("caps the active list and drops faded meteors", () => {
    const s = createShower(6);
    const f = setSkyFrame(createSkyFrame(), 1920, "offFrame", 200);
    let maxCount = 0;
    let stale = 0;
    for (let t = 0; t < 600; t += 1 / 20) {
      stepShower(s, t, 60, 1, f);
      maxCount = Math.max(maxCount, s.count);
      for (let i = 0; i < s.count; i++) {
        if (t - s.list[i].start >= meteorLife(s.list[i])) stale++;
      }
    }
    expect(maxCount).toBeLessThanOrEqual(MAX_ACTIVE);
    expect(stale).toBe(0);
    expect(s.started).toBeGreaterThan(300);
  });

  it("is deterministic for a seed", () => {
    const run = (seed: number) => {
      const s = createShower(seed);
      const f = setSkyFrame(createSkyFrame(), 2560, "topRight", 250);
      const out: number[] = [];
      for (let t = 0; t < 120; t += 1 / 30) {
        stepShower(s, t, 20, 0.3, f);
        for (let i = 0; i < s.count; i++) out.push(s.list[i].start, s.list[i].x, s.list[i].dy);
      }
      return out;
    };
    expect(run(8)).toEqual(run(8));
    expect(run(8)).not.toEqual(run(9));
  });
});

describe("ground", () => {
  const table = new Float32Array(HILL_COLUMNS * HILL_CHANNELS);

  it("fills hills within range, deterministically", () => {
    fillHillTable(table, 4, 1920);
    const copy = table.slice();
    fillHillTable(table, 4, 1920);
    expect(table).toEqual(copy);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of table) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThanOrEqual(HILL_TOP + 1e-6);
    expect(hillHeightAt(table, 0, 0)).toBeCloseTo(table[0]);
  });

  it("places trees and the tent on the near hill, in the outer thirds, under the top", () => {
    for (const seed of [1, 2, 3, 4]) {
      fillHillTable(table, seed, 1920);
      const g = layoutGround(createGroundLayout(), table, "trees", seed, 1920);
      expect(g.treeCount).toBeGreaterThan(0);
      expect(g.treeCount).toBeLessThanOrEqual(MAX_TREES);
      for (let i = 0; i < g.treeCount; i++) {
        const [x, y, h] = g.trees.subarray(i * TREE_FLOATS, i * TREE_FLOATS + 3);
        const u = x / 1920;
        expect(u < 1 / 3 || u > 2 / 3).toBe(true);
        expect(y).toBeCloseTo(hillHeightAt(table, 0, u) * REF_HEIGHT - 4, 3);
        expect(y + h).toBeLessThanOrEqual(g.top + 1e-3);
      }
      const t = layoutGround(createGroundLayout(), table, "tent", seed, 1920);
      expect(t.tent).toBe(true);
      expect(t.treeCount).toBe(0);
      const u = t.tentX / 1920;
      expect(u < 1 / 3 || u > 2 / 3).toBe(true);
    }
    expect(layoutGround(createGroundLayout(), table, "none", 1, 1920).top).toBe(0);
  });
});
