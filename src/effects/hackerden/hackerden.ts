import { createCanvasAtlas, MONO_FONT_STACK } from "../canvas-texture";
import { createColorEase } from "../color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  type RenderTarget,
  scissorBox,
  scopedProgram,
  withScope,
} from "../gl";
import { smoothstep } from "../math";
import { LAND_MASK_BIAS, LAND_MASK_GAIN, loadLandMask, uploadLandMask } from "../land-mask";
import { VALUE_NOISE_GLSL } from "../noise";
import { DESIGN_GLSL, fitScale } from "../scene-layout";
import { SDF2D_GLSL } from "../sdf-glsl";
import { TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import { hackerdenMeta, MAX_SCREENS, type PaletteId } from "./hackerden.meta";
import {
  ALERT_TEXTS,
  alertLevel,
  type CodeSim,
  createDen,
  DIRTY_ALL,
  DIRTY_NONE,
  type DecryptSim,
  hopEase,
  lineStepOffset,
  MAP_NORTH,
  MAP_SOUTH,
  MAP_WEST,
  type MapSim,
  MAX_HOPS,
  type NetworkSim,
  type ProgressSim,
  progressFileAt,
  progressTaskOf,
  RED_ALERT,
  type ScreenKind,
  type ScreenSim,
  SLOTS,
  slotRows,
  stepDen,
  type TerminalSim,
  terminalLine,
  WAVE_CYCLES,
  type WaveSim,
} from "./hackerden-sim";
import {
  CODE_ACCENT,
  CODE_COMMENT,
  docIp,
  nodeName,
  promptFor,
  promptHandle,
  TERMINAL_COLUMNS,
  unitHash,
} from "./hackerden-text";

/** The layout's seed: which screen shows what, and everything they say. */
const SEED = 20_611;

/** The desk's back edge (where the monitors stand) and its front lip, above the frame's bottom (design units). */
const DESK_TOP = 0.105;
const DESK_LIP = 0.04;
/** The desk's front edge, below the lip, and the LED strip under it. */
const DESK_FACE = 0.012;
/** Monitor bezels, the stands' necks and feet (design units). */
const BEZEL = 0.009;
const NECK = 0.007;
/** How far the wall-mounted monitors' arms reach down to the wall plate. */
const WALL_ARM = 0.035;
/** The glow pass renders at 1/GLOW_DIVISOR of the frame's size each way, storing light over GLOW_RANGE. */
const GLOW_DIVISOR = 4;
const GLOW_RANGE = 4;
/** The room's light without the screens: almost dark. */
const AMBIENT = [0.02, 0.022, 0.032] as const;
/** How much light a screen throws on the wall, by how much of it is lit. */
const KIND_GLOW: Record<ScreenKind, number> = {
  terminal: 0.5,
  code: 0.55,
  map: 0.45,
  decrypt: 0.6,
  progress: 0.5,
  network: 0.4,
  wave: 0.4,
};
/** The banner's peak opacity, and the glow a red banner adds to its screen's light. */
const BANNER_PEAK = 0.9;
const ALERT_GLOW = 0.9;
/** Seconds a palette change eases over. */
const PALETTE_EASE = 1.2;
/** Columns a line of code is laid out for (longer lines run off the screen's edge). */
const CODE_COLUMNS = 38;
/** Monitor kinds the screen shader draws extras for. */
const KIND_MAP = 1;
const KIND_WAVE = 2;
const KIND_NETWORK = 3;

type Rgb3 = readonly [number, number, number];

/** A screen's colours: main text, dim text (labels, comments) and highlights. */
interface ScreenColours {
  primary: Rgb3;
  muted: Rgb3;
  accent: Rgb3;
}

const GREEN: ScreenColours = {
  primary: [0.3, 1, 0.42],
  muted: [0.1, 0.42, 0.17],
  accent: [0.78, 1, 0.74],
};
const AMBER: ScreenColours = {
  primary: [1, 0.66, 0.14],
  muted: [0.46, 0.27, 0.05],
  accent: [1, 0.88, 0.58],
};
const ICE: ScreenColours = {
  primary: [0.48, 0.84, 1],
  muted: [0.16, 0.35, 0.52],
  accent: [0.86, 0.97, 1],
};

/** The Movie palette: each kind of screen its own colour, as on film. */
const MOVIE: Record<ScreenKind, ScreenColours> = {
  terminal: GREEN,
  code: { primary: [0.84, 0.87, 0.92], muted: [0.36, 0.43, 0.53], accent: [1, 0.42, 0.74] },
  map: { primary: [0.4, 0.88, 1], muted: [0.12, 0.36, 0.46], accent: [1, 0.34, 0.28] },
  decrypt: { primary: [1, 0.55, 0.2], muted: [0.48, 0.22, 0.08], accent: [1, 0.9, 0.62] },
  progress: { primary: [0.45, 0.7, 1], muted: [0.2, 0.3, 0.5], accent: [0.82, 0.92, 1] },
  network: { primary: [0.74, 0.5, 1], muted: [0.3, 0.2, 0.48], accent: [0.95, 0.86, 1] },
  wave: { primary: [0.3, 1, 0.84], muted: [0.1, 0.4, 0.34], accent: [0.8, 1, 0.95] },
};

/** The LED strip under the desk, per palette. */
const STRIP: Record<PaletteId, Rgb3> = {
  green: [0.12, 0.7, 0.3],
  amber: [0.85, 0.42, 0.06],
  ice: [0.18, 0.45, 1],
  movie: [0.55, 0.18, 0.95],
};

const RED: Rgb3 = [1, 0.16, 0.13];

function toPalette(value: string): PaletteId {
  switch (value) {
    case "amber":
    case "ice":
    case "movie":
      return value;
    default:
      return "green";
  }
}

function coloursFor(palette: PaletteId, kind: ScreenKind): ScreenColours {
  switch (palette) {
    case "amber":
      return AMBER;
    case "ice":
      return ICE;
    case "movie":
      return MOVIE[kind];
    case "green":
      break;
  }
  return GREEN;
}

/** Floats per slot in the eased colour block: primary, muted, accent. */
const SLOT_FLOATS = 9;
const STRIP_OFFSET = MAX_SCREENS * SLOT_FLOATS;
const COLOUR_FLOATS = STRIP_OFFSET + 3;

/** Writes every slot's colours and the strip's for `palette` into `out`. */
function paletteTarget(palette: PaletteId, kinds: readonly ScreenKind[], out: Float32Array): void {
  for (let s = 0; s < MAX_SCREENS; s++) {
    const c = coloursFor(palette, kinds[s]);
    out.set(c.primary, s * SLOT_FLOATS);
    out.set(c.muted, s * SLOT_FLOATS + 3);
    out.set(c.accent, s * SLOT_FLOATS + 6);
  }
  out.set(STRIP[palette], STRIP_OFFSET);
}

const v3 = (c: readonly number[]) => `vec3(${F(c[0])}, ${F(c[1])}, ${F(c[2])})`;

/**
 * The room, drawn once per resize with four samples per pixel: RGB is the
 * surface's colour, A how much of the screens' light reaches it. A dark
 * plaster wall with a few cables hanging on it, and the desk along the bottom
 * with a mug and two cans on it. The monitors are drawn live over it.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uK;
out vec4 outColor;
${SDF2D_GLSL}
${DESIGN_GLSL}
${VALUE_NOISE_GLSL}
float bottom;
float deskTop;

void lay(inout vec3 col, inout float recv, vec3 c, float r, float a) {
  col = mix(col, c, a);
  recv = mix(recv, r, a);
}

/** Distance to a quadratic Bezier from a through control c to b, by eight chords. */
float sdCable(vec2 p, vec2 a, vec2 c, vec2 b) {
  float d = 1e3;
  vec2 prev = a;
  for (int i = 1; i <= 8; i++) {
    float t = float(i) / 8.0;
    vec2 q = mix(mix(a, c, t), mix(c, b, t), t);
    d = min(d, sdSeg(p, prev, q));
    prev = q;
  }
  return d;
}

vec4 room(vec2 p) {
  // Plaster, unevenly painted, with faint panel joints.
  float n = vnoise(p * 6.0, 3.0) * 0.6 + vnoise(p * 23.0, 4.0) * 0.4;
  vec3 col = vec3(0.34, 0.35, 0.39) * (0.82 + 0.3 * n);
  float joint = abs(fract(p.x / 0.44 + 0.5) - 0.5) * 0.44;
  col *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.0025, joint));
  float recv = 1.0;

  // Cables hanging between the monitors and down behind the desk.
  float d = sdCable(p, vec2(-0.6, -0.12), vec2(-0.76, -0.2), vec2(-0.72, deskTop));
  d = min(d, sdCable(p, vec2(0.6, -0.14), vec2(0.77, -0.24), vec2(0.73, deskTop)));
  d = min(d, sdCable(p, vec2(-0.33, 0.15), vec2(-0.235, -0.06), vec2(-0.36, deskTop)));
  d = min(d, sdCable(p, vec2(0.33, 0.15), vec2(0.3, -0.1), vec2(0.37, deskTop)));
  d = min(d, sdCable(p, vec2(-0.36, 0.33), vec2(-0.32, 0.2), vec2(-0.285, 0.34)));
  d = min(d, sdCable(p, vec2(0.36, 0.3), vec2(0.325, 0.17), vec2(0.29, 0.32)));
  d = min(d, sdCable(p, vec2(-0.68, -0.06), vec2(-0.5, -0.36), vec2(-0.4, -0.08)));
  float cable = cover(d - 0.0032);
  // A little shadow on the wall beside each cable.
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.012, d)) * (1.0 - cable);
  lay(col, recv, vec3(0.05, 0.05, 0.06), 0.35, cable);

  // The desk: its top, catching the screens, the lip and front edge, and the dark under it.
  float lip = bottom + ${F(DESK_LIP)};
  float face = lip - ${F(DESK_FACE)};
  float depth = clamp((p.y - lip) / (deskTop - lip), 0.0, 1.0);
  lay(col, recv, vec3(0.3, 0.29, 0.3) * (0.75 + 0.25 * depth), 0.75 + 0.25 * depth, cover(p.y - deskTop));
  lay(col, recv, vec3(0.42), 0.6, cover(abs(p.y - lip) - 0.0015));
  lay(col, recv, vec3(0.1, 0.1, 0.11), 0.2, cover(p.y - (lip - 0.0015)) * (1.0 - cover(p.y - face)));
  lay(col, recv, vec3(0.3, 0.3, 0.32), 0.0, cover(p.y - face));

  // A mug on the left, two cans on the right, standing on the desk.
  float base = mix(lip, deskTop, 0.45);
  vec2 m = p - vec2(-0.64, base);
  float mug = sdBox(m - vec2(0.0, 0.032), vec2(0.022, 0.032), 0.004);
  mug = min(mug, abs(length(m - vec2(-0.025, 0.034)) - 0.013) - 0.0035);
  float rim = cover(abs(m.y - 0.062) - 0.002) * cover(abs(m.x) - 0.02);
  vec3 mugCol = vec3(0.6, 0.58, 0.55) * (0.8 + 0.2 * smoothstep(-0.02, 0.02, m.x)) + 0.15 * rim;
  lay(col, recv, mugCol, 0.8, cover(mug));
  for (int i = 0; i < 2; i++) {
    vec2 c = p - vec2(0.615 + 0.042 * float(i), base + 0.002 * float(i));
    float can = sdBox(c - vec2(0.0, 0.037), vec2(0.016, 0.037), 0.003);
    float band = smoothstep(0.02, 0.022, c.y) * (1.0 - smoothstep(0.05, 0.052, c.y));
    float shine = exp(-pow((c.x + 0.006) / 0.004, 2.0));
    vec3 canCol = mix(vec3(0.55, 0.56, 0.6), vec3(0.3, 0.12, 0.12), band) * (0.75 + 0.5 * shine);
    canCol += 0.2 * cover(abs(c.y - 0.072) - 0.0015);
    lay(col, recv, canCol, 0.85, cover(can));
  }
  return vec4(col, recv);
}

