import {
  advanceGraph,
  createGraphWalk,
  GRAPH_SAMPLES,
  graphShift,
  GRAPH_DISTANCE_GLSL,
} from "../graph-walk";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import { lowResSize } from "../lowres";
import { approach, clamp, fract } from "../math";
import { HASH32_GLSL, hash32 } from "../noise";
import { defineEffect } from "../types";
import type { OutsideId } from "./stationops.meta";
import { stationopsMeta } from "./stationops.meta";
import {
  ALERT_PERIOD,
  alertPulse,
  ANOMALY_SITES,
  ANOMALY_SPIN,
  anomalyOpen,
  BEACON_PERIOD,
  CELL_COUNT,
  CONSOLE_INNER,
  createShipPass,
  FOCAL,
  FRAME_W,
  fillCellLevels,
  GRAPH_COUNT,
  GRAPH_SPANS,
  GRAPH_Y0,
  GRAPH_Y1,
  LIGHTING_FADE,
  lightingTargets,
  type OpsLayout,
  opsLayout,
  outsideId,
  PLANET,
  PYLONS,
  RING,
  shipAt,
  STATION_Z,
  STEADY_CELL,
  TABLE_RX,
  TABLE_RY,
  TABLE_Y,
  VIEW_RX,
  VIEW_RY,
  VIEW_X,
  VIEW_Y,
} from "./stationops-sim";
import { OPS_SHIP_GLSL } from "./stationops-ships";
import { SDF2D_GLSL } from "../sdf-glsl";

const g = glslFloat;

/** The outside cache is never taller than this: it is soft, distant detail. */
const OUTSIDE_MAX_H = 1080;
/** Most beacons on the station. */
const MAX_BEACONS = 3;
/** Towards the sun, in view space (the eye looks along +z), for the station and ships. */
const SUN = ((v: number[]) => v.map((x) => x / Math.hypot(...v)))([0.62, 0.45, -0.64]);

/** Shared GLSL: anti-aliased shapes, the console edges and hashed noise. */
const COMMON_GLSL = /* glsl */ `
${HASH32_GLSL}
const float VIEW_X = ${g(VIEW_X)};
const float VIEW_Y = ${g(VIEW_Y)};
const vec2 VIEW_R = vec2(${g(VIEW_RX)}, ${g(VIEW_RY)});
${SDF2D_GLSL}
// A close approximation to the distance to an ellipse of radii r.
float sdEll(vec2 p, vec2 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float consoleFront(float u) {
  return -0.35 + 0.02 * (u - ${g(CONSOLE_INNER)});
}
float consoleBack(float u) {
  return -0.25 + 0.03 * (u - ${g(CONSOLE_INNER)});
}
float r8(uint h, int k) {
  return float((h >> uint(8 * k)) & 255u) / 255.0;
}
uint cellHash(vec2 c, uint salt) {
  ivec2 i = ivec2(c) + 65536;
  return hash32(uint(i.x) * 0x9e3779b9u ^ hash32(uint(i.y) ^ salt));
}
float vnoise(vec2 p, uint salt) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = float(cellHash(i, salt) >> 8);
  float b = float(cellHash(i + vec2(1.0, 0.0), salt) >> 8);
  float c = float(cellHash(i + vec2(0.0, 1.0), salt) >> 8);
  float d = float(cellHash(i + vec2(1.0, 1.0), salt) >> 8);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) / 16777216.0;
}
`;

/** Whether design point d is on a live graph screen. */
const GRAPH_TEST = GRAPH_SPANS.map(
  ([a, b]) => `(ax > ${g(a)} && ax < ${g(b)} && d.y > ${g(GRAPH_Y0)} && d.y < ${g(GRAPH_Y1)})`,
).join(" || ");

/**
 * The room, drawn once per resize or variation with four samples per pixel, in
 * two passes. Pass 0 is the room's colour, its alpha the viewports' glass
 * (under which the colour is the glass's faint reflection). Pass 1 is the
 * glowing panels: R how much a pixel glows, G its colour (amber, teal, the
 * table's cool white, or the alert strips' red, as 0..3 over 3), B which of
 * the console-light cells it belongs to. The composite colours and dims them,
 * so lighting changes cost nothing to redraw.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uK;
uniform uint uSalt;
uniform int uPass;
out vec4 outColor;
${COMMON_GLSL}
${DITHER_GLSL}
const vec3 WALL = vec3(0.1, 0.083, 0.07);
const vec3 BRONZE = vec3(0.27, 0.195, 0.125);
const vec3 CHAR = vec3(0.05, 0.046, 0.044);
const vec3 LENS = vec3(0.05, 0.032, 0.022);
const vec3 TEAL_LENS = vec3(0.02, 0.045, 0.04);
const vec3 RED_LENS = vec3(0.1, 0.022, 0.016);
const float STEADY = ${g(STEADY_CELL)};

vec3 col;
float glass;
float eAmt;
float eIdx;
float eId;

void paint(vec3 c, float a) {
  col = mix(col, c, a);
  eAmt *= 1.0 - a;
  glass *= 1.0 - a;
}

void glow(vec3 base, float a, float amt, float idx, float id) {
  col = mix(col, base, a);
  eAmt = mix(eAmt, amt, a);
  glass *= 1.0 - a;
  if (a > 0.5) {
    eIdx = idx;
    eId = id;
  }
}

/** The ceiling: beams fanning out overhead, a curved crossbeam and a few warm downlights. */
void ceiling(vec2 d, float cy) {
  float a = cover(cy - d.y);
  if (a <= 0.0) {
    return;
  }
  vec2 v = d - vec2(0.0, 0.02);
  float r = length(v);
  float ang = atan(v.x, v.y);
  const float STEP = 0.17;
  vec3 c = CHAR * 0.75 * (0.8 + 0.4 * smoothstep(cy, cy + 0.15, d.y));
  // Downlights in alternate coffers, just inside the crossbeam.
  float kc = floor(ang / STEP);
  float dm = (ang - (kc + 0.5) * STEP) * r;
  float ring = d.y - (0.47 + 0.09 * d.x * d.x);
  uint h = hash32(uint(int(kc) + 64) ^ uSalt);
  float slit = sdBox(vec2(dm, ring + 0.022), vec2(0.006 * r / 0.45, 0.0045), 0.002);
  float beamK = floor(ang / STEP + 0.5);
  float da = (ang - beamK * STEP) * r;
  float hw = 0.006 + 0.024 * r;
  float beam = cover(abs(da) - hw);
  vec3 bc = BRONZE * (0.45 + 0.3 * clamp(-da / hw, -1.0, 1.0)) * (0.9 - 0.4 * smoothstep(0.0, 0.03, ring));
  c = mix(c, bc, beam);
  float cross = cover(abs(ring) - 0.012);
  c = mix(c, BRONZE * (0.55 + 0.3 * clamp(-ring / 0.012, -1.0, 1.0)), cross);
  paint(c, a);
  if ((h & 1u) == 0u && ring < 0.0) {
    glow(LENS, cover(slit) * a * (1.0 - beam), 0.55, 0.0, float(h >> 24));
  }
  // The heavy moulding along the top of the wall, notched underneath, with an alert strip in it.
  float m = d.y - cy + 0.004;
  float mould = cover(abs(m) - 0.014);
  if (mould > 0.0) {
    vec3 mc = BRONZE * (0.7 + 0.35 * clamp(m / 0.014, -1.0, 1.0));
    float notch = abs(fract(d.x / 0.035) - 0.5) * 0.035;
    mc *= 1.0 - 0.45 * cover(notch - 0.004) * step(m, -0.007);
    paint(mc, mould);
    glow(RED_LENS, cover(abs(m) - 0.0045) * mould, 1.0, 3.0, 0.0);
  }
}

