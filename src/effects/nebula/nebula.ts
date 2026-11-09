import { createChangeKey } from "../change-key";
import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import {
  BASE_RGB,
  buildStars,
  coreCentre,
  CORE_RADIUS,
  createLayout,
  densityThreshold,
  DUST_DEPTH,
  DUST_FREQ,
  DUST_HI,
  DUST_LO,
  DUST_WARP,
  ENV_BASE,
  ENV_CORE,
  EXPOSURE,
  GAS_SOFT,
  gasAmount,
  getNoiseData,
  LAYER_FREQ,
  LAYER_GAIN,
  MAX_STARS,
  MEAN,
  type NebulaLayout,
  NOISE_SIZE,
  NORM,
  OCT,
  OFFSET_FLOATS,
  offsetsAt,
  paletteColor,
  PATCH_LO,
  PATCH_SPAN,
  rotationAt,
  STAR_MAX,
  starDim,
  WARP_AMT,
  WARP_FREQ,
} from "./nebula-sim";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { nebulaMeta } from "./nebula.meta";
import { defineEffect } from "../types";

/** Low-res divisors: the gas has no fine detail, so balanced renders at 1/16 of the pixels. */
const DIVISORS = { high: 2, balanced: 4, low: 6 } as const;
/** Diffraction spike half-length (1080p px) for a STAR_MAX star, and its Gaussian width. */
const SPIKE_LEN = 30;
const SPIKE_WIDTH = 0.6;
/** Star core Gaussian radius (1080p px). */
const CORE_SIGMA = 0.55;

const f = glslFloat;

/**
 * Gas pass, at reduced resolution. Five fetches per pixel from one 4-octave
 * tiling noise texture: the warp (rg) and brightness patches (b), three warped gas
 * layers and one dust layer. Output is the final colour (tone-mapped).
 */
const GAS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
/** (width / height, 1): uv to centred canvas-height units. */
uniform vec2 uAspect;
/** cos and sin of the rotation. */
uniform vec2 uRot;
uniform vec2 uWarpOff;
/** xy = layer 0 offset, zw = layer 1. */
uniform vec4 uOffA;
/** xy = layer 2 offset, zw = dust. */
uniform vec4 uOffB;
uniform float uThreshold;
/** Dust strength times DUST_DEPTH. */
uniform float uDust;
/** Layer colours times gain and exposure. */
uniform vec3 uColor0;
uniform vec3 uColor1;
uniform vec3 uColor2;
/** xy = core centre (gas space), z = 1 / radius^2. */
uniform vec3 uCore;
in vec2 vUv;
out vec4 outColor;

const vec4 OCT = vec4(${f(OCT[0])}, ${f(OCT[1])}, ${f(OCT[2])}, ${f(OCT[3])});

float fbm(vec2 t) {
  return (dot(texture(uNoise, t), OCT) - ${f(MEAN)}) * ${f(NORM)};
}

float emission(float n) {
  float g = smoothstep(uThreshold, uThreshold + ${f(GAS_SOFT)}, n);
  return g * g;
}

