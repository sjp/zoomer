import { describe, expect, it, vi } from "vitest";
import {
  beginFrame,
  columnTableFormat,
  createColumnTable,
  createRenderTarget,
  createScope,
  createUniforms,
  glslFloat,
  withScope,
} from "./gl";
import { createFakeGl } from "../test/fake-gl";

describe("beginFrame", () => {
  it("resets everything a crashed or careless effect could leave set", () => {
    const { gl, state } = createFakeGl();
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    for (const cap of [gl.DEPTH_TEST, gl.STENCIL_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.BLEND]) {
      gl.enable(cap);
    }
    gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
    gl.colorMask(false, true, false, true);
    gl.bindVertexArray(gl.createVertexArray());
    beginFrame(gl, 3840, 2160);
    expect(state.drawFramebuffer).toBeNull();
    expect(state.readFramebuffer).toBeNull();
    expect(state.viewport).toEqual([0, 0, 3840, 2160]);
    expect([...state.enabled]).toEqual([]);
    expect(state.blendEquationRgb).toBe("FUNC_ADD");
    expect(state.blendEquationAlpha).toBe("FUNC_ADD");
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
      // Bindings read back as null; the arrays as empty.
      getParameter: (k: unknown) => (/BINDING/.test(String(k)) ? null : []),
      FRAMEBUFFER_BINDING: "FRAMEBUFFER_BINDING",
      TEXTURE_BINDING_2D: "TEXTURE_BINDING_2D",
    });

  it("returns a cleared target of the requested size when complete", () => {
    const { gl, calls, texture } = make(COMPLETE);
    const t = createRenderTarget(gl, 64, 32, 7)!;
    expect(t).not.toBeNull();
    expect([t.width, t.height, t.texture, t.framebuffer]).toEqual([64, 32, texture, fbo]);
    expect(calls.find((c) => c.name === "texStorage2D")!.args.slice(1)).toEqual([1, 7, 64, 32]);
    expect(calls.some((c) => c.name === "clear")).toBe(true);
    // Restores the framebuffer that was bound before: the default one here.
    expect(calls.findLast((c) => c.name === "bindFramebuffer")!.args[1]).toBeNull();

    calls.length = 0;
    t.dispose();
    expect(calls.map((c) => c.name).sort()).toEqual(["deleteFramebuffer", "deleteTexture"]);
  });

  it("restores the state it changes, so it can run mid-frame", () => {
    const { gl, state, errors, live } = createFakeGl();
    const prevFbo = gl.createFramebuffer();
    const prevTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(1, 2, 300, 200);
    gl.clearColor(0.25, 0.5, 0.75, 1);
    gl.colorMask(true, false, true, false);
    gl.enable(gl.SCISSOR_TEST);
    const t = createRenderTarget(gl, 64, 32, gl.RGBA8)!;
    expect(t).not.toBeNull();
    expect(state.drawFramebuffer).toBe(prevFbo);
    expect(state.textures.get(0)).toBe(prevTex);
    expect(state.viewport).toEqual([1, 2, 300, 200]);
    expect(state.clearColor).toEqual([0.25, 0.5, 0.75, 1]);
    expect(state.colorMask).toEqual([true, false, true, false]);
    expect(state.enabled.has("SCISSOR_TEST")).toBe(true);
    t.dispose();
    expect(live()).toEqual([prevFbo, prevTex]);
    expect(errors).toEqual([]);
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

describe("createUniforms", () => {
  const CURRENT_PROGRAM = 0x8b8d;
  const program = { id: "program" };
  const other = { id: "other" };

  /** A fake context that records uniform uploads and tracks the bound program. */
  function uniformGl() {
    const calls: unknown[][] = [];
    let current: object | null = null;
    let lost = false;
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push([name, ...args]);
    const gl = {
      CURRENT_PROGRAM,
      getUniformLocation: (_p: object, name: string) => (name === "uGone" ? null : { name }),
      useProgram: (p: object | null) => (current = p),
      getParameter: (pname: number) => (pname === CURRENT_PROGRAM && !lost ? current : null),
      isContextLost: () => lost,
      uniform1f: record("1f"),
      uniform2f: record("2f"),
      uniform3f: record("3f"),
      uniform4f: record("4f"),
      uniform1i: record("1i"),
      uniform1ui: record("1ui"),
    };
    const loseContext = () => (lost = true);
    return { gl: gl as unknown as WebGL2RenderingContext, calls, loseContext };
  }

  const NAMES = ["uA", "uB", "uC", "uD", "uI", "uU", "uGone"] as const;

  it("uploads each value once, until it changes", () => {
    const { gl, calls } = uniformGl();
    const u = createUniforms(gl, program, NAMES);
    gl.useProgram(program);
    for (let i = 0; i < 3; i++) {
      u.f1("uA", 1);
      u.f2("uB", 2, 3);
      u.f3("uC", 4, 5, 6);
      u.f4("uD", 7, 8, 9, 10);
      u.i1("uI", 2);
      u.u1("uU", 3);
    }
    expect(calls).toEqual([
      ["1f", { name: "uA" }, 1],
      ["2f", { name: "uB" }, 2, 3],
      ["3f", { name: "uC" }, 4, 5, 6],
      ["4f", { name: "uD" }, 7, 8, 9, 10],
      ["1i", { name: "uI" }, 2],
      ["1ui", { name: "uU" }, 3],
    ]);

    calls.length = 0;
    expect(u.f2("uB", 2, 4)).toBe(true);
    expect(u.f4("uD", 7, 8, 9, 11)).toBe(true);
    expect(u.f1("uA", 1)).toBe(false);
    expect(calls).toEqual([
      ["2f", { name: "uB" }, 2, 4],
      ["4f", { name: "uD" }, 7, 8, 9, 11],
    ]);
  });

  it("compares values as given, not rounded to float32", () => {
    const { gl, calls } = uniformGl();
    const u = createUniforms(gl, program, NAMES);
    gl.useProgram(program);
    u.f1("uA", 0.1);
    u.f1("uA", 0.1 + 1e-12);
    expect(calls).toHaveLength(2);
  });

  it("sets vec3s from arrays and parses each distinct hex colour once", () => {
    const { gl, calls } = uniformGl();
    const u = createUniforms(gl, program, NAMES);
    gl.useProgram(program);
    u.v3("uC", [0.5, 0.25, 1]);
    u.v3("uC", new Float32Array([0.5, 0.25, 1]));
    expect(u.rgb("uB", "#ff0000")).toBe(true);
    expect(u.rgb("uB", "#ff0000")).toBe(false);
    // The same colour spelled differently parses again but uploads nothing.
    expect(u.rgb("uB", "#FF0000")).toBe(false);
    expect(calls).toEqual([
      ["3f", { name: "uC" }, 0.5, 0.25, 1],
      ["3f", { name: "uB" }, 1, 0, 0],
    ]);

    // A numeric set in between invalidates the remembered hex.
    calls.length = 0;
    u.f3("uB", 0, 0, 0);
    u.rgb("uB", "#FF0000");
    expect(calls).toEqual([
      ["3f", { name: "uB" }, 0, 0, 0],
      ["3f", { name: "uB" }, 1, 0, 0],
    ]);
  });

  it("passes null locations through for uniforms the compiler removed", () => {
    const { gl, calls } = uniformGl();
    const u = createUniforms(gl, program, NAMES);
    gl.useProgram(program);
    expect(u.loc.uGone).toBeNull();
    u.f1("uGone", 1);
    expect(calls).toEqual([["1f", null, 1]]);
  });

  it("asserts in dev builds that its program is bound when uploading", () => {
    expect(import.meta.env.DEV).toBe(true);
    const { gl, calls } = uniformGl();
    const u = createUniforms(gl, program, NAMES);
    gl.useProgram(program);
    u.f1("uA", 1);
    gl.useProgram(other);
    // Unchanged: nothing is written, so nothing can go to the wrong program.
    expect(() => u.f1("uA", 1)).not.toThrow();
    expect(() => u.f1("uA", 2)).toThrow("uA set while another program is bound");
    expect(calls).toHaveLength(1);
    // The rejected value wasn't cached, so it uploads once the program is bound.
    gl.useProgram(program);
    u.f1("uA", 2);
    expect(calls).toHaveLength(2);
  });

  it("doesn't assert on a lost context, where the bound program reads as null", () => {
    const { gl, loseContext } = uniformGl();
    const u = createUniforms(gl, program, NAMES);
    gl.useProgram(program);
    loseContext();
    expect(() => u.f1("uA", 1)).not.toThrow();
  });
});
