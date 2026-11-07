import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
} from "../gl";
import { clamp } from "../math";
import { HASH32_GLSL, hash32 } from "../noise";
import { defineEffect } from "../types";
import {
  alertWash,
  BEACON_R,
  BEACON_Y,
  beaconAngle,
  beaconAzimuths,
  CALM_SLOT0,
  CAMERA_Z,
  CEILING_H,
  CONSOLE_BACK_H,
  CONSOLE_H,
  createLampBank,
  DECK_H,
  DOOR,
  EYE_H,
  LAMP_GROUP,
  LAMP_SLOTS,
  type LampBank,
  MAX_SEGMENTS,
  R_CONSOLE,
  R_CONSOLE_BACK,
  R_DECK,
  R_RAIL,
  R_WALL,
  RAIL_H,
  ringSegments,
  SCREEN_PERIOD,
  screenTime,
  stepAlert,
  stepLamps,
  TAN_HALF_FOV,
  wallPoint,
} from "./retrobridge-sim";
import { type Lighting, retrobridgeMeta } from "./retrobridge.meta";

const g = glslFloat;

/** Live-map codes (the blue channel): the top two bits are the kind, the rest a sub-index. */
const CODE_LAMP = 64;
const CODE_SCREEN = 128;
const CODE_BEACON = 192;

/** The three coloured washes on the walls (left, middle, right), per lighting choice. */
const WASHES: Record<Lighting, Float32Array> = {
  classic: new Float32Array([0.78, 0.22, 0.62, 0.18, 0.4, 0.5, 0.9, 0.45, 0.12]),
  cool: new Float32Array([0.12, 0.62, 0.62, 0.22, 0.32, 0.6, 0.5, 0.28, 0.85]),
  warm: new Float32Array([0.92, 0.46, 0.14, 0.5, 0.38, 0.22, 0.88, 0.22, 0.3]),
};

/**
 * The bridge, ray-cast once per resize, variation, lighting or door side, with
 * four samples per pixel. The camera stands before the command chair looking
 * at the back of the round room: the lower floor and the step up, the red
 * railing and its posts, the ring of consoles, and the wall behind them with
 * its lamp panels, black recesses of screens, pillars, a band of light under
 * the ceiling and, at one side, the red lift door. The chair's back and arms
 * sit in front of everything, behind the speaker.
 *
 * Pass 0 writes the colour, with the lamps at their lit colour and the screens
 * dark, and in alpha how much a surface takes the red alert's wash. Pass 1
 * writes the live map: what each pixel shows that changes per frame (a lamp's
 * slot, or a screen's or beacon's own coordinates in red and green), its code
 * in blue and its coverage in alpha.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform uint uSalt;
uniform int uPass;
uniform float uMirror;
uniform vec4 uSegs[${String(MAX_SEGMENTS)}];
uniform int uSegCount;
uniform vec2 uDoor;
uniform vec2 uBeaconA;
uniform vec3 uWash[3];
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
const float TAN_HALF = ${g(TAN_HALF_FOV)};
const float EYE_H = ${g(EYE_H)};
const float CAMERA_Z = ${g(CAMERA_Z)};
const float R_DECK = ${g(R_DECK)};
const float R_RAIL = ${g(R_RAIL)};
const float R_CONSOLE = ${g(R_CONSOLE)};
const float R_BACK = ${g(R_CONSOLE_BACK)};
const float R_WALL = ${g(R_WALL)};
const float DECK_H = ${g(DECK_H)};
const float CONSOLE_H = ${g(CONSOLE_H)};
const float BACK_H = ${g(CONSOLE_BACK_H)};
const float RAIL_H = ${g(RAIL_H)};
const float CEILING_H = ${g(CEILING_H)};
const float BEACON_Y = ${g(BEACON_Y)};
const float BEACON_R = ${g(BEACON_R)};
const float SLOPE = (BACK_H - CONSOLE_H) / (R_BACK - R_CONSOLE);
const float SLOPE_LEN = ${g(Math.hypot(CONSOLE_BACK_H - CONSOLE_H, R_CONSOLE_BACK - R_CONSOLE))};
const int DOOR = ${String(DOOR)};
const int CALM = 0;
const int STATION = 1;
const float CALM_SLOT0 = ${g(CALM_SLOT0)};
const float BUSY_GROUPS = ${g(CALM_SLOT0 / LAMP_GROUP)};
const float GROUP = ${g(LAMP_GROUP)};

const vec3 WALL = vec3(0.5, 0.54, 0.6);
const vec3 SOFFIT = vec3(0.3, 0.32, 0.38);
const vec3 PILLAR = vec3(0.62, 0.64, 0.68);
const vec3 PANEL = vec3(0.6, 0.6, 0.62);
const vec3 RECESS = vec3(0.022, 0.024, 0.028);
const vec3 CONSOLE = vec3(0.36, 0.37, 0.41);
const vec3 LIP = vec3(0.58, 0.59, 0.62);
const vec3 METAL = vec3(0.78, 0.79, 0.82);
const vec3 RAIL_RED = vec3(0.78, 0.07, 0.05);
const vec3 DOOR_RED = vec3(0.74, 0.15, 0.09);

float px;
vec3 gLight;
float gWash;
int gCode;
vec2 gUV;
float gCov;

float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
/** The far crossing of a ray from inside a circle of radius R round the y axis. */
float farRoot(vec2 o, vec2 d, float R) {
  float a = dot(d, d);
  float b = dot(o, d);
  float c = dot(o, o) - R * R;
  return (-b + sqrt(max(b * b - a * c, 0.0))) / a;
}
vec3 lit(vec3 c) {
  return c * gLight;
}

