import { createCanvasTexture, MONO_FONT_STACK } from "../canvas-texture";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  scopedProgram,
  updateDataTexture,
  withScope,
} from "../gl";
import { GRID_DDA_GLSL } from "../grid-walk";
import { createLowResTarget } from "../lowres";
import { approach, clamp, smoothstep } from "../math";
import { VALUE_NOISE_GLSL } from "../noise";
import { defineEffect } from "../types";
import { backroomsMeta } from "./backrooms.meta";
import {
  advanceFlicker,
  advanceWalker,
  createFlicker,
  createWalker,
  createWorld,
  fillWindow,
  type Flicker,
  flickerLevel,
  MAX_FLICKERS,
  PANEL_LIT,
  PILLAR,
  reseedWorld,
  resetWalker,
  VIEW_REACH,
  WALL,
  walkRate,
  WINDOW,
  windowOrigin,
} from "./backrooms-sim";

/** Ceiling height and eye height, in cells (a cell is about 1.2 m). */
const CEIL = 2.2;
const EYE = 1.3;
/** Focal length in frame heights. */
const FOCAL = 1;
/** The haze is complete this far away (cells) at a haze of 1; at 0, as far as the window reaches. */
const NEAR_HAZE = 6;
/** Found footage renders this many lines tall (at least), upscaled smoothly. */
const FOOTAGE_LINES = 480;
/** Found footage head bob: height in cells, and bobs per cell walked. */
const BOB = 0.012;
const BOBS_PER_CELL = 1;
/** Seconds to fade to black on a variation change, and back. */
const RESET_FADE = 1.2;
/** Seconds of the dip to black and back that switches between the styles. */
const STYLE_DIP = 0.5;
/** Seconds a haze change eases over (per full slider range). */
const HAZE_EASE = 1;
/** Camcorder overlay, in px at 1080p: text size and margin from the frame's edge. */
const OSD_PX = 36;
const OSD_MARGIN = 54;
/** Seconds per pulse of the REC dot: a slow glow, never a blink. */
const REC_PULSE = 2;
/** Where unused flicker slots point: no cell of the window. */
const NO_CELL = -1000;
const MONTHS = [
  "JAN.",
  "FEB.",
  "MAR.",
  "APR.",
  "MAY",
  "JUN.",
  "JUL.",
  "AUG.",
  "SEP.",
  "OCT.",
  "NOV.",
  "DEC.",
] as const;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

/** One texel per window cell, values 0..255: r = kind (open, wall, pillar), g = panel above. */
uniform sampler2D uCells;
/** Maps gl_FragCoord to frame heights from the centre, y up. */
uniform vec2 uPixScale;
uniform vec2 uPixOffset;
/** Camera position in window cells, and eye height. */
uniform vec3 uCam;
/** Heading (x, y). */
uniform vec2 uView;
/** The window's south-west cell in the world, so patterns stay put when the window moves. */
uniform vec2 uOrigin;
/** Horizontal distance at which the haze is complete, cells. */
uniform float uFar;
/** Flickering panels: window cell (x, y) and brightness. */
uniform vec3 uFlick[${String(MAX_FLICKERS)}];
uniform float uFade;

out vec4 outColor;

const int WINDOW = ${String(WINDOW)};
const int MAX_STEPS = ${String(2 * VIEW_REACH + 2)};
const int FLICKERS = ${String(MAX_FLICKERS)};
const int WALL = ${String(WALL)};
const int PILLAR = ${String(PILLAR)};
const int PANEL_LIT = ${String(PANEL_LIT)};
const float FOCAL = ${glslFloat(FOCAL)};
const float CEIL = ${glslFloat(CEIL)};
const float PILLAR_HALF = 0.22;
const vec3 WALLPAPER = vec3(0.8, 0.7, 0.4);
const vec3 WALL_INK = vec3(0.64, 0.55, 0.28);
const vec3 BASEBOARD = vec3(0.47, 0.39, 0.24);
const vec3 STAIN = vec3(0.5, 0.41, 0.22);
const vec3 CARPET = vec3(0.56, 0.48, 0.33);
const vec3 DAMP = vec3(0.38, 0.32, 0.21);
const vec3 TILE = vec3(0.86, 0.84, 0.75);
const vec3 GROUT = vec3(0.66, 0.64, 0.56);
const vec3 FRAME = vec3(0.8, 0.79, 0.74);
const vec3 LENS_ON = vec3(1.0, 1.0, 0.93);
const vec3 LENS_OFF = vec3(0.6, 0.6, 0.56);
/** The light's slight greenish-yellow cast, and the haze far rooms dissolve into. */
const vec3 TINT = vec3(1.0, 0.98, 0.8);
const vec3 HAZE = vec3(0.84, 0.79, 0.55);
const float AMBIENT = 0.55;
const float DIRECT = 0.75;

