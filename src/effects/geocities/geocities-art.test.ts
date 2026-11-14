import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import {
  createGeoMeasure,
  MAX_TEXTURE,
  paintMarquee,
  paintPage,
  paintParts,
  snapWebSafe,
} from "./geocities-art";
import { BUTTON_LABELS, FOOTER_LINES, layoutPage } from "./geocities-sim";
import { geocitiesMeta, MARQUEE_LENGTH, TILE_OPTIONS } from "./geocities.meta";

beforeEach(() => {
  MeasuringCanvas.reset(0.6);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const texts = () =>
  MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));

describe("web-safe snap", () => {
  it("snaps channels to multiples of 51 and alpha to clear or solid", () => {
    const px = new Uint8ClampedArray([10, 30, 200, 255, 128, 77, 254, 127, 90, 160, 26, 128]);
    snapWebSafe(px);
    expect(Array.from(px)).toEqual([0, 51, 204, 255, 0, 0, 0, 0, 102, 153, 51, 255]);
  });
});

describe("page art", () => {
  it.each(TILE_OPTIONS.map((o) => o.value))("letters every label on the %s page", (tile) => {
    const layout = layoutPage(16 / 9, "Welcome!", createGeoMeasure());
    const canvas = paintPage(layout, tile, 1067, 600, true) as unknown as MeasuringCanvas;
    expect(canvas.width).toBe(1067);
    const drawn = texts();
    for (const label of [...BUTTON_LABELS, ...FOOTER_LINES, "Welcome!"]) {
      expect(drawn).toContain(label);
    }
  });

  it.each([
    ["Classic 16:9", 16 / 9, 1067, 600],
    ["Crisp 4K", 16 / 9, 3840, 2160],
    ["Crisp portrait", 9 / 16, 1080, 1920],
    ["thin strip", 32, 1920, 60],
  ])("packs the moving parts into one texture (%s)", (_, aspect, w, h) => {
    const layout = layoutPage(aspect, "Welcome", createGeoMeasure());
    const art = paintParts(layout, w / layout.width, h / layout.height, false);
    const canvas = art.canvas as unknown as MeasuringCanvas;
    expect(canvas.width).toBeLessThanOrEqual(MAX_TEXTURE);
    expect(canvas.height).toBeLessThanOrEqual(MAX_TEXTURE);
    const uvs = [art.signText, ...art.workers, art.badge, ...art.globes, art.wheel];
    for (const uv of uvs) {
      expect(uv.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(uv[2]).toBeGreaterThan(uv[0]);
      expect(uv[3]).toBeGreaterThan(uv[1]);
    }
    // Eleven digits on the wheel, so rolling 9 to 0 shows a 0 below the 9.
    expect(art.wheel[3] - art.wheel[1]).toBeCloseTo(11 * art.cell);
    expect(texts()).toEqual(expect.arrayContaining(["UNDER", "CONSTRUCTION", "NEW!", "0", "9"]));
  });
});

describe("marquee art", () => {
  it.each([
    ["default", geocitiesMeta.params.marquee.default],
    ["longest", "W".repeat(MARQUEE_LENGTH)],
    ["many words", "a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4"],
  ])("draws the %s text once on a strip that fits a texture", (_, text) => {
    const layout = layoutPage(16 / 9, "", createGeoMeasure());
    const art = paintMarquee(text, layout, createGeoMeasure(), 3.6, 3.6, false);
    const canvas = art.canvas as unknown as MeasuringCanvas;
    expect(canvas.width).toBeLessThanOrEqual(MAX_TEXTURE);
    expect(canvas.height).toBeLessThanOrEqual(MAX_TEXTURE);
    expect(texts()).toEqual(text.split(" "));
    expect(art.period).toBeGreaterThan(0);
  });
});
