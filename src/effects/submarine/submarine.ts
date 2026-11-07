import { FISH_FRAGMENT, FISH_VERTEX } from "../aquarium/aquarium-fish";
import { createFishSim, type FishEnv, fishInstances, stepFishSim } from "../aquarium/aquarium-sim";
import { GLOW_CAP } from "../biolum/biolum-sim";
import { advanceGraph, createGraphWalk } from "../bridge/bridge-graph";
import { tileFragment } from "../caustics/caustics";
import {
  advancePhases,
  CAUSTIC_RATES,
  tileMatrices,
  tileResolution,
} from "../caustics/caustics-sim";
import type { Rgb } from "../color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  type RenderTarget,
  withScope,
} from "../gl";
import {
  BELL_FRAGMENT,
  BELL_SHAPE,
  bellVertex,
  STRIP_FRAGMENT,
  STRIP_VERTEX,
} from "../jellyfish/jellyfish-shaders";
import {
  CHAINS_PER_JELLY,
  createSwarm,
  paletteFor,
  STRIP_FLOATS,
  STRIP_VERTS,
  type Swarm,
} from "../jellyfish/jellyfish-sim";
import { MAX_JELLIES } from "../jellyfish/jellyfish.meta";
import { approach, smoothstep, wrap } from "../math";
import { createRng, HASH32_GLSL } from "../noise";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import { MAX_FISH, submarineMeta } from "./submarine.meta";
import {
  CHAIR_ROUND,
  CHAIR_TOP,
  createWhales,
  createZones,
  depthAt,
  depthReading,
  DIAL_START,
  DIAL_SWEEP,
  easeDepth,
  GLASS_R,
  INNER_HALF,
  INNER_RING,
  LAMP_SHADE_H,
  LAMP_SHADE_HALF,
  needleAngle,
  PEAK_SINK,
  PIPE_R,
  pressureReading,
  RING_W,
  SHELF_Y,
  stepWhales,
  strokePhase,
  STRUT_HALF,
  STRUTS,
  type SubLayout,
  submarineLayout,
  TOP_PIPE_Y,
  walkWander,
  waterAt,
  whaleProgress,
  whaleX,
  zonesAt,
} from "./submarine-sim";

const v3 = (c: Rgb | readonly number[]) => `vec3(${F(c[0])}, ${F(c[1])}, ${F(c[2])})`;

/** The view outside covers the glass plus this margin (glass units), at 1 / OUT_DIV of the device resolution. */
const SPAN = 1.04;
const OUT_DIV = 2;
/** The glass's bulge: the centre is magnified by 1 / (1 - BULGE), the rim not at all. */
const BULGE = 0.08;
/** Caustic period on the sea floor (glass units), morph rate and drifts (tile periods per second). */
const CAUSTIC_PERIOD = 0.8;
const CAUSTIC_RATE = 0.2;
const DRIFT_A: readonly [number, number] = [0.008, 0.004];
const DRIFT_B: readonly [number, number] = [-0.004, 0.006];
const TILE_INTERVAL = 1 / 30;
/** Marine snow: cell sizes of its two layers (glass units) and their rise (glass units per second). */
const SNOW_CELL_A = 0.07;
const SNOW_CELL_B = 0.12;
const SNOW_RISE = 0.018;
/** The snow's slow sideways sway (glass units) and its period (s). */
const SNOW_SWAY = 0.05;
const SNOW_SWAY_PERIOD = 120;
/** The sea floor's top in the shallows (glass units), and how far it falls away below the glass. */
const FLOOR_TOP = -0.62;
const FLOOR_DROP = 1;
/** Extra rise while the vessel sinks at its fastest, as a share of SNOW_RISE. */
const SNOW_SINK_BOOST = 1.6;
/** Cells per period of the hashed snow and glow grids, so their offsets wrap without a jump. */
const GRID_PERIOD = 64;
/** Bioluminescence grid cell (glass units); its time wraps at the flash periods' common multiple. */
const GLOW_CELL = 0.42;
const GLOW_PERIODS = [10, 12, 15, 20, 24, 30] as const;
const GLOW_WRAP = 120;
/** Seconds the whale takes to fade when switched off or on. */
const WHALE_FADE = 2;
/** Seconds the needles take to settle on a new reading. */
const NEEDLE_LAG = 0.5;

const WALNUT: Rgb = [0.17, 0.085, 0.042];
const BRASS: Rgb = [0.8, 0.58, 0.27];
const IRON: Rgb = [0.055, 0.052, 0.055];
const CREAM: Rgb = [0.86, 0.8, 0.64];
const INK: Rgb = [0.06, 0.05, 0.04];
const LEATHER: Rgb = [0.26, 0.055, 0.04];
const LAMP_RGB: Rgb = [1, 0.66, 0.34];
const SHADE_RGB: Rgb = [1, 0.6, 0.26];
const AMBER_GLOW: Rgb = [1.0, 0.7, 0.4];
const BIOLUM: Rgb = [0.17, 0.77, 1];
const BIOLUM_B: Rgb = [0.35, 1, 0.72];
const SAND: Rgb = [0.5, 0.46, 0.34];

/** Value noise, hashed with lowbias32 so every GPU agrees. */
const NOISE_GLSL = /* glsl */ `
${HASH32_GLSL}
float hash2(vec2 c, float s) {
  uvec2 u = uvec2(ivec2(floor(c)) + 65536);
  return float(hash32(u.x ^ hash32(u.y ^ hash32(uint(s) + 0x9e3779b9u)))) / 4294967296.0;
}
float vnoise(vec2 p, float s) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  return mix(mix(hash2(i, s), hash2(i + vec2(1.0, 0.0), s), t.x),
             mix(hash2(i + vec2(0.0, 1.0), s), hash2(i + vec2(1.0, 1.0), s), t.x), t.y);
}
`;

/** Coverage from a signed distance in reference px (positive inside), anti-aliased at the device pixel. */
const COVER_GLSL = /* glsl */ `
float cov(float d) { return clamp(d * uScale + 0.5, 0.0, 1.0); }
`;

/** Lamp light and brass shading, shared by the cached room and the live needles' caps. */
const LIGHT_GLSL = /* glsl */ `
const vec3 LAMP_RGB = ${v3(LAMP_RGB)};
const vec3 BRASS = ${v3(BRASS)};
/** The lamp's warm light on the wall at p (reference px). */
vec3 lampLight(vec2 p) {
  vec2 d = p - uLamp;
  return LAMP_RGB * 1.1 / (1.0 + dot(d, d) * ${F(1 / (240 * 240))});
}
/** Brass with surface normal n at p: a little ambient, the lamp's diffuse light and a soft highlight. */
vec3 brass(vec3 n, vec2 p) {
  vec3 l = vec3(uLamp - p, 160.0);
  float dist = length(l);
  l /= dist;
  float fall = 1.0 / (1.0 + dist * dist * ${F(1 / (460 * 460))});
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 22.0);
  vec3 c = BRASS * (0.07 + 0.08 * max(n.y, 0.0) + 1.25 * diff * fall);
  return c + LAMP_RGB * spec * fall * 1.1 + BRASS * 0.09 * pow(max(n.y, 0.0), 6.0);
}
`;

