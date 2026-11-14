import { describe, expect, it } from "vitest";
import { tweenPeakPxPerFrame } from "../charts";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { CANDLE_SPACING, SLIDE_SECONDS, STEP_SECONDS } from "./trading";
import { createFocusLayout, focusLayout } from "./trading-layout";

describe("trading motion", () => {
  it("steps the chart one candle within the codec motion limits", () => {
    expect(tweenPeakPxPerFrame(CANDLE_SPACING, STEP_SECONDS)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
  });

  it.each([
    [1920, 1080],
    [1440, 1080],
    [2560, 1080],
  ])("slides a new trade row in within the codec motion limits at %d x %d", (w, h) => {
    const layout = createFocusLayout();
    focusLayout(w, h, h / 1080, layout);
    const rowRef = layout.tradeRow / (h / 1080);
    expect(rowRef).toBeGreaterThan(10);
    expect(tweenPeakPxPerFrame(rowRef, SLIDE_SECONDS)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
  });
});
