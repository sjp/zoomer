/**
 * Shared night-sky pieces for Star Trails (036) and the effects that reuse its
 * sky: the star colours, the Milky Way haze (GLSL plus its noise texture) and
 * the sky rotation in GLSL. The pure layout, rotation and band geometry are in
 * `starfield-sim.ts`.
 */
import { hexToUnitRgb } from "./color";
import { createDataTexture, glslFloat } from "./gl";
import { buildPeriodicNoiseTexture } from "./noise";
import { DEFAULT_BAND, HAZE_TILE, type MilkyWayBand } from "./starfield-sim";

/** Star colours: hot blue-white, white and cool orange. */
export const STAR_BLUE = "#b4c8ff";
export const STAR_WHITE = "#f4f2ec";
export const STAR_ORANGE = "#ffb070";
/** Milky Way haze colour, before the caller's strength. */
export const HAZE_COLOR = "#aab4d6";
/** Haze brightness at a strength of 1. */
export const HAZE_GAIN = 0.11;

const NOISE_SIZE = 128;

/** A hex colour as a GLSL `vec3` literal, optionally scaled. */
export function glslColor(hex: string, gain = 1): string {
  const [r, g, b] = hexToUnitRgb(hex);
  const v = `vec3(${glslFloat(r)}, ${glslFloat(g)}, ${glslFloat(b)})`;
  return gain === 1 ? v : `${v} * ${glslFloat(gain)}`;
}

/**
 * GLSL for the star colours: `vec3 starTint(float temp2, float colorful)`, where
 * `temp2` is twice the colour temperature (0 blue-white, 1 white, 2 orange) and
 * `colorful` (0..1) blends from plain white to the full tint. Defines the
 * constants `STAR_BLUE`, `STAR_WHITE` and `STAR_ORANGE`.
 */
export const STAR_TINT_GLSL = /* glsl */ `
const vec3 STAR_BLUE = ${glslColor(STAR_BLUE)};
const vec3 STAR_WHITE = ${glslColor(STAR_WHITE)};
const vec3 STAR_ORANGE = ${glslColor(STAR_ORANGE)};
vec3 starTint(float temp2, float colorful) {
  vec3 c = temp2 < 1.0 ? mix(STAR_BLUE, STAR_WHITE, temp2) : mix(STAR_WHITE, STAR_ORANGE, temp2 - 1.0);
  return mix(STAR_WHITE, c, colorful);
}
`;

/**
 * GLSL for `vec2 toSky(vec2 d, vec2 cs)`: a screen offset from the pole turned
 * back by the sky's rotation (`cs` = its cosine and sine) into sky coordinates.
 * The twin of `toSky` in `starfield-sim.ts`.
 */
export const TO_SKY_GLSL = /* glsl */ `
vec2 toSky(vec2 d, vec2 cs) {
  return vec2(cs.x * d.x + cs.y * d.y, cs.x * d.y - cs.y * d.x);
}
`;

/**
 * GLSL for the Milky Way haze along `band`, in sky coordinates `q` (reference px
 * from the pole, see `toSky`):
 *
 * - `float milkyWayAcross(vec2 q)`: signed distance from the band's centre line.
 * - `float milkyWay(sampler2D noise, vec2 q)`: the mottled haze, about 0..1.5,
 *   0 well outside the band (one fetch of `createMilkyWayNoise`, skipped there).
 *
 * Multiply the haze by `HAZE_COLOR * HAZE_GAIN` (`glslColor(HAZE_COLOR, HAZE_GAIN)`)
 * and the caller's strength.
 */
export function milkyWayGlsl(band: MilkyWayBand = DEFAULT_BAND): string {
  return /* glsl */ `
float milkyWayAcross(vec2 q) {
  return dot(q, vec2(${glslFloat(Math.cos(band.angle))}, ${glslFloat(Math.sin(band.angle))})) - ${glslFloat(band.offset)};
}
float milkyWay(sampler2D noise, vec2 q) {
  float across = milkyWayAcross(q);
  float m = exp2(-across * across * ${glslFloat(1 / (band.width * band.width))});
  if (m <= 0.01) return 0.0;
  vec2 n = textureLod(noise, q * ${glslFloat(1 / HAZE_TILE)}, 0.0).rg;
  return m * smoothstep(0.3, 0.75, n.r) * (0.5 + n.g);
}
`;
}

/**
 * The haze's tiling RG8 noise texture (two octaves), with REPEAT wrapping. The
 * caller owns it: `scope.add(createMilkyWayNoise(gl), (t) => gl.deleteTexture(t))`.
 */
export function createMilkyWayNoise(gl: WebGL2RenderingContext): WebGLTexture {
  return createDataTexture(gl, {
    width: NOISE_SIZE,
    height: NOISE_SIZE,
    internalFormat: gl.RG8,
    format: gl.RG,
    type: gl.UNSIGNED_BYTE,
    data: buildPeriodicNoiseTexture(NOISE_SIZE, [
      { period: 4, seed: 3611 },
      { period: 16, seed: 3613 },
    ]),
    wrap: gl.REPEAT,
  });
}
