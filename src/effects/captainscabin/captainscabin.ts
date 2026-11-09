import { createChangeKey } from "../change-key";
import type { Rgb } from "../color";
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
  withScope,
  scopedProgram,
} from "../gl";
import { createSkyState, type SkyState } from "../horizon/horizon-sim";
import { lowResSize } from "../lowres";
import { approach, wrap } from "../math";
import { buildPeriodicNoiseTexture, createRng } from "../noise";
import { landColor, presetSky } from "../sea/sea-sim";
import { createSeaWater, createSeaWaterFrame, SEA_SKY_GLSL } from "../sea/sea-water";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { advanceSwell } from "../sway";
import { defineEffect } from "../types";
import {
  DROP_CLEAR,
  DROP_DIR_GLSL,
  DROP_FRAGMENT,
  DROP_VERTEX,
  OFFSET_RANGE,
} from "../windowrain/windowrain-drops";
import {
  createRainSim,
  DEFAULT_CONFIG,
  instanceCapacity,
  type RainSimParams,
  resizeRainSim,
  stepRainSim,
  writeDropInstances,
} from "../windowrain/windowrain-sim";
import { type CabinWeather, captainscabinMeta } from "./captainscabin.meta";
import {
  BEAM_Y0,
  BEAM_Y1,
  cabinLayout,
  CAME_W,
  createLightning,
  createMotion,
  createShips,
  createWeatherLook,
  DECK_Y,
  easeGain,
  easeWeather,
  EYE_HEIGHT,
  flameAt,
  FLAME_UP,
  FOCAL,
  FRAME_W,
  HEAD_BOW,
  HEAD_Y,
  HORIZON_Y,
  LANTERN_H,
  LANTERN_HALF,
  LANTERN_ROD,
  LIGHT_X,
  motionAt,
  PANE_COLS,
  PANE_ROWS,
  PILASTER_HALF,
  REF_HEIGHT,
  ROLL_SWELL,
  SEAT_Y,
  SHELF_Y0,
  SHELF_Y1,
  SHELVES,
  shipView,
  SILL_BOW,
  SILL_Y,
  stepLightning,
  stepShips,
  swellGain,
  TABLE_Y,
  WEATHER_SKIES,
  WEATHER_TONES,
} from "./captainscabin-sim";

const v3 = (c: Rgb | readonly number[]) => `vec3(${F(c[0])}, ${F(c[1])}, ${F(c[2])})`;

/** The view outside renders at about this many reference px per texel: it is soft and seen through old glass. */
const VIEW_TEXEL_REF = 2;
/** Extra view round the windows (frame heights), so the rolled and pitched view never runs out at the panes' edges. */
const VIEW_MARGIN = 0.14;
/** The lantern's warm light, its reach (reference px) and its strength. */
const LAMP: Rgb = [1, 0.68, 0.36];
const LAMP_R = 400;
const LAMP_POWER = 1.25;
/** Seconds for the lantern to come up or go down when it is lit or put out. */
const LAMP_EASE = 0.8;
/** How far the light through the windows slides across the deck per radian of roll (reference px). */
const LIGHT_SHIFT = 700;
/** The old glass's wobble: a fixed offset per pane, and a finer ripple across each (reference px). */
const WOBBLE_PANE = 4;
const WOBBLE_RIPPLE = 6;
/** Refraction through the raindrops, as a share of Rain on a Window's, kept low so it doesn't shimmer. */
const REFRACTION = 0.35;
/** The wake: half width at the stern (m), its spread per metre back, the ship's speed (m/s) and how far it lasts (m). */
const WAKE_W0 = 4;
const WAKE_SPREAD = 0.07;
const SHIP_SPEED = 2.6;
const WAKE_FADE = 420;
/** Sizes of the wake's two noise layers: across and along (m per tile). */
const WAKE_TILE_A: readonly [number, number] = [36, 64];
const WAKE_TILE_B: readonly [number, number] = [15, 26];
/** Lightning's light: on the sky outside at its peak, and the share of it that reaches into the cabin. */
const FLASH_RGB: Rgb = [0.26, 0.29, 0.34];
const FLASH_IN = 0.35;
/** How much darker the storm's sky is than the Calm Sea's overcast. */
const STORM_DARKEN = 0.6;
/** Cloud plane height (in focal units, for the perspective), noise scale and drift (tiles per second). */
const CLOUD_HEIGHT = 1;
const CLOUD_SCALE = 0.11;
const CLOUD_DRIFT = 0.003;
const CLOUD_NOISE = 128;
const HV = HORIZON_Y * REF_HEIGHT;

const OAK: Rgb = [0.2, 0.115, 0.062];
const PAINT: Rgb = [0.065, 0.16, 0.17];
const GILT: Rgb = [0.74, 0.54, 0.23];
const LEAD: Rgb = [0.045, 0.045, 0.05];
const BRASS: Rgb = [0.8, 0.58, 0.27];
const IRON: Rgb = [0.045, 0.045, 0.05];
const CUSHION: Rgb = [0.34, 0.06, 0.05];
const PARCHMENT: Rgb = [0.74, 0.63, 0.44];
const INK: Rgb = [0.24, 0.16, 0.1];
const BOOKS: readonly Rgb[] = [
  [0.36, 0.08, 0.06],
  [0.2, 0.12, 0.06],
  [0.1, 0.18, 0.12],
  [0.32, 0.2, 0.09],
  [0.12, 0.1, 0.16],
];

/** Hashes and value noise, for grain and variation in the cached cabin. */
const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), t.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), t.x), t.y);
}
`;

/**
 * The row of stern windows, shared by the cabin and the composite so both
 * agree on every pane: the bowed sill and head, and the leaded glazing.
 */
const WINDOW_GLSL = /* glsl */ `
/** Window glass left and right, number of lights, frame centre (reference px). */
uniform vec4 uWin;
float bow(float x) {
  float u = clamp((x - uWin.w) / ((uWin.y - uWin.x) * 0.5), -1.0, 1.0);
  return 1.0 - u * u;
}
float sillAt(float x) { return ${F(SILL_Y)} + ${F(SILL_BOW)} * bow(x); }
float headAt(float x) { return ${F(HEAD_Y)} - ${F(HEAD_BOW)} * bow(x); }
/** Distance from x to the nearest boundary between two lights (a pilaster's centre). */
float pilasterDist(float x) {
  float pitch = (uWin.y - uWin.x) / uWin.z;
  float lx = x - uWin.x;
  return abs(lx - floor(lx / pitch + 0.5) * pitch);
}
/**
 * The leaded glazing at p: xy = the pane's column and row across the whole
 * row of windows, z = distance into the glazed area (negative on the frame or
 * a pilaster), w = distance into the glass from the nearest lead came.
 */