${VALUE_NOISE_GLSL}
${DITHER_GLSL}
${GRID_DDA_GLSL}

/** Kind and panel of window cell c; outside the window, wall. */
ivec2 cellAt(ivec2 c) {
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, ivec2(WINDOW)))) {
    return ivec2(WALL, 0);
  }
  return ivec2(texelFetch(uCells, c, 0).rg * 255.0 + 0.5);
}

/** Brightness of the panel over cell c: 0 if none or dead. */
float panelLevel(ivec2 c) {
  if (cellAt(c).y != PANEL_LIT) {
    return 0.0;
  }
  float b = 1.0;
  for (int k = 0; k < FLICKERS; k++) {
    if (c == ivec2(uFlick[k].xy)) {
      b *= uFlick[k].z;
    }
  }
  return b;
}

/**
 * The panels' light at p (window cells, z up) on a surface facing n: x the
 * direct light, y the glow round them on the ceiling. Panels sit on the even
 * cells; the nine nearest are summed, each faded out by 3 cells so none pops as
 * the set changes. No shadows.
 */
vec2 panelLight(vec3 p, vec3 n) {
  ivec2 mid = ivec2(round((p.xy - 0.5) * 0.5)) * 2;
  vec2 sum = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 c = mid + ivec2(i, j) * 2;
      float b = panelLevel(c);
      if (b <= 0.0) {
        continue;
      }
      vec3 l = vec3(vec2(c) + 0.5, CEIL) - p;
      float r2 = dot(l.xy, l.xy);
      float w = max(1.0 - r2 / 9.0, 0.0);
      w *= w;
      float d2 = r2 + l.z * l.z;
      float lambert = max(dot(n, l), 0.0) * inversesqrt(max(d2, 1e-4));
      sum.x += b * w * lambert * 2.5 / (2.5 + d2);
      sum.y += b * w * exp(-2.0 * r2);
    }
  }
  return sum;
}

/** Ray against the square pillar in cell c: t (or -1) and the face's normal. */
float pillarHit(ivec2 c, vec3 ro, vec3 rd, out vec2 n) {
  vec2 ctr = vec2(c) + 0.5;
  vec2 dd = vec2(abs(rd.x) < 1e-6 ? 1e-6 : rd.x, abs(rd.y) < 1e-6 ? 1e-6 : rd.y);
  vec2 t1 = (ctr - PILLAR_HALF - ro.xy) / dd;
  vec2 t2 = (ctr + PILLAR_HALF - ro.xy) / dd;
  vec2 tn = min(t1, t2);
  vec2 tf = max(t1, t2);
  float a = max(tn.x, tn.y);
  n = tn.x > tn.y ? vec2(-sign(dd.x), 0.0) : vec2(0.0, -sign(dd.y));
  return a <= min(tf.x, tf.y) ? a : -1.0;
}

/** Wallpaper at g (world cells along the wall, height), patterns filtered over fw. */
vec3 wallpaperColour(vec2 g, float fw) {
  // Strips half a cell wide, each with a faint chevron and a pinstripe at its edge.
  float zz = abs(fract(g.x * 2.0) - 0.5);
  float band = fract(g.y * 5.0 + zz * 1.2);
  float pw = fw * 5.0;
  float chevron = smoothstep(0.42 - pw, 0.46 + pw, abs(band - 0.5));
  float pin = smoothstep(0.47 - 2.0 * fw, 0.49 + 2.0 * fw, zz);
  float k = 1.0 - smoothstep(0.03, 0.08, fw);
  vec3 c = mix(WALLPAPER, WALL_INK, (0.5 * chevron + 0.6 * pin) * 0.5 * k);
  // Damp creeping up from the floor, and the odd water stain.
  c *= mix(0.8, 1.0, smoothstep(0.0, 0.9, g.y));
  float stain = smoothstep(0.58, 0.8, vnoise(vec2(g.x * 0.9, g.y * 1.4), 3.0));
  c = mix(c, STAIN, 0.45 * stain * (1.0 - smoothstep(0.4, 1.6, g.y)));
  // A plain skirting board.
  return mix(c, BASEBOARD, 1.0 - smoothstep(0.075 - fw, 0.075 + fw, g.y));
}

