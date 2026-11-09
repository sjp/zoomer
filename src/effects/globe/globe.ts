import { hexToUnitRgb } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import {
  BASE_BOT,
  BASE_BW,
  BASE_K,
  BASE_TOP,
  BASE_TW,
  createLayout,
  createSnow,
  FLAKE_DISC,
  FLAKE_STRIDE,
  globeLayout,
  globeNudge,
  MOUND_BASE,
  MOUND_RISE,
  sceneKind,
  SHADOW_DX,
  SHADOW_RX,
  SHADOW_RY,
  SHADOW_SOFT,
  shakeSnow,
  SHELF_BACK_Y,
  SHELF_FRONT_Y,
  stepSnow,
  writeFlakes,
} from "./globe-sim";
import { globeMeta, MAX_FLAKES } from "./globe.meta";
import { createLowResTarget } from "../lowres";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import { PAINT_OVER_GLSL } from "../sdf-glsl";
import { createChangeKey } from "../change-key";

/** Room pass: about 4 reference px per texel. The room is all out of focus. */
const ROOM_TEXEL_REF = 4;
/** Fixed flake layout, so the globe looks the same on every load. */
const SNOW_SEED = 88;
/** Scene compression towards the rim, where the glass bends it (globe units). */
const REFRACT = 0.06;

/** Palette (sRGB hex), parsed once. */
const WALL = "#6a4634";
const SHELF = "#6b4630";
const LAMP = "#ffc480";
const NIGHT = "#2c3c5e";
const WOOD = "#5a321e";
const BRASS = "#c8a050";

const g = glslFloat;
const vec3Hex = (hex: string) =>
  `vec3(${hexToUnitRgb(hex)
    .map((c) => g(c))
    .join(", ")})`;

/**
 * The room at low resolution: a warm wall lit by a lamp off the outer edge, a
 * night window on the outer side, the shelf across the bottom and a vignette.
 * Static, so it re-renders only when the side or the canvas changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** +1 if the globe (and the lamp) is on the right, -1 left. */
uniform float uSide;
out vec4 outColor;
float box(vec2 p, vec2 lo, vec2 hi, float soft) {
  vec2 a = smoothstep(lo - soft, lo + soft, p) * (1.0 - smoothstep(hi - soft, hi + soft, p));
  return a.x * a.y;
}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  // x measured from the outer edge, where the lamp is.
  vec2 o = vec2(uSide > 0.0 ? uFrame.x - p.x : p.x, p.y);
  vec2 l = (o - vec2(0.02, 0.58)) * vec2(1.5, 1.2);
  float pool = 1.0 / (1.0 + 3.0 * dot(l, l));
  vec3 lamp = ${vec3Hex(LAMP)};
  vec3 wall = ${vec3Hex(WALL)} * (0.3 + 0.8 * pool) * (0.8 + 0.2 * smoothstep(1.0, 0.3, p.y));
  // A night window, blurred: deep blue, paler towards its snowy sill, with soft bars.
  float win = box(o, vec2(0.2, 0.46), vec2(0.62, 0.98), 0.04);
  float bars = max(1.0 - smoothstep(0.006, 0.03, abs(o.x - 0.41)),
    1.0 - smoothstep(0.006, 0.03, abs(o.y - 0.72)));
  vec3 night = ${vec3Hex(NIGHT)} * mix(1.35, 0.75, clamp((o.y - 0.46) * 2.0, 0.0, 1.0));
  night = mix(night, wall * 0.7, 0.6 * bars);
  wall = mix(wall, night, win);
  // The shelf: its top from the wall line to the front edge, then its front face.
  vec3 shelf = ${vec3Hex(SHELF)};
  float top = smoothstep(${g(SHELF_FRONT_Y - 0.004)}, ${g(SHELF_FRONT_Y + 0.004)}, p.y);
  float onShelf = 1.0 - smoothstep(${g(SHELF_BACK_Y - 0.004)}, ${g(SHELF_BACK_Y + 0.004)}, p.y);
  vec3 shelfTop = shelf * (0.55 + 0.6 * pool + 0.25 * smoothstep(${g(SHELF_FRONT_Y)}, ${g(SHELF_BACK_Y)}, p.y));
  vec3 shelfFront = shelf * (0.32 + 0.3 * pool);
  vec3 col = mix(wall, mix(shelfFront, shelfTop, top), onShelf);
  col += lamp * 0.04 * pool;
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.45 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * Shared GLSL for the two globe passes: the local frame (globe units, x towards
 * the outer side), coverage, and the base's front silhouette.
 */
