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
  type Uniforms,
  withScope,
  scopedProgram,
} from "../gl";
import {
  advanceOrbit,
  AIZAWA,
  anchorX,
  type AttractorSystem,
  buildTrajectory,
  CAM_DIST,
  CLEAN_8BIT,
  FADE_IN,
  flowStep,
  LORENZ,
  paletteFor,
  PARTICLE_FLOATS,
  respawnChance,
  seedParticles,
  SIZE,
  SUBSTEPS,
  systemFor,
  THOMAS,
  TILT,
  type Trajectory,
  trailKeep,
  TRAJ_H,
  TRAJ_SAMPLES,
  TRAJ_W,
} from "./lorenz-sim";
import { lorenzMeta, MAX_PARTICLES } from "./lorenz.meta";
import { hash32, HASH32_GLSL } from "../noise";
import { defineEffect } from "../types";

/** The trail layer is this many times smaller than the canvas on each axis. */
const TRAIL_DIVISOR = 2;
/** Trail line half-width at 1080p, device pixels. */
const TRAIL_HALF_PX = 1.4;
/** Light one trail segment adds to the layer at the reference particle count. */
const TRAIL_GAIN = 0.06;
/** Point diameter at 1080p, device pixels, at the centre's depth. */
const POINT_PX = 2;
/** Light one point adds at the reference particle count. */
const POINT_GAIN = 0.3;
/**
 * Gains scale with sqrt(REF_COUNT / particles), so more particles read denser
 * without the whole cloud saturating to white.
 */
const REF_COUNT = 30000;
/** Background at the centre and in the corners: a faint vignette. */
const BG_CENTRE = [0.03, 0.035, 0.058] as const;
const BG_EDGE = [0.006, 0.007, 0.013] as const;

/** `deriv(p)`: the selected system's velocity, as `deriv` in lorenz-sim.ts. */
const SYSTEM_GLSL = /* glsl */ `
uniform int uSystem;
vec3 deriv(vec3 p) {
  if (uSystem == 0) {
    return vec3(
      ${glslFloat(LORENZ.sigma)} * (p.y - p.x),
      p.x * (${glslFloat(LORENZ.rho)} - p.z) - p.y,
      p.x * p.y - ${glslFloat(LORENZ.beta)} * p.z);
  }
  if (uSystem == 1) {
    float zb = p.z - ${glslFloat(AIZAWA.b)};
    return vec3(
      zb * p.x - ${glslFloat(AIZAWA.d)} * p.y,
      ${glslFloat(AIZAWA.d)} * p.x + zb * p.y,
      ${glslFloat(AIZAWA.c)} + ${glslFloat(AIZAWA.a)} * p.z - p.z * p.z * p.z * ${glslFloat(1 / 3)}
        - (p.x * p.x + p.y * p.y) * (1.0 + ${glslFloat(AIZAWA.e)} * p.z)
        + ${glslFloat(AIZAWA.f)} * p.z * p.x * p.x * p.x);
  }
  return vec3(sin(p.y), sin(p.z), sin(p.x)) - ${glslFloat(THOMAS.b)} * p;
}
`;

/**
 * `view(p)`: screen position (frame heights from the canvas centre, y up), depth
 * towards the viewer and perspective factor, as `project` in lorenz-sim.ts plus
 * the anchor. `tint(p)`: the palette colour by wing or speed. `depthFade(dz)`:
 * far particles dimmer.
 */
const VIEW_GLSL = /* glsl */ `
uniform vec3 uCentre;
uniform float uNorm;
/** Camera yaw: cos, sin. */
uniform vec2 uYaw;
uniform float uAnchor;
uniform float uAspect;
uniform vec3 uWing;
/** Speed for colour: lo, 1 / (hi - lo). */
uniform vec2 uSpeed;
uniform float uBySpeed;
uniform vec3 uPalA;
uniform vec3 uPalB;
uniform float uPalC;
uniform vec3 uPalD;
vec4 view(vec3 p) {
  vec3 q = (p - uCentre) * uNorm;
  float u = q.x * uYaw.x - q.y * uYaw.y;
  float d = q.x * uYaw.y + q.y * uYaw.x;
  float y = q.z * ${glslFloat(Math.cos(TILT))} - d * ${glslFloat(Math.sin(TILT))};
  float dz = d * ${glslFloat(Math.cos(TILT))} + q.z * ${glslFloat(Math.sin(TILT))};
  float k = ${glslFloat(CAM_DIST)} / (${glslFloat(CAM_DIST)} - dz);
  return vec4(vec2(u, y) * (k * ${glslFloat(SIZE)}) + vec2(uAnchor, 0.0), dz, k);
}
vec3 tint(vec3 p) {
  float t = uBySpeed > 0.5
    ? clamp((length(deriv(p)) - uSpeed.x) * uSpeed.y, 0.0, 1.0)
    : smoothstep(-1.0, 1.0, dot((p - uCentre) * uNorm, uWing));
  return uPalA + uPalB * cos(6.2831853 * (uPalC * t + uPalD));
}
float depthFade(float dz) {
  return mix(0.35, 1.0, smoothstep(-1.0, 1.0, dz));
}
`;

