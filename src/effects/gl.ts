/**
 * Small WebGL2 helpers for full-screen fragment-shader effects: compile and link
 * with readable errors, a full-screen triangle, uniform lookup and data textures.
 */

/**
 * Vertex shader for `createFullscreenTriangle`. Passes `vUv` (0..1 across the
 * canvas, origin bottom-left). Use `gl_FragCoord` for pixel coordinates.
 */
export const FULLSCREEN_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * GLSL for `float dither8(vec2 fragCoord)`: a static, per-pixel offset of up to
 * +-0.5 LSB of an 8-bit channel (interleaved gradient noise, Jimenez 2014). Add it
 * to a colour just before the write, so wide, shallow gradients don't band into
 * visible strips at 4K. Interpolate it into a fragment shader after the precision
 * statement. ALU only, a few instructions per pixel.
 */
export const DITHER_GLSL = /* glsl */ `
float dither8(vec2 fragCoord) {
  return (fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
}
`;

/**
 * Formats a number as a GLSL float literal, for constants interpolated into shader
 * source: integers gain a ".0" (GLSL ES has no implicit int-to-float conversion),
 * other values use JavaScript's shortest round-trip form (exponents are valid GLSL).
 * Throws on NaN and infinities, which have no literal.
 */
export function glslFloat(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`glslFloat: ${n} has no GLSL literal`);
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * Resets the shared per-frame GL state to known defaults. Effects share one context,
 * and an effect that crashed or forgot a call may have left anything set, so every
 * `frame` calls this first and then sets only what it changes from here:
 *
 * - the default framebuffer bound, with a full-canvas viewport;
 * - depth, stencil, cull, scissor and blend tests all disabled;
 * - `blendEquation(FUNC_ADD)` and every colour channel writable;
 * - no vertex array bound.
 *
 * It leaves the program, textures, blend function and clear colour alone: effects
 * set those wherever they use them. Ten cheap state calls; negligible per frame.
 */
export function beginFrame(gl: WebGL2RenderingContext, width: number, height: number): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.colorMask(true, true, true, true);
  gl.bindVertexArray(null);
}

/**
 * Collects cleanup for the resources an effect (or helper) builds, so they can all
 * be released at once: on `dispose()`, or when a later step of `create` throws
 * (a shader that fails to compile, say). Effects share one long-lived context, so
 * anything a failed `create` leaves behind would otherwise leak.
 */
export interface Scope {
  /** Registers `dispose(resource)` and returns `resource`. */
  add<T>(resource: T, dispose: (resource: T) => void): T;
  /** Registers `resource.dispose()` and returns `resource`. */
  own<T extends { dispose(): void }>(resource: T): T;
  /**
   * Registers a cleanup callback, for resources that are replaced over time
   * (the callback reads the current one) or non-GL teardown.
   */
  defer(cleanup: () => void): void;
  /**
   * Runs every cleanup, most recent first, and forgets them, so a second call does
   * nothing. A cleanup that throws doesn't stop the rest; the first error is rethrown
   * once all have run.
   */
  dispose(): void;
}

export function createScope(): Scope {
  const cleanups: (() => void)[] = [];
  return {
    add(resource, dispose) {
      cleanups.push(() => dispose(resource));
      return resource;
    },
    own(resource) {
      cleanups.push(() => resource.dispose());
      return resource;
    },
    defer(cleanup) {
      cleanups.push(cleanup);
    },
    dispose() {
      let failed = false;
      let first: unknown;
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop()!;
        try {
          cleanup();
        } catch (err) {
          if (!failed) first = err;
          failed = true;
        }
      }
      if (failed) throw first;
    },
  };
}

/**
 * Runs `build` with a fresh scope and returns its result. If `build` throws, the
 * scope is disposed (releasing everything built so far) and the error rethrown.
 * On success the caller owns the scope, typically returning
 * `dispose: () => scope.dispose()` from it.
 */
