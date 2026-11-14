import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { CRITTER_FRAMES, CRITTERS, drawCritter, paintCritterAtlas } from "./critters";
import { FRAME_BLINK, FRAME_IDLE } from "./passion-sim";
import { CRITTER_OPTIONS, passionMeta } from "./passion.meta";

/** The 2D calls drawing one pose makes, as "method(args)" strings. */
function calls(critter: (typeof CRITTER_OPTIONS)[number]["value"], frame: number): string[] {
  MeasuringCanvas.reset();
  const ctx = new MeasuringCanvas(
    64,
    64,
  ).getContext() as unknown as OffscreenCanvasRenderingContext2D;
  drawCritter(ctx, critter, frame);
  return MeasuringCanvas.calls.map((c) => `${c.method}(${c.args.join(",")})`);
}

const IDS = CRITTER_OPTIONS.map((o) => o.value);

beforeEach(() => {
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("critters", () => {
  it("has exactly one draw function per select option", () => {
    expect(Object.keys(CRITTERS).toSorted()).toEqual(IDS.toSorted());
    expect(passionMeta.params.critter.options).toBe(CRITTER_OPTIONS);
    expect(IDS).toContain(passionMeta.params.critter.default);
  });

  it.each(IDS)("draws the %s with filled, outlined shapes", (id) => {
    const open = calls(id, 0);
    expect(open.filter((c) => c.startsWith("fill(")).length).toBeGreaterThan(5);
    expect(open.filter((c) => c.startsWith("stroke(")).length).toBeGreaterThan(5);
  });

  it.each(IDS)("closes the %s's eyes to blink", (id) => {
    expect(calls(id, FRAME_BLINK)).not.toEqual(calls(id, 0));
  });

  it.each(IDS)("gives the %s an idle touch", (id) => {
    expect(calls(id, FRAME_IDLE)).not.toEqual(calls(id, 0));
  });

  it("paints every critter and pose into one atlas", () => {
    const atlas = paintCritterAtlas(32) as unknown as MeasuringCanvas;
    expect([atlas.width, atlas.height]).toEqual([32 * CRITTER_FRAMES, 32 * IDS.length]);
    const placed = MeasuringCanvas.calls.filter((c) => c.method === "translate");
    expect(placed).toHaveLength(CRITTER_FRAMES * IDS.length);
  });
});
