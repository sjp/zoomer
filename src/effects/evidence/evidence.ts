import { createCanvasAtlas } from "../canvas-texture";
import { createColorEase, unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  type RenderTarget,
  scopedProgram,
  TO_CLIP_GLSL,
  type Uniforms,
  withScope,
} from "../gl";
import { approach } from "../math";
import { hash32, HASH32_GLSL } from "../noise";
import { sanitizeText } from "../params";
import { fitScale } from "../scene-layout";
import {
  createSpriteBatch,
  polygonStrip,
  QUAD,
  ribbonStrip,
  SPRITE_SPIN_GLSL,
  writeSprite,
} from "../sprites";
import { advanceSwell, createSwell, swayGlsl } from "../sway";
import { defineEffect } from "../types";
import { paintItem, SHADOW_PAD } from "./evidence-art";
import {
  ADDED_HALF,
  advanceGrow,
  cardAlpha,
  createGrow,
  type GrowState,
  type Item,
  layoutBoard,
  LOOSE_ITEM,
  MAX_ADDED,
  MAX_DENSITY,
  pinPoint,
  shelfPack,
  stringProgress,
} from "./evidence-layout";
import {
  clippingLift,
  humLevel,
  LIGHT_FLOATS,
  LIGHTINGS,
  POOL_GLSL,
  poolAt,
} from "./evidence-light";
import { evidenceMeta } from "./evidence.meta";

/** The board's layout seed. */
const SEED = 7;
/** Seconds a lighting change eases over, and an item takes to fade in or out with the density. */
const LIGHT_EASE = 1.5;
const ITEM_FADE = 0.8;
/** Seconds the title card takes to fade in or out. */
const TITLE_FADE = 0.6;

/** Atlas slots: the title card, the board's items, then the added cards. */
const TITLE_SLOT = 0;
const ITEM_SLOT = 1;
const ADDED_SLOT = ITEM_SLOT + MAX_DENSITY;
const SLOTS = ADDED_SLOT + MAX_ADDED;
/** Px between atlas slots, and the largest atlas side. */
const ATLAS_GAP = 2;
const ATLAS_MAX = 4096;

/** Strings: segments along each, half width and the sway's reach (px at 1080p), sag per px of length. */
const STRING_SEGMENTS = 24;
const STRING_HALF_W = 1.25;
const SWAY_PX = 1.3;
const SAG = 0.028;
const MAX_STRINGS = 2 * MAX_DENSITY + MAX_ADDED;
/** The strings' and pins' shadow: offset right and down (px at 1080p). */
const SHADOW_DX = 2.5;
const SHADOW_DY = 4;
/** A pin's head radius (px at 1080p). */
const PIN_R = 6.5;
const PINS = 1 + MAX_DENSITY + MAX_ADDED;
const PIN_RGB = [
  [0.82, 0.16, 0.14],
  [0.95, 0.78, 0.18],
  [0.2, 0.4, 0.78],
  [0.2, 0.6, 0.3],
  [0.92, 0.91, 0.88],
] as const;
/** How far the loose clipping's corner lifts at most, as a share of its size. */
const LIFT_REACH = 0.08;

/** Dust: motes, their radius (px at 1080p), drift speed (board units a second) and brightness. */
const MOTES = 56;
const MOTE_R = 4.5;
const MOTE_SPEED = 0.006;
const MOTE_GAIN = 0.32;

/** A slow draught: whole cycles every 48 s, so the phase wraps cleanly. */
const DRAUGHT = createSwell(48, [
  { cycles: 6, amplitude: 1, offset: 0 },
  { cycles: 4, amplitude: 0.6, offset: 0.37 },
  { cycles: 11, amplitude: 0.25, offset: 0.71 },
]);

/** GLSL: the light reaching a pixel, from the ambient and the lamp's pool. */
const LIGHT_GLSL = /* glsl */ `
uniform vec2 uRes;
uniform float uUnit;
uniform vec3 uAmbient;
uniform vec3 uPool;
${POOL_GLSL}
vec3 lightAt(vec2 frag) {
  return uAmbient + uPool * poolAt((frag - 0.5 * uRes) / uUnit);
}
`;

