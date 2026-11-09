import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import { HASH32_GLSL } from "../noise";
import {
  AGENT_FLOATS,
  agentCount,
  BASE_CELL,
  buildPaletteLut,
  CALM_DECAY,
  CALM_REPEL,
  depositAmount,
  FOOD_COUNT,
  FOOD_RADIUS,
  FOOD_STRENGTH,
  foodPositions,
  gridSize,
  JITTER,
  LUT_SIZE,
  MAX_STEPS,
  SENSOR_ANGLE,
  SENSOR_DISTANCE,
  seedAgents,
  STEP_RATE,
  type StepClock,
  stepSalt,
  takeSteps,
  TRAIL_MAX,
  TURN_ANGLE,
} from "./physarum-sim";
import { physarumMeta } from "./physarum.meta";
import { defineEffect } from "../types";

/** Offset of the four glow taps from the centre tap, in trail cells (diagonally). */
const GLOW_CELLS = 2.5;
/** Weight of the glow taps' mean against the centre tap. */
const GLOW_WEIGHT = 0.6;
/** Tone-map gain: palette position t = 1 - exp(-GAIN * (trail + glow)). */
const GAIN = 0.45;
/**
 * The R8 fallback stores trail / TRAIL_MAX, so it saturates where the float path
 * clamps. Deposits below one 8-bit step would round away, so they are raised to
 * MIN_DEPOSIT_8BIT (stored units), and the diffuse pass subtracts
 * DECAY_FLOOR_8BIT each step, since `v * keep` rounds back to `v` for small
 * values and faint trails would otherwise never fade.
 */
const MIN_DEPOSIT_8BIT = 1.5 / 255;
const DECAY_FLOOR_8BIT = 1 / 255;

/** GLSL twin of `calmMask` in physarum-sim.ts. */
const CALM_GLSL = /* glsl */ `
float calmMask(vec2 uv) {
  return (1.0 - smoothstep(0.1, 0.22, abs(uv.x - 0.5))) * (1.0 - smoothstep(0.7, 0.88, uv.y));
}
`;

/**
 * Agent update and deposit in one draw of GL_POINTS, one vertex per agent. The
 * vertex shader senses the previous trail map at three points, turns, moves and
 * writes the new agent to transform feedback (vAgent); the rasterizer then drops
 * a one-cell point at the new position into the freshly diffused trail map, which
 * the fragment shader adds `uDeposit` to (blend ONE, ONE). Mirrors the agent
 * half of `physarumStep` in physarum-sim.ts.
 */
