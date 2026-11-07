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
  FACE_TOP,
  LAMP_GROUP,
  LAMP_SLOTS,
  type LampBank,
  MAX_SEGMENTS,
  R_CONSOLE,
  R_CONSOLE_BACK,
  R_CHAIR,
  R_DECK,
  R_RAIL,
  R_WALL,
  RAIL_H,
  RAIL_T,
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

/**
 * The stage lighting per choice: a base tint for the flat, even key light,
 * then three faint coloured pools (left, middle and right) on top of it.
 */
const WASHES: Record<Lighting, Float32Array> = {
  classic: new Float32Array([0.93, 0.95, 1.0, 0.03, 0.04, 0.1, 0.0, 0.02, 0.05, 0.05, 0.03, 0.08]),
  cool: new Float32Array([0.84, 0.92, 1.04, 0.0, 0.08, 0.16, 0.0, 0.04, 0.1, 0.02, 0.06, 0.18]),
  warm: new Float32Array([1.02, 0.95, 0.88, 0.14, 0.06, 0.0, 0.06, 0.04, 0.0, 0.12, 0.03, 0.06]),
};

/**
 * The bridge, ray-cast once per resize, variation, lighting or door side, with
 * four samples per pixel. The camera stands before the command chair looking
 * at the back of the round room: the carpeted lower well and the step up, the
 * red padded railing on its black posts, swivel chairs at some stations, the
 * ring of black consoles (a red-trimmed desk of jewel buttons over pale,
 * blue-lit knee panels), and the wall behind them: a black face of framed lamp
 * tiles, then pale panels with a band of framed screens, and at one side a red
 * slatted door in an alcove. The command chair's back and arms sit in front of
 * everything, behind the speaker.
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
uniform vec3 uWash[4];
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
const float TAN_HALF = ${g(TAN_HALF_FOV)};
const float EYE_H = ${g(EYE_H)};
const float CAMERA_Z = ${g(CAMERA_Z)};
const float R_DECK = ${g(R_DECK)};
const float R_RAIL = ${g(R_RAIL)};
const float R_CHAIR = ${g(R_CHAIR)};
const float R_CONSOLE = ${g(R_CONSOLE)};
const float R_BACK = ${g(R_CONSOLE_BACK)};
const float R_WALL = ${g(R_WALL)};
const float DECK_H = ${g(DECK_H)};
const float CONSOLE_H = ${g(CONSOLE_H)};
const float BACK_H = ${g(CONSOLE_BACK_H)};
const float RAIL_H = ${g(RAIL_H)};
const float RAIL_T = ${g(RAIL_T)};
const float FACE_TOP = ${g(FACE_TOP)};
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
/** Where the screens' band sits, and the soffit above it. */
const float SCREEN_Y = 2.3;
const float SOFFIT_Y = 2.72;

const vec3 WALL = vec3(0.75, 0.78, 0.83);
const vec3 SOFFIT = vec3(0.66, 0.68, 0.73);
const vec3 PILLAR = vec3(0.56, 0.58, 0.63);
const vec3 FRAME = vec3(0.8, 0.81, 0.83);
const vec3 BLACK = vec3(0.03, 0.03, 0.035);
const vec3 KNEE = vec3(0.7, 0.73, 0.78);
const vec3 SHELL = vec3(0.8, 0.86, 0.93);
const vec3 RAIL_RED = vec3(0.9, 0.07, 0.05);
const vec3 DOOR_RED = vec3(0.86, 0.12, 0.1);
const vec3 CARPET = vec3(0.3, 0.3, 0.315);

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

