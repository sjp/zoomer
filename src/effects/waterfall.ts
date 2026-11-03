import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createLowResTarget } from "./lowres";
import { clamp, fract, smoothstep } from "./math";
import { buildPeriodicNoiseTexture, createRng, hash32, HASH32_GLSL } from "./noise";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { defineEffect } from "./types";
import {
  buildStreakTexture,
  createFallLayout,
  createSpray,
  FALL_GRAVITY,
  FALL_LENGTH,
  FALL_V0,
  fallLayout,
  LEDGE_Y,
  MAX_SPRAY,
  packPalette,
  PALETTES,
  POOL_Y,
  REF_HEIGHT,
  scrollPhase,
  sprayAlpha,
  sprayCount,
  SPRAY_SINK,
  stepSpray,
  STREAK_H,
  STREAK_RATES,
  STREAK_W,
  WOBBLE,
  wobblePhases,
} from "./waterfall-sim";
import { type ForestLight, waterfallMeta } from "./waterfall.meta";

/** Background pass: about 2.5 reference px per texel (divisor 5 at 4K). */
const BG_TEXEL_REF = 2.5;

/** Shared noise texture (RGBA, one octave per channel) and the world size of one tile. */
const NOISE_SIZE = 128;
const NOISE_CHANNELS = [
  { period: 4, seed: 0x3a11 },
  { period: 8, seed: 0x7c42 },
  { period: 16, seed: 0x1e93 },
  { period: 32, seed: 0x5d06 },
] as const;

/** Mist drift: px/s sideways (away from the fall) for the two layers, and up at the foot. */
const MIST_TILES = [900, 500, 380] as const;
const MIST_SPEEDS = [14, 22, 26] as const;
/** Pool rings: waves per second leaving the foot. */
const RING_RATE = 0.35;
/** Light shafts: radians per second of their slow breathing. */
const SHAFT_RATE = 0.09;
/** Width of the lip where the water rolls over the ledge, reference px. */
const LIP = 6;

/** Spray look: opacity at full, how much it grows over its life. */
const SPRAY_OPACITY = 0.2;
const SPRAY_GROW = 1.8;

const f = glslFloat;

/** Palette indices into `uPal`; must follow `PALETTE_KEYS`. */
const PAL_GLSL = /* glsl */ `
uniform vec3 uPal[10];
#define CANOPY uPal[0]
#define DEEP uPal[1]
#define FAR uPal[2]
#define NEAR uPal[3]
#define ROCK uPal[4]
#define MOSS uPal[5]
#define POOL uPal[6]
#define WATER uPal[7]
#define MIST uPal[8]
#define SHAFT uPal[9]
`;

/**
 * Shared by the background and the fall: the band's wobbling edges (mirrors
 * `fallEdges` in waterfall-sim.ts) and the mist density, so the fall can be
 * hazed by exactly the mist the background has behind it.
 */