const VIEW_UNIFORMS = [
  "uSystem",
  "uCentre",
  "uNorm",
  "uYaw",
  "uAnchor",
  "uAspect",
  "uWing",
  "uSpeed",
  "uBySpeed",
  "uPalA",
  "uPalB",
  "uPalC",
  "uPalD",
] as const;
type ViewUniform = (typeof VIEW_UNIFORMS)[number];

/**
 * Particle update, one vertex per particle, captured with transform feedback (the
 * rasterizer is off): SUBSTEPS RK4 steps, then a rare respawn at a random sample
 * of the stored trajectory, or at once if the particle left the attractor.
 */
const UPDATE_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec4 aParticle;
uniform vec3 uCentre;
uniform float uNorm;
/** System time per substep. */
uniform float uH;
/** Real seconds this frame, for the age. */
uniform float uDt;
uniform float uRespawn;
uniform uint uSalt;
uniform sampler2D uTraj;
out vec4 vParticle;
${HASH32_GLSL}
${SYSTEM_GLSL}
void main() {
  vec3 p = aParticle.xyz;
  for (int i = 0; i < ${String(SUBSTEPS)}; i++) {
    vec3 k1 = deriv(p);
    vec3 k2 = deriv(p + (0.5 * uH) * k1);
    vec3 k3 = deriv(p + (0.5 * uH) * k2);
    vec3 k4 = deriv(p + uH * k3);
    p += (uH / 6.0) * (k1 + 2.0 * (k2 + k3) + k4);
  }
  float age = aParticle.w + uDt;
  uint h = hash32(uint(gl_VertexID) + uSalt);
  float r = float(h >> 8u) * ${glslFloat(1 / 16777216)};
  vec3 q = (p - uCentre) * uNorm;
  // Written so NaN fails the bound too.
  if (r < uRespawn || !(dot(q, q) < 9.0)) {
    int s = int(hash32(h) % ${String(TRAJ_SAMPLES)}u);
    p = texelFetch(uTraj, ivec2(s % ${String(TRAJ_W)}, s / ${String(TRAJ_W)}), 0).xyz;
    age = 0.0;
  }
  vParticle = vec4(p, age);
}
`;

const NULL_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
out vec4 outColor;
void main() {
  outColor = vec4(0.0);
}
`;

/** Scales the trail layer down: dst * keep - clean (blend REVERSE_SUBTRACT, ONE, SRC_ALPHA). */
const FADE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
uniform vec2 uFade;
out vec4 outColor;
void main() {
  outColor = vec4(vec3(uFade.y), uFade.x);
}
`;

/**
 * One anti-aliased segment per particle, from its previous position to its new
 * one, into the trail layer. A particle that respawned (its age went down) draws
 * nothing, so no streak crosses the frame.
 */
const SEGMENT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aPrev;
layout(location = 1) in vec4 aCur;
/** Target size, pixels. */
uniform vec2 uTarget;
uniform float uHalfWidth;
uniform float uGain;
out float vSide;
out vec3 vColor;
const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
${SYSTEM_GLSL}
${VIEW_GLSL}
vec2 toPx(vec2 s) {
  return vec2(s.x / uAspect + 0.5, s.y + 0.5) * uTarget;
}
void main() {
  if (!(aCur.w > aPrev.w)) {
    vSide = 0.0;
    vColor = vec3(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 a = view(aPrev.xyz);
  vec4 b = view(aCur.xyz);
  vec2 p0 = toPx(a.xy);
  vec2 p1 = toPx(b.xy);
  vec2 c = CORNERS[gl_VertexID];
  vec2 d = p1 - p0;
  float len = length(d);
  d = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  float extent = uHalfWidth + 1.0;
  vec2 pos = mix(p0, p1, c.x) + n * (c.y * extent);
  vSide = c.y * extent;
  float fade = smoothstep(0.0, ${glslFloat(FADE_IN)}, aCur.w) * depthFade(b.z);
  vColor = tint(aCur.xyz) * (fade * uGain);
  gl_Position = vec4(pos / uTarget * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SEGMENT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vSide;
in vec3 vColor;
uniform float uHalfWidth;
out vec4 outColor;
void main() {
  float coverage = clamp(min(vSide + 0.5, uHalfWidth) - max(vSide - 0.5, -uHalfWidth), 0.0, 1.0);
  outColor = vec4(vColor * coverage, 0.0);
}
`;