vec4 paneAt(vec2 p) {
  float pitch = (uWin.y - uWin.x) / uWin.z;
  float lx = (p.x - uWin.x) / pitch;
  float li = floor(lx);
  float within = (lx - li) * pitch;
  float gw = pitch - ${F(2 * PILASTER_HALF)};
  float s = sillAt(p.x);
  float h = headAt(p.x);
  float glaze = min(min(within - ${F(PILASTER_HALF)}, pitch - ${F(PILASTER_HALF)} - within), min(p.y - s, h - p.y));
  glaze = min(glaze, min(p.x - uWin.x, uWin.y - p.x));
  float u = (within - ${F(PILASTER_HALF)}) / gw * ${F(PANE_COLS)};
  float v = (p.y - s) / (h - s) * ${F(PANE_ROWS)};
  float du = min(fract(u), 1.0 - fract(u)) * gw * ${F(1 / PANE_COLS)};
  float dv = min(fract(v), 1.0 - fract(v)) * (h - s) * ${F(1 / PANE_ROWS)};
  float glass = min(glaze, min(du, dv) - ${F(CAME_W / 2)});
  return vec4(li * ${F(PANE_COLS)} + floor(u), floor(v), glaze, glass);
}
`;

const COVER_GLSL = /* glsl */ `
/** Anti-aliased coverage for a signed distance d (reference px, positive inside). */
float cov(float d) { return clamp(d * uScale + 0.5, 0.0, 1.0); }
float sq(float x) { return x * x; }
`;

/**
 * The cabin, drawn once per resize, at full resolution in reference px, as
 * colour under an even light (the composite lights it): the planked deckhead
 * and the great beam, the stern wall's boards, the row of leaded windows in
 * their carved, painted frame (alpha 0 over the glass), the stern lockers and
 * their cushion, the deck in perspective, the bookcase with its rails at the
 * left, the hull side, a closed gunport and the cannon at the right, and the
 * chart table along the bottom with a chart, a sextant and dividers. Corners
 * are darkened, for the deep shadow a lantern leaves there.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uScale;
/** Frame width and centre (reference px). */
uniform vec2 uSize;
/** Bookcase width, hull side width, the cannon's breech x. */
uniform vec3 uSides;
/** Sextant x, dividers x. */
uniform vec2 uItems;
out vec4 outColor;
${NOISE_GLSL}
${DITHER_GLSL}
${COVER_GLSL}
${WINDOW_GLSL}
const vec3 OAK = ${v3(OAK)};
const vec3 PAINT = ${v3(PAINT)};
const vec3 GILT = ${v3(GILT)};
const vec3 LEAD = ${v3(LEAD)};
const vec3 BRASS = ${v3(BRASS)};
const vec3 IRON = ${v3(IRON)};
const vec3 CUSHION = ${v3(CUSHION)};
const vec3 PARCHMENT = ${v3(PARCHMENT)};
const vec3 INK = ${v3(INK)};
const vec3 BOOK0 = ${v3(BOOKS[0])};
const vec3 BOOK1 = ${v3(BOOKS[1])};
const vec3 BOOK2 = ${v3(BOOKS[2])};
const vec3 BOOK3 = ${v3(BOOKS[3])};
const vec3 BOOK4 = ${v3(BOOKS[4])};
const float HV = ${F(HV)};

/** Oak boards \`board\` wide, side by side across x and running along y: grain, a tone per board, dark seams. */
vec3 boards(vec2 q, float board, float seed) {
  float i = floor(q.x / board);
  float f = q.x - i * board;
  float tone = 0.78 + 0.4 * hash12(vec2(i, seed));
  float g = 0.6 * vnoise(vec2(q.x * 0.08, q.y * 0.005 + i * 7.0)) + 0.4 * vnoise(vec2(q.x * 0.31, q.y * 0.018 + i * 3.0));
  float seam = 1.0 - smoothstep(0.0, 2.5, min(f, board - f));
  return OAK * tone * (0.72 + 0.55 * g) * (1.0 - 0.65 * seam);
}

/** A raised panel from lo to hi on col: a dark groove round it and a lit upper-left bevel. */
vec3 panel(vec2 p, vec2 lo, vec2 hi, vec3 col) {
  vec2 c = (lo + hi) * 0.5;
  vec2 q = abs(p - c) - (hi - lo) * 0.5;
  float d = max(q.x, q.y);
  float groove = 1.0 - smoothstep(0.0, 3.0, abs(d + 2.0));
  float bevel = smoothstep(-14.0, -6.0, d) * (1.0 - groove);
  float lit = (p.y - c.y) > (p.x - c.x) ? 1.0 : -1.0;
  return col * (1.0 - 0.55 * groove + 0.16 * bevel * lit);
}

vec3 book(float k) {
  return k < 1.0 ? BOOK0 : k < 2.0 ? BOOK1 : k < 3.0 ? BOOK2 : k < 4.0 ? BOOK3 : BOOK4;
}

/** Distance from p to the segment ab. */
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / uScale;
  float W = uSize.x;
  float cx = uSize.y;
  float shelfW = uSides.x;
  float sideX = W - uSides.y;
  float a = 1.0;

  // --- The stern wall: upright oak boards.
  vec3 col = boards(p, 64.0, 1.0) * 0.85;

  // --- The deckhead: planks running fore and aft in perspective, with one more beam across.
  if (p.y > ${F(BEAM_Y1)}) {
    float depth = 1.0 / (p.y - HV);
    float u = (p.x - cx) * depth * 380.0;
    col = boards(vec2(u, 1.0 / depth), 52.0, 2.0) * 0.6;
    float b = cov(min(p.y - 1030.0, 1054.0 - p.y));
    vec3 beam = boards(vec2(p.y * 3.0, p.x), 400.0, 3.0) * (0.55 + 0.35 * smoothstep(1030.0, 1054.0, p.y));
    col = mix(col, beam, b);
  } else if (p.y > ${F(BEAM_Y0)}) {
    // The great beam across the stern: oak with a bead moulding and a gilt line.
    col = boards(vec2(p.y * 4.0, p.x), 1000.0, 4.0);
    float t = (p.y - ${F(BEAM_Y0)}) / ${F(BEAM_Y1 - BEAM_Y0)};
    col *= 0.7 + 0.45 * smoothstep(0.0, 0.25, t) - 0.35 * smoothstep(0.7, 1.0, t);
    float bead = cov(3.0 - abs(p.y - ${F(BEAM_Y0 + 9)}));
    col = mix(col, OAK * 1.6, bead * 0.7);
    float line = cov(1.6 - abs(p.y - ${F(BEAM_Y0 + 20)}));
    col = mix(col, GILT * 0.8, line);
  }

  // --- The row of windows: the carved, painted frame, the pilasters and the leaded glass.
  {
    float fx0 = uWin.x - ${F(FRAME_W)};
    float fx1 = uWin.y + ${F(FRAME_W)};
    float s = sillAt(p.x);
    float h = headAt(p.x);
    float inFrame = min(min(p.x - fx0, fx1 - p.x), min(p.y - s + ${F(FRAME_W)}, h + ${F(FRAME_W)} - p.y));
    if (inFrame > -2.0) {
      vec4 pane = paneAt(p);
      float pd = pilasterDist(p.x);
      // Paint, worn a little, with a gilt bead round the outside and along each pilaster's edges.
      vec3 fr = PAINT * (0.8 + 0.35 * vnoise(p * vec2(0.04, 0.012)));
      float outer = cov(2.0 - abs(inFrame - 6.0));
      float pil = pd < ${F(PILASTER_HALF)} ? 1.0 : 0.0;
      // Fluting down the pilasters, and a carved capital and base.
      float flute = pil * (0.5 + 0.5 * cos(pd * 0.9));
      fr *= 1.0 - 0.3 * flute;
      float edgeLine = pil * cov(1.4 - abs(pd - ${F(PILASTER_HALF - 3)}));
      float cap = pil * max(cov(5.0 - abs(p.y - h + 12.0)), cov(5.0 - abs(p.y - s - 12.0)));
      fr = mix(fr, GILT * (0.7 + 0.3 * vnoise(p * 0.3)), max(max(outer, edgeLine), cap));
      // The frame's carved scroll along the head: a gilt wave.
      float scroll = cov(1.8 - abs(p.y - h - 11.0 - 4.0 * sin(p.x * 0.07)));
      fr = mix(fr, GILT * 0.75, scroll * step(h, p.y));
      col = mix(col, fr, cov(inFrame));
      if (pane.z > -1.0) {
        // Lead cames between panes, a soft highlight down their middle, and the glass itself.
        float lead = cov(pane.z);
        vec3 came = LEAD * (1.0 + 1.5 * cov(0.8 - abs(pane.w + ${F(CAME_W / 2)})));
        col = mix(col, came, lead);
        float glass = cov(pane.w) * lead;
        col *= 1.0 - glass;
        a = 1.0 - glass;
      }
    }
  }

  // --- The stern lockers under the windows, and their long cushion.
  if (p.y < ${F(SEAT_Y + 26)} && p.x > shelfW && p.x < sideX) {
    float n = max(1.0, floor((sideX - shelfW) / 190.0));
    float w = (sideX - shelfW) / n;
    if (p.y < ${F(SEAT_Y)}) {
      float i = floor((p.x - shelfW) / w);
      vec3 lk = boards(vec2(p.y * 2.0, p.x), 600.0, 5.0) * 0.95;
      col = panel(p, vec2(shelfW + i * w + 14.0, ${F(DECK_Y + 22)}), vec2(shelfW + i * w + w - 14.0, ${F(SEAT_Y - 24)}), lk);
      // A dark lip under the cushion, and a kick rail at the foot.
      col *= 1.0 - 0.5 * smoothstep(${F(SEAT_Y - 14)}, ${F(SEAT_Y)}, p.y) - 0.3 * (1.0 - smoothstep(${F(DECK_Y)}, ${F(DECK_Y + 12)}, p.y));
    } else {
      float t = (p.y - ${F(SEAT_Y)}) / 26.0;
      float k = mod(p.x - shelfW, 110.0);
      float tuft = exp(-sq((k - 55.0) / 4.0)) * exp(-sq((t - 0.55) / 0.2));
      vec3 c = CUSHION * (0.6 + 0.5 * sin(t * 3.1) - 0.4 * tuft);
      float top = cov(min(p.y - ${F(SEAT_Y)}, ${F(SEAT_Y + 26)} - p.y));
      col = mix(col, c, top);
      a = mix(a, 1.0, top);
    }
  }

  // --- The deck: planks running aft, converging on the eye level.
  if (p.y < ${F(DECK_Y)}) {
    float depth = 1.0 / (HV - p.y);
    float u = (p.x - cx) * depth * 400.0;
    vec3 dk = boards(vec2(u, 1.0 / depth * 3.0), 40.0, 6.0) * 1.05;
    // Shadow pooling at the lockers' foot.
    dk *= 0.55 + 0.45 * smoothstep(${F(DECK_Y)}, ${F(DECK_Y - 60)}, p.y);
    col = dk;
  }

  // --- The bookcase at the left: shelves of books held in by rails.
  if (p.x < shelfW + 6.0 && p.y < ${F(BEAM_Y0)}) {
    float sp = ${F((SHELF_Y1 - SHELF_Y0) / SHELVES)};
    vec3 bc = OAK * 0.12;
    float k = floor((p.y - ${F(SHELF_Y0)}) / sp);
    float y0 = ${F(SHELF_Y0)} + k * sp;
    if (k >= 0.0 && k < ${F(SHELVES)}) {
      // Books: slots of varying width, varying heights and leathers, the odd gap.
      float slot = floor(p.x / 22.0);
      float hb = hash12(vec2(slot, k * 13.0 + 1.0));
      float hgt = 96.0 + 44.0 * hb;
      float gap = hash12(vec2(slot, k * 7.0 + 5.0));
      float bx = p.x - slot * 22.0;
      float spine = cov(min(min(bx - 1.0, 21.0 - bx), hgt - (p.y - y0 - 12.0))) * step(0.12, gap);
      vec3 bk = book(floor(hash12(vec2(slot, k + 40.0)) * 5.0)) * (0.7 + 0.5 * sin(bx * 0.15));
      float band = max(cov(2.0 - abs(p.y - y0 - 30.0)), cov(2.0 - abs(p.y - y0 - hgt + 6.0)));
      bk = mix(bk, GILT * 0.6, band * 0.8);
      bc = mix(bc, bk, spine);
      // The shelf board, and the rail across the books.
      float board = cov(min(p.y - y0, y0 + 12.0 - p.y));
      bc = mix(bc, OAK * 1.1 * (0.8 + 0.3 * smoothstep(y0, y0 + 12.0, p.y)), board);
      float rail = cov(3.5 - abs(p.y - y0 - 58.0));
      bc = mix(bc, BRASS * (0.6 + 0.4 * cov(1.0 - abs(p.y - y0 - 59.0))), rail);
    } else if (k < 0.0) {
      // A cupboard below the lowest shelf.
      bc = panel(p, vec2(12.0, ${F(DECK_Y - 30)}), vec2(shelfW - 12.0, ${F(SHELF_Y0 - 14)}), boards(p, 80.0, 8.0));
    }
    // The case's side and top.
    float side = cov(min(p.x - shelfW + 18.0, shelfW + 6.0 - p.x));
    bc = mix(bc, boards(vec2(p.x * 3.0, p.y), 200.0, 9.0) * 1.1, side);
    float top = cov(p.y - ${F(SHELF_Y1)});
    bc = mix(bc, OAK * 0.9, top);
    float c = cov(shelfW + 6.0 - p.x) * cov(p.y - ${F(DECK_Y - 30)});
    col = mix(col, bc, c);
    a = mix(a, 1.0, c);
  }

  // --- The hull side at the right: planks, a closed gunport and the cannon.
  if (p.x > sideX - 6.0 && p.y < ${F(BEAM_Y0)} && p.y > ${F(DECK_Y - 30)}) {
    vec3 hc = boards(vec2(p.y + 0.0004 * sq(p.x - sideX), p.x), 44.0, 10.0) * 0.9;
    // The gunport's lid, with its hinges along the top.
    float gx = sideX + uSides.y * 0.55;
    vec2 gq = abs(p - vec2(gx, 380.0)) - vec2(uSides.y * 0.3, 70.0);
    float gd = max(gq.x, gq.y);
    hc *= 1.0 - 0.6 * cov(3.0 - abs(gd));
    float hinge = cov(4.0 - abs(p.y - 432.0)) * cov(-gd) * step(mod(p.x - gx, 50.0), 30.0);
    hc = mix(hc, IRON * 2.0, hinge);
    // The edge of the hull side against the stern wall.
    hc *= 0.6 + 0.4 * smoothstep(sideX - 6.0, sideX + 24.0, p.x);
    float c = cov(p.x - sideX + 6.0);
    col = mix(col, hc, c);
    a = mix(a, 1.0, c);
  }
  {
    // The cannon's breech, coming in from the right on its carriage, aimed at the port.
    float bx = uSides.z;
    float cy = 268.0;
    vec2 q = p - vec2(bx, cy);
    // Carriage: stepped cheeks of oak, and a truck wheel.
    float carriage = min(min(q.x - 6.0, W + 10.0 - p.x), min(p.y - 150.0, (q.x < 70.0 ? cy - 26.0 : cy - 4.0) - p.y));
    vec3 cc = boards(vec2(p.y * 2.0, p.x), 300.0, 11.0) * 1.2;
    float wheel = length(p - vec2(bx + 92.0, 172.0)) - 40.0;
    vec3 wc = OAK * (0.9 + 0.3 * cov(-abs(wheel + 8.0) + 2.0)) * (1.0 - 0.5 * cov(8.0 - length(p - vec2(bx + 92.0, 172.0))));
    // The barrel: a tapering iron cylinder with reinforcing rings, and the cascabel knob at its end.
    float r = 36.0 - 0.02 * max(q.x, 0.0);
    float barrel = min(r - abs(q.y), min(q.x, W + 20.0 - p.x));
    float ny = clamp(q.y / r, -1.0, 1.0);
    float ring = max(cov(5.0 - abs(q.x - 14.0)), cov(4.0 - abs(q.x - 120.0)));
    vec3 ic = IRON * (0.6 + 1.2 * sq(max(1.0 - abs(ny - 0.45) * 2.2, 0.0)) + 0.8 * ring) + vec3(0.06, 0.055, 0.05) * pow(max(1.0 - abs(ny - 0.55) * 3.0, 0.0), 3.0);
    float neck = min(8.0 - abs(q.y), min(q.x + 24.0, -q.x + 2.0));
    float knob = 15.0 - length(q - vec2(-26.0, 0.0));
    float iron = max(barrel, max(neck, knob));
    vec3 kc = IRON * (0.7 + 1.4 * sq(max(1.0 - length((q - vec2(-30.0, 6.0)) / 9.0), 0.0)));
    float cCar = cov(carriage);
    col = mix(col, cc, cCar);
    col = mix(col, wc, cov(-wheel));
    col = mix(col, knob > barrel ? kc : ic, cov(iron));
    // A shadow on the deck under the carriage.
    float under = cov(150.0 - p.y) * cov(p.x - bx) * (1.0 - smoothstep(100.0, 150.0, p.y));
    col *= 1.0 - 0.4 * under;
    a = mix(a, 1.0, max(max(cCar, cov(-wheel)), cov(iron)));
  }

  // --- The chart table along the bottom: polished oak, a chart, a sextant and dividers.
  if (p.y < ${F(TABLE_Y + 4)}) {
    vec3 tc = boards(vec2(p.y * 5.0, p.x), 400.0, 12.0) * 1.1;
    tc *= 0.85 + 0.25 * smoothstep(0.0, ${F(TABLE_Y)}, p.y);
    // The table's far edge, catching the light.
    tc = mix(tc, OAK * 2.0, cov(2.0 - abs(p.y - ${F(TABLE_Y - 3)})));
    // The chart: parchment with a coastline, rhumb lines from a compass rose, and a curled corner.
    vec2 cq = p - vec2(cx, 0.0);
    float chart = min(${F(TABLE_Y - 14)} - p.y - 3.0 * sin(cq.x * 0.01), 560.0 - abs(cq.x));
    if (chart > -2.0) {
      vec3 pc = PARCHMENT * (0.82 + 0.25 * vnoise(p * 0.03) - 0.15 * smoothstep(500.0, 560.0, abs(cq.x)));
      vec2 rose = vec2(cx + 330.0, 40.0);
      vec2 rq = (p - rose) * vec2(1.0, 2.4);
      float ang = atan(rq.y, rq.x);
      float rays = cov(1.0 - abs(fract(ang * ${F(16 / (2 * Math.PI))} + 0.5) - 0.5) * length(rq) * 0.39);
      float roseRing = cov(1.3 - abs(length(rq) - 30.0));
      float coast = cov(1.3 - abs(p.y - 60.0 - 22.0 * sin(cq.x * 0.012) - 9.0 * sin(cq.x * 0.041 + 1.0)));
      pc = mix(pc, INK, 0.45 * max(rays * step(length(rq), 300.0), max(roseRing, coast)));
      tc = mix(tc, pc, cov(chart));
    }
    // The sextant: a brass sector frame lying on the table, with its arc, arm and telescope.
    {
      vec2 q = (p - vec2(uItems.x, 46.0)) * vec2(1.0, 1.8);
      vec2 apex = vec2(0.0, 60.0);
      vec2 d = q - apex;
      float rr = length(d);
      float ang = atan(d.x, -d.y);
      float arc = min(5.0 - abs(rr - 100.0), (0.62 - abs(ang)) * 100.0);
      float frameS = min(min(seg(q, apex, apex + 100.0 * vec2(sin(0.6), -cos(0.6))), seg(q, apex, apex + 100.0 * vec2(-sin(0.6), -cos(0.6)))), seg(q, apex, apex + vec2(0.0, -100.0)));
      float arm = seg(q, apex, apex + 104.0 * vec2(sin(0.2), -cos(0.2)));
      float scope = seg(q, apex + vec2(-28.0, -36.0), apex + vec2(30.0, -46.0));
      float sh = min(min(frameS - 3.0, arm - 2.5), scope - 6.0);
      float brass = max(cov(arc * 0.6), cov(-sh * 0.6));
      vec3 bc = BRASS * (0.55 + 0.45 * sin(rr * 0.2 + q.x * 0.03)) + vec3(0.25, 0.2, 0.1) * cov(1.0 - abs(rr - 99.0)) * step(abs(ang), 0.62);
      float shadow = cov(10.0 - length((q - apex - vec2(0.0, -50.0)) / vec2(1.2, 0.8)) * 0.18);
      tc *= 1.0 - 0.3 * shadow;
      tc = mix(tc, bc, brass);
    }
    // The dividers: two steel legs from a brass hinge, opened across the chart.
    {
      vec2 c = vec2(uItems.y, 40.0);
      vec2 hingeP = c + vec2(-6.0, 48.0);
      float l1 = seg(p, hingeP, c + vec2(-60.0, -28.0)) - 2.6 + 1.2 * smoothstep(40.0, 70.0, length(p - hingeP));
      float l2 = seg(p, hingeP, c + vec2(52.0, -34.0)) - 2.6 + 1.2 * smoothstep(40.0, 70.0, length(p - hingeP));
      float legs = cov(-min(l1, l2));
      float hd = cov(7.0 - length(p - hingeP));
      tc = mix(tc, vec3(0.5, 0.52, 0.55) * (0.6 + 0.4 * sin(p.x * 0.1)), legs);
      tc = mix(tc, BRASS, hd);
    }
    float c = cov(${F(TABLE_Y)} - p.y);
    col = mix(col, tc, c);
    a = mix(a, 1.0, c);
  }

  // --- Deep shadow into the corners, which the lantern and the windows never quite reach.
  vec2 v = (p - vec2(cx, 620.0)) / vec2(max(W * 0.62, 700.0), 720.0);
  col *= 1.0 - 0.55 * smoothstep(0.35, 1.1, length(v));
  outColor = vec4(col + dither8(frag) * a, a);
}
`;