export function withScope<T>(build: (scope: Scope) => T): T {
  const scope = createScope();
  try {
    return build(scope);
  } catch (err) {
    try {
      scope.dispose();
    } catch (cleanupErr) {
      console.error("WebGL: cleanup after a failed create also failed:", cleanupErr);
    }
    throw err;
  }
}

/** Prefixes each source line with its number, so log line references are easy to find. */
const numbered = (source: string) =>
  source
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)}: ${line}`)
    .join("\n");

export function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL: could not create shader (is the context lost?)");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(`WebGL: ${kind} shader failed to compile:\n${log}\n${numbered(source)}`);
  }
  return shader;
}

/** Compiles and links a program. Throws with the shader or link log on failure. */
export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  let fs: WebGLShader;
  try {
    fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  } catch (err) {
    gl.deleteShader(vs);
    throw err;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders can be flagged for deletion once linked; the program keeps them alive.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`WebGL: program failed to link:\n${log}`);
  }
  return program;
}

/**
 * Looks up uniform locations by name. Locations are null for uniforms the compiler
 * optimised away; `gl.uniform*` ignores null, so callers need not check.
 */
export function getUniforms<const N extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly N[],
): Record<N, WebGLUniformLocation | null> {
  const out = {} as Record<N, WebGLUniformLocation | null>;
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}

export interface FullscreenTriangle {
  /** Binds the triangle's vertex array and draws it. */
  draw(): void;
  dispose(): void;
}

/**
 * One oversized triangle covering clip space, fed to attribute location 0
 * (`aPosition` in `FULLSCREEN_VERTEX`). Unlike a two-triangle quad it has no
 * diagonal seam, where fragments would be shaded twice.
 */
export function createFullscreenTriangle(gl: WebGL2RenderingContext): FullscreenTriangle {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return {
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    dispose() {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(buffer);
    },
  };
}

export interface DataTextureOptions {
  width: number;
  height: number;
  /** Sized internal format, e.g. `gl.R16F` or `gl.RGBA8`. */
  internalFormat: GLenum;
  /** Pixel format of `data`, e.g. `gl.RED` or `gl.RGBA`. */
  format: GLenum;
  /** Component type of `data`, e.g. `gl.FLOAT` or `gl.UNSIGNED_BYTE`. */
  type: GLenum;
  data: ArrayBufferView;
  /** Defaults to `gl.CLAMP_TO_EDGE`. */
  wrap?: GLenum;
  /** Defaults to `gl.LINEAR`. No mipmaps are generated. */
  filter?: GLenum;
}

/**
 * Resets the pixel-unpack state that texture uploads read, so a tightly packed
 * typed array (or canvas) uploads as-is. Effects share one context, so any of this
 * may have been changed by another effect: a bound `PIXEL_UNPACK_BUFFER` makes
 * typed-array uploads fail with INVALID_OPERATION, `UNPACK_FLIP_Y_WEBGL` flips
 * rows, and the row-length / skip settings offset or stride the source data.
 * Call before every `texImage2D` / `texSubImage2D` that isn't via `createDataTexture`
 * (which calls it itself). A handful of cheap state calls; fine per frame.
 */
export function resetUnpackState(gl: WebGL2RenderingContext): void {
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // Alignment 1 accepts any tightly packed row, whatever its byte width.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
}

/**
 * Uploads a 2D texture from typed-array data. Row 0 of `data` is at t = 0. Resets
 * the unpack state first (see `resetUnpackState`). Note that
 * in WebGL2 32-bit float formats are not filterable without an extension; prefer
 * `R16F`/`RGBA16F` (which accept `FLOAT` data) when you need linear filtering.
 */
export function createDataTexture(gl: WebGL2RenderingContext, o: DataTextureOptions): WebGLTexture {
  const tex = gl.createTexture();
  const wrap = o.wrap ?? gl.CLAMP_TO_EDGE;
  const filter = o.filter ?? gl.LINEAR;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  resetUnpackState(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, o.internalFormat, o.width, o.height, 0, o.format, o.type, o.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
