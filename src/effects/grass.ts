import type { Rgb } from "./color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import {
  BEND_BASE,
  BEND_GUST,
  BEND_LIMIT,
  BEND_SWAY,
  BLADE_STRIP,
  bladeCount,
  buildBlades,
  D_MIN,
  FIELDS,
  GUST_CX,
  GUST_CZ,
  GUST_FX,
  GUST_FZ,
  GUST_HI,
  GUST_LO,
  MAX_BEND,
  MAX_BLADES,
  NOISE_CHANNELS,
  NOISE_SIZE,
  SEGMENT_BEND,
  SUNS,
  WAVE1,
  WAVE2,
  windRate,
} from "./grass-sim";
import { buildPeriodicNoiseTexture } from "./noise";
import { createSpriteBatch } from "./sprites";
import { grassMeta } from "./grass.meta";
import { defineEffect } from "./types";
import { lookup } from "./lookup";

/** Blade layout seed: the field is the same every time. */
const SEED = 55;
/** Thinnest blade at 1080p (px), against aliasing at 4K, and the defocus blur of the nearest blades. */
const MIN_WIDTH_PX = 1.5;
const NEAR_BLUR_PX = 7;
/** Cloud drift: whole texture widths per wind period. */
const CLOUD_CX = 8;
/** Sun disc radius as a fraction of the height. */
const SUN_RADIUS = 0.032;

const f = glslFloat;

/**
 * The wind, shared by the blades (per vertex, at the root) and the ground band
 * (per pixel), twinned by `windBend` in grass-sim.ts: two travelling sines plus
 * one fetch of gust-band noise. Every term is a whole number of cycles per wind
 * period, so `uPhase` wraps at 1 without a jump.
 */
const WIND_GLSL = /* glsl */ `
uniform sampler2D uNoise;
/** Wind phase, 0..1 over one wind period. */
uniform float uPhase;
/** Wind strength, gusts. */
uniform vec2 uWind;
const float TAU = 6.28318530718;
float windAt(vec2 p) {
  vec2 g = p * vec2(${f(GUST_FX)}, ${f(GUST_FZ)}) - vec2(${f(GUST_CX)}, ${f(GUST_CZ)}) * uPhase;
  vec4 n = textureLod(uNoise, g, 0.0);
  float gust = smoothstep(${f(GUST_LO)}, ${f(GUST_HI)}, n.r * 0.7 + n.g * 0.3);
  float wave = ${f(WAVE1.amp)} * sin(TAU * fract(dot(p, vec2(${f(WAVE1.kx)}, ${f(WAVE1.kz)})) - ${f(WAVE1.n)} * uPhase))
    + ${f(WAVE2.amp)} * sin(TAU * fract(dot(p, vec2(${f(WAVE2.kx)}, ${f(WAVE2.kz)})) - ${f(WAVE2.n)} * uPhase));
  return uWind.x * (${f(BEND_BASE)} + ${f(BEND_SWAY)} * wave * (1.0 - 0.5 * uWind.y)
    + ${f(BEND_GUST)} * uWind.y * gust);
}
`;

/**
 * One blade: a 7-vertex strip, `(level, side)` per vertex. The root's wind
 * bends it along three equal segments (constant length; the tip turns most),
 * offset sideways by the half width plus half the blur, so the fragment shader
 * can anti-alias (or defocus) the edge from `vOff` alone. Colour is per vertex.
 */
