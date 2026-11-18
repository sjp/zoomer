import { createCountFade, createCrossfadeSlots } from "../fade";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  scopedProgram,
  withScope,
} from "../gl";
import { HASH32_GLSL, VALUE_NOISE_GLSL } from "../noise";
import { SDF2D_GLSL } from "../sdf-glsl";
import { createShotSchedule, restartShots, screenFlicker, stepShots } from "../shot-schedule";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import {
  BACK_FLOOR,
  BACK_Z,
  BEAM_APEX,
  BEAM_DIR,
  BEAM_EDGE,
  BEAM_FALLOFF,
  BEAM_NORMAL,
  BEAM_R0,
  BEAM_SOFT,
  BEAM_SPREAD,
  BEAM_START,
  BOOTH_H,
  BOOTH_HALF,
  BOOTH_X,
  CURTAIN_BUNCH,
  CURTAIN_FOLDS,
  CURTAIN_OUTER,
  CURTAIN_OVERLAP,
  CURTAIN_TRAVEL,
  AISLE_IN,
  AISLE_OUT,
  CAMERA_H,
  CEILING,
  cinemaFit,
  createShow,
  CROSSFADE_SECONDS,
  FILM_PALETTES,
  FOCAL,
  HORIZON_Y,
  LEG_IN,
  MAX_MOTES,
  MOTE_FLOATS,
  moteCount,
  ROW_DEPTH,
  ROW_RISE,
  ROW_Z0,
  ROWS,
  SEAT_EDGE,
  SEAT_PITCH,
  SEAT_TOP,
  stepShow,
  toFilm,
  toView,
  type View,
  WALL_X,
  writeMote,
} from "./cinema-sim";
import { cinemaMeta } from "./cinema.meta";

const g = glslFloat;

/** The beam's haze renders at 1/n of the frame's size. */
const BEAM_DIVISOR = 4;
/** The beam's layer stores its brightness scaled by this, leaving headroom for the haze. */
const BEAM_STORE = 0.7;
/** Seconds the GPU's clock loops over: every slow motion in the shaders repeats exactly in it. */
const LOOP_SECONDS = 600;
/** Seconds a dust count change fades motes in. */
const MOTE_FADE_IN = 1.5;

/** Brightness of the beam's haze, the lens's glow and the motes per unit of film light. */
const BEAM_GAIN = 1.5;
const MOTE_GAIN = 1.6;

/**
 * Constants every pass shares: the room facing the projector (in metres), the
 * screen, curtains and stage facing the screen (in design units), and how the
 * cached rooms encode their light in alpha.
 *
 * A cache texel holds the room under the house lights in rgb, and in alpha how
 * it behaves as they dim: 0.5 is an ordinary surface, above 0.5 it glows on
 * its own (an exit sign keeps its light; 1 keeps it all), and below 0.5 it
 * catches the film's light (0 catches it all).
 */
const SHARED_GLSL = /* glsl */ `
${SDF2D_GLSL}
const float FOCAL = ${g(FOCAL)};
const float HORIZON_Y = ${g(HORIZON_Y)};
const float CAMERA_H = ${g(CAMERA_H)};
const int ROWS = ${String(ROWS)};
const float ROW_Z0 = ${g(ROW_Z0)};
const float ROW_DEPTH = ${g(ROW_DEPTH)};
const float ROW_RISE = ${g(ROW_RISE)};
const float SEAT_TOP = ${g(SEAT_TOP)};
const float SEAT_PITCH = ${g(SEAT_PITCH)};
const float AISLE_IN = ${g(AISLE_IN)};
const float AISLE_OUT = ${g(AISLE_OUT)};
const float SEAT_EDGE = ${g(SEAT_EDGE)};
const float WALL_X = ${g(WALL_X)};
const float BACK_Z = ${g(BACK_Z)};
const float BACK_FLOOR = ${g(BACK_FLOOR)};
const float CEILING = ${g(CEILING)};
const vec2 BOOTH = vec2(${g(BOOTH_X)}, ${g(BOOTH_H)});
const vec2 BOOTH_HALF = vec2(${g(BOOTH_HALF[0])}, ${g(BOOTH_HALF[1])});
const vec2 APEX = vec2(${g(BEAM_APEX[0])}, ${g(BEAM_APEX[1])});
const vec2 BEAM_DIR = vec2(${g(BEAM_DIR[0])}, ${g(BEAM_DIR[1])});
const vec2 BEAM_NORMAL = vec2(${g(BEAM_NORMAL[0])}, ${g(BEAM_NORMAL[1])});
/** The screen behind the camera when facing the projector: its centre (m). */
const vec3 SCREEN_POS = vec3(0.0, 4.6, -13.0);

/** Facing the screen: the screen's half width, top and bottom, the curtains and the stage (design units). */
const float SCR_HW = 0.6;
const float SCR_TOP = 0.39;
const float SCR_BOT = -0.13;
const float LEG_IN = ${g(LEG_IN)};
const float LEG_OUT = 0.79;
const float VALANCE = 0.425;
const float STAGE_Y = -0.2;
const float STAGE_LIP = -0.232;
const float STAGE_FOOT = -0.33;
const float CURTAIN_OUTER = ${g(CURTAIN_OUTER)};
const float CURTAIN_TRAVEL = ${g(CURTAIN_TRAVEL)};
const float CURTAIN_OVERLAP = ${g(CURTAIN_OVERLAP)};
const float CURTAIN_WIDTH = ${g(CURTAIN_OUTER + CURTAIN_OVERLAP)};
const float FOLDS = ${g(CURTAIN_FOLDS)};
const float BUNCH = ${g(CURTAIN_BUNCH)};
const vec3 CURTAIN = vec3(0.5, 0.05, 0.075);
const vec3 WARM = vec3(1.0, 0.72, 0.42);

float pack(float glow, float film) {
  return clamp(0.5 + 0.5 * glow - 0.5 * film, 0.0, 1.0);
}
`;