/** The corkboard and its wooden frame, drawn once per resize. */
const BOARD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uUnit;
out vec4 outColor;
${HASH32_GLSL}

float rand(vec2 cell, uint salt) {
  uvec2 u = uvec2(ivec2(floor(cell)) + 65536);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y ^ salt))) / 4294967296.0;
}
float vnoise(vec2 p, uint salt) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rand(i, salt), rand(i + vec2(1.0, 0.0), salt), f.x),
             mix(rand(i + vec2(0.0, 1.0), salt), rand(i + vec2(1.0, 1.0), salt), f.x), f.y);
}

const float FRAME = 0.045;

vec3 cork(vec2 p) {
  vec3 c = vec3(0.6, 0.43, 0.27);
  // Broad patches, then the granules, then dark flecks and old pin holes.
  c *= 0.9 + 0.16 * vnoise(p * 7.0, 3u);
  float g = vnoise(p * 210.0, 5u) * 0.6 + vnoise(p * 470.0, 7u) * 0.4;
  c *= 0.82 + 0.32 * g;
  // Round flecks, a pixel or two across, one in some cells.
  vec2 fc = p * 160.0;
  vec2 fo = vec2(rand(fc, 11u), rand(fc, 31u)) * 0.6 + 0.2;
  float fd = length(fract(fc) - fo) / 160.0;
  float fr = 0.0008 + 0.001 * rand(fc, 37u);
  float aa = 0.7 / uUnit;
  c *= 1.0 - 0.38 * step(0.62, rand(fc, 41u)) * (1.0 - smoothstep(fr - aa, fr + aa, fd));
  vec2 cell = p * 9.0;
  vec2 hole = vec2(rand(cell, 13u), rand(cell, 17u));
  float d = length(fract(cell) - hole) / 9.0;
  float pinHole = rand(cell, 19u) > 0.72 ? 1.0 - smoothstep(0.0012, 0.0024, d) : 0.0;
  c *= 1.0 - 0.45 * pinHole;
  return c;
}

vec3 wood(float along, float across) {
  vec3 c = vec3(0.42, 0.27, 0.15);
  float grain = vnoise(vec2(along * 6.0, across * 260.0), 23u) * 0.6 + vnoise(vec2(along * 22.0, across * 900.0), 29u) * 0.4;
  c *= 0.8 + 0.35 * grain;
  // A rounded profile: lit along its outer half, a dark bevel at the inner edge.
  float t = across / FRAME;
  c *= 0.85 + 0.3 * smoothstep(0.0, 0.5, t) * (1.0 - smoothstep(0.55, 1.0, t)) - 0.35 * smoothstep(0.86, 1.0, t);
  return c;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uUnit;
  // Distances from the top and left edges, in board units.
  float top = (uRes.y - gl_FragCoord.y) / uUnit;
  float left = gl_FragCoord.x / uUnit;
  vec3 c = cork(p);
  // The frame's shadow on the cork along its inner edge.
  float inner = min(top, left) - FRAME;
  c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.02, inner));
  if (top < FRAME && top < left) {
    c = wood(gl_FragCoord.x / uUnit, top);
  } else if (left < FRAME) {
    c = wood(top, left);
  }
  outColor = vec4(c, 1.0);
}
`;

/** Every frame: the cached board under the lamp's light. */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uBoard;
out vec4 outColor;
${LIGHT_GLSL}
${DITHER_GLSL}
void main() {
  vec3 albedo = texelFetch(uBoard, ivec2(gl_FragCoord.xy), 0).rgb;
  outColor = vec4(albedo * lightAt(gl_FragCoord.xy) + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Items from the atlas, turned, faded and lit; the loose clipping's corner lifts. */
const ITEM_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre and half size (px, y down). */
layout(location = 1) in vec4 aRect;
/** The atlas rect: top-left and bottom-right uv. */
layout(location = 2) in vec4 aUv;
/** Alpha, lift (0..1), and the item's half size as a share of its slot's. */
layout(location = 3) in vec4 aFx;
layout(location = 4) in vec2 aSpin;
uniform vec2 uRes;
out vec2 vUv;
out vec2 vLocal;
flat out vec4 vFx;
flat out vec2 vUvHalf;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vLocal = aCorner;
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vUvHalf = 0.5 * (aUv.zw - aUv.xy);
  vFx = aFx;
  gl_Position = pxToClip(aRect.xy + spinCorner(aCorner * aRect.zw, aSpin), uRes);
}
`;