const GLOBE_COMMON = /* glsl */ `
/** One device px in height units. */
uniform float uPx;
/** Sphere centre (height units, nudge included), radius, and side (+1: outer side is right). */
uniform vec4 uGlobe;
/** One device px in globe units, set by main. */
float pxU;
float cov(float sdf) { return clamp(0.5 - sdf / pxU, 0.0, 1.0); }
/** Approximate signed distance to an ellipse of radii r. */
float sdEllipse(vec2 q, vec2 r) {
  float k0 = length(q / r);
  float k1 = max(length(q / (r * r)), 1e-6);
  return k0 * (k0 - 1.0) / k1;
}
/** The base's half-width at height y, between its bottom and top ellipses. */
float baseHalf(float y) {
  return mix(${g(BASE_BW)}, ${g(BASE_TW)}, clamp((y - ${g(BASE_BOT)}) / ${g(BASE_TOP - BASE_BOT)}, 0.0, 1.0));
}
/** The front arc of the base's top ellipse: the top of its visible side. */
float baseArc(float x) {
  float u = x / ${g(BASE_TW)};
  return ${g(BASE_TOP)} - ${g(BASE_K * BASE_TW)} * sqrt(max(1.0 - u * u, 0.0));
}
/** Signed distance (approx.) to the base's side and bottom, which hide the sphere's foot. */
float baseFront(vec2 q) {
  float side = max(max(abs(q.x) - baseHalf(q.y), q.y - baseArc(q.x)), ${g(BASE_BOT)} - q.y);
  return min(side, sdEllipse(q - vec2(0.0, ${g(BASE_BOT)}), vec2(${g(BASE_BW)}, ${g(BASE_BW * BASE_K)})));
}
vec2 localPos() {
  vec2 q = (gl_FragCoord.xy * uPx - uGlobe.xy) / uGlobe.z;
  q.x *= uGlobe.w;
  pxU = uPx / uGlobe.z;
  return q;
}
${PAINT_OVER_GLSL}
`;

