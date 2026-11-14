import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { bluescreen } from "./bluescreen";

/** Floats per sprite: rect, uv rect, tint and opacity. */
const STRIDE = 12;
const ALPHA = 11;

/** A fake context that records each frame's sprite uploads and clear colours. */
function recording() {
  const fake = createFakeGl();
  const uploads: number[][] = [];
  const clears: number[][] = [];
  const gl = new Proxy(fake.gl, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        if (key === "bufferSubData") {
          const data = args.find((a) => a instanceof Float32Array);
          const count = args.at(-1);
          if (data && typeof count === "number") {
            uploads.push(Array.from(data.subarray(0, count)));
          }
        }
        if (key === "clearColor") {
          clears.push(args as number[]);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fake, gl, uploads, clears };
}

const effect: EffectDefinition = bluescreen;

beforeEach(() => {
  MeasuringCanvas.reset(0.55);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("blue screen", () => {
  it.each(["modern", "classic", "kernel"])("draws %s cleanly and frees everything", (style) => {
    const { fake, gl } = recording();
    const instance = effect.create(gl);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 90; i++) {
      instance.frame(1 / 30, { ...defaults(effect.params), style, speed: 3 });
    }
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("draws the same frame over and over at speed 0 in Modern", () => {
    const { fake, gl, uploads } = recording();
    const instance = effect.create(gl);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 60; i++) {
      instance.frame(1 / 2, { ...defaults(effect.params), speed: 0 });
    }
    for (const u of uploads) {
      expect(u).toEqual(uploads[0]);
    }
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("crossfades the background into a new style", () => {
    const { fake, gl, clears } = recording();
    const instance = effect.create(gl);
    const params = defaults(effect.params);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    instance.frame(1 / 30, params);
    for (let i = 0; i < 45; i++) {
      instance.frame(1 / 30, { ...params, style: "kernel" });
    }
    const first = clears[0];
    const mid = clears[15];
    const last = clears.at(-1) ?? [];
    expect(mid).not.toEqual(first);
    expect(mid).not.toEqual(last);
    expect(last).toEqual([0, 0, 0, 1]);
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("crossfades the count back down at a restart, never cutting or blanking it", () => {
    const { fake, gl, uploads } = recording();
    const instance = effect.create(gl);
    const params = { ...defaults(effect.params), speed: 3 };
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    const shown: number[] = [];
    let percent = -1;
    for (let i = 0; i < 12000; i++) {
      MeasuringCanvas.calls = [];
      instance.frame(1 / 10, params);
      const painted = MeasuringCanvas.calls.find(
        (c) => c.method === "fillText" && String(c.args[0]).endsWith("% complete"),
      );
      if (painted) {
        percent = Number.parseInt(String(painted.args[0]), 10);
      }
      shown.push(percent);
    }
    expect(Math.max(...shown)).toBe(99);
    const restart = shown.findIndex((p, i) => i > 0 && p < shown[i - 1]);
    expect(restart).toBeGreaterThan(0);
    // The old count stays while the new one fades in over a second.
    const old = (f: number) => uploads[f][STRIDE + ALPHA];
    const incoming = (f: number) => uploads[f][2 * STRIDE + ALPHA];
    expect(incoming(restart)).toBe(0);
    for (let f = restart + 1; f < restart + 5; f++) {
      expect(incoming(f)).toBeGreaterThan(incoming(f - 1));
      expect(incoming(f)).toBeLessThan(1);
      expect(old(f)).toBe(1);
    }
    // Some count line is always visible.
    for (const u of uploads) {
      expect(Math.max(u[STRIDE + ALPHA], u[2 * STRIDE + ALPHA])).toBeGreaterThan(0.99);
    }
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("steps the kernel log up a line smoothly when a line arrives", () => {
    const { fake, gl, uploads } = recording();
    const instance = effect.create(gl);
    const params = { ...defaults(effect.params), style: "kernel", speed: 3 };
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 600; i++) {
      instance.frame(1 / 30, params);
    }
    // The log sprite's top texture coordinate.
    const v0 = uploads.map((u) => u[3 * STRIDE + 5]);
    const jumps = v0.map((v, i) => (i === 0 ? 0 : v - v0[i - 1]));
    // Lines arrived (each resets the step to the top) ...
    expect(jumps.filter((j) => j < 0).length).toBeGreaterThan(0);
    // ... and every step up moves in small eased increments.
    const lineV = Math.max(...v0);
    for (const j of jumps.filter((d) => d > 0)) {
      expect(j).toBeLessThan(lineV * 0.2);
    }
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("blinks the cursor softly in Classic", () => {
    const { fake, gl, uploads } = recording();
    const instance = effect.create(gl);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 120; i++) {
      instance.frame(1 / 60, { ...defaults(effect.params), style: "classic" });
    }
    const alpha = uploads.map((u) => u[4 * STRIDE + ALPHA]);
    expect(Math.min(...alpha)).toBeLessThan(0.05);
    expect(Math.max(...alpha)).toBeGreaterThan(0.95);
    for (let i = 1; i < alpha.length; i++) {
      expect(Math.abs(alpha[i] - alpha[i - 1])).toBeLessThan(0.2);
    }
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
  });
});