/**
 * The sky outside, at low resolution over the view's rows above the horizon:
 * the Calm Sea's sky gradient and glow, the sun and the moon (each by its
 * weather's weight), clouds on a plane overhead, and a distant ship on the
 * horizon now and then.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uNoise;
/** Full-res px per low-res px, across and up. */
uniform vec2 uLowToFull;
/** Horizon centre x, y (view px), 1 / frame height, focal length (frame heights). */
uniform vec4 uView;
/** Sun: x, y (frame heights), radius, weight. */
uniform vec4 uSun;
/** Moon: x, y (frame heights), radius, weight. */
uniform vec4 uMoon;
/** Cloud drift offset (noise tiles), cover, how much the light catches their edges. */
uniform vec4 uCloud;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
/** Ship: x (frame heights), height, opacity, heading (+1 or -1). */
uniform vec4 uShip;
uniform vec3 uShipColor;
out vec4 outColor;
${SEA_SKY_GLSL}
const vec3 SUN = vec3(1.0, 0.93, 0.74);
const vec3 MOON = vec3(0.92, 0.92, 0.86);

float cloudDensity(float n0, float n1, float cover) {
  float n = 0.65 * n0 + 0.35 * n1;
  float threshold = 0.66 - 0.4 * clamp(cover, 0.0, 1.0);
  return smoothstep(threshold - 0.08, threshold + 0.14, n);
}

