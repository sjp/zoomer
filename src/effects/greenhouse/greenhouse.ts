import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import {
  buildLeaves,
  buildRoof,
  CLOUD_PERIOD,
  cloudThin,
  createBobs,
  createDrips,
  createRivulets,
  EAVE_CENTRE,
  EAVE_EDGE,
  EAVE_GLSL,
  GREENHOUSE_SWELL,
  KIND_FROND,
  KIND_MONSTERA,
  LEAF_LAYERS,
  LEAF_SEGMENTS,
  LEAF_STRIP,
  type LeafLayout,
  MAX_BARS,
  MAX_DRIPS,
  MAX_LEAVES,
  MAX_RIVULETS,
  PALETTES,
  paletteOf,
  resetRivulets,
  ROOF_CODE,
  type Roof,
  roofOf,
  stepBobs,
  stepDrips,
  stepRivulets,
  TRAIL_SEGS,
  BOB_RATE,
  writeBars,
  writeDrips,
  writeLeaves,
  writeRivulets,
} from "./greenhouse-sim";
import { greenhouseMeta, type PaletteId, type RoofId } from "./greenhouse.meta";
import { createLowResTarget } from "../lowres";
import { createSpriteBatch, QUAD } from "../sprites";
import { createStreakRenderer } from "../streaks";
import { advanceSwell, swayGlsl } from "../sway";
import { defineEffect } from "../types";

const f = glslFloat;

/** Background pass: about 4 reference px per texel (divisor 8 at 4K). It is all soft. */
const BACKGROUND_TEXEL_REF = 4;

/**
 * The background at low resolution: the glass roof above the eave (brighter
 * towards the top, slow drifting cloud light, brighter when the clouds thin)
 * and the humid interior below it (haze fading to a dim floor).
 */
const BACKGROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
/** Aspect ratio (width / height). */
uniform float uAspect;
/** Roof code, eave y at the sides and in the middle (heights). */
uniform vec3 uEave;
uniform vec3 uGlassTop;
uniform vec3 uGlassLow;
uniform vec3 uHaze;
uniform vec3 uFloor;
/** Cloud phase (0..1), cloud thinning (0..1), haze param (0..1). */
uniform vec3 uSky;
out vec4 outColor;
${EAVE_GLSL}
const float TAU = 6.28318530718;
void main() {
  // Heights: x from 0 to the aspect ratio, y down from the top.
  vec2 p = vec2(vUv.x * uAspect, 1.0 - vUv.y);
  float eave = eaveY(vUv.x, uEave);
  float haze = uSky.z;

  // Interior: haze in the middle distance, a dim floor, light falling from the glass.
  vec3 inside = mix(uHaze, uFloor, smoothstep(0.5, 1.05, p.y) * (1.0 - 0.35 * haze));
  inside += (uGlassLow - uHaze) * 0.5 * exp(-4.0 * max(p.y - eave, 0.0));
  vec3 col = inside;

  // Glass: cloud light drifts across in whole multiples of the cloud phase.
  float o = TAU * uSky.x;
  float cl = sin(2.3 * p.x + o + 1.7 * sin(1.1 * p.y - o)) * sin(3.1 * p.y - 1.3 * p.x + 2.0 * o);
  float glassT = clamp(p.y / max(eave, 0.05), 0.0, 1.0);
  vec3 glass = mix(uGlassTop, uGlassLow, glassT);
  glass *= 0.94 + 0.06 * cl + uSky.y * (0.12 + 0.18 * smoothstep(-0.2, 0.8, cl));
  float onGlass = 1.0 - smoothstep(eave - 0.012, eave + 0.012, p.y);
  col = mix(col, glass, onGlass);

  // Humidity lifts everything towards the haze colour, most in the middle band.
  float band = exp(-6.0 * (p.y - 0.62) * (p.y - 0.62));
  col = mix(col, uHaze, haze * (0.12 + 0.3 * band));
  vec2 v = vUv - 0.5;
  col *= 1.0 - 0.3 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/** Glazing bars: alpha-blended capsules (premultiplied), in heights converted to px. */
const BAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Start x, y, end x, y (heights). */
layout(location = 1) in vec4 aSegment;
/** Half width (reference px), shade. */
layout(location = 2) in vec4 aStyle;
uniform vec2 uResolution;
uniform float uScale;
out vec2 vLocal;
flat out vec2 vShape;
flat out float vShade;
${TO_CLIP_GLSL}
void main() {
  float h = uResolution.y;
  vec2 a = aSegment.xy * h;
  vec2 d = aSegment.zw * h - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = max(aStyle.x * uScale, 0.5);
  float ext = r + 1.0;
  float u = aCorner.x < 0.0 ? -ext : len + ext;
  float v = aCorner.y * ext;
  vLocal = vec2(u, v);
  vShape = vec2(len, r);
  vShade = aStyle.y;
  gl_Position = pxToClip(a + dir * u + nrm * v, uResolution);
}
`;

const BAR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vShape;
flat in float vShade;
uniform vec3 uBar;
out vec4 outColor;
void main() {
  float dx = vLocal.x - clamp(vLocal.x, 0.0, vShape.x);
  float dist = length(vec2(dx, vLocal.y));
  float cover = clamp(vShape.y + 0.5 - dist, 0.0, 1.0);
  // A faint highlight along the lit edge.
  float across = clamp(vLocal.y / vShape.y, -1.0, 1.0);
  vec3 c = uBar * vShade * (1.0 + 0.35 * smoothstep(0.2, 1.0, -across));
  outColor = vec4(c * cover, cover);
}
`;

/**
 * One leaf: a strip of LEAF_SEGMENTS + 1 vertex pairs along the midrib, an arc of
 * constant curvature (mirrors `leafPoint`) swayed by the lagged swell and dipped by
 * its bob spring. The strip is the envelope; the fragment shader cuts the shape.
 */
const LEAF_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** Anchor (fraction of the width), x offset, y, length (heights). */
layout(location = 1) in vec4 aBase;
/** Start angle, total bend (radians), half width (fraction of the length), kind. */
layout(location = 2) in vec4 aShape;
/** Sway phase offset (periods), lag (s), sway (fraction of the length), bob dip (fraction of the length). */
layout(location = 3) in vec4 aMotion;
/** Tone, stalk share, cut seed, leaflets. */
layout(location = 4) in vec4 aLook;
uniform vec2 uResolution;
uniform float uPhase;
/** Edge softness (px). */
uniform float uBlur;
out vec2 vLeaf;
out float vLight;
/** Blade half width (px), total length (px), stalk share, kind. */
flat out vec4 vInfo;
/** Tone, cut seed, leaflets. */
flat out vec3 vLook;
${swayGlsl(GREENHOUSE_SWELL, "leaf")}
${TO_CLIP_GLSL}
vec2 arc(float t) {
  float a0 = aShape.x;
  float k = aShape.y;
  if (abs(k) > 1e-3) {
    return vec2(cos(a0) - cos(a0 + k * t), sin(a0) - sin(a0 + k * t)) / k;
  }
  return vec2(sin(a0), -cos(a0)) * t;
}
vec2 midrib(float t, vec2 base, float L) {
  vec2 n0 = vec2(cos(aShape.x), sin(aShape.x));
  float sway = aMotion.z * leafOffset(uPhase + aMotion.x, t, aMotion.y);
  return base + L * (arc(t) + n0 * sway + vec2(0.0, aMotion.w * t * t));
}
void main() {
  float h = uResolution.y;
  float L = aBase.w * h;
  vec2 base = vec2(aBase.x * uResolution.x + aBase.y * h, aBase.z * h);
  float t = aCorner.x / ${f(LEAF_SEGMENTS)};
  vec2 p = midrib(t, base, L);
  vec2 q = midrib(t + ${f(1 / LEAF_SEGMENTS)}, base, L);
  vec2 dir = normalize(q - p + vec2(1e-6, 0.0));
  vec2 across = vec2(-dir.y, dir.x);
  float hw = aShape.z * L;
  float stalk = aLook.y;
  float u = (t - stalk) / (1.0 - stalk);
  float stalkW = max(0.06 * hw, 1.5);
  // Every blade profile stays inside 0.3 + 3 min(u, 1 - u) of the half width.
  float env = t < stalk - 0.001 ? stalkW : hw * clamp(0.36 + 3.0 * min(u, 1.0 - u), 0.0, 1.0);
  float off = aCorner.y * (env + uBlur + 1.5);
  gl_Position = pxToClip(p + across * off, uResolution);
  vLeaf = vec2(t, off);
  // Leaves higher up catch more light through the glass.
  vLight = 1.0 - smoothstep(0.15, 1.0, p.y / h);
  vInfo = vec4(hw, L, stalk, aShape.w);
  vLook = vec3(aLook.x, aLook.z, aLook.w);
}
`;

const LEAF_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLeaf;
in float vLight;
flat in vec4 vInfo;
flat in vec3 vLook;
uniform float uBlur;
uniform vec3 uLeaf;
uniform vec3 uRib;
uniform vec3 uGlow;
uniform vec3 uHaze;
/** Haze mix, vein strength, edge glow strength. */
uniform vec3 uMix;
out vec4 outColor;
const float PI = 3.14159265359;
void main() {
  float t = vLeaf.x;
  float ax = abs(vLeaf.y);
  float hw = vInfo.x;
  float len = vInfo.y;
  float stalk = vInfo.z;
  float kind = vInfo.w;
  float bladeLen = len * (1.0 - stalk);
  float u = (t - stalk) / (1.0 - stalk);
  float x = ax / hw;
  float ribW = 0.8 + 0.035 * hw;
  float stalkW = max(0.06 * hw, 1.5);
  // Signed distance-like field in px: positive inside.
  float e = min(stalkW - ax, (stalk + 0.03 - t) * len);
  float vein = 0.0;
  if (u > 0.0) {
    float su = sin(PI * clamp(u, 0.0, 1.0));
    float eb;
    if (kind < ${f(KIND_MONSTERA - 0.5)}) {
      // Broad banana-like blade, with the odd tear between the side veins.
      float p = pow(su, 0.7) * (1.0 - 0.2 * u);
      eb = (p - x) * hw;
      float s = fract(u * 11.0 + vLook.y * 7.0 - 0.15 * x);
      float gate = step(0.6, fract(sin(floor(u * 11.0 + vLook.y * 7.0 - 0.15 * x) * 91.7 + vLook.y * 13.0) * 43758.5));
      float ds = 0.5 - abs(s - 0.5);
      float tear = max((ds - 0.02) * bladeLen / 11.0, (0.25 - x) * hw);
      eb = gate > 0.5 ? min(eb, tear) : eb;
      vein = 1.0 - smoothstep(0.02, 0.06, ds);
    } else if (kind < ${f(KIND_FROND - 0.5)}) {
      // Monstera: a wide, rounded blade with slits from the edge towards the midrib.
      float p = pow(su, 0.6) * (1.0 - 0.1 * u);
      float s = fract(u * 6.0 - 0.5 * x + vLook.y);
      float ds = 0.5 - abs(s - 0.5);
      float slit = max((ds - 0.09) * bladeLen / 6.0, (0.35 - x) * hw);
      eb = min((p - x) * hw, slit);
      vein = 1.0 - smoothstep(0.1, 0.16, ds);
    } else {
      // Frond (palm or fern): a rachis with leaflets angled towards the tip.
      float env = pow(su, 0.6);
      float n = vLook.z;
      float s = fract(u * n - 1.2 * x);
      float lw = 0.42 * (1.0 - x / max(env, 1e-3)) + 0.04;
      float leaflet = (lw - abs(s - 0.5)) * bladeLen / n;
      float rachis = min(ribW - ax, (0.97 - u) * bladeLen);
      eb = max(min((env - x) * hw, leaflet), rachis);
    }
    e = max(e, eb);
  }
  float cover = clamp(e / uBlur + 0.5, 0.0, 1.0);

  vec3 c = uLeaf * vLook.x;
  float rib = 1.0 - smoothstep(ribW, ribW * 2.5, ax);
  c = mix(c, uRib, uMix.y * max(rib, 0.2 * vein * (1.0 - x)) * step(0.0, u));
  // Translucent edges glow with the light behind them.
  float edge = 1.0 - smoothstep(0.0, 2.0 + 0.12 * hw, e);
  c += uGlow * (uMix.z * edge * (0.4 + 0.6 * vLight));
  c = mix(c, uHaze, uMix.x);
  outColor = vec4(c * cover, cover);
}
`;

/**
 * Inside a Victorian glasshouse in soft rain: a low-res background (glass roof
 * with drifting cloud light over a humid interior), iron glazing bars as
 * capsules, rivulets and drips as additive streaks, then three depth layers of
 * instanced leaf strips (broad, monstera and frond profiles) swaying with the
 * shared lagged swell and bobbing when a drip hits them.
 */
export const greenhouse = defineEffect(greenhouseMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scope.own(createLowResTarget(gl));
      const bgProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT);
      const ub = createUniforms(gl, bgProgram, [
        "uAspect",
        "uEave",
        "uGlassTop",
        "uGlassLow",
        "uHaze",
        "uFloor",
        "uSky",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const barBatch = scope.own(createSpriteBatch(gl, MAX_BARS, [4, 4], [QUAD]));
      const barProgram = scopedProgram(gl, scope, BAR_VERTEX, BAR_FRAGMENT);
      const ubar = createUniforms(gl, barProgram, ["uResolution", "uScale", "uBar"]);

      const streaks = scope.own(createStreakRenderer(gl, MAX_RIVULETS * TRAIL_SEGS + MAX_DRIPS));

      const leafBatch = scope.own(createSpriteBatch(gl, MAX_LEAVES, [4, 4, 4, 4], [LEAF_STRIP]));
      const leafProgram = scopedProgram(gl, scope, LEAF_VERTEX, LEAF_FRAGMENT);
      const ul = createUniforms(gl, leafProgram, [
        "uResolution",
        "uPhase",
        "uBlur",
        "uLeaf",
        "uRib",
        "uGlow",
        "uHaze",
        "uMix",
      ]);

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Swell phase (0..1 over GREENHOUSE_SWELL.period) and cloud phase (0..1 over CLOUD_PERIOD). */
      let phase = 0;
      let cloud = 0;

      let roof: Roof | null = null;
      let roofKind: RoofId | "" = "";
      let roofAspect = Number.NaN;
      let barCount = 0;

      let layout: LeafLayout | null = null;
      let leafCount = 0;
      let builtSeed = Number.NaN;
      let builtDensity = Number.NaN;
      let builtPalette: PaletteId | "" = "";
      let bobs = createBobs([], 0);

      let simSeed = Number.NaN;
      let rivulets = createRivulets(0);
      let drips = createDrips(0);

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
          phase = advanceSwell(GREENHOUSE_SWELL, phase, step);
          cloud += step / CLOUD_PERIOD;
          cloud -= Math.floor(cloud);
          const aspect = width / Math.max(1, height);
          const palette = paletteOf(p.palette);
          const pal = PALETTES[palette];
          const kind = roofOf(p.roof);
          const seed = Math.floor(p.seed);
          const rain = Math.min(1, Math.max(0, p.rain));
          const haze = Math.min(1, Math.max(0, p.haze));

          if (seed !== simSeed) {
            rivulets = createRivulets(seed);
            drips = createDrips(seed);
            simSeed = seed;
            roofKind = "";
          }
          if (kind !== roofKind || aspect !== roofAspect) {
            roof = buildRoof(kind, aspect);
            barCount = writeBars(roof, barBatch.data);
            barBatch.upload(barCount);
            resetRivulets(rivulets);
            roofKind = kind;
            roofAspect = aspect;
          }
          if (seed !== builtSeed || p.density !== builtDensity || palette !== builtPalette) {
            layout = buildLeaves(seed, p.density, palette);
            leafCount = writeLeaves(layout, leafBatch.data);
            bobs = createBobs(
              layout.leaves.map((l) => l.length),
              seed,
            );
            builtSeed = seed;
            builtDensity = p.density;
            builtPalette = palette;
          }

          // Simulation.
          stepRivulets(rivulets, roof, step, rain);
          stepDrips(drips, roof, step, rain, p.drips);
          stepBobs(bobs, step, BOB_RATE * (0.25 + 0.75 * rain), leafBatch.data);
          leafBatch.upload(leafCount);
          let streakCount = writeRivulets(rivulets, roof, height, scale, pal.glint, streaks.data);
          streakCount += writeDrips(drips, height, scale, pal.glint, streaks.data, streakCount);
          streaks.upload(streakCount);

          // Background.
          background.resize(width, height, Math.max(1, BACKGROUND_TEXEL_REF * scale));
          background.bind();
          gl.useProgram(bgProgram);
          ub.f1("uAspect", aspect);
          ub.f3(
            "uEave",
            ROOF_CODE[kind],
            EAVE_EDGE,
            kind === "hidden" ? EAVE_EDGE : EAVE_CENTRE[kind],
          );
          ub.v3("uGlassTop", pal.glassTop);
          ub.v3("uGlassLow", pal.glassLow);
          ub.v3("uHaze", pal.haze);
          ub.v3("uFloor", pal.floor);
          ub.f3("uSky", cloud, cloudThin(cloud), haze);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          background.blit();
          gl.viewport(0, 0, width, height);

          // Roof: bars, then rivulets and drips over the glass.
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          if (barCount > 0) {
            gl.useProgram(barProgram);
            ubar.f2("uResolution", width, height);
            ubar.f1("uScale", scale);
            ubar.v3("uBar", pal.bar);
            barBatch.draw(0, barCount);
          }
          streaks.draw(streakCount, width, height);

          // Leaves, far to near.
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          if (layout) {
            gl.useProgram(leafProgram);
            ul.f2("uResolution", width, height);
            ul.f1("uPhase", phase);
            ul.v3("uRib", pal.rib);
            ul.v3("uGlow", pal.glow);
            ul.v3("uHaze", pal.haze);
            for (let l = 0; l < LEAF_LAYERS.length; l++) {
              const layer = LEAF_LAYERS[l];
              ul.f1("uBlur", Math.max(1, layer.blur * scale));
              ul.v3("uLeaf", pal.leaves[l]);
              ul.f3(
                "uMix",
                Math.min(0.9, layer.haze * (0.3 + 1.4 * haze)),
                layer.detail,
                layer.glow,
              );
              leafBatch.draw(layout.starts[l], layout.counts[l]);
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