/** Carpet at g (world cells): a soft pile, filtered out as it shrinks, and dark damp patches. */
vec3 carpetColour(vec2 g, float fw) {
  float k1 = 1.0 - smoothstep(0.02, 0.08, fw);
  float k2 = 1.0 - smoothstep(0.008, 0.03, fw);
  float pile = (vnoise(g * 9.0, 5.0) - 0.5) * k1 + 0.6 * (vnoise(g * 23.0, 6.0) - 0.5) * k2;
  vec3 c = CARPET * (1.0 + 0.16 * pile);
  float damp = smoothstep(0.6, 0.78, 0.7 * vnoise(g * 0.45, 9.0) + 0.3 * vnoise(g * 1.3, 10.0));
  return mix(c, DAMP, 0.65 * damp);
}

/** The drop ceiling at q (window cells; g the same in world cells): tiles, and a panel on even cells. */
vec3 ceilingColour(vec2 q, vec2 g, float fw) {
  // Tiles half a cell square, offset a quarter cell in x so one sits centred in each cell.
  vec2 f = abs(fract(vec2(q.x + 0.25, q.y) * 2.0) - 0.5);
  float d = (0.5 - max(f.x, f.y)) * 0.5;
  float grout = 1.0 - smoothstep(0.006, 0.01 + 1.5 * fw, d);
  float v = hash2(floor(vec2(g.x + 0.25, g.y) * 2.0), 21.0);
  vec3 c = mix(TILE * (0.97 + 0.05 * v), GROUT, grout * (1.0 - smoothstep(0.02, 0.06, fw)));
  float glow = panelLight(vec3(q, CEIL), vec3(0.0, 0.0, -1.0)).y;
  c *= 0.62 + 0.4 * glow;
  // A diffuser one tile wide and two long in a metal frame, lit or dead.
  ivec2 cell = ivec2(floor(q));
  if (((cell.x | cell.y) & 1) == 0) {
    int panel = cellAt(cell).y;
    if (panel > 0) {
      vec2 o = abs(q - vec2(cell) - 0.5);
      float frame = smoothstep(-fw, fw, min(0.25 - o.x, 0.5 - o.y));
      float lens = smoothstep(-fw, fw, min(0.215 - o.x, 0.465 - o.y));
      vec3 lit = mix(LENS_OFF, LENS_ON, panelLevel(cell));
      c = mix(mix(c, FRAME * (0.62 + 0.4 * glow), frame), lit, lens);
    }
  }
  return c;
}

