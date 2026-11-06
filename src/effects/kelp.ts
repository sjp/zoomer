import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import {
  buildBladeProfiles,
  buildFronds,
  createFish,
  createSnow,
  fishInstances,
  FISH_PER_SCHOOL,
  FROND_STRIP,
  type FrondLayout,
  KELP_SWELL,
  LAYERS,
  MAX_FRONDS,
  MAX_SHAFTS,
  PALETTES,
  PROFILE_COLUMNS,
  PROFILE_ROWS,
  SEGMENTS,
  shaftUniforms,
  snowInstances,
  SNOW_COUNT,
  STIPE,
  stepFish,
  stepSnow,
  SWAY_MAX,
} from "./kelp-sim";
import { kelpMeta } from "./kelp.meta";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { advanceSwell, swayGlsl } from "./sway";
import { createSpriteBatch, QUAD } from "./sprites";
import { defineEffect } from "./types";
import { lookup } from "./lookup";

const f = glslFloat;

/** Profile rows are randomised per frond; the shapes themselves are fixed. */
const PROFILE_SEED = 58;
/** The water pass is soft everywhere: shafts are 40 px wide at 1080p at their narrowest. */
const WATER_DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** Surface ripple cycles per second at speed 1. */
const RIPPLE_RATE = 1 / 40;
/** Fish draw just in front of this layer (far to near). */
const FISH_LAYER = 0;
/** Fog of the fish against the water, and of the snow. */
const FISH_FOG = 0.55;

/** The water gradient, shared by the background and the fog of everything in front of it. */
const WATER_GLSL = /* glsl */ `
uniform vec3 uSurface;
uniform vec3 uMid;
uniform vec3 uDeep;
/** Water colour at depth v (0 at the top of the frame, 1 at the bottom). */
vec3 waterAt(float v) {
  float a = 1.0 - clamp(v / 0.55, 0.0, 1.0);
  vec3 c = mix(uMid, uSurface, a * a * a);
  return mix(c, uDeep, smoothstep(0.3, 1.05, v));
}
`;

/**
 * The water at reduced resolution: the depth gradient, a bright rippling band
 * under the surface, and soft light shafts as analytic wedges that widen and
 * fade with depth. The blit adds the dither.
 */
