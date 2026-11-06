import {
  buildFilmTable,
  DRAIN_POWER,
  DRAIN_TOP,
  filmMode,
  MAX_THICKNESS,
  TABLE_SIZE,
  type FilmMode,
} from "./film-sim";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  updateDataTexture,
  withScope,
} from "./gl";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { clamp, wrap } from "./math";
import { buildPeriodicNoiseTexture } from "./noise";
import { filmMeta } from "./film.meta";
import { defineEffect } from "./types";

/** Noise texture side in texels. RG: a vector octave (period 4); B, A: scalar octaves (periods 4, 8). */
const NOISE_SIZE = 256;
const NOISE_CHANNELS = [
  { period: 4, seed: 381 },
  { period: 4, seed: 382 },
  { period: 4, seed: 383 },
  { period: 8, seed: 384 },
] as const;
const NOISE_PERIOD = 4;

/** The thickness field is very smooth: even "high" shades 1/4 of the pixels. */
const DIVISORS = { high: 2, balanced: 3, low: 4 } as const;

/**
 * Noise lattice cells per frame height of the coarse warp, the fine warp and the
 * thickness noise. Low, so swirls are large and colour bands tens of pixels wide.
 */
const FREQ_WARP1 = 0.7;
const FREQ_WARP2 = 1.5;
const FREQ_THICK = 1.1;
/** Warp displacements in frame heights per unit of (texel - 0.5). */
const WARP1_AMP = 0.7;
const WARP2_AMP = 0.25;
/** Drift of each noise layer's offset, in texture units per second at swirl 1. */
const FLOW: readonly (readonly [number, number])[] = [
  [0.0042, 0.0029],
  [-0.0061, 0.0043],
  [0.0033, -0.0047],
];
/** Soap: downward advection of the whole swirl pattern, in frame heights per second at swirl 1. */
const SOAP_FALL = 0.012;

interface ModeSetup {
  /** Multiplier on every noise frequency (oil's puddles are a little smaller). */
  freq: number;
  /** 1: apply the drainage profile (thin black film at the top). */
  drain: number;
  /** Downward advection, frame heights per second at swirl 1. */
  fall: number;
  /** Peak brightness the window highlight adds. */
  highlight: number;
}
const MODES: Readonly<Record<FilmMode, ModeSetup>> = {
  soap: { freq: 1, drain: 1, fall: SOAP_FALL, highlight: 0.09 },
  oil: { freq: 1.35, drain: 0, fall: 0, highlight: 0.06 },
  pearl: { freq: 0.9, drain: 0, fall: 0, highlight: 0.1 },
};

/** Window highlight: centre (uv), drift amplitude and angular rates, radius in frame heights. */
const HIGHLIGHT_CENTRE: readonly [number, number] = [0.8, 0.76];
const HIGHLIGHT_DRIFT: readonly [number, number] = [0.07, 0.05];
const HIGHLIGHT_RATES: readonly [number, number] = [0.013, 0.0091];
const HIGHLIGHT_RADIUS = 0.33;

/**
 * Thickness pass (low res): three fetches of one periodic noise texture. A coarse
 * vector warp, a finer one sampled at the warped point, then two scalar octaves of
 * thickness noise in one fetch. Soap multiplies by the drainage profile. Writes
 * thickness / MAX_THICKNESS to R (RGBA16F where available; dithered for RGBA8).
 */
const THICKNESS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform float uAspect;
/** Noise uv per frame-height unit: coarse warp, fine warp, thickness. */
uniform vec3 uFreq;
uniform vec4 uOff01;
uniform vec2 uOff2;
/** Mean thickness and variation, both / MAX_THICKNESS. */
uniform vec2 uThick;
uniform float uDrain;
in vec2 vUv;
out vec4 outColor;
${DITHER_GLSL}
const float DRAIN_POWER = ${glslFloat(DRAIN_POWER)};
const float INV_DRAIN_TOP = ${glslFloat(1 / DRAIN_TOP)};
const float WARP1 = ${glslFloat(WARP1_AMP)};
const float WARP2 = ${glslFloat(WARP2_AMP)};

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 w1 = texture(uNoise, p * uFreq.x + uOff01.xy).rg - 0.5;
  vec2 q = p + WARP1 * w1;
  vec2 w2 = texture(uNoise, q * uFreq.y + uOff01.zw).rg - 0.5;
  q += WARP2 * w2;
  vec2 h = texture(uNoise, q * uFreq.z + uOff2).ba - 0.5;
  float d = uThick.x + uThick.y * (2.0 * h.x + h.y);
  // Drainage (see drainProfile in film-sim.ts): thinner towards the top.
  float drain = (DRAIN_POWER + 1.0) * pow(max(1.0 - vUv.y * INV_DRAIN_TOP, 0.0), DRAIN_POWER);
  d *= mix(1.0, drain, uDrain);
  outColor = vec4(clamp(d, 0.0, 1.0) + dither8(gl_FragCoord.xy), 0.0, 0.0, 1.0);
}
`;

/** Full-res composite: one lookup fetch, mixed over the background, plus the soft highlight. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uFilm;
uniform vec3 uBg;
uniform float uAspect;
/** Highlight centre (uv), 1 / radius^2 in frame-height units, peak. */
uniform vec4 uSpec;
const float LUT_SCALE = ${glslFloat((TABLE_SIZE - 1) / TABLE_SIZE)};
const float LUT_BIAS = ${glslFloat(0.5 / TABLE_SIZE)};
vec4 composite(vec2 uv) {
  float t = texture(uLowRes, uv).r;
  vec4 f = texture(uFilm, vec2(t * LUT_SCALE + LUT_BIAS, 0.5));
  vec3 c = mix(uBg, f.rgb, f.a);
  vec2 s = (uv - uSpec.xy) * vec2(uAspect, 1.0);
  c += uSpec.w * (0.4 + 0.6 * f.a) * exp2(-dot(s, s) * uSpec.z);
  return vec4(c, 1.0);
}
`;

