import { describe, expect, it } from "vitest";
import {
  BLINK_PERIOD,
  createDomeState,
  createIndicator,
  createWingman,
  domeAt,
  domePose,
  ease,
  indicatorAt,
  MAX_TURN,
  MAX_TURN_GAP,
  MIN_TURN_GAP,
  TURN_MAX_SECONDS,
  turnSeconds,
  turnStart,
  WING_FOCAL,
  WING_MIN_GAP,
  WING_SLOT,
  wingmanAt,
  wingmanVisit,
} from "./starfighter-sim";

const SEEDS = [0, 4, 17, 999];

describe("ease", () => {
  it("runs from 0 to 1, rising, with no speed at either end", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    let last = 0;
    for (let u = 0.01; u <= 1; u += 0.01) {
      expect(ease(u)).toBeGreaterThanOrEqual(last);
      last = ease(u);
    }
    expect(ease(0.01) / 0.01).toBeLessThan(0.01);
    expect((1 - ease(0.99)) / 0.01).toBeLessThan(0.01);
  });
});

describe("dome turns", () => {
  it("keeps every pose and every moment of a turn within range", () => {
    const d = createDomeState();
    for (const seed of SEEDS) {
      for (let k = -1; k < 200; k++) {
        const p = domePose(k, seed);
        expect(Math.abs(p)).toBeLessThanOrEqual(MAX_TURN);
      }
      for (let t = 0; t < 1500; t += 0.07) {
        expect(Math.abs(domeAt(t, seed, d).angle)).toBeLessThanOrEqual(MAX_TURN + 1e-9);
      }
    }
  });

  it("starts turns between the shortest and longest gap apart, each done before the next", () => {
    for (const seed of SEEDS) {
      expect(turnStart(0, seed)).toBeGreaterThanOrEqual(MIN_TURN_GAP / 2);
      for (let k = 0; k < 300; k++) {
        const gap = turnStart(k + 1, seed) - turnStart(k, seed);
        expect(gap).toBeGreaterThanOrEqual(MIN_TURN_GAP);
        expect(gap).toBeLessThanOrEqual(MAX_TURN_GAP);
        expect(turnSeconds(k, seed)).toBeLessThanOrEqual(TURN_MAX_SECONDS);
        expect(turnStart(k, seed) + turnSeconds(k, seed)).toBeLessThan(turnStart(k + 1, seed));
      }
    }
  });

  it("eases each turn from the last pose to the next, then holds", () => {
    const d = createDomeState();
    for (const seed of SEEDS) {
      for (let k = 0; k < 60; k++) {
        const start = turnStart(k, seed);
        const len = turnSeconds(k, seed);
        const from = domePose(k - 1, seed);
        const to = domePose(k, seed);
        // Holding just before, and at the start of, the turn.
        expect(domeAt(start - 0.5, seed, d).angle).toBe(from);
        expect(domeAt(start - 0.5, seed, d).turning).toBe(false);
        // Barely moving in its first and last hundredth.
        expect(Math.abs(domeAt(start + 0.01 * len, seed, d).angle - from)).toBeLessThan(
          1e-4 + 0.001 * Math.abs(to - from),
        );
        expect(Math.abs(domeAt(start + 0.99 * len, seed, d).angle - to)).toBeLessThan(
          1e-4 + 0.001 * Math.abs(to - from),
        );
        const mid = domeAt(start + 0.5 * len, seed, d);
        expect(mid.turning).toBe(true);
        expect(mid.turn).toBe(k);
        expect(mid.angle).toBeCloseTo((from + to) / 2, 9);
        // Held until the next turn.
        const after = domeAt(start + len + 0.01, seed, d);
        expect(after.turning).toBe(false);
        expect(after.angle).toBe(to);
        expect(domeAt(turnStart(k + 1, seed) - 0.01, seed, d).angle).toBe(to);
      }
    }
  });

  it("never jumps: the heading changes no faster than an eased turn allows", () => {
    const d = createDomeState();
    const dt = 0.02;
    // Smootherstep's peak speed is 15/8 of the average.
    const most = ((15 / 8) * 2 * MAX_TURN * dt) / 1.6;
    for (const seed of SEEDS) {
      let last = domeAt(0, seed, d).angle;
      for (let t = dt; t < 800; t += dt) {
        const a = domeAt(t, seed, d).angle;
        expect(Math.abs(a - last)).toBeLessThanOrEqual(most + 1e-9);
        last = a;
      }
    }
  });

  it("starts straight ahead and copes with bad times", () => {
    const d = createDomeState();
    expect(domeAt(0, 4, d).angle).toBe(0);
    expect(domeAt(Number.NaN, 4, d).angle).toBe(0);
    expect(domeAt(-5, 4, d).angle).toBe(0);
  });
});

