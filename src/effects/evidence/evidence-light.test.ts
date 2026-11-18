import { describe, expect, it } from "vitest";
import {
  clippingLift,
  HUM_DEPTH,
  humLevel,
  LIGHT_FLOATS,
  LIGHTINGS,
  poolAt,
} from "./evidence-light";
import { evidenceMeta } from "./evidence.meta";

describe("lightings", () => {
  it("has one per option, each a full block", () => {
    const options = evidenceMeta.params.lighting.options.map((o) => o.value);
    expect(Object.keys(LIGHTINGS).toSorted()).toEqual([...options].toSorted());
    for (const values of Object.values(LIGHTINGS)) {
      expect(values).toHaveLength(LIGHT_FLOATS);
    }
  });

  it("has no dust or hum in daylight", () => {
    expect(LIGHTINGS.daylight[6]).toBe(0);
    expect(LIGHTINGS.daylight[7]).toBe(0);
  });

  it("lights the lamp's pool brightest at its centre, dim at the corners", () => {
    let peak = 0;
    for (let x = -0.9; x <= 0.9; x += 0.05) {
      for (let y = -0.5; y <= 0.5; y += 0.05) {
        peak = Math.max(peak, poolAt(x, y));
      }
    }
    expect(peak).toBeGreaterThan(0.95);
    for (const [x, y] of [
      [-0.89, -0.5],
      [-0.89, 0.5],
      [0.89, -0.5],
    ]) {
      expect(poolAt(x, y)).toBeLessThan(0.25);
    }
  });
});

describe("humLevel", () => {
  it("stays within its depth, under 3 % of the lamp's brightness", () => {
    expect(HUM_DEPTH).toBeLessThan(0.03);
    let deepest = 0;
    for (let t = 0; t < 120; t += 0.01) {
      deepest = Math.max(deepest, Math.abs(humLevel(t) - 1));
    }
    expect(deepest).toBeLessThanOrEqual(HUM_DEPTH + 1e-12);
  });

  it("changes by under half a percent a frame at 30 fps", () => {
    let biggest = 0;
    for (let t = 0; t < 60; t += 1 / 30) {
      biggest = Math.max(biggest, Math.abs(humLevel(t + 1 / 30) - humLevel(t)));
    }
    expect(biggest).toBeLessThan(0.005);
  });

  it("treats a non-finite time as zero", () => {
    expect(humLevel(Number.NaN)).toBe(humLevel(0));
  });
});

describe("clippingLift", () => {
  it.each([1, 2, 3])("lifts now and then, and rests most of the time, for seed %i", (seed) => {
    let lifted = 0;
    let lifts = 0;
    let was = false;
    const n = 600 * 30;
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const v = clippingLift(i / 30, seed);
      lowest = Math.min(lowest, v);
      highest = Math.max(highest, v);
      if (v > 0) {
        lifted++;
      }
      if (v > 0.2 && !was) {
        lifts++;
      }
      was = v > 0.2;
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest).toBeLessThanOrEqual(1);
    expect(lifted / n).toBeLessThan(0.3);
    expect(lifts).toBeGreaterThanOrEqual(15);
    expect(lifts).toBeLessThanOrEqual(38);
  });

  it("moves smoothly", () => {
    let biggest = 0;
    for (let t = 0; t < 300; t += 1 / 30) {
      biggest = Math.max(biggest, Math.abs(clippingLift(t + 1 / 30, 1) - clippingLift(t, 1)));
    }
    expect(biggest).toBeLessThan(0.06);
  });

  it("rests before the start and for non-finite times", () => {
    expect(clippingLift(-1, 1)).toBe(0);
    expect(clippingLift(Number.NaN, 1)).toBe(0);
  });
});