/** The sample offsets (in pixels) the room caches average over: a rotated grid. */
const SUPERSAMPLE_GLSL = /* glsl */ `
const vec2 SS[4] = vec2[4](vec2(0.125, 0.375), vec2(-0.375, 0.125), vec2(-0.125, -0.375), vec2(0.375, -0.125));
`;

/**
 * The auditorium facing the projector, into its cache: the speaker's row and
 * the rows of seats climbing behind it to the back wall, the aisles' steps
 * with their lights, the side walls with sconces, the ceiling's downlights,
 * and on the back wall the booth's ports and an exit door with its sign.
 */
const PROJECTOR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uFit;
uniform vec3 uSeat;
out vec4 outColor;
${HASH32_GLSL}
${SHARED_GLSL}
${SUPERSAMPLE_GLSL}
float rnd(float a, float b) {
  uvec2 u = uvec2(ivec2(floor(vec2(a, b))) + 4096);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y + 0x632be5abu))) / 4294967296.0;
}
/** How much of the screen's light reaches a point at p with normal n (about 1 for the middle rows). */
float receive(vec3 p, vec3 n) {
  vec3 l = SCREEN_POS - p;
  float d = length(l);
  return max(dot(n, l / d), 0.0) * 300.0 / (d * d);
}
/** How much of the screen's light gets past the seat tops of the row in front of row r. */
float rowShadow(vec3 p, float r) {
  if (r < 0.5) {
    return 1.0;
  }
  float zf = ROW_Z0 + (r - 1.0) * ROW_DEPTH;
  float top = (r - 1.0) * ROW_RISE + SEAT_TOP;
  float h = p.y + (SCREEN_POS.y - p.y) * (p.z - zf) / (p.z - SCREEN_POS.z);
  return smoothstep(-0.12, 0.2, h - top);
}
/** 1 where a row has seats at |x| = ax (m), anti-aliased over w. */
float seatsAt(float ax, float w) {
  float middle = clamp((AISLE_IN - ax) / w + 0.5, 0.0, 1.0);
  float outer = clamp((ax - AISLE_OUT) / w + 0.5, 0.0, 1.0) * clamp((SEAT_EDGE - ax) / w + 0.5, 0.0, 1.0);
  return middle + outer;
}
float floorAt(float z) {
  return clamp(floor((z - ROW_Z0) / ROW_DEPTH + 0.5) + 1.0, 0.0, float(ROWS)) * ROW_RISE;
}
/** A sconce on a wall at local (u, v) metres from its fixture: the warm wash it throws, and its shell. */
void sconce(vec2 q, inout vec3 col, inout float glow) {
  float wash = exp(-(q.x * q.x) / 0.22 - (q.y * q.y) / 0.9) + 0.6 * exp(-(q.x * q.x) / 0.05 - (q.y - 0.35) * (q.y - 0.35) / 0.12);
  col += WARM * 0.38 * wash;
  float shell = sdBox(q - vec2(0.0, -0.04), vec2(0.16, 0.1), 0.09);
  float c = clamp(0.5 - shell / px, 0.0, 1.0);
  vec3 lamp = mix(vec3(1.0, 0.86, 0.62), vec3(0.95, 0.62, 0.32), smoothstep(-0.1, 0.06, q.y));
  col = mix(col, lamp, c);
  glow = max(glow, 0.32 * c);
}
/** One stroke of the exit sign's letters, in its local units. */
float stroke(vec2 p, vec2 a, vec2 b) {
  return sdSeg(p, a, b) - 0.022;
}
float exitLetters(vec2 p) {
  float d = 1e9;
  // E
  d = min(d, stroke(p, vec2(-0.21, -0.07), vec2(-0.21, 0.07)));
  d = min(d, stroke(p, vec2(-0.21, 0.07), vec2(-0.14, 0.07)));
  d = min(d, stroke(p, vec2(-0.21, 0.0), vec2(-0.15, 0.0)));
  d = min(d, stroke(p, vec2(-0.21, -0.07), vec2(-0.14, -0.07)));
  // X
  d = min(d, stroke(p, vec2(-0.09, -0.07), vec2(0.0, 0.07)));
  d = min(d, stroke(p, vec2(-0.09, 0.07), vec2(0.0, -0.07)));
  // I
  d = min(d, stroke(p, vec2(0.06, -0.07), vec2(0.06, 0.07)));
  // T
  d = min(d, stroke(p, vec2(0.12, 0.07), vec2(0.22, 0.07)));
  d = min(d, stroke(p, vec2(0.17, 0.07), vec2(0.17, -0.07)));
  return d;
}
/** The back wall at (x, h) metres. */
void backWall(vec2 q, float pxm, inout vec3 col, inout float glow, inout float film) {
  float seam = abs(fract(q.x / 1.4 + 0.5) - 0.5) * 1.4;
  col = vec3(0.21, 0.085, 0.09) * (0.82 + 0.18 * smoothstep(0.0, 0.03, seam));
  col *= 1.0 - 0.35 * smoothstep(BACK_FLOOR + 1.5, CEILING, q.y);
  // A dark wooden dado along the cross-aisle.
  col = mix(col, vec3(0.11, 0.06, 0.04), step(q.y, BACK_FLOOR + 1.05));
  film = 0.8;
  sconce(q - vec2(-1.55, BACK_FLOOR + 2.0), col, glow);
  sconce(q - vec2(1.55, BACK_FLOOR + 2.0), col, glow);
  // The booth's ports: the projector's, and a smaller one to watch through.
  for (int i = 0; i < 2; i++) {
    vec2 c = i == 0 ? BOOTH : vec2(BOOTH.x - 0.95, BOOTH.y + 0.04);
    vec2 hs = i == 0 ? BOOTH_HALF : vec2(0.22, 0.17);
    float frame = sdBox(q - c, hs + 0.05, 0.03);
    float pane = sdBox(q - c, hs, 0.02);
    float cf = clamp(0.5 - frame / pxm, 0.0, 1.0);
    float cp = clamp(0.5 - pane / pxm, 0.0, 1.0);
    col = mix(col, vec3(0.05, 0.045, 0.045), cf);
    film = mix(film, 0.1, cf);
    vec2 l = (q - c) / hs;
    vec3 inside = vec3(0.3, 0.22, 0.14) * (0.55 + 0.45 * smoothstep(1.0, -0.6, l.y)) * (i == 0 ? 1.0 : 0.6);
    // A pale streak of reflection across the glass.
    inside += vec3(0.08) * smoothstep(0.12, 0.0, abs(l.x + l.y * 0.6 - 0.25));
    col = mix(col, inside, cp);
    glow = mix(glow, 0.75, cp);
    film = mix(film, 0.0, cp);
  }
  // The projector's lens, dark until the beam lights it.
  float lens = length(q - (BOOTH + vec2(-0.1, -0.04))) - 0.085;
  float cl = clamp(0.5 - lens / pxm, 0.0, 1.0);
  col = mix(col, vec3(0.02), cl);
  glow = mix(glow, 1.0, cl);
  // The exit door in the far left corner, and its sign.
  vec2 door = q - vec2(-2.48, BACK_FLOOR + 1.05);
  float cd = clamp(0.5 - sdBox(door, vec2(0.47, 1.05), 0.01) / pxm, 0.0, 1.0);
  vec3 doorCol = vec3(0.09, 0.06, 0.055) * (0.85 + 0.15 * step(0.0, door.x));
  doorCol = mix(doorCol, vec3(0.03), clamp(0.5 - (abs(door.x) - 0.008) / pxm, 0.0, 1.0));
  doorCol = mix(doorCol, vec3(0.22, 0.2, 0.18), clamp(0.5 - sdBox(door - vec2(0.0, 0.05), vec2(0.38, 0.025), 0.02) / pxm, 0.0, 1.0));
  col = mix(col, doorCol, cd);
  vec2 sp = q - vec2(-2.48, BACK_FLOOR + 2.38);
  float halo = exp(-dot(sp * vec2(0.9, 1.6), sp * vec2(0.9, 1.6)) / 0.18);
  col += vec3(0.05, 0.5, 0.18) * 0.32 * halo;
  glow = max(glow, 0.55 * halo);
  float box = sdBox(sp, vec2(0.3, 0.12), 0.02);
  float cb = clamp(0.5 - box / pxm, 0.0, 1.0);
  float letters = clamp(0.5 - exitLetters(sp) / pxm, 0.0, 1.0);
  vec3 sign = mix(vec3(0.03, 0.2, 0.08), vec3(0.55, 1.0, 0.62), letters);
  col = mix(col, sign, cb);
  glow = mix(glow, 1.0, cb);
  film = mix(film, 0.0, cb);
}
/** A side wall at (z, h) metres; side is -1 on the left. */
void sideWall(vec2 q, float side, inout vec3 col, inout float glow, inout float film) {
  float rib = abs(fract(q.x / 1.5) - 0.5) * 1.5;
  col = vec3(0.17, 0.07, 0.075) * (0.78 + 0.22 * smoothstep(0.02, 0.08, rib));
  float base = floorAt(q.x);
  col *= 1.0 - 0.4 * smoothstep(base + 1.5, CEILING, q.y);
  col = mix(col, vec3(0.03, 0.02, 0.02), step(q.y, base));
  film = 0.7;
  for (int i = 0; i < 2; i++) {
    float z = i == 0 ? 3.4 : 6.2;
    sconce(vec2(-side * (q.x - z), q.y - floorAt(z) - 2.25), col, glow);
  }
}
/** The ceiling at (x, z) metres, with its downlights. */
void ceilingAt(vec2 q, float pxm, inout vec3 col, inout float glow, inout float film) {
  col = vec3(0.055, 0.05, 0.06) * (0.9 + 0.1 * step(0.5, fract(q.y / 1.2)));
  film = 0.85;
  vec2 cell = vec2(fract(q.x / 2.2 + 0.5) - 0.5, fract(q.y / 2.6) - 0.5) * vec2(2.2, 2.6);
  float d = length(cell * vec2(1.0, 2.2)) - 0.12;
  col += WARM * 0.35 * exp(-dot(cell, cell) / 0.25);
  col = mix(col, vec3(1.0, 0.9, 0.7), clamp(0.5 - d / pxm, 0.0, 1.0));
}

