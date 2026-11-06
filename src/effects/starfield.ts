/**
 * Shared night-sky pieces for Star Trails and the effects that reuse its
 * sky: the star colours, the Milky Way haze (GLSL plus its noise texture), the
 * sky rotation in GLSL, and `createStarSprites`, which draws the same stars as
 * crisp, slowly twinkling points. The pure layout, rotation and band geometry
 * are in `starfield-sim.ts`.
 */
import { hexToUnitRgb } from "./color";
import { createDataTexture, createProgram, createUniforms, glslFloat, withScope } from "./gl";
import { clamp } from "./math";
import { buildPeriodicNoiseTexture } from "./noise";
import { createSpriteBatch, QUAD } from "./sprites";
import {
  DEFAULT_BAND,
  fillStars,
  HAZE_TILE,
  type MilkyWayBand,
  STAR_ENERGY,
  STAR_FLOATS,
  STAR_MIN_RADIUS_PX,
  STAR_RADIUS,
  type StarfieldLayout,
  TWINKLE_AMP,
  TWINKLE_FROM,
  TWINKLE_FULL,
  TWINKLE_PERIOD,
  twinkleTime,
} from "./starfield-sim";

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

const STAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Sky x, y (reference px from the pole), brightness, 2 x temperature. */
layout(location = 1) in vec4 aStar;
/** Twinkle cycles per period, phase. */
layout(location = 2) in vec2 aTwinkle;
/** Pole (reference px, y up), and the rotation's cosine and sine. */
uniform vec4 uPole;
/** Reference px -> device px, 2 / width, 2 / height. */
uniform vec3 uFrame;
/** Colour spread, light gain, twinkle amount, wrapped time (s). */
uniform vec4 uLook;
out vec2 vLocal;
flat out vec3 vColor;
${STAR_TINT_GLSL}
const float TAU = 6.283185307179586;
void main() {
  vec2 q = aStar.xy;
  vec2 d = vec2(uPole.z * q.x - uPole.w * q.y, uPole.w * q.x + uPole.z * q.y);
  vec2 px = (uPole.xy + d) * uFrame.x;
  float b = aStar.z;
  float r = max((${glslFloat(STAR_RADIUS[0])} + ${glslFloat(STAR_RADIUS[1])} * b) * uFrame.x, ${glslFloat(STAR_MIN_RADIUS_PX)});
  float tw = 1.0 + ${glslFloat(TWINKLE_AMP)} * uLook.z * smoothstep(${glslFloat(TWINKLE_FROM)}, ${glslFloat(TWINKLE_FULL)}, b)
    * sin(TAU * (aTwinkle.x * uLook.w * ${glslFloat(1 / TWINKLE_PERIOD)} + aTwinkle.y));
  // Same light at every sprite size: the (1 - d^2)^2 profile integrates to pi r^2 / 3.
  float peak = b * ${glslFloat((STAR_ENERGY * 3) / Math.PI)} * uFrame.x * uFrame.x / (r * r);
  vColor = starTint(aStar.w, uLook.x) * (peak * tw * uLook.y);
  vLocal = aCorner;
  gl_Position = vec4((px + aCorner * r) * uFrame.yz - 1.0, 0.0, 1.0);
}
`;

const STAR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float f = max(0.0, 1.0 - dot(vLocal, vLocal));
  outColor = vec4(vColor * (f * f), 0.0);
}
`;

/** Per-frame inputs of `StarSprites.draw`. Keep one and update it, so a frame allocates nothing. */
export interface StarDraw {
  /** Canvas size, device px. */
  width: number;
  height: number;
  /** Device px per reference px (`Viewport.scale`). */
  scale: number;
  /** Pole, reference px, y up (the one the stars were built for). */
  pole: readonly [number, number];
  /** Sky rotation, radians (any range; see `advanceRotation`). */
  rotation: number;
  /** Time, s, unwrapped float64 (wrapped here to the twinkle period). */
  time: number;
  /** Colour spread 0..1 (0 plain white). */
  colorful: number;
  /** Overall light, 1 = default. */
  gain: number;
  /** Twinkle amount 0..1. */
  twinkle: number;
}

export const createStarDraw = (): StarDraw => ({
  width: 1,
  height: 1,
  scale: 1,
  pole: [0, 0],
  rotation: 0,
  time: 0,
  colorful: 0.6,
  gain: 1,
  twinkle: 1,
});

/** Point stars of the shared layout as additive sprites. */
export interface StarSprites {
  /** Lists and uploads the stars for `layout`; returns the count. Call on resize or when the layout changes. */
  build(layout: StarfieldLayout): number;
  /** Stars from the last `build`. */
  readonly count: number;
  /**
   * Draws the stars additively (ONE, ONE) into the bound framebuffer and
   * viewport, then disables blending. Sets its own program.
   */
  draw(d: StarDraw): void;
  dispose(): void;
}

/**
 * Point stars from the shared layout: one small quad each, placed and turned
 * about the pole in the vertex shader (the CPU builds the list only on
 * `build`), with a soft round profile at least `STAR_MIN_RADIUS_PX` wide so
 * slow rotation doesn't shimmer, and a very slow twinkle on the bright ones.
 * `maxStars` bounds the list (see `fillStars`).
 */
export function createStarSprites(gl: WebGL2RenderingContext, maxStars: number): StarSprites {
  return withScope((scope) => {
    const program = scope.add(createProgram(gl, STAR_VERTEX, STAR_FRAGMENT), (p) => {
      gl.deleteProgram(p);
    });
    const u = createUniforms(gl, program, ["uPole", "uFrame", "uLook"]);
    const batch = scope.own(createSpriteBatch(gl, maxStars, [4, 2], [QUAD]));
    if (batch.stride !== STAR_FLOATS) throw new Error("createStarSprites: layout mismatch");
    let count = 0;
    return {
      build(layout) {
        count = fillStars(batch.data, maxStars, layout);
        batch.upload(count);
        return count;
      },
      get count() {
        return count;
      },
      draw(d) {
        if (count <= 0) return;
        gl.useProgram(program);
        u.f4("uPole", d.pole[0], d.pole[1], Math.cos(d.rotation), Math.sin(d.rotation));
        u.f3("uFrame", d.scale, 2 / d.width, 2 / d.height);
        u.f4(
          "uLook",
          clamp(d.colorful, 0, 1),
          Math.max(0, d.gain),
          clamp(d.twinkle, 0, 1),
          twinkleTime(d.time),
        );
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        batch.draw(0, count);
        gl.disable(gl.BLEND);
      },
      dispose: () => {
        scope.dispose();
      },
    };
  });
}
