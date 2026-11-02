import { describe, expect, it } from "vitest";
import { createSpriteBatch } from "./sprites";

/** A fake context that records every call as `[name, ...args]`; enums are their names. */
function fakeGl() {
  const calls: unknown[][] = [];
  const gl = new Proxy(
    {},
    {
      get(_, name: string) {
        if (/^[A-Z_0-9]+$/.test(name)) return name;
        return (...args: unknown[]) => {
          calls.push([name, ...args]);
          return {};
        };
      },
    },
  );
  return { gl: gl as WebGL2RenderingContext, calls };
}

const named = (calls: unknown[][], name: string) => calls.filter((c) => c[0] === name);

describe("createSpriteBatch", () => {
  it("clamps upload to maxInstances", () => {
    const { gl, calls } = fakeGl();
    const batch = createSpriteBatch(gl, 10, [2, 1]);
    calls.length = 0;
    batch.upload(25);
    const [sub] = named(calls, "bufferSubData");
    expect(sub[5]).toBe(10 * 3);
  });

  it("uploads nothing for a zero, negative or NaN count", () => {
    const { gl, calls } = fakeGl();
    const batch = createSpriteBatch(gl, 10, [4]);
    calls.length = 0;
    batch.upload(0);
    batch.upload(-3);
    batch.upload(NaN);
    expect(calls).toHaveLength(0);
  });

  it("clips draws to the instances that exist", () => {
    const { gl, calls } = fakeGl();
    const batch = createSpriteBatch(gl, 10, [4]);
    calls.length = 0;
    batch.draw(0, 50);
    batch.draw(6, 50);
    batch.draw(10, 5);
    batch.draw(3, 4);
    const draws = named(calls, "drawArraysInstanced").map((c) => c[4]);
    expect(draws).toEqual([10, 4, 4]);
  });
});
