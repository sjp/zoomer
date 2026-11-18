import { createColorEase, hexesToUnitRgb } from "../color";
import { GLYPH_H, glyphRows } from "../dot-matrix";
import { createCrossfadeSlots } from "../fade";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  scopedProgram,
  TO_CLIP_GLSL,
  type Uniforms,
  updateDataTexture,
  withScope,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { buildPeriodicNoiseTexture } from "../noise";
import { createSpriteBatch } from "../sprites";
import { createTextLayer, setTextPalette, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import { MAX_PIXEL, MIN_PIXEL, roadRacerMeta } from "./roadracer.meta";
import {
  BACKDROP_WIDTH,
  buildBackdrop,
  buildSpriteAtlas,
  type CourseLook,
  COURSES,
  SCENE_COLOURS,
} from "./roadracer-art";
import { buildScene, createScene, MAX_SPRITES, type SceneInput, STRIDE } from "./roadracer-scene";
import {
  BAND,
  buildCourse,
  cameraHeight,
  carDistance,
  CLOUD_WIND,
  type Course,
  createDrive,
  createRoadFrame,
  formatLapTime,
  HORIZON,
  LAP,
  LAYER_PERIOD,
  laneBlocked,
  PARALLAX,
  panRate,
  projectRoad,
  RUMBLE,
  ROAD_HALF,
  sampleLoop,
  SEA_X,
  SEGMENTS,
  speedKmh,
  stepDrive,
  trafficAt,
  type TrafficState,
  viewScale,
  WINDOW_WIDTH,
} from "./roadracer-sim";

/** Seconds a course, seed or pixel-size change crossfades over. */
export const CROSSFADE = 1.5;
/** Seconds the HUD fades in or out, and its colours ease. */
const HUD_FADE = 0.6;
/** Side of the shade swatch in the HUD canvas, px. */
const PANEL = 4;
/** Most low-res rows the row table holds. */
const MAX_ROWS = 1200;
/** Colours the road shader takes from the course. */
const COLOURS = SCENE_COLOURS.length;

/**
 * The road, verges, sea and sky in one pass over the low-res frame. Each row
 * reads its nearest visible ground from the row table (road centre and width,
 * position along the road, depth, stripe contrast, fog); rows with no ground
 * show the sky, clouds and two panning background layers.
 */
const ROAD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uRows;
uniform sampler2D uBackdrop;
uniform sampler2D uClouds;
uniform vec2 uSize;
uniform vec3 uPal[${String(COLOURS)}];
/** Sun centre (frame heights from the centre and the horizon) and radius. */
uniform vec3 uSun;
/** Far layer, near layer and cloud offsets, frame heights. */
uniform vec3 uPan;
/** Night (skyline, windows, stars), sea on the left, cloud cover. */
uniform vec3 uMode;
out vec4 outColor;

const float HORIZON = ${glslFloat(HORIZON)};
const float ROAD_HALF = ${glslFloat(ROAD_HALF)};
const float EDGE = ${glslFloat(ROAD_HALF + RUMBLE)};
const float BAND = ${glslFloat(BAND)};
const float SEA_X = ${glslFloat(SEA_X)};
const float FAR_PERIOD = ${glslFloat(LAYER_PERIOD.far)};
const float NEAR_PERIOD = ${glslFloat(LAYER_PERIOD.near)};
const float CLOUD_PERIOD = ${glslFloat(LAYER_PERIOD.clouds)};
const float WIN_FAR = ${glslFloat(WINDOW_WIDTH.far)};
const float WIN_NEAR = ${glslFloat(WINDOW_WIDTH.near)};
const int BACKDROP = ${String(BACKDROP_WIDTH)};

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/** A 2x2 ordered dither, 0..0.75. */
float bayer(vec2 p) {
  ivec2 i = ivec2(p) & 1;
  return float((i.x * 2 + i.y * 3) & 3) * 0.25;
}

/** Light or dark band at road position s, with the contrast c (0 blurs it to their mean). */
vec3 banded(vec3 a, vec3 b, float s, float c) {
  float odd = mod(floor(s / BAND), 2.0);
  return mix(mix(a, b, 0.5), odd < 0.5 ? a : b, c);
}

vec3 ground(float xh, vec4 a, float contrast) {
  float x = (xh - a.x) / a.y * ROAD_HALF;
  float ax = abs(x);
  float s = a.z;
  float odd = mod(floor(s / BAND), 2.0);
  vec3 col;
  if (ax < ROAD_HALF) {
    col = banded(uPal[12], uPal[13], s, contrast);
    if (ax > ROAD_HALF - 0.13 && ax < ROAD_HALF - 0.06) {
      col = uPal[16];
    }
    if (ax < 0.045) {
      col = mix(col, uPal[16], mix(0.5, odd < 0.5 ? 1.0 : 0.0, contrast));
    }
    if (s < 0.6) {
      float check = mod(floor(x / 0.35) + floor(s / 0.3), 2.0);
      col = mix(vec3(0.5), check < 0.5 ? vec3(0.95) : vec3(0.08), contrast);
    }
  } else if (ax < EDGE) {
    col = banded(uPal[14], uPal[15], s, contrast);
  } else if (x < 0.0 && uMode.y > 0.5) {
    if (x < -SEA_X) {
      col = mix(uPal[21], uPal[22], smoothstep(4.0, 45.0, a.w));
    } else if (x < -SEA_X + 0.14) {
      col = uPal[5];
    } else {
      col = banded(uPal[19], uPal[20], s, contrast);
    }
  } else {
    col = banded(uPal[17], uPal[18], s, contrast);
  }
  return col;
}

/** Lit windows on a skyline at layer position u (frame heights), cell width w, height yh. */
float windows(float u, float yh, float top, float w, float period) {
  float cx = floor(u / w);
  float cy = floor((yh - top) / (w * 1.3));
  vec2 f = vec2(fract(u / w), fract((yh - top) / (w * 1.3)));
  float inside = step(0.25, f.x) * step(f.x, 0.7) * step(0.3, f.y) * step(f.y, 0.75);
  float lit = step(hash(vec2(mod(cx, period / w), cy) + vec2(7.0, 3.0)), 0.3);
  return inside * lit * step(1.0, cy);
}

vec3 sky(float xh, float yh, vec2 p) {
  float t = clamp((yh + HORIZON) / HORIZON, 0.0, 1.0);
  float q = floor(t * 18.0 + bayer(p)) / 18.0;
  vec3 col = q < 0.6 ? mix(uPal[0], uPal[1], q / 0.6) : mix(uPal[1], uPal[2], (q - 0.6) / 0.4);
  if (uMode.x > 0.5 && yh < -0.1 && hash(p * 0.37 + 11.0) < 0.004) {
    col = mix(col, uPal[23], 0.5 + 0.5 * hash(p + 3.0));
  }
  float ds = length(vec2(xh, yh) - uSun.xy) / uSun.z;
  if (ds < 1.9) {
    col = mix(col, uPal[4], ds < 1.4 ? 0.5 : 0.25);
  }
  if (ds < 1.0) {
    col = uPal[3];
  }
  // Clouds: two octaves of tiling noise, thresholded into crisp two-tone puffs.
  float band = (yh + 0.43) / 0.32;
  if (band > 0.0 && band < 1.0 && uMode.z > 0.0) {
    vec2 uv = vec2((xh + uPan.z) / CLOUD_PERIOD, yh * 1.5);
    float n = texture(uClouds, uv).r * 0.65 + texture(uClouds, uv * 2.0 + 0.31).g * 0.35;
    float th = 0.7 - 0.24 * uMode.z * sin(band * 3.14159);
    if (n > th) {
      col = n > th + 0.045 ? uPal[5] : uPal[6];
    }
  }
  // The far layer: mountains, or the city's skyline with its windows.
  float uf = xh + uPan.x;
  vec4 hills = texture(uBackdrop, vec2(uf / FAR_PERIOD, 0.5));
  if (uMode.x > 0.5) {
    int i = int(floor(fract(uf / FAR_PERIOD) * float(BACKDROP))) % BACKDROP;
    float top = -texelFetch(uBackdrop, ivec2(i, 0), 0).b * 0.15;
    if (yh > top) {
      col = mix(uPal[7], uPal[11], 0.25);
      col = mix(col, uPal[8], windows(uf, yh, top, WIN_FAR, FAR_PERIOD) * 0.8);
    }
  } else {
    float top = -hills.r * 0.13 - 0.005;
    if (yh > top) {
      col = mix(uPal[7], uPal[8], 0.6 * step(yh, top + 0.012));
      col = mix(col, uPal[11], 0.3 + 0.4 * smoothstep(-0.06, 0.0, yh));
    }
  }
  // The near layer: green hills, or the nearer skyline.
  float un = xh + uPan.y;
  if (uMode.x > 0.5) {
    int i = int(floor(fract(un / NEAR_PERIOD) * float(BACKDROP))) % BACKDROP;
    float top = -texelFetch(uBackdrop, ivec2(i, 0), 0).a * 0.09;
    if (yh > top) {
      col = mix(uPal[9], uPal[10], windows(un, yh, top, WIN_NEAR, NEAR_PERIOD) * 0.7);
    }
  } else {
    float top = -texture(uBackdrop, vec2(un / NEAR_PERIOD, 0.5)).g * 0.06 + 0.004;
    if (yh > top) {
      col = mix(uPal[9], uPal[10], step(top + 0.03, yh));
      col = mix(col, uPal[11], 0.15);
    }
  }
  return col;
}

void main() {
  vec2 p = floor(gl_FragCoord.xy);
  int r = int(uSize.y) - 1 - int(p.y);
  vec4 a = texelFetch(uRows, ivec2(r, 0), 0);
  float xh = (p.x + 0.5 - 0.5 * uSize.x) / uSize.y;
  float yh = (float(r) + 0.5) / uSize.y - HORIZON;
  vec3 col;
  if (a.w > 0.0) {
    vec4 b = texelFetch(uRows, ivec2(r, 1), 0);
    col = mix(ground(xh, a, b.x), uPal[11], b.y);
  } else {
    col = sky(xh, yh, p);
  }
  outColor = vec4(col, 1.0);
}
`;

/** Scenery and cars: atlas cells in low-res px (y down), fogged, hidden below the ground in front. */
const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSprite;
layout(location = 2) in vec4 aUv;
layout(location = 3) in vec4 aTint;
layout(location = 4) in vec4 aFx;
uniform vec2 uResolution;
uniform vec2 uAtlasSize;
out vec2 vUv;
flat out vec4 vTint;
flat out vec3 vFx;
${TO_CLIP_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5) / uAtlasSize;
  vTint = aTint;
  vFx = aFx.xyz;
  gl_Position = pxToClip(aSprite.xy + aCorner * aSprite.zw, uResolution);
}
`;

const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in vec4 vTint;
flat in vec3 vFx;
uniform sampler2D uAtlas;
uniform vec3 uSpriteTint;
uniform vec3 uFog;
uniform float uLit;
uniform float uRows;
out vec4 outColor;
void main() {
  // Rows below the ground in front (a crest) hide it.
  if (uRows - gl_FragCoord.y > vFx.y) {
    outColor = vec4(0.0);
    return;
  }
  vec4 c = texture(uAtlas, vUv);
  vec3 glow = texture(uAtlas, vUv + vec2(0.0, 0.5)).rgb;
  vec3 col = c.rgb * vTint.rgb * mix(uSpriteTint, vec3(1.0), vFx.z) + glow * (uLit * vTint.a);
  col = mix(col, uFog * (c.a * vTint.a), vFx.x);
  outColor = vec4(col, c.a * vTint.a);
}
`;

/** Nearest-neighbour upscale, faded by uAlpha (premultiplied) for crossfades. */
const PIXEL_COMPOSITE = /* glsl */ `
uniform float uAlpha;
vec4 composite(vec2 uv) {
  ivec2 size = ivec2(uLowResSize);
  ivec2 p = min(ivec2(uv * uLowResSize), size - 1);
  return vec4(texelFetch(uLowRes, p, 0).rgb * uAlpha, uAlpha);
}
`;

type CourseName = "coast" | "sunset" | "night";

interface Slot {
  course: CourseName;
  seed: number;
  pixel: number;
  target: ReturnType<typeof createLowResTarget>;
  u: Uniforms<"uAlpha">;
  /** Device px per low-res pixel, and the blit's rect. */
  px: number;
  /** Which map region of the HUD canvas this slot draws, and the seed and size it was drawn for. */
  region: number;
  mapSeed: number;
  mapSize: number;
}

const courseName = (v: string): CourseName => (v === "sunset" || v === "night" ? v : "coast");

/** Device px per low-res pixel: the slider's size at 1080p, whole, and few enough rows for the table. */
const pixelSize = (pixel: number, height: number) => {
  const p = Math.min(MAX_PIXEL, Math.max(MIN_PIXEL, Number.isFinite(pixel) ? pixel : 2));
  return Math.max(1, Math.round((p * height) / 1080), Math.ceil(height / MAX_ROWS));
};

/** The font's glyphs, split once. */
const glyphs = new Map<string, string[]>();

/** Draws `text` in the 5x7 font with `dot`-px dots at (x, y) in `colour`, offset by `off`. */
function glyphPass(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  dot: number,
  colour: string,
  off: number,
): void {
  ctx.fillStyle = colour;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let rows = glyphs.get(ch);
    if (!rows) {
      rows = glyphRows(ch);
      glyphs.set(ch, rows);
    }
    const cx = x + i * 6 * dot + off;
    for (let ry = 0; ry < GLYPH_H; ry++) {
      const row = rows[ry];
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] === "#") {
          ctx.fillRect(cx + rx * dot, y + ry * dot + off, dot, dot);
        }
      }
    }
  }
}

/** Draws `text` in the 5x7 font with `dot`-px dots at (x, y), over its shadow; returns its right edge. */
function pixelText(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  dot: number,
  role: string,
): number {
  glyphPass(ctx, text, x, y, dot, TEXT_ROLES.inverse, Math.max(1, Math.round(dot / 2)));
  glyphPass(ctx, text, x, y, dot, role, 0);
  return x + text.length * 6 * dot;
}

/** Wraps a background layer's offset into its loop. */
const wrapPan = (v: number, period: number) => v - Math.floor(v / period) * period;

/** The HUD's colours for a course, in text-layer palette order (the down role unused, as main). */
function hudPalette(look: CourseLook): Float32Array {
  const [main, label, dot, shade] = look.hud;
  return hexesToUnitRgb([main, label, dot, main, shade]);
}

/**
 * A pseudo-3D arcade racer driving itself round a seeded coastal course. The
 * road, sky and background layers draw in one full-screen pass into a low-res
 * target from a per-row table projected on the CPU; scenery and cars are
 * instanced atlas sprites, back to front; the frame is upscaled
 * nearest-neighbour. Course, seed and pixel-size changes crossfade two such
 * renders. The HUD is pixel text on a 2D canvas, redrawn when it changes.
 */
export const roadRacer = defineEffect(roadRacerMeta, {
  create(gl) {
    return withScope((scope) => {
      const texture = (o: Parameters<typeof createDataTexture>[1]) =>
        scope.add(createDataTexture(gl, o), (t) => {
          gl.deleteTexture(t);
        });
      const atlas = buildSpriteAtlas();
      const atlasTexture = texture({
        width: atlas.width,
        height: atlas.half * 2,
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        data: atlas.pixels,
        filter: gl.NEAREST,
      });
      const backdropTexture = texture({
        width: BACKDROP_WIDTH,
        height: 1,
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        data: buildBackdrop(),
        wrap: gl.REPEAT,
      });
      const CLOUD_SIZE = 128;
      const cloudTexture = texture({
        width: CLOUD_SIZE,
        height: CLOUD_SIZE,
        internalFormat: gl.RG8,
        format: gl.RG,
        type: gl.UNSIGNED_BYTE,
        data: buildPeriodicNoiseTexture(CLOUD_SIZE, [
          { period: 4, seed: 71 },
          { period: 8, seed: 72 },
        ]),
        wrap: gl.REPEAT,
      });
      const frameRows = createRoadFrame(MAX_ROWS);
      const rowTexture = texture({
        width: MAX_ROWS,
        height: 2,
        internalFormat: gl.RGBA32F,
        format: gl.RGBA,
        type: gl.FLOAT,
        data: new Float32Array(MAX_ROWS * 8),
        filter: gl.NEAREST,
      });

      const roadProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROAD_FRAGMENT);
      const ru = createUniforms(gl, roadProgram, [
        "uRows",
        "uBackdrop",
        "uClouds",
        "uSize",
        "uPal",
        "uSun",
        "uPan",
        "uMode",
      ]);
      gl.useProgram(roadProgram);
      ru.i1("uRows", 1);
      ru.i1("uBackdrop", 2);
      ru.i1("uClouds", 3);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const spriteProgram = scopedProgram(gl, scope, SPRITE_VERTEX, SPRITE_FRAGMENT);
      const su = createUniforms(gl, spriteProgram, [
        "uResolution",
        "uAtlasSize",
        "uAtlas",
        "uSpriteTint",
        "uFog",
        "uLit",
        "uRows",
      ]);
      gl.useProgram(spriteProgram);
      su.i1("uAtlas", 0);
      su.f2("uAtlasSize", atlas.width, atlas.half * 2);
      const batch = scope.own(createSpriteBatch(gl, MAX_SPRITES, [4, 4, 4, 4]));
      if (batch.stride !== STRIDE) {
        throw new Error("Road Racer: sprite layout mismatch");
      }
      gl.useProgram(null);

      const makeSlot = (region: number): Slot => {
        const target = scope.own(
          createLowResTarget(gl, {
            composite: PIXEL_COMPOSITE,
            premultiplied: true,
            dither: false,
          }),
        );
        return {
          course: "coast",
          seed: 1,
          pixel: 2,
          target,
          u: createUniforms(gl, target.program, ["uAlpha"]),
          px: 1,
          region,
          mapSeed: -1,
          mapSize: 0,
        };
      };
      const slots: [Slot, Slot] = [makeSlot(0), makeSlot(1)];
      const fade = createCrossfadeSlots(slots, CROSSFADE, (slot) => {
        slot.target.release();
      });

      /** Courses by seed, so a crossfade or a return to a seed reuses them. */
      const courses = new Map<number, Course>();
      const courseFor = (seed: number) => {
        let c = courses.get(seed);
        if (!c) {
          if (courses.size > 4) {
            courses.clear();
          }
          c = buildCourse(seed);
          courses.set(seed, c);
        }
        return c;
      };
      const palettes = new Map<CourseName, Float32Array>();
      const paletteFor = (name: CourseName) => {
        let p = palettes.get(name);
        if (!p) {
          const colours = COURSES[name].colours;
          p = hexesToUnitRgb(SCENE_COLOURS.map((k) => colours[k]));
          palettes.set(name, p);
        }
        return p;
      };

      const scene = createScene();
      const traffic: TrafficState = { active: false, gap: 0, closing: 0, appear: 0, hash: 0 };
      let drive = createDrive(1);
      let width = 1;
      let height = 1;
      let started = false;
      const pan = { far: 0, near: 0, clouds: 0 };

      // HUD.
      const text = createTextLayer(gl, scope, 8);
      const textPalette = new Float32Array(TEXT_PALETTE_FLOATS);
      const hudEase = createColorEase(TEXT_PALETTE_FLOATS);
      /** -1 until the first frame, which starts it shown or hidden. */
      let hudAlpha = -1;
      /** HUD layout, canvas and screen px; recomputed on resize. */
      const hud = {
        label: 1,
        big: 2,
        slotW: 1,
        slotH: 1,
        map: 1,
        dot: 1,
        margin: 0,
        /** Canvas rows: speed, lap, map A, map B, dot. */
        lapY: 0,
        mapY: [0, 0],
        dotY: 0,
        speedShown: -1,
        lapShown: -1,
      };
      const hudPalettes = new Map<CourseName, Float32Array>();

      const layoutHud = () => {
        const s = Math.min(height, (width * 9) / 16) / 1080;
        hud.label = Math.max(1, Math.round(3 * s));
        hud.big = Math.max(2, Math.round(5 * s));
        hud.slotW = Math.ceil(9 * 6 * hud.big + hud.big);
        hud.slotH = Math.ceil(9 * hud.label + 8 * hud.big);
        hud.map = Math.max(24, Math.round(170 * s));
        hud.dot = Math.max(3, Math.round(4 * hud.label));
        hud.margin = Math.round(Math.max(12, 40 * s));
        hud.lapY = hud.slotH;
        hud.mapY[0] = hud.slotH * 2;
        hud.mapY[1] = hud.mapY[0] + hud.map + 2;
        hud.dotY = hud.mapY[1] + hud.map + 2;
        const w = Math.max(hud.slotW, hud.map + 2, hud.dot + 2 + PANEL);
        const h = hud.dotY + hud.dot;
        const changed = text.width !== w || text.height !== h;
        if (text.resize(w, h) && changed) {
          hud.speedShown = -1;
          hud.lapShown = -1;
          slots[0].mapSize = 0;
          slots[1].mapSize = 0;
          const ctx = text.ctx;
          if (ctx) {
            text.clear(0, hud.dotY, hud.dot, hud.dot);
            ctx.fillStyle = TEXT_ROLES.inverse;
            ctx.fillRect(0, hud.dotY, hud.dot, hud.dot);
            ctx.fillStyle = TEXT_ROLES.up;
            const e = Math.max(1, Math.round(hud.dot / 5));
            ctx.fillRect(e, hud.dotY + e, hud.dot - 2 * e, hud.dot - 2 * e);
            // A swatch of shade, stretched behind the map.
            text.clear(hud.dot + 2, hud.dotY, PANEL, PANEL);
            ctx.fillStyle = TEXT_ROLES.inverse;
            ctx.fillRect(hud.dot + 2, hud.dotY, PANEL, PANEL);
          }
        }
      };

      const drawSlotText = (y: number, label: string, value: string, unit: string) => {
        const ctx = text.ctx;
        if (!ctx) {
          return;
        }
        text.clear(0, y, hud.slotW, hud.slotH);
        pixelText(ctx, label, 0, y, hud.label, TEXT_ROLES.muted);
        const x = pixelText(ctx, value, 0, y + 9 * hud.label, hud.big, TEXT_ROLES.primary);
        if (unit !== "") {
          pixelText(
            ctx,
            unit,
            x + hud.big,
            y + 9 * hud.label + 2 * hud.big,
            hud.label,
            TEXT_ROLES.muted,
          );
        }
      };

      const drawMap = (slot: Slot, course: Course) => {
        const ctx = text.ctx;
        if (!ctx || (slot.mapSeed === course.seed && slot.mapSize === hud.map)) {
          return;
        }
        slot.mapSeed = course.seed;
        slot.mapSize = hud.map;
        const y0 = hud.mapY[slot.region];
        text.clear(0, y0, hud.map + 2, hud.map + 2);
        const line = Math.max(1, Math.round(hud.map / 60));
        const box = hud.map - line - 1;
        for (const [off, role] of [
          [1, TEXT_ROLES.inverse],
          [0, TEXT_ROLES.muted],
        ] as const) {
          ctx.fillStyle = role;
          for (let i = 0; i < SEGMENTS; i++) {
            const j = (i + 1) % SEGMENTS;
            for (let k = 0; k < 4; k++) {
              const t = k / 4;
              const mx = course.map[i * 2] + (course.map[j * 2] - course.map[i * 2]) * t;
              const my =
                course.map[i * 2 + 1] + (course.map[j * 2 + 1] - course.map[i * 2 + 1]) * t;
              ctx.fillRect(Math.round(mx * box) + off, y0 + Math.round(my * box) + off, line, line);
            }
          }
        }
        ctx.fillStyle = TEXT_ROLES.primary;
        ctx.fillRect(
          Math.round(course.map[0] * box) - line,
          y0 + Math.round(course.map[1] * box) - line,
          line * 3,
          line * 3,
        );
      };

      const mapPoint = (course: Course, distance: number, axis: number) => {
        const s = distance - Math.floor(distance / LAP) * LAP;
        const i = Math.floor(s);
        const j = (i + 1) % SEGMENTS;
        const a = course.map[i * 2 + axis];
        return a + (course.map[j * 2 + axis] - a) * (s - i);
      };

      /** Queues a slot's map and the dot on it at (x, y). */
      const mapQuads = (slot: Slot, x: number, y: number, alpha: number) => {
        const c = courseFor(slot.seed);
        const size = hud.map + 2;
        text.quad(0, hud.mapY[slot.region], size, size, x, y, size, size, alpha);
        const box = hud.map - Math.max(1, Math.round(hud.map / 60)) - 1;
        const dx = x + mapPoint(c, drive.distance, 0) * box - hud.dot / 2;
        const dy = y + mapPoint(c, drive.distance, 1) * box - hud.dot / 2;
        text.quad(0, hud.dotY, hud.dot, hud.dot, dx, dy, hud.dot, hud.dot, alpha);
      };

      const sceneInput: SceneInput = {
        look: COURSES.coast,
        atlas,
        drive,
        traffic,
        carZ: 1,
        width: 1,
        height: 1,
      };

      /** Draws a slot's course into its low-res target. */
      const drawSlot = (slot: Slot, camHeight: number, carZ: number) => {
        const course = courseFor(slot.seed);
        const look: CourseLook = COURSES[slot.course];
        const target = slot.target;
        slot.px = pixelSize(slot.pixel, height);
        target.resize(width, height, slot.px);
        const lowW = target.width;
        const lowH = target.height;
        projectRoad(frameRows, course, drive.distance, camHeight, drive.speed, lowH);
        trafficAt(slot.seed, drive.distance, traffic);
        sceneInput.look = look;
        sceneInput.drive = drive;
        sceneInput.carZ = carZ;
        sceneInput.width = lowW;
        sceneInput.height = lowH;
        buildScene(scene, frameRows, course, sceneInput);

        target.bind();
        gl.useProgram(roadProgram);
        ru.f2("uSize", lowW, lowH);
        gl.uniform3fv(ru.loc.uPal, paletteFor(slot.course));
        ru.f3("uSun", look.sun[0], look.sun[1], look.sun[2]);
        ru.f3("uPan", pan.far, pan.near, pan.clouds);
        ru.f3("uMode", look.night, look.sea, look.clouds);
        gl.activeTexture(gl.TEXTURE1);
        updateDataTexture(gl, rowTexture, lowH, 2, gl.RGBA, gl.FLOAT, frameRows.table);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, backdropTexture);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, cloudTexture);
        triangle.draw();

        if (scene.count > 0) {
          batch.data.set(scene.data.subarray(0, scene.count * STRIDE));
          batch.upload(scene.count);
          gl.useProgram(spriteProgram);
          su.f2("uResolution", lowW, lowH);
          su.f3("uSpriteTint", look.spriteTint[0], look.spriteTint[1], look.spriteTint[2]);
          const fog = paletteFor(slot.course);
          su.f3("uFog", fog[33], fog[34], fog[35]);
          su.f1("uLit", look.lit);
          su.f1("uRows", lowH);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          batch.draw(0, scene.count);
          gl.disable(gl.BLEND);
        }
        for (let unit = 3; unit >= 0; unit--) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      };

      const compose = (slot: Slot, alpha: number) => {
        const target = slot.target;
        const outW = target.width * slot.px;
        const outH = target.height * slot.px;
        gl.useProgram(target.program);
        slot.u.f1("uAlpha", alpha);
        target.blit(outW, outH, Math.floor((width - outW) / 2), Math.floor((height - outH) / 2));
      };

      return {
        resize({ width: w, height: h }) {
          width = Math.max(1, Math.floor(w));
          height = Math.max(1, Math.floor(h));
          layoutHud();
        },
        frame(dt, params) {
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const course = courseName(params.course);
          const seed = Math.floor(Number.isFinite(params.seed) ? params.seed : 0);
          const pixel = Math.round(Number.isFinite(params.pixel) ? params.pixel : 2);
          const lane = params.lane === "left" ? -1 : 1;
          if (!started) {
            started = true;
            const c = fade.current;
            c.course = course;
            c.seed = seed;
            c.pixel = pixel;
            drive = createDrive(lane);
          } else if (!fade.fading) {
            const c = fade.current;
            if (c.course !== course || c.seed !== seed || c.pixel !== pixel) {
              const n = fade.next;
              n.course = course;
              n.seed = seed;
              n.pixel = pixel;
              n.mapSeed = -1;
              fade.start();
            }
          }
          fade.step(step);
          const shown = fade.fading ? fade.next : fade.current;
          const drivenCourse = courseFor(shown.seed);
          const blocked =
            laneBlocked(fade.current.seed, drive.distance) ||
            (fade.fading && laneBlocked(fade.next.seed, drive.distance));
          stepDrive(drive, drivenCourse, params.speed, lane, blocked, step);
          const curve = sampleLoop(drivenCourse.curve, drive.distance);
          pan.far = wrapPan(
            pan.far + panRate(curve, drive.speed, PARALLAX.far) * step,
            LAYER_PERIOD.far,
          );
          pan.near = wrapPan(
            pan.near + panRate(curve, drive.speed, PARALLAX.near) * step,
            LAYER_PERIOD.near,
          );
          pan.clouds = wrapPan(
            pan.clouds + (CLOUD_WIND + panRate(curve, drive.speed, PARALLAX.clouds)) * step,
            LAYER_PERIOD.clouds,
          );

          const camHeight = cameraHeight(viewScale(width, height));
          const carZ = carDistance(camHeight);
          beginFrame(gl, width, height);
          drawSlot(fade.current, camHeight, carZ);
          if (fade.fading) {
            drawSlot(fade.next, camHeight, carZ);
          }
          gl.viewport(0, 0, width, height);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          compose(fade.current, 1);
          if (fade.fading) {
            compose(fade.next, fade.mix);
          }

          // HUD: speed and lap time redrawn when their text changes, the maps once per seed and size.
          const hudOn = params.hud;
          hudAlpha =
            hudAlpha < 0
              ? hudOn
                ? 1
                : 0
              : Math.min(1, Math.max(0, hudAlpha + ((hudOn ? 1 : -1) * step) / HUD_FADE));
          let hudTarget = hudPalettes.get(shown.course);
          if (!hudTarget) {
            hudTarget = hudPalette(COURSES[shown.course]);
            hudPalettes.set(shown.course, hudTarget);
          }
          const colours = hudEase.step(hudTarget, step, HUD_FADE * 2);
          if (hudAlpha > 0 && text.ctx) {
            const kmh = speedKmh(drive.speed);
            if (kmh !== hud.speedShown) {
              hud.speedShown = kmh;
              drawSlotText(0, "SPEED", String(kmh), "KM/H");
            }
            const tenths = Math.floor(drive.lapTime * 10);
            if (tenths !== hud.lapShown) {
              hud.lapShown = tenths;
              drawSlotText(hud.lapY, "LAP", formatLapTime(drive.lapTime), "");
            }
            drawMap(fade.current, courseFor(fade.current.seed));
            if (fade.fading) {
              drawMap(fade.next, courseFor(fade.next.seed));
            }
            text.flush();
            const m = hud.margin;
            const right = width - m;
            const lapW = 6 * 6 * hud.big + hud.big;
            text.quad(0, 0, hud.slotW, hud.slotH, m, m, hud.slotW, hud.slotH, hudAlpha);
            text.quad(
              0,
              hud.lapY,
              hud.slotW,
              hud.slotH,
              right - lapW,
              m,
              hud.slotW,
              hud.slotH,
              hudAlpha,
            );
            const mapX = right - hud.map;
            const mapY = m + hud.slotH + hud.big;
            const pad = hud.big * 2;
            text.quad(
              hud.dot + 3,
              hud.dotY + 1,
              PANEL - 2,
              PANEL - 2,
              mapX - pad,
              mapY - pad,
              hud.map + 2 * pad,
              hud.map + 2 * pad,
              hudAlpha * 0.3,
            );
            if (fade.fading && fade.next.seed !== fade.current.seed) {
              mapQuads(fade.current, mapX, mapY, hudAlpha * (1 - fade.mix));
              mapQuads(fade.next, mapX, mapY, hudAlpha * fade.mix);
            } else {
              mapQuads(shown, mapX, mapY, hudAlpha);
            }
            setTextPalette(
              textPalette,
              colours.subarray(0, 3),
              colours.subarray(3, 6),
              colours.subarray(6, 9),
              colours.subarray(9, 12),
              colours.subarray(12, 15),
            );
            gl.viewport(0, 0, width, height);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            text.draw(width, height, textPalette);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