void main() {
  vec2 p = (vUv - 0.5) * uAspect;
  vec2 q = vec2(uRot.x * p.x - uRot.y * p.y, uRot.y * p.x + uRot.x * p.y);
  vec4 wt = texture(uNoise, q * ${f(WARP_FREQ)} + uWarpOff);
  vec2 w = wt.rg - 0.5;
  vec2 g = q + w * ${f(WARP_AMT)};
  vec3 gas = uColor0 * emission(fbm(g * ${f(LAYER_FREQ[0])} + uOffA.xy))
    + uColor1 * emission(fbm(g * ${f(LAYER_FREQ[1])} + uOffA.zw))
    + uColor2 * emission(fbm(g * ${f(LAYER_FREQ[2])} + uOffB.xy));
  float dn = fbm((q + w * ${f(DUST_WARP)}) * ${f(DUST_FREQ)} + uOffB.zw);
  float lane = smoothstep(${f(DUST_LO)}, ${f(DUST_HI)}, dn) * uDust;
  vec2 dc = q - uCore.xy;
  float env = (${f(ENV_BASE)} + ${f(ENV_CORE)} * exp(-dot(dc, dc) * uCore.z))
    * (${f(PATCH_LO)} + ${f(PATCH_SPAN)} * wt.b);
  gas *= env * (1.0 - lane);
  vec3 base = vec3(${f(BASE_RGB[0])}, ${f(BASE_RGB[1])}, ${f(BASE_RGB[2])});
  outColor = vec4(base + 1.0 - exp2(-gas), 1.0);
}
`;

const STAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x, y (gas space), halo radius (1080p px), brightness. */
layout(location = 1) in vec4 aStar;
layout(location = 2) in vec3 aTint;
uniform vec2 uResolution;
uniform float uScale;
uniform vec2 uRot;
/** 0: round glow (octagon), 1: diffraction cross. */
uniform float uShape;
out vec2 vLocal;
out float vExt;
out vec3 vColor;
void main() {
  // Gas space to screen: the inverse (transpose) of the gas rotation.
  vec2 s = vec2(uRot.x * aStar.x + uRot.y * aStar.y, uRot.x * aStar.y - uRot.y * aStar.x);
  vec2 centre = s * uResolution.y + 0.5 * uResolution;
  vec2 off;
  if (uShape < 0.5) {
    float ext = max(aStar.z * uScale, 1.5);
    off = aCorner * ext;
    vLocal = off;
    vExt = ext;
  } else {
    // Cross corners: the arm's long axis is +-1, its thin axis +-0.5.
    float len = ${f(SPIKE_LEN)} * uScale * sqrt(clamp(aStar.w / ${f(STAR_MAX)}, 0.0, 1.0));
    float w = max(${f(SPIKE_WIDTH)} * uScale, 0.5);
    bool horiz = abs(aCorner.x) > 0.75;
    float along = horiz ? aCorner.x : aCorner.y;
    float across = (horiz ? aCorner.y : aCorner.x) * 5.0 * w;
    off = horiz ? vec2(along * len, across) : vec2(across, along * len);
    vLocal = vec2(along, across / w);
    vExt = 1.0;
  }
  vColor = aTint * aStar.w;
  gl_Position = vec4((centre + off) / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const STAR_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
/** highp to match the vertex stage: shared uniforms must agree in precision. */
uniform highp float uShape;
/** 1 / (2 sigma^2) of the star core, in px^-2. */
uniform float uCoreK;
in vec2 vLocal;
in float vExt;
in vec3 vColor;
out vec4 outColor;
void main() {
  float i;
  if (uShape < 0.5) {
    float d2 = dot(vLocal, vLocal);
    float h = max(1.0 - d2 / (vExt * vExt), 0.0);
    i = exp(-d2 * uCoreK) + 0.18 * h * h * h;
  } else {
    float a = 1.0 - abs(vLocal.x);
    i = 0.5 * a * a * exp(-vLocal.y * vLocal.y);
  }
  outColor = vec4(vColor * i, 1.0);
}
`;

/** The cross: a horizontal and a vertical thin quad joined by degenerate triangles. */
const CROSS: readonly number[] = [
  -1, -0.5, 1, -0.5, -1, 0.5, 1, 0.5, 1, 0.5, -0.5, -1, -0.5, -1, 0.5, -1, -0.5, 1, 0.5, 1,
];

/**
 * A deep-space nebula: two or three glowing gas colours shaped by warped fBm,
 * carved by darker dust lanes, over a fixed starfield. The gas evolves (the warp
 * moves, not the clouds) and the whole field turns about a degree a minute.
 */
