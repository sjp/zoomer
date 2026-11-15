import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { suchwow } from "./suchwow";

const definition: EffectDefinition = suchwow;
const params = defaults(definition.params);

beforeEach(() => {
  MeasuringCanvas.reset(0.55);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("such background", () => {
  it("repaints the phrases a couple a frame after a resize, not all at once", () => {
    const fake = createFakeGl();
    const effect = definition.create(fake.gl);
    effect.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 30 * 20; i++) {
      effect.frame(1 / 30, { ...params, motion: 0 });
    }
    effect.resize({ width: 960, height: 540, scale: 1 / 2 });
    const painted: number[] = [];
    for (let i = 0; i < 60; i++) {
      const before = MeasuringCanvas.made.length;
      effect.frame(1 / 30, { ...params, motion: 0 });
      painted.push(MeasuringCanvas.made.length - before);
    }
    const total = painted.reduce((a, b) => a + b, 0);
    // Every shown phrase is repainted at the new size, two at most a frame.
    expect(total).toBeGreaterThan(4);
    expect(Math.max(...painted)).toBeLessThanOrEqual(2);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });
});
