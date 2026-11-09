/**
 * The GPU side of the smoke model in smoke-sim.ts, shared by the effects that
 * draw rising smoke or steam (Incense Smoke, Steaming Mug): a density field in
 * two ping-ponged low-resolution targets, advanced in fixed steps along the
 * analytic velocity field, faded, and fed by up to two source splats.
 *
 * The grid covers a rectangle of "sim space" (`uRegion`: x0, y0, width,
 * height), in whatever units the caller picks; the velocity field's waves and
 * speeds are in those units. Incense Smoke maps the whole canvas in height
 * units; Steaming Mug maps a small box above the mug, scaled up so the curls
 * come out smaller on screen.
 */
import {
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  type Scope,
  typedParameters,
  type Uniforms,
} from "../gl";
import { hash32, HASH32_GLSL } from "../noise";
import { SIM_DT, SPLAT_CUTOFF, WAVE_COUNT, waveAmp, WAVES } from "./smoke-sim";

const vec4Of = (f: (i: number) => number) =>
  `vec4(${Array.from({ length: WAVE_COUNT }, (_, i) => glslFloat(f(i))).join(", ")})`;

/**
 * GLSL twin of `velocity` in smoke-sim.ts: the curl of a four-wave stream
 * function scaled by a smoothstep in height, plus the draft (growing with height)
 * and buoyancy. ALU only: four sines and four cosines.
 */
const VELOCITY_GLSL = /* glsl */ `
/** Wave numbers, and amplitudes (c / |k|) of the stream function's waves. */
const vec4 KX = ${vec4Of((i) => WAVES[i].kx)};
const vec4 KY = ${vec4Of((i) => WAVES[i].ky)};
const vec4 AMP = ${vec4Of(waveAmp)};
/** Phases of the waves, wrapped on the CPU. */
uniform vec4 uPhase;
/** Rise, draft at the top, curl strength. */
uniform vec3 uFlow;
/** Curl onset height and 1 / onset span. */
uniform vec2 uOnset;
vec2 velocity(vec2 p) {
  vec4 th = KX * p.x + KY * p.y + uPhase;
  vec4 s = AMP * sin(th);
  vec4 c = AMP * cos(th);
  float t = clamp((p.y - uOnset.x) * uOnset.y, 0.0, 1.0);
  float sv = uFlow.z * t * t * (3.0 - 2.0 * t);
  float ds = uFlow.z * 6.0 * t * (1.0 - t) * uOnset.y;
  float psiY = sv * dot(c, KY) + ds * (s.x + s.y + s.z + s.w);
  float psiX = sv * dot(c, KX);
  return vec2(psiY + uFlow.y * p.y, uFlow.x - psiX);
}
`;

const CUT = Math.exp(-0.5 * SPLAT_CUTOFF * SPLAT_CUTOFF);

/**
 * One fixed simulation step per cell: semi-Lagrangian advection of the density
 * along the velocity (midpoint backtrace, one bilinear fetch), a height-dependent
 * fade, and the source splats (`max`, so a source holds its density rather than
 * piling it up). `quantise` adds stochastic rounding for the 8-bit fallback,
 * whose slow fade would otherwise stall at a few LSBs above zero.
 */
const advectFragment = (quantise: boolean) => /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uField;
/** Sim-space rectangle the grid covers: x0, y0, width, height. */
uniform vec4 uRegion;
/** Emitters: x, y (sim units), segment half-width, strength (0: off). */
uniform vec4 uEmit0;
uniform vec4 uEmit1;
/** 1 / splat radius^2. */
uniform float uInvR2;
/** Wisps along a wide source: wave number, phase, amount. */
uniform vec3 uWisp;
/** Fade rate at y = 0 (1/s), and its extra per sim unit of height. */
uniform vec2 uDecay;
${quantise ? "uniform uint uSeed;" : ""}
in vec2 vUv;
out vec4 outColor;
${VELOCITY_GLSL}
${quantise ? HASH32_GLSL : ""}
const float DT = ${glslFloat(SIM_DT)};
float splat(vec2 d, vec4 e) {
  float ex = max(abs(d.x) - e.z, 0.0);
  float q = (ex * ex + d.y * d.y) * uInvR2;
  float s = max(exp(-0.5 * q) - ${glslFloat(CUT)}, 0.0) * ${glslFloat(1 / (1 - CUT))};
  return s * e.w * (1.0 - uWisp.z * (0.5 + 0.5 * sin(uWisp.x * (d.x + e.x) + uWisp.y)));
}
void main() {
  vec2 p = uRegion.xy + vUv * uRegion.zw;
  vec2 v1 = velocity(p);
  vec2 back = p - DT * velocity(p - 0.5 * DT * v1);
  vec2 uv = (back - uRegion.xy) / uRegion.zw;
  // Air drawn in from beyond the sides or the bottom is clear.
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y);
  float d = texture(uField, uv).r * inside;
  d *= exp(-DT * uDecay.x * (1.0 + uDecay.y * p.y));
  d = max(d, max(splat(p - uEmit0.xy, uEmit0), splat(p - uEmit1.xy, uEmit1)));
