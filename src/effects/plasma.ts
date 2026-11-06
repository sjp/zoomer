import type { Rgb } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createLowResTarget } from "./lowres";
import {
  BASE_BOT,
  BASE_BW,
  BASE_K,
  BASE_TOP,
  BASE_TW,
  BRANCH_SEGMENTS,
  branchPath,
  createLayout,
  createPlasma,
  CORE_R,
  filamentBrightness,
  filamentPath,
  MAX_BRANCHES,
  PALETTES,
  PATH_SEGMENTS,
  type PlasmaPalette,
  plasmaLayout,
  rainbowPalette,
  roomGlow,
  SEAT_Y,
  settlePlasma,
  stepPlasma,
  TABLE_Y,
} from "./plasma-sim";
import { MAX_FILAMENTS, plasmaMeta } from "./plasma.meta";
import { createSpriteBatch } from "./sprites";
import { createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";

/** Room pass: about 4 reference px per texel. It is all soft gradients. */
const ROOM_TEXEL_REF = 4;
/** Fixed filament layout, so the globe looks the same on every load. */
const SEED = 109;
/** The sphere radius the line widths are set for (height units: the default size). */
const REF_R = 0.21;

/**
 * Nested line widths (half widths in px at 1080p and the default size) with
 * their brightness and how far each moves from the glow colour to the
 * filament's own: a wide faint glow down to a thin bright core. Drawn with
 * max blending, so the nested lines give a soft, stepped profile, and the
 * joints of a path never stack into beads.
 */
const LEVEL_HW = [10, 5, 2.2, 0.8];
const LEVEL_I = [0.12, 0.25, 0.5, 1];
const LEVEL_MIX = [0, 0.3, 0.7, 1];
const LEVELS = LEVEL_HW.length;
/** Streak instances: every segment of every path and branch, at every level. */
const MAX_STREAKS = MAX_FILAMENTS * (PATH_SEGMENTS + MAX_BRANCHES * BRANCH_SEGMENTS) * LEVELS;
/** Branch brightness and width relative to the main path. */
const BRANCH_I = 0.6;
const BRANCH_W = 0.7;
/** How much a filament dims from the electrode out to the glass. */
const OUTER_DIM = 0.35;
/** Contact spots on the glass: radius (globe units) and brightness, main and branch. */
const SPOT_R = 0.1;
const SPOT_I = 0.6;
const BRANCH_SPOT_R = 0.06;
const BRANCH_SPOT_I = 0.3;
/** Spots and the core are sprites: x, y, radius, squash; dir x, y, kind, -; r, g, b. */
const SPRITE_ATTRS = [4, 4, 3];
const SPRITE_STRIDE = 11;
const MAX_SPRITES = MAX_FILAMENTS * (1 + MAX_BRANCHES) + 1;
/** The core sprite's radius (globe units): the electrode ball is a fifth of it. */
const CORE_SPRITE_R = CORE_R / 0.2;

const g = glslFloat;

/**
 * The room at low resolution: a dark wall and a dark table, both washed by the
 * globe's coloured glow, and a vignette. Static, so it re-renders only when the
 * layout, the colour or the canvas changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** Sphere centre and radius (height units). */
uniform vec3 uGlobe;
uniform vec3 uGlow;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  vec3 wall = vec3(0.022, 0.02, 0.03) * (0.75 + 0.25 * p.y);
  vec2 d = (p - uGlobe.xy) / uGlobe.z;
  wall += uGlow * 0.14 / (1.0 + 0.3 * dot(d, d));
  // The table: a little lighter towards the front, with a pool of glow round the base.
  vec3 table = vec3(0.03, 0.027, 0.032) * (1.2 - p.y * 2.0);
  vec2 t = vec2(p.x - uGlobe.x, (p.y - ${g(SEAT_Y)}) * 3.0) / uGlobe.z;
  table += uGlow * 0.2 / (1.0 + 0.5 * dot(t, t));
  // A faint highlight along the table's back edge.
  float edge = 1.0 - smoothstep(0.0, 0.006, abs(p.y - ${g(TABLE_Y)}));
  table += uGlow * 0.06 * edge / (1.0 + 0.3 * d.x * d.x);
  float onTable = 1.0 - smoothstep(${g(TABLE_Y - 0.002)}, ${g(TABLE_Y + 0.002)}, p.y);
  vec3 col = mix(wall, table, onTable);
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.5 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/** Shared GLSL for the two globe passes: the local frame, coverage, and the base. */
const GLOBE_COMMON = /* glsl */ `
/** One device px in height units. */
uniform float uPx;
/** Sphere centre (height units), radius, and side (+1: globe in the right corner). */
uniform vec4 uGlobe;
uniform vec3 uGlow;
/** One device px in globe units, set by localPos. */
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
/** The front arc of the base's top ellipse: the collar the sphere sits in. */
float baseArc(float x) {
  float u = x / ${g(BASE_TW)};
  return ${g(BASE_TOP)} - ${g(BASE_K * BASE_TW)} * sqrt(max(1.0 - u * u, 0.0));
}
/** Signed distance (approx.) to the base's front, which hides the sphere's foot. */
float baseFront(vec2 q) {
  float side = max(max(abs(q.x) - baseHalf(q.y), q.y - baseArc(q.x)), ${g(BASE_BOT)} - q.y);
  return min(side, sdEllipse(q - vec2(0.0, ${g(BASE_BOT)}), vec2(${g(BASE_BW)}, ${g(BASE_BW * BASE_K)})));
}
vec2 localPos() {
  pxU = uPx / uGlobe.z;
  return (gl_FragCoord.xy * uPx - uGlobe.xy) / uGlobe.z;
}
`;

/**
 * Behind the filaments, premultiplied over the room: the gas inside the
 * sphere, darkening the room seen through it a little and glowing faintly
 * towards the middle.
 */
const GAS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
${DITHER_GLSL}
${GLOBE_COMMON}
void main() {
  vec2 q = localPos();
  float r2 = dot(q, q);
  float m = cov(sqrt(r2) - 1.0);
  vec3 gas = uGlow * (0.035 + 0.1 * exp(-2.5 * r2));
  float a = 0.5;
  outColor = vec4((gas + dither8(gl_FragCoord.xy) * a) * m, a * m);
}
`;

/**
 * In front of the filaments, premultiplied: the glass (a Fresnel rim lit by the
 * plasma, a soft reflection of the room and one small highlight) and the black
 * base, which hides the sphere's foot and any filament behind it.
 */
const FRONT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
${DITHER_GLSL}
${GLOBE_COMMON}
void main() {
  vec2 q = localPos();
  float r = length(q);
  vec4 acc = vec4(0.0);
  float sphere = cov(r - 1.0);
  if (sphere > 0.0) {
    float z = sqrt(max(1.0 - r * r, 0.0));
    float fres = (1.0 - z) * (1.0 - z) * (1.0 - z);
    float rim = smoothstep(0.96, 0.99, r) * (1.0 - smoothstep(0.995, 1.0, r));
    vec3 col = (uGlow * 0.5 + 0.12) * fres * 0.3 + uGlow * 0.3 * rim;
    float a = 0.06 * fres;
    // The room behind the viewer, bent over the sphere: a dim doorway towards the frame's middle.
    vec2 w = q / (1.0 + z);
    w.x *= -uGlobe.w;
    vec2 wd = abs(w - vec2(0.3, 0.28)) - vec2(0.1, 0.17);
    float door = 1.0 - smoothstep(-0.03, 0.04, max(wd.x, wd.y));
    col += vec3(0.05, 0.05, 0.06) * door;
    vec2 h = (vec2(q.x * -uGlobe.w, q.y) - vec2(0.45, 0.55)) * vec2(1.0, 1.4);
    col += vec3(0.3) * exp(-dot(h, h) * 150.0) + vec3(0.03) * exp(-dot(h, h) * 10.0);
    acc = vec4(col, a) * sphere;
  }
  float bf = cov(baseFront(q));
  if (bf > 0.0) {
    // Glossy black, shaded as a drum: a soft sheen towards the frame's middle,
    // and the plasma's light on the collar's lip.
    float nx = clamp(q.x / baseHalf(q.y), -1.0, 1.0) * -uGlobe.w;
    float sheen = exp(-(nx - 0.45) * (nx - 0.45) * 30.0);
    vec3 col = vec3(0.012, 0.011, 0.014) + vec3(0.05) * sheen;
    float lip = 1.0 - smoothstep(0.0, 0.06, baseArc(q.x) - q.y);
    col += uGlow * (0.25 * lip + 0.04) * (1.0 - 0.6 * nx * nx);
    acc = vec4(col, 1.0) * bf + acc * (1.0 - bf);
  }
  outColor = vec4(acc.rgb + dither8(gl_FragCoord.xy) * acc.a, acc.a);
}
`;

/**
 * Contact spots and the electrode, as additive sprites. A spot is a soft
 * ellipse, squashed along the sphere's radius where the glass turns away; the
 * core (kind 1) is a bright ball in a wide halo.
 */
const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (height units), radius (height units), squash along dir. */
layout(location = 1) in vec4 aSpot;
/** Squash direction, kind (0 spot, 1 core). */
layout(location = 2) in vec4 aDir;
/** Colour, brightness included. */
layout(location = 3) in vec3 aColor;
/** 2 / frame size in height units. */
uniform vec2 uToClip;
out vec2 vLocal;
flat out float vKind;
flat out vec3 vColor;
void main() {
  vec2 perp = vec2(-aDir.y, aDir.x);
  vec2 off = (aDir.xy * (aCorner.x * aSpot.w) + perp * aCorner.y) * aSpot.z;
  vLocal = aCorner;
  vKind = aDir.z;
  vColor = aColor;
  gl_Position = vec4((aSpot.xy + off) * uToClip - 1.0, 0.0, 1.0);
}
`;

const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vKind;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float d2 = dot(vLocal, vLocal);
  vec3 col;
  if (vKind < 0.5) {
    // exp(-4) at the quad's edge: subtracted so the spot ends at zero.
    float a = max(exp(-4.0 * d2) - 0.0183, 0.0);
    col = vColor * (a + 0.8 * exp(-24.0 * d2));
  } else {
    float d = sqrt(d2);
    float aa = max(fwidth(d), 1e-3);
    float ball = 1.0 - smoothstep(0.2 - aa, 0.2, d);
    float shade = 0.75 + 0.25 * sqrt(max(1.0 - d2 * 25.0, 0.0));
    float halo = max(exp(-7.0 * d2) - 0.0009, 0.0);
    col = mix(vColor, vec3(1.0), 0.65) * ball * shade + vColor * 0.55 * halo;
  }
  outColor = vec4(col, 0.0);
}
`;

/**
 * A plasma globe on a table in a bottom corner: soft filaments wander from the
 * electrode to the glass, branching near their ends and pooling in soft spots.
 *
 * Passes: the room at 1/4 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; then, scissored to the globe's box, the
 * gas behind the filaments, the filaments as nested streaks (max blend), the
 * contact spots and the electrode as additive sprites, and the glass and base
 * in front. Paths, brightness and colours come from plasma-sim.ts.
 */
export const plasma = defineEffect(plasmaMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const streaks = scope.own(createStreakRenderer(gl, MAX_STREAKS, { blend: "max" }));
      const sprites = scope.own(createSpriteBatch(gl, MAX_SPRITES, SPRITE_ATTRS));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });

      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uPxToH", "uFrame", "uGlobe", "uGlow"]);
      const gasProgram = program(FULLSCREEN_VERTEX, GAS_FRAGMENT);
      const gu = createUniforms(gl, gasProgram, ["uPx", "uGlobe", "uGlow"]);
      const frontProgram = program(FULLSCREEN_VERTEX, FRONT_FRAGMENT);
      const fu = createUniforms(gl, frontProgram, ["uPx", "uGlobe", "uGlow"]);
      const spriteProgram = program(SPRITE_VERTEX, SPRITE_FRAGMENT);
      const su = createUniforms(gl, spriteProgram, ["uToClip"]);

      const layout = createLayout();
      const sim = createPlasma(SEED);
      let settled = false;
      const path = new Float64Array(3 * (PATH_SEGMENTS + 1));
      const branch = new Float64Array(3 * (BRANCH_SEGMENTS + 1));
      const branchDir = new Float64Array(3);
      const rainbow: PlasmaPalette = { root: [0, 0, 0], tip: [0, 0, 0], glow: [0, 0, 0] };
      const segColor: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      /** What the room target holds; reset whenever it may have been reallocated. */
      let roomKey = "";
      let roomCx = Number.NaN;
      let roomCy = Number.NaN;
      let roomR = Number.NaN;

      // Per-frame state for the writers below, set at the start of each frame.
      let streakCount = 0;
      let spriteCount = 0;
      /** Globe centre in device px (y down) and radius in device px. */
      let gx = 0;
      let gy = 0;
      let gr = 0;
      /** Line width scale: device px per reference px. */
      let wScale = 1;

      /** Writes one path segment (globe units) at every level of the nested lines. */
      const segment = (
        pts: Float64Array,
        k: number,
        pal: PlasmaPalette,
        s: number,
        intensity: number,
        widthK: number,
      ) => {
        const o = 3 * k;
        const ax = gx + pts[o] * gr;
        const ay = gy - pts[o + 1] * gr;
        const bx = gx + pts[o + 3] * gr;
        const by = gy - pts[o + 4] * gr;
        // Filaments behind the electrode are a little dimmer, seen through more gas.
        const depth = 0.8 + 0.1 * (pts[o + 2] + pts[o + 5]);
        const t = s * Math.sqrt(s);
        const k0 = intensity * depth;
        for (let c = 0; c < 3; c++) segColor[c] = pal.root[c] + (pal.tip[c] - pal.root[c]) * t;
        const data = streaks.data;
        for (let l = 0; l < LEVELS; l++) {
          const i = streakCount++ * STREAK_FLOATS;
          const m = LEVEL_MIX[l];
          const li = LEVEL_I[l] * k0;
          data[i] = ax;
          data[i + 1] = ay;
          data[i + 2] = bx;
          data[i + 3] = by;
          data[i + 4] = (pal.glow[0] + (segColor[0] - pal.glow[0]) * m) * li;
          data[i + 5] = (pal.glow[1] + (segColor[1] - pal.glow[1]) * m) * li;
          data[i + 6] = (pal.glow[2] + (segColor[2] - pal.glow[2]) * m) * li;
          data[i + 7] = LEVEL_HW[l] * wScale * widthK;
        }
      };

      /** Writes a sprite at globe-unit point (x, y, z) on the glass. */
      const spot = (x: number, y: number, z: number, radius: number, col: Rgb, k: number) => {
        const i = spriteCount++ * SPRITE_STRIDE;
        const data = sprites.data;
        const len = Math.hypot(x, y);
        const depth = 0.8 + 0.2 * z;
        data[i] = layout.cx + x * layout.r;
        data[i + 1] = layout.cy + y * layout.r;
        data[i + 2] = radius * layout.r;
        // Foreshortened along the sphere's radius as the glass turns away.
        data[i + 3] = Math.max(Math.abs(z), 0.3);
        data[i + 4] = len > 1e-3 ? x / len : 1;
        data[i + 5] = len > 1e-3 ? y / len : 0;
        data[i + 6] = 0;
        data[i + 7] = 0;
        data[i + 8] = col[0] * k * depth;
        data[i + 9] = col[1] * k * depth;
        data[i + 10] = col[2] * k * depth;
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
          roomKey = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          plasmaLayout(aspect, p.corner, p.size, layout);
          if (!settled) {
            settlePlasma(sim, p.filaments);
            settled = true;
          }
          stepPlasma(sim, dt, p.filaments, p.drift);
          const glow = roomGlow(p.colour);
          const px = 1 / height;

          // 1. The room, re-rendered only when it changes, upscaled every frame.
          if (
            target.direct ||
            roomKey !== p.colour ||
            roomCx !== layout.cx ||
            roomCy !== layout.cy ||
            roomR !== layout.r
          ) {
            target.bind();
            gl.useProgram(roomProgram);
            ru.f2("uFrame", aspect, 1);
            ru.f3("uGlobe", layout.cx, layout.cy, layout.r);
            ru.v3("uGlow", glow);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            roomKey = p.colour;
            roomCx = layout.cx;
            roomCy = layout.cy;
            roomR = layout.r;
          }
          target.blit();

          // 2. The gas, premultiplied, in the globe's box.
          gl.viewport(0, 0, width, height);
          const box = layout.box;
          const sx0 = Math.max(0, Math.floor(box[0] * height));
          const sy0 = Math.max(0, Math.floor(box[1] * height));
          const sx1 = Math.min(width, Math.ceil(box[2] * height));
          const sy1 = Math.min(height, Math.ceil(box[3] * height));
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(sx0, sy0, Math.max(0, sx1 - sx0), Math.max(0, sy1 - sy0));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(gasProgram);
          gu.f1("uPx", px);
          gu.f4("uGlobe", layout.cx, layout.cy, layout.r, layout.side);
          gu.v3("uGlow", glow);
          triangle.draw();

          // 3. The filaments, and the spots where they touch the glass.
          gx = layout.cx * height;
          gy = (1 - layout.cy) * height;
          gr = layout.r * height;
          wScale = (height / 1080) * (layout.r / REF_R);
          streakCount = 0;
          spriteCount = 0;
          const isRainbow = p.colour === "rainbow";
          const fixed = PALETTES[p.colour] ?? PALETTES.violet;
          for (let i = 0; i < MAX_FILAMENTS; i++) {
            const b = filamentBrightness(sim, i);
            if (b <= 1e-3) continue;
            const pal = isRainbow ? rainbowPalette(sim, i, rainbow) : fixed;
            filamentPath(sim, i, path);
            for (let k = 0; k < PATH_SEGMENTS; k++) {
              const s = (k + 0.5) / PATH_SEGMENTS;
              segment(path, k, pal, s, b * (1 - OUTER_DIM * s), 1);
            }
            const e = 3 * PATH_SEGMENTS;
            spot(path[e], path[e + 1], path[e + 2], SPOT_R, pal.tip, SPOT_I * b);
            for (let j = 0; j < sim.branches[i]; j++) {
              branchPath(sim, i, j, path, branchDir, branch);
              for (let k = 0; k < BRANCH_SEGMENTS; k++) {
                const u = (k + 0.5) / BRANCH_SEGMENTS;
                segment(branch, k, pal, 0.7 + 0.3 * u, b * BRANCH_I * (1 - 0.3 * u), BRANCH_W);
              }
              const be = 3 * BRANCH_SEGMENTS;
              spot(
                branch[be],
                branch[be + 1],
                branch[be + 2],
                BRANCH_SPOT_R,
                pal.tip,
                BRANCH_SPOT_I * b,
              );
            }
          }
          if (streakCount > 0) {
            streaks.upload(streakCount);
            streaks.draw(streakCount, width, height);
          }

          // 4. Spots and the electrode, additive. The core takes the first filament's glow.
          const coreCol = isRainbow ? glow : fixed.root;
          const c = spriteCount++ * SPRITE_STRIDE;
          const sd = sprites.data;
          sd[c] = layout.cx;
          sd[c + 1] = layout.cy;
          sd[c + 2] = CORE_SPRITE_R * layout.r;
          sd[c + 3] = 1;
          sd[c + 4] = 1;
          sd[c + 5] = 0;
          sd[c + 6] = 1;
          sd[c + 7] = 0;
          sd[c + 8] = coreCol[0];
          sd[c + 9] = coreCol[1];
          sd[c + 10] = coreCol[2];
          sprites.upload(spriteCount);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.useProgram(spriteProgram);
          su.f2("uToClip", 2 / aspect, 2);
          sprites.draw(0, spriteCount);

          // 5. The glass and the base, premultiplied.
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(frontProgram);
          fu.f1("uPx", px);
          fu.f4("uGlobe", layout.cx, layout.cy, layout.r, layout.side);
          fu.v3("uGlow", glow);
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
