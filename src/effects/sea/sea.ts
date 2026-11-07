import { createChangeKey } from "../change-key";
import { beginFrame, createFullscreenTriangle, createUniforms, withScope } from "../gl";
import { createSkyState } from "../horizon/horizon-sim";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { clamp } from "../math";
import { landColor, presetSky, seaPreset } from "./sea-sim";
import {
  createSeaWater,
  createSeaWaterFrame,
  SEA_LAND_UNIFORMS,
  SEA_SKY_GLSL,
  SEA_SKY_UNIFORMS,
} from "./sea-water";
import { seaMeta } from "./sea.meta";
import { defineEffect } from "../types";

/** Camera height above the water, metres. */
const CAMERA_HEIGHT = 3;
/** Focal length as a multiple of the frame height (about 40° vertical field of view). */
const FOCAL = 1.4;
/** Strength of the glitter path at `glitter` = 1. */
const GLITTER_GAIN = 0.55;
/** Cap on the reflectance, so the far water stays a shade darker than the sky at the horizon. */
const FRESNEL_MAX = 0.8;

/**
 * Composite while upscaling: the sky, the sun or moon disc and the headland at
 * full resolution above the horizon, the low-res water below, and a one-pixel
 * anti-aliased blend across the horizon so it stays crisp.
 */
const COMPOSITE_GLSL = /* glsl */ `
${SEA_SKY_GLSL}
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

/**
 * Open water at dusk from a low viewpoint: a gentle swell under an analytic sky,
 * with a soft glitter path below an off-centre sun or moon and an optional distant
 * headland. The water renders at reduced resolution; the sky and the horizon line
 * are drawn at full resolution in the upscale.
 */
export const sea = defineEffect(seaMeta, {
  create(gl) {
    return withScope((scope) => {
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE_GLSL }));
      const compU = createUniforms(gl, target.program, [
        "uFrame",
        "uDisc",
        "uDiscColor",
        ...SEA_SKY_UNIFORMS,
        ...SEA_LAND_UNIFORMS,
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const water = scope.own(createSeaWater(gl, triangle, 43));

      // Static uniforms.
      gl.useProgram(target.program);
      compU.i1("uLand", 1);
      gl.useProgram(null);

      const sky = createSkyState();
      const wf = createSeaWaterFrame(sky);
      const landRgb = wf.landColor;
      const lightColor = wf.lightColor;
      const presetKey = createChangeKey(1);
      const TIMES = ["sunset", "dusk", "moonlight", "overcast"];
      let preset = seaPreset("sunset");

      let width = 1;
      let height = 1;

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
          const wind = Math.max(0, p.wind);
          water.advance(dt, wind);

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
          // The headland is built rising from the left; mirror it when the sun is on the left.
          const mirror = p.sunX < 0.5;

          // 1. Water, low-res, rows below the horizon only.
          wf.lowToFullX = width / lowW;
          wf.lowToFullY = pxLow;
          wf.centreX = width / 2;
          wf.horizonPx = horizonPx;
          wf.focalPx = focalPx;
          wf.focal = FOCAL;
          wf.cameraHeight = CAMERA_HEIGHT;
          wf.aspectInv = height / width;
          wf.swell = p.swell;
          wf.wind = wind;
          wf.lightX = sunQx;
          wf.lightY = preset.lightY;
          wf.roughness = preset.roughness;
          wf.fresnelMax = FRESNEL_MAX;
          wf.deep = preset.deep;
          wf.skyK = skyK;
          wf.land = p.land;
          wf.mirror = mirror;
          target.bind();
          gl.viewport(0, 0, lowW, waterRows);
          water.draw(wf);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          // 2. Sky, disc, headland and horizon at full res, water upscaled.
          gl.useProgram(target.program);
          compU.f4("uFrame", width / 2, horizonPx, 1 / height, (waterRows - 0.5) / lowH);
          compU.f2("uDisc", preset.disc * height, preset.disc > 0 ? 1 : 0);
          compU.v3("uDiscColor", preset.discColor);
          compU.v3("uZenith", sky.zenith);
          compU.v3("uHorizon", sky.horizon);
          compU.v3("uGlow", sky.glow);
          compU.f4("uSkyA", sunQx, preset.lightY, sky.glowStrength, skyK);
          compU.v3("uLandColor", landRgb);
          compU.f2("uLandMap", p.land ? 1 : 0, mirror ? 1 : 0);
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