const COMMON_GLSL = /* glsl */ `
/** Fall centre x, half width at the top and bottom (local reference px), flow. */
uniform vec4 uFall;
/** Edge wobble phases. */
uniform vec4 uWob;
/** Mist scroll offsets: layer one (xy) and two (zw), in tiles. */
uniform vec4 uMistOff;
/** Mist amount (param) and the foot billow's scroll offset. */
uniform vec2 uMist;
uniform sampler2D uNoise;

vec2 fallEdges(float s) {
  float t = clamp(s * ${f(1 / FALL_LENGTH)}, 0.0, 1.0);
  float hw = mix(uFall.y, uFall.z, t);
  float g = 0.35 + 0.65 * t;
  float l = ${f(WOBBLE[0][0])} * sin(s * ${f(WOBBLE[0][1])} + uWob.x)
    + ${f(WOBBLE[1][0])} * sin(s * ${f(WOBBLE[1][1])} + uWob.y);
  float r = ${f(WOBBLE[2][0])} * sin(s * ${f(WOBBLE[2][1])} + uWob.z)
    + ${f(WOBBLE[3][0])} * sin(s * ${f(WOBBLE[3][1])} + uWob.w);
  return vec2(uFall.x - hw + g * l, uFall.x + hw + g * r);
}

float mistAt(vec2 p) {
  float a = texture(uNoise, p * ${f(1 / MIST_TILES[0])} + uMistOff.xy).r;
  float b = texture(uNoise, p * ${f(1 / MIST_TILES[1])} + uMistOff.zw).g;
  float n = smoothstep(0.3, 0.75, a * 0.6 + b * 0.4);
  float low = smoothstep(560.0, 960.0, p.y);
  vec2 d = (p - vec2(uFall.x, ${f(POOL_Y)})) / vec2(200.0 + 1.5 * uFall.z, 150.0);
  float foot = exp2(-dot(d, d) * 1.6);
  float billow = texture(uNoise, p * ${f(1 / MIST_TILES[2])} + vec2(0.31, uMist.y)).b;
  float m = low * (0.2 + 0.8 * n) * 0.7 + foot * (0.35 + 0.9 * billow) * (0.6 + 0.4 * uFall.w);
  return clamp(m * uMist.x, 0.0, 0.9);
}
`;

/**
 * The forest at low resolution, y down in local reference px (the fall on the
 * left): canopy light, hazy and near trunks, the mossy cliff the water drops
 * over with bushes on top, ferns along the bank, the pool with rings, foam and
 * the fall's reflection, foreground boulders, light shafts and mist.
 */
const BG_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
/** Reference width, mirror (0 or 1). */
uniform vec2 uRef;
/** Seeded phases for the outlines. */
uniform vec4 uShape;
uniform uint uHash;
/** Shaft breathing (radians), pool ring phase (0..1), foam scroll, shaft gain. */
uniform vec4 uAnim;
/** Edge softness, reference px. */
uniform float uSoft;
out vec4 outColor;
${PAL_GLSL}
${COMMON_GLSL}
${HASH32_GLSL}

float cover(float d) {
  return clamp(d / uSoft + 0.5, 0.0, 1.0);
}

vec2 rand2(float cell, uint salt) {
  uint h = hash32(uint(int(cell) + 65536) * 747796405u + uHash + salt);
  return vec2(float(h & 0xffffu), float(h >> 16u)) * ${f(1 / 65535)};
}

/** Coverage of a trunk in cells of \`cell\` px, \`w\` = width range, standing on \`bottom\`. */
float trunk(vec2 p, float cell, vec2 w, float bottom, uint salt) {
  float c = floor(p.x / cell);
  vec2 r = rand2(c, salt);
  float cx = (c + 0.25 + 0.5 * r.x) * cell;
  float width = mix(w.x, w.y, r.y) * (1.0 + 0.6 * smoothstep(bottom - 90.0, bottom, p.y));
  float lean = (r.x - 0.5) * 0.04 * (bottom - p.y);
  return cover(width * 0.5 - abs(p.x - cx - lean)) * cover(bottom - p.y);
}

/** A fern clump profile in 0..1: mounds with serrated fronds. */
float fern(float x, float cell, uint salt) {
  float c = floor(x / cell);
  float u = fract(x / cell) * 2.0 - 1.0;
  vec2 r = rand2(c, salt);
  float mound = max(0.0, 1.0 - u * u) * (0.45 + 0.55 * r.x);
  return mound * (0.72 + 0.28 * abs(sin(x * 0.16 + r.y * 6.0)));
}

