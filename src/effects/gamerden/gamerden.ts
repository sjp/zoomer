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
  withScope,
} from "../gl";
import { approach, smoothstep } from "../math";
import { fitScale } from "../scene-layout";
import { SDF2D_GLSL } from "../sdf-glsl";
import { createStreamOverlays } from "../stream-overlay/overlay-layer";
import { defineEffect } from "../types";
import {
  createPanelShow,
  type PaletteId,
  PANEL_COUNT,
  PANEL_RADIUS,
  panelCentres,
  type PanelMode,
} from "./gamerden-panels";
import { gamerdenMeta } from "./gamerden.meta";

/** The desk's top edge, above the frame's bottom (design units). */
const DESK_HEIGHT = 0.075;
/** The glow pass renders at 1/GLOW_DIVISOR of the frame's size each way. */
const GLOW_DIVISOR = 4;
/** The glow target stores light divided by this, to fit 8 bits. */
const GLOW_RANGE = 4;
/** A panel's own light close by (its halo), and the wide bounce off the wall. */
const HALO_GAIN = 1.1;
const HALO_SIZE = 0.085;
const BOUNCE_GAIN = 0.1;
const BOUNCE_SIZE = 0.32;
/** The desk strip's light on the wall, and the strip itself. */
const STRIP_GAIN = 1.4;
const STRIP_LINE_GAIN = 0.9;
/** The room's light without the panels: the night, and the monitor out of shot. */
const AMBIENT = [0.26, 0.28, 0.36] as const;
/** The panels' grey plastic, where the diffuser doesn't reach. */
const PLASTIC = 0.2;
/** Seconds a side change cross-fades over, and a colour change eases over. */
const SIDE_FADE = 1.5;
const COLOUR_EASE = 1.2;

/** The mode param's value as a `PanelMode` (an unknown value is Wave). */
function toMode(value: string): PanelMode {
  switch (value) {
    case "breathe":
    case "static":
    case "reactive":
      return value;
    default:
      return "wave";
  }
}

/** The palette param's value as a `PaletteId` (an unknown value is Synth). */
function toPalette(value: string): PaletteId {
  switch (value) {
    case "rainbow":
    case "ocean":
    case "ember":
    case "forest":
    case "mono":
      return value;
    default:
      return "synth";
  }
}

const v3 = (c: readonly number[]) => `vec3(${F(c[0])}, ${F(c[1])}, ${F(c[2])})`;
const N = String(PANEL_COUNT);

/** Design units of a fragment (see fitScale): frame heights at 16:9, centred. */
const DESIGN_GLSL = /* glsl */ `
vec2 design(vec2 frag, vec2 res, float k) {
  return (frag - 0.5 * res) / (res.y * k);
}
`;

/**
 * The room with the panels on the right, drawn once per resize with four
 * samples per pixel: RGB is the surface's colour (albedo), A how much of the
 * panels' and the desk strip's light reaches it. The panels themselves are
 * drawn live over it; the left-hand layout samples this mirrored.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uK;
out vec4 outColor;
${SDF2D_GLSL}
${DESIGN_GLSL}
float halfW;
float bottom;

const vec3 WALL = vec3(0.2, 0.19, 0.24);
const vec3 FOAM = vec3(0.11, 0.11, 0.13);
const vec3 SILHOUETTE = vec3(0.05, 0.05, 0.06);
const vec3 LEAF = vec3(0.05, 0.1, 0.06);
const vec3 BOARD = vec3(0.13, 0.1, 0.08);
const vec3 CHAIR = vec3(0.075, 0.075, 0.085);
const vec3 CHAIR_TRIM = vec3(0.17, 0.17, 0.19);
const vec3 DESK = vec3(0.05, 0.05, 0.06);

float rand(vec2 c) {
  return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
}

/** Paints colour c with receive r over (col, recv) at coverage a. */
void lay(inout vec3 col, inout float recv, vec3 c, float r, float a) {
  col = mix(col, c, a);
  recv = mix(recv, r, a);
}

