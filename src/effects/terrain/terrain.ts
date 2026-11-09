import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createGradientBackground,
  createUniforms,
  DITHER_GLSL,
  glslFloat,
  resetUnpackState,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import {
  buildMesh,
  buildOctaves,
  buildRamp,
  cameraAt,
  cameraMeshZ,
  CELLS_PER_SECOND,
  createOctaveRows,
  createPose,
  MAX_TAN_H,
  octaveWeights,
  PALETTES,
  type OctaveRowWriter,
  PERIOD,
  RAMP_SIZE,
  ringRow,
  ROWS,
  rowsNeeded,
  TAN_V,
  VERTEX_SHORTS,
} from "./terrain-sim";
import { terrainMeta } from "./terrain.meta";
import { defineEffect } from "../types";
import { lookup } from "../lookup";

/** Valley along the flight path: height scale at its floor, and where its walls start and end. */
const VALLEY_FLOOR = 0.12;
const VALLEY_IN = 1.5;
const VALLEY_OUT = 16;
/** Constant height offset: the valley floor dips a little below zero, where lakes form. */
const HEIGHT_OFFSET = -0.25;
/** Lowest shore height, used for the colour ramp when there is no water. */
const DRY_SHORE = -0.5;
/** Ramp height span per unit of terrain amplitude. */
const RAMP_SPAN = 1.2;
/** Water height at water = 1, and its offset. */
const WATER_SPAN = 1.6;
const WATER_BASE = -0.5;
const NO_WATER = -1e4;
/** Lighting: ambient share, sun elevation, base azimuth and drift (radians), drift period (s). */
const AMBIENT = 0.42;
const SUN_ELEVATION = 0.6;
const SUN_AZIMUTH = 2;
const SUN_DRIFT = 0.5;
const SUN_PERIOD = 420;
/** Clip planes, in cells. Only near matters: nothing relies on depth. */
const NEAR = 0.05;
const FAR = 1000;
/** Fog density per unit of the param, and the forced fade over the mesh's last rows. */
const FOG_BASE = 0.004;
const FOG_SCALE = 0.03;
const FADE_START = 0.7 * ROWS;

/*
 * Every vertex fetches its triangle's three corner heights (three texelFetches of
 * the octave texture) and computes the face normal and colour itself; the three
 * vertices of a triangle do identical work, so the flat colour is the same
 * whichever vertex is the provoking one. Fog is per vertex and interpolated.
 */
const VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in ivec4 aVert;
/** Four noise octaves, texel (x, z) mod ${String(PERIOD)} for grid vertex (x, z). */
uniform sampler2D uOctaves;
/** Height colour ramp: rgb and rockiness. */
uniform sampler2D uRamp;
/** Whole cells flown, mod ${String(PERIOD)}: mesh row j shows terrain row j + uRow (the texture is a ring buffer). */
uniform int uRow;
/** Octave weights (amplitude included) and base height. */
uniform vec4 uWeights;
uniform float uBase;
uniform float uWaterLevel;
/** Ramp texture coordinate = height * x + y. */
uniform vec2 uRampMap;
uniform vec3 uCam;
/** cos and sin of the heading, then of the pitch. */
uniform vec4 uRot;
uniform vec2 uFocal;
uniform vec3 uSun;
uniform vec3 uRock;
uniform vec3 uWater;
uniform vec3 uFog;
uniform float uFogK;
flat out vec3 vColor;
out float vFog;

float rawHeight(ivec2 c) {
  // Offsets keep both operands of & non-negative.
  ivec2 t = ivec2((c.x + ${String(PERIOD * 4)}) & ${String(PERIOD - 1)}, (c.y + uRow) & ${String(PERIOD - 1)});
  vec4 o = texelFetch(uOctaves, t, 0) * 2.0 - 1.0;
  float d = abs(float(c.x) - 0.5);
  float v = mix(${glslFloat(VALLEY_FLOOR)}, 1.0, smoothstep(${glslFloat(VALLEY_IN)}, ${glslFloat(VALLEY_OUT)}, d));
  return v * (uBase + dot(o, uWeights)) + ${glslFloat(HEIGHT_OFFSET)};
}

ivec2 corner(int code) {
  return ivec2(code % 3 - 1, code / 3 - 1);
}

