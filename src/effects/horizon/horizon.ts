import { hexToUnitRgb, type Rgb } from "../color";
import { createChangeKey } from "../change-key";
import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import {
  arcPosition,
  BACK_BASE,
  buildHills,
  createDayClock,
  createSkyState,
  HILL_COLUMNS,
  type HillShape,
  layerDepth,
  localDayPhase,
  lunarPhase,
  moonTerminator,
  nightAmount,
  placeTrees,
  sampleSky,
  type TimeMode,
  TREE_FLOATS,
} from "./horizon-sim";
import { clamp, smoothstep, wrap } from "../math";
import { createRng } from "../noise";
import { createSpriteBatch, polygonStrip, QUAD } from "../sprites";
import { horizonMeta, MAX_LAYERS, MIN_LAYERS } from "./horizon.meta";
import { defineEffect } from "../types";

/** Height of the sun and moon arcs above the horizon at their peak, as a fraction of the height. */
const ARC_HEIGHT = 0.48;
/** Sun and moon radii, as fractions of the height. */
const SUN_RADIUS = 0.032;
const MOON_RADIUS = 0.024;
/** Moon sprite extent (where its halo reaches zero), in moon radii. */
const MOON_EXTENT = 3;
const STAR_COUNT = 240;
/** Shader period of the star twinkle, in seconds: every star's rate is a whole number of cycles per period. */
const TWINKLE_PERIOD = 600;
const MAX_CLOUDS = 8;
const MAX_TREES = 48;
/** Pixels the hill strips reach below the next layer's lowest point, so no gap opens between them. */
const STRIP_OVERLAP = 2;
/** Steps per unit colours are rounded to before upload: finer than 8 bits, so slow drifts rarely upload. */
const COLOR_STEPS = 1024;
const TAU = Math.PI * 2;

const PALETTE_IDS = ["meadow", "desert", "mountains", "coast"] as const;

/** The clock mode for a select value; any other value steps like "fixed". */
const toTimeMode = (value: string): TimeMode =>
  value === "local" || value === "cycle" ? value : "fixed";

const quant = (v: number) => Math.round(v * COLOR_STEPS) / COLOR_STEPS;

interface Palette {
  /** Daylight colours of the back and front layers; layers between are mixed. */
  back: Rgb;
  front: Rgb;
  shape: HillShape;
  trees: boolean;
}

const PALETTES: Record<string, Palette> = {
  meadow: {
    back: hexToUnitRgb("#7ea676"),
    front: hexToUnitRgb("#2c5a26"),
    shape: { amp: 1, ridge: 0, freq: 1 },
    trees: true,
  },
  desert: {
    back: hexToUnitRgb("#e0b07c"),
    front: hexToUnitRgb("#9c5228"),
    shape: { amp: 0.85, ridge: 0.35, freq: 0.8 },
    trees: false,
  },
  mountains: {
    back: hexToUnitRgb("#8592ad"),
    front: hexToUnitRgb("#28372f"),
    shape: { amp: 1.9, ridge: 0.8, freq: 1.3 },
    trees: true,
  },
  coast: {
    back: hexToUnitRgb("#86b0aa"),
    front: hexToUnitRgb("#3a6a4c"),
    shape: { amp: 0.7, ridge: 0, freq: 0.7 },
    trees: true,
  },
};

const SUN_LOW = hexToUnitRgb("#ff7a30");
const SUN_HIGH = hexToUnitRgb("#fff4dc");
const MOON_COLOR = hexToUnitRgb("#f2efe2");
const STAR_COLOR = hexToUnitRgb("#e4eaff");

