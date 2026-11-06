import {
  buildCraneVertices,
  type Cranes,
  CRANE_VERTICES,
  createCranes,
  createInstanceScratch,
  HINGE_Y,
  INSTANCE_FLOATS,
  MAX_INSTANCES,
  PATTERN_DOTS,
  PATTERN_STRIPES,
  paletteFor,
  skyFor,
  stepCranes,
  THREAD,
  THREAD_HALF_WIDTH,
  VERTEX_FLOATS,
  writeInstances,
  zScale,
} from "./cranes-sim";
import { cranesMeta, MOBILE_CRANES } from "./cranes.meta";
import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  glslFloat,
  withScope,
} from "./gl";
import { HASH32_GLSL } from "./noise";
import { createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";

/** Direction towards the key light (up, left and in front), normalised in the shader. */
const LIGHT = [-0.35, 0.75, 0.55] as const;
/** Shade of a face turned fully away from the light, and of one facing it. */
const SHADE_MIN = 0.62;
const SHADE_MAX = 1.04;
/** Paper fibre cells per crane unit, and the fibre's brightness variation. */
const FIBRE_CELLS = 48;
const FIBRE_AMOUNT = 0.06;
/** Washi prints: stripes and dot rows per crane unit. */
const STRIPE_FREQ = 9;
const DOT_FREQ = 11;

/*
 * Cranes: one instanced triangle list, drawn twice. Each vertex carries its rest
 * position and wing side, its face normal, and the normals of the three faces
 * across its triangle's edges. Wings turn about the hinge by the flap angle,
 * then the instance rotation and a plain orthographic projection place them.
 * Triangles facing away are dropped in the vertex shader (every part is a
 * closed surface), and an edge whose neighbour faces away is a silhouette:
 * only those edges are anti-aliased, from barycentric distances.
 */
const CRANE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aNb0;
layout(location = 3) in vec3 aNb1;
layout(location = 4) in vec3 aNb2;
/** Rotation columns, plus flap angle, size (px per crane unit) and clip-z slot. */
layout(location = 5) in vec4 aM0;
layout(location = 6) in vec4 aM1;
layout(location = 7) in vec4 aM2;
/** Origin x, y (px, y up), pattern, haze. */
layout(location = 8) in vec4 aPlace;
layout(location = 9) in vec3 aBase;
layout(location = 10) in vec3 aPrint;
uniform vec2 uResolution;
uniform float uZScale;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uLight;
out vec3 vBary;
out vec2 vUv;
flat out vec3 vEdge;
flat out vec3 vBase;
flat out vec3 vPrint;
flat out vec3 vHazeColor;
/** Shade, pattern, haze. */
flat out vec3 vMisc;

const float HINGE_Y = ${glslFloat(HINGE_Y)};
const float SHADE_MIN = ${glslFloat(SHADE_MIN)};
const float SHADE_MAX = ${glslFloat(SHADE_MAX)};

/** Turns v about the hinge (pivot 1) or as a direction (pivot 0); see hinge() in cranes-sim.ts. */
vec3 hinge(vec3 v, float side, float c, float s, float pivot) {
  float y = v.y - pivot * HINGE_Y;
  return vec3(v.x, pivot * HINGE_Y + y * c + v.z * s, -y * s + v.z * c);
}

void main() {
  mat3 m = mat3(aM0.xyz, aM1.xyz, aM2.xyz);
  float side = aPos.w;
  float c = cos(aM0.w * abs(side));
  float s = sin(aM0.w * abs(side)) * side;
  vec3 local = m * hinge(aPos.xyz, side, c, s, 1.0);
  vec3 n = m * hinge(aNormal, side, c, s, 0.0);
  int k = gl_VertexID - (gl_VertexID / 3) * 3;
  vBary = vec3(k == 0 ? 1.0 : 0.0, k == 1 ? 1.0 : 0.0, k == 2 ? 1.0 : 0.0);
  vUv = vec2(aPos.x, aPos.y + aPos.z);
  vEdge = vec3(
    (m * hinge(aNb0, side, c, s, 0.0)).z <= 0.0 ? 1.0 : 0.0,
    (m * hinge(aNb1, side, c, s, 0.0)).z <= 0.0 ? 1.0 : 0.0,
    (m * hinge(aNb2, side, c, s, 0.0)).z <= 0.0 ? 1.0 : 0.0
  );
  vBase = aBase;
  vPrint = aPrint;
  vHazeColor = mix(uSkyBottom, uSkyTop, clamp(aPlace.y / uResolution.y, 0.0, 1.0));
  // Paper is a little translucent: faces turned from the light still glow.
  float lit = dot(n, uLight);
  vMisc = vec3(mix(SHADE_MIN, SHADE_MAX, 0.5 + 0.5 * lit), aPlace.z, aPlace.w);
  vec2 px = aPlace.xy + local.xy * aM1.w;
  float z = aM2.w - local.z * uZScale;
  // Faces turned away from the viewer are dropped (pushed past the far plane).
  gl_Position = n.z > 0.0 ? vec4(px / uResolution * 2.0 - 1.0, z, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}
`;

/**
 * uPass 0 draws the fully covered interior, opaque, writing depth; uPass 1 draws
 * only the anti-aliased silhouette fringe, blended over whatever lies behind it.
 */
const CRANE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 vBary;
in vec2 vUv;
flat in vec3 vEdge;
flat in vec3 vBase;
flat in vec3 vPrint;
flat in vec3 vHazeColor;
flat in vec3 vMisc;
uniform int uPass;
out vec4 outColor;
${DITHER_GLSL}
${HASH32_GLSL}
const float FIBRE_CELLS = ${glslFloat(FIBRE_CELLS)};
const float FIBRE_AMOUNT = ${glslFloat(FIBRE_AMOUNT)};
const float STRIPE_FREQ = ${glslFloat(STRIPE_FREQ)};
const float DOT_FREQ = ${glslFloat(DOT_FREQ)};

float cellHash(vec2 cell) {
  ivec2 i = ivec2(cell) + 4096;
  return float(hash32(uint(i.x) * 7919u + uint(i.y)) & 1023u) / 1023.0;
}

void main() {
  // Distance in px to each edge; only silhouette edges count.
  vec3 grad = vec3(
    length(vec2(dFdx(vBary.x), dFdy(vBary.x))),
    length(vec2(dFdx(vBary.y), dFdy(vBary.y))),
    length(vec2(dFdx(vBary.z), dFdy(vBary.z)))
  );
  vec3 dist = mix(vec3(1e4), vBary / max(grad, vec3(1e-6)), vEdge);
  float cover = clamp(min(dist.x, min(dist.y, dist.z)) + 0.35, 0.0, 1.0);
  bool interior = cover >= 1.0;
  if (interior != (uPass == 0)) discard;

  // Washi prints: diagonal stripes or a dot grid, anti-aliased.
  float st = (vUv.x + vUv.y) * STRIPE_FREQ;
  float stripe = clamp((0.25 - abs(fract(st) - 0.5)) / max(fwidth(st), 1e-4) + 0.5, 0.0, 1.0);
  vec2 dq = vUv * DOT_FREQ;
  vec2 dr = fract(dq + vec2(0.5 * floor(dq.y), 0.0)) - 0.5;
  float dots = clamp((0.2 - length(dr)) / max(fwidth(dq.x), 1e-4) + 0.5, 0.0, 1.0);
  float pattern = vMisc.y;
  float print = pattern > ${glslFloat(PATTERN_DOTS - 0.5)} ? dots : (pattern > ${glslFloat(PATTERN_STRIPES - 0.5)} ? stripe : 0.0);
  vec3 col = mix(vBase, vPrint, print);

  // Paper fibre: smooth value noise in the crane's own coordinates, faded out
  // where its cells get smaller than about a pixel.
  vec2 f = vUv * FIBRE_CELLS;
  vec2 fi = floor(f);
  vec2 ff = f - fi;
  ff = ff * ff * (3.0 - 2.0 * ff);
  float fibre = mix(
    mix(cellHash(fi), cellHash(fi + vec2(1.0, 0.0)), ff.x),
    mix(cellHash(fi + vec2(0.0, 1.0)), cellHash(fi + vec2(1.0, 1.0)), ff.x),
    ff.y
  );
  float fade = clamp(2.0 - 2.0 * fwidth(f.x), 0.0, 1.0);
  col *= vMisc.x * (1.0 + FIBRE_AMOUNT * fade * (fibre - 0.5) * 2.0);
  col = mix(col, vHazeColor, vMisc.z);
  col += dither8(gl_FragCoord.xy);
  outColor = uPass == 0 ? vec4(col, 1.0) : vec4(col * cover, cover);
}
`;

/**
 * Origami cranes drifting across a pale sky: a dithered gradient, then up to
 * twenty low-poly folded cranes and a four-crane mobile, all from one
 * instanced triangle list. Cranes are depth-sorted on the CPU and each gets its
 * own slice of clip z, so the depth test sorts each crane's own faces. Two passes
 * over the same instances: the opaque interior with depth writes, then the
 * anti-aliased silhouette fringe blended on top. The mobile's threads are alpha
 * streaks.
 */
export const cranes = defineEffect(cranesMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, CRANE_VERTEX, CRANE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uResolution",
        "uZScale",
        "uSkyTop",
        "uSkyBottom",
        "uLight",
        "uPass",
      ]);
      const sky = scope.own(createGradientBackground(gl));
      const threads = scope.own(createStreakRenderer(gl, MOBILE_CRANES, { blend: "alpha" }));

      const vao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const meshBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const instanceBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const instances = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, buildCraneVertices(), gl.STATIC_DRAW);
      const meshLayout = [4, 3, 3, 3, 3];
      let offset = 0;
      meshLayout.forEach((size, loc) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, VERTEX_FLOATS * 4, offset * 4);
        gl.vertexAttribDivisor(loc, 0);
        offset += size;
      });
      if (offset !== VERTEX_FLOATS) {
        throw new Error("cranes: vertex layout mismatch");
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
      const instanceLayout = [4, 4, 4, 4, 3, 3];
      offset = 0;
      instanceLayout.forEach((size, i) => {
        const loc = meshLayout.length + i;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, INSTANCE_FLOATS * 4, offset * 4);
        gl.vertexAttribDivisor(loc, 1);
        offset += size;
      });
      if (offset !== INSTANCE_FLOATS) {
        throw new Error("cranes: instance layout mismatch");
      }
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const len = Math.hypot(LIGHT[0], LIGHT[1], LIGHT[2]);
      gl.useProgram(program);
      u.f3("uLight", LIGHT[0] / len, LIGHT[1] / len, LIGHT[2] / len);
      gl.useProgram(null);

      const scratch = createInstanceScratch();
      let field: Cranes | null = null;
      let fieldSeed = Number.NaN;
      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const seed = Math.floor(p.seed);
          if (field === null || seed !== fieldSeed) {
            field = createCranes(seed, aspect, p.cranes);
            fieldSeed = seed;
          }
          stepCranes(field, dt, aspect, p.speed, p.cranes);
          const colours = skyFor(p.sky);

          // 1. Sky.
          sky.draw(colours.top, colours.bottom);

          // 2. Cranes, far first, each in its own slice of depth.
          const n = writeInstances(
            field,
            p.mobile,
            paletteFor(p.palette),
            width,
            height,
            scratch,
            instances,
          );
          if (n > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, n * INSTANCE_FLOATS);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.depthMask(true);
            gl.clearDepth(1);
            gl.clear(gl.DEPTH_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LESS);
            gl.useProgram(program);
            u.f2("uResolution", width, height);
            u.f1("uZScale", zScale(n));
            u.v3("uSkyTop", colours.top);
            u.v3("uSkyBottom", colours.bottom);
            gl.bindVertexArray(vao);
            u.i1("uPass", 0);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, CRANE_VERTICES, n);
            // The fringe: blended, tested against the interiors but not written.
            gl.depthMask(false);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            u.i1("uPass", 1);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, CRANE_VERTICES, n);
            gl.bindVertexArray(null);
            gl.depthMask(true);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
          }

          // 3. The mobile's threads, in front of the flying cranes.
          if (p.mobile) {
            const data = threads.data;
            const half = THREAD_HALF_WIDTH * scale;
            for (let i = 0; i < MOBILE_CRANES; i++) {
              const o = i * STREAK_FLOATS;
              // Streaks are in px, y down; start above the top edge.
              data[o] = scratch.threads[i * 3] * height;
              data[o + 1] = -2 * half;
              data[o + 2] = scratch.threads[i * 3 + 1] * height;
              data[o + 3] = (1 - scratch.threads[i * 3 + 2]) * height;
              data[o + 4] = THREAD[0];
              data[o + 5] = THREAD[1];
              data[o + 6] = THREAD[2];
              data[o + 7] = half;
            }
            threads.upload(MOBILE_CRANES);
            threads.draw(MOBILE_CRANES, width, height);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
