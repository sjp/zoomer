import {
  buildPresetTable,
  cloudNoiseChannels,
  coverageOpacity,
  coverageThreshold,
  createPresetTransition,
  LAYER_FLOATS,
  layerUniforms,
  P,
  presetIndex,
  STRETCH_X,
  TIME_OPTIONS,
} from "./clouds-sky";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createLowResTarget, QUALITY_OPTIONS, qualityDivisor } from "./lowres";
import { defineEffect } from "./types";
import { approach } from "./math";
import { buildPeriodicNoiseTexture } from "./noise";

/** Noise texture side, in texels. */
const NOISE_SIZE = 256;
const NOISE_SEED = 7;

/** Coarse noise texture repeats per frame height for the near layer at scale 1. */
const BASE_FREQ = 0.55;
/** The far layer's clouds are this many times smaller... */
const FAR_FREQ = 1.9;
/** ...and drift this fraction of the near layer's speed. */
const FAR_SPEED = 0.45;
/** Near-layer wind, in frame heights per second at speed 1. */
const WIND = 0.012;
/** Offset towards the light of the lighting sample, in texture units (~5 texels). */
const LIGHT_STEP = 0.02;
/** Per-layer opacity: the far layer is slightly thinner and hazier. */
const OPACITY = [1, 0.85] as const;
/** Seconds the far layer takes to fade in or out when the layer count changes. */
const LAYER_FADE = 1;
const HAZE = [0, 0.3] as const;

/**
 * Cloud pass, rendered at reduced resolution. Per layer: two coarse fetches (the
 * evolving cross-fade), one detail fetch, and one coarse fetch offset towards the
 * light from the higher-weighted sample for the fake lighting (two only while
 * the lighting cross-fades near the A/B swap; see `lightWeight`). So 8 fetches
 * per pixel with two layers, 10 for about a fifth of the time. Output is
 * premultiplied RGBA.
 */
const CLOUD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform float uAspect;
uniform int uLayers;
/** Per layer: xy = coarse offset of sample A, zw = of sample B (texture units). */
uniform vec4 uOffA[2];
/** Per layer: xy = detail offset, z = detail frequency, w = light weight of A. */
uniform vec4 uDetail[2];
/** Per layer: x = coarse frequency, y = weight of A, z = contrast fix, w = opacity. */
uniform vec4 uLayerP[2];
/** Density threshold (from coverage). */
uniform float uThreshold;
/**
 * Direction towards the light times LIGHT_STEP, in texture units (x squashed by
 * STRETCH_X, like the texture coordinates).
 */
uniform vec2 uSunStep;
uniform vec3 uCloudLight;
uniform vec3 uCloudShadow;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
in vec2 vUv;
out vec4 outColor;

const vec4 OCT = vec4(0.5, 0.25, 0.125, 0.0625);
/** Mean of dot(texel, OCT) for mid-grey texels. */
const float MEAN = 0.46875;
/** Brings the 4-octave sum to roughly unit standard deviation. */
const float NORM = 10.0;
const float EDGE = 0.9;
const float LIGHT_GAIN = 1.2;

vec4 cloudLayer(vec2 q, vec4 off, vec4 det, vec4 lp, float haze, vec3 sky) {
  vec2 t = q * lp.x;
  // Evolving coarse fbm (4 octaves): A and B cross-faded, centred, before NORM.
  float a = dot(texture(uNoise, t + off.xy), OCT);
  float b = dot(texture(uNoise, t + off.zw), OCT);
  float c = (mix(b, a, lp.y) - MEAN) * lp.z;
  // Gradient towards the light, from the dominant sample only. The branches
  // depend only on uniforms, so every pixel takes the same path.
  float lw = det.w;
  float g = 0.0;
  if (lw > 0.0) g += lw * (dot(texture(uNoise, t + uSunStep + off.xy), OCT) - a);
  if (lw < 1.0) g += (1.0 - lw) * (dot(texture(uNoise, t + uSunStep + off.zw), OCT) - b);
  // Mixing two independent gradients lowers their contrast; undo it as for c.
  g *= inversesqrt(lw * lw + (1.0 - lw) * (1.0 - lw));
  float d = dot(texture(uNoise, q * det.z + det.xy), OCT) - MEAN;
  float n = (c + 0.25 * d) * NORM;
  float dens = smoothstep(uThreshold, uThreshold + EDGE, n);
  // Denser towards the light means this point is in the cloud's own shadow.
  float lit = clamp(0.62 - g * (NORM * LIGHT_GAIN) - 0.15 * dens, 0.0, 1.0);
  vec3 col = mix(mix(uCloudShadow, uCloudLight, lit), sky, haze);
  float a = dens * lp.w;
  return vec4(col * a, a);
}

