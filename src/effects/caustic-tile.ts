/**
 * The tileable caustic pattern shared by Caustics, Aquarium, Submarine and Koi: an
 * R8 tile, re-rendered at a capped rate as its warp phases advance, plus the
 * two drifting layer offsets the composites sample it at.
 */

import { advancePhases, CAUSTIC_RATES } from "./caustics/caustics-sim";
import {
  createRenderTarget,
  type FullscreenTriangle,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  scopedProgram,
  withScope,
} from "./gl";
import { wrap } from "./math";

/**
 * One period of the iterated sine-warp caustic (after Dave Hoskins' tileable water
 * caustic), into an R8 tile. Every term is 2π-periodic in `p`, so the tile repeats
 * seamlessly. The original `1 / length(p * k / sin, p * k / cos)` uses the
 * near-constant `p * k` (about 1.23) and is rewritten as
 * `|s c| / (k * sqrt(s² + c²))`, which has no division by zero.
 */
export function tileFragment(iterations: number): string {
  let body = "";
  for (let n = 0; n < iterations; n++) {
    body += `
  t = uT[${String(n)}];
  i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
  s = sin(i.x + t);
  k = cos(i.y + t);
  c += abs(s * k) * inversesqrt(s * s + k * k + 1e-6);`;
  }
  return /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uT[${String(iterations)}];
out vec4 outColor;
void main() {
  vec2 p = vUv * 6.28318530718;
  vec2 i = p;
  float c = 0.0;
  float t;
  float s;
  float k;${body}
  c = (1.0 + c * ${glslFloat(1 / 1.23)}) * ${glslFloat(1 / iterations)};
  float v = pow(max(1.17 - pow(c, 1.4), 0.0), 8.0);
  outColor = vec4(clamp(v * 0.75 - 0.08, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;
}

export interface CausticTileOptions {
  /** Seconds between re-renders while moving (at least 0.9 of it passes first). */
  interval: number;
  /** Phase units per second of `advance`'s `dt`, before each iteration's rate. */
  rate: number;
  /** Drift of layers A and B in tile periods per second of `advance`'s `dt`. */
  driftA: readonly [number, number];
  /** Defaults to none, for a composite that samples one layer. */
  driftB?: readonly [number, number];
  /** Phase rate of each warp iteration, one iteration per entry. Defaults to `CAUSTIC_RATES`. */
  rates?: readonly number[];
}

export interface CausticTile {
  /** The tile texture (R8, REPEAT); null until `resize`, or if that failed. */
  readonly texture: WebGLTexture | null;
  /** Layer offsets in tile periods, wrapped to 0..1: A's x and y, then B's. */
  readonly offsets: Float64Array;
  /**
   * Makes the tile `res` x `res` texels if it isn't already; the next `update`
   * then renders it. Returns false if it can't be allocated.
   */
  resize: (res: number) => boolean;
  /** Advances the warp phases and layer offsets by `dt` (scaled by the effect's speed). */
  advance: (dt: number) => void;
  /**
   * Ages the tile by `dt` and re-renders it if it's new, or if `moving` and an
   * interval has passed; never while `visible` is false. Returns true if it
   * rendered, leaving the default framebuffer bound and the viewport the tile's.
   */
  update: (dt: number, moving: boolean, visible?: boolean) => boolean;
  dispose: () => void;
}

/** A caustic tile drawn with `triangle`; call `resize` before the first `update`. */
export function createCausticTile(
  gl: WebGL2RenderingContext,
  triangle: FullscreenTriangle,
  options: CausticTileOptions,
): CausticTile {
  return withScope((scope) => {
    const { interval, rate, driftA, driftB = [0, 0], rates = CAUSTIC_RATES } = options;
    const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, tileFragment(rates.length));
    const uT = gl.getUniformLocation(program, "uT");
    const phases = new Float32Array(rates.length);
    const offsets = new Float64Array(4);
    let tile: RenderTarget | null = null;
    scope.defer(() => tile?.dispose());
    let age = 0;
    let dirty = true;
    return {
      get texture() {
        return tile?.texture ?? null;
      },
      offsets,
      resize(res) {
        if (res === tile?.width) {
          return true;
        }
        tile?.dispose();
        tile = null;
        tile = createRenderTarget(gl, res, res, gl.R8, { wrap: gl.REPEAT });
        dirty = true;
        return tile !== null;
      },
      advance(dt) {
        advancePhases(phases, dt * rate, rates);
        offsets[0] = wrap(offsets[0] + driftA[0] * dt, 0, 1);
        offsets[1] = wrap(offsets[1] + driftA[1] * dt, 0, 1);
        offsets[2] = wrap(offsets[2] + driftB[0] * dt, 0, 1);
        offsets[3] = wrap(offsets[3] + driftB[1] * dt, 0, 1);
      },
      update(dt, moving, visible = true) {
        age += dt;
        if (!tile || !visible || !(dirty || (moving && age >= interval * 0.9))) {
          return false;
        }
        age = 0;
        dirty = false;
        tile.bind();
        gl.useProgram(program);
        gl.uniform1fv(uT, phases);
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return true;
      },
      dispose: () => {
        scope.dispose();
      },
    };
  });
}
