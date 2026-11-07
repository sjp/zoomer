import {
  BAMBOO_SWAY_GLSL,
  BAMBOO_SWELL,
  buildLeaves,
  buildStems,
  LAYERS,
  LEAF_ATTRIBUTES,
  type LeafLayout,
  type LightId,
  LIGHTS,
  MAX_LEAVES,
  MAX_STEMS,
  type OpeningId,
  SEGMENTS,
  STEM_ATTRIBUTES,
  STEM_STRIP,
  type StemLayout,
  STRIP_BOTTOM,
  STRIP_TOP,
  SWAY_MAX,
  swaySpeed,
} from "./bamboo-sim";
import { bambooMeta } from "./bamboo.meta";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { createSpriteBatch, QUAD } from "../sprites";
import { advanceSwell, swayGlsl } from "../sway";
import { defineEffect } from "../types";
import { lookup } from "../lookup";

const f = glslFloat;

/** The haze pass is soft everywhere: the narrowest shaft is about 60 px wide at 1080p. */
const HAZE_DIVISOR = 4;
/** Layout seed for the leaves, offset from the stems'. */
const LEAF_SEED = 96;

const HAZE_UNIFORMS = ["uTop", "uMid", "uGround", "uLightCol", "uLightPos", "uGlow"] as const;

/** The haze gradient and back-light glow, shared by the background and the fog of everything in front. */
const HAZE_GLSL = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uGround;
uniform vec3 uLightCol;
/** Light centre: x fraction of the width, y fraction of the height. */
uniform vec2 uLightPos;
/** Glow radius (heights) and strength. */
uniform vec2 uGlow;
/** Glow falloff at px (0..1). */
float glowAt(vec2 px, vec2 res) {
  vec2 d = (px - uLightPos * res) / res.y;
  return exp(-dot(d, d) / (uGlow.x * uGlow.x));
}
vec3 hazeAt(vec2 px, vec2 res) {
  float v = px.y / res.y;
  vec3 c = mix(uTop, uMid, smoothstep(0.0, 0.6, v));
  c = mix(c, uGround, smoothstep(0.55, 1.05, v));
  return c + uLightCol * (uGlow.y * glowAt(px, res));
}
`;

/** Background at reduced resolution: haze, glow and soft shafts fanning down from the light. The blit dithers. */
const HAZE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uResolution;
/** Shaft strength and phase (0..1). */
uniform vec2 uShafts;
out vec4 outColor;
${HAZE_GLSL}
const float TAU = 6.28318530718;
void main() {
  vec2 px = vec2(vUv.x * uResolution.x, (1.0 - vUv.y) * uResolution.y);
  vec3 c = hazeAt(px, uResolution);
  vec2 d = (px - uLightPos * uResolution) / uResolution.y;
  float a = atan(d.x, d.y);
  float rays = (0.5 + 0.5 * sin(7.0 * a + TAU * uShafts.y))
    * (0.5 + 0.5 * sin(11.0 * a - TAU * fract(2.0 * uShafts.y) + 1.3))
    + 0.5 * (0.5 + 0.5 * sin(4.0 * a + 2.1));
  float below = smoothstep(-0.05, 0.25, d.y);
  float shaft = uShafts.x * rays * rays * below * exp(-1.4 * length(d));
  c += uLightCol * (0.22 * shaft);
  outColor = vec4(c, 1.0);
}
`;

/**
 * One stem: a strip of SEGMENTS + 1 vertex pairs from its root (or just below the
 * frame) to just above the frame, bent by the lagged swell and the gust. The
 * strip is padded for the node bulges and the back-light halo. Fog, base colour
 * and rim are per vertex.
 */