/**
 * The globe at full resolution in its box, premultiplied over the room: the
 * shadow on the shelf, the base's top, the scene inside the sphere (compressed
 * a little near the rim, as the glass bends it) over a faint tint of the water,
 * then the base's side over the sphere's foot. Analytic shapes with coverage
 * antialiasing.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform int uScene;
out vec4 outColor;
${DITHER_GLSL}
${GLOBE_COMMON}
const vec3 LAMP = ${vec3Hex(LAMP)};
const vec3 SNOW = vec3(0.93, 0.95, 1.0);
const vec3 SNOW_SHADE = vec3(0.55, 0.62, 0.78);
const vec3 PINE = vec3(0.09, 0.22, 0.17);
const vec3 WINDOW = vec3(1.0, 0.78, 0.42);
const vec3 WOOD = ${vec3Hex(WOOD)};
const vec3 BRASS = ${vec3Hex(BRASS)};

float mound(float x) { return ${g(MOUND_BASE)} + ${g(MOUND_RISE)} * (1.0 - x * x); }
float sdBox(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
/** Isoceles triangle: base centre b, half-width w, height h (approximate distance). */
float sdRoof(vec2 p, vec2 b, float w, float h) {
  vec2 d = p - b;
  return max(b.y - p.y, (abs(d.x) - w * (1.0 - d.y / h)) * h * inversesqrt(h * h + w * w));
}
/** A snowy pine: trunk base x, height h, half-width w; three tiers with snowy hems. */
void pine(inout vec4 acc, vec2 p, float x, float h, float w) {
  float y0 = mound(x) - 0.02;
  vec2 d = p - vec2(x, y0);
  over(acc, vec3(0.2, 0.12, 0.08), cov(sdBox(d, vec2(0.0, 0.04), vec2(0.018, 0.04))));
  float t = (d.y - 0.06) / h;
  float f = fract(t * 3.0);
  float hw = w * (1.0 - 0.85 * t) * (1.0 - 0.4 * f);
  float sd = max(max((abs(d.x) - hw) * 0.8, -t * h), (t - 1.0) * h);
  float hem = 1.0 - smoothstep(0.1, 0.22, f);
  // Lit from the outer side.
  vec3 c = PINE * (0.85 + 0.4 * clamp(d.x / w, -1.0, 1.0));
  c = mix(c, SNOW * 0.9, hem * 0.85);
  over(acc, c, cov(sd));
}
/** A house: centre x, half-width w, wall height h, roof height r, wall colour; chimney if c. */
void house(inout vec4 acc, vec2 p, float x, float w, float h, float r, vec3 wall, bool c) {
  float y0 = mound(x) - 0.03;
  vec2 d = p - vec2(x, y0);
  if (c) over(acc, vec3(0.35, 0.22, 0.18), cov(sdBox(d, vec2(0.45 * w, h + 0.7 * r), vec2(0.022, 0.06))));
  over(acc, wall * (0.8 + 0.3 * d.y / h), cov(sdBox(d, vec2(0.0, 0.5 * h), vec2(w, 0.5 * h))));
  // Lit window and dark door.
  float win = cov(sdBox(d, vec2(-0.4 * w, 0.58 * h), vec2(0.17 * w, 0.17 * h)));
  over(acc, WINDOW, win);
  over(acc, wall * 0.35, cov(sdBox(d, vec2(0.38 * w, 0.36 * h), vec2(0.16 * w, 0.36 * h))));
  // Snow-covered roof with a dark eave.
  float roof = sdRoof(d, vec2(0.0, h - 0.01), w * 1.25, r);
  float eave = smoothstep(0.03, 0.0, d.y - h + 0.01);
  over(acc, mix(SNOW * (0.9 + 0.1 * clamp(d.x / w, -1.0, 1.0)), vec3(0.25, 0.18, 0.15), eave), cov(roof));
  // The window's glow on the snow and air around it.
  vec2 g = (d - vec2(-0.4 * w, 0.58 * h)) / max(w, 0.1);
  acc.rgb += WINDOW * 0.18 * exp(-6.0 * dot(g, g));
}
void lighthouse(inout vec4 acc, vec2 p, float x) {
  float y0 = mound(x) - 0.03;
  vec2 d = p - vec2(x, y0);
  const float H = 0.5;
  float hw = mix(0.085, 0.055, clamp(d.y / H, 0.0, 1.0));
  float tower = max(abs(d.x) - hw, max(-d.y, d.y - H));
  // Red and white bands, antialiased.
  float band = (abs(fract(d.y * ${g(1 / 0.12)}) - 0.5) - 0.25) * 0.12;
  float red = clamp(0.5 + band / pxU, 0.0, 1.0);
  vec3 tc = mix(vec3(0.92, 0.9, 0.88), vec3(0.72, 0.14, 0.12), red);
  tc *= 0.75 + 0.35 * clamp(d.x / hw, -1.0, 1.0);
  over(acc, tc, cov(tower));
  over(acc, vec3(0.15, 0.13, 0.13), cov(sdBox(d, vec2(0.0, H + 0.01), vec2(0.08, 0.012))));
  over(acc, WINDOW * 1.1, cov(sdBox(d, vec2(0.0, H + 0.05), vec2(0.04, 0.035))));
  over(acc, vec3(0.2, 0.12, 0.1), cov(sdRoof(d, vec2(0.0, H + 0.085), 0.06, 0.06)));
  vec2 g = (d - vec2(0.0, H + 0.05)) * vec2(1.6, 3.0);
  acc.rgb += WINDOW * 0.35 * exp(-dot(g, g) * 18.0);
}
vec4 scene(vec2 p) {
  vec4 acc = vec4(0.0);
  if (uScene == 1) {
    pine(acc, p, -0.66, 0.3, 0.11);
    house(acc, p, -0.38, 0.12, 0.13, 0.12, vec3(0.55, 0.3, 0.22), false);
    house(acc, p, 0.42, 0.11, 0.12, 0.11, vec3(0.32, 0.4, 0.5), false);
    house(acc, p, 0.02, 0.15, 0.18, 0.14, vec3(0.62, 0.52, 0.36), true);
  } else if (uScene == 2) {
    pine(acc, p, -0.55, 0.34, 0.12);
    house(acc, p, -0.25, 0.11, 0.1, 0.1, vec3(0.55, 0.5, 0.45), true);
    lighthouse(acc, p, 0.12);
    pine(acc, p, 0.5, 0.26, 0.1);
  } else {
    pine(acc, p, -0.52, 0.44, 0.16);
    pine(acc, p, -0.28, 0.28, 0.1);
    house(acc, p, 0.08, 0.17, 0.16, 0.15, vec3(0.42, 0.25, 0.15), true);
    pine(acc, p, 0.52, 0.34, 0.13);
  }
  // The mound in front of everything's feet: lit at its crest, blue in the shade below.
  float m = mound(p.x);
  vec3 snow = mix(SNOW_SHADE, SNOW, smoothstep(-1.0, m, p.y)) * (0.92 + 0.12 * clamp(p.x, -1.0, 1.0));
  over(acc, snow, cov(p.y - m));
  return acc;
}
void main() {
  vec2 q = localPos();
  // Shadow on the shelf, thrown inwards, plus a tight contact shadow.
  float soft = 1.0 - smoothstep(${g(-SHADOW_SOFT)}, ${g(SHADOW_SOFT)},
    sdEllipse(q - vec2(${g(SHADOW_DX)}, ${g(BASE_BOT)}), vec2(${g(SHADOW_RX)}, ${g(SHADOW_RY)})));
  float contact = 1.0 - smoothstep(0.0, 0.08,
    sdEllipse(q - vec2(0.0, ${g(BASE_BOT)}), vec2(${g(BASE_BW)}, ${g(BASE_BW * BASE_K)})));
  vec4 acc = vec4(0.0, 0.0, 0.0, min(0.4 * soft + 0.3 * contact, 0.65));
  // The base's top, mostly hidden behind the sphere.
  float topE = sdEllipse(q - vec2(0.0, ${g(BASE_TOP)}), vec2(${g(BASE_TW)}, ${g(BASE_TW * BASE_K)}));
  over(acc, WOOD * 1.25, cov(topE));
  // The sphere's inside.
  float r = length(q);
  float sc = cov(r - 1.0);
  if (sc > 0.0) {
    vec4 s = scene(q * (1.0 - ${g(REFRACT)} * smoothstep(0.86, 1.0, r)));
    // A faint cool tint where the water shows the room through it.
    s += vec4(vec3(0.04, 0.05, 0.07), 0.12) * (1.0 - s.a);
    acc = s * sc + acc * (1.0 - s.a * sc);
  }
  // The base's side: wood shaded as a drum, a brass band at the top.
  float bf = cov(baseFront(q));
  if (bf > 0.0) {
    float nx = clamp(q.x / baseHalf(q.y), -1.0, 1.0);
    vec3 w = WOOD * (0.55 + 0.6 * max(nx * 0.7 + 0.45, 0.0));
    w *= 0.94 + 0.06 * sin(q.y * 90.0 + 2.0 * sin(q.x * 7.0));
    float band = smoothstep(0.075, 0.06, baseArc(q.x) - q.y);
    vec3 b = BRASS * (0.5 + 0.7 * max(nx * 0.7 + 0.45, 0.0));
    over(acc, mix(w, b, band), bf);
  }
  // Same dither pattern as the room's blit, weighted so the blend keeps its sum.
  outColor = vec4(acc.rgb + dither8(gl_FragCoord.xy) * acc.a, acc.a);
}
`;

/**
 * The glass over the scene and flakes, premultiplied: a Fresnel rim lit by the
 * lamp, a darker edge line, the night window's reflection bent over the
 * sphere, and the lamp's highlight. Masked off where the base hides the glass.
 */
const GLASS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
${DITHER_GLSL}
${GLOBE_COMMON}
const vec3 LAMP = ${vec3Hex(LAMP)};
const vec3 NIGHT = ${vec3Hex(NIGHT)};
void main() {
  vec2 q = localPos();
  float r = length(q);
  float m = cov(r - 1.0) * (1.0 - cov(baseFront(q)));
  if (m <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  float z = sqrt(max(1.0 - r * r, 0.0));
  float fres = (1.0 - z) * (1.0 - z) * (1.0 - z);
  vec3 col = mix(LAMP, vec3(1.0), 0.4) * fres * 0.3;
  float a = 0.1 * fres + 0.35 * smoothstep(0.965, 0.995, r);
  // The window behind the viewer's shoulder, mirrored onto the sphere.
  vec2 w = q / (1.0 + z);
  vec2 wd = abs(w - vec2(0.3, 0.3)) - vec2(0.13, 0.15);
  float win = 1.0 - smoothstep(-0.02, 0.03, max(wd.x, wd.y));
  float bars = max(1.0 - smoothstep(0.004, 0.012, abs(w.x - 0.3)), 1.0 - smoothstep(0.004, 0.012, abs(w.y - 0.32)));
  col += (NIGHT * 1.6 + 0.06) * win * (1.0 - 0.8 * bars) * 0.55;
  // The lamp's highlight, and a fainter one bounced off the far side.
  vec2 h = (q - vec2(0.52, 0.5)) * vec2(1.0, 1.4);
  col += LAMP * (0.9 * exp(-dot(h, h) * 160.0) + 0.12 * exp(-dot(h, h) * 12.0));
  vec2 h2 = q - vec2(-0.6, -0.25);
  col += LAMP * 0.08 * exp(-dot(h2, h2) * 30.0);
  outColor = vec4((col + dither8(gl_FragCoord.xy) * a) * m, a * m);
}
`;