/** Flat, even studio light at azimuth th and height y: a tinted key light and three faint coloured pools. */
vec3 wallLight(float th, float y) {
  vec3 L = uWash[0] * (0.92 + 0.08 * smoothstep(0.6, 2.7, y));
  float v = exp(-pow((y - 1.9) / 1.2, 2.0));
  L += uWash[1] * exp(-pow((th + 0.72) / 0.3, 2.0)) * v;
  L += uWash[2] * exp(-pow(th / 0.35, 2.0)) * v;
  L += uWash[3] * exp(-pow((th - 0.68) / 0.3, 2.0)) * v;
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

/** Indicator colours: mostly red, yellow, green, blue and white. */
vec3 lampColour(uint h) {
  uint k = (h >> 3) % 8u;
  if (k == 0u) return vec3(1.0, 0.12, 0.08);
  if (k == 1u) return vec3(1.0, 0.82, 0.15);
  if (k == 2u) return vec3(0.25, 0.95, 0.3);
  if (k == 3u) return vec3(0.25, 0.5, 1.0);
  if (k == 4u) return vec3(1.0, 0.97, 0.9);
  if (k == 5u) return vec3(1.0, 0.5, 0.1);
  if (k == 6u) return vec3(0.75, 0.9, 1.0);
  return vec3(1.0, 0.2, 0.12);
}

/** Which slot a lamp shows: one group per busy row (so it can chase), or a calm slot. */
float lampSlot(uint rh, uint lh, float i, bool calm) {
  return calm ? CALM_SLOT0 + float(lh % 32u) : float(rh % uint(BUSY_GROUPS)) * GROUP + mod(i, GROUP);
}

/** A square backlit tile (signed distance d) in a thin dark bezel, at its lit colour; the composite dims it by its slot. */
vec3 lens(vec3 col, float d, vec3 glow, float slot) {
  col = mix(col, vec3(0.02), cover(d - 0.005));
  float c = cover(d);
  col = mix(col, glow, c);
  setLive(${String(CODE_LAMP)}, vec2(slot / 255.0, 0.0), c);
  return col;
}

/**
 * A row of square tiles at height y0 across -w..w (q in metres), pitch apart,
 * each hs in half size, one colour per tile (mixed) or per row.
 */
vec3 lampRow(vec3 col, vec2 q, float y0, float w, float pitch, vec2 hs, uint rh, bool calm, bool mixed) {
  float n = max(floor(2.0 * w / pitch), 1.0);
  float x0 = -0.5 * n * pitch;
  float i = clamp(floor((q.x - x0) / pitch), 0.0, n - 1.0);
  vec2 c = vec2(x0 + (i + 0.5) * pitch, y0);
  float d = sdBox(q - c, hs, min(hs.x, hs.y) * 0.15);
  if (d > 0.012) {
    return col;
  }
  uint lh = hash32(rh ^ (uint(i) * 0x9e3779b9u));
  // A few tiles in a row are blank.
  if ((lh & 7u) == 0u) {
    return mix(col, vec3(0.02), cover(d));
  }
  return lens(col, d, lampColour(mixed ? lh : rh), lampSlot(rh, lh, i, calm));
}

/** A row of round jewel buttons: domed, with a highlight, in a dark collar. */
vec3 jewelRow(vec3 col, vec2 q, float y0, float w, float pitch, float r, uint rh, bool calm) {
  float n = max(floor(2.0 * w / pitch), 1.0);
  float x0 = -0.5 * n * pitch;
  float i = clamp(floor((q.x - x0) / pitch), 0.0, n - 1.0);
  vec2 o = q - vec2(x0 + (i + 0.5) * pitch, y0);
  float d = length(o) - r;
  if (d > 0.012) {
    return col;
  }
  uint lh = hash32(rh ^ (uint(i) * 0x85ebca6bu));
  col = mix(col, vec3(0.12, 0.12, 0.13), cover(d - 0.005));
  vec2 nn = o / r;
  vec3 glow = lampColour(lh) * (0.72 + 0.3 * clamp(nn.y, -1.0, 1.0));
  glow += vec3(0.55) * exp(-dot(nn - vec2(-0.3, 0.4), nn - vec2(-0.3, 0.4)) * 9.0);
  float c = cover(d);
  col = mix(col, glow, c);
  setLive(${String(CODE_LAMP)}, vec2(lampSlot(rh, lh, i, calm) / 255.0, 0.0), c);
  return col;
}

/** A framed block of tiles on the black face: a light grey frame round rows of square lamps. */
vec3 tileBlock(vec3 col, vec2 q, vec2 c, vec2 hs, uint h, int rows, bool calm) {
  float d = sdBox(q - c, hs, 0.006);
  if (d > 0.02) {
    return col;
  }
  col = mix(col, lit(FRAME), cover(d));
  col = mix(col, vec3(0.025), cover(d + 0.016));
  if (d < -0.016) {
    float pitch = calm ? 0.12 : 0.046;
    float rp = (2.0 * hs.y - 0.026) / float(rows);
    for (int k = 0; k < 3; k++) {
      if (k >= rows) {
        break;
      }
      uint rk = hash32(h + uint(k) * 31u);
      float y = c.y + hs.y - 0.015 - (float(k) + 0.5) * rp;
      col = lampRow(col, q - vec2(c.x, 0.0), y, hs.x - 0.018, pitch, vec2(0.0175, 0.0155), rk, calm, (rk & 3u) != 0u);
    }
  }
  return col;
}

/** A screen recessed in a light grey frame: dark glass here, its picture drawn live. */
vec3 screen(vec3 col, vec2 q, vec2 c, vec2 hs, uint h, int idx) {
  float d = sdBox(q - c, hs, 0.01);
  if (d > 0.05) {
    return col;
  }
  col *= 1.0 - 0.25 * cover(d - 0.045) * (1.0 - cover(d - 0.035));
  col = mix(col, lit(FRAME * 1.04), cover(d - 0.035));
  // The frame's inner reveal, shaded as a recess lit from above.
  float rev = cover(d - 0.012);
  vec3 reveal = lit(vec3(0.42, 0.44, 0.48)) * (q.y > c.y + hs.y - 0.002 ? 0.6 : 1.0);
  col = mix(col, reveal, rev);
  float glass = cover(d);
  col = mix(col, vec3(0.01, 0.012, 0.02), glass);
  vec2 uv = clamp((q - c + hs) / (2.0 * hs), 0.0, 1.0);
  // Mostly speckled star fields and plots, now and then a trace or a bar graph.
  uint t = h % 8u;
  int type = t < 4u ? 0 : t < 6u ? 1 : t == 6u ? 2 : 3;
  setLive(${String(CODE_SCREEN)} + type * 16 + (idx & 15), uv, glass);
  return col;
}

/** Flat wall panels: faint seams every pitch metres. */
vec3 panels(vec3 col, float s, float pitch) {
  float seam = abs(fract(s / pitch + 0.5) - 0.5) * pitch;
  return col * (1.0 - 0.12 * cover(seam - 0.003));
}

/** The black face over a station's desk: framed blocks of tiles, and rows of loose ones and slim readouts under them. */
vec3 stationFace(vec3 col, vec2 q, float hw, uint h) {
  float aw = hw - 0.04;
  int nb = 2 + int((h >> 5) & 1u);
  float bw = 2.0 * aw / float(nb);
  float i = clamp(floor((q.x + aw) / bw), 0.0, float(nb - 1));
  uint bh = hash32(h ^ (uint(i) + 1u) * 0x9e3779b9u);
  float cx = -aw + (i + 0.5) * bw;
  int rows = 2 + int((bh >> 4) & 1u);
  float top = FACE_TOP - 0.05;
  float bh2 = rows == 3 ? 0.11 : 0.08;
  col = tileBlock(col, q, vec2(cx, top - bh2), vec2(0.5 * bw - 0.02, bh2), bh, rows, false);
  // Loose tiles and slim readouts lower down.
  float y1 = top - 2.0 * bh2 - 0.075;
  col = lampRow(col, q, y1, aw - 0.03, 0.062, vec2(0.022, 0.013), hash32(h + 3u), false, true);
  if (rows == 2) {
    col = lampRow(col, q, y1 - 0.065, aw - 0.1, 0.11, vec2(0.04, 0.011), hash32(h + 4u), false, true);
  }
  return col;
}

/** The wall over a station: pale panels with a band of framed screens. */
vec3 stationScreens(vec3 col, vec2 q, float hw, uint h, int idx) {
  if (((h >> 9) & 1u) == 0u) {
    float sw = 0.5 * hw - 0.07;
    col = screen(col, q, vec2(-0.5 * hw + 0.015, SCREEN_Y), vec2(sw, 0.19), hash32(h + 5u), idx * 2);
    col = screen(col, q, vec2(0.5 * hw - 0.015, SCREEN_Y), vec2(sw, 0.19), hash32(h + 6u), idx * 2 + 1);
  } else {
    col = screen(col, q, vec2(-0.26 * hw, SCREEN_Y), vec2(0.62 * hw, 0.2), hash32(h + 5u), idx * 2);
    col = screen(col, q, vec2(0.68 * hw, SCREEN_Y + 0.04), vec2(0.18 * hw, 0.13), hash32(h + 6u), idx * 2 + 1);
  }
  return col;
}

/** The calm wall behind the speaker: plain panels, an empty framed inset, and one block of slow tiles. */
vec3 calmWall(vec3 col, vec2 q, float hw, uint h) {
  if (q.y < FACE_TOP) {
    col = tileBlock(col, q, vec2(0.0, FACE_TOP - 0.13), vec2(hw - 0.14, 0.06), hash32(h + 9u), 1, true);
  } else {
    float di = sdBox(q - vec2(0.0, SCREEN_Y), vec2(hw - 0.25, 0.2), 0.01);
    col = mix(col, lit(FRAME), cover(di - 0.03));
    col = mix(col, lit(WALL * 0.9), cover(di));
    col *= 1.0 - 0.18 * cover(abs(di) - 0.003) * step(SCREEN_Y + 0.17, q.y);
  }
  return col;
}

/** The door's bay: a red slatted door in a recessed alcove between grey pillars, a call panel and a lamp. */
vec3 doorWall(vec3 col, vec2 q, float hw, uint h) {
  float pw = 0.13;
  float ax = hw - pw;
  float top = 2.42;
  // Pillars either side, full height.
  float pil = step(ax, abs(q.x));
  float side = clamp((abs(q.x) - ax) / pw, 0.0, 1.0);
  vec3 pc = lit(PILLAR * (1.05 - 0.2 * side));
  // The alcove: a darker reveal round the door.
  float dc = sdBox(q - vec2(0.0, 0.5 * (DECK_H + top)), vec2(ax, 0.5 * (top - DECK_H)), 0.0);
  vec3 alc = lit(vec3(0.42, 0.44, 0.48)) * (0.8 + 0.2 * smoothstep(DECK_H, top, q.y));
  col = mix(col, alc, cover(dc));
  // A header over the alcove, flush with the pillars.
  col = mix(col, lit(PILLAR * 1.1), step(top, q.y) * (1.0 - pil) * step(q.y, SOFFIT_Y));
  col = mix(col, pc, pil * step(q.y, SOFFIT_Y));
  col *= 1.0 - 0.3 * cover(abs(abs(q.x) - ax) - 0.004);
  // The door: fine vertical slats.
  vec2 dh = vec2(ax - 0.05, 0.5 * (top - 0.06 - DECK_H));
  float dd = sdBox(q - vec2(0.0, DECK_H + dh.y), dh, 0.0);
  float pitch = 0.032;
  float fade = clamp(1.6 - 2.0 * px / pitch, 0.0, 1.0);
  float slat = 0.5 + 0.5 * cos(6.2831853 * q.x / pitch);
  vec3 leaf = DOOR_RED * (0.95 - 0.28 * slat * fade - 0.12 * (1.0 - fade));
  leaf *= 0.88 + 0.12 * smoothstep(DECK_H, top, q.y);
  col = mix(col, vec3(0.06), cover(dd - 0.012));
  col = mix(col, lit(leaf), cover(dd));
  // A small red call panel on one pillar, with lamps.
  vec2 pq = q - vec2(-(ax + 0.5 * pw), 1.55);
  float dp = sdBox(pq, vec2(0.04, 0.1), 0.006);
  col = mix(col, vec3(0.05), cover(dp - 0.008));
  col = mix(col, lit(vec3(0.75, 0.08, 0.06)), cover(dp));
  if (dp < 0.0) {
    col = lampRow(col, vec2(pq.y, pq.x), 0.0, 0.08, 0.075, vec2(0.016, 0.016), hash32(h + 11u), true, true);
  }
  // A lamp over the door.
  float dl = sdBox(q - vec2(0.0, top + 0.08), vec2(0.1, 0.02), 0.006);
  col = lens(col, dl, vec3(1.0, 0.92, 0.7), CALM_SLOT0 + float(hash32(h + 12u) % 32u));
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
  vec3 col = panels(lit(WALL), s, 0.56);
  if (kind == DOOR) {
    col = doorWall(col, q, hw, h);
  } else if (y < FACE_TOP) {
    // The black face over the desks, leaning back a little: lighter at the top.
    col = lit(BLACK) * (0.8 + 0.5 * smoothstep(BACK_H, FACE_TOP, y));
    if (kind == STATION) {
      col = stationFace(col, q, hw, h);
    } else {
      col = calmWall(col, q, hw, h);
    }
    col *= 1.0 - 0.6 * cover(min(s - s0, s1 - s) - 0.004);
  } else {
    // A light grey ledge along the face's top.
    col = mix(col, lit(FRAME * 1.05), cover(abs(y - FACE_TOP - 0.03) - 0.03));
    col *= 1.0 - 0.3 * cover(abs(y - FACE_TOP - 0.065) - 0.004);
    if (kind == STATION) {
      col = stationScreens(col, q, hw, h, idx);
    } else if (kind == CALM) {
      col = calmWall(col, q, hw, h);
    }
    // Slim pillars between segments.
    float e = min(s - s0, s1 - s);
    col = mix(col, lit(PILLAR * (0.9 + 0.15 * clamp(e / 0.03, 0.0, 1.0))), cover(e - 0.03));
  }
  if (y > SOFFIT_Y) {
    col = lit(SOFFIT);
    col *= 1.0 - 0.3 * cover(abs(y - SOFFIT_Y - 0.006) - 0.006);
    // The band of light under the ceiling.
    col = mix(col, vec3(1.0, 0.98, 0.94), cover(abs(y - (CEILING_H - 0.1)) - 0.025));
    col *= 1.0 - 0.15 * smoothstep(CEILING_H - 0.06, CEILING_H, y);
  }
  // The alert beacons: dark red domes on little plates.
  for (int b = 0; b < 2; b++) {
    float bs = (b == 0 ? uBeaconA.x : uBeaconA.y) * R_WALL;
    vec2 bq = vec2(s - bs, y - BEACON_Y);
    if (abs(bq.x) < 0.2 && abs(bq.y) < 0.2) {
      col = mix(col, lit(vec3(0.35)), cover(sdBox(bq + vec2(0.0, 0.07), vec2(0.13, 0.025), 0.008)));
      float dd = length(bq) - BEACON_R;
      vec2 n = bq / BEACON_R;
      vec3 dome = vec3(0.4, 0.04, 0.03) * (0.7 + 0.5 * clamp(n.y - 0.4 * n.x, -1.0, 1.0));
      dome += vec3(0.3) * exp(-dot(n - vec2(-0.35, 0.45), n - vec2(-0.35, 0.45)) * 18.0);
      float c = cover(dd);
      col = mix(col, dome, c);
      setLive(${String(CODE_BEACON)} + b, bq / (2.0 * BEACON_R) + 0.5, c);
    }
  }
  return col;
}

/** A console's front: a red trim along the desk's edge, a dark lip, and pale knee panels lit soft blue. */
vec3 consoleFront(vec3 p, vec4 seg, int kind, uint h) {
  float th = atan(p.x, p.z);
  gLight = wallLight(th, p.y);
  gWash = 0.6;
  float s = th * R_CONSOLE;
  float sc = 0.5 * (seg.x + seg.y) * R_CONSOLE;
  float y = p.y;
  vec3 col = panels(lit(KNEE), s - sc, 0.28);
  // Shadow under the desk, and a soft blue or teal glow spilling down the panels.
  col *= 0.55 + 0.45 * smoothstep(CONSOLE_H - 0.03, CONSOLE_H - 0.3, y);
  vec3 glow = ((h >> 3) & 1u) == 0u ? vec3(0.25, 0.55, 1.0) : vec3(0.2, 0.85, 0.8);
  float gx = kind == STATION ? 1.0 : 0.45;
  float g = exp(-pow((s - sc) / 0.32, 2.0)) * exp(-pow((y - (CONSOLE_H - 0.17)) / 0.14, 2.0));
  col += glow * 0.55 * g * gx;
  col = mix(col, lit(BLACK), cover(abs(y - (CONSOLE_H - 0.07)) - 0.022));
  // The red trim along the desk's front edge.
  float n = clamp((y - (CONSOLE_H - 0.025)) / 0.025, -1.0, 1.0);
  vec3 trim = RAIL_RED * (0.8 + 0.25 * n) + vec3(0.25, 0.15, 0.15) * exp(-pow((n - 0.6) / 0.25, 2.0));
  col = mix(col, lit(trim), cover(abs(y - (CONSOLE_H - 0.025)) - 0.025));
  // A dark kick plate.
  col = mix(col, vec3(0.04), cover(y - (DECK_H + 0.05)));
  float e = min(s - seg.x * R_CONSOLE, seg.y * R_CONSOLE - s);
  col *= 1.0 - 0.6 * cover(e - 0.005);
  return col;
}

/** The slanted black desk: clusters of round jewel buttons at stations, a few slow ones elsewhere. */
vec3 consoleTop(vec3 p, vec4 seg, int kind, uint h) {
  float th = atan(p.x, p.z);
  float r = length(p.xz);
  float v = (r - R_CONSOLE) / (R_BACK - R_CONSOLE) * SLOPE_LEN;
  float rm = 0.5 * (R_CONSOLE + R_BACK);
  vec2 q = vec2((th - 0.5 * (seg.x + seg.y)) * rm, v);
  float hw = 0.5 * (seg.y - seg.x) * rm;
  gLight = wallLight(th, p.y);
  gWash = 0.6;
  // Black, with a soft sheen of the key light towards the back.
  vec3 col = lit(BLACK) * (1.0 + 1.2 * smoothstep(0.1, SLOPE_LEN, v));
  if (kind == STATION) {
    for (int k = 0; k < 3; k++) {
      uint ck = hash32(h + 40u + uint(k));
      float cx = (float(k) - 1.0) * 0.66 * hw + (float(ck % 9u) - 4.0) * 0.01;
      float cw = 0.11 + 0.04 * float((ck >> 4) % 3u);
      int rows = 2 + int((ck >> 8) & 1u);
      for (int j = 0; j < 3; j++) {
        if (j >= rows) {
          break;
        }
        uint rk = hash32(ck + uint(j) * 17u);
        col = jewelRow(col, q - vec2(cx, 0.0), 0.15 + float(j) * 0.085, cw, 0.05, 0.017, rk, false);
      }
      // A small pale plate beside some clusters.
      if (((ck >> 12) & 1u) == 0u) {
        float dp = sdBox(q - vec2(cx + cw + 0.06, 0.24), vec2(0.035, 0.05), 0.004);
        col = mix(col, lit(KNEE * 0.8), cover(dp));
      }
    }
  } else if (seg.z > -0.5) {
    col = jewelRow(col, q, 0.27, hw - 0.2, 0.26, 0.017, hash32(h + 41u), true);
  }
  float e = min(q.x + hw, hw - q.x);
  col *= 1.0 - 0.5 * cover(e - 0.006);
  return col;
}

/** The ceiling: mid grey, with a ring of cove light near the wall and radial ribs. */
vec3 ceiling(vec3 p) {
  float r = length(p.xz);
  float th = atan(p.x, p.z);
  gLight = vec3(1.0);
  gWash = 0.6;
  vec3 col = vec3(0.4, 0.41, 0.44) * uWash[0] * (0.85 + 0.15 * smoothstep(2.0, 4.0, r));
  col += vec3(0.5, 0.5, 0.48) * smoothstep(3.95, 4.05, r) * (1.0 - smoothstep(4.3, 4.4, r));
  float rib = abs(fract(th / 0.3927 + 0.5) - 0.5) * 0.3927 * r;
  col *= 1.0 - 0.12 * cover(rib - 0.012);
  return col;
}

/** Charcoal carpet: a fine, faint texture that fades out where it would alias. */
vec3 carpet(vec3 p, float shade) {
  vec2 c = floor(p.xz / 0.012);
  float n = float(hash32(uint(int(c.x) + 4096) * 0x9e3779b9u ^ uint(int(c.y) + 4096)) & 255u) / 255.0;
  float k = clamp(1.0 - px / 0.02, 0.0, 1.0);
  return CARPET * uWash[0] * shade * (1.0 + 0.12 * (n - 0.5) * k);
}

vec3 deckFloor(vec3 p) {
  float r = length(p.xz);
  gLight = vec3(1.0);
  gWash = 0.5;
  vec3 col = carpet(p, 0.9);
  // Shadow under the desks.
  col *= 1.0 - 0.45 * smoothstep(R_CONSOLE - 0.15, R_CONSOLE, r);
  return col;
}

vec3 lowerFloor(vec3 p) {
  float r = length(p.xz);
  gLight = vec3(1.0);
  gWash = 0.5;
  return carpet(p, 0.95 + 0.25 * exp(-r * r / 4.0));
}

/** The step up to the deck: charcoal, darker towards the floor. */
vec3 riser(vec3 p) {
  gLight = vec3(1.0);
  gWash = 0.5;
  vec3 col = CARPET * uWash[0] * (0.45 + 0.25 * smoothstep(0.0, DECK_H, p.y));
  col = mix(col, CARPET * 1.4, cover(abs(p.y - (DECK_H - 0.008)) - 0.008));
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

/**
 * A swivel chair seen from behind, w in metres from the foot of its pedestal:
 * a single black pedestal on a low foot, a pale blue-white shell seat and a
 * black back.
 */
vec3 swivelChair(vec2 w, vec3 col, vec3 L) {
  float dFoot = sdBox(w - vec2(0.0, 0.02), vec2(0.2, 0.018), 0.018);
  float dPost = sdBox(w - vec2(0.0, 0.22), vec2(0.028, 0.2), 0.008);
  vec2 sq = (w - vec2(0.0, 0.5)) / vec2(0.26, 0.12);
  float dShell = (length(vec2(sq.x, max(sq.y, 0.0) * 0.35 + min(sq.y, 0.0))) - 1.0) * 0.12;
  float dBack = sdBox(w - vec2(0.0, 0.84), vec2(0.18, 0.27), 0.08);
  float c = max(max(cover(dFoot), cover(dPost)), max(cover(dShell), cover(dBack)));
  if (c <= 0.0) {
    return col;
  }
  col = mix(col, vec3(0.03) * L, max(cover(dFoot), cover(dPost)));
  vec3 shell = SHELL * L * (0.7 + 0.35 * smoothstep(0.38, 0.6, w.y)) * (1.0 - 0.25 * sq.x * sq.x);
  col = mix(col, shell, cover(dShell));
  vec3 pad = BLACK * L * (1.0 + 2.5 * smoothstep(0.9, 1.1, w.y));
  col = mix(col, vec3(0.01), cover(dBack - 0.006));
  col = mix(col, pad, cover(dBack));
  gWash = mix(gWash, 0.4, c);
  gCov *= 1.0 - c;
  return col;
}

/** Swivel chairs at most stations, between the railing and the desks. */
vec3 chairs(vec2 f, vec3 col, float k) {
  for (int i = 0; i < ${String(MAX_SEGMENTS)}; i++) {
    if (i >= uSegCount) {
      break;
    }
    vec4 s = uSegs[i];
    if (int(s.z + 0.5) != STATION) {
      continue;
    }
    uint h = hash32(uint(i) * 0x632be5abu ^ uSalt);
    if (((h >> 13) & 3u) == 0u) {
      continue;
    }
    float a = 0.5 * (s.x + s.y) + (float((h >> 16) % 7u) - 3.0) * 0.015;
    vec3 c = vec3(R_CHAIR * sin(a), DECK_H, R_CHAIR * cos(a));
    float d = c.z - CAMERA_Z;
    vec2 w = vec2(f.x * 2.0 * TAN_HALF * d - c.x, EYE_H + f.y * 2.0 * TAN_HALF * d - DECK_H);
    if (abs(w.x) < 0.32 && w.y > -0.02 && w.y < 1.14) {
      px = d * k;
      col = swivelChair(w, col, wallLight(a, 1.0));
    }
  }
  return col;
}

/** The thick, flat-topped red padded railing on black posts, over col. Open in front of the door. */
vec3 railing(vec3 ro, vec3 rd, float k, vec3 col) {
  float tR = farRoot(ro.xz, rd.xz, R_RAIL);
  vec3 p = ro + rd * tR;
  px = tR * k;
  float th = atan(p.x, p.z);
  float s = th * R_RAIL;
  float g0 = (uDoor.x + 0.01) * R_RAIL;
  float g1 = (uDoor.y - 0.01) * R_RAIL;
  // Positive outside the gap, negative inside it.
  float dg = max(g0 - s, s - g1);
  float outside = cover(-dg);
  float dy = p.y - (RAIL_H - 0.5 * RAIL_T);
  float pad = cover(abs(dy) - 0.5 * RAIL_T) * outside;
  float pitch = 0.3 * R_RAIL;
  float sp = abs(s - pitch * (floor(s / pitch) + 0.5));
  sp = min(sp, min(abs(s - g0 + 0.08), abs(s - g1 - 0.08)));
  float post = cover(sp - 0.03) * step(DECK_H, p.y) * step(p.y, RAIL_H) * cover(-dg - 0.02);
  // The padding: a rounded upper edge catching the light, a flat face, a soft underside.
  float n = clamp(dy / (0.5 * RAIL_T), -1.0, 1.0);
  vec3 L = wallLight(th, RAIL_H);
  vec3 rail = RAIL_RED * L * (0.82 + 0.18 * smoothstep(-1.0, 0.2, n) - 0.3 * smoothstep(0.75, 1.0, n));
  rail += vec3(0.35, 0.2, 0.2) * exp(-pow((n - 0.62) / 0.14, 2.0));
  rail *= 1.0 - 0.35 * smoothstep(-0.7, -1.0, n);
  vec3 pole = vec3(0.025) + vec3(0.05) * exp(-pow(sp / 0.012, 2.0));
  // The posts and the railing's shadow on what lies behind.
  col *= 1.0 - 0.25 * cover(abs(dy + 0.5 * RAIL_T + 0.02) - 0.02) * outside;
  col = mix(col, pole, post);
  col = mix(col, rail, pad);
  float c = max(pad, post);
  gCov *= 1.0 - c;
  gWash = mix(gWash, 0.4, c);
  return col;
}

/** The command chair's back (black upholstery in a pale shell) and arm ends, in front of everything. */
vec3 chair(vec2 f, vec3 col) {
  vec3 L = uWash[0];
  float ds = sdBox(f - vec2(0.0, -0.385), vec2(0.17, 0.165), 0.05);
  if (ds < 0.01) {
    col = mix(col, col * 0.5, cover(ds - 0.008));
    vec3 shell = vec3(0.68, 0.7, 0.74) * L * (0.8 + 0.25 * clamp((f.y + 0.3) / 0.1, -1.0, 1.0));
    col = mix(col, shell, cover(ds));
    float dp = sdBox(f - vec2(0.0, -0.39), vec2(0.14, 0.14), 0.04);
    col = mix(col, vec3(0.04, 0.04, 0.045) * (1.0 + 0.6 * smoothstep(-0.28, -0.25, f.y)), cover(dp));
    col *= 1.0 - 0.35 * cover(abs(f.x) - 0.003) * cover(dp + 0.02);
    gWash = mix(gWash, 0.2, cover(ds));
    gCov *= 1.0 - cover(ds);
  }
  for (int sgn = -1; sgn <= 1; sgn += 2) {
    vec2 a = f - vec2(float(sgn) * 0.255, -0.47);
    float da = sdBox(a, vec2(0.065, 0.04), 0.012);
    if (da < 0.01) {
      col = mix(col, vec3(0.03), cover(da - 0.006));
      col = mix(col, vec3(0.62, 0.64, 0.68) * L * (0.85 + 0.2 * a.y / 0.04), cover(da));
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
      col = chairs(f, col, k);
      col = railing(ro, rd, k, col);
    }
  }
  px = 1.0 / uRes.y;
  col = chair(vec2(f.x * uMirror, f.y), col);
  // A faint stage vignette.
  vec2 v = f / vec2(0.5 * uRes.x / uRes.y + 0.15, 0.62);
  col *= 1.0 - 0.15 * smoothstep(0.5, 1.1, dot(v, v));
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
 * the screens' pictures (a drifting star field, a plot of speckles round a
 * circling cluster, an oscilloscope trace or a bar graph), and under red alert
 * the pulsing red wash and the beacons' turning glow.
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

/**
 * Speckles: a field of small coloured points, one chance per cell, panning
 * across by shift (whole screens) and twinkling slowly. Focus gathers
 * more of them round a point, with spread its reach (0 for an even field).
 */
vec3 speckle(vec2 uv, float idx, float shift, float dens, vec2 focus, float spread) {
  const vec2 G = vec2(38.0, 24.0);
  vec2 gq = vec2((uv.x + shift) * G.x, uv.y * G.y);
  vec2 cell = floor(gq);
  vec2 local = gq - cell;
  cell.x = mod(cell.x, G.x);
  uint h = hash32(uint(cell.x) + uint(cell.y) * 64u + uint(idx) * 4096u + 0x51ed27u);
  float p = dens;
  if (spread > 0.0) {
    vec2 c = vec2(fract((cell.x + 0.5) / G.x - shift), (cell.y + 0.5) / G.y);
    vec2 o = (c - focus) * vec2(1.4, 1.0);
    p += 0.7 * exp(-dot(o, o) / (spread * spread));
  }
  if (float(h & 1023u) / 1024.0 > p) {
    return vec3(0.0);
  }
  vec2 j = 0.2 + 0.6 * vec2(float((h >> 10) & 255u), float((h >> 18) & 255u)) / 255.0;
  vec2 o = local - j;
  float s = exp(-dot(o, o) / 0.035);
  uint k = (h >> 26) & 7u;
  vec3 c = k < 3u ? vec3(1.0, 0.97, 0.92) : pal(float(k));
  float tw = 0.75 + 0.25 * sin(TAU * cyc(40.0 + float((h >> 3) & 15u) * 5.0) + float(h & 255u));
  return c * s * tw;
}

/** A dark star field with a coloured haze, drifting slowly sideways. */
vec3 stars(vec2 uv, float idx) {
  float shift = cyc(2.0 + mod(idx, 3.0));
  vec3 col = vec3(0.01, 0.012, 0.03);
  vec2 hc = vec2(fract(0.25 + 0.37 * idx - shift), 0.35 + 0.3 * fract(0.61 * idx));
  vec2 ho = (uv - hc) * vec2(1.4, 1.0);
  vec2 ho2 = (uv - hc + vec2(1.0, 0.0)) * vec2(1.4, 1.0);
  float haze = exp(-dot(ho, ho) / 0.03) + exp(-dot(ho2, ho2) / 0.03);
  vec3 hue = mod(idx, 2.0) < 0.5 ? vec3(0.55, 0.06, 0.3) : vec3(0.1, 0.25, 0.5);
  col += hue * 0.45 * haze;
  col += speckle(uv, idx, shift, 0.32, hc, 0.0) * (0.75 + 0.6 * haze);
  return col;
}

/** A plot: speckles gathered round a slowly circling cluster, over a faint grid with a crosshair on it. */
vec3 plot(vec2 uv, float idx) {
  vec2 gq = abs(fract(uv * vec2(6.0, 4.0)) - 0.5);
  vec3 col = vec3(0.01, 0.015, 0.035) + vec3(0.02, 0.04, 0.07) * step(0.46, max(gq.x, gq.y));
  float a = TAU * (cyc(6.0 + mod(idx, 4.0)) + 0.13 * idx);
  vec2 c = vec2(0.5 + 0.22 * cos(a), 0.5 + 0.2 * sin(a));
  col += speckle(uv, idx + 16.0, 0.0, 0.12, c, 0.16);
  vec2 o = abs(uv - c) * vec2(1.4, 1.0);
  float cross = step(min(o.x, o.y), 0.006) * step(max(o.x, o.y), 0.07) * step(0.02, max(o.x, o.y));
  col += vec3(0.9, 0.3, 0.6) * 0.7 * cross;
  return col;
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
  if (type == 0) return stars(uv, idx);
  if (type == 1) return plot(uv, idx);
  if (type == 2) return scope(uv, idx);
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
      col = mix(col, room.rgb * mix(0.3, 1.12, b), live.a);
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
 * Standing before the command chair of a 1960s TV starship's round bridge,
 * under bright, flat studio light: a ring of black consoles round the pale
 * grey walls, each with framed blocks of coloured lamp tiles over a slanted,
 * red-trimmed desk of jewel buttons, a band of framed wall screens above, a
 * thick red padded railing on black posts, swivel chairs, and a red slatted
 * door in an alcove at one side. The wall behind the speaker stays plain, with
 * only slow lamps. Under red alert the walls wash red in a slow pulse and two
 * beacons turn.
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
