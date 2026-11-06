/**
 * The Rising Bubbles sprite shaders, shared with the aquarium's air-stone column:
 * an instanced octagon per bubble (see `createSpriteBatch` with `{ rotation: true }`
 * and the per-bubble layout written by `bubbles-sim.ts`).
 */
import { glslFloat, TO_CLIP_GLSL } from "./gl";
import { SPRITE_SPIN_GLSL } from "./sprites";

/** Light from above and a little to the left, in screen space (y down). */
const LIGHT_X = -0.3;
const LIGHT_Y = -0.954;

/**
 * One bubble in an octagon. `vLocal` is in the bubble's own frame, where its rim
 * is the unit circle; the spin pair squashes and turns that frame into a tilted
 * ellipse. The light direction is carried into the same frame once per vertex,
 * so the highlights sit toward the light whatever the wobble.
 */
export const bubbleVertex = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y (device px, y down), semi-major axis (device px), opacity. */
layout(location = 1) in vec4 aBubble;
/** Edge softness (fraction of the radius), sprite extent (radii). */
layout(location = 2) in vec2 aLook;
/** Angle (radians), squash of the local x axis. */
layout(location = ${String(spinLocation)}) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec2 vLight;
flat out float vAlpha;
flat out float vSoft;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vLocal = aCorner * aLook.y;
  vec2 px = aBubble.xy + spinCorner(vLocal, aSpin) * aBubble.z;
  // Screen light direction into the local frame: undo the rotation, then the squash.
  float s = sin(aSpin.x);
  float k = cos(aSpin.x);
  const vec2 light = vec2(${glslFloat(LIGHT_X)}, ${glslFloat(LIGHT_Y)});
  vec2 l = vec2(light.x * k + light.y * s, light.y * k - light.x * s);
  vLight = normalize(vec2(l.x / aSpin.y, l.y));
  vAlpha = aBubble.w;
  vSoft = aLook.x;
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * A mostly transparent bubble: a slightly darker body and inner ring (blended
 * over the liquid) plus a thin bright rim, a highlight toward the light and a
 * faint one opposite (added). Premultiplied output, so one draw does both.
 */
export const BUBBLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vLight;
flat in float vAlpha;
flat in float vSoft;
uniform vec3 uLight;
uniform vec3 uShade;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  // About a pixel of anti-aliasing, or the depth blur when that is wider.
  float w = max(fwidth(d), vSoft);
  float cover = clamp((1.0 - d) / w + 0.5, 0.0, 1.0);
  float rim = smoothstep(0.7, 1.0 - 0.5 * w, d);
  rim *= rim;
  float ring = max(0.0, 1.0 - abs(d - 0.8) * 6.0);
  vec2 h1 = vLocal - vLight * 0.5;
  vec2 h2 = vLocal + vLight * 0.62;
  float spec = max(0.0, 1.0 - dot(h1, h1) * 22.0);
  float spec2 = max(0.0, 1.0 - dot(h2, h2) * 40.0);
  spec = spec * spec * spec;
  spec2 = spec2 * spec2 * 0.35;
  float body = (0.07 + 0.3 * ring * ring) * cover * vAlpha;
  float glow = (0.55 * rim + spec + spec2) * cover * vAlpha;
  outColor = vec4(uShade * body + uLight * glow, body);
}
`;
