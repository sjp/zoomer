import { describe, expect, it } from "vitest";
import {
  coneMask,
  CONE_TAN,
  createDrips,
  createLampGeometry,
  createRain,
  createSplashes,
  FALLING,
  GROW_RANGE,
  GROWING,
  growTime,
  GUTTER_BOTTOM,
  lampGeometry,
  lampLight,
  MAX_DRIP_DT,
  RAIN_TOP,
  rainFloor,
  rainSpeed,
  SPLASH_LIFE,
  splashDroplet,
  stepDrips,
  stepRain,
  stepSplashes,
} from "./porch-sim";

const WIDTH = 1920;

describe("cone mask", () => {
  it("is 1 along the axis and 0 outside the cone or behind the lamp", () => {
    for (const side of ["left", "right"] as const) {
      const g = lampGeometry(createLampGeometry(), side, WIDTH);
      let bad = 0;
      for (let s = 1; s <= 1500; s += 7) {
        if (coneMask(g, g.x + g.ax * s, g.y + g.ay * s) !== 1) {
          bad++;
        }
        // Perpendicular offset just past the edge.
        const off = s * CONE_TAN * 1.01;
        const px = g.x + g.ax * s + g.ay * off;
        const py = g.y + g.ay * s - g.ax * off;
        if (coneMask(g, px, py) !== 0) {
          bad++;
        }
        if (coneMask(g, g.x - g.ax * s, g.y - g.ay * s) !== 0) {
          bad++;
        }
      }
      expect(bad).toBe(0);
    }
  });

  it("falls off monotonically across the cone", () => {
    const g = lampGeometry(createLampGeometry(), "left", WIDTH);
    const s = 600;
    let prev = 2;
    let rising = 0;
    for (let k = 0; k <= 60; k++) {
      const off = (k / 60) * s * CONE_TAN;
      const m = coneMask(g, g.x + g.ax * s + g.ay * off, g.y + g.ay * s - g.ax * off);
      if (m > prev + 1e-12) {
        rising++;
      }
      prev = m;
    }
    expect(rising).toBe(0);
    expect(prev).toBe(0);
  });

  it("leans towards the middle and mirrors with the lamp side", () => {
    const l = lampGeometry(createLampGeometry(), "left", WIDTH);
    const r = lampGeometry(createLampGeometry(), "right", WIDTH);
    expect(l.ax).toBeGreaterThan(0);
    expect(r.ax).toBeLessThan(0);
    expect(l.x + r.x).toBe(WIDTH);
    expect(lampLight(l, 500, 700)).toBeCloseTo(lampLight(r, WIDTH - 500, 700), 12);
    expect(lampLight(l, l.x + l.ax * 100, l.y + l.ay * 100)).toBeGreaterThan(
      lampLight(l, l.x + l.ax * 900, l.y + l.ay * 900),
    );
  });
});

describe("rain", () => {
  it("is deterministic per seed", () => {
    const a = createRain(3, 200);
    const b = createRain(3, 200);
    const c = createRain(4, 200);
    expect(Array.from(a.u)).toEqual(Array.from(b.u));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
    expect(Array.from(a.u)).not.toEqual(Array.from(c.u));
  });

  it("wraps without gaps and keeps a constant count", () => {
    const rain = createRain(11, 300);
    const span = WIDTH + 400;
    const dt = 1 / 60;
    let outOfRange = 0;
    let badWrap = 0;
    for (let f = 0; f < 600; f++) {
      const before = Float64Array.from(rain.y);
      stepRain(rain, rain.count, dt, 0.7, span);
      for (let i = 0; i < rain.count; i++) {
        const d = rain.depth[i];
        const floor = rainFloor(d);
        const y = rain.y[i];
        if (!(y >= RAIN_TOP && y < floor) || !(rain.u[i] >= 0 && rain.u[i] < 1)) {
          outOfRange++;
        }
        // Moved by exactly one step's fall, less one span if it wrapped.
        let moved = y - before[i];
        if (moved < 0) {
          moved += floor - RAIN_TOP;
        }
        if (Math.abs(moved - rainSpeed(d) * dt) > 1e-2) {
          badWrap++;
        }
      }
    }
    expect(rain.count).toBe(300);
    expect(rain.y.length).toBe(300);
    expect(outOfRange).toBe(0);
    expect(badWrap).toBe(0);
  });

  it("stays spread over the whole fall", () => {
    const rain = createRain(2, 400);
    for (let f = 0; f < 300; f++) {
      stepRain(rain, rain.count, 1 / 60, 0, WIDTH);
    }
    const bins = Array.from({ length: 8 }, () => 0);
    for (let i = 0; i < rain.count; i++) {
      const t = (rain.y[i] - RAIN_TOP) / (rainFloor(rain.depth[i]) - RAIN_TOP);
      bins[Math.min(7, Math.floor(t * 8))]++;
    }
    expect(Math.min(...bins)).toBeGreaterThan(20);
  });

  it("drifts with the wind and not without it", () => {
    const rain = createRain(1, 50);
    const u0 = Array.from(rain.u);
    stepRain(rain, rain.count, 0.1, 0, WIDTH);
    expect(Array.from(rain.u)).toEqual(u0);
    const u1 = Array.from(rain.u);
    stepRain(rain, rain.count, 0.01, 1, WIDTH);
    let wrong = 0;
    for (let i = 0; i < rain.count; i++) {
      const moved = (rain.u[i] - u1[i] + 1) % 1;
      if (moved <= 0 || moved > 0.01) {
        wrong++;
      }
    }
    expect(wrong).toBe(0);
  });
});

