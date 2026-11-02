import { describe, expect, it } from "vitest";
import { createFrameLimiter } from "./frameRate";

/** Simulates `seconds` of a display at `hz` and counts frames the limiter draws. */
function countFrames(hz: number, fps: number | undefined, seconds = 10) {
  const shouldDraw = createFrameLimiter();
  let drawn = 0;
  for (let i = 0; i < hz * seconds; i++) {
    const jitter = (Math.random() - 0.5) * 1.5;
    if (shouldDraw(1000 + (i * 1000) / hz + jitter, fps)) drawn++;
  }
  return drawn / seconds;
}

describe("createFrameLimiter", () => {
  it("draws every refresh when matching the display", () => {
    expect(countFrames(144, undefined)).toBe(144);
  });

  it("does not drop frames when the cap equals the refresh rate", () => {
    expect(countFrames(60, 60)).toBeCloseTo(60, 0);
  });

  it.each([
    [144, 60],
    [120, 60],
    [120, 30],
    [60, 30],
  ])("caps a %d Hz display to %d fps", (hz, fps) => {
    expect(Math.abs(countFrames(hz, fps) - fps)).toBeLessThan(1);
  });
});
