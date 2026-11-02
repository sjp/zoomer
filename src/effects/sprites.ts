/**
 * Shared WebGL2 helpers for the particle effects (bokeh, snow): an instanced sprite
 * batch whose per-instance data is filled on the CPU each frame, and a vertical
 * two-colour gradient background pass.
 */
import type { Rgb } from "./color";
import {
  createFullscreenTriangle,
  createProgram,
  createScope,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  getUniforms,
  type Scope,
  withScope,
} from "./gl";

export interface SpriteBatch {
  /** CPU-side instance data, `stride` floats per instance. Fill, then `upload`. */
  readonly data: Float32Array;
  /** Floats per instance. */
  readonly stride: number;
  /** Uploads the first `count` instances from `data` to the GPU. */
  upload(count: number): void;
  /**
   * Draws instances `first .. first + count - 1`, each as one triangle strip of
   * `shapes[shape]` (see `createSpriteBatch`).
   */
  draw(first: number, count: number, shape?: number): void;
  dispose(): void;
}

/** A unit quad, corners at ±1, as a triangle strip. */
export const QUAD: readonly number[] = [-1, -1, 1, -1, -1, 1, 1, 1];

/**
 * A regular polygon circumscribing the unit circle (apothem 1), as a triangle strip.
 * Vertex 0 is at `angle` radians. Tighter than a quad around round sprites, so fewer
 * fragments are shaded and blended: an octagon covers 17% less area than the square.
 */
export function polygonStrip(sides: number, angle = 0): number[] {
  const r = 1 / Math.cos(Math.PI / sides);
  const vertex = (k: number) => {
    const a = angle + (k * 2 * Math.PI) / sides;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  // Zigzag 0, 1, n-1, 2, n-2, ... turns the convex fan into a strip.
  const out = vertex(0);
  for (let lo = 1, hi = sides - 1; lo <= hi; lo++, hi--) {
    out.push(...vertex(lo));
    if (hi !== lo) out.push(...vertex(hi));
  }
  return out;
}

/**
 * Per-instance sprites: each instance draws one of `shapes` (triangle strips of
 * `vec2` corners in unit space, attribute location 0; a unit quad by default).
 * `attributeSizes` lists the per-instance attributes, bound to locations 1, 2, ...
 * in order, each with that many float components, interleaved in one buffer.
 */
export function createSpriteBatch(
  gl: WebGL2RenderingContext,
  maxInstances: number,
  attributeSizes: readonly number[],
  shapes: readonly (readonly number[])[] = [QUAD],
): SpriteBatch {
  const stride = attributeSizes.reduce((a, b) => a + b, 0);
  const strideBytes = stride * 4;
  const data = new Float32Array(maxInstances * stride);
  // All shapes share one buffer; a draw picks its range by first vertex.
  const shapeFirst: number[] = [];
  const shapeCount: number[] = [];
  const corners: number[] = [];
  for (const shape of shapes) {
    shapeFirst.push(corners.length / 2);
    shapeCount.push(shape.length / 2);
    corners.push(...shape);
  }

  // Nothing below can throw, so a plain scope (no `withScope`) is enough.
  const scope = createScope();
  const vao = scope.add(gl.createVertexArray(), (v) => gl.deleteVertexArray(v));
  const cornerBuffer = scope.add(gl.createBuffer(), (b) => gl.deleteBuffer(b));
  const instanceBuffer = scope.add(gl.createBuffer(), (b) => gl.deleteBuffer(b));
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  const offsets: number[] = [];
  let offset = 0;
  attributeSizes.forEach((size, i) => {
    const location = i + 1;
    offsets.push(offset);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, strideBytes, offset);
    gl.vertexAttribDivisor(location, 1);
    offset += size * 4;
  });
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  /**
   * Instance the pointers in the VAO currently start at. The VAO is private to this
   * batch, so its pointers persist between draws and frames.
   */
  let pointedAt = 0;

  return {
    data,
    stride,
    upload(count) {
      if (count <= 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * stride);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    },
    draw(first, count, shape = 0) {
      if (count <= 0) return;
      gl.bindVertexArray(vao);
      if (first !== pointedAt) {
        // WebGL2 has no base-instance draw, so offset the instance pointers instead.
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        const base = first * strideBytes;
        for (let i = 0; i < attributeSizes.length; i++) {
          const size = attributeSizes[i];
          gl.vertexAttribPointer(i + 1, size, gl.FLOAT, false, strideBytes, base + offsets[i]);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        pointedAt = first;
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, shapeFirst[shape], shapeCount[shape], count);
      // Unbind so another effect's element-buffer binding can't land in this VAO.
      gl.bindVertexArray(null);
    },
    dispose: () => scope.dispose(),
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
  const loc = getUniforms(gl, program, ["uTop", "uBottom"]);
  // Uniforms are per-program state, and this program is ours alone: set on change only.
  // A plain array: values are compared as given, not rounded to float32.
  const last: number[] = Array.from({ length: 6 }, () => Number.NaN);
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
      if (last[0] !== top[0] || last[1] !== top[1] || last[2] !== top[2]) {
        gl.uniform3fv(loc.uTop, top);
        last[0] = top[0];
        last[1] = top[1];
        last[2] = top[2];
      }
      if (last[3] !== bottom[0] || last[4] !== bottom[1] || last[5] !== bottom[2]) {
        gl.uniform3fv(loc.uBottom, bottom);
        last[3] = bottom[0];
        last[4] = bottom[1];
        last[5] = bottom[2];
      }
      triangle.draw();
    },
    dispose: () => scope.dispose(),
  };
}