/** A leaning, ribbed pilaster at design |x| = x0 (at the console tops), from the consoles to the ceiling. */
void pilaster(vec2 d, float x0, float cy) {
  float ax = abs(d.x);
  float top = consoleBack(ax);
  if (d.y > cy + 0.02 || d.y < top - 0.01) {
    return;
  }
  float xc = x0 - 0.06 * (d.y + 0.25);
  float rib = abs(fract(d.y / 0.045) - 0.5);
  float hw = 0.021 * (1.0 + 0.16 * smoothstep(0.3, 0.5, rib));
  float s = clamp((ax - xc) / hw, -1.0, 1.0);
  float a = cover(abs(ax - xc) - hw) * cover(top - d.y);
  // Lit on its inner face, towards the room's middle, and down its raised spine.
  vec3 c = BRONZE * (0.5 - 0.3 * s + 0.25 * (1.0 - smoothstep(0.0, 0.25, abs(s + 0.2))));
  c *= 1.0 - 0.45 * cover(rib * 0.045 - 0.0018);
  col *= 1.0 - 0.35 * cover(abs(ax - xc - hw - 0.008) - 0.008);
  paint(c, a);
}

/** The bulkhead behind the speaker: a plain inset with shallow chevron ribs, deliberately calm. */
void bulkhead(vec2 d) {
  float ax = abs(d.x);
  float inset = sdBox(d - vec2(0.0, 0.04), vec2(0.27, 0.29), 0.02);
  if (inset > 0.02) {
    return;
  }
  col *= 1.0 - 0.45 * cover(abs(inset) - 0.0025);
  vec3 c = WALL * 1.08;
  float v = d.y + 0.11 * ax;
  float gv = fract(v / 0.068);
  float gd = abs(gv - 0.5) * 0.068;
  // Raised chevron ribs: a lit upper edge, a shadowed groove beneath.
  c *= 1.0 - 0.4 * cover(gd - 0.0018);
  c *= 1.0 + 0.22 * smoothstep(0.5, 0.56, gv) * (1.0 - smoothstep(0.56, 0.75, gv));
  c *= 1.0 - 0.15 * smoothstep(0.2, 0.45, gv) * (1.0 - step(0.5, gv));
  // A shallow recessed spine.
  c *= 1.0 - 0.25 * cover(ax - 0.012);
  paint(c, cover(inset));
  // A dim, steady amber slit along its top.
  glow(LENS, cover(sdBox(d - vec2(0.0, 0.347), vec2(0.09, 0.0035), 0.003)), 0.4, 0.0, STEADY);
}

/** A viewport's angular surround plate, before the pilasters overlap it. */
void surround(vec2 d) {
  vec2 q = vec2(abs(d.x) - VIEW_X, d.y - VIEW_Y);
  vec2 hs = VIEW_R + vec2(0.065, 0.055);
  float plate = max(sdBox(q, hs, 0.0), abs(q.x) * 0.8 + abs(q.y) * 0.6 - (hs.x * 0.8 + hs.y * 0.6 - 0.07));
  if (plate > 0.03) {
    return;
  }
  col *= 1.0 - 0.45 * cover(plate - 0.014) * (1.0 - cover(plate));
  vec3 c = BRONZE * 0.42 * (1.0 + 0.3 * clamp(-q.y / hs.y, -1.0, 1.0));
  // Radial fins round the oval.
  float a = atan(q.y / VIEW_R.y, q.x / VIEW_R.x);
  float fin = abs(fract(a / (TAU / 18.0)) - 0.5);
  c *= 1.0 + 0.25 * (1.0 - smoothstep(0.03, 0.08, fin));
  c *= 1.0 - 0.3 * cover(abs(plate + 0.006) - 0.0015);
  paint(c, cover(plate));
}

/** A viewport's heavy oval frame and its glass. */
void viewport(vec2 d) {
  vec2 q = vec2(abs(d.x) - VIEW_X, d.y - VIEW_Y);
  float e = sdEll(q, VIEW_R);
  if (e > ${g(FRAME_W)} + 0.01) {
    return;
  }
  float across = clamp(e / ${g(FRAME_W)}, 0.0, 1.0);
  float a = atan(q.y / VIEW_R.y, q.x / VIEW_R.x);
  float seg = abs(fract(a / (TAU / 32.0)) - 0.5);
  vec3 c = BRONZE * (0.55 + 0.55 * (1.0 - across)) * (0.8 + 0.35 * clamp(-q.y / VIEW_R.y, -1.0, 1.0));
  c *= 1.0 - 0.5 * (1.0 - smoothstep(0.03, 0.07, seg)) * step(0.35, across);
  c *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 0.004, e));
  c *= 1.0 - 0.3 * smoothstep(0.8, 1.0, across);
  paint(c, cover(e - ${g(FRAME_W)}));
  float gl = cover(e);
  if (gl > 0.0) {
    // A faint cool sheen across the glass.
    float sheen = exp(-pow((q.x * 0.7 + q.y - 0.05) / 0.05, 2.0)) * 0.012;
    col = mix(col, vec3(0.008, 0.009, 0.013) + sheen * vec3(0.7, 0.8, 1.0), gl);
    eAmt *= 1.0 - gl;
    glass = gl;
  }
}

