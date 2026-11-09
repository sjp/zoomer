import type { Rgb } from "../color";
import { createChangeKey } from "../change-key";
import { createSettledValue } from "../rebuild";
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
} from "../gl";
import { createLowResTarget } from "../lowres";
import { clamp } from "../math";
import { PINE_GLSL } from "../pines";
import { createFlakes, type FlakeFrame } from "../snow/snow-sim";
import { createFlakeRenderer } from "../snowflakes";
import {
  buildCondensation,
  condensationSize,
  interior,
  layoutId,
  MAX_PANES,
  sceneIndex,
  windowPanes,
} from "./snowwindow-sim";
import { MAX_SNOWFALL, snowWindowMeta } from "./snowwindow.meta";
import { defineEffect } from "../types";

/** Low-res divisor at 1080p: the outside scene is about 360 rows tall at any size, so it stays soft. */
const SCENE_DIVISOR = 3;
/** Seconds the aspect and the Variation slider must hold still before the mask is rebuilt. */
const INPUT_SETTLE = 0.3;
/** Width of the sloped reveal around each pane, height units. */
const BEVEL = 0.012;
/** Depth of the sill's top face, height units. */
const SILL_TOP = 0.03;
/** Where the lamp's reflection sits in the glass, as shares of the width and height. */
const REFLECT_X = 0.84;
const REFLECT_Y = 0.62;
/** Snowflake look: fixed, so the params stay few. */
const FLAKE_COLOR: Rgb = [0.9, 0.93, 1];
/** Layout ids in a fixed order, for the change key. */
const LAYOUTS = ["four", "six", "frame"] as const;

/**
 * Low-res pass: the twilight scene outside, y up in height units. Sky, a far
 * wooded hill, the snowfield, and pines, a village or nothing in front. Static,
 * so it renders only when its inputs change.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Low-res px to height units, x and y. */
uniform vec2 uInvLow;
uniform float uAspect;
/** 0 pines, 1 village, 2 plain. */
uniform int uScene;
/** Whole-number seed, and a phase (radians) derived from it. */
uniform float uSeed;
uniform float uPhase;
out vec4 outColor;

${PINE_GLSL}

const vec3 SKY_TOP = vec3(0.07, 0.10, 0.23);
const vec3 SKY_LOW = vec3(0.34, 0.41, 0.60);
const vec3 AFTERGLOW = vec3(0.58, 0.50, 0.62);
const vec3 SNOW_FAR = vec3(0.60, 0.67, 0.83);
const vec3 SNOW_NEAR = vec3(0.47, 0.54, 0.73);
const vec3 PINE = vec3(0.07, 0.11, 0.16);
const vec3 PINE_SNOW = vec3(0.56, 0.62, 0.77);
const vec3 WALL = vec3(0.13, 0.14, 0.22);
const vec3 LIT = vec3(1.0, 0.74, 0.40);

float groundLine(float x) {
  return 0.30 + 0.018 * sin(x * 2.3 + uPhase) + 0.008 * sin(x * 6.1 + 2.0 * uPhase);
}

float hillLine(float x) {
  return 0.35 + 0.025 * sin(x * 3.1 + 1.7 * uPhase) + 0.01 * sin(x * 8.3 + uPhase);
}

/** 0 in the middle of the frame (behind the speaker), 1 toward the sides. */
float sideWeight(float x) {
  return smoothstep(0.12, 0.38, abs(x / uAspect - 0.5));
}

/**
 * A row of spruces in cells \`cellW\` wide, standing on the hill or the ground line
 * (sunk by \`sink\`), with \`tiers\` (min, max) of branches: their coverage, how
 * snowy the pixel is and how shaded. \`bias\` thins the trees toward the middle.
 * Trees can overhang the next cell, so three are tested.
 */