/** Wedge foam tiles behind the speaker: four ridges a tile, alternately across and upright. */
void foam(vec2 p, inout vec3 col, inout float recv) {
  float d = sdBox(p - vec2(0.0, 0.0), vec2(0.3, 0.4), 0.004);
  float a = cover(d);
  if (a <= 0.0) {
    return;
  }
  const float T = 0.1;
  vec2 cell = floor(p / T);
  vec2 u = p / T - cell;
  bool across = mod(cell.x + cell.y, 2.0) < 0.5;
  float s = across ? u.y : u.x;
  float w = fract(s * 4.0);
  float side = w < 0.5 ? -1.0 : 1.0;
  vec2 n = across ? vec2(0.0, side) : vec2(side, 0.0);
  vec3 n3 = normalize(vec3(n * 0.9, 1.0));
  // Lit softly from the panels' side, up and to the right.
  float diff = max(dot(n3, normalize(vec3(0.45, 0.55, 0.7))), 0.0);
  float ao = 0.6 + 0.4 * smoothstep(0.0, 0.5, 1.0 - abs(2.0 * w - 1.0));
  float e = min(min(u.x, 1.0 - u.x), min(u.y, 1.0 - u.y));
  // Each tile's edges round off into a narrow gap showing the wall.
  float seam = 0.6 + 0.4 * smoothstep(0.0, 0.06, e);
  a *= clamp((e * T - 0.003) / px + 0.5, 0.0, 1.0);
  float vary = 0.92 + 0.16 * rand(cell);
  // The foam's edge is a little shadowed on the wall round it.
  col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.02, d)) * (1.0 - a);
  lay(col, recv, FOAM * (0.45 + 0.9 * diff) * ao * seam * vary, 0.7, a);
}

/** The figures, plant and board on the shelf, on the left; returns the signed distance of the lot. */
float sdShelfThings(vec2 p, out float board, out float leaf) {
  float x0 = -halfW + 0.07;
  float y = 0.1;
  board = sdBox(p - vec2(x0 + 0.21, y), vec2(0.22, 0.009), 0.002);
  float d = board;
  // Brackets.
  d = min(d, sdBox(p - vec2(x0 + 0.05, y - 0.03), vec2(0.007, 0.024), 0.0));
  d = min(d, sdBox(p - vec2(x0 + 0.37, y - 0.03), vec2(0.007, 0.024), 0.0));
  float top = y + 0.009;
  // A big-headed figure on a round base.
  d = min(d, sdBox(p - vec2(x0 + 0.05, top + 0.004), vec2(0.022, 0.004), 0.003));
  d = min(d, sdBox(p - vec2(x0 + 0.05, top + 0.03), vec2(0.014, 0.024), 0.008));
  d = min(d, length(p - vec2(x0 + 0.05, top + 0.075)) - 0.03);
  // A blocky robot with an antenna.
  d = min(d, sdBox(p - vec2(x0 + 0.13, top + 0.032), vec2(0.022, 0.032), 0.004));
  d = min(d, sdBox(p - vec2(x0 + 0.13, top + 0.086), vec2(0.026, 0.02), 0.006));
  d = min(d, sdSeg(p, vec2(x0 + 0.13, top + 0.1), vec2(x0 + 0.14, top + 0.13)) - 0.002);
  d = min(d, length(p - vec2(x0 + 0.14, top + 0.132)) - 0.006);
  // A small creature with pointed ears.
  vec2 c = vec2(x0 + 0.21, top + 0.032);
  d = min(d, length((p - c) * vec2(1.0, 1.2)) - 0.03);
  vec2 q = vec2(abs(p.x - c.x), p.y - c.y);
  d = min(d, sdSeg(q, vec2(0.012, 0.02), vec2(0.024, 0.052)) - 0.006);
  // A boxed figure, standing on end.
  d = min(d, sdBox(p - vec2(x0 + 0.285, top + 0.055), vec2(0.03, 0.055), 0.002));
  // A pot with a plant.
  d = min(d, sdBox(p - vec2(x0 + 0.375, top + 0.02), vec2(0.022, 0.02), 0.004));
  leaf = 1e3;
  for (int i = 0; i < 5; i++) {
    float t = float(i) - 2.0;
    vec2 base = vec2(x0 + 0.375, top + 0.04);
    vec2 tip = base + vec2(t * 0.022, 0.065 - abs(t) * 0.012);
    leaf = min(leaf, sdSeg(p, base, tip) - 0.008 + 0.004 * smoothstep(0.0, 0.07, length(p - base)));
  }
  return d;
}

