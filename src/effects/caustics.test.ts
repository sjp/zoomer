import { describe, expect, it } from "vitest";
import { mainFragment, tileFragment } from "./caustics";
import {
  advancePhases,
  BUBBLE_MAX_R,
  BUBBLE_MIN_R,
  bubbleMargin,
  bubbleX,
  CAUSTIC_RATES,
  createBubbleState,
  createRays,
  DEEP_SQUASH,
  LAYER_B_ANGLE,
  LAYER_B_SCALE,
  rescaleBubbles,
  tileMatrices,
  fillRayTable,
  seedBubbles,
  spawnBubble,
  stepBubbles,
  tileResolution,
} from "./caustics-sim";
import { growLive } from "./fade";
import { createRng } from "./noise";

const TAU = Math.PI * 2;

describe("caustic phases", () => {
  it("advances each iteration at its own rate, wrapped to [0, TAU)", () => {
    const phases = new Float32Array(CAUSTIC_RATES.length);
    advancePhases(phases, 1);
    for (let n = 0; n < phases.length; n++) {
      const expected = ((CAUSTIC_RATES[n] % TAU) + TAU) % TAU;
      expect(phases[n]).toBeCloseTo(expected, 5);
    }
    for (let k = 0; k < 1000; k++) advancePhases(phases, 7.3);
    for (const v of phases) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(TAU);
    }
  });

  it("drifts every pair of iterations apart, so the network morphs rather than slides", () => {
    // Two iterations at equal (or nearly equal) rates would stay locked together.
    expect(CAUSTIC_RATES).toEqual([1, 2, 3, 4, 5].map((n) => 1 - 3.5 / n));
    for (let i = 0; i < CAUSTIC_RATES.length; i++) {
      for (let j = i + 1; j < CAUSTIC_RATES.length; j++) {
        expect(Math.abs(CAUSTIC_RATES[i] - CAUSTIC_RATES[j])).toBeGreaterThan(0.1);
      }
    }
  });
});

describe("tileResolution", () => {
  it("picks a power of two near the on-screen size, clamped", () => {
    expect(tileResolution(900)).toBe(512);
    expect(tileResolution(1800)).toBe(1024);
    expect(tileResolution(10000)).toBe(1024);
    expect(tileResolution(100)).toBe(256);
    expect(tileResolution(Number.NaN)).toBe(256);
    expect(tileResolution(0)).toBe(256);
  });
});

describe("god-ray table", () => {
  const rays = createRays(createRng(1), 7);

  it("stratifies rays across the width", () => {
    rays.forEach((r, k) => {
      expect(r.center).toBeGreaterThan(k / 7);
      expect(r.center).toBeLessThan((k + 1) / 7);
    });
  });

  it("fills 0..1 with peaks near ray centres and is deterministic", () => {
    const a = new Float32Array(256);
    const b = new Float32Array(256);
    fillRayTable(a, rays, 12.5);
    fillRayTable(b, rays, 12.5);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...a)).toBeGreaterThan(0.2);
    // Dark gaps exist between rays.
    expect(Math.min(...a)).toBeLessThan(0.05);
  });

  it("overwrites rather than accumulates across calls", () => {
    const a = new Float32Array(64);
    fillRayTable(a, rays, 0);
    const first = Array.from(a);
    fillRayTable(a, rays, 0);
    expect(Array.from(a)).toEqual(first);
  });

  it("moves slowly over time", () => {
    const a = new Float32Array(256);
    const b = new Float32Array(256);
    fillRayTable(a, rays, 0);
    fillRayTable(b, rays, 1 / 120);
    let maxDiff = 0;
    for (let j = 0; j < 256; j++) maxDiff = Math.max(maxDiff, Math.abs(a[j] - b[j]));
    expect(maxDiff).toBeLessThan(0.02);
  });
});