/** Stage lighting at azimuth th and height y: a cool fill, brighter high up, and three coloured pools. */
vec3 wallLight(float th, float y) {
  vec3 L = vec3(0.6) + 0.22 * smoothstep(0.6, 2.7, y);
  float v = exp(-pow((y - 1.9) / 0.95, 2.0));
  L += uWash[0] * exp(-pow((th + 0.72) / 0.26, 2.0)) * v;
  L += uWash[1] * 0.45 * exp(-pow(th / 0.3, 2.0)) * v;
  L += uWash[2] * exp(-pow((th - 0.68) / 0.26, 2.0)) * v;
  return L;
}

int segAt(float th, out vec4 seg, out int idx) {
  for (int i = 0; i < ${String(MAX_SEGMENTS)}; i++) {
    if (i >= uSegCount) {
      break;
    }
    vec4 s = uSegs[i];
    if (th >= s.x && th < s.y) {
      seg = s;
      idx = i;
      return int(s.z + 0.5);
    }
  }
  seg = vec4(th - 1.0, th + 1.0, -1.0, 0.0);
  idx = 15;
  return -1;
}

void setLive(int code, vec2 uv, float c) {
  if (c > 0.0 && c >= gCov) {
    gCode = code;
    gUV = uv;
    gCov = c;
  }
}

vec3 lampColour(uint h) {
  uint k = (h >> 3) % 8u;
  if (k == 0u) return vec3(1.0, 0.14, 0.08);
  if (k == 1u) return vec3(1.0, 0.45, 0.06);
  if (k == 2u) return vec3(1.0, 0.85, 0.18);
  if (k == 3u) return vec3(0.25, 0.95, 0.3);
  if (k == 4u) return vec3(0.22, 0.5, 1.0);
  if (k == 5u) return vec3(1.0, 0.95, 0.85);
  if (k == 6u) return vec3(0.15, 0.9, 0.85);
  return vec3(1.0, 0.3, 0.6);
}

/** A lamp's lens (signed distance d) in a dark bezel, at its lit colour; the composite dims it by its slot. */
vec3 lens(vec3 col, float d, vec3 glow, float slot) {
  col = mix(col, vec3(0.03), cover(d - 0.006));
  float c = cover(d);
  col = mix(col, glow, c);
  setLive(${String(CODE_LAMP)}, vec2(slot / 255.0, 0.0), c);
  return col;
}

/**
 * A row of lamps at height y0 across -w..w (q in metres), pitch apart, each hs
 * in half size. Colours are one per row (mixed = false) or one per lamp; busy
 * rows map onto one slot group so they can chase, calm rows onto calm slots.
 */
vec3 lampRow(vec3 col, vec2 q, float y0, float w, float pitch, vec2 hs, uint rh, bool calm, bool mixed) {
  float n = max(floor(2.0 * w / pitch), 1.0);
  float x0 = -0.5 * n * pitch;
  float i = clamp(floor((q.x - x0) / pitch), 0.0, n - 1.0);
  vec2 c = vec2(x0 + (i + 0.5) * pitch, y0);
  float d = sdBox(q - c, hs, min(hs.x, hs.y) * 0.3);
  if (d > 0.012) {
    return col;
  }
  uint lh = hash32(rh ^ (uint(i) * 0x9e3779b9u));
  vec3 glow = lampColour(mixed ? lh : rh);
  float slot = calm ? CALM_SLOT0 + float(lh % 32u)
    : float(rh % uint(BUSY_GROUPS)) * GROUP + mod(i, GROUP);
  return lens(col, d, glow, slot);
}

/** A row of chunky toggle switches on chrome plates, levers up or down, with coloured knobs. */
vec3 toggleRow(vec3 col, vec2 q, float y0, float w, float pitch, uint rh) {
  float n = max(floor(2.0 * w / pitch), 1.0);
  float x0 = -0.5 * n * pitch;
  float i = clamp(floor((q.x - x0) / pitch), 0.0, n - 1.0);
  vec2 o = q - vec2(x0 + (i + 0.5) * pitch, y0);
  if (abs(o.x) > 0.5 * pitch || abs(o.y) > 0.06) {
    return col;
  }
  uint th = hash32(rh ^ (uint(i) * 0x85ebca6bu));
  float db = sdBox(o, vec2(0.019, 0.027), 0.006);
  col *= 1.0 - 0.35 * cover(sdBox(o - vec2(0.004, -0.005), vec2(0.019, 0.027), 0.008));
  col = mix(col, lit(METAL * (0.85 + 0.15 * o.y / 0.027)), cover(db));
  float dir = (th & 3u) == 0u ? -1.0 : 1.0;
  vec2 tip = vec2(0.0, dir * 0.034);
  col *= 1.0 - 0.4 * cover(sdSeg(o - vec2(0.006, -0.008), vec2(0.0), tip) - 0.008);
  float dl = sdSeg(o, vec2(0.0), tip) - 0.0055;
  col = mix(col, lit(METAL * (1.0 - 0.35 * clamp(o.x / 0.0055, -1.0, 1.0))), cover(dl));
  uint kc = (th >> 4) % 3u;
  vec3 knob = kc == 0u ? vec3(0.04) : kc == 1u ? vec3(0.75, 0.08, 0.05) : vec3(0.85);
  vec2 kq = (o - tip) / 0.011;
  col = mix(col, lit(knob * (0.8 + 0.35 * clamp(kq.y - 0.4 * kq.x, -1.0, 1.0))), cover(length(o - tip) - 0.011));
  return col;
}

