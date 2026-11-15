import { describe, expect, it } from "vitest";
import {
  easedMoveSeconds,
  type GridPose,
  SEG_HOLD,
  SEG_TURN,
  SEG_WALK,
  updateGridPose,
} from "./grid-walk";
import { EASE_PEAK, MAX_PATTERN_HZ } from "./motion-limits";

const pose = (kind: number, dir: number, progress: number, turn = 0): GridPose => ({
  cx: 3,
  cy: -2,
  dir,
  kind,
  progress,
  turn,
  easeIn: true,
  easeOut: true,
  x: 0,
  y: 0,
  angle: 0,
});

describe("easedMoveSeconds", () => {
  it("takes span / rate below the cap", () => {
    expect(easedMoveSeconds(1, 0.5, 1)).toBeCloseTo(2, 12);
  });

  it.each([1, 10, 1e9])("keeps the peak within MAX_PATTERN_HZ at rate %d", (rate) => {
    const period = 0.5;
    const peak = EASE_PEAK / easedMoveSeconds(1, rate, period);
    expect(peak / period).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
  });
});

describe("updateGridPose", () => {
  it("walks from the cell centre along the heading", () => {
    const w = pose(SEG_WALK, 1, 1);
    updateGridPose(w);
    expect([w.x, w.y, w.angle]).toEqual([3.5, -0.5, Math.PI / 2]);
  });

  it("turns on the spot from the old heading to the new", () => {
    const w = pose(SEG_TURN, 1, 0, 1);
    updateGridPose(w);
    expect([w.x, w.y, w.angle]).toEqual([3.5, -1.5, 0]);
    w.progress = 1;
    updateGridPose(w);
    expect(w.angle).toBeCloseTo(Math.PI / 2, 12);
  });

  it("stands on the cell centre when holding", () => {
    const w = pose(SEG_HOLD, 2, 0.4);
    updateGridPose(w);
    expect([w.x, w.y, w.angle]).toEqual([3.5, -1.5, Math.PI]);
  });
});
