import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import {
  createPhraseMeasure,
  drawShiba,
  EYE_R,
  paintPhrase,
  paintShibaAtlas,
  PUPIL_CELL,
  PUPIL_TRAVEL,
  SHIBA_CELLS,
} from "./suchwow-art";
import { PHRASE_COLORS } from "./suchwow-sim";

beforeEach(() => {
  MeasuringCanvas.reset(0.5);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The 2D calls drawing the head makes, as "method(args)" strings. */
function headCalls(shut: boolean): string[] {
  MeasuringCanvas.reset();
  const ctx = new MeasuringCanvas(
    64,
    64,
  ).getContext() as unknown as OffscreenCanvasRenderingContext2D;
  drawShiba(ctx, shut);
  return MeasuringCanvas.calls.map((c) => `${c.method}(${c.args.join(",")})`);
}

describe("phrase art", () => {
  it("outlines then fills the phrase in its colour, centred in a canvas of the box's size", () => {
    const canvas = paintPhrase("such test", 2, 40, 300.2, 58) as unknown as MeasuringCanvas;
    expect([canvas.width, canvas.height]).toEqual([301, 58]);
    const text = MeasuringCanvas.calls.filter(
      (c) => c.method === "strokeText" || c.method === "fillText",
    );
    expect(text.map((c) => c.method)).toEqual(["strokeText", "fillText"]);
    expect(text[1].args.slice(0, 2)).toEqual(["such test", 301 / 2]);
    expect(text[1].fillStyle).toBe(PHRASE_COLORS[2]);
    expect(text[1].font).toContain("40px");
  });

  it("measures phrases in ems of the phrase font", () => {
    expect(createPhraseMeasure()("wow")).toBeCloseTo(1.5);
  });
});

describe("shiba art", () => {
  it("draws a filled, outlined head that shuts its eyes", () => {
    const open = headCalls(false);
    expect(open.filter((c) => c.startsWith("fill(")).length).toBeGreaterThan(5);
    expect(open.filter((c) => c.startsWith("stroke(")).length).toBeGreaterThan(5);
    expect(headCalls(true)).not.toEqual(open);
  });

  it("paints open, shut and pupil cells in a row", () => {
    const atlas = paintShibaAtlas(40) as unknown as MeasuringCanvas;
    expect([atlas.width, atlas.height]).toEqual([40 * SHIBA_CELLS, 40]);
    expect(MeasuringCanvas.calls.filter((c) => c.method === "translate")).toHaveLength(SHIBA_CELLS);
  });

  it("keeps the sliding pupil inside the eye's white", () => {
    // The pupil's half height (0.58 of the eye radius it is drawn for) plus its travel.
    expect(PUPIL_TRAVEL + 0.58 * EYE_R).toBeLessThan(EYE_R);
    expect(PUPIL_CELL).toBeGreaterThan(EYE_R);
  });
});
