import type { Rgb } from "../color";
import { NOISE_GLSL } from "../cockpit/cockpit-layout";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
} from "../gl";
import {
  createSkyState,
  lunarPhase,
  moonTerminator,
  type Terminator,
} from "../horizon/horizon-sim";
import { createPieces, type PieceFrame, type Season, SEASONS, SHAPES } from "../leaves/leaves-sim";
import { lowResSize } from "../lowres";
import { clamp } from "../math";
import { PIECE_FRAGMENT, pieceVertex } from "../pieces";
import { createFlakes, type FlakeFrame } from "../snow/snow-sim";
import { createFlakeRenderer } from "../snowflakes";
import { drawGlyphAtlas, GLYPH_AT_GLSL } from "../splitflap/splitflap-atlas";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import {
  advanceCycles,
  ARC_HALF,
  ARC_HEIGHT,
  bodyAt,
  CHAIR_CREST,
  CHAIR_HALF,
  CHAIR_SHOULDER,
  copySky,
  COUNTER_BOTTOM,
  COUNTER_CELLS,
  COUNTER_INSET,
  COUNTER_TOP,
  counterDrums,
  createJourneyTime,
  createSceneLayout,
  createSeasonLook,
  daySeconds,
  DISC_R,
  DISC_Y,
  discRate,
  directionSign,
  HORIZON_Y,
  journeyAt,
  LEVER_LEAN,
  LEVER_LENGTH,
  LEVER_Y,
  lightAt,
  lightSwing,
  nightFrom,
  PANEL_BOTTOM,
  PANEL_TOP,
  PANEL_W,
  SEASON_BUCKETS,
  seasonAt,
  seasonBuckets,
  sceneLayout,
  slewLight,
} from "./timemachine-sim";
import { OUTSIDE_OPTIONS, timemachineMeta } from "./timemachine.meta";

const f = glslFloat;
const TAU = Math.PI * 2;

/** The outside is soft and hazy, so it is drawn and lit at half size. */
const OUTSIDE_DIVISOR = 2;
/** Most falling snowflakes and leaves, at the height of their seasons. */
const MAX_SNOW = 150;
const MAX_LEAVES = 36;
/** The falling snow's colour by day. */
const SNOW_COLOUR: Rgb = [0.93, 0.95, 1];
/** Falling leaves' size (1080p px), and how fast the snow and leaves fall. */
const LEAF_SIZE = 13;
const SNOW_SPEED = 0.8;
const LEAF_SPEED = 0.7;
/** The machine's own warm lamplight, and how much of the daylight outside reaches it. */
const INTERIOR: Rgb = [0.6, 0.52, 0.42];
const DAYLIGHT_SHARE = 0.5;
/** The shimmer of the machine's field: its reach (1080p px) and its two waves' rates (rad/s). */
const SHIMMER_PX = 1.4;
const SHIMMER_RATES: readonly [number, number] = [0.9, 0.55];

/* ----- The outside, drawn once per week of the calendar ----- */

/**
 * The outside's colours for one week of the year, at half size, in two modes.
 * Mode 0: the albedo (rgb) and how much of the pixel is solid rather than sky
 * (a). Mode 1: what lights it: warm lamp or window glow at night (r), how much
 * it mirrors the sky (g), how much direct sunlight reaches it (b), and the
 * haze of distance (a). The scene behind is the garden, a city street or the
 * seaside; a tree in front of it changes with the seasons in all three.
 */
const ALBEDO_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform int uScene;
uniform int uMode;
/** Foliage, blossom and lying snow. */
uniform vec3 uSeason;
uniform vec3 uLeaf;
uniform vec3 uGrass;
/** The tree's trunk and the street lamp's post (x). */
uniform vec2 uPlaces;

out vec4 outColor;
${NOISE_GLSL}

const float HY = ${f(HORIZON_Y)};
const vec3 SNOW = vec3(0.9, 0.92, 0.96);

float px;
vec4 acc;
vec4 ext;

/** Lays a layer with colour col and lighting e over everything so far. */
void lay(vec3 col, float cov, vec4 e) {
  acc = vec4(col, 1.0) * cov + acc * (1.0 - cov);
  ext = e * cov + ext * (1.0 - cov);
}

float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}