/** A strip of small lit status panels under each viewport. */
void statusStrip(vec2 d) {
  float ax = abs(d.x);
  float sb = sdBox(vec2(ax - VIEW_X, d.y + 0.1975), vec2(0.23, 0.0175), 0.004);
  if (sb > 0.01) {
    return;
  }
  col *= 1.0 - 0.4 * cover(sb - 0.004) * (1.0 - cover(sb));
  paint(CHAR * 0.55, cover(sb));
  float u = ax - (VIEW_X - 0.225);
  float ci = floor(u / 0.025);
  vec2 lq = vec2(u - (ci + 0.5) * 0.025, d.y + 0.1975);
  uint h = hash32(uint(ci) + (d.x < 0.0 ? 101u : 7u) ^ (uSalt * 3u));
  if (ci >= 0.0 && ci < 18.0 && (h & 7u) != 0u) {
    float r = sdBox(lq, vec2(0.0095, 0.0105), 0.0015);
    bool teal = ((h >> 4) & 3u) == 0u;
    glow(teal ? TEAL_LENS : LENS, cover(r), 0.45 + 0.4 * r8(h, 2), teal ? 1.0 : 0.0, float(h >> 24));
  }
}

/** One glowing panel on a console's top: bars of a readout or a cluster of buttons. */
void consolePanel(vec2 lq, float rh, uint h) {
  uint type = h % 7u;
  float box = sdBox(lq, vec2(0.021, rh), 0.002);
  if (type == 0u) {
    paint(vec3(0.02), cover(box));
    return;
  }
  bool teal = type >= 4u;
  float idx = teal ? 1.0 : 0.0;
  vec3 lens = teal ? TEAL_LENS : LENS;
  if (type == 6u) {
    // A cluster of six buttons, each its own cell.
    vec2 bc = clamp(floor((lq + vec2(0.021, rh)) / vec2(0.014, rh)), vec2(0.0), vec2(2.0, 1.0));
    vec2 bq = lq - (vec2(-0.021, -rh) + (bc + 0.5) * vec2(0.014, rh));
    uint bh = hash32(h ^ uint(bc.x + 3.0 * bc.y));
    float b = sdBox(bq, vec2(0.005, rh * 0.5 - 0.0025), 0.0012);
    paint(vec3(0.02), cover(box));
    glow((bh & 1u) == 0u ? LENS : TEAL_LENS, cover(b), 0.5 + 0.4 * r8(bh, 1), float(bh & 1u), float(bh >> 24));
    return;
  }
  // Bars of a readout over the panel's dim glow.
  float rows = 3.0;
  float row = clamp(floor((lq.y + rh) / (2.0 * rh) * rows), 0.0, rows - 1.0);
  uint rh2 = hash32(h ^ (uint(row) * 0x9e3779b9u));
  float len = 0.008 + 0.03 * r8(rh2, 0);
  float yIn = lq.y + rh - (row + 0.5) * (2.0 * rh / rows);
  float bar = cover(abs(yIn) - rh / rows * 0.45) * cover(lq.x + 0.018 - len) * step(-0.018, lq.x);
  glow(lens, cover(box), 0.28 + 0.6 * bar, idx, float(h >> 24));
}

/** The sloping consoles along the bottom on both sides, and the live graphs' screens. */
void consoles(vec2 d) {
  float ax = abs(d.x);
  float yf = consoleFront(ax);
  float yb = consoleBack(ax);
  float side = cover(${g(CONSOLE_INNER)} - ax);
  if (side <= 0.0 || d.y > yb + 0.01) {
    return;
  }
  if (d.y < yf) {
    // The front face: dark bronze, grooved, with an alert strip under the lip.
    vec3 c = BRONZE * 0.32 * (0.6 + 0.4 * smoothstep(-0.5, yf, d.y));
    float gr = abs(fract(ax / 0.06) - 0.5) * 0.06;
    c *= 1.0 - 0.35 * cover(gr - 0.0015);
    c *= 1.0 - 0.5 * cover(abs(ax - ${g(CONSOLE_INNER)} - 0.006) - 0.004);
    paint(c, side);
    glow(RED_LENS, cover(abs(d.y - yf + 0.016) - 0.0045) * side, 1.0, 3.0, 0.0);
  } else {
    vec3 c = CHAR * (0.85 + 0.3 * (d.y - yf) / (yb - yf));
    paint(c, side * cover(d.y - yb));
    float depth = yb - yf;
    float v = (d.y - yf) / depth;
    float row = floor(v * 3.0);
    float rh = depth / 6.0 - 0.005;
    float u = ax - ${g(CONSOLE_INNER)} - 0.012;
    float ci = floor(u / 0.05);
    vec2 lq = vec2(u - (ci + 0.5) * 0.05, d.y - yf - (row + 0.5) * depth / 3.0);
    if (ci >= 0.0 && row >= 0.0 && row < 3.0) {
      uint h = hash32(uint(ci + 50.0 * row + (d.x < 0.0 ? 500.0 : 0.0)) ^ uSalt);
      consolePanel(lq, rh, h);
    }
    if (${GRAPH_TEST}) {
      paint(vec3(0.006, 0.014, 0.012), 1.0);
    }
    // The lip along the front edge.
    paint(BRONZE * 0.9, cover(abs(d.y - yf - 0.002) - 0.0025) * side);
  }
}

