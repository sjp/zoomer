import { describe, expect, it } from "vitest";
import {
  BLOOM_AT,
  BLOOM_FALL_SECONDS,
  BLOOM_PEAK,
  BLOOM_RISE_SECONDS,
  createJump,
  createStreakField,
  RESPAWN_DIST,
  RESPAWN_MAX,
  RESPAWN_MIN,
  STREAK_FADE_IN,
  wantsHyperspace,
} from "./hyperspace-sim";
import { FADE_OUT } from "../fade";
import { createRng } from "../noise";

describe("wantsHyperspace", () => {
  it("follows a fixed mode", () => {
    expect(wantsHyperspace("in", 0, 16)).toBe(true);
    expect(wantsHyperspace("out", 5, 16)).toBe(false);
  });

  it("cycles: normal for the first quarter, hyperspace for the next 60%", () => {
    expect(wantsHyperspace("cycle", 0, 16)).toBe(false);
    expect(wantsHyperspace("cycle", 3.99, 16)).toBe(false);
    expect(wantsHyperspace("cycle", 4, 16)).toBe(true);
    expect(wantsHyperspace("cycle", 13.59, 16)).toBe(true);
    expect(wantsHyperspace("cycle", 13.6, 16)).toBe(false);
    expect(wantsHyperspace("cycle", 16 + 5, 16)).toBe(true);
  });
});

describe("createJump", () => {
  const dt = 1 / 60;

  it("starts in its target state and stays there without jitter or a bloom", () => {
    const into = createJump();
    expect(into.progress).toBe(-1);
    for (let i = 0; i < 10; i++) {
      into.step(dt, "in", 1.6, 16);
      expect(into.progress).toBe(1);
      expect(into.bloom).toBe(0);
    }
    const out = createJump();
    out.step(dt, "out", 1.6, 16);
    expect(out.progress).toBe(0);
  });

  it("ramps linearly over jumpSeconds, starting one bloom as it passes BLOOM_AT", () => {
    const jump = createJump();
    jump.step(dt, "out", 2, 16);
    let started = -1;
    let frames = 0;
    while (jump.progress < 1) {
      const before = jump.bloom;
      jump.step(dt, "in", 2, 16);
      frames++;
      if (started < 0 && jump.bloom > before) {
        started = jump.progress;
      }
      expect(jump.progress).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(frames - 120)).toBeLessThanOrEqual(1);
    expect(started).toBeGreaterThanOrEqual(BLOOM_AT);
    expect(started).toBeLessThan(BLOOM_AT + 2 * (dt / 2));
  });

  it("caps the bloom and ramps it up and down over at least a second each", () => {
    const jump = createJump();
    jump.step(dt, "out", 0.5, 16);
    while (jump.bloom === 0) {
      jump.step(dt, "in", 0.5, 16);
    }
    const levels = [jump.bloom];
    for (let t = 0; t < 4; t += dt) {
      jump.step(dt, "in", 0.5, 16);
      levels.push(jump.bloom);
    }
    const peak = Math.max(...levels);
    expect(peak).toBeLessThanOrEqual(BLOOM_PEAK);
    expect(peak).toBeGreaterThan(BLOOM_PEAK * 0.99);
    const peakAt = levels.indexOf(peak);
    const endAt = levels.indexOf(0, peakAt);
    expect(peakAt * dt).toBeGreaterThanOrEqual(BLOOM_RISE_SECONDS - 2 * dt);
    expect((endAt - peakAt) * dt).toBeGreaterThanOrEqual(BLOOM_FALL_SECONDS - 2 * dt);
    expect(BLOOM_RISE_SECONDS).toBeGreaterThanOrEqual(1);
    expect(BLOOM_FALL_SECONDS).toBeGreaterThanOrEqual(1);
    // No frame changes the bloom by more than a small step.
    for (let i = 1; i < levels.length; i++) {
      expect(Math.abs(levels[i] - levels[i - 1])).toBeLessThan(0.005);
    }
  });

  it("rises again smoothly when a jump retriggers it mid-fall", () => {
    const jump = createJump();
    jump.step(dt, "out", 0.3, 16);
    let last = 0;
    let maxStep = 0;
    const run = (mode: string, seconds: number) => {
      for (let t = 0; t < seconds; t += dt) {
        jump.step(dt, mode, 0.3, 16);
        maxStep = Math.max(maxStep, Math.abs(jump.bloom - last));
        last = jump.bloom;
      }
    };
    run("in", 1.5);
    run("out", 0.5);
    expect(jump.bloom).toBeGreaterThan(0);
    run("in", 2);
    expect(maxStep).toBeLessThan(0.005);
    expect(jump.bloom).toBeLessThanOrEqual(BLOOM_PEAK);
  });

  it("drops back without a bloom, and reverses mid-jump", () => {
    const jump = createJump();
    jump.step(dt, "in", 1, 16);
    for (let i = 0; i < 30; i++) {
      jump.step(dt, "out", 1, 16);
    }
    expect(jump.progress).toBeCloseTo(0.5, 9);
    expect(jump.bloom).toBe(0);
    for (let i = 0; i < 6; i++) {
      jump.step(dt, "in", 1, 16);
    }
    expect(jump.progress).toBeCloseTo(0.6, 9);
    for (let i = 0; i < 100; i++) {
      jump.step(dt, "out", 1, 16);
    }
    expect(jump.progress).toBe(0);
  });

  it("runs the auto cycle: out, in, then out again", () => {
    const jump = createJump();
    const at: number[] = [];
    for (let t = 0; t < 16; t += 0.5) {
      for (let i = 0; i < 30; i++) {
        jump.step(dt, "cycle", 1.6, 16);
      }
      at.push(jump.progress);
    }
    // Normal space through 4s, fully in by about 4 + 1.6s, back out after 13.6s.
    expect(at[6]).toBe(0);
    expect(at[12]).toBe(1);
    expect(at[25]).toBe(1);
    expect(at[31]).toBeLessThan(1);
  });
});