float sdBox(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

/** Snow lying on a surface, as much as the season has. */
vec3 snowed(vec3 col, float k) {
  return mix(col, SNOW, clamp(uSeason.z * k, 0.0, 1.0));
}

void garden(vec2 p) {
  // Woods beyond the wall, bare and grey in winter.
  float woods = HY + 0.15 + 0.03 * fbm(vec2(p.x * 5.0, 0.5), 3.0) + 0.012 * vnoise(vec2(p.x * 30.0, 1.5), 4.0);
  if (p.y < woods + px) {
    vec3 bare = vec3(0.36, 0.33, 0.34);
    vec3 col = mix(bare, uLeaf * 0.6, uSeason.x) * (0.8 + 0.35 * vnoise(p * 45.0, 5.0));
    col = snowed(col, 0.45 * smoothstep(0.3, 0.7, vnoise(p * 60.0, 6.0)));
    lay(col, cover(p.y - woods), vec4(0.0, 0.0, 0.6, 0.75));
  }
  // The garden wall: brick, with stone coping.
  float wallTop = HY + 0.1;
  if (p.y < wallTop + 0.014 + px) {
    float row = (p.y - HY) / 0.0125;
    float ri = floor(row);
    float u = p.x / 0.032 + 0.5 * mod(ri, 2.0);
    float mortar = max(smoothstep(0.1, 0.0, min(fract(row), 1.0 - fract(row))), smoothstep(0.06, 0.0, min(fract(u), 1.0 - fract(u))));
    vec3 brick = vec3(0.55, 0.27, 0.19) * (0.82 + 0.3 * hash2(vec2(floor(u), ri), 7.0));
    vec3 col = mix(brick, vec3(0.62, 0.58, 0.52), mortar * 0.8);
    // Older and darker towards the foot.
    col *= 0.78 + 0.22 * smoothstep(HY, wallTop, p.y);
    vec4 e = vec4(0.0, 0.0, 0.8, 0.3);
    if (p.y > wallTop) {
      col = snowed(vec3(0.63, 0.6, 0.55), 1.0);
      e.b = 1.0;
    }
    lay(col, cover(p.y - wallTop - 0.014), e);
  }
  // A glasshouse along the right: a low brick wall, glazing, a pitched glass roof.
  float g0 = 0.22;
  float g1 = 0.88;
  if (p.x > g0 - px && p.x < g1 + px && p.y < HY + 0.27) {
    float eave = HY + 0.17;
    float ridge = HY + 0.255;
    float roof = mix(eave, ridge, smoothstep(g0, g0 + 0.08, p.x) * smoothstep(g1, g1 - 0.08, p.x));
    float d = max(sdBox(p, vec2(0.5 * (g0 + g1), 0.5 * (HY + ridge)), vec2(0.5 * (g1 - g0), 0.5 * (ridge - HY))), p.y - roof);
    if (d < px) {
      vec3 col;
      vec4 e;
      if (p.y < HY + 0.03) {
        col = vec3(0.5, 0.26, 0.18) * (0.85 + 0.25 * vnoise(p * vec2(30.0, 80.0), 8.0));
        e = vec4(0.0, 0.0, 0.8, 0.25);
      } else {
        // Glazing bars, white-painted, every few inches; plants behind the glass.
        float bar = smoothstep(0.004, 0.002, abs(fract(p.x / 0.045) - 0.5) * 0.045 - 0.0175);
        float rail = smoothstep(0.004, 0.002, abs(p.y - eave));
        float frame = max(max(bar, rail), smoothstep(0.004, 0.002, abs(p.y - HY - 0.03)));
        vec3 plants = vec3(0.16, 0.24, 0.13) * (0.7 + 0.6 * vnoise(p * 40.0, 9.0));
        bool onRoof = p.y > eave;
        if (onRoof) {
          plants = snowed(plants * 0.8, 0.85);
        }
        col = mix(plants, vec3(0.86, 0.87, 0.84), frame);
        e = vec4(0.0, (onRoof ? 0.45 : 0.6) * (1.0 - frame) * (1.0 - (onRoof ? uSeason.z * 0.85 : 0.0)), 0.8, 0.25);
      }
      lay(col, cover(d), e);
    }
  }
  // The lawn, mown in stripes that run away from you.
  if (p.y < HY + px) {
    float depth = HY + 0.04 - p.y;
    float stripe = step(0.5, fract(p.x / depth * 0.45 + 0.25));
    vec3 col = uGrass * (0.9 + 0.12 * stripe) * (0.88 + 0.2 * vnoise(vec2(p.x / depth * 8.0, 1.0 / depth), 10.0));
    col = snowed(col, 1.0);
    lay(col, cover(p.y - HY), vec4(0.0, 0.0, 1.0, 0.25 * smoothstep(-0.2, HY, p.y)));
  }
}

void street(vec2 p) {
  // A terrace of tall town houses across the street.
  float w = 0.34;
  float hi = floor(p.x / w);
  float hx = p.x - hi * w;
  float h1 = hash2(vec2(hi, 1.0), 11.0);
  float roofLine = HY + 0.3;
  float chimney = sdBox(vec2(hx, p.y), vec2(0.05, roofLine + 0.03), vec2(0.025, 0.03));
  if (p.y < roofLine + px || chimney < px) {
    vec3 brick = h1 < 0.5 ? vec3(0.5, 0.3, 0.22) : vec3(0.78, 0.74, 0.64);
    vec3 col = brick * (0.88 + 0.18 * vnoise(p * vec2(40.0, 90.0), 12.0));
    vec4 e = vec4(0.0, 0.0, 0.7, 0.3);
    // Party walls between the houses.
    col *= 1.0 - 0.3 * smoothstep(0.004, 0.0, min(hx, w - hx));
    // Slate roofs, and chimney stacks with pots.
    if (p.y > roofLine - 0.03 && chimney > 0.0) {
      col = snowed(vec3(0.24, 0.26, 0.3) * (0.85 + 0.2 * vnoise(p * vec2(80.0, 20.0), 13.0)), 0.9);
      e.b = 0.9;
    } else if (chimney < px && p.y > roofLine - 0.03) {
      col = vec3(0.48, 0.28, 0.2);
      if (p.y > roofLine + 0.055) {
        col = snowed(col, 0.8);
      }
    } else {
      // Sash windows on two floors, and a door.
      for (int r = 0; r < 2; r++) {
        float wy = r == 0 ? HY + 0.075 : HY + 0.2;
        for (int c = 0; c < 2; c++) {
          float wx = c == 0 ? 0.08 : 0.26;
          if (r == 0 && c == 1) {
            continue;
          }
          float d = sdBox(vec2(hx, p.y), vec2(wx, wy), vec2(0.035, 0.05));
          if (d < 0.006) {
            float frame = smoothstep(-0.006, -0.004, d) + smoothstep(0.002, 0.0, abs(p.y - wy)) + smoothstep(0.0015, 0.0, abs(hx - wx));
            float lit = step(0.45, hash2(vec2(hi * 4.0 + float(r * 2 + c), 2.0), 14.0));
            vec3 glass = vec3(0.1, 0.11, 0.13);
            float inFrame = clamp(frame, 0.0, 1.0);
            col = mix(glass, vec3(0.88, 0.86, 0.8), inFrame);
            if (d > 0.0) {
              col = vec3(0.86, 0.84, 0.78);
              inFrame = 1.0;
            }
            e = vec4(lit * (1.0 - inFrame) * (0.7 + 0.3 * h1), 0.35 * (1.0 - inFrame), 0.7, 0.3);
          }
        }
      }
      float door = sdBox(vec2(hx, p.y), vec2(0.25, HY + 0.05), vec2(0.03, 0.055));
      if (door < 0.0) {
        col = (h1 > 0.7 ? vec3(0.12, 0.22, 0.16) : h1 > 0.35 ? vec3(0.08, 0.08, 0.1) : vec3(0.35, 0.1, 0.1)) * (0.8 + 0.25 * smoothstep(-0.03, 0.0, door));
      }
    }
    lay(col, cover(min(p.y - roofLine, chimney)), e);
  }
  // The pavement, the kerb and the cobbled road.
  if (p.y < HY + px) {
    vec3 col;
    float depth = HY + 0.04 - p.y;
    if (p.y > HY - 0.035) {
      col = vec3(0.5, 0.49, 0.46) * (0.9 + 0.1 * step(0.5, fract(p.x / 0.06)));
    } else {
      vec2 c = vec2(p.x / depth * 1.8, 0.35 / depth);
      float cell = vnoise(c * 3.0, 15.0);
      float gap = smoothstep(0.35, 0.0, min(min(fract(c.x * 3.0), 1.0 - fract(c.x * 3.0)), min(fract(c.y * 3.0), 1.0 - fract(c.y * 3.0))));
      col = vec3(0.36, 0.33, 0.3) * (0.75 + 0.4 * cell) * (1.0 - 0.35 * gap);
    }
    col = snowed(col, 0.95);
    lay(col, cover(p.y - HY), vec4(0.0, 0.08 * (1.0 - uSeason.z), 1.0, 0.2 * smoothstep(-0.2, HY, p.y)));
  }
  // A gas lamp on the pavement.
  {
    float lx = uPlaces.y;
    float post = max(abs(p.x - lx) - 0.006 - 0.004 * smoothstep(HY + 0.03, HY - 0.03, p.y), max(p.y - HY - 0.2, HY - 0.04 - p.y));
    float lantern = sdBox(p, vec2(lx, HY + 0.225), vec2(0.022 - 0.25 * (p.y - HY - 0.225), 0.03));
    float cap = sdBox(p, vec2(lx, HY + 0.262), vec2(0.028 - 0.6 * (p.y - HY - 0.262), 0.007));
    float d = min(min(post, lantern), cap);
    if (d < px) {
      vec3 col = vec3(0.08, 0.1, 0.09);
      vec4 e = vec4(0.0, 0.0, 0.6, 0.15);
      if (lantern < 0.0 && cap > 0.0) {
        float pane = step(0.004, -lantern) * step(0.003, abs(p.x - lx));
        col = mix(col, vec3(0.75, 0.7, 0.55), pane);
        e = vec4(pane, 0.2 * pane, 0.6, 0.15);
      }
      lay(col, cover(d), e);
    }
  }
}

void seaside(vec2 p) {
  float seaLine = HY + 0.07;
  // A headland to the right, with a little lighthouse.
  float head = seaLine + 0.15 * smoothstep(0.15, 0.7, p.x) - 0.04 * smoothstep(0.75, 1.1, p.x) + 0.01 * vnoise(vec2(p.x * 20.0, 2.0), 16.0);
  float tower = sdBox(p, vec2(0.62, head + 0.04), vec2(0.011 - 0.04 * (p.y - head - 0.04), 0.045));
  float lamp = sdBox(p, vec2(0.62, head + 0.093), vec2(0.009, 0.009));
  if (p.y < head + px || tower < px || lamp < px) {
    vec3 col = mix(uGrass * 0.75, vec3(0.42, 0.38, 0.34), smoothstep(head - 0.03, head - 0.09, p.y)) * (0.85 + 0.3 * vnoise(p * 50.0, 17.0));
    col = snowed(col, 0.7);
    vec4 e = vec4(0.0, 0.0, 0.7, 0.55);
    float d = p.y - head;
    if (tower < px) {
      col = mix(vec3(0.9, 0.88, 0.84), vec3(0.62, 0.14, 0.12), step(0.5, fract((p.y - head) / 0.03)));
      e = vec4(0.0, 0.0, 0.8, 0.45);
      d = min(d, tower);
    }
    if (lamp < px) {
      col = vec3(0.7, 0.68, 0.55);
      e = vec4(1.0, 0.0, 0.5, 0.3);
      d = min(d, lamp);
    }
    lay(col, cover(d), e);
  }
  // The sea, mirroring the sky more towards the horizon.
  float shore = HY - 0.05;
  if (p.y < seaLine + px) {
    float depth = seaLine + 0.02 - p.y;
    float ripple = vnoise(vec2(p.x * 6.0 / depth, 0.4 / depth), 18.0);
    vec3 col = vec3(0.07, 0.2, 0.25) * (0.8 + 0.35 * ripple);
    float mirror = mix(0.85, 0.45, smoothstep(seaLine, shore, p.y)) * (0.85 + 0.15 * ripple);
    lay(col, cover(p.y - seaLine), vec4(0.0, mirror, 0.5, 0.35 * smoothstep(shore, seaLine, p.y)));
  }
  // The beach, wet where the waves reach, then the promenade.
  if (p.y < shore + px) {
    vec3 sand = vec3(0.78, 0.69, 0.5) * (0.9 + 0.15 * vnoise(p * vec2(30.0, 120.0), 19.0));
    sand *= mix(1.0, 0.7, smoothstep(shore - 0.012, shore, p.y));
    float foam = smoothstep(0.003, 0.0, abs(p.y - shore + 0.002 + 0.002 * sin(p.x * 30.0)));
    vec3 col = snowed(mix(sand, vec3(0.92), foam * 0.7), 0.9);
    lay(col, cover(p.y - shore), vec4(0.0, 0.0, 1.0, 0.1));
  }
  float prom = HY - 0.1;
  if (p.y < prom + px) {
    vec3 col = snowed(vec3(0.6, 0.58, 0.54) * (0.9 + 0.1 * step(0.5, fract(p.x / 0.08 + p.y * 3.0))), 1.0);
    lay(col, cover(p.y - prom), vec4(0.0, 0.0, 1.0, 0.0));
  }
  // The promenade's iron railing.
  {
    float top = abs(p.y - prom - 0.045) - 0.004;
    float mid = abs(p.y - prom - 0.022) - 0.0025;
    float post = max(abs(fract(p.x / 0.05) - 0.5) * 0.05 - 0.003, max(p.y - prom - 0.05, prom - p.y));
    float d = min(min(top, mid), post);
    if (d < px) {
      lay(snowed(vec3(0.82, 0.84, 0.82), 0.3 * step(0.0, p.y - prom - 0.045)), cover(d), vec4(0.0, 0.0, 0.8, 0.0));
    }
  }
}

/** The tree in front of the scene: trunk, branches, and a canopy that comes and goes with the seasons. */
void tree(vec2 p) {
  float tx = uPlaces.x;
  float base = HY - 0.1;
  vec2 top = vec2(tx, base + 0.21);
  vec2 crown = vec2(tx, base + 0.36);
  if (abs(p.x - tx) > 0.32 || p.y > base + 0.58) {
    return;
  }
  vec3 bark = vec3(0.24, 0.19, 0.15);
  // The trunk, tapering, and the branches fanning out from its top.
  {
    float hw = mix(0.02, 0.011, clamp((p.y - base) / 0.21, 0.0, 1.0));
    float d = max(abs(p.x - tx - 0.004 * sin(p.y * 30.0)) - hw, max(base - 0.012 - p.y, p.y - top.y - 0.01));
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float ang = mix(-1.15, 1.15, fi / 6.0) + 0.15 * sin(fi * 2.3);
      float len = 0.15 + 0.05 * fract(fi * 0.618);
      vec2 end = top + len * vec2(sin(ang), cos(ang) * 0.95);
      float s = sdSeg(p, top, end) - mix(0.006, 0.0025, clamp(length(p - top) / len, 0.0, 1.0));
      // A fork near each branch's tip.
      vec2 mid = mix(top, end, 0.6);
      vec2 tip = mid + 0.06 * vec2(sin(ang + 0.6), cos(ang + 0.6));
      s = min(s, sdSeg(p, mid, tip) - 0.0022);
      d = min(d, s);
    }
    if (d < px) {
      vec3 col = bark * (0.8 + 0.3 * vnoise(p * vec2(200.0, 40.0), 20.0));
      // Snow along the branches' upper sides.
      col = snowed(col, 0.6 * smoothstep(0.3, 0.8, vnoise(p * 300.0, 21.0)));
      lay(col, cover(d), vec4(0.0, 0.0, 0.6, 0.12));
    }
  }
  // The canopy: clumps of leaves that fill out from buds as the foliage grows.
  float field = 0.0;
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float ang = fi * 0.9 + 0.3;
    vec2 c = crown + vec2(cos(ang), sin(ang) * 0.7) * (i == 0 ? 0.0 : 0.1);
    float r = i == 0 ? 0.14 : 0.1;
    field = max(field, 1.0 - length(p - c) / r);
  }
  field += 0.45 * (fbm(p * 28.0, 22.0) - 0.5);
  float threshold = 1.0 - uSeason.x * 1.15;
  if (uSeason.x > 0.0 && field > threshold - 0.05) {
    float cov = smoothstep(threshold, threshold + 0.04, field);
    float n = vnoise(p * 90.0, 23.0);
    vec3 col = uLeaf * (0.7 + 0.45 * n) * (0.8 + 0.4 * clamp((p.y - crown.y) / 0.2 + 0.5, 0.0, 1.0));
    // Blossom among the new leaves.
    float bl = step(1.0 - uSeason.y * 0.55, vnoise(p * 140.0, 24.0));
    col = mix(col, vec3(0.97, 0.8, 0.86), bl);
    lay(snowed(col, 0.3), cov, vec4(0.0, 0.0, 0.55 + 0.35 * n, 0.12));
  }
}

