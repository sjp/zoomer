import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
  floatRenderable,
} from "../gl";
import {
  ATTRACT_MAX,
  attractorAt,
  BIRD_FLOATS,
  birdCounts,
  type BirdCounts,
  BOUNDARY_GLSL,
  buildHorizon,
  CRUISE,
  fieldEncoding,
  type FieldEncoding,
  FLOCK_MAX,
  gridSize,
  HORIZON_COLUMNS,
  MAX_STEPS,
  NOISE_ACCEL,
  PRED_RADIUS,
  predatorAt,
  seedBirds,
  skyFor,
  SPEED_K,
  steeringAt,
  steeringWeights,
  type SteeringWeights,
  STEP_RATE,
  type StepClock,
  SWIRL_REACH,
  takeSteps,
  VMAX,
} from "./murmuration-sim";
import { MAX_BIRDS, murmurationMeta } from "./murmuration.meta";
import { HASH32_GLSL, hash32 } from "../noise";
import { defineEffect } from "../types";
import { createPingPong, createFeedbackPair } from "../gpu-sim";

/** Bird dot diameter at 1080p, device pixels, before the per-bird 0.7-1.3 size jitter. */
const BIRD_PX = 1.6;
/** Opacity of one dot; overlapping dots build to near-solid in dense bands. */
const BIRD_ALPHA = 0.6;

/**
 * Splat: one point per bird into the field grid (blend ONE, ONE), adding the
 * encoded velocity and a count (see `fieldEncoding`). Birds whose index isn't a
 * multiple of uStride are dropped outside the clip volume.
 */