/** A three-masted ship's silhouette at local (x across, y up, in ship heights), with anti-aliasing width aa. */
float ship(vec2 l, float aa) {
  float hull = min(min(l.y + 0.02, 0.11 - l.y), 0.5 - abs(l.x) - 0.25 * max(0.11 - l.y, 0.0) - 0.1 * step(0.0, l.x) * l.y);
  float s = clamp(hull / aa + 0.5, 0.0, 1.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float mx = -0.26 + 0.27 * fi;
    float top = i == 1 ? 1.0 : 0.82;
    float mast = min(0.012 - abs(l.x - mx), min(l.y, top - l.y));
    // Two square sails on each mast, narrowing upward, with a gap between.
    float yy = (l.y - 0.18) / (top - 0.24);
    float w = 0.12 * (1.0 - 0.35 * yy);
    float sail = min(w - abs(l.x - mx), min(yy, 1.0 - yy));
    sail = min(sail, abs(yy - 0.5) - 0.04);
    s = max(s, clamp(max(mast, sail * 0.6) / aa + 0.5, 0.0, 1.0));
  }
  // A jib from the bow.
  float jib = min(l.x - 0.27, 0.62 - l.x - (l.y - 0.12) * 0.4);
  jib = min(jib, min(l.y - 0.14, 0.62 - l.y - (l.x - 0.27) * 1.2));
  s = max(s, clamp(jib / aa + 0.5, 0.0, 1.0));
  return s;
}