/** Background with a faint vignette, plus the trail layer, soft-clipped and dithered. */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTrails;
uniform float uAspect;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec3 bg = mix(
    vec3(${BG_CENTRE.map((v) => glslFloat(v)).join(", ")}),
    vec3(${BG_EDGE.map((v) => glslFloat(v)).join(", ")}),
    smoothstep(0.15, 1.1, length(d)));
  vec3 t = texture(uTrails, vUv).rgb;
  outColor = vec4(bg + (1.0 - exp(-t)) + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Particles as small soft dots, additive, smaller and dimmer with distance. */
const POINT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aParticle;
/** Diameter at the centre's depth, device pixels. */
uniform float uSize;
uniform float uGain;
out vec3 vColor;
out float vRadius;
out float vSpan;
${SYSTEM_GLSL}
${VIEW_GLSL}
void main() {
  vec4 s = view(aParticle.xyz);
  float near = smoothstep(-1.0, 1.0, s.z);
  float d = max(1.0, uSize * s.w * mix(0.7, 1.0, near));
  vRadius = 0.5 * d;
  vSpan = d + 1.0;
  gl_PointSize = vSpan;
  float fade = smoothstep(0.0, ${glslFloat(FADE_IN)}, aParticle.w) * depthFade(s.z);
  vColor = tint(aParticle.xyz) * (fade * uGain);
  gl_Position = vec4(s.x * 2.0 / uAspect, s.y * 2.0, 0.0, 1.0);
}
`;

const POINT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
in float vRadius;
in float vSpan;
out vec4 outColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * vSpan;
  outColor = vec4(vColor * clamp(vRadius + 0.5 - r, 0.0, 1.0), 0.0);
}
`;

/**
 * Lorenz attractor: tens of thousands of particles stream around a chaotic
 * attractor (Lorenz, Aizawa or Thomas) while the camera orbits it.
 *
 * Particles (x, y, z in system coordinates, plus age) live in two float32 vertex
 * buffers, stepped with transform feedback as in physarum.ts and murmuration.ts
 * rather than in a float texture, so no float render target holds them. Each
 * frame:
 *
 * 1. Update: SUBSTEPS RK4 steps over the clamped frame time, with a rare respawn
 *    at a random sample of a long trajectory computed on the CPU (an RGBA32F
 *    texture), so coverage stays even as particles spread.
 * 2. Trails: scale the half-resolution trail layer down by blending (no
 *    ping-pong), then add one segment per particle from its old position to its
 *    new one.
 * 3. Composite the vignetted background and the trail layer to the canvas.
 * 4. Draw every particle as a soft additive dot at full resolution.
 */
export const lorenz = defineEffect(lorenzMeta, {
  create(gl) {
    return withScope((scope) => {
      // Half-float trails if renderable here (16F blending needs no extension), else RGBA8.
      const floatExt =
        gl.getExtension("EXT_color_buffer_float") !== null ||
        gl.getExtension("EXT_color_buffer_half_float") !== null;

      const program = (vertex: string, fragment: string, varyings?: string[]) =>
        scopedProgram(gl, scope, vertex, fragment, varyings);
      const updateProgram = program(UPDATE_VERTEX, NULL_FRAGMENT, ["vParticle"]);
      const fadeProgram = program(FULLSCREEN_VERTEX, FADE_FRAGMENT);
      const segmentProgram = program(SEGMENT_VERTEX, SEGMENT_FRAGMENT);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const pointProgram = program(POINT_VERTEX, POINT_FRAGMENT);
      const update = createUniforms(gl, updateProgram, [
        "uSystem",
        "uCentre",
        "uNorm",
        "uH",
        "uDt",
        "uRespawn",
        "uSalt",
        "uTraj",
      ]);
      const fade = createUniforms(gl, fadeProgram, ["uFade"]);
      const segment = createUniforms(gl, segmentProgram, [
        ...VIEW_UNIFORMS,
        "uTarget",
        "uHalfWidth",
        "uGain",
      ]);
      const composite = createUniforms(gl, compositeProgram, ["uTrails", "uAspect"]);
      const point = createUniforms(gl, pointProgram, [...VIEW_UNIFORMS, "uSize", "uGain"]);
      gl.useProgram(updateProgram);
      update.i1("uTraj", 0);
      gl.useProgram(compositeProgram);
      composite.i1("uTrails", 0);
      gl.useProgram(null);

      const triangle = scope.own(createFullscreenTriangle(gl));
      const trajTexture = scope.add(
        createDataTexture(gl, {
          width: TRAJ_W,
          height: TRAJ_H,
          internalFormat: gl.RGBA32F,
          format: gl.RGBA,
          type: gl.FLOAT,
          data: new Float32Array(TRAJ_SAMPLES * 4),
          filter: gl.NEAREST,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      // Particles: two ping-ponged vertex buffers. vaos[c] reads buffer c (update
      // and points); segVaos[c] reads the other buffer as the previous position.
      const buffers = [0, 1].map(() => {
        const b = scope.add(gl.createBuffer(), (x) => {
          gl.deleteBuffer(x);
        });
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, MAX_PARTICLES * PARTICLE_FLOATS * 4, gl.DYNAMIC_COPY);
        return b;
      });
      const stride = PARTICLE_FLOATS * 4;
      const vaos = buffers.map((buffer) => {
        const vao = scope.add(gl.createVertexArray(), (v) => {
          gl.deleteVertexArray(v);
        });
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
        return vao;
      });
      const segVaos = buffers.map((buffer, c) => {
        const vao = scope.add(gl.createVertexArray(), (v) => {
          gl.deleteVertexArray(v);
        });
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers[c ^ 1]);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(1, 1);
        return vao;
      });
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const feedback = scope.add(gl.createTransformFeedback(), (t) => {
        gl.deleteTransformFeedback(t);
      });
      let cur = 0;
      const seedData = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);

      /** Trajectories are deterministic, so each is built once, on first use. */
      const trajectories = new Map<AttractorSystem, Trajectory>();
      let system: AttractorSystem | undefined;
      let traj: Trajectory | undefined;

      /** The trail layer; null until the first frame, or if allocation failed. */
      let trails: RenderTarget | null = null;
      let trailFloat = floatExt;
      let trailW = 0;
      let trailH = 0;
      scope.defer(() => trails?.dispose());
      const ensureTrails = (w: number, h: number) => {
        if (w === trailW && h === trailH) {
          return;
        }
        trails?.dispose();
        trailW = w;
        trailH = h;
        trails = trailFloat ? createRenderTarget(gl, w, h, gl.RGBA16F) : null;
        if (!trails) {
          trailFloat = false;
          trails = createRenderTarget(gl, w, h, gl.RGBA8);
        }
        if (!trails) {
          console.warn(`lorenz: can't allocate a ${String(w)}x${String(h)} trail layer`);
        }
      };
      const clearTrails = () => {
        if (!trails) {
          return;
        }
        trails.bind();
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      let width = 1;
      let height = 1;
      let scale = 1;
      let yaw = 0.6;
      let frameNo = 0;

      const setView = (u: Uniforms<ViewUniform>, aspect: number, palette: string, side: string) => {
        if (!system || !traj) {
          return;
        }
        const pal = paletteFor(palette);
        u.i1("uSystem", system.index);
        u.f3("uCentre", traj.centre[0], traj.centre[1], traj.centre[2]);
        u.f1("uNorm", traj.norm);
        u.f2("uYaw", Math.cos(yaw), Math.sin(yaw));
        u.f1("uAnchor", anchorX(side, aspect));
        u.f1("uAspect", aspect);
        u.f3("uWing", system.wing[0], system.wing[1], system.wing[2]);
        u.f2("uSpeed", traj.speedLo, 1 / Math.max(1e-6, traj.speedHi - traj.speedLo));
        u.f1("uBySpeed", pal.bySpeed ? 1 : 0);
        u.f3("uPalA", pal.a[0], pal.a[1], pal.a[2]);
        u.f3("uPalB", pal.b[0], pal.b[1], pal.b[2]);
        u.f1("uPalC", pal.c);
        u.f3("uPalD", pal.d[0], pal.d[1], pal.d[2]);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          ensureTrails(
            Math.max(1, Math.ceil(width / TRAIL_DIVISOR)),
            Math.max(1, Math.ceil(height / TRAIL_DIVISOR)),
          );
          gl.activeTexture(gl.TEXTURE0);

          const next = systemFor(p.system);
          let moved = false;
          if (next !== system || !traj) {
            system = next;
            traj = trajectories.get(next);
            if (!traj) {
              traj = buildTrajectory(next);
              trajectories.set(next, traj);
            }
            updateDataTexture(gl, trajTexture, TRAJ_W, TRAJ_H, gl.RGBA, gl.FLOAT, traj.points);
            gl.bindTexture(gl.TEXTURE_2D, null);
            seedParticles(traj, MAX_PARTICLES, 1, seedData);
            for (const buffer of buffers) {
              gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
              gl.bufferSubData(gl.ARRAY_BUFFER, 0, seedData);
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            clearTrails();
          }
          const count = Math.max(1, Math.min(MAX_PARTICLES, Math.round(p.particles)));
          const gain = Math.sqrt(REF_COUNT / count);
          const step = Number.isFinite(dt) && dt > 0;

          // 1. Update every drawn particle into the other buffer.
          if (step) {
            gl.useProgram(updateProgram);
            update.i1("uSystem", system.index);
            update.f3("uCentre", traj.centre[0], traj.centre[1], traj.centre[2]);
            update.f1("uNorm", traj.norm);
            update.f1("uH", flowStep(dt, p.speed, system) / SUBSTEPS);
            update.f1("uDt", Math.min(dt, 1));
            update.f1("uRespawn", respawnChance(dt));
            frameNo = (frameNo + 1) >>> 0;
            update.u1("uSalt", hash32(frameNo));
            gl.bindTexture(gl.TEXTURE_2D, trajTexture);
            gl.enable(gl.RASTERIZER_DISCARD);
            gl.bindVertexArray(vaos[cur]);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[cur ^ 1]);
            gl.beginTransformFeedback(gl.POINTS);
            gl.drawArrays(gl.POINTS, 0, count);
            gl.endTransformFeedback();
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
            gl.disable(gl.RASTERIZER_DISCARD);
            gl.bindVertexArray(null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            cur ^= 1;
            moved = true;
          }
          yaw = advanceOrbit(yaw, dt, p.orbit);

          // 2. Fade the trail layer, then add this frame's segments.
          if (trails && moved) {
            trails.bind();
            gl.enable(gl.BLEND);
            gl.useProgram(fadeProgram);
            gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
            gl.blendFunc(gl.ONE, gl.SRC_ALPHA);
            fade.f2("uFade", trailKeep(dt), trailFloat ? 0 : CLEAN_8BIT);
            triangle.draw();
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(segmentProgram);
            setView(segment, aspect, p.palette, p.position);
            segment.f2("uTarget", trails.width, trails.height);
            segment.f1("uHalfWidth", Math.max(0.5, (TRAIL_HALF_PX * scale) / TRAIL_DIVISOR));
            segment.f1("uGain", TRAIL_GAIN * gain);
            gl.bindVertexArray(segVaos[cur]);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
            gl.bindVertexArray(null);
            gl.disable(gl.BLEND);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 3. Background and trails.
          gl.useProgram(compositeProgram);
          composite.f1("uAspect", aspect);
          gl.bindTexture(gl.TEXTURE_2D, trails ? trails.texture : null);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);

          // 4. Particles.
          gl.useProgram(pointProgram);
          setView(point, aspect, p.palette, p.position);
          point.f1("uSize", POINT_PX * scale);
          point.f1("uGain", POINT_GAIN * gain);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.bindVertexArray(vaos[cur]);
          gl.drawArrays(gl.POINTS, 0, count);
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