void main() {
  vec2 q = vec2(vUv.x * uAspect * ${glslFloat(STRETCH_X)}, vUv.y);
  float h = vUv.y;
  vec3 sky = mix(uSkyBottom, uSkyTop, h * (2.0 - h));
  vec4 acc = cloudLayer(q, uOffA[0], uDetail[0], uLayerP[0], ${glslFloat(HAZE[0])}, sky);
  if (uLayers > 1) {
    vec4 far = cloudLayer(q, uOffA[1], uDetail[1], uLayerP[1], ${glslFloat(HAZE[1])}, sky);
    acc += far * (1.0 - acc.a);
  }
  outColor = acc;
}
`;

/** Full-resolution composite: sky gradient + sun/moon glow, then the clouds over it. */
const COMPOSITE = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uGlowColor;
/** xy = sun/moon position (uv), z = glow radius, w = glow strength. */
uniform vec4 uSun;
/** x = disc radius, y = disc strength. Radii are in frame heights. */
uniform vec2 uDisc;
uniform float uAspect;
vec4 composite(vec2 uv) {
  float h = uv.y;
  vec3 sky = mix(uSkyBottom, uSkyTop, h * (2.0 - h));
  float d = length((uv - uSun.xy) * vec2(uAspect, 1.0));
  float g = uSun.w * exp(-d / uSun.z);
  float disc = uDisc.y * (1.0 - smoothstep(uDisc.x * 0.85, uDisc.x, d));
  sky += uGlowColor * g + mix(uGlowColor, vec3(1.0), 0.6) * disc;
  vec4 c = texture(uLowRes, uv);
  // Clouds near the sun pick up its glow (silver lining).
  return vec4(sky * (1.0 - c.a) + c.rgb + uGlowColor * (0.6 * g * c.a), 1.0);
}
`;

/**
 * A sky timelapse: fbm cumulus clouds with fake directional lighting drift and
 * slowly evolve over a time-of-day sky gradient with a sun or moon glow. The
 * clouds render at reduced resolution from a precomputed tileable noise texture
 * (four octaves per fetch); the sky is composited analytically while upscaling.
 */