void main() {
  vec2 p = gl_FragCoord.xy * uLowToFull;
  vec2 q = (p - uView.xy) * uView.z;
  vec3 col = sky(q);
  float aa = uLowToFull.y * uView.z;
  float ds = length(q - uSun.xy);
  float dm = length(q - uMoon.xy);
  col = mix(col, SUN, uSun.w * clamp((uSun.z - ds) / aa + 0.5, 0.0, 1.0));
  col = mix(col, MOON, uMoon.w * clamp((uMoon.z - dm) / aa + 0.5, 0.0, 1.0));
  // Clouds on a plane overhead, in perspective, thinning into haze at the horizon.
  vec2 s = q / uView.w;
  float k = ${F(CLOUD_HEIGHT * CLOUD_SCALE)} / max(s.y, 1e-3);
  vec2 uv = vec2(s.x, 1.0) * k + uCloud.xy;
  vec2 n = texture(uNoise, uv).rg;
  float dens = cloudDensity(n.r, n.g, uCloud.z) * smoothstep(0.015, 0.12, s.y);
  float near = uSun.w * exp(-3.0 * ds) + uMoon.w * exp(-3.0 * dm);
  float rim = near * (0.3 + 0.7 * (1.0 - smoothstep(0.2, 0.9, dens)));
  vec3 cloud = mix(uCloudLit, uCloudDark, smoothstep(0.3, 1.0, dens)) + uGlow * (uCloud.w * rim);
  col = mix(col, cloud, dens * 0.92);
  // A ship far off on the horizon.
  if (uShip.z > 0.0) {
    vec2 l = vec2((q.x - uShip.x) * uShip.w, q.y) / uShip.y;
    if (abs(l.x) < 0.7 && l.y < 1.1) {
      col = mix(col, uShipColor, uShip.z * ship(l, aa / uShip.y));
    }
  }
  outColor = vec4(col, 1.0);
}
`;

/**
 * Over the whole view (premultiplied): the ship's wake, a band of churned
 * foam trailing straight back from the stern, widening as it spreads and
 * thinning with distance, its two noise layers drifting away at slightly
 * different speeds so it churns; then the storm's murk and lightning's soft
 * glow, brightest in the sky.
 */
const OVERLAY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uNoise;
uniform vec2 uLowToFull;
/** Horizon centre x, y (view px), 1 / focal (view px), the eye's height above the sea (m). */
uniform vec4 uView;
/** The two layers' offsets along the wake (noise tiles), strength, footprint factor (m per px per m of depth). */
uniform vec4 uWake;
uniform vec3 uFoam;
/** Murk colour and amount. */
uniform vec4 uMurk;
uniform vec3 uFlash;
out vec4 outColor;

void main() {
  vec2 p = gl_FragCoord.xy * uLowToFull;
  vec2 s = (p - uView.xy) * uView.z;
  float fa = 0.0;
  if (s.y < -1e-4 && uWake.z > 0.0) {
    float z = uView.w / -s.y;
    float x = s.x * z;
    float w = ${F(WAKE_W0)} + ${F(WAKE_SPREAD)} * z;
    float across = abs(x) / w;
    float core = 1.0 - smoothstep(0.35, 1.0, across);
    if (core > 0.0) {
      float na = texture(uNoise, vec2(x * ${F(1 / WAKE_TILE_A[0])}, z * ${F(1 / WAKE_TILE_A[1])} - uWake.x)).r;
      float nb = texture(uNoise, vec2(x * ${F(1 / WAKE_TILE_B[0])} + 0.37, z * ${F(1 / WAKE_TILE_B[1])} - uWake.y)).g;
      float n = 0.6 * na + 0.4 * nb;
      float foam = smoothstep(0.42, 0.72, n + 0.22 * core - 0.1 * across);
      // As the footprint grows, the detail averages into a soft pale band.
      float detail = clamp(1.6 - z * z * uWake.w * 0.25, 0.0, 1.0);
      foam = mix(0.3 * core, foam * core, detail);
      fa = foam * uWake.z * exp(-z * ${F(1 / WAKE_FADE)});
    }
  }
  float m = uMurk.w * (s.y > 0.0 ? 0.6 + 0.4 * exp(-s.y * 6.0) : 0.6 + 0.4 * exp(s.y * 10.0));
  vec3 flash = uFlash * (s.y > 0.0 ? 0.7 + 0.3 * smoothstep(0.0, 0.3, s.y) : 0.3 * exp(s.y * 5.0));
  outColor = vec4(uFoam * fa * (1.0 - m) + uMurk.rgb * m + flash, 1.0 - (1.0 - fa) * (1.0 - m));
}
`;

/**
 * The frame, at full size: the cached cabin lit by the weather's ambient, the
 * daylight through the windows (with patches on the deck that slide as the
 * ship rolls) and the lantern's warm point light where it hangs now; and,
 * through the glass, the view outside, rolled and pitched with the swell,
 * wobbling through the old panes and refracted by any rain on them.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uView;
uniform sampler2D uDrops;
uniform sampler2D uNoise;
uniform vec2 uResolution;
uniform float uScale;
/** cos and sin of the view's tilt, and its pivot (device px). */
uniform vec4 uRot;
/** The view target's origin (device px) and 1 / its size, and the horizon's rise (device px). */
uniform vec4 uViewRect;
uniform float uPitch;
uniform vec3 uAmbient;
uniform vec3 uDaylight;
/** The flame (reference px), the lantern's light, the daylight patches' shift (reference px). */
uniform vec4 uLamp;
/** Rain on (0 or 1), then the refraction offset scale (decoded drop offset to device px). */
uniform vec3 uRain;
out vec4 outColor;
${NOISE_GLSL}
${COVER_GLSL}
${WINDOW_GLSL}
${DROP_DIR_GLSL}
const vec3 LAMP = ${v3(LAMP)};