/**
 * The salon, drawn once per resize or change of side, at full resolution in
 * reference px: walnut panelling, the brass viewport ring with its rivets on
 * an iron backing plate, the struts and inner ring across the glass, the
 * pipes, the valve wheel, the two dials (cream faces, ticks, and numbers from
 * the label texture), the shelf and its lamp, and a leather chair back in the
 * far corner, all lit by the lamp. Alpha is 0 over the glass, where the colour
 * carries a faint reflection of the lamp to add over the view. Premultiplied.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform float uScale;
uniform float uWidth;
/** Glass centre; side (-1 gauges left, +1 right). */
uniform vec3 uGlass;
uniform vec2 uLamp;
/** Dials: centre x, y, face radius. */
uniform vec3 uDepth;
uniform vec3 uPress;
/** Pipe A x, pipe B x, shelf end x, chair width. */
uniform vec4 uParts;
uniform sampler2D uLabels;
out vec4 outColor;
${NOISE_GLSL}
${COVER_GLSL}
${LIGHT_GLSL}
${DITHER_GLSL}
const float PI = 3.14159265;
const float GR = ${F(GLASS_R)};
const float RW = ${F(RING_W)};

vec3 lit(vec3 base, vec2 p, float amb) {
  return base * (amb + 1.5 * lampLight(p));
}

/** Walnut panelling: raised panels in moulded frames, with grain. */
vec3 walnut(vec2 p) {
  float pw = 270.0;
  float xc = p.x - 0.5 * uWidth;
  float col = floor(xc / pw + 0.5);
  float lx = xc - col * pw;
  bool lower = p.y < 390.0;
  float y0 = lower ? 34.0 : 430.0;
  float y1 = lower ? 362.0 : 990.0;
  float inX = 0.5 * pw - abs(lx) - 24.0;
  float inY = min(p.y - y0, y1 - p.y);
  float din = min(inX, inY);
  float g = vnoise(vec2(p.x * 0.11 + col * 17.0, p.y * 0.007), 3.0);
  float s = vnoise(vec2(p.x * 0.035 + col * 5.0 + 2.5 * g, p.y * 0.0016), 7.0);
  vec3 base = ${v3(WALNUT)} * (0.7 + 0.45 * s) * (0.9 + 0.2 * g);
  // The frame round each panel is a shade darker; the panel's bevel catches the light.
  float field = smoothstep(-1.0, 1.0, din);
  float shade = mix(0.82, 1.0, field);
  if (din > 0.0 && din < 16.0) {
    vec2 n = inX < inY ? vec2(sign(lx), 0.0) : vec2(0.0, p.y - y0 < y1 - p.y ? -1.0 : 1.0);
    vec2 toLamp = normalize(uLamp - p);
    shade *= 1.0 + 0.35 * dot(n, toLamp) + 0.2 * n.y;
  }
  shade *= 1.0 - 0.5 * exp(-abs(din) * 0.6) * (1.0 - field * 0.6);
  // Dado rail and the cornice under the top pipe: rounded mouldings.
  float rail = 1.0 - smoothstep(14.0, 17.0, abs(p.y - 396.0));
  float cornice = smoothstep(997.0, 1000.0, p.y) * (1.0 - smoothstep(1020.0, 1023.0, p.y));
  float band = max(rail, cornice);
  if (band > 0.0) {
    float t = rail > 0.0 ? (p.y - 396.0) / 16.0 : (p.y - 1010.0) / 12.0;
    shade = mix(shade, 1.05 + 0.4 * t, band);
  }
  // Skirting.
  shade *= mix(0.7, 1.0, smoothstep(30.0, 34.0, p.y));
  return base * shade;
}

/** A vertical pipe of radius r at x = px: brass, with flanges every 250 px. */
void pipe(vec2 p, float px, float r, float phase, float y1, inout vec3 col, inout float a) {
  float dx = p.x - px;
  float fy = p.y + phase;
  float fl = abs(fy - 250.0 * floor(fy / 250.0 + 0.5));
  float rr = r + (fl < 9.0 ? 5.0 : 0.0);
  // Soft shadow on the wall to one side.
  col *= 1.0 - 0.45 * exp(-max(abs(dx - 6.0) - rr, 0.0) * 0.08) * step(p.y, y1);
  float c = cov(rr - abs(dx)) * cov(y1 - p.y);
  if (c > 0.0) {
    float s = clamp(dx / rr, -1.0, 1.0);
    vec3 n = vec3(s, fl < 9.0 ? (fy - 250.0 * floor(fy / 250.0 + 0.5)) / 12.0 : 0.0, sqrt(max(1.0 - s * s, 0.0)));
    col = mix(col, brass(normalize(n), p) * 0.85, c);
    a = max(a, c);
  }
}

