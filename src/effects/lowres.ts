/**
 * Reduced-resolution render target: render a smooth, low-frequency image into a
 * small texture, then upscale it to the canvas with one bilinear fetch per pixel.
 * At divisor 2 the low-res pass shades 1/4 of the pixels; at divisor 4, 1/16.
 *
 * Typical frame:
 *
 * ```ts
 * target.bind();                          // FBO + low-res viewport
 * // ...draw the expensive pass...
 * gl.bindFramebuffer(gl.FRAMEBUFFER, null);
 * target.blit();                          // upscale + dither to the default framebuffer
 * ```
 *
 * Quality param pattern. Use these labels so every effect reads the same:
 *
 * ```ts
 * quality: {
 *   kind: "select",
 *   label: "Quality",
 *   options: QUALITY_OPTIONS,
 *   default: "balanced",
 * },
 * // in resize/frame:
 * target.resize(width, height, qualityDivisor(params.quality));
 * ```
 *
 * Effects with no high frequencies (e.g. gradient blobs) may pass their own
 * divisor table, e.g. `qualityDivisor(q, { high: 4, balanced: 6, low: 8 })`.
 */

import {
  createFullscreenTriangle,
  createProgram,
  FULLSCREEN_VERTEX,
  type Scope,
  withScope,
} from "./gl";

export type LowResQuality = "high" | "balanced" | "low";

/** Options for a `quality` select param. */
export const QUALITY_OPTIONS = [
  { value: "high", label: "High" },
  { value: "balanced", label: "Balanced" },
  { value: "low", label: "Low (saves power)" },
] as const;

/** Default divisors for each quality label. */
export const QUALITY_DIVISORS: Readonly<Record<LowResQuality, number>> = {
  high: 1,
  balanced: 2,
  low: 3,
};

/** Maps a quality select value to a divisor; unknown values fall back to "balanced". */
export function qualityDivisor(
  quality: string,
  table: Readonly<Record<LowResQuality, number>> = QUALITY_DIVISORS,
): number {
  return quality === "high" || quality === "balanced" || quality === "low"
    ? table[quality]
    : table.balanced;
}

/**
 * Size of a low-res target: `ceil(size / divisor)`, at least 1. Divisors may be
 * fractional; non-finite or < 1 divisors are treated as 1.
 */
export function lowResSize(size: number, divisor: number): number {
  const d = Number.isFinite(divisor) && divisor >= 1 ? divisor : 1;
  const s = Number.isFinite(size) ? Math.floor(size) : 0;
  // Subtract a tiny epsilon so e.g. 1080 / 1.5 = 720.0000000001 rounds to 720.
  return Math.max(1, Math.ceil(s / d - 1e-9));
}

export interface LowResTarget {
  /**
   * Sets the full (canvas) size and divisor. Recreates the texture when the
   * low-res size changes; no-op otherwise.
   */
  resize(width: number, height: number, divisor: number): void;
  /** Binds the FBO and sets the viewport to the low-res size. Caller unbinds. */
  bind(): void;
  /**
   * Draws the low-res texture to the currently bound framebuffer, filling the
   * full-size viewport, with blending disabled and sub-LSB dither. Binds the
   * low-res texture to texture unit 0 and leaves the active unit at 0.
   * Callers must unbind the FBO from `bind()` before calling this.
   *
   * The viewport defaults to the full size passed to `resize`. Pass an explicit
   * output size when the target covers only part of the canvas but the
   * `composite` shader must shade all of it.
   */
  blit(outWidth?: number, outHeight?: number): void;
  /** Low-res size in pixels. */
  readonly width: number;
  readonly height: number;
  /** Full (output) size passed to `resize`. */
  readonly fullWidth: number;
  readonly fullHeight: number;
  readonly texture: WebGLTexture;
  /** The blit program, for setting custom uniforms declared in `composite`. */
  readonly program: WebGLProgram;
  /** True if the texture is RGBA16F (requested and supported). */
  readonly isFloat: boolean;
  dispose(): void;
}

