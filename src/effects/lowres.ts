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
 * Quality param pattern. Use these labels so every effect reads the same (the
 * options come from `param-options.ts`, which `.meta.ts` files may import):
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

import type { ChangeKey } from "./change-key";
import {
  createFullscreenTriangle,
  createRenderTarget,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  type RenderTarget,
  type Scope,
  typedParameters,
  withScope,
  scopedProgram,
  floatRenderable,
} from "./gl";

export type LowResQuality = "high" | "balanced" | "low";

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

/**
 * Whether a target can skip its texture and render straight to the canvas: only
 * when the low-res size equals the full size, the blit is a plain copy (no
 * `composite`) and the format is RGBA8 (an RGBA16F target keeps its extra
 * precision until the dithered blit). Saves a full-screen fetch and write.
 */
export function rendersDirect(
  fullWidth: number,
  fullHeight: number,
  lowWidth: number,
  lowHeight: number,
  hasComposite: boolean,
  wantFloat: boolean,
): boolean {
  return !hasComposite && !wantFloat && lowWidth === fullWidth && lowHeight === fullHeight;
}

export interface LowResTarget {
  /**
   * Sets the full (canvas) size and divisor. Recreates the texture (cleared to
   * black) when the low-res size changes; no-op otherwise. Leaves the GL state
   * (viewport, framebuffer, program and so on) as it found it, so it is safe to
   * call mid-frame.
   */
  resize: (width: number, height: number, divisor: number) => void;
  /**
   * Binds the FBO and sets the viewport to the low-res size. Caller unbinds.
   * When rendering direct (see `rendersDirect`), binds the default framebuffer
   * and sets the full-size viewport instead.
   */
  bind: () => void;
  /**
   * Draws the low-res texture to the currently bound framebuffer, filling the
   * full-size viewport, with sub-LSB dither and blending disabled (or, for a
   * `premultiplied` target, blended over the framebuffer, leaving blending
   * disabled afterwards). Binds the low-res texture to texture unit 0 and
   * leaves the active unit at 0.
   * Callers must unbind the FBO from `bind()` before calling this.
   *
   * The viewport defaults to the full size passed to `resize`. Pass an explicit
   * output size when the target covers only part of the canvas but the
   * `composite` shader must shade all of it.
   *
   * A no-op when rendering direct: the image is already on the canvas.
   */
  blit: (outWidth?: number, outHeight?: number) => void;
  /** Low-res size in pixels. */
  readonly width: number;
  readonly height: number;
  /** Full (output) size passed to `resize`. */
  readonly fullWidth: number;
  readonly fullHeight: number;
  /**
   * The low-res texture; null until the first `resize`, and while rendering
   * direct. Effects that sample it themselves must pass a `composite`.
   */
  readonly texture: WebGLTexture | null;
  /** The blit program, for setting custom uniforms declared in `composite`. */
  readonly program: WebGLProgram;
  /** True if the texture is RGBA16F (requested and supported). */
  readonly isFloat: boolean;
  /** True while `bind` targets the canvas directly and `blit` does nothing. */
  readonly direct: boolean;
  /**
   * For a target that caches an image between frames: whether it must be drawn
   * this frame. True while rendering direct (the canvas keeps nothing), on the
   * first call after `resize` changed the full or low-res size (a new texture
   * starts black, and the image may depend on the aspect), and when `key`
   * reports a change. Always takes `key`, so its flag is clear afterwards.
   */
  needsRedraw: (key?: ChangeKey) => boolean;
  dispose: () => void;
}

export interface LowResOptions {
  /** Defaults to "rgba8". "rgba16f" falls back to RGBA8 if not renderable. */
  format?: "rgba8" | "rgba16f";
  /**
   * Optional GLSL that replaces the default blit body, so an effect can composite
   * while upscaling. It must define `vec4 composite(vec2 uv)`, and may declare its
   * own uniforms (bind extra textures to units 1+). Available: `uniform sampler2D
   * uLowRes` (unit 0, highp), `uniform vec2 uLowResSize`, `in vec2 vUv` (0..1). Dither is
   * added to the returned colour afterwards. Default:
   * `vec4 composite(vec2 uv) { return texture(uLowRes, uv); }`.
   * Set custom uniforms with `gl.useProgram(target.program)` first.
   */
  composite?: string;
  /** Adds +-0.5 LSB of dither to the blit output. Defaults to true. */
  dither?: boolean;
  /**
   * Blit the texture as premultiplied colour and alpha over what is already in
   * the framebuffer (blend ONE, ONE_MINUS_SRC_ALPHA) instead of replacing it with
   * opaque colour. Defaults to false.
   */
  premultiplied?: boolean;
  /**
   * Never render direct, even at full size, so the texture keeps its image
   * between frames and `needsRedraw` can skip an unchanged one. Defaults to false.
   */
  keep?: boolean;
}

