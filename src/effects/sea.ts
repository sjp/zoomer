import type { Rgb } from "./color";
import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createSkyState } from "./horizon-sim";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { clamp, wrap } from "./math";
import {
  advanceSwellPhases,
  buildHeadland,
  buildRippleSlopes,
  LAND_COLUMNS,
  landColor,
  presetSky,
  resolveSwells,
  seaPreset,
  WATER_F0,
} from "./sea-sim";
import { seaMeta } from "./sea.meta";
import { defineEffect } from "./types";

/** Camera height above the water, metres. */
const CAMERA_HEIGHT = 3;
/** Focal length as a multiple of the frame height (about 40° vertical field of view). */
const FOCAL = 1.4;
const RIPPLE_SIZE = 256;
/** World size (m) of one ripple texture period for the two layers. */
const RIPPLE_TILE_A = 20;
const RIPPLE_TILE_B = 7;
/** Ripple layer B's rotation against layer A, radians. */
const RIPPLE_ROT_B = 0.7;
/** RMS slope of each ripple layer at `wind` = 1. */
const RIPPLE_RMS_A = 0.06;
const RIPPLE_RMS_B = 0.045;
/** Ripple drift velocities (m/s) at `wind` = 1, in each layer's own texture axes. */
const RIPPLE_DRIFT_A: readonly [number, number] = [0.12, -0.32];
const RIPPLE_DRIFT_B: readonly [number, number] = [-0.28, -0.2];
/** Strength of the glitter path at `glitter` = 1. */
const GLITTER_GAIN = 0.55;
/** Cap on the reflectance, so the far water stays a shade darker than the sky at the horizon. */
const FRESNEL_MAX = 0.8;

/**
 * Analytic sky in "frame heights" from the horizon centre: the horizon-to-zenith
 * gradient and the two-term sun glow of horizon.ts. Shared by the water (for its
 * reflections) and the composite (for the sky itself), so they match exactly.
 */
const SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
/** Sun or moon centre (frame heights from the horizon centre), glow strength, 1 / sky height. */
uniform vec4 uSkyA;
vec3 sky(vec2 q) {
  float t = clamp(q.y * uSkyA.w, 0.0, 1.0);
  t = t * (2.0 - t);
  vec3 col = mix(uHorizon, uZenith, t);
  float d = length(q - uSkyA.xy);
  float glow = uSkyA.z * (0.5 * exp2(-9.0 * d) + 0.5 * exp2(-2.2 * d) * (1.0 - 0.7 * t));
  return mix(col, uGlow, min(glow, 1.0));
}
`;

/**
 * Water, at reduced resolution over the rows below the horizon. The view ray hits
 * the plane y = 0 analytically; three sine swells (analytic gradient) and two
 * ripple slope fetches perturb the normal, each faded out as the pixel's footprint
 * on the water outgrows it. The variance faded out widens the glitter lobe instead,
 * so the far glitter path is a smooth band rather than aliased sparkle.
 */
const WATER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uRipples;
uniform sampler2D uLand;
/** Full-res px per low-res px (x, y). */
uniform vec2 uLowToFull;
/** Centre x, horizon y (full px), 1 / focal (full px), focal in frame heights. */
uniform vec4 uView;
/** Camera height (m), footprint factor (m per low-res px per z²), frame height / width. */
uniform vec3 uCam;
/** Per swell: wave vector (rad/m), height amplitude (m), phase. */
uniform vec4 uWave[3];
/** Per swell: (k / 2)², for its footprint fade. */
uniform vec3 uWaveFade;
/** Ripple layer offsets in texture periods: A.xy, B.xy. */
uniform vec4 uRipOff;
uniform mat2 uRipRot;
/** 1 / tile size A and B (1/m), slope scale A and B. */
uniform vec4 uRip;
/** 1 / cell size A and B (1/m), slope variance A and B. */
uniform vec4 uRipFade;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
/** Base m², reflectance cap. */
uniform vec2 uRough;
uniform vec3 uDeep;
uniform vec3 uLandColor;
/** Land on (0 or 1), mirrored (0 or 1). */
uniform vec2 uLandMap;
out vec4 outColor;
${SKY_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy * uLowToFull;
  vec2 s = (p - uView.xy) * uView.z;
  // Rows at or above the horizon continue the far water, so the upscale stays smooth.
  s.y = min(s.y, -1e-4);
  float z = uCam.x / -s.y;
  vec2 P = vec2(s.x * z, z);
  float fp = z * z * uCam.y;

  // Swells: analytic gradient, each faded as its wavelength falls below the footprint.
  vec2 g = vec2(0.0);
  float lost = 0.0;
  vec3 fade = 1.0 / (1.0 + fp * fp * uWaveFade);
  for (int i = 0; i < 3; i++) {
    vec4 w = uWave[i];
    float a = w.z * fade[i];
    g += w.xy * (a * cos(dot(w.xy, P) + w.w));
    lost += 0.5 * dot(w.xy, w.xy) * (w.z * w.z - a * a);
  }

  // Ripples: two fetches at two scales, drifting in different directions.
  vec2 rf = clamp(1.5 - fp * uRipFade.xy, 0.0, 1.0);
  vec2 ra = texture(uRipples, P * uRip.x + uRipOff.xy).rg * 2.0 - 1.0;
  vec2 rb = texture(uRipples, (uRipRot * P) * uRip.y + uRipOff.zw).rg * 2.0 - 1.0;
  g += ra * (uRip.z * rf.x) + (rb * uRipRot) * (uRip.w * rf.y);
  lost += dot(uRipFade.zw, 1.0 - rf * rf);

  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 d = normalize(vec3(s, 1.0));
  vec3 r = reflect(d, n);
  r.y = max(r.y, 0.0);
  vec2 q = r.xy / max(r.z, 1e-3) * uView.w;
  vec3 refl = sky(q);
  if (uLandMap.x > 0.5) {
    float u = 0.5 + q.x * uCam.z;
    u = mix(u, 1.0 - u, uLandMap.y);
    float lh = texture(uLand, vec2(u, 0.5)).r;
    refl = mix(refl, uLandColor, smoothstep(0.0, 0.003, lh - q.y));
  }

  // Schlick Fresnel, capped.
  float m = 1.0 - max(dot(n, -d), 0.0);
  float m2 = m * m;
  float F = min(${glslFloat(WATER_F0)} + ${glslFloat(1 - WATER_F0)} * m2 * m2 * m, uRough.y);
  vec3 col = mix(uDeep, refl, F);

  // Glitter: normalised Blinn-Phong whose exponent falls as the footprint smooths the normals.
  float rough = uRough.x + lost;
  float sp = 2.0 / rough - 2.0;
  vec3 h = normalize(uLightDir - d);
  float ndh = max(dot(n, h), 0.0);
  col += uLightColor * (pow(ndh, sp) * (sp + 8.0) * (${glslFloat(1 / (8 * Math.PI))} * F));
  outColor = vec4(col, 1.0);
}
`;

/**
 * Composite while upscaling: the sky, the sun or moon disc and the headland at
 * full resolution above the horizon, the low-res water below, and a one-pixel
 * anti-aliased blend across the horizon so it stays crisp.
 */
const COMPOSITE_GLSL = /* glsl */ `
${SKY_GLSL}
/** Centre x, horizon y (px), 1 / frame height, highest low-res v holding water. */
uniform vec4 uFrame;
/** Disc radius (px), disc opacity. */
uniform vec2 uDisc;
uniform vec3 uDiscColor;
uniform sampler2D uLand;
uniform vec3 uLandColor;
/** Land on (0 or 1), mirrored (0 or 1). */
uniform vec2 uLandMap;
vec4 composite(vec2 uv) {
  vec2 p = gl_FragCoord.xy;
  float above = clamp(p.y - uFrame.y + 0.5, 0.0, 1.0);
  // textureLod: these fetches sit in non-uniform branches, where implicit derivatives are undefined.
  vec3 col = vec3(0.0);
  if (above < 1.0) col = textureLod(uLowRes, vec2(uv.x, min(uv.y, uFrame.w)), 0.0).rgb;
  if (above > 0.0) {
    vec2 q = (p - uFrame.xy) * uFrame.z;
    vec3 c = sky(q);
    float dist = length(q - uSkyA.xy) / uFrame.z;
    c = mix(c, uDiscColor, clamp(uDisc.x - dist + 0.5, 0.0, 1.0) * uDisc.y);
    if (uLandMap.x > 0.5) {
      float lh = textureLod(uLand, vec2(mix(uv.x, 1.0 - uv.x, uLandMap.y), 0.5), 0.0).r;
      c = mix(c, uLandColor, clamp(lh / uFrame.z - (p.y - uFrame.y) + 0.5, 0.0, 1.0));
    }
    col = mix(col, c, above);
  }
  return vec4(col, 1.0);
}
`;