const STEM_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** x (fraction of the width), root y (fraction of the height), length (heights), half width (px at 1080p). */
layout(location = 1) in vec4 aStem;
/** Swell phase offset (periods), lag (s), sway multiplier, tone. */
layout(location = 2) in vec4 aSway;
/** Node spacing (heights), node offset (spacings), fog, blur (px at 1080p). */
layout(location = 3) in vec4 aLook;
layout(location = 4) in float aRim;
uniform vec2 uResolution;
uniform float uScale;
uniform float uPhase;
/** Sway amplitude at t = 1 (heights), haze multiplier. */
uniform vec2 uWind;
uniform vec3 uLime;
uniform vec3 uOlive;
uniform vec3 uRing;
out float vOff;
out float vHalf;
out float vBlur;
out float vNode;
out float vNodePx;
out vec3 vCol;
out vec3 vRingCol;
out vec3 vRim;
out vec3 vHaloCol;
out float vHaloA;
out float vHaloW;
${HAZE_GLSL}
${swayGlsl(BAMBOO_SWELL, "bamboo")}
${BAMBOO_SWAY_GLSL}
${TO_CLIP_GLSL}
vec2 centre(float y) {
  float t = (aStem.y - y) / aStem.z;
  float off = stemSway(uPhase, aSway.x, aStem.x, aSway.y, t, uWind.x * aSway.z);
  return vec2(aStem.x * uResolution.x + off * uResolution.y, y * uResolution.y);
}
void main() {
  float bottom = min(${f(STRIP_BOTTOM)}, aStem.y + 0.01);
  float y = mix(bottom, ${f(STRIP_TOP)}, aCorner.x / ${f(SEGMENTS)});
  vec2 p = centre(y);
  vec2 q = centre(y - 0.01);
  vec2 dir = normalize(q - p);
  vec2 across = vec2(-dir.y, dir.x);
  float hw = aStem.w * uScale;
  float blur = aLook.w * uScale;
  float glow = glowAt(p, uResolution);
  float fog = clamp(aLook.z * uWind.y, 0.0, 0.95);
  vHaloW = (1.5 + 2.5 * aRim) * uScale;
  float off = aCorner.y * (hw * 1.1 + blur + 3.0 * vHaloW);
  gl_Position = pxToClip(p + across * off, uResolution);
  vOff = off;
  vHalf = hw;
  vBlur = blur;
  vNode = (aStem.y - y) / aLook.x + aLook.y;
  vNodePx = aLook.x * uResolution.y;

  vec3 haze = hazeAt(p, uResolution);
  float v = y;
  // Back-lit stems are darker low down, where the ground shades them.
  float light = mix(1.15, 0.6, smoothstep(0.3, 1.0, v));
  vec3 base = mix(uLime, uOlive, aSway.w) * light;
  // Roots inside the frame melt into the ground haze.
  float rootFog = smoothstep(aStem.y - 0.12, aStem.y, y);
  float f = max(fog, rootFog);
  vCol = mix(base, haze, f);
  vRingCol = mix(uRing * light, haze, f);
  float lit = aRim * (0.25 + 0.75 * glow) * (1.0 - f);
  vRim = uLightCol * (0.55 * lit);
  vHaloCol = mix(haze, uLightCol, 0.6);
  vHaloA = 0.3 * lit * glow;
}
`;

const STEM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vOff;
in float vHalf;
in float vBlur;
in float vNode;
in float vNodePx;
in vec3 vCol;
in vec3 vRingCol;
in vec3 vRim;
in vec3 vHaloCol;
in float vHaloA;
in float vHaloW;
out vec4 outColor;
void main() {
  // Signed px from the nearest node (positive above it).
  float fz = fract(vNode);
  float dz = (fz < 0.5 ? fz : fz - 1.0) * vNodePx;
  float ringW = max(0.8, 0.09 * vHalf);
  float ring = exp(-(dz - 0.5 * ringW) * (dz - 0.5 * ringW) / (ringW * ringW));
  float shadow = exp(-(dz + 2.0 * ringW) * (dz + 2.0 * ringW) / (2.5 * ringW * ringW));
  // Nodes bulge a little.
  float hw = vHalf * (1.0 + 0.07 * exp(-dz * dz / (4.0 * ringW * ringW)));
  float d = abs(vOff);
  float cover = clamp((hw - d) / vBlur + 0.5, 0.0, 1.0);
  float s = clamp(vOff / hw, -1.0, 1.0);
  float nz = sqrt(1.0 - s * s);
  // Cylinder: soft front fill, a faint sheen off-centre, and the back light on the rims.
  float sheen = max(0.0, 1.0 - abs(s + 0.35) * 3.0);
  vec3 col = vCol * (0.6 + 0.4 * nz + 0.12 * sheen * sheen);
  col = mix(col, vRingCol, 0.75 * ring);
  col *= 1.0 - 0.3 * shadow;
  float r2 = s * s;
  col += vRim * (r2 * r2 * abs(s));
  // A soft glow just outside the edge, where the light spills round the stem.
  float halo = vHaloA * exp(-max(d - hw, 0.0) / vHaloW) * (1.0 - cover);
  float a = cover + halo;
  outColor = a > 0.0 ? vec4((col * cover + vHaloCol * halo) / a, a) : vec4(0.0);
}
`;