const WATER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
/** Full canvas size, px. */
uniform vec2 uResolution;
/** Shafts: top x (px), slope (dx/dy), top half width (px), strength. */
uniform vec4 uShafts[${String(MAX_SHAFTS)}];
uniform int uShaftCount;
uniform vec3 uShaftCol;
/** Shaft strength param, and the ripple phase (0..1). */
uniform vec2 uLight;
out vec4 outColor;
${WATER_GLSL}
const float TAU = 6.28318530718;
void main() {
  vec2 px = vec2(vUv.x * uResolution.x, (1.0 - vUv.y) * uResolution.y);
  float v = px.y / uResolution.y;
  vec3 c = waterAt(v);
  float xh = px.x / uResolution.y;
  float rip = sin(TAU * fract(xh * 1.3 + uLight.y)) * sin(TAU * fract(xh * 2.1 - 2.0 * uLight.y + 0.3));
  c += uSurface * exp(-v * 12.0) * (0.3 + 0.12 * rip);
  float shaft = 0.0;
  for (int i = 0; i < ${String(MAX_SHAFTS)}; i++) {
    if (i >= uShaftCount) break;
    vec4 s = uShafts[i];
    float d = (px.x - s.x - s.y * px.y) / (s.z * (1.0 + 2.5 * v));
    shaft += s.w * exp(-d * d);
  }
  float fade = 1.0 - 0.9 * v;
  c += uShaftCol * (0.24 * uLight.x * shaft * fade * fade * (0.9 + 0.1 * rip));
  outColor = vec4(c, 1.0);
}
`;

/**
 * One frond: a strip of SEGMENTS + 1 vertex pairs, bent by the lagged swell and a
 * static lean. The strip is the blade envelope; the fragment shader cuts blades
 * and stipe out of it from the width profile. Fog and light are per vertex.
 */
const FROND_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** Base x (fraction of the width), height (fraction of the frame height), envelope half width (px at 1080p), profile row v. */
layout(location = 1) in vec4 aFrond;
/** Swell phase offset (periods), lag (s), lean (fraction of the height), tone 0..1. */
layout(location = 2) in vec4 aTraits;
uniform vec2 uResolution;
uniform float uScale;
uniform float uPhase;
/** Floor y (fraction of the height), sway amplitude (fraction of the frond's height), edge blur (px), fog. */
uniform vec4 uLayer;
uniform vec3 uStipe;
uniform vec3 uBlade;
/** Rim colour times the layer's rim strength. */
uniform vec3 uRim;
out vec2 vProf;
out float vOff;
out float vHalf;
out float vBlur;
out vec3 vStipe;
out vec3 vBlade;
out vec3 vRim;
out float vFade;
${WATER_GLSL}
${swayGlsl(KELP_SWELL, "kelp")}
${TO_CLIP_GLSL}
vec2 centre(float t, float hpx) {
  float off = aTraits.z * t * t + uLayer.y * kelpOffset(uPhase + aTraits.x, t, aTraits.y);
  return vec2(aFrond.x * uResolution.x + hpx * off, uLayer.x * uResolution.y - hpx * t);
}
void main() {
  float t = aCorner.x / ${f(SEGMENTS)};
  float hpx = aFrond.y * uResolution.y;
  vec2 p = centre(t, hpx);
  vec2 q = centre(t + ${f(1 / SEGMENTS)}, hpx);
  vec2 dir = normalize(q - p);
  vec2 across = vec2(-dir.y, dir.x);
  float env = aFrond.z * uScale * (1.0 - 0.45 * t);
  float blur = uLayer.z;
  float off = aCorner.y * (env + blur);
  gl_Position = pxToClip(p + across * off, uResolution);
  vProf = vec2(t, aFrond.w);
  vOff = off;
  vHalf = env;
  vBlur = blur;

  float v = clamp(p.y / uResolution.y, 0.0, 1.0);
  vec3 water = waterAt(v);
  // Lit from above: darker towards the floor.
  float light = mix(0.45, 1.2, 1.0 - smoothstep(0.0, 1.0, v));
  float tone = mix(0.75, 1.25, aTraits.w);
  vStipe = mix(uStipe * tone * light, water, uLayer.w);
  vBlade = mix(uBlade * tone * light, water, uLayer.w);
  vRim = uRim * (1.0 - smoothstep(0.1, 0.9, v));
  // Bases melt into the dark floor; the tip ends softly.
  vFade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.93, 1.0, t));
}
`;

const FROND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uProfile;
in vec2 vProf;
in float vOff;
in float vHalf;
in float vBlur;
in vec3 vStipe;
in vec3 vBlade;
in vec3 vRim;
in float vFade;
out vec4 outColor;
void main() {
  vec2 w = texture(uProfile, vProf).rg;
  float share = vOff < 0.0 ? w.r : w.g;
  float hw = share * vHalf;
  float d = abs(vOff);
  float cover = clamp((hw - d) / vBlur + 0.5, 0.0, 1.0) * vFade;
  float leaf = smoothstep(${f(STIPE + 0.02)}, ${f(STIPE + 0.2)}, share);
  float x = d / max(hw, 0.001);
  // Blades are translucent and brighter in the middle; the rim catches the light behind.
  vec3 col = mix(vStipe, vBlade, leaf * (0.7 + 0.3 * (1.0 - x)));
  col += vRim * (leaf * smoothstep(0.55, 1.0, x));
  float stipe = clamp((${f(STIPE)} * vHalf - d) / vBlur + 0.5, 0.0, 1.0);
  col = mix(col, vStipe, stipe);
  outColor = vec4(col, cover);
}
`;

/** Fish shadows: a quad per fish, the shape drawn in the fragment shader. */
const FISH_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** Centre (heights), length (heights), direction (+1 right). */
layout(location = 1) in vec4 aFish;
/** Tail-beat phase, alpha. */
layout(location = 2) in vec2 aFish2;
uniform vec2 uResolution;
uniform vec3 uFish;
uniform float uFog;
out vec2 vUv;
out float vWig;
out float vAlpha;
out vec3 vColor;
${WATER_GLSL}
${TO_CLIP_GLSL}
void main() {
  float h = uResolution.y;
  vec2 c = aFish.xy * h;
  float hs = 0.5 * aFish.z * h;
  vec2 local = aCorner * vec2(1.0, 0.45);
  gl_Position = pxToClip(c + vec2(local.x * aFish.w, local.y) * hs, uResolution);
  vUv = local;
  vWig = aFish2.x;
  vAlpha = aFish2.y;
  vColor = mix(uFish, waterAt(clamp(aFish.y, 0.0, 1.0)), uFog);
}
`;