void main() {
  vec2 q = vec2(gl_FragCoord.x * uPxToRef.x, ${f(REF_HEIGHT)} - gl_FragCoord.y * uPxToRef.y);
  vec2 p = vec2(mix(q.x, uRef.x - q.x, uRef.y), q.y);
  float x = p.x;
  float y = p.y;
  vec4 nz = texture(uNoise, p * ${f(1 / 1024)});
  float cx = uFall.x;

  // Canopy light at the top, deep shade lower down, with darker leaf clumps.
  vec3 col = mix(CANOPY, DEEP, smoothstep(0.0, 640.0, y + 160.0 * (nz.r - 0.5)));
  float clumps = texture(uNoise, p * ${f(1 / 640)} + uShape.xy * 0.1).g;
  col = mix(col, DEEP * 0.8, smoothstep(0.45, 0.62, clumps) * (1.0 - smoothstep(40.0, 560.0, y)) * 0.8);

  // Hazy far trunks, then darker near ones, standing on the forest floor.
  float floorY = ${f(POOL_Y - 30)} + 14.0 * sin(x * 0.011 + uShape.z);
  col = mix(col, mix(FAR, DEEP, 0.35 + 0.3 * smoothstep(200.0, 700.0, y)),
    0.85 * trunk(p, 95.0, vec2(7.0, 17.0), floorY, 11u));
  float near = trunk(p, 270.0, vec2(22.0, 44.0), floorY + 20.0, 29u);
  col = mix(col, NEAR * (1.4 + 0.5 * nz.b) + MOSS * 0.25 * smoothstep(500.0, 800.0, y), near);
  col = mix(col, DEEP * 0.7, cover(y - floorY));

  // The cliff: right edge flaring out towards the pool, top dipping to the lip.
  float t = smoothstep(${f(LEDGE_Y)}, ${f(POOL_Y)}, y);
  float cliffR = cx + uFall.z + 150.0 + 70.0 * t + 22.0 * sin(y * 0.021 + uShape.x)
    + 10.0 * sin(y * 0.057 + uShape.y);
  float dx = (x - cx) / (uFall.y + 26.0);
  float atLip = exp2(-dx * dx * 2.0);
  float top = mix(${f(LEDGE_Y - 30)} + 9.0 * sin(x * 0.03 + uShape.w) + 5.0 * sin(x * 0.09 + uShape.x),
    ${f(LEDGE_Y + 1)}, atLip);
  float inCliff = cover(cliffR - x) * cover(y - top);
  // Bushes on top, parting where the stream comes over.
  float bushTop = ${f(LEDGE_Y - 80)} - 38.0 * abs(sin(x * 0.009 + uShape.z)) - 16.0 * sin(x * 0.033 + uShape.y)
    - 6.0 * abs(sin(x * 0.11)) + 90.0 * atLip;
  float bush = cover(y - bushTop) * cover(cliffR + 30.0 - x);
  col = mix(col, NEAR * (1.2 + 1.2 * nz.g) + CANOPY * 0.12 * cover(bushTop + 20.0 - y), bush);
  // Rock with strata; moss on each ledge and along the top; wet and dark behind the water.
  float strata = fract((y + 18.0 * sin(x * 0.013 + uShape.x)) * ${f(1 / 64)});
  vec3 rock = ROCK * (0.7 + 0.6 * nz.a) * (0.55 + 0.45 * smoothstep(0.0, 0.1, strata));
  float moss = (1.0 - smoothstep(0.0, 0.3, strata)) * smoothstep(0.4, 0.65, nz.g)
    + 1.0 - smoothstep(6.0, 26.0, y - top);
  rock = mix(rock, MOSS * (0.75 + 0.5 * nz.r), clamp(moss, 0.0, 1.0));
  float wet = (x - cx) / (uFall.z + 40.0);
  rock *= (1.0 - 0.5 * exp2(-wet * wet)) * (0.7 + 0.3 * (1.0 - t));
  rock *= 0.75 + 0.25 * cover(cliffR - 14.0 - x);
  col = mix(col, rock, inCliff);

  // Ferns along the far bank.
  float bank = ${f(POOL_Y + 4)} - 75.0 * fern(x + uShape.w * 40.0, 150.0, 41u)
    - 40.0 * fern(x + 61.0, 83.0, 53u);
  col = mix(col, NEAR * (1.1 + 0.6 * nz.r), cover(y - bank) * cover(x - cliffR + 60.0));

  // The pool.
  float poolTop = ${f(POOL_Y)} + 3.0 * sin(x * 0.02 + uShape.z);
  if (y > poolTop - 2.0 * uSoft) {
    float dy = max(y - ${f(POOL_Y)}, 0.0);
    float depth = clamp(dy * ${f(1 / (REF_HEIGHT - POOL_Y))}, 0.0, 1.0);
    vec3 pool = mix(POOL * 1.4, POOL, depth) + CANOPY * 0.05 * depth;
    // Rings from the foot (squashed by perspective) and a gentle scrolled chop.
    vec2 rd = vec2(x - cx, dy * 3.2);
    float r = length(rd);
    float ring = sin(r * 0.045 - uAnim.y * 6.2831853) * exp2(-r * 0.0022) * smoothstep(20.0, 90.0, r);
    float chop = texture(uNoise, vec2(x * ${f(1 / 300)}, y * ${f(1 / 90)}) + uMistOff.zw).a - 0.5;
    float slope = ring * 0.8 + chop * 0.7;
    // The fall reflected, shifted by the ripples.
    float s = ${f(POOL_Y - LEDGE_Y)} - dy;
    vec2 e = fallEdges(s);
    float rx = x + slope * 12.0;
    float refl = smoothstep(-5.0, 5.0, rx - e.x) * smoothstep(-5.0, 5.0, e.y - rx);
    pool += WATER * refl * 0.3 * exp2(-dy * ${f(1 / 140)});
    pool += CANOPY * 0.07 * max(slope, 0.0);
    // Foam where the water lands.
    vec2 fd = vec2((x - cx) / (uFall.z * 1.6 + 20.0), dy * ${f(1 / 22)});
    float foamN = texture(uNoise, p * ${f(1 / 120)} + vec2(0.0, uAnim.z)).a;
    float foam = exp2(-dot(fd, fd)) * (0.55 + 0.7 * foamN) * (0.5 + 0.5 * uFall.w);
    pool = mix(pool, WATER, clamp(foam, 0.0, 1.0));
    col = mix(col, pool, cover(y - poolTop));
  }

  // Foreground boulders in the bottom corners, mossy on top, ferns on the far one.
  float bx = x / 230.0 - 0.3;
  float hl = sqrt(max(0.0, 1.0 - bx * bx * 0.5));
  float boulderL = 1084.0 - (154.0 + 12.0 * sin(x * 0.04 + uShape.y)) * hl;
  float fx = (uRef.x - x) / 260.0 - 0.2;
  float hr = sqrt(max(0.0, 1.0 - fx * fx * 0.45));
  float boulderR = 1084.0 - (179.0 + 10.0 * sin(x * 0.05 + uShape.w)) * hr;
  float fernR = boulderR + 6.0 - 95.0 * fern(x + 17.0, 120.0, 67u) * smoothstep(uRef.x - 520.0, uRef.x - 300.0, x);
  float dl = y - boulderL;
  float dr = y - boulderR;
  float fg = max(cover(dl), cover(dr));
  float rim = 1.0 - smoothstep(0.0, 30.0, max(dl, dr));
  vec3 stone = mix(ROCK * (0.45 + 0.4 * nz.a), MOSS * (0.6 + 0.4 * nz.b), rim * smoothstep(0.35, 0.6, nz.g + 0.2));
  col = mix(col, stone, fg);
  col = mix(col, NEAR * (0.8 + 0.4 * nz.r), cover(y - fernR) * (1.0 - cover(dr)));

  // Soft shafts of light slanting down through the canopy.
  float sr = x + y * 0.42;
  float shaft = pow(0.5 + 0.5 * sin(sr * 0.0105 + uShape.x), 6.0)
    * (0.65 + 0.35 * sin(sr * 0.0021 + uAnim.x)) * (0.5 + 0.5 * nz.b);
  col += SHAFT * shaft * uAnim.w * (1.0 - smoothstep(120.0, 1000.0, y));

  col = mix(col, MIST, mistAt(p));
  outColor = vec4(col, 1.0);
}
`;

/**
 * The fall at full resolution, scissored to its band: streak noise scrolled at
 * the free-fall speed and stretched as it speeds up, thresholded more and more
 * towards the pool so the sheet breaks into strands; anti-aliased edges and
 * strands, hazed by the same mist as the background, alpha-blended over it.
 */
const FALL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uScale;
uniform float uHeight;
/** Reference width, mirror (0 or 1). */
uniform vec2 uRef;
/** Streak scroll phases (tiles), seeded across offset. */
uniform vec3 uPhase;
uniform sampler2D uStreak;
out vec4 outColor;
${PAL_GLSL}
${COMMON_GLSL}
${DITHER_GLSL}

float travelTime(float s) {
  return (sqrt(${f(FALL_V0 * FALL_V0)} + ${f(2 * FALL_GRAVITY)} * max(s, 0.0)) - ${f(FALL_V0)}) * ${f(1 / FALL_GRAVITY)};
}

void main() {
  vec2 q = vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) / uScale;
  vec2 p = vec2(mix(q.x, uRef.x - q.x, uRef.y), q.y);
  float s = p.y - ${f(LEDGE_Y)};
  vec2 e = fallEdges(s);
  float px = 1.0 / uScale;
  float cov = clamp((p.x - e.x) / px + 0.5, 0.0, 1.0) * clamp((e.y - p.x) / px + 0.5, 0.0, 1.0)
    * clamp((s + ${f(LIP)}) / px + 0.5, 0.0, 1.0) * (1.0 - smoothstep(${f(POOL_Y - 8)}, ${f(POOL_Y + 10)}, p.y));
  if (cov <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  float u = (p.x - e.x) / max(e.y - e.x, 1.0);
  float tau = travelTime(s);
  float fall = clamp(s * ${f(1 / FALL_LENGTH)}, 0.0, 1.0);
  vec2 a = texture(uStreak, vec2(u * 1.5 + uPhase.z, tau * ${f(STREAK_RATES[0])} - uPhase.x)).rg;
  float b = texture(uStreak, vec2(u * 0.9 + 0.37, tau * ${f(STREAK_RATES[1])} - uPhase.y)).r;
  float n = a.r * 0.65 + b * 0.35;

  // The sheet breaks into strands down the fall and at its edges; less flow breaks sooner.
  float side = abs(2.0 * u - 1.0);
  float th = mix(0.2, 0.58, pow(fall, 1.3)) * (1.2 - 0.4 * uFall.w) + 0.25 * smoothstep(0.6, 1.0, side);
  float w = max(fwidth(n), 0.03);
  float water = smoothstep(th - w, th + w, n);

  float bright = clamp(0.35 + 0.9 * (a.g - 0.5) + 0.6 * (n - 0.5) + 0.25 * fall, 0.0, 1.0);
  vec3 col = mix(WATER * 0.72, vec3(0.97, 0.99, 1.0), bright) * (0.85 + 0.15 * (1.0 - side * side));
  // A glassy highlight on the lip, and white churn just above the pool.
  col += 0.22 * exp2(-s * s * ${f(1 / 40)});
  col = mix(col, vec3(0.93, 0.96, 0.96), 0.55 * smoothstep(${f(POOL_Y - 90)}, ${f(POOL_Y)}, p.y));
  col = mix(col, MIST, mistAt(p));
  col += dither8(gl_FragCoord.xy);
  outColor = vec4(col, cov * water * mix(0.95, 0.82, fall));
}
`;

