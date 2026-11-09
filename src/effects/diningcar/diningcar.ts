import { AMBIENT, LIGHT_R, LIGHT_TINT, SURF_GAIN, SURF_SQUASH } from "../candlelight/candle-sim";
import type { Rgb } from "../color";
import {
  beginFrame,
  createColumnTable,
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
import { createLowResTarget } from "../lowres";
import { approach, fract, smoothstep, wrap } from "../math";
import { createRng, HASH32_GLSL, VALUE_NOISE_GLSL } from "../noise";
import {
  BANK_CHANNELS,
  BANK_COLUMNS,
  BANK_PERIOD,
  BANK_Z,
  CAM_H,
  createTrain,
  FAR_HILL_Z,
  FAR_LINE_Z,
  FAR_Y,
  FIELD_CHANNELS,
  FIELD_COLUMNS,
  FIELD_PERIOD,
  fillBankTable,
  fillFieldTable,
  fillHillTable,
  FOCAL,
  groundY,
  HILL_CHANNELS,
  HILL_COLUMNS,
  HILL_PERIOD,
  HORIZON_Y,
  HOUSE_FLOATS,
  HOUSE_Y,
  MAX_HOUSES,
  MID_LINE_Z,
  MID_SHIFT,
  MID_Y,
  NEAR_HILL_Z,
  placeHouses,
  REF_HEIGHT,
  scrollOffset,
  stepTrain,
  V_MAX,
  viewHouses,
} from "../train/train-sim";
import { defineEffect } from "../types";
import { diningcarMeta } from "./diningcar.meta";
import {
  BUILDING_Z,
  BUMP_DAMPING,
  BUMP_HZ,
  BUMP_KICK,
  BUMP_MAX,
  createJolts,
  createSpring,
  createStations,
  type DiningLayout,
  diningLayout,
  drinkLook,
  FRAME_W,
  FRINGE_DAMPING,
  FRINGE_HZ,
  FRINGE_KICK,
  FRINGE_LEN,
  FRINGE_MAX,
  LAMP_BASE_Y,
  LIQUID_DAMPING,
  LIQUID_HZ,
  LIQUID_KICK,
  LIQUID_MAX,
  POLE_SPACING,
  POLE_Z,
  POS_SCALE,
  ROCK_PX,
  rockAt,
  SEAT_TOP,
  SHADE_HALF0,
  SHADE_HALF1,
  SHADE_Y0,
  SHADE_Y1,
  STATION_FLOATS,
  STATION_Z,
  stationGlow,
  stepJolts,
  stepSpring,
  stepStations,
  TABLE_Y,
  VASE_BASE_Y,
  VESSEL_BASE_Y,
  viewStation,
  WIN_RADIUS,
  WIN_Y0,
  WIN_Y1,
} from "./diningcar-sim";
import { COVERAGE_GLSL } from "../sdf-glsl";

/** The landscape renders at about 2 reference px per texel: it is dark, soft and seen through glass. */
const LAND_TEXEL_REF = 2;
/** The landscape's horizon sits this far above the Train Window's, so the window shows some ground. */
const VIEW_SHIFT = 120;
/** The moon, as a fraction of the right pane's width, height (reference px) and radius. */
const MOON_AT = 0.64;
const MOON_Y = 836;
const MOON_R = 21;
/** Seconds for the moonlight to come up or fade when switched. */
const MOON_EASE = 2.5;
/** Peak warm light a passing station adds to the table. */
const STATION_PEAK = 0.15;
const STATION_RGB: Rgb = [1, 0.72, 0.42];
/** Lamp falloff radius: the candlelight's, widened for an electric lamp. */
const LAMP_R = LIGHT_R * 1.5;
/** The glass's walls, so the wine sits inside them. */
const GLASS_WALL = 2.5;
/** Wine glass: stem height, bowl height and widest half width; tea glass height and holder top. */
const STEM_H = 85;
const BOWL_H = 140;
const BOWL_R = 46;
const TEA_H = 150;
const HOLDER_TOP = 80;

/** The drink's vessel, shared by the cached interior and the live liquid so they line up exactly. */
const VESSEL_GLSL = /* glsl */ `
// Outer half width of the bowl (kind 0, a wine glass) or the tea glass (kind 1)
// at height y above its base, reference px; negative outside it.
float bowlHalf(float y, int kind) {
  if (kind == 0) {
    float t = (y - ${F(STEM_H)}) * ${F(1 / BOWL_H)};
    if (t < 0.0 || t > 1.0) return -1.0;
    if (t < 0.42) {
      float e = 1.0 - t * ${F(1 / 0.42)};
      return ${F(BOWL_R)} * sqrt(max(1.0 - e * e, 0.0));
    }
    float u = (t - 0.42) * ${F(1 / 0.58)};
    return ${F(BOWL_R)} * (1.0 - 0.17 * u * u);
  }
  if (y < 0.0 || y > ${F(TEA_H)}) return -1.0;
  return 29.0 + 5.0 * y * ${F(1 / TEA_H)};
}
`;

/** Coverage from a signed distance in reference px (positive inside), anti-aliased at the device pixel. */
const COVER_GLSL = /* glsl */ `
float cov(float d) { return clamp(d * uScale + 0.5, 0.0, 1.0); }
float sq(float x) { return x * x; }
`;

/** Converts the sway's device px back to the cached interior's, in reference px. */
const UNSWAY_GLSL = /* glsl */ `
// Cosine and sine of the tilt, vertical offset and pivot x (device px).
uniform vec4 uXform;
vec2 unsway(vec2 frag) {
  vec2 f = frag - uXform.wz;
  return vec2(uXform.x * f.x + uXform.y * f.y + uXform.w, -uXform.y * f.x + uXform.x * f.y);
}
`;

const WOOD: Rgb = [0.3, 0.13, 0.06];
const INLAY: Rgb = [0.78, 0.55, 0.3];
const BRASS: Rgb = [0.82, 0.6, 0.27];
const CURTAIN: Rgb = [0.42, 0.05, 0.07];
const SEAT: Rgb = [0.07, 0.09, 0.25];
const CLOTH: Rgb = [0.9, 0.88, 0.84];
const SHADE: Rgb = [1, 0.76, 0.46];
const SILVER: Rgb = [0.78, 0.78, 0.8];
const FLOWER: Rgb = [0.72, 0.05, 0.1];
const LEAF: Rgb = [0.08, 0.2, 0.07];
const v3 = (c: Rgb | readonly number[]) => `vec3(${F(c[0])}, ${F(c[1])}, ${F(c[2])})`;

/**
 * The interior, drawn once per resize or change of drink, at full resolution
 * in reference px: panelled walls with inlaid lines lit by the lamp, the two
 * panes in brass frames (alpha 0 over the glass, carrying a faint reflection
 * of the lamp to add over the view), gathered curtains, the tablecloth, the
 * lamp with its glowing shade, the bud vase, the drink's glass and the
 * upholstered seat backs at the sides. Premultiplied.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform float uScale;
/** Frame width and centre, reference px. */
uniform vec2 uSize;
uniform vec4 uPanes;
/** Lamp, vase and vessel x. */
uniform vec3 uItems;
/** Seat width, curtain width. */
uniform vec2 uSides;
uniform int uVessel;
out vec4 outColor;
${VALUE_NOISE_GLSL}
${DITHER_GLSL}
${VESSEL_GLSL}
${COVER_GLSL}
const vec3 WOOD = ${v3(WOOD)};
const vec3 INLAY = ${v3(INLAY)};
const vec3 BRASS = ${v3(BRASS)};
const vec3 CURTAIN = ${v3(CURTAIN)};
const vec3 SEAT = ${v3(SEAT)};
const vec3 CLOTH = ${v3(CLOTH)};
const vec3 SHADE = ${v3(SHADE)};
const vec3 SILVER = ${v3(SILVER)};
const vec3 FLOWER = ${v3(FLOWER)};
const vec3 LEAF = ${v3(LEAF)};
const vec3 TINT = ${v3(LIGHT_TINT)};

// Signed distance to a rounded box from lo to hi, negative inside.
float box(vec2 p, vec2 lo, vec2 hi, float r) {
  vec2 q = abs(p - (lo + hi) * 0.5) - (hi - lo) * 0.5 + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// The lamp's light at offset d: the candlelight's soft inverse-square falloff.
float falloff(vec2 d) {
  float q = 1.0 + dot(d, d) * ${F(1 / (LAMP_R * LAMP_R))};
  return 1.0 / (q * q);
}

// Light on an upright surface at p: a warm ambient, a little cool moonlight and the lamp.
vec3 wallLight(vec2 p, float lampX) {
  return vec3(${F(AMBIENT + 0.06)}) + vec3(0.0, 0.01, 0.04)
    + TINT * 1.15 * falloff(p - vec2(lampX, ${F(SHADE_Y0 - 10)}));
}

vec3 wood(vec2 p) {
  float g = 0.6 * vnoise(vec2(p.x * 0.06, p.y * 0.003), 1.0) + 0.4 * vnoise(vec2(p.x * 0.21, p.y * 0.01), 2.0);
  float fig = vnoise(vec2(p.x * 0.015 + p.y * 0.002, p.y * 0.0016), 3.0);
  return WOOD * (0.7 + 0.42 * g + 0.3 * (fig - 0.5));
}

// A panel from lo to hi: a groove round it, a raised field and an inlaid line inside.
vec3 panel(vec2 p, vec2 lo, vec2 hi, vec3 col) {
  float d = box(p, lo, hi, 4.0);
  float groove = 1.0 - smoothstep(1.0, 3.0, abs(d));
  float bevel = smoothstep(-9.0, -3.0, d) * (1.0 - groove);
  vec2 n = normalize(p - (lo + hi) * 0.5 + 1e-3);
  col *= 1.0 - 0.5 * groove + 0.18 * bevel * (n.y - 0.3 * n.x);
  float inlay = cov(1.2 - abs(box(p, lo + 17.0, hi - 17.0, 8.0)));
  return mix(col, INLAY * (0.6 + 0.4 * vnoise(p * 0.2, 5.0)), 0.85 * inlay);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / uScale;
  float W = uSize.x;
  float cx = uSize.y;
  float lampX = uItems.x;
  float vaseX = uItems.y;
  float vesselX = uItems.z;
  float seatW = uSides.x;
  float curtW = uSides.y;
  vec2 lampAt = vec2(lampX, ${F(SHADE_Y0 - 10)});

  // --- Walls: panelling, the post between the panes and the frieze above.
  vec3 col = wood(p);
  if (p.y > ${F(WIN_Y1 + FRAME_W + 10)}) {
    float n = max(1.0, floor(W / 300.0));
    float w = W / n;
    float i = floor(p.x / w);
    col = panel(p, vec2(i * w + 8.0, ${F(WIN_Y1 + FRAME_W + 18)}), vec2(i * w + w - 8.0, ${F(REF_HEIGHT + 40)}), col);
  } else if (p.y > ${F(TABLE_Y)}) {
    if (p.x < uPanes.x - ${F(FRAME_W)} || p.x > uPanes.w + ${F(FRAME_W)}) {
      float x = p.x < cx ? p.x : W - p.x;
      vec2 q = vec2(x, p.y);
      col = panel(q, vec2(-40.0, ${F(TABLE_Y + 14)}), vec2(uPanes.x - ${F(FRAME_W + 12)}, ${F(WIN_Y1 + FRAME_W)}), col);
    } else if (p.x > uPanes.y && p.x < uPanes.z) {
      col = panel(p, vec2(uPanes.y + ${F(FRAME_W + 6)}, ${F(WIN_Y0 + 10)}), vec2(uPanes.z - ${F(FRAME_W + 6)}, ${F(WIN_Y1 - 10)}), col);
    } else if (p.y < ${F(WIN_Y0)}) {
      // The rail under the windows, with a brass strip along its top.
      col *= 0.9 + 0.1 * smoothstep(${F(TABLE_Y)}, ${F(WIN_Y0)}, p.y);
      float strip = cov(3.0 - abs(p.y - ${F(TABLE_Y + 26)}));
      col = mix(col, BRASS * 0.7, strip);
    }
  }
  vec3 light = wallLight(p, lampX);
  // Varnish: the lamp's reflection in the polish, broken up by the grain.
  vec3 gloss = TINT * 0.5 * pow(falloff((p - lampAt) * 1.6), 1.5) * (0.6 + 0.8 * vnoise(vec2(p.x * 0.05, p.y * 0.004), 7.0));
  col = col * light + gloss;
  float a = 1.0;

  // --- The panes: brass frames, and the glass carrying a faint reflection of the lamp.
  float dl = box(p, vec2(uPanes.x, ${F(WIN_Y0)}), vec2(uPanes.y, ${F(WIN_Y1)}), ${F(WIN_RADIUS)});
  float dr = box(p, vec2(uPanes.z, ${F(WIN_Y0)}), vec2(uPanes.w, ${F(WIN_Y1)}), ${F(WIN_RADIUS)});
  float d = min(dl, dr);
  if (d < ${F(FRAME_W + 3)}) {
    float t = clamp(d * ${F(1 / FRAME_W)}, 0.0, 1.0);
    float bead = sin(t * 3.14159265);
    vec3 brass = BRASS * (0.25 + 0.75 * bead * bead) * light + TINT * 0.35 * bead * falloff((p - lampAt) * 1.3);
    brass *= 1.0 - 0.5 * (1.0 - smoothstep(0.5, 2.0, abs(d - ${F(FRAME_W)})));
    col = mix(col, brass, cov(${F(FRAME_W + 1.5)} - d));
    vec2 rp = vec2(lampX + (cx - lampX) * 0.18, 520.0);
    vec3 refl = TINT * (0.07 * falloff((p - rp) * 2.2) + 0.012 * smoothstep(${F(WIN_Y0 + 240)}, ${F(WIN_Y0)}, p.y));
    float glass = cov(-d);
    col = mix(col, refl, glass);
    a = 1.0 - glass;
  }

  // --- Curtains, gathered at the panes' outer edges with a cord, mirrored.
  {
    float x = p.x < cx ? p.x : W - p.x;
    float x0 = uPanes.x - 46.0;
    float yt = ${F(WIN_Y0 + 0.36 * (WIN_Y1 - WIN_Y0))};
    float u = p.y < yt ? (yt - p.y) * ${F(1 / (0.36 * (WIN_Y1 - WIN_Y0) + 40))} : (p.y - yt) * ${F(1 / (0.64 * (WIN_Y1 - WIN_Y0) + 40))};
    float prof = 0.38 + 0.62 * pow(clamp(u, 0.0, 1.0), p.y < yt ? 1.6 : 1.25);
    float xin = x0 + (curtW + 46.0) * prof + 6.0 * sin(p.y * 0.021);
    float c = cov(min(min(xin - x, x - x0 + 30.0), min(p.y - ${F(WIN_Y0 - 40)}, ${F(WIN_Y1 + 52)} - p.y)));
    if (c > 0.0) {
      float f = clamp((x - x0) / max(xin - x0, 1.0), 0.0, 1.0);
      float folds = 0.5 + 0.5 * cos(f * 22.0 + 0.6);
      vec3 cc = CURTAIN * (0.45 + 0.55 * folds) * (0.75 + 0.25 * f) * wallLight(p, lampX);
      cc += TINT * 0.05 * pow(folds, 6.0) * falloff((p - lampAt) * 0.9);
      // The cord and its tassel.
      float cord = cov(5.0 - abs(p.y - yt)) * (0.55 + 0.45 * sin(x * 1.2));
      float tassel = cov(min(7.0 - abs(x - xin + 4.0), min(yt - p.y, p.y - yt + 46.0)));
      vec3 gold = BRASS * wallLight(p, lampX) * 1.1;
      cc = mix(cc, gold, max(cord, tassel * (0.7 + 0.3 * sin(x * 2.4))));
      col = mix(col, cc, c);
      a = mix(a, 1.0, c);
    }
    // The curtain rod.
    float rod = cov(min(4.5 - abs(p.y - ${F(WIN_Y1 + 46)}), x - x0 + 40.0));
    float rodC = rod * cov(uPanes.x + curtW + 60.0 - x);
    col = mix(col, BRASS * (0.5 + 0.5 * cov(1.5 - abs(p.y - ${F(WIN_Y1 + 47.5)}))) * wallLight(p, lampX), rodC);
    a = mix(a, 1.0, rodC);
  }

  // --- The tablecloth: soft folds in perspective, the lamp's pool of light, shadows under things.
  if (p.y < ${F(TABLE_Y + 2)}) {
    float fx = (p.x - cx) / (${F(TABLE_Y + 700)} - p.y);
    float n = vnoise(vec2(fx * 9.0, 0.5), 11.0) * 0.6 + vnoise(vec2(fx * 23.0, p.y * 0.004), 12.0) * 0.4;
    float shade = 0.9 + 0.14 * n - 0.06 * smoothstep(${F(TABLE_Y * 0.6)}, 0.0, p.y);
    shade += 0.05 * (1.0 - smoothstep(0.0, 3.0, abs(p.y - ${F(TABLE_Y * 0.42)}) - 1.0 * n));
    vec3 lit = vec3(${F(AMBIENT + 0.12)}) + vec3(0.0, 0.01, 0.035)
      + TINT * ${F(SURF_GAIN * 1.1)} * falloff(vec2(p.x - lampX, (p.y - ${F(LAMP_BASE_Y)}) * ${F(SURF_SQUASH)}));
    vec3 cloth = CLOTH * shade * lit;
    cloth *= 1.0 - 0.35 * smoothstep(${F(TABLE_Y - 14)}, ${F(TABLE_Y)}, p.y);
    vec2 s1 = vec2((p.x - lampX) / 64.0, (p.y - ${F(LAMP_BASE_Y - 4)}) / 12.0);
    vec2 s2 = vec2((p.x - vaseX) / 30.0, (p.y - ${F(VASE_BASE_Y - 3)}) / 8.0);
    vec2 s3 = vec2((p.x - vesselX - 14.0) / 50.0, (p.y - ${F(VESSEL_BASE_Y - 4)}) / 11.0);
    cloth *= (1.0 - 0.45 * exp(-dot(s1, s1))) * (1.0 - 0.3 * exp(-dot(s2, s2))) * (1.0 - 0.25 * exp(-dot(s3, s3)));
    float c = cov(${F(TABLE_Y)} - p.y);
    col = mix(col, cloth, c);
    a = mix(a, 1.0, c);
  }

  // --- The bud vase: a slim silver vase with a single flower.
  {
    vec2 q = vec2(p.x - vaseX, p.y - ${F(VASE_BASE_Y)});
    float t = q.y / 130.0;
    float hw = 6.0 + 11.0 * exp(-sq((t - 0.2) / 0.2)) + 4.0 * smoothstep(0.9, 1.0, t);
    float c = cov(min(hw - abs(q.x), min(q.y, 130.0 - q.y)));
    // The stem curves up to the flower, with one leaf.
    float sx = 14.0 * pow(clamp((q.y - 128.0) / 96.0, 0.0, 1.0), 2.0);
    float stem = cov(min(2.0 - abs(q.x - sx), min(q.y - 120.0, 226.0 - q.y)));
    vec2 lq = q - vec2(-13.0, 168.0);
    lq = mat2(0.8, 0.6, -0.6, 0.8) * lq;
    float leaf = cov(6.0 - length(lq * vec2(0.37, 1.0)) * 1.0);
    vec3 green = LEAF * wallLight(p, lampX) * (0.8 + 0.4 * smoothstep(-6.0, 6.0, lq.y));
    col = mix(col, green, max(stem, leaf));
    a = mix(a, 1.0, max(stem, leaf));
    vec2 fq = q - vec2(14.0, 232.0);
    float r = length(fq);
    float ang = atan(fq.y, fq.x);
    float petals = 21.0 + 2.5 * sin(ang * 7.0) + 1.5 * sin(ang * 3.0 + 1.0);
    float fc = cov(petals - r);
    if (fc > 0.0) {
      float swirl = 0.5 + 0.5 * sin(ang * 2.0 + r * 0.55);
      vec3 fl = FLOWER * (0.45 + 0.6 * swirl * (1.0 - 0.5 * r / 22.0)) * (0.6 + 0.4 * smoothstep(-20.0, 20.0, fq.x + fq.y)) * wallLight(p, lampX) * 1.2;
      col = mix(col, fl, fc);
      a = mix(a, 1.0, fc);
    }
    if (c > 0.0) {
      float s = q.x / hw;
      vec3 silver = SILVER * (0.18 + 0.55 * (1.0 - s * s)) * wallLight(p, lampX)
        + TINT * 0.55 * exp(-sq((s - 0.45) / 0.14)) * (0.6 + 0.4 * t);
      col = mix(col, silver, c);
      a = mix(a, 1.0, c);
    }
  }

  // --- The lamp: a brass base and stem under a glowing shade.
  {
    vec2 q = vec2(p.x - lampX, p.y - ${F(LAMP_BASE_Y)});
    float e = length(vec2(q.x / 44.0, max(q.y, 0.0) / 24.0));
    float base = cov(min((1.0 - e) * 22.0, q.y + 6.0)) * cov(46.0 - abs(q.x));
    vec2 nrm = normalize(vec2(q.x / 44.0, max(q.y, 0.0) / 24.0 + 0.15));
    vec3 brassBase = BRASS * (0.2 + 0.8 * nrm.y * nrm.y) * wallLight(p, lampX) + TINT * 0.45 * pow(max(nrm.y, 0.0), 8.0);
    float stemY = clamp(q.y, 24.0, ${F(SHADE_Y0 - LAMP_BASE_Y)});
    float stem = cov(min(5.0 - abs(q.x), min(q.y - 18.0, ${F(SHADE_Y0 - LAMP_BASE_Y + 2)} - q.y)));
    float knob = cov(9.0 - length(q - vec2(0.0, 92.0)));
    float s = clamp(q.x / (knob > 0.0 ? 9.0 : 5.0), -1.0, 1.0);
    vec3 brassStem = BRASS * (0.25 + 0.7 * (1.0 - s * s)) * wallLight(p, lampX) + TINT * 0.6 * exp(-sq((s + 0.3) / 0.2)) * (0.4 + 0.6 * stemY / ${F(SHADE_Y0 - LAMP_BASE_Y)});
    col = mix(col, brassBase, base);
    col = mix(col, brassStem, max(stem, knob));
    a = mix(a, 1.0, max(base, max(stem, knob)));

    float ty = (p.y - ${F(SHADE_Y0)}) * ${F(1 / (SHADE_Y1 - SHADE_Y0))};
    float halfW = mix(${F(SHADE_HALF0)}, ${F(SHADE_HALF1)}, clamp(ty, 0.0, 1.0)) + 4.0 * sin(clamp(ty, 0.0, 1.0) * 3.14159265);
    float side = halfW - abs(q.x);
    float dShade = min(side, min(p.y - ${F(SHADE_Y0)}, ${F(SHADE_Y1)} - p.y));
    float sc = cov(dShade);
    float u = q.x / halfW;
    float pleat = 0.5 + 0.5 * sin(u * 30.0);
    vec3 fabric = SHADE * (0.72 + 0.4 * (1.0 - ty)) * (0.8 + 0.2 * cos(u * 1.4)) * (0.93 + 0.07 * pleat);
    float trim = max(cov(3.0 - abs(p.y - ${F(SHADE_Y1 - 1)})), cov(3.5 - abs(p.y - ${F(SHADE_Y0 + 2)})));
    fabric = mix(fabric, BRASS * 0.9, trim);
    col = mix(col, fabric, sc);
    a = mix(a, 1.0, sc);
    // The shade's glow, added over everything, the window included.
    float out_ = max(-dShade, 0.0);
    col += TINT * (0.16 * exp(-out_ * 0.05) + 0.07 * exp(-out_ * 0.012)) * (1.0 - sc);
  }

  // --- The drink: a wine glass, or a tea glass in a brass holder with a spoon.
  {
    vec2 q = vec2(p.x - vesselX, p.y - ${F(VESSEL_BASE_Y)});
    vec3 vl = wallLight(p, lampX);
    if (uVessel == 1) {
      vec2 sp = q - vec2(6.0, 96.0);
      vec2 sd = vec2(0.36, 0.93);
      float along = dot(sp, sd);
      float spoon = cov(min(1.8 - abs(dot(sp, vec2(sd.y, -sd.x))), min(along, 118.0 - along)));
      col = mix(col, SILVER * 0.6 * vl, spoon * (q.y > ${F(TEA_H)} ? 1.0 : 0.4));
      a = mix(a, 1.0, spoon * (q.y > ${F(TEA_H)} ? 1.0 : 0.4));
    }
    float hw = bowlHalf(q.y, uVessel);
    float gc = cov(min(hw - abs(q.x), hw));
    if (uVessel == 0) {
      float stem = cov(min(3.2 - abs(q.x) + 2.0 * smoothstep(${F(STEM_H - 12)}, ${F(STEM_H)}, q.y), min(q.y, ${F(STEM_H + 2)} - q.y)));
      float foot = cov((1.0 - length(vec2(q.x / 36.0, (q.y - 3.0) / 5.0))) * 5.0);
      gc = max(gc, max(stem, foot));
    }
    if (gc > 0.0) {
      float w = max(hw, 3.2);
      float s = clamp(q.x / w, -1.0, 1.0);
      float edge = smoothstep(0.82, 1.0, abs(s));
      vec3 hi = TINT * (0.26 * edge + 0.45 * exp(-sq((s + 0.55) / 0.08)) * step(1.0, hw)) * (0.5 + 0.5 * vl.r);
      col = col * (1.0 - 0.15 * gc) + hi * gc;
      a = 1.0 - (1.0 - a) * (1.0 - 0.15 * gc);
    }
    float rimY = uVessel == 0 ? ${F(STEM_H + BOWL_H)} : ${F(TEA_H)};
    float rw = bowlHalf(rimY - 0.01, uVessel);
    vec2 eq = vec2(q.x / rw, (q.y - rimY) * 0.2);
    float el = length(eq);
    vec2 grad = vec2(eq.x / rw, eq.y * 0.2) / max(el, 1e-3);
    float rim = cov(1.0 - abs(el - 1.0) / max(length(grad), 1e-3));
    col += TINT * 0.35 * rim;
    a = mix(a, 1.0, 0.4 * rim);
    if (uVessel == 1) {
      // The holder: brass with an openwork band and a loop handle.
      float hh = hw + 3.0 + 4.0 * (1.0 - smoothstep(0.0, 10.0, q.y));
      float holder = cov(min(hh - abs(q.x), min(q.y + 1.0, ${F(HOLDER_TOP)} - q.y)));
      vec2 hq = q - vec2(hh + 12.0, 48.0);
      float handle = cov(min(5.0 - abs(length(hq * vec2(1.0, 0.75)) - 15.0), q.x - hh + 4.0));
      vec2 lat = vec2(q.x + q.y, q.y - q.x) * 0.16;
      vec2 fl = abs(fract(lat) - 0.5);
      float open = smoothstep(0.32, 0.38, max(fl.x, fl.y)) * step(22.0, q.y) * step(q.y, 64.0);
      float sh = clamp(q.x / hh, -1.0, 1.0);
      vec3 hb = BRASS * (0.25 + 0.75 * (1.0 - sh * sh)) * vl * (1.0 - 0.65 * open) + TINT * 0.4 * exp(-sq((sh + 0.5) / 0.15));
      col = mix(col, hb, max(holder, handle));
      a = mix(a, 1.0, max(holder, handle));
    }
  }

  // --- The seat backs at the sides: buttoned blue velvet with piping.
  {
    float x = p.x < cx ? p.x : W - p.x;
    float d = box(vec2(x, p.y), vec2(-200.0, -200.0), vec2(seatW, ${F(SEAT_TOP)}), 40.0);
    float c = cov(-d);
    if (c > 0.0) {
      vec2 g = vec2(x + p.y, p.y - x) * ${F(1 / 62)};
      vec2 f = fract(g) - 0.5;
      float dimple = exp(-dot(f, f) * 30.0);
      float puff = 1.0 - 4.0 * max(abs(f.x), abs(f.y)) * max(abs(f.x), abs(f.y));
      vec3 velvet = SEAT * (0.55 + 0.35 * puff - 0.35 * dimple) * wallLight(p, lampX) * 1.4;
      velvet += SEAT * 1.3 * smoothstep(-14.0, -4.0, d) * (1.0 - smoothstep(-3.0, 0.0, d));
      velvet = mix(velvet, BRASS * 0.5 * wallLight(p, lampX), exp(-dot(f, f) * 900.0));
      col = mix(col, velvet, c);
      a = mix(a, 1.0, c);
    }
  }
  outColor = vec4(col + dither8(frag) * a, a);
}
`;

/** The cached interior, moved by the carriage's sway, premultiplied over the view. */
const INTERIOR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform vec2 uResolution;
out vec4 outColor;
${UNSWAY_GLSL}
void main() {
  outColor = texture(uRoom, unsway(gl_FragCoord.xy) / uResolution);
}
`;

/**
 * The live parts on the table, each drawn inside a scissor round it and moved
 * with the interior: the drink (kind 0), its surface tilting on a damped
 * spring, and the shade's fringe (kind 1), swinging on another.
 */
const OBJECT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform float uScale;
uniform int uKind;
uniform int uVessel;
/** Lamp x and vessel x, reference px. */
uniform vec2 uAt;
/** Fill level (reference px above the base), surface tilt (radians), opacity, fringe swing (radians). */
uniform vec4 uMotion;
uniform vec3 uDrink;
out vec4 outColor;
${HASH32_GLSL}
${VESSEL_GLSL}
${COVER_GLSL}
${UNSWAY_GLSL}
const vec3 TINT = ${v3(LIGHT_TINT)};

void main() {
  vec2 p = unsway(gl_FragCoord.xy) / uScale;
  if (uKind == 0) {
    vec2 q = vec2(p.x - uAt.y, p.y - ${F(VESSEL_BASE_Y)});
    float hw = bowlHalf(q.y, uVessel) - ${F(GLASS_WALL)};
    float surf = uMotion.x + tan(uMotion.y) * q.x;
    float ell = 4.5 * sqrt(max(1.0 - (q.x * q.x) / max(hw * hw, 1.0), 0.0)) * hw * ${F(1 / BOWL_R)};
    float bottom = uVessel == 0 ? ${F(STEM_H + GLASS_WALL)} : ${F(GLASS_WALL + 4)};
    float c = cov(min(min(hw - abs(q.x), surf + ell - q.y), q.y - bottom));
    if (uVessel == 1) {
      c *= cov(q.y - ${F(HOLDER_TOP)});
    }
    float top = smoothstep(surf - ell - 1.0, surf - ell + 1.0, q.y);
    float s = clamp(q.x / max(hw, 1.0), -1.0, 1.0);
    vec3 col = uDrink * (0.55 + 0.45 * (1.0 - s * s)) * (1.0 + 0.5 * top);
    col += TINT * (0.12 * top * smoothstep(0.2, -0.6, s) + 0.4 * exp(-sq((s + 0.55) / 0.08)));
    float al = uMotion.z * c;
    outColor = vec4(col * al, al);
    return;
  }
  // The fringe: short strands under the shade's rim, swinging from their tops.
  vec2 q = vec2(p.x - uAt.x, p.y - ${F(SHADE_Y0)});
  float depth = -q.y;
  float xs = q.x - uMotion.w * max(depth, 0.0);
  float k = floor(xs / 4.5 + 0.5);
  float hk = float(hash32(uint(int(k) + 1000)) & 255u) / 255.0;
  float len = ${F(FRINGE_LEN)} * (0.8 + 0.2 * hk);
  float dx = xs - k * 4.5;
  float inside = cov(${F(SHADE_HALF0 - 1)} - abs(k * 4.5));
  float strand = cov(min(1.1 - abs(dx), min(len - depth, depth + 1.0))) * inside;
  float bead = cov(2.1 - length(vec2(dx, depth - len))) * inside;
  float c = max(strand, bead);
  vec3 col = TINT * (0.55 + 0.45 * (1.0 - depth / len)) * (0.8 + 0.2 * hk);
  outColor = vec4(col * c, c);
}
`;

/** A passing station's warm light on the table, from the window side; added. */
const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uScale;
/** Strength, source x and width (reference px). */
uniform vec3 uGlow;
uniform vec3 uColor;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy / uScale;
  float x = (p.x - uGlow.y) / uGlow.z;
  float g = uGlow.x * exp(-x * x) * (0.3 + 0.7 * smoothstep(0.0, ${F(TABLE_Y)}, p.y))
    * (1.0 - 0.75 * smoothstep(${F(TABLE_Y)}, ${F(WIN_Y0)}, p.y));
  outColor = vec4(uColor * g + dither8(gl_FragCoord.xy) * 0.5, 0.0);
}
`;

const WORLD_K = FOCAL * CAM_H;
/** Platform top, lamp heads and the buildings' ground, in the Train Window's screen heights. */
const GROUND_ST = groundY(STATION_Z);
const PLATFORM_TOP = GROUND_ST + (1.1 * FOCAL) / STATION_Z;
const LAMP_TOP = GROUND_ST + (4.4 * FOCAL) / STATION_Z;
const CROSSING_TOP = GROUND_ST + (3.3 * FOCAL) / STATION_Z;
const GROUND_B = groundY(BUILDING_Z);
const KB = FOCAL / BUILDING_Z;

/**
 * The night landscape, at low resolution over the window: a deep blue sky
 * with stars and the moon, two hill ridges from the Train Window's hill table
 * with the odd farm light on them, the far tree line, a river meandering
 * across the fields catching the moon, the farmhouses with lit windows, the
 * nearer hedgerow, a passing station or level crossing with its lamps, the
 * embankment's bushes and soft trackside poles. Each layer scrolls at its
 * depth's speed.
 */
const LAND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uHills;
uniform sampler2D uFields;
uniform sampler2D uBank;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
/** View centre x, ground scroll (world units, wrapped), embankment scroll (periods), pole scroll (reference px). */
uniform vec4 uView;
/** Far and near hill scroll (periods), seed salt, moonlight (0..1). */
uniform vec4 uScroll;
/** Moon x, y and radius, reference px. */
uniform vec3 uMoon;
uniform vec4 uHouse[${String(MAX_HOUSES)}];
uniform vec4 uHouseLook[${String(MAX_HOUSES)}];
uniform int uHouseCount;
/** First lamp x, lamp spacing, lamp count, kind; building x, half width, lit windows, platform end x. */
uniform vec4 uStation;
uniform vec4 uStationB;
out vec4 outColor;
${VALUE_NOISE_GLSL}
const vec3 WARM = vec3(1.0, 0.7, 0.36);
float sq(float x) { return x * x; }

${COVERAGE_GLSL}

void main() {
  vec2 p = gl_FragCoord.xy * uPxToRef;
  vec2 q = vec2(p.x, p.y - ${F(VIEW_SHIFT)});
  float moon = uScroll.w;
  float cx = uView.x;
  float px = uPxToRef.x;

  // Sky: deep blue, lighter low down and round the moon, with stars.
  float t = clamp((q.y - ${F(HORIZON_Y)}) * ${F(1 / (REF_HEIGHT - HORIZON_Y))}, 0.0, 1.0);
  vec3 col = mix(vec3(0.028, 0.045, 0.1), vec3(0.006, 0.01, 0.03), sqrt(t));
  float md = length(p - uMoon.xy);
  col += vec3(0.07, 0.085, 0.13) * moon * (0.6 * exp2(-md * 0.008) + 0.4 * exp2(-md * 0.0022));
  vec2 cell = floor(p / 26.0);
  float h = hash2(cell, uScroll.z);
  if (h < 0.1) {
    vec2 at = (cell + 0.2 + 0.6 * vec2(hash2(cell, uScroll.z + 1.0), hash2(cell, uScroll.z + 2.0))) * 26.0;
    vec2 sd = (p - at) / max(px, 1.0);
    float b = (0.2 + 0.8 * h * 10.0) * (1.0 - 0.75 * moon * exp2(-md * 0.004));
    col += vec3(0.5, 0.55, 0.7) * 0.5 * b * exp(-dot(sd, sd) * 1.2) * smoothstep(${F(HORIZON_Y + 60)}, ${F(HORIZON_Y + 220)}, q.y);
  }
  float disc = clamp((uMoon.z - md) / px + 0.5, 0.0, 1.0) * moon;
  float maria = vnoise((p - uMoon.xy) * 0.16, 9.0);
  col = mix(col, vec3(0.95, 0.93, 0.84) * (0.82 + 0.18 * maria), disc);

  // Hills: moonlit along their ridges, with the odd farm light on the nearer ones.
  float u = p.x * ${F(1 / HILL_PERIOD)};
  float farH = textureLod(uHills, vec2(u + uScroll.x, 0.5), 0.0).r * 0.9;
  float far = ${F(HORIZON_Y)} + farH - q.y;
  float cFar = coverage(far);
  vec3 farCol = mix(vec3(0.016, 0.024, 0.048), vec3(0.04, 0.056, 0.1), moon)
    + vec3(0.05, 0.06, 0.08) * moon * exp2(-max(far, 0.0) * 0.12);
  col = mix(col, farCol, cFar);
  float nearH = textureLod(uHills, vec2(u + uScroll.y, 0.5), 0.0).g;
  float near = ${F(HORIZON_Y)} + nearH - q.y;
  float cNear = coverage(near);
  vec3 nearCol = mix(vec3(0.01, 0.016, 0.032), vec3(0.026, 0.038, 0.072), moon)
    + vec3(0.03, 0.035, 0.05) * moon * exp2(-max(near, 0.0) * 0.15);
  col = mix(col, nearCol, cNear);
  float xh = (u + uScroll.y) * ${F(HILL_PERIOD)};
  float lc = floor(xh / 150.0);
  float lh = hash2(vec2(lc, 3.0), uScroll.z);
  if (lh < 0.3) {
    float lx = (lc + 0.2 + 0.6 * hash2(vec2(lc, 5.0), uScroll.z)) * 150.0;
    float ly = ${F(HORIZON_Y)} + textureLod(uHills, vec2(lx * ${F(1 / HILL_PERIOD)}, 0.5), 0.0).g * 0.8 - 6.0 - 26.0 * hash2(vec2(lc, 7.0), uScroll.z);
    vec2 ld = vec2(xh - lx, q.y - ly) / max(px, 1.0);
    col += WARM * (0.55 * exp(-dot(ld, ld) * 0.7) + 0.06 * exp(-length(ld) * 0.5)) * cNear;
  }

  // The ground: fields, the river and the tree lines, in perspective as in the Train Window.
  if (q.y < ${F(HORIZON_Y + 4)}) {
    float dx = p.x - cx;
    vec4 farT = texture(uFields, vec2((dx * ${F(FAR_LINE_Z / FOCAL)} + uView.y) * ${F(1 / FIELD_PERIOD)}, 0.5));
    vec4 midT = texture(uFields, vec2((dx * ${F(MID_LINE_Z / FOCAL)} + uView.y) * ${F(1 / FIELD_PERIOD)} + ${F(MID_SHIFT)}, 0.5));
    float z = ${F(WORLD_K)} / max(${F(HORIZON_Y)} - q.y, ${F(WORLD_K / FAR_LINE_Z)});
    float xw = dx * z * ${F(1 / FOCAL)} + uView.y;
    vec4 g = texture(uFields, vec2(xw * ${F(1 / FIELD_PERIOD)} + 0.71, 0.5));
    vec3 ground = mix(vec3(0.014, 0.022, 0.026), vec3(0.03, 0.042, 0.05), g.g) * (0.5 + 0.5 * moon);
    ground *= 1.0 - 0.6 * g.b;
    // The river: a band of water at a meandering depth, now and then out of sight.
    float w = xw * ${F((2 * Math.PI) / FIELD_PERIOD)};
    float zr = 38.0 + 6.0 * sin(w * 2.0 + 0.7) + 3.0 * sin(w * 5.0 + 2.1);
    float half_ = (4.5 + 1.5 * sin(w * 3.0)) * smoothstep(-0.3, 0.2, sin(w + 1.3));
    float wc = coverage((half_ - abs(z - zr)) * (${F(HORIZON_Y)} - q.y) * (${F(HORIZON_Y)} - q.y) * ${F(1 / WORLD_K)});
    vec3 water = vec3(0.022, 0.034, 0.075) * (0.55 + 0.45 * moon);
    float glint = exp(-sq((p.x - uMoon.x) / (40.0 + 0.6 * (${F(HORIZON_Y)} - q.y)))) * (0.45 + 0.55 * vnoise(vec2(xw * 1.3, z * 0.9), 13.0));
    water += vec3(0.5, 0.52, 0.5) * 0.45 * moon * glint;
    ground = mix(ground, water, wc);
    ground = mix(ground, col * 0.9, smoothstep(${F(WORLD_K / 60)}, 0.0, ${F(HORIZON_Y)} - q.y) * 0.6);

    float farTop = ${F(FAR_Y)} + farT.r * ${F(FOCAL / FAR_LINE_Z)};
    float cF = coverage(farTop - q.y);
    vec3 trees = vec3(0.008, 0.013, 0.024) + vec3(0.012, 0.016, 0.025) * moon * farT.a;
    vec3 c = mix(ground, trees, clamp((q.y - ${F(FAR_Y)}) / px + 0.5, 0.0, 1.0));
    col = mix(col, c, cF);

    // Farmhouses: dark shapes with warm windows.
    for (int i = 0; i < ${String(MAX_HOUSES)}; i++) {
      if (i >= uHouseCount) break;
      vec4 hs = uHouse[i];
      vec2 r = vec2(q.x - hs.x, q.y - ${F(HOUSE_Y)});
      float ax = abs(r.x);
      if (ax > hs.y * 1.4 + 30.0 || r.y < -2.0 || r.y > hs.z + hs.w + 30.0) continue;
      float eave = hs.y * 1.15;
      float slope = 0.72 * eave / hs.w;
      float roofHalf = eave - slope * clamp(r.y - hs.z, 0.0, hs.w);
      float sd = r.y < hs.z ? hs.y - ax : (roofHalf - ax) * inversesqrt(1.0 + slope * slope);
      float hc = clamp(min(min(sd, hs.z + hs.w - r.y), r.y) / px + 0.5, 0.0, 1.0);
      vec2 wv = vec2(abs(ax - hs.y * 0.5), abs(r.y - hs.z * 0.55));
      vec2 wsz = vec2(hs.y * 0.17, hs.z * 0.16);
      vec2 wo = max(wv - wsz, 0.0);
      float lit = uHouseLook[i].x;
      float win = clamp(min(wsz.x - wv.x, wsz.y - wv.y) / px + 0.5, 0.0, 1.0) * lit;
      vec3 house = mix(vec3(0.01, 0.014, 0.022), WARM * 0.85, win);
      col = mix(col, house, hc);
      col += WARM * 0.12 * lit * exp(-length(wo) * 0.18) * (1.0 - win);
    }

    float midTop = ${F(MID_Y)} + midT.r * ${F((0.8 * FOCAL) / MID_LINE_Z)};
    float cM = coverage(midTop - q.y);
    vec3 hedge = vec3(0.005, 0.008, 0.014) + vec3(0.008, 0.011, 0.018) * moon * midT.a;
    col = mix(col, mix(ground, hedge, clamp((q.y - ${F(MID_Y)}) / px + 0.5, 0.0, 1.0)), cM);
  }

  // A station or level crossing: the building behind, then the platform, posts and lamps.
  float lamps = uStation.z;
  float platform = 0.0;
  if (lamps > 0.5) {
    bool station = uStation.w < 0.5;
    float wash = exp(-max(max(uStation.x - p.x, p.x - uStationB.w), 0.0) * 0.004);
    vec2 b = vec2(p.x - uStationB.x, q.y - ${F(GROUND_B)});
    float bh = (station ? 3.6 : 2.6) * ${F(KB)};
    float roof = bh + 1.3 * ${F(KB)} * clamp(1.0 - abs(b.x) / (uStationB.y + 8.0), 0.0, 1.0) * 1.6;
    float bc = clamp(min(uStationB.y - abs(b.x), min(roof, bh + 1.3 * ${F(KB)}) - b.y) / px + 0.5, 0.0, 1.0);
    float n = uStationB.z;
    float cellW = 2.0 * uStationB.y / n;
    float wi = clamp(floor((b.x + uStationB.y) / cellW), 0.0, n - 1.0);
    vec2 wv = vec2(b.x + uStationB.y - (wi + 0.5) * cellW, b.y - 1.8 * ${F(KB)});
    float win = clamp(min(0.42 * ${F(KB)} - abs(wv.x), 0.62 * ${F(KB)} - abs(wv.y)) / px + 0.5, 0.0, 1.0);
    vec3 bcol = mix(vec3(0.03, 0.026, 0.026) + WARM * 0.08 * wash, WARM * 0.8, win);
    col = mix(col, bcol, bc);
    col += WARM * 0.05 * wash * (1.0 - bc);

    float i = clamp(floor((p.x - uStation.x) / uStation.y + 0.5), 0.0, lamps - 1.0);
    float lx = uStation.x + i * uStation.y;
    float top = station ? ${F(LAMP_TOP)} : ${F(CROSSING_TOP)};
    if (station) {
      platform = clamp(min(min(p.x - uStation.x + 0.6 * uStation.y, uStationB.w + 0.6 * uStation.y - p.x), ${F(PLATFORM_TOP)} - q.y) / px + 0.5, 0.0, 1.0);
      float pool = exp(-sq((p.x - lx) / 170.0));
      vec3 pc = vec3(0.05, 0.045, 0.04) + WARM * 0.22 * pool;
      pc += vec3(0.25, 0.22, 0.18) * pool * smoothstep(${F(PLATFORM_TOP - 7)}, ${F(PLATFORM_TOP - 2)}, q.y);
      col = mix(col, pc, platform);
    }
    float post = clamp(min(3.0 - abs(p.x - lx), top - q.y) / px + 0.5, 0.0, 1.0);
    col = mix(col, vec3(0.02, 0.02, 0.022), post);
    vec2 ld = vec2(p.x - lx, q.y - top - 8.0);
    float dl = length(ld);
    col += WARM * (clamp((7.0 - dl) / px + 0.5, 0.0, 1.0) * 1.1 + 0.4 / (1.0 + dl * dl * 0.004) + 0.06 * exp(-dl * 0.006));
  }

  // The embankment's bushes, then the trackside poles: dark and soft.
  vec2 bk = texture(uBank, vec2(p.x * ${F(1 / BANK_PERIOD)} + uView.z, 0.5)).rg;
  float cB = coverage(bk.r - q.y) * (1.0 - platform);
  col = mix(col, vec3(0.004, 0.006, 0.01) + vec3(0.01, 0.012, 0.016) * moon * bk.g * exp2(-max(bk.r - q.y, 0.0) * 0.1), cB);
  float pxl = p.x + uView.w;
  float pd = pxl - floor(pxl * ${F(1 / POLE_SPACING)} + 0.5) * ${F(POLE_SPACING)};
  float pc = clamp((11.0 - abs(pd)) / max(px, 3.0) + 0.5, 0.0, 1.0);
  col = mix(col, vec3(0.004, 0.005, 0.008), pc * 0.95);
  outColor = vec4(col, 1.0);
}
`;

/** Scissor margin round the window and the live objects, reference px, for the sway. */
const SWAY_MARGIN = 10;

/**
 * At a table in the dining car of a night express: polished wood, a white
 * cloth, a brass lamp with a glowing shade, a bud vase and a drink, gently
 * rocking with the rails and jolting at each joint, while the moonlit
 * countryside slides past the window and now and then a small station's
 * lamps light the table.
 */
export const diningcar = defineEffect(diningcarMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const land = scope.own(createLowResTarget(gl));
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const landProgram = program(LAND_FRAGMENT);
      const lu = createUniforms(gl, landProgram, [
        "uHills",
        "uFields",
        "uBank",
        "uPxToRef",
        "uView",
        "uScroll",
        "uMoon",
        "uHouse",
        "uHouseLook",
        "uHouseCount",
        "uStation",
        "uStationB",
      ]);
      const roomProgram = program(ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uScale",
        "uSize",
        "uPanes",
        "uItems",
        "uSides",
        "uVessel",
      ]);
      const interiorProgram = program(INTERIOR_FRAGMENT);
      const iu = createUniforms(gl, interiorProgram, ["uRoom", "uResolution", "uXform"]);
      const objectProgram = program(OBJECT_FRAGMENT);
      const ou = createUniforms(gl, objectProgram, [
        "uScale",
        "uKind",
        "uVessel",
        "uAt",
        "uMotion",
        "uDrink",
        "uXform",
      ]);
      const glowProgram = program(GLOW_FRAGMENT);
      const gu = createUniforms(gl, glowProgram, ["uScale", "uGlow", "uColor"]);

      const hills = scope.own(
        createColumnTable(gl, HILL_COLUMNS, HILL_CHANNELS, { wrap: gl.REPEAT }),
      );
      const fields = scope.own(
        createColumnTable(gl, FIELD_COLUMNS, FIELD_CHANNELS, { wrap: gl.REPEAT }),
      );
      const bank = scope.own(
        createColumnTable(gl, BANK_COLUMNS, BANK_CHANNELS, { wrap: gl.REPEAT }),
      );

      gl.useProgram(landProgram);
      lu.i1("uHills", 0);
      lu.i1("uFields", 1);
      lu.i1("uBank", 2);
      gl.useProgram(interiorProgram);
      iu.i1("uRoom", 0);
      gl.useProgram(glowProgram);
      gu.v3("uColor", STATION_RGB);
      gl.useProgram(null);

      let room: RenderTarget | null = null;
      scope.defer(() => room?.dispose());
      /** The vessel the cache was drawn with; -1 when it must be redrawn. */
      let roomVessel = -1;

      const trainState = createTrain();
      const houses = new Float64Array(MAX_HOUSES * HOUSE_FLOATS);
      const houseView = new Float32Array(MAX_HOUSES * 4);
      const houseLook = new Float32Array(MAX_HOUSES * 4);
      const stationView = new Float32Array(STATION_FLOATS);
      const rock = { dy: 0, tilt: 0 };
      const liquid = createSpring();
      const fringe = createSpring();
      const bump = createSpring();
      let jolts = createJolts(0);
      let stations = createStations(0);
      let kicks = createRng(1);
      let tableSeed = Number.NaN;
      let moonLevel = Number.NaN;

      let width = 1;
      let height = 1;
      let scale = 1;
      let layout: DiningLayout = diningLayout(1920);
      /** CPU-only time, unwrapped float64. */
      let time = 0;

      /** Scissors to a rect in reference px (x0, y0, x1, y1), clipped to the canvas. */
      const scissorRef = (x0: number, y0: number, x1: number, y1: number, k = 1) => {
        const sx = Math.max(0, Math.floor((x0 * scale) / k));
        const sy = Math.max(0, Math.floor((y0 * scale) / k));
        const ex = Math.min(Math.ceil(width / k), Math.ceil((x1 * scale) / k));
        const ey = Math.min(Math.ceil(height / k), Math.ceil((y1 * scale) / k));
        gl.scissor(sx, sy, Math.max(0, ex - sx), Math.max(0, ey - sy));
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale;
          layout = diningLayout(width / scale);
          land.resize(width, height, Math.max(1, LAND_TEXEL_REF * scale));
          gl.useProgram(landProgram);
          lu.f2(
            "uPxToRef",
            land.fullWidth / land.width / scale,
            land.fullHeight / land.height / scale,
          );
          gl.useProgram(null);
          room?.dispose();
          room = createRenderTarget(gl, width, height, gl.RGBA8);
          roomVessel = -1;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!room) {
            return;
          }
          const l = layout;
          const seed = Math.floor(p.seed);
          const drink = drinkLook(p.drink);
          const pos = stepTrain(trainState, step, p.speed, 1) * POS_SCALE;
          const v = trainState.v * POS_SCALE;
          const speed = trainState.v / V_MAX;

          if (seed !== tableSeed) {
            tableSeed = seed;
            gl.activeTexture(gl.TEXTURE0);
            fillHillTable(hills.data, seed);
            hills.upload();
            fillFieldTable(fields.data, seed);
            fields.upload();
            fillBankTable(bank.data, seed);
            bank.upload();
            placeHouses(houses, seed);
            jolts = createJolts(seed);
            stations = createStations(seed);
            kicks = createRng(seed + 101);
          }

          // Motion: the rock, the jolts and the springs they kick.
          const amp = smoothstep(0, 0.3, speed);
          if (stepJolts(jolts, step, v) && amp > 0) {
            const side = kicks() < 0.5 ? -1 : 1;
            liquid.v += side * LIQUID_KICK * amp * (0.6 + 0.4 * kicks());
            fringe.v += side * FRINGE_KICK * amp * (0.6 + 0.4 * kicks());
            bump.v -= BUMP_KICK * amp * (0.7 + 0.3 * kicks());
          }
          rockAt(time, speed, rock);
          const sway = rock.dy / ROCK_PX;
          const tiltL = stepSpring(
            liquid,
            step,
            LIQUID_HZ,
            LIQUID_DAMPING,
            LIQUID_MAX,
            0.03 * sway,
          );
          const swing = stepSpring(
            fringe,
            step,
            FRINGE_HZ,
            FRINGE_DAMPING,
            FRINGE_MAX,
            0.05 * sway,
          );
          const dy = rock.dy + stepSpring(bump, step, BUMP_HZ, BUMP_DAMPING, BUMP_MAX);
          const cosT = Math.cos(rock.tilt);
          const sinT = Math.sin(rock.tilt);

          moonLevel = Number.isNaN(moonLevel)
            ? Number(p.moon)
            : approach(moonLevel, p.moon ? 1 : 0, step / MOON_EASE);
          const glow = stationGlow(stepStations(stations, step, pos, p.stations, l.cx));

          // 1. The interior cache, when the size or the vessel changes.
          if (roomVessel !== drink.vessel) {
            roomVessel = drink.vessel;
            room.bind();
            gl.useProgram(roomProgram);
            ru.f1("uScale", scale);
            ru.f2("uSize", l.width, l.cx);
            ru.f4("uPanes", l.paneL0, l.paneL1, l.paneR0, l.paneR1);
            ru.f3("uItems", l.lampX, l.vaseX, l.vesselX);
            ru.f2("uSides", l.seatW, l.curtainW);
            ru.i1("uVessel", drink.vessel);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. The landscape at low resolution, over the window only.
          gl.enable(gl.SCISSOR_TEST);
          const wx0 = l.paneL0 - FRAME_W - SWAY_MARGIN;
          const wx1 = l.paneR1 + FRAME_W + SWAY_MARGIN;
          const wy0 = WIN_Y0 - FRAME_W - SWAY_MARGIN;
          const wy1 = WIN_Y1 + FRAME_W + SWAY_MARGIN;
          land.bind();
          scissorRef(wx0, wy0, wx1, wy1, land.fullWidth / land.width);
          gl.useProgram(landProgram);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, bank.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, fields.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, hills.texture);
          lu.f4(
            "uView",
            l.cx,
            fract(pos / FIELD_PERIOD) * FIELD_PERIOD,
            scrollOffset(pos, BANK_Z, BANK_PERIOD),
            wrap((pos * FOCAL) / POLE_Z, 0, POLE_SPACING),
          );
          lu.f4(
            "uScroll",
            scrollOffset(pos, FAR_HILL_Z, HILL_PERIOD),
            scrollOffset(pos, NEAR_HILL_Z, HILL_PERIOD),
            (seed % 97) + 3,
            smoothstep(0, 1, moonLevel),
          );
          lu.f3("uMoon", l.paneR0 + MOON_AT * (l.paneR1 - l.paneR0), MOON_Y, MOON_R);
          const houseCount = viewHouses(houses, pos, l.width, 1, houseView, houseLook);
          lu.i1("uHouseCount", houseCount);
          if (houseCount > 0) {
            gl.uniform4fv(lu.loc.uHouse, houseView);
            gl.uniform4fv(lu.loc.uHouseLook, houseLook);
          }
          viewStation(stations, pos, l.cx, stationView);
          lu.f4("uStation", stationView[0], stationView[1], stationView[2], stationView[3]);
          lu.f4("uStationB", stationView[4], stationView[5], stationView[6], stationView[7]);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          scissorRef(wx0, wy0, wx1, wy1);
          land.blit();

          // 3. The interior over it, rocking with the carriage.
          gl.disable(gl.SCISSOR_TEST);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(interiorProgram);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          iu.f2("uResolution", width, height);
          iu.f4("uXform", cosT, sinT, dy * scale, l.cx * scale);
          triangle.draw();

          // 4. The drink and the lamp's fringe.
          gl.enable(gl.SCISSOR_TEST);
          gl.useProgram(objectProgram);
          ou.f1("uScale", scale);
          ou.i1("uVessel", drink.vessel);
          ou.f2("uAt", l.lampX, l.vesselX);
          ou.f4("uMotion", drink.level, tiltL, drink.alpha, swing);
          ou.v3("uDrink", drink.rgb);
          ou.f4("uXform", cosT, sinT, dy * scale, l.cx * scale);
          ou.i1("uKind", 0);
          scissorRef(
            l.vesselX - 60 - SWAY_MARGIN,
            VESSEL_BASE_Y + 60,
            l.vesselX + 60 + SWAY_MARGIN,
            VESSEL_BASE_Y + 240,
          );
          triangle.draw();
          ou.i1("uKind", 1);
          const reach = SHADE_HALF0 + FRINGE_LEN * FRINGE_MAX + SWAY_MARGIN;
          scissorRef(
            l.lampX - reach,
            SHADE_Y0 - FRINGE_LEN - 4 - SWAY_MARGIN,
            l.lampX + reach,
            SHADE_Y0 + 2 + SWAY_MARGIN,
          );
          triangle.draw();

          // 5. A passing station's light on the table.
          if (glow > 0.002) {
            gl.useProgram(glowProgram);
            gl.blendFunc(gl.ONE, gl.ONE);
            gu.f1("uScale", scale);
            gu.f3("uGlow", STATION_PEAK * glow, stations.lightX, 0.32 * l.width);
            scissorRef(0, 0, l.width, WIN_Y0);
            triangle.draw();
          }
          gl.disable(gl.SCISSOR_TEST);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