/** A round brass-bezelled dial at d (x, y, face radius), its numbers in label cell \`cell\`. */
void dial(vec2 p, vec3 d, float cell, bool redZone, inout vec3 col) {
  vec2 q = p - d.xy;
  float r = length(q);
  float R = d.z;
  float bez = 0.16 * R;
  if (r > R + bez + 40.0) return;
  // Shadow on the wall below and right.
  float sh = length(q - vec2(6.0, -10.0));
  col *= 1.0 - 0.6 * smoothstep(R + bez + 26.0, R + bez - 4.0, sh);
  float cb = cov(R + bez - r);
  if (cb <= 0.0) return;
  // Bezel: a rounded brass ring with six screws.
  float t = clamp((r - R) / bez, 0.0, 1.0);
  vec2 rad = q / max(r, 1e-3);
  vec3 n = normalize(vec3(rad * -cos(PI * t) * 0.9, sin(PI * t) + 0.3));
  vec3 c = brass(n, p);
  float ang = atan(q.y, q.x);
  float k = floor(ang / (PI / 3.0) + 0.5) * (PI / 3.0) + PI / 6.0;
  vec2 sc = d.xy + vec2(cos(k), sin(k)) * (R + 0.5 * bez) - p;
  float sr = 0.22 * bez;
  float screw = cov(sr - length(sc));
  vec3 sn = normalize(vec3(-sc / sr, 0.6));
  c = mix(c, brass(sn, p) * (1.0 - 0.7 * cov(0.8 - abs(dot(sc, vec2(0.7, 0.7))))), screw);
  // Face: aged cream, shadowed by the bezel at its edge.
  float cf = cov(R - r);
  if (cf > 0.0) {
    vec3 face = ${v3(CREAM)} * (0.9 + 0.1 * vnoise(q * 0.06, 11.0 + cell));
    face *= 1.0 - 0.45 * smoothstep(0.75 * R, R, r);
    float s = mod(${F(DIAL_START)} - ang, 2.0 * PI) / ${F(DIAL_SWEEP)};
    float inScale = cov(min(s, 1.0 - s) * ${F(DIAL_SWEEP)} * r + 1.5);
    float m = s * 30.0;
    float minor = cov(0.9 - abs(m - floor(m + 0.5)) * ${F(DIAL_SWEEP / 30)} * r)
      * cov(min(r - 0.8 * R, 0.9 * R - r));
    float M = s * 6.0;
    float major = cov(1.6 - abs(M - floor(M + 0.5)) * ${F(DIAL_SWEEP / 6)} * r)
      * cov(min(r - 0.7 * R, 0.9 * R - r));
    float arc = cov(0.8 - abs(r - 0.9 * R));
    float ink = max(max(minor, major), arc) * inScale;
    vec2 luv = vec2((cell + 0.5 + 0.5 * q.x / R) * 0.5, 0.5 + 0.5 * q.y / R);
    ink = max(ink, texture(uLabels, luv).r);
    face = mix(face, ${v3(INK)}, ink);
    if (redZone) {
      float zone = smoothstep(0.82, 0.84, s) * cov(min(r - 0.92 * R, 0.97 * R - r)) * inScale;
      face = mix(face, vec3(0.62, 0.08, 0.05), zone);
    }
    face = lit(face, p, 0.12);
    // The cover glass: a soft glint high on the far side from the lamp.
    vec2 gq = (q - vec2(-0.3, 0.45) * R) / R;
    face += vec3(0.05, 0.05, 0.045) * exp(-dot(gq, gq) * 9.0);
    c = mix(c, face, cf);
  }
  col = mix(col, c, cb);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / uScale;
  vec2 g = p - uGlass.xy;
  float r = length(g);
  float side = uGlass.z;
  float a = 1.0;

  vec3 col = lit(walnut(p), p, 0.42);

  // The iron backing plate round the ring, its bolts, and its shadow on the wall.
  float plateR = GR + RW + 22.0;
  col *= 1.0 - 0.6 * smoothstep(plateR + 30.0, plateR - 4.0, length(g - vec2(8.0, -14.0)));
  vec2 rad = g / max(r, 1e-3);
  float ang = atan(g.y, g.x);
  float cp = cov(plateR - r);
  if (cp > 0.0) {
    vec3 iron = ${v3(IRON)} * (0.8 + 0.4 * vnoise(g * 0.08, 5.0));
    iron = lit(iron, p, 0.9);
    float k = floor(ang / (PI / 18.0) + 0.5) * (PI / 18.0);
    vec2 bq = g - vec2(cos(k), sin(k)) * (GR + RW + 11.0);
    float bolt = cov(4.5 - length(bq));
    iron = mix(iron, brass(normalize(vec3(-bq / 4.5, 0.7)), p) * 0.6, bolt);
    col = mix(col, iron, cp);
  }

  // The brass ring: a rounded bead at each edge, a flat face between with large rivets.
  float t = (r - GR) / RW;
  float cr = cov(GR + RW - r) * cov(r - GR + 1.0);
  if (cr > 0.0) {
    float slope = t < 0.2 ? -cos(PI * t / 0.2) : t > 0.84 ? -cos(PI * (t - 0.84) / 0.16) : 0.0;
    vec3 n = normalize(vec3(rad * slope * 0.9, 1.0));
    vec3 c = brass(n, p) * (t > 0.2 && t < 0.84 ? 0.85 : 1.0);
    // Shadow of the beads on the flat face.
    c *= 1.0 - 0.35 * (1.0 - smoothstep(0.2, 0.28, t)) * step(0.2, t);
    float k = floor(ang / (PI / 14.0) + 0.5) * (PI / 14.0);
    vec2 rq = g - vec2(cos(k), sin(k)) * (GR + 0.52 * RW);
    float rv = 9.5;
    float rl = length(rq);
    c *= 1.0 - 0.45 * cov(rv + 2.5 - length(rq - vec2(2.0, -3.0))) * (1.0 - cov(rv - rl));
    float rivet = cov(rv - rl);
    c = mix(c, brass(normalize(vec3(-rq / rv, 0.55)), p), rivet);
    // A dark gasket line where the ring meets the glass.
    c *= mix(0.25, 1.0, smoothstep(0.0, 0.05, t));
    col = mix(col, c, cr);
  }

  // Over the glass: the inner ring and the struts out to the rim.
  if (r < GR + 1.0) {
    float ir = ${F(INNER_RING * GLASS_R)};
    float ci = cov(${F(INNER_HALF)} - abs(r - ir));
    float sa = ${F((2 * Math.PI) / STRUTS)};
    float k = floor((ang - 0.5 * sa) / sa + 0.5) * sa + 0.5 * sa;
    vec2 dirk = vec2(cos(k), sin(k));
    float along = dot(g, dirk);
    float across = dot(g, vec2(-dirk.y, dirk.x));
    float cs = cov(${F(STRUT_HALF)} - abs(across)) * cov(along - ir);
    vec3 strut = brass(normalize(vec3(vec2(-dirk.y, dirk.x) * clamp(across / ${F(STRUT_HALF)}, -1.0, 1.0), 0.75)), p);
    vec3 ring = brass(normalize(vec3(rad * clamp((r - ir) / ${F(INNER_HALF)}, -1.0, 1.0), 0.75)), p);
    float c = max(ci, cs);
    vec3 bc = ci >= cs ? ring : strut;
    // A faint reflection of the lamp in the bulging glass, and a cool sheen at the top.
    vec2 lampDir = normalize(uLamp - uGlass.xy);
    vec2 hq = (g - (lampDir * 0.72 + vec2(0.0, -0.06)) * GR) / vec2(34.0, 22.0);
    vec3 refl = ${v3(AMBER_GLOW)} * (0.07 * exp(-dot(hq, hq)) + 0.012 * exp(-dot(hq, hq) * 0.08));
    vec2 tq = g / GR - vec2(-0.2 * side, 0.82);
    refl += vec3(0.02, 0.025, 0.03) * exp(-dot(tq, tq) * 14.0);
    // Premultiplied: the glass (struts and reflection) blended over the ring's inner bead at the rim.
    float gc = cov(GR - r);
    col = mix(col, mix(refl, bc, c), gc);
    a = mix(1.0, c, gc);
  }

  // Pipes on the gauges' side, and the one along the top of the wall.
  float topY = ${F(TOP_PIPE_Y)};
  pipe(p, uParts.x, 12.0, 40.0, topY, col, a);
  pipe(p, uParts.y, 9.0, 160.0, topY, col, a);
  // Branches from pipe B to each dial.
  for (int i = 0; i < 2; i++) {
    vec3 d = i == 0 ? uDepth : uPress;
    float lo = min(uParts.y, d.x);
    float hi = max(uParts.y, d.x);
    float dy = p.y - d.y;
    float cbr = cov(5.0 - abs(dy)) * cov(min(p.x - lo, hi - p.x));
    if (cbr > 0.0) {
      vec3 n = normalize(vec3(0.0, dy / 5.0, sqrt(max(1.0 - dy * dy / 25.0, 0.0))));
      col = mix(col, brass(n, p) * 0.85, cbr);
    }
  }
  {
    float dy = p.y - topY;
    float fx = p.x + 90.0;
    float fl = abs(fx - 300.0 * floor(fx / 300.0 + 0.5));
    float rr = ${F(PIPE_R)} + (fl < 9.0 ? 5.0 : 0.0);
    col *= 1.0 - 0.45 * exp(-max(abs(dy + 8.0) - rr, 0.0) * 0.08);
    float c = cov(rr - abs(dy));
    if (c > 0.0) {
      float s = clamp(dy / rr, -1.0, 1.0);
      col = mix(col, brass(normalize(vec3(0.0, s, sqrt(max(1.0 - s * s, 0.0)))), p) * 0.85, c);
    }
  }
  // A valve wheel hanging from the top pipe above the dials.
  {
    vec2 wc = vec2(uDepth.x, topY - 82.0);
    vec2 q = p - wc;
    float wr = length(q);
    float stem = cov(4.0 - abs(q.x)) * cov(q.y) * cov(topY - p.y);
    col = mix(col, brass(vec3(clamp(q.x / 4.0, -1.0, 1.0), 0.0, 0.8), p) * 0.8, stem);
    col *= 1.0 - 0.5 * cov(36.0 - length(q - vec2(5.0, -8.0))) * (1.0 - cov(36.0 - wr));
    float rim = cov(5.0 - abs(wr - 30.0));
    float wa = atan(q.y, q.x);
    float k = floor(wa / (PI * 0.4) + 0.5) * (PI * 0.4) + 0.3;
    float spoke = cov(3.0 - abs(dot(q, vec2(-sin(k), cos(k))))) * cov(dot(q, vec2(cos(k), sin(k)))) * cov(30.0 - wr);
    float hub = cov(7.0 - wr);
    float cw = max(max(rim, spoke), hub);
    vec3 wn = rim >= spoke ? normalize(vec3(q / max(wr, 1.0) * clamp((wr - 30.0) / 5.0, -1.0, 1.0), 0.8)) : vec3(0.0, 0.0, 1.0);
    col = mix(col, brass(wn, p) * vec3(1.0, 0.75, 0.7), cw);
  }

  dial(p, uDepth, 0.0, false, col);
  dial(p, uPress, 1.0, true, col);

  // The shelf, its lamp and the warm pool of light on it.
  {
    float shelfEnd = uParts.z;
    float inShelf = side < 0.0 ? shelfEnd - p.x : p.x - shelfEnd;
    float sy = ${F(SHELF_Y)};
    col *= 1.0 - 0.55 * cov(inShelf + 4.0) * smoothstep(sy - 70.0, sy - 22.0, p.y) * (1.0 - smoothstep(sy - 24.0, sy - 20.0, p.y));
    float cs = cov(inShelf) * cov(min(sy - p.y, p.y - sy + 22.0));
    if (cs > 0.0) {
      vec3 w = ${v3(WALNUT)} * 1.3 * (0.85 + 0.3 * vnoise(vec2(p.x * 0.02, p.y * 0.4), 9.0));
      w *= p.y > sy - 4.0 ? 1.5 : 1.0;
      col = mix(col, lit(w, p + vec2(0.0, 40.0), 0.35), cs);
    }
    vec2 q = p - uLamp;
    float hh = ${F(LAMP_SHADE_H / 2)};
    float bottom = -hh;
    // Stem and foot.
    float stem = cov(3.5 - abs(q.x)) * cov(min(p.y - sy, bottom - q.y));
    col = mix(col, brass(vec3(clamp(q.x / 3.5, -1.0, 1.0), 0.0, 0.8), p), stem);
    vec2 fq = vec2(q.x / 34.0, (p.y - sy - 6.0) / 8.0);
    float foot = cov((1.0 - length(fq)) * 8.0) * cov(p.y - sy + 0.5);
    col = mix(col, brass(normalize(vec3(fq.x, fq.y + 0.3, 0.8)), p), foot);
    // The amber glass shade, glowing from within.
    float u = clamp((q.y - bottom) / ${F(LAMP_SHADE_H)}, 0.0, 1.0);
    float hw = mix(${F(LAMP_SHADE_HALF)}, ${F(LAMP_SHADE_HALF * 0.55)}, u);
    float shade = cov(hw - abs(q.x)) * cov(hh - abs(q.y));
    if (shade > 0.0) {
      float x = q.x / hw;
      vec3 glow = ${v3(SHADE_RGB)} * (0.55 + 0.45 * (1.0 - x * x)) * (0.75 + 0.35 * (1.0 - u));
      float rimC = max(cov(3.0 - abs(q.y - hh)), cov(3.0 - abs(q.y + hh)));
      glow = mix(glow, brass(vec3(0.0, sign(q.y), 0.6), p) * 1.4, rimC);
      col = mix(col, glow, shade);
    }
  }

  // The leather chair back in the far bottom corner: tufted, with a rolled top edge.
  {
    float e = side < 0.0 ? uWidth - p.x : p.x;
    float w = uParts.w;
    float rc = ${F(CHAIR_ROUND)};
    vec2 b = vec2(e, p.y) - vec2(w - rc, ${F(CHAIR_TOP)} - rc);
    float sd = (b.x > 0.0 && b.y > 0.0) ? rc - length(b) : min(w - e, ${F(CHAIR_TOP)} - p.y);
    col *= 1.0 - 0.5 * smoothstep(-6.0, 26.0, sd + 22.0) * (1.0 - cov(sd));
    float cc = cov(sd);
    if (cc > 0.0) {
      vec2 dq = vec2(e + p.y, e - p.y) / 62.0;
      vec2 fq = fract(dq) - 0.5;
      float puff = (1.0 - 4.0 * fq.x * fq.x) * (1.0 - 4.0 * fq.y * fq.y);
      vec3 lth = ${v3(LEATHER)} * (0.55 + 0.6 * puff);
      vec2 bt = (fract(dq + 0.5) - 0.5) * 62.0 * 0.7071;
      lth *= 1.0 - 0.7 * cov(4.0 - length(bt));
      // The rolled top edge: a cylinder along the outline.
      float roll = clamp(sd / 34.0, 0.0, 1.0);
      if (roll < 1.0) {
        float s = 1.0 - 2.0 * roll;
        lth = ${v3(LEATHER)} * (0.55 + 0.75 * sqrt(max(1.0 - s * s, 0.0)) + 0.5 * max(s, 0.0));
        lth *= 1.0 - 0.6 * cov(1.5 - abs(sd - 34.0));
      }
      // Brass nailheads under the roll.
      float nail = cov(3.5 - length(vec2(mod(e, 22.0) - 11.0, sd - 42.0)));
      lth = mix(lth, BRASS * 0.7, nail);
      col = mix(col, lit(lth, p, 0.35), cc);
      a = max(a, cc);
    }
  }

  // The room's corners fall into shadow.
  vec2 vq = (p - vec2(0.5 * uWidth, 540.0)) / vec2(0.5 * uWidth + 200.0, 760.0);
  float vig = 1.0 - 0.55 * smoothstep(0.35, 1.0, dot(vq, vq));
  col *= mix(1.0, vig, a);
  outColor = vec4(col + dither8(frag) * a, a);
}
`;

/** A dial's needle and its brass cap, at the given angle; premultiplied, drawn in a scissor round the dial. */
const NEEDLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uScale;
uniform vec2 uLamp;
/** Dial centre x, y, face radius, needle angle. */
uniform vec4 uDial;
out vec4 outColor;
${COVER_GLSL}
${LIGHT_GLSL}
/** Coverage of the needle at q (dial-local, face radii, needle along +x). */
float needle(vec2 q, float px) {
  float w = q.x > 0.0 ? mix(0.035, 0.006, clamp(q.x / 0.84, 0.0, 1.0)) : 0.03;
  float body = clamp((w - abs(q.y)) / px + 0.5, 0.0, 1.0) * clamp((min(q.x + 0.24, 0.84 - q.x)) / px + 0.5, 0.0, 1.0);
  float weight = clamp((0.07 - length(q - vec2(-0.2, 0.0))) / px + 0.5, 0.0, 1.0);
  return max(body, weight);
}
void main() {
  vec2 p = gl_FragCoord.xy / uScale;
  float R = uDial.z;
  vec2 d = (p - uDial.xy) / R;
  float c = cos(uDial.w);
  float s = sin(uDial.w);
  float px = 1.0 / (R * uScale);
  vec2 q = vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
  vec2 ds = d - vec2(0.025, -0.04);
  vec2 qs = vec2(c * ds.x + s * ds.y, -s * ds.x + c * ds.y);
  float shadow = needle(qs, px * 4.0) * 0.35 * clamp((1.0 - length(d)) / px, 0.0, 1.0);
  float n = needle(q, px);
  float cap = clamp((0.075 - length(d)) / px + 0.5, 0.0, 1.0);
  vec3 col = vec3(0.025, 0.022, 0.02) * n;
  float a = max(n, shadow);
  vec3 capCol = brass(normalize(vec3(d / 0.075, 0.6)), p);
  col = mix(col, capCol, cap);
  a = max(a, cap);
  outColor = vec4(col, a);
}
`;

