/**
 * Soft light beams slanting down through the frame, as in Fireflies' dusty room,
 * Rising Bubbles and Jellyfish: their layout, the brightness profile the CPU
 * uses to light motes inside them, and the instanced quad that draws them with
 * the same profile.
 */

import { DITHER_GLSL, glslFloat, TO_CLIP_GLSL } from "./gl";
import { clamp, smoothstep } from "./math";

/**
 * A light beam: a parallelogram with horizontal top and bottom edges at `y0` and
 * `y1` and slanted sides. Its centre line is `x = x0 + slope * y`, and it reaches
 * `halfWidth` horizontally either side of that line. Reference units (y down).
 */
export interface Beam {
  x0: number;
  slope: number;
  halfWidth: number;
  y0: number;
  y1: number;
  /** Peak brightness multiplier. */
  intensity: number;
}

/** Inner edge of the across-beam falloff, as a fraction of the half-width. */
const BEAM_CORE = 0.3;
/** Where along the beam (0 = top, 1 = bottom) the end fade starts. */
const BEAM_END = 0.72;
/** Brightness left at the bottom of the beam, before the end fade. */
const BEAM_TAIL = 0.35;

/** Across-beam profile: `a` is horizontal offset / half-width; 1 inside the core, 0 at |a| >= 1. */
export function beamAcross(a: number): number {
  return 1 - smoothstep(BEAM_CORE, 1, Math.abs(a));
}

/** Along-beam profile: `v` is 0 at the top, 1 at the bottom; a gentle fade then a soft end. */
export function beamAlong(v: number): number {
  if (v < 0 || v > 1) {
    return 0;
  }
  return (1 - (1 - BEAM_TAIL) * v) * (1 - smoothstep(BEAM_END, 1, v));
}

/**
 * Brightness of beam `b` at point (x, y), 0 outside it. The fragment shader
 * computes the same function, so motes light up exactly where the beam is visible.
 */
export function beamMembership(x: number, y: number, b: Beam): number {
  const v = (y - b.y0) / (b.y1 - b.y0);
  if (v < 0 || v > 1) {
    return 0;
  }
  const a = (x - (b.x0 + b.slope * y)) / b.halfWidth;
  if (a <= -1 || a >= 1) {
    return 0;
  }
  return beamAcross(a) * beamAlong(v) * b.intensity;
}

/**
 * Writes beam `b` as a BEAM_VERTEX instance at `out[o]`: x0, slope and half-width,
 * then y0, y1 and intensity times `gain`, in device px (`scale` per reference px).
 */
export function writeBeamInstance(
  out: Float32Array,
  o: number,
  b: Beam,
  scale: number,
  gain: number,
): void {
  out[o] = b.x0 * scale;
  out[o + 1] = b.slope;
  out[o + 2] = b.halfWidth * scale;
  out[o + 3] = b.y0 * scale;
  out[o + 4] = b.y1 * scale;
  out[o + 5] = b.intensity * gain;
}

/** Relative mid-height x (fraction of width), half-width (px at 1080p) and intensity per beam. */
const BEAM_LAYOUT = [
  [0, 95, 1],
  [0.17, 55, 0.8],
  [-0.15, 70, 0.65],
] as const;

/** The most beams `layoutBeams` places. */
export const MAX_LAYOUT_BEAMS = BEAM_LAYOUT.length;

/** Slope at which the beam group's lean against the slant reaches its full 8% of the width. */
const FULL_LEAN_SLOPE = Math.tan((24 * Math.PI) / 180);

/**
 * Lays out `n` beams (clamped to 1..MAX_LAYOUT_BEAMS) into `out`, slanting `angleDeg`
 * from vertical (positive leans right going down), spanning the frame height and
 * centred around 40% of the width at mid-height. Allocates nothing.
 */
export function layoutBeams(n: number, angleDeg: number, refWidth: number, out: Beam[]): number {
  const count = Math.max(1, Math.min(MAX_LAYOUT_BEAMS, Math.round(n), out.length));
  const slope = Math.tan((angleDeg * Math.PI) / 180);
  // Lean the group against the slant so the beams stay central on screen. The lean
  // eases in with the slope, so dragging the angle through 0 doesn't jump the beams.
  const centre = refWidth * (0.42 - 0.08 * clamp(slope / FULL_LEAN_SLOPE, -1, 1));
  for (let i = 0; i < count; i++) {
    const layout = BEAM_LAYOUT[i];
    const b = out[i];
    b.slope = slope;
    b.x0 = centre + layout[0] * refWidth - slope * 540;
    b.halfWidth = layout[1];
    b.y0 = -20;
    b.y1 = 1080;
    b.intensity = layout[2];
  }
  return count;
}

/**
 * Each beam is one quad mapped onto its parallelogram: `aCorner.x` runs across
 * (±1 = the soft edges), `aCorner.y` along (-1 top, 1 bottom). The profiles match
 * `beamAcross` and `beamAlong`.
 */
export const BEAM_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x0, slope, half-width (device px; slope is unitless). */
layout(location = 1) in vec3 aShape;
/** y0, y1 (device px), intensity. */
layout(location = 2) in vec3 aSpan;
uniform vec2 uResolution;
out vec2 vBeam;
flat out float vIntensity;
${TO_CLIP_GLSL}
void main() {
  float v = aCorner.y * 0.5 + 0.5;
  float y = mix(aSpan.x, aSpan.y, v);
  float x = aShape.x + aShape.y * y + aCorner.x * aShape.z;
  vBeam = vec2(aCorner.x, v);
  vIntensity = aSpan.z;
  gl_Position = pxToClip(vec2(x, y), uResolution);
}
`;

export const BEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vBeam;
flat in float vIntensity;
uniform vec3 uColor;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float across = 1.0 - smoothstep(${glslFloat(BEAM_CORE)}, 1.0, abs(vBeam.x));
  float v = clamp(vBeam.y, 0.0, 1.0);
  float along = (1.0 - ${glslFloat(1 - BEAM_TAIL)} * v) * (1.0 - smoothstep(${glslFloat(BEAM_END)}, 1.0, v));
  vec3 c = uColor * (across * along * vIntensity);
  // Sub-LSB dither hides banding in the wide, shallow beam. Clamped at zero, since
  // a negative additive output would be clamped anyway and bias the edges.
  outColor = vec4(max(c + dither8(gl_FragCoord.xy), 0.0), 0.0);
}
`;