/**
 * Flakes: soft white discs, centred and sized in height units, clipped to the
 * inside of the glass. The quad grows by about a pixel so the edge is never cut.
 */
const FLAKE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aFlake;
/** 2 / frame size in height units. */
uniform vec2 uToClip;
uniform float uPx;
out vec2 vLocal;
out vec2 vPos;
flat out float vAlpha;
void main() {
  float ext = aFlake.z + 1.5 * uPx;
  vec2 p = aFlake.xy + aCorner * ext;
  vLocal = aCorner * ext / aFlake.z;
  vPos = p;
  vAlpha = aFlake.w;
  gl_Position = vec4(p * uToClip - 1.0, 0.0, 1.0);
}
`;

const FLAKE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vPos;
flat in float vAlpha;
uniform float uPx;
/** Sphere centre and inner radius (height units). */
uniform vec3 uClip;
const vec3 LAMP = ${vec3Hex(LAMP)};
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float aa = max(fwidth(d), 0.05);
  float a = (1.0 - smoothstep(0.3, 1.0 + aa, d)) * vAlpha;
  a *= clamp(0.5 - (length(vPos - uClip.xy) - uClip.z) / uPx, 0.0, 1.0);
  vec3 c = mix(vec3(0.95, 0.97, 1.0), LAMP, 0.15);
  outColor = vec4(c * a, a);
}
`;