export const clouds = defineEffect({
  id: "clouds",
  name: "Time-lapse Clouds",
  description: "Fluffy clouds drifting and evolving across a day, golden hour, dusk or night sky.",
  params: {
    time: { kind: "select", label: "Time of day", options: TIME_OPTIONS, default: "day" },
    coverage: { kind: "number", label: "Cloud cover", min: 0, max: 1, step: 0.01, default: 0.5 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    scale: { kind: "number", label: "Cloud size", min: 0.5, max: 2, step: 0.05, default: 1 },
    layers: { kind: "number", label: "Layers", min: 1, max: 2, step: 1, default: 2 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, CLOUD_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const u = createUniforms(gl, program, [
        "uNoise",
        "uAspect",
        "uLayers",
        "uOffA",
        "uDetail",
        "uLayerP",
        "uThreshold",
        "uSunStep",
        "uCloudLight",
        "uCloudShadow",
        "uSkyTop",
        "uSkyBottom",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uSkyTop",
        "uSkyBottom",
        "uGlowColor",
        "uSun",
        "uDisc",
        "uAspect",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);

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
      // Mipmaps keep the detail fetch from aliasing at low quality settings.
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const transition = createPresetTransition(buildPresetTable());
      const offA = new Float32Array(2 * LAYER_FLOATS);
      const detail = new Float32Array(2 * LAYER_FLOATS);
      const layerP = new Float32Array(2 * LAYER_FLOATS);

      let width = 1;
      let height = 1;
      let sizeDirty = true;
      let lastTime = "";
      let timeIndex = 0;
      /** Wind travel per layer (frame heights) and evolution time; float64. */
      let driftNear = 0;
      let driftFar = 0;
      let evolve = 0;
      /** Far layer's fade, 0..1; NaN before the first frame, which starts at its target. */
      let farFade = Number.NaN;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          sizeDirty = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, dt) * p.speed;
          driftNear += step * WIND;
          driftFar += step * WIND * FAR_SPEED;
          evolve += step;
          const farTarget = p.layers >= 1.5 ? 1 : 0;
          if (Number.isNaN(farFade)) farFade = farTarget;
          const fadeStep = Math.max(0, dt) / LAYER_FADE;
          farFade = approach(farFade, farTarget, fadeStep);
          // The far layer costs its fetches only while it is at all visible.
          const layers = farFade > 0 ? 2 : 1;
          const freq = BASE_FREQ / Math.max(0.1, p.scale);

          target.resize(width, height, qualityDivisor(p.quality));

          if (p.time !== lastTime) {
            lastTime = p.time;
            timeIndex = presetIndex(p.time);
          }
          if (transition.update(dt, timeIndex)) {
            const v = transition.values;
            gl.useProgram(program);
            u.f3("uSkyTop", v[P.skyTop], v[P.skyTop + 1], v[P.skyTop + 2]);
            u.f3("uSkyBottom", v[P.skyBottom], v[P.skyBottom + 1], v[P.skyBottom + 2]);
            u.f3("uCloudLight", v[P.cloudLight], v[P.cloudLight + 1], v[P.cloudLight + 2]);
            u.f3("uCloudShadow", v[P.cloudShadow], v[P.cloudShadow + 1], v[P.cloudShadow + 2]);
            // The blended light direction may be shorter than 1; that only softens shading.
            // The step is in texture space, where x is squashed by STRETCH_X: squash it
            // too, so the shading follows the preset's on-screen direction rather than
            // leaning towards the horizontal.
            u.f2("uSunStep", v[P.lightX] * STRETCH_X * LIGHT_STEP, v[P.lightY] * LIGHT_STEP);
            gl.useProgram(target.program);
            cu.f3("uSkyTop", v[P.skyTop], v[P.skyTop + 1], v[P.skyTop + 2]);
            cu.f3("uSkyBottom", v[P.skyBottom], v[P.skyBottom + 1], v[P.skyBottom + 2]);
            cu.f3("uGlowColor", v[P.glow], v[P.glow + 1], v[P.glow + 2]);
            cu.f4("uSun", v[P.sunX], v[P.sunY], Math.max(1e-3, v[P.glowRadius]), v[P.glowStrength]);
            cu.f2("uDisc", Math.max(1e-3, v[P.discRadius]), v[P.discStrength]);
          }
          if (sizeDirty) {
            sizeDirty = false;
            const aspect = width / height;
            gl.useProgram(target.program);
            cu.f1("uAspect", aspect);
            gl.useProgram(program);
            u.f1("uAspect", aspect);
          }

          // Cloud pass, into the low-res target.
          gl.useProgram(program);
          u.f1("uThreshold", coverageThreshold(p.coverage));
          u.i1("uLayers", layers);
          const cover = coverageOpacity(p.coverage);
          layerUniforms(offA, detail, layerP, 0, 0, driftNear, evolve, freq, OPACITY[0] * cover);
          layerUniforms(
            offA,
            detail,
            layerP,
            LAYER_FLOATS,
            1,
            driftFar,
            evolve,
            freq * FAR_FREQ,
            OPACITY[1] * farFade * cover,
          );
          gl.uniform4fv(u.loc.uOffA, offA);
          gl.uniform4fv(u.loc.uDetail, detail);
          gl.uniform4fv(u.loc.uLayerP, layerP);
          target.bind();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          triangle.draw();

          // Composite: sky + glow, then the upscaled clouds, to the canvas.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