const SPLAT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aBird;
uniform float uAspect;
uniform int uStride;
uniform float uQuantise;
uniform float uDeposit;
uniform uint uSalt;
out vec3 vValue;
${HASH32_GLSL}
void main() {
  gl_PointSize = 1.0;
  if (gl_VertexID % uStride != 0) {
    vValue = vec3(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 vn = clamp(aBird.zw * ${glslFloat(1 / VMAX)}, -1.0, 1.0);
  vec2 e = 0.5 + 0.5 * vn;
  if (uQuantise > 0.5) {
    uint h = hash32(uint(gl_VertexID) + uSalt);
    vec2 r = vec2(float(h & 0xffffu), float(h >> 16u)) / 65536.0;
    e = floor(1.0 + vn + r) * 0.5;
  }
  vValue = vec3(e, 1.0) * uDeposit;
  gl_Position = vec4(aBird.x / uAspect * 2.0 - 1.0, aBird.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPLAT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec3 vValue;
out vec4 outColor;
void main() {
  outColor = vec4(vValue, 0.0);
}
`;

/** A 1-2-1 3x3 blur of the field grid from four bilinear taps at the cell's corners. */
const BLUR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uField;
/** Half a cell in uv. */
uniform vec2 uHalf;
out vec4 outColor;
void main() {
  outColor = 0.25 * (texture(uField, vUv + vec2(-uHalf.x, -uHalf.y))
    + texture(uField, vUv + vec2(uHalf.x, -uHalf.y))
    + texture(uField, vUv + vec2(-uHalf.x, uHalf.y))
    + texture(uField, vUv + vec2(uHalf.x, uHalf.y)));
}
`;

/**
 * Bird update, one vertex per bird, captured with transform feedback (the
 * rasterizer is off). Reads the blurred field at the bird and one cell either
 * side on each axis, and sums the steering terms (see murmuration-sim.ts).
 */
const UPDATE_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec4 aBird;
uniform sampler2D uField;
/** One cell in uv. */
uniform vec2 uCell;
uniform float uAspect;
uniform float uRhoScale;
/** Simulation seconds per step. */
uniform float uDt;
uniform float uAlign;
uniform float uFlock;
uniform float uRhoEq;
uniform vec2 uAttractor;
/** Attractor spring rates (x, y) and swirl. */
uniform vec3 uSteer;
/** Predator x, y and strength. */
uniform vec3 uPredator;
uniform uint uSalt;
out vec4 vBird;
${HASH32_GLSL}
${BOUNDARY_GLSL}
float density(vec2 uv) {
  return textureLod(uField, uv, 0.0).b * uRhoScale;
}
vec2 clampLength(vec2 v, float m) {
  float l = length(v);
  return l > m ? v * (m / l) : v;
}
void main() {
  vec2 p = aBird.xy;
  vec2 v = aBird.zw;
  vec2 uv = vec2(p.x / uAspect, p.y);
  vec4 f = textureLod(uField, uv, 0.0);
  float rho = f.b * uRhoScale;

  // Alignment, trusted only where there are birds to average.
  vec2 meanV = (2.0 * f.rg / max(f.b, 1e-6) - 1.0) * ${glslFloat(VMAX)};
  vec2 acc = (meanV - v) * (uAlign * smoothstep(0.0, 1.0, rho));

  // Cohesion below the target density, separation above it.
  vec2 dx = vec2(uCell.x, 0.0);
  vec2 dy = vec2(0.0, uCell.y);
  vec2 grad = vec2(
    (density(uv + dx) - density(uv - dx)) / (2.0 * uCell.x * uAspect),
    (density(uv + dy) - density(uv - dy)) / (2.0 * uCell.y));
  acc += clampLength(grad * (uFlock * (1.0 - rho / uRhoEq) / (rho + 1.0)), ${glslFloat(FLOCK_MAX)});

  // The wandering attractor, with a swirl around it.
  vec2 d = uAttractor - p;
  acc += clampLength(d * uSteer.xy, ${glslFloat(ATTRACT_MAX)});
  vec2 arm = clampLength(d, ${glslFloat(SWIRL_REACH)});
  acc += vec2(-arm.y, arm.x) * uSteer.z;

  acc += boundaryForce(p, uAspect);

  vec2 q = p - uPredator.xy;
  float ql = length(q);
  acc += q / max(ql, 1e-3) * (uPredator.z * exp(-ql * ql * ${glslFloat(1 / (PRED_RADIUS * PRED_RADIUS))}));

  // Relax towards cruising speed, plus a little noise so birds don't lock step.
  float s = length(v);
  acc += v / max(s, 1e-4) * ((${glslFloat(CRUISE)} - s) * ${glslFloat(SPEED_K)});
  uint h = hash32(uint(gl_VertexID) + uSalt);
  acc += (vec2(float(h & 0xffffu), float(h >> 16u)) / 65535.0 - 0.5) * ${glslFloat(NOISE_ACCEL)};

  v = clampLength(v + acc * uDt, ${glslFloat(VMAX)});
  vBird = vec4(p + v * uDt, v);
}
`;

const NULL_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}
`;

/**
 * Sky gradient (horizon, a third of the way up, top) with the horizon silhouette
 * from the column table, anti-aliased with the screen-space slope of its edge.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uHorizon;
uniform vec3 uLow;
uniform vec3 uMid;
uniform vec3 uTop;
uniform vec3 uLand;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec3 c = mix(uLow, uMid, smoothstep(0.0, 0.35, vUv.y));
  c = mix(c, uTop, smoothstep(0.3, 1.0, vUv.y));
  float edge = texture(uHorizon, vec2(vUv.x, 0.5)).r - vUv.y;
  c = mix(c, uLand, clamp(edge / max(fwidth(edge), 1e-5) + 0.5, 0.0, 1.0));
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Birds as soft dots, extrapolated from the last step by uLead seconds. */
const BIRD_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aBird;
uniform float uAspect;
uniform float uLead;
/** Mean dot diameter, device pixels. */
uniform float uSize;
out float vRadius;
out float vSpan;
${HASH32_GLSL}
void main() {
  vec2 p = aBird.xy + aBird.zw * uLead;
  float k = 0.7 + 0.6 * float(hash32(uint(gl_VertexID)) & 0xffffu) / 65535.0;
  float d = max(1.0, uSize * k);
  vRadius = 0.5 * d;
  vSpan = d + 1.0;
  gl_PointSize = vSpan;
  gl_Position = vec4(p.x / uAspect * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BIRD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vRadius;
in float vSpan;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * vSpan;
  outColor = vec4(uColor, ${glslFloat(BIRD_ALPHA)} * clamp(vRadius + 0.5 - r, 0.0, 1.0));
}
`;

/**
 * Starling murmuration: tens of thousands of dark dots flocking over a dusk sky.
 *
 * Birds (x, y, vx, vy in frame heights) live in two float32 vertex buffers,
 * updated with transform feedback as in physarum.ts, so no float render target
 * holds them. Neighbours come from a coarse field grid (RGBA16F where
 * renderable, else RGBA8 with the encoding in `fieldEncoding`). Each step, at a
 * fixed STEP_RATE:
 *
 * 1. Splat every drawn bird as a one-cell point into the cleared grid (blend ONE, ONE).
 * 2. Blur the grid twice (4 bilinear taps per cell).
 * 3. Update every bird from the field and the global steering, captured with
 *    transform feedback into the other buffer.
 *
 * Then the frame draws the sky and silhouette in one full-screen pass and the
 * birds as one point draw, each extrapolated along its velocity since the last
 * step so the motion stays smooth at any display rate.
 */
export const murmuration = defineEffect(murmurationMeta, {
  create(gl) {
    return withScope((scope) => {
      // Half-float field if it's renderable (and so blendable) here, else RGBA8.
      const float = floatRenderable(gl, gl.RGBA16F);
      const fieldFormat = float ? gl.RGBA16F : gl.RGBA8;

      const program = (vertex: string, fragment: string, varyings?: string[]) =>
        scopedProgram(gl, scope, vertex, fragment, varyings);
      const splatProgram = program(SPLAT_VERTEX, SPLAT_FRAGMENT);
      const blurProgram = program(FULLSCREEN_VERTEX, BLUR_FRAGMENT);
      const updateProgram = program(UPDATE_VERTEX, NULL_FRAGMENT, ["vBird"]);
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const birdProgram = program(BIRD_VERTEX, BIRD_FRAGMENT);
      const splat = createUniforms(gl, splatProgram, [
        "uAspect",
        "uStride",
        "uQuantise",
        "uDeposit",
        "uSalt",
      ]);
      const blur = createUniforms(gl, blurProgram, ["uField", "uHalf"]);
      const update = createUniforms(gl, updateProgram, [
        "uField",
        "uCell",
        "uAspect",
        "uRhoScale",
        "uDt",
        "uAlign",
        "uFlock",
        "uRhoEq",
        "uAttractor",
        "uSteer",
        "uPredator",
        "uSalt",
      ]);
      const sky = createUniforms(gl, skyProgram, ["uHorizon", "uLow", "uMid", "uTop", "uLand"]);
      const bird = createUniforms(gl, birdProgram, ["uAspect", "uLead", "uSize", "uColor"]);
      gl.useProgram(blurProgram);
      blur.i1("uField", 0);
      gl.useProgram(updateProgram);
      update.i1("uField", 0);
      gl.useProgram(skyProgram);
      sky.i1("uHorizon", 0);
      gl.useProgram(null);

      const triangle = scope.own(createFullscreenTriangle(gl));
      const horizon = scope.own(createColumnTable(gl, HORIZON_COLUMNS, 1));
      let horizonKey = "";
      let horizonAspect = 0;

      // Birds: two ping-ponged vertex buffers, stepped with transform feedback.
      const birds = scope.own(createFeedbackPair(gl, BIRD_FLOATS, [{ location: 0, size: 4 }]));
      let seeded = false;

      /** The field and its blur scratch; not ready until the first frame, or if allocation failed. */
      const field = scope.own(createPingPong(gl, fieldFormat));
      const regrid = (w: number, h: number) => {
        if (!field.resize(w, h)) {
          console.warn(`murmuration: can't allocate a ${String(w)}x${String(h)} field grid`);
        }
      };

      let width = 1;
      let height = 1;
      let scale = 1;
      const clock: StepClock = { acc: 0 };
      let step = 0;
      /** Simulation seconds, unwrapped (float64), for the attractor and predator. */
      let simTime = 0;
      const counts: BirdCounts = { draw: 0, update: 0 };
      const weights: SteeringWeights = { align: 0, flock: 0, rhoEq: 1, attract: 0 };
      const encoding: FieldEncoding = { stride: 1, deposit: 0, rhoScale: 1, quantise: 0 };
      const attractor = new Float32Array(2);
      const steer = new Float32Array(3);
      const predator = new Float32Array(3);

      const grid: [number, number] = [0, 0];

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          if (!seeded) {
            birds.seed(seedBirds(1, MAX_BIRDS, aspect, new Float32Array(MAX_BIRDS * BIRD_FLOATS)));
            seeded = true;
          }
          gridSize(aspect, grid);
          const w = grid[0];
          const h = grid[1];
          if (w !== field.width || h !== field.height) {
            regrid(w, h);
          }
          birdCounts(p.birds, p.quality, counts);
          const skyColors = skyFor(p.sky);

          const n = field.ready ? takeSteps(clock, STEP_RATE, dt, MAX_STEPS) : 0;
          const simDt = p.speed / STEP_RATE;
          if (n > 0) {
            fieldEncoding(float, counts.draw, w * h, encoding);
            steeringWeights(p.cohesion, weights);
            gl.useProgram(splatProgram);
            splat.f1("uAspect", aspect);
            splat.i1("uStride", encoding.stride);
            splat.f1("uQuantise", encoding.quantise);
            splat.f1("uDeposit", encoding.deposit);
            gl.useProgram(blurProgram);
            blur.f2("uHalf", 0.5 / w, 0.5 / h);
            gl.useProgram(updateProgram);
            update.f2("uCell", 1 / w, 1 / h);
            update.f1("uAspect", aspect);
            update.f1("uRhoScale", encoding.rhoScale);
            update.f1("uDt", simDt);
            update.f1("uAlign", weights.align);
            update.f1("uFlock", weights.flock);
            update.f1("uRhoEq", weights.rhoEq);
            gl.activeTexture(gl.TEXTURE0);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.clearColor(0, 0, 0, 0);
            const { src: a, dst: b } = field;
            for (let i = 0; i < n; i++) {
              const salt = hash32(step);

              // 1. Splat into a.
              a.bind();
              gl.clear(gl.COLOR_BUFFER_BIT);
              gl.useProgram(splatProgram);
              splat.u1("uSalt", salt);
              gl.enable(gl.BLEND);
              gl.bindVertexArray(birds.vao);
              gl.drawArrays(gl.POINTS, 0, counts.draw);
              gl.disable(gl.BLEND);

              // 2. Blur a into b and back.
              gl.useProgram(blurProgram);
              b.bind();
              gl.bindTexture(gl.TEXTURE_2D, a.texture);
              triangle.draw();
              a.bind();
              gl.bindTexture(gl.TEXTURE_2D, b.texture);
              triangle.draw();
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);

              // 3. Update every bird into the other buffer.
              gl.useProgram(updateProgram);
              attractorAt(simTime, aspect, attractor);
              steeringAt(simTime, weights.attract, steer);
              predatorAt(simTime, aspect, predator);
              update.f2("uAttractor", attractor[0], attractor[1]);
              update.f3("uSteer", steer[0], steer[1], steer[2]);
              update.f3("uPredator", predator[0], predator[1], predator[2]);
              update.u1("uSalt", hash32(salt));
              gl.bindTexture(gl.TEXTURE_2D, a.texture);
              gl.enable(gl.RASTERIZER_DISCARD);
              birds.step(counts.update);
              gl.disable(gl.RASTERIZER_DISCARD);
              step = (step + 1) >>> 0;
              simTime += simDt;
            }
            gl.bindTexture(gl.TEXTURE_2D, null);
          }

          // Sky and silhouette.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE0);
          if (p.horizon !== horizonKey || aspect !== horizonAspect) {
            horizonKey = p.horizon;
            horizonAspect = aspect;
            buildHorizon(horizonKey, aspect, horizon.data);
            horizon.upload();
          } else {
            gl.bindTexture(gl.TEXTURE_2D, horizon.texture);
          }
          gl.useProgram(skyProgram);
          sky.rgb("uLow", skyColors.low);
          sky.rgb("uMid", skyColors.mid);
          sky.rgb("uTop", skyColors.top);
          sky.rgb("uLand", skyColors.land);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);

          // Birds.
          gl.useProgram(birdProgram);
          bird.f1("uAspect", aspect);
          bird.f1("uLead", clock.acc * simDt);
          bird.f1("uSize", BIRD_PX * scale);
          bird.rgb("uColor", skyColors.bird);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.bindVertexArray(birds.vao);
          gl.drawArrays(gl.POINTS, 0, counts.draw);
          gl.bindVertexArray(null);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
