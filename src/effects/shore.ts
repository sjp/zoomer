import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  updateDataTexture,
  withScope,
} from "./gl";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { clamp, wrap } from "./math";
import { buildPeriodicNoiseTexture, createRng } from "./noise";
import {
  advanceFoam,
  createFoamField,
  createShoreScheduler,
  createSpray,
  fillRockTable,
  fillSeaTable,
  FOAM_CELL,
  FOAM_TOP,
  foamColumns,
  type FoamField,
  HORIZON,
  MAX_SPRAY,
  paletteFor,
  ROCK_COLUMNS,
  ROCK_FLOATS,
  SEA_COLUMNS,
  SEA_FLOATS,
  SPRAY_FLOATS,
  stepSpray,
  WATER_Y,
  writeSpray,
} from "./shore-sim";
import { ROCKS_OPTIONS, shoreMeta } from "./shore.meta";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { defineEffect } from "./types";

const f = glslFloat;

/** Noise texture side. R: lace, G: lace detail and sea glitter, B: rock glints, A: rock tone and sea ripples. */
const NOISE_SIZE = 128;
const NOISE_CHANNELS = [
  { period: 8, seed: 981 },
  { period: 16, seed: 982 },
  { period: 16, seed: 983 },
  { period: 4, seed: 984 },
] as const;
/** Noise tiles per height unit: the foam lace (cells about 0.035 high) and the rock texture. */
const LACE_K = 3.6;
const ROCK_K = 5;
/** Lace drift, noise tiles per second: slowly down, as the foam drains. */
const LACE_DRIFT: readonly [number, number] = [0.0015, 0.012];
/** Sea ripples drift toward the camera, noise tiles per second. */
const RIPPLE_DRIFT = 0.015;
/** Peak foam opacity. */
const FOAM_ALPHA = 0.92;
/** Lit rim along the rock tops: depth (height units) and strength. */
const RIM_DEPTH = 0.012;
const RIM_LEVEL = 0.45;
/** Wet highlight strength. */
const GLINT_LEVEL = 0.35;
/** Index of a rocks select value, for the change key; -1 if unknown. */
function rocksIndex(value: string): number {
  for (let i = 0; i < ROCKS_OPTIONS.length; i++) if (ROCKS_OPTIONS[i].value === value) return i;
  return -1;
}

/** Longest frame step the simulation takes (s): a stalled tab resumes calmly. */
const MAX_STEP = 0.1;

/**
 * Low-res pass: sky, sea, the approaching swells and the surging wave face. y up,
 * height units. Pixels well inside the rocks get a flat colour: the composite
 * paints the rocks over them at full resolution.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

/** Per column: surge above the water line, swell y, swell half-thickness, swell strength. */
uniform sampler2D uSea;
/** Per column: rock height, slope. */
uniform sampler2D uRock;
uniform sampler2D uNoise;
/** Low-res px to height units, x and y. */
uniform vec2 uInvLow;
uniform float uInvAspect;
/** Below the rock top by more than this, the composite covers the pixel. */
uniform float uMargin;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSeaFar;
uniform vec3 uSeaNear;
uniform vec3 uFace;
uniform vec3 uSun;
uniform vec3 uRockColor;
/** Sun glow centre (height units), 1 / size, strength. */
uniform vec4 uSunGlow;
uniform vec2 uRipple;

out vec4 outColor;

const float HORIZON = ${f(HORIZON)};
const float INV_HORIZON = ${f(1 / HORIZON)};
const float INV_SKY = ${f(1 / (1 - HORIZON))};
const float WATER_Y = ${f(WATER_Y)};

