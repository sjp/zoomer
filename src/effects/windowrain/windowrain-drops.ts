/**
 * The rain-on-glass drop map, shared by Rain on a Window and the Neon-Noir
 * Apartment: drop sprites from `writeDropInstances` drawn into an RGBA8 map of
 * refraction offsets, dome heights and coverage, and the GLSL that decodes it.
 */
import { glslFloat, TO_CLIP_GLSL } from "../gl";

/**
 * Drop lens: a drop shows the background around its centre, inverted and
 * minified by this factor (a ball lens's wide, flipped view), so the defocused
 * lights read smaller and crisper through the drop.
 */
const LENS = 2;
/** Refraction offsets are stored in the drop map as +-OFFSET_RANGE reference px. */
export const OFFSET_RANGE = 128;
/** 8-bit value meaning "no offset", and the scale from [-1, 1] to stored units. */
export const ENC_MID = 128 / 255;
const ENC_SCALE = 127 / 255;
/** The drop map's clear value: no offset, no dome, no coverage. */
export const DROP_CLEAR = new Float32Array([ENC_MID, ENC_MID, 0, 0]);

/** `vec2 dropDir(vec4 d)`: a drop-map texel's refraction offset, decoded to [-1, 1]. */
export const DROP_DIR_GLSL = /* glsl */ `
vec2 dropDir(vec4 d) {
  return (d.xy - ${glslFloat(ENC_MID)}) * ${glslFloat(1 / ENC_SCALE)};
}
`;

/**
 * Drop sprites, shared by the drop-map and fog-wipe passes. Each drop is an
 * octagon around an ellipse (stretched vertically while running).
 */
export const DROP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down) and vertical stretch. */
layout(location = 1) in vec4 aDrop;
layout(location = 2) in float aFade;
uniform vec2 uResolution;
uniform float uInvScale;
uniform float uGrow;
uniform float uMargin;
/** Unit-ellipse coordinates, y up. */
out vec2 vLocal;
/** Offset from the centre in reference px, y up. */
out vec2 vRel;
flat out float vFade;
${TO_CLIP_GLSL}
void main() {
  float s = aDrop.w;
  vec2 radii = aDrop.z * uGrow * vec2(inversesqrt(s), s);
  // Grow by the target's texel size, so the anti-aliased edge is never clipped.
  vec2 ext = radii + uMargin;
  vec2 offset = aCorner * ext;
  vec2 px = aDrop.xy + offset;
  vLocal = offset / radii * vec2(1.0, -1.0);
  vRel = offset * uInvScale * vec2(1.0, -1.0);
  vFade = aFade;
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * Drop map: RG = refraction offset (encoded), B = dome height, A = coverage.
 * Drawn without blending in priority order (runners last), so each pixel holds
 * exactly one drop's surface and overlaps are well defined.
 */
export const DROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vRel;
flat in float vFade;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float cov = clamp((1.0 - d) / max(fwidth(d), 1e-4) + 0.5, 0.0, 1.0);
  if (cov <= 0.0) discard;
  float h = sqrt(max(1.0 - d * d, 0.0));
  // Sample the background at centre - LENS * rel: inverted and minified.
  vec2 off = vRel * (${glslFloat(-(1 + LENS) / OFFSET_RANGE)} * vFade);
  vec2 enc = clamp(${glslFloat(ENC_MID)} + off * ${glslFloat(ENC_SCALE)}, ${glslFloat(1 / 255)}, 1.0);
  outColor = vec4(enc, h, cov * vFade);
}
`;