/** The situation table, low in the middle: a bronze rim round a glowing map. */
void table(vec2 d) {
  vec2 tq = vec2(d.x, d.y - ${g(TABLE_Y)});
  float te = sdEll(tq, vec2(${g(TABLE_RX)}, ${g(TABLE_RY)}));
  if (te > 0.01) {
    return;
  }
  vec3 rim = BRONZE * (0.6 + 0.5 * smoothstep(-0.015, 0.0, te));
  paint(rim, cover(te));
  vec2 n = tq / vec2(${g(TABLE_RX)}, ${g(TABLE_RY)});
  float r = length(n);
  float ang = atan(n.y, n.x);
  float band = floor(r * 4.0);
  float sector = floor((ang / TAU + 0.5) * 16.0);
  uint h = hash32(uint(band * 16.0 + sector) ^ uSalt ^ 0x51edu);
  float grid = max(1.0 - smoothstep(0.0, 0.025, abs(fract(r * 4.0) - 0.5) - 0.47),
                   1.0 - smoothstep(0.0, 0.025, abs(fract((ang / TAU + 0.5) * 16.0) - 0.5) - 0.47));
  float amt = 0.05 + 0.1 * r8(h, 0) * r8(h, 1) + 0.22 * grid;
  glow(vec3(0.015, 0.022, 0.03), cover(te + 0.013), amt, 2.0, float(h >> 24));
}

vec4 room(vec2 f) {
  vec2 d = vec2(f.x / uK, f.y);
  float ax = abs(d.x);
  col = WALL;
  glass = 0.0;
  eAmt = 0.0;
  eIdx = 0.0;
  eId = 0.0;
  // The curved back wall: panel seams bowing gently, faint mottling.
  float bow = d.y - 0.035 * d.x * d.x;
  float seam = abs(fract(bow / 0.11) - 0.5) * 0.11;
  col *= 1.0 - 0.25 * cover(seam - 0.0015);
  col *= 0.9 + 0.2 * vnoise(d * vec2(18.0, 7.0), uSalt);
  float cy = 0.375 + 0.05 * d.x * d.x;
  ceiling(d, cy);
  bulkhead(d);
  surround(d);
  for (int i = 0; i < 3; i++) {
    pilaster(d, i == 0 ? 0.315 : i == 1 ? 0.92 : 1.22, cy);
  }
  viewport(d);
  statusStrip(d);
  consoles(d);
  table(d);

  // Light: dim and warm from above, falling off to the corners, with amber
  // spill from the consoles and cool spill from the table.
  vec3 light = vec3(1.0, 0.93, 0.86) * (0.6 + 0.4 * smoothstep(-0.5, 0.35, d.y));
  light *= 1.0 - 0.5 * smoothstep(0.45, 1.3, length(d * vec2(0.85, 1.4)));
  float above = d.y - consoleBack(ax);
  light += vec3(1.0, 0.55, 0.2) * 0.55 * exp(-max(above, 0.0) / 0.06) * step(0.0, above) * smoothstep(${g(CONSOLE_INNER)} - 0.02, ${g(CONSOLE_INNER)} + 0.05, ax);
  light += vec3(0.45, 0.7, 1.0) * 0.5 * exp(-max(d.y + 0.39, 0.0) / 0.12) * (1.0 - smoothstep(0.2, 0.45, ax)) * step(-0.39, d.y);
  col *= mix(light * 1.3, vec3(1.0), glass);
  return vec4(col, glass);
}