void main() {
  vec2 p = gl_FragCoord.xy * uInvLow;
  float u = p.x * uInvAspect;
  float rock = textureLod(uRock, vec2(u, 0.5), 0.0).r;
  if (p.y < rock - uMargin) {
    outColor = vec4(uRockColor, 1.0);
    return;
  }
  vec2 d = (p - uSunGlow.xy) * vec2(0.6, 1.0);
  float glow = uSunGlow.w * exp(-length(d) * uSunGlow.z);
  vec3 col;
  if (p.y >= HORIZON) {
    float h = clamp((p.y - HORIZON) * INV_SKY, 0.0, 1.0);
    col = mix(uSkyHorizon, uSkyTop, sqrt(h)) + uSun * glow;
  } else {
    float depth = HORIZON - p.y;
    float k = clamp(depth * INV_HORIZON, 0.0, 1.0);
    col = mix(uSeaFar, uSeaNear, sqrt(k));
    // Long, low ripples in perspective, faded out where they would alias near the horizon.
    float z = 1.0 / (depth + 0.02);
    vec4 nz = textureLod(uNoise, vec2(p.x * z * 0.04, z * 0.12) + uRipple, 0.0);
    float far = smoothstep(0.015, 0.12, depth);
    col *= 1.0 + 0.16 * (nz.a - 0.5) * far;
    // The sun's path: soft glitter on the water below it.
    float path = exp(-abs(p.x - uSunGlow.x) * (2.5 + 4.0 * k) * uSunGlow.z * 0.25);
    col += uSun * (uSunGlow.w * 0.45 * path * smoothstep(0.5, 0.75, nz.g) * far);
    col += uSun * (glow * 0.35);
    // Haze along the horizon.
    col = mix(col, uSkyHorizon, 0.55 * (1.0 - smoothstep(0.0, 0.035, depth)));

    vec4 s = textureLod(uSea, vec2(u, 0.5), 0.0);
    // An approaching swell: a dark face under a light crest line.
    if (s.a > 0.0) {
      float t = (p.y - s.g) / s.b;
      float crest = exp(-t * t * 5.0);
      float face = smoothstep(-2.6, -0.8, t) * (1.0 - smoothstep(-0.6, 0.15, t));
      col = mix(col, uFace * 0.7, 0.45 * s.a * face);
      col = mix(col, uSkyHorizon, 0.3 * s.a * crest);
    }
    // The surge: a translucent wave face rising over the water line.
    if (s.r > 0.0) {
      float top = WATER_Y + s.r;
      float aa = uInvLow.y;
      float body = (1.0 - smoothstep(top - aa, top + aa, p.y)) * smoothstep(WATER_Y - 0.03, WATER_Y, p.y);
      float lift = clamp((p.y - WATER_Y) / max(s.r, 1e-3), 0.0, 1.0);
      col = mix(col, uFace * (0.75 + 0.5 * lift), 0.85 * body);
    }
  }
  outColor = vec4(col, 1.0);
}
`;

/**
 * Full-res blit: upscales the scene, draws the rocks with an anti-aliased edge,
 * a lit rim and wet highlights, and lays the foam over everything, sharpened
 * into lace by a threshold on noise.
 */
const COMPOSITE = /* glsl */ `
uniform sampler2D uRock;
uniform sampler2D uNoise;
uniform sampler2D uFoam;
/** 1 / canvas height, canvas height (px), 1 / aspect, unused. */
uniform vec4 uPx;
/** Height units to foam texture coordinates. */
uniform vec2 uFoamScale;
uniform vec2 uLaceOff;
uniform vec3 uRockColor;
uniform vec3 uRim;
uniform vec3 uFoamColor;
uniform vec3 uGlint;

const float FOAM_TOP = ${f(FOAM_TOP)};
const float LACE_K = ${f(LACE_K)};
const float ROCK_K = ${f(ROCK_K)};
const float RIM_DEPTH = ${f(RIM_DEPTH)};

