import { describe, expect, it } from "vitest";
import {
  CEILING_H,
  EYE_Y,
  HALF_W,
  project,
  rayDir,
  ringCoords,
  ringPoint,
  SEATS,
  seatBoxes,
  traceCorridor,
  vanishingY,
  WINDOW_FIRST,
  WINDOW_HALF,
  WINDOW_STEP,
  WINDOW_Y0,
  WINDOW_Y1,
  windowAzimuths,
  windowDistance,
} from "./ring-layout";

describe("corridor framing", () => {
  it("puts the corridor's vanishing curve in the middle third", () => {
    for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
      const y = vanishingY(aspect);
      expect(Math.abs(y)).toBeLessThan(1 / 3);
      expect(y).toBeGreaterThan(0);
    }
  });

  it("traces floor, ceiling and walls where they are", () => {
    for (let y = -0.95; y < 1; y += 0.1) {
      for (let x = -0.95; x < 1; x += 0.1) {
        const hit = traceCorridor(rayDir(x, y, 16 / 9));
        const { h } = ringCoords(hit.point);
        const onWall = hit.kind === "left" || hit.kind === "right";
        const want = hit.kind === "floor" ? 0 : hit.kind === "ceiling" ? CEILING_H : null;
        // Floor and ceiling hits sit at their height; wall hits on the wall, between them.
        expect(want === null ? 0 : Math.abs(h - want)).toBeLessThan(1e-6);
        expect(onWall ? Math.abs(Math.abs(hit.point[0]) - HALF_W) : 0).toBeLessThan(1e-6);
        expect(h).toBeGreaterThanOrEqual(-1e-6);
        expect(h).toBeLessThanOrEqual(CEILING_H + 1e-6);
        expect(onWall ? hit.kind : x > 0 ? "right" : "left").toBe(x > 0 ? "right" : "left");
      }
    }
    // Straight down is floor under the camera, straight ahead the far floor.
    expect(traceCorridor([0, -1, 0]).t).toBeCloseTo(EYE_Y, 9);
  });

  it("round-trips ring positions", () => {
    for (const [s, h] of [
      [0, 0],
      [5, 1.2],
      [-3, 2.5],
      [30, 0.4],
    ]) {
      const c = ringCoords(ringPoint(s, h, 0.3));
      expect(c.s).toBeCloseTo(s, 9);
      expect(c.h).toBeCloseTo(h, 9);
    }
  });
});

describe("windows", () => {
  it("are rounded rectangles repeating along the right wall", () => {
    const mid = (WINDOW_Y0 + WINDOW_Y1) / 2;
    for (let k = 0; k < 5; k++) {
      const s = WINDOW_FIRST + k * WINDOW_STEP;
      expect(windowDistance(s, mid)).toBeLessThan(0);
      expect(windowDistance(s + WINDOW_STEP / 2, mid)).toBeGreaterThan(0);
      expect(windowDistance(s + WINDOW_HALF - 0.01, mid)).toBeLessThan(0);
      // Rounded corners.
      expect(windowDistance(s + WINDOW_HALF - 0.01, WINDOW_Y1 - 0.01)).toBeGreaterThan(0);
    }
    // None behind the camera.
    expect(windowDistance(WINDOW_FIRST - WINDOW_STEP, mid)).toBeGreaterThan(0);
  });

  it("show on the right of the frame, the nearest in view", () => {
    const first = project(ringPoint(WINDOW_FIRST, (WINDOW_Y0 + WINDOW_Y1) / 2, HALF_W), 16 / 9);
    expect(first.x).toBeGreaterThan(0.5);
    expect(first.x).toBeLessThan(1);
    expect(Math.abs(first.y)).toBeLessThan(0.5);
  });

  it("span a range of azimuths from below to above straight ahead", () => {
    const [lo, hi] = windowAzimuths();
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi - lo).toBeLessThan(Math.PI / 2);
  });
});

describe("seats", () => {
  it("stand on the floor against a wall, clear of the middle", () => {
    for (const seat of SEATS) {
      for (const b of seatBoxes(seat)) {
        expect(b[0]).toBeGreaterThanOrEqual(-HALF_W);
        expect(b[3]).toBeLessThanOrEqual(HALF_W);
        expect(b[1]).toBe(0);
        expect(Math.min(Math.abs(b[0]), Math.abs(b[3]))).toBeGreaterThan(1);
        expect(b[4]).toBeLessThan(WINDOW_Y0 + 0.05);
      }
    }
  });
});
