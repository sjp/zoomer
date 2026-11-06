import { describe, expect, it } from "vitest";
import { createFrameLimiter, frameDelta, MAX_FRAME_DT } from "./frameRate";

/** Simulates `seconds` of a display at `hz` and counts frames the limiter draws. */
function countFrames(hz: number, fps: number | undefined, seconds = 10) {
  const shouldDraw = createFrameLimiter();
  let drawn = 0;
  for (let i = 0; i < hz * seconds; i++) {
    const jitter = (Math.random() - 0.5) * 1.5;
    if (shouldDraw(1000 + (i * 1000) / hz + jitter, fps)) {
      drawn++;
    }
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

describe("frameDelta", () => {
  it("converts milliseconds to seconds", () => {
    expect(frameDelta(1016, 1000)).toBeCloseTo(0.016);
  });

  it("never goes negative when the timestamp precedes the last one", () => {
    expect(frameDelta(990, 1000)).toBe(0);
  });

  it("caps long pauses", () => {
    expect(frameDelta(60_000, 1000)).toBe(MAX_FRAME_DT);
  });

  it("treats NaN as no time passing", () => {
    expect(frameDelta(Number.NaN, 1000)).toBe(0);
  });
});
