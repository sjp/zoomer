import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { timeFrames } from "../../test/frame-timing";
import { FakeOffscreenCanvas } from "../../test/offscreen-canvas";
import { ASCENT_PERIOD } from "./lunarlander-sim";
import { lunarlander } from "./lunarlander";

/** CPU budget for a frame on a shared CI machine; the one-shot builds took 25-350 ms. */
const FRAME_BUDGET_MS = 16;

beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("lunarlander", () => {
  it("builds its textures without stalling a frame, through a lift-off", () => {
    const seconds = ASCENT_PERIOD + 60;
    const run = timeFrames(lunarlander, Math.ceil(seconds / 0.1), 0.1, (_, base) => ({
      params: { ...base, ascent: true },
    }));
    expect(run.worst(5)).toBeLessThan(FRAME_BUDGET_MS);
  });
});
