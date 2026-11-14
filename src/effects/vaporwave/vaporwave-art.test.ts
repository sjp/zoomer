import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import {
  canDrawKana,
  dialogText,
  paintCaption,
  paintDialog,
  paintPalmAtlas,
} from "./vaporwave-art";
import { PALM_ASPECT, PALM_VARIANTS } from "./vaporwave-sim";

describe("dialogText", () => {
  it("is the same for a variation and serial, and varies between them", () => {
    expect(dialogText(1, 2)).toEqual(dialogText(1, 2));
    const seen = new Set<string>();
    for (let serial = 0; serial < 40; serial++) {
      const { title, lines } = dialogText(3, serial);
      expect(title).toMatch(/^[a-z]+\.exe$/);
      expect(lines).toHaveLength(2);
      seen.add(title);
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("without a canvas", () => {
  it("paints nothing and assumes the katakana can be drawn", () => {
    expect(paintDialog(1, 1, 0)).toBeNull();
    expect(paintPalmAtlas(100)).toBeNull();
    expect(paintCaption(800, 200, 1, 40, "A E S T H E T I C", true)).toBeNull();
    expect(canDrawKana()).toBe(true);
  });
});

describe("with a canvas", () => {
  beforeEach(() => {
    MeasuringCanvas.reset(0.6);
    vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lays the palm variants side by side", () => {
    const atlas = paintPalmAtlas(200);
    expect(atlas?.width).toBe(Math.round(200 * PALM_ASPECT) * PALM_VARIANTS);
    expect(atlas?.height).toBe(200);
  });

  it("shrinks a long caption to fit across", () => {
    const text = "A".repeat(24);
    paintCaption(400, 200, 1, 40, text, false);
    const call = MeasuringCanvas.calls.find((c) => c.method === "fillText" && c.args[0] === text);
    const px = Number(/([\d.]+)px/.exec(call?.font ?? "")?.[1]);
    expect(px * 0.6 * text.length).toBeLessThanOrEqual(400 * 0.94 + 1e-6);
  });

  it("leaves out the katakana when there is no face for it", () => {
    paintCaption(800, 200, 1, 40, "A E S T H E T I C", false);
    const lines = MeasuringCanvas.calls
      .filter((c) => c.method === "fillText")
      .map((c) => c.args[0]);
    expect(lines.every((l) => l === "A E S T H E T I C")).toBe(true);
    MeasuringCanvas.reset(0.6);
    paintCaption(800, 200, 1, 40, "A E S T H E T I C", true);
    expect(MeasuringCanvas.calls.filter((c) => c.method === "fillText")).toHaveLength(4);
  });
});
