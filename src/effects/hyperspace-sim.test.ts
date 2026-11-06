import { describe, expect, it } from "vitest";
import { createJump, FLASH_AT, FLASH_SECONDS, wantsHyperspace } from "./hyperspace-sim";

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

  it("starts in its target state and stays there without jitter or a flash", () => {
    const into = createJump();
    expect(into.progress).toBe(-1);
    for (let i = 0; i < 10; i++) {
      into.step(dt, "in", 1.6, 16);
      expect(into.progress).toBe(1);
      expect(into.flash).toBe(0);
    }
    const out = createJump();
    out.step(dt, "out", 1.6, 16);
    expect(out.progress).toBe(0);
  });

  it("ramps linearly over jumpSeconds, flashing once as it passes FLASH_AT", () => {
    const jump = createJump();
    jump.step(dt, "out", 2, 16);
    const flashes: number[] = [];
    let frames = 0;
    while (jump.progress < 1) {
      const before = jump.flash;
      jump.step(dt, "in", 2, 16);
      frames++;
      if (jump.flash > before) {
        flashes.push(jump.progress);
      }
      expect(jump.progress).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(frames - 120)).toBeLessThanOrEqual(1);
    expect(flashes).toHaveLength(1);
    expect(flashes[0]).toBeGreaterThanOrEqual(FLASH_AT);
    expect(flashes[0]).toBeLessThan(FLASH_AT + 2 * (dt / 2));
  });

  it("fades the flash out over FLASH_SECONDS", () => {
    const jump = createJump();
    jump.step(dt, "out", 0.5, 16);
    while (jump.flash === 0) {
      jump.step(dt, "in", 0.5, 16);
    }
    expect(jump.flash).toBeCloseTo(1 - dt / FLASH_SECONDS, 12);
    for (let t = 0; t < FLASH_SECONDS; t += dt) {
      jump.step(dt, "in", 0.5, 16);
    }
    expect(jump.flash).toBe(0);
  });

  it("drops back without a flash, and reverses mid-jump", () => {
    const jump = createJump();
    jump.step(dt, "in", 1, 16);
    for (let i = 0; i < 30; i++) {
      jump.step(dt, "out", 1, 16);
    }
    expect(jump.progress).toBeCloseTo(0.5, 9);
    expect(jump.flash).toBe(0);
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