void main() {
  px = 1.0 / uRes.y;
  vec4 sum = vec4(0.0);
  float best = -1.0;
  vec2 tag = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec4 c = room((gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y);
    sum += vec4(uPass == 0 ? c.rgb : vec3(eAmt, 0.0, 0.0), c.a);
    if (eAmt > best) {
      best = eAmt;
      tag = vec2(eIdx, eId);
    }
  }
  sum *= 0.25;
  if (uPass == 0) {
    outColor = vec4(sum.rgb + dither8(gl_FragCoord.xy), sum.a);
  } else {
    outColor = vec4(sum.r, tag.x / 3.0, tag.y / 255.0, 0.0);
  }
}
`;

/**
 * The outside, cached at reduced resolution and only inside the viewports'
 * bounds: stars, a faint nebula, the planet if shown, and the station's docking
 * ring and pylons lit by a distant sun. Alpha is the station's coverage, so
 * ships can pass behind it.
 */
const OUTSIDE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uAspect;
uniform float uK;
uniform uint uSalt;
/** Planet centre (frame units), radius; radius 0 for none. */
uniform vec3 uPlanet;
out vec4 outColor;
${COMMON_GLSL}
const vec3 SUN = vec3(${SUN.map((x) => g(x)).join(", ")});
const vec3 HULL = vec3(0.36, 0.3, 0.24);
const vec4 RING = vec4(${RING.map((x) => g(x)).join(", ")});

vec3 stars(vec2 f, float cell, float density, uint salt) {
  vec2 sp = f / cell;
  vec2 c = floor(sp);
  uint h = cellHash(c, salt);
  if (r8(h, 0) > density) {
    return vec3(0.0);
  }
  vec2 at = c + 0.2 + 0.6 * vec2(r8(h, 1), r8(h, 2));
  vec2 dd = (sp - at) * cell;
  float sig = 0.75 * px;
  float b = 0.05 + 0.9 * pow(r8(h, 3), 3.0);
  vec3 tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.75, 0.85, 1.0), r8(hash32(h), 0));
  return tint * b * exp(-dot(dd, dd) / (2.0 * sig * sig));
}

vec2 bez(vec2 a, vec2 b, vec2 c, float t) {
  float s = 1.0 - t;
  return s * s * a + 2.0 * s * t * b + t * t * c;
}

/** Nearest point on a pylon's centre curve: distance, how far along (0..1), and the offset to p. */
vec4 curveDist(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec4 best = vec4(1e9, 0.0, 0.0, 0.0);
  vec2 prev = a;
  for (int i = 1; i <= 16; i++) {
    vec2 cur = bez(a, b, c, float(i) / 16.0);
    vec2 pa = p - prev;
    vec2 ba = cur - prev;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    vec2 w = pa - ba * h;
    float dd = length(w);
    if (dd < best.x) {
      best = vec4(dd, (float(i - 1) + h) / 16.0, w);
    }
    prev = cur;
  }
  return best;
}

/** A pylon, premultiplied colour and coverage: a tapering, rounded arm with ribs and a few lights. */
vec4 pylon(vec2 d, vec4 pa, vec4 pb, uint salt) {
  vec4 cd = curveDist(d, pa.xy, pa.zw, pb.xy);
  // Tapering, with a swollen docking clamp near the tip.
  float w = mix(pb.z, pb.w, cd.y) + 0.45 * pb.z * exp(-pow((cd.y - 0.84) / 0.06, 2.0));
  float a = cover(cd.x - w);
  if (a <= 0.0) {
    return vec4(0.0);
  }
  float s = clamp(cd.x / w, 0.0, 1.0);
  vec2 n2 = cd.x > 1e-6 ? cd.zw / cd.x : vec2(0.0);
  vec3 n = vec3(n2 * s, sqrt(max(0.0, 1.0 - s * s)));
  vec3 sunv = vec3(SUN.xy, -SUN.z);
  float lit = 0.08 + 0.92 * max(dot(n, sunv), 0.0);
  vec3 c = HULL * vec3(0.95, 0.8, 0.62) * lit;
  float rib = abs(fract(cd.y * 18.0) - 0.5);
  c *= 1.0 - 0.5 * (1.0 - smoothstep(0.04, 0.1, rib));
  // A seam down the arm, and a few lit windows along it.
  c *= 1.0 - 0.35 * (1.0 - smoothstep(0.05, 0.15, abs(s - 0.45)));
  float wl = fract(cd.y * 40.0);
  uint h = hash32(uint(cd.y * 40.0) ^ salt);
  if ((h & 7u) == 0u && cd.y < 0.75) {
    c += vec3(1.0, 0.75, 0.45) * 0.35 * (1.0 - smoothstep(0.1, 0.25, abs(wl - 0.5))) * (1.0 - smoothstep(0.1, 0.3, s));
  }
  return vec4(c * a, a);
}

/** The station: the docking ring's far arc with the hull below it, and two pylons. */
vec4 station(vec2 d) {
  vec4 out_ = vec4(0.0);
  float u = (d.x - RING.x) / RING.z;
  if (abs(u) < 1.0) {
    float top = RING.y + RING.w * sqrt(1.0 - u * u);
    float e = top - d.y;
    float a = cover(-e);
    if (a > 0.0) {
      vec3 c;
      float seam = abs(fract(d.x / 0.04) - 0.5) * 0.04;
      if (e < 0.011) {
        // The ring's upper face, catching the sun.
        c = HULL * (0.85 + 0.25 * e / 0.011);
      } else if (e < 0.05) {
        // Its outer face: shaded, with rows of lit windows.
        c = HULL * 0.22;
        float row = floor((e - 0.011) / 0.013);
        float yIn = (e - 0.011) - (row + 0.5) * 0.013;
        float cx = floor(d.x / 0.009);
        uint h = cellHash(vec2(cx, row), uSalt ^ 0x2545u);
        if (r8(h, 0) < 0.35) {
          float wx = abs(fract(d.x / 0.009) - 0.5) * 0.009;
          c += vec3(1.0, 0.78, 0.5) * (0.25 + 0.5 * r8(h, 1)) * cover(wx - 0.0025) * cover(abs(yIn) - 0.0018);
        }
        c *= 1.0 - 0.3 * cover(seam - 0.0012);
      } else {
        // The hull below, mostly in shadow, with a few lights.
        c = HULL * (0.12 + 0.06 * vnoise(d * 60.0, uSalt));
        uint h = cellHash(floor(d / 0.02), uSalt ^ 0x77u);
        if (r8(h, 0) < 0.08) {
          vec2 at = (floor(d / 0.02) + 0.5) * 0.02;
          c += vec3(1.0, 0.8, 0.55) * 0.5 * exp(-dot(d - at, d - at) / (2.0 * px * px));
        }
      }
      c *= 1.0 - 0.35 * cover(seam - 0.0008) * step(e, 0.011);
      out_ = vec4(c * a, a);
    }
  }
${PYLONS.map(
  (p, i) => `  {
    vec4 pc = pylon(d, vec4(${g(p[0])}, ${g(p[1])}, ${g(p[2])}, ${g(p[3])}), vec4(${g(p[4])}, ${g(p[5])}, ${g(p[6])}, ${g(p[7])}), uSalt + ${String(i + 1)}u);
    out_ = out_ * (1.0 - pc.a) + pc;
  }`,
).join("\n")}
  return out_;
}

vec3 planet(vec2 f) {
  vec2 q = (f - uPlanet.xy) / uPlanet.z;
  float r = length(q);
  vec3 atmo = vec3(0.35, 0.55, 0.9);
  if (r > 1.0) {
    float rim = exp(-(r - 1.0) * 35.0 * uPlanet.z);
    return atmo * 0.25 * rim * smoothstep(-0.3, 0.6, dot(normalize(q), normalize(SUN.xy)));
  }
  vec3 n = vec3(q, sqrt(max(0.0, 1.0 - r * r)));
  vec3 sunv = vec3(SUN.xy, -SUN.z);
  float diff = max(dot(n, sunv), 0.0);
  vec2 uv = q * 3.0 + vec2(5.0, 2.0);
  float land = 0.6 * vnoise(uv, uSalt ^ 9u) + 0.3 * vnoise(uv * 2.7, uSalt ^ 10u) + 0.1 * vnoise(uv * 7.0, uSalt ^ 11u);
  vec3 surf = land > 0.5 ? mix(vec3(0.3, 0.27, 0.17), vec3(0.42, 0.33, 0.22), smoothstep(0.5, 0.75, land)) : vec3(0.05, 0.1, 0.18);
  float cloud = smoothstep(0.55, 0.8, vnoise(uv * vec2(1.5, 4.0), uSalt ^ 12u) * 0.7 + vnoise(uv * 6.0, uSalt ^ 13u) * 0.3);
  surf = mix(surf, vec3(0.85), cloud * 0.8);
  float a = clamp((1.0 - r) / (px / uPlanet.z) + 0.5, 0.0, 1.0);
  return (surf * (0.02 + 0.9 * diff) + atmo * 0.4 * pow(1.0 - n.z, 3.0) * (0.3 + diff)) * a;
}

void main() {
  px = 1.0 / uRes.y;
  vec2 f = (gl_FragCoord.xy / uRes - 0.5) * vec2(uAspect, 1.0);
  vec2 d = vec2(f.x / uK, f.y);
  vec3 col = vec3(0.003, 0.004, 0.01);
  // A faint nebula, mostly over to the right.
  float neb = 0.6 * vnoise(f * 3.0, uSalt ^ 3u) + 0.3 * vnoise(f * 7.0, uSalt ^ 4u) + 0.1 * vnoise(f * 15.0, uSalt ^ 5u);
  col += mix(vec3(0.05, 0.02, 0.07), vec3(0.02, 0.04, 0.09), smoothstep(0.0, 0.8, f.x)) * smoothstep(0.42, 0.85, neb) * (0.5 + 0.5 * smoothstep(-0.5, 0.7, f.x));
  col += stars(f, 0.022, 0.5, uSalt ^ 6u) + stars(f, 0.041, 0.6, uSalt ^ 7u) * 1.2;
  if (uPlanet.z > 0.0) {
    vec2 q = (f - uPlanet.xy) / uPlanet.z;
    col *= 1.0 - clamp((1.0 - length(q)) * uPlanet.z / px + 0.5, 0.0, 1.0);
    col += planet(f);
  }
  vec4 st = station(d);
  col = col * (1.0 - st.a) + st.rgb;
  outColor = vec4(col, st.a);
}
`;

