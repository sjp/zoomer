import { describe, expect, it, vi } from "vitest";
import { beginFrame, createScope, glslFloat, withScope } from "./gl";

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

describe("createScope", () => {
  it("runs cleanups in reverse order of registration", () => {
    const scope = createScope();
    const order: string[] = [];
    const a = scope.add("a", (r) => order.push(r));
    scope.own({ dispose: () => order.push("b") });
    scope.defer(() => order.push("c"));
    expect(a).toBe("a");
    scope.dispose();
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("is idempotent", () => {
    const scope = createScope();
    let count = 0;
    scope.defer(() => count++);
    scope.dispose();
    scope.dispose();
    expect(count).toBe(1);
  });

  it("runs every cleanup even if one throws, then rethrows the first error", () => {
    const scope = createScope();
    const order: string[] = [];
    scope.defer(() => order.push("a"));
    scope.defer(() => {
      throw new Error("first");
    });
    scope.defer(() => {
      throw new Error("second");
    });
    scope.defer(() => order.push("d"));
    expect(() => scope.dispose()).toThrow("second");
    expect(order).toEqual(["d", "a"]);
    expect(() => scope.dispose()).not.toThrow("has no GLSL literal");
  });
});

describe("withScope", () => {
  it("returns the result and leaves the scope to the caller on success", () => {
    let disposed = false;
    const result = withScope((scope) => {
      scope.defer(() => (disposed = true));
      return { dispose: () => scope.dispose() };
    });
    expect(disposed).toBe(false);
    result.dispose();
    expect(disposed).toBe(true);
  });

  it("disposes everything built so far and rethrows when build throws", () => {
    const order: string[] = [];
    const err = new Error("shader failed");
    expect(() =>
      withScope((scope) => {
        scope.add("triangle", (r) => order.push(r));
        scope.add("program", (r) => order.push(r));
        throw err;
      }),
    ).toThrow(err);
    expect(order).toEqual(["program", "triangle"]);
  });

  it("rethrows the build error even if a cleanup also throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("build");
    expect(() =>
      withScope((scope) => {
        scope.defer(() => {
          throw new Error("cleanup");
        });
        throw err;
      }),
    ).toThrow(err);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("glslFloat", () => {
  it("gives integers a decimal point", () => {
    expect(glslFloat(1)).toBe("1.0");
    expect(glslFloat(-3)).toBe("-3.0");
    expect(glslFloat(0)).toBe("0.0");
    expect(glslFloat(-0)).toBe("0.0");
  });

  it("keeps fractions at full precision", () => {
    expect(glslFloat(0.25)).toBe("0.25");
    expect(glslFloat(1 / 3)).toBe(String(1 / 3));
    expect(glslFloat(1e-7)).toBe("1e-7");
  });

  it("rejects values with no literal", () => {
    expect(() => glslFloat(Number.NaN)).toThrow("has no GLSL literal");
    expect(() => glslFloat(Number.POSITIVE_INFINITY)).toThrow("has no GLSL literal");
  });
});
