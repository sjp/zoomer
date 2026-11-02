import { describe, expect, it } from "vitest";
import { beginFrame } from "./gl";

const ENUMS = {
  FRAMEBUFFER: 0x8d40,
  DEPTH_TEST: 0x0b71,
  STENCIL_TEST: 0x0b90,
  CULL_FACE: 0x0b44,
  SCISSOR_TEST: 0x0c11,
  BLEND: 0x0be2,
  FUNC_ADD: 0x8006,
} as const;

/** A fake context that applies the state calls `beginFrame` makes to a state object. */
function fakeGl() {
  const state = {
    framebuffer: {} as object | null,
    viewport: [0, 0, 0, 0],
    enabled: new Set<number>([
      ENUMS.DEPTH_TEST,
      ENUMS.STENCIL_TEST,
      ENUMS.CULL_FACE,
      ENUMS.SCISSOR_TEST,
      ENUMS.BLEND,
    ]),
    blendEquation: 0x800b, // FUNC_REVERSE_SUBTRACT
    colorMask: [false, true, false, true],
    vertexArray: {} as object | null,
  };
  const gl = {
    ...ENUMS,
    bindFramebuffer: (target: number, fb: object | null) => {
      expect(target).toBe(ENUMS.FRAMEBUFFER);
      state.framebuffer = fb;
    },
    viewport: (x: number, y: number, w: number, h: number) => {
      state.viewport = [x, y, w, h];
    },
    enable: (cap: number) => state.enabled.add(cap),
    disable: (cap: number) => state.enabled.delete(cap),
    blendEquation: (mode: number) => {
      state.blendEquation = mode;
    },
    colorMask: (r: boolean, g: boolean, b: boolean, a: boolean) => {
      state.colorMask = [r, g, b, a];
    },
    bindVertexArray: (vao: object | null) => {
      state.vertexArray = vao;
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, state };
}

describe("beginFrame", () => {
  it("resets everything a crashed or careless effect could leave set", () => {
    const { gl, state } = fakeGl();
    beginFrame(gl, 3840, 2160);
    expect(state.framebuffer).toBeNull();
    expect(state.viewport).toEqual([0, 0, 3840, 2160]);
    expect([...state.enabled]).toEqual([]);
    expect(state.blendEquation).toBe(ENUMS.FUNC_ADD);
    expect(state.colorMask).toEqual([true, true, true, true]);
    expect(state.vertexArray).toBeNull();
  });
});