void main() {
  vec2 p = gl_FragCoord.xy * uPixScale + uPixOffset;
  vec2 fwd = uView;
  vec2 right = vec2(fwd.y, -fwd.x);
  vec3 rd = vec3(fwd * FOCAL + right * p.x, p.y);
  vec3 ro = uCam;

  // DDA through the window's cells; t is in units of rd.
  GridRay ray = gridRay(ro.xy, rd.xy);
  float tPlane = rd.z > 1e-6 ? (CEIL - ro.z) / rd.z : (rd.z < -1e-6 ? -ro.z / rd.z : 1e9);
  float tFar = uFar / length(rd.xy);
  // Surfaces: 0 floor or ceiling, 1 wall across x, 2 wall across y, 3 pillar, 4 lost in the haze.
  int surf = 4;
  float t = tFar;
  vec2 pn = vec2(0.0);
  int kind = cellAt(ray.cell).x;
  for (int i = 0; i < MAX_STEPS; i++) {
    float tNext = gridNext(ray);
    if (kind == PILLAR) {
      float tp = pillarHit(ray.cell, ro, rd, pn);
      if (tp > 0.0 && tp < min(tNext, tPlane)) {
        surf = 3;
        t = tp;
        break;
      }
    }
    if (tPlane <= tNext) {
      surf = 0;
      t = tPlane;
      break;
    }
    if (tNext > tFar) {
      break;
    }
    int axis = gridStep(ray, t);
    kind = cellAt(ray.cell).x;
    if (kind == WALL) {
      surf = 1 + axis;
      break;
    }
  }
  if (surf == 4) {
    t = tFar;
  }

  vec3 hit = ro + rd * t;
  vec3 n = surf == 0
    ? vec3(0.0, 0.0, rd.z > 0.0 ? -1.0 : 1.0)
    : (surf == 1 ? vec3(-float(ray.stp.x), 0.0, 0.0)
    : (surf == 2 ? vec3(0.0, -float(ray.stp.y), 0.0) : vec3(pn, 0.0)));
  // World surface coordinates in cells (along the surface, up), set for every
  // pixel so their derivatives are taken in uniform control flow: the filter
  // width for the patterns.
  bool acrossX = abs(n.x) > 0.5;
  vec2 g = surf == 0
    ? hit.xy + uOrigin
    : (acrossX ? vec2(hit.y + uOrigin.y, hit.z) : vec2(hit.x + uOrigin.x, hit.z));
  float fw = min(length(fwidth(g)), 1.0);

  vec3 col;
  if (surf == 4) {
    col = HAZE;
  } else if (surf == 0 && rd.z > 0.0) {
    col = ceilingColour(hit.xy, g, fw) * TINT;
  } else {
    vec3 albedo = surf == 0 ? carpetColour(g, fw) : wallpaperColour(g, fw);
    float light = AMBIENT + DIRECT * panelLight(hit + n * 0.02, n).x;
    col = albedo * light * TINT;
  }
  // Far rooms dissolve into the haze, completely by uFar.
  float x = t * length(rd.xy) / uFar;
  float fog = clamp((1.0 - exp(-4.0 * x * x)) / (1.0 - exp(-4.0)), 0.0, 1.0);
  col = mix(col, HAZE, fog);
  outColor = vec4(clamp(col * uFade, 0.0, 1.0) + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** The camcorder upscale: a slight colour fringe towards the edges and a soft vignette. */
const FOOTAGE_COMPOSITE = /* glsl */ `
uniform float uAspect;
vec4 composite(vec2 uv) {
  vec2 d = uv - 0.5;
  vec2 off = d * 0.006;
  vec3 c = vec3(texture(uLowRes, uv + off).r, texture(uLowRes, uv).g, texture(uLowRes, uv - off).b);
  float r = length(d * vec2(uAspect, 1.0)) / length(vec2(0.5 * uAspect, 0.5));
  c *= 1.0 - 0.5 * smoothstep(0.3, 1.0, r);
  return vec4(c, 1.0);
}
`;

/** Draws a premultiplied canvas texture into the viewport (set to its rectangle). */
const OVERLAY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)) * uAlpha;
}
`;

const hazeParam = (v: number) => clamp(Number.isFinite(v) ? v : 0.5, 0, 1);

const two = (n: number) => (n < 10 ? "0" : "") + String(n);

/** Paints the camcorder date stamp, right-aligned in two lines: "PM 3:04:05", "NOV. 14 2026". */
function paintStamp(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number, ms: number) {
  const d = new Date(ms);
  const hours = d.getHours();
  const line1 = `${hours < 12 ? "AM" : "PM"} ${String(hours % 12 === 0 ? 12 : hours % 12)}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const line2 = `${MONTHS[d.getMonth()]} ${String(d.getDate())} ${String(d.getFullYear())}`;
  ctx.clearRect(0, 0, w, h);
  osdText(ctx, h / 2.6, w - h * 0.06, h * 0.06, line1, "right");
  osdText(ctx, h / 2.6, w - h * 0.06, h * 0.06 + h / 2.2, line2, "right");
}

/** Paints the "REC" label beside the space left for its dot. */
function paintRec(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  osdText(ctx, h / 1.3, h * 0.06, h * 0.12, "REC", "left");
}

/** Paints the REC dot: a red disc with a dark rim. */
function paintDot(ctx: OffscreenCanvasRenderingContext2D, size: number) {
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = "#e8231c";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  ctx.lineWidth = size * 0.08;
  ctx.stroke();
  ctx.fill();
}

/** White on-screen-display text with a dark outline, as camcorders print it. */
function osdText(
  ctx: OffscreenCanvasRenderingContext2D,
  px: number,
  x: number,
  y: number,
  text: string,
  align: CanvasTextAlign,
) {
  ctx.font = `bold ${String(Math.round(px))}px ${MONO_FONT_STACK}`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, px * 0.14);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#f4f4ee";
  ctx.fillText(text, x, y);
}