/** The gaming chair's back, centred behind the speaker: shoulder wings, a headrest and its harness slots. */
float sdChair(vec2 p, out float slots, out float trim) {
  vec2 q = vec2(abs(p.x), p.y);
  float head = sdBox(q - vec2(0.0, 0.12), vec2(0.17, 0.1), 0.08);
  // The back widens into wings at the shoulders, then narrows at the waist.
  float hw = 0.2 + 0.07 * smoothstep(0.12, -0.12, q.y) - 0.04 * smoothstep(-0.25, -0.5, q.y);
  float back = max(q.x - hw, max(q.y - 0.05, bottom - 0.1 - q.y));
  float d = min(head, back);
  slots = sdBox(q - vec2(0.105, 0.135), vec2(0.022, 0.04), 0.02);
  // Piping down the back.
  trim = max(abs(q.x - (hw - 0.035)) - 0.008, q.y - 0.02);
  return max(d, -slots);
}

vec4 room(vec2 p) {
  vec3 col = WALL * (0.9 + 0.1 * smoothstep(-0.5, 0.5, p.y));
  float recv = 1.0;
  foam(p, col, recv);

  float board;
  float leaf;
  float ds = sdShelfThings(p, board, leaf);
  // The shelf's shadow on the wall below it.
  float x0 = -halfW + 0.07;
  float under = sdBox(p - vec2(x0 + 0.21, 0.07), vec2(0.22, 0.03), 0.02);
  col *= 1.0 - 0.25 * (1.0 - smoothstep(-0.03, 0.04, under));
  lay(col, recv, SILHOUETTE, 0.25, cover(ds));
  lay(col, recv, BOARD, 0.5, cover(board));
  lay(col, recv, LEAF, 0.3, cover(leaf));

  float slots;
  float trim;
  float dc = sdChair(p, slots, trim);
  float c = cover(dc);
  if (c > 0.0) {
    vec3 chair = mix(CHAIR, CHAIR_TRIM, cover(trim));
    chair *= 0.6 + 0.4 * smoothstep(0.0, 0.05, -dc);
    lay(col, recv, chair, 0.4, c);
  }

  // The desk along the bottom, its top edge caught by the strip.
  float deskTop = bottom + ${F(DESK_HEIGHT)};
  float dd = p.y - deskTop;
  float bevel = smoothstep(-0.012, 0.0, dd);
  lay(col, recv, DESK * (1.0 + 1.5 * bevel), mix(0.12, 0.6, bevel), cover(dd));
  return vec4(col, recv);
}

void main() {
  halfW = 0.5 * uRes.x / (uRes.y * uK);
  bottom = -0.5 / uK;
  px = 1.0 / (uRes.y * uK);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    sum += room(design(gl_FragCoord.xy + o, uRes, uK));
  }
  outColor = clamp(sum * 0.25, 0.0, 1.0);
}
`;

/**
 * Every frame the panels change, at reduced resolution: the light they and the
 * desk strip throw on the wall, panels on the right. Each panel adds a halo and
 * a wide bounce; the strip lights the wall from below.
 */
const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uLow;
uniform float uK;
uniform vec2 uCentres[${N}];
uniform vec3 uColours[${N}];
uniform vec3 uStrip;
out vec4 outColor;
${DESIGN_GLSL}
void main() {
  vec2 p = design(gl_FragCoord.xy * (uRes / uLow), uRes, uK);
  vec3 light = vec3(0.0);
  for (int i = 0; i < ${N}; i++) {
    vec2 d = p - uCentres[i];
    float r2 = dot(d, d);
    float w = ${F(HALO_GAIN)} * exp(-r2 * ${F(0.5 / (HALO_SIZE * HALO_SIZE))})
      + ${F(BOUNCE_GAIN)} / (1.0 + r2 * ${F(1 / (BOUNCE_SIZE * BOUNCE_SIZE))});
    light += uColours[i] * w;
  }
  float yb = max(p.y - (-0.5 / uK + ${F(DESK_HEIGHT)}), 0.0);
  light += uStrip * (0.8 * exp(-yb / 0.07) + 0.35 * exp(-yb / 0.3));
  outColor = vec4(min(light / ${F(GLOW_RANGE)}, vec3(1.0)), 1.0);
}
`;