void main() {
  ivec2 c0 = aVert.xy;
  ivec2 cA = c0 + corner(aVert.z);
  ivec2 cB = c0 + corner(aVert.w);
  float r0 = rawHeight(c0);
  float rA = rawHeight(cA);
  float rB = rawHeight(cB);
  // Below the water level the surface is the flat water plane.
  vec3 p0 = vec3(float(c0.x), max(r0, uWaterLevel), float(c0.y));
  vec3 pA = vec3(float(cA.x), max(rA, uWaterLevel), float(cA.y));
  vec3 pB = vec3(float(cB.x), max(rB, uWaterLevel), float(cB.y));
  vec3 n = normalize(cross(pA - p0, pB - p0));
  n = n.y < 0.0 ? -n : n;
  float lit = ${glslFloat(AMBIENT)} + ${glslFloat(1 - AMBIENT)} * max(dot(n, uSun), 0.0);

  vec3 col;
  if (max(r0, max(rA, rB)) <= uWaterLevel) {
    // Deeper water is darker; a little of the sky is reflected.
    float depth = uWaterLevel - (r0 + rA + rB) / 3.0;
    col = mix(uWater * lit, uFog, 0.3) * (1.0 - 0.3 * clamp(depth * 0.6, 0.0, 1.0));
  } else {
    float h = (p0.y + pA.y + pB.y) / 3.0;
    vec4 ramp = textureLod(uRamp, vec2(h * uRampMap.x + uRampMap.y, 0.5), 0.0);
    float rock = smoothstep(0.3, 0.55, 1.0 - n.y) * ramp.a;
    col = mix(ramp.rgb, uRock, rock) * lit;
  }
  vColor = col;

  vec3 rel = p0 - uCam;
  float vx = uRot.x * rel.x - uRot.y * rel.z;
  float fz = uRot.y * rel.x + uRot.x * rel.z;
  float vy = rel.y * uRot.z + fz * uRot.w;
  float vz = fz * uRot.z - rel.y * uRot.w;
  gl_Position = vec4(vx * uFocal.x, vy * uFocal.y,
    vz * ${glslFloat((FAR + NEAR) / (FAR - NEAR))} - ${glslFloat((2 * FAR * NEAR) / (FAR - NEAR))}, vz);

  float fd = length(rel) * uFogK;
  // Fully fogged before the mesh ends, whatever the density.
  vFog = max(1.0 - exp2(-fd * fd), smoothstep(${glslFloat(FADE_START)}, ${glslFloat(ROWS)}, rel.z));
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
flat in vec3 vColor;
in float vFog;
uniform vec3 uFog;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  outColor = vec4(mix(vColor, uFog, vFog) + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A slow glide along a valley of flat-shaded, low-poly hills under a gradient sky,
 * fading into fog. A static mesh drawn in painter's order (no depth buffer), with
 * heights from a tiling noise texture fetched in the vertex shader.
 */
export const terrain = defineEffect(terrainMeta, {
  create(gl) {
    return withScope((scope) => {
      const sky = scope.own(createGradientBackground(gl));
      const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, [
        "uOctaves",
        "uRamp",
        "uRow",
        "uWeights",
        "uBase",
        "uWaterLevel",
        "uRampMap",
        "uCam",
        "uRot",
        "uFocal",
        "uSun",
        "uRock",
        "uWater",
        "uFog",
        "uFogK",
      ]);
      gl.useProgram(program);
      u.i1("uOctaves", 0);
      u.i1("uRamp", 1);
      gl.useProgram(null);

      const mesh = buildMesh();
      const vertexCount = mesh.length / VERTEX_SHORTS;
      const vao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const vbo = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 4, gl.SHORT, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      /** Seed the octaves were built from; NaN builds them on the first frame. */
      let seed = Number.NaN;
      let writeRow: OctaveRowWriter | null = null;
      /** One past the last terrain row written into the ring buffer. */
      let filledTo = 0;
      const rowData = new Uint8Array(PERIOD * 4);
      const octaves = scope.add(
        createDataTexture(gl, {
          width: PERIOD,
          height: PERIOD,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: new Uint8Array(PERIOD * PERIOD * 4),
          filter: gl.NEAREST,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const ramp = scope.own(createColumnTable(gl, RAMP_SIZE, 4));
      let paletteId = "";

      const rgb = unitRgbMemo();
      const weights = new Float64Array(4);
      const pose = createPose();
      let width = 1;
      let height = 1;
      /** Seconds, float64 and unwrapped: only sines of it reach the GPU. */
      let time = 0;
      /** Cells flown, float64 and unwrapped: the terrain never repeats. */
      let distance = 0;

      return {
        resize(v) {
          ({ width, height } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          distance += Math.max(0, dt * p.speed * CELLS_PER_SECOND);
          const row = Math.floor(distance);
          cameraAt(time, pose);

          // Sky: fog colour everywhere, then the gradient down to the horizon.
          const fog = rgb(p.fog);
          const aspect = width / Math.max(1, height);
          const tanV = Math.min(TAN_V, MAX_TAN_H / aspect);
          const horizonPx = Math.round(((1 + pose.horizon) / 2) * height);
          gl.clearColor(fog[0], fog[1], fog[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (horizonPx < height) {
            gl.viewport(0, horizonPx, width, height - horizonPx);
            sky.draw(rgb(p.skyTop), fog);
            gl.viewport(0, 0, width, height);
          }

          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE1);
          if (p.palette !== paletteId) {
            paletteId = p.palette;
            const pal = lookup(PALETTES, paletteId, "alpine");
            buildRamp(pal.stops, ramp.data);
            ramp.upload();
            u.v3("uRock", rgb(pal.rock));
            u.v3("uWater", rgb(pal.water));
          } else {
            gl.bindTexture(gl.TEXTURE_2D, ramp.texture);
          }
          gl.activeTexture(gl.TEXTURE0);
          const s = Math.round(p.seed);
          const need = rowsNeeded(row);
          if (s !== seed || need - filledTo > PERIOD / 2) {
            // New terrain (or a jump too far to stream): rebuild the whole ring.
            seed = s;
            writeRow = createOctaveRows(seed);
            const data = buildOctaves(seed, row);
            updateDataTexture(gl, octaves, PERIOD, PERIOD, gl.RGBA, gl.UNSIGNED_BYTE, data);
            filledTo = row + PERIOD;
          } else {
            gl.bindTexture(gl.TEXTURE_2D, octaves);
            if (filledTo < need && writeRow) {
              // Stream the rows coming into view over the ones already flown past.
              resetUnpackState(gl);
              for (; filledTo < need; filledTo++) {
                writeRow(filledTo, rowData);
                gl.texSubImage2D(
                  gl.TEXTURE_2D,
                  0,
                  0,
                  ringRow(filledTo),
                  PERIOD,
                  1,
                  gl.RGBA,
                  gl.UNSIGNED_BYTE,
                  rowData,
                );
              }
            }
          }

          const amp = octaveWeights(p.roughness, weights);
          u.f4("uWeights", weights[0], weights[1], weights[2], weights[3]);
          u.f1("uBase", amp * 0.5);
          const level = p.water > 0 ? WATER_BASE + WATER_SPAN * p.water : NO_WATER;
          u.f1("uWaterLevel", level);
          // Ramp texel centres: shore at the first, amp * RAMP_SPAN above it at the last.
          const shore = Math.max(level, DRY_SHORE);
          const rampA = (RAMP_SIZE - 1) / (RAMP_SIZE * amp * RAMP_SPAN);
          u.f2("uRampMap", rampA, 0.5 / RAMP_SIZE - shore * rampA);

          u.i1("uRow", ringRow(row));
          u.f3("uCam", pose.x, pose.y, cameraMeshZ(distance));
          const pitch = Math.atan(pose.horizon * tanV);
          u.f4("uRot", Math.cos(pose.yaw), Math.sin(pose.yaw), Math.cos(pitch), Math.sin(pitch));
          u.f2("uFocal", 1 / (tanV * aspect), 1 / tanV);
          const az = SUN_AZIMUTH + SUN_DRIFT * Math.sin((time * 2 * Math.PI) / SUN_PERIOD);
          const ce = Math.cos(SUN_ELEVATION);
          u.f3("uSun", ce * Math.sin(az), Math.sin(SUN_ELEVATION), ce * Math.cos(az));
          u.v3("uFog", fog);
          u.f1("uFogK", FOG_BASE + FOG_SCALE * p.fogDensity);

          // Painter's order needs no depth; culling skips the hidden back faces.
          gl.enable(gl.CULL_FACE);
          gl.frontFace(gl.CCW);
          gl.cullFace(gl.BACK);
          gl.bindVertexArray(vao);
          gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
          gl.bindVertexArray(null);
          gl.disable(gl.CULL_FACE);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
