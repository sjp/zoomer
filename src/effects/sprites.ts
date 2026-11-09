/**
 * Shared WebGL2 helpers for the particle effects (bokeh, snow and others): an
 * instanced sprite batch whose per-instance data is filled on the CPU each frame,
 * and polygon shapes that fit round sprites tightly.
 */
import { createScope } from "./gl";

export interface SpriteBatch {
  /** CPU-side instance data, `stride` floats per instance. Fill, then `upload`. */
  readonly data: Float32Array;
  /** Floats per instance. */
  readonly stride: number;
  /**
   * With `{ rotation: true }`: the float offset within each instance of its spin
   * pair (angle in radians, then flip scale), always the last two floats. -1 for
   * a batch without rotation.
   */
  readonly spinOffset: number;
  /** With `{ rotation: true }`: the spin attribute's location (`attributeSizes.length + 1`), else -1. */
  readonly spinLocation: number;
  /** Uploads the first `count` instances (at most `maxInstances`) from `data` to the GPU. */
  upload: (count: number) => void;
  /**
   * Draws instances `first .. first + count - 1`, each as one triangle strip of
   * `shapes[shape]` (see `createSpriteBatch`). The range is clipped to the
   * batch's `maxInstances`.
   */
  draw: (first: number, count: number, shape?: number) => void;
  dispose: () => void;
}

/** Options for `createSpriteBatch`. */
interface SpriteBatchOptions {
  /**
   * Appends a per-instance `vec2` spin attribute after the caller's ones: in-plane
   * rotation in radians, then a flip scale applied to the corner's x before the
   * rotation (the cosine of a tumble angle fakes a piece turning over in 3D). Read
   * it in the vertex shader with `SPRITE_SPIN_GLSL`. Off by default, so other
   * batches keep their layout and cost.
   */
  rotation?: boolean;
}

/**
 * GLSL for `vec2 spinCorner(vec2 corner, vec2 spin)`: scales the corner's x by
 * `spin.y` (flip), then rotates by `spin.x` radians. For batches created with
 * `{ rotation: true }`; declare the attribute as
 * `layout(location = <batch.spinLocation>) in vec2 aSpin;`.
 */
export const SPRITE_SPIN_GLSL = /* glsl */ `
vec2 spinCorner(vec2 corner, vec2 spin) {
  vec2 c = vec2(corner.x * spin.y, corner.y);
  float s = sin(spin.x);
  float k = cos(spin.x);
  return vec2(c.x * k - c.y * s, c.x * s + c.y * k);
}
`;

/** A unit quad, corners at ±1, as a triangle strip. */
export const QUAD: readonly number[] = [-1, -1, 1, -1, -1, 1, 1, 1];

/**
 * A ribbon of `segments` quads as a triangle strip: (level, side) per vertex,
 * level 0 to `segments` along the ribbon and side -1 or 1 across it, for a
 * vertex shader to bend along a stem, frond or leaf.
 */
export function ribbonStrip(segments: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segments; i++) {
    out.push(i, -1, i, 1);
  }
  return out;
}

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
    if (hi !== lo) {
      out.push(...vertex(hi));
    }
  }
  return out;
}

/**
 * Per-instance sprites: each instance draws one of `shapes` (triangle strips of
 * `vec2` corners in unit space, attribute location 0; a unit quad by default).
 * `attributeSizes` lists the per-instance attributes, bound to locations 1, 2, ...
 * in order, each with that many float components, interleaved in one buffer.
 * `options.rotation` appends a two-float spin attribute (see `SpriteBatchOptions`).
 */
export function createSpriteBatch(
  gl: WebGL2RenderingContext,
  maxInstances: number,
  attributeSizes: readonly number[],
  shapes: readonly (readonly number[])[] = [QUAD],
  options: SpriteBatchOptions = {},
): SpriteBatch {
  // The spin pair is just one more attribute, so a batch without it is unchanged.
  const rotation = options.rotation === true;
  const sizes = rotation ? [...attributeSizes, 2] : attributeSizes;
  const stride = sizes.reduce((a, b) => a + b, 0);
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
  const vao = scope.add(gl.createVertexArray(), (v) => {
    gl.deleteVertexArray(v);
  });
  const cornerBuffer = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
  const instanceBuffer = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
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
  sizes.forEach((size, i) => {
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
    spinOffset: rotation ? stride - 2 : -1,
    spinLocation: rotation ? sizes.length : -1,
    upload(count) {
      // Past the buffer's end, bufferSubData raises INVALID_VALUE and uploads nothing.
      const n = Math.floor(Math.min(count, maxInstances));
      if (!(n > 0)) {
        return;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * stride);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    },
    draw(first, count, shape = 0) {
      first = Math.max(0, Math.floor(first));
      // Instances past the buffer's end would make the draw fail outright.
      count = Math.floor(Math.min(count, maxInstances - first));
      if (!(count > 0)) {
        return;
      }
      gl.bindVertexArray(vao);
      if (first !== pointedAt) {
        // WebGL2 has no base-instance draw, so offset the instance pointers instead.
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        const base = first * strideBytes;
        for (let i = 0; i < sizes.length; i++) {
          const size = sizes[i];
          gl.vertexAttribPointer(i + 1, size, gl.FLOAT, false, strideBytes, base + offsets[i]);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        pointedAt = first;
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, shapeFirst[shape], shapeCount[shape], count);
      // Unbind so another effect's element-buffer binding can't land in this VAO.
      gl.bindVertexArray(null);
    },
    dispose: () => {
      scope.dispose();
    },
  };
}
