import { describe, expect, it } from "vitest";
import { capPatternSpeed, MAX_PATTERN_HZ, pxPerReferenceFrame } from "./motion-limits";

describe("capPatternSpeed", () => {
  it("leaves slow patterns alone", () => {
    expect(capPatternSpeed(1.2, 0.5)).toBe(1.2);
  });

  it("caps the crossing rate at MAX_PATTERN_HZ for any period", () => {
    for (const period of [0.05, 0.2, 0.5, 1, 3]) {
      for (const speed of [0.1, 1, 6, 50]) {
        const v = capPatternSpeed(speed, period);
        expect(v).toBeLessThanOrEqual(speed);
        expect(v / period).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-12);
      }
    }
  });

  it("gives 0 for bad or negative inputs", () => {
    expect(capPatternSpeed(-1, 0.5)).toBe(0);
    expect(capPatternSpeed(Number.NaN, 0.5)).toBe(0);
    expect(capPatternSpeed(Infinity, 0.5)).toBe(0);
    expect(capPatternSpeed(1, 0)).toBe(0);
  });
});

describe("pxPerReferenceFrame", () => {
  it("converts frame heights per second to px per frame at 1080p30", () => {
    expect(pxPerReferenceFrame(1)).toBe(36);
    expect(pxPerReferenceFrame(-0.5)).toBe(18);
  });
});