/**
 * Every frame: the cached room lit by the glow, the panels' diffusers over it
 * and the strip's line along the desk, with dither. While the panels change
 * side, both layouts are shaded and mixed.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uGlow;
uniform vec2 uRes;
uniform float uK;
uniform vec2 uCentres[${N}];
uniform vec3 uColours[${N}];
/** The cluster's bounds (design units, panels on the right): min x, min y, max x, max y. */
uniform vec4 uBox;
uniform vec3 uStripLine;
/** 0 with the panels on the right, 1 on the left, between while they change side. */
uniform float uMix;
out vec4 outColor;
${SDF2D_GLSL}
${DESIGN_GLSL}
${DITHER_GLSL}
const vec3 AMBIENT = ${v3(AMBIENT)};
const float R_IN = ${F((PANEL_RADIUS * Math.sqrt(3)) / 2)};

/** A flat-topped hexagon of inradius r. */
float sdHex(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

/** The frame with the panels on the right (flip 1) or mirrored to the left (flip -1). */
vec3 shade(float flip) {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / uRes;
  if (flip < 0.0) {
    t.x = int(uRes.x) - 1 - t.x;
    uv.x = 1.0 - uv.x;
  }
  vec4 r = texelFetch(uRoom, t, 0);
  vec3 glow = texture(uGlow, uv).rgb * ${F(GLOW_RANGE)};
  vec3 col = r.rgb * (AMBIENT + glow * r.a);

  vec2 p = design(gl_FragCoord.xy, uRes, uK);
  p.x *= flip;
  if (p.x > uBox.x && p.y > uBox.y && p.x < uBox.z && p.y < uBox.w) {
    float d = 1e3;
    vec3 c = vec3(0.0);
    for (int i = 0; i < ${N}; i++) {
      float di = sdHex(p - uCentres[i], R_IN);
      if (di < d) {
        d = di;
        c = uColours[i];
      }
    }
    float a = cover(d);
    if (a > 0.0) {
      // A diffuser that fades softly to its edge, with a slightly brighter rim.
      float lit = smoothstep(0.0, 0.012, -d);
      float rd = (d + 0.008) / 0.004;
      float rim = exp(-rd * rd);
      vec3 face = c * min(1.0, 0.84 * lit + 0.3 * rim);
      vec3 body = ${F(PLASTIC)} * (AMBIENT + glow);
      col = mix(col, body + face, a);
    }
  }

  // The strip along the desk's back edge.
  float dy = p.y - (-0.5 / uK + ${F(DESK_HEIGHT)});
  col += uStripLine * (exp(-dy * dy * 6.0e4) + 0.25 * exp(-abs(dy) * 60.0) * step(0.0, dy));
  return col;
}

void main() {
  px = 1.0 / (uRes.y * uK);
  vec3 col;
  if (uMix <= 0.0) {
    col = shade(1.0);
  } else if (uMix >= 1.0) {
    col = shade(-1.0);
  } else {
    col = mix(shade(1.0), shade(-1.0), uMix);
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A streamer's room at night: a cluster of hexagonal light panels in an upper
 * corner, wedge foam behind the speaker, a gaming chair's back and headrest
 * centred behind them, a shelf of figures and a plant on the other side, and
 * a desk along the bottom with an LED strip lighting the wall from below.
 *
 * The room is drawn once per resize (panels on the right; the left-hand layout
 * reads it mirrored). Each frame the panel show gives every panel a colour, a
 * reduced-resolution pass sums their halos, bounce and the strip's light, and
 * a full-resolution pass lights the room with that and draws the panels'
 * diffusers. The stream overlays draw on top.
 */
export const gamerden = defineEffect(gamerdenMeta, {
  create(gl) {
    return withScope((scope) => {
      const roomProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const glowProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, GLOW_FRAGMENT);
      const compositeProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uK"]);
      const gu = createUniforms(gl, glowProgram, [
        "uRes",
        "uLow",
        "uK",
        "uCentres",
        "uColours",
        "uStrip",
      ]);
      const cu = createUniforms(gl, compositeProgram, [
        "uRoom",
        "uGlow",
        "uRes",
        "uK",
        "uCentres",
        "uColours",
        "uBox",
        "uStripLine",
        "uMix",
      ]);
      gl.useProgram(compositeProgram);
      cu.i1("uRoom", 0);
      cu.i1("uGlow", 1);
      gl.useProgram(null);
      const overlays = createStreamOverlays(gl, scope);

      let roomTarget: RenderTarget | null = null;
      let glowTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
        glowTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let lowWidth = 1;
      let lowHeight = 1;
      let k = 1;
      let roomDrawn = false;
      /** Whether the glow target needs drawing again (panel colours or strip changed, or a resize). */
      let glowStale = true;
      const centres = new Float32Array(2 * PANEL_COUNT);
      const box = new Float32Array(4);
      const colours = new Float32Array(3 * PANEL_COUNT);
      const strip = new Float32Array(3);
      const accentRgb = unitRgbMemo();
      const accentEase = createColorEase(3);
      const show = createPanelShow();
      /** Side cross-fade progress: 0 on the right, 1 on the left. */
      let side = -1;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          lowWidth = Math.max(1, Math.ceil(width / GLOW_DIVISOR));
          lowHeight = Math.max(1, Math.ceil(height / GLOW_DIVISOR));
          k = fitScale(width / height);
          panelCentres(width / height, centres);
          box[0] = Infinity;
          box[1] = Infinity;
          box[2] = -Infinity;
          box[3] = -Infinity;
          for (let i = 0; i < PANEL_COUNT; i++) {
            box[0] = Math.min(box[0], centres[2 * i] - PANEL_RADIUS);
            box[1] = Math.min(box[1], centres[2 * i + 1] - PANEL_RADIUS);
            box[2] = Math.max(box[2], centres[2 * i] + PANEL_RADIUS);
            box[3] = Math.max(box[3], centres[2 * i + 1] + PANEL_RADIUS);
          }
          roomTarget?.dispose();
          roomTarget = null;
          roomTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          glowTarget?.dispose();
          glowTarget = null;
          glowTarget = createRenderTarget(gl, lowWidth, lowHeight, gl.RGBA8);
          roomDrawn = false;
          glowStale = true;
          overlays.resize(v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
          const accent = accentEase.step(accentRgb(p.accent), step, COLOUR_EASE);
          const lit = show.step(
            step,
            toMode(p.mode),
            toPalette(p.palette),
            accentRgb(p.accent),
            p.speed,
          );
          // The side cross-fade: a smoothstep from where it is towards the chosen side.
          const sideTarget = p.panelSide === "left" ? 1 : 0;
          side = side < 0 ? sideTarget : approach(side, sideTarget, step / SIDE_FADE);
          const sideMix = smoothstep(0, 1, side);

          const b = p.brightness;
          for (let i = 0; i < colours.length; i++) {
            const v = lit[i] * b;
            if (v !== colours[i]) {
              colours[i] = v;
              glowStale = true;
            }
          }
          for (let c = 0; c < 3; c++) {
            const v = accent[c] * b * STRIP_GAIN;
            if (v !== strip[c]) {
              strip[c] = v;
              glowStale = true;
            }
          }

          if (roomTarget && glowTarget) {
            // 1. The room, once per resize.
            if (!roomDrawn) {
              roomDrawn = true;
              gl.useProgram(roomProgram);
              ru.f2("uRes", width, height);
              ru.f1("uK", k);
              roomTarget.bind();
              triangle.draw();
            }

            // 2. The panels' and strip's light, when it changes.
            if (glowStale) {
              glowStale = false;
              gl.useProgram(glowProgram);
              gu.f2("uRes", width, height);
              gu.f2("uLow", lowWidth, lowHeight);
              gu.f1("uK", k);
              gl.uniform2fv(gu.loc.uCentres, centres);
              gl.uniform3fv(gu.loc.uColours, colours);
              gu.f3("uStrip", strip[0], strip[1], strip[2]);
              glowTarget.bind();
              triangle.draw();
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);

            // 3. The room, lit, with the panels.
            const line = b * STRIP_LINE_GAIN;
            gl.useProgram(compositeProgram);
            cu.f2("uRes", width, height);
            cu.f1("uK", k);
            gl.uniform2fv(cu.loc.uCentres, centres);
            gl.uniform3fv(cu.loc.uColours, colours);
            cu.f4("uBox", box[0], box[1], box[2], box[3]);
            cu.f3("uStripLine", accent[0] * line, accent[1] * line, accent[2] * line);
            cu.f1("uMix", sideMix);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, roomTarget.texture);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, glowTarget.texture);
            triangle.draw();
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, null);
          }

          // 4. The stream overlays, last.
          overlays.frame(dt, p);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
