import { createChangeKey } from "../change-key";
import { createMeteorPose, meteorAt } from "../desertcamp/desertcamp-sim";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget } from "../lowres";
import {
  createMilkyWayNoise,
  createStarDraw,
  createStarSprites,
  glslColor as C,
  HAZE_COLOR,
  HAZE_GAIN,
  milkyWayGlsl,
  TO_SKY_GLSL,
} from "../starfield";
import { advanceRotation, bandThrough, seedSalt, wrapAngle } from "../starfield-sim";
import { createStreakRenderer, STREAK_FLOATS } from "../streaks";
import { defineEffect } from "../types";
import {
  angleDiff,
  applyReschedule,
  BAR_REACH,
  CAM_FWD,
  CAM_RIGHT,
  CAM_UP,
  CAM_X,
  CAM_Y,
  CAM_Z,
  createPose,
  createReschedule,
  createSlitMeteors,
  createTarget,
  DEC_OFFSET,
  decAxis,
  DESK_MAX,
  DESK_MIN,
  DOME_R,
  easeLights,
  FOCAL,
  HEAD,
  PIER_H,
  PIER_LAMP,
  PIER_R,
  pointing,
  POLAR,
  poseAt,
  REF_HEIGHT,
  reschedule,
  RIBS,
  RING_STEP,
  SCREEN_AT,
  SCREEN_HALF,
  skyPole,
  SLIT_FROM,
  SLIT_HALF,
  SLIT_LIP,
  SLIT_PAST,
  slitBounds,
  stepSlitMeteors,
  targetOf,
  TUBE_BACK,
  TUBE_FRONT,
  TUBE_R,
  WALL_H,
  WALL_LAMPS,
  WEIGHT_SPAN,
} from "./observatory-sim";
import { observatoryMeta } from "./observatory.meta";
import { HASH_CELL_GLSL } from "../noise";

/** Sky pass: about 3 reference px per texel; it is all soft gradient and haze. */
const SKY_TEXEL_REF = 3;
/** Point stars: the most listed, their density (share of cells) and frame margin (reference px). */
const MAX_STARS = 24000;
const STAR_DENSITY = 0.4;
const STAR_MARGIN = 6;
/** Sky rotation, degrees per minute: slow enough to be felt rather than seen. */
const SKY_TURN = 0.5;
/** Milky Way: where it crosses the slit (reference px from the frame centre and bottom), its slant and width. */
const BAND_DX = 120;
const BAND_Y = 820;
const BAND_DIRECTION = 1.15;
const BAND_WIDTH = 150;
const HAZE_BOOST = 1.5;
/** Meteor core and glow half-widths (reference px), the glow's brightness and the colour. */
const METEOR_CORE = 0.7;
const METEOR_GLOW = 2.6;
const METEOR_GLOW_GAIN = 0.22;
const METEOR_RGB = [0.92, 0.96, 1] as const;

const v3 = (v: readonly number[]) => `vec3(${F(v[0])}, ${F(v[1])}, ${F(v[2])})`;

/**
 * Sky at low resolution, in screen space (the camera never moves, so the sky
 * only turns): a deep blue-black gradient and the Milky Way haze with darker
 * lanes along its core, turning about the pole.
 */
