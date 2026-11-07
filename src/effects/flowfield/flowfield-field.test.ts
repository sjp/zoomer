import { describe, expect, it } from "vitest";
import { createFlowField, FIELD_DZ, FIELD_RES, type Noise3 } from "./flowfield-field";
import { createNoise, createRng } from "../noise";

/** A noise function that counts its calls. */
const counted = (seed: number) => {
  const { noise3 } = createNoise(seed);
  const state = { calls: 0 };
  const fn: Noise3 = (x, y, z) => {
    state.calls++;
    return noise3(x, y, z);
  };
  return { fn, state, noise3 };
};

// Default-detail cover: about 3.2 x 1.8 noise units, with some negative margin.
const X0 = -0.02;
const Y0 = -0.02;
const X1 = 3.1;
const Y1 = 1.75;

describe("createFlowField", () => {
  it("tracks the noise it bakes closely", () => {
    const { noise3 } = createNoise(42);
    const field = createFlowField();
    const rng = createRng(7);
    let maxErr = 0;
    let sumErr = 0;
    let samples = 0;
    for (let time = 3; time < 4; time += 0.01) {
      field.update(noise3, X0, Y0, X1, Y1, time);
      for (let s = 0; s < 50; s++) {
        const x = rng() * X1;
        const y = rng() * Y1;
        const err = Math.abs(field.sample(x, y) - noise3(x, y, time));
        maxErr = Math.max(maxErr, err);
        sumErr += err;
        samples++;
      }
    }
    // Simplex noise spans about [-1, 1]: a few percent at worst, under 1% on average.
    expect(maxErr).toBeLessThan(0.05);
    expect(sumErr / samples).toBeLessThan(0.01);
  });

  it("matches lattice samples exactly at slice times", () => {
    const { noise3 } = createNoise(3);
    const field = createFlowField();
    const time = 5 * FIELD_DZ;
    field.update(noise3, X0, Y0, X1, Y1, time);
    const x = 9 / FIELD_RES;
    const y = 4 / FIELD_RES;
    expect(field.sample(x, y)).toBeCloseTo(noise3(x, y, time), 6);
  });

  it("gives the same field after scrolling through slices as when built fresh", () => {
    const { noise3 } = createNoise(11);
    const scrolled = createFlowField();
    let time = 0;
    for (let i = 0; i < 100; i++) {
      time += FIELD_DZ * 0.137;
      scrolled.update(noise3, X0, Y0, X1, Y1, time);
    }
    const fresh = createFlowField();
    fresh.update(noise3, X0, Y0, X1, Y1, time);
    for (let y = 0; y < Y1; y += 0.13) {
      for (let x = 0; x < X1; x += 0.17) {
        expect(scrolled.sample(x, y)).toBeCloseTo(fresh.sample(x, y), 6);
      }
    }
  });

  it("does no noise work while the field is still", () => {
    const { fn, state } = counted(1);
    const field = createFlowField();
    field.update(fn, X0, Y0, X1, Y1, 2);
    const first = state.calls;
    expect(first).toBeGreaterThan(0);
    // Paused time finishes building the next slice at most once, then stops.
    field.update(fn, X0, Y0, X1, Y1, 2);
    const settled = state.calls;
    for (let i = 0; i < 10; i++) {
      field.update(fn, X0, Y0, X1, Y1, 2);
    }
    expect(state.calls).toBe(settled);
  });

  it("spreads slice building over the frames between slices", () => {
    const { fn, state } = counted(1);
    const field = createFlowField();
    let time = 1;
    field.update(fn, X0, Y0, X1, Y1, time);
    const slice = state.calls / 2;
    let worst = 0;
    // 60 frames per slice.
    for (let i = 0; i < 600; i++) {
      const before = state.calls;
      time += FIELD_DZ / 60;
      field.update(fn, X0, Y0, X1, Y1, time);
      worst = Math.max(worst, state.calls - before);
    }
    expect(worst).toBeLessThan(slice / 4);
  });

  it("rebuilds for a new noise function or cover", () => {
    const a = counted(1);
    const b = counted(2);
    const field = createFlowField();
    field.update(a.fn, X0, Y0, X1, Y1, 0.5);
    field.update(b.fn, X0, Y0, X1, Y1, 0.5);
    expect(b.state.calls).toBeGreaterThan(0);
    expect(field.sample(1, 1)).toBeCloseTo(b.noise3(1, 1, 0.5), 1);
    const before = b.state.calls;
    field.update(b.fn, X0, Y0, X1 * 2, Y1 * 2, 0.5);
    expect(b.state.calls).toBeGreaterThan(before);
  });

  it("clamps points outside the cover to its edge", () => {
    const { noise3 } = createNoise(5);
    const field = createFlowField();
    field.update(noise3, 0, 0, 1, 1, 0);
    expect(field.sample(-5, 0.5)).toBe(field.sample(0, 0.5));
    expect(field.sample(0.5, 9)).toBe(field.sample(0.5, 1));
    expect(Number.isFinite(field.sample(1, 1))).toBe(true);
  });
});
