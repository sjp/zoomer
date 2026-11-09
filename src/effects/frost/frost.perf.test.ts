import { describe, expect, it } from "vitest";
import { timeFrames } from "../../test/frame-timing";
import { frost } from "./frost";

/**
 * CPU budgets for a frame on a shared CI machine. The field build is spread over
 * frames at about 2 ms each; a one-shot build takes 60-120 ms warm.
 */
const FRAME_BUDGET_MS = 16;

describe("frost", () => {
  it("never stalls a frame across many grow / hold / melt cycles", () => {
    // Fastest growth: a cycle every ~80 s, so 250 s cross three boundaries, each
    // building the next cycle's field ahead. More cycles only repeat the same work.
    const run = timeFrames(frost, 2500, 0.1, (_, base) => ({ params: { ...base, growth: 4 } }));
    expect(run.worst(20)).toBeLessThan(FRAME_BUDGET_MS);
  });

  it("builds once after a seed drag or a resize settles, without stalling", () => {
    let seed = 0;
    const run = timeFrames(frost, 600, 1 / 60, (i, base) => {
      if (i > 60 && i < 180) {
        seed++;
      }
      const width = i > 300 && i < 400 ? 1920 - (i - 300) * 4 : undefined;
      return {
        params: { ...base, seed },
        ...(width === undefined ? {} : { viewport: { width, height: 1080, scale: 1 } }),
      };
    });
    expect(run.worst(20)).toBeLessThan(FRAME_BUDGET_MS);
  });
});