/**
 * A snow globe on a shelf in a bottom corner. Every `interval` seconds it
 * nudges itself and its flakes swirl up, then settle on the mound.
 *
 * Passes: the room at 1/4 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; the scene (shadow, base, the analytic
 * scene inside the sphere) in a scissored full-resolution box; the flakes as
 * instanced sprites; then the glass in the same box. The flakes are simulated
 * on the CPU (globe-sim.ts).
 */
export const globe = defineEffect(globeMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const batch = scope.own(createSpriteBatch(gl, MAX_FLAKES, [FLAKE_STRIDE]));
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);

      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uPxToH", "uFrame", "uSide"]);
      const sceneProgram = program(FULLSCREEN_VERTEX, SCENE_FRAGMENT);
      const su = createUniforms(gl, sceneProgram, ["uPx", "uGlobe", "uScene"]);
      const glassProgram = program(FULLSCREEN_VERTEX, GLASS_FRAGMENT);
      const gu = createUniforms(gl, glassProgram, ["uPx", "uGlobe"]);
      const flakeProgram = program(FLAKE_VERTEX, FLAKE_FRAGMENT);
      const fu = createUniforms(gl, flakeProgram, ["uToClip", "uPx", "uClip"]);

      const layout = createLayout();
      const snow = createSnow(SNOW_SEED, MAX_FLAKES);
      // Start mid-swirl, without the nudge, so the first frame already has snow in the water.
      shakeSnow(snow, false);
      const nudge = new Float64Array(2);

      let width = 1;
      let height = 1;
      /** The inputs the room target was drawn from. */
      const roomKey = createChangeKey(1);

      /** Scissors to a box given in height units (x0, y0, x1, y1). */
      const scissor = (b: readonly number[]) => {
        const x0 = Math.max(0, Math.floor(b[0] * height));
        const y0 = Math.max(0, Math.floor(b[1] * height));
        const x1 = Math.min(width, Math.ceil(b[2] * height));
        const y1 = Math.min(height, Math.ceil(b[3] * height));
        gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          const scale = v.scale > 0 ? v.scale : height / 1080;
          target.resize(width, height, Math.max(1, ROOM_TEXEL_REF * scale));
          gl.useProgram(roomProgram);
          ru.f2(
            "uPxToH",
            target.fullWidth / target.width / height,
            target.fullHeight / target.height / height,
          );
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          globeLayout(aspect, p.position, p.size, layout);
          stepSnow(snow, dt, p.interval);
          globeNudge(snow, nudge);
          const cx = layout.cx + nudge[0];
          const cy = layout.cy + nudge[1];
          const px = 1 / height;

          // 1. The room, re-rendered only when it changes, upscaled every frame.
          roomKey.set(0, layout.side);
          if (target.needsRedraw(roomKey)) {
            target.bind();
            gl.useProgram(roomProgram);
            ru.f2("uFrame", aspect, 1);
            ru.f1("uSide", layout.side);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          target.blit();

          // 2. The scene, 3. the flakes, 4. the glass, premultiplied, in the globe's box.
          gl.viewport(0, 0, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          scissor(layout.box);
          gl.useProgram(sceneProgram);
          su.f1("uPx", px);
          su.f4("uGlobe", cx, cy, layout.r, layout.side);
          su.i1("uScene", sceneKind(p.scene));
          triangle.draw();

          const n = writeFlakes(snow, layout, nudge, p.flakes, batch.data);
          if (n > 0) {
            batch.upload(n);
            gl.useProgram(flakeProgram);
            fu.f2("uToClip", 2 / aspect, 2);
            fu.f1("uPx", px);
            fu.f3("uClip", cx, cy, layout.r * (FLAKE_DISC + 0.06));
            batch.draw(0, n);
          }

          gl.useProgram(glassProgram);
          gu.f1("uPx", px);
          gu.f4("uGlobe", cx, cy, layout.r, layout.side);
          triangle.draw();

          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