/** The lantern's light at offset d: a soft falloff that still reaches, dimly, across the cabin. */
float falloff(vec2 d) {
  return 1.0 / (1.0 + dot(d, d) * ${F(1 / (LAMP_R * LAMP_R))});
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uResolution;
  vec2 p = frag / uScale;
  vec4 room = texture(uRoom, uv);
  vec2 dl = p - uLamp.xy;

  // Light on the cabin: ambient, the glow spilling from the windows, the lantern.
  float dx = max(max(uWin.x - p.x, p.x - uWin.y), 0.0);
  float dy = max(max(${F(SILL_Y)} - p.y, p.y - ${F(HEAD_Y)}), 0.0);
  float day = 0.55 * exp(-length(vec2(dx, dy)) * ${F(1 / 240)});
  if (p.y < ${F(SEAT_Y + 26)}) {
    // Patches through the lights onto the cushion and the deck, sliding with the roll.
    float below = max(${F(SEAT_Y)} - p.y, 0.0);
    float x = p.x + uLamp.w * (1.0 + below * ${F(1 / 160)});
    float patchL = smoothstep(${F(PILASTER_HALF + 4)}, ${F(PILASTER_HALF + 50)}, pilasterDist(x));
    patchL *= smoothstep(uWin.x - 20.0, uWin.x + 60.0, x) * smoothstep(uWin.y + 20.0, uWin.y - 60.0, x);
    float onDeck = p.y < ${F(DECK_Y)} ? exp(-(${F(DECK_Y)} - p.y) * ${F(1 / 180)}) : (p.y > ${F(SEAT_Y)} ? 0.8 : 0.0);
    day += 0.7 * patchL * onDeck;
  }
  vec3 light = uAmbient + uDaylight * day + LAMP * (uLamp.z * falloff(dl));
  vec3 col = room.rgb * light;

  float glass = 1.0 - room.a;
  if (glass > 0.0) {
    vec4 pane = paneAt(p);
    // The old glass: a fixed tilt per pane and a fine ripple across it.
    vec2 wob = (vec2(hash12(pane.xy), hash12(pane.xy + 17.0)) - 0.5) * ${F(WOBBLE_PANE)}
      + (texture(uNoise, p * ${F(1 / 90)}).rg - 0.5) * ${F(WOBBLE_RIPPLE)};
    vec2 off = wob * uScale;
    float dim = 1.0;
    float spec = 0.0;
    if (uRain.x > 0.5) {
      vec4 d = texture(uDrops, uv);
      vec2 dir = dropDir(d);
      off += dir * uRain.yz;
      float rim = d.a * (1.0 - smoothstep(0.0, 0.45, d.z));
      dim = 1.0 - 0.35 * rim;
      spec = pow(max(d.z * 0.8 + dot(dir, vec2(0.35, -0.3)) * 0.3, 0.0), 30.0) * d.a;
    }
    // Roll and pitch: the view turns about its pivot and rises with the swell.
    vec2 f = frag + off - uRot.zw - vec2(0.0, uPitch);
    vec2 vp = vec2(uRot.x * f.x + uRot.y * f.y, -uRot.y * f.x + uRot.x * f.y) + uRot.zw;
    vec3 v = texture(uView, (vp - uViewRect.xy) * uViewRect.zw).rgb * dim;
    // The lantern's reflection in the glass, and a faint sheen.
    v += LAMP * uLamp.z * (0.05 * falloff(dl * 2.2) + spec * 0.1) + uAmbient * 0.04;
    col += v * glass;
  }
  // A soft glow round the flame.
  col += LAMP * uLamp.z * 0.14 * exp(-dot(dl, dl) * ${F(1 / (110 * 110))});
  outColor = vec4(col, 1.0);
}
`;

/**
 * The lantern, inside a scissor round its swing, premultiplied over the
 * frame: an iron rod down from the beam, a pierced cap, a glass chimney in a
 * brass frame glowing round the flame, and a brass foot, all turned by the
 * swing about the hook on the beam.
 */
const LANTERN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uScale;
/** Pivot (reference px), cos and sin of the swing. */
uniform vec4 uPivot;
/** The flame's light, 0 when out. */
uniform float uLit;
uniform vec3 uAmbient;
out vec4 outColor;
${COVER_GLSL}
${DITHER_GLSL}
const vec3 LAMP = ${v3(LAMP)};
const vec3 BRASS = ${v3(BRASS)};
const vec3 IRON = ${v3(IRON)};

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 d = frag / uScale - uPivot.xy;
  // Into the lantern's own frame: x across, y down from the hook.
  vec2 l = vec2(uPivot.z * d.x + uPivot.w * d.y, uPivot.w * d.x - uPivot.z * d.y);
  float top = ${F(LANTERN_ROD)};
  float bottom = ${F(LANTERN_ROD + LANTERN_H)};
  float y = l.y - top;
  vec3 amb = uAmbient + LAMP * uLit * 0.5;
  float lit = uLit;
  vec3 col = vec3(0.0);
  float a = 0.0;
  // The rod and the hook's ring.
  float rod = cov(min(2.2 - abs(l.x), min(l.y - 6.0, top + 2.0 - l.y)));
  float ring = cov(2.0 - abs(length(l - vec2(0.0, 4.0)) - 5.0));
  float iron = max(rod, ring);
  col = mix(col, IRON * 2.0 * amb, iron);
  a = max(a, iron);
  // The cap: a cone with a vent ring, and a handle loop.
  float capT = clamp(y / 30.0, 0.0, 1.0);
  float capHalf = mix(9.0, ${F(LANTERN_HALF)}, capT);
  float cap = cov(min(capHalf - abs(l.x), min(y, 30.0 - y)));
  float vent = cov(2.0 - abs(y - 12.0)) * (0.5 + 0.5 * sin(l.x * 0.9));
  vec3 capC = BRASS * (0.25 + 0.5 * (1.0 - abs(l.x) / capHalf)) * amb + LAMP * lit * 0.4 * vent;
  col = mix(col, capC, cap);
  a = max(a, cap);
  // The glass chimney, glowing round the flame, between the frame's corner posts and a middle bar.
  float gy0 = 30.0;
  float gy1 = ${F(LANTERN_H - 20)};
  float gHalf = ${F(LANTERN_HALF - 5)} + 3.0 * sin(clamp((y - gy0) / (gy1 - gy0), 0.0, 1.0) * 3.14159);
  float body = cov(min(gHalf - abs(l.x), min(y - gy0, gy1 - y)));
  vec2 fq = vec2(l.x, y - ${F(LANTERN_H - FLAME_UP)});
  float glow = exp(-dot(fq, fq) * 0.0016);
  vec3 glassC = amb * vec3(0.05, 0.05, 0.045) + LAMP * lit * (0.25 + 0.9 * glow);
  // The flame: a small teardrop, brightest at its root.
  vec2 fl = vec2(fq.x / (5.0 - 0.18 * fq.y), fq.y / 13.0);
  float flame = lit * clamp(1.0 - length(fl), 0.0, 1.0);
  glassC += vec3(1.0, 0.9, 0.6) * flame * 1.4;
  float posts = max(cov(2.5 - abs(abs(l.x) - gHalf + 1.0)), cov(1.6 - abs(l.x)) * 0.6);
  glassC = mix(glassC, BRASS * 0.45 * amb + LAMP * lit * 0.15, posts);
  col = mix(col, glassC, body);
  a = max(a, body);
  // The foot: a brass band and a tapered base.
  float fy = y - gy1;
  float footHalf = ${F(LANTERN_HALF)} - max(fy - 8.0, 0.0) * 0.9;
  float foot = cov(min(footHalf - abs(l.x), min(fy, 20.0 - fy)));
  vec3 footC = BRASS * (0.3 + 0.6 * (1.0 - abs(l.x) / ${F(LANTERN_HALF)})) * amb + LAMP * lit * 0.25 * (1.0 - smoothstep(0.0, 8.0, fy));
  col = mix(col, footC, foot);
  a = max(a, foot);
  col *= step(l.y, bottom + 2.0);
  a *= step(l.y, bottom + 2.0);
  outColor = vec4((col + dither8(frag)) * a, a);
}
`;

/** Cloud colours per weather: lit tops and dark undersides. */
const CLOUD_LIT: Readonly<Record<CabinWeather, Rgb>> = {
  fair: [1, 0.88, 0.72],
  night: [0.04, 0.05, 0.08],
  storm: [0.3, 0.32, 0.35],
};
const CLOUD_DARK: Readonly<Record<CabinWeather, Rgb>> = {
  fair: [0.62, 0.55, 0.58],
  night: [0.025, 0.03, 0.05],
  storm: [0.14, 0.15, 0.17],
};
const WEATHERS: readonly CabinWeather[] = ["fair", "night", "storm"];

/**
 * Captain's Cabin. Per frame:
 * 1. the cabin, cached at full size per resize;
 * 2. the view outside at low resolution over a margin round the windows: the
 *    sky and clouds above the horizon, the Calm Sea's water below, then the
 *    wake, the storm's murk and lightning's glow over both;
 * 3. in a storm, the rain's drop map (Rain on a Window's simulation and drop shaders);
 * 4. one full-size pass that lights the cabin and shows the view through the
 *    glass, rolled and pitched with the swell;
 * 5. the swinging lantern, inside a scissor round it.
 */