vec4 composite(vec2 uv) {
  vec3 c = texture(uLowRes, uv).rgb;
  vec2 p = gl_FragCoord.xy * uPx.x;
  vec2 rk = textureLod(uRock, vec2(p.x * uPx.z, 0.5), 0.0).rg;
  float gap = rk.x - p.y;
  // Signed distance to the edge through a one-pixel ramp; the slope keeps steep sides smooth.
  float cover = clamp(gap * uPx.y / sqrt(1.0 + rk.y * rk.y) + 0.5, 0.0, 1.0);
  vec2 fw = p.y < FOAM_TOP ? texture(uFoam, p * uFoamScale).rg : vec2(0.0);
  if (cover > 0.0) {
    vec4 n = textureLod(uNoise, p * ROCK_K, 0.0);
    vec3 rock = uRockColor * (0.7 + 0.6 * n.a);
    rock *= mix(0.55, 1.0, smoothstep(0.0, 0.3, p.y));
    float rim = 1.0 - smoothstep(0.0, RIM_DEPTH, gap);
    rock = mix(rock, uRim, rim * ${f(RIM_LEVEL)});
    rock *= 1.0 - 0.3 * fw.g;
    float glint = smoothstep(0.66, 0.82, n.b) * (0.2 + 0.8 * fw.g) * (0.5 + 0.5 * rim);
    rock += uGlint * (glint * ${f(GLINT_LEVEL)});
    c = mix(c, rock, cover);
  }
  if (fw.r > 0.004) {
    vec2 ln = textureLod(uNoise, p * LACE_K + uLaceOff, 0.0).rg;
    // High along the noise's mid-level lines: a web that survives as the foam thins.
    float web = 1.0 - smoothstep(0.0, 0.18, abs(ln.x - 0.5));
    float m = fw.r * (0.55 + 0.9 * web) + 0.25 * (ln.y - 0.5);
    float a = smoothstep(0.3, 0.42, m) * ${f(FOAM_ALPHA)} + 0.15 * fw.r;
    c = mix(c, uFoamColor * (0.82 + 0.18 * fw.r), clamp(a, 0.0, 1.0));
  }
  return vec4(c, 1.0);
}
`;

/** Spray droplets: soft round sprites. */
const SPRAY_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (px, y up), radius (px), alpha. */
layout(location = 1) in vec4 aDrop;
uniform vec2 uInvRes;
out vec2 vLocal;
out float vAlpha;
void main() {
  vLocal = aCorner;
  vAlpha = aDrop.w;
  vec2 px = aDrop.xy + aCorner * aDrop.z;
  gl_Position = vec4(px * uInvRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPRAY_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
in float vAlpha;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float r2 = dot(vLocal, vLocal);
  outColor = vec4(uColor, vAlpha * (1.0 - smoothstep(0.0, 1.0, r2)));
}
`;

/**
 * Waves rolling slowly onto a rocky shore, seen from the side at a low angle.
 * Each swell rises, breaks into foam over the dark rocks with a soft burst of
 * spray, and drains back between them in lacy streams. The sky and sea render
 * at reduced resolution; the rocks and the foam (a low-res density field on the
 * CPU, sharpened by a threshold on noise) are drawn at full resolution in the
 * blit, and the spray is a small sprite batch.
 */
