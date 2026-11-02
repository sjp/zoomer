import { describe, expect, it, vi } from "vitest";
import {
  beginFrame,
  columnTableFormat,
  createColumnTable,
  createRenderTarget,
  createScope,
  glslFloat,
  withScope,
} from "./gl";

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

/** A fake context that records every call by name, for the texture helpers. */
function recordingGl(overrides: Record<string, unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const enums: Record<string, number> = {
    TEXTURE_2D: 1,
    FLOAT: 2,
    R16F: 10,
    RG16F: 11,
    RGBA16F: 12,
    RED: 20,
    RG: 21,
    RGBA: 22,
    CLAMP_TO_EDGE: 30,
    REPEAT: 31,
    LINEAR: 40,
  };
  const texture = { id: "tex" };
  const gl = new Proxy(enums, {
    get(target, key: string) {
      if (key in overrides) return overrides[key];
      if (key in target) return target[key];
      if (key === "createTexture") return () => texture;
      // Any other enum the helpers read (unpack state and so on) is just a number.
      if (/^[A-Z0-9_]+$/.test(key)) return 0;
      return (...args: unknown[]) => calls.push({ name: key, args });
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, calls, enums, texture };
}

describe("columnTableFormat", () => {
  it("picks a filterable half-float format per channel count", () => {
    const { gl, enums } = recordingGl();
    expect(columnTableFormat(gl, 1)).toEqual({ internalFormat: enums.R16F, format: enums.RED });
    expect(columnTableFormat(gl, 2)).toEqual({ internalFormat: enums.RG16F, format: enums.RG });
    expect(columnTableFormat(gl, 4)).toEqual({
      internalFormat: enums.RGBA16F,
      format: enums.RGBA,
    });
  });
});

describe("createColumnTable", () => {
  it("allocates columns x rows x channels floats and uploads them whole", () => {
    const { gl, calls, enums, texture } = recordingGl();
    const table = createColumnTable(gl, 8, 4, { rows: 2 });
    expect(table.data.length).toBe(64);
    const image = calls.find((c) => c.name === "texImage2D")!;
    expect(image.args.slice(2, 8)).toEqual([enums.RGBA16F, 8, 2, 0, enums.RGBA, enums.FLOAT]);

    calls.length = 0;
    table.upload();
    expect(calls[0]).toEqual({ name: "bindTexture", args: [enums.TEXTURE_2D, texture] });
    const sub = calls.find((c) => c.name === "texSubImage2D")!;
    expect(sub.args).toEqual([
      enums.TEXTURE_2D,
      0,
      0,
      0,
      8,
      2,
      enums.RGBA,
      enums.FLOAT,
      table.data,
    ]);
    // Left bound, ready to draw with.
    expect(calls.some((c) => c.name === "bindTexture" && c.args[1] === null)).toBe(false);
  });

  it("keeps given data and wrap mode", () => {
    const { gl, calls, enums } = recordingGl();
    const data = new Float32Array(6);
    const table = createColumnTable(gl, 3, 2, { data, wrap: enums.REPEAT });
    expect(table.data).toBe(data);
    expect(calls).toContainEqual({
      name: "texParameteri",
      args: [enums.TEXTURE_2D, 0, enums.REPEAT],
    });
  });

  it("rejects data of the wrong length", () => {
    const { gl } = recordingGl();
    expect(() => createColumnTable(gl, 3, 2, { data: new Float32Array(5) })).toThrow(
      "needs 6 floats",
    );
  });
});

describe("createRenderTarget", () => {
  const COMPLETE = 0x8cd5;
  const fbo = { id: "fbo" };
  const make = (status: number, lost = false) =>
    recordingGl({
      FRAMEBUFFER_COMPLETE: COMPLETE,
      createFramebuffer: () => fbo,
      checkFramebufferStatus: () => status,
      isContextLost: () => lost,
    });

  it("returns a cleared target of the requested size when complete", () => {
    const { gl, calls, texture } = make(COMPLETE);
    const t = createRenderTarget(gl, 64, 32, 7)!;
    expect(t).not.toBeNull();
    expect([t.width, t.height, t.texture, t.framebuffer]).toEqual([64, 32, texture, fbo]);
    expect(calls.find((c) => c.name === "texStorage2D")!.args.slice(1)).toEqual([1, 7, 64, 32]);
    expect(calls.some((c) => c.name === "clear")).toBe(true);
    // Leaves the default framebuffer bound.
    expect(calls.findLast((c) => c.name === "bindFramebuffer")!.args[1]).toBeNull();

    calls.length = 0;
    t.dispose();
    expect(calls.map((c) => c.name).sort()).toEqual(["deleteFramebuffer", "deleteTexture"]);
  });

  it("deletes everything and returns null when the format isn't renderable", () => {
    const { gl, calls } = make(0);
    expect(createRenderTarget(gl, 4, 4, 7)).toBeNull();
    expect(calls.some((c) => c.name === "deleteTexture")).toBe(true);
    expect(calls.some((c) => c.name === "deleteFramebuffer")).toBe(true);
    expect(calls.some((c) => c.name === "clear")).toBe(false);
  });

  it("doesn't blame the format for a lost context", () => {
    const { gl } = make(0, true);
    expect(createRenderTarget(gl, 4, 4, 7)).not.toBeNull();
  });
});
