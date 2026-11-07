/**
 * The Aquarium's procedurally drawn fish (positions from `fishInstances` in
 * aquarium-sim.ts) and the water colour that fogs them: shared with other
 * underwater scenes that reuse the fish school.
 */
import { TO_CLIP_GLSL } from "../gl";

/** Water colour at depth v (0 at the top, 1 at the bottom), shared by everything fogged by it. */
export const WATER_GLSL = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uDeep;
vec3 waterAt(float v) {
  return mix(uTop, uDeep, smoothstep(0.0, 0.95, v));
}
`;

/** A fish: a quad squeezed by the turn, the shape drawn in the fragment shader. */
export const FISH_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** Centre (heights), length (heights), turn scale (cos of the turn angle). */
layout(location = 1) in vec4 aFish;
/** Tail phase, fog, species, alpha. */
layout(location = 2) in vec4 aFish2;
uniform vec2 uResolution;
out vec2 vUv;
flat out float vTail;
flat out float vSpecies;
flat out float vAlpha;
flat out float vEdge;
flat out float vFog;
flat out vec3 vWater;
${WATER_GLSL}
${TO_CLIP_GLSL}
void main() {
  float h = uResolution.y;
  vec2 c = aFish.xy * h;
  float hs = 0.5 * aFish.z * h;
  // Edge-on, a fish is a sliver, never nothing; the sign mirrors it.
  float w = max(abs(aFish.w), 0.16);
  float sx = aFish.w < 0.0 ? -1.0 : 1.0;
  vec2 local = aCorner * vec2(1.0, 0.42);
  gl_Position = pxToClip(c + vec2(local.x * w * sx, local.y) * hs, uResolution);
  vUv = local;
  vTail = aFish2.x;
  vFog = aFish2.y;
  vSpecies = aFish2.z;
  vAlpha = aFish2.w;
  vEdge = 1.0 - w;
  vWater = waterAt(clamp(aFish.y, 0.0, 1.0));
}
`;

export const FISH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in float vTail;
flat in float vSpecies;
flat in float vAlpha;
flat in float vEdge;
flat in float vFog;
flat in vec3 vWater;
/** Light on the fish, neon stripe glow. */
uniform vec2 uFishLight;
out vec4 outColor;
void main() {
  bool silver = vSpecies > 0.5;
  vec2 uv = vUv;
  // Head at +x; a travelling wave bends the rear.
  float back = clamp(0.2 - uv.x, 0.0, 1.2);
  uv.y += 0.07 * sin(vTail - uv.x * 3.0) * back * back;

  vec2 bq = (uv - vec2(0.1, 0.0)) / vec2(0.66, silver ? 0.2 : 0.16);
  float bl = length(bq);
  float body = clamp((1.0 - bl) / max(fwidth(bl), 1e-4) + 0.5, 0.0, 1.0);

  // A forked tail behind the body.
  float tx = -0.44 - uv.x;
  float halfW = 0.04 + 0.55 * max(tx, 0.0);
  float tip = 0.36 - 0.18 * (1.0 - clamp(abs(uv.y) / halfW, 0.0, 1.0));
  float ta = max(fwidth(uv.x) * 1.5, 1e-4);
  float tail = clamp((halfW - abs(uv.y)) / ta, 0.0, 1.0) * clamp((tip - tx) / ta, 0.0, 1.0)
    * step(-0.15, tx);

  vec3 col;
  float tailAlpha;
  if (silver) {
    col = mix(vec3(0.42, 0.5, 0.54), vec3(0.88, 0.9, 0.9), smoothstep(-0.12, 0.1, uv.y));
    col *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.015, abs(uv.y - 0.01)));
    col += 0.15 * (1.0 - smoothstep(0.0, 0.08, abs(uv.y + 0.04)));
    tailAlpha = 0.45;
  } else {
    col = mix(vec3(0.5, 0.47, 0.38), vec3(0.85, 0.85, 0.8), smoothstep(-0.1, 0.12, uv.y));
    float red = smoothstep(0.005, 0.03, uv.y) * (1.0 - smoothstep(-0.05, 0.12, uv.x))
      * smoothstep(-0.55, -0.4, uv.x);
    col = mix(col, vec3(0.85, 0.12, 0.12), red);
    float stripe = (1.0 - smoothstep(0.022, 0.04, abs(uv.y + 0.025)))
      * smoothstep(-0.5, -0.35, uv.x) * (1.0 - smoothstep(0.5, 0.62, uv.x));
    col = mix(col, vec3(0.15, 0.75, 1.0), stripe);
    col += vec3(0.1, 0.55, 0.9) * stripe * uFishLight.y;
    tailAlpha = 0.3;
  }
  // The eye.
  col *= 1.0 - 0.85 * (1.0 - smoothstep(0.025, 0.04, length(uv - vec2(0.56, -0.02))));
  col *= uFishLight.x * (1.0 - 0.3 * vEdge);
  col = mix(col, vWater, vFog);
  outColor = vec4(col, max(body, tail * tailAlpha) * vAlpha);
}
`;