describe("createStreakField", () => {
  const MAX = 64;
  const dt = 1 / 60;

  it("lays out the same field for the same seed", () => {
    const a = createStreakField(MAX, createRng(7));
    const b = createStreakField(MAX, createRng(7));
    const c = createStreakField(MAX, createRng(8));
    expect(Array.from(a.dist)).toEqual(Array.from(b.dist));
    expect(Array.from(a.dirX)).toEqual(Array.from(b.dirX));
    expect(Array.from(a.dist)).not.toEqual(Array.from(c.dist));
    for (let i = 0; i < 200; i++) {
      a.step(dt, MAX, 0.5);
      b.step(dt, MAX, 0.5);
    }
    expect(Array.from(a.dist)).toEqual(Array.from(b.dist));
    expect(Array.from(a.mix)).toEqual(Array.from(b.mix));
  });

  it("starts with unit directions, distances in 0..1 and mixes in 0..1", () => {
    const f = createStreakField(MAX, createRng(1));
    for (let i = 0; i < MAX; i++) {
      expect(Math.hypot(f.dirX[i], f.dirY[i])).toBeCloseTo(1, 5);
      expect(f.dist[i]).toBeGreaterThanOrEqual(0);
      expect(f.dist[i]).toBeLessThan(1);
      expect(f.mix[i]).toBeGreaterThanOrEqual(0);
      expect(f.mix[i]).toBeLessThan(1);
    }
  });

  it("moves streaks outwards at their pace, faster further out", () => {
    const f = createStreakField(MAX, createRng(2));
    const before = Array.from(f.dist);
    const v = 0.2;
    f.step(dt, MAX, v);
    for (let i = 0; i < MAX; i++) {
      // Each streak's pace is 0.6..1.4 of the velocity, scaled by 0.1 + distance.
      const moved = f.dist[i] - before[i];
      expect(moved).toBeGreaterThanOrEqual(dt * v * 0.6 * (0.1 + before[i]) * 0.999);
      expect(moved).toBeLessThanOrEqual(dt * v * 1.4 * (0.1 + before[i]) * 1.001);
    }
  });

  it("respawns streaks that fly off near the centre, keeping them unit length", () => {
    const f = createStreakField(MAX, createRng(3));
    const respawns: number[] = [];
    let farthest = 0;
    let badDir = 0;
    for (let s = 0; s < 600; s++) {
      const before = Array.from(f.dist);
      f.step(dt, MAX, 1);
      for (let i = 0; i < MAX; i++) {
        farthest = Math.max(farthest, f.dist[i]);
        if (f.dist[i] < before[i]) {
          respawns.push(f.dist[i]);
          badDir += Math.abs(Math.hypot(f.dirX[i], f.dirY[i]) - 1) > 1e-5 ? 1 : 0;
        }
      }
    }
    expect(farthest).toBeLessThanOrEqual(RESPAWN_DIST);
    expect(respawns.length).toBeGreaterThan(MAX);
    expect(Math.min(...respawns)).toBeGreaterThanOrEqual(RESPAWN_MIN);
    expect(Math.max(...respawns)).toBeLessThan(RESPAWN_MAX);
    expect(badDir).toBe(0);
  });

  it("dims streaks near the centre", () => {
    const f = createStreakField(MAX, createRng(4));
    // Settle the count fade first.
    for (let s = 0; s < 120; s++) {
      f.step(dt, MAX, 0);
    }
    for (let i = 0; i < MAX; i++) {
      expect(f.alpha[i]).toBeCloseTo(Math.min(1, f.dist[i] * 3), 5);
    }
  });

  it("fades added streaks in and removed ones out, then stops simulating them", () => {
    const f = createStreakField(MAX, createRng(5));
    expect(f.step(dt, 10, 0)).toBe(10);
    expect(f.alpha[0]).toBeGreaterThan(0);
    expect(f.alpha[0]).toBeLessThan(0.1);
    const settle = Math.ceil(STREAK_FADE_IN / dt) + 1;
    for (let s = 0; s < settle; s++) {
      f.step(dt, 10, 0);
    }
    expect(f.alpha[3]).toBeCloseTo(Math.min(1, f.dist[3] * 3), 5);

    // Dropping to 4 keeps drawing all 10 while 4..9 fade out.
    expect(f.step(dt, 4, 0)).toBe(10);
    expect(f.live).toBe(10);
    expect(f.alpha[8]).toBeLessThan(Math.min(1, f.dist[8] * 3));
    for (let s = 0; s < Math.ceil(FADE_OUT / dt) + 1; s++) {
      f.step(dt, 4, 0);
    }
    expect(f.live).toBe(4);
    expect(f.step(dt, 4, 0)).toBe(4);
  });

  it("clamps the count to the capacity", () => {
    const f = createStreakField(MAX, createRng(6));
    expect(f.step(dt, MAX * 2, 0)).toBe(MAX);
    expect(f.step(dt, -3, 0)).toBe(MAX);
  });
});