/** A small screen in a grey bezel: dark glass here, its picture drawn live. */
vec3 screen(vec3 col, vec2 q, vec2 c, vec2 hs, uint h, int idx) {
  float d = sdBox(q - c, hs, 0.014);
  if (d > 0.03) {
    return col;
  }
  col = mix(col, lit(vec3(0.42, 0.43, 0.46)), cover(d - 0.02));
  col = mix(col, vec3(0.08), cover(d - 0.007));
  float glass = cover(d);
  col = mix(col, vec3(0.012, 0.018, 0.02), glass);
  vec2 uv = clamp((q - c + hs) / (2.0 * hs), 0.0, 1.0);
  int type = int(h % 4u);
  setLive(${String(CODE_SCREEN)} + type * 16 + (idx & 15), uv, glass);
  return col;
}

/** A station's wall: a lamp panel over its console, and above it a black recess of screens and lamps. */
vec3 stationWall(vec3 col, vec2 q, float hw, uint h, int idx) {
  float pw = hw - 0.06;
  float dp = sdBox(q - vec2(0.0, 1.43), vec2(pw, 0.165), 0.015);
  if (dp < 0.02) {
    col *= 1.0 - 0.3 * cover(dp - 0.012);
    col = mix(col, lit(PANEL), cover(dp));
    if (dp < 0.0) {
      uint r0 = hash32(h + 1u);
      uint r1 = hash32(h + 2u);
      uint r2 = hash32(h + 3u);
      col = lampRow(col, q, 1.53, pw - 0.03, 0.078, vec2(0.028, 0.016), r0, false, (r0 & 1u) == 0u);
      col = lampRow(col, q, 1.45, pw - 0.03, 0.078, vec2(0.028, 0.016), r1, false, (r1 & 1u) == 0u);
      if (((h >> 7) & 1u) == 0u) {
        col = toggleRow(col, q, 1.335, pw - 0.03, 0.07, r2);
      } else {
        col = lampRow(col, q, 1.335, pw - 0.03, 0.062, vec2(0.021, 0.021), r2, false, true);
      }
    }
  }
  float rw = hw - 0.08;
  float dr = sdBox(q - vec2(0.0, 2.08), vec2(rw, 0.36), 0.035);
  if (dr < 0.03) {
    // A lit lip round the recess, brighter along its top.
    col = mix(col, col * (q.y > 2.08 ? 1.25 : 0.7), cover(dr - 0.018) - cover(dr - 0.006));
    col = mix(col, RECESS, cover(dr));
    if (dr < 0.0) {
      int type = int((h >> 9) % 3u);
      if (type == 0) {
        col = screen(col, q, vec2(-0.5 * rw + 0.01, 2.17), vec2(0.42 * rw, 0.165), hash32(h + 5u), idx * 2);
        col = screen(col, q, vec2(0.5 * rw - 0.01, 2.17), vec2(0.42 * rw, 0.165), hash32(h + 6u), idx * 2 + 1);
        col = lampRow(col, q, 1.85, rw - 0.05, 0.062, vec2(0.019, 0.019), hash32(h + 7u), false, true);
      } else if (type == 1) {
        col = screen(col, q, vec2(-0.14 * rw, 2.15), vec2(0.72 * rw, 0.2), hash32(h + 5u), idx * 2);
        vec2 qc = vec2(q.y - 2.15, q.x);
        col = lampRow(col, qc, 0.87 * rw, 0.2, 0.08, vec2(0.02, 0.026), hash32(h + 8u), false, false);
        col = lampRow(col, q, 1.85, rw - 0.05, 0.078, vec2(0.028, 0.015), hash32(h + 7u), false, false);
      } else {
        vec2 ql = vec2(q.x + 0.32 * rw, q.y);
        for (int k = 0; k < 4; k++) {
          uint rk = hash32(h + 20u + uint(k));
          col = lampRow(col, ql, 2.3 - float(k) * 0.12, 0.6 * rw, 0.07, vec2(0.024, 0.018), rk, false, (rk & 3u) == 0u);
        }
        col = screen(col, q, vec2(0.64 * rw, 2.14), vec2(0.3 * rw, 0.17), hash32(h + 5u), idx * 2 + 1);
      }
    }
  }
  return col;
}

/** The calm wall behind the speaker: plain panels, an empty inset, and one strip of slow lamps. */
vec3 calmWall(vec3 col, vec2 q, float hw, uint h) {
  float seam = abs(fract(q.x / 0.64 + 0.5) - 0.5) * 0.64;
  col *= 1.0 - 0.18 * cover(seam - 0.004) * step(1.68, q.y) * step(q.y, 2.48);
  float dr = sdBox(q - vec2(0.0, 2.08), vec2(hw - 0.08, 0.36), 0.035);
  col = mix(col, col * (q.y > 2.08 ? 1.15 : 0.8), cover(dr) - cover(dr + 0.012));
  col = mix(col, col * 0.9, cover(dr + 0.012));
  float ds = sdBox(q - vec2(0.0, 1.44), vec2(hw - 0.12, 0.034), 0.012);
  col = mix(col, vec3(0.05), cover(ds));
  if (ds < 0.0) {
    col = lampRow(col, q, 1.44, hw - 0.16, 0.17, vec2(0.024, 0.014), hash32(h + 9u), true, true);
  }
  return col;
}