/**
 * Sky: horizon-to-zenith gradient, an analytic two-term sun glow (a tight core and
 * a wide warm wash that hugs the horizon), the sun disc, and sub-LSB dither.
 * Drawn only over the rows above the back hills' lowest point.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunColor;
/** Sun centre x, y (px, y up), radius (px) and glow strength. */
uniform vec4 uSun;
/** Horizon y (px), 1 / (height - horizon y), 1 / height. */
uniform vec3 uSky;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy;
  float t = clamp((p.y - uSky.x) * uSky.y, 0.0, 1.0);
  t = t * (2.0 - t);
  vec3 col = mix(uHorizon, uZenith, t);
  float dist = length(p - uSun.xy);
  float d = dist * uSky.z;
  float glow = uSun.w * (0.5 * exp2(-9.0 * d) + 0.5 * exp2(-2.2 * d) * (1.0 - 0.7 * t));
  col = mix(col, uGlow, min(glow, 1.0));
  col = mix(col, uSunColor, clamp(uSun.z - dist + 0.5, 0.0, 1.0));
  outColor = vec4(col + dither8(p), 1.0);
}
`;

/** Stars: static instances; the twinkle is a slow sine of the wrapped time in the vertex shader. */
const STAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x, y (fractions of the canvas, y up), extent radius (px at 1080), brightness. */
layout(location = 1) in vec4 aStar;
/** Twinkle rate (radians per second) and phase. */
layout(location = 2) in vec2 aTwinkle;
uniform vec2 uResolution;
uniform float uScale;
uniform float uTime;
uniform float uAlpha;
out vec2 vLocal;
flat out float vBright;
void main() {
  vBright = aStar.w * uAlpha * (0.8 + 0.2 * sin(uTime * aTwinkle.x + aTwinkle.y));
  vLocal = aCorner;
  vec2 px = aStar.xy * uResolution + aCorner * (aStar.z * uScale);
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const STAR_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in float vBright;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float t = max(1.0 - dot(vLocal, vLocal), 0.0);
  outColor = vec4(uColor * (vBright * t * t), 0.0);
}
`;