vec3 pineRow(vec2 p, float cellW, float tallest, float density, float bias, bool onHill,
             float sink, float salt, vec2 tiers, float px) {
  float cell0 = floor(p.x / cellW);
  vec3 best = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    float cell = cell0 + float(k);
    float dens = density * mix(1.0, sideWeight((cell + 0.5) * cellW), bias);
    vec3 pine = pineCell(cell, 4096.0, uSeed + salt, dens);
    if (pine.x == 0.0) continue;
    float cx = (cell + pine.y) * cellW;
    float th = pine.z * tallest;
    float base = (onHill ? hillLine(cx) : groundLine(cx)) - sink;
    float yr = (p.y - base) / th;
    if (yr < 0.0 || yr > 1.0) continue;
    float r = fract(pine.y * 7.31 + pine.z * 3.77);
    vec3 s = pineSpruce(vec2(p.x - cx, yr), th, floor(mix(tiers.x, tiers.y + 0.99, r)), r);
    float c = clamp(s.x / px + 0.5, 0.0, 1.0);
    if (c > best.x) best = vec3(c, s.yz);
  }
  return best;
}

/** A spruce's colour from its row sample (coverage, snow, shade): needles, shaded under each tier, with snow. */
vec3 spruceColor(vec3 needles, vec3 s, float snow) {
  return mix(needles * (1.0 - 0.45 * s.z), PINE_SNOW, snow * s.y);
}

/** A warm point of light with a soft halo. */
vec3 glow(vec2 p, vec2 at, float core, float halo, float strength) {
  vec2 d = p - at;
  float r2 = dot(d, d);
  return LIT * strength * (exp(-r2 / (core * core)) + 0.2 * exp(-r2 / (halo * halo)));
}

/** Houses with snowy roofs and lit windows, in cells 0.2 wide, fewer in the middle. */
vec3 houses(vec2 p, vec3 col, float px) {
  const float CELL = 0.2;
  float cell = floor(p.x / CELL);
  uint h = hash32(uint(cell) * 747796405u + uint(uSeed) * 2891336453u + 17u);
  float r0 = float(h & 0xffu) / 255.0;
  float r1 = float((h >> 8) & 0xffu) / 255.0;
  float r2 = float((h >> 16) & 0xffu) / 255.0;
  float cx = (cell + 0.5 + (r1 - 0.5) * 0.2) * CELL;
  if (r0 > 0.3 + 0.55 * sideWeight(cx)) return col;
  float hw = mix(0.035, 0.06, r2);
  float wallH = mix(0.04, 0.065, r1);
  float roofH = 0.04;
  vec2 q = p - vec2(cx, groundLine(cx) - 0.006);
  float wall = clamp(min(min(hw - abs(q.x), wallH - q.y), q.y) / px + 0.5, 0.0, 1.0);
  float ry = (q.y - wallH + 0.004) / roofH;
  float roof = ry < 0.0 ? 0.0 : clamp((hw * 1.2 * (1.0 - ry) - abs(q.x)) / px + 0.5, 0.0, 1.0);
  col = mix(col, WALL, wall);
  col = mix(col, mix(PINE_SNOW, SNOW_FAR, ry), roof);
  // Two windows, one of them sometimes dark.
  vec2 w = vec2(abs(q.x) - hw * 0.45, q.y - wallH * 0.45);
  float lit = (q.x < 0.0 || ((h >> 24) & 3u) != 0u) ? 1.0 : 0.0;
  float pane = clamp(min(0.008 - abs(w.x), 0.009 - abs(w.y)) / px + 0.5, 0.0, 1.0);
  col = mix(col, LIT, pane * lit * wall);
  col += lit * LIT * 0.12 * exp(-dot(w, w) / 0.0008);
  return col;
}