/** The lift door's bay: red double doors in a dark frame, a red call panel beside them, a lamp above. */
vec3 doorWall(vec3 col, vec2 q, uint h) {
  vec2 dc = vec2(0.08, 0.5 * (DECK_H + 2.3));
  vec2 dh = vec2(0.4, 0.5 * (2.3 - DECK_H));
  float d = sdBox(q - dc, dh, 0.0);
  col = mix(col, lit(vec3(0.7, 0.71, 0.73)), cover(d - 0.07));
  col = mix(col, vec3(0.04), cover(d - 0.03));
  float shade = 0.82 + 0.18 * (q.y - DECK_H) / (2.3 - DECK_H);
  vec3 leaf = lit(DOOR_RED * shade);
  float seam = abs(q.x - dc.x);
  leaf *= 1.0 - 0.7 * cover(seam - 0.005);
  leaf *= 1.0 + 0.25 * cover(abs(q.x - dc.x - 0.014) - 0.003);
  col = mix(col, leaf, cover(d));
  // The call panel.
  float dp = sdBox(q - vec2(-0.49, 1.52), vec2(0.055, 0.3), 0.012);
  col = mix(col, vec3(0.05), cover(dp - 0.01));
  col = mix(col, lit(vec3(0.7, 0.08, 0.06)), cover(dp));
  if (dp < 0.0) {
    col = lampRow(col, vec2(q.y - 1.52, q.x), -0.49, 0.22, 0.11, vec2(0.022, 0.022), hash32(h + 11u), true, true);
  }
  // A lamp over the door.
  float dl = sdBox(q - vec2(dc.x, 2.42), vec2(0.11, 0.022), 0.008);
  col = lens(col, dl, vec3(1.0, 0.9, 0.6), CALM_SLOT0 + float(hash32(h + 12u) % 32u));
  return col;
}

/** The back wall at p. */
vec3 wall(vec3 p) {
  float th = atan(p.x, p.z);
  float y = p.y;
  vec4 seg;
  int idx;
  int kind = segAt(th, seg, idx);
  gLight = wallLight(th, y);
  gWash = 1.0;
  float s = th * R_WALL;
  float s0 = seg.x * R_WALL;
  float s1 = seg.y * R_WALL;
  float hw = 0.5 * (s1 - s0);
  vec2 q = vec2(s - 0.5 * (s0 + s1), y);
  uint h = hash32(uint(idx) * 0x632be5abu ^ uSalt);
  vec3 col = lit(WALL);
  if (y < BACK_H + 0.04 && kind != DOOR) {
    col = lit(CONSOLE * 0.6);
  }
  // Trim: a ledge over the lamp panels, and one under the band of light.
  col = mix(col, lit(PILLAR), cover(abs(y - 1.65) - 0.025));
  col *= 1.0 - 0.25 * cover(abs(y - 1.622) - 0.004);
  if (y > 2.48) {
    col = lit(SOFFIT);
    col = mix(col, lit(vec3(0.4, 0.41, 0.45)), cover(abs(y - 2.52) - 0.04));
    col *= 1.0 - 0.3 * cover(abs(y - 2.565) - 0.004);
    // The band of light under the ceiling.
    vec3 band = vec3(0.95, 0.9, 0.8) * 0.85 + 0.25 * gLight * 0.3;
    col = mix(col, band, cover(abs(y - 2.63) - 0.022));
    col *= 1.0 - 0.35 * smoothstep(2.75, 3.0, y);
  }
  if (kind == STATION) {
    col = stationWall(col, q, hw, h, idx);
  } else if (kind == CALM) {
    col = calmWall(col, q, hw, h);
  } else if (kind == DOOR) {
    col = doorWall(col, q, h);
  }
  // Pillars between segments.
  float dpil = min(s - s0, s1 - s) - 0.036;
  if (dpil < px) {
    float e = clamp(min(s - s0, s1 - s) / 0.036, 0.0, 1.0);
    vec3 pil = lit(PILLAR * (0.75 + 0.25 * e));
    col = mix(col, pil, cover(dpil) * step(DECK_H, y));
  }
  // The alert beacons: dark red domes on little plates.
  for (int b = 0; b < 2; b++) {
    float bs = (b == 0 ? uBeaconA.x : uBeaconA.y) * R_WALL;
    vec2 bq = vec2(s - bs, y - BEACON_Y);
    if (abs(bq.x) < 0.2 && abs(bq.y) < 0.2) {
      col = mix(col, lit(vec3(0.25)), cover(sdBox(bq + vec2(0.0, 0.07), vec2(0.13, 0.025), 0.008)));
      float dd = length(bq) - BEACON_R;
      vec2 n = bq / BEACON_R;
      vec3 dome = vec3(0.32, 0.03, 0.025) * (0.7 + 0.5 * clamp(n.y - 0.4 * n.x, -1.0, 1.0));
      dome += vec3(0.25) * exp(-dot(n - vec2(-0.35, 0.45), n - vec2(-0.35, 0.45)) * 18.0);
      float c = cover(dd);
      col = mix(col, dome, c);
      setLive(${String(CODE_BEACON)} + b, bq / (2.0 * BEACON_R) + 0.5, c);
    }
  }
  return col;
}

/** The face of a console turned to the captain: dark, with a light lip and a dark kick plate. */
vec3 consoleFront(vec3 p, vec4 seg, int kind, uint h) {
  float th = atan(p.x, p.z);
  gLight = wallLight(th, p.y) * 0.9;
  gWash = 0.6;
  vec3 col = lit(CONSOLE);
  if (kind == STATION) {
    col = mix(col, lit(lampColour(h) * 0.45), cover(abs(p.y - 0.84) - 0.012));
  }
  col = mix(col, lit(LIP), cover(abs(p.y - (CONSOLE_H - 0.025)) - 0.025));
  col = mix(col, vec3(0.05), cover(p.y - (DECK_H + 0.07)));
  float s = th * R_CONSOLE;
  float e = min(s - seg.x * R_CONSOLE, seg.y * R_CONSOLE - s);
  col *= 1.0 - 0.5 * cover(e - 0.006);
  // Shade towards the floor, as the stage light falls off.
  col *= 0.7 + 0.3 * smoothstep(DECK_H, CONSOLE_H, p.y);
  return col;
}