export const nebula = defineEffect(nebulaMeta, {
  create(gl) {
    return withScope((scope) => {
      // Half floats keep the dark gradients smooth until the dithered blit.
      const target = scope.own(createLowResTarget(gl, { format: "rgba16f" }));
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, GAS_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const u = createUniforms(gl, program, [
        "uNoise",
        "uAspect",
        "uRot",
        "uWarpOff",
        "uOffA",
        "uOffB",
        "uThreshold",
        "uDust",
        "uColor0",
        "uColor1",
        "uColor2",
        "uCore",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);

      const starProgram = scopedProgram(gl, scope, STAR_VERTEX, STAR_FRAGMENT);
      const su = createUniforms(gl, starProgram, [
        "uResolution",
        "uScale",
        "uRot",
        "uShape",
        "uCoreK",
      ]);
      const stars = scope.own(
        createSpriteBatch(gl, MAX_STARS, [4, 3], [polygonStrip(8, Math.PI / 8), CROSS]),
      );
      gl.useProgram(null);

      const noiseData = getNoiseData();
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: noiseData,
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const colorMemo = [unitRgbMemo(), unitRgbMemo(), unitRgbMemo()];
      const offsets = new Float64Array(OFFSET_FLOATS);
      const core = new Float64Array(2);
      /** Inputs the star buffer was built from: seed, stars, density, dust, aspect, spikes. */
      const starKey = createChangeKey(6);

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Simulation time: seconds times speed, unwrapped float64. */
      let time = 0;
      let seed = Number.NaN;
      let layout: NebulaLayout = createLayout(0);
      let starCount = 0;
      let spikeCount = 0;
      let threshold = 0;
      let dustAmount = 0;

      const dimAt = (x: number, y: number) =>
        starDim(gasAmount(noiseData, x, y, offsets, threshold, dustAmount, core));

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += Math.max(0, dt) * p.speed;
          const aspect = width / height;
          target.resize(width, height, qualityDivisor(p.quality, DIVISORS));

          if (p.seed !== seed) {
            seed = p.seed;
            layout = createLayout(seed);
          }
          coreCentre(layout, aspect, core);
          offsetsAt(layout, time, offsets);
          threshold = densityThreshold(p.density);
          dustAmount = Math.min(1, Math.max(0, p.dust)) * DUST_DEPTH;
          const angle = rotationAt(time);
          const c = Math.cos(angle);
          const s = Math.sin(angle);

          // Gas pass, into the low-res target.
          gl.useProgram(program);
          u.f2("uAspect", aspect, 1);
          u.f2("uRot", c, s);
          u.f2("uWarpOff", offsets[0], offsets[1]);
          u.f4("uOffA", offsets[2], offsets[3], offsets[4], offsets[5]);
          u.f4("uOffB", offsets[6], offsets[7], offsets[8], offsets[9]);
          u.f1("uThreshold", threshold);
          u.f1("uDust", dustAmount);
          u.f3("uCore", core[0], core[1], 1 / (CORE_RADIUS * CORE_RADIUS));
          for (let i = 0; i < 3; i++) {
            const rgb = colorMemo[i](paletteColor(p.palette, i, p.color1, p.color2, p.color3));
            const k = LAYER_GAIN[i] * EXPOSURE;
            u.f3(
              i === 0 ? "uColor0" : i === 1 ? "uColor1" : "uColor2",
              rgb[0] * k,
              rgb[1] * k,
              rgb[2] * k,
            );
          }
          target.bind();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          triangle.draw();

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // Stars: rebuilt (with gas dimming from the current gas) only when an input changes.
          starKey.set(0, seed);
          starKey.set(1, p.stars);
          starKey.set(2, p.density);
          starKey.set(3, p.dust);
          starKey.set(4, aspect);
          starKey.set(5, p.spikes ? 1 : 0);
          if (starKey.take()) {
            const built = buildStars(stars.data, seed, p.stars, aspect, p.spikes, dimAt);
            starCount = built.count;
            spikeCount = built.spikes;
            stars.upload(starCount);
          }

          if (starCount > 0) {
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(starProgram);
            su.f2("uResolution", width, height);
            su.f1("uScale", scale);
            su.f2("uRot", c, s);
            const sigma = Math.max(CORE_SIGMA * scale, 0.4);
            su.f1("uCoreK", 1 / (2 * sigma * sigma));
            su.f1("uShape", 0);
            stars.draw(0, starCount, 0);
            if (spikeCount > 0) {
              su.f1("uShape", 1);
              stars.draw(0, spikeCount, 1);
            }
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
