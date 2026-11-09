import { describe, expect, it } from "vitest";
import { createFeedbackPair, createPingPong } from "./gpu-sim";
import { createFakeGl } from "../test/fake-gl";
import { defined } from "../test/defined";

describe("createPingPong", () => {
  it("allocates on resize and swaps src and dst", () => {
    const fake = createFakeGl();
    const pair = createPingPong(fake.gl, fake.gl.RGBA8);
    expect(pair.ready).toBe(false);
    expect(() => pair.src).toThrow("before it was allocated");
    expect(pair.resize(8, 4)).toBe(true);
    expect([pair.ready, pair.width, pair.height]).toEqual([true, 8, 4]);
    const { src, dst } = pair;
    expect([src.width, src.height]).toEqual([8, 4]);
    expect(src).not.toBe(dst);
    pair.swap();
    expect([pair.src, pair.dst]).toEqual([dst, src]);
    pair.dispose();
    expect(pair.ready).toBe(false);
    expect(fake.live()).toEqual([]);
    expect(fake.errors).toEqual([]);
  });

  it("frees the old pair on resize, and leaves none if allocation fails", () => {
    const fake = createFakeGl({ unrenderable: ["RGBA16F"] });
    const pair = createPingPong(fake.gl, fake.gl.RGBA8);
    pair.resize(8, 4);
    pair.resize(16, 8);
    expect(fake.live()).toHaveLength(4);
    expect(pair.resize(2, 2, { format: fake.gl.RGBA16F })).toBe(false);
    expect([pair.ready, pair.width, pair.height]).toEqual([false, 2, 2]);
    expect(fake.live()).toEqual([]);
    // The format override sticks.
    expect(pair.resize(4, 4)).toBe(false);
    expect(pair.resize(4, 4, { format: fake.gl.RGBA8 })).toBe(true);
    pair.dispose();
    expect(fake.live()).toEqual([]);
  });

  it("carries the latest state across, and keeps the old pair if allocation fails", () => {
    const fake = createFakeGl({ unrenderable: ["RGBA16F"] });
    const pair = createPingPong(fake.gl, fake.gl.RGBA8);
    const carried: [number, number][] = [];
    const carry = (from: { width: number }, into: { width: number }) => {
      carried.push([from.width, into.width]);
    };
    pair.resize(8, 8, { carry });
    expect(carried).toEqual([]);
    pair.swap();
    const latest = pair.src;
    pair.resize(16, 16, {
      carry: (from, into) => {
        expect(from).toBe(latest);
        carry(from, into);
      },
    });
    expect(carried).toEqual([[8, 16]]);
    expect(pair.src.width).toBe(16);
    expect(fake.live()).toHaveLength(4);
    expect(pair.resize(32, 32, { format: fake.gl.RGBA16F, carry })).toBe(false);
    expect([pair.ready, pair.src.width, pair.width]).toEqual([true, 16, 32]);
    expect(carried).toHaveLength(1);
    pair.dispose();
    expect(fake.live()).toEqual([]);
  });
});

describe("createFeedbackPair", () => {
  it("steps from the current buffer into the other and swaps", () => {
    const fake = createFakeGl({ record: true });
    const { gl } = fake;
    const pair = createFeedbackPair(gl, 6, [
      { location: 0, size: 4 },
      { location: 1, size: 2, offset: 4 },
    ]);
    const pointers = fake.calls.filter((c) => c.name === "vertexAttribPointer");
    expect(pointers.map((c) => [c.args[0], c.args[1], c.args[4], c.args[5]])).toEqual([
      [0, 4, 24, 0],
      [1, 2, 24, 16],
      [0, 4, 24, 0],
      [1, 2, 24, 16],
    ]);
    pair.seed(new Float32Array(12));
    expect(pair.current).toBe(0);
    gl.useProgram(gl.createProgram());
    const vao0 = pair.vao;
    fake.calls.length = 0;
    pair.step(2);
    const names = fake.calls.map((c) => c.name);
    expect(names).toContain("beginTransformFeedback");
    expect(defined(fake.calls.find((c) => c.name === "drawArrays")).args.slice(1)).toEqual([0, 2]);
    expect(defined(fake.calls.find((c) => c.name === "bindBufferBase")).args[2]).toBe(
      pair.buffers[1],
    );
    expect(pair.current).toBe(1);
    expect(pair.vao).not.toBe(vao0);
    expect(fake.state.vertexArray).toBeNull();
    pair.step(2);
    expect(pair.current).toBe(0);
    pair.seed(new Float32Array(12));
    expect(pair.current).toBe(0);
    pair.dispose();
    expect(fake.live().map((o) => o.kind)).toEqual(["Program"]);
    expect(fake.errors).toEqual([]);
  });
});
