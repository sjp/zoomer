/**
 * Shared snowflake renderer (Snow, Snowy Window): soft round flakes as instanced
 * sprites, filled by `createFlakes` in `snow-sim.ts`. Each effect owns its own
 * renderer, so the uniforms are change-tracked per effect.
 */
import type { Rgb } from "./color";
import {
  createUniforms,
  glslFloat,
  type Scope,
  TO_CLIP_GLSL,
  typedParameters,
  withScope,
  scopedProgram,
} from "./gl";
import { PAD_MARGIN } from "./snow/snow-sim";
import { createSpriteBatch } from "./sprites";

/**
 * Vertex shader for flakes. Per flake: centre and quad half-size (device px,
 * y down; the x half-size narrows as the flake tumbles), opacity and edge softness.
 *
 * With `fadeMask`, each flake's opacity is also scaled by the mask texture's R
 * channel at its centre (one vertex fetch, so the whole flake fades together).
 * The mask covers the canvas with row 0 at the top (u = x / width, v = y / height
 * in device px, y down); bilinear filtering keeps the fade smooth as a flake moves.
 * Without it the shader is exactly the original.
 */
export const flakeVertex = (fadeMask: boolean) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec2 aLook;
uniform vec2 uResolution;
${fadeMask ? "uniform sampler2D uMask;\n" : ""}out vec2 vLocal;
flat out float vAlpha;
flat out float vSoftness;
${TO_CLIP_GLSL}
void main() {
  // Grow the quad by a pixel so the anti-aliased edge of tiny flakes is never clipped.
  vec2 ext = aRect.zw + 1.0;
  vec2 px = aRect.xy + aCorner * ext;
  // spritePad(softness), as in TS.
  float pad = 1.0 + aLook.y + ${glslFloat(PAD_MARGIN)};
  vLocal = aCorner * pad * ext / aRect.zw;
  vAlpha = aLook.x${fadeMask ? " * textureLod(uMask, aRect.xy / uResolution, 0.0).r" : ""};
  vSoftness = aLook.y;
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * One soft round flake: a disc whose edge fades over `softness` radii, slightly
 * whiter in the middle. Output is premultiplied for source-over blending.
 */
const FLAKE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vAlpha;
flat in float vSoftness;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float s = vSoftness;
  float inner = max(0.0, 1.0 - s);
  float outer = 1.0 + s;
  // At least about a pixel of anti-aliasing, as the old bilinear-scaled sprite had.
  float mid = 0.5 * (inner + outer);
  float hw = max(0.5 * (outer - inner), 0.5 * fwidth(d));
  // Blurring spreads the same light wider, so the peak drops a little.
  float a = (1.0 - smoothstep(mid - hw, mid + hw, d)) / (1.0 + s * 0.6) * vAlpha;
  vec3 color = mix(uColor, vec3(1.0), 0.35 * max(0.0, 1.0 - d));
  outColor = vec4(color * a, a);
}
`;

export interface FlakeRenderer {
  /** Instance data for `Flakes.step`: write `stride` floats per flake, then `upload`. */
  readonly data: Float32Array;
  readonly stride: number;
  /** Uploads the first `count` flakes. */
  upload: (count: number) => void;
  /**
   * Draws flakes `first .. first + count - 1` in `color` on a `width` x `height`
   * canvas. Binds its program; the caller sets blending (premultiplied
   * source-over: `ONE, ONE_MINUS_SRC_ALPHA`).
   *
   * With the `fadeMask` option, `mask` is bound to texture unit 0 (left bound,
   * with unit 0 active) and scales each flake's opacity; see `flakeVertex`.
   * Without it, `mask` is ignored.
   */
  draw: (
    first: number,
    count: number,
    width: number,
    height: number,
    color: Rgb,
    mask?: WebGLTexture | null,
  ) => void;
  dispose: () => void;
}

export interface FlakeRendererOptions {
  /** Opt in to fading flakes by a mask texture passed to `draw` (default false). */
  fadeMask?: boolean;
}

/** A flake renderer for up to `max` flakes. */
export function createFlakeRenderer(
  gl: WebGL2RenderingContext,
  max: number,
  options: FlakeRendererOptions = {},
): FlakeRenderer {
  return withScope((scope) => buildFlakeRenderer(gl, max, options.fadeMask === true, scope));
}

function buildFlakeRenderer(
  gl: WebGL2RenderingContext,
  max: number,
  fadeMask: boolean,
  scope: Scope,
): FlakeRenderer {
  const program = scopedProgram(gl, scope, flakeVertex(fadeMask), FLAKE_FRAGMENT);
  const u = createUniforms(gl, program, ["uResolution", "uColor"]);
  if (fadeMask) {
    const prevProgram = typedParameters(gl).getParameter(gl.CURRENT_PROGRAM);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uMask"), 0);
    gl.useProgram(prevProgram);
  }
  // Per flake: centre x, centre y, half-width, half-height, then opacity and softness.
  const batch = scope.own(createSpriteBatch(gl, max, [4, 2]));
  return {
    data: batch.data,
    stride: batch.stride,
    upload: (count) => {
      batch.upload(count);
    },
    draw(first, count, width, height, color, mask) {
      gl.useProgram(program);
      u.f2("uResolution", width, height);
      u.v3("uColor", color);
      if (fadeMask) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, mask ?? null);
      }
      batch.draw(first, count);
    },
    dispose: () => {
      scope.dispose();
    },
  };
}
