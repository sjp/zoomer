import { describe, expect, it } from "vitest";
import { advanceGraph, createGraphWalk, walkWander } from "../graph-walk";
import {
  ASCENT_LENGTH,
  ASCENT_PERIOD,
  ASCENT_RISE,
  ascentAt,
  cabinLayout,
  CLIMB_RATE,
  climbHeight,
  createPlume,
  DIAL_START,
  DIAL_SWEEP,
  dialBase,
  dustLevel,
  eventPhase,
  FRAME_W,
  HORIZON_Y,
  horizonDip,
  MAX_DIALS,
  MAX_PANELS,
  NEEDLE_WANDER,
  needleAngle,
  needleReading,
  ORBIT_HEIGHT,
  plumeAt,
  SUN_CREEP,
  SUN_ELEVATION,
  sunElevation,
  WARNING_GAP,
  warningGlow,
  windowSpan,
} from "./lunarlander-sim";

describe("needles", () => {
  it("wander on the random walk but stay on their scales", () => {
    for (const seed of [0, 11, 999]) {
      const walk = createGraphWalk(MAX_DIALS, seed);
      for (let i = 0; i < MAX_DIALS; i++) {
        const base = dialBase(seed, i);
        expect(base).toBeGreaterThanOrEqual(0.25);
        expect(base).toBeLessThanOrEqual(0.75);
      }
      const prev = new Float64Array(MAX_DIALS).fill(Number.NaN);
      let outside = 0;
      let biggestStep = 0;
      for (let t = 0; t < 3600; t += 0.5) {
        advanceGraph(walk, t);
        for (let i = 0; i < MAX_DIALS; i++) {
          const base = dialBase(seed, i);
          const r = needleReading(base, walkWander(walk, i));
          const a = needleAngle(r);
          if (
            r < Math.max(0, base - NEEDLE_WANDER) ||
            r > Math.min(1, base + NEEDLE_WANDER) ||
            a > DIAL_START ||
            a < DIAL_START - DIAL_SWEEP
          ) {
            outside++;
          }
          if (!Number.isNaN(prev[i])) {
            biggestStep = Math.max(biggestStep, Math.abs(r - prev[i]));
          }
          prev[i] = r;
        }
      }
      expect(outside).toBe(0);
      // Slow: half a second moves a needle only a little.
      expect(biggestStep).toBeLessThan(0.03);
    }
  });

  it("clamps odd readings onto the scale", () => {
    expect(needleReading(0.9, 5)).toBe(1);
    expect(needleReading(0.1, -5)).toBe(0);
    expect(needleReading(0.5, Number.NaN)).toBe(0.5);
    expect(needleAngle(Number.NaN)).toBe(DIAL_START);
    expect(needleAngle(2)).toBeCloseTo(DIAL_START - DIAL_SWEEP);
  });
});

describe("ascent", () => {
  it("stays on the surface until the first period is up", () => {
    for (const t of [-5, 0, 1, 600, ASCENT_PERIOD - 0.001, Number.NaN]) {
      expect(ascentAt(t)).toBe(0);
    }
  });

  it("climbs, holds and returns continuously, landing exactly", () => {
    for (let cycle = 1; cycle <= 3; cycle++) {
      const start = cycle * ASCENT_PERIOD;
      const dt = 0.05;
      let prev = ascentAt(start - dt);
      let peak = 0;
      for (let t = start; t <= start + ASCENT_LENGTH + 10; t += dt) {
        const a = ascentAt(t);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        // Gentle: no step bigger than the eased climb's steepest (1.875 per rise).
        expect(Math.abs(a - prev)).toBeLessThan((1.9 * dt) / ASCENT_RISE);
        peak = Math.max(peak, a);
        prev = a;
      }
      expect(peak).toBe(1);
      expect(ascentAt(start + ASCENT_RISE + 1)).toBe(1);
      // Back on the ground: exactly zero, until the next lift-off.
      expect(ascentAt(start + ASCENT_LENGTH)).toBe(0);
      expect(ascentAt(start + ASCENT_LENGTH + 0.001)).toBe(0);
      expect(ascentAt(start + ASCENT_PERIOD - 0.001)).toBe(0);
    }
  });

  it("maps the climb to a height and a dipping horizon", () => {
    expect(climbHeight(0)).toBe(0);
    expect(climbHeight(1)).toBe(ORBIT_HEIGHT);
    expect(horizonDip(0)).toBe(0);
    const dip = horizonDip(ORBIT_HEIGHT);
    expect(dip).toBeGreaterThan(0.25);
    expect(dip).toBeLessThan(0.4);
    expect(CLIMB_RATE).toBeLessThanOrEqual(1 / 30);
  });
});