describe("drips", () => {
  it("has bounded swell times that are deterministic per seed", () => {
    let outside = 0;
    for (let seed = 0; seed < 20; seed++) {
      for (let i = 0; i < 7; i++) {
        for (let n = 0; n < 20; n++) {
          const g = growTime(seed, i, n);
          if (!(g >= GROW_RANGE[0] && g <= GROW_RANGE[1])) {
            outside++;
          }
          if (g !== growTime(seed, i, n)) {
            outside++;
          }
        }
      }
    }
    expect(outside).toBe(0);
    expect(growTime(1, 0, 0)).not.toBe(growTime(2, 0, 0));
  });

  it("keeps timers bounded and repeats exactly for the same seed", () => {
    const run = (seed: number) => {
      const d = createDrips(seed);
      const s = createSplashes();
      let bad = 0;
      for (let f = 0; f < 3000; f++) {
        stepDrips(d, s, 1 / 60, 1);
        for (let i = 0; i < d.count; i++) {
          if (d.phase[i] === GROWING && !(d.t[i] >= 0 && d.t[i] <= d.grow[i])) {
            bad++;
          }
          if (!(d.grow[i] >= GROW_RANGE[0] && d.grow[i] <= GROW_RANGE[1])) {
            bad++;
          }
          if (d.phase[i] === FALLING && !(d.y[i] >= GUTTER_BOTTOM && d.y[i] < d.landY[i])) {
            bad++;
          }
        }
      }
      return { bad, landings: Array.from(d.landings), t: Array.from(d.t) };
    };
    const a = run(9);
    expect(a.bad).toBe(0);
    expect(run(9)).toEqual(a);
    expect(a.landings.every((n) => n > 3)).toBe(true);
  });

  it("spawns exactly one splash per landing, even with long frames", () => {
    const d = createDrips(4);
    const s = createSplashes();
    let landed = 0;
    for (let f = 0; f < 2000; f++) {
      const dt = f % 50 === 0 ? 5 : 1 / 30;
      landed += stepDrips(d, s, dt, 1.5);
      stepSplashes(s, Math.min(dt, MAX_DRIP_DT));
    }
    const total = d.landings.reduce((a, b) => a + b, 0);
    expect(landed).toBeGreaterThan(20);
    expect(s.spawned).toBe(landed);
    expect(total).toBe(landed);
  });

  it("lands splashes where the drip was", () => {
    const d = createDrips(6);
    const s = createSplashes();
    let mismatched = 0;
    for (let f = 0; f < 1200; f++) {
      const before = s.spawned;
      stepDrips(d, s, 1 / 60, 1);
      if (s.spawned > before) {
        const k = (s.next + s.max - 1) % s.max;
        const i = d.u.indexOf(s.u[k]);
        if (i < 0 || s.y[k] !== d.landY[i] || s.age[k] !== 0) {
          mismatched++;
        }
      }
      stepSplashes(s, 1 / 60);
    }
    expect(mismatched).toBe(0);
    expect(s.age.every((a) => a >= 0 && a < SPLASH_LIFE + 1 / 60)).toBe(true);
  });
});

describe("splash droplets", () => {
  it("rise and then land within the splash's life", () => {
    const out = new Float64Array(2);
    let early = 0;
    let late = 0;
    for (let k = 0; k < 4; k++) {
      if (splashDroplet(out, 1234, k, 0.05)) {
        early++;
      }
      if (splashDroplet(out, 1234, k, SPLASH_LIFE)) {
        late++;
      }
    }
    expect(early).toBe(4);
    expect(late).toBe(0);
  });
});
