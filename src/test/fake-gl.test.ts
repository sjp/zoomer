import { describe, expect, it } from "vitest";
import { createFakeGl } from "./fake-gl";

describe("createFakeGl", () => {
  it("reports uniform writes to a program that isn't bound", () => {
    const { gl, errors } = createFakeGl();
    const a = gl.createProgram();
    const b = gl.createProgram();
    const loc = gl.getUniformLocation(a, "uColor");
    gl.useProgram(a);
    gl.uniform1f(loc, 1);
    gl.uniform1f(null, 1);
    expect(errors).toEqual([]);
    gl.useProgram(b);
    gl.uniform3fv(loc, [1, 2, 3]);
    expect(errors).toEqual(["uniform3fv(uColor) belongs to program 1 but program 2 is bound"]);
  });

  it("tracks live objects and reports double deletes and use after delete", () => {
    const { gl, errors, live } = createFakeGl();
    const tex = gl.createTexture();
    const buf = gl.createBuffer();
    expect(live().map((o) => o.kind)).toEqual(["Texture", "Buffer"]);
    gl.deleteTexture(tex);
    gl.deleteTexture(null);
    expect(live().map((o) => o.kind)).toEqual(["Buffer"]);
    gl.deleteTexture(tex);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.deleteTexture(buf as unknown as WebGLTexture);
    expect(errors).toEqual([
      "deleteTexture: Texture 1 was already deleted",
      "bindTexture: Texture 1 was already deleted",
      "deleteTexture: expected a Texture, got [object Object]",
    ]);
  });

  it("unbinds deleted objects and reads state back through getParameter", () => {
    const { gl, state } = createFakeGl();
    const fb = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    expect(gl.getParameter(gl.FRAMEBUFFER_BINDING)).toBe(fb);
    expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBe(tex);
    expect(gl.getParameter(gl.ACTIVE_TEXTURE)).toBe(gl.TEXTURE0 + 3);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    expect(state.drawFramebuffer).toBeNull();
    expect(gl.getParameter(gl.TEXTURE_BINDING_2D)).toBeNull();

    gl.blendEquation(gl.FUNC_SUBTRACT);
    expect(state.blendEquationRgb).toBe("FUNC_SUBTRACT");
    gl.enable(gl.BLEND);
    expect(gl.isEnabled(gl.BLEND)).toBe(true);
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });

  it("completes framebuffers unless their format is unrenderable", () => {
    const { gl } = createFakeGl({ unrenderable: ["RGBA16F"] });
    const status = (format: number) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, 4, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    };
    expect(status(gl.RGBA8)).toBe(gl.FRAMEBUFFER_COMPLETE);
    expect(status(gl.RGBA16F)).not.toBe(gl.FRAMEBUFFER_COMPLETE);
  });

  it("fails the chosen shader compile", () => {
    const { gl } = createFakeGl({ failCompileAt: 1 });
    const results = [0, 1, 2].map(() => {
      const shader = gl.createShader(gl.VERTEX_SHADER)!;
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    });
    expect(results).toEqual([true, false, true]);
  });

  it("reports buffer writes past the end", () => {
    const { gl, errors } = createFakeGl();
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, 16, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(8), 0, 4);
    expect(errors).toEqual([]);
    gl.bufferSubData(gl.ARRAY_BUFFER, 4, new Float32Array(8), 0, 4);
    expect(errors).toEqual(["bufferSubData writes 16 bytes at 4 of 16"]);
  });

  it("records calls when asked", () => {
    const { gl, calls } = createFakeGl({ record: true });
    gl.clearColor(0, 0, 0, 1);
    expect(calls).toEqual([{ name: "clearColor", args: [0, 0, 0, 1] }]);
  });
});