describe("events", () => {
  it("opens quiet, then fires once per slot", () => {
    expect(eventPhase(5, 1, 1, 100, 10)).toBe(-1);
    for (let slot = 1; slot < 20; slot++) {
      let inside = 0;
      for (let t = slot * 100; t < (slot + 1) * 100; t += 0.5) {
        if (eventPhase(t, 3, 1, 100, 10) >= 0) {
          inside++;
        }
      }
      expect(inside).toBeGreaterThanOrEqual(20);
      expect(inside).toBeLessThanOrEqual(21);
    }
  });

  it("ramps the warning lamp and the plume over more than a second", () => {
    const dt = 0.05;
    let prevGlow = 0;
    let prevPlume = 0;
    const plume = createPlume();
    for (let t = 0; t < 10 * WARNING_GAP; t += dt) {
      const g = warningGlow(t, 7);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(Math.abs(g - prevGlow)).toBeLessThan(dt * 1.2);
      prevGlow = g;
      plumeAt(t, 7, plume);
      expect(Math.abs(plume.amount - prevPlume)).toBeLessThan(dt);
      expect(plume.across).toBeGreaterThanOrEqual(0);
      expect(plume.across).toBeLessThanOrEqual(1);
      prevPlume = plume.amount;
      const d = dustLevel(t, 7);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });
});

describe("sun", () => {
  it("creeps within its range", () => {
    for (let t = 0; t < 20000; t += 37) {
      const e = sunElevation(t);
      expect(e).toBeGreaterThanOrEqual(SUN_ELEVATION - SUN_CREEP - 1e-9);
      expect(e).toBeLessThanOrEqual(SUN_ELEVATION + SUN_CREEP + 1e-9);
    }
    expect(sunElevation(Number.NaN)).toBe(SUN_ELEVATION);
  });
});

describe("cabinLayout", () => {
  for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9]) {
    it(`keeps the middle clear and fits at ${aspect.toFixed(2)}`, () => {
      const L = cabinLayout(aspect);
      expect(L.panels.length).toBeLessThanOrEqual(MAX_PANELS);
      expect(L.dials.length).toBeLessThanOrEqual(MAX_DIALS);
      const [ax, ay, bx, , cx, cy] = L.window;
      // The windows sit either side of the speaker's head, inside the frame.
      expect(Math.min(ax, cx) - FRAME_W).toBeGreaterThan(0.15);
      expect(bx + FRAME_W).toBeLessThan(aspect / 2);
      expect(ay + FRAME_W).toBeLessThan(0.45 + 1e-9);
      // The horizon is inside the glass, with sky above it for the Earth.
      expect(HORIZON_Y).toBeGreaterThan(cy);
      expect(HORIZON_Y).toBeLessThan(ay - 0.1);
      const span = windowSpan(L, L.earth[1], new Float64Array(2));
      expect(L.earth[0] - L.earth[2]).toBeGreaterThan(span[0] + 0.01);
      expect(L.earth[0] + L.earth[2]).toBeLessThan(span[1] - 0.01);
      expect(L.earth[1] - L.earth[2]).toBeGreaterThan(HORIZON_Y);
      for (const d of L.dials) {
        expect(Math.abs(d.x)).toBeGreaterThan(0.3);
        expect(Math.abs(d.x) + d.r).toBeLessThan(aspect / 2);
      }
      for (const p of L.panels) {
        expect(p.x0).toBeLessThan(p.x1);
        expect(p.x0).toBeGreaterThanOrEqual(-aspect / 2 - 1e-9);
        expect(p.x1).toBeLessThanOrEqual(aspect / 2 + 1e-9);
      }
      expect(windowSpan(L, 0.45, new Float64Array(2))[0]).toBeNaN();
    });
  }
});

describe("climb", () => {
  it("can't reach orbit sooner than 15 s into a lift-off", () => {
    // The view from orbit (and its surface texture, built in the background) starts
    // at a climb of 0.25.
    expect(0.25 / CLIMB_RATE).toBeGreaterThanOrEqual(15);
  });
});
