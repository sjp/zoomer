import { describe, expect, it } from "vitest";
import { advanceGraph, createGraphWalk, walkWander } from "../graph-walk";
import {
  createWhales,
  createZones,
  CYCLE_BOTTOM,
  CYCLE_TOP,
  depthAt,
  DESCEND_PERIOD,
  DIAL_START,
  DIAL_SWEEP,
  easeDepth,
  FIXED_DEPTH,
  GLASS_R,
  needleAngle,
  pressureReading,
  RING_W,
  RISE_TIME,
  stepWhales,
  submarineLayout,
  waterAt,
  WHALE_MAX_TIME,
  WHALE_MIN_GAP,
  WHALE_MIN_TIME,
  whaleProgress,
  whaleX,
  zonesAt,
} from "./submarine-sim";

describe("depthAt", () => {
  it("holds the fixed depths at every time", () => {
    for (const mode of ["shallows", "twilight", "abyss"] as const) {
      for (const t of [0, 1, 59.5, 700, 1e5, 3e7, -4, Number.NaN]) {
        expect(depthAt(mode, t)).toBe(FIXED_DEPTH[mode]);
      }
    }
    expect(FIXED_DEPTH.shallows).toBeLessThan(FIXED_DEPTH.twilight);
    expect(FIXED_DEPTH.twilight).toBeLessThan(FIXED_DEPTH.abyss);
  });

  const PEAK_RISE = (1.5 * (CYCLE_BOTTOM - CYCLE_TOP)) / RISE_TIME;

  it("descends continuously from shallows to abyss and back", () => {
    let prev = depthAt("descend", 0);
    let lo = Infinity;
    let hi = -Infinity;
    let maxStep = 0;
    const dt = 0.25;
    for (let t = dt; t <= 2 * DESCEND_PERIOD; t += dt) {
      const d = depthAt("descend", t);
      maxStep = Math.max(maxStep, Math.abs(d - prev));
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
      prev = d;
    }
    // Never faster than the surfacing's peak slope, the cycle's steepest.
    expect(maxStep).toBeLessThanOrEqual(PEAK_RISE * dt * 1.01 + 1e-12);
    expect(lo).toBeCloseTo(CYCLE_TOP, 9);
    expect(hi).toBeCloseTo(CYCLE_BOTTOM, 9);
  });

  it("is periodic", () => {
    for (const t of [0, 13, 400, 811.5, 1000, DESCEND_PERIOD - 0.01]) {
      expect(depthAt("descend", t + DESCEND_PERIOD)).toBeCloseTo(depthAt("descend", t), 9);
      expect(depthAt("descend", t + 7 * DESCEND_PERIOD)).toBeCloseTo(depthAt("descend", t), 6);
    }
    // Continuous across the period's wrap.
    expect(
      Math.abs(depthAt("descend", DESCEND_PERIOD - 1e-6) - depthAt("descend", DESCEND_PERIOD)),
    ).toBeLessThan(1e-6);
  });

  it("treats an unknown mode as the cycle", () => {
    expect(depthAt("nope", 500)).toBe(depthAt("descend", 500));
  });

  it("eases a changed setting rather than cutting", () => {
    let d = 0.1;
    for (let i = 0; i < 10; i++) {
      const next = easeDepth(d, 0.95, 0.5);
      expect(next - d).toBeLessThanOrEqual(0.5 / 15 + 1e-12);
      d = next;
    }
    expect(d).toBeLessThan(0.95);
    expect(easeDepth(0.5, 0.95, Number.NaN)).toBe(0.5);
    expect(easeDepth(0.94, 0.95, 10)).toBe(0.95);
  });
});

describe("zones and water", () => {
  it("swaps shallow life for deep life as the vessel sinks", () => {
    const z = createZones();
    zonesAt(0.05, z);
    expect(z.shallows).toBe(1);
    expect(z.abyss).toBe(0);
    zonesAt(0.5, z);
    expect(z.shallows).toBe(0);
    expect(z.jellies).toBe(1);
    zonesAt(1, z);
    expect(z.abyss).toBe(1);
  });

  it("darkens the water with depth", () => {
    const top = [0, 0, 0];
    const deep = [0, 0, 0];
    let prev = Infinity;
    for (let d = 0; d <= 1; d += 0.05) {
      waterAt(d, top, deep);
      const lum = top[0] + top[1] + top[2];
      expect(lum).toBeLessThanOrEqual(prev + 1e-12);
      prev = lum;
    }
    waterAt(Number.NaN, top, deep);
    expect(Number.isFinite(top[0])).toBe(true);
  });
});

