import { describe, expect, it } from "vitest";
import { timeFrames } from "../../test/frame-timing";
import { planet } from "./planet";

/** CPU budget for a frame on a shared CI machine; a one-shot rebuild takes ~80 ms. */
const FRAME_BUDGET_MS = 16;

describe("planet", () => {
  it("rebuilds after a seed drag and a world change without stalling a frame", () => {
    const run = timeFrames(planet, 900, 1 / 60, (i, base) => ({
      params: {
        ...base,
        seed: i > 30 && i < 150 ? i : 150,
        world: i > 400 ? "gas" : base.world,
      },
    }));
    // The first frame builds at once so the planet never opens blank.
    expect(run.worst(1)).toBeLessThan(FRAME_BUDGET_MS);
  });
});
