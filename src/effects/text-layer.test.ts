import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../test/fake-gl";
import { FakeOffscreenCanvas, MeasuringCanvas } from "../test/offscreen-canvas";
import { hexToUnitRgb } from "./color";
import { createScope } from "./gl";
import {
  createTextLayer,
  setTextPalette,
  TEXT_PALETTE_FLOATS,
  TEXT_ROLES,
  type TextLayer,
} from "./text-layer";

/** The shader's role decode, in JS: the weight of each role for a premultiplied texel. */
function decode(r: number, g: number, b: number): number[] {
  const down = Math.min(r, b);
  const inverse = Math.min(g, b);
  return [r - down, g - inverse, Math.max(0, b - down - inverse), down, inverse];
}

describe("text roles", () => {
  const roles = Object.values(TEXT_ROLES);

  it("has a palette triple per role", () => {
    expect(roles.length * 3).toBe(TEXT_PALETTE_FLOATS);
  });

  it.each(roles.map((hex, i) => [hex, i] as const))(
    "decodes %s at any coverage as its own role only",
    (hex, index) => {
      const [r, g, b] = hexToUnitRgb(hex);
      for (const cover of [1, 0.5, 0.1]) {
        const w = decode(r * cover, g * cover, b * cover);
        w.forEach((v, k) => {
          expect(v).toBeCloseTo(k === index ? cover : 0, 9);
        });
      }
    },
  );
});

describe("setTextPalette", () => {
  it("writes each role's colour in role order", () => {
    const palette = new Float32Array(TEXT_PALETTE_FLOATS);
    setTextPalette(palette, [1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15]);
    expect([...palette]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});

describe("createTextLayer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const build = () => {
    const fake = createFakeGl({ record: true });
    const scope = createScope();
    const layer: TextLayer = createTextLayer(fake.gl, scope, 4);
    return { fake, scope, layer };
  };
  const named = (fake: ReturnType<typeof createFakeGl>, name: string) =>
    fake.calls.filter((c) => c.name === name).length;

  it("does nothing without an OffscreenCanvas", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { fake, scope, layer } = build();
    expect(layer.resize(100, 50)).toBe(false);
    layer.clear(0, 0, 10, 10);
    layer.flush();
    layer.quad(0, 0, 10, 10, 0, 0, 10, 10, 1);
    layer.draw(100, 50, new Float32Array(TEXT_PALETTE_FLOATS));
    expect(fake.draws()).toBe(0);
    scope.dispose();
    expect(fake.errors).toEqual([]);
  });

  it("uploads the whole canvas first, then only the cleared rects", () => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const { fake, scope, layer } = build();
    expect(layer.resize(100.4, 50)).toBe(true);
    expect([layer.width, layer.height]).toEqual([100, 50]);
    expect(layer.ctx).not.toBeNull();
    layer.clear(0, 0, 10, 10);
    layer.flush();
    expect(named(fake, "texSubImage2D")).toBe(0);
    const full = named(fake, "texImage2D");
    layer.clear(5, 5, 10, 10);
    layer.clear(200, 200, 10, 10);
    layer.flush();
    expect(named(fake, "texSubImage2D")).toBe(1);
    expect(named(fake, "texImage2D")).toBe(full);
    // An unchanged size keeps the canvas.
    expect(layer.resize(100, 50)).toBe(true);
    layer.flush();
    expect(named(fake, "texImage2D")).toBe(full);

    for (let i = 0; i < 6; i++) {
      layer.quad(0, 0, 10, 10, i * 10, 0, 10, 10, 1);
    }
    layer.quad(0, 0, 10, 10, 0, 0, 10, 10, 0);
    layer.draw(100, 50, new Float32Array(TEXT_PALETTE_FLOATS));
    expect(fake.draws()).toBe(1);
    layer.draw(100, 50, new Float32Array(TEXT_PALETTE_FLOATS));
    expect(fake.draws()).toBe(1);

    layer.release();
    expect(layer.ctx).toBeNull();
    scope.dispose();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("fills role text centred on whole pixels, skipping empty text and no width", () => {
    vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
    MeasuringCanvas.reset();
    const { scope, layer } = build();
    layer.fill("A", 10, 10, TEXT_ROLES.up, "12px x", 50);
    expect(layer.resize(100, 50)).toBe(true);
    layer.fill("", 10, 10, TEXT_ROLES.up, "12px x", 50);
    layer.fill("B", 10, 10, TEXT_ROLES.up, "12px x", 0);
    layer.fill("C", 10.4, 20.6, TEXT_ROLES.up, "12px x", 50, "right");
    const fills = MeasuringCanvas.calls.filter((c) => c.method === "fillText");
    expect(fills).toEqual([
      { method: "fillText", args: ["C", 10, 21, 50], font: "12px x", fillStyle: TEXT_ROLES.up },
    ]);
    expect(layer.ctx?.textAlign).toBe("right");
    expect(layer.ctx?.textBaseline).toBe("middle");
    scope.dispose();
  });
});