void main() {
  bottom = -0.5 / uK;
  deskTop = bottom + ${F(DESK_TOP)};
  px = 1.0 / (uRes.y * uK);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    sum += room(design(gl_FragCoord.xy + o, uRes, uK));
  }
  outColor = clamp(sum * 0.25, 0.0, 1.0);
}
`;

const N = String(MAX_SCREENS);

/**
 * The light the screens throw on the wall and desk, at reduced resolution,
 * whenever a screen's colour or brightness changes: a soft halo round each
 * monitor and a wide, faint spill.
 */
const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uLow;
uniform float uK;
uniform vec4 uRects[${N}];
uniform vec3 uLights[${N}];
out vec4 outColor;
${DESIGN_GLSL}
void main() {
  vec2 p = design(gl_FragCoord.xy * (uRes / uLow), uRes, uK);
  vec3 light = vec3(0.0);
  for (int i = 0; i < ${N}; i++) {
    vec2 q = max(abs(p - uRects[i].xy) - uRects[i].zw, 0.0);
    float d2 = dot(q, q);
    light += uLights[i] * (0.7 * exp(-d2 * 200.0) + 0.3 / (1.0 + d2 * 14.0));
  }
  outColor = vec4(min(light / ${F(GLOW_RANGE)}, vec3(1.0)), 1.0);
}
`;