/** The room under the house lights (rgb) and its packed light behaviour (a), at design point f. */
vec4 scene(vec2 f) {
  vec3 dir = vec3(f.x / FOCAL, (f.y - HORIZON_Y) / FOCAL, 1.0);
  float zSide = abs(dir.x) > 1e-4 ? WALL_X / abs(dir.x) : 1e9;
  float zCeil = dir.y > 1e-4 ? (CEILING - CAMERA_H) / dir.y : 1e9;
  float z = min(BACK_Z, min(zSide, zCeil));
  vec3 p = vec3(dir.x * z, CAMERA_H + dir.y * z, z);
  float pxm = px * z / FOCAL;
  vec3 col;
  float glow = 0.0;
  float film = 0.0;
  if (z == BACK_Z) {
    backWall(p.xy, pxm, col, glow, film);
    film *= receive(p, vec3(0.0, 0.0, -1.0)) * rowShadow(p, float(ROWS) + 0.6);
  } else if (z == zSide) {
    float side = sign(dir.x);
    sideWall(vec2(p.z, p.y), side, col, glow, film);
    film *= receive(p, vec3(-side, 0.0, 0.0));
  } else {
    ceilingAt(p.xz, pxm, col, glow, film);
    film *= receive(p, vec3(0.0, -1.0, 0.0));
  }
  // Farther surfaces sit in more of the dark.
  col *= 1.0 - 0.25 * smoothstep(3.0, BACK_Z, z);
  float enc = pack(glow, film);

  // The rows, back to front, each over what's behind it.
  for (int ri = ROWS; ri >= 0; ri--) {
    float r = float(ri);
    float zr = ROW_Z0 + r * ROW_DEPTH;
    float hr = r * ROW_RISE;
    // The aisles' steps: this row's riser, or the tread in front of it.
    float zp = zr - 0.5 * ROW_DEPTH;
    float xp = dir.x * zp;
    float hp = CAMERA_H + dir.y * zp;
    float pxp = px * zp / FOCAL;
    float apx = abs(xp);
    float inAisle = (1.0 - seatsAt(apx, pxp)) * clamp((WALL_X - apx) / pxp + 0.5, 0.0, 1.0);
    float cs = clamp((hr - hp) / pxp + 0.5, 0.0, 1.0) * inAisle;
    if (cs > 0.0) {
      vec3 sc;
      float sg = 0.0;
      float sf;
      if (hp > hr - ROW_RISE) {
        sc = vec3(0.1, 0.05, 0.05) * (0.8 + 0.2 * rnd(hp * 40.0, xp * 9.0));
        // A brass nosing along the step's edge, and step lights on its riser at the aisles' sides.
        sc = mix(sc, vec3(0.32, 0.24, 0.13), clamp((hp - hr + 0.035) / pxp + 0.5, 0.0, 1.0));
        float lx = min(abs(apx - AISLE_IN - 0.16), abs(apx - AISLE_OUT + 0.16));
        vec2 lq = vec2(lx, hp - hr + 0.08);
        float light = sdBox(lq, vec2(0.09, 0.025), 0.018);
        float cl = clamp(0.5 - light / pxp, 0.0, 1.0);
        float pool = exp(-dot(lq, lq) / 0.012);
        sc += vec3(1.0, 0.6, 0.25) * 0.25 * pool;
        sc = mix(sc, vec3(1.0, 0.74, 0.4), cl);
        sg = max(cl, 0.7 * pool);
        sf = receive(vec3(xp, hp, zp), vec3(0.0, 0.0, -1.0)) * 0.6 * rowShadow(vec3(xp, hp, zp), r);
      } else {
        sc = vec3(0.12, 0.06, 0.055);
        sf = 0.35;
      }
      sc *= 1.0 - 0.25 * smoothstep(3.0, BACK_Z, zp);
      col = mix(col, sc, cs);
      enc = mix(enc, pack(sg, sf), cs);
    }
    if (ri == ROWS) {
      continue;
    }
    // The seats, in the plane of their backs' fronts.
    float x = dir.x * zr;
    float u = CAMERA_H + dir.y * zr - hr;
    float pxs = px * zr / FOCAL;
    float ax = abs(x);
    // Seats count from the middle in the middle block, and from the aisle in the outer ones.
    float outer = step(0.5 * (AISLE_IN + AISLE_OUT), ax);
    float xb = outer > 0.5 ? ax - AISLE_OUT - 0.5 * SEAT_PITCH : x;
    float k = floor(xb / SEAT_PITCH + 0.5) + outer * sign(x) * 50.0;
    float lx = xb - floor(xb / SEAT_PITCH + 0.5) * SEAT_PITCH;
    vec3 sp = vec3(x, u + hr, zr);
    float inRow = seatsAt(ax, pxs);
    float dBack = sdBox(vec2(lx, u - 0.7), vec2(0.235, 0.28), 0.085);
    float dCush = sdBox(vec2(lx, u - 0.39), vec2(0.245, 0.065), 0.04);
    float dArm = sdBox(vec2(abs(lx) - 0.5 * SEAT_PITCH, u - 0.31), vec2(0.035, 0.33), 0.025);
    float dUnder = u - 0.34;
    float cBack = clamp(0.5 - dBack / pxs, 0.0, 1.0) * inRow;
    float cCush = clamp(0.5 - dCush / pxs, 0.0, 1.0) * inRow;
    float cArm = clamp(0.5 - dArm / pxs, 0.0, 1.0) * inRow;
    float cUnder = clamp(0.5 - dUnder / pxs, 0.0, 1.0) * inRow;
    float rowDark = 1.0 - 0.25 * smoothstep(3.0, BACK_Z, zr);
    // The dark under the seats.
    col = mix(col, vec3(0.02, 0.012, 0.012), cUnder);
    enc = mix(enc, pack(0.0, 0.05), cUnder);
    // Armrests between the seats.
    vec3 arm = vec3(0.07, 0.05, 0.04) + vec3(0.12, 0.09, 0.06) * smoothstep(0.58, 0.635, u);
    col = mix(col, arm * rowDark, cArm);
    enc = mix(enc, pack(0.0, 0.3 * receive(sp, vec3(0.0, 0.3, -1.0)) * rowShadow(sp, r)), cArm);
    // The cushion, folded down.
    float tone = 0.86 + 0.28 * rnd(r * 31.0 + 7.0, k);
    vec3 cush = uSeat * tone * (0.62 + 0.3 * smoothstep(0.33, 0.44, u));
    col = mix(col, cush * rowDark, cCush * (1.0 - cBack));
    enc = mix(enc, pack(0.0, 0.7 * receive(sp, vec3(0.0, 0.8, -0.6)) * rowShadow(sp, r)), cCush * (1.0 - cBack));
    // The back: velvet in three stitched channels, a rolled top, worn at its edges.
    float v = clamp((u - 0.42) / (SEAT_TOP - 0.42), 0.0, 1.0);
    float shade = 0.84 + 0.16 * (0.5 + 0.5 * cos(lx / 0.235 * 3.0 * 3.14159265));
    shade *= mix(0.5, 1.0, smoothstep(0.0, 0.45, v)) * (1.0 + 0.32 * smoothstep(0.72, 0.95, v));
    vec3 back = uSeat * tone * shade;
    float rim = (1.0 - smoothstep(0.0, 0.04, -dBack)) * smoothstep(0.45, 0.85, v);
    float lum = dot(uSeat, vec3(0.3, 0.55, 0.15));
    vec3 worn = mix(uSeat, vec3(lum) * 1.25 + vec3(0.06, 0.05, 0.05), 0.5);
    float rub = smoothstep(0.55, 1.0, rnd(r * 13.0 + 3.0, k + 40.0)) * exp(-(lx * lx) / 0.006 - (v - 0.8) * (v - 0.8) / 0.02);
    back = mix(back, worn * tone, clamp(0.55 * rim + 0.5 * rub, 0.0, 1.0));
    col = mix(col, back * rowDark, cBack);
    float backFilm = receive(sp, normalize(vec3(0.0, 0.25, -1.0))) * rowShadow(sp, r);
    enc = mix(enc, pack(0.0, backFilm), cBack);
    // The rows' ends, wooden panels along the aisles.
    float ex = min(abs(ax - AISLE_IN + 0.04), min(abs(ax - AISLE_OUT - 0.04), abs(ax - SEAT_EDGE + 0.04)));
    float dEnd = sdBox(vec2(ex, u - 0.4), vec2(0.04, 0.4), 0.03);
    float cEnd = clamp(0.5 - dEnd / pxs, 0.0, 1.0);
    vec3 endCol = vec3(0.13, 0.075, 0.05) * (0.8 + 0.4 * smoothstep(0.7, 0.8, u)) * rowDark;
    col = mix(col, endCol, cEnd);
    enc = mix(enc, pack(0.0, 0.3 * rowShadow(sp, r)), cEnd);
  }
  return vec4(col, enc);
}

