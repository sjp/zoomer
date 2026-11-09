import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { FakeOffscreenCanvas } from "../../test/offscreen-canvas";
import { defaults } from "../params";
import type { EffectWebGL2 } from "../types";
import { noir } from "./noir";

beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** Clears of the drop map over `frames` frames at `rain`. */
function runRain(rain: number, frames: number) {
  const fake = createFakeGl({ record: true });
  const effect: EffectWebGL2 = noir;
  const instance = effect.create(fake.gl);
  instance.resize({ width: 640, height: 360, scale: 1 / 3 });
  const params = { ...defaults(effect.params), rain };
  fake.calls.length = 0;
  for (let i = 0; i < frames; i++) {
    instance.frame(1 / 60, params);
  }
  const clears = fake.calls.filter((c) => c.name === "clearBufferfv").length;
  instance.dispose?.();
  return clears;
}

describe("noir rain", () => {
  it("runs the drop pipeline only while there is rain", () => {
    expect(runRain(0.5, 5)).toBe(5);
    expect(runRain(0, 5)).toBe(0);
  });
});
