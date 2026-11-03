import {
  cloudNoiseChannels,
  coverageOpacity,
  coverageThreshold,
  LAYER_FLOATS,
  layerUniforms,
  PRESETS,
  STRETCH_X,
} from "./clouds-sky";
import { hexToUnitRgb, type Rgb } from "./color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import {
  createKiteState,
  kiteCounts,
  lineCounts,
  MAX_BACK_STREAKS,
  MAX_FRONT_STREAKS,
  MAX_TRIS,
  paletteFor,
  shapeFor,
  stepKite,
  TRI_FLOATS,
  writeKite,
  writeLines,
  writeTail,
} from "./kite-sim";
import { kiteMeta } from "./kite.meta";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { buildPeriodicNoiseTexture } from "./noise";
import { createSpriteBatch } from "./sprites";
import { createStreakRenderer } from "./streaks";
import { defineEffect } from "./types";

/** Noise texture side, in texels, and its seed. */
const NOISE_SIZE = 256;
const NOISE_SEED = 11;
/** Coarse noise texture repeats per frame height: fair-weather cumulus, smallish. */
const CLOUD_FREQ = 0.7;
/** Cloud drift, frame heights per second, at wind 0 and its gain. */
const DRIFT0 = 0.006;
const DRIFT1 = 0.02;
/** Offset towards the light of the lighting sample, in texture units. */
const LIGHT_STEP = 0.02;
/** The sky is soft, so even "high" renders it at half resolution. */
const SKY_DIVISORS = { high: 2, balanced: 3, low: 4 } as const;

const DAY = PRESETS.day;
const vec3 = (c: Rgb) => `vec3(${c.map(glslFloat).join(", ")})`;
const lightLen = Math.hypot(DAY.lightX, DAY.lightY);
/** Step towards the light in texture space, where x is squashed by STRETCH_X (as in `clouds.ts`). */
const SUN_STEP_X = (DAY.lightX / lightLen) * STRETCH_X * LIGHT_STEP;
const SUN_STEP_Y = (DAY.lightY / lightLen) * LIGHT_STEP;

/**
 * One layer of the Time-lapse Clouds cumulus (see `clouds.ts`), at reduced
 * resolution: two coarse fetches for the evolving cross-fade, one detail fetch and
 * one (two near the A/B swap) towards the light. Premultiplied RGBA out.
 */
const CLOUD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform float uAspect;
/** xy = coarse offset of sample A, zw = of sample B (texture units). */
uniform vec4 uOffA;
/** xy = detail offset, z = detail frequency, w = light weight of A. */
uniform vec4 uDetail;
/** x = coarse frequency, y = weight of A, z = contrast fix, w = opacity. */
uniform vec4 uLayerP;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;

const vec4 OCT = vec4(0.5, 0.25, 0.125, 0.0625);
const float MEAN = 0.46875;
const float NORM = 10.0;
const float EDGE = 0.9;
const float LIGHT_GAIN = 1.2;
const vec2 SUN_STEP = vec2(${glslFloat(SUN_STEP_X)}, ${glslFloat(SUN_STEP_Y)});
const vec3 LIGHT = ${vec3(hexToUnitRgb(DAY.cloudLight))};
const vec3 SHADOW = ${vec3(hexToUnitRgb(DAY.cloudShadow))};