export interface LowResOptions {
  /** Defaults to "rgba8". "rgba16f" falls back to RGBA8 if not renderable. */
  format?: "rgba8" | "rgba16f";
  /**
   * Optional GLSL that replaces the default blit body, so an effect can composite
   * while upscaling. It must define `vec4 composite(vec2 uv)`, and may declare its
   * own uniforms (bind extra textures to units 1+). Available: `uniform sampler2D
   * uLowRes` (unit 0), `uniform vec2 uLowResSize`, `in vec2 vUv` (0..1). Dither is
   * added to the returned colour afterwards. Default:
   * `vec4 composite(vec2 uv) { return texture(uLowRes, uv); }`.
   * Set custom uniforms with `gl.useProgram(target.program)` first.
   */
  composite?: string;
  /** Adds +-0.5 LSB of dither to the blit output. Defaults to true. */
  dither?: boolean;
}

const DEFAULT_COMPOSITE = /* glsl */ `
vec4 composite(vec2 uv) { return texture(uLowRes, uv); }
`;

const blitFragment = (composite: string, dither: boolean) => /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uLowRes;
uniform vec2 uLowResSize;
in vec2 vUv;
out vec4 outColor;
${composite}
void main() {
  vec4 c = composite(vUv);
${
  dither
    ? `  // Sub-LSB dither: upscaled 8-bit gradients band visibly without it.
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  c.rgb += (n - 0.5) / 255.0;`
    : ""
}
  outColor = vec4(c.rgb, 1.0);
}
`;

export function createLowResTarget(
  gl: WebGL2RenderingContext,
  opts: LowResOptions = {},
): LowResTarget {
  return withScope((scope) => buildLowResTarget(gl, opts, scope));
}

function buildLowResTarget(
  gl: WebGL2RenderingContext,
  opts: LowResOptions,
  scope: Scope,
): LowResTarget {
  const program = scope.add(
    createProgram(
      gl,
      FULLSCREEN_VERTEX,
      blitFragment(opts.composite ?? DEFAULT_COMPOSITE, opts.dither ?? true),
    ),
    (p) => gl.deleteProgram(p),
  );
  const uTex = gl.getUniformLocation(program, "uLowRes");
  const uSize = gl.getUniformLocation(program, "uLowResSize");
  gl.useProgram(program);
  gl.uniform1i(uTex, 0);
  const triangle = scope.own(createFullscreenTriangle(gl));

  let wantFloat = opts.format === "rgba16f" && gl.getExtension("EXT_color_buffer_float") !== null;
  let texture: WebGLTexture = gl.createTexture();
  // `allocate` replaces the texture, so delete whichever one is current.
  scope.defer(() => gl.deleteTexture(texture));
  const fbo = scope.add(gl.createFramebuffer(), (f) => gl.deleteFramebuffer(f));
  let width = 0;
  let height = 0;
  let fullWidth = 1;
  let fullHeight = 1;
  let isFloat = false;

  /** (Re)allocates texture storage at width x height; returns framebuffer completeness. */
  const allocate = (float: boolean): boolean => {
    gl.deleteTexture(texture);
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA16F : gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (ok) {
      // Start from black rather than undefined contents.
      gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok;
  };

  const target: LowResTarget = {
    resize(w, h, divisor) {
      fullWidth = Math.max(1, Math.floor(w));
      fullHeight = Math.max(1, Math.floor(h));
      const lw = lowResSize(w, divisor);
      const lh = lowResSize(h, divisor);
      if (lw === width && lh === height) return;
      width = lw;
      height = lh;
      isFloat = wantFloat && allocate(true);
      if (!isFloat) {
        // 16F not renderable after all: stop trying and use 8-bit from now on.
        if (wantFloat) wantFloat = false;
        allocate(false);
      }
      gl.useProgram(program);
      gl.uniform2f(uSize, width, height);
    },
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, width, height);
    },
    blit(outWidth = fullWidth, outHeight = fullHeight) {
      gl.viewport(0, 0, outWidth, outHeight);
      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      triangle.draw();
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get fullWidth() {
      return fullWidth;
    },
    get fullHeight() {
      return fullHeight;
    },
    get texture() {
      return texture;
    },
    get isFloat() {
      return isFloat;
    },
    program,
    dispose: () => scope.dispose(),
  };
  return target;
}
