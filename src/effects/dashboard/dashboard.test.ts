import { describe, expect, it } from "vitest";
import { tweenPeakPxPerFrame } from "../charts";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { LINE_POINTS, STEP_SECONDS } from "./dashboard";
import { createLayout, dashboardLayout, linePlot, rect } from "./dashboard-layout";

describe("dashboard motion", () => {
  it.each([
    [1920, 1080],
    [1440, 1080],
    [2560, 1080],
  ])("steps the line chart one day within the codec motion limits at %d x %d", (w, h) => {
    const s = h / 1080;
    const L = dashboardLayout(w, h, s, createLayout());
    // The Simple density's wide card spaces the points furthest apart.
    for (const card of [L.lineSimple, L.lineFull]) {
      const plot = linePlot(card, s, rect());
      const spacingRef = plot.w / (LINE_POINTS - 1) / s;
      expect(tweenPeakPxPerFrame(spacingRef, STEP_SECONDS)).toBeLessThanOrEqual(
        MAX_FEATURE_PX_PER_FRAME,
      );
    }
  });
});