const SKY_FRAGMENT = (band: string) => /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
/** Pole (reference px), rotation cosine and sine. */
uniform vec4 uPole;
out vec4 outColor;
${TO_SKY_GLSL}
${band}
const vec3 TOP = ${C("#020309")};
const vec3 LOW = ${C("#081024")};
const vec3 HAZE = ${C(HAZE_COLOR, HAZE_GAIN * HAZE_BOOST)};
const vec3 CORE = ${C("#e8d8c0", 0.06)};
void main() {
  vec2 p = gl_FragCoord.xy * uPxToRef;
  vec3 col = mix(LOW, TOP, smoothstep(0.35, 1.0, p.y * ${F(1 / REF_HEIGHT)}));
  vec2 q = toSky(p - uPole.xy, uPole.zw);
  float h = milkyWay(uNoise, q);
  if (h > 0.0) {
    float across = milkyWayAcross(q);
    float lanes = textureLod(uNoise, q * ${F(1 / 310)} + vec2(0.31, 0.77), 0.0).g;
    float lane = exp2(-(across + 20.0) * (across + 20.0) * ${F(1 / (50 * 50))}) * smoothstep(0.35, 0.7, lanes);
    float core = exp2(-across * across * ${F(1 / (80 * 80))});
    col += (HAZE + CORE * core) * (h * (1.0 - 0.8 * lane));
  }
  outColor = vec4(col, 1.0);
}
`;

const LAMPS = [...WALL_LAMPS, PIER_LAMP];
/** Each lamp's light, and the falloff with squared distance. */
const LAMP_GAIN = [1.8, 1.8, 1.8, 0.9] as const;
const LAMP_FALL = 0.5;
/** Lamp bulb and halo sizes (m) as seen directly. */
const BULB = 0.035;
const HALO = 0.3;
/** Monitor bezel and depth, m. */
const BEZEL = 0.025;
const MONITOR_D = 0.03;
/**
 * The cached room is redrawn once the telescope or dome has turned far enough
 * to move something by this many device px. While tracking that is about ten times
 * a second at 4K rather than every frame.
 */
const REDRAW_PX = 0.05;
/**
 * Upper bound on how far (device px per radian, in units of the focal length)
 * a turn of either telescope axis or the dome moves anything on screen: lever
 * arm over viewing distance, about 2 for the dome's ribs above the camera,
 * times up to 2 for the projection's stretch towards the frame's edges.
 */
const TURN_REACH = 4;

/**
 * The room, ray-traced in one full-resolution pass (telescope on the left; the
 * ray is mirrored for the right): the dome (a hemisphere on a drum wall) with
 * its ribs and rings and the slit cut through it, the floor, the desk and its
 * screen, and the telescope: a dozen cylinders on two axes. Each cylinder's
 * coverage comes from the ray's closest approach to its axis and the distance
 * to its ends, measured in pixels, so its silhouette is anti-aliased without
 * supersampling. Premultiplied output, transparent through the slit.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Frame centre x, y (device px), mirror (1 or -1), focal length (device px). */
uniform vec4 uFrame;
/** Tube direction, and the declination axis (the tube's side of the mount). */
uniform vec3 uTube;
uniform vec3 uDec;
/** The slit's forward direction (x, z), and the work lights' level. */
uniform vec3 uDome;
/** Desk screen: the outgoing and incoming images (kind, tilt, shape a, shape b), and the cross-fade. */
uniform vec4 uImgA;
uniform vec4 uImgB;
uniform float uImgMix;
out vec4 outColor;
${DITHER_GLSL}
const float TAU = 6.283185307179586;
const vec3 CAM = vec3(${F(CAM_X)}, ${F(CAM_Y)}, ${F(CAM_Z)});
const vec3 RIGHT = ${v3(CAM_RIGHT)};
const vec3 UP = ${v3(CAM_UP)};
const vec3 FWD = ${v3(CAM_FWD)};
const vec3 DOME_C = vec3(0.0, ${F(WALL_H)}, 0.0);
const float R = ${F(DOME_R)};
const vec3 HEAD = ${v3(HEAD)};
const vec3 POLAR = ${v3(POLAR)};
const vec3 SCREEN = ${v3(SCREEN_AT)};
const vec3 LAMP[4] = vec3[](${LAMPS.map((v) => v3(v)).join(", ")});
const float GAIN[4] = float[](${LAMP_GAIN.map((g) => F(g)).join(", ")});

const vec3 AMB = ${C("#1a2236")};
const vec3 SKY_SPILL = ${C("#2a3a66", 0.5)};
const vec3 RED = ${C("#ff2a14", 0.4)};
const vec3 BULB_RGB = ${C("#ff3a20", 1.4)};
const vec3 SCREEN_LIGHT = ${C("#8aa0d0", 0.12)};
const vec3 DOME_ALB = ${C("#7c8aa6")};
const vec3 DRUM_ALB = ${C("#5c6476")};
const vec3 FLOOR_ALB = ${C("#3a3a3e")};
const vec3 LIP_ALB = ${C("#a0a8b8")};
const vec3 TUBE_ALB = ${C("#f0e8d8")};
const vec3 BLACK_ALB = ${C("#141416")};
const vec3 MOUNT_ALB = ${C("#2c3038")};
const vec3 STEEL_ALB = ${C("#80848c")};
const vec3 PIER_ALB = ${C("#8c8880")};
const vec3 DESK_ALB = ${C("#4a3426")};

/** Light falling on a point: the night's ambient, the red work lights and the screen's glow. */
vec3 lit(vec3 P, vec3 N, vec3 albedo) {
  vec3 l = AMB * (0.55 + 0.45 * N.y);
  if (uDome.z > 0.0) {
    float red = 0.0;
    for (int i = 0; i < 4; i++) {
      vec3 L = LAMP[i] - P;
      float d2 = dot(L, L);
      red += GAIN[i] * (0.15 + 0.85 * max(dot(N, L) * inversesqrt(d2 + 1e-4), 0.0)) / (1.0 + d2 * ${F(LAMP_FALL)});
    }
    l += RED * (red * uDome.z);
  }
  vec3 S = SCREEN - P;
  float s2 = dot(S, S);
  l += SCREEN_LIGHT * (max(dot(N, S) * inversesqrt(s2 + 1e-4), 0.0) / (1.0 + s2 * 10.0));
  return albedo * l;
}

float band(float d, float halfWidth, float px) {
  return clamp((halfWidth - abs(d)) / px + 0.5, 0.0, 1.0);
}

${HASH_CELL_GLSL}
float hash12(vec2 p) {
  return hashCell(p);
}

/**
 * Coverage (0..1) of a cylinder from \`a\` along unit \`w\` for \`len\`, radius \`r\`,
 * open at both ends (looking in shows its inner wall, flagged in \`inside\`).
 * \`fp\` is the pixel's angular size. Writes the hit distance and normal.
 */
float cylinder(vec3 ro, vec3 rd, vec3 a, vec3 w, float len, float r, float fp,
    out float t, out vec3 n, out float inside) {
  vec3 oc = ro - a;
  float dw = dot(rd, w);
  float ow = dot(oc, w);
  vec3 rp = rd - w * dw;
  vec3 op = oc - w * ow;
  float A = max(dot(rp, rp), 1e-6);
  float B = dot(op, rp);
  float tc = -B / A;
  float d2 = max(dot(op, op) - B * B / A, 0.0);
  float dmin = sqrt(d2);
  inside = 0.0;
  t = 1e9;
  n = vec3(0.0);
  if (tc <= 0.0 || dmin > r + fp * tc) return 0.0;
  float h = sqrt(max(r * r - d2, 0.0) / A);
  t = tc - h;
  float s = ow + dw * t;
  if (s < 0.0 || s > len) {
    float t2 = tc + h;
    float s2 = ow + dw * t2;
    if (h > 0.0 && s2 > 0.0 && s2 < len) {
      t = t2;
      s = s2;
      inside = 1.0;
    }
  }
  float px = fp * t;
  float cov = clamp((r - dmin) / (fp * tc) + 0.5, 0.0, 1.0) * clamp(min(s, len - s) / px + 0.5, 0.0, 1.0);
  vec3 hp = op + rp * t;
  n = hp / max(length(hp), 1e-5) * (1.0 - 2.0 * inside);
  return cov;
}

/** Ray against an axis-aligned box: the entry distance (or -1) and the entry face's normal. */
float box(vec3 ro, vec3 rd, vec3 lo, vec3 hi, out vec3 n) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (lo - ro) * inv;
  vec3 t1 = (hi - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  n = vec3(0.0);
  if (tn > tf || tn <= 0.0) return -1.0;
  n = -sign(rd) * step(tmin.yzx, tmin) * step(tmin.zxy, tmin);
  return tn;
}

/** The desk screen's picture of a target (kind, tilt, shape a, shape b) at \`uv\` (-1..1 high). */
vec3 targetImage(vec2 uv, vec4 img) {
  float c = cos(img.y);
  float s = sin(img.y);
  vec2 p = vec2(c * uv.x + s * uv.y, c * uv.y - s * uv.x);
  vec3 col = vec3(0.0);
  if (img.x < 0.5) {
    // A galaxy: an inclined disc with a bright core.
    float e = 0.3 + 0.45 * img.z;
    float r2 = p.x * p.x + p.y * p.y / (e * e);
    col = ${C("#e8dcc8")} * (0.7 * exp2(-r2 * 5.0) + 0.9 * exp2(-r2 * 60.0));
  } else if (img.x < 1.5) {
    // A nebula: a soft, lumpy cloud in two tints.
    float m = exp2(-dot(p, p) * 2.5) * (0.6 + 0.4 * sin(p.x * 6.0 + img.w * 6.0) * sin(p.y * 5.0 - img.z * 5.0));
    col = mix(${C("#e0506a")}, ${C("#50b0c8")}, img.w * 0.8 + 0.2 * p.x) * (0.9 * max(m, 0.0));
  } else {
    // A cluster: a knot of bright stars.
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      vec2 o = vec2(sin(fi * 2.4 + img.z * 6.0), cos(fi * 3.1 + img.w * 6.0)) * (0.12 + 0.05 * fi);
      vec2 d = p - o;
      col += ${C("#d8e4ff")} * (0.9 * exp2(-dot(d, d) * 900.0));
    }
    col += ${C("#a0b0d0")} * (0.15 * exp2(-dot(p, p) * 6.0));
  }
  return col;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 rd = normalize(RIGHT * ((frag.x - uFrame.x) * uFrame.z) + UP * (frag.y - uFrame.y) + FWD * uFrame.w);
  vec3 ro = CAM;
  float fp = 1.0 / uFrame.w;

  // The dome from inside, else the drum wall below it, else the floor.
  vec3 oc = ro - DOME_C;
  float b = dot(oc, rd);
  float t = -b + sqrt(max(b * b - dot(oc, oc) + R * R, 0.0));
  vec3 P = ro + rd * t;
  vec3 col;
  float alpha = 1.0;
  if (P.y >= DOME_C.y) {
    vec3 q = P - DOME_C;
    vec2 f = uDome.xy;
    float along = dot(q.xz, f);
    float across = q.z * f.x - q.x * f.y;
    float el = asin(clamp(q.y * ${F(1 / DOME_R)}, 0.0, 1.0));
    float px = fp * t;
    float ax = abs(across);
    float open = clamp((${F(SLIT_HALF)} - ax) / px + 0.5, 0.0, 1.0)
      * clamp((along + ${F(SLIT_PAST)}) / px + 0.5, 0.0, 1.0)
      * clamp((el - ${F(SLIT_FROM)}) * R / px + 0.5, 0.0, 1.0);
    float lip = clamp((${F(SLIT_HALF + SLIT_LIP)} - ax) / px + 0.5, 0.0, 1.0)
      * clamp((along + ${F(SLIT_PAST + SLIT_LIP)}) / px + 0.5, 0.0, 1.0)
      * clamp((el - ${F(SLIT_FROM - SLIT_LIP / DOME_R)}) * R / px + 0.5, 0.0, 1.0);
    // Ribs and rings turn with the dome: azimuth measured from the slit.
    float cell = ${F((2 * Math.PI) / RIBS)};
    float ra = atan(across, along) / cell + 0.5;
    float ribD = (fract(ra + 0.5) - 0.5) * cell * length(q.xz);
    float ru = el * ${F(1 / RING_STEP)};
    float ringD = (fract(ru + 0.5) - 0.5) * ${F(RING_STEP * DOME_R)};
    float rib = max(band(ribD, 0.05, px), band(ringD, 0.04, px));
    float panel = 0.9 + 0.2 * hash12(floor(vec2(ra, ru)));
    vec3 N = -q * ${F(1 / DOME_R)};
    vec3 alb = DOME_ALB * mix(panel, 1.45, rib);
    alb = mix(alb, LIP_ALB * (1.0 - 0.7 * band(ax - ${F(SLIT_HALF + SLIT_LIP)}, 0.012, px)), lip);
    col = lit(P, N, alb);
    col += SKY_SPILL * (exp2(-max(ax - ${F(SLIT_HALF)}, 0.0) * 1.2) * smoothstep(0.0, 0.4, el) * (1.0 - lip) * 0.08);
    alpha = 1.0 - open;
  } else {
    float a2 = dot(rd.xz, rd.xz);
    float b2 = dot(ro.xz, rd.xz);
    t = (-b2 + sqrt(max(b2 * b2 - a2 * (dot(ro.xz, ro.xz) - R * R), 0.0))) / a2;
    P = ro + rd * t;
    if (P.y > 0.0) {
      float px = fp * t;
      float az = atan(P.x, -P.z);
      float seam = band((fract(az * ${F(36 / (2 * Math.PI))} + 0.5) - 0.5) * ${F((2 * Math.PI * DOME_R) / 36)}, 0.012, px);
      float ledge = smoothstep(${F(WALL_H - 0.14)} - px, ${F(WALL_H - 0.14)} + px, P.y);
      vec3 N = vec3(-P.x, 0.0, -P.z) * ${F(1 / DOME_R)};
      col = lit(P, N, DRUM_ALB * (1.0 - 0.5 * seam) * (1.0 + 0.5 * ledge));
    } else {
      t = -ro.y / rd.y;
      P = ro + rd * t;
      col = lit(P, vec3(0.0, 1.0, 0.0), FLOOR_ALB);
    }
  }
  col *= alpha;

  // The desk and its screen.
  vec3 n;
  float td = box(ro, rd, ${v3(DESK_MIN)}, ${v3(DESK_MAX)}, n);
  if (td > 0.0 && td < t) {
    t = td;
    col = lit(ro + rd * t, n, DESK_ALB * (n.y > 0.5 ? 1.0 : 0.5));
    alpha = 1.0;
  }
  td = box(ro, rd,
    SCREEN - vec3(${F(SCREEN_HALF[0] + BEZEL)}, ${F(SCREEN_HALF[1] + BEZEL)}, ${F(MONITOR_D)}),
    SCREEN + vec3(${F(SCREEN_HALF[0] + BEZEL)}, ${F(SCREEN_HALF[1] + BEZEL)}, 0.0), n);
  if (td > 0.0 && td < t) {
    t = td;
    vec3 Q = ro + rd * t;
    vec2 uv = (Q.xy - SCREEN.xy) * ${F(1 / SCREEN_HALF[1])};
    col = lit(Q, n, BLACK_ALB);
    if (n.z > 0.5 && abs(uv.x) < ${F(SCREEN_HALF[0] / SCREEN_HALF[1])} && abs(uv.y) < 1.0) {
      vec3 img = mix(targetImage(uv, uImgA), targetImage(uv, uImgB), uImgMix);
      col = ${C("#04060c")} + 0.5 * img;
    }
    alpha = 1.0;
  }

  // The telescope, inside a bounding sphere round the mount's head.
  vec3 hc = ro - HEAD;
  float hb = dot(hc, rd);
  if (hb * hb - dot(hc, hc) + 7.5 > 0.0) {
    vec3 side = cross(uTube, uDec);
    vec3 tc = HEAD + uDec * ${F(DEC_OFFSET)};
    vec3 back = tc - uTube * ${F(TUBE_BACK)};
    for (int i = 0; i < 12; i++) {
      vec3 a;
      vec3 w;
      float len;
      float r;
      vec3 alb;
      if (i == 0) { a = vec3(0.0); w = vec3(0.0, 1.0, 0.0); len = ${F(PIER_H)}; r = ${F(PIER_R)}; alb = PIER_ALB; }
      else if (i == 1) { a = vec3(0.0, ${F(PIER_H - 0.1)}, 0.0); w = vec3(0.0, 1.0, 0.0); len = ${F(HEAD[1] - PIER_H - 0.1)}; r = 0.2; alb = MOUNT_ALB; }
      else if (i == 2) { a = HEAD - POLAR * 0.5; w = POLAR; len = 0.62; r = 0.17; alb = MOUNT_ALB; }
      else if (i == 3) { a = HEAD - uDec * 0.28; w = uDec; len = ${F(0.28 + DEC_OFFSET - TUBE_R)}; r = 0.13; alb = MOUNT_ALB; }
      else if (i == 4) { a = HEAD - uDec * ${F(BAR_REACH)}; w = uDec; len = ${F(BAR_REACH - 0.28)}; r = 0.035; alb = STEEL_ALB; }
      else if (i == 5) { a = HEAD - uDec * ${F(WEIGHT_SPAN[1])}; w = uDec; len = ${F(WEIGHT_SPAN[1] - WEIGHT_SPAN[0])}; r = 0.17; alb = MOUNT_ALB; }
      else if (i == 6) { a = back; w = uTube; len = ${F(TUBE_BACK + TUBE_FRONT)}; r = ${F(TUBE_R)}; alb = TUBE_ALB; }
      else if (i == 7) { a = tc + uTube * ${F(TUBE_FRONT - 0.24)}; w = uTube; len = 0.24; r = ${F(TUBE_R + 0.03)}; alb = BLACK_ALB; }
      else if (i == 8) { a = back; w = uTube; len = 0.14; r = ${F(TUBE_R + 0.03)}; alb = BLACK_ALB; }
      else if (i == 9) { a = tc - uTube * 0.38; w = uTube; len = 0.07; r = ${F(TUBE_R + 0.02)}; alb = MOUNT_ALB; }
      else if (i == 10) { a = tc + uTube * 0.31; w = uTube; len = 0.07; r = ${F(TUBE_R + 0.02)}; alb = MOUNT_ALB; }
      else { a = tc + side * ${F(TUBE_R + 0.09)} + uTube * 0.6; w = uTube; len = 0.55; r = 0.05; alb = TUBE_ALB; }
      float tp;
      vec3 np;
      float inside;
      float cov = cylinder(ro, rd, a, w, len, r, fp, tp, np, inside);
      if (cov > 0.0 && tp < t) {
        vec3 c = lit(ro + rd * tp, np, alb * (1.0 - 0.85 * inside));
        col = mix(col, c, cov);
        alpha = mix(alpha, 1.0, cov);
        if (cov > 0.5) t = tp;
      }
    }
  }

  // The work lights' bulbs and a soft halo round each, where nothing hides them.
  if (uDome.z > 0.0) {
    for (int i = 0; i < 4; i++) {
      vec3 L = LAMP[i] - ro;
      float d = length(L);
      if (d < t + 0.1) {
        float c2 = 2.0 * max(1.0 - dot(rd, L / d), 0.0);
        float k = d * d;
        float g = exp2(-c2 * k * ${F(1 / (BULB * BULB))}) + 0.08 * exp2(-c2 * k * ${F(1 / (HALO * HALO))});
        col += BULB_RGB * (g * uDome.z * (i == 3 ? 0.5 : 1.0));
      }
    }
  }
  outColor = vec4(col + dither8(frag) * alpha, alpha);
}
`;