void main() {
  vec2 q = vec2(vUv.x * uAspect * ${glslFloat(STRETCH_X)}, vUv.y);
  vec2 t = q * uLayerP.x;
  float a = dot(texture(uNoise, t + uOffA.xy), OCT);
  float b = dot(texture(uNoise, t + uOffA.zw), OCT);
  float c = (mix(b, a, uLayerP.y) - MEAN) * uLayerP.z;
  float lw = uDetail.w;
  float g = 0.0;
  if (lw > 0.0) g += lw * (dot(texture(uNoise, t + SUN_STEP + uOffA.xy), OCT) - a);
  if (lw < 1.0) g += (1.0 - lw) * (dot(texture(uNoise, t + SUN_STEP + uOffA.zw), OCT) - b);
  g *= inversesqrt(lw * lw + (1.0 - lw) * (1.0 - lw));
  float d = dot(texture(uNoise, q * uDetail.z + uDetail.xy), OCT) - MEAN;
  float n = (c + 0.25 * d) * NORM;
  float dens = smoothstep(uThreshold, uThreshold + EDGE, n);
  float lit = clamp(0.62 - g * (NORM * LIGHT_GAIN) - 0.15 * dens, 0.0, 1.0);
  float alpha = dens * uLayerP.w;
  outColor = vec4(mix(SHADOW, LIGHT, lit) * alpha, alpha);
}
`;

/** Full-resolution composite: the day sky gradient and sun glow, then the clouds over it. */
const COMPOSITE = /* glsl */ `
uniform float uAspect;
const vec3 SKY_TOP = ${vec3(hexToUnitRgb(DAY.skyTop))};
const vec3 SKY_BOTTOM = ${vec3(hexToUnitRgb(DAY.skyBottom))};
const vec3 GLOW = ${vec3(hexToUnitRgb(DAY.glow))};
const vec2 SUN = vec2(${glslFloat(DAY.sunX)}, ${glslFloat(DAY.sunY)});
vec4 composite(vec2 uv) {
  float h = uv.y;
  vec3 sky = mix(SKY_BOTTOM, SKY_TOP, h * (2.0 - h));
  float d = length((uv - SUN) * vec2(uAspect, 1.0));
  float g = ${glslFloat(DAY.glowStrength)} * exp(-d / ${glslFloat(DAY.glowRadius)});
  sky += GLOW * g;
  vec4 c = texture(uLowRes, uv);
  return vec4(sky * (1.0 - c.a) + c.rgb + GLOW * (0.6 * g * c.a), 1.0);
}
`;

/**
 * Triangles with anti-aliased outer edges: each instance is drawn as its bounding
 * box (plus a 1.5 px margin), and the fragment shader takes the distance to each
 * edge. Outer edges fade over a pixel; inner edges, shared with a neighbour,
 * reach half a pixel past it so the two overlap and no seam of sky shows.
 */
const TRI_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Vertices a and b, px (y down). */
layout(location = 1) in vec4 aAB;
/** Vertex c, outer-edge mask. */
layout(location = 2) in vec4 aC;
/** Premultiplied colour. */
layout(location = 3) in vec4 aColor;
uniform vec2 uResolution;
out vec2 vPx;
flat out vec4 vAB;
flat out vec2 vC;
/** Per edge: the distance (px) to add before clamping coverage. */
flat out vec3 vPad;
flat out vec4 vColor;
${TO_CLIP_GLSL}
void main() {
  vec2 lo = min(min(aAB.xy, aAB.zw), aC.xy) - 1.5;
  vec2 hi = max(max(aAB.xy, aAB.zw), aC.xy) + 1.5;
  vec2 px = mix(lo, hi, aCorner * 0.5 + 0.5);
  int m = int(aC.z + 0.5);
  vPad = vec3((m & 1) != 0 ? 0.5 : 1.0, (m & 2) != 0 ? 0.5 : 1.0, (m & 4) != 0 ? 0.5 : 1.0);
  vPx = px;
  vAB = aAB;
  vC = aC.xy;
  vColor = aColor;
  gl_Position = pxToClip(px, uResolution);
}
`;

const TRI_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPx;
flat in vec4 vAB;
flat in vec2 vC;
flat in vec3 vPad;
flat in vec4 vColor;
out vec4 outColor;

/** Signed distance (px) of p from the line a-b, positive on the left of a to b. */
float side(vec2 p, vec2 a, vec2 b) {
  vec2 e = b - a;
  return (e.x * (p.y - a.y) - e.y * (p.x - a.x)) / max(length(e), 1e-4);
}