describe("indicator", () => {
  it("blinks slowly, alternating red and blue, fading on and off", () => {
    const ind = createIndicator();
    let last = indicatorAt(0, ind).level;
    let blues = 0;
    for (let t = 0.01; t < 60; t += 0.01) {
      indicatorAt(t, ind);
      expect(ind.level).toBeGreaterThanOrEqual(0);
      expect(ind.level).toBeLessThanOrEqual(1);
      // No faster than full brightness over 0.4 s.
      expect(Math.abs(ind.level - last)).toBeLessThan((0.01 / 0.4) * 1.6);
      last = ind.level;
      if (ind.blue) {
        blues++;
      }
    }
    expect(blues).toBeGreaterThan(2000);
    expect(blues).toBeLessThan(4000);
    expect(indicatorAt(1, ind).blue).not.toBe(indicatorAt(1 + BLINK_PERIOD, ind).blue);
  });
});

/** The sphere's inner edge on screen (frame heights), by the true perspective of its centre. */
function innerEdge(x: number, r: number, side: number): number {
  const ang = Math.atan(x / WING_FOCAL) - side * Math.asin(r / Math.hypot(x, WING_FOCAL));
  return WING_FOCAL * Math.tan(ang);
}

describe("wingman", () => {
  it("keeps the minimum gap between visits", () => {
    const a = { start: 0, length: 0 };
    const b = { start: 0, length: 0 };
    for (const seed of SEEDS) {
      let visits = 0;
      let lastEnd = -Infinity;
      for (let slot = 0; slot < 400; slot++) {
        wingmanVisit(slot, seed, a);
        if (a.length === 0) {
          continue;
        }
        visits++;
        expect(a.start).toBeGreaterThanOrEqual(slot * WING_SLOT);
        expect(a.start - lastEnd).toBeGreaterThanOrEqual(WING_MIN_GAP);
        lastEnd = a.start + a.length;
        wingmanVisit(slot + 1, seed, b);
        expect(b.start - lastEnd).toBeGreaterThanOrEqual(WING_MIN_GAP);
      }
      expect(visits).toBeGreaterThan(200);
      expect(visits).toBeLessThan(360);
    }
  });

  it("starts and ends each visit fully out of frame, and moves smoothly between", () => {
    const w = createWingman();
    const v = { start: 0, length: 0 };
    for (const seed of SEEDS) {
      for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
        for (const side of [-1, 1]) {
          for (let slot = 0; slot < 40; slot++) {
            wingmanVisit(slot, seed, v);
            if (v.length === 0) {
              continue;
            }
            const half = aspect / 2;
            // Out of frame at the very start and the very end.
            for (const t of [v.start, v.start + v.length - 1e-6]) {
              wingmanAt(t, seed, aspect, side, w);
              expect(w.visible).toBe(true);
              expect(side * innerEdge(w.x, w.radius, side)).toBeGreaterThan(half);
            }
            // Gone before and after.
            expect(wingmanAt(v.start - 0.01, seed, aspect, side, w).visible).toBe(false);
            expect(wingmanAt(v.start + v.length + 0.01, seed, aspect, side, w).visible).toBe(false);
            // In frame while holding formation, on its own side.
            wingmanAt(v.start + v.length / 2, seed, aspect, side, w);
            expect(side * innerEdge(w.x, w.radius, side)).toBeLessThan(half);
            expect(side * w.x).toBeGreaterThan(0);
            // Never jumps.
            wingmanAt(v.start, seed, aspect, side, w);
            let lx = w.x;
            let ly = w.y;
            let most = 0;
            for (let t = v.start + 0.05; t < v.start + v.length; t += 0.05) {
              wingmanAt(t, seed, aspect, side, w);
              most = Math.max(most, Math.hypot(w.x - lx, w.y - ly), Math.abs(w.roll) / 50);
              lx = w.x;
              ly = w.y;
            }
            expect(most).toBeLessThan(0.02);
          }
        }
      }
    }
  });
});
