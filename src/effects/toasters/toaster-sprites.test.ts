import { afterEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  CLASSIC_CELL,
  paintClassicAtlas,
  paintModernAtlas,
  pixelate,
} from "./toaster-sprites";
import { FLAP_CYCLE, TOAST_CELL } from "./toasters-sim";

describe("pixelate", () => {
  it("makes alpha binary and snaps colours to the web-safe palette", () => {
    const data = new Uint8ClampedArray([
      // Opaque enough: kept, snapped.
      10, 30, 200, 200,
      // Mostly clear: cleared to transparent black.
      255, 255, 255, 100,
      // Exactly half: kept.
      127, 128, 254, 128,
      // A bluish grey: snapped to one grey, not tinted channel by channel.
      123, 128, 137, 255,
    ]);
    pixelate(data);
    expect([...data]).toEqual([
      0, 51, 204, 255, 0, 0, 0, 0, 102, 153, 255, 255, 153, 153, 153, 255,
    ]);
  });
});

describe("atlas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has a cell for every flap frame and toast level", () => {
    expect(Math.max(...FLAP_CYCLE)).toBeLessThan(TOAST_CELL);
    expect(TOAST_CELL + 3).toBe(ATLAS_COLS * ATLAS_ROWS);
  });

  it("paints both styles at their cell sizes, each cell clipped to itself", () => {
    MeasuringCanvas.reset();
    vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
    const classic = paintClassicAtlas();
    expect(classic?.width).toBe(ATLAS_COLS * CLASSIC_CELL);
    expect(classic?.height).toBe(ATLAS_ROWS * CLASSIC_CELL);
    const modern = paintModernAtlas(100);
    expect(modern?.width).toBe(ATLAS_COLS * 100);
    expect(modern?.height).toBe(ATLAS_ROWS * 100);
    const clips = MeasuringCanvas.calls.filter((c) => c.method === "clip").length;
    // Classic: one clip per cell plus one per toaster's chrome glint; Modern
    // draws each cell on its own canvas and composites it, clipped.
    expect(clips).toBe(2 * ATLAS_COLS * ATLAS_ROWS + 2 * 3);
    expect(MeasuringCanvas.calls.filter((c) => c.method === "drawImage")).toHaveLength(
      ATLAS_COLS * ATLAS_ROWS,
    );
  });

  it("paints nothing without a canvas", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    expect(paintClassicAtlas()).toBeNull();
    expect(paintModernAtlas(100)).toBeNull();
  });
});