${
  quantise
    ? `  uvec2 c = uvec2(gl_FragCoord.xy);
  uint h = hash32((c.x + (c.y << 16)) ^ uSeed);
  d += (float(h) * ${glslFloat(1 / 4294967296)} - 0.5) * ${glslFloat(1 / 255)};`
    : ""
}
  outColor = vec4(clamp(d, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

export const SMOKE_FIELD_UNIFORMS = [
  "uField",
  "uRegion",
  "uPhase",
  "uFlow",
  "uOnset",
  "uEmit0",
  "uEmit1",
  "uInvR2",
  "uWisp",
  "uDecay",
  "uSeed",
] as const;
export type SmokeFieldUniform = (typeof SMOKE_FIELD_UNIFORMS)[number];

export interface SmokeField {
  /** The advection program; bind it and set `uniforms` before `advance`. */
  readonly program: WebGLProgram;
  readonly uniforms: Uniforms<SmokeFieldUniform>;
  /** Grid size in cells (as last requested, even if allocation failed). */
  readonly width: number;
  readonly height: number;
  /** The current density (R channel), or null if the grid couldn't be allocated. */
  readonly texture: WebGLTexture | null;
  /**
   * Sets the grid size. A change replaces the field with a clear one (no
   * resampling). Returns whether a field exists. Leaves GL state as it was.
   */
  resize: (width: number, height: number) => boolean;
  /**
   * Runs `n` fixed steps with the advection program, which must be bound with
   * its uniforms set. Uses texture unit 0 (the caller makes it active), and
   * leaves the last target's framebuffer bound and its viewport set.
   */
  advance: (n: number) => void;
}

/**
 * Builds a density field owned by `scope`: R16F when half floats are renderable
 * here, else R8 with stochastic rounding. `name` labels allocation warnings.
 */
export function createSmokeField(
  gl: WebGL2RenderingContext,
  scope: Scope,
  name: string,
): SmokeField {
  const floatExt =
    gl.getExtension("EXT_color_buffer_float") !== null ||
    gl.getExtension("EXT_color_buffer_half_float") !== null;
  let quantise = true;
  if (floatExt) {
    const probe = createRenderTarget(gl, 1, 1, gl.R16F);
    if (probe) {
      quantise = false;
      probe.dispose();
    }
  }
  const format = quantise ? gl.R8 : gl.R16F;

  const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, advectFragment(quantise)), (p) => {
    gl.deleteProgram(p);
  });
  // Only the 8-bit variant declares uSeed (for its dither).
  const uniforms = createUniforms<SmokeFieldUniform>(
    gl,
    program,
    quantise ? SMOKE_FIELD_UNIFORMS : SMOKE_FIELD_UNIFORMS.filter((n) => n !== "uSeed"),
  );
  const triangle = scope.own(createFullscreenTriangle(gl));
  const prevProgram = typedParameters(gl).getParameter(gl.CURRENT_PROGRAM);
  gl.useProgram(program);
  uniforms.i1("uField", 0);
  gl.useProgram(prevProgram);

  /** The ping-pong pair; empty until the first resize, or if allocation failed. */
  let targets: RenderTarget[] = [];
  let current = 0;
  let gridW = 0;
  let gridH = 0;
  let stepNo = 0;
  const deleteTargets = () => {
    for (const t of targets) {
      t.dispose();
    }
    targets = [];
  };
  scope.defer(deleteTargets);
  const INVALIDATE = [gl.COLOR_ATTACHMENT0];

  return {
    program,
    uniforms,
    get width() {
      return gridW;
    },
    get height() {
      return gridH;
    },
    get texture() {
      return targets.length === 2 ? targets[current].texture : null;
    },
    resize(w, h) {
      if (w === gridW && h === gridH) {
        return targets.length === 2;
      }
      deleteTargets();
      gridW = w;
      gridH = h;
      const a = createRenderTarget(gl, w, h, format);
      const b = a && createRenderTarget(gl, w, h, format);
      if (!a || !b) {
        a?.dispose();
        console.warn(`${name}: can't allocate a ${String(w)}x${String(h)} density field`);
        return false;
      }
      targets = [a, b];
      current = 0;
      return true;
    },
    advance(n) {
      if (targets.length < 2) {
        return;
      }
      for (let i = 0; i < n; i++) {
        const src = targets[current];
        current ^= 1;
        const dst = targets[current];
        dst.bind();
        // Every cell is overwritten, so tiled GPUs need not load the old contents.
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
        if (quantise) {
          uniforms.u1("uSeed", hash32(++stepNo));
        }
        gl.bindTexture(gl.TEXTURE_2D, src.texture);
        triangle.draw();
      }
    },
  };
}
