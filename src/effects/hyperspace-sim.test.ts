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

  it("ramps linearly over jumpSeconds, flashing once as it passes FLASH_AT", () => {
    const jump = createJump();
    jump.step(dt, "out", 2, 16);
    const flashes: number[] = [];
    let frames = 0;
    while (jump.progress < 1) {
      const before = jump.flash;
      jump.step(dt, "in", 2, 16);
      frames++;
      if (jump.flash > before) flashes.push(jump.progress);
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
    while (jump.flash === 0) jump.step(dt, "in", 0.5, 16);
    expect(jump.flash).toBeCloseTo(1 - dt / FLASH_SECONDS, 12);
    for (let t = 0; t < FLASH_SECONDS; t += dt) jump.step(dt, "in", 0.5, 16);
    expect(jump.flash).toBe(0);
  });
});