/**
 * The deep sea outside, at reduced resolution over a square round the glass
 * (glass units, y up): the water's gradient for the depth, light shafts and
 * caustics in the shallows over a sandy floor that sinks out of view, the
 * whale, two layers of marine snow rising past, bioluminescent flashes and
 * small glowing creatures in the abyss, and the vessel's own lamp beam.
 */
const WATER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uRes;
uniform vec3 uTop;
uniform vec3 uDeep;
/** Shallows, jellies, abyss, life. */
uniform vec4 uZones;
/** Time (s, wrapped), the sea floor's height (glass units), the gauges' side, the seed's salt. */
uniform vec4 uClock;
/** Snow offsets (glass units): layer A rise, layer B rise, sideways drift, glow-grid rise. */
uniform vec4 uSnow;
/** Whale: centre x, y, size times direction, opacity. */
uniform vec4 uWhale;
/** Whale: tail stroke phase, fog. */
uniform vec2 uWhale2;
uniform sampler2D uTile;
uniform mat2 uMatA;
uniform mat2 uMatB;
uniform vec2 uOffA;
uniform vec2 uOffB;
out vec4 outColor;
${NOISE_GLSL}
const float PI = 3.14159265;

float caustic(vec2 px) {
  float ca = texture(uTile, uMatA * px + uOffA).r;
  float cb = texture(uTile, uMatB * px + uOffB).r;
  return (ca + cb) * 0.5 + ca * cb;
}