void main() {
  vec4 acc = vec4(0.0);
  px = 1.0 / (uRes.y * uFit);
  for (int i = 0; i < 4; i++) {
    vec2 frag = gl_FragCoord.xy + SS[i];
    acc += scene((frag - 0.5 * uRes) * px);
  }
  outColor = acc * 0.25;
}
`;

/**
 * The auditorium facing the screen, into its cache: the screen in its black
 * masking, the curtains' fixed legs and swagged valance, the stage's edge,
 * the walls with sconces either side, and the tops of the seats in front.
 * The travelling curtains, which part, are drawn each frame over it.
 */
const SCREEN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uFit;
uniform vec3 uSeat;
out vec4 outColor;
${HASH32_GLSL}
${SHARED_GLSL}
${SUPERSAMPLE_GLSL}
float rnd(float a, float b) {
  uvec2 u = uvec2(ivec2(floor(vec2(a, b))) + 4096);
  return float(hash32(u.x * 0x9e3779b1u ^ hash32(u.y + 0x632be5abu))) / 4294967296.0;
}
float cov(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}
/** The bottom of the valance's swags at x. */
float valanceAt(float x) {
  return VALANCE - 0.028 * sin(fract(x / 0.27) * 3.14159265);
}
vec4 scene(vec2 f) {
  float ax = abs(f.x);
  // The walls: fabric between ribs, darker towards the top, with sconces.
  float rib = abs(fract(ax / 0.24) - 0.5) * 0.24;
  vec3 col = vec3(0.16, 0.065, 0.07) * (0.8 + 0.2 * smoothstep(0.004, 0.02, rib));
  col *= 1.0 - 0.35 * smoothstep(0.0, 0.5, f.y);
  float glow = 0.0;
  float film = 0.12 * smoothstep(1.3, 0.6, ax);
  for (int i = 0; i < 2; i++) {
    vec2 q = vec2(ax - (i == 0 ? 0.87 : 1.15), f.y - 0.1);
    float wash = exp(-(q.x * q.x) / 0.0025 - (q.y * q.y) / 0.03) + 0.5 * exp(-(q.x * q.x) / 0.0008 - (q.y - 0.07) * (q.y - 0.07) / 0.006);
    col += WARM * 0.36 * wash;
    float c = cov(sdBox(q - vec2(0.0, -0.005), vec2(0.024, 0.016), 0.014));
    col = mix(col, mix(vec3(1.0, 0.86, 0.62), vec3(0.95, 0.62, 0.32), smoothstep(-0.02, 0.01, q.y)), c);
    glow = max(glow, 0.32 * c);
  }
  // Behind the curtains: black masking around the screen.
  float cWall = cov(ax - LEG_IN - 0.02) * cov(f.y - VALANCE - 0.05) * cov(STAGE_Y - f.y);
  col = mix(col, vec3(0.012), cWall);
  film = mix(film, 0.05, cWall);
  // The screen: a matte white sheet, a little darker towards its corners.
  float cScreen = cov(sdBox(f - vec2(0.0, 0.5 * (SCR_TOP + SCR_BOT)), vec2(SCR_HW, 0.5 * (SCR_TOP - SCR_BOT)), 0.0));
  vec3 sheet = vec3(0.5, 0.5, 0.48) * (1.0 - 0.18 * smoothstep(0.2, 0.75, length(f * vec2(0.8, 1.6) - vec2(0.0, 0.2))));
  col = mix(col, sheet, cScreen);
  film = mix(film, 1.0, cScreen);
  // The legs: fixed drapes either side of the screen, lit from below.
  float legU = (ax - LEG_IN) / (LEG_OUT - LEG_IN);
  float cLeg = cov(max(LEG_IN - ax, ax - LEG_OUT)) * cov(STAGE_Y - 0.004 - f.y);
  float fold = 0.5 + 0.5 * cos(legU * 6.2831853 * 2.5 + 0.6);
  vec3 drape = CURTAIN * (0.35 + 0.65 * pow(fold, 1.4)) + vec3(0.18, 0.06, 0.06) * pow(fold, 10.0);
  drape *= 0.75 + 0.5 * smoothstep(VALANCE, STAGE_Y, f.y);
  col = mix(col, drape, cLeg);
  film = mix(film, 0.4 * smoothstep(1.0, 0.0, legU), cLeg);
  glow = mix(glow, 0.0, cLeg);
  // The valance: swags of the same velvet, with a gold fringe.
  float vb = valanceAt(f.x);
  float cVal = cov(vb - f.y) * cov(ax - LEG_OUT - 0.03);
  float sw = fract(f.x / 0.27);
  vec3 swag = CURTAIN * (0.5 + 0.5 * smoothstep(0.0, 0.5, sin(sw * 3.14159265))) * (0.65 + 0.35 * smoothstep(0.5, vb, f.y));
  swag *= 0.7 + 0.3 * (0.5 + 0.5 * cos((f.y - vb) * 70.0 + sw * 2.0));
  float fringe = smoothstep(0.016, 0.0, f.y - vb) * (0.7 + 0.3 * step(0.5, fract(f.x / 0.006)));
  swag = mix(swag, vec3(0.7, 0.5, 0.2), fringe);
  col = mix(col, swag, cVal);
  film = mix(film, 0.15 + 0.2 * fringe, cVal);
  glow = mix(glow, 0.0, cVal);
  // The stage: its floor catching the screen's light, a brass lip, and its dark front.
  float cStage = cov(f.y - STAGE_Y) * cov(ax - 1.05);
  vec3 boards = vec3(0.13, 0.08, 0.05) * (0.85 + 0.15 * rnd(f.x * 60.0, 1.0));
  vec3 stage = boards;
  float sf = 0.85;
  float lip = smoothstep(0.003, 0.0, abs(f.y - STAGE_LIP - 0.002));
  if (f.y < STAGE_LIP) {
    stage = vec3(0.045, 0.03, 0.03) * (0.8 + 0.2 * smoothstep(STAGE_FOOT, STAGE_LIP, f.y));
    sf = 0.06;
  }
  stage = mix(stage, vec3(0.45, 0.33, 0.16), lip);
  sf = mix(sf, 0.9, lip);
  col = mix(col, stage, cStage);
  film = mix(film, sf, cStage);
  glow = mix(glow, 0.0, cStage);
  // The floor in front of the stage.
  float cFloor = cov(f.y - STAGE_FOOT);
  col = mix(col, vec3(0.04, 0.025, 0.025), cFloor);
  film = mix(film, 0.12, cFloor);
  // The tops of the seats in the rows in front, from behind.
  for (int ri = 0; ri < 2; ri++) {
    float w = ri == 0 ? 0.19 : 0.29;
    float top = ri == 0 ? -0.365 : -0.425;
    float off = ri == 0 ? 0.0 : 0.5 * w;
    float k = floor((f.x - off) / w + 0.5);
    float lx = f.x - off - k * w;
    vec2 q = vec2(lx, f.y - top + 0.3);
    float d = sdBox(q, vec2(0.42 * w, 0.3), 0.28 * w);
    float c = cov(d);
    float v = clamp(-d / (0.12 * w), 0.0, 1.0);
    float tone = 0.86 + 0.28 * rnd(k, 5.0 + float(ri));
    float roll = smoothstep(top - 0.07 * w, top, f.y);
    vec3 shell = uSeat * tone * mix(0.3, 0.7, roll) * (0.7 + 0.3 * v);
    // The velvet's worn top edge catches the light.
    float rim = (1.0 - v) * roll;
    float lum = dot(uSeat, vec3(0.3, 0.55, 0.15));
    shell = mix(shell, mix(uSeat, vec3(lum) * 1.25 + 0.06, 0.5) * tone, 0.5 * rim);
    col = mix(col, shell, c);
    film = mix(film, mix(0.04, 0.75, roll), c);
    glow = mix(glow, 0.0, c);
  }
  return vec4(col, pack(glow, film));
}
void main() {
  vec4 acc = vec4(0.0);
  px = 1.0 / (uRes.y * uFit);
  for (int i = 0; i < 4; i++) {
    vec2 frag = gl_FragCoord.xy + SS[i];
    acc += scene((frag - 0.5 * uRes) * px);
  }
  outColor = acc * 0.25;
}
`;