void main() {
  px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  acc = vec4(0.0);
  ext = vec4(0.0);
  if (uScene == 1) {
    street(p);
  } else if (uScene == 2) {
    seaside(p);
  } else {
    garden(p);
  }
  tree(p);
  float a = max(acc.a, 1e-4);
  outColor = uMode == 0 ? vec4(acc.rgb / a, acc.a) : ext / a;
}
`;

/**
 * The outside lit for the moment, at half size: the sky with its sun and moon
 * (and their streaks across it on fast days), the stars at night, and the
 * scene crossfaded between this week's colours and next, lit by the day, its
 * windows and lamps glowing at night and its glass and water mirroring the sky.
 */
const OUTSIDE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uAlbedoA;
uniform sampler2D uAlbedoB;
uniform sampler2D uExtrasA;
uniform sampler2D uExtrasB;
/** Frame heights per texel, unused, the crossfade between the weeks, and how dark it is. */
uniform vec4 uFrame;
/** The sun and the moon. */
uniform vec4 uBodies;
/** The moon's terminator (k, side), how much shows by day, and the streaks' strength. */
uniform vec4 uMoon;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uLight;
uniform float uGlowStrength;

out vec4 outColor;
${NOISE_GLSL}

const float HY = ${f(HORIZON_Y)};

vec3 sky(vec2 p) {
  float t = clamp((p.y - HY) / 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, t * (2.0 - t));
  float d = length(p - uBodies.xy);
  col = mix(col, uGlow, min(1.0, uGlowStrength * (0.5 * exp(-d * 7.0) + 0.35 * exp(-d * 2.0) * (1.0 - t))));
  float night = uFrame.w;
  // Stars, scattered and still.
  if (night > 0.0) {
    vec2 g = p * 70.0;
    vec2 c = floor(g);
    vec2 o = vec2(hash2(c, 31.0), hash2(c, 32.0)) * 0.6 + 0.2;
    float star = step(0.965, hash2(c, 33.0)) * smoothstep(0.16, 0.0, length(fract(g) - o));
    col += star * night * t * (0.45 + 0.4 * hash2(c, 34.0));
  }
  // On fast days the sun (and moon) streak along their arcs.
  float streak = uMoon.w;
  if (streak > 0.0 && p.y > HY) {
    vec2 q = (p - vec2(0.0, HY)) / vec2(${f(ARC_HALF)}, ${f(ARC_HEIGHT)});
    float e = (length(q) - 1.0) * ${f(ARC_HEIGHT)};
    col += streak * vec3(1.0, 0.9, 0.72) * 0.3 * exp(-e * e / 0.0003);
  }
  // The sun's disc, softened to its streak when fast.
  col = mix(col, vec3(1.0, 0.96, 0.86), (1.0 - 0.7 * streak) * smoothstep(0.03, 0.025, d));
  // The moon, lit on its sunward side.
  vec2 m = (p - uBodies.zw) / 0.024;
  float md = length(m);
  if (md < 1.1) {
    float lit = smoothstep(-0.1, 0.1, m.x * uMoon.y - uMoon.x * sqrt(max(0.0, 1.0 - m.y * m.y)));
    vec3 mc = vec3(0.94, 0.93, 0.86) * (0.1 + 0.9 * lit) * (0.9 + 0.1 * hash2(floor(m * 4.0), 35.0));
    col = mix(col, mc, smoothstep(1.0, 0.9, md) * mix(uMoon.z, 1.0, night) * (1.0 - 0.6 * streak));
  }
  return col;
}

void main() {
  vec2 res = vec2(textureSize(uAlbedoA, 0));
  vec2 uv = gl_FragCoord.xy / res;
  float px = uFrame.x;
  vec2 p = (gl_FragCoord.xy - 0.5 * res) * px;
  vec4 a = mix(texture(uAlbedoA, uv), texture(uAlbedoB, uv), uFrame.z);
  vec3 col = a.a < 0.999 ? sky(p) : vec3(0.0);
  if (a.a > 0.0) {
    vec4 e = mix(texture(uExtrasA, uv), texture(uExtrasB, uv), uFrame.z);
    vec3 lit = a.rgb * (uLight * (0.45 + 0.55 * e.b) + 0.2 * uZenith + 0.05);
    vec3 mirror = mix(uHorizon, uZenith, 0.3) * 0.9 + uGlow * uGlowStrength * 0.25;
    lit = mix(lit, mirror, e.g);
    lit += e.r * uFrame.w * vec3(1.0, 0.72, 0.38);
    lit = mix(lit, uHorizon, e.a * 0.55);
    col = mix(col, lit, a.a);
  }
  outColor = vec4(col, 1.0);
}
`;

