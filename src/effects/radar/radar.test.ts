import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { FakeOffscreenCanvas } from "../../test/offscreen-canvas";
import { defaults } from "../params";
import type { EffectWebGL2 } from "../types";
import { radar } from "./radar";

beforeAll(() => {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe("radar", () => {
  it("keeps no canvas-sized label texture after baking the map", () => {
    const fake = createFakeGl({ record: true });
    const effect: EffectWebGL2 = radar;
    const instance = effect.create(fake.gl);
    const params = defaults(effect.params);
    expect(params.region).not.toBe("world");
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    instance.frame(1 / 60, params);
    const uploads = fake.calls.filter((c) => c.name === "texImage2D");
    const labels = uploads.findIndex(
      (c) => c.args[5] instanceof FakeOffscreenCanvas && c.args[5].width === 640,
    );
    expect(labels).toBeGreaterThanOrEqual(0);
    // Shrunk back to one texel once the bake has read it.
    expect(uploads.slice(labels + 1).some((c) => c.args[3] === 1 && c.args[4] === 1)).toBe(true);
    instance.dispose?.();
  });
});