const FISH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in float vWig;
in float vAlpha;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 uv = vUv;
  // Head at +x; the tail beats.
  float tailW = 1.0 - uv.x;
  uv.y += 0.035 * sin(vWig) * tailW * tailW;
  float body = 1.0 - smoothstep(0.75, 1.0, length((uv - vec2(0.15, 0.0)) / vec2(0.7, 0.2)));
  float fin = (-0.45 - uv.x) * 0.75;
  float tail = smoothstep(-0.98, -0.88, uv.x) * (1.0 - smoothstep(-0.04, 0.04, abs(uv.y) - fin))
    * step(uv.x, -0.4);
  outColor = vec4(vColor, max(body, tail) * vAlpha * 0.6);
}
`;

/** Marine snow: soft dots. */
const SNOW_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** Centre (heights), radius (px at 1080p), alpha. */
layout(location = 1) in vec4 aSnow;
uniform vec2 uResolution;
uniform float uScale;
out vec2 vUv;
out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  gl_Position = pxToClip(aSnow.xy * uResolution.y + aCorner * (aSnow.z * uScale + 1.0), uResolution);
  vUv = aCorner;
  vAlpha = aSnow.w;
}
`;

const SNOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uSnow;
in vec2 vUv;
in float vAlpha;
out vec4 outColor;
void main() {
  float r = length(vUv);
  outColor = vec4(uSnow, vAlpha * (1.0 - smoothstep(0.25, 1.0, r)));
}
`;

/**
 * A kelp forest seen sideways: a low-res water pass (gradient, surface glow,
 * light shafts), then four depth layers of instanced frond strips swaying with
 * one lagged swell, far to near, with an occasional school of fish shadows in
 * the far water and slowly sinking marine snow.
 */
export const kelp = defineEffect(kelpMeta, {
  create(gl) {
    return withScope((scope) => {
      const water = scope.own(createLowResTarget(gl));
      const waterProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, WATER_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const uw = createUniforms(gl, waterProgram, [
        "uResolution",
        "uShafts",
        "uShaftCount",
        "uShaftCol",
        "uLight",
        "uSurface",
        "uMid",
        "uDeep",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const frondProgram = scope.add(createProgram(gl, FROND_VERTEX, FROND_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const uf = createUniforms(gl, frondProgram, [
        "uResolution",
        "uScale",
        "uPhase",
        "uLayer",
        "uStipe",
        "uBlade",
        "uRim",
        "uSurface",
        "uMid",
        "uDeep",
        "uProfile",
      ]);
      const fishProgram = scope.add(createProgram(gl, FISH_VERTEX, FISH_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const ufi = createUniforms(gl, fishProgram, [
        "uResolution",
        "uFish",
        "uFog",
        "uSurface",
        "uMid",
        "uDeep",
      ]);
      const snowProgram = scope.add(createProgram(gl, SNOW_VERTEX, SNOW_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const us = createUniforms(gl, snowProgram, ["uResolution", "uScale", "uSnow"]);
      gl.useProgram(frondProgram);
      uf.i1("uProfile", 0);
      gl.useProgram(fishProgram);
      ufi.f1("uFog", FISH_FOG);
      gl.useProgram(null);

      const profile = scope.own(
        createColumnTable(gl, PROFILE_COLUMNS, 2, {
          rows: PROFILE_ROWS,
          data: buildBladeProfiles(PROFILE_SEED),
        }),
      );
      const fronds = scope.own(createSpriteBatch(gl, MAX_FRONDS, [4, 4], [FROND_STRIP]));
      const fishBatch = scope.own(createSpriteBatch(gl, FISH_PER_SCHOOL, [4, 2]));
      const snowBatch = scope.own(createSpriteBatch(gl, SNOW_COUNT, [4], [QUAD]));

      const shafts = new Float32Array(MAX_SHAFTS * 4);
      let layout: FrondLayout | null = null;
      let builtSeed = Number.NaN;
      let builtDensity = Number.NaN;
      let fish = createFish(0);
      let snow = createSnow(0);
      let simSeed = Number.NaN;

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Swell phase (0..1 over KELP_SWELL.period) and surface ripple phase (0..1). */
      let phase = 0;
      let ripple = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
          phase = advanceSwell(KELP_SWELL, phase, step, p.speed);
          ripple += step * p.speed * RIPPLE_RATE;
          ripple -= Math.floor(ripple);
          const aspect = width / Math.max(1, height);

          if (p.seed !== builtSeed || p.density !== builtDensity) {
            layout = buildFronds(p.seed, p.density, fronds.data);
            fronds.upload(layout.total);
            builtSeed = p.seed;
            builtDensity = p.density;
          }
          if (p.seed !== simSeed) {
            fish = createFish(p.seed);
            snow = createSnow(p.seed);
            simSeed = p.seed;
          }
          const pal = lookup(PALETTES, p.palette, "temperate");

          // Water.
          water.resize(width, height, qualityDivisor(p.quality, WATER_DIVISORS));
          water.bind();
          gl.useProgram(waterProgram);
          uw.f2("uResolution", width, height);
          const n = shaftUniforms(phase, width, height, shafts);
          gl.uniform4fv(uw.loc.uShafts, shafts);
          uw.i1("uShaftCount", n);
          uw.v3("uShaftCol", pal.shaft);
          uw.f2("uLight", p.shafts, ripple);
          uw.v3("uSurface", pal.surface);
          uw.v3("uMid", pal.mid);
          uw.v3("uDeep", pal.deep);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          water.blit();
          gl.viewport(0, 0, width, height);

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

          let fishCount = 0;
          if (p.fish) {
            stepFish(fish, step, aspect);
            fishCount = fishInstances(fish, aspect, fishBatch.data);
            fishBatch.upload(fishCount);
          }
          let snowCount = 0;
          if (p.snow) {
            stepSnow(snow, step);
            snowCount = snowInstances(snow, aspect, snowBatch.data);
            snowBatch.upload(snowCount);
          }

          for (let l = 0; l < LAYERS.length; l++) {
            const layer = LAYERS[l];
            gl.useProgram(frondProgram);
            uf.f2("uResolution", width, height);
            uf.f1("uScale", scale);
            uf.f1("uPhase", phase);
            uf.f4(
              "uLayer",
              layer.floor,
              p.swell * SWAY_MAX * layer.sway,
              layer.blur * scale,
              layer.fog,
            );
            uf.v3("uStipe", pal.stipe);
            uf.v3("uBlade", pal.blade);
            uf.f3("uRim", pal.rim[0] * layer.rim, pal.rim[1] * layer.rim, pal.rim[2] * layer.rim);
            uf.v3("uSurface", pal.surface);
            uf.v3("uMid", pal.mid);
            uf.v3("uDeep", pal.deep);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, profile.texture);
            if (layout) fronds.draw(layout.starts[l], layout.counts[l]);

            if (l === FISH_LAYER && fishCount > 0) {
              gl.useProgram(fishProgram);
              ufi.f2("uResolution", width, height);
              ufi.v3("uFish", pal.fish);
              ufi.v3("uSurface", pal.surface);
              ufi.v3("uMid", pal.mid);
              ufi.v3("uDeep", pal.deep);
              fishBatch.draw(0, fishCount);
            }
            if (l === LAYERS.length - 2 && snowCount > 0) {
              gl.useProgram(snowProgram);
              us.f2("uResolution", width, height);
              us.f1("uScale", scale);
              us.v3("uSnow", pal.snow);
              snowBatch.draw(0, snowCount);
            }
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