/** The lit outside upscaled to the frame through the machine's faintly shimmering field. */
const BLIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uOutside;
uniform vec2 uResolution;
/** The shimmer's reach (uv) and its two waves' phases. */
uniform vec4 uShimmer;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uResolution;
  float y = uv.y * 9.0;
  vec2 wobble = vec2(
    sin(y * 4.3 + uShimmer.z) + 0.6 * sin(y * 7.1 - uShimmer.w + uv.x * 5.0),
    0.5 * sin(uv.x * 23.0 + uShimmer.w)
  );
  outColor = vec4(texture(uOutside, uv + wobble * uShimmer.xy).rgb + dither8(frag), 1.0);
}
`;

/* ----- The machine, drawn once per resize and direction ----- */

/**
 * The machine around the speaker, in neutral light, premultiplied: the
 * deep-buttoned velvet chair back in its carved frame, brass rails either side,
 * the dial panel with its gauges and the counter's window, the travel lever,
 * and the platform's edge along the bottom.
 */
const MACHINE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
/** The panel's left edge, the lever's pivot, and the lever's lean (radians). */
uniform vec3 uLayout;

out vec4 outColor;
${NOISE_GLSL}

const float PI = 3.14159265;
const vec3 LIGHT = vec3(-0.42, 0.62, 0.66);

float px;
vec4 acc;

void over(vec3 col, float cov) {
  acc = vec4(col, 1.0) * cov + acc * (1.0 - cov);
}

float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}

float sdBox(vec2 p, vec2 c, vec2 h, float rr) {
  vec2 d = abs(p - c) - h + rr;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rr;
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

float sdEllipse(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  float k = length(q);
  vec2 g = q / (r * max(k, 1e-5));
  return (k - 1.0) / max(length(g), 1e-5);
}

/** Polished brass with surface normal n: the warm room above, dark below, a bright highlight. */
vec3 brass(vec3 n) {
  vec3 env = mix(vec3(0.2, 0.12, 0.04), vec3(0.98, 0.78, 0.42), smoothstep(-0.35, 0.75, n.y));
  float spec = pow(max(0.0, dot(n, normalize(LIGHT))), 28.0);
  return env * 0.85 + spec * vec3(1.0, 0.94, 0.78) * 0.8;
}

/** A tube across which s runs -1..1 along direction a (in the picture). */
vec3 tubeNormal(float s, vec2 a) {
  s = clamp(s, -1.0, 1.0);
  return normalize(vec3(a * s, sqrt(max(0.0, 1.0 - s * s))));
}

/** Polished mahogany, its grain running along direction a. */
vec3 mahogany(vec2 p, vec2 a, float s) {
  float along = dot(p, a);
  float across = dot(p, vec2(-a.y, a.x));
  float grain = vnoise(vec2(along * 12.0, across * 260.0), s) * 0.6 + vnoise(vec2(along * 3.0, across * 50.0), s + 1.0) * 0.4;
  return vec3(0.27, 0.11, 0.06) * (0.7 + 0.55 * grain);
}

float chairSd(vec2 p) {
  float body = sdBox(p, vec2(0.0, -0.4), vec2(${f(CHAIR_HALF)}, ${f(CHAIR_SHOULDER + 0.4)}), 0.0);
  return min(body, sdEllipse(p, vec2(0.0, ${f(CHAIR_SHOULDER)}), vec2(${f(CHAIR_HALF)}, ${f(CHAIR_CREST)})));
}

void chair(vec2 p) {
  float d = chairSd(p);
  if (d > px) {
    return;
  }
  vec3 col;
  if (d > -0.034) {
    // The carved frame: a rounded moulding with bead-and-reel carving along it.
    vec2 g = normalize(vec2(chairSd(p + vec2(0.001, 0.0)) - d, chairSd(p + vec2(0.0, 0.001)) - d) + 1e-6);
    float s = (d + 0.017) / 0.017;
    vec3 n = tubeNormal(s, g);
    float ang = atan(p.x, p.y + 0.25);
    float carve = 0.5 + 0.5 * sin(ang * 70.0);
    vec3 wood = mahogany(p, vec2(-g.y, g.x), 3.0) * (0.75 + 0.2 * carve * smoothstep(0.6, 0.0, abs(s)));
    float lit = 0.45 + 0.6 * max(dot(n, normalize(LIGHT)), 0.0);
    col = wood * lit + pow(max(dot(n, normalize(LIGHT)), 0.0), 20.0) * 0.25;
    // A brass bead along the inner edge.
    float bs = (d + 0.031) / 0.003;
    if (abs(bs) < 1.0) {
      col = brass(tubeNormal(bs, g));
    }
  } else {
    // Deep-buttoned velvet: puffs between buttons on a diamond lattice.
    float k = 0.085;
    vec2 q = p - vec2(0.0, 0.07);
    float u = (q.x + q.y) / k;
    float v = (q.y - q.x) / k;
    float fu = fract(u);
    float fv = fract(v);
    float hu = PI * cos(PI * fu) * sin(PI * fv);
    float hv = PI * sin(PI * fu) * cos(PI * fv);
    vec3 n = normalize(vec3(-0.3 * (hu - hv), -0.3 * (hu + hv), 1.0));
    float diff = max(dot(n, normalize(LIGHT)), 0.0);
    vec3 base = vec3(0.45, 0.04, 0.07) * (0.92 + 0.12 * vnoise(p * 500.0, 4.0));
    col = base * (0.3 + 0.8 * diff) + base * 1.6 * pow(1.0 - n.z, 1.5) * 0.5;
    float crease = smoothstep(0.1, 0.0, min(min(fu, 1.0 - fu), min(fv, 1.0 - fv)));
    col *= 1.0 - 0.55 * crease;
    // Buttons at the lattice points.
    vec2 bi = floor(vec2(u, v) + 0.5);
    vec2 b = vec2(bi.x - bi.y, bi.x + bi.y) * 0.5 * k + vec2(0.0, 0.07);
    float db = length(p - b) - 0.009;
    if (db < px) {
      vec2 bn = (p - b) / 0.009;
      vec3 bc = vec3(0.3, 0.03, 0.05) * (0.5 + 0.7 * max(0.0, dot(normalize(vec3(bn, 1.0)), normalize(LIGHT))));
      col = mix(col, bc, cover(db));
    }
    // In the frame's shadow at the edges.
    col *= 0.6 + 0.4 * smoothstep(-0.034, -0.08, d);
  }
  over(col, cover(d));
}

/** A brass tube from a to b, radius r. */
void tube(vec2 p, vec2 a, vec2 b, float r) {
  vec2 ab = b - a;
  vec2 dir = normalize(ab);
  vec2 nrm = vec2(-dir.y, dir.x);
  float d = sdSeg(p, a, b) - r;
  if (d < px) {
    over(brass(tubeNormal(dot(p - a, nrm) / r, nrm)), cover(d));
  }
}

/** A brass ball, centre c, radius r. */
void ball(vec2 p, vec2 c, float r) {
  float d = length(p - c) - r;
  if (d < px) {
    vec2 q = (p - c) / r;
    over(brass(normalize(vec3(q, sqrt(max(0.0, 1.0 - dot(q, q)))))), cover(d));
  }
}

void rails(vec2 p) {
  float sx = p.x < 0.0 ? -1.0 : 1.0;
  vec2 q = vec2(abs(p.x), p.y);
  if (q.x < 0.33) {
    return;
  }
  // Mirrored, so the left side's shading mirrors too; the highlight stays upper left.
  vec2 m = vec2(sx, 1.0);
  tube(q * m, vec2(0.5, -0.44) * m, vec2(0.5, -0.2) * m, 0.011);
  tube(q * m, vec2(0.37, -0.2) * m, vec2(0.5, -0.2) * m, 0.01);
  tube(q * m, vec2(0.37, -0.31) * m, vec2(0.5, -0.31) * m, 0.008);
  ball(q * m, vec2(0.5, -0.19) * m, 0.018);
  ball(q * m, vec2(0.37, -0.2) * m, 0.014);
  ball(q * m, vec2(0.37, -0.31) * m, 0.011);
}

/** A small round gauge, centre c, radius r, its needle at angle a from upright. */
void gauge(vec2 p, vec2 c, float r, float a) {
  float d = length(p - c) - r;
  if (d > px) {
    return;
  }
  vec2 q = p - c;
  float rr = length(q) / r;
  vec3 col;
  if (rr > 0.8) {
    float s = (rr - 0.9) / 0.1;
    col = brass(normalize(vec3(q / max(length(q), 1e-5) * s, sqrt(max(0.0, 1.0 - s * s)))));
  } else {
    col = vec3(0.9, 0.86, 0.74) * (0.85 + 0.15 * smoothstep(0.8, 0.0, rr));
    float ang = atan(q.x, q.y);
    float tick = step(0.6, rr) * step(abs(ang), 2.3) * smoothstep(0.08, 0.03, abs(fract(ang / 0.29) - 0.5));
    col = mix(col, vec3(0.1), tick);
    vec2 tip = c + 0.65 * r * vec2(sin(a), cos(a));
    float needle = sdSeg(p, c, tip) - 0.0018;
    col = mix(col, vec3(0.05, 0.03, 0.02), cover(needle));
    col = mix(col, brass(vec3(0.0, 0.3, 0.95)), step(length(q), 0.12 * r));
    // The glass's reflection.
    col += 0.12 * smoothstep(0.1, 0.0, abs(q.x + q.y + 0.4 * r) / r);
  }
  over(col, cover(d));
}

void panel(vec2 p) {
  float x0 = uLayout.x;
  vec2 c = vec2(x0 + ${f(PANEL_W / 2)}, ${f((PANEL_TOP + PANEL_BOTTOM) / 2)});
  vec2 h = vec2(${f(PANEL_W / 2)}, ${f((PANEL_TOP - PANEL_BOTTOM) / 2)});
  float d = sdBox(p, c, h, 0.012);
  if (d > px) {
    return;
  }
  vec3 col;
  if (d > -0.012) {
    float s = (d + 0.006) / 0.006;
    vec2 g = normalize(vec2(sdBox(p + vec2(0.001, 0.0), c, h, 0.012) - d, sdBox(p + vec2(0.0, 0.001), c, h, 0.012) - d) + 1e-6);
    col = brass(tubeNormal(s, g));
  } else {
    col = mahogany(p, vec2(1.0, 0.0), 7.0) * 0.95;
    // Brass screw heads in the corners.
    vec2 sc = abs(p - c) - (h - 0.022);
    float screw = length(sc) - 0.0045;
    col = mix(col, brass(vec3(0.0, 0.4, 0.9)) * 0.9, cover(screw));
  }
  over(col, cover(d));
  // The counter's window: a brass-lined recess, the drums drawn into it live.
  {
    vec2 wc = vec2(x0 + ${f(PANEL_W / 2)}, ${f((COUNTER_TOP + COUNTER_BOTTOM) / 2)});
    vec2 wh = vec2(${f(PANEL_W / 2 - COUNTER_INSET)}, ${f((COUNTER_TOP - COUNTER_BOTTOM) / 2)});
    float wd = sdBox(p, wc, wh + 0.005, 0.004);
    if (wd < px) {
      float s = (wd + 0.0025) / 0.0025;
      vec3 rim = brass(tubeNormal(-s, vec2(0.0, 1.0)));
      over(mix(vec3(0.03, 0.025, 0.02), rim, step(-0.005, wd)), cover(wd));
    }
  }
  gauge(p, vec2(x0 + 0.065, -0.298), 0.03, -0.7);
  gauge(p, vec2(x0 + 0.145, -0.298), 0.03, 0.9);
  // An engraved brass plate with a row of little lamps.
  {
    float pd = sdBox(p, vec2(x0 + 0.27, -0.298), vec2(0.075, 0.022), 0.004);
    if (pd < px) {
      vec3 col2 = brass(vec3(0.0, 0.25, 0.97)) * 0.85;
      col2 *= 1.0 - 0.35 * smoothstep(0.0015, 0.0, abs(pd + 0.006));
      for (int i = 0; i < 4; i++) {
        float ld = length(p - vec2(x0 + 0.225 + 0.03 * float(i), -0.298)) - 0.0075;
        vec3 lamp = (i == 1 ? vec3(0.9, 0.25, 0.15) : vec3(0.95, 0.7, 0.3)) * 0.8;
        col2 = mix(col2, lamp, cover(ld));
      }
      over(col2, cover(pd));
    }
  }
}

void lever(vec2 p) {
  vec2 pivot = vec2(uLayout.y, ${f(LEVER_Y)});
  // The quadrant it moves in: a brass half-disc with engraved stops.
  {
    vec2 q = p - pivot;
    float d = max(length(q) - 0.075, -q.y - 0.012);
    if (d < px) {
      float r = length(q) / 0.075;
      float ang = atan(q.x, q.y);
      vec3 col = brass(normalize(vec3(q * 2.0, 1.0))) * 0.8;
      col *= 1.0 - 0.5 * step(0.8, r) * smoothstep(0.06, 0.02, abs(fract(ang / 0.15) - 0.5)) * step(abs(ang), 1.2);
      col *= 1.0 - 0.4 * smoothstep(0.004, 0.0, abs(length(q) - 0.055));
      over(col, cover(d));
    }
  }
  float lean = uLayout.z;
  vec2 dir = vec2(sin(lean), cos(lean));
  vec2 tip = pivot + ${f(LEVER_LENGTH)} * dir;
  // The shaft: brass, with an ebony grip towards the top.
  {
    vec2 nrm = vec2(-dir.y, dir.x);
    float along = dot(p - pivot, dir) / ${f(LEVER_LENGTH)};
    float r = mix(0.011, 0.0075, clamp(along, 0.0, 1.0));
    float d = sdSeg(p, pivot, tip) - r;
    if (d < px) {
      vec3 n = tubeNormal(dot(p - pivot, nrm) / r, nrm);
      vec3 col = along > 0.62 ? vec3(0.06, 0.05, 0.05) * (0.6 + 0.8 * max(dot(n, normalize(LIGHT)), 0.0)) + pow(max(dot(n, normalize(LIGHT)), 0.0), 24.0) * 0.4 : brass(n);
      over(col, cover(d));
    }
  }
  ball(p, pivot, 0.02);
  // A crystal knob.
  {
    float r = 0.026;
    vec2 q = (p - tip - dir * 0.012) / r;
    float d = (length(q) - 1.0) * r;
    if (d < px) {
      vec3 n = normalize(vec3(q, sqrt(max(0.0, 1.0 - dot(q, q)))));
      float facet = 0.5 + 0.5 * cos(atan(q.y, q.x) * 6.0);
      vec3 col = vec3(0.62, 0.78, 0.86) * (0.45 + 0.4 * facet * n.z) + pow(max(dot(n, normalize(LIGHT)), 0.0), 40.0);
      col *= 0.6 + 0.4 * smoothstep(1.0, 0.6, length(q));
      over(col, cover(d));
    }
  }
}

void platform(vec2 p) {
  float top = -0.432;
  if (p.y > top + 0.008 + px) {
    return;
  }
  vec3 col = mahogany(p, vec2(1.0, 0.0), 9.0) * 0.8;
  float s = (p.y - top) / 0.008;
  if (abs(s) < 1.0) {
    col = brass(tubeNormal(s, vec2(0.0, 1.0)));
  }
  // Rivets along the brass edge.
  float rv = length(vec2((fract(p.x / 0.08) - 0.5) * 0.08, p.y - top)) - 0.003;
  col = mix(col, brass(vec3(0.0, 0.5, 0.86)) * 1.1, cover(rv));
  over(col, cover(p.y - top - 0.008));
}

void main() {
  px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  acc = vec4(0.0);
  chair(p);
  rails(p);
  panel(p);
  lever(p);
  platform(p);
  outColor = acc;
}
`;