const BLADE_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec2 aCorner;
/** Root x (fraction of the width), depth z, height and base width (grass-band heights at z = 1). */
layout(location = 1) in vec4 aBlade;
/** Tone 0..1, own-sway cycles per wind period, flex, rest lean (radians). */
layout(location = 2) in vec4 aTraits;
uniform vec2 uResolution;
/** Horizon y (px from the top) and grass-band height (px). */
uniform vec2 uField;
/** Minimum blade width and nearest-blade blur, px. */
uniform vec2 uWidthPx;
uniform vec3 uRoot;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uUnder;
uniform vec3 uHead;
/** Seed-head share and width factor. */
uniform vec2 uHeadShape;
uniform vec3 uLight;
/** Backlight colour times strength. */
uniform vec3 uGlow;
uniform vec3 uHaze;
uniform float uSunX;
out vec3 vColor;
out vec3 vGlow;
out float vOff;
out float vHalfW;
out float vBlur;
flat out float vAlpha;
${TO_CLIP_GLSL}
${WIND_GLSL}
void main() {
  float z = aBlade.y;
  float d = 1.0 / z;
  float width = uResolution.x;
  float rootX = aBlade.x * width;
  float rootY = uField.x + uField.y * d;
  float bend = windAt(vec2((rootX - 0.5 * width) / uField.y * z, z));
  float sway = (0.03 + 0.06 * uWind.x) * sin(TAU * fract(aTraits.y * uPhase + aTraits.x * 7.0));
  float tip = clamp(aTraits.w + bend * ${f(MAX_BEND)} * aTraits.z + sway, ${f(-BEND_LIMIT)}, ${f(BEND_LIMIT)});
  float a0 = tip * ${f(SEGMENT_BEND[0])};
  float a1 = tip * ${f(SEGMENT_BEND[1])};
  float a2 = tip * ${f(SEGMENT_BEND[2])};
  float seg = aBlade.z * uField.y * d / 3.0;
  int level = int(aCorner.x + 0.5);
  // Centre line in (x, up) px from the root, and the direction across it.
  vec2 p = vec2(0.0);
  if (level >= 1) p += seg * vec2(sin(a0), cos(a0));
  if (level >= 2) p += seg * vec2(sin(a1), cos(a1));
  if (level >= 3) p += seg * vec2(sin(a2), cos(a2));
  float across = level == 0 ? a0 : (level == 1 ? 0.5 * (a0 + a1) : 0.5 * (a1 + a2));

  float tone = aTraits.x;
  float head = step(fract(tone * 37.13), uHeadShape.x);
  float taper = level == 0 ? 1.0 : (level == 1 ? 0.8 : (level == 2 ? 0.5 * mix(1.0, uHeadShape.y, head) : 0.0));
  float halfW = 0.5 * max(uWidthPx.x, aBlade.w * uField.y * d) * taper;
  float blur = max(1.0, uWidthPx.y * smoothstep(0.85, 1.25, d));
  float off = aCorner.y * (halfW + 0.5 * blur);
  p += off * vec2(cos(across), -sin(across));
  gl_Position = pxToClip(vec2(rootX + p.x, rootY - p.y), uResolution);
  vOff = off;
  vHalfW = halfW;
  vBlur = blur;

  float s = aCorner.x / 3.0;
  vec3 col = mix(uRoot, mix(uColA, uColB, tone), 0.3 + 0.7 * smoothstep(0.0, 0.6, s));
  // Bent blades show their lighter undersides: this is what makes the wind visible.
  col = mix(col, uUnder, 0.55 * s * smoothstep(0.15, 1.1, abs(bend) * aTraits.z));
  col = mix(col, uHead, head * smoothstep(0.55, 0.7, s));
  col *= uLight;
  float sunDx = (rootX - uSunX) / width * 3.0;
  float haze = 0.6 * (1.0 - smoothstep(${f(D_MIN)}, 0.7, d));
  vColor = mix(col, uHaze, haze);
  vGlow = uGlow * (s * s * (0.35 + 0.65 * exp(-sunDx * sunDx)) * (1.0 - haze));
  // Far blades fade out over the distance band, which carries on without them.
  vAlpha = smoothstep(${f(D_MIN)}, ${f(D_MIN * 1.7)}, d);
}
`;

/** Edge coverage (anti-aliasing, or defocus for the nearest blades) and the backlit rim. */
const BLADE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColor;
in vec3 vGlow;
in float vOff;
in float vHalfW;
in float vBlur;
flat in float vAlpha;
out vec4 outColor;
void main() {
  float edge = clamp((vHalfW - abs(vOff)) / vBlur + 0.5, 0.0, 1.0);
  float rim = clamp(abs(vOff) / max(vHalfW, 0.001), 0.0, 1.0);
  outColor = vec4(vColor + vGlow * (0.35 + 0.65 * rim * rim), edge * vAlpha);
}
`;