export const shore = defineEffect(shoreMeta, {
  create(gl) {
    return withScope((scope) => {
      const scene = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SCENE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const sprayProgram = scope.add(createProgram(gl, SPRAY_VERTEX, SPRAY_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const rockTable = scope.own(createColumnTable(gl, ROCK_COLUMNS, ROCK_FLOATS));
      const seaTable = scope.own(createColumnTable(gl, SEA_COLUMNS, SEA_FLOATS));
      const noiseTexture = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, NOISE_CHANNELS),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const drops = scope.own(createSpriteBatch(gl, MAX_SPRAY, [SPRAY_FLOATS], [polygonStrip(8)]));

      /** Rebuilt when the frame's aspect changes the column count. */
      let foam: FoamField = createFoamField(16 / 9);
      let foamTexture: WebGLTexture | null = null;
      scope.defer(() => {
        if (foamTexture) gl.deleteTexture(foamTexture);
      });
      const makeFoamTexture = (): WebGLTexture => {
        if (foamTexture) gl.deleteTexture(foamTexture);
        return (foamTexture = createDataTexture(gl, {
          width: foam.columns,
          height: foam.rows,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: foam.bytes,
        }));
      };

      const u = createUniforms(gl, scene, [
        "uSea",
        "uRock",
        "uNoise",
        "uInvLow",
        "uInvAspect",
        "uMargin",
        "uSkyTop",
        "uSkyHorizon",
        "uSeaFar",
        "uSeaNear",
        "uFace",
        "uSun",
        "uRockColor",
        "uSunGlow",
        "uRipple",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uRock",
        "uNoise",
        "uFoam",
        "uPx",
        "uFoamScale",
        "uLaceOff",
        "uRockColor",
        "uRim",
        "uFoamColor",
        "uGlint",
      ]);
      const su = createUniforms(gl, sprayProgram, ["uInvRes", "uColor"]);
      gl.useProgram(scene);
      u.i1("uSea", 0);
      u.i1("uRock", 1);
      u.i1("uNoise", 2);
      gl.useProgram(target.program);
      cu.i1("uRock", 1);
      cu.i1("uNoise", 2);
      cu.i1("uFoam", 3);
      gl.useProgram(null);

      const sched = createShoreScheduler(0);
      const spray = createSpray();
      let rand = createRng(0);
      /** Seed the scheduler was last reset with; NaN until the first frame. */
      let seed = Number.NaN;
      const sizeKey = createChangeKey(3);
      const rockKey = createChangeKey(3);
      let rippleV = 0;
      let laceU = 0;
      let laceV = 0;

      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = clamp(dt, 0, MAX_STEP);
          const aspect = width / height;
          const divisor = qualityDivisor(p.quality);
          sizeKey.set(0, width);
          sizeKey.set(1, height);
          sizeKey.set(2, divisor);
          if (sizeKey.take()) target.resize(width, height, divisor);

          if (p.seed !== seed) {
            seed = p.seed;
            sched.reset(seed);
            rand = createRng(seed * 31 + 7);
            spray.count = 0;
            foam.density.fill(0);
            foam.wet.fill(0);
          }

          // Texture uploads below leave their texture bound to the active unit.
          let foamTex = foamTexture;
          if (!foamTex || foamColumns(aspect) !== foam.columns) {
            foam = createFoamField(aspect);
            foamTex = makeFoamTexture();
          }
          gl.activeTexture(gl.TEXTURE1);
          rockKey.set(0, aspect);
          rockKey.set(1, rocksIndex(p.rocks));
          rockKey.set(2, p.seed);
          if (rockKey.take()) {
            fillRockTable(rockTable.data, aspect, p.rocks, p.seed);
            rockTable.upload();
          } else {
            gl.bindTexture(gl.TEXTURE_2D, rockTable.texture);
          }

          const swell = clamp(p.swell, 0, 1);
          sched.step(step, p.period);
          gl.activeTexture(gl.TEXTURE3);
          if (advanceFoam(foam, sched, rockTable.data, aspect, swell, step)) {
            updateDataTexture(
              gl,
              foamTex,
              foam.columns,
              foam.rows,
              gl.RG,
              gl.UNSIGNED_BYTE,
              foam.bytes,
            );
          } else {
            gl.bindTexture(gl.TEXTURE_2D, foamTex);
          }
          stepSpray(spray, sched, rockTable.data, aspect, swell, step, rand);

          gl.activeTexture(gl.TEXTURE0);
          fillSeaTable(sched, aspect, swell, seaTable.data);
          seaTable.upload();
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          gl.activeTexture(gl.TEXTURE0);

          rippleV = wrap(rippleV + step * RIPPLE_DRIFT, 0, 1);
          laceU = wrap(laceU + step * LACE_DRIFT[0], 0, 1);
          laceV = wrap(laceV + step * LACE_DRIFT[1], 0, 1);

          const pal = paletteFor(p.sky);
          gl.useProgram(scene);
          u.f2("uInvLow", aspect / target.width, 1 / target.height);
          u.f1("uInvAspect", 1 / aspect);
          u.f1("uMargin", 2.5 / target.height);
          u.v3("uSkyTop", pal.skyTop);
          u.v3("uSkyHorizon", pal.skyHorizon);
          u.v3("uSeaFar", pal.seaFar);
          u.v3("uSeaNear", pal.seaNear);
          u.v3("uFace", pal.face);
          u.v3("uSun", pal.sun);
          u.v3("uRockColor", pal.rock);
          u.f4("uSunGlow", pal.sunX * aspect, pal.sunY, 1 / pal.sunSize, pal.sunStrength);
          u.f2("uRipple", 0, rippleV);
          target.bind();
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          gl.useProgram(target.program);
          cu.f4("uPx", 1 / height, height, 1 / aspect, 0);
          cu.f2("uFoamScale", 1 / (foam.columns * FOAM_CELL), 1 / (foam.rows * FOAM_CELL));
          cu.f2("uLaceOff", laceU, laceV);
          cu.v3("uRockColor", pal.rock);
          cu.v3("uRim", pal.rim);
          cu.v3("uFoamColor", pal.foam);
          cu.v3("uGlint", pal.glint);
          target.blit();

          const count = writeSpray(spray, drops.data, height, scale);
          if (count === 0) return;
          drops.upload(count);
          gl.useProgram(sprayProgram);
          su.f2("uInvRes", 1 / width, 1 / height);
          su.v3("uColor", pal.foam);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          drops.draw(0, count);
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