uint cellHash(vec2 id, uint salt) {
  ivec2 i = ivec2(mod(id, ${F(GRID_PERIOD)}));
  return hash32(uint(i.x) * 0x9e3779b1u ^ hash32(uint(i.y) * 0x85ebca77u ^ salt));
}

/** One layer of marine snow: soft motes, one per occupied cell. */
float snow(vec2 g, float cell, vec2 off, float rad, uint salt) {
  vec2 q = g / cell - off / cell;
  vec2 id = floor(q);
  uint h = cellHash(id, salt);
  if ((h & 255u) > 120u) return 0.0;
  vec2 o = 0.2 + 0.6 * vec2(float((h >> 8u) & 255u), float((h >> 16u) & 255u)) / 255.0;
  float r = rad * (0.6 + 0.8 * float(h >> 24u) / 255.0);
  vec2 d = (q - id - o) * cell;
  return exp(-dot(d, d) / (r * r));
}

/** The vessel's lamp, shining up and away from the gauges' side: 0..1. */
float beam(vec2 g) {
  vec2 o = vec2(0.2 * uClock.z, -1.45);
  vec2 ax = normalize(vec2(-0.42 * uClock.z, 1.0));
  vec2 rel = g - o;
  float along = dot(rel, ax);
  float perp = dot(rel, vec2(-ax.y, ax.x));
  float w = 0.1 + 0.32 * max(along, 0.0);
  return smoothstep(0.0, 0.5, along) * exp(-perp * perp / (w * w)) / (1.0 + 0.35 * along * along);
}

/** The whale: (coverage, brightness from above, 0) at g. */
vec3 whale(vec2 g) {
  float size = abs(uWhale.z);
  vec2 w = (g - uWhale.xy) / size;
  w.x *= sign(uWhale.z);
  if (abs(w.x) > 1.25 || abs(w.y) > 0.5) return vec3(0.0);
  float ph = uWhale2.x;
  // The tail end bends with the stroke.
  float tail = clamp((0.15 - w.x) / 1.1, 0.0, 1.0);
  float bend = 0.07 * sin(ph - 1.8 * tail) * tail * tail;
  float y = w.y - bend;
  float x = w.x;
  float hw;
  if (x >= 0.22) {
    float u = (x - 0.22) / 0.72;
    hw = 0.165 * sqrt(max(1.0 - u * u, 0.0));
  } else {
    hw = mix(0.165, 0.032, smoothstep(0.22, -0.72, x));
  }
  float mid = 0.012 * smoothstep(0.9, 0.2, x);
  float top = hw * 0.86;
  float d = y > mid ? top - (y - mid) : hw - (mid - y);
  d = min(d, x + 0.74);
  // Flukes, edge-on, tilting with the stroke.
  float ft = ph - 2.2;
  vec2 fa = vec2(-0.7, bend);
  vec2 fb = vec2(-1.02, bend + 0.1 * sin(ft));
  vec2 pa = vec2(x, w.y) - fa;
  vec2 ba = fb - fa;
  float hf = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float fd = (0.022 + 0.035 * hf * (1.0 - 0.6 * hf)) - length(pa - ba * hf);
  // A long pectoral fin, swept back and down.
  vec2 pf = vec2(x, w.y) - vec2(0.42, -0.1);
  float fa2 = -2.5 + 0.12 * sin(ph);
  vec2 dir = vec2(cos(fa2), sin(fa2));
  float along = clamp(dot(pf, dir), 0.0, 0.34);
  float pd = 0.03 * (1.0 - along / 0.36) - length(pf - dir * along);
  float sd = max(max(d, fd), pd);
  float soft = 0.012 / size;
  float c = smoothstep(-soft, soft, sd);
  // Light from above: the back catches it, the belly falls dark; grooves under the jaw.
  float up = clamp((y - mid + hw) / max(2.0 * hw, 1e-3), 0.0, 1.0);
  float lum = 0.2 + 0.75 * up * up;
  float grooves = step(y, mid - 0.02) * step(0.35, x) * (0.5 + 0.5 * sin(y * 260.0));
  lum *= 1.0 - 0.18 * grooves;
  lum *= 1.0 - 0.6 * smoothstep(0.012, 0.0, length(vec2(x, w.y) - vec2(0.76, 0.0)));
  return vec3(c, lum, 0.0);
}