export const captainscabin = defineEffect(captainscabinMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const water = scope.own(createSeaWater(gl, triangle, 138));

      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uScale", "uSize", "uSides", "uItems", "uWin"]);
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const su = createUniforms(gl, skyProgram, [
        "uNoise",
        "uLowToFull",
        "uView",
        "uSun",
        "uMoon",
        "uCloud",
        "uCloudLit",
        "uCloudDark",
        "uShip",
        "uShipColor",
        "uZenith",
        "uHorizon",
        "uGlow",
        "uSkyA",
      ]);
      const overlayProgram = program(FULLSCREEN_VERTEX, OVERLAY_FRAGMENT);
      const ou = createUniforms(gl, overlayProgram, [
        "uNoise",
        "uLowToFull",
        "uView",
        "uWake",
        "uFoam",
        "uMurk",
        "uFlash",
      ]);
      const compProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compProgram, [
        "uRoom",
        "uView",
        "uDrops",
        "uNoise",
        "uResolution",
        "uScale",
        "uRot",
        "uViewRect",
        "uPitch",
        "uAmbient",
        "uDaylight",
        "uLamp",
        "uRain",
        "uWin",
      ]);
      const lanternProgram = program(FULLSCREEN_VERTEX, LANTERN_FRAGMENT);
      const lu = createUniforms(gl, lanternProgram, ["uScale", "uPivot", "uLit", "uAmbient"]);
      const dropProgram = program(DROP_VERTEX, DROP_FRAGMENT);
      const du = createUniforms(gl, dropProgram, ["uResolution", "uInvScale", "uGrow", "uMargin"]);
      const drops = scope.own(
        createSpriteBatch(
          gl,
          instanceCapacity(DEFAULT_CONFIG),
          [4, 1],
          [polygonStrip(8, Math.PI / 8)],
        ),
      );

      const noise = scope.add(
        createDataTexture(gl, {
          width: CLOUD_NOISE,
          height: CLOUD_NOISE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(CLOUD_NOISE, [
            { period: 4, seed: 81 },
            { period: 8, seed: 83 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      gl.useProgram(skyProgram);
      su.i1("uNoise", 0);
      gl.useProgram(overlayProgram);
      ou.i1("uNoise", 0);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uView", 1);
      cu.i1("uDrops", 2);
      cu.i1("uNoise", 3);
      gl.useProgram(dropProgram);
      du.f1("uGrow", 1);
      gl.useProgram(null);

      let room: RenderTarget | null = null;
      let view: RenderTarget | null = null;
      let dropMap: RenderTarget | null = null;
      const disposeTargets = () => {
        room?.dispose();
        view?.dispose();
        dropMap?.dispose();
        room = view = dropMap = null;
      };
      scope.defer(disposeTargets);
      const makeTarget = (w: number, h: number): RenderTarget => {
        const t = createRenderTarget(gl, w, h, gl.RGBA8);
        // RGBA8 is always colour-renderable in WebGL2.
        if (!t) {
          throw new Error("Captain's Cabin: render target is not renderable");
        }
        return t;
      };

      const rain = createRainSim(1920, 1080, createRng(0x63616269));
      const rainParams: RainSimParams = { rain: 0, speed: 1 };
      const skies = WEATHERS.map((w) => presetSky(WEATHER_SKIES[w], createSkyState()));
      // The storm's sky is the overcast one, darkened.
      const stormSky = skies[2];
      for (let c = 0; c < 3; c++) {
        stormSky.zenith[c] *= STORM_DARKEN;
        stormSky.horizon[c] *= STORM_DARKEN;
        stormSky.glow[c] *= STORM_DARKEN;
      }
      const sky: SkyState = createSkyState();
      const wf = createSeaWaterFrame(sky);
      const look = createWeatherLook();
      const motion = createMotion();
      const flame = { x: 0, y: 0 };
      const shipOut = { x: 0, h: 0, alpha: 0 };
      const ambient: Rgb = [0, 0, 0];
      const daylight: Rgb = [0, 0, 0];
      const cloudLit: Rgb = [0, 0, 0];
      const cloudDark: Rgb = [0, 0, 0];
      const weights = [1, 0, 0];
      const roomKey = createChangeKey(2);

      let width = 1;
      let height = 1;
      let scale = 1;
      let layout = cabinLayout(1920);
      /** The view target's rectangle, device px. */
      let rectX = 0;
      let rectY = 0;
      let rectW = 1;
      let rectH = 1;
      let phase = 0;
      let gain = Number.NaN;
      let lampLevel = Number.NaN;
      let primed = false;
      let seed = Number.NaN;
      let lightning = createLightning(0);
      let ships = createShips(0);
      let cloudU = 0;
      let cloudV = 0;
      let wakeA = 0;
      let wakeB = 0;
      let flicker = 0;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          layout = cabinLayout(width / scale);
          disposeTargets();
          room = makeTarget(width, height);
          const margin = VIEW_MARGIN * height;
          rectX = Math.max(0, Math.floor((layout.winX0 - FRAME_W) * scale - margin));
          rectY = Math.max(0, Math.floor((SILL_Y - FRAME_W) * scale - margin));
          rectW = Math.min(width, Math.ceil((layout.winX1 + FRAME_W) * scale + margin)) - rectX;
          rectH = Math.min(height, Math.ceil((HEAD_Y + FRAME_W) * scale + margin)) - rectY;
          const d = Math.max(1, VIEW_TEXEL_REF * scale);
          view = makeTarget(lowResSize(rectW, d), lowResSize(rectH, d));
          dropMap = makeTarget(lowResSize(width, scale), lowResSize(height, scale));
          resizeRainSim(rain, width / scale, 1080);
          roomKey.set(0, -1);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          if (!room || !view || !dropMap) {
            return;
          }
          const s = Number.isFinite(p.seed) ? Math.floor(p.seed) : 0;
          if (s !== seed) {
            seed = s;
            lightning = createLightning(s);
            ships = createShips(s);
            const r = createRng(s * 101 + 5);
            cloudU = r();
            cloudV = r();
            wakeA = r();
            wakeB = r();
          }

          // Motion: the weather, the swell, the lantern, the clouds and the wake.
          easeWeather(look, p.weather, step, !primed);
          weights[0] = look.fair;
          weights[1] = look.night;
          weights[2] = look.storm;
          const target = swellGain(p.swell, look.storm);
          gain = !primed ? target : easeGain(gain, target, step);
          const lampTarget = p.lantern ? 1 : 0;
          lampLevel = !primed ? lampTarget : approach(lampLevel, lampTarget, step / LAMP_EASE);
          primed = true;
          phase = advanceSwell(ROLL_SWELL, phase, step);
          motionAt(phase, gain, motion);
          flicker = wrap(flicker + step, 0, 1000 * Math.PI);
          // A gentle, slow breathing of the flame: a few per cent, never a flicker.
          const flameLevel =
            lampLevel * (1 + 0.03 * Math.sin(flicker * 1.3) + 0.02 * Math.sin(flicker * 2.9));
          cloudU = wrap(cloudU + step * CLOUD_DRIFT, 0, 1);
          cloudV = wrap(cloudV + step * CLOUD_DRIFT * 0.4, 0, 1);
          wakeA = wrap(wakeA + (step * SHIP_SPEED) / WAKE_TILE_A[1], 0, 1);
          wakeB = wrap(wakeB + (step * SHIP_SPEED * 1.2) / WAKE_TILE_B[1], 0, 1);
          let wind = 0;
          let cover = 0;
          for (let c = 0; c < 3; c++) {
            sky.zenith[c] = 0;
            sky.horizon[c] = 0;
            sky.glow[c] = 0;
            ambient[c] = 0;
            daylight[c] = 0;
            cloudLit[c] = 0;
            cloudDark[c] = 0;
            wf.deep[c] = 0;
            wf.lightColor[c] = 0;
          }
          sky.glowStrength = 0;
          let roughness = 0;
          for (let i = 0; i < 3; i++) {
            const w = weights[i];
            const name = WEATHERS[i];
            const k = skies[i];
            const tone = WEATHER_TONES[name];
            const preset = WEATHER_SKIES[name];
            for (let c = 0; c < 3; c++) {
              sky.zenith[c] += k.zenith[c] * w;
              sky.horizon[c] += k.horizon[c] * w;
              sky.glow[c] += k.glow[c] * w;
              ambient[c] += tone.ambient[c] * w;
              daylight[c] += tone.daylight[c] * w;
              cloudLit[c] += CLOUD_LIT[name][c] * w;
              cloudDark[c] += CLOUD_DARK[name][c] * w;
              wf.deep[c] += preset.deep[c] * w;
              wf.lightColor[c] += preset.lightColor[c] * preset.intensity * 0.6 * w;
            }
            sky.glowStrength += k.glowStrength * w;
            wind += tone.wind * w;
            cover += tone.cover * w;
            roughness += preset.roughness * w;
          }
          water.advance(step, wind);
          const flash = stepLightning(lightning, step, look.storm) * look.storm;
          for (let c = 0; c < 3; c++) {
            daylight[c] += FLASH_RGB[c] * flash * FLASH_IN;
          }
          stepShips(ships, step);

          // 1. The cabin cache.
          roomKey.set(0, width);
          roomKey.set(1, height);
          if (roomKey.take()) {
            room.bind();
            gl.useProgram(roomProgram);
            ru.f1("uScale", scale);
            ru.f2("uSize", layout.width, layout.cx);
            ru.f3("uSides", layout.shelfW, layout.sideW, layout.cannonX);
            ru.f2("uItems", layout.sextantX, layout.dividersX);
            ru.f4("uWin", layout.winX0, layout.winX1, layout.lights, layout.cx);
            triangle.draw();
          }

          // 2. The view outside, over its rectangle round the windows.
          const aspect = width / height;
          const focalPx = FOCAL * height;
          const cxView = width / 2 - rectX;
          const cyView = HORIZON_Y * height - rectY;
          const lowToFullX = rectW / view.width;
          const lowToFullY = rectH / view.height;
          const waterRows = Math.min(
            view.height,
            Math.max(0, Math.ceil(cyView / lowToFullY - 0.5)),
          );
          landColor(sky, wf.landColor);
          // The sun or moon: each weather's own, so a change of weather slides one out and the other in.
          const sunX = LIGHT_X.fair * aspect * 0.5;
          const moonX = LIGHT_X.night * aspect * 0.5;
          const lightX = sunX * look.fair + moonX * look.night + LIGHT_X.storm * look.storm;
          const lightY =
            WEATHER_SKIES.fair.lightY * look.fair +
            WEATHER_SKIES.night.lightY * look.night +
            WEATHER_SKIES.storm.lightY * look.storm;
          const skyK = height / Math.max(1, height - HORIZON_Y * height);

          view.bind();
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, waterRows, view.width, view.height - waterRows);
          gl.useProgram(skyProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noise);
          su.f2("uLowToFull", lowToFullX, lowToFullY);
          su.f4("uView", cxView, cyView, 1 / height, FOCAL);
          su.f4("uSun", sunX, WEATHER_SKIES.fair.lightY, WEATHER_SKIES.fair.disc, look.fair);
          su.f4("uMoon", moonX, WEATHER_SKIES.night.lightY, WEATHER_SKIES.night.disc, look.night);
          su.f4("uCloud", cloudU, cloudV, cover, 1 - look.storm);
          su.v3("uCloudLit", cloudLit);
          su.v3("uCloudDark", cloudDark);
          shipView(ships, aspect * 0.5 + VIEW_MARGIN, shipOut);
          const shipAlpha = shipOut.alpha * (1 - 0.6 * look.storm);
          su.f4("uShip", shipOut.x, Math.max(shipOut.h, 1e-3), shipAlpha, ships.dir);
          su.f3(
            "uShipColor",
            sky.horizon[0] * 0.45 + 0.02,
            sky.horizon[1] * 0.47 + 0.02,
            sky.horizon[2] * 0.52 + 0.03,
          );
          su.v3("uZenith", sky.zenith);
          su.v3("uHorizon", sky.horizon);
          su.v3("uGlow", sky.glow);
          su.f4("uSkyA", lightX, lightY, sky.glowStrength, skyK);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);

          wf.lowToFullX = lowToFullX;
          wf.lowToFullY = lowToFullY;
          wf.centreX = cxView;
          wf.horizonPx = cyView;
          wf.focalPx = focalPx;
          wf.focal = FOCAL;
          wf.cameraHeight = EYE_HEIGHT;
          wf.aspectInv = height / width;
          wf.swell = 1 + 1.2 * look.storm + 0.6 * gain;
          wf.wind = wind;
          wf.lightX = lightX;
          wf.lightY = lightY;
          wf.roughness = roughness * (1 + look.storm * 2);
          wf.fresnelMax = 0.8;
          wf.skyK = skyK;
          wf.land = false;
          wf.mirror = false;
          if (waterRows > 0) {
            gl.viewport(0, 0, view.width, waterRows);
            water.draw(wf);
          }

          gl.viewport(0, 0, view.width, view.height);
          gl.useProgram(overlayProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noise);
          ou.f2("uLowToFull", lowToFullX, lowToFullY);
          ou.f4("uView", cxView, cyView, 1 / focalPx, EYE_HEIGHT);
          ou.f4(
            "uWake",
            wakeA,
            wakeB,
            0.75 - 0.35 * look.night,
            lowToFullY / (focalPx * EYE_HEIGHT),
          );
          ou.f3(
            "uFoam",
            0.55 * sky.horizon[0] + 0.3 * daylight[0],
            0.55 * sky.horizon[1] + 0.3 * daylight[1],
            0.55 * sky.horizon[2] + 0.3 * daylight[2],
          );
          ou.f4("uMurk", 0.12, 0.13, 0.14, 0.3 * look.storm);
          ou.f3("uFlash", FLASH_RGB[0] * flash, FLASH_RGB[1] * flash, FLASH_RGB[2] * flash);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();
          gl.disable(gl.BLEND);

          // 3. Rain on the glass.
          rainParams.rain = 0.8 * look.storm;
          stepRainSim(rain, step, rainParams);
          const count = writeDropInstances(rain, drops.data, scale);
          if (count > 0) {
            drops.upload(count);
            dropMap.bind();
            gl.clearBufferfv(gl.COLOR, 0, DROP_CLEAR);
            gl.useProgram(dropProgram);
            du.f2("uResolution", width, height);
            du.f1("uInvScale", 1 / scale);
            du.f1("uMargin", width / dropMap.width);
            drops.draw(0, count);
          }

          // 4. The lit cabin and the view through its glass.
          // The horizon tilts against the cabin's roll; sampling turns the other way.
          const tilt = -motion.roll;
          flameAt(layout.lanternX, BEAM_Y0, motion.lantern, flame);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, noise);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, dropMap.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, view.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          gl.useProgram(compProgram);
          cu.f2("uResolution", width, height);
          cu.f1("uScale", scale);
          cu.f4("uRot", Math.cos(tilt), Math.sin(tilt), width / 2, HORIZON_Y * height);
          cu.f4("uViewRect", rectX, rectY, 1 / rectW, 1 / rectH);
          cu.f1("uPitch", motion.pitch * height);
          cu.v3("uAmbient", ambient);
          cu.v3("uDaylight", daylight);
          cu.f4("uLamp", flame.x, flame.y, LAMP_POWER * flameLevel, motion.roll * LIGHT_SHIFT);
          const k = OFFSET_RANGE * REFRACTION * scale;
          cu.f3("uRain", count > 0 ? 1 : 0, k, k);
          cu.f4("uWin", layout.winX0, layout.winX1, layout.lights, layout.cx);
          triangle.draw();

          // 5. The lantern, inside a scissor round its swing.
          const reach =
            (LANTERN_ROD + LANTERN_H) * Math.abs(Math.sin(motion.lantern)) + LANTERN_HALF + 8;
          const sx = Math.max(0, Math.floor((layout.lanternX - reach) * scale));
          const ex = Math.min(width, Math.ceil((layout.lanternX + reach) * scale));
          const sy = Math.max(0, Math.floor((BEAM_Y0 - LANTERN_ROD - LANTERN_H - 10) * scale));
          const ey = Math.min(height, Math.ceil((BEAM_Y0 + 4) * scale));
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(sx, sy, Math.max(0, ex - sx), Math.max(0, ey - sy));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(lanternProgram);
          lu.f1("uScale", scale);
          lu.f4(
            "uPivot",
            layout.lanternX,
            BEAM_Y0,
            Math.cos(motion.lantern),
            Math.sin(motion.lantern),
          );
          lu.f1("uLit", flameLevel);
          lu.v3("uAmbient", ambient);
          triangle.draw();
          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
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