/**
 * A domed observatory at night: the sky (gradient and Milky Way at low
 * resolution, point stars and the odd slow meteor) drawn only inside the
 * slit's screen box, then the ray-traced room over it, transparent through
 * the slit. The telescope tracks, every few minutes slews to a new target,
 * and the dome turns after it.
 */
export const observatory = defineEffect(observatoryMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const sky = scope.own(createLowResTarget(gl));
      // The room changes only while the telescope slews, the lights fade or the
      // screen cross-fades; the rest of the time it is cached at full size.
      const room = scope.own(
        createLowResTarget(gl, { keep: true, premultiplied: true, dither: false }),
      );
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const pole: [number, number] = [0, 0];
      // The pole sits at the frame's centre x for every width, so the band's
      // offset from it doesn't depend on the width either.
      skyPole(0, pole);
      const band = bandThrough(pole, BAND_DX, BAND_Y, BAND_DIRECTION, BAND_WIDTH);
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT(milkyWayGlsl(band)));
      const su = createUniforms(gl, skyProgram, ["uNoise", "uPxToRef", "uPole"]);
      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uFrame",
        "uTube",
        "uDec",
        "uDome",
        "uImgA",
        "uImgB",
        "uImgMix",
      ]);
      const noiseTex = scope.add(createMilkyWayNoise(gl), (t) => {
        gl.deleteTexture(t);
      });
      const stars = scope.own(createStarSprites(gl, MAX_STARS));
      const streaks = scope.own(createStreakRenderer(gl, 2));
      gl.useProgram(skyProgram);
      su.i1("uNoise", 0);
      gl.useProgram(null);

      const starDraw = createStarDraw();
      const starInputs = createChangeKey(2);
      /** The room's inputs other than the axes and dome, and the axes and dome it was drawn at. */
      const roomInputs = createChangeKey(6);
      const drawn = createPose();
      const scheduled = createPose();
      const shown = createPose();
      const blend = createReschedule();
      const imgA = createTarget();
      const imgB = createTarget();
      const tube = [0, 0, 0];
      const dec = [0, 0, 0];
      const bounds = [0, 0, 0, 0];
      const meteorPose = createMeteorPose();
      let meteors = createSlitMeteors(0);
      let simSeed = Number.NaN;
      let schedSeed = Number.NaN;
      let schedGap = Number.NaN;
      let lights = -1;

      let width = 1;
      let height = 1;
      let scale = 1;
      /** CPU-only time and sky rotation, unwrapped float64. */
      let time = 0;
      let rot = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
          sky.resize(width, height, Math.max(1, SKY_TEXEL_REF * scale));
          room.resize(width, height, 1);
          gl.useProgram(skyProgram);
          su.f2("uPxToRef", sky.fullWidth / sky.width / scale, sky.fullHeight / sky.height / scale);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, dt);
          time += step;
          rot = advanceRotation(rot, step, SKY_TURN);
          const refWidth = width / scale;
          const seed = Math.floor(p.seed);
          skyPole(refWidth, pole);

          // Schedule: a new seed or gap swings over to the new schedule smoothly.
          if (seed !== schedSeed || p.slewGap !== schedGap) {
            const first = Number.isNaN(schedSeed);
            schedSeed = seed;
            schedGap = p.slewGap;
            poseAt(schedSeed, schedGap, time, scheduled);
            if (!first) {
              reschedule(blend, shown, scheduled, time);
            }
          }
          poseAt(schedSeed, schedGap, time, scheduled);
          applyReschedule(blend, scheduled, time, shown);
          pointing(shown.ha, shown.dec, tube);
          decAxis(shown.ha, dec);
          targetOf(schedSeed, shown.from, imgA);
          targetOf(schedSeed, shown.to, imgB);
          const lightsOn = p.lights === "red" ? 1 : 0;
          lights = lights < 0 ? lightsOn : easeLights(lights, lightsOn, step);

          starInputs.set(0, seed);
          starInputs.set(1, refWidth);
          if (starInputs.take()) {
            // Allocates only when the sky's inputs change.
            stars.build({
              salt: seedSalt(seed),
              density: STAR_DENSITY,
              pole,
              refWidth,
              refHeight: REF_HEIGHT,
              rotates: true,
              margin: STAR_MARGIN,
            });
          }
          if (seed !== simSeed) {
            meteors = createSlitMeteors(seed);
            // Start the schedule from now, so a new seed doesn't release a burst.
            meteors.next += time;
            simSeed = seed;
          }

          // 1. Sky, low resolution. Clear first: outside the slit's box nothing
          // else is drawn under the room, and a direct (full-size) sky lands on
          // the canvas itself.
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          sky.bind();
          gl.useProgram(skyProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          su.f4("uPole", pole[0], pole[1], Math.cos(wrapAngle(rot)), Math.sin(wrapAngle(rot)));
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);

          // 2. Only inside the slit's box: the sky upscaled, the stars and the odd meteor.
          stepSlitMeteors(meteors, time, p.meteors, shown.dome, refWidth, p.side);
          meteorAt(meteors.current, time, meteorPose);
          slitBounds(shown.dome, refWidth, p.side, bounds);
          const x0 = Math.floor(bounds[0] * scale);
          const y0 = Math.floor(bounds[1] * scale);
          const x1 = Math.ceil(bounds[2] * scale);
          const y1 = Math.ceil(bounds[3] * scale);
          if (x1 > x0 && y1 > y0) {
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(x0, y0, x1 - x0, y1 - y0);
            sky.blit();
            starDraw.width = width;
            starDraw.height = height;
            starDraw.scale = scale;
            starDraw.pole = pole;
            starDraw.rotation = rot;
            starDraw.time = time;
            stars.draw(starDraw);

            if (meteorPose.bright > 0) {
              const d = streaks.data;
              const hx = meteorPose.headX * scale;
              const hy = height - meteorPose.headY * scale;
              const tx = meteorPose.tailX * scale;
              const ty = height - meteorPose.tailY * scale;
              for (let k = 0; k < 2; k++) {
                const o = k * STREAK_FLOATS;
                const b = k === 0 ? meteorPose.bright * METEOR_GLOW_GAIN : meteorPose.bright;
                d[o] = tx;
                d[o + 1] = ty;
                d[o + 2] = hx;
                d[o + 3] = hy;
                d[o + 4] = METEOR_RGB[0] * b;
                d[o + 5] = METEOR_RGB[1] * b;
                d[o + 6] = METEOR_RGB[2] * b;
                d[o + 7] = (k === 0 ? METEOR_GLOW : METEOR_CORE) * scale;
              }
              streaks.upload(2);
              streaks.draw(2, width, height);
            }
            gl.disable(gl.SCISSOR_TEST);
            gl.disable(gl.BLEND);
          }

          // 3. The room over everything, transparent through the slit: redrawn
          // into its cache when it has changed, then blended over the sky.
          roomInputs.setText(0, p.side);
          roomInputs.set(1, lights);
          roomInputs.set(2, schedSeed);
          roomInputs.set(3, shown.from);
          roomInputs.set(4, shown.to);
          roomInputs.set(5, shown.image);
          const turn = Math.max(
            Math.abs(angleDiff(drawn.ha, shown.ha)),
            Math.abs(shown.dec - drawn.dec),
            Math.abs(angleDiff(drawn.dome, shown.dome)),
          );
          if (room.needsRedraw(roomInputs) || turn * TURN_REACH * FOCAL * height > REDRAW_PX) {
            room.bind();
            gl.useProgram(roomProgram);
            ru.f4("uFrame", width / 2, height / 2, p.side === "right" ? -1 : 1, FOCAL * height);
            ru.f3("uTube", tube[0], tube[1], tube[2]);
            ru.f3("uDec", dec[0], dec[1], dec[2]);
            ru.f3("uDome", Math.sin(shown.dome), -Math.cos(shown.dome), lights);
            ru.f4("uImgA", imgA.kind, imgA.angle, imgA.shapeA, imgA.shapeB);
            ru.f4("uImgB", imgB.kind, imgB.angle, imgB.shapeA, imgB.shapeB);
            ru.f1("uImgMix", shown.image);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            drawn.ha = shown.ha;
            drawn.dec = shown.dec;
            drawn.dome = shown.dome;
          }
          room.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
