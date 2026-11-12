import { describe, expect, it } from "vitest";
import { createRng } from "../noise";
import {
  BOUNCE_JITTER,
  createBouncePoints,
  MIN_SPEED_FACTOR,
  placeBouncePoint,
  stepBouncePoints,
} from "./bounce-points";

const outside = (a: Float32Array) => a.some((v) => !(v >= 0 && v <= 1));

describe("stepBouncePoints", () => {
  it("keeps every point inside the frame for any dt", () => {
    const rng = createRng(3);
    const p = createBouncePoints(32, createRng(1));
    let bad = 0;
    for (const dt of [0, 1 / 120, 1 / 60, 0.1, 1, 7.3, 1e3, 1e6, -1, Number.NaN, Infinity]) {
      for (let k = 0; k < 50; k++) {
        stepBouncePoints(p, dt, 0.25, 16 / 9, rng);
        if (outside(p.x) || outside(p.y)) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("keeps points inside at extreme aspects and speeds", () => {
    const rng = createRng(4);
    const p = createBouncePoints(16, createRng(2));
    let bad = 0;
    for (const aspect of [1 / 1080, 1, 32, 1e-9, 0, Number.NaN]) {
      for (const speed of [0, 0.01, 0.25, 100, Number.NaN]) {
        for (let k = 0; k < 40; k++) {
          stepBouncePoints(p, 1 / 60, speed, aspect, rng);
          if (outside(p.x) || outside(p.y)) {
            bad++;
          }
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("reflects off an edge, keeping the speed and turning by at most the jitter", () => {
    const p = createBouncePoints(1, createRng(1));
    p.x[0] = 0.99;
    p.y[0] = 0.5;
    p.vx[0] = 0.6;
    p.vy[0] = 0.6;
    const before = Math.atan2(p.vy[0], -p.vx[0]);
    const speed = Math.hypot(p.vx[0], p.vy[0]);
    stepBouncePoints(p, 0.1, 1, 1, createRng(9));
    expect(p.vx[0]).toBeLessThan(0);
    expect(p.vy[0]).toBeGreaterThan(0);
    expect(p.x[0]).toBeLessThan(1);
    expect(Math.hypot(p.vx[0], p.vy[0])).toBeCloseTo(speed, 5);
    const after = Math.atan2(p.vy[0], p.vx[0]);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(BOUNCE_JITTER + 1e-6);
  });

  it("moves each point no faster than the speed, in frame heights", () => {
    const rng = createRng(5);
    const p = createBouncePoints(32, createRng(6));
    const aspect = 16 / 9;
    const speed = 0.2;
    const dt = 1 / 60;
    let fastest = 0;
    let slowest = Infinity;
    for (let k = 0; k < 600; k++) {
      stepBouncePoints(p, dt, speed, aspect, rng);
      for (let i = 0; i < p.count; i++) {
        // Speed of the unfolded motion: the velocity times the speed.
        const v = Math.hypot(p.vx[i], p.vy[i]) * speed;
        fastest = Math.max(fastest, v);
        slowest = Math.min(slowest, v);
        // A step away from the edges moves exactly that far (in heights).
        const dx = (p.x[i] - p.prevX[i]) * aspect;
        const dy = p.y[i] - p.prevY[i];
        expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(speed * dt * (1 + 1e-4));
      }
    }
    expect(fastest).toBeLessThanOrEqual(speed * (1 + 1e-6));
    expect(slowest).toBeGreaterThanOrEqual(speed * MIN_SPEED_FACTOR * (1 - 1e-6));
  });

  it("gives the same motion for the same seed", () => {
    const run = (seed: number) => {
      const rng = createRng(seed + 100);
      const p = createBouncePoints(8, createRng(seed));
      for (let k = 0; k < 2000; k++) {
        stepBouncePoints(p, 1 / 60, 0.25, 4 / 3, rng);
      }
      return [...p.x, ...p.y];
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it("never falls into a loop: bounces keep changing the path", () => {
    // Without jitter a point in a square with rational slopes retraces its path.
    const rng = createRng(11);
    const p = createBouncePoints(1, createRng(1));
    p.vx[0] = 0.7;
    p.vy[0] = 0.7;
    const seen = new Set<number>();
    for (let k = 0; k < 6000; k++) {
      stepBouncePoints(p, 1 / 60, 0.25, 1, rng);
      seen.add(Math.round(Math.atan2(p.vy[0], p.vx[0]) * 1e4));
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe("placeBouncePoint", () => {
  it("moves a point onto another, keeping its own velocity", () => {
    const p = createBouncePoints(3, createRng(1));
    const vx = p.vx[2];
    placeBouncePoint(p, 2, 1);
    expect([p.x[2], p.y[2], p.prevX[2], p.prevY[2]]).toEqual([
      p.x[1],
      p.y[1],
      p.prevX[1],
      p.prevY[1],
    ]);
    expect(p.vx[2]).toBe(vx);
  });
});
