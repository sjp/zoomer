import { describe, expect, it } from "vitest";
import type { Rgb } from "./color";
import {
  ECHO_SIM_RATE,
  echoBrightness,
  echoColor,
  echoLineLook,
  echoSteps,
  hueRgb,
  MIN_ECHO_STEPS,
  type EchoLineLook,
} from "./echo-lines";
import { MAX_PATTERN_HZ } from "./motion-limits";

describe("echoSteps", () => {
  it("keeps the echo rate under the pattern limit at any speed", () => {
    for (const speed of [0, 1e-9, 0.02, 0.1, 0.5, 5, 1e6]) {
      const steps = echoSteps(speed);
      expect(steps).toBeGreaterThanOrEqual(MIN_ECHO_STEPS);
      expect(ECHO_SIM_RATE / steps).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    }
  });

  it("samples faster points more often", () => {
    expect(echoSteps(0.12)).toBeLessThan(echoSteps(0.04));
  });
});

describe("hueRgb", () => {
  it("runs through the primaries", () => {
    const out: Rgb = [0, 0, 0];
    expect(hueRgb(0, 1, out)).toEqual([1, 0, 0]);
    expect(hueRgb(1 / 3, 1, out)).toEqual([0, 1, 0]);
    expect(hueRgb(2 / 3, 1, out)).toEqual([0, 0, 1]);
    expect(hueRgb(1.5, 0, out)).toEqual([1, 1, 1]);
  });
});

describe("echo styles", () => {
  it("draws every echo at full brightness in Classic and fades them with age in Modern", () => {
    const classic = [1, 2, 3, 8].map((k) => echoBrightness(k, 8, 0.5, 0));
    expect(classic).toEqual([1, 1, 1, 1]);
    const modern = [1, 2, 3, 8].map((k) => echoBrightness(k, 8, 0.5, 1));
    for (let i = 1; i < modern.length; i++) {
      expect(modern[i]).toBeLessThan(modern[i - 1]);
    }
    // A fractional count fades the last echo in.
    expect(echoBrightness(3, 2.25, 0, 0)).toBeCloseTo(0.25);
    expect(echoBrightness(4, 2.25, 0, 0)).toBe(0);
  });

  it("colours echoes with the figure's colour in Classic and their own in Modern", () => {
    const out: Rgb = [0, 0, 0];
    expect(echoColor([1, 0, 0], [0, 0, 1], 0, out)).toEqual([1, 0, 0]);
    expect(echoColor([1, 0, 0], [0, 0, 1], 1, out)).toEqual([0, 0, 1]);
  });

  it("adds a wider glow only in Modern", () => {
    const look: EchoLineLook = { halfWidth: 0, glowWidth: 0, glow: 0, saturation: 0 };
    expect(echoLineLook(0, 2, look).glow).toBe(0);
    const classicWidth = look.halfWidth;
    echoLineLook(1, 2, look);
    expect(look.glow).toBeGreaterThan(0);
    expect(look.glowWidth).toBeGreaterThan(look.halfWidth);
    expect(look.halfWidth).toBeGreaterThan(classicWidth);
  });
});