/** The cached machine over the scene, in the moment's light. */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uMachine;
uniform vec3 uLight;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec4 m = texelFetch(uMachine, ivec2(gl_FragCoord.xy), 0);
  outColor = vec4(m.rgb * uLight + dither8(gl_FragCoord.xy) * m.a, m.a);
}
`;

/**
 * The brass and crystal disc, live in its own box: a polished brass rim with
 * engraved ticks and rivets, four spokes, a hub, and a crystal pane etched
 * with rays, rings and a star, all turning slowly. Premultiplied.
 */
const DISC_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
/** Centre, radius and turn. */
uniform vec4 uDisc;
uniform vec3 uLight;

out vec4 outColor;

const float PI = 3.14159265;
const float TAU = 6.2831853;
const vec3 LIGHT = vec3(-0.42, 0.62, 0.66);

float px;
vec4 acc;

void over(vec3 col, float a) {
  acc = vec4(col, 1.0) * a + acc * (1.0 - a);
}

vec3 brass(vec3 n) {
  vec3 env = mix(vec3(0.2, 0.12, 0.04), vec3(0.98, 0.78, 0.42), smoothstep(-0.35, 0.75, n.y));
  float spec = pow(max(0.0, dot(n, normalize(LIGHT))), 28.0);
  return env * 0.85 + spec * vec3(1.0, 0.94, 0.78) * 0.8;
}

/** Coverage of a line distance d of half width w. */
float line(float d, float w) {
  return clamp((w - abs(d)) / px + 0.5, 0.0, 1.0);
}

void main() {
  px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  vec2 q = p - uDisc.xy;
  float r = length(q);
  float R = uDisc.z;
  if (r > R + px) {
    outColor = vec4(0.0);
    return;
  }
  acc = vec4(0.0);
  float a = atan(q.y, q.x) - uDisc.w;
  float inner = R * 0.86;
  // The crystal pane: faintly tinted, its facets catching the light as it
  // turns, and its etching bright.
  {
    float seg = a * ${f(12 / TAU)};
    float fs = fract(seg) - 0.5;
    float facet = 0.5 + 0.5 * cos(fs * TAU);
    float ray = line(sin(fs * ${f(TAU / 12)}) * r, 0.0011);
    float ringT = r / inner * 5.0;
    float ring = line((fract(ringT + 0.5) - 0.5) * inner / 5.0, 0.0009) * step(0.6, ringT);
    float star = line(r - inner * mix(0.42, 0.7, abs(fs) * 2.0), 0.0012);
    float etch = max(max(ray * 0.7, ring), star);
    vec3 col = vec3(0.72, 0.86, 0.94) * (0.55 + 0.45 * facet) + etch * vec3(0.95, 0.99, 1.0);
    float alpha = (0.1 + 0.08 * facet + 0.5 * etch) * clamp((inner - r) / px + 0.5, 0.0, 1.0);
    over(col, alpha);
  }
  // Four spokes and the hub.
  {
    float sa = mod(a + PI * 0.25, PI * 0.5) - PI * 0.25;
    float across = sin(sa) * r;
    float w = 0.0065;
    float c = clamp((w - abs(across)) / px + 0.5, 0.0, 1.0);
    if (c > 0.0 && r < inner) {
      float spoke = a - sa + uDisc.w;
      vec2 nrm = vec2(-sin(spoke), cos(spoke));
      over(brass(normalize(vec3(nrm * clamp(across / w, -1.0, 1.0), 0.8))) * 0.9, c);
    }
    float hub = clamp((0.045 - r) / px + 0.5, 0.0, 1.0);
    if (hub > 0.0) {
      vec2 h = q / 0.045;
      vec3 col = brass(normalize(vec3(h, 1.2)));
      col *= 1.0 - 0.4 * smoothstep(0.03, 0.0, abs(length(h) - 0.55));
      over(col, hub);
    }
  }
  // The brass rim: a rounded section, engraved ticks, rivets.
  {
    float c = clamp((r - inner) / px + 0.5, 0.0, 1.0) * clamp((R - r) / px + 0.5, 0.0, 1.0);
    if (c > 0.0) {
      float s = (r - (inner + R) * 0.5) / ((R - inner) * 0.5);
      vec2 dir = q / max(r, 1e-5);
      vec3 col = brass(normalize(vec3(dir * s, sqrt(max(0.0, 1.0 - s * s)) + 0.2)));
      float tick = line(sin((fract(a * ${f(36 / TAU)}) - 0.5) * ${f(TAU / 36)}) * r, 0.0012) * step(0.15, s) * step(s, 0.8);
      col *= 1.0 - 0.45 * tick;
      float rv = fract(a * ${f(12 / TAU)} + 0.5) - 0.5;
      vec2 rp = vec2(rv * ${f(TAU / 12)} * r, r - (inner + R) * 0.5 - 0.1 * (R - inner));
      float rivet = clamp((0.0055 - length(rp)) / px + 0.5, 0.0, 1.0);
      col = mix(col, brass(normalize(vec3(rp / 0.0055, 1.0))) * 1.05, rivet);
      // The groove where the crystal meets the rim.
      col *= 1.0 - 0.5 * smoothstep(0.006, 0.0, r - inner);
      over(col, c);
    }
  }
  outColor = vec4(acc.rgb * uLight, acc.a);
}
`;