/** Every frame: the cached room lit by the glow, and the LED strip under the desk. */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uGlow;
uniform vec2 uRes;
uniform float uK;
uniform vec3 uStrip;
out vec4 outColor;
${DESIGN_GLSL}
${DITHER_GLSL}
void main() {
  vec4 r = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0);
  vec3 glow = texture(uGlow, gl_FragCoord.xy / uRes).rgb * ${F(GLOW_RANGE)};
  vec3 col = r.rgb * (${v3(AMBIENT)} + glow * r.a);
  // The strip lights the dark under the desk, and shows as a line just under its edge.
  float y = design(gl_FragCoord.xy, uRes, uK).y;
  float under = (-0.5 / uK + ${F(DESK_LIP - DESK_FACE)}) - y;
  if (under > 0.0) {
    float line = (under - 0.003) / 0.0024;
    col += uStrip * (0.35 * exp(-line * line) + r.rgb * (1.4 * exp(-under / 0.012) + 0.4 * exp(-under / 0.04)));
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * One monitor per draw, scissored to it: the bezel, the stand down to the
 * desk, and the screen. The screen shows its region of the text atlas (roles
 * coloured from the screen's palette), with a soft glow round the text, the
 * kind's live extras (the map's land dots and trace, the waveform, the
 * network's pulse), the alert banner, and faint scanlines. Premultiplied, with
 * the monitor's fade as its alpha.
 */
const MONITOR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uK;
uniform float uScale;
uniform sampler2D uAtlas;
uniform sampler2D uMask;
uniform vec2 uAtlasSize;
uniform vec4 uFrame;
uniform vec3 uBase;
uniform vec4 uScreen;
uniform vec2 uOrigin;
uniform vec3 uScroll;
uniform vec3 uBanner;
uniform vec3 uAlertCol;
uniform vec3 uPrimary;
uniform vec3 uMuted;
uniform vec3 uAccent;
uniform float uLife;
uniform int uKind;
uniform vec2 uPoints[${String(MAX_HOPS + 1)}];
uniform vec4 uRoute;
uniform vec3 uPulse;
uniform vec3 uWave;
out vec4 outColor;
${SDF2D_GLSL}
${DESIGN_GLSL}
${DITHER_GLSL}

vec3 roles(vec4 t) {
  return t.r * uPrimary + t.g * uMuted + t.b * uAccent;
}

float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0));
}

/** A crisp core of radius r and a soft glow of size g, at distance d (px). */
float spot(float d, float r, float g) {
  return clamp(r - d + 0.5, 0.0, 1.0) + 0.5 * exp(-d / g);
}

/** The world in dots where there's land, and the trace hopping across it. */
vec3 mapLayer(vec2 lp, vec2 size) {
  float cs = max(3.0, size.y / 44.0);
  vec2 cell = floor(lp / cs);
  vec2 cc = (cell + 0.5) * cs;
  vec2 uv = cc / size;
  float lon = ${F(MAP_WEST)} + uv.x * 360.0;
  float lat = ${F(MAP_NORTH)} - uv.y * ${F(MAP_NORTH - MAP_SOUTH)};
  float sd = texture(uMask, vec2(fract(lon / 360.0 + 0.5), 0.5 - lat / 180.0)).r * ${F(LAND_MASK_GAIN)} - ${F(LAND_MASK_BIAS)};
  float dotCover = step(0.0, sd) * clamp(cs * 0.28 - length(lp - cc) + 0.5, 0.0, 1.0);
  vec3 col = uMuted * dotCover;

  int count = int(uRoute.x + 0.5);
  float line = 1e4;
  float stops = 1e4;
  vec2 head = uPoints[0] * size;
  for (int i = 0; i < ${String(MAX_HOPS)}; i++) {
    if (i + 1 >= count) {
      break;
    }
    vec2 a = uPoints[i] * size;
    vec2 b = uPoints[i + 1] * size;
    if (i + 2 == count) {
      b = mix(a, b, uRoute.y);
      head = b;
    }
    line = min(line, seg(lp, a, b));
  }
  for (int i = 0; i <= ${String(MAX_HOPS)}; i++) {
    if (i >= count || (i + 1 == count && uRoute.y < 1.0)) {
      break;
    }
    stops = min(stops, length(lp - uPoints[i] * size));
  }
  float w = uScale;
  col += uAccent * uRoute.z * (0.85 * clamp(w - line + 0.5, 0.0, 1.0) + 0.2 * exp(-line / (3.0 * w)));
  col += uAccent * uRoute.z * clamp(2.5 * w - stops + 0.5, 0.0, 1.0);
  col += uAccent * uRoute.z * spot(length(lp - head), 3.0 * w, 5.0 * w);
  return col;
}

/** The oscilloscope trace: two slow waves, with a static graticule behind it. */
vec3 waveLayer(vec2 lp, vec2 size) {
  vec2 uv = lp / size;
  float top = 0.16;
  float bot = 0.84;
  if (uv.y < top - 0.02 || uv.y > bot + 0.02) {
    return vec3(0.0);
  }
  float mid = 0.5 * (top + bot) * size.y;
  float amp = uWave.z * (bot - top) * 0.45 * size.y;
  float a1 = ${F(2 * Math.PI * WAVE_CYCLES[0])} * uv.x + uWave.x;
  float a2 = ${F(2 * Math.PI * WAVE_CYCLES[1])} * uv.x - uWave.y;
  float y = mid - amp * (0.68 * sin(a1) + 0.32 * sin(a2));
  float slope = amp * (0.68 * ${F(2 * Math.PI * WAVE_CYCLES[0])} * cos(a1) - 0.32 * ${F(2 * Math.PI * WAVE_CYCLES[1])} * cos(a2)) / size.x;
  float d = abs(lp.y - y) / sqrt(1.0 + slope * slope);
  return uPrimary * spot(d, 1.2 * uScale, 3.5 * uScale);
}