/**
 * Per frame: the cached room, its glowing panels coloured for the lighting and
 * dimmed cell by cell, the live graphs, and through the glass the cached
 * outside with the station's beacons, the anomaly and a passing ship.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uRoom;
uniform sampler2D uEmit;
uniform sampler2D uOutside;
uniform sampler2D uCells;
uniform sampler2D uGraph;
uniform vec2 uRes;
uniform float uK;
uniform vec3 uAmbient;
uniform vec3 uPal[4];
/** Panel brightness, alert strip brightness. */
uniform vec2 uLevels;
/** Anomaly centre (frame units), radius, openness. */
uniform vec4 uAnom;
uniform float uSpin;
uniform int uShipKind;
/** Ship centre (view space) and turn. */
uniform vec4 uShip;
uniform float uShipScale;
uniform float uShipPx;
uniform vec2 uBeacons[${String(MAX_BEACONS)}];
uniform float uBeaconPhase;
uniform vec4 uGraphs[${String(GRAPH_COUNT)}];
uniform float uGraphShift;
${GRAPH_DISTANCE_GLSL}
out vec4 outColor;
${COMMON_GLSL}
${OPS_SHIP_GLSL}
${DITHER_GLSL}
const vec3 LIGHT = vec3(${SUN.map((x) => g(x)).join(", ")});
const vec3 GLASS = vec3(0.86, 0.9, 0.94);
const float FOCAL = ${g(FOCAL)};
const float STATION_Z = ${g(STATION_Z)};

/** The anomaly: a slowly turning blue-white swirl round a bright core, sized and lit by how open it is. */
vec3 anomaly(vec2 f) {
  vec2 q = (f - uAnom.xy) / uAnom.z;
  q.y /= 0.72;
  float r = length(q);
  if (r > 2.5) {
    return vec3(0.0);
  }
  float c = cos(uSpin);
  float s = sin(uSpin);
  vec2 rq = mat2(c, -s, s, c) * q;
  float a = atan(q.y, q.x);
  float sw = a + 3.2 * log(max(r, 1e-3)) - uSpin;
  float wob = vnoise(rq * 3.0 + 7.0, 41u) + 0.5 * vnoise(rq * 8.0, 42u);
  float arms = 0.5 + 0.5 * cos(6.0 * sw + 3.0 * wob);
  arms *= 0.6 + 0.4 * vnoise(rq * 14.0, 43u);
  float disc = 1.0 - smoothstep(0.15, 1.05, r);
  float core = exp(-r * r * 14.0);
  float iris = exp(-pow((r - 0.36) / 0.13, 2.0));
  float halo = exp(-max(r - 0.7, 0.0) * 3.0) * 0.12;
  vec3 blue = vec3(0.22, 0.45, 1.0);
  vec3 col = mix(blue, vec3(0.8, 0.9, 1.0), smoothstep(0.2, 0.9, arms * disc + 0.5 * iris)) * disc * (0.2 + 0.8 * arms) * 0.7;
  col += vec3(0.55, 0.75, 1.0) * iris * (0.25 + 0.35 * arms);
  col += vec3(0.95, 0.97, 1.0) * core + blue * halo;
  return col * uAnom.w;
}

/** A live graph's trace: a polyline through its row of random-walk samples, scrolling left. */
float graph(vec2 f, int i) {
  vec4 r = uGraphs[i];
  vec2 size = r.zw - r.xy;
  vec2 gp = (f - r.xy) / size;
  float dm = graphDistance(i, gp, size, vec2(0.1, 0.8));
  float line = clamp(0.5 - (dm - 0.0012) / px, 0.0, 1.0) + 0.2 * exp(-dm / 0.003);
  vec2 cell = abs(fract(gp * vec2(8.0, 4.0)) - 0.5) / vec2(8.0, 4.0) * size;
  float grid = 0.12 * clamp(0.5 - (min(cell.x, cell.y) - 0.0004) / px, 0.0, 1.0);
  float ends = smoothstep(0.0, 0.03, gp.x) * (1.0 - smoothstep(0.97, 1.0, gp.x));
  return (line + grid) * ends;
}