/**
 * The projector's beam into its reduced-size layer: a soft cone from the lens
 * fading along its length, with slow haze drifting through it (rays along its
 * length and billows across it). Its profile is `beamAt` in the sim.
 */
const BEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uFull;
uniform float uFit;
uniform vec2 uDrift;
out vec4 outColor;
${VALUE_NOISE_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy / uRes * uFull;
  vec2 f = (frag - 0.5 * uFull) / (uFull.y * uFit);
  vec2 d = f - vec2(${g(BEAM_APEX[0])}, ${g(BEAM_APEX[1])});
  float t = dot(d, vec2(${g(BEAM_DIR[0])}, ${g(BEAM_DIR[1])}));
  float s = dot(d, vec2(${g(BEAM_NORMAL[0])}, ${g(BEAM_NORMAL[1])}));
  float hw = ${g(BEAM_R0)} + ${g(BEAM_SPREAD)} * max(t, 0.0);
  float a = abs(s) / hw;
  float beam = exp(-${g(BEAM_SOFT)} * a * a) * (1.0 - smoothstep(${g(BEAM_EDGE)}, 1.0, a))
    * smoothstep(0.0, ${g(BEAM_START)}, t) / (1.0 + ${g(BEAM_FALLOFF)} * max(t, 0.0));
  beam *= step(0.0, t);
  // Rays: brighter and darker streaks fanning out from the lens.
  float rays = vnoise(vec2(s / hw * 5.0 + 11.0, t * 1.4 + uDrift.x * 0.4), 3.0);
  // Billows of smoke drifting slowly through.
  float smoke = vnoise(f * 6.0 + uDrift, 7.0) * 0.6 + vnoise(f * 13.0 - uDrift * 1.7, 9.0) * 0.4;
  beam *= (0.72 + 0.4 * rays) * (0.6 + 0.6 * smoke);
  outColor = vec4(beam * ${g(BEAM_STORE)}, 0.0, 0.0, 1.0);
}
`;

/**
 * Every frame, at full size, once per view on show (twice while a view
 * cross-fades): the cached room under the house lights' level and the film's
 * light; facing the projector, the beam from its layer and the lens's glow;
 * facing the screen, the screen's glow and the travelling curtains.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uBeamTex;
uniform vec2 uRes;
uniform float uFit;
uniform int uView;
/** House lights (1 up), the beam (0 off) and how far the curtains have parted. */
uniform vec3 uShow;
/** The film's light on the room, including the beam's level and shimmer. */
uniform vec3 uFilm;
/** The screen's pool of light: centre x, centre y, radius. */
uniform vec3 uPool;
/** The curtains' sway phases. */
uniform vec2 uSway;
out vec4 outColor;
${SHARED_GLSL}
${DITHER_GLSL}
const float DARK = 0.1;
const float FILM_GAIN = 0.95;
const float SCREEN_GAIN = 1.5;

/** The travelling curtains facing the screen: colour and coverage. */
vec4 curtains(vec2 f, float open) {
  float ax = abs(f.x);
  float side = sign(f.x);
  // Closed, the two halves overlap a little in the middle. As they part, the
  // folds bunch up (as curtainFolds does in the sim), then slide behind the drapes.
  float lead = open * CURTAIN_TRAVEL - CURTAIN_OVERLAP + 0.005 * sin(uSway.y + f.y * 4.0 + side) * (1.0 - open);
  float outer = CURTAIN_OUTER;
  float width = CURTAIN_WIDTH * max((outer - lead) / CURTAIN_WIDTH, BUNCH);
  float local = clamp((ax - lead) / width, 0.0, 1.0);
  float sway = (0.22 * sin(uSway.x + f.y * 2.2 + side * 1.3) + 0.12 * sin(uSway.y + f.y * 5.0)) * (1.0 - local);
  float ph = local * FOLDS * 6.2831853 + sway;
  float contrast = smoothstep(3.0, 10.0, width / FOLDS / px);
  float fold = 0.5 + 0.5 * cos(ph);
  float shade = mix(0.62, 0.35 + 0.65 * pow(fold, 1.4), contrast);
  vec3 c = CURTAIN * shade + vec3(0.2, 0.06, 0.06) * pow(fold, 10.0) * contrast;
  float hem = STAGE_Y + 0.004 + 0.003 * cos(ph);
  float cover = clamp((ax - lead) / px + 0.5, 0.0, 1.0) * clamp((f.y - hem) / px + 0.5, 0.0, 1.0)
    * clamp((VALANCE - 0.02 - f.y) / px + 0.5, 0.0, 1.0) * step(ax, outer);
  // Lit from the footlights under the house lights; the film plays on them while they're closed.
  vec3 house = c * mix(DARK, 1.0, uShow.x) * (0.7 + 0.6 * smoothstep(VALANCE, STAGE_Y, f.y));
  float onSheet = step(ax, SCR_HW) * step(SCR_BOT, f.y) * step(f.y, SCR_TOP);
  vec3 film = (c * 1.8 + CURTAIN * 0.6) * uFilm * mix(0.25, 1.2, onSheet);
  return vec4(house + film, cover);
}

void main() {
  px = 1.0 / (uRes.y * uFit);
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) * px;
  vec4 room = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0);
  float glow = max(0.0, 2.0 * room.a - 1.0);
  float film = max(0.0, 1.0 - 2.0 * room.a);
  vec3 col = room.rgb * mix(mix(DARK, 1.0, uShow.x), 1.0, glow) + room.rgb * uFilm * (film * FILM_GAIN);
  if (uView == 0) {
    float beam = texture(uBeamTex, gl_FragCoord.xy / uRes).r / ${g(BEAM_STORE)};
    col += uFilm * ${g(BEAM_GAIN)} * beam;
    // The lens: a hot white point with the film's colour round it.
    vec2 d = f - APEX;
    float r2 = dot(d, d);
    col += (vec3(1.0, 0.97, 0.92) * 0.9 * exp(-r2 / 0.00006) + uFilm * (0.9 * exp(-r2 / 0.0006) + 0.25 * exp(-sqrt(r2) / 0.05))) * uShow.y;
  } else {
    float inScreen = clamp((SCR_HW - abs(f.x)) / px + 0.5, 0.0, 1.0)
      * clamp((SCR_TOP - f.y) / px + 0.5, 0.0, 1.0) * clamp((f.y - SCR_BOT) / px + 0.5, 0.0, 1.0);
    vec2 q = (f - uPool.xy) / uPool.z;
    float pool = 0.72 + 0.28 * exp(-dot(q, q));
    col += uFilm * (SCREEN_GAIN * pool * inScreen);
    // The screen's light spilling round its edges.
    vec2 out2 = max(abs(f - vec2(0.0, 0.5 * (SCR_TOP + SCR_BOT))) - vec2(SCR_HW, 0.5 * (SCR_TOP - SCR_BOT)), 0.0);
    col += uFilm * (0.12 * exp(-length(out2) / 0.05) * (1.0 - inScreen));
    vec4 c = curtains(f, uShow.z);
    col = mix(col, c.rgb, c.a);
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** The dust motes: soft round sprites lit by the beam. */
const MOTE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (design units), radius (design units) and brightness. */
layout(location = 1) in vec4 aMote;
uniform vec2 uRes;
uniform float uFit;
out vec2 vLocal;
flat out float vLevel;
void main() {
  float unit = uRes.y * uFit;
  // At least a pixel and a half across, so the smallest don't shimmer.
  float r = max(aMote.z * unit, 1.5);
  vLocal = aCorner;
  vLevel = aMote.w * min(1.0, aMote.z * unit / 1.5);
  vec2 p = 0.5 * uRes + aMote.xy * unit + aCorner * r;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

const MOTE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in float vLevel;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float d = dot(vLocal, vLocal);
  outColor = vec4(uColor * (vLevel * max(0.0, 1.0 - d) * (1.0 - d)), 0.0);
}
`;