void main() {
  px = 1.0 / (uRes.y * uK);
  vec2 p = design(gl_FragCoord.xy, uRes, uK);
  vec2 q = p - uFrame.xy;
  float dScreen = sdBox(q, uFrame.zw, 0.002);
  float dBezel = sdBox(q, uFrame.zw + ${F(BEZEL)}, 0.006);
  float neckTop = uFrame.y - uFrame.w;
  float neck = sdBox(p - vec2(uFrame.x, 0.5 * (neckTop + uBase.x)), vec2(${F(NECK)}, 0.5 * (neckTop - uBase.x)), 0.0);
  float foot = sdBox(p - vec2(uFrame.x, uBase.x + 0.004), uBase.yz, 0.004);
  float body = min(dBezel, min(neck, foot));
  float a = cover(body);
  if (a <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  // Dark plastic, its inner edge lit by its own screen.
  vec3 col = vec3(0.028, 0.029, 0.033) * (1.0 + 0.4 * smoothstep(0.0, -0.01, neck));
  col += (uPrimary + uMuted) * 0.06 * exp(-max(dScreen, 0.0) / 0.004) * step(dBezel, 0.0);

  float inside = cover(dScreen);
  if (inside > 0.0) {
    vec2 size = uScreen.zw;
    // Pixels from the screen's top-left, y down, as on the atlas.
    vec2 lp = vec2(gl_FragCoord.x - uScreen.x, uScreen.y + uScreen.w - gl_FragCoord.y);
    vec3 s = uMuted * 0.05 + vec3(0.004);
    if (uKind == ${String(KIND_MAP)}) {
      s += mapLayer(lp, size);
    } else if (uKind == ${String(KIND_WAVE)}) {
      s += waveLayer(lp, size);
    } else if (uKind == ${String(KIND_NETWORK)}) {
      s += uAccent * uPulse.z * spot(length(lp - uPulse.xy * size), 3.0 * uScale, 6.0 * uScale);
    }
    // The text, stepping up by a line in the scrolling area.
    float cy = lp.y >= uScroll.x ? lp.y + uScroll.y - uScroll.z : lp.y;
    vec2 at = uOrigin + vec2(lp.x, cy);
    vec4 t = texture(uAtlas, at / uAtlasSize);
    float o = 1.5 * uScale;
    vec4 halo = texture(uAtlas, (at + vec2(o, o)) / uAtlasSize)
      + texture(uAtlas, (at + vec2(-o, o)) / uAtlasSize)
      + texture(uAtlas, (at + vec2(o, -o)) / uAtlasSize)
      + texture(uAtlas, (at + vec2(-o, -o)) / uAtlasSize);
    s = s * (1.0 - t.a) + roles(t) + roles(halo) * 0.09;

    // The alert banner across the middle.
    if (uBanner.y > 0.0) {
      float bd = abs(lp.y - 0.5 * size.y);
      float band = clamp(uBanner.x - bd + 0.5, 0.0, 1.0);
      if (band > 0.0) {
        vec4 bt = texture(uAtlas, (uOrigin + vec2(lp.x, uBanner.z + lp.y - 0.5 * size.y + uBanner.x)) / uAtlasSize);
        float edge = clamp(1.0 - abs(bd - uBanner.x + 1.5 * uScale) / uScale, 0.0, 1.0);
        vec3 b = uAlertCol * (0.2 + 0.7 * edge) * (1.0 - bt.a) + uAlertCol * 1.1 * bt.a;
        s = mix(s, b, band * uBanner.y * ${F(BANNER_PEAK)});
      }
    }
    // Faint, still scanlines, and the glass a little darker towards its edges.
    float period = max(2.0, 3.0 * uScale);
    s *= 1.0 - 0.08 * (0.5 + 0.5 * cos(gl_FragCoord.y * TAU / period));
    s *= 0.8 + 0.2 * smoothstep(0.0, 0.03, -dScreen);
    col = mix(col, s, inside);
  }
  col += dither8(gl_FragCoord.xy);
  float alpha = a * uLife;
  outColor = vec4(col * alpha, alpha);
}
`;

/** A slot's screen in device pixels, and its region of the text atlas. */
interface ScreenBox {
  /** Left and bottom edges (GL, y up), width and height, whole pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The region's top-left in the atlas. */
  ax: number;
  ay: number;
  /** Padding, line height and font size, px. */
  pad: number;
  line: number;
  font: number;
  /** Where the banner's text sits in the region, and its half height. */
  bannerTop: number;
  bannerHalf: number;
  /** Where the scrolling area starts, from the screen's top (beyond the screen when none). */
  scrollTop: number;
}

const newBox = (): ScreenBox => ({
  x: 0,
  y: 0,
  w: 1,
  h: 1,
  ax: 0,
  ay: 0,
  pad: 0,
  line: 1,
  font: 1,
  bannerTop: 0,
  bannerHalf: 1,
  scrollTop: 1e5,
});

/** Draw order: the top row first, so the lower monitors stand in front of their stands. */
const DRAW_ORDER = [3, 2, 4, 0, 6, 1, 5] as const;

const P = TEXT_ROLES.primary;
const M = TEXT_ROLES.muted;
const A = TEXT_ROLES.up;

/**
 * The thriller hacker's den: a dark room lit only by a wall of monitors, the
 * speaker in front of them. A terminal types commands under the owner's
 * handle, code steps past, a trace hops across a world map, a grid of hex
 * decrypts itself column by column, a progress bar fills, a network passes a
 * pulse along and an oscilloscope traces; now and then one screen shows an
 * alert banner.
 *
 * The room is drawn once per resize. Every screen's text and graphics are
 * drawn with a 2D canvas into one atlas, a changed rect at a time, at a few
 * redraws a second at most. Each frame: the screens' light on the wall at
 * quarter size (only when it changes), the room lit by it, then each monitor
 * with its screen composited from the atlas.
 */
export const hackerden = defineEffect(hackerdenMeta, {
  create(gl) {
    return withScope((scope) => {
      const roomProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const glowProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, GLOW_FRAGMENT);
      const compositeProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const monitorProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, MONITOR_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uK"]);
      const gu = createUniforms(gl, glowProgram, ["uRes", "uLow", "uK", "uRects", "uLights"]);
      const cu = createUniforms(gl, compositeProgram, ["uRoom", "uGlow", "uRes", "uK", "uStrip"]);
      const mu = createUniforms(gl, monitorProgram, [
        "uRes",
        "uK",
        "uScale",
        "uAtlas",
        "uMask",
        "uAtlasSize",
        "uFrame",
        "uBase",
        "uScreen",
        "uOrigin",
        "uScroll",
        "uBanner",
        "uAlertCol",
        "uPrimary",
        "uMuted",
        "uAccent",
        "uLife",
        "uKind",
        "uPoints",
        "uRoute",
        "uPulse",
        "uWave",
      ]);
      gl.useProgram(compositeProgram);
      cu.i1("uRoom", 0);
      cu.i1("uGlow", 1);
      gl.useProgram(monitorProgram);
      mu.i1("uAtlas", 0);
      mu.i1("uMask", 1);
      gl.useProgram(null);

      const atlas = createCanvasAtlas(gl, scope);
      // Until the land mask loads, a single "far out at sea" texel.
      const mask = scope.add(
        createDataTexture(gl, {
          width: 1,
          height: 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: new Uint8Array([0]),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const maskImage = loadLandMask(scope, "Hacker Thriller Den");
      const maxTexture = Math.min(8192, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096);

      let roomTarget: RenderTarget | null = null;
      let glowTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
        glowTarget?.dispose();
      });

      const den = createDen(SEED);
      const kinds = den.kinds;
      const boxes = SLOTS.map(() => newBox());
      const ease = createColorEase(COLOUR_FLOATS);
      const target = new Float32Array(COLOUR_FLOATS);
      let targetPalette = "";
      const rects = new Float32Array(4 * MAX_SCREENS);
      const lights = new Float32Array(3 * MAX_SCREENS);
      const points = new Float32Array(2 * (MAX_HOPS + 1));

      let width = 1;
      let height = 1;
      let lowWidth = 1;
      let lowHeight = 1;
      let k = 1;
      let scale = 1;
      let roomDrawn = false;
      let glowStale = true;
      /** The atlas needs every screen drawn again (a resize, or the atlas was lost). */
      let redrawAll = true;
      let handle = "";
      let prompt = "";
      /** The banner drawn into each slot's region: an `ALERT_TEXTS` index, or -1. */
      const bannerDrawn = new Int8Array(MAX_SCREENS).fill(-1);

      const font = (b: ScreenBox, size = 1, bold = false) =>
        `${bold ? "bold " : ""}${String(Math.max(1, Math.round(b.font * size)))}px ${MONO_FONT_STACK}`;

      /** Clears a rect of a slot's region (in its own px) and clips drawing to it. */
      const begin = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        x: number,
        y: number,
        w: number,
        h: number,
      ) => {
        atlas.clear(b.ax + x, b.ay + y, w, h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(b.ax + x, b.ay + y, w, h);
        ctx.clip();
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
      };

      const text = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        s: string,
        x: number,
        y: number,
        role: string,
        f: string,
        maxWidth?: number,
        align: CanvasTextAlign = "left",
      ) => {
        if (s === "") {
          return;
        }
        ctx.font = f;
        ctx.fillStyle = role;
        ctx.textAlign = align;
        const xx = Math.round(b.ax + x);
        const yy = Math.round(b.ay + y);
        if (maxWidth === undefined) {
          ctx.fillText(s, xx, yy);
        } else {
          ctx.fillText(s, xx, yy, Math.max(1, maxWidth));
        }
      };

      /** The y of row `r`'s middle in a region, rows counted from the top padding. */
      const rowY = (b: ScreenBox, r: number) => b.pad + (r + 0.5) * b.line;

      // ---- Per-kind drawing -------------------------------------------------

      const drawTerminalRow = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        t: TerminalSim,
        row: number,
      ) => {
        // Rows sit one line below the scroll top, the hidden row (-1) just above them.
        const y = b.scrollTop + b.line * (row + 1);
        begin(ctx, b, 0, y, b.w, b.line);
        const i = terminalLine(t, row);
        if (i >= 0) {
          const cw = b.font * 0.6;
          const cy = y + b.line * 0.5;
          let x = b.pad;
          if (t.prompt[i]) {
            text(ctx, b, prompt, x, cy, A, font(b));
            x += prompt.length * cw;
          }
          const s = t.lines[i];
          text(ctx, b, s, x, cy, t.prompt[i] ? P : M, font(b));
          if (i === t.lines.length - 1 && t.prompt[i]) {
            ctx.fillStyle = P;
            ctx.fillRect(
              Math.round(b.ax + x + s.length * cw + 1),
              Math.round(b.ay + y + b.line * 0.15),
              Math.max(1, Math.round(cw)),
              Math.max(1, Math.round(b.line * 0.72)),
            );
          }
        }
        ctx.restore();
      };

      const drawTerminal = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        t: TerminalSim,
        all: boolean,
      ) => {
        if (all) {
          begin(ctx, b, 0, 0, b.w, b.scrollTop);
          text(ctx, b, `TTY3  ${prompt.trim()}`, b.pad, rowY(b, 0), M, font(b), b.w - 2 * b.pad);
          ctx.restore();
          for (let r = -1; r < t.rows; r++) {
            drawTerminalRow(ctx, b, t, r);
          }
        } else if (t.dirty >= 0) {
          // The changed row, and the one above (which may have lost the cursor).
          if (t.dirty > 0) {
            drawTerminalRow(ctx, b, t, t.dirty - 1);
          }
          drawTerminalRow(ctx, b, t, t.dirty);
        }
        t.dirty = DIRTY_NONE;
      };

      const drawCode = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        c: CodeSim,
        all: boolean,
      ) => {
        if (!all && c.dirty === DIRTY_NONE) {
          return;
        }
        c.dirty = DIRTY_NONE;
        const cw = b.font * 0.6;
        begin(ctx, b, 0, 0, b.w, b.scrollTop);
        text(ctx, b, "core.c", b.pad, rowY(b, 0), M, font(b));
        text(
          ctx,
          b,
          `Ln ${String(c.first + 1 + (c.rows >> 1))}`,
          b.w - b.pad,
          rowY(b, 0),
          M,
          font(b),
          undefined,
          "right",
        );
        ctx.restore();
        begin(ctx, b, 0, b.scrollTop, b.w, b.h + b.line - b.scrollTop);
        const gutter = b.pad + 5 * cw;
        for (let r = 0; r < c.lines.length; r++) {
          const cy = b.scrollTop + b.line * (r + 0.5);
          text(ctx, b, String(c.first + r), gutter - cw, cy, M, font(b), undefined, "right");
          const line = c.lines[r];
          let x = gutter + line.indent * 2 * cw;
          for (const part of line.parts) {
            const role = part.role === CODE_ACCENT ? A : part.role === CODE_COMMENT ? M : P;
            text(ctx, b, part.text, x, cy, role, font(b));
            x += part.text.length * cw;
          }
        }
        ctx.restore();
      };

      const cellOf = (b: ScreenBox, d: DecryptSim, cell: number) => {
        const cw = (b.w - 2 * b.pad) / d.cols;
        const c = cell % d.cols;
        const r = Math.floor(cell / d.cols);
        return { x: b.pad + c * cw, y: b.pad + (r + 1) * b.line, w: cw };
      };

      const drawDecryptCell = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        d: DecryptSim,
        cell: number,
      ) => {
        const { x, y, w } = cellOf(b, d, cell);
        begin(ctx, b, x, y, w, b.line);
        const v = d.values[cell];
        text(
          ctx,
          b,
          HEX_PAIRS[v],
          x + w / 2,
          y + b.line / 2,
          d.settled[cell] ? A : P,
          font(b),
          w,
          "center",
        );
        ctx.restore();
      };

      const drawDecrypt = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        d: DecryptSim,
        all: boolean,
      ) => {
        const total = d.cols * d.rows;
        if (all || d.dirtyAll) {
          begin(ctx, b, 0, 0, b.w, b.pad + b.line);
          text(ctx, b, "DECRYPT  AES-X/4096", b.pad, rowY(b, 0), M, font(b), b.w - 2 * b.pad);
          ctx.restore();
          for (let i = 0; i < total; i++) {
            drawDecryptCell(ctx, b, d, i);
          }
        } else {
          for (let i = 0; i < d.changedCount; i++) {
            drawDecryptCell(ctx, b, d, d.changed[i]);
          }
        }
        if (all || d.dirtyAll || d.statusDirty) {
          const y = b.pad + (d.rows + 1.5) * b.line;
          begin(
            ctx,
            b,
            0,
            Math.floor(y - b.line * 0.1),
            b.w,
            b.h + b.line - Math.floor(y - b.line * 0.1),
          );
          const done = d.settledCount >= total;
          const status = done
            ? "KEY FOUND"
            : `KEY ${String(Math.floor((100 * d.settledCount) / total)).padStart(2, " ")}%`;
          text(
            ctx,
            b,
            status,
            b.pad,
            y + b.line * 0.5,
            done ? A : P,
            font(b, 1, true),
            b.w - 2 * b.pad,
          );
          ctx.restore();
        }
        d.changedCount = 0;
        d.dirtyAll = false;
        d.statusDirty = false;
      };

      const drawProgress = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        p: ProgressSim,
        all: boolean,
      ) => {
        const listTop = b.pad + 6 * b.line;
        if (all || p.dirty === DIRTY_ALL) {
          begin(ctx, b, 0, 0, b.w, b.pad + b.line);
          text(ctx, b, "UPLINK  NODE-7", b.pad, rowY(b, 0), M, font(b), b.w - 2 * b.pad);
          ctx.restore();
        }
        if (all || p.barDirty || p.dirty === DIRTY_ALL) {
          begin(ctx, b, 0, b.pad + b.line, b.w, 5 * b.line);
          const done = p.percent >= 100;
          text(
            ctx,
            b,
            done ? "COMPLETE" : `${progressTaskOf(p)}...`,
            b.pad,
            rowY(b, 1.6),
            done ? A : P,
            font(b, 1.7, true),
            b.w - 2 * b.pad,
          );
          const bx = Math.round(b.ax + b.pad);
          const by = Math.round(b.ay + b.pad + 3 * b.line);
          const bw = Math.round(b.w - 2 * b.pad);
          const bh = Math.max(3, Math.round(b.line * 1.1));
          const lw = Math.max(1, Math.round(scale));
          ctx.fillStyle = M;
          ctx.fillRect(bx, by, bw, lw);
          ctx.fillRect(bx, by + bh - lw, bw, lw);
          ctx.fillRect(bx, by, lw, bh);
          ctx.fillRect(bx + bw - lw, by, lw, bh);
          ctx.fillStyle = P;
          const fill = Math.round(((bw - 4 * lw) * p.percent) / 100);
          if (fill > 0) {
            ctx.fillRect(bx + 2 * lw, by + 2 * lw, fill, bh - 4 * lw);
          }
          const eta = Math.max(0, Math.round((100 - p.percent) * 0.4));
          text(ctx, b, `${p.percent.toFixed(1)}%`, b.pad, rowY(b, 4.6), P, font(b));
          text(
            ctx,
            b,
            `ETA 00:${String(eta).padStart(2, "0")}`,
            b.w - b.pad,
            rowY(b, 4.6),
            M,
            font(b),
            undefined,
            "right",
          );
          ctx.restore();
        }
        const drawRow = (r: number) => {
          const y = listTop + r * b.line;
          begin(ctx, b, 0, y, b.w, b.line);
          if (r < p.files) {
            const current = r === p.files - 1 && p.percent < 100;
            text(
              ctx,
              b,
              `${current ? ">" : "+"} ${progressFileAt(p, r)}`,
              b.pad,
              y + b.line / 2,
              current ? P : M,
              font(b),
              b.w - 2 * b.pad,
            );
          }
          ctx.restore();
        };
        if (all || p.dirty === DIRTY_ALL) {
          for (let r = 0; r < p.rows; r++) {
            drawRow(r);
          }
        } else if (p.dirty >= 0) {
          if (p.dirty > 0) {
            drawRow(p.dirty - 1);
          }
          drawRow(p.dirty);
        }
        p.barDirty = false;
        p.dirty = DIRTY_NONE;
      };

      /** The network's graph area within its screen: left, top, width, height (px). */
      const graphArea = (b: ScreenBox) => {
        const top = b.pad + b.line * 1.3;
        return { x: b.pad, y: top, w: b.w - 2 * b.pad, h: b.h - b.pad - b.line * 1.3 - top };
      };

      const drawNetwork = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        n: NetworkSim,
        all: boolean,
      ) => {
        if (all) {
          begin(ctx, b, 0, 0, b.w, b.pad + b.line);
          text(ctx, b, "NETWORK  MESH-9", b.pad, rowY(b, 0), M, font(b), b.w - 2 * b.pad);
          ctx.restore();
        }
        const g = graphArea(b);
        if (all || n.dirty) {
          begin(ctx, b, 0, Math.floor(g.y), b.w, Math.ceil(g.h + 1));
          const gx = (i: number) => b.ax + g.x + n.nodes[2 * i] * g.w;
          const gy = (i: number) => b.ay + g.y + n.nodes[2 * i + 1] * g.h;
          ctx.lineWidth = Math.max(1, scale);
          ctx.strokeStyle = M;
          ctx.beginPath();
          for (let i = 0; i < n.links.length; i += 2) {
            ctx.moveTo(gx(n.links[i]), gy(n.links[i]));
            ctx.lineTo(gx(n.links[i + 1]), gy(n.links[i + 1]));
          }
          ctx.stroke();
          ctx.lineWidth = Math.max(1.5, 2 * scale);
          ctx.strokeStyle = A;
          ctx.beginPath();
          ctx.moveTo(gx(n.path[0]), gy(n.path[0]));
          for (let i = 1; i < n.pathLen; i++) {
            ctx.lineTo(gx(n.path[i]), gy(n.path[i]));
          }
          ctx.stroke();
          ctx.fillStyle = P;
          for (let i = 0; i < n.nodes.length / 2; i++) {
            ctx.beginPath();
            ctx.arc(gx(i), gy(i), Math.max(2, 3.5 * scale), 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.font = font(b, 0.8);
          ctx.textBaseline = "middle";
          for (let i = 0; i < n.nodes.length / 2; i++) {
            const right = n.nodes[2 * i] < 0.75;
            ctx.textAlign = right ? "left" : "right";
            ctx.fillStyle = M;
            ctx.fillText(
              `N${String(i + 1)}`,
              gx(i) + (right ? 1 : -1) * 7 * scale,
              gy(i) - 6 * scale,
            );
          }
          ctx.restore();
          n.dirty = false;
        }
        if (all || n.statsDirty) {
          const y = b.h - b.pad - b.line;
          begin(ctx, b, 0, Math.floor(y), b.w, Math.ceil(b.h + b.line - y));
          const pkts = 10000 + Math.floor(unitHash(n.seed, 100, n.ticks) * 89999);
          const lat = 8 + Math.floor(unitHash(n.seed, 101, n.ticks) * 60);
          text(
            ctx,
            b,
            `PKT ${String(pkts)}  LAT ${String(lat)}ms`,
            b.pad,
            y + b.line / 2,
            P,
            font(b),
            b.w - 2 * b.pad,
          );
          ctx.restore();
          n.statsDirty = false;
        }
      };

      const drawWave = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        w: WaveSim,
        all: boolean,
      ) => {
        if (all) {
          begin(ctx, b, 0, 0, b.w, b.h + b.line);
          text(ctx, b, "SIGNAL  CH-2", b.pad, rowY(b, 0), M, font(b), b.w - 2 * b.pad);
          // A still graticule behind the trace.
          ctx.fillStyle = "rgba(0, 255, 0, 0.3)";
          const top = Math.round(b.ay + b.h * 0.16);
          const bot = Math.round(b.ay + b.h * 0.84);
          const lw = Math.max(1, Math.round(scale));
          for (let i = 0; i <= 8; i++) {
            ctx.fillRect(Math.round(b.ax + (i / 8) * (b.w - lw)), top, lw, bot - top);
          }
          for (let i = 0; i <= 4; i++) {
            ctx.fillRect(Math.round(b.ax), Math.round(top + (i / 4) * (bot - top - lw)), b.w, lw);
          }
          ctx.restore();
        }
        if (all || w.statsDirty) {
          const y = b.h - b.pad - b.line;
          begin(ctx, b, 0, Math.floor(y), b.w, Math.ceil(b.h + b.line - y));
          const freq = (2 + w.amplitude * 1.5 + unitHash(w.seed, 102, w.ticks) * 0.08).toFixed(2);
          text(
            ctx,
            b,
            `FREQ ${freq} kHz  AMP ${w.amplitude.toFixed(2)}`,
            b.pad,
            y + b.line / 2,
            P,
            font(b),
            b.w - 2 * b.pad,
          );
          ctx.restore();
          w.statsDirty = false;
        }
      };

      const drawMapRow = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        m: MapSim,
        row: number,
        panelW: number,
      ) => {
        const y = b.pad + (row + 1) * b.line;
        begin(ctx, b, 0, y, panelW, b.line);
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.fillRect(b.ax, b.ay + y, panelW, b.line);
        const reached = m.hop >= 1 ? m.count : m.count - 1;
        if (row < reached) {
          const n = m.trace * 16 + row;
          const s = `${String(row + 1).padStart(2, "0")} ${docIp(m.seed, n)} ${nodeName(m.seed, n)}`;
          text(
            ctx,
            b,
            s,
            b.pad,
            y + b.line / 2,
            row === reached - 1 ? P : M,
            font(b),
            panelW - 2 * b.pad,
          );
        } else if (row === reached && m.finished) {
          text(
            ctx,
            b,
            "TRACE COMPLETE",
            b.pad,
            y + b.line / 2,
            A,
            font(b, 1, true),
            panelW - 2 * b.pad,
          );
        }
        ctx.restore();
      };

      const drawMap = (
        ctx: OffscreenCanvasRenderingContext2D,
        b: ScreenBox,
        m: MapSim,
        all: boolean,
      ) => {
        const panelW = Math.round(Math.min(b.w * 0.4, b.font * 0.6 * 30 + 2 * b.pad));
        if (all || m.dirty === DIRTY_ALL) {
          begin(ctx, b, 0, 0, panelW, b.pad + b.line);
          ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
          ctx.fillRect(b.ax, b.ay, panelW, b.pad + b.line);
          text(ctx, b, "TRACE ROUTE", b.pad, rowY(b, 0), M, font(b), panelW - 2 * b.pad);
          ctx.restore();
          for (let r = 0; r <= MAX_HOPS + 1; r++) {
            drawMapRow(ctx, b, m, r, panelW);
          }
        } else if (m.dirty >= 0) {
          drawMapRow(ctx, b, m, m.dirty, panelW);
          if (m.dirty > 0) {
            drawMapRow(ctx, b, m, m.dirty - 1, panelW);
          }
        }
        m.dirty = DIRTY_NONE;
      };

      const drawScreen = (
        ctx: OffscreenCanvasRenderingContext2D,
        s: ScreenSim,
        b: ScreenBox,
        all: boolean,
      ) => {
        switch (s.kind) {
          case "terminal":
            if (all || s.dirty === DIRTY_ALL) {
              drawTerminal(ctx, b, s, true);
            } else {
              drawTerminal(ctx, b, s, false);
            }
            return;
          case "code":
            drawCode(ctx, b, s, all);
            return;
          case "decrypt":
            drawDecrypt(ctx, b, s, all);
            return;
          case "progress":
            drawProgress(ctx, b, s, all);
            return;
          case "network":
            drawNetwork(ctx, b, s, all);
            return;
          case "wave":
            drawWave(ctx, b, s, all);
            return;
          case "map":
            drawMap(ctx, b, s, all);
            return;
        }
      };

      const drawBanner = (ctx: OffscreenCanvasRenderingContext2D, b: ScreenBox, which: number) => {
        begin(ctx, b, 0, b.bannerTop, b.w, 2 * b.bannerHalf);
        ctx.font = `bold ${String(Math.max(1, Math.round(b.bannerHalf * 0.85)))}px ${MONO_FONT_STACK}`;
        ctx.fillStyle = P;
        ctx.textAlign = "center";
        ctx.fillText(
          ALERT_TEXTS[which],
          Math.round(b.ax + b.w / 2),
          Math.round(b.ay + b.bannerTop + b.bannerHalf),
          Math.max(1, b.w * 0.88),
        );
        ctx.restore();
      };

      /** Lays out every screen's box and its atlas region for the frame's size. */
      const layout = () => {
        let ax = 0;
        let ay = 0;
        let shelf = 0;
        let atlasW = 1;
        for (let s = 0; s < MAX_SCREENS; s++) {
          const slot = SLOTS[s];
          const b = boxes[s];
          const x0 = Math.round(width / 2 + (slot.x - slot.hw) * height * k);
          const x1 = Math.round(width / 2 + (slot.x + slot.hw) * height * k);
          const y0 = Math.round(height / 2 + (slot.y - slot.hh) * height * k);
          const y1 = Math.round(height / 2 + (slot.y + slot.hh) * height * k);
          b.x = x0;
          b.y = y0;
          b.w = Math.max(1, x1 - x0);
          b.h = Math.max(1, y1 - y0);
          b.pad = Math.max(1, Math.round(b.h * 0.045));
          const rows = slotRows(slot);
          b.line = Math.max(1, Math.floor((b.h - 2 * b.pad) / rows));
          const cols =
            kinds[s] === "terminal" ? TERMINAL_COLUMNS : kinds[s] === "code" ? CODE_COLUMNS : 0;
          const byWidth = cols > 0 ? (b.w - 2 * b.pad) / (cols * 0.6) : Infinity;
          b.font = Math.max(1, Math.min(b.line * 0.8, byWidth));
          b.scrollTop = kinds[s] === "terminal" || kinds[s] === "code" ? b.pad + b.line : 1e5;
          b.bannerHalf = Math.max(1, Math.round(b.h * 0.1));
          b.bannerTop = b.h + b.line;
          const rh = b.bannerTop + 2 * b.bannerHalf;
          if (ax + b.w > maxTexture && ax > 0) {
            ax = 0;
            ay += shelf;
            shelf = 0;
          }
          b.ax = ax;
          b.ay = ay;
          ax += b.w;
          shelf = Math.max(shelf, rh);
          atlasW = Math.max(atlasW, ax);
        }
        return { w: atlasW, h: Math.min(maxTexture, ay + shelf) };
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          lowWidth = Math.max(1, Math.ceil(width / GLOW_DIVISOR));
          lowHeight = Math.max(1, Math.ceil(height / GLOW_DIVISOR));
          k = Math.max(0.6, fitScale(width / height));
          scale = height / 1080;
          for (let s = 0; s < MAX_SCREENS; s++) {
            const slot = SLOTS[s];
            rects[4 * s] = slot.x;
            rects[4 * s + 1] = slot.y;
            rects[4 * s + 2] = slot.hw + BEZEL;
            rects[4 * s + 3] = slot.hh + BEZEL;
          }
          const size = layout();
          atlas.resize(size.w, size.h);
          redrawAll = true;
          roomTarget?.dispose();
          roomTarget = null;
          roomTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          glowTarget?.dispose();
          glowTarget = null;
          glowTarget = createRenderTarget(gl, lowWidth, lowHeight, gl.RGBA8);
          roomDrawn = false;
          glowStale = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
          stepDen(den, step, p.pace, p.screens, p.alerts);

          // Colours: the palette's target for every screen, eased.
          if (p.palette !== targetPalette) {
            targetPalette = p.palette;
            paletteTarget(toPalette(p.palette), kinds, target);
          }
          const wasMoving = ease.moving;
          const colours = ease.step(target, step, PALETTE_EASE);

          // The screens' text, a changed rect at a time.
          const h = promptHandle(p.handle);
          const ctx = atlas.ctx;
          if (ctx) {
            if (h !== handle) {
              handle = h;
              prompt = promptFor(h);
              const t = den.screens[kinds.indexOf("terminal")];
              if (t.kind === "terminal") {
                t.dirty = DIRTY_ALL;
              }
            }
            const all = redrawAll;
            redrawAll = false;
            for (let s = 0; s < MAX_SCREENS; s++) {
              drawScreen(ctx, den.screens[s], boxes[s], all);
              if (all) {
                bannerDrawn[s] = -1;
              }
            }
            const alert = den.alerts;
            if (alert.slot >= 0 && bannerDrawn[alert.slot] !== alert.text) {
              bannerDrawn[alert.slot] = alert.text;
              drawBanner(ctx, boxes[alert.slot], alert.text);
            }
            atlas.flush();
          }

          // The screens' light: each slot's colour by its fade, plus a red banner's tint.
          const alert = den.alerts;
          const level = alert.slot >= 0 ? alertLevel(alert) : 0;
          for (let s = 0; s < MAX_SCREENS; s++) {
            const o = s * SLOT_FLOATS;
            const g = KIND_GLOW[kinds[s]] * den.life[s];
            const red = s === alert.slot && alert.text === RED_ALERT ? level * ALERT_GLOW : 0;
            for (let c = 0; c < 3; c++) {
              const v =
                (0.7 * colours[o + c] + 0.3 * colours[o + 3 + c]) * g * (1 - 0.5 * red) +
                RED[c] * red * den.life[s];
              if (v !== lights[3 * s + c]) {
                lights[3 * s + c] = v;
                glowStale = true;
              }
            }
          }
          if (wasMoving) {
            glowStale = true;
          }

          gl.activeTexture(gl.TEXTURE1);
          const image = maskImage.take();
          if (image) {
            gl.bindTexture(gl.TEXTURE_2D, mask);
            uploadLandMask(gl, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.bindTexture(gl.TEXTURE_2D, null);
          }
          gl.activeTexture(gl.TEXTURE0);

          if (!roomTarget || !glowTarget) {
            return;
          }
          // 1. The room, once per resize.
          if (!roomDrawn) {
            roomDrawn = true;
            gl.useProgram(roomProgram);
            ru.f2("uRes", width, height);
            ru.f1("uK", k);
            roomTarget.bind();
            triangle.draw();
          }
          // 2. The screens' light, when it changes.
          if (glowStale) {
            glowStale = false;
            gl.useProgram(glowProgram);
            gu.f2("uRes", width, height);
            gu.f2("uLow", lowWidth, lowHeight);
            gu.f1("uK", k);
            gl.uniform4fv(gu.loc.uRects, rects);
            gl.uniform3fv(gu.loc.uLights, lights);
            glowTarget.bind();
            triangle.draw();
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);

          // 3. The room, lit.
          gl.useProgram(compositeProgram);
          cu.f2("uRes", width, height);
          cu.f1("uK", k);
          cu.f3(
            "uStrip",
            colours[STRIP_OFFSET],
            colours[STRIP_OFFSET + 1],
            colours[STRIP_OFFSET + 2],
          );
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, roomTarget.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, glowTarget.texture);
          triangle.draw();

          // 4. The monitors, back to front.
          gl.useProgram(monitorProgram);
          mu.f2("uRes", width, height);
          mu.f1("uK", k);
          mu.f1("uScale", scale);
          mu.f2("uAtlasSize", atlas.width, atlas.height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, mask);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          const deskTop = -0.5 / k + DESK_TOP;
          for (const s of DRAW_ORDER) {
            const life = den.life[s];
            if (!(life > 0)) {
              continue;
            }
            const slot = SLOTS[s];
            const top = slot.y + slot.hh + BEZEL;
            const base = slot.wall ? slot.y - slot.hh - BEZEL - WALL_ARM : deskTop;
            const bottom = base - 0.01;
            const hw = Math.max(slot.hw + BEZEL, 0.05);
            if (
              !scissorBox(
                gl,
                width,
                height,
                slot.x * k,
                ((top + bottom) / 2) * k,
                hw * k,
                ((top - bottom) / 2) * k,
                2,
              )
            ) {
              continue;
            }
            const b = boxes[s];
            const o = s * SLOT_FLOATS;
            mu.f4("uFrame", slot.x, slot.y, slot.hw, slot.hh);
            if (slot.wall) {
              mu.f3("uBase", base, 0.016, 0.012);
            } else {
              mu.f3("uBase", base, Math.min(0.045, Math.max(0.025, slot.hw * 0.28)), 0.005);
            }
            mu.f4("uScreen", b.x, b.y, b.w, b.h);
            mu.f2("uOrigin", b.ax, b.ay);
            mu.f3("uPrimary", colours[o], colours[o + 1], colours[o + 2]);
            mu.f3("uMuted", colours[o + 3], colours[o + 4], colours[o + 5]);
            mu.f3("uAccent", colours[o + 6], colours[o + 7], colours[o + 8]);
            mu.f1("uLife", life);
            const sim = den.screens[s];
            let shift = 0;
            if (sim.kind === "terminal" || sim.kind === "code") {
              shift = lineStepOffset(sim.stepAge) * b.line;
            }
            mu.f3("uScroll", b.scrollTop, b.line, shift);
            const showing = s === alert.slot && level > 0;
            mu.f3("uBanner", b.bannerHalf, showing ? level : 0, b.bannerTop);
            if (showing) {
              const red = alert.text === RED_ALERT;
              mu.f3(
                "uAlertCol",
                red ? RED[0] : colours[o],
                red ? RED[1] : colours[o + 1],
                red ? RED[2] : colours[o + 2],
              );
            }
            mu.i1("uKind", kindCode(sim));
            if (sim.kind === "map") {
              points.set(sim.points.subarray(0, 2 * sim.count));
              gl.uniform2fv(mu.loc.uPoints, points);
              mu.f4("uRoute", sim.count, hopEase(sim), sim.level, 0);
            } else if (sim.kind === "network") {
              const g = graphArea(b);
              mu.f3(
                "uPulse",
                (g.x + sim.pulseX * g.w) / b.w,
                (g.y + sim.pulseY * g.h) / b.h,
                smoothstep(0, 1, sim.pulseLevel),
              );
            } else if (sim.kind === "wave") {
              mu.f3("uWave", sim.phase1, sim.phase2, sim.amplitude);
            }
            triangle.draw();
          }
          gl.disable(gl.SCISSOR_TEST);
          gl.disable(gl.BLEND);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});

/** Every byte as two upper-case hex digits. */
const HEX_PAIRS = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).toUpperCase().padStart(2, "0"),
);

function kindCode(s: ScreenSim): number {
  switch (s.kind) {
    case "map":
      return KIND_MAP;
    case "wave":
      return KIND_WAVE;
    case "network":
      return KIND_NETWORK;
    case "terminal":
    case "code":
    case "decrypt":
    case "progress":
      break;
  }
  return 0;
}
