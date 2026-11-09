import { describe, expect, it } from "vitest";
import { timeFrames } from "../../test/frame-timing";
import { grass } from "./grass";

/** CPU budget for a frame; rebuilding and sorting the blades took 10-35 ms. */
const FRAME_BUDGET_MS = 4;

describe("grass", () => {
  it("follows a window resize and a density drag without rebuilding the blades", () => {
    const run = timeFrames(grass, 240, 1 / 60, (i, base) => ({
      params: { ...base, density: i < 120 ? base.density : 0.5 + (i - 120) / 60 },
      viewport: { width: 1920 + i * 8, height: 1080, scale: 1 },
    }));
    expect(run.worst(1)).toBeLessThan(FRAME_BUDGET_MS);
  });
});