void main() {
  vec2 a = vAB.xy;
  vec2 b = vAB.zw;
  vec2 c = vC;
  vec2 ab = b - a;
  vec2 ac = c - a;
  float area = ab.x * ac.y - ab.y * ac.x;
  float s = area < 0.0 ? -1.0 : 1.0;
  vec3 d = s * vec3(side(vPx, a, b), side(vPx, b, c), side(vPx, c, a));
  vec3 cov = clamp(d + vPad, 0.0, 1.0);
  float k = abs(area) < 1e-3 ? 0.0 : min(cov.x, min(cov.y, cov.z));
  outColor = vColor * k;
}
`;

/**
 * A kite swooping in a top corner of a blue sky: one layer of the Time-lapse
 * Clouds cumulus at reduced resolution, composited over the day sky, then the
 * tail ribbon and kite panels as anti-aliased triangles and the spars and string
 * as streaks. All the motion is on the CPU in `kite-sim.ts`.
 */
export const kite = defineEffect(kiteMeta, {
  create(gl) {
    return withScope((scope) => {
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => gl.deleteProgram(p));
      const cloudProgram = program(FULLSCREEN_VERTEX, CLOUD_FRAGMENT);
      const triProgram = program(TRI_VERTEX, TRI_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const cu = createUniforms(gl, cloudProgram, [
        "uNoise",
        "uAspect",
        "uOffA",
        "uDetail",
        "uLayerP",
        "uThreshold",
      ]);
      const bu = createUniforms(gl, target.program, ["uAspect"]);
      const tu = createUniforms(gl, triProgram, ["uResolution"]);
      const batch = scope.own(createSpriteBatch(gl, MAX_TRIS, [4, 4, 4]));
      if (batch.stride !== TRI_FLOATS) throw new Error("kite: instance layout mismatch");
      const backLines = scope.own(createStreakRenderer(gl, MAX_BACK_STREAKS, { blend: "alpha" }));
      const frontLines = scope.own(createStreakRenderer(gl, MAX_FRONT_STREAKS, { blend: "alpha" }));

      gl.useProgram(cloudProgram);
      cu.i1("uNoise", 0);
      gl.useProgram(null);

      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, cloudNoiseChannels(NOISE_SEED)),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const offA = new Float32Array(LAYER_FLOATS);
      const detail = new Float32Array(LAYER_FLOATS);
      const layerP = new Float32Array(LAYER_FLOATS);
      const state = createKiteState();

      let width = 1;
      let height = 1;
      /** Cloud travel (frame heights, signed) and evolution time; float64. */
      let drift = 0;
      let evolve = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, dt);
          const aspect = width / height;
          const shape = shapeFor(p.kite);
          stepKite(state, dt, shape, p.wind, p.corner, aspect);
          drift += step * (DRIFT0 + DRIFT1 * state.wind) * -state.windDir;
          evolve += step * (0.6 + 0.8 * state.wind);

          // 1. Clouds into the low-res target, then the sky composite to the canvas.
          target.resize(width, height, qualityDivisor(p.quality, SKY_DIVISORS));
          gl.useProgram(cloudProgram);
          cu.f1("uAspect", aspect);
          cu.f1("uThreshold", coverageThreshold(p.clouds));
          layerUniforms(
            offA,
            detail,
            layerP,
            0,
            0,
            drift,
            evolve,
            CLOUD_FREQ,
            coverageOpacity(p.clouds),
          );
          gl.uniform4fv(cu.loc.uOffA, offA);
          gl.uniform4fv(cu.loc.uDetail, detail);
          gl.uniform4fv(cu.loc.uLayerP, layerP);
          target.bind();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.useProgram(target.program);
          bu.f1("uAspect", aspect);
          target.blit();

          // 2. Tail and kite triangles, spars and string.
          const palette = paletteFor(p.colour);
          const nTail = writeTail(batch.data, 0, state, palette, height);
          const nKite = writeKite(batch.data, nTail, state, shape, palette, height);
          batch.upload(nTail + nKite);
          writeLines(backLines.data, frontLines.data, state, shape, height, height / 1080);

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(triProgram);
          tu.f2("uResolution", width, height);
          // The tail and any faces turned away, then the spars seen through them.
          batch.draw(0, nTail + kiteCounts.back);
          if (lineCounts.back > 0) {
            backLines.upload(lineCounts.back);
            backLines.draw(lineCounts.back, width, height);
            gl.useProgram(triProgram);
          }
          batch.draw(nTail + kiteCounts.back, kiteCounts.front);
          frontLines.upload(lineCounts.front);
          frontLines.draw(lineCounts.front, width, height);
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
