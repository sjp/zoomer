/**
 * GPU simulation plumbing: ping-pong render-target pairs and transform-feedback
 * buffer pairs. Kept out of `gl.ts`, which the app shell loads up front, so only
 * the simulations' chunks carry it.
 */

import { createRenderTarget, type RenderTarget, type RenderTargetOptions, withScope } from "./gl";

/** A pair of same-sized render targets that a simulation steps between. */
export interface PingPong {
  /** The size last passed to `resize` (0 before the first), allocated or not. */
  readonly width: number;
  readonly height: number;
  /** Whether a pair is allocated; `src` and `dst` throw while it isn't. */
  readonly ready: boolean;
  /** The target holding the latest state. */
  readonly src: RenderTarget;
  /** The other target, for the next step to write. */
  readonly dst: RenderTarget;
  /** Makes `dst` the latest state, after a step has written it. */
  swap: () => void;
  /**
   * Replaces the pair with two new, cleared `width` x `height` targets, with
   * `src` the first. Returns false if they can't be allocated, leaving no pair.
   * With `carry`, the new pair is allocated before the old one is freed, and
   * `carry(oldSrc, newSrc)` runs in between (if there was an old pair) to move
   * the state across; a failed allocation then keeps the old pair.
   */
  resize: (
    width: number,
    height: number,
    options?: {
      /** Overrides the format given to `createPingPong` from now on. */
      format?: GLenum;
      carry?: (from: RenderTarget, into: RenderTarget) => void;
    },
  ) => boolean;
  /** Frees the pair. `resize` can allocate a new one afterwards. */
  dispose: () => void;
}

/**
 * A ping-pong pair of `internalFormat` render targets, allocated by the first
 * `resize`. A step reads `src`, renders into `dst`, then calls `swap`.
 */
export function createPingPong(
  gl: WebGL2RenderingContext,
  internalFormat: GLenum,
  options: RenderTargetOptions = {},
): PingPong {
  let format = internalFormat;
  let targets: RenderTarget[] = [];
  let current = 0;
  let width = 0;
  let height = 0;
  const dispose = () => {
    for (const t of targets) {
      t.dispose();
    }
    targets = [];
  };
  const target = (i: number) => {
    const t = targets.at(i);
    if (!t) {
      throw new Error("WebGL: ping-pong pair used before it was allocated");
    }
    return t;
  };
  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get ready() {
      return targets.length === 2;
    },
    get src() {
      return target(current);
    },
    get dst() {
      return target(current ^ 1);
    },
    swap() {
      current ^= 1;
    },
    resize(w, h, o = {}) {
      format = o.format ?? format;
      width = w;
      height = h;
      const carry = o.carry;
      if (!carry) {
        dispose();
      }
      const a = createRenderTarget(gl, w, h, format, options);
      const b = a && createRenderTarget(gl, w, h, format, options);
      if (!a || !b) {
        a?.dispose();
        return false;
      }
      if (carry && targets.length === 2) {
        carry(targets[current], a);
      }
      dispose();
      targets = [a, b];
      current = 0;
      return true;
    },
    dispose,
  };
}

/** A float vertex attribute of each item in a `FeedbackPair`. */
export interface FeedbackAttrib {
  location: number;
  /** Floats in the attribute, 1 to 4. */
  size: number;
  /** Floats from the start of the item. Defaults to 0. */
  offset?: number;
}

/**
 * Two vertex buffers of interleaved float items that a transform-feedback
 * program steps between, each with a vertex array reading it.
 */
export interface FeedbackPair {
  readonly buffers: readonly [WebGLBuffer, WebGLBuffer];
  /** Index of the buffer holding the latest items. */
  readonly current: 0 | 1;
  /** The vertex array reading `buffers[current]`. */
  readonly vao: WebGLVertexArrayObject;
  /** Uploads `data` into both buffers, sizing them to it, and makes buffer 0 current. */
  seed: (data: Float32Array) => void;
  /**
   * Draws the first `count` items of the current buffer as points with the bound
   * program, captures its varyings into the other buffer, then makes that one
   * current. The caller sets up the program and any blend or rasterizer-discard
   * state; the vertex array, transform feedback and its buffer are unbound after.
   */
  step: (count: number) => void;
  dispose: () => void;
}

export function createFeedbackPair(
  gl: WebGL2RenderingContext,
  floatsPerItem: number,
  attribs: readonly FeedbackAttrib[],
): FeedbackPair {
  return withScope((scope) => {
    const buffer = () =>
      scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
    const buffers = [buffer(), buffer()] as const;
    const vaos = buffers.map((b) => {
      const vao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      for (const a of attribs) {
        gl.enableVertexAttribArray(a.location);
        gl.vertexAttribPointer(
          a.location,
          a.size,
          gl.FLOAT,
          false,
          floatsPerItem * 4,
          (a.offset ?? 0) * 4,
        );
      }
      return vao;
    });
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const feedback = scope.add(gl.createTransformFeedback(), (t) => {
      gl.deleteTransformFeedback(t);
    });
    let current: 0 | 1 = 0;
    return {
      buffers,
      get current() {
        return current;
      },
      get vao() {
        return vaos[current];
      },
      seed(data) {
        for (const b of buffers) {
          gl.bindBuffer(gl.ARRAY_BUFFER, b);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        current = 0;
      },
      step(count) {
        const next = current === 0 ? 1 : 0;
        gl.bindVertexArray(vaos[current]);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[next]);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.bindVertexArray(null);
        current = next;
      },
      dispose: () => {
        scope.dispose();
      },
    };
  });
}