void main() {
  vec2 p = gl_FragCoord.xy * uInvLow;
  float px = uInvLow.y;

  // Blue-hour sky with a faint afterglow on the horizon.
  vec3 col = mix(SKY_LOW, SKY_TOP, smoothstep(0.28, 1.0, p.y));
  col = mix(col, AFTERGLOW, 0.45 * exp(-max(p.y - 0.3, 0.0) / 0.07));

  // A far hill, hazed into the sky, wooded unless the scene is plain.
  vec3 haze = mix(PINE, SKY_LOW, 0.6);
  col = mix(col, haze, clamp((hillLine(p.x) - p.y) / px + 0.5, 0.0, 1.0));
  if (uScene != 2) {
    vec3 far = pineRow(p, 0.02, 0.035, 0.75, 0.0, true, 0.004, 11.0, vec2(4.0, 5.0), px);
    col = mix(col, mix(PINE, SKY_LOW, 0.5), far.x);
  }

  // The snowfield, lighter toward the horizon, with a few soft drifts.
  float g = groundLine(p.x);
  vec3 snow = mix(SNOW_NEAR, SNOW_FAR, smoothstep(0.0, g, p.y));
  snow *= 1.0 + 0.04 * sin(p.x * 4.0 + p.y * 30.0 + uPhase);
  col = mix(col, snow, clamp((g - p.y) / px + 0.5, 0.0, 1.0));

  if (uScene == 0) {
    vec3 mid = pineRow(p, 0.09, 0.11, 0.85, 0.8, false, 0.004, 23.0, vec2(5.0, 7.0), px);
    col = mix(col, spruceColor(mix(PINE, SKY_LOW, 0.25), mid, 0.55), mid.x);
    vec3 near = pineRow(p, 0.22, 0.42, 0.9, 1.0, false, 0.06, 37.0, vec2(7.0, 9.0), px);
    col = mix(col, spruceColor(PINE, near, 0.75), near.x);
    // A cabin window among the far trees.
    col += glow(p, vec2(uAspect * 0.8, hillLine(uAspect * 0.8) + 0.004), 0.0035, 0.03, 0.8);
  } else if (uScene == 1) {
    vec3 mid = pineRow(p, 0.09, 0.1, 0.35, 0.8, false, 0.004, 23.0, vec2(5.0, 7.0), px);
    col = mix(col, spruceColor(mix(PINE, SKY_LOW, 0.25), mid, 0.55), mid.x);
    col = houses(p, col, px);
    // A street lamp on the left, with a pool of light on the snow.
    float lx = uAspect * 0.14;
    float lb = groundLine(lx) - 0.03;
    float post = clamp((0.0025 - abs(p.x - lx)) / px + 0.5, 0.0, 1.0) * step(lb, p.y) * step(p.y, lb + 0.13);
    col = mix(col, PINE, post);
    vec2 d = p - vec2(lx, lb);
    col += LIT * 0.18 * exp(-(d.x * d.x / 0.012 + d.y * d.y / 0.0006)) * step(p.y, g);
    col += glow(p, vec2(lx, lb + 0.135), 0.006, 0.05, 0.9);
  } else {
    col += glow(p, vec2(uAspect * 0.78, g + 0.004), 0.003, 0.025, 0.7);
  }
  outColor = vec4(col, 1.0);
}
`;

/**
 * Full-res overlay over the scene and the snow, premultiplied: the frame and sill
 * (opaque) lit by the room's lamp, and in the panes the snow piled on the outside
 * ledge, the condensation and its droplets, the lamp's reflection and a warm
 * vignette.
 */
const GLASS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Condensation mask: R fog, G droplet edge (0.5 on it), B droplet highlight. */
uniform sampler2D uCond;
/** Panes, height units: left, bottom, right, top. */
uniform vec4 uPane[${String(MAX_PANES)}];
uniform int uPaneCount;
/** 1 / canvas height. */
uniform float uInvHeight;
uniform float uAspect;
/** Bottom of the window opening: panes there have the outside ledge below them. */
uniform float uSill;
uniform vec3 uFrame;
uniform float uWarmth;
uniform float uFog;
uniform float uPhase;
/** Centre of the lamp's reflection, height units. */
uniform vec2 uReflect;
out vec4 outColor;
${DITHER_GLSL}

const int MAX_PANES = ${String(MAX_PANES)};
const float BEVEL = ${glslFloat(BEVEL)};
const float SILL_TOP = ${glslFloat(SILL_TOP)};
const vec3 LAMP = vec3(1.0, 0.72, 0.45);
/** Dim, cool light in the room besides the lamp. */
const vec3 ROOM = vec3(0.28, 0.30, 0.36);
/** Twilight from outside, on the reveals around the glass. */
const vec3 SKYLIGHT = vec3(0.42, 0.52, 0.78);
/** The lamp, off to the left of the window and toward the viewer (height units). */
const vec3 LAMP_POS = vec3(-0.35, 0.8, 0.9);

float boxDist(vec2 p, vec4 r) {
  vec2 d = abs(p - 0.5 * (r.xy + r.zw)) - 0.5 * (r.zw - r.xy);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/** Lamp light on a surface at p facing n, fading with distance. */
vec3 lampLight(vec2 p, vec3 n) {
  vec3 l = vec3(LAMP_POS.xy - p, LAMP_POS.z);
  float r2 = dot(l, l);
  return LAMP * (uWarmth * 1.6 * max(dot(n, l * inversesqrt(r2)), 0.0) / (1.0 + 0.5 * r2));
}

/** The frame at p, sd from the nearest pane: flat faces, reveals and the sill. */
vec3 frameShade(vec2 p, float sd, vec4 pane, float px) {
  vec3 n = vec3(0.0, 0.0, 1.0);
  float shade = 1.0;
  vec3 sky = vec3(0.0);
  float sillTop = uSill - BEVEL;
  if (p.y < sillTop) {
    float nose = sillTop - SILL_TOP;
    if (p.y > nose) {
      // The sill's top face, tilted up toward the room.
      n = normalize(vec3(0.0, 0.75, 0.66));
    } else {
      // The rounded nose, then the apron in its shadow.
      float t = (nose - p.y) / 0.006;
      n = normalize(vec3(0.0, 0.6 * (1.0 - clamp(t, 0.0, 1.0)), 0.8));
      shade = 1.0 - 0.3 * exp(-(nose - p.y) / 0.012) * step(1.0, t);
    }
    // A crease where the sill meets the reveal.
    shade *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 1.5 * px, abs(p.y - sillTop)));
  } else if (sd < BEVEL) {
    // The reveal around the glass slopes toward it, catching the twilight outside.
    vec2 q = p - clamp(p, pane.xy, pane.zw);
    vec2 g = q / max(length(q), 1e-6);
    n = normalize(vec3(-g * 0.8, 0.6));
    sky = SKYLIGHT * 0.3 * (1.0 - sd / BEVEL);
    // A thin dark glazing line where it meets the glass.
    shade = mix(0.55, 1.0, smoothstep(0.0, 2.5 * px, sd));
  }
  // A crease where the reveal meets the flat face.
  shade *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 1.5 * px, abs(sd - BEVEL)));
  return uFrame * ((ROOM + lampLight(p, n)) * shade + sky);
}

/** The glass layers at p in pane, premultiplied. */
vec4 glassLayer(vec2 p, vec4 pane, float px, vec4 cond, float dropAa) {
  vec3 col = vec3(0.0);
  float a = 0.0;
  // Snow piled on the outside ledge, drifted up into the corners.
  if (pane.y <= uSill + 1e-4) {
    float lx = p.x - pane.x;
    float w = pane.z - pane.x;
    float h = 0.026 + 0.006 * sin(lx * 11.0 + uPhase) + 0.004 * sin(lx * 29.0 + 2.3 * uPhase)
      + 0.03 * (exp(-lx / 0.05) + exp(-(w - lx) / 0.05));
    float depth = pane.y + h - p.y;
    float cover = clamp(depth / px + 0.5, 0.0, 1.0);
    vec3 snow = mix(vec3(0.80, 0.85, 0.95), vec3(0.50, 0.57, 0.76), smoothstep(0.0, 0.03, depth));
    snow += LAMP * (uWarmth * 0.18 * exp(-max(depth, 0.0) / 0.01));
    col = snow * cover;
    a = cover;
  }
  // Condensation, growing out of the corners as uFog rises, cleared by droplets.
  float fogA = 0.72 * smoothstep(1.0 - uFog, 1.4 - uFog, cond.r);
  float drop = clamp((cond.g - 0.5) / dropAa + 0.5, 0.0, 1.0) *
    smoothstep(1.0 - uFog, 1.2 - uFog, cond.r);
  fogA *= 1.0 - 0.85 * drop;
  vec3 fogCol = mix(vec3(0.60, 0.64, 0.72), LAMP * 0.85, 0.35 * uWarmth);
  col = fogCol * fogA + col * (1.0 - fogA);
  a = fogA + a * (1.0 - fogA);
  // Each droplet's dark refracting rim, and a glint of the lamp.
  float rim = 0.45 * drop * (1.0 - smoothstep(0.5, 0.8, cond.g));
  col = vec3(0.10, 0.12, 0.18) * rim + col * (1.0 - rim);
  a = rim + a * (1.0 - rim);
  col += LAMP * (cond.b * drop * (0.25 + 0.5 * uWarmth));
  // The lamp reflected in the glass, and the room's warm vignette (both additive).
  vec2 d = p - uReflect;
  float r2 = dot(d, d);
  col += LAMP * (uWarmth * (0.06 * exp(-r2 / 0.02) + 0.07 * exp(-r2 / 0.0005)));
  vec2 v = (p - vec2(0.5 * uAspect, 0.5)) / vec2(0.5 * uAspect, 0.5);
  col += LAMP * (uWarmth * 0.06 * smoothstep(0.5, 1.4, length(v)));
  return vec4(col, a);
}

void main() {
  float px = uInvHeight;
  vec2 p = gl_FragCoord.xy * px;
  // Fetched before any branch, so the derivative is defined.
  vec4 cond = texture(uCond, vec2(p.x / uAspect, p.y));
  float dropAa = max(fwidth(cond.g), 1e-3);
  float sd = 1e3;
  vec4 pane = vec4(0.0);
  for (int i = 0; i < MAX_PANES; i++) {
    if (i >= uPaneCount) break;
    float d = boxDist(p, uPane[i]);
    if (d < sd) {
      sd = d;
      pane = uPane[i];
    }
  }
  float glass = clamp(-sd / px + 0.5, 0.0, 1.0);
  vec4 c = vec4(0.0);
  if (glass < 1.0) c = vec4(frameShade(p, sd, pane, px), 1.0) * (1.0 - glass);
  if (glass > 0.0) c += glassLayer(p, pane, px, cond, dropAa) * glass;
  c.rgb += c.a * dither8(gl_FragCoord.xy);
  outColor = c;
}
`;