const DEFAULT_COMPOSITE = /* glsl */ `
vec4 composite(vec2 uv) { return texture(uLowRes, uv); }
`;

const blitFragment = (
  composite: string,
  dither: boolean,
  premultiplied: boolean,
) => /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uLowRes;
uniform vec2 uLowResSize;
in vec2 vUv;
out vec4 outColor;
${dither ? DITHER_GLSL : ""}
${composite}
void main() {
  vec4 c = composite(vUv);
${
  dither
    ? `  // Sub-LSB dither: upscaled 8-bit gradients band visibly without it.
  c.rgb += dither8(gl_FragCoord.xy);`
    : ""
}
  outColor = ${premultiplied ? "c" : "vec4(c.rgb, 1.0)"};
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
  const premultiplied = opts.premultiplied === true;
  const program = scopedProgram(
    gl,
    scope,
    FULLSCREEN_VERTEX,
    blitFragment(opts.composite ?? DEFAULT_COMPOSITE, opts.dither ?? true, premultiplied),
  );
  const uTex = gl.getUniformLocation(program, "uLowRes");
  // Only custom composites read the low-res size; the default one leaves it unused.
  const uSize =
    (opts.composite?.includes("uLowResSize") ?? false)
      ? gl.getUniformLocation(program, "uLowResSize")
      : null;
  gl.useProgram(program);
  gl.uniform1i(uTex, 0);
  const triangle = scope.own(createFullscreenTriangle(gl));

  let wantFloat = opts.format === "rgba16f" && floatRenderable(gl, gl.RGBA16F);
  /** Null only until the first `resize`. */
  let rt: RenderTarget | null = null;
  // `resize` replaces the target, so dispose whichever one is current.
  scope.defer(() => rt?.dispose());
  let fullWidth = 1;
  let fullHeight = 1;
  let isFloat = false;
  let direct = false;
  // Keeping the image needs a texture, as a composite does.
  const needsTexture = opts.composite !== undefined || opts.keep === true || premultiplied;
  /** Set when `resize` changes a size, cleared by `needsRedraw`. */
  let stale = true;

  const target: LowResTarget = {
    resize(w, h, divisor) {
      const fw = Math.max(1, Math.floor(w));
      const fh = Math.max(1, Math.floor(h));
      if (fw !== fullWidth || fh !== fullHeight) {
        stale = true;
      }
      fullWidth = fw;
      fullHeight = fh;
      const lw = lowResSize(w, divisor);
      const lh = lowResSize(h, divisor);
      direct = rendersDirect(fullWidth, fullHeight, lw, lh, needsTexture, wantFloat);
      if (direct) {
        // No texture needed: free it rather than keep a full-size copy around.
        rt?.dispose();
        rt = null;
        isFloat = false;
        return;
      }
      if (lw === rt?.width && lh === rt.height) {
        return;
      }
      rt?.dispose();
      rt = null;
      stale = true;
      if (wantFloat) {
        rt = createRenderTarget(gl, lw, lh, gl.RGBA16F);
        // 16F not renderable after all: stop trying and use 8-bit from now on.
        if (!rt) {
          wantFloat = false;
        }
      }
      isFloat = rt !== null;
      rt ??= createRenderTarget(gl, lw, lh, gl.RGBA8);
      if (!rt) {
        throw new Error("Low-res target: RGBA8 is not renderable");
      }
      const prevProgram = typedParameters(gl).getParameter(gl.CURRENT_PROGRAM);
      gl.useProgram(program);
      gl.uniform2f(uSize, lw, lh);
      gl.useProgram(prevProgram);
    },
    bind() {
      if (direct) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, fullWidth, fullHeight);
      } else {
        rt?.bind();
      }
    },
    blit(outWidth = fullWidth, outHeight = fullHeight) {
      if (direct) {
        return;
      }
      gl.viewport(0, 0, outWidth, outHeight);
      if (premultiplied) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        gl.disable(gl.BLEND);
      }
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, rt?.texture ?? null);
      triangle.draw();
      if (premultiplied) {
        gl.disable(gl.BLEND);
      }
    },
    get width() {
      return direct ? fullWidth : (rt?.width ?? 0);
    },
    get height() {
      return direct ? fullHeight : (rt?.height ?? 0);
    },
    get fullWidth() {
      return fullWidth;
    },
    get fullHeight() {
      return fullHeight;
    },
    get texture() {
      return rt?.texture ?? null;
    },
    get isFloat() {
      return isFloat;
    },
    get direct() {
      return direct;
    },
    needsRedraw(key) {
      const changed = key?.take() ?? false;
      const redraw = direct || stale || changed;
      stale = false;
      return redraw;
    },
    program,
    dispose: () => {
      scope.dispose();
    },
  };
  return target;
}