const SKY_UNIFORMS = ["uZenith", "uHorizon", "uGlow", "uSkyA"] as const;
const LAND_UNIFORMS = ["uLand", "uLandColor", "uLandMap"] as const;

/**
 * Open water at dusk from a low viewpoint: a gentle swell under an analytic sky,
 * with a soft glitter path below an off-centre sun or moon and an optional distant
 * headland. The water renders at reduced resolution; the sky and the horizon line
 * are drawn at full resolution in the upscale.
 */
export const sea = defineEffect(seaMeta, {
  create(gl) {
    return withScope((scope) => {
      const waterProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, WATER_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const waterU = createUniforms(gl, waterProgram, [
        "uRipples",
        "uLowToFull",
        "uView",
        "uCam",
        "uWave",
        "uWaveFade",
        "uRipOff",
        "uRipRot",
        "uRip",
        "uRipFade",
        "uLightDir",
        "uLightColor",
        "uRough",
        "uDeep",
        ...SKY_UNIFORMS,
        ...LAND_UNIFORMS,
      ]);
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE_GLSL }));
      const compU = createUniforms(gl, target.program, [
        "uFrame",
        "uDisc",
        "uDiscColor",
        ...SKY_UNIFORMS,
        ...LAND_UNIFORMS,
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const ripple = buildRippleSlopes(RIPPLE_SIZE, 0x5ea);
      const rippleTex = scope.add(
        createDataTexture(gl, {
          width: RIPPLE_SIZE,
          height: RIPPLE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: ripple.data,
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const land = scope.own(createColumnTable(gl, LAND_COLUMNS, 1));
      buildHeadland(land.data, 43);
      land.upload();

      // Static uniforms.
      const cosB = Math.cos(RIPPLE_ROT_B);
      const sinB = Math.sin(RIPPLE_ROT_B);
      gl.useProgram(waterProgram);
      waterU.i1("uRipples", 0);
      waterU.i1("uLand", 1);
      gl.uniformMatrix2fv(waterU.loc.uRipRot, false, [cosB, sinB, -sinB, cosB]);
      gl.useProgram(target.program);
      compU.i1("uLand", 1);
      gl.useProgram(null);

      const waves = resolveSwells();
      const phases = new Float64Array(waves.length);
      const waveData = new Float32Array(waves.length * 4);
      let ripAx = 0;
      let ripAy = 0;
      let ripBx = 0;
      let ripBy = 0;

      const sky = createSkyState();
      const landRgb: Rgb = [0, 0, 0];
      const lightColor: Rgb = [0, 0, 0];
      const presetKey = createChangeKey(1);
      const TIMES = ["sunset", "dusk", "moonlight", "overcast"];
      let preset = seaPreset("sunset");

      let width = 1;
      let height = 1;

      const setSky = (u: typeof waterU | typeof compU, sunQx: number, skyK: number) => {
        u.v3("uZenith", sky.zenith);
        u.v3("uHorizon", sky.horizon);
        u.v3("uGlow", sky.glow);
        u.f4("uSkyA", sunQx, preset.lightY, sky.glowStrength, skyK);
      };

      return {
        resize(v) {
          width = v.width;
          height = v.height;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          presetKey.set(0, TIMES.indexOf(p.time));
          if (presetKey.take()) {
            preset = seaPreset(p.time);
            presetSky(preset, sky);
            landColor(sky, landRgb);
          }
          const glitter = clamp(p.glitter, 0, 1) * preset.intensity * GLITTER_GAIN;
          for (let c = 0; c < 3; c++) {
            lightColor[c] = preset.lightColor[c] * glitter;
          }

          // Motion: swell phases and ripple drift, wrapped.
          advanceSwellPhases(phases, waves, dt);
          const wind = Math.max(0, p.wind);
          const windDrift = dt * (0.5 + 0.5 * wind);
          ripAx = wrap(ripAx + (RIPPLE_DRIFT_A[0] * windDrift) / RIPPLE_TILE_A, 0, 1);
          ripAy = wrap(ripAy + (RIPPLE_DRIFT_A[1] * windDrift) / RIPPLE_TILE_A, 0, 1);
          ripBx = wrap(ripBx + (RIPPLE_DRIFT_B[0] * windDrift) / RIPPLE_TILE_B, 0, 1);
          ripBy = wrap(ripBy + (RIPPLE_DRIFT_B[1] * windDrift) / RIPPLE_TILE_B, 0, 1);

          // Geometry.
          target.resize(width, height, qualityDivisor(p.quality));
          const lowW = target.width;
          const lowH = target.height;
          const horizonPx = clamp(p.horizon, 0.3, 0.9) * height;
          const focalPx = FOCAL * height;
          const pxLow = height / lowH;
          const waterRows = Math.min(lowH, Math.ceil(horizonPx / pxLow) + 2);
          const sunQx = (clamp(p.sunX, 0, 1) - 0.5) * (width / height);
          const skyK = height / Math.max(1, height - horizonPx);
          const sunLeft = p.sunX < 0.5;
          const landOn = p.land ? 1 : 0;
          // The headland is built rising from the left; mirror it when the sun is on the left.
          const mirror = sunLeft ? 1 : 0;

          // 1. Water, low-res, rows below the horizon only.
          const swell = Math.max(0, p.swell);
          for (let i = 0; i < waves.length; i++) {
            const w = waves[i];
            waveData[i * 4] = w.kx;
            waveData[i * 4 + 1] = w.kz;
            waveData[i * 4 + 2] = w.amp * swell;
            waveData[i * 4 + 3] = phases[i];
          }
          target.bind();
          gl.viewport(0, 0, lowW, waterRows);
          gl.useProgram(waterProgram);
          gl.uniform4fv(waterU.loc.uWave, waveData);
          waterU.f2("uLowToFull", width / lowW, height / lowH);
          waterU.f4("uView", width / 2, horizonPx, 1 / focalPx, FOCAL);
          waterU.f3("uCam", CAMERA_HEIGHT, pxLow / (focalPx * CAMERA_HEIGHT), height / width);
          waterU.f3(
            "uWaveFade",
            (waves[0].k / 2) ** 2,
            (waves[1].k / 2) ** 2,
            (waves[2].k / 2) ** 2,
          );
          waterU.f4("uRipOff", ripAx, ripAy, ripBx, ripBy);
          const ampA = (RIPPLE_RMS_A * wind) / ripple.rms;
          const ampB = (RIPPLE_RMS_B * wind) / ripple.rms;
          waterU.f4("uRip", 1 / RIPPLE_TILE_A, 1 / RIPPLE_TILE_B, ampA, ampB);
          // Fade each layer once the footprint passes its noise cell; its variance moves to the lobe.
          waterU.f4(
            "uRipFade",
            8 / RIPPLE_TILE_A,
            8 / RIPPLE_TILE_B,
            2 * (RIPPLE_RMS_A * wind) ** 2,
            2 * (RIPPLE_RMS_B * wind) ** 2,
          );
          const lx = sunQx / FOCAL;
          const ly = preset.lightY / FOCAL;
          const ln = 1 / Math.hypot(lx, ly, 1);
          waterU.f3("uLightDir", lx * ln, ly * ln, ln);
          waterU.v3("uLightColor", lightColor);
          waterU.f2("uRough", preset.roughness, FRESNEL_MAX);
          waterU.v3("uDeep", preset.deep);
          setSky(waterU, sunQx, skyK);
          waterU.v3("uLandColor", landRgb);
          waterU.f2("uLandMap", landOn, mirror);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, land.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, rippleTex);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          // 2. Sky, disc, headland and horizon at full res, water upscaled.
          gl.useProgram(target.program);
          compU.f4("uFrame", width / 2, horizonPx, 1 / height, (waterRows - 0.5) / lowH);
          compU.f2("uDisc", preset.disc * height, preset.disc > 0 ? 1 : 0);
          compU.v3("uDiscColor", preset.discColor);
          setSky(compU, sunQx, skyK);
          compU.v3("uLandColor", landRgb);
          compU.f2("uLandMap", landOn, mirror);
          // Unit 1 still holds the headland table; blit binds the water to unit 0.
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
