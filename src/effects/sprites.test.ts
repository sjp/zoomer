import { describe, expect, it } from "vitest";
import { createFakeGl } from "../test/fake-gl";
import { createSpriteBatch } from "./sprites";

const named = (calls: { name: string; args: unknown[] }[], name: string) =>
  calls.filter((c) => c.name === name).map((c) => c.args);

describe("createSpriteBatch", () => {
  it("clamps upload to maxInstances", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const batch = createSpriteBatch(gl, 10, [2, 1]);
    calls.length = 0;
    batch.upload(25);
    const [sub] = named(calls, "bufferSubData");
    expect(sub[4]).toBe(10 * 3);
  });

  it("uploads nothing for a zero, negative or NaN count", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const batch = createSpriteBatch(gl, 10, [4]);
    calls.length = 0;
    batch.upload(0);
    batch.upload(-3);
    batch.upload(NaN);
    expect(calls).toHaveLength(0);
  });

  it("clips draws to the instances that exist", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const batch = createSpriteBatch(gl, 10, [4]);
    calls.length = 0;
    batch.draw(0, 50);
    batch.draw(6, 50);
    batch.draw(10, 5);
    batch.draw(3, 4);
    const draws = named(calls, "drawArraysInstanced").map((c) => c[3]);
    expect(draws).toEqual([10, 4, 4]);
  });
});