void main() {
  vec2 g = (gl_FragCoord.xy / uRes * 2.0 - 1.0) * ${F(SPAN)};
  float v = 0.5 - 0.5 * g.y / ${F(SPAN)};
  float shallows = uZones.x;
  float abyss = uZones.z;
  float t = uClock.x;
  vec3 col = mix(uTop, uDeep, smoothstep(0.0, 0.95, v));
  float bm = abyss > 0.0 ? beam(g) * abyss : 0.0;
  float c = 0.0;

  if (shallows > 0.0) {
    c = caustic(gl_FragCoord.xy);
    // Shafts of light from the surface, swaying slowly.
    float shaft = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float x0 = -0.9 + 0.6 * fi + 0.06 * sin(t * ${F((2 * Math.PI) / 40)} + fi * 1.7);
      float dr = (g.x - x0 - 0.22 * (1.2 - g.y)) / (0.07 + 0.05 * fract(fi * 0.618) + 0.05 * (1.2 - g.y));
      shaft += (0.6 + 0.4 * fract(fi * 0.37 + 0.2)) * exp(-dr * dr);
    }
    col += vec3(0.45, 0.75, 0.7) * shaft * 0.11 * shallows * smoothstep(-1.3, 1.0, g.y);
    col += uTop * (0.25 * smoothstep(0.3, 1.1, g.y) + 0.12 * c * smoothstep(0.0, 1.0, g.y)) * shallows;
    // The sandy floor, with rocks, falling away as the vessel sinks.
    float fy = uClock.y + 0.05 * sin(g.x * 2.3 + 1.0) + 0.025 * sin(g.x * 5.7 + 2.0);
    float rock = 0.13 * max(vnoise(vec2(g.x * 3.0, 0.5), 21.0) * 2.0 - 0.9, 0.0);
    float floorC = smoothstep(0.004, -0.004, g.y - fy);
    float rockC = smoothstep(0.004, -0.004, g.y - fy - rock) * (1.0 - floorC);
    if (floorC + rockC > 0.0) {
      float depthIn = clamp((fy - g.y) / 0.5, 0.0, 1.0);
      vec3 sand = ${v3(SAND)} * (0.55 + 0.45 * depthIn) * (0.9 + 0.2 * vnoise(g * 14.0, 4.0));
      sand += uTop * c * 0.9;
      sand = mix(sand, col, 0.55 - 0.35 * depthIn);
      vec3 rk = uDeep * 0.6 + uTop * 0.25 * vnoise(g * 9.0, 8.0);
      col = mix(col, sand, floorC * shallows);
      col = mix(col, rk, rockC * shallows);
    }
  }

  // The whale, far off and fogged by the water, lit from above (and by the lamp in the dark).
  if (uWhale.w > 0.0) {
    vec3 wh = whale(g);
    if (wh.x > 0.0) {
      vec3 body = uTop * (0.3 + 1.1 * wh.y) + uTop * c * 0.4 * wh.y * shallows;
      body += vec3(0.32, 0.36, 0.36) * 0.5 * bm * (0.5 + 0.5 * wh.y);
      body = mix(body, col, uWhale2.y);
      col = mix(col, body, wh.x * uWhale.w);
    }
  }

  // The lamp's beam through the water.
  col += vec3(0.3, 0.36, 0.33) * 0.14 * bm;

  // Marine snow, faint in the twilight and brightest in the lamp's beam.
  float sA = snow(g, ${F(SNOW_CELL_A)}, vec2(uSnow.z, uSnow.x), 0.0055, 0x51u);
  float sB = snow(g, ${F(SNOW_CELL_B)}, vec2(uSnow.z * 1.6, uSnow.y), 0.009, 0xa7u);
  float lightLevel = 0.04 + 0.32 * shallows + 0.08 * (1.0 - abyss) + 1.6 * bm;
  col += vec3(0.7, 0.82, 0.86) * (0.6 * sA + 0.8 * sB) * lightLevel * (0.5 + 0.5 * uZones.w);

  // Bioluminescence: slow flashes and small strings of steadily glowing lights.
  float bio = max(abyss, 0.25 * uZones.y);
  if (bio > 0.0) {
    vec2 q = (g - vec2(uSnow.z * 0.5, uSnow.w)) / ${F(GLOW_CELL)};
    vec2 id = floor(q);
    uint h = cellHash(id, 0x3cu + uint(uClock.w));
    float present = smoothstep(0.0, 0.08, bio * (0.12 + 0.5 * uZones.w) - float(h & 255u) / 255.0);
    if (present > 0.0) {
      float T = ${F(GLOW_PERIODS[0])};
      uint pk = (h >> 8u) % 6u;
      ${GLOW_PERIODS.slice(1)
        .map((p, i) => `if (pk == ${String(i + 1)}u) T = ${F(p)};`)
        .join("\n      ")}
      float ph = float((h >> 12u) & 255u) / 255.0;
      float tt = mod(t + ph * T, T);
      vec2 o = 0.3 + 0.4 * vec2(float((h >> 20u) & 15u), float((h >> 24u) & 15u)) / 15.0;
      vec2 d = (q - id - o) * ${F(GLOW_CELL)};
      float glow;
      vec3 tint;
      if ((h >> 28u) < 10u) {
        // A flash: up over a second and a half, then a slow fade.
        float env = smoothstep(0.0, 1.5, tt) * (1.0 - smoothstep(1.5, 6.0, tt));
        glow = env * (exp(-dot(d, d) * 3000.0) + 0.3 * exp(-dot(d, d) * 700.0));
        tint = ${v3(BIOLUM)};
      } else {
        // A string of lights, drifting and pulsing gently.
        float ang = ph * 6.2832;
        vec2 ax = vec2(cos(ang), sin(ang));
        float al = clamp(dot(d, ax), -0.05, 0.05);
        float k = floor(al / 0.025 + 0.5) * 0.025;
        vec2 e = d - ax * k;
        float pulse = 0.65 + 0.35 * sin(6.2832 * tt / T);
        glow = pulse * 0.8 * (exp(-dot(e, e) * 9000.0) + 0.25 * exp(-dot(e, e) * 1500.0));
        tint = ${v3(BIOLUM_B)};
      }
      col += tint * (1.0 - exp(-${F(GLOW_CAP)} * glow)) * present * bio;
    }
  }
  outColor = vec4(col, 1.0);
}
`;

/**
 * The frame: the cached room over the view through the glass. Where the room
 * is clear, the view is sampled through the glass's bulge (magnified at the
 * centre, unchanged at the rim) and darkened toward the rim; the water's light
 * spills a little onto the brass and panelling round the viewport.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uOutside;
uniform vec2 uResolution;
uniform float uScale;
uniform vec2 uGlass;
/** The water's light spilling onto the room. */
uniform vec3 uSpill;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec4 room = texture(uRoom, frag / uResolution);
  vec2 g = (frag / uScale - uGlass) / ${F(GLASS_R)};
  float r2 = dot(g, g);
  vec3 col = room.rgb;
  if (room.a < 0.999 && r2 < 1.1) {
    vec2 q = g * (1.0 - ${F(BULGE)} * (1.0 - min(r2, 1.0)));
    vec3 view = texture(uOutside, 0.5 + 0.5 * q / ${F(SPAN)}).rgb;
    view *= 1.0 - 0.3 * smoothstep(0.55, 1.0, r2);
    col += (1.0 - room.a) * view;
  }
  float rr = sqrt(r2);
  col += uSpill * room.a * exp(-max(rr - 1.0, 0.0) * 3.5) * (0.35 + 0.65 * smoothstep(1.25, 1.0, rr));
  outColor = vec4(col + dither8(frag), 1.0);
}
`;

/**
 * Numbers round the two dials (depth in fathoms, pressure), drawn once per
 * resize on a canvas into an R8 texture: the depth dial's in the left half,
 * the pressure gauge's in the right, each face filling its square.
 */
function drawLabels(size: number): Uint8Array {
  const out = new Uint8Array(size * 2 * size);
  if (typeof OffscreenCanvas === "undefined") {
    return out;
  }
  const ctx = new OffscreenCanvas(size * 2, size).getContext("2d");
  if (!ctx) {
    return out;
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size * 2, size);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const half = size / 2;
  const sets = [
    { numbers: ["0", "2", "4", "6", "8", "10", "12"], caption: "FATHOMS ×100" },
    { numbers: ["0", "1", "2", "3", "4", "5", "6"], caption: "ATMOS ×10" },
  ];
  sets.forEach((set, cell) => {
    const cx = cell * size + half;
    ctx.font = `600 ${String(Math.round(size * 0.1))}px Georgia, "Times New Roman", serif`;
    set.numbers.forEach((text, k) => {
      const a = DIAL_START - (DIAL_SWEEP * k) / 6;
      ctx.fillText(text, cx + Math.cos(a) * half * 0.56, half - Math.sin(a) * half * 0.56);
    });
    ctx.font = `600 ${String(Math.round(size * 0.055))}px Georgia, "Times New Roman", serif`;
    ctx.fillText(set.caption, cx, half + half * 0.42);
  });
  // Typed loosely: the tests' fake 2D context returns undefined from every method.
  const image = ctx.getImageData(0, 0, size * 2, size) as ImageData | undefined;
  const data = image?.data;
  if (!data || data.length < size * 2 * size * 4) {
    return out;
  }
  const w = size * 2;
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * w * 4;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = data[src + x * 4];
    }
  }
  return out;
}