describe("whales", () => {
  it("keeps the minimum gap between passes, each 20-40 s long", () => {
    for (const seed of [0, 1, 5, 42, 999]) {
      const s = createWhales(seed);
      let prevEnd = -Infinity;
      for (let i = 0; i < 60; i++) {
        const p = stepWhales(s, prevEnd === -Infinity ? 0 : prevEnd + 1e-3);
        expect(p.start - prevEnd).toBeGreaterThanOrEqual(WHALE_MIN_GAP);
        expect(p.duration).toBeGreaterThanOrEqual(WHALE_MIN_TIME);
        expect(p.duration).toBeLessThanOrEqual(WHALE_MAX_TIME);
        prevEnd = p.start + p.duration;
      }
    }
  });

  it("keeps the gap when stepped in small frames, and after a long pause", () => {
    const s = createWhales(7);
    const starts: number[] = [];
    let last = -1;
    for (let t = 0; t < 3600; t += 1 / 30) {
      const p = stepWhales(s, t);
      if (p.start !== last) {
        starts.push(p.start);
        last = p.start;
      }
    }
    expect(starts.length).toBeGreaterThan(8);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(WHALE_MIN_GAP + WHALE_MIN_TIME);
    }
    const p = stepWhales(s, 1e6);
    expect(p.start + p.duration).toBeGreaterThan(1e6);
  });

  it("is deterministic per seed", () => {
    const a = createWhales(3);
    const b = createWhales(3);
    for (let t = 0; t < 2000; t += 50) {
      expect(stepWhales(a, t)).toEqual(stepWhales(b, t));
    }
  });

  it("crosses from fully off the glass to fully off the other side", () => {
    const p = stepWhales(createWhales(2), 0);
    const half = 0.5 * 1.9 * p.size;
    expect(Math.abs(whaleX(p, 0)) - half).toBeGreaterThan(1);
    expect(Math.abs(whaleX(p, 1)) - half).toBeGreaterThan(1);
    expect(Math.sign(whaleX(p, 1))).toBe(p.dir);
    expect(whaleProgress(p, p.start - 1)).toBe(-1);
    expect(whaleProgress(p, p.start + p.duration / 2)).toBeCloseTo(0.5);
  });
});

describe("gauges", () => {
  it("maps readings onto the dial's sweep", () => {
    expect(needleAngle(0)).toBe(DIAL_START);
    expect(needleAngle(1)).toBeCloseTo(DIAL_START - DIAL_SWEEP);
    expect(needleAngle(2)).toBe(needleAngle(1));
    expect(needleAngle(Number.NaN)).toBe(DIAL_START);
  });

  it("wanders slowly with the random walk", () => {
    const g = createGraphWalk(2, 4);
    let prev = walkWander(g, 0);
    for (let t = 0.05; t < 60; t += 1 / 60) {
      advanceGraph(g, t);
      const w = walkWander(g, 0);
      expect(Math.abs(w)).toBeLessThanOrEqual(1);
      // One new sample moves the average only a little.
      expect(Math.abs(w - prev)).toBeLessThan(0.05);
      prev = w;
    }
    expect(pressureReading(1, 1)).toBeLessThanOrEqual(1);
    expect(pressureReading(0, -1)).toBeGreaterThanOrEqual(0);
  });
});

describe("submarineLayout", () => {
  for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9]) {
    for (const side of ["left", "right"] as const) {
      it(`fits the room at ${aspect.toFixed(2)} with the gauges ${side}`, () => {
        const l = submarineLayout(1080 * aspect, side);
        const outer = GLASS_R + RING_W;
        // The ring stays in the frame, and the frame's centre is on the glass.
        expect(l.cx - outer).toBeGreaterThan(0);
        expect(l.cx + outer).toBeLessThan(l.width);
        expect(l.cy - outer).toBeGreaterThan(0);
        expect(l.cy + outer).toBeLessThan(1080);
        expect(Math.abs(l.width / 2 - l.cx)).toBeLessThan(0.5 * GLASS_R);
        // The glass sits away from the gauges.
        expect(Math.sign(l.width / 2 - l.cx)).toBe(l.dir);
        for (const [x, y, r] of [
          [l.depthX, l.depthY, l.depthR],
          [l.pressX, l.pressY, l.pressR],
        ]) {
          // Each dial (and its bezel) clears the ring and the frame edge, in the outer third.
          expect(Math.hypot(x - l.cx, y - l.cy)).toBeGreaterThan(outer + r * 1.2);
          expect(Math.min(x, l.width - x)).toBeGreaterThan(r * 1.15);
          expect(Math.abs(x - l.width / 2)).toBeGreaterThan(l.width / 6 + r);
        }
        // The pressure gauge sits below the depth dial, clear of it, and above the lamp.
        expect(l.depthY - l.pressY).toBeGreaterThan(l.depthR + l.pressR);
        expect(l.pressY - l.pressR).toBeGreaterThan(l.lampY + 40);
        // The mirrored layout is a mirror image.
        const m = submarineLayout(l.width, side === "left" ? "right" : "left");
        expect(m.cx).toBeCloseTo(l.width - l.cx);
        expect(m.depthX).toBeCloseTo(l.width - l.depthX);
      });
    }
  }
});