describe("bubbles", () => {
  it("spawns within size and width ranges", () => {
    const s = createBubbleState(200);
    seedBubbles(s, createRng(2), 1920);
    for (let i = 0; i < 200; i++) {
      expect(s.r[i]).toBeGreaterThanOrEqual(BUBBLE_MIN_R);
      expect(s.r[i]).toBeLessThanOrEqual(BUBBLE_MAX_R);
      expect(s.x[i]).toBeGreaterThanOrEqual(0);
      expect(s.x[i]).toBeLessThanOrEqual(1920);
      expect(s.y[i]).toBeGreaterThanOrEqual(0);
      expect(s.y[i]).toBeLessThanOrEqual(1080);
      expect(s.rise[i]).toBeGreaterThan(0);
      expect(s.life[i]).toBe(1);
    }
  });

  it("rises, and respawns below the bottom after leaving the top", () => {
    const s = createBubbleState(1);
    const rng = createRng(3);
    spawnBubble(s, 0, rng, 1920, 500);
    stepBubbles(s, 1, 1, 1, 1, 1920, rng);
    expect(s.y[0]).toBeCloseTo(500 - s.rise[0], 3);

    s.y[0] = -bubbleMargin(s.r[0]) + 0.1;
    stepBubbles(s, 1, 1, 0.5, 0.5, 1920, rng);
    expect(s.y[0]).toBeGreaterThan(1080 + bubbleMargin(s.r[0]) - 1e-3);
  });

  it("only steps the first `count` bubbles and fades them in", () => {
    const s = createBubbleState(4);
    const rng = createRng(4);
    seedBubbles(s, rng, 1920);
    const y3 = s.y[3];
    s.life[0] = 0;
    stepBubbles(s, 2, 2, 0.75, 0.75, 1920, rng, 1.5);
    expect(s.y[3]).toBe(y3);
    expect(s.life[0]).toBeCloseTo(0.5);
  });

  it("fades in on the wall clock while the motion is paused (speed 0)", () => {
    const s = createBubbleState(1);
    const rng = createRng(6);
    spawnBubble(s, 0, rng, 1920, 500);
    s.life[0] = 0;
    stepBubbles(s, 1, 1, 0, 0.75, 1920, rng, 1.5);
    expect(s.y[0]).toBe(500);
    expect(s.life[0]).toBeCloseTo(0.5);
  });

  it("fades out bubbles at or beyond the target", () => {
    const s = createBubbleState(2);
    const rng = createRng(7);
    seedBubbles(s, rng, 1920);
    stepBubbles(s, 2, 1, 0, 0.3, 1920, rng);
    expect(s.life[0]).toBe(1);
    expect(s.life[1]).toBeCloseTo(0.5);
  });

  it("starts bubbles added by a higher count at life 0, beyond the old live range", () => {
    const s = createBubbleState(10);
    const rng = createRng(8);
    seedBubbles(s, rng, 1920);
    let live = growLive(s.life, 4, 4);
    stepBubbles(s, live, 4, 0.1, 0.1, 1920, rng);
    live = growLive(s.life, live, 10);
    expect(live).toBe(10);
    expect(Array.from(s.life.subarray(0, 4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(s.life.subarray(4))).toEqual([0, 0, 0, 0, 0, 0]);
    stepBubbles(s, live, 10, 0.75, 0.75, 1920, rng, 1.5);
    expect(s.life[4]).toBeCloseTo(0.5);
    expect(s.life[0]).toBe(1);
  });

  it("rescales x with the width on resize, keeping bubbles in the same place", () => {
    const s = createBubbleState(20);
    seedBubbles(s, createRng(9), 1920);
    const x = s.x.slice();
    const y = s.y.slice();
    rescaleBubbles(s, 1440 / 1920);
    for (let i = 0; i < 20; i++) {
      expect(s.x[i]).toBeCloseTo((x[i] * 1440) / 1920, 3);
      expect(s.x[i]).toBeLessThanOrEqual(1440);
    }
    expect(s.y).toEqual(y);
  });

  it("wobbles by less than a radius", () => {
    const s = createBubbleState(1);
    spawnBubble(s, 0, createRng(5), 1920, 100);
    for (let t = 0; t < 10; t += 0.1) {
      expect(Math.abs(bubbleX(s, 0, t) - s.x[0])).toBeLessThanOrEqual(s.r[0]);
    }
  });
});

describe("shaders", () => {
  it("generates one unrolled warp iteration per rate", () => {
    const src = tileFragment(CAUSTIC_RATES.length);
    expect(src.startsWith("#version 300 es")).toBe(true);
    expect(src.match(/inversesqrt/g)?.length).toBe(CAUSTIC_RATES.length);
    expect(src).toContain(`uniform float uT[${CAUSTIC_RATES.length}];`);
  });

  it("samples the tile 2 or 4 times, plus the ray table in deep water with rays", () => {
    const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
    expect(count(mainFragment(false, false), /texture\(/g)).toBe(2);
    expect(count(mainFragment(false, true), /texture\(/g)).toBe(4);
    expect(count(mainFragment(true, false), /texture\(/g)).toBe(3);
    expect(count(mainFragment(true, true), /texture\(/g)).toBe(5);
    expect(count(mainFragment(true, false, false), /texture\(/g)).toBe(2);
    expect(count(mainFragment(true, true, false), /texture\(/g)).toBe(4);
    expect(mainFragment(true, false, false)).not.toContain("uRayColor *");
  });
});

describe("tileMatrices", () => {
  const matA = new Float32Array(4);
  const matB = new Float32Array(4);
  /** GLSL `mat2 * vec2` with column-major `m`. */
  const apply = (m: Float32Array, x: number, y: number) => [
    m[0] * x + m[2] * y,
    m[1] * x + m[3] * y,
  ];

  it("maps one tile period of pixels to one tile unit on layer A", () => {
    tileMatrices(900, false, matA, matB);
    expect(apply(matA, 900, 0)[0]).toBeCloseTo(1, 6);
    expect(apply(matA, 0, 900)[1]).toBeCloseTo(1, 6);
    expect(apply(matA, 900, 0)[1]).toBe(0);
  });

  it("rotates and enlarges layer B without skewing it", () => {
    tileMatrices(900, false, matA, matB);
    const [ux, uy] = apply(matB, 900 * LAYER_B_SCALE, 0);
    expect(Math.hypot(ux, uy)).toBeCloseTo(1, 5);
    expect(Math.atan2(uy, ux)).toBeCloseTo(LAYER_B_ANGLE, 5);
    // Columns orthogonal and of equal length: a pure rotation and scale.
    expect(matB[0] * matB[2] + matB[1] * matB[3]).toBeCloseTo(0, 9);
    expect(Math.hypot(matB[0], matB[1])).toBeCloseTo(Math.hypot(matB[2], matB[3]), 9);
  });

  it("squashes both layers vertically in deep water", () => {
    tileMatrices(900, true, matA, matB);
    // A vertical run of DEEP_SQUASH periods covers a whole tile unit.
    expect(apply(matA, 0, 900 * DEEP_SQUASH)[1]).toBeCloseTo(1, 5);
    const [bx, by] = apply(matB, 0, 900 * LAYER_B_SCALE * DEEP_SQUASH);
    expect(Math.hypot(bx, by)).toBeCloseTo(1, 5);
    // x is not squashed.
    const [cx, cy] = apply(matB, 900 * LAYER_B_SCALE, 0);
    expect(Math.hypot(cx, cy)).toBeCloseTo(1, 5);
    const det = (m: Float32Array) => m[0] * m[3] - m[1] * m[2];
    expect(det(matA)).toBeCloseTo(1 / (900 * 900 * DEEP_SQUASH), 12);
    expect(det(matB)).toBeCloseTo(1 / (900 * LAYER_B_SCALE) ** 2 / DEEP_SQUASH, 12);
  });
});