/** A 2D context on a new canvas of the given size, or null without OffscreenCanvas (tests, old browsers). */
function canvas2d(w: number, h: number): OffscreenCanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === "undefined") {
    return null;
  }
  return new OffscreenCanvas(w, h).getContext("2d");
}

/**
 * The Backrooms: a slow first-person walk through endless empty yellow office
 * rooms, on a long straight route that bends only now and then. A fragment shader casts one ray per pixel through a window of cells
 * round the camera (the shared grid DDA over a small data texture), shades
 * wallpapered walls and pillars, damp carpet and a drop ceiling of tiles and
 * light panels, lights them from the nearest panels, and fades the distance
 * into a yellow haze. Found footage renders at camcorder resolution with a
 * colour fringe, a vignette, a REC dot and a date stamp.
 */
export const backrooms = defineEffect(backroomsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const overlay = scopedProgram(gl, scope, FULLSCREEN_VERTEX, OVERLAY_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { composite: FOOTAGE_COMPOSITE }));
      const texData = new Uint8Array(WINDOW * WINDOW * 4);
      const texture = scope.add(
        createDataTexture(gl, {
          width: WINDOW,
          height: WINDOW,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: texData,
          filter: gl.NEAREST,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const u = createUniforms(gl, program, [
        "uCells",
        "uPixScale",
        "uPixOffset",
        "uCam",
        "uView",
        "uOrigin",
        "uFar",
        "uFlick",
        "uFade",
      ]);
      gl.useProgram(program);
      u.i1("uCells", 0);
      const ou = createUniforms(gl, overlay, ["uTex", "uAlpha"]);
      gl.useProgram(overlay);
      ou.i1("uTex", 0);
      const cu = createUniforms(gl, target.program, ["uAspect"]);
      const flickData = new Float32Array(MAX_FLICKERS * 3);

      const stampTex = createCanvasTexture(gl, scope, { premultiply: true });
      const recTex = createCanvasTexture(gl, scope, { premultiply: true });
      const dotTex = createCanvasTexture(gl, scope, { premultiply: true });
      let stampCtx: OffscreenCanvasRenderingContext2D | null = null;
      /** Overlay sizes in px: text line, stamp width and height, REC label width, dot side, margin. */
      let osd = 0;
      let stampW = 1;
      let stampH = 1;
      let recW = 1;
      let recH = 1;
      let dotSize = 1;
      let margin = 0;
      let stampSecond = Number.NaN;

      const world = createWorld(0);
      const walker = createWalker();
      let flicker: Flicker = createFlicker(0);

      let width = 1;
      let height = 1;
      let scale = 1;
      let builtSeed = Number.NaN;
      /** 0 black .. 1 shown: the variation fade, and whether it is fading out. */
      let shown = 0;
      let leaving = false;
      /** The style on screen, and the dip to black that switches it. */
      let style = "";
      let dip = 1;
      let dipping = false;
      let haze = Number.NaN;
      let originX = Number.NaN;
      let originY = Number.NaN;
      let textureDirty = true;
      let pulse = 0;

      const build = (seed: number) => {
        builtSeed = seed;
        reseedWorld(world, seed);
        resetWalker(walker, world);
        flicker = createFlicker(seed);
        originX = Number.NaN;
      };

      const layoutOverlay = () => {
        const s = Math.max(scale, 0.01);
        const size = Math.max(4, Math.round(OSD_PX * s));
        if (size === osd) {
          return;
        }
        osd = size;
        margin = Math.round(OSD_MARGIN * s);
        stampW = Math.round(size * 7.4);
        stampH = Math.round(size * 2.6);
        recW = Math.round(size * 2.4);
        recH = Math.round(size * 1.3);
        dotSize = Math.round(size * 1.1);
        stampCtx = canvas2d(stampW, stampH);
        stampSecond = Number.NaN;
        const rec = canvas2d(recW, recH);
        if (rec) {
          paintRec(rec, recW, recH);
          recTex.upload(rec.canvas);
        }
        const dot = canvas2d(dotSize, dotSize);
        if (dot) {
          paintDot(dot, dotSize);
          dotTex.upload(dot.canvas);
        }
      };

      /** Draws one overlay texture into the rectangle (x, y from the top-left, px). */
      const drawOverlay = (
        tex: WebGLTexture,
        x: number,
        y: number,
        w: number,
        h: number,
        a: number,
      ) => {
        gl.viewport(x, height - y - h, w, h);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        ou.f1("uAlpha", a);
        triangle.draw();
      };

      return {
        resize(v) {
          width = v.width;
          height = v.height;
          scale = v.scale;
        },
        frame(dt, p) {
          const step = Math.max(0, dt);
          if (Number.isNaN(builtSeed)) {
            build(p.seed);
            style = p.style;
            haze = hazeParam(p.haze);
          }

          // A new variation fades to black, rebuilds and fades back.
          if (p.seed !== builtSeed) {
            leaving = true;
          }
          shown = approach(shown, leaving ? 0 : 1, step / RESET_FADE);
          if (leaving && shown === 0) {
            leaving = false;
            build(p.seed);
          }
          // A style switch dips to black and back.
          if (p.style !== style) {
            dipping = true;
          }
          dip = approach(dip, dipping ? 0 : 1, step / STYLE_DIP);
          if (dipping && dip === 0) {
            dipping = false;
            style = p.style;
          }
          haze = approach(haze, hazeParam(p.haze), step / HAZE_EASE);

          advanceWalker(walker, world, step, walkRate(p.speed));
          advanceFlicker(flicker, world, step, p.flicker, walker.x, walker.y);
          pulse = (pulse + step / REC_PULSE) % 1;

          const ox = windowOrigin(walker.x);
          const oy = windowOrigin(walker.y);
          if (ox !== originX || oy !== originY) {
            originX = ox;
            originY = oy;
            fillWindow(world, ox, oy, texData);
            textureDirty = true;
          }

          // Draw.
          const footage = style !== "clean";
          beginFrame(gl, width, height);
          let w = width;
          let h = height;
          if (footage) {
            target.resize(width, height, Math.max(1, height / FOOTAGE_LINES));
            target.bind();
            w = target.width;
            h = target.height;
          }
          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          if (textureDirty) {
            textureDirty = false;
            updateDataTexture(gl, texture, WINDOW, WINDOW, gl.RGBA, gl.UNSIGNED_BYTE, texData);
          } else {
            gl.bindTexture(gl.TEXTURE_2D, texture);
          }
          const hh = Math.max(1, h);
          u.f2("uPixScale", 1 / hh, 1 / hh);
          u.f2("uPixOffset", (-0.5 * w) / hh, -0.5);
          const bob = footage ? BOB * Math.sin(walker.walked * BOBS_PER_CELL * Math.PI * 2) : 0;
          u.f3("uCam", walker.x - ox, walker.y - oy, EYE + bob);
          u.f2("uView", Math.cos(walker.angle), Math.sin(walker.angle));
          u.f2("uOrigin", ox, oy);
          u.f1("uFar", VIEW_REACH + (NEAR_HAZE - VIEW_REACH) * smoothstep(0, 1, haze));
          for (let k = 0; k < MAX_FLICKERS; k++) {
            const s = flicker.slots[k];
            flickData[k * 3] = s.active ? s.x - ox : NO_CELL;
            flickData[k * 3 + 1] = s.active ? s.y - oy : NO_CELL;
            flickData[k * 3 + 2] = flickerLevel(s);
          }
          gl.uniform3fv(u.loc.uFlick, flickData);
          const fade = smoothstep(0, 1, shown) * smoothstep(0, 1, dip);
          u.f1("uFade", fade);
          triangle.draw();
          if (!footage) {
            return;
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.useProgram(target.program);
          cu.f1("uAspect", width / Math.max(1, height));
          target.blit();

          // The camcorder overlay: REC top left, the date stamp bottom right.
          layoutOverlay();
          const second = Math.floor(Date.now() / 1000);
          if (stampCtx && second !== stampSecond) {
            stampSecond = second;
            paintStamp(stampCtx, stampW, stampH, second * 1000);
            stampTex.upload(stampCtx.canvas);
          }
          gl.useProgram(overlay);
          gl.activeTexture(gl.TEXTURE0);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          const glow = 0.6 + 0.4 * (0.5 + 0.5 * Math.cos(pulse * Math.PI * 2));
          drawOverlay(dotTex.texture, margin, margin, dotSize, dotSize, fade * glow);
          drawOverlay(recTex.texture, margin + dotSize, margin, recW, recH, fade);
          drawOverlay(
            stampTex.texture,
            width - margin - stampW,
            height - margin - stampH,
            stampW,
            stampH,
            fade,
          );
          gl.disable(gl.BLEND);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.viewport(0, 0, width, height);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
