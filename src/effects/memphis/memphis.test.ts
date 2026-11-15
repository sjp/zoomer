import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { memphis } from "./memphis";

/** A fake context that records each frame's instance uploads and clear colours. */
function recording() {
  const fake = createFakeGl();
  const uploads: number[][] = [];
  const indexUploads: number[] = [];
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
          if (args.some((a) => a instanceof Uint16Array)) {
            indexUploads.push(uploads.length);
          }
        }
        if (key === "clearColor") {
          clears.push(args as number[]);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { fake, gl, uploads, indexUploads, clears };
}

describe("corporate memphis", () => {
  it("draws identical frames over time at Motion 0", () => {
    const { fake, gl, uploads } = recording();
    const effect: EffectDefinition = memphis;
    const instance = effect.create(gl);
    const params = { ...defaults(effect.params), motion: 0 };
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 120; i++) {
      instance.frame(1 / 2, params);
    }
    // The first frame uploads the shapes, then the people's vertices; later
    // frames re-upload the same shapes and reuse the people's mesh.
    expect(uploads.length).toBe(121);
    expect(uploads[0].length).toBeGreaterThan(0);
    expect(uploads[1].length).toBeGreaterThan(0);
    uploads.forEach((u, i) => {
      expect(u).toEqual(uploads[i === 1 ? 1 : 0]);
    });
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("moves at Motion 1", () => {
    const { fake, gl, uploads, indexUploads } = recording();
    const effect: EffectDefinition = memphis;
    const instance = effect.create(gl);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    instance.frame(1 / 30, defaults(effect.params));
    instance.frame(1 / 30, defaults(effect.params));
    // The second frame's people (upload 3) moved from the first's (upload 1).
    expect(uploads[3]).not.toEqual(uploads[1]);
    // The same parts make the same triangles, so the indices went up once.
    expect(indexUploads).toEqual([2]);
    instance.dispose?.();
    expect(fake.live()).toEqual([]);
  });

  it("eases the background into a new palette", () => {
    const { fake, gl, clears } = recording();
    const effect: EffectDefinition = memphis;
    const instance = effect.create(gl);
    const params = defaults(effect.params);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    instance.frame(1 / 30, params);
    for (let i = 0; i < 60; i++) {
      instance.frame(1 / 30, { ...params, palette: "wellness" });
    }
    const first = clears[0];
    const mid = clears[18];
    const last = clears.at(-1) ?? [];
    expect(mid).not.toEqual(first);
    expect(mid).not.toEqual(last);
    expect(last).not.toEqual(first);
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("draws only the blobs, plants and mug with no people or props", () => {
    const { fake, gl, uploads } = recording();
    const effect: EffectDefinition = memphis;
    const instance = effect.create(gl);
    instance.resize({ width: 360, height: 640, scale: 640 / 1080 });
    instance.frame(1 / 30, { ...defaults(effect.params), people: 0, props: false });
    // Blobs, two plants and a mug, and no people.
    expect(uploads).toHaveLength(1);
    expect(uploads[0].length / 12).toBeLessThan(30);
    instance.dispose?.();
    expect(fake.live()).toEqual([]);
  });
});
