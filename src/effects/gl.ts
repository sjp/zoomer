/**
 * Small WebGL2 helpers shared by the effects: per-frame state reset, exception-safe
 * resource scopes, compile and link with readable errors, uniform lookup, a
 * full-screen triangle and gradient background, shared GLSL snippets, and data
 * textures, lookup tables and render targets.
 */
import { hexToUnitRgb, type Rgb } from "./color";

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
 * GLSL for `vec4 pxToClip(vec2 px, vec2 resolution)`: a position in device pixels
 * (origin at the top-left, y down, as on a 2D canvas) to clip space, for vertex
 * shaders that place geometry in canvas pixels.
 */
export const TO_CLIP_GLSL = /* glsl */ `
vec4 pxToClip(vec2 px, vec2 resolution) {
  return vec4(px.x / resolution.x * 2.0 - 1.0, 1.0 - px.y / resolution.y * 2.0, 0.0, 1.0);
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

/**
 * A program's uniforms, each remembering the last value sent, so a setter called
 * every frame with an unchanged value costs a few comparisons and no GL call.
 * Setters return whether they uploaded, for effects that redo work on a change.
 * Uniforms are per-program state, and each effect owns its programs, so the cache
 * stays valid. Call the setters with the program bound: dev builds assert that
 * it is whenever a value is actually uploaded.
 *
 * Use one kind of setter per uniform. `loc` is for arrays and matrices, which
 * are uploaded directly (and so are not tracked).
 */
export interface Uniforms<N extends string> {
  readonly program: WebGLProgram;
  readonly loc: Readonly<Record<N, WebGLUniformLocation | null>>;
  f1(name: N, x: number): boolean;
  f2(name: N, x: number, y: number): boolean;
  f3(name: N, x: number, y: number, z: number): boolean;
  f4(name: N, x: number, y: number, z: number, w: number): boolean;
  /** A `vec3` from the first three entries of `v`, e.g. an `Rgb`. */
  v3(name: N, v: ArrayLike<number>): boolean;
  /** A `vec3` colour (0..1) from a hex string, parsed once per distinct string. */
  rgb(name: N, hex: string): boolean;
  /** An `int`, `bool` or sampler unit. */
  i1(name: N, x: number): boolean;
  /** A `uint`. */
  u1(name: N, x: number): boolean;
}

/**
 * Looks up `names` in `program` and wraps them in change-tracked setters (see
 * `Uniforms`). Values are compared as given, not rounded to float32. Allocates
 * nothing per call, except when `rgb` parses a new colour string.
 */
export function createUniforms<const N extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly N[],
): Uniforms<N> {
  const loc = getUniforms(gl, program, names);
  const index = {} as Record<N, number>;
  names.forEach((name, i) => (index[name] = i));
  /** Four values per uniform; NaN never compares equal, so the first set always uploads. */
  const last = new Float64Array(names.length * 4).fill(Number.NaN);
  const lastHex: (string | undefined)[] = names.map(() => undefined);

  /**
   * Records the value and returns true if it changed (unused components are 0),
   * meaning the caller should upload it.
   */
  function changed(name: N, x: number, y: number, z: number, w: number): boolean {
    const i = index[name];
    const o = i * 4;
    if (last[o] === x && last[o + 1] === y && last[o + 2] === z && last[o + 3] === w) return false;
    if (
      import.meta.env.DEV &&
      gl.getParameter(gl.CURRENT_PROGRAM) !== program &&
      !gl.isContextLost()
    ) {
      throw new Error(`createUniforms: ${name} set while another program is bound`);
    }
    last[o] = x;
    last[o + 1] = y;
    last[o + 2] = z;
    last[o + 3] = w;
    lastHex[i] = undefined;
    return true;
  }

  const f3 = (name: N, x: number, y: number, z: number) => {
    if (!changed(name, x, y, z, 0)) return false;
    gl.uniform3f(loc[name], x, y, z);
    return true;
  };
  return {
    program,
    loc,
    f1(name, x) {
      if (!changed(name, x, 0, 0, 0)) return false;
      gl.uniform1f(loc[name], x);
      return true;
    },
    f2(name, x, y) {
      if (!changed(name, x, y, 0, 0)) return false;
      gl.uniform2f(loc[name], x, y);
      return true;
    },
    f3,
    f4(name, x, y, z, w) {
      if (!changed(name, x, y, z, w)) return false;
      gl.uniform4f(loc[name], x, y, z, w);
      return true;
    },
    v3: (name, v) => f3(name, v[0], v[1], v[2]),
    rgb(name, hex) {
      const i = index[name];
      if (lastHex[i] === hex) return false;
      const [r, g, b] = hexToUnitRgb(hex);
      const uploaded = f3(name, r, g, b);
      lastHex[i] = hex;
      return uploaded;
    },
    i1(name, x) {
      if (!changed(name, x, 0, 0, 0)) return false;
      gl.uniform1i(loc[name], x);
      return true;
    },
    u1(name, x) {
      if (!changed(name, x, 0, 0, 0)) return false;
      gl.uniform1ui(loc[name], x);
      return true;
    },
  };
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

const GRADIENT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec3 c = mix(uTop, uBottom, 1.0 - vUv.y);
  // Sub-LSB dither (interleaved gradient noise, static per pixel): dark, shallow
  // gradients otherwise band into strips tens of pixels tall at 4K.
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

export interface GradientBackground {
  /**
   * Fills the viewport, top to bottom, with blending disabled and sub-LSB dither.
   * Colours are 0..1. When top and bottom are equal it clears instead, which
   * ignores the viewport: the viewport must cover the bound framebuffer.
   */
  draw(top: Rgb, bottom: Rgb): void;
  dispose(): void;
}

/** Full-screen vertical linear gradient, matching a 2D `createLinearGradient(0, 0, 0, h)`. */
export function createGradientBackground(gl: WebGL2RenderingContext): GradientBackground {
  return withScope((scope) => buildGradientBackground(gl, scope));
}

function buildGradientBackground(gl: WebGL2RenderingContext, scope: Scope): GradientBackground {
  const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, GRADIENT_FRAGMENT), (p) =>
    gl.deleteProgram(p),
  );
  const triangle = scope.own(createFullscreenTriangle(gl));
  const u = createUniforms(gl, program, ["uTop", "uBottom"]);
  return {
    draw(top, bottom) {
      gl.disable(gl.BLEND);
      if (top[0] === bottom[0] && top[1] === bottom[1] && top[2] === bottom[2]) {
        // A flat colour plus sub-LSB dither rounds back to itself: clear instead.
        gl.clearColor(top[0], top[1], top[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      gl.useProgram(program);
      u.v3("uTop", top);
      u.v3("uBottom", bottom);
      triangle.draw();
    },
    dispose: () => scope.dispose(),
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

/**
 * Replaces the whole of a 2D texture's level 0 with `data` (tightly packed, row 0
 * at t = 0), for tables rebuilt on the CPU. Binds `texture` to the active texture
 * unit, resets the unpack state (see `resetUnpackState`) and leaves the texture
 * bound there, ready to draw with. Allocates nothing, so it is fine per frame.
 */
export function updateDataTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
  format: GLenum,
  type: GLenum,
  data: ArrayBufferView,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  resetUnpackState(gl);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, type, data);
}

/** Channels per texel of a `ColumnTable`: R, RG or RGBA. */
export type ColumnTableChannels = 1 | 2 | 4;

export interface ColumnTableOptions {
  /** Rows of the table (texture height). Defaults to 1. */
  rows?: number;
  /** Defaults to `gl.CLAMP_TO_EDGE`; `gl.REPEAT` for tables that tile across. */
  wrap?: GLenum;
  /**
   * Initial contents, `columns * rows * channels` floats, kept as the table's
   * `data`. Defaults to zeros.
   */
  data?: Float32Array;
}

/**
 * A small linearly filtered half-float lookup texture, one texel per column (and
 * row), filled from a `Float32Array` on the CPU: per-column paths, profiles and
 * the like, which the shader reads with one fetch instead of recomputing per pixel.
 */
export interface ColumnTable {
  readonly texture: WebGLTexture;
  /** CPU-side contents: write here, then `upload`. */
  readonly data: Float32Array;
  readonly columns: number;
  readonly rows: number;
  /** Uploads `data`, leaving the texture bound to the active unit (see `updateDataTexture`). */
  upload(): void;
  dispose(): void;
}

/** Sized half-float internal format and pixel format for a table with this many channels. */
export function columnTableFormat(
  gl: WebGL2RenderingContext,
  channels: ColumnTableChannels,
): { internalFormat: GLenum; format: GLenum } {
  // Half floats are filterable in core WebGL2 and accept FLOAT data; 32-bit floats aren't.
  if (channels === 1) return { internalFormat: gl.R16F, format: gl.RED };
  if (channels === 2) return { internalFormat: gl.RG16F, format: gl.RG };
  return { internalFormat: gl.RGBA16F, format: gl.RGBA };
}

export function createColumnTable(
  gl: WebGL2RenderingContext,
  columns: number,
  channels: ColumnTableChannels,
  options: ColumnTableOptions = {},
): ColumnTable {
  const rows = options.rows ?? 1;
  const length = columns * rows * channels;
  const data = options.data ?? new Float32Array(length);
  if (data.length !== length) {
    throw new Error(
      `createColumnTable: ${columns}x${rows}x${channels} needs ${length} floats, got ${data.length}`,
    );
  }
  const { internalFormat, format } = columnTableFormat(gl, channels);
  const texture = createDataTexture(gl, {
    width: columns,
    height: rows,
    internalFormat,
    format,
    type: gl.FLOAT,
    data,
    wrap: options.wrap,
  });
  return {
    texture,
    data,
    columns,
    rows,
    upload: () => updateDataTexture(gl, texture, columns, rows, format, gl.FLOAT, data),
    dispose: () => gl.deleteTexture(texture),
  };
}

export interface RenderTargetOptions {
  /** Defaults to `gl.LINEAR`. */
  filter?: GLenum;
  /** Defaults to `gl.CLAMP_TO_EDGE`. */
  wrap?: GLenum;
}

/** A texture with immutable storage and a framebuffer that renders into it. */
export interface RenderTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
  /** Binds the framebuffer and sets the viewport to cover it. Caller unbinds. */
  bind(): void;
  dispose(): void;
}

/**
 * Creates a `width` x `height` texture of `internalFormat` (e.g. `gl.RGBA8`, `gl.R8`)
 * attached to a new framebuffer, cleared to transparent black. Returns null, having
 * deleted both, if the format isn't renderable here (e.g. `RGBA16F` without
 * `EXT_color_buffer_float`), so callers can fall back to another format.
 * Leaves the default framebuffer bound; the clear changes the viewport, clear
 * colour, scissor test and colour mask, which `beginFrame` resets anyway.
 */
export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  internalFormat: GLenum,
  options: RenderTargetOptions = {},
): RenderTarget | null {
  const filter = options.filter ?? gl.LINEAR;
  const wrap = options.wrap ?? gl.CLAMP_TO_EDGE;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  if (complete) {
    // Start from known contents rather than whatever the driver hands out.
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const dispose = () => {
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  };
  // A lost context reports every framebuffer incomplete; that isn't the format's fault.
  if (!complete && !gl.isContextLost()) {
    dispose();
    return null;
  }
  return {
    texture,
    framebuffer,
    width,
    height,
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, width, height);
    },
    dispose,
  };
}