const AGENT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec3 aAgent;
uniform sampler2D uTrail;
/** Trail grid size in cells. */
uniform vec2 uGrid;
/** Cells per step. */
uniform float uSpeed;
uniform uint uSalt;
uniform vec2 uFood[${String(FOOD_COUNT)}];
uniform float uFoodOn;
uniform float uCalmOn;
/** Grid width / height. */
uniform float uAspect;
/** Trail units per stored unit: 1, or TRAIL_MAX for the R8 fallback. */
uniform float uRange;
out vec3 vAgent;
${HASH32_GLSL}
${CALM_GLSL}
const float TAU = 6.283185307179586;
float sense(vec2 p, float a) {
  vec2 uv = fract(p + vec2(cos(a), sin(a)) * (${glslFloat(SENSOR_DISTANCE)} / uGrid));
  float s = textureLod(uTrail, uv, 0.0).r * uRange;
  if (uFoodOn > 0.0) {
    for (int i = 0; i < ${String(FOOD_COUNT)}; i++) {
      vec2 d = (uv - uFood[i]) * vec2(uAspect, 1.0);
      s += ${glslFloat(FOOD_STRENGTH)} * exp(-dot(d, d) * ${glslFloat(1 / (FOOD_RADIUS * FOOD_RADIUS))});
    }
  }
  return s - uCalmOn * ${glslFloat(CALM_REPEL)} * calmMask(uv);
}
void main() {
  vec2 p = aAgent.xy;
  float a = aAgent.z;
  float f = sense(p, a);
  float l = sense(p, a + ${glslFloat(SENSOR_ANGLE)});
  float r = sense(p, a - ${glslFloat(SENSOR_ANGLE)});
  uint bits = hash32(uint(gl_VertexID) + uSalt);
  float t;
  if (f >= l && f >= r) t = 0.0;
  else if (f < l && f < r) t = (bits & 1u) == 0u ? ${glslFloat(TURN_ANGLE)} : ${glslFloat(-TURN_ANGLE)};
  else if (l > r) t = ${glslFloat(TURN_ANGLE)};
  else t = ${glslFloat(-TURN_ANGLE)};
  t += (float(bits >> 16u) / 65536.0 - 0.5) * ${glslFloat(JITTER)};
  float na = fract((a + t) / TAU) * TAU;
  vec2 np = fract(p + vec2(cos(na), sin(na)) * (uSpeed / uGrid));
  vAgent = vec3(np, na);
  vec2 cell = (floor(np * uGrid) + 0.5) / uGrid;
  gl_Position = vec4(cell * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;

const DEPOSIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uDeposit;
out vec4 outColor;
void main() {
  outColor = vec4(uDeposit, 0.0, 0.0, 1.0);
}
`;

/**
 * Diffuse and decay, one fragment per trail cell: a 1-2-1 3x3 blur from four
 * bilinear taps at the cell's corners (the target wraps, so edges wrap), times
 * the keep factor, less in the calm centre. Mirrors the first half of
 * `physarumStep`.
 */
const DIFFUSE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTrail;
/** Half a cell in uv. */
uniform vec2 uHalf;
uniform float uKeep;
uniform float uCalmOn;
uniform float uFloor;
uniform float uMax;
out vec4 outColor;
${CALM_GLSL}
void main() {
  float b = texture(uTrail, vUv + vec2(-uHalf.x, -uHalf.y)).r
    + texture(uTrail, vUv + vec2(uHalf.x, -uHalf.y)).r
    + texture(uTrail, vUv + vec2(-uHalf.x, uHalf.y)).r
    + texture(uTrail, vUv + vec2(uHalf.x, uHalf.y)).r;
  float k = uKeep * (1.0 - uCalmOn * ${glslFloat(CALM_DECAY)} * calmMask(vUv));
  outColor = vec4(clamp(0.25 * b * k - uFloor, 0.0, uMax), 0.0, 0.0, 1.0);
}
`;

/**
 * Full-resolution composite: the bilinear trail plus a soft glow from four wider
 * taps, tone-mapped and looked up in the palette, with sub-LSB dither.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTrail;
uniform sampler2D uPalette;
/** Glow tap offset in uv. */
uniform vec2 uGlow;
/** Tone-map gain per stored unit. */
uniform float uGain;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float v = texture(uTrail, vUv).r;
  float g = texture(uTrail, vUv + uGlow).r
    + texture(uTrail, vUv - uGlow).r
    + texture(uTrail, vUv + vec2(uGlow.x, -uGlow.y)).r
    + texture(uTrail, vUv + vec2(-uGlow.x, uGlow.y)).r;
  float x = v + ${glslFloat(GLOW_WEIGHT * 0.25)} * g;
  float t = 1.0 - exp(-x * uGain);
  vec3 c = texture(uPalette, vec2(t * ${glslFloat((LUT_SIZE - 1) / LUT_SIZE)} + ${glslFloat(0.5 / LUT_SIZE)}, 0.5)).rgb;
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Slime mould: glowing vein networks from a Physarum agent model (Jones 2010).
 *
 * The trail map is a ping-pong pair of low-resolution targets (R16F when half
 * floats are renderable, else R8), one cell per BASE_CELL * scale reference
 * pixels, so the grid is the same size at every output resolution. Agents
 * (x, y, heading) live in two float32 vertex buffers, updated with transform
 * feedback rather than in a float texture: vertex buffers are float32 on every
 * WebGL2 device, with no float-render-target extension, and the updated agents
 * can be drawn straight back as the deposit points. So each step is two passes:
 *
 * 1. Diffuse and decay the trail into the other target (4 bilinear taps per cell).
 * 2. One draw of N points: sense the old trail, turn, move, capture the agent with
 *    transform feedback, and deposit a point into the new trail (blend ONE, ONE).
 *
 * Steps run at a fixed STEP_RATE (30 per second, at most MAX_STEPS a frame), below
 * the display rate. A full-resolution composite maps the trail through a palette
 * lookup with a glow. A resize, scale change or agent-tier change reseeds the
 * network rather than resampling it.
 */
export const physarum = defineEffect(physarumMeta, {
  create(gl) {
    return withScope((scope) => {
      // Half-float trail if it's renderable (and so blendable) here, else R8.
      const floatExt =
        gl.getExtension("EXT_color_buffer_float") !== null ||
        gl.getExtension("EXT_color_buffer_half_float") !== null;
      let r8 = true;
      if (floatExt) {
        const probe = createRenderTarget(gl, 1, 1, gl.R16F);
        if (probe) {
          r8 = false;
          probe.dispose();
        }
      }
      const trailFormat = r8 ? gl.R8 : gl.R16F;
      /** Trail units per stored unit. */
      const range = r8 ? TRAIL_MAX : 1;

      const program = (fragment: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fragment);
      const diffuseProgram = program(DIFFUSE_FRAGMENT);
      const compositeProgram = program(COMPOSITE_FRAGMENT);
      const agentProgram = scopedProgram(gl, scope, AGENT_VERTEX, DEPOSIT_FRAGMENT, ["vAgent"]);
      const diffuse = createUniforms(gl, diffuseProgram, [
        "uTrail",
        "uHalf",
        "uKeep",
        "uCalmOn",
        "uFloor",
        "uMax",
      ]);
      const composite = createUniforms(gl, compositeProgram, [
        "uTrail",
        "uPalette",
        "uGlow",
        "uGain",
      ]);
      const agent = createUniforms(gl, agentProgram, [
        "uTrail",
        "uGrid",
        "uSpeed",
        "uSalt",
        "uFood",
        "uFoodOn",
        "uCalmOn",
        "uAspect",
        "uDeposit",
        "uRange",
      ]);
      gl.useProgram(diffuseProgram);
      diffuse.i1("uTrail", 0);
      diffuse.f1("uFloor", r8 ? DECAY_FLOOR_8BIT : 0);
      diffuse.f1("uMax", TRAIL_MAX / range);
      gl.useProgram(compositeProgram);
      composite.i1("uTrail", 0);
      composite.i1("uPalette", 1);
      composite.f1("uGain", GAIN * range);
      gl.useProgram(agentProgram);
      agent.i1("uTrail", 0);
      agent.f1("uRange", range);
      gl.useProgram(null);

      const triangle = scope.own(createFullscreenTriangle(gl));
      const lutBytes = new Uint8Array(LUT_SIZE * 4);
      const lut = scope.add(
        createDataTexture(gl, {
          width: LUT_SIZE,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPaletteLut("gold", lutBytes),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      let paletteKey = "gold";

      // Agents: two ping-ponged vertex buffers, each with a VAO reading it.
      const buffers = [0, 1].map(() =>
        scope.add(gl.createBuffer(), (b) => {
          gl.deleteBuffer(b);
        }),
      );
      const vaos = buffers.map((buffer) => {
        const vao = scope.add(gl.createVertexArray(), (v) => {
          gl.deleteVertexArray(v);
        });
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, AGENT_FLOATS * 4, 0);
        return vao;
      });
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const feedback = scope.add(gl.createTransformFeedback(), (t) => {
        gl.deleteTransformFeedback(t);
      });
      let agentCur = 0;
      /** Agents in the buffers; 0 until the first frame. */
      let agents = 0;

      /** The trail ping-pong pair; empty until the first frame, or if allocation failed. */
      let targets: RenderTarget[] = [];
      let current = 0;
      let gridW = 0;
      let gridH = 0;
      const deleteTargets = () => {
        for (const t of targets) {
          t.dispose();
        }
        targets = [];
      };
      scope.defer(deleteTargets);

      let width = 1;
      let height = 1;
      let scale = 1;
      const clock: StepClock = { acc: 0 };
      let step = 0;
      let seedNo = 0;
      /** Simulation seconds, unwrapped (float64), for the food paths. */
      let simTime = 0;
      const food = new Float32Array(FOOD_COUNT * 2);
      const INVALIDATE = [gl.COLOR_ATTACHMENT0];

      /** Scatters `agents` fresh agents into the current buffer and sizes the other. */
      const seed = () => {
        const data = seedAgents(++seedNo, agents, new Float32Array(agents * AGENT_FLOATS));
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers[0]);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers[1]);
        gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_COPY);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        agentCur = 0;
      };

      /** New, cleared trail targets of `w` x `h`; a failed allocation leaves none. */
      const regrid = (w: number, h: number) => {
        deleteTargets();
        gridW = w;
        gridH = h;
        const opts = { filter: gl.LINEAR, wrap: gl.REPEAT };
        const a = createRenderTarget(gl, w, h, trailFormat, opts);
        const b = a && createRenderTarget(gl, w, h, trailFormat, opts);
        if (!a || !b) {
          a?.dispose();
          console.warn(`physarum: can't allocate a ${String(w)}x${String(h)} trail grid`);
          return;
        }
        targets = [a, b];
        current = 0;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const [w, h] = gridSize(width, height, BASE_CELL * p.scale * scale);
          const count = agentCount(p.agents);
          let reseed = false;
          if (w !== gridW || h !== gridH) {
            regrid(w, h);
            reseed = true;
          }
          if (count !== agents) {
            agents = count;
            reseed = true;
          }
          if (reseed) {
            seed();
          }

          if (p.palette !== paletteKey) {
            paletteKey = p.palette;
            gl.activeTexture(gl.TEXTURE1);
            updateDataTexture(
              gl,
              lut,
              LUT_SIZE,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              buildPaletteLut(paletteKey, lutBytes),
            );
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
          }
          if (targets.length < 2) {
            gl.clearColor(lutBytes[0] / 255, lutBytes[1] / 255, lutBytes[2] / 255, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
          }

          const n = takeSteps(clock, STEP_RATE, dt, MAX_STEPS);
          gl.activeTexture(gl.TEXTURE0);
          if (n > 0) {
            const deposit = depositAmount(p.decay, w * h, agents);
            gl.useProgram(diffuseProgram);
            diffuse.f2("uHalf", 0.5 / w, 0.5 / h);
            diffuse.f1("uKeep", 1 - p.decay);
            diffuse.f1("uCalmOn", p.calmCentre ? 1 : 0);
            gl.useProgram(agentProgram);
            agent.f2("uGrid", w, h);
            agent.f1("uSpeed", p.speed);
            agent.f1("uFoodOn", p.food ? 1 : 0);
            agent.f1("uCalmOn", p.calmCentre ? 1 : 0);
            agent.f1("uAspect", w / h);
            agent.f1("uDeposit", r8 ? Math.max(deposit / range, MIN_DEPOSIT_8BIT) : deposit);
            gl.blendFunc(gl.ONE, gl.ONE);
            for (let i = 0; i < n; i++) {
              const src = targets[current];
              current ^= 1;
              const dst = targets[current];

              // 1. Diffuse and decay src into dst.
              dst.bind();
              gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
              gl.useProgram(diffuseProgram);
              gl.bindTexture(gl.TEXTURE_2D, src.texture);
              triangle.draw();

              // 2. Agents sense src, move into the other buffer and deposit into dst.
              gl.useProgram(agentProgram);
              agent.u1("uSalt", stepSalt(step));
              if (p.food) {
                foodPositions(simTime, food);
                gl.uniform2fv(agent.loc.uFood, food);
              }
              gl.enable(gl.BLEND);
              gl.bindVertexArray(vaos[agentCur]);
              gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
              gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[agentCur ^ 1]);
              gl.beginTransformFeedback(gl.POINTS);
              gl.drawArrays(gl.POINTS, 0, agents);
              gl.endTransformFeedback();
              gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
              gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
              gl.bindVertexArray(null);
              gl.disable(gl.BLEND);
              agentCur ^= 1;
              step = (step + 1) >>> 0;
              simTime += 1 / STEP_RATE;
            }
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(compositeProgram);
          composite.f2("uGlow", GLOW_CELLS / w, GLOW_CELLS / h);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, lut);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, targets[current].texture);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
