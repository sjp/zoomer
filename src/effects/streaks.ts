import type { Rgb } from "./color";
import { createProgram, createUniforms, type Scope, TO_CLIP_GLSL, withScope } from "./gl";

/**
 * Instanced WebGL2 renderer for round-capped line segments ("streaks"), shared by
 * the warp and hyperspace effects. Each streak is one instance: a quad expanded
 * around the segment in the vertex shader, shaded as an anti-aliased capsule.
 */

/** Floats per streak in `data`: tail x, tail y, head x, head y, r, g, b, half width. */
export const STREAK_FLOATS = 8;

/**
 * Shared vertex inputs. Tail and head are in device pixels, y down; style is the
 * colour premultiplied by alpha, and half the line width in device pixels.
 */
const VERTEX_HEADER = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSegment;
layout(location = 2) in vec4 aStyle;

uniform vec2 uResolution;

out vec2 vLocal;
flat out float vRadius;
flat out vec3 vColor;

${TO_CLIP_GLSL}`;

/** Single capsule per instance. */
const VERTEX = /* glsl */ `${VERTEX_HEADER}
flat out float vLength;

void main() {
  vec2 a = aSegment.xy;
  vec2 d = aSegment.zw - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Lines thinner than a pixel are drawn a pixel wide at proportionally lower intensity.
  float r = max(aStyle.w, 0.5);
  // Coverage reaches zero at r + 0.5, so that is all the padding the AA edge needs.
  float ext = r + 0.5;
  float u = aCorner.x < 0.0 ? -ext : len + ext;
  float v = aCorner.y * ext;
  vLocal = vec2(u, v);
  vLength = len;
  vRadius = r;
  vColor = aStyle.rgb * (aStyle.w / r);
  gl_Position = pxToClip(a + dir * u + nrm * v, uResolution);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
flat in float vLength;
flat in float vRadius;
flat in vec3 vColor;

out vec4 outColor;

void main() {
  // Distance to the segment from (0, 0) to (vLength, 0) in the streak's local frame.
  float dx = vLocal.x - clamp(vLocal.x, 0.0, vLength);
  float dist = length(vec2(dx, vLocal.y));
  float coverage = clamp(vRadius + 0.5 - dist, 0.0, 1.0);
  outColor = vec4(vColor * coverage, coverage);
}
`;

/**
 * Chromatic variant: each colour channel's capsule is the segment scaled about
 * uCenter by that channel's entry in uZoom. Scaling keeps the segment's direction,
 * so in the unscaled segment's local frame every channel's segment is still
 * axis-aligned: x from vStart to vEnd at y = vOffset. One quad bounds all three,
 * replacing three colour-masked draws with one draw and three cheap distances.
 */
const CHROMATIC_VERTEX = /* glsl */ `${VERTEX_HEADER}
uniform vec2 uCenter;
uniform vec3 uZoom;

flat out vec3 vStart;
flat out vec3 vEnd;
flat out vec3 vOffset;

void main() {
  vec2 a = aSegment.xy;
  vec2 d = aSegment.zw - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = max(aStyle.w, 0.5);
  float ext = r + 0.5;
  // Channel k's tail is a + (a - uCenter) * (zoom_k - 1); its length is len * zoom_k.
  vec2 ac = a - uCenter;
  vec3 zm1 = uZoom - 1.0;
  vec3 start = dot(ac, dir) * zm1;
  vec3 end = start + len * uZoom;
  vec3 offset = dot(ac, nrm) * zm1;
  float u = aCorner.x < 0.0
    ? min(start.x, min(start.y, start.z)) - ext
    : max(end.x, max(end.y, end.z)) + ext;
  float v = aCorner.y < 0.0
    ? min(offset.x, min(offset.y, offset.z)) - ext
    : max(offset.x, max(offset.y, offset.z)) + ext;
  vLocal = vec2(u, v);
  vStart = start;
  vEnd = end;
  vOffset = offset;
  vRadius = r;
  vColor = aStyle.rgb * (aStyle.w / r);
  gl_Position = pxToClip(a + dir * u + nrm * v, uResolution);
}
`;

const CHROMATIC_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
flat in vec3 vStart;
flat in vec3 vEnd;
flat in vec3 vOffset;
flat in float vRadius;
flat in vec3 vColor;

out vec4 outColor;

void main() {
  vec3 x = vec3(vLocal.x);
  vec3 dx = x - clamp(x, vStart, vEnd);
  vec3 dy = vLocal.y - vOffset;
  vec3 dist = sqrt(dx * dx + dy * dy);
  vec3 coverage = clamp(vRadius + 0.5 - dist, 0.0, 1.0);
  outColor = vec4(vColor * coverage, max(coverage.r, max(coverage.g, coverage.b)));
}
`;

export interface StreakRendererOptions {
  /** Also build the per-channel zoom (chromatic aberration) program. */
  chromatic?: boolean;
}

export interface StreakRenderer {
  /** Per-streak data, `STREAK_FLOATS` floats each; fill it, then call `upload`. */
  data: Float32Array;
  /** Uploads the first `count` streaks of `data`. */
  upload(count: number): void;
  /**
   * Draws the uploaded streaks additively. Sets its own program, vertex array and
   * blending; everything else is as `beginFrame` left it, plus the caller's viewport.
   * `zoom` scales each colour channel's positions about the centre (needs the
   * `chromatic` option); omit it to draw unscaled.
   */
  draw(count: number, width: number, height: number, zoom?: Rgb): void;
  dispose(): void;
}

export function createStreakRenderer(
  gl: WebGL2RenderingContext,
  max: number,
  options: StreakRendererOptions = {},
): StreakRenderer {
  return withScope((scope) => buildStreakRenderer(gl, max, options, scope));
}

function buildStreakRenderer(
  gl: WebGL2RenderingContext,
  max: number,
  options: StreakRendererOptions,
  scope: Scope,
): StreakRenderer {
  const deleteProgram = (p: WebGLProgram) => gl.deleteProgram(p);
  const program = scope.add(createProgram(gl, VERTEX, FRAGMENT), deleteProgram);
  const u = createUniforms(gl, program, ["uResolution"]);
  const chromatic = options.chromatic
    ? scope.add(createProgram(gl, CHROMATIC_VERTEX, CHROMATIC_FRAGMENT), deleteProgram)
    : null;
  const cu = chromatic ? createUniforms(gl, chromatic, ["uResolution", "uCenter", "uZoom"]) : null;
  const data = new Float32Array(max * STREAK_FLOATS);

  const vao = scope.add(gl.createVertexArray(), (v) => gl.deleteVertexArray(v));
  const cornerBuffer = scope.add(gl.createBuffer(), (b) => gl.deleteBuffer(b));
  const instanceBuffer = scope.add(gl.createBuffer(), (b) => gl.deleteBuffer(b));
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  // Triangle strip: (tail, -side), (head, -side), (tail, +side), (head, +side).
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  const stride = STREAK_FLOATS * 4;
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const clampCount = (count: number) => Math.floor(Math.min(count, max));

  return {
    data,
    upload(count) {
      const n = clampCount(count);
      if (n <= 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * STREAK_FLOATS);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    },
    draw(count, width, height, zoom) {
      const n = clampCount(count);
      if (n <= 0) return;
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      const split = zoom && (zoom[0] !== 1 || zoom[1] !== 1 || zoom[2] !== 1);
      if (split && cu) {
        gl.useProgram(cu.program);
        cu.f2("uResolution", width, height);
        cu.f2("uCenter", width / 2, height / 2);
        cu.v3("uZoom", zoom);
      } else {
        if (split) throw new Error("Streaks: per-channel zoom needs the chromatic option");
        gl.useProgram(program);
        u.f2("uResolution", width, height);
      }
      gl.bindVertexArray(vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    },
    dispose: () => scope.dispose(),
  };
}
