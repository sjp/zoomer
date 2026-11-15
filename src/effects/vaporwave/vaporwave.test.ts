import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl, type FakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { vaporwave } from "./vaporwave";

beforeEach(() => {
  MeasuringCanvas.reset(0.6);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Samples of storage each renderbuffer holds now, replayed from the recorded calls. */
function renderbufferSamples(fake: FakeGl): number[] {
  let bound: unknown = null;
  const samples = new Map<unknown, number>();
  for (const { name, args } of fake.calls) {
    if (name === "bindRenderbuffer") {
      bound = args[1];
    } else if (name === "renderbufferStorage") {
      samples.set(bound, Number(args[2]) * Number(args[3]));
    } else if (name === "renderbufferStorageMultisample") {
      samples.set(bound, Number(args[1]) * Number(args[3]) * Number(args[4]));
    }
  }
  return [...samples.values()].filter((n) => n > 0);
}

const liveTextures = (fake: FakeGl) => fake.live().filter((o) => o.kind === "Texture").length;

describe("vaporwave", () => {
  it.each([false, true])(
    "frees the faded-out look's bust layer and Lo-fi target (multisample %s)",
    (multisample) => {
      const fake = createFakeGl({ record: true, multisample });
      const effect: EffectDefinition = vaporwave;
      const instance = effect.create(fake.gl);
      const params = { ...defaults(effect.params), style: "clean" };
      instance.resize({ width: 1280, height: 720, scale: 720 / 1080 });
      const run = (style: string) => {
        for (let i = 0; i < 120; i++) {
          instance.frame(1 / 30, { ...params, style });
        }
      };
      run("clean");
      // One layer: multisampled colour + depth, or just a plain depth buffer.
      const clean = renderbufferSamples(fake);
      expect(clean).toHaveLength(multisample ? 2 : 1);
      const cleanTextures = liveTextures(fake);
      expect(fake.calls.some((c) => c.name === "blitFramebuffer")).toBe(multisample);

      run("lofi");
      // The clean layer is gone, the (smaller) Lo-fi one in its place.
      const lofi = renderbufferSamples(fake);
      expect(lofi).toHaveLength(clean.length);
      expect(Math.max(...lofi)).toBeLessThan(Math.max(...clean));

      run("clean");
      expect(renderbufferSamples(fake)).toEqual(clean);
      expect(liveTextures(fake)).toBe(cleanTextures);
      instance.dispose?.();
      expect(fake.errors).toEqual([]);
      expect(fake.live()).toEqual([]);
    },
  );
});