void main() {
  px = 1.0 / uRes.y;
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 room = texelFetch(uRoom, fc, 0);
  vec2 f = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 col = room.rgb * uAmbient;
  vec4 e = texelFetch(uEmit, fc, 0);
  if (e.r > 0.0) {
    int idx = int(e.g * 3.0 + 0.5);
    float level = idx == 3 ? uLevels.y : uLevels.x * texelFetch(uCells, ivec2(int(e.b * 255.0 + 0.5), 0), 0).r * ${g(1.25)};
    col += uPal[idx] * e.r * level * 0.85;
  }
  for (int i = 0; i < ${String(GRAPH_COUNT)}; i++) {
    vec4 r = uGraphs[i];
    if (f.x > r.x && f.x < r.z && f.y > r.y && f.y < r.w) {
      col += uPal[(i & 1) == 0 ? 1 : 0] * graph(f, i) * uLevels.x * 0.8;
    }
  }
  vec2 d = vec2(f.x / uK, f.y);
  if (room.a > 0.002) {
    vec4 o = texture(uOutside, gl_FragCoord.xy / uRes);
    vec3 view = o.rgb;
    if (uAnom.w > 0.0) {
      view += anomaly(f) * (1.0 - o.a);
    }
    for (int i = 0; i < ${String(MAX_BEACONS)}; i++) {
      vec2 bq = f - uBeacons[i];
      float pulse = 0.5 - 0.5 * cos(TAU * (uBeaconPhase + float(i) * 0.37));
      vec3 bc = i == 0 ? vec3(1.0, 0.25, 0.15) : i == 1 ? vec3(0.3, 1.0, 0.4) : vec3(1.0, 0.9, 0.7);
      view += bc * pulse * pulse * 0.9 * exp(-dot(bq, bq) / 0.000006);
    }
    if (uShipKind >= 0) {
      vec3 rd = normalize(vec3(f, FOCAL));
      vec4 ship = opsShip(uShipKind, rd, uShip.xyz, uShipScale, uShip.w, LIGHT, uShipPx);
      if (uShip.z > STATION_Z) {
        ship *= 1.0 - o.a;
      }
      view = view * (1.0 - ship.a) + ship.rgb;
    }
    col += view * GLASS * room.a;
  }
  if (uAnom.w > 0.0) {
    // The anomaly's cool light spilling round the right viewport.
    float ev = sdEll(vec2(d.x - VIEW_X, d.y - VIEW_Y), VIEW_R);
    col += vec3(0.25, 0.45, 1.0) * 0.05 * uAnom.w * uAnom.z / 0.1 * exp(-max(ev, 0.0) / 0.12) * (1.0 - room.a);
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Panel colours: amber, teal, the table's cool white, alert red; normal and at red alert. */
const PAL_NORMAL = [
  [1.0, 0.58, 0.18],
  [0.2, 0.88, 0.72],
  [0.38, 0.6, 0.85],
  [1.0, 0.12, 0.07],
];
const PAL_RED = [
  [1.0, 0.3, 0.1],
  [0.55, 0.28, 0.24],
  [1.0, 0.35, 0.28],
  [1.0, 0.12, 0.07],
];
const AMBIENT_NIGHT = [0.55, 0.55, 0.62];
const AMBIENT_RED = [0.62, 0.3, 0.27];

/**
 * The operations room of an alien-built space station: ribbed bronze
 * bulkheads, sloping consoles of amber and teal panels, a glowing situation
 * table, and two oval viewports onto the docking ring and the stars. Ships
 * arrive and depart now and then, and every few minutes a blue-white anomaly
 * slowly opens in the distance and closes again.
 */
export const stationops = defineEffect(stationopsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);
      const roomProgram = program(ROOM_FRAGMENT);
      const outsideProgram = program(OUTSIDE_FRAGMENT);
      const compProgram = program(COMPOSITE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uK", "uSalt", "uPass"]);
      const ou = createUniforms(gl, outsideProgram, ["uRes", "uAspect", "uK", "uSalt", "uPlanet"]);
      const cu = createUniforms(gl, compProgram, [
        "uRoom",
        "uEmit",
        "uOutside",
        "uCells",
        "uGraph",
        "uRes",
        "uK",
        "uAmbient",
        "uPal",
        "uLevels",
        "uAnom",
        "uSpin",
        "uShipKind",
        "uShip",
        "uShipScale",
        "uShipPx",
        "uBeacons",
        "uBeaconPhase",
        "uGraphs",
        "uGraphShift",
      ]);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uEmit", 1);
      cu.i1("uOutside", 2);
      cu.i1("uCells", 3);
      cu.i1("uGraph", 4);
      gl.useProgram(null);

      const dataTexture = (w: number, h: number) =>
        scope.add(
          createDataTexture(gl, {
            width: w,
            height: h,
            internalFormat: gl.R8,
            format: gl.RED,
            type: gl.UNSIGNED_BYTE,
            data: new Uint8Array(w * h),
            filter: gl.NEAREST,
          }),
          (t) => {
            gl.deleteTexture(t);
          },
        );
      const cellTex = dataTexture(CELL_COUNT, 1);
      const graphTex = dataTexture(GRAPH_SAMPLES, GRAPH_COUNT);
      const cells = new Uint8Array(CELL_COUNT);

      let roomTarget: RenderTarget | null = null;
      let emitTarget: RenderTarget | null = null;
      let outsideTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
        emitTarget?.dispose();
        outsideTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let layout: OpsLayout = opsLayout(16 / 9);
      let roomSeed = Number.NaN;
      let outsideSeed = Number.NaN;
      let outsideShown = "";
      const graphRects = new Float32Array(GRAPH_COUNT * 4);
      const beacons = new Float32Array(MAX_BEACONS * 2);
      const pal = new Float32Array(12);
      const targets = new Float64Array(2);
      const ambient = new Float64Array(3);
      const pass = createShipPass();

      let time = 0;
      let dim = 0;
      let red = 0;
      let lightingSet = false;
      let walk = createGraphWalk(GRAPH_COUNT, 0);
      let walkTime = 0;
      let walkSeed = Number.NaN;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          roomTarget?.dispose();
          emitTarget?.dispose();
          outsideTarget?.dispose();
          roomTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          emitTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          const divisor = Math.max(1, height / OUTSIDE_MAX_H);
          outsideTarget = createRenderTarget(
            gl,
            lowResSize(width, divisor),
            lowResSize(height, divisor),
            gl.RGBA8,
          );
          layout = opsLayout(width / height);
          layout.graphs.slice(0, GRAPH_COUNT).forEach((r, i) => {
            graphRects.set([r.x0, r.y0, r.x1, r.y1], i * 4);
          });
          beacons.fill(-9);
          layout.beacons.slice(0, MAX_BEACONS).forEach((b, i) => {
            beacons.set(b, i * 2);
          });
          gl.useProgram(compProgram);
          gl.uniform4fv(cu.loc.uGraphs, graphRects);
          gl.uniform2fv(cu.loc.uBeacons, beacons);
          gl.useProgram(null);
          roomSeed = Number.NaN;
          outsideSeed = Number.NaN;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!roomTarget || !emitTarget || !outsideTarget) {
            return;
          }
          const seed = Math.floor(clamp(Number.isFinite(p.seed) ? p.seed : 0, 0, 999));
          const salt = hash32(seed + 0x3c6ef372);
          const outside: OutsideId = outsideId(p.outside);
          const k = layout.k;

          // 1. The room and its glowing panels, when the size or variation changes.
          if (seed !== roomSeed) {
            gl.useProgram(roomProgram);
            ru.f2("uRes", width, height);
            ru.f1("uK", k);
            ru.u1("uSalt", salt);
            ru.i1("uPass", 0);
            roomTarget.bind();
            triangle.draw();
            ru.i1("uPass", 1);
            emitTarget.bind();
            triangle.draw();
            roomSeed = seed;
          }

          // 2. The outside, only inside the viewports' bounds.
          if (seed !== outsideSeed || outside !== outsideShown) {
            gl.useProgram(outsideProgram);
            outsideTarget.bind();
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const ow = outsideTarget.width;
            const oh = outsideTarget.height;
            ou.f2("uRes", ow, oh);
            ou.f1("uAspect", width / height);
            ou.f1("uK", k);
            ou.u1("uSalt", salt);
            ou.f3("uPlanet", PLANET[0] * k, PLANET[1], outside === "planet" ? PLANET[2] : 0);
            gl.enable(gl.SCISSOR_TEST);
            const y0 = Math.max(0, Math.floor((VIEW_Y - VIEW_RY + 0.5) * oh) - 2);
            const y1 = Math.min(oh, Math.ceil((VIEW_Y + VIEW_RY + 0.5) * oh) + 2);
            for (const side of [-1, 1]) {
              const xa = side * (VIEW_X - VIEW_RX) * k * oh + ow / 2;
              const xb = side * (VIEW_X + VIEW_RX) * k * oh + ow / 2;
              const x0 = Math.max(0, Math.floor(Math.min(xa, xb)) - 2);
              const x1 = Math.min(ow, Math.ceil(Math.max(xa, xb)) + 2);
              if (x1 > x0 && y1 > y0) {
                gl.scissor(x0, y0, x1 - x0, y1 - y0);
                triangle.draw();
              }
            }
            gl.disable(gl.SCISSOR_TEST);
            outsideSeed = seed;
            outsideShown = outside;
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);

          // 3. Lighting, easing between settings.
          lightingTargets(p.lighting, targets);
          if (!lightingSet) {
            lightingSet = true;
            dim = targets[0];
            red = targets[1];
          }
          dim = approach(dim, targets[0], step / LIGHTING_FADE);
          red = approach(red, targets[1], step / LIGHTING_FADE);
          const pulse = alertPulse(time % ALERT_PERIOD);
          for (let i = 0; i < 4; i++) {
            for (let c = 0; c < 3; c++) {
              pal[i * 3 + c] = PAL_NORMAL[i][c] + (PAL_RED[i][c] - PAL_NORMAL[i][c]) * red;
            }
          }
          for (let c = 0; c < 3; c++) {
            const night = 1 + (AMBIENT_NIGHT[c] - 1) * dim;
            ambient[c] = night + (AMBIENT_RED[c] * (0.92 + 0.08 * pulse) - night) * red;
          }

          // 4. Console lights and graphs.
          fillCellLevels(time, seed, cells);
          gl.activeTexture(gl.TEXTURE3);
          updateDataTexture(gl, cellTex, CELL_COUNT, 1, gl.RED, gl.UNSIGNED_BYTE, cells);
          if (seed !== walkSeed) {
            walkSeed = seed;
            walk = createGraphWalk(GRAPH_COUNT, seed);
            walkTime = 0;
            gl.activeTexture(gl.TEXTURE4);
            updateDataTexture(
              gl,
              graphTex,
              GRAPH_SAMPLES,
              GRAPH_COUNT,
              gl.RED,
              gl.UNSIGNED_BYTE,
              walk.values,
            );
          }
          walkTime += step;
          if (advanceGraph(walk, walkTime)) {
            gl.activeTexture(gl.TEXTURE4);
            updateDataTexture(
              gl,
              graphTex,
              GRAPH_SAMPLES,
              GRAPH_COUNT,
              gl.RED,
              gl.UNSIGNED_BYTE,
              walk.values,
            );
          }

          // 5. Composite.
          gl.useProgram(compProgram);
          cu.f2("uRes", width, height);
          cu.f1("uK", k);
          cu.f3("uAmbient", ambient[0], ambient[1], ambient[2]);
          gl.uniform3fv(cu.loc.uPal, pal);
          cu.f2("uLevels", 1 - 0.25 * dim, red * (0.2 + 0.8 * pulse));
          const open = anomalyOpen(time, seed, outside, p.anomaly);
          const site = ANOMALY_SITES[outside];
          cu.f4("uAnom", site[0] * k, site[1], site[2] * (0.3 + 0.7 * open), open);
          cu.f1("uSpin", 2 * Math.PI * fract(time / ANOMALY_SPIN));
          shipAt(time, seed, p.traffic, k, pass);
          cu.i1("uShipKind", pass.kind);
          if (pass.kind >= 0) {
            cu.f4("uShip", pass.x, pass.y, pass.z, pass.yaw);
            cu.f1("uShipScale", pass.scale);
            cu.f1("uShipPx", 1 / (height * FOCAL));
          }
          cu.f1("uBeaconPhase", fract(time / BEACON_PERIOD));
          cu.f1("uGraphShift", graphShift(walkTime));
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, graphTex);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, cellTex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, outsideTarget.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, emitTarget.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, roomTarget.texture);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