/** A cached room: its view and seat colour, and the target holding it. */
interface Slot {
  target: RenderTarget | null;
  view: View;
  seats: string;
}

export const cinema = defineEffect(cinemaMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const projectorProgram = program(PROJECTOR_FRAGMENT);
      const screenProgram = program(SCREEN_FRAGMENT);
      const beamProgram = program(BEAM_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const moteProgram = scopedProgram(gl, scope, MOTE_VERTEX, MOTE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const motes = scope.own(createSpriteBatch(gl, MAX_MOTES, [MOTE_FLOATS]));
      const roomNames = ["uRes", "uFit", "uSeat"] as const;
      const pu = createUniforms(gl, projectorProgram, roomNames);
      const su = createUniforms(gl, screenProgram, roomNames);
      const bu = createUniforms(gl, beamProgram, ["uRes", "uFull", "uFit", "uDrift"]);
      const cu = createUniforms(gl, compProgram, [
        "uRoom",
        "uBeamTex",
        "uRes",
        "uFit",
        "uView",
        "uShow",
        "uFilm",
        "uPool",
        "uSway",
      ]);
      const mu = createUniforms(gl, moteProgram, ["uRes", "uFit", "uColor"]);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uBeamTex", 1);
      gl.useProgram(null);

      const slots: [Slot, Slot] = [
        { target: null, view: "projector", seats: "" },
        { target: null, view: "projector", seats: "" },
      ];
      const release = (s: Slot) => {
        s.target?.dispose();
        s.target = null;
        s.seats = "";
      };
      const fade = createCrossfadeSlots(slots, CROSSFADE_SECONDS, release);
      let beamTarget: RenderTarget | null = null;
      const disposeTargets = () => {
        release(slots[0]);
        release(slots[1]);
        beamTarget?.dispose();
        beamTarget = null;
      };
      scope.defer(disposeTargets);

      const show = createShow();
      const schedule = createShotSchedule(0, FILM_PALETTES.drama, 1);
      const moteFade = createCountFade(MAX_MOTES);
      let started = false;
      let width = 1;
      let height = 1;
      let fit = 1;
      // CPU-only time, kept unwrapped in float64.
      let time = 0;

      /** Draws the room for `view` with `seats` into `slot`. */
      const bake = (slot: Slot, view: View, seats: string) => {
        slot.view = view;
        slot.seats = seats;
        slot.target ??= createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
        if (!slot.target) {
          return;
        }
        slot.target.bind();
        const u = view === "projector" ? pu : su;
        gl.useProgram(view === "projector" ? projectorProgram : screenProgram);
        u.f2("uRes", width, height);
        u.f1("uFit", fit);
        u.rgb("uSeat", seats);
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      /** Draws the beam's haze into its layer. */
      const drawBeam = () => {
        if (!beamTarget) {
          return;
        }
        beamTarget.bind();
        gl.useProgram(beamProgram);
        bu.f2("uRes", beamTarget.width, beamTarget.height);
        bu.f2("uFull", width, height);
        bu.f1("uFit", fit);
        // The haze drifts round a slow circle, so its motion loops with no jump.
        const a = ((time % LOOP_SECONDS) / LOOP_SECONDS) * 2 * Math.PI;
        bu.f2("uDrift", 3.8 * Math.cos(a), 3.8 * Math.sin(a));
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      /** Draws `slot`'s view over the frame. */
      const composite = (slot: Slot) => {
        if (!slot.target) {
          return;
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, slot.target.texture);
        cu.i1("uView", slot.view === "projector" ? 0 : 1);
        triangle.draw();
      };

      /** Draws the motes, `level` bright, additively. */
      const drawMotes = (level: number, r: number, gr: number, b: number) => {
        const live = moteFade.live;
        if (live === 0 || level <= 0) {
          return;
        }
        const d = motes.data;
        for (let i = 0; i < live; i++) {
          const o = i * MOTE_FLOATS;
          writeMote(i, time, d, o);
          d[o + 3] *= moteFade.life[i];
        }
        motes.upload(live);
        gl.useProgram(moteProgram);
        mu.f2("uRes", width, height);
        mu.f1("uFit", fit);
        mu.f3("uColor", r * level, gr * level, b * level);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        motes.draw(0, live);
        gl.disable(gl.BLEND);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          fit = cinemaFit(width / height);
          disposeTargets();
          beamTarget = createRenderTarget(
            gl,
            Math.max(1, Math.round(width / BEAM_DIVISOR)),
            Math.max(1, Math.round(height / BEAM_DIVISOR)),
            gl.RGBA8,
          );
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const palette = FILM_PALETTES[toFilm(p.film)];
          if (!started) {
            // The first frame starts the show on the link's settings, with no ease in.
            started = true;
            restartShots(schedule, 0, palette, 1);
            moteFade.snap(moteCount(p.dust));
          }
          stepShots(schedule, step, palette, 1, 0);
          stepShow(show, step, p.state !== "before");
          moteFade.step(moteCount(p.dust), step, MOTE_FADE_IN);

          // 1. The room: bake it after a resize, or cross-fade to a changed view or seat colour.
          fade.step(step);
          const view = toView(p.view);
          const seats = p.seats;
          if (!fade.current.target) {
            bake(fade.current, view, seats);
          } else if (!fade.fading && (fade.current.view !== view || fade.current.seats !== seats)) {
            bake(fade.next, view, seats);
            fade.start();
          }
          const current = fade.current;
          const next = fade.next;
          if (!current.target) {
            return;
          }
          const mix = fade.fading ? fade.mix : 0;
          const projector =
            (current.view === "projector" ? 1 - mix : 0) +
            (fade.fading && next.view === "projector" ? mix : 0);

          // 2. The beam's haze, while it shows.
          const beamOn = show.beam > 0 && projector > 0;
          if (beamOn) {
            drawBeam();
          }

          // 3. The room, the beam, the screen and the curtains.
          const shimmer = screenFlicker(time) * show.beam;
          const light = schedule.light;
          gl.useProgram(compProgram);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, beamOn && beamTarget ? beamTarget.texture : null);
          cu.f2("uRes", width, height);
          cu.f1("uFit", fit);
          cu.f3("uShow", show.house, show.beam, show.curtains);
          cu.f3("uFilm", light[0] * shimmer, light[1] * shimmer, light[2] * shimmer);
          cu.f3("uPool", schedule.centre * 3, 0.14, 0.25 + 0.3 * schedule.radius);
          const sway = ((time % LOOP_SECONDS) / LOOP_SECONDS) * 2 * Math.PI;
          cu.f2("uSway", 30 * sway, 50 * sway);
          composite(current);
          if (fade.fading) {
            gl.enable(gl.BLEND);
            gl.blendColor(0, 0, 0, mix);
            gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
            composite(next);
            gl.disable(gl.BLEND);
            gl.blendColor(0, 0, 0, 0);
          }
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, null);

          // 4. Dust in the beam.
          if (beamOn) {
            drawMotes(projector * shimmer * MOTE_GAIN, light[0], light[1], light[2]);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