/** Leaves and twigs: a quad per piece, rotated about its base, the shape cut in the fragment shader. */
const LEAF_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** Stem x, root y, length, attach y. */
layout(location = 1) in vec4 aStem;
/** Stem phase, lag, sway; twig x offset (px at 1080p). */
layout(location = 2) in vec4 aSway;
/** Twig y offset (px), angle (rad), length (px), half width (px). */
layout(location = 3) in vec4 aShape;
/** Flutter phase, flutter cycles per period, tone, kind (0 leaf, 1 twig). */
layout(location = 4) in vec4 aLeaf;
uniform vec2 uResolution;
uniform float uScale;
uniform float uPhase;
/** Sway amplitude at t = 1 (heights), haze multiplier, wind 0..1. */
uniform vec3 uWind;
/** Layer fog and blur (px at 1080p). */
uniform vec2 uLayer;
uniform vec3 uLeaf;
uniform vec3 uLeafLit;
uniform vec3 uOlive;
out vec2 vUv;
out float vHw;
out float vBlur;
out float vKind;
out float vLen;
out vec3 vCol;
out vec3 vRib;
${HAZE_GLSL}
${swayGlsl(BAMBOO_SWELL, "bamboo")}
${BAMBOO_SWAY_GLSL}
${TO_CLIP_GLSL}
const float TAU = 6.28318530718;
void main() {
  float t = (aStem.y - aStem.w) / aStem.z;
  float sway = stemSway(uPhase, aSway.x, aStem.x, aSway.y, t, uWind.x * aSway.z);
  vec2 anchor = vec2(aStem.x * uResolution.x + sway * uResolution.y, aStem.w * uResolution.y)
    + vec2(aSway.w, aShape.x) * uScale;
  float g = gustAt(aStem.x, uPhase);
  float strength = 0.04 + 0.22 * uWind.z * (0.5 + g);
  float flutter = strength * sin(TAU * fract(aLeaf.y * uPhase + aLeaf.x));
  float angle = aShape.y + flutter * (1.0 - 0.7 * aLeaf.w);
  vec2 dir = vec2(cos(angle), sin(angle));
  vec2 nrm = vec2(-dir.y, dir.x);
  float len = aShape.z * uScale;
  float hw = max(0.6, aShape.w * uScale);
  float blur = uLayer.y * uScale;
  float u = 0.5 + 0.5 * aCorner.x;
  float along = mix(-blur, len + blur, u);
  float acr = aCorner.y * (hw + blur);
  gl_Position = pxToClip(anchor + dir * along + nrm * acr, uResolution);
  vUv = vec2(along / len, acr / hw);
  vHw = hw;
  vBlur = blur;
  vKind = aLeaf.w;
  vLen = len;

  vec3 haze = hazeAt(anchor, uResolution);
  float glow = glowAt(anchor, uResolution);
  float fog = clamp(uLayer.x * uWind.y, 0.0, 0.95);
  // Back-lit leaves glow through near the gap.
  float tone = mix(0.8, 1.15, aLeaf.z);
  vec3 leaf = mix(uLeaf, uLeafLit, 0.25 + 0.75 * glow) * tone;
  vec3 col = mix(leaf, uOlive * 0.8, aLeaf.w);
  vCol = mix(col, haze, fog);
  vRib = mix(leaf * 1.25, haze, fog);
}
`;

const LEAF_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in float vHw;
in float vBlur;
in float vKind;
in float vLen;
in vec3 vCol;
in vec3 vRib;
out vec4 outColor;
const float PI = 3.14159265359;
void main() {
  float u = vUv.x;
  float blur = max(vBlur, 0.75);
  // Narrow lance: widest about a third of the way out, a long point at the tip.
  float w = vKind > 0.5 ? 1.0 : sin(PI * pow(clamp(u, 0.0, 1.0), 0.6));
  float dpx = (abs(vUv.y) - w) * vHw;
  float cover = clamp(0.5 - dpx / blur, 0.0, 1.0)
    * clamp(min(u, 1.0 - u) * vLen / blur + 0.5, 0.0, 1.0);
  float rib = (1.0 - vKind) * (1.0 - smoothstep(0.08, 0.2, abs(vUv.y)));
  outColor = vec4(mix(vCol, vRib, 0.5 * rib), cover);
}
`;

/**
 * A bamboo grove: a low-res haze pass with the back light and soft shafts, then
 * four depth layers far to near, each an instanced draw of bent stem strips
 * (cylindrical shading, node rings, rim light) followed by its leaf clusters,
 * all swaying with one lagged swell and a gust field travelling across.
 */