/** The sloping top of a console: black, with rows of square buttons at stations, a few slow ones elsewhere. */
vec3 consoleTop(vec3 p, vec4 seg, int kind, uint h) {
  float th = atan(p.x, p.z);
  float r = length(p.xz);
  float v = (r - R_CONSOLE) / (R_BACK - R_CONSOLE) * SLOPE_LEN;
  float rm = 0.5 * (R_CONSOLE + R_BACK);
  vec2 q = vec2((th - 0.5 * (seg.x + seg.y)) * rm, v);
  float hw = 0.5 * (seg.y - seg.x) * rm;
  gLight = wallLight(th, p.y) * 0.7;
  gWash = 0.6;
  vec3 col = lit(vec3(0.07, 0.07, 0.08));
  col = mix(col, lit(LIP * 0.9), cover(v - 0.03));
  if (kind == STATION) {
    for (int k = 0; k < 3; k++) {
      uint rk = hash32(h + 40u + uint(k));
      col = lampRow(col, q, 0.14 + float(k) * 0.13, hw - 0.08, 0.072, vec2(0.025, 0.025), rk, false, true);
    }
  } else if (seg.z > -0.5) {
    col = lampRow(col, q, 0.27, hw - 0.2, 0.26, vec2(0.025, 0.025), hash32(h + 41u), true, true);
  }
  float e = min(q.x + hw, hw - q.x);
  col *= 1.0 - 0.5 * cover(e - 0.006);
  return col;
}

/** The ceiling: dark, with a ring of cove light near the wall and radial ribs. */
vec3 ceiling(vec3 p) {
  float r = length(p.xz);
  float th = atan(p.x, p.z);
  gLight = vec3(1.0);
  gWash = 0.6;
  vec3 col = vec3(0.075, 0.075, 0.09);
  col += vec3(0.75, 0.72, 0.66) * smoothstep(3.95, 4.05, r) * (1.0 - smoothstep(4.3, 4.4, r));
  col += vec3(0.06) * (1.0 - smoothstep(2.6, 2.7, r));
  float rib = abs(fract(th / 0.3927 + 0.5) - 0.5) * 0.3927 * r;
  col *= 1.0 - 0.25 * cover(rib - 0.015);
  return col;
}

vec3 deckFloor(vec3 p) {
  float r = length(p.xz);
  gLight = wallLight(atan(p.x, p.z), 0.8) * 0.6;
  gWash = 0.5;
  vec3 col = lit(vec3(0.24, 0.22, 0.25));
  col *= 1.0 - 0.45 * smoothstep(R_CONSOLE - 0.12, R_CONSOLE, r);
  return col;
}

vec3 lowerFloor(vec3 p) {
  float r = length(p.xz);
  gLight = vec3(1.0);
  gWash = 0.5;
  return vec3(0.16, 0.15, 0.17) * (0.8 + 0.35 * exp(-r * r / 5.0));
}

/** The step up to the deck: dark, with a light trim along its edge and a faint light strip low down. */
vec3 riser(vec3 p) {
  gLight = vec3(1.0);
  gWash = 0.5;
  vec3 col = vec3(0.1, 0.1, 0.115);
  col = mix(col, vec3(0.5, 0.5, 0.53), cover(abs(p.y - (DECK_H - 0.02)) - 0.02));
  col = mix(col, vec3(0.55, 0.5, 0.42), cover(abs(p.y - 0.07) - 0.008));
  return col;
}

/** Everything behind the railing along the ray. */
vec3 back(vec3 ro, vec3 rd, float k) {
  float tC = farRoot(ro.xz, rd.xz, R_CONSOLE);
  vec3 pC = ro + rd * tC;
  vec4 seg;
  int idx;
  int kindC = segAt(atan(pC.x, pC.z), seg, idx);
  uint h = hash32(uint(idx) * 0x632be5abu ^ uSalt);
  if (rd.y < 0.0) {
    float t = (DECK_H - ro.y) / rd.y;
    vec3 p = ro + rd * t;
    float r = length(p.xz);
    vec4 sd;
    int id2;
    if (r < R_CONSOLE || (r < R_WALL && segAt(atan(p.x, p.z), sd, id2) == DOOR)) {
      px = t * k;
      return deckFloor(p);
    }
  }
  if (kindC != DOOR) {
    if (pC.y < CONSOLE_H) {
      px = tC * k;
      return consoleFront(pC, seg, kindC, h);
    }
    float tB = farRoot(ro.xz, rd.xz, R_BACK);
    vec3 pB = ro + rd * tB;
    if (pB.y < BACK_H) {
      float a = tC;
      float b = tB;
      for (int i = 0; i < 12; i++) {
        float m = 0.5 * (a + b);
        vec3 pm = ro + rd * m;
        if (pm.y - (CONSOLE_H + (length(pm.xz) - R_CONSOLE) * SLOPE) > 0.0) {
          a = m;
        } else {
          b = m;
        }
      }
      float t = 0.5 * (a + b);
      px = t * k;
      return consoleTop(ro + rd * t, seg, kindC, h);
    }
  }
  float tW = farRoot(ro.xz, rd.xz, R_WALL);
  vec3 pW = ro + rd * tW;
  if (pW.y < CEILING_H) {
    px = tW * k;
    return wall(pW);
  }
  float t = (CEILING_H - ro.y) / max(rd.y, 1e-4);
  px = t * k;
  return ceiling(ro + rd * t);
}

