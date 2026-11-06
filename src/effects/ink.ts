import { hexToUnitRgb } from "./color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import {
  createDropState,
  createPlumeUniforms,
  MAX_PLUMES,
  packPlumes,
  seedDrops,
  stepDrops,
} from "./ink-sim";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { wrap } from "./math";
import { buildPeriodicNoiseTexture, createRng } from "./noise";
import { inkMeta } from "./ink.meta";
import { defineEffect } from "./types";

/** Noise texture side in texels. RG: one vector octave (period 4), BA: the next (period 8). */
const NOISE_SIZE = 256;
const NOISE_CHANNELS = [
  { period: 4, seed: 301 },
  { period: 4, seed: 302 },
  { period: 8, seed: 303 },
  { period: 8, seed: 304 },
] as const;

/** Corner darkening: a soft studio falloff on light water, moodier on dark. */
const VIGNETTE_LIGHT = 0.05;
const VIGNETTE_DARK = 0.3;
/** Light water: absorption per unit density is this times (1 - ink colour). */
const ABSORB = 0.92;
/** Dark water: emission per unit density is this times the ink colour. */
const GLOW = 1.3;

/** Drops: coarse warp noise tiles per frame height, and the fine warp's range (detail 0..1). */
const DROP_FREQ1 = 1;
const DROP_FREQ2: readonly [number, number] = [1.5, 4];

/** Marbling: stripe repeats per frame height (each repeat holds one band of every ink). */
const MARBLE_REPEATS = 1.1;
/** Fraction of each band covered by ink; the rest is clear water between inks. */
const MARBLE_WIDTH = 0.62;
const MARBLE_SOFT = 0.05;
/** Warp amplitudes (frame heights at turbulence 1) and noise frequencies of the three folds. */
const MARBLE_AMP: readonly [number, number, number] = [0.32, 0.11, 0.035];
const MARBLE_FREQ1 = 0.45;
const MARBLE_FREQ2 = 1.1;
const MARBLE_FREQ3: readonly [number, number] = [2.5, 6];
/** Noise drift of each fold in texture units per second, and the stripe phase drift. */
const MARBLE_FLOW: readonly (readonly [number, number])[] = [
  [0.0021, 0.0013],
  [-0.0017, 0.0026],
  [0.0034, -0.0022],
];
const MARBLE_PHASE_RATE = 0.006;
/** Stripe direction: a slow sway around this angle (radians). */
const MARBLE_ANGLE = 0.5;
const MARBLE_SWAY = 0.35;
const MARBLE_SWAY_RATE = 0.011;

const HEADER = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform float uAspect;
uniform vec3 uWater;
uniform float uVignette;
uniform int uDark;
in vec2 vUv;
out vec4 outColor;
${DITHER_GLSL}
/** Two octaves of tiling vector noise in one fetch; each component within +-0.75. */
vec2 warp(vec2 uv) {
  vec4 n = texture(uNoise, uv) - 0.5;
  return n.xy + 0.5 * n.zw;
}
vec3 water() {
  vec2 d = vUv * 2.0 - 1.0;
  return uWater * (1.0 - uVignette * dot(d, d));
}
`;

/**
 * Drops: per live plume, two noise fetches (a swirling coarse warp, then a fine
 * warp that is stronger towards the edge for filaments) and an elongated soft
 * radial falloff. Pixels beyond a plume's reach skip it, so most pixels fetch
 * nothing. Light water multiplies per-channel transmissions (subtractive);
 * dark water adds glow and soft-clips it.
 */
const DROPS_FRAGMENT = /* glsl */ `${HEADER}
uniform int uCount;
/** x: coarse warp frequency, y: fine warp frequency (noise tiles per frame height). */
uniform vec2 uFreq;
/** Filament gaps near plume edges. */
uniform float uFil;
uniform vec4 uP0[${String(MAX_PLUMES)}];
uniform vec4 uP1[${String(MAX_PLUMES)}];
uniform vec4 uP2[${String(MAX_PLUMES)}];
uniform vec4 uP3[${String(MAX_PLUMES)}];
/** Per plume: absorption (light water) or emission (dark water). */
uniform vec3 uInk[${String(MAX_PLUMES)}];