/**
 * Sky above the horizon (gradient, sun glow and disc, one-fetch clouds) and the
 * ground below it: the distance band, shaded with the same wind as the blades,
 * darkening towards the roots near the bottom and hazing towards the horizon.
 * Every pixel is shaded once.
 */
const BACKGROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform vec2 uResolution;
uniform vec2 uField;
uniform vec3 uZenith;
uniform vec3 uHorizon;
/** Sky glow colour times strength. */
uniform vec3 uGlowSky;
uniform vec3 uHaze;
/** Sun centre (px from the top-left) and disc visibility. */
uniform vec3 uSun;
uniform float uCover;
uniform vec3 uCloud;
uniform vec3 uShade;
/** Lit ground colours: mid blade, roots, undersides. */
uniform vec3 uBand;
uniform vec3 uRootLit;
uniform vec3 uUnderLit;
out vec4 outColor;
${WIND_GLSL}
${DITHER_GLSL}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  float h = uResolution.y;
  vec2 ds = (px - uSun.xy) / h;
  float r2 = dot(ds, ds);
  vec3 c;
  if (px.y < uField.x) {
    float v = (uField.x - px.y) / max(uField.x, 1.0);
    c = mix(uHorizon, uZenith, v * (2.0 - v));
    c += uGlowSky * (0.55 * exp(-r2 * 8.0) + 0.45 * exp(-r2 * 70.0));
    float disc = uSun.z * clamp((${f(SUN_RADIUS)} * h - sqrt(r2) * h) + 0.5, 0.0, 1.0);
    c = mix(c, vec3(1.0, 0.95, 0.84), disc);
    // A cloud plane: four tiling octaves in one fetch, stretched towards the horizon.
    float k = 1.0 / (v + 0.2);
    vec2 cuv = vec2((px.x - 0.5 * uResolution.x) / h * 0.12 * k + ${f(CLOUD_CX)} * uPhase, 0.25 * k);
    float fbm = dot(textureLod(uNoise, cuv, 0.0), vec4(0.45, 0.3, 0.16, 0.09));
    float t0 = mix(0.6, 0.4, uCover);
    float cloud = smoothstep(t0, t0 + 0.14, fbm) * smoothstep(0.02, 0.3, v);
    vec3 cc = mix(uShade, uCloud, smoothstep(t0, t0 + 0.3, fbm)) + uGlowSky * 0.4 * exp(-r2 * 12.0);
    c = mix(c, cc, 0.85 * cloud);
  } else {
    float d = (px.y - uField.x) / max(uField.y, 1.0);
    float z = 1.0 / max(d, 0.01);
    float bend = windAt(vec2((px.x - 0.5 * uResolution.x) / max(uField.y, 1.0) * z, z));
    // The wind fades out near the horizon, where its bands would be finer than a pixel.
    float sheen = smoothstep(0.15, 1.1, abs(bend)) * smoothstep(0.015, 0.08, d);
    float deep = smoothstep(0.2, 0.9, d);
    c = mix(uBand, uRootLit, deep);
    c = mix(c, uUnderLit, 0.45 * sheen * (1.0 - deep));
    float haze = 1.0 - smoothstep(0.0, 0.45, d);
    c = mix(c, uHaze, 0.85 * haze * haze) + uGlowSky * (0.3 * haze * exp(-r2 * 6.0));
  }
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

const mulInto = (out: Rgb, a: Rgb, b: Rgb, k = 1) => {
  out[0] = a[0] * b[0] * k;
  out[1] = a[1] * b[1] * k;
  out[2] = a[2] * b[2] * k;
};

/**
 * A field of tall grass from a low viewpoint, with gusts travelling across it.
 * Instanced blades (built once per count, sorted back to front) bent in the
 * vertex shader, over one full-screen pass of sky and a wind-shaded distance band.
 */