/** The red railing and its posts at p (on the railing's cylinder), over col. Open in front of the door. */
vec3 railing(vec3 p, vec3 col) {
  float th = atan(p.x, p.z);
  float s = th * R_RAIL;
  float g0 = (uDoor.x + 0.01) * R_RAIL;
  float g1 = (uDoor.y - 0.01) * R_RAIL;
  // Positive outside the gap, negative inside it.
  float dg = max(g0 - s, s - g1);
  float outside = cover(-dg);
  float dy = p.y - RAIL_H;
  float tube = cover(abs(dy) - 0.035) * outside;
  float pitch = 0.105 * R_RAIL;
  float sp = abs(s - pitch * floor(s / pitch + 0.5));
  sp = min(sp, min(abs(s - g0), abs(s - g1)));
  float post = cover(sp - 0.016) * step(DECK_H, p.y) * step(p.y, RAIL_H) * cover(-dg - 0.02);
  float n = clamp(dy / 0.035, -1.0, 1.0);
  vec3 rail = RAIL_RED * (0.55 + 0.4 * n) + vec3(0.45, 0.3, 0.3) * exp(-pow((n - 0.55) / 0.18, 2.0));
  vec3 pole = METAL * 0.55 * (0.7 + 0.3 * (1.0 - sp / 0.016));
  col = mix(col, pole, post);
  col = mix(col, rail, tube);
  float c = max(tube, post);
  gCov *= 1.0 - c;
  gWash = mix(gWash, 0.4, c);
  return col;
}

/** The command chair's back and arm ends, in front of everything, behind the speaker. */
vec3 chair(vec2 f, vec3 col) {
  float ds = sdBox(f - vec2(0.0, -0.385), vec2(0.165, 0.165), 0.05);
  if (ds < 0.01) {
    col = mix(col, col * 0.5, cover(ds - 0.008));
    vec3 shell = vec3(0.3, 0.31, 0.34) * (0.8 + 0.3 * clamp((f.y + 0.3) / 0.1, -1.0, 1.0));
    col = mix(col, shell, cover(ds));
    float dp = sdBox(f - vec2(0.0, -0.39), vec2(0.14, 0.14), 0.04);
    col = mix(col, vec3(0.05, 0.05, 0.06) * (1.0 + 0.4 * smoothstep(-0.28, -0.25, f.y)), cover(dp));
    col *= 1.0 - 0.35 * cover(abs(f.x) - 0.003) * cover(dp + 0.02);
    gWash = mix(gWash, 0.2, cover(ds));
    gCov *= 1.0 - cover(ds);
  }
  for (int sgn = -1; sgn <= 1; sgn += 2) {
    vec2 a = f - vec2(float(sgn) * 0.255, -0.47);
    float da = sdBox(a, vec2(0.065, 0.04), 0.012);
    if (da < 0.01) {
      col = mix(col, vec3(0.03), cover(da - 0.006));
      col = mix(col, vec3(0.24, 0.25, 0.28) * (0.85 + 0.2 * a.y / 0.04), cover(da));
      gWash = mix(gWash, 0.2, cover(da));
      gCov *= 1.0 - cover(da);
      float x = a.x * float(sgn);
      float i = clamp(floor((x + 0.045) / 0.03), 0.0, 2.0);
      vec2 b = vec2(x - (-0.03 + i * 0.03), a.y - 0.008);
      float db = sdBox(b, vec2(0.009, 0.009), 0.002);
      uint bh = hash32(uSalt ^ uint(i + 3.0 * float(sgn + 1)));
      col = lens(col, db, lampColour(bh), CALM_SLOT0 + float(bh % 32u));
    }
  }
  return col;
}

vec3 scene(vec2 f) {
  gWash = 1.0;
  gCode = 0;
  gCov = 0.0;
  gUV = vec2(0.0);
  vec3 ro = vec3(0.0, EYE_H, CAMERA_Z);
  vec3 rd = normalize(vec3(f * (2.0 * TAN_HALF), 1.0));
  float k = 2.0 * TAN_HALF / uRes.y;
  vec3 col;
  bool done = false;
  if (rd.y < 0.0) {
    float t = -ro.y / rd.y;
    vec3 p = ro + rd * t;
    if (length(p.xz) < R_DECK) {
      px = t * k;
      col = lowerFloor(p);
      done = true;
    }
  }
  if (!done) {
    float tD = farRoot(ro.xz, rd.xz, R_DECK);
    vec3 pD = ro + rd * tD;
    if (pD.y < DECK_H) {
      px = tD * k;
      col = riser(pD);
    } else {
      col = back(ro, rd, k);
      float tR = farRoot(ro.xz, rd.xz, R_RAIL);
      px = tR * k;
      col = railing(ro + rd * tR, col);
    }
  }
  px = 1.0 / uRes.y;
  col = chair(vec2(f.x * uMirror, f.y), col);
  // A soft stage vignette.
  vec2 v = f / vec2(0.5 * uRes.x / uRes.y + 0.15, 0.62);
  col *= 1.0 - 0.3 * smoothstep(0.45, 1.05, dot(v, v));
  return col;
}