/**
 * The salon of a brass-and-walnut submarine: a great riveted viewport onto the
 * deep, the vessel sinking from the sunlit shallows (fish shoals, light shafts,
 * caustics on the sand) through the twilight (jellyfish, marine snow, a
 * passing whale) to the abyss (bioluminescence and the vessel's lamp), while a
 * depth dial and a wandering pressure gauge keep watch beside it.
 */
export const submarine = defineEffect(submarineMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uScale",
        "uWidth",
        "uGlass",
        "uLamp",
        "uDepth",
        "uPress",
        "uParts",
        "uLabels",
      ]);
      const needleProgram = program(FULLSCREEN_VERTEX, NEEDLE_FRAGMENT);
      const nu = createUniforms(gl, needleProgram, ["uScale", "uLamp", "uDial"]);
      const waterProgram = program(FULLSCREEN_VERTEX, WATER_FRAGMENT);
      const wu = createUniforms(gl, waterProgram, [
        "uRes",
        "uTop",
        "uDeep",
        "uZones",
        "uClock",
        "uSnow",
        "uWhale",
        "uWhale2",
        "uTile",
        "uMatA",
        "uMatB",
        "uOffA",
        "uOffB",
      ]);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, [
        "uRoom",
        "uOutside",
        "uResolution",
        "uScale",
        "uGlass",
        "uSpill",
      ]);
      const tileProgram = program(FULLSCREEN_VERTEX, tileFragment(CAUSTIC_RATES.length));
      const uT = gl.getUniformLocation(tileProgram, "uT");

      // Fish from the Aquarium, jellyfish from Jellyfish, both drawn into the view outside.
      const fishProgram = program(FISH_VERTEX, FISH_FRAGMENT);
      const fu = createUniforms(gl, fishProgram, ["uResolution", "uTop", "uDeep", "uFishLight"]);
      const fishBatch = scope.own(createSpriteBatch(gl, MAX_FISH, [4, 4]));
      const bellBatch = scope.own(
        createSpriteBatch(gl, MAX_JELLIES, [4, 4], [BELL_SHAPE], { rotation: true }),
      );
      const bellProgram = program(bellVertex(bellBatch.spinLocation), BELL_FRAGMENT);
      const bu = createUniforms(gl, bellProgram, ["uResolution", "uGlow"]);
      const stripProgram = program(STRIP_VERTEX, STRIP_FRAGMENT);
      const su = createUniforms(gl, stripProgram, ["uResolution"]);
      const strips = new Float32Array(MAX_JELLIES * CHAINS_PER_JELLY * STRIP_VERTS * STRIP_FLOATS);
      const stripVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const stripBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(stripVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, stripBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, strips.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIP_FLOATS * 4, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, STRIP_FLOATS * 4, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIP_FLOATS * 4, 12);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      gl.useProgram(roomProgram);
      ru.i1("uLabels", 0);
      gl.useProgram(waterProgram);
      wu.i1("uTile", 0);
      gl.useProgram(compositeProgram);
      cu.i1("uRoom", 0);
      cu.i1("uOutside", 1);
      gl.useProgram(null);

      let room: RenderTarget | null = null;
      let outside: RenderTarget | null = null;
      let tile: RenderTarget | null = null;
      let labels: WebGLTexture | null = null;
      scope.defer(() => {
        room?.dispose();
        outside?.dispose();
        tile?.dispose();
        gl.deleteTexture(labels);
      });
      /** The side the room cache was drawn for; "" when it must be redrawn. */
      let roomSide = "";

      const phases = new Float32Array(CAUSTIC_RATES.length);
      const matA = new Float32Array(4);
      const matB = new Float32Array(4);
      let offAx = 0;
      let offAy = 0;
      let offBx = 0;
      let offBy = 0;
      let tileAge = Infinity;

      const top = [0, 0, 0];
      const deep = [0, 0, 0];
      const spill = [0, 0, 0];
      const zones = createZones();
      let fish = createFishSim(0, MAX_FISH, 1);
      const env: FishEnv = { aspect: 1, count: 1, species: "silver", speed: 1 };
      let swarm: Swarm = createSwarm(createRng(1), 1080);
      const swarmFrame = {
        refWidth: 1080,
        scale: 1,
        count: 0,
        size: 70,
        pulse: 0.8,
        tentacles: 0.8,
        glow: 0,
        palette: paletteFor("moon"),
      };
      let whales = createWhales(0);
      let walk = createGraphWalk(2, 0);
      let seedNow = Number.NaN;

      let width = 1;
      let height = 1;
      let scale = 1;
      let outSize = 1;
      let layout: SubLayout = submarineLayout(1920, "left");
      /** CPU-only time, unwrapped float64, and the time since the walk was made. */
      let time = 0;
      let walkTime = 0;
      let depth = Number.NaN;
      let sinkRate = 0;
      let snowA = 0;
      let snowB = 0;
      let snowX = 0;
      let snowGlow = 0;
      let whaleFade = 0;
      let depthNeedle = Number.NaN;
      let pressNeedle = Number.NaN;

      const snowSpan = (cell: number) => cell * GRID_PERIOD;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale;
          room?.dispose();
          room = null;
          room = createRenderTarget(gl, width, height, gl.RGBA8);
          outSize = Math.max(8, Math.ceil((2 * SPAN * GLASS_R * scale) / OUT_DIV));
          outside?.dispose();
          outside = null;
          outside = createRenderTarget(gl, outSize, outSize, gl.RGBA8);
          const tilePx = (CAUSTIC_PERIOD * outSize) / (2 * SPAN);
          const res = tileResolution(tilePx);
          if (res !== tile?.width) {
            tile?.dispose();
            tile = null;
            tile = createRenderTarget(gl, res, res, gl.R8, { wrap: gl.REPEAT });
            tileAge = Infinity;
          }
          tileMatrices(tilePx, true, matA, matB);
          swarmFrame.scale = outSize / 1080;
          roomSide = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
          time += step;
          walkTime += step;
          if (!room || !outside) {
            return;
          }
          const seed = Math.floor(p.seed);
          if (seed !== seedNow) {
            seedNow = seed;
            fish = createFishSim(seed, MAX_FISH, 1);
            swarm = createSwarm(createRng(seed * 977 + 13), 1080);
            whales = createWhales(seed);
            walk = createGraphWalk(2, seed);
            walkTime = 0;
          }

          // Depth: the setting's, eased so a change never cuts; the snow rises faster while sinking.
          const target = depthAt(p.depth, time);
          const prev = depth;
          depth = Number.isNaN(depth) ? target : easeDepth(depth, target, step);
          const rate = step > 0 && !Number.isNaN(prev) ? (depth - prev) / step : 0;
          sinkRate = approach(sinkRate, Math.max(-1, Math.min(1.5, rate / PEAK_SINK)), step * 0.5);
          zonesAt(depth, zones);
          waterAt(depth, top, deep);
          const life = Math.max(0, Math.min(1, p.life));

          const rise = SNOW_RISE * Math.max(0.25, 1 + SNOW_SINK_BOOST * sinkRate);
          snowA = wrap(snowA + rise * step, 0, snowSpan(SNOW_CELL_A));
          snowB = wrap(snowB + 1.6 * rise * step, 0, snowSpan(SNOW_CELL_B));
          snowX =
            SNOW_SWAY * Math.sin(((time % SNOW_SWAY_PERIOD) * 2 * Math.PI) / SNOW_SWAY_PERIOD);
          snowGlow = wrap(snowGlow + 0.5 * rise * step, 0, snowSpan(GLOW_CELL));

          // 1. The room, when the size or the side changes.
          if (roomSide !== p.side) {
            roomSide = p.side;
            layout = submarineLayout(width / scale, p.side);
            const L = layout;
            const labelSize = Math.max(16, Math.min(1024, Math.round(2 * L.depthR * scale)));
            gl.deleteTexture(labels);
            labels = null;
            labels = createDataTexture(gl, {
              width: labelSize * 2,
              height: labelSize,
              internalFormat: gl.R8,
              format: gl.RED,
              type: gl.UNSIGNED_BYTE,
              data: drawLabels(labelSize),
            });
            room.bind();
            gl.useProgram(roomProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, labels);
            ru.f1("uScale", scale);
            ru.f1("uWidth", L.width);
            ru.f3("uGlass", L.cx, L.cy, L.dir);
            ru.f2("uLamp", L.lampX, L.lampY);
            ru.f3("uDepth", L.depthX, L.depthY, L.depthR);
            ru.f3("uPress", L.pressX, L.pressY, L.pressR);
            ru.f4("uParts", L.pipeA, L.pipeB, L.shelfEnd, L.chairW);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }
          const L = layout;

          // 2. The caustic tile, while the shallows show.
          advancePhases(phases, step * CAUSTIC_RATE);
          offAx = wrap(offAx + DRIFT_A[0] * step, 0, 1);
          offAy = wrap(offAy + DRIFT_A[1] * step, 0, 1);
          offBx = wrap(offBx + DRIFT_B[0] * step, 0, 1);
          offBy = wrap(offBy + DRIFT_B[1] * step, 0, 1);
          tileAge += step;
          if (tile && zones.shallows > 0.002 && tileAge >= TILE_INTERVAL * 0.9) {
            tileAge = 0;
            tile.bind();
            gl.useProgram(tileProgram);
            gl.uniform1fv(uT, phases);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          // 3. The sea, at reduced resolution.
          const pass = stepWhales(whales, time);
          const u = whaleProgress(pass, time);
          whaleFade = Math.max(
            0,
            Math.min(1, whaleFade + (p.whale ? 1 : -1) * (step / WHALE_FADE)),
          );
          outside.bind();
          gl.useProgram(waterProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tile?.texture ?? null);
          wu.f2("uRes", outSize, outSize);
          wu.f3("uTop", top[0], top[1], top[2]);
          wu.f3("uDeep", deep[0], deep[1], deep[2]);
          wu.f4("uZones", zones.shallows, zones.jellies, zones.abyss, life);
          wu.f4(
            "uClock",
            time % GLOW_WRAP,
            FLOOR_TOP - FLOOR_DROP * smoothstep(0.08, 0.4, depth),
            L.dir,
            seed % 256,
          );
          wu.f4("uSnow", snowA, snowB, snowX, snowGlow);
          const whaleOn = u >= 0 ? whaleFade : 0;
          wu.f4("uWhale", u >= 0 ? whaleX(pass, u) : 0, pass.y, pass.size * pass.dir, whaleOn);
          wu.f2("uWhale2", strokePhase(time), pass.fog);
          gl.uniformMatrix2fv(wu.loc.uMatA, false, matA);
          gl.uniformMatrix2fv(wu.loc.uMatB, false, matB);
          wu.f2("uOffA", offAx, offAy);
          wu.f2("uOffB", offBx, offBy);
          triangle.draw();

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          // Fish shoals in the shallows, fading out as the water darkens.
          if (zones.shallows > 0.001) {
            env.count = 6 + (MAX_FISH - 6) * life;
            stepFishSim(fish, step, env);
            const n = fishInstances(fish, env, fishBatch.data, fishBatch.stride);
            const d = fishBatch.data;
            for (let k = 0; k < n; k++) {
              d[k * fishBatch.stride + 7] *= zones.shallows;
            }
            fishBatch.upload(n);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(fishProgram);
            fu.f2("uResolution", outSize, outSize);
            fu.f3("uTop", top[0], top[1], top[2]);
            fu.f3("uDeep", deep[0], deep[1], deep[2]);
            fu.f2("uFishLight", 0.45 + 0.5 * zones.shallows, 0);
            fishBatch.draw(0, n);
          }
          // Jellyfish from the twilight down, glowing in the abyss.
          swarmFrame.count = Math.round(life * 6 * zones.jellies);
          swarmFrame.glow = 0.15 + 0.85 * zones.abyss;
          swarm.step(
            step,
            swarmFrame,
            bellBatch.data,
            bellBatch.stride,
            bellBatch.spinOffset,
            strips,
          );
          gl.blendFunc(gl.ONE, gl.ONE);
          const verts = swarm.stripVerts;
          if (verts > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, stripBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, strips, 0, verts * STRIP_FLOATS);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.useProgram(stripProgram);
            su.f2("uResolution", outSize, outSize);
            gl.bindVertexArray(stripVao);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, verts);
            gl.bindVertexArray(null);
          }
          if (swarm.bells > 0) {
            bellBatch.upload(swarm.bells);
            gl.useProgram(bellProgram);
            bu.f2("uResolution", outSize, outSize);
            bu.f1("uGlow", swarmFrame.glow);
            bellBatch.draw(0, swarm.bells);
          }
          gl.disable(gl.BLEND);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);

          // 4. The room over the view through the glass.
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, outside.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          cu.f2("uResolution", width, height);
          cu.f1("uScale", scale);
          cu.f2("uGlass", L.cx, L.cy);
          for (let c = 0; c < 3; c++) {
            spill[c] = 0.12 * top[c] + 0.05 * zones.abyss * BIOLUM[c] * 0.2;
          }
          cu.f3("uSpill", spill[0], spill[1], spill[2]);
          triangle.draw();

          // 5. The needles: depth follows the depth, pressure wanders on the random walk.
          advanceGraph(walk, walkTime);
          const lag = 1 - Math.exp(-step / NEEDLE_LAG);
          const dTarget = needleAngle(depthReading(depth, walkWander(walk, 1)));
          const pTarget = needleAngle(pressureReading(depth, walkWander(walk, 0)));
          depthNeedle = Number.isNaN(depthNeedle)
            ? dTarget
            : depthNeedle + (dTarget - depthNeedle) * lag;
          pressNeedle = Number.isNaN(pressNeedle)
            ? pTarget
            : pressNeedle + (pTarget - pressNeedle) * lag;
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.enable(gl.SCISSOR_TEST);
          gl.useProgram(needleProgram);
          nu.f1("uScale", scale);
          nu.f2("uLamp", L.lampX, L.lampY);
          for (let k = 0; k < 2; k++) {
            const x = k === 0 ? L.depthX : L.pressX;
            const y = k === 0 ? L.depthY : L.pressY;
            const r = k === 0 ? L.depthR : L.pressR;
            nu.f4("uDial", x, y, r, k === 0 ? depthNeedle : pressNeedle);
            const sx = Math.max(0, Math.floor((x - r) * scale));
            const sy = Math.max(0, Math.floor((y - r) * scale));
            const ex = Math.min(width, Math.ceil((x + r) * scale));
            const ey = Math.min(height, Math.ceil((y + r) * scale));
            gl.scissor(sx, sy, Math.max(0, ex - sx), Math.max(0, ey - sy));
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