/** The moon: one sprite, analytic disc, phase terminator and a faint halo, premultiplied. */
const MOON_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (px, y up), radius (px), unused. */
layout(location = 1) in vec4 aMoon;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vRadius;
void main() {
  vLocal = aCorner * ${glslFloat(MOON_EXTENT)};
  vRadius = aMoon.z;
  vec2 px = aMoon.xy + vLocal * aMoon.z;
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const MOON_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vRadius;
uniform vec3 uColor;
/** Terminator k, lit side (+1 right, -1 left), opacity, halo strength. */
uniform vec4 uMoon;
out vec4 outColor;
void main() {
  float r = length(vLocal);
  float disc = clamp((1.0 - r) * vRadius + 0.5, 0.0, 1.0);
  float edge = uMoon.x * sqrt(max(1.0 - vLocal.y * vLocal.y, 0.0));
  float lit = smoothstep(edge - 0.06, edge + 0.06, vLocal.x * uMoon.y) * disc;
  // Two soft, faint maria.
  float maria = 1.0 - 0.13 * (1.0 - smoothstep(0.0, 0.45, length(vLocal - vec2(-0.25, 0.2))))
    - 0.09 * (1.0 - smoothstep(0.0, 0.35, length(vLocal - vec2(0.3, -0.3))));
  float halo = uMoon.w * exp2(-4.0 * max(r - 1.0, 0.0)) * (1.0 - disc);
  outColor = vec4(uColor * (lit * maria + halo) * uMoon.z, lit * uMoon.z);
}
`;

/** Clouds: soft, wide elliptical bands, lit on top and shaded below, premultiplied. */
const CLOUD_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (px, y up), radii x, y (px). */
layout(location = 1) in vec4 aCloud;
/** Opacity, shape seed. */
layout(location = 2) in vec2 aLook;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec2 vLook;
void main() {
  vLocal = aCorner;
  vLook = aLook;
  vec2 px = aCloud.xy + aCorner * aCloud.zw;
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const CLOUD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vLook;
uniform vec3 uLit;
uniform vec3 uShade;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float body = max(1.0 - dot(vLocal, vLocal), 0.0);
  float lumps = 0.8 + 0.2 * sin(vLocal.x * 9.0 + vLook.y) * sin(vLocal.x * 4.0 - vLook.y * 1.7);
  float a = body * body * lumps * vLook.x;
  vec3 c = mix(uShade, uLit, clamp(vLocal.y * 0.5 + 0.6, 0.0, 1.0));
  outColor = vec4((c + dither8(gl_FragCoord.xy)) * a, a);
}
`;

/**
 * Hills: one instanced triangle strip, an instance per layer, back first, so the
 * nearer layers paint over the farther ones. Each column's top vertex sits on the
 * profile (read from the column table), 1.5 px higher for the anti-aliased edge;
 * the bottom vertex sits just below the next layer's lowest point, since that
 * layer hides everything beneath it. No vertex attributes: gl_VertexID picks the
 * column and the top or bottom.
 */
const HILL_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uHeights;
uniform vec2 uResolution;
uniform vec3 uColors[${String(MAX_LAYERS)}];
/** Bottom of each layer's strip, px (y up). */
uniform float uBottoms[${String(MAX_LAYERS)}];
out float vEdge;
flat out vec3 vColor;
void main() {
  int layer = gl_InstanceID;
  int col = gl_VertexID >> 1;
  float h = texelFetch(uHeights, ivec2(col, layer), 0).r * uResolution.y;
  float x = float(col) / ${glslFloat(HILL_COLUMNS - 1)} * uResolution.x;
  float y = (gl_VertexID & 1) == 1 ? h + 1.5 : uBottoms[layer];
  vEdge = h;
  vColor = uColors[layer];
  gl_Position = vec4(vec2(x, y) / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HILL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vEdge;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  // Distance below the edge in px, made perpendicular to it by the screen-space gradient.
  float d = vEdge - gl_FragCoord.y;
  float g = length(vec2(dFdx(d), dFdy(d)));
  outColor = vec4(vColor, clamp(d / max(g, 0.001) + 0.5, 0.0, 1.0));
}
`;

/** Trees: small conifer triangles planted in the front ridge, in its colour, edge anti-aliased. */
const TREE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x, base y (fractions of the canvas, y up), height, half-width (px at 1080). */
layout(location = 1) in vec4 aTree;
uniform vec2 uResolution;
uniform float uScale;
out vec2 vLocal;
void main() {
  vec2 size = vec2(aTree.w, 0.5 * aTree.z) * uScale;
  // Sunk 30% into the ridge, so slopes never show the base.
  vec2 centre = vec2(aTree.x * uResolution.x, aTree.y * uResolution.y + size.y * 0.4);
  vec2 px = centre + aCorner * (size + 1.5);
  vLocal = (px - centre) / size;
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const TREE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  // Inside the triangle (-1,-1), (1,-1), (0,1) where both slanted edge functions are positive.
  float e = min(2.0 * vLocal.x - vLocal.y + 1.0, -2.0 * vLocal.x - vLocal.y + 1.0);
  float g = length(vec2(dFdx(e), dFdy(e)));
  outColor = vec4(uColor, clamp(e / max(g, 0.0001) + 0.5, 0.0, 1.0));
}
`;

/**
 * A stylised landscape of silhouetted hill layers under a sky that follows the
 * time of day, from dawn through day and sunset to a starry night with a moon.
 */
export const horizon = defineEffect(horizonMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const starProgram = program(STAR_VERTEX, STAR_FRAGMENT);
      const moonProgram = program(MOON_VERTEX, MOON_FRAGMENT);
      const cloudProgram = program(CLOUD_VERTEX, CLOUD_FRAGMENT);
      const hillProgram = program(HILL_VERTEX, HILL_FRAGMENT);
      const treeProgram = program(TREE_VERTEX, TREE_FRAGMENT);
      const skyU = createUniforms(gl, skyProgram, [
        "uZenith",
        "uHorizon",
        "uGlow",
        "uSunColor",
        "uSun",
        "uSky",
      ]);
      const starU = createUniforms(gl, starProgram, [
        "uResolution",
        "uScale",
        "uTime",
        "uAlpha",
        "uColor",
      ]);
      const moonU = createUniforms(gl, moonProgram, ["uResolution", "uColor", "uMoon"]);
      const cloudU = createUniforms(gl, cloudProgram, ["uResolution", "uLit", "uShade"]);
      const hillU = createUniforms(gl, hillProgram, [
        "uHeights",
        "uResolution",
        "uColors",
        "uBottoms",
      ]);
      const treeU = createUniforms(gl, treeProgram, ["uResolution", "uScale", "uColor"]);

      const triangle = scope.own(createFullscreenTriangle(gl));
      /** The hill strip has no attributes, but draws with a VAO of its own bound. */
      const hillVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const hills = scope.own(createColumnTable(gl, HILL_COLUMNS, 1, { rows: MAX_LAYERS }));
      const stars = scope.own(createSpriteBatch(gl, STAR_COUNT, [4, 2], [QUAD]));
      const moonSprite = scope.own(createSpriteBatch(gl, 1, [4], [QUAD]));
      const cloudBatch = scope.own(
        createSpriteBatch(gl, MAX_CLOUDS, [4, 2], [polygonStrip(8, Math.PI / 8)]),
      );
      const treeBatch = scope.own(createSpriteBatch(gl, MAX_TREES, [TREE_FLOATS], [QUAD]));

      gl.useProgram(hillProgram);
      hillU.i1("uHeights", 0);
      gl.useProgram(moonProgram);
      moonU.v3("uColor", MOON_COLOR);
      gl.useProgram(starProgram);
      starU.v3("uColor", STAR_COLOR);
      gl.useProgram(null);

      // Stars never move, so their instances are uploaded once.
      {
        const rand = createRng(20341);
        const d = stars.data;
        for (let i = 0; i < STAR_COUNT; i++) {
          const o = i * stars.stride;
          const v = 1 - (1 - BACK_BASE) * rand() ** 1.3;
          const bright = (0.25 + 0.75 * rand() ** 3) * smoothstep(BACK_BASE, BACK_BASE + 0.2, v);
          d[o] = rand();
          d[o + 1] = v;
          d[o + 2] = 2.2 + 2 * bright;
          d[o + 3] = bright;
          d[o + 4] = (TAU * (6 + Math.floor(rand() * 25))) / TWINKLE_PERIOD;
          d[o + 5] = rand() * TAU;
        }
        stars.upload(STAR_COUNT);
      }

      // Clouds: fixed shapes and heights; only their x drifts (reference px, 1080 tall).
      const cloudX = new Float64Array(MAX_CLOUDS);
      const cloudY = new Float64Array(MAX_CLOUDS);
      const cloudRx = new Float64Array(MAX_CLOUDS);
      const cloudRy = new Float64Array(MAX_CLOUDS);
      const cloudSpeed = new Float64Array(MAX_CLOUDS);
      const cloudSeed = new Float64Array(MAX_CLOUDS);
      {
        const rand = createRng(8117);
        for (let i = 0; i < MAX_CLOUDS; i++) {
          cloudX[i] = rand() * 1920;
          cloudY[i] = 0.62 + rand() * 0.3;
          cloudRx[i] = 360 + rand() * 380;
          cloudRy[i] = 26 + rand() * 30;
          cloudSpeed[i] = 3 + rand() * 5;
          cloudSeed[i] = rand() * 100;
        }
      }

      const clock = createDayClock(() => localDayPhase(new Date()), localDayPhase(new Date()));
      const sky = createSkyState();
      const sun = { x: 0.5, elevation: 0 };
      const moon = { x: 0.5, elevation: 0 };
      const terminator = { k: -1, side: 1, lit: 1 };
      const profiles = hills.data;
      const hillMin = new Float64Array(MAX_LAYERS);
      const hillMax = new Float64Array(MAX_LAYERS);
      const hillInputs = createChangeKey(3);
      let treeCount = 0;
      let layerCount = MIN_LAYERS;
      /** Per-layer uniform arrays, and their last uploaded values. */
      const colors = new Float32Array(MAX_LAYERS * 3);
      const bottoms = new Float32Array(MAX_LAYERS);
      const sentColors = new Float32Array(MAX_LAYERS * 3).fill(Number.NaN);
      const sentBottoms = new Float32Array(MAX_LAYERS).fill(Number.NaN);
      const sunColor: Rgb = [0, 0, 0];
      const cloudLit: Rgb = [0, 0, 0];
      const cloudShade: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      /** Twinkle time, wrapped to the shader's period. */
      let twinkle = 0;
      /** Seconds until the lunar phase is next read from the date; it changes slowly. */
      let lunarTimer = 0;
      let lunar = 0.5;

      /** Copies `src` into `sent` and returns true if any value differs. */
      const changedArray = (src: Float32Array, sent: Float32Array) => {
        let changed = false;
        for (let i = 0; i < src.length; i++) {
          if (src[i] !== sent[i]) {
            sent[i] = src[i];
            changed = true;
          }
        }
        return changed;
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          const k = newRefWidth / refWidth;
          for (let i = 0; i < MAX_CLOUDS; i++) {
            cloudX[i] *= k;
          }
          ({ width, height, scale } = v);
          refWidth = newRefWidth;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const palette = PALETTES[p.palette] ?? PALETTES.meadow;
          const phase = clock.step(dt, toTimeMode(p.time), p.cycleMins, p.hour);
          twinkle = (twinkle + dt) % TWINKLE_PERIOD;
          lunarTimer -= dt;
          if (lunarTimer <= 0) {
            lunarTimer = 60;
            lunar = lunarPhase(Date.now());
          }

          // Hill profiles and trees: rebuilt only when their inputs change.
          hillInputs.set(0, clamp(Math.round(p.layers), MIN_LAYERS, MAX_LAYERS));
          hillInputs.set(1, Math.floor(p.seed));
          hillInputs.set(2, (PALETTE_IDS as readonly string[]).indexOf(p.palette));
          if (hillInputs.take()) {
            layerCount = clamp(Math.round(p.layers), MIN_LAYERS, MAX_LAYERS);
            buildHills(profiles, layerCount, p.seed, palette.shape, hillMin, hillMax);
            gl.activeTexture(gl.TEXTURE0);
            hills.upload();
            treeCount = placeTrees(treeBatch.data, MAX_TREES, profiles, layerCount - 1, p.seed);
            treeBatch.upload(treeCount);
          }

          // Sky colours, sun and moon.
          sampleSky(phase, sky);
          arcPosition(phase, false, sun);
          arcPosition(phase, true, moon);
          const night = nightAmount(sun.elevation);
          const day = 1 - night;
          const horizonPx = BACK_BASE * height;
          const skyBottom = clamp(Math.floor(hillMin[0] * height - STRIP_OVERLAP), 0, height);
          const sunMix = smoothstep(0, 0.4, sun.elevation);
          for (let c = 0; c < 3; c++) {
            sunColor[c] = quant(SUN_LOW[c] + (SUN_HIGH[c] - SUN_LOW[c]) * sunMix);
            const lit = Math.min(
              1,
              sky.zenith[c] +
                (1 - sky.zenith[c]) * (0.55 * day + 0.08) +
                0.3 * sky.glow[c] * sky.glowStrength,
            );
            cloudLit[c] = quant(lit);
            cloudShade[c] = quant(lit + (sky.zenith[c] - lit) * 0.45);
          }

          // Hill layer colours: daylight colour times the light, hazed towards the horizon sky.
          for (let l = 0; l < layerCount; l++) {
            const depth = layerDepth(l, layerCount);
            const haze = 0.6 * (1 - depth) ** 1.3;
            for (let c = 0; c < 3; c++) {
              const base = palette.back[c] + (palette.front[c] - palette.back[c]) * depth;
              const lit = base * sky.light[c];
              colors[l * 3 + c] = quant(lit + (sky.horizon[c] - lit) * haze);
            }
            bottoms[l] =
              l + 1 < layerCount ? Math.floor(hillMin[l + 1] * height - STRIP_OVERLAP) : -1;
          }

          // 1. Sky, over the rows the hills can leave uncovered.
          gl.viewport(0, skyBottom, width, height - skyBottom);
          gl.useProgram(skyProgram);
          skyU.f3("uZenith", quant(sky.zenith[0]), quant(sky.zenith[1]), quant(sky.zenith[2]));
          skyU.f3("uHorizon", quant(sky.horizon[0]), quant(sky.horizon[1]), quant(sky.horizon[2]));
          skyU.f3("uGlow", quant(sky.glow[0]), quant(sky.glow[1]), quant(sky.glow[2]));
          skyU.v3("uSunColor", sunColor);
          const sunR = SUN_RADIUS * height;
          skyU.f4(
            "uSun",
            Math.round(sun.x * width * 8) / 8,
            Math.round((horizonPx + sun.elevation * ARC_HEIGHT * height) * 8) / 8,
            sunR,
            quant(sky.glowStrength),
          );
          skyU.f3("uSky", horizonPx, 1 / Math.max(1, height - horizonPx), 1 / height);
          triangle.draw();
          gl.viewport(0, 0, width, height);

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);

          // 2. Stars, faded in with the night.
          const starAlpha = p.stars ? quant(night) : 0;
          if (starAlpha > 0) {
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(starProgram);
            starU.f2("uResolution", width, height);
            starU.f1("uScale", scale);
            starU.f1("uTime", twinkle);
            starU.f1("uAlpha", starAlpha);
            stars.draw(0, STAR_COUNT);
          }

          // 3. Moon, whenever it is above the sky's lowest row.
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          const moonR = MOON_RADIUS * height;
          const moonY = horizonPx + moon.elevation * ARC_HEIGHT * height;
          const moonAlpha = p.moon === "off" ? 0 : quant(0.35 + 0.65 * night);
          if (moonAlpha > 0 && moonY + moonR * MOON_EXTENT > skyBottom) {
            moonTerminator(p.moon === "full" ? 0.5 : lunar, terminator);
            const md = moonSprite.data;
            md[0] = Math.round(moon.x * width * 8) / 8;
            md[1] = Math.round(moonY * 8) / 8;
            md[2] = moonR;
            moonSprite.upload(1);
            gl.useProgram(moonProgram);
            moonU.f2("uResolution", width, height);
            moonU.f4(
              "uMoon",
              terminator.k,
              terminator.side,
              moonAlpha,
              quant(0.15 * terminator.lit * night),
            );
            moonSprite.draw(0, 1);
          }

          // 4. Clouds drifting slowly right, the last one fading with the slider.
          const cloudAmount = clamp(p.clouds, 0, 1) * MAX_CLOUDS;
          const nClouds = Math.ceil(cloudAmount);
          for (let i = 0; i < MAX_CLOUDS; i++) {
            cloudX[i] = wrap(
              cloudX[i] + cloudSpeed[i] * dt,
              -cloudRx[i],
              refWidth + 2 * cloudRx[i],
            );
          }
          if (nClouds > 0) {
            const cd = cloudBatch.data;
            const cs = cloudBatch.stride;
            for (let i = 0; i < nClouds; i++) {
              const o = i * cs;
              cd[o] = cloudX[i] * scale;
              cd[o + 1] = cloudY[i] * height;
              cd[o + 2] = cloudRx[i] * scale;
              cd[o + 3] = cloudRy[i] * scale;
              cd[o + 4] = 0.6 * clamp(cloudAmount - i, 0, 1);
              cd[o + 5] = cloudSeed[i];
            }
            cloudBatch.upload(nClouds);
            gl.useProgram(cloudProgram);
            cloudU.f2("uResolution", width, height);
            cloudU.v3("uLit", cloudLit);
            cloudU.v3("uShade", cloudShade);
            cloudBatch.draw(0, nClouds);
          }

          // 5. Hills, back to front in one instanced strip.
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(hillProgram);
          hillU.f2("uResolution", width, height);
          if (changedArray(colors, sentColors)) {
            gl.uniform3fv(hillU.loc.uColors, sentColors);
          }
          if (changedArray(bottoms, sentBottoms)) {
            gl.uniform1fv(hillU.loc.uBottoms, sentBottoms);
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, hills.texture);
          gl.bindVertexArray(hillVao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, HILL_COLUMNS * 2, layerCount);
          gl.bindVertexArray(null);

          // 6. Trees on the nearest ridge, in its colour.
          if (p.trees && palette.trees && treeCount > 0) {
            gl.useProgram(treeProgram);
            treeU.f2("uResolution", width, height);
            treeU.f1("uScale", scale);
            const f = (layerCount - 1) * 3;
            treeU.f3("uColor", colors[f], colors[f + 1], colors[f + 2]);
            treeBatch.draw(0, treeCount);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