void main() {
  vec2 c = gl_FragCoord.xy - 0.5 * uRes;
  vec3 sum = vec3(0.0);
  float wash = 0.0;
  int code = 0;
  vec2 uv = vec2(0.0);
  float cov = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (c + o) / uRes.y;
    f.x *= uMirror;
    sum += scene(f);
    wash += gWash;
    if (gCode != 0) {
      if (code == 0) {
        code = gCode;
        uv = gUV;
      }
      if (gCode == code) {
        cov += gCov;
      }
    }
  }
  if (uPass == 0) {
    outColor = vec4(sum * 0.25 + dither8(gl_FragCoord.xy), wash * 0.25);
  } else {
    outColor = vec4(uv, float(code) / 255.0, cov * 0.25);
  }
}
`;

/**
 * Per frame: the cached room, its lamps dimmed and brightened by their slots,
 * the screens' pictures (colour bars, an oscilloscope trace, a turning pattern
 * or a bar graph), and under red alert the pulsing red wash and the beacons'
 * turning glow.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uRoom;
uniform sampler2D uLive;
uniform sampler2D uLamps;
uniform vec2 uRes;
uniform float uTime;
/** Eased alert level, red wash strength, and the beacons' turn as cos and sin. */
uniform vec4 uAlert;
/** The two beacons' centres in frame units. */
uniform vec4 uBeacons;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
const float TAU = 6.28318530718;

/** A cycle of n whole turns per screen period: continuous as the clock wraps. */
float cyc(float n) {
  return fract(uTime * n / ${g(SCREEN_PERIOD)});
}

vec3 pal(float i) {
  int k = int(mod(i, 6.0));
  if (k == 0) return vec3(1.0, 0.15, 0.1);
  if (k == 1) return vec3(1.0, 0.55, 0.08);
  if (k == 2) return vec3(1.0, 0.92, 0.2);
  if (k == 3) return vec3(0.2, 0.9, 0.35);
  if (k == 4) return vec3(0.2, 0.45, 1.0);
  return vec3(0.9, 0.25, 0.8);
}

/** Colour bars that step round one place every ten seconds, cross-fading over a second and a half. */
vec3 bars(vec2 uv, float idx) {
  float i = floor(uv.x * 6.0);
  float ph = uTime / 10.0 + idx;
  float k = floor(ph);
  float fr = smoothstep(0.85, 1.0, ph - k);
  vec3 c = mix(pal(i + k), pal(i + k + 1.0), fr);
  return c * (uv.y > 0.2 ? 0.8 : 0.35);
}

/** A green oscilloscope trace, drifting and slowly changing height, over a faint grid. */
vec3 scope(vec2 uv, float idx) {
  vec2 gq = abs(fract(uv * vec2(5.0, 4.0)) - 0.5);
  vec3 col = vec3(0.02, 0.06, 0.045) + vec3(0.03, 0.08, 0.06) * step(0.47, max(gq.x, gq.y));
  float fq = 1.5 + mod(idx, 3.0);
  float amp = 0.28 * (0.7 + 0.3 * sin(TAU * cyc(13.0 + idx)));
  float a = TAU * (fq * uv.x - cyc(150.0 + 10.0 * idx));
  float y = 0.5 + amp * (sin(a) + 0.25 * sin(3.0 * a + TAU * cyc(7.0)));
  float dy = amp * TAU * fq * (cos(a) + 0.75 * cos(3.0 * a + TAU * cyc(7.0)));
  float d = abs(uv.y - y) / sqrt(1.0 + dy * dy * 0.6);
  float tr = 1.0 - smoothstep(0.012, 0.03, d);
  col += vec3(0.35, 1.0, 0.55) * tr + vec3(0.05, 0.2, 0.1) * exp(-d * 20.0);
  return col;
}

/** A coloured pinwheel turning about once every twelve seconds. */
vec3 pinwheel(vec2 uv, float idx) {
  vec2 p = (uv - 0.5) * vec2(1.35, 1.0);
  float r = length(p);
  float dir = mod(idx, 2.0) < 0.5 ? 1.0 : -1.0;
  float a = atan(p.y, p.x) / TAU + dir * cyc(50.0);
  float s = fract(a * 4.0 + r * 2.5);
  float k = floor(fract(a * 4.0 + r * 2.5 + 0.5 * floor(idx / 2.0)) * 4.0);
  vec3 c = pal(k + idx);
  c *= 0.55 + 0.45 * smoothstep(0.0, 0.08, s) * smoothstep(1.0, 0.92, s);
  c *= 1.0 - smoothstep(0.4, 0.46, r);
  return c * 0.85 + vec3(0.02, 0.02, 0.05);
}

/** A bar graph whose bars rise and fall over ten to thirty seconds. */
vec3 graph(vec2 uv, float idx) {
  float i = floor(uv.x * 8.0);
  float x = fract(uv.x * 8.0);
  uint h = hash32(uint(i + 8.0 * idx) * 0x9e3779b9u);
  float n = 20.0 + float(h % 41u);
  float hgt = 0.15 + 0.7 * (0.5 + 0.5 * sin(TAU * cyc(n) + float(h >> 8) * 0.001));
  vec3 bg = vec3(0.02, 0.03, 0.08);
  float on = step(0.15, x) * step(x, 0.85) * step(uv.y, hgt);
  vec3 bar = mix(vec3(1.0, 0.55, 0.1), vec3(1.0, 0.9, 0.3), uv.y);
  return mix(bg, bar * 0.85, on);
}

vec3 screenColour(vec2 uv, int sub) {
  int type = sub >> 4;
  float idx = float(sub & 15);
  if (type == 0) return bars(uv, idx);
  if (type == 1) return scope(uv, idx);
  if (type == 2) return pinwheel(uv, idx);
  return graph(uv, idx);
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 room = texelFetch(uRoom, ij, 0);
  vec4 live = texelFetch(uLive, ij, 0);
  vec3 col = room.rgb;
  float level = uAlert.x;
  if (live.a > 0.0) {
    int code = int(live.b * 255.0 + 0.5);
    int kind = code >> 6;
    if (kind == 1) {
      float b = texelFetch(uLamps, ivec2(int(live.r * 255.0 + 0.5), 0), 0).r;
      col = mix(col, room.rgb * mix(0.2, 1.15, b), live.a);
    } else if (kind == 2) {
      col = mix(col, screenColour(live.rg, code & 63), live.a);
    } else if (level > 0.0) {
      // A beacon's dome: a lamp turning inside it, a bright band crossing as it faces us.
      float sgn = (code & 1) == 0 ? 1.0 : -1.0;
      float face = max(uAlert.z * sgn, 0.0);
      float side = uAlert.w * sgn;
      vec2 d = live.rg * 2.0 - 1.0;
      float band = exp(-pow((d.x - 0.8 * side) / 0.4, 2.0)) * face;
      col += vec3(1.0, 0.12, 0.06) * level * (0.3 + 1.1 * band) * live.a;
    }
  }
  if (level > 0.0) {
    float w = room.a * uAlert.y;
    col = mix(col, col * vec3(1.3, 0.42, 0.38) + vec3(0.05, 0.0, 0.0), w);
    vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
    for (int b = 0; b < 2; b++) {
      vec2 c = b == 0 ? uBeacons.xy : uBeacons.zw;
      float sgn = b == 0 ? 1.0 : -1.0;
      float face = max(uAlert.z * sgn, 0.0);
      vec2 q = f - c;
      float halo = exp(-dot(q, q) / 0.0016) * (0.12 + 0.3 * face);
      vec2 spot = q - vec2(0.13 * uAlert.w * sgn, -0.035);
      float thrown = exp(-dot(spot, spot) / 0.008) * 0.3 * (1.0 - face) * room.a;
      col += vec3(1.0, 0.14, 0.08) * level * (halo + thrown);
    }
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Standing before the command chair of a 1960s TV starship's round bridge:
 * the ring of stations round the back wall behind a red railing, rows of
 * coloured lamps blinking slowly, small screens of colour bars, traces and
 * turning patterns, a red lift door at one side, and flat, coloured stage
 * lighting. The wall behind the speaker stays plain, with only slow lamps.
 * Under red alert the walls wash red in a slow pulse and two beacons turn.
 */
export const retrobridge = defineEffect(retrobridgeMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => {
          gl.deleteProgram(p);
        });
      const roomProgram = program(ROOM_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, [
        "uRes",
        "uSalt",
        "uPass",
        "uMirror",
        "uSegs",
        "uSegCount",
        "uDoor",
        "uBeaconA",
        "uWash",
      ]);
      const cu = createUniforms(gl, compProgram, [
        "uRoom",
        "uLive",
        "uLamps",
        "uRes",
        "uTime",
        "uAlert",
        "uBeacons",
      ]);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uLive", 1);
      cu.i1("uLamps", 2);
      gl.useProgram(null);

      const lampBytes = new Uint8Array(LAMP_SLOTS);
      const lampTex = scope.add(
        createDataTexture(gl, {
          width: LAMP_SLOTS,
          height: 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: lampBytes,
          filter: gl.NEAREST,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const segments = ringSegments();
      const segData = new Float32Array(MAX_SEGMENTS * 4);
      segments.slice(0, MAX_SEGMENTS).forEach((s, i) => {
        segData.set([s.a0, s.a1, s.kind, i], i * 4);
      });
      const door = segments.find((s) => s.kind === DOOR) ?? { a0: 0, a1: 0 };
      const [beaconA, beaconB] = beaconAzimuths();
      const beacons = new Float64Array(4);
      const point = new Float64Array(2);

      let room: RenderTarget | null = null;
      let live: RenderTarget | null = null;
      scope.defer(() => {
        room?.dispose();
        live?.dispose();
      });
      let width = 1;
      let height = 1;
      let roomKey = "";

      let time = 0;
      let alert = 0;
      let bank: LampBank = createLampBank(0);
      let bankSeed = Number.NaN;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          room?.dispose();
          live?.dispose();
          room = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          live = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          roomKey = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!room || !live) {
            return;
          }
          const seed = Math.floor(clamp(Number.isFinite(p.seed) ? p.seed : 0, 0, 999));
          const mirror = p.door === "left" ? -1 : 1;
          const lighting: Lighting =
            p.lighting === "cool" || p.lighting === "warm" ? p.lighting : "classic";

          // 1. The room and its live map, when the size or a setting that shapes it changes.
          const key = `${String(seed)}|${String(mirror)}|${lighting}`;
          if (key !== roomKey) {
            roomKey = key;
            gl.useProgram(roomProgram);
            ru.f2("uRes", width, height);
            ru.u1("uSalt", hash32(seed + 0x3c6ef372));
            ru.f1("uMirror", mirror);
            gl.uniform4fv(ru.loc.uSegs, segData);
            ru.i1("uSegCount", Math.min(MAX_SEGMENTS, segments.length));
            ru.f2("uDoor", door.a0, door.a1);
            ru.f2("uBeaconA", beaconA, beaconB);
            gl.uniform3fv(ru.loc.uWash, WASHES[lighting]);
            for (const [pass, target] of [
              [0, room],
              [1, live],
            ] as const) {
              ru.i1("uPass", pass);
              target.bind();
              triangle.draw();
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. The lamps.
          if (seed !== bankSeed) {
            bankSeed = seed;
            bank = createLampBank(seed);
          }
          stepLamps(bank, step, p.activity, lampBytes);
          gl.activeTexture(gl.TEXTURE2);
          updateDataTexture(gl, lampTex, LAMP_SLOTS, 1, gl.RED, gl.UNSIGNED_BYTE, lampBytes);

          // 3. Red alert, and the beacons' places in the frame.
          alert = stepAlert(alert, p.alert === "red", step);
          const turn = beaconAngle(time);
          wallPoint(beaconA, BEACON_Y, point);
          beacons[0] = point[0] * mirror;
          beacons[1] = point[1];
          wallPoint(beaconB, BEACON_Y, point);
          beacons[2] = point[0] * mirror;
          beacons[3] = point[1];

          // 4. Composite.
          gl.useProgram(compProgram);
          cu.f2("uRes", width, height);
          cu.f1("uTime", screenTime(time));
          cu.f4("uAlert", alert, alertWash(alert, time), Math.cos(turn), Math.sin(turn));
          cu.f4("uBeacons", beacons[0], beacons[1], beacons[2], beacons[3]);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, live.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