/** Spray: soft round puffs, premultiplied alpha, device px with y down. */
const SPRAY_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down), radius, opacity. */
layout(location = 1) in vec4 aSprite;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vAlpha = aSprite.w;
  gl_Position = pxToClip(aSprite.xy + aCorner * aSprite.z, uResolution);
}
`;

const SPRAY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vAlpha;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float b = max(0.0, 1.0 - dot(vLocal, vLocal));
  float a = vAlpha * b * b;
  outColor = vec4(uColor * a, a);
}
`;

/** One packed palette per light, built once. */
const PACKED: Readonly<Record<ForestLight, Float32Array>> = {
  morning: packPalette(PALETTES.morning),
  overcast: packPalette(PALETTES.overcast),
  dusk: packPalette(PALETTES.dusk),
};

const lightOf = (v: string): ForestLight => (v === "overcast" || v === "dusk" ? v : "morning");

/**
 * A waterfall in a forest: a narrow fall on one side drops from a mossy ledge
 * into a misty pool. Background, pool and mist render at low resolution; the
 * fall itself at full resolution inside its band; spray as a few hundred sprites.
 */
export const waterfall = defineEffect(waterfallMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => gl.deleteProgram(p));
      const texture = (data: Uint8Array, width: number, height: number, rgba: boolean) => {
        const tex = scope.add(
          createDataTexture(gl, {
            width,
            height,
            internalFormat: rgba ? gl.RGBA8 : gl.RG8,
            format: rgba ? gl.RGBA : gl.RG,
            type: gl.UNSIGNED_BYTE,
            data,
            wrap: gl.REPEAT,
          }),
          (t) => gl.deleteTexture(t),
        );
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
      };
      const noiseTex = texture(
        buildPeriodicNoiseTexture(NOISE_SIZE, NOISE_CHANNELS),
        NOISE_SIZE,
        NOISE_SIZE,
        true,
      );
      const streakTex = texture(buildStreakTexture(), STREAK_W, STREAK_H, false);

      const common = ["uPal", "uFall", "uWob", "uMistOff", "uMist", "uNoise", "uRef"] as const;
      const bgProgram = program(FULLSCREEN_VERTEX, BG_FRAGMENT);
      const bu = createUniforms(gl, bgProgram, [
        ...common,
        "uPxToRef",
        "uShape",
        "uHash",
        "uAnim",
        "uSoft",
      ]);
      gl.useProgram(bgProgram);
      bu.i1("uNoise", 1);
      const fallProgram = program(FULLSCREEN_VERTEX, FALL_FRAGMENT);
      const fu = createUniforms(gl, fallProgram, [
        ...common,
        "uScale",
        "uHeight",
        "uPhase",
        "uStreak",
      ]);
      gl.useProgram(fallProgram);
      fu.i1("uNoise", 1);
      fu.i1("uStreak", 2);
      const sprayProgram = program(SPRAY_VERTEX, SPRAY_FRAGMENT);
      const su = createUniforms(gl, sprayProgram, ["uResolution", "uColor"]);
      const sprites = scope.own(createSpriteBatch(gl, MAX_SPRAY, [4], [polygonStrip(8)]));

      const layout = createFallLayout();
      const phases = new Float64Array(4);
      let spray = createSpray(0, layout);
      let spraySeed = -1;
      /** The light each program's `uPal` holds. */
      let bgLight = "";
      let fallLight = "";
      let shapeSeed = -1;
      let time = 0;

      let width = 1;
      let height = 1;
      let scale = 1;

      /** Uniforms both the background and the fall read. */
      const setCommon = (
        u: typeof bu | typeof fu,
        light: ForestLight,
        upload: boolean,
        mirror: number,
        flow: number,
        mist: number,
      ) => {
        if (upload) gl.uniform3fv(u.loc.uPal, PACKED[light]);
        u.f4("uFall", layout.cx, layout.halfTop, layout.halfBottom, flow);
        u.f4("uWob", phases[0], phases[1], phases[2], phases[3]);
        u.f4(
          "uMistOff",
          fract((-time * MIST_SPEEDS[0]) / MIST_TILES[0]),
          0.17,
          fract((-time * MIST_SPEEDS[1]) / MIST_TILES[1]),
          0.61,
        );
        u.f2("uMist", mist, fract((time * MIST_SPEEDS[2]) / MIST_TILES[2]));
        u.f2("uRef", width / scale, mirror);
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          target.resize(width, height, Math.max(1, BG_TEXEL_REF * scale));
          gl.useProgram(bgProgram);
          bu.f2(
            "uPxToRef",
            target.fullWidth / target.width / scale,
            target.fullHeight / target.height / scale,
          );
          bu.f1("uSoft", Math.max(1.5, (target.fullHeight / target.height / scale) * 1.2));
          gl.useProgram(fallProgram);
          fu.f1("uScale", scale);
          fu.f1("uHeight", height);
          gl.useProgram(sprayProgram);
          su.f2("uResolution", width, height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const refWidth = width / scale;
          const seed = Math.floor(p.seed);
          const right = p.position === "right";
          const mirror = right ? 1 : 0;
          const flow = clamp(p.flow, 0, 1);
          const mist = clamp(p.mist, 0, 1);
          const light = lightOf(p.light);
          const pal = PALETTES[light];

          fallLayout(layout, refWidth, flow);
          wobblePhases(phases, time);
          if (seed !== spraySeed) {
            spray = createSpray(seed, layout);
            spraySeed = seed;
          }

          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, streakTex);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.activeTexture(gl.TEXTURE0);

          // 1. Forest, cliff, pool and mist at low resolution, upscaled with dither.
          target.bind();
          gl.useProgram(bgProgram);
          setCommon(bu, light, light !== bgLight, mirror, flow, mist);
          bgLight = light;
          if (seed !== shapeSeed) {
            const rng = createRng(hash32(seed + 0x3f1d));
            const tau = Math.PI * 2;
            bu.f4("uShape", rng() * tau, rng() * tau, rng() * tau, rng() * tau);
            bu.u1("uHash", hash32(seed + 0x77));
            shapeSeed = seed;
          }
          bu.f4(
            "uAnim",
            fract((time * SHAFT_RATE) / (2 * Math.PI)) * 2 * Math.PI,
            fract(time * RING_RATE),
            fract(time * 0.12),
            pal.shaftGain,
          );
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // 2. The fall at full resolution, scissored to its band.
          const x0 = right ? refWidth - layout.maxX : layout.minX;
          const left = Math.max(0, Math.floor(x0 * scale));
          const bandRight = Math.min(width, Math.ceil((x0 + layout.maxX - layout.minX) * scale));
          const top = Math.max(0, Math.floor((LEDGE_Y - 10) * scale));
          const bottom = Math.min(height, Math.ceil((POOL_Y + 12) * scale));
          if (bandRight > left && bottom > top) {
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(left, height - bottom, bandRight - left, bottom - top);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(fallProgram);
            setCommon(fu, light, light !== fallLight, mirror, flow, mist);
            fallLight = light;
            fu.f3(
              "uPhase",
              scrollPhase(time, STREAK_RATES[0]),
              scrollPhase(time, STREAK_RATES[1]),
              fract(seed * 0.618034),
            );
            triangle.draw();
            gl.disable(gl.SCISSOR_TEST);
          }

          // 3. Spray at the foot: soft premultiplied puffs.
          stepSpray(spray, dt, layout, sprayCount(flow));
          const d = sprites.data;
          let n = 0;
          for (let i = 0; i < MAX_SPRAY; i++) {
            const life = spray.life[i];
            const age = spray.age[i];
            if (age >= life) continue;
            const t = age / life;
            const y = spray.y[i];
            const a =
              SPRAY_OPACITY * sprayAlpha(t) * smoothstep(POOL_Y + SPRAY_SINK, POOL_Y - 10, y);
            if (a < 0.004) continue;
            const x = right ? refWidth - spray.x[i] : spray.x[i];
            const o = n * 4;
            d[o] = x * scale;
            d[o + 1] = y * scale;
            d[o + 2] = spray.size[i] * (1 + SPRAY_GROW * t) * scale + 0.5;
            d[o + 3] = a;
            n++;
          }
          if (n > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(sprayProgram);
            su.f3(
              "uColor",
              0.5 * pal.mist[0] + 0.5,
              0.5 * pal.mist[1] + 0.5,
              0.5 * pal.mist[2] + 0.5,
            );
            sprites.upload(n);
            sprites.draw(0, n);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