const ITEM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
in vec2 vUv;
in vec2 vLocal;
flat in vec4 vFx;
flat in vec2 vUvHalf;
out vec4 outColor;
${LIGHT_GLSL}
void main() {
  vec2 uv = vUv;
  float bright = 1.0;
  if (vFx.y > 0.0) {
    // The bottom-right corner curls up: drawn a little in towards the pin and
    // catching more light, uncovering a little more of its shadow.
    vec2 l = vLocal / vFx.zw;
    float corner = smoothstep(0.35, 1.0, 0.5 * (l.x + l.y));
    uv += vUvHalf * vFx.zw * ${F(LIFT_REACH)} * vFx.y * corner;
    bright += 0.22 * vFx.y * corner;
  }
  vec4 c = texture(uAtlas, uv);
  c.rgb *= lightAt(gl_FragCoord.xy) * bright;
  outColor = c * vFx.x;
}
`;

/** Strings: a ribbon along each sagging, swaying curve between two pins. */
const STRING_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aStrip;
/** The ends (px, y down): from a to b. */
layout(location = 1) in vec4 aEnds;
/** Sag (px), sway reach (px), sway lag (s), how much is drawn (0..1). */
layout(location = 2) in vec4 aShape;
/** Alpha, then half width (px). */
layout(location = 3) in vec2 aFx;
uniform vec2 uRes;
uniform float uPhase;
/** Shadow offset (px) and how much wider the shadow is (px); zero for the string itself. */
uniform vec3 uShadow;
out float vAcross;
flat out vec2 vFx;
${TO_CLIP_GLSL}
${swayGlsl(DRAUGHT, "draught")}
void main() {
  float t = aStrip.x / ${F(STRING_SEGMENTS)} * aShape.w;
  vec2 ab = aEnds.zw - aEnds.xy;
  vec2 n = normalize(vec2(-ab.y, ab.x) + 1e-6);
  float sway = aShape.y * draughtAt(uPhase, aShape.z);
  float bow = 4.0 * t * (1.0 - t);
  float dbow = 4.0 - 8.0 * t;
  vec2 pos = aEnds.xy + ab * t + vec2(0.0, aShape.x * bow) + n * sway * bow;
  vec2 tangent = normalize(ab + vec2(0.0, aShape.x * dbow) + n * sway * dbow + 1e-6);
  float reach = aFx.y + uShadow.z + 1.0;
  vAcross = aStrip.y * reach;
  vFx = vec2(aFx.x, aFx.y + uShadow.z);
  gl_Position = pxToClip(pos + vec2(-tangent.y, tangent.x) * aStrip.y * reach + uShadow.xy, uRes);
}
`;

