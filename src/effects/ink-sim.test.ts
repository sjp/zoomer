import { describe, expect, it } from "vitest";
import {
  aliveCount,
  createDropState,
  createPlumeUniforms,
  EDGE_BOTTOM,
  EDGE_INSET,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
  FADE_IN,
  landingPoint,
  MAX_INTERVAL,
  MAX_PLUMES,
  MIN_INTERVAL,
  packPlumes,
  PLUME_LIFE,
  plumeGrowth,
  plumeIntensity,
  plumeRadius,
  seedDrops,
  spawnInterval,
  spawnPlume,
  stepDrops,
  WARP_BOUND,
} from "./ink-sim";
import { createRng } from "./noise";

describe("plume lifecycle", () => {
  it("is zero at landing and at the end of life, and full in between", () => {
    expect(plumeIntensity(0)).toBe(0);
    expect(plumeIntensity(-1)).toBe(0);
    expect(plumeIntensity(PLUME_LIFE)).toBe(0);
    expect(plumeIntensity(PLUME_LIFE + 10)).toBe(0);
    expect(plumeIntensity(FADE_IN)).toBeCloseTo(1);
    expect(plumeIntensity(10)).toBeCloseTo(1);
    expect(plumeIntensity(PLUME_LIFE - 0.01)).toBeLessThan(1e-3);
  });

  it("is continuous over the whole life", () => {
    const step = 0.01;
    let prev = plumeIntensity(-step);
    for (let a = 0; a <= PLUME_LIFE + step; a += step) {
      const v = plumeIntensity(a);
      expect(Math.abs(v - prev)).toBeLessThan(0.03);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it("grows monotonically from a small start", () => {
    expect(plumeGrowth(0)).toBe(0);
    expect(plumeGrowth(20)).toBeGreaterThan(0.9);
    expect(plumeRadius(0)).toBeLessThan(0.02);
    let prev = -1;
    for (let a = 0; a <= PLUME_LIFE; a += 0.5) {
      const r = plumeRadius(a);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
    expect(plumeRadius(PLUME_LIFE)).toBeLessThan(0.4);
  });
});

describe("drop scheduler", () => {
  it("draws intervals from the 15-40 s range", () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const t = spawnInterval(rng);
      expect(t).toBeGreaterThanOrEqual(MIN_INTERVAL);
      expect(t).toBeLessThan(MAX_INTERVAL);
    }
  });

  /** Runs the scheduler for `seconds`, returning the landing times and the most alive at once. */
  const simulate = (frequency: number, seconds: number, dt = 0.05) => {
    const rng = createRng(42);
    const state = createDropState();
    seedDrops(state, rng, 3);
    const landings: number[] = [];
    let maxAlive = aliveCount(state);
    let spawned = state.spawned;
    for (let t = 0; t < seconds; t += dt) {
      stepDrops(state, dt, frequency, 3, rng);
      if (state.spawned !== spawned) {
        expect(state.spawned).toBe(spawned + 1);
        spawned = state.spawned;
        landings.push(t);
      }
      maxAlive = Math.max(maxAlive, aliveCount(state));
    }
    return { landings, maxAlive, state };
  };

  it("spaces drops 15-40 s apart at frequency 1", () => {
    const { landings, maxAlive } = simulate(1, 2000);
    expect(landings.length).toBeGreaterThan(2000 / MAX_INTERVAL - 2);
    expect(maxAlive).toBeLessThanOrEqual(MAX_PLUMES);
    for (let i = 1; i < landings.length; i++) {
      const gap = landings[i] - landings[i - 1];
      expect(gap).toBeGreaterThanOrEqual(MIN_INTERVAL - 0.1);
      // A full house delays a drop until a plume finishes, never beyond a life.
      expect(gap).toBeLessThanOrEqual(Math.max(MAX_INTERVAL, PLUME_LIFE) + 0.1);
    }
  });

  it("never has more than MAX_PLUMES alive, even at the highest frequency", () => {
    const { landings, maxAlive } = simulate(3, 2000);
    expect(maxAlive).toBe(MAX_PLUMES);
    for (let i = 1; i < landings.length; i++) {
      expect(landings[i] - landings[i - 1]).toBeGreaterThanOrEqual(MIN_INTERVAL / 3 - 0.1);
    }
  });

  it("refuses to spawn into a full house", () => {
    const rng = createRng(3);
    const state = createDropState();
    for (let i = 0; i < MAX_PLUMES; i++) expect(spawnPlume(state, rng, 3)).not.toBeNull();
    expect(spawnPlume(state, rng, 3)).toBeNull();
    expect(aliveCount(state)).toBe(MAX_PLUMES);
  });

  it("holds still while paused", () => {
    const rng = createRng(4);
    const state = createDropState();
    seedDrops(state, rng, 3);
    const timer = state.timer;
    for (let i = 0; i < 100; i++) stepDrops(state, 0, 1, 3, rng);
    expect(state.timer).toBe(timer);
    expect(state.spawned).toBe(1);
  });

  it("starts with one plume already unfurling", () => {
    const state = createDropState();
    seedDrops(state, createRng(5), 3);
    expect(aliveCount(state)).toBe(1);
    expect(plumeIntensity(state.plumes[0].age)).toBeGreaterThan(0.5);
  });

  it("lands drops just inside an edge, clear of the middle on top and bottom", () => {
    const rng = createRng(7);
    const aspect = 16 / 9;
    const pt = new Float32Array(2);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const state = createDropState();
      const p = spawnPlume(state, rng, 3)!;
      seen.add(p.edge);
      landingPoint(p, aspect, pt);
      const [x, y] = pt;
      const dEdge = Math.min(x, aspect - x, y, 1 - y);
      expect(dEdge).toBeCloseTo(EDGE_INSET, 5);
      const side = p.edge === EDGE_LEFT || p.edge === EDGE_RIGHT;
      const u = x / aspect;
      expect(side || u < 1 / 3 || u > 2 / 3).toBe(true);
      // Drift points into the frame.
      const inward = [Math.cos(p.angle), -Math.cos(p.angle), -Math.sin(p.angle), Math.sin(p.angle)];
      expect([EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM]).toContain(p.edge);
      expect(inward[p.edge]).toBeGreaterThan(0);
    }
    expect(seen.size).toBe(4);
  });

  it("cycles ink colours through the inks in use", () => {
    const rng = createRng(8);
    const state = createDropState();
    const colors = [0, 1].map(() => spawnPlume(state, rng, 2)!.color);
    expect(colors).toEqual([0, 1]);
    state.plumes[0].alive = false;
    expect(spawnPlume(state, rng, 2)!.color).toBe(0);
  });
});

describe("packPlumes", () => {
  it("packs only visible plumes, with a reach covering the warped extent", () => {
    const rng = createRng(9);
    const state = createDropState();
    const u = createPlumeUniforms();
    expect(packPlumes(state, 16 / 9, 1, u)).toBe(0);
    spawnPlume(state, rng, 3, 0); // age 0: not yet visible
    const b = spawnPlume(state, rng, 3, 20)!;
    expect(packPlumes(state, 16 / 9, 1.5, u)).toBe(1);
    expect(u.color[0]).toBe(b.color);
    const r = u.p0[2];
    expect(r).toBeCloseTo(plumeRadius(20));
    expect(u.p0[3]).toBeCloseTo(plumeIntensity(20));
    const elong = u.p2[2];
    const reach = Math.sqrt(u.p3[2]);
    expect(reach).toBeGreaterThanOrEqual(r * elong + WARP_BOUND * (u.p3[0] + u.p3[1]));
    expect(Math.hypot(u.p2[0], u.p2[1])).toBeCloseTo(1);
    for (let k = 0; k < 4; k++) {
      expect(u.p1[k]).toBeGreaterThanOrEqual(0);
      expect(u.p1[k]).toBeLessThan(1);
    }
  });
});