vec2 toLocal(vec2 q, vec4 s) {
  return vec2(dot(q, s.xy) / s.z, s.x * q.y - s.y * q.x);
}

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec3 trans = vec3(1.0);
  vec3 glow = vec3(0.0);
  for (int i = 0; i < uCount; i++) {
    vec4 a = uP0[i];
    vec4 w = uP3[i];
    vec2 dp = p - a.xy;
    if (dot(dp, dp) > w.z) continue;
    vec4 o = uP1[i];
    vec4 s = uP2[i];
    // Coarse warp, sampled in coordinates that turn slowly with age: the plume curls.
    float cs = cos(w.w);
    float sn = sin(w.w);
    vec2 rp = vec2(cs * dp.x - sn * dp.y, sn * dp.x + cs * dp.y);
    vec2 q = dp + w.x * warp(rp * uFreq.x + o.xy);
    float e = smoothstep(0.3, 1.0, length(toLocal(q, s)) / a.z);
    // Fine warp, strongest at the edge, where the filaments are.
    vec4 n2 = texture(uNoise, q * uFreq.y + o.zw) - 0.5;
    q += w.y * (0.4 + 0.6 * e) * (n2.xy + 0.5 * n2.zw);
    float x = 1.0 - length(toLocal(q, s)) / a.z;
    float dens = smoothstep(0.0, s.w, x) * (0.55 + 0.45 * clamp(x, 0.0, 1.0));
    dens *= 1.0 - uFil * e * smoothstep(0.0, 0.3, n2.z);
    dens *= a.w;
    if (uDark == 1) glow += uInk[i] * dens;
    else trans *= 1.0 - uInk[i] * dens;
  }
  vec3 col = uDark == 1 ? water() + (1.0 - exp(-glow)) : water() * trans;
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Marbling: stripes of the inks, folded by three chained warps (one fetch each)
 * whose noise drifts slowly, so the pattern keeps folding into itself.
 */
