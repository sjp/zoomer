import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { INSTANCE_FLOATS, jazz } from "./jazz";

/** A fake context that records each frame's instance uploads and paper colours. */
function recording() {
  const fake = createFakeGl();
  const uploads: number[][] = [];
  const papers: number[][] = [];
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
        if (key === "uniform3f") {
          papers.push(args.slice(1) as number[]);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fake, gl, uploads, papers };
}

describe("90s jazz", () => {
  it.each([[{ speed: 0 }], [{ animation: "still" }]])("draws identical frames with %o", (p) => {
    const { fake, gl, uploads } = recording();
    const effect: EffectDefinition = jazz;
    const instance = effect.create(gl);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 120; i++) {
      instance.frame(1 / 2, { ...defaults(effect.params), ...p });
    }
    expect(uploads).toHaveLength(120);
    expect(uploads[0].length).toBeGreaterThan(20 * INSTANCE_FLOATS);
    for (const u of uploads) {
      expect(u).toEqual(uploads[0]);
    }
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("changes over time by default", () => {
    const { fake, gl, uploads } = recording();
    const effect: EffectDefinition = jazz;
    const instance = effect.create(gl);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 30 * 20; i++) {
      instance.frame(1 / 30, defaults(effect.params));
    }
    expect(uploads.at(-1)).not.toEqual(uploads[0]);
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("keeps drawing the pattern through a window drag and slider drags", () => {
    const { fake, gl, uploads } = recording();
    const effect: EffectDefinition = jazz;
    const instance = effect.create(gl);
    const params = defaults(effect.params);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 30 * 3; i++) {
      if (i < 30) {
        instance.resize({ width: 640 - 4 * i, height: 360, scale: 1 / 3 });
      }
      instance.frame(1 / 30, {
        ...params,
        seed: 1 + Math.min(i, 45),
        scale: 1 - Math.min(i, 30) / 60,
      });
    }
    expect(uploads).toHaveLength(30 * 3);
    for (const u of uploads) {
      expect(u.length).toBeGreaterThan(20 * INSTANCE_FLOATS);
    }
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("eases the paper into a new palette", () => {
    const { fake, gl, papers } = recording();
    const effect: EffectDefinition = jazz;
    const instance = effect.create(gl);
    const params = defaults(effect.params);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    instance.frame(1 / 30, params);
    for (let i = 0; i < 60; i++) {
      instance.frame(1 / 30, { ...params, palette: "neon" });
    }
    const first = papers[0];
    const mid = papers[15];
    const last = papers.at(-1) ?? [];
    expect(mid).not.toEqual(first);
    expect(mid).not.toEqual(last);
    expect(last[0]).toBeLessThan(0.1);
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("draws fewer instances with confetti, shapes and splatter off", () => {
    const { fake, gl, uploads } = recording();
    const effect: EffectDefinition = jazz;
    const instance = effect.create(gl);
    const params = { ...defaults(effect.params), animation: "still" };
    instance.resize({ width: 360, height: 640, scale: 640 / 1080 });
    instance.frame(1 / 30, params);
    const off = { ...params, confetti: false, shapes: false, splatter: false };
    for (let i = 0; i < 45; i++) {
      instance.frame(1 / 30, off);
    }
    expect(uploads.at(-1)?.length).toBeLessThan(uploads[0].length / 2);
    expect(uploads.at(-1)?.length).toBeGreaterThan(0);
    instance.dispose?.();
    expect(fake.live()).toEqual([]);
  });
});