export const grass = defineEffect(grassMeta, {
  create(gl) {
    return withScope((scope) => {
      const bg = scope.add(createProgram(gl, FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ub = createUniforms(gl, bg, [
        "uNoise",
        "uPhase",
        "uWind",
        "uResolution",
        "uField",
        "uZenith",
        "uHorizon",
        "uGlowSky",
        "uHaze",
        "uSun",
        "uCover",
        "uCloud",
        "uShade",
        "uBand",
        "uRootLit",
        "uUnderLit",
      ]);
      const blade = scope.add(createProgram(gl, BLADE_VERTEX, BLADE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const ug = createUniforms(gl, blade, [
        "uNoise",
        "uPhase",
        "uWind",
        "uResolution",
        "uField",
        "uWidthPx",
        "uRoot",
        "uColA",
        "uColB",
        "uUnder",
        "uHead",
        "uHeadShape",
        "uLight",
        "uGlow",
        "uHaze",
        "uSunX",
      ]);
      gl.useProgram(bg);
      ub.i1("uNoise", 0);
      gl.useProgram(blade);
      ug.i1("uNoise", 0);
      gl.useProgram(null);

      const noise = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, NOISE_CHANNELS),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const blades = scope.own(createSpriteBatch(gl, MAX_BLADES, [4, 4], [BLADE_STRIP]));
      /** Blades in the batch; -1 builds them on the first frame. */
      let built = -1;

      const band: Rgb = [0, 0, 0];
      const rootLit: Rgb = [0, 0, 0];
      const underLit: Rgb = [0, 0, 0];
      const glow: Rgb = [0, 0, 0];
      const glowSky: Rgb = [0, 0, 0];
      const mid: Rgb = [0, 0, 0];
      let width = 1;
      let height = 1;
      let scale = 1;
      /** Wind phase in periods, wrapped to [0, 1): every shader phase is whole cycles of it. */
      let phase = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          phase += Math.max(0, dt) * windRate(p.wind);
          phase -= Math.floor(phase);

          const count = bladeCount(p.density, width / Math.max(1, height));
          if (count !== built) {
            built = buildBlades(SEED, count, blades.data);
            blades.upload(built);
          }

          const fp = lookup(FIELDS, p.field, "meadow");
          const sp = lookup(SUNS, p.sun, "golden");
          mid[0] = (fp.a[0] + fp.b[0]) * 0.5;
          mid[1] = (fp.a[1] + fp.b[1]) * 0.5;
          mid[2] = (fp.a[2] + fp.b[2]) * 0.5;
          mulInto(band, mid, sp.light, 0.85);
          mulInto(rootLit, fp.root, sp.light);
          mulInto(underLit, fp.under, sp.light);
          for (let i = 0; i < 3; i++) {
            glow[i] = sp.glow[i] * sp.backlight;
            glowSky[i] = sp.glow[i] * sp.glowSky;
          }

          const horizon = Math.round(height * (1 - p.height));
          const span = height - horizon;
          const sunX = sp.sunX * width;
          const sunY = horizon * (1 - sp.sunY);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noise);

          gl.useProgram(bg);
          ub.f1("uPhase", phase);
          ub.f2("uWind", p.wind, p.gusts);
          ub.f2("uResolution", width, height);
          ub.f2("uField", horizon, span);
          ub.v3("uZenith", sp.zenith);
          ub.v3("uHorizon", sp.horizon);
          ub.v3("uGlowSky", glowSky);
          ub.v3("uHaze", sp.haze);
          ub.f3("uSun", sunX, sunY, sp.disc);
          ub.f1("uCover", sp.cover);
          ub.v3("uCloud", sp.cloud);
          ub.v3("uShade", sp.shade);
          ub.v3("uBand", band);
          ub.v3("uRootLit", rootLit);
          ub.v3("uUnderLit", underLit);
          triangle.draw();

          gl.useProgram(blade);
          ug.f1("uPhase", phase);
          ug.f2("uWind", p.wind, p.gusts);
          ug.f2("uResolution", width, height);
          ug.f2("uField", horizon, span);
          ug.f2("uWidthPx", MIN_WIDTH_PX * scale, NEAR_BLUR_PX * scale);
          ug.v3("uRoot", fp.root);
          ug.v3("uColA", fp.a);
          ug.v3("uColB", fp.b);
          ug.v3("uUnder", fp.under);
          ug.v3("uHead", fp.head);
          ug.f2("uHeadShape", fp.headShare, fp.headWidth);
          ug.v3("uLight", sp.light);
          ug.v3("uGlow", glow);
          ug.v3("uHaze", sp.haze);
          ug.f1("uSunX", sunX);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          blades.draw(0, built);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