const MARBLE_FRAGMENT = /* glsl */ `${HEADER}
/** Noise offsets of the three folds: xy, zw of the first, then xy of the third. */
uniform vec4 uOff;
uniform vec2 uOff3;
uniform vec3 uAmp;
uniform vec3 uMFreq;
/** Stripe direction times repeats per frame height. */
uniform vec2 uDir;
uniform float uPhase;
uniform float uInks;
uniform vec3 uInk[3];

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 q = p + uAmp.x * warp(p * uMFreq.x + uOff.xy);
  q += uAmp.y * warp(q * uMFreq.y + uOff.zw);
  q += uAmp.z * warp(q * uMFreq.z + uOff3);
  float t = (dot(q, uDir) + uPhase) * uInks;
  float k = floor(t);
  float f = t - k;
  int idx = int(mod(k, uInks) + 0.5);
  idx = idx > 2 ? 2 : idx;
  // Anti-aliased band edges, however tightly the folds compress them.
  float aa = clamp(fwidth(t), 0.002, 0.2);
  float soft = ${glslFloat(MARBLE_SOFT)} + aa;
  float band = smoothstep(0.0, soft, f) * (1.0 - smoothstep(${glslFloat(MARBLE_WIDTH)} - soft, ${glslFloat(MARBLE_WIDTH)}, f));
  // Pigment gathers slightly at the band edges, as in suminagashi.
  float dens = band * (0.8 + 0.2 * abs(f * ${glslFloat(2 / MARBLE_WIDTH)} - 1.0));
  vec3 ink = uInk[idx] * dens;
  vec3 col = uDark == 1 ? water() + (1.0 - exp(-ink)) : water() * (1.0 - ink);
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

const COMMON_UNIFORMS = ["uNoise", "uAspect", "uWater", "uVignette", "uDark"] as const;

/**
 * Clouds of ink blooming and curling through clear water: occasional drops at
 * the frame edges, each unfurling and fading over about a minute, or an endless
 * marbled swirl of the inks. Stateless domain warping of a soft radial falloff
 * (or of stripes) by a tiling noise texture, at reduced resolution.
 */
export const ink = defineEffect(inkMeta, {
  create(gl) {
    return withScope((scope) => {
      const target = scope.own(createLowResTarget(gl));
      const triangle = scope.own(createFullscreenTriangle(gl));
      const dropsProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, DROPS_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const marbleProgram = scope.add(
        createProgram(gl, FULLSCREEN_VERTEX, MARBLE_FRAGMENT),
        (p) => {
          gl.deleteProgram(p);
        },
      );
      const du = createUniforms(gl, dropsProgram, [
        ...COMMON_UNIFORMS,
        "uCount",
        "uFreq",
        "uFil",
        "uP0",
        "uP1",
        "uP2",
        "uP3",
        "uInk",
      ]);
      const mu = createUniforms(gl, marbleProgram, [
        ...COMMON_UNIFORMS,
        "uOff",
        "uOff3",
        "uAmp",
        "uMFreq",
        "uDir",
        "uPhase",
        "uInks",
        "uInk",
      ]);
      gl.useProgram(dropsProgram);
      du.i1("uNoise", 0);
      gl.useProgram(marbleProgram);
      mu.i1("uNoise", 0);

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
      // The fine warps minify the texture at low quality: mipmaps keep them from aliasing.
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const rng = createRng(0x1c4);
      const drops = createDropState();
      const plumeU = createPlumeUniforms();
      const plumeInk = new Float32Array(MAX_PLUMES * 3);
      let seeded = false;

      /** The three ink colours as absorptions (light water) or emissions (dark). */
      const palette = new Float32Array(9);
      const lastPalette = { water: "", c1: "", c2: "", c3: "" };
      let paletteVersion = 0;
      let marblePaletteVersion = -1;
      const updatePalette = (water: string, c1: string, c2: string, c3: string) => {
        const l = lastPalette;
        if (l.water === water && l.c1 === c1 && l.c2 === c2 && l.c3 === c3) return;
        l.water = water;
        l.c1 = c1;
        l.c2 = c2;
        l.c3 = c3;
        paletteVersion++;
        const dark = water === "dark";
        const hexes = [c1, c2, c3];
        for (let j = 0; j < 3; j++) {
          const c = hexToUnitRgb(hexes[j]);
          for (let ch = 0; ch < 3; ch++) {
            palette[j * 3 + ch] = dark ? c[ch] * GLOW : (1 - c[ch]) * ABSORB;
          }
        }
      };

      let width = 1;
      let height = 1;
      /** Marbling: fold offsets (texture units, wrapped), stripe phase (wrapped) and sway clock (float64). */
      const marbleOff = new Float64Array(6);
      let marblePhase = 0;
      let marbleClock = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const sdt = Math.max(0, dt) * Math.max(0, p.speed);
          const aspect = width / height;
          const dark = p.water === "dark";
          const waterColor = dark ? p.darkWater : p.lightWater;
          const inks = p.inks >= 2.5 ? 3 : 2;
          const turb = Math.max(0, p.turbulence);
          const detail = Math.min(1, Math.max(0, p.detail));
          updatePalette(p.water, p.color1, p.color2, p.color3);
          target.resize(width, height, qualityDivisor(p.quality));

          target.bind();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);

          if (p.mode === "marbling") {
            for (let f = 0; f < 3; f++) {
              marbleOff[f * 2] = wrap(marbleOff[f * 2] + MARBLE_FLOW[f][0] * sdt, 0, 1);
              marbleOff[f * 2 + 1] = wrap(marbleOff[f * 2 + 1] + MARBLE_FLOW[f][1] * sdt, 0, 1);
            }
            marblePhase = wrap(marblePhase + MARBLE_PHASE_RATE * sdt, 0, 1);
            marbleClock += sdt;
            const angle = MARBLE_ANGLE + MARBLE_SWAY * Math.sin(marbleClock * MARBLE_SWAY_RATE);
            gl.useProgram(marbleProgram);
            mu.f1("uAspect", aspect);
            mu.rgb("uWater", waterColor);
            mu.f1("uVignette", dark ? VIGNETTE_DARK : VIGNETTE_LIGHT);
            mu.i1("uDark", dark ? 1 : 0);
            mu.f4("uOff", marbleOff[0], marbleOff[1], marbleOff[2], marbleOff[3]);
            mu.f2("uOff3", marbleOff[4], marbleOff[5]);
            mu.f3("uAmp", MARBLE_AMP[0] * turb, MARBLE_AMP[1] * turb, MARBLE_AMP[2] * turb);
            mu.f3(
              "uMFreq",
              MARBLE_FREQ1,
              MARBLE_FREQ2,
              MARBLE_FREQ3[0] + (MARBLE_FREQ3[1] - MARBLE_FREQ3[0]) * detail,
            );
            mu.f2("uDir", Math.cos(angle) * MARBLE_REPEATS, Math.sin(angle) * MARBLE_REPEATS);
            mu.f1("uPhase", marblePhase);
            mu.f1("uInks", inks);
            if (marblePaletteVersion !== paletteVersion) {
              marblePaletteVersion = paletteVersion;
              gl.uniform3fv(mu.loc.uInk, palette);
            }
          } else {
            if (!seeded) {
              seeded = true;
              seedDrops(drops, rng, inks);
            }
            stepDrops(drops, sdt, p.frequency, inks, rng);
            const count = packPlumes(drops, aspect, turb, plumeU);
            gl.useProgram(dropsProgram);
            du.f1("uAspect", aspect);
            du.rgb("uWater", waterColor);
            du.f1("uVignette", dark ? VIGNETTE_DARK : VIGNETTE_LIGHT);
            du.i1("uDark", dark ? 1 : 0);
            du.i1("uCount", count);
            du.f2("uFreq", DROP_FREQ1, DROP_FREQ2[0] + (DROP_FREQ2[1] - DROP_FREQ2[0]) * detail);
            du.f1("uFil", 0.25 + 0.5 * detail);
            if (count > 0) {
              for (let i = 0; i < count; i++) {
                const c = plumeU.color[i] * 3;
                plumeInk[i * 3] = palette[c];
                plumeInk[i * 3 + 1] = palette[c + 1];
                plumeInk[i * 3 + 2] = palette[c + 2];
              }
              gl.uniform4fv(du.loc.uP0, plumeU.p0);
              gl.uniform4fv(du.loc.uP1, plumeU.p1);
              gl.uniform4fv(du.loc.uP2, plumeU.p2);
              gl.uniform4fv(du.loc.uP3, plumeU.p3);
              gl.uniform3fv(du.loc.uInk, plumeInk);
            }
          }
          triangle.draw();

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
