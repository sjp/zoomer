/**
 * The Jellyfish shaders for the bells and tentacle strips that `createSwarm`
 * (jellyfish-sim.ts) writes: additive, in device px. Shared with other
 * underwater scenes that reuse the swarm.
 */
import { DITHER_GLSL, glslFloat, TO_CLIP_GLSL } from "../gl";
import { SPRITE_SPIN_GLSL } from "../sprites";
import { BELL_A, DOME_H, QUAD_BOTTOM, RIM_E, RIM_Y } from "./jellyfish-sim";

/** The bell quad: full width, from the top to just below the rim (nothing is drawn lower). */
export const BELL_SHAPE: readonly number[] = [-1, -1, 1, -1, -1, QUAD_BOTTOM, 1, QUAD_BOTTOM];

export const bellVertex = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, quad half-width, half-height (device px, y down). */
layout(location = 1) in vec4 aBell;
/** Premultiplied colour, contraction. */
layout(location = 2) in vec4 aTint;
layout(location = ${String(spinLocation)}) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vTint;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vLocal = aCorner;
  vTint = aTint;
  gl_Position = pxToClip(aBell.xy + spinCorner(aCorner * aBell.zw, aSpin), uResolution);
}
`;

/**
 * A translucent bell, shaded analytically in quad-local units (x across, y down
 * the axis): a dome above the rim ellipse, brighter toward its edge, with the rim
 * ring (its back half seen through the dome), radial canals, an inner glow and a
 * faint halo that reaches zero inside the quad.
 */
export const BELL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vTint;
uniform float uGlow;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float x = vLocal.x / ${glslFloat(BELL_A)};
  float dy = vLocal.y - ${glslFloat(RIM_Y)};
  // Silhouette: the dome above the rim, the near half of the rim ellipse below.
  float r = length(vec2(x, dy / (dy < 0.0 ? ${glslFloat(DOME_H)} : ${glslFloat(RIM_E)})));
  float body = 1.0 - smoothstep(0.9, 1.0, r);
  float edge = smoothstep(0.55, 1.0, r);
  float rim = edge * edge * edge;

  // Rim ring: distance to the whole rim ellipse, normalised by its gradient.
  float ey = dy / ${glslFloat(RIM_E)};
  float e = length(vec2(x, ey));
  vec2 grad = vec2(x / ${glslFloat(BELL_A)}, ey / ${glslFloat(RIM_E)}) / max(e, 1e-3);
  float d = (e - 1.0) / max(length(grad), 1e-3);
  float ring = exp(-(d * d) / 0.0012);

  // Radial canals: meridians of the dome, from the apex down to the rim.
  float h = min(dy, 0.0) / ${glslFloat(DOME_H)};
  float span = sqrt(max(1.0 - h * h, 1e-4));
  float lon = asin(clamp(x / span, -1.0, 1.0));
  float c = cos(lon * 4.0);
  float canal = smoothstep(0.8, 1.0, c * c) * smoothstep(0.0, 0.3, 1.0 + h) * step(dy, 0.0);

  // Inner glow, high in the bell.
  vec2 q = vec2(x * 1.6, (dy + 0.5 * ${glslFloat(DOME_H)}) / 0.45);
  float inner = exp(-3.0 * dot(q, q));

  float halo = max(0.0, 1.0 - (r - 1.0) / 0.2);
  halo *= halo * (1.0 - body);

  float con = vTint.a;
  float lum = body * (0.09 + (0.35 + 0.5 * uGlow) * rim + 0.3 * canal + 0.35 * inner)
    + 0.55 * ring
    + 0.22 * uGlow * halo;
  lum *= 1.0 + 0.3 * con;
  outColor = vec4(max(vTint.rgb * lum + dither8(gl_FragCoord.xy), 0.0), 0.0);
}
`;

/** Tentacle strips: device-px positions, the across coordinate and a premultiplied colour. */
export const STRIP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aAcross;
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
out float vAcross;
out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  vAcross = aAcross;
  vColor = aColor;
  gl_Position = pxToClip(aPos, uResolution);
}
`;

/** A soft ribbon: brightest along its middle, zero at both edges. */
export const STRIP_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in float vAcross;
in vec3 vColor;
out vec4 outColor;
void main() {
  float f = max(1.0 - vAcross * vAcross, 0.0);
  outColor = vec4(vColor * f, 0.0);
}
`;