/**
 * Looking out through a lamplit window on a snowy evening: a soft, low-res
 * twilight scene (rendered only when it changes), the shared snowflakes falling
 * in front of it, then one full-res pass for the frame, the snow on the ledge,
 * the condensation in the pane corners and the room's warm light.
 */
export const snowWindow = defineEffect(snowWindowMeta, {
  create(gl) {
    return withScope((scope) => {
      const sceneProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SCENE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const glassProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, GLASS_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const flakeRenderer = scope.own(createFlakeRenderer(gl, MAX_SNOWFALL));
      /** The condensation mask, replaced when its size changes. */
      let condTexture: WebGLTexture | null = null;
      let condData = new Uint8Array(4);
      let condWidth = 0;
      let condHeight = 0;
      scope.defer(() => {
        gl.deleteTexture(condTexture);
      });

      const su = createUniforms(gl, sceneProgram, [
        "uInvLow",
        "uAspect",
        "uScene",
        "uSeed",
        "uPhase",
      ]);
      const gu = createUniforms(gl, glassProgram, [
        "uCond",
        "uPane",
        "uPaneCount",
        "uInvHeight",
        "uAspect",
        "uSill",
        "uFrame",
        "uWarmth",
        "uFog",
        "uPhase",
        "uReflect",
      ]);
      gl.useProgram(glassProgram);
      gu.i1("uCond", 0);
      gl.useProgram(null);

      const paneData = new Float32Array(MAX_PANES * 4);
      let paneCount = 0;
      /** Bottom of the window opening, height units. */
      let sill = 0;
      const layoutKey = createChangeKey(2);
      const condKey = createChangeKey(3);
      const settledAspect = createSettledValue<number>(INPUT_SETTLE);
      const settledSeed = createSettledValue<number>(INPUT_SETTLE);
      const sceneKey = createChangeKey(4);

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      const flakes = createFlakes(MAX_SNOWFALL, refWidth);
      const f: FlakeFrame = {
        refWidth,
        scale: 1,
        count: 0,
        speed: 0.8,
        wind: 0,
        gustiness: 0.3,
        sway: 0.45,
        size: 3.2,
        depthBlur: 0.7,
        brightness: 0.85,
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          flakes.rescaleX(newRefWidth / refWidth);
          ({ width, height } = v);
          refWidth = f.refWidth = newRefWidth;
          f.scale = v.scale;
          target.resize(width, height, Math.max(1, SCENE_DIVISOR * v.scale));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const seed = Math.floor(clamp(Number.isFinite(p.seed) ? p.seed : 0, 0, 1e6));
          const phase = (seed * 2.39996) % (Math.PI * 2);
          const layout = layoutId(p.layout);

          // Panes follow the layout and aspect at once (cheap). The condensation mask
          // (tens of ms to build) follows the aspect and seed once they settle, so a
          // window resize or a seed drag rebuilds it once; it stretches until then.
          layoutKey.set(0, LAYOUTS.indexOf(layout));
          layoutKey.set(1, aspect);
          if (layoutKey.take()) {
            const panes = windowPanes(layout, aspect);
            paneCount = panes.length;
            sill = interior(aspect)[1];
            paneData.fill(0);
            panes.forEach((r, i) => {
              paneData.set(r, i * 4);
            });
            gl.useProgram(glassProgram);
            gl.uniform4fv(gu.loc.uPane, paneData);
          }
          const condAspect = settledAspect.update(aspect, dt);
          const condSeed = settledSeed.update(seed, dt);
          condKey.set(0, LAYOUTS.indexOf(layout));
          condKey.set(1, condAspect);
          condKey.set(2, condSeed);
          if (condKey.take()) {
            const panes = windowPanes(layout, condAspect);
            const size = condensationSize(condAspect);
            if (size.width !== condWidth || size.height !== condHeight || !condTexture) {
              condWidth = size.width;
              condHeight = size.height;
              condData = new Uint8Array(condWidth * condHeight * 4);
              gl.deleteTexture(condTexture);
              condTexture = null;
              buildCondensation(condData, condWidth, condHeight, condAspect, panes, condSeed);
              condTexture = createDataTexture(gl, {
                width: condWidth,
                height: condHeight,
                internalFormat: gl.RGBA8,
                format: gl.RGBA,
                type: gl.UNSIGNED_BYTE,
                data: condData,
              });
            } else {
              buildCondensation(condData, condWidth, condHeight, condAspect, panes, condSeed);
              gl.activeTexture(gl.TEXTURE0);
              updateDataTexture(
                gl,
                condTexture,
                condWidth,
                condHeight,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                condData,
              );
            }
          }

          // The scene outside: static, so drawn only when it changes (or every
          // frame when the target renders straight to the canvas).
          sceneKey.set(0, sceneIndex(p.scene));
          sceneKey.set(1, seed);
          sceneKey.set(2, target.width);
          sceneKey.set(3, target.height);
          if (sceneKey.take() || target.direct) {
            gl.useProgram(sceneProgram);
            su.f2("uInvLow", aspect / target.width, 1 / target.height);
            su.f1("uAspect", aspect);
            su.i1("uScene", sceneIndex(p.scene));
            su.f1("uSeed", seed);
            su.f1("uPhase", phase);
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }
          target.blit();

          // Snow, behind the glass.
          f.count = clamp(p.snowfall, 0, MAX_SNOWFALL);
          f.wind = clamp(p.wind, -1, 1);
          const visible = flakes.step(dt, f, flakeRenderer.data, flakeRenderer.stride);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          if (visible > 0) {
            flakeRenderer.upload(visible);
            flakeRenderer.draw(0, visible, width, height, FLAKE_COLOR);
          }

          // The window itself.
          gl.useProgram(glassProgram);
          gu.i1("uPaneCount", paneCount);
          gu.f1("uInvHeight", 1 / height);
          gu.f1("uAspect", aspect);
          gu.f1("uSill", sill);
          gu.rgb("uFrame", p.frameColor);
          gu.f1("uWarmth", clamp(p.warmth, 0, 1));
          gu.f1("uFog", clamp(p.fog, 0, 1));
          gu.f1("uPhase", phase);
          gu.f2("uReflect", aspect * REFLECT_X, REFLECT_Y);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, condTexture);
          triangle.draw();
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
