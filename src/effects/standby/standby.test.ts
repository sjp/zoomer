import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { standby } from "./standby";

/**
 * A fake context that tracks what each texture holds: the size of the canvas
 * last uploaded to it, or null for the one transparent texel of an empty one.
 */
function recording() {
  const fake = createFakeGl();
  const held = new Map<unknown, { width: number; height: number } | null>();
  let bound: unknown = null;
  const gl = new Proxy(fake.gl, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        if (key === "bindTexture") {
          bound = args[1];
        }
        if (key === "texImage2D") {
          const source = args.at(-1);
          held.set(bound, source instanceof MeasuringCanvas ? source : null);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  /** Textures holding a canvas. */
  const filled = () => [...held.values()].filter((v) => v !== null);
  return { fake, gl, filled };
}

const definition: EffectDefinition = standby;
const params = defaults(definition.params);

beforeEach(() => {
  MeasuringCanvas.reset(0.55);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("please stand by", () => {
  it.each(["analogue", "digital", "cartoon"])("draws %s cleanly and frees everything", (style) => {
    const { fake, gl, filled } = recording();
    const effect = definition.create(gl);
    effect.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 60; i++) {
      effect.frame(1 / 30, { ...params, style });
    }
    // Card, sign and parts for the one look shown.
    expect(filled().length).toBe(3);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("finishes a crossfade before starting the next, freeing each faded-out look", () => {
    const { fake, gl, filled } = recording();
    const effect = definition.create(gl);
    effect.resize({ width: 640, height: 360, scale: 1 / 3 });
    const counts: number[] = [];
    const run = (frames: number, style: string) => {
      for (let i = 0; i < frames; i++) {
        effect.frame(1 / 30, { ...params, style });
        counts.push(filled().length);
      }
    };
    run(10, "analogue");
    // Digital, then Cartoon half way through that fade.
    run(15, "digital");
    run(90, "cartoon");
    // Two looks at a time while fading, one once each fade ends: two fades in turn.
    const starts = counts.filter((n, i) => i > 0 && n > counts[i - 1]).length;
    expect(Math.max(...counts)).toBe(6);
    expect(starts).toBe(2);
    expect(counts.at(-1)).toBe(3);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("repaints both looks for a resize mid-fade, then frees the old one", () => {
    const { fake, gl, filled } = recording();
    const effect = definition.create(gl);
    effect.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 10; i++) {
      effect.frame(1 / 30, params);
    }
    for (let i = 0; i < 6; i++) {
      effect.frame(1 / 30, { ...params, style: "cartoon" });
    }
    effect.resize({ width: 480, height: 480, scale: 4 / 9 });
    // The size settles while the fade still runs: both cards go up at the new size.
    for (let i = 0; i < 12; i++) {
      effect.frame(1 / 30, { ...params, style: "cartoon" });
    }
    const cards = () => filled().filter((c) => c.width === 480 && c.height === 480).length;
    expect(filled().length).toBe(6);
    expect(cards()).toBe(2);
    for (let i = 0; i < 30; i++) {
      effect.frame(1 / 30, { ...params, style: "cartoon" });
    }
    expect(filled().length).toBe(3);
    expect(cards()).toBe(1);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });
});