/**
 * Iridescent film: slow-flowing thin-film interference colours (soap film, oil
 * slick or pearl). A low-res pass renders a smooth, domain-warped thickness field;
 * the upscaling blit turns thickness into colour with one fetch of a lookup table
 * built in JS from the real interference optics (see `film-sim.ts`).
 */
export const film = defineEffect(filmMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, THICKNESS_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { format: "rgba16f", composite: COMPOSITE }));
      const u = createUniforms(gl, program, [
        "uNoise",
        "uAspect",
        "uFreq",
        "uOff01",
        "uOff2",
        "uThick",
        "uDrain",
      ]);
      const cu = createUniforms(gl, target.program, ["uFilm", "uBg", "uAspect", "uSpec"]);
      gl.useProgram(program);
      u.i1("uNoise", 0);
      gl.useProgram(target.program);
      cu.i1("uFilm", 1);

      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, NOISE_CHANNELS),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const table = new Uint8Array(TABLE_SIZE * 4);
      const tableTex = scope.add(
        createDataTexture(gl, {
          width: TABLE_SIZE,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: table,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      let tableMode = "";
      let tableSat = Number.NaN;

      /** Noise offsets of the three layers in texture units, wrapped to [0, 1). */
      const off = new Float64Array(6);
      /** Highlight clock in seconds (float64, CPU only). */
      let clock = 0;
      let width = 1;
      let height = 1;
      /** Texture the thickness was last rendered into; a new one needs a render. */
      let renderedTex: WebGLTexture | null = null;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const mode = filmMode(p.mode);
          const setup = MODES[mode];
          const aspect = width / height;
          const swirl = Number.isFinite(p.swirl) ? Math.max(0, p.swirl) : 0;
          const sdt = step * swirl;
          clock += step;

          // Lookup table: rebuilt only when the mode or saturation change.
          gl.activeTexture(gl.TEXTURE1);
          if (mode !== tableMode || p.saturation !== tableSat) {
            tableMode = mode;
            tableSat = p.saturation;
            buildFilmTable(mode, p.saturation, table);
            updateDataTexture(gl, tableTex, TABLE_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, table);
          }

          // Thickness pass, only when the field moved or a setting changed.
          // Noise uv per frame-height unit of each layer.
          const f = setup.freq / NOISE_PERIOD;
          const s0 = FREQ_WARP1 * f;
          const s1 = FREQ_WARP2 * f;
          const s2 = FREQ_THICK * f;
          let invalid = sdt > 0;
          if (sdt > 0) {
            // Soap's fall moves every layer by the same distance on screen.
            const fall = setup.fall * sdt;
            off[0] = wrap(off[0] + FLOW[0][0] * sdt, 0, 1);
            off[1] = wrap(off[1] + FLOW[0][1] * sdt + fall * s0, 0, 1);
            off[2] = wrap(off[2] + FLOW[1][0] * sdt, 0, 1);
            off[3] = wrap(off[3] + FLOW[1][1] * sdt + fall * s1, 0, 1);
            off[4] = wrap(off[4] + FLOW[2][0] * sdt, 0, 1);
            off[5] = wrap(off[5] + FLOW[2][1] * sdt + fall * s2, 0, 1);
          }
          target.resize(width, height, qualityDivisor(p.quality, DIVISORS));
          if (target.texture !== renderedTex) invalid = true;
          gl.useProgram(program);
          if (u.f1("uAspect", aspect)) invalid = true;
          if (u.f3("uFreq", s0, s1, s2)) invalid = true;
          if (u.f4("uOff01", off[0], off[1], off[2], off[3])) invalid = true;
          if (u.f2("uOff2", off[4], off[5])) invalid = true;
          const mean = clamp(p.thickness || 0, 0, MAX_THICKNESS);
          const range = clamp(p.range || 0, 0, MAX_THICKNESS);
          if (u.f2("uThick", mean / MAX_THICKNESS, range / MAX_THICKNESS)) invalid = true;
          if (u.f1("uDrain", setup.drain)) invalid = true;
          if (invalid) {
            target.bind();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, noiseTex);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            renderedTex = target.texture;
          }

          // Composite at full resolution.
          gl.useProgram(target.program);
          cu.rgb("uBg", mode === "pearl" ? p.pearlBackground : p.background);
          cu.f1("uAspect", aspect);
          cu.f4(
            "uSpec",
            HIGHLIGHT_CENTRE[0] + HIGHLIGHT_DRIFT[0] * Math.sin(clock * HIGHLIGHT_RATES[0]),
            HIGHLIGHT_CENTRE[1] + HIGHLIGHT_DRIFT[1] * Math.sin(clock * HIGHLIGHT_RATES[1]),
            1 / (HIGHLIGHT_RADIUS * HIGHLIGHT_RADIUS),
            p.highlight ? setup.highlight : 0,
          );
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, tableTex);
          target.blit();
          // Unbind the low-res texture so it is never sampled while it is a render target.
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