export const bamboo = defineEffect(bambooMeta, {
  create(gl) {
    return withScope((scope) => {
      const haze = scope.own(createLowResTarget(gl));
      const hazeProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, HAZE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const uh = createUniforms(gl, hazeProgram, ["uResolution", "uShafts", ...HAZE_UNIFORMS]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const stemProgram = scope.add(createProgram(gl, STEM_VERTEX, STEM_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const us = createUniforms(gl, stemProgram, [
        "uResolution",
        "uScale",
        "uPhase",
        "uWind",
        "uLime",
        "uOlive",
        "uRing",
        ...HAZE_UNIFORMS,
      ]);
      const leafProgram = scope.add(createProgram(gl, LEAF_VERTEX, LEAF_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const ul = createUniforms(gl, leafProgram, [
        "uResolution",
        "uScale",
        "uPhase",
        "uWind",
        "uLayer",
        "uLeaf",
        "uLeafLit",
        "uOlive",
        ...HAZE_UNIFORMS,
      ]);

      const stems = scope.own(createSpriteBatch(gl, MAX_STEMS, STEM_ATTRIBUTES, [STEM_STRIP]));
      const leaves = scope.own(createSpriteBatch(gl, MAX_LEAVES, LEAF_ATTRIBUTES, [QUAD]));
      let stemLayout: StemLayout | null = null;
      let leafLayout: LeafLayout | null = null;
      let builtSeed = Number.NaN;
      let builtDensity = Number.NaN;
      let builtOpening = "";

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Swell phase, 0..1 over BAMBOO_SWELL.period. */
      let phase = 0;

      type HazeUniforms = typeof uh | typeof us | typeof ul;
      const setHaze = (u: HazeUniforms, light: (typeof LIGHTS)[LightId]) => {
        u.v3("uTop", light.top);
        u.v3("uMid", light.mid);
        u.v3("uGround", light.ground);
        u.v3("uLightCol", light.light);
        u.f2("uLightPos", light.lightX, light.lightY);
        u.f2("uGlow", light.radius, light.glow);
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
          const wind = Math.min(1, Math.max(0, Number.isFinite(p.wind) ? p.wind : 0));
          phase = advanceSwell(BAMBOO_SWELL, phase, step, swaySpeed(wind));
          const light = lookup(LIGHTS, p.light, "morning");

          if (p.seed !== builtSeed || p.density !== builtDensity || p.opening !== builtOpening) {
            const opening: OpeningId = p.opening === "none" ? "none" : "centre";
            stemLayout = buildStems(p.seed, p.density, opening, stems.data);
            stems.upload(stemLayout.total);
            leafLayout = buildLeaves(p.seed + LEAF_SEED, stems.data, stemLayout, leaves.data);
            leaves.upload(leafLayout.total);
            builtSeed = p.seed;
            builtDensity = p.density;
            builtOpening = p.opening;
          }

          // Haze and back light.
          haze.resize(width, height, HAZE_DIVISOR);
          haze.bind();
          gl.useProgram(hazeProgram);
          uh.f2("uResolution", width, height);
          uh.f2("uShafts", light.shafts, phase);
          setHaze(uh, light);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          haze.blit();
          gl.viewport(0, 0, width, height);

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          const amp = wind * SWAY_MAX;
          for (let l = 0; l < LAYERS.length; l++) {
            const layer = LAYERS[l];
            if (stemLayout) {
              gl.useProgram(stemProgram);
              us.f2("uResolution", width, height);
              us.f1("uScale", scale);
              us.f1("uPhase", phase);
              us.f2("uWind", amp, light.mist);
              us.v3("uLime", light.lime);
              us.v3("uOlive", light.olive);
              us.v3("uRing", light.ring);
              setHaze(us, light);
              stems.draw(stemLayout.starts[l], stemLayout.counts[l]);
            }
            if (leafLayout) {
              gl.useProgram(leafProgram);
              ul.f2("uResolution", width, height);
              ul.f1("uScale", scale);
              ul.f1("uPhase", phase);
              ul.f3("uWind", amp, light.mist, wind);
              ul.f2("uLayer", layer.fog, layer.blur);
              ul.v3("uLeaf", light.leaf);
              ul.v3("uLeafLit", light.leafLit);
              ul.v3("uOlive", light.olive);
              setHaze(ul, light);
              leaves.draw(leafLayout.starts[l], leafLayout.counts[l]);
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