const STRING_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vAcross;
flat in vec2 vFx;
uniform vec3 uColor;
/** 1 for the shadow pass. */
uniform float uIsShadow;
out vec4 outColor;
${LIGHT_GLSL}
void main() {
  float d = abs(vAcross);
  if (uIsShadow > 0.5) {
    float a = 0.32 * (1.0 - smoothstep(0.0, vFx.y + 0.5, d)) * vFx.x;
    outColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  float a = clamp(vFx.y + 0.5 - d, 0.0, 1.0) * vFx.x;
  // Rounder in the middle: a little lighter along its crest.
  float crest = 0.82 + 0.3 * (1.0 - d / (vFx.y + 0.5));
  outColor = vec4(uColor * lightAt(gl_FragCoord.xy) * crest * a, a);
}
`;

/** Pins: a round head with its highlight, and its shadow down and to the right. */
const PIN_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (px, y down), radius (px), alpha. */
layout(location = 1) in vec4 aPin;
layout(location = 2) in vec3 aColor;
uniform vec2 uRes;
out vec2 vLocal;
flat out vec4 vPin;
flat out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  // Room for the head and its shadow, which falls down and to the right.
  vec2 local = aCorner * 1.9 + vec2(0.45, 0.6);
  vLocal = local;
  vPin = aPin;
  vColor = aColor;
  gl_Position = pxToClip(aPin.xy + local * aPin.z, uRes);
}
`;

const PIN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vPin;
flat in vec3 vColor;
out vec4 outColor;
${LIGHT_GLSL}
void main() {
  float aa = 1.0 / vPin.z;
  float r = length(vLocal);
  float head = clamp((1.0 - r) / aa + 0.5, 0.0, 1.0);
  float sr = length(vLocal - vec2(0.55, 0.8));
  float shadow = 0.45 * (1.0 - smoothstep(0.5, 1.35, sr));
  // A lit dome: brighter to the upper left, with a small highlight.
  vec2 hl = vLocal - vec2(-0.35, -0.4);
  float shade = 0.7 + 0.35 * clamp(1.0 - length(vLocal - vec2(-0.3, -0.35)), 0.0, 1.0);
  vec3 c = vColor * shade * lightAt(gl_FragCoord.xy) + 0.5 * exp(-dot(hl, hl) * 18.0) * lightAt(gl_FragCoord.xy);
  float a = head + shadow * (1.0 - head);
  outColor = vec4(c * head, a) * vPin.w;
}
`;

const MOTE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (px, y down), radius (px). */
layout(location = 1) in vec3 aMote;
/** Additive colour times brightness. */
layout(location = 2) in vec3 aColor;
uniform vec2 uRes;
out vec2 vLocal;
flat out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = pxToClip(aMote.xy + aCorner * aMote.z, uRes);
}
`;

const MOTE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float t = max(1.0 - dot(vLocal, vLocal), 0.0);
  outColor = vec4(vColor * t * t, 0.0);
}
`;

/** The uniforms of `LIGHT_GLSL`. */
const LIGHT_UNIFORMS = ["uRes", "uUnit", "uAmbient", "uPool"] as const;

/** One random float in [0, 1) from `n`. */
const unitHash = (n: number) => hash32(n) / 4294967296;

/**
 * A wall-sized corkboard of an unsolved case under a desk lamp. Every item is
 * painted once into a canvas atlas (per resize, and when a card is added or the
 * title edited) and drawn as a turned sprite; the cork is drawn once into a
 * cached target. Each frame: the board lit by the lamp's pool, the items, the
 * strings' shadows and the strings as sagging ribbons, the pins, and the dust.
 */
export const evidence = defineEffect(evidenceMeta, {
  create(gl) {
    return withScope((scope) => {
      const boardProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BOARD_FRAGMENT);
      const compositeProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const itemProgram = scopedProgram(gl, scope, ITEM_VERTEX, ITEM_FRAGMENT);
      const stringProgram = scopedProgram(gl, scope, STRING_VERTEX, STRING_FRAGMENT);
      const pinProgram = scopedProgram(gl, scope, PIN_VERTEX, PIN_FRAGMENT);
      const moteProgram = scopedProgram(gl, scope, MOTE_VERTEX, MOTE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const bu = createUniforms(gl, boardProgram, ["uRes", "uUnit"]);
      const cu = createUniforms(gl, compositeProgram, [...LIGHT_UNIFORMS, "uBoard"]);
      const iu = createUniforms(gl, itemProgram, [...LIGHT_UNIFORMS, "uAtlas"]);
      const su = createUniforms(gl, stringProgram, [
        ...LIGHT_UNIFORMS,
        "uPhase",
        "uShadow",
        "uColor",
        "uIsShadow",
      ]);
      const pu = createUniforms(gl, pinProgram, LIGHT_UNIFORMS);
      const mu = createUniforms(gl, moteProgram, ["uRes"]);
      const items = scope.own(createSpriteBatch(gl, SLOTS, [4, 4, 4], [QUAD], { rotation: true }));
      const strings = scope.own(
        createSpriteBatch(gl, MAX_STRINGS, [4, 4, 2], [ribbonStrip(STRING_SEGMENTS)]),
      );
      const pins = scope.own(createSpriteBatch(gl, PINS, [4, 3], [polygonStrip(8, Math.PI / 8)]));
      const motes = scope.own(createSpriteBatch(gl, MOTES, [3, 3], [polygonStrip(8, Math.PI / 8)]));
      const atlas = createCanvasAtlas(gl, scope);

      const layout = layoutBoard(SEED);
      const grow: GrowState = createGrow(SEED);
      const lightEase = createColorEase(LIGHT_FLOATS);
      const stringRgb = unitRgbMemo();
      const titleDef = evidenceMeta.params.title;

      let boardTarget: RenderTarget | null = null;
      scope.defer(() => {
        boardTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let scale = 1;
      /** Px per board unit. */
      let unit = 1;
      let boardDirty = true;
      /** The atlas: each slot's top-left (px), its scale (atlas px per frame px), and what's painted in each. */
      const slotSize = new Float64Array(SLOTS * 2);
      const slotAt = new Float64Array(SLOTS * 2);
      let atlasScale = 1;
      let atlasPainted = false;
      let titlePainted = "";
      const addedPainted = new Int32Array(MAX_ADDED).fill(-1);

      // Each item's fade with the density, the title's, and CPU-only time (unwrapped).
      const itemAlpha = new Float32Array(MAX_DENSITY);
      let started = false;
      let titleAlpha = 0;
      let titleText = "";
      let titleRaw: string | null = null;
      let titleOn = false;
      /** The light now (see LIGHTINGS) and the lamp's hum. */
      let light: Float32Array = lightEase.value;
      let hum = 1;
      let phase = 0;
      let time = 0;

      // Pins in px, refreshed per resize (the board's) or per frame (the added cards').
      const pinPx = new Float64Array(2 * (1 + MAX_DENSITY));
      const addedPin = new Float64Array(2 * MAX_ADDED);
      const point = new Float64Array(2);

      // Dust, in board units from the frame's centre (y up).
      const mx = new Float32Array(MOTES);
      const my = new Float32Array(MOTES);
      const heading = new Float32Array(MOTES);
      const twinkle = new Float32Array(MOTES);
      for (let i = 0; i < MOTES; i++) {
        mx[i] = (unitHash(i * 4 + 1) - 0.5) * 2;
        my[i] = unitHash(i * 4 + 2) - 0.5;
        heading[i] = unitHash(i * 4 + 3) * Math.PI * 2;
        twinkle[i] = unitHash(i * 4 + 4) * 100;
      }

      /** Atlas slot size (frame px) for slot `s`. */
      const slotHalf = (s: number): [number, number] => {
        if (s === TITLE_SLOT) {
          return [layout.title.hw, layout.title.hh];
        }
        if (s < ADDED_SLOT) {
          const it = layout.items[s - ITEM_SLOT];
          return [it.hw, it.hh];
        }
        return [ADDED_HALF[0], ADDED_HALF[1]];
      };

      /** Sizes the atlas for the frame and packs its slots; nothing is painted yet. */
      const packAtlas = () => {
        let area = 0;
        let widest = 0;
        for (let s = 0; s < SLOTS; s++) {
          const [hw, hh] = slotHalf(s);
          const w = 2 * (hw + SHADOW_PAD) * unit;
          const h = 2 * (hh + SHADOW_PAD) * unit;
          slotSize[2 * s] = w;
          slotSize[2 * s + 1] = h;
          area += (w + ATLAS_GAP) * (h + ATLAS_GAP);
          widest = Math.max(widest, w);
        }
        let side = Math.max(widest + 2 * ATLAS_GAP, Math.ceil(Math.sqrt(area * 1.2)));
        atlasScale = Math.min(1, ATLAS_MAX / side);
        side = Math.min(ATLAS_MAX, side);
        for (let s = 0; s < SLOTS; s++) {
          slotSize[2 * s] *= atlasScale;
          slotSize[2 * s + 1] *= atlasScale;
        }
        let h = shelfPack(slotSize, SLOTS, side, ATLAS_GAP, slotAt);
        if (h > ATLAS_MAX) {
          // Too tall at this size: paint every slot smaller.
          const k = ATLAS_MAX / h;
          atlasScale *= k;
          for (let s = 0; s < 2 * SLOTS; s++) {
            slotSize[s] *= k;
          }
          h = shelfPack(slotSize, SLOTS, side, ATLAS_GAP, slotAt);
        }
        atlasPainted = false;
        titlePainted = "";
        addedPainted.fill(-1);
        return atlas.resize(side, Math.min(ATLAS_MAX, Math.ceil(h)));
      };

      /** Clears slot `s` and paints `item` in it. */
      const paintSlot = (s: number, item: Item, title = "") => {
        const ctx = atlas.ctx;
        if (!ctx) {
          return;
        }
        const x = slotAt[2 * s];
        const y = slotAt[2 * s + 1];
        const w = slotSize[2 * s];
        const h = slotSize[2 * s + 1];
        atlas.clear(x - 1, y - 1, w + 2, h + 2);
        paintItem(ctx, item, x + w / 2, y + h / 2, unit * atlasScale, title);
      };

      /** Writes sprite `n` for `item` from slot `s`; returns the next sprite index. */
      const writeItem = (n: number, s: number, item: Item, alpha: number, lift: number) => {
        if (alpha <= 0.002) {
          return n;
        }
        const hw = item.hw + SHADOW_PAD;
        const hh = item.hh + SHADOW_PAD;
        const aw = atlas.width;
        const ah = atlas.height;
        const x = slotAt[2 * s];
        const y = slotAt[2 * s + 1];
        const o = writeSprite(
          items,
          n,
          item.u * width,
          item.v * height,
          hw * unit,
          hh * unit,
          x / aw,
          y / ah,
          (x + slotSize[2 * s]) / aw,
          (y + slotSize[2 * s + 1]) / ah,
          item.angle,
          1,
        );
        const d = items.data;
        d[o + 8] = alpha;
        d[o + 9] = lift;
        d[o + 10] = item.hw / hw;
        d[o + 11] = item.hh / hh;
        return n + 1;
      };

      /** Writes string `n` from (ax, ay) to (bx, by) px; returns the next string index. */
      const writeString = (
        n: number,
        ax: number,
        ay: number,
        bx: number,
        by: number,
        key: number,
        drawn: number,
        alpha: number,
      ) => {
        if (alpha <= 0.002 || drawn <= 0) {
          return n;
        }
        const len = Math.hypot(bx - ax, by - ay);
        const d = strings.data;
        const o = n * strings.stride;
        d[o] = ax;
        d[o + 1] = ay;
        d[o + 2] = bx;
        d[o + 3] = by;
        d[o + 4] = SAG * len;
        // Short strings are tauter: they sway less.
        d[o + 5] = SWAY_PX * scale * Math.min(1, len / (0.5 * height));
        d[o + 6] = unitHash(key) * 6;
        d[o + 7] = drawn;
        d[o + 8] = alpha;
        d[o + 9] = STRING_HALF_W * scale;
        return n + 1;
      };

      /** Writes pin `n` at (x, y) px; returns the next pin index. */
      const writePin = (n: number, x: number, y: number, color: number, alpha: number) => {
        if (alpha <= 0.002) {
          return n;
        }
        const d = pins.data;
        const o = n * pins.stride;
        const rgb = PIN_RGB[color % PIN_RGB.length];
        d[o] = x;
        d[o + 1] = y;
        d[o + 2] = PIN_R * scale;
        d[o + 3] = alpha;
        d[o + 4] = rgb[0];
        d[o + 5] = rgb[1];
        d[o + 6] = rgb[2];
        return n + 1;
      };

      /** Uploads the light to a bound program. */
      const setLight = (u: Uniforms<(typeof LIGHT_UNIFORMS)[number]>) => {
        u.f2("uRes", width, height);
        u.f1("uUnit", unit);
        u.f3("uAmbient", light[0], light[1], light[2]);
        u.f3("uPool", light[3] * hum, light[4] * hum, light[5] * hum);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = height / 1080;
          unit = height * fitScale(width / height);
          boardTarget?.dispose();
          boardTarget = null;
          boardTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          boardDirty = true;
          packAtlas();
          pinPoint(layout.title, width, height, unit, point);
          pinPx[0] = point[0];
          pinPx[1] = point[1];
          for (let i = 0; i < MAX_DENSITY; i++) {
            pinPoint(layout.items[i], width, height, unit, point);
            pinPx[2 + 2 * i] = point[0];
            pinPx[3 + 2 * i] = point[1];
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
          time += step;
          phase = advanceSwell(DRAUGHT, phase, step);
          const density = Math.max(0, Math.min(MAX_DENSITY, Math.round(p.density)));
          for (let i = 0; i < MAX_DENSITY; i++) {
            const target = i < density ? 1 : 0;
            itemAlpha[i] = started ? approach(itemAlpha[i], target, step / ITEM_FADE) : target;
          }
          if (p.title !== titleRaw) {
            titleRaw = p.title;
            const text = sanitizeText(titleDef, p.title).trim();
            titleOn = text !== "";
            // Keep the old words on the card while it fades out.
            if (titleOn) {
              titleText = text;
            }
          }
          titleAlpha = started
            ? approach(titleAlpha, titleOn ? 1 : 0, step / TITLE_FADE)
            : titleOn
              ? 1
              : 0;
          started = true;
          advanceGrow(grow, layout, step, density, p.grow);
          light = lightEase.step(LIGHTINGS[p.lighting] ?? LIGHTINGS.lamp, step, LIGHT_EASE);
          hum = 1 + (humLevel(time) - 1) * light[7];

          if (!boardTarget) {
            return;
          }
          if (boardDirty) {
            boardTarget.bind();
            gl.useProgram(boardProgram);
            bu.f2("uRes", width, height);
            bu.f1("uUnit", unit);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            boardDirty = false;
          }

          // Paint what the atlas lacks: everything after a resize, the title
          // when edited, and each new card.
          if (atlas.ctx) {
            if (!atlasPainted) {
              for (let i = 0; i < MAX_DENSITY; i++) {
                paintSlot(ITEM_SLOT + i, layout.items[i]);
              }
              atlasPainted = true;
            }
            if (titleText !== titlePainted && titleText !== "") {
              paintSlot(TITLE_SLOT, layout.title, titleText);
              titlePainted = titleText;
            }
            for (let k = 0; k < MAX_ADDED; k++) {
              const c = grow.cards[k];
              if (c.live && addedPainted[k] !== c.id) {
                paintSlot(ADDED_SLOT + k, c.item);
                addedPainted[k] = c.id;
              }
            }
            atlas.flush();
          }

          // The board.
          gl.useProgram(compositeProgram);
          setLight(cu);
          cu.i1("uBoard", 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, boardTarget.texture);
          triangle.draw();

          // The items, the added cards, then the title card on top.
          let n = 0;
          const lift = clippingLift(time, SEED);
          for (let i = 0; i < MAX_DENSITY; i++) {
            n = writeItem(
              n,
              ITEM_SLOT + i,
              layout.items[i],
              itemAlpha[i],
              i === LOOSE_ITEM ? lift : 0,
            );
          }
          for (let k = 0; k < MAX_ADDED; k++) {
            const c = grow.cards[k];
            if (c.live && addedPainted[k] === c.id) {
              n = writeItem(n, ADDED_SLOT + k, c.item, cardAlpha(c, grow.time), 0);
            }
          }
          if (titlePainted !== "") {
            n = writeItem(n, TITLE_SLOT, layout.title, titleAlpha, 0);
          }
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          if (n > 0 && atlas.ready) {
            items.upload(n);
            gl.useProgram(itemProgram);
            setLight(iu);
            iu.i1("uAtlas", 0);
            gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
            items.draw(0, n);
          }
          gl.bindTexture(gl.TEXTURE_2D, null);

          // The strings: the board's, then each added card's, drawing itself.
          let ns = 0;
          for (const s of layout.strings) {
            const alpha = Math.min(itemAlpha[s.a], itemAlpha[s.b]);
            ns = writeString(
              ns,
              pinPx[2 + 2 * s.a],
              pinPx[3 + 2 * s.a],
              pinPx[2 + 2 * s.b],
              pinPx[3 + 2 * s.b],
              s.a * 64 + s.b,
              1,
              alpha,
            );
          }
          for (let k = 0; k < MAX_ADDED; k++) {
            const c = grow.cards[k];
            if (!c.live) {
              continue;
            }
            pinPoint(c.item, width, height, unit, point);
            addedPin[2 * k] = point[0];
            addedPin[2 * k + 1] = point[1];
            const bx = pinPx[2 + 2 * c.target];
            const by = pinPx[3 + 2 * c.target];
            const len = Math.hypot(bx - point[0], by - point[1]) / height;
            const alpha = cardAlpha(c, grow.time) * itemAlpha[c.target];
            ns = writeString(
              ns,
              point[0],
              point[1],
              bx,
              by,
              0x4000 + c.id,
              stringProgress(c, grow.time, len),
              alpha,
            );
          }
          if (ns > 0) {
            strings.upload(ns);
            gl.useProgram(stringProgram);
            setLight(su);
            su.f1("uPhase", phase);
            const rgb = stringRgb(p.string);
            su.f3("uColor", rgb[0], rgb[1], rgb[2]);
            su.f3("uShadow", SHADOW_DX * scale, SHADOW_DY * scale, 1.5 * scale);
            su.f1("uIsShadow", 1);
            strings.draw(0, ns);
            su.f3("uShadow", 0, 0, 0);
            su.f1("uIsShadow", 0);
            strings.draw(0, ns);
          }

          // The pins, over the strings' ends.
          let np = writePin(0, pinPx[0], pinPx[1], layout.title.pinColor, titleAlpha);
          for (let i = 0; i < MAX_DENSITY; i++) {
            np = writePin(
              np,
              pinPx[2 + 2 * i],
              pinPx[3 + 2 * i],
              layout.items[i].pinColor,
              itemAlpha[i],
            );
          }
          for (let k = 0; k < MAX_ADDED; k++) {
            const c = grow.cards[k];
            if (c.live) {
              np = writePin(
                np,
                addedPin[2 * k],
                addedPin[2 * k + 1],
                c.item.pinColor,
                cardAlpha(c, grow.time),
              );
            }
          }
          if (np > 0) {
            pins.upload(np);
            gl.useProgram(pinProgram);
            setLight(pu);
            pins.draw(0, np);
          }

          // Dust drifting in the lamp's light.
          const gain = light[6] * MOTE_GAIN * hum;
          let nm = 0;
          const halfW = (0.5 * width) / unit;
          const halfH = (0.5 * height) / unit;
          for (let i = 0; i < MOTES; i++) {
            heading[i] += 0.35 * Math.sin(time * 0.21 + twinkle[i]) * step;
            mx[i] += Math.cos(heading[i]) * MOTE_SPEED * step;
            my[i] += (Math.sin(heading[i]) * MOTE_SPEED - 0.0015) * step;
            // Wrap round the frame, where the pool's light has all but gone.
            if (mx[i] < -halfW - 0.02) {
              mx[i] += 2 * halfW + 0.04;
            } else if (mx[i] > halfW + 0.02) {
              mx[i] -= 2 * halfW + 0.04;
            }
            if (my[i] < -halfH - 0.02) {
              my[i] += 2 * halfH + 0.04;
            } else if (my[i] > halfH + 0.02) {
              my[i] -= 2 * halfH + 0.04;
            }
            if (gain <= 0.002) {
              continue;
            }
            const glint = 0.55 + 0.45 * Math.sin(time * 0.9 + twinkle[i]);
            const k = gain * glint * poolAt(mx[i], my[i]);
            if (k <= 0.004) {
              continue;
            }
            const o = nm * motes.stride;
            const d = motes.data;
            d[o] = 0.5 * width + mx[i] * unit;
            d[o + 1] = 0.5 * height - my[i] * unit;
            d[o + 2] = MOTE_R * scale * (0.7 + 0.6 * unitHash(i + 900)) + 1;
            d[o + 3] = light[3] * k;
            d[o + 4] = light[4] * k;
            d[o + 5] = light[5] * k;
            nm++;
          }
          if (nm > 0) {
            gl.blendFunc(gl.ONE, gl.ONE);
            motes.upload(nm);
            gl.useProgram(moteProgram);
            mu.f2("uRes", width, height);
            motes.draw(0, nm);
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