/**
 * The date counter's drums, live in their window: each drum's glyph rolls up
 * (or down, backwards) to the next, shaded round the drum, with the window
 * glass's sheen. Opaque.
 */
const COUNTER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
/** The window: left, bottom, right, top (frame heights). */
uniform vec4 uBox;
/** Each drum's glyph, the next, and how far it has rolled. */
uniform vec3 uCells[${String(COUNTER_CELLS)}];
uniform vec3 uLight;

out vec4 outColor;
${GLYPH_AT_GLSL}
${DITHER_GLSL}

void main() {
  float px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  vec2 q = (p - uBox.xy) / (uBox.zw - uBox.xy);
  float fi = clamp(q.x, 0.0, 0.9999) * ${f(COUNTER_CELLS)};
  int i = int(fi);
  float fx = fract(fi);
  vec3 cell = uCells[i];
  // Drum coordinates: screen height s shows what was at s - roll.
  float s = q.y - 0.5;
  float u = s - cell.z;
  float gx = clamp((fx - 0.08) / 0.84, 0.0, 1.0);
  float g;
  if (u < -0.5) {
    g = glyphAt(cell.y, vec2(gx, u + 1.5));
  } else if (u > 0.5) {
    g = glyphAt(cell.y, vec2(gx, u - 0.5));
  } else {
    g = glyphAt(cell.x, vec2(gx, u + 0.5));
  }
  float face = smoothstep(0.03, 0.08, fx) * smoothstep(0.97, 0.92, fx);
  vec3 drum = vec3(0.88, 0.84, 0.72);
  vec3 col = mix(drum, vec3(0.08, 0.06, 0.05), g) * (0.35 + 0.65 * cos(s * 2.6));
  col = mix(vec3(0.05, 0.04, 0.03), col, face);
  // The window glass's sheen.
  col += 0.06 * smoothstep(0.08, 0.0, abs(q.y - 0.75 + 0.3 * q.x * 0.1));
  outColor = vec4(col * uLight + dither8(gl_FragCoord.xy), 1.0);
}
`;

const SCENE_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  OUTSIDE_OPTIONS.map((o, i) => [o.value, i]),
);

interface Slot {
  albedo: RenderTarget;
  extras: RenderTarget;
  /** The bucket and scene drawn into it, or -1. */
  key: number;
}

/**
 * Victorian Time Machine. The machine is drawn once per resize (and turn of
 * the lever); the outside's colours once per week of the calendar, in two
 * slots crossfaded between. Each frame lights the outside at half size and
 * upscales it through a faint shimmer, lets snow or leaves fall in their
 * seasons, turns the disc in its box, lays the machine over it and rolls the
 * counter's drums. The day's light is capped (see `lightAt` and `slewLight`)
 * so it never strobes, however fast the days go.
 */
export const timemachine = defineEffect(timemachineMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const albedoProgram = program(FULLSCREEN_VERTEX, ALBEDO_FRAGMENT);
      const au = createUniforms(gl, albedoProgram, [
        "uResolution",
        "uScene",
        "uMode",
        "uSeason",
        "uLeaf",
        "uGrass",
        "uPlaces",
      ]);
      const outsideProgram = program(FULLSCREEN_VERTEX, OUTSIDE_FRAGMENT);
      const ou = createUniforms(gl, outsideProgram, [
        "uAlbedoA",
        "uAlbedoB",
        "uExtrasA",
        "uExtrasB",
        "uFrame",
        "uBodies",
        "uMoon",
        "uZenith",
        "uHorizon",
        "uGlow",
        "uLight",
        "uGlowStrength",
      ]);
      const blitProgram = program(FULLSCREEN_VERTEX, BLIT_FRAGMENT);
      const bu = createUniforms(gl, blitProgram, ["uOutside", "uResolution", "uShimmer"]);
      const machineProgram = program(FULLSCREEN_VERTEX, MACHINE_FRAGMENT);
      const mu = createUniforms(gl, machineProgram, ["uResolution", "uLayout"]);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, ["uMachine", "uLight"]);
      const discProgram = program(FULLSCREEN_VERTEX, DISC_FRAGMENT);
      const du = createUniforms(gl, discProgram, ["uResolution", "uDisc", "uLight"]);
      const counterProgram = program(FULLSCREEN_VERTEX, COUNTER_FRAGMENT);
      const ku = createUniforms(gl, counterProgram, [
        "uResolution",
        "uBox",
        "uCells",
        "uLight",
        "uAtlas",
        "uTile",
        "uPad",
        "uGlyphSize",
      ]);
      gl.useProgram(outsideProgram);
      ou.i1("uAlbedoA", 0);
      ou.i1("uAlbedoB", 1);
      ou.i1("uExtrasA", 2);
      ou.i1("uExtrasB", 3);
      gl.useProgram(blitProgram);
      bu.i1("uOutside", 0);
      gl.useProgram(compositeProgram);
      cu.i1("uMachine", 0);
      gl.useProgram(counterProgram);
      ku.i1("uAtlas", 0);
      gl.useProgram(null);

      const atlas = scope.add(gl.createTexture(), (t) => {
        gl.deleteTexture(t);
      });

      // Falling snow (the Snow flakes) and falling leaves (the Falling Leaves pieces).
      const flakeRenderer = scope.own(createFlakeRenderer(gl, MAX_SNOW));
      const pieceBatch = scope.own(
        createSpriteBatch(gl, MAX_LEAVES, [4, 4], SHAPES, { rotation: true }),
      );
      const pieceProgram = program(pieceVertex(pieceBatch.spinLocation), PIECE_FRAGMENT);
      const pu = createUniforms(gl, pieceProgram, ["uResolution", "uVein"]);

      let slots: Slot[] = [];
      let outside: RenderTarget | null = null;
      let machine: RenderTarget | null = null;
      const disposeTargets = () => {
        for (const s of slots) {
          s.albedo.dispose();
          s.extras.dispose();
        }
        slots = [];
        outside?.dispose();
        machine?.dispose();
        outside = machine = null;
      };
      scope.defer(disposeTargets);

      const layout = createSceneLayout();
      const journey = createJourneyTime();
      const look = createSeasonLook();
      const buckets = { first: 0, second: 0, mix: 0 };
      const target = createSkyState();
      const shown = createSkyState();
      const sun: [number, number] = [0, 0];
      const moon: [number, number] = [0, 0];
      const terminator: Terminator = { k: 0, side: 1, lit: 0 };
      const light: Rgb = [0, 0, 0];
      const flakeColour: Rgb = [0, 0, 0];
      const cells = new Float32Array(COUNTER_CELLS * 3);
      const autumn = SEASONS.autumn;
      const leafPalette: Rgb[] = autumn.palette.map((c) => [c[0], c[1], c[2]]);
      const leafSeason: Season = { ...autumn, palette: leafPalette };

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let cycles = 0;
      let discAngle = 0;
      let shimmer1 = 0;
      let shimmer2 = 0;
      let streak = 0;
      let first = true;
      let machineLean = Number.NaN;
      let atlasW = 0;
      let atlasH = 0;
      let startYear = Number.NaN;

      const flakes = createFlakes(MAX_SNOW, refWidth, 0x7173);
      const flakeFrame: FlakeFrame = {
        refWidth,
        scale: 1,
        count: 0,
        speed: SNOW_SPEED,
        wind: 0.12,
        gustiness: 0.35,
        sway: 0.5,
        size: 3.2,
        depthBlur: 0.6,
        brightness: 0.85,
      };
      const pieces = createPieces(MAX_LEAVES, refWidth, 0x1ea5);
      const pieceFrame: PieceFrame = {
        refWidth,
        scale: 1,
        season: leafSeason,
        count: 0,
        size: LEAF_SIZE,
        speed: LEAF_SPEED,
        wind: 0.15,
        gusts: 0.4,
        hazeTop: [0, 0, 0],
        hazeBottom: [0, 0, 0],
      };

      /** Draws the outside's colours for `bucket` of `scene` into `slot`. */
      const drawSlot = (slot: Slot, bucket: number, scene: number) => {
        seasonAt(bucket / SEASON_BUCKETS, look);
        gl.useProgram(albedoProgram);
        au.f2("uResolution", slot.albedo.width, slot.albedo.height);
        au.i1("uScene", scene);
        au.f3("uSeason", look.foliage, look.blossom, look.snow);
        au.v3("uLeaf", look.leaf);
        au.v3("uGrass", look.grass);
        au.f2("uPlaces", layout.treeX, layout.lampX);
        au.i1("uMode", 0);
        slot.albedo.bind();
        triangle.draw();
        au.i1("uMode", 1);
        slot.extras.bind();
        triangle.draw();
        slot.key = scene * SEASON_BUCKETS + bucket;
      };

      /** The slot holding `bucket` of `scene`, drawing it into the slot not holding `keep` if needed. */
      const slotFor = (bucket: number, scene: number, keep: number) => {
        const key = scene * SEASON_BUCKETS + bucket;
        for (const s of slots) {
          if (s.key === key) {
            return s;
          }
        }
        const free = slots[0].key === keep ? slots[1] : slots[0];
        drawSlot(free, bucket, scene);
        return free;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          const newRefWidth = width / scale;
          flakes.rescaleX(newRefWidth / refWidth);
          pieces.rescaleX(newRefWidth / refWidth);
          refWidth = flakeFrame.refWidth = pieceFrame.refWidth = newRefWidth;
          flakeFrame.scale = pieceFrame.scale = scale;
          disposeTargets();
          const lw = lowResSize(width, OUTSIDE_DIVISOR);
          const lh = lowResSize(height, OUTSIDE_DIVISOR);
          for (let i = 0; i < 2; i++) {
            const albedo = createRenderTarget(gl, lw, lh, gl.RGBA8);
            const extras = createRenderTarget(gl, lw, lh, gl.RGBA8);
            if (albedo && extras) {
              slots.push({ albedo, extras, key: -1 });
            } else {
              albedo?.dispose();
              extras?.dispose();
            }
          }
          outside = createRenderTarget(gl, lw, lh, gl.RGBA8);
          machine = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          sceneLayout(width / height, layout);
          machineLean = Number.NaN;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          if (!outside || !machine || slots.length < 2) {
            return;
          }
          const speed = daySeconds(p.speed);
          const sign = directionSign(p.direction);
          const year = Math.round(clamp(Number.isFinite(p.year) ? p.year : 1887, 1, 9999));
          if (year !== startYear) {
            // A new starting year sets off again from its 1 March.
            startYear = year;
            cycles = 0;
          }

          // 1. Time, light and season.
          cycles = advanceCycles(cycles, step, speed, p.direction);
          journeyAt(cycles, startYear, journey);
          lightAt(journey.dayPhase, speed, target);
          if (first) {
            copySky(target, shown);
            streak = 1 - lightSwing(speed);
            first = false;
          } else {
            slewLight(shown, target, step);
          }
          // The streak fades in and out no faster than the light.
          const streakTarget = 1 - lightSwing(speed);
          streak += clamp(streakTarget - streak, -0.6 * step, 0.6 * step);
          const night = nightFrom(shown);
          seasonAt(journey.yearFraction, look);
          bodyAt(journey.dayPhase, false, sun);
          bodyAt(journey.dayPhase, true, moon);
          moonTerminator(
            lunarPhase((journey.dayNumber + journey.dayFraction) * 86400000),
            terminator,
          );
          discAngle = (discAngle + sign * discRate(speed) * step) % TAU;
          shimmer1 = (shimmer1 + SHIMMER_RATES[0] * step) % TAU;
          shimmer2 = (shimmer2 + SHIMMER_RATES[1] * step) % TAU;
          for (let k = 0; k < 3; k++) {
            light[k] = INTERIOR[k] + DAYLIGHT_SHARE * shown.light[k];
          }

          // 2. The machine, when the lever moves.
          const lean = sign * LEVER_LEAN;
          if (lean !== machineLean) {
            machineLean = lean;
            gl.useProgram(machineProgram);
            mu.f2("uResolution", width, height);
            mu.f3("uLayout", layout.panelX, layout.leverX, lean);
            machine.bind();
            triangle.draw();
          }

          // 3. This week's and next week's colours outside.
          const scene = SCENE_INDEX[p.scene] ?? 0;
          seasonBuckets(journey.yearFraction, buckets);
          const keyA = scene * SEASON_BUCKETS + buckets.first;
          const keyB = scene * SEASON_BUCKETS + buckets.second;
          const slotA = slotFor(buckets.first, scene, keyB);
          const slotB = slotFor(buckets.second, scene, keyA);

          // 4. The outside, lit.
          outside.bind();
          gl.useProgram(outsideProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, slotA.albedo.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, slotB.albedo.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, slotA.extras.texture);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, slotB.extras.texture);
          ou.f4("uFrame", 1 / outside.height, 0, buckets.mix, night);
          ou.f4("uBodies", sun[0], sun[1], moon[0], moon[1]);
          ou.f4("uMoon", terminator.k, terminator.side, 0.35, streak);
          ou.v3("uZenith", shown.zenith);
          ou.v3("uHorizon", shown.horizon);
          ou.v3("uGlow", shown.glow);
          ou.v3("uLight", shown.light);
          ou.f1("uGlowStrength", shown.glowStrength);
          triangle.draw();

          // 5. Upscaled through the shimmer.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(blitProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, outside.texture);
          bu.f2("uResolution", width, height);
          bu.f4(
            "uShimmer",
            (SHIMMER_PX * scale) / width,
            (SHIMMER_PX * scale) / height,
            shimmer1,
            shimmer2,
          );
          triangle.draw();

          // 6. Snow and leaves in their seasons, rising when running backwards.
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          const glow = 0.25 + 0.75 * (1 - night);
          flakeFrame.count = Math.round(look.snowfall * MAX_SNOW);
          flakeFrame.speed = sign * SNOW_SPEED;
          flakeFrame.wind = sign * 0.12;
          const nFlakes = flakes.step(step, flakeFrame, flakeRenderer.data, flakeRenderer.stride);
          if (nFlakes > 0) {
            flakeRenderer.upload(nFlakes);
            for (let k = 0; k < 3; k++) {
              flakeColour[k] = SNOW_COLOUR[k] * glow;
            }
            flakeRenderer.draw(0, nFlakes, width, height, flakeColour);
          }
          for (let i = 0; i < leafPalette.length; i++) {
            for (let k = 0; k < 3; k++) {
              leafPalette[i][k] = autumn.palette[i][k] * glow;
            }
          }
          for (let k = 0; k < 3; k++) {
            pieceFrame.hazeTop[k] = shown.zenith[k];
            pieceFrame.hazeBottom[k] = shown.horizon[k];
          }
          pieceFrame.count = Math.round(look.leaffall * MAX_LEAVES);
          pieceFrame.speed = sign * LEAF_SPEED;
          pieceFrame.wind = sign * 0.15;
          const nPieces = pieces.step(step, pieceFrame, pieceBatch.data, pieceBatch.stride);
          if (nPieces > 0) {
            pieceBatch.upload(nPieces);
            gl.useProgram(pieceProgram);
            pu.f2("uResolution", width, height);
            pu.f1("uVein", 1);
            for (let g = 0; g < pieces.groups; g++) {
              pieceBatch.draw(pieces.groupFirst[g], pieces.groupCount[g], pieces.groupShape[g]);
            }
          }

          // 7. The disc, in its box.
          const discLeft = Math.max(
            0,
            Math.floor((layout.discX - DISC_R) * height + width / 2) - 1,
          );
          const discBottom = Math.max(0, Math.floor((DISC_Y - DISC_R) * height + height / 2) - 1);
          const discSize = Math.ceil(2 * DISC_R * height) + 2;
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(discLeft, discBottom, discSize, discSize);
          gl.useProgram(discProgram);
          du.f2("uResolution", width, height);
          du.f4("uDisc", layout.discX, DISC_Y, DISC_R, discAngle);
          du.v3("uLight", light);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);

          // 8. The machine over it all.
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, machine.texture);
          cu.v3("uLight", light);
          triangle.draw();
          gl.disable(gl.BLEND);

          // 9. The counter's drums in their window.
          const x0 = layout.panelX + COUNTER_INSET;
          const x1 = layout.panelX + PANEL_W - COUNTER_INSET;
          const cw = Math.max(4, Math.round(((x1 - x0) / COUNTER_CELLS) * 0.84 * height));
          const ch = Math.max(4, Math.round((COUNTER_TOP - COUNTER_BOTTOM) * height));
          gl.useProgram(counterProgram);
          if (cw !== atlasW || ch !== atlasH) {
            atlasW = cw;
            atlasH = ch;
            const m = drawGlyphAtlas(gl, atlas, cw, ch);
            ku.f2("uTile", m.tile[0], m.tile[1]);
            ku.f2("uPad", m.pad[0], m.pad[1]);
            ku.f2("uGlyphSize", m.glyph[0], m.glyph[1]);
          }
          counterDrums(journey, speed, p.direction, cells);
          const left = Math.floor(x0 * height + width / 2);
          const bottom = Math.floor(COUNTER_BOTTOM * height + height / 2);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(
            Math.max(0, left),
            Math.max(0, bottom),
            Math.ceil((x1 - x0) * height) + 1,
            Math.ceil((COUNTER_TOP - COUNTER_BOTTOM) * height) + 1,
          );
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, atlas);
          ku.f2("uResolution", width, height);
          ku.f4("uBox", x0, COUNTER_BOTTOM, x1, COUNTER_TOP);
          gl.uniform3fv(ku.loc.uCells, cells);
          ku.v3("uLight", light);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
