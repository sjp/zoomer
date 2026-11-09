import { bridgeMeta, SHIP_OPTIONS } from "./bridge.meta";
import {
  type AtlasImage,
  buildPanels,
  createAtlasImage,
  groupCount,
  MAX_WIDGETS,
  type PanelSet,
  rasterisePanels,
} from "./bridge-panels";
import {
  ATLAS_S0,
  ATLAS_S1,
  ATLAS_Y0,
  ATLAS_Y1,
  atlasTexelsPerMetre,
  BEZEL,
  type BridgeLayout,
  bridgeLayout,
  CEILING_Y,
  COVE_Y0,
  COVE_Y1,
  DOOR_S0,
  DOOR_S1,
  DOOR_TOP,
  EYE_Y,
  FORWARD,
  LEDGE_BOTTOM,
  LEDGE_DEPTH,
  LEDGE_S,
  LEDGE_TOP,
  LENS_S0,
  LENS_S1,
  LENS_Y0,
  LENS_Y1,
  RAIL_CAP,
  RAIL_CZ,
  RAIL_FACE,
  RAIL_IN,
  RAIL_OUT,
  RAIL_TOP,
  TAN_HALF_FOV,
  UP,
  WALL_CZ,
  WALL_R,
} from "./bridge-room";
import {
  alertPulse,
  blockStates,
  createAlertMix,
  createStateScratch,
  type StateScratch,
  stepAlert,
} from "./bridge-sim";
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
  resetUnpackState,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import { approach } from "../math";
import { SHIP_DISTANCE, SHIP_FOCAL, SHIP_GLSL, SHIP_RADIUS } from "../ship-shapes";
import { createShipPose, SHIP_KINDS, SHIP_SCALE, shipAt, type ShipPlan } from "./bridge-ships";
import {
  advanceGraph,
  createGraphWalk,
  GRAPH_SAMPLES,
  graphShift,
  GRAPH_DISTANCE_GLSL,
} from "../graph-walk";
import { planetStyle } from "./bridge-planets";
import {
  clockText,
  dateText,
  formatStardate,
  LOCATION_HOLD,
  locationAt,
  locationIndex,
  locationVisit,
  type LiveKey,
  shipStatus,
  stardate,
} from "./bridge-live";
import { hexToUnitRgb, type Rgb } from "../color";
import { createStreakRenderer } from "../streaks";
import { createStarfield, type StarFrame } from "../warp/warp-sim";
import { defineEffect } from "../types";
import { cameraRayGlsl, SUPERSAMPLE4_GLSL, SD_RECT_GLSL } from "../room-ray";
import { HASH_CELL_GLSL } from "../noise";

/** Most glass rects the room pass draws (every panel and the band). */
const MAX_GLASS = 8;
/** Glow texels per atlas texel, each way. */
const GLOW_DIVISOR = 8;
/** The outside view renders at this fraction of its on-screen size. */
const EXTERIOR_SCALE = 1;
/** Background of the outside view, as in the stars and planet shader. */
const SPACE: Rgb = [0.004, 0.006, 0.018];
/**
 * Warp Speed's starfield, tuned for a small display: fewer stars, longer streaks
 * and a floor on their width, since at its own defaults it shrinks to specks.
 */
const WARP_STARS = 700;
/** Smallest size scale for the warp streaks (1 is Warp Speed at 1080p). */
const WARP_MIN_SCALE = 0.7;
/** Height of a visiting ship's centre above the view's middle, in display heights. */
const SHIP_Y = 0.06;
/** Milliseconds the outside view takes to fade out, or back in, as the planet changes. */
const PLANET_FADE_MS = 750;
const WARP_ABERRATION = 0.15 * 0.03;
/**
 * The graph line's half width (m) and the soft glow around it. At 1080p the
 * line is about 2.5 px wide.
 */
const GRAPH_HALF_WIDTH = 0.004;
const GRAPH_GLOW = 0.012;
/** Seconds the sweep's animation repeats over: it turns in 10. */
const WIDGET_PERIOD = 10;
/** Seconds the outside view repeats over; every drift in it is a whole number of cycles. */
const EXTERIOR_PERIOD = 1000;
/** Seconds for a lighting change (day to night) to fade. */
const LIGHTING_FADE = 1.5;
/**
 * The panel font: Antonio (SIL Open Font License, public/fonts/antonio-OFL.txt),
 * a tall condensed face close to the show's LCARS lettering, loaded in the
 * background under its own family name. Condensed system fonts stand in until
 * it arrives, and if it can't load.
 */
const FONT_URL = `${import.meta.env.BASE_URL}fonts/antonio-600.woff2`;
const FONT_FACE = "Bridge LCARS";
const FONT_FAMILY = `"${FONT_FACE}", "Arial Narrow", "Roboto Condensed", "Liberation Sans Narrow", "Helvetica Neue", Arial, sans-serif`;
/** Width of a digit as a fraction of the capital height: tall and narrow. */
const DIGIT_WIDTH = 0.5;

const g = glslFloat;
/** Direction towards the ceiling lights: above, and a little behind the camera. */
const KEY = ((v: number[]) => v.map((x) => x / Math.hypot(...v)))([0, 1, -0.45]);

/** Shared GLSL: camera rays, the wall cylinder and small helpers. */
const COMMON_GLSL = /* glsl */ `
const float EYE_Y = ${g(EYE_Y)};
${cameraRayGlsl(FORWARD, UP, TAN_HALF_FOV)}
const float WALL_CZ = ${g(WALL_CZ)};
const float WALL_R = ${g(WALL_R)};

// Far root of a ray from the eye (inside) against a vertical cylinder at z = cz.
float cylFar(vec3 d, float cz, float r) {
  float a = d.x * d.x + d.z * d.z;
  float b = -cz * d.z;
  float c = cz * cz - r * r;
  float disc = b * b - a * c;
  if (disc < 0.0 || a <= 0.0) {
    return -1.0;
  }
  return (-b + sqrt(disc)) / a;
}

// Arc length along the wall of world point p.
float wallS(vec3 p) {
  return WALL_R * atan(p.x, p.z - WALL_CZ);
}

${HASH_CELL_GLSL}
float hash2(vec2 p) {
  return hashCell(p);
}

// Value noise, repeating every period cells in x.
float vnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  float a = hash2(vec2(x0, i.y));
  float b = hash2(vec2(x1, i.y));
  float c = hash2(vec2(x0, i.y + 1.0));
  float d = hash2(vec2(x1, i.y + 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

${SD_RECT_GLSL}
`;

/**
 * The room, ray-traced once per resize or layout change: the wooden rail, the
 * console ledge, the curved aft wall with its panels' bezels and glass, doors,
 * alert lenses and cove light, and the ceiling. Four samples per pixel for
 * smooth edges. Alpha marks what the composite animates: 1 on the wall where
 * panels can be, 0.5 on the alert lenses.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec4 uGlass[${String(MAX_GLASS)}];
uniform int uGlassCount;
out vec4 outColor;
${COMMON_GLSL}
const vec3 KEY = vec3(${KEY.map((x) => g(x)).join(", ")});
const vec3 WALL = vec3(0.62, 0.57, 0.5);
const vec3 BEZEL_C = vec3(0.76, 0.73, 0.68);
const vec3 GLASS = vec3(0.018, 0.018, 0.022);
const vec3 DOOR_C = vec3(0.6, 0.6, 0.61);
const vec3 WOOD = vec3(0.34, 0.17, 0.09);
const vec3 BASE_C = vec3(0.56, 0.53, 0.49);
const vec3 CEIL = vec3(0.7, 0.67, 0.62);
const vec3 LIGHT = vec3(1.0, 0.95, 0.86);

float ambient(vec3 n) {
  return mix(0.32, 0.62, n.y * 0.5 + 0.5);
}

vec4 wallShade(float s, float y, vec3 n) {
  float sa = abs(s);
  float light = ambient(n) + 0.55 * max(0.0, dot(n, KEY));
  light += y < ${g(COVE_Y0)} ? 0.55 * exp(-(${g(COVE_Y0)} - y) / 0.35) : 0.0;
  light *= 0.75 + 0.25 * smoothstep(0.0, 1.6, y);
  float ao = 1.0;
  ao *= 0.55 + 0.45 * smoothstep(0.0, 0.25, ${g(CEILING_Y)} - y);
  ao *= 0.6 + 0.4 * smoothstep(0.0, 0.2, y);
  float below = ${g(LEDGE_BOTTOM)} - y;
  if (sa < ${g(LEDGE_S + 0.05)} && below > 0.0) {
    ao *= 0.55 + 0.45 * smoothstep(0.0, 0.22, below);
  }
  float mask = 0.0;
  // Fabric panels with thin seams.
  float seam = abs(fract(s / 0.62 + 0.5) - 0.5) * 0.62;
  float hseam = min(abs(y - 2.04), abs(y - 0.6));
  float grain = 0.96 + 0.04 * vnoise(vec2(s, y) * 40.0, 1e4);
  vec3 albedo = WALL * grain * (seam < 0.004 || hseam < 0.003 ? 0.72 : 1.0);
  if (sa < ${g(LEDGE_S)} && y < ${g(LEDGE_BOTTOM)}) {
    albedo = vec3(0.5, 0.47, 0.42) * (hseam < 0.004 ? 0.8 : 1.0);
  }
  if (y > ${g(COVE_Y0)} && y < ${g(COVE_Y1)}) {
    float k = smoothstep(${g(COVE_Y0)}, ${g(COVE_Y0 + 0.02)}, y) *
      (1.0 - smoothstep(${g(COVE_Y1 - 0.02)}, ${g(COVE_Y1)}, y));
    return vec4(mix(WALL * light * ao, LIGHT, k), 0.0);
  }
  if (y >= ${g(COVE_Y1)}) {
    albedo = vec3(0.56, 0.53, 0.48);
    light = 0.5 + 0.3 * (1.0 - smoothstep(${g(COVE_Y1)}, ${g(COVE_Y1 + 0.12)}, y));
  }
  vec3 col = albedo * light * ao;
  // Doors: a dark recess round two grey leaves with a seam, rounded at the top.
  if (sa > ${g(DOOR_S0 - 0.06)}) {
    float dd = sdRect(vec2(sa, y), vec4(${g(DOOR_S0)}, -1.0, ${g(DOOR_S1)}, ${g(DOOR_TOP)}), 0.2);
    if (dd < 0.06) {
      bool leaf = dd < 0.0;
      float seamD = abs(sa - ${g((DOOR_S0 + DOOR_S1) / 2)});
      vec3 c = leaf ? DOOR_C : vec3(0.26, 0.25, 0.24);
      if (leaf && seamD < 0.006) {
        c = vec3(0.12);
      }
      float l = ambient(n) + 0.4 + 0.15 * smoothstep(0.0, 2.3, y);
      col = c * l * (leaf ? 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.03, -dd)) : 1.0);
    }
  }
  // Alert lenses, one inside each door.
  float ld = sdRect(vec2(sa, y), vec4(${g(LENS_S0)}, ${g(LENS_Y0)}, ${g(LENS_S1)}, ${g(LENS_Y1)}), 0.025);
  if (ld < 0.012) {
    if (ld < 0.0) {
      col = mix(vec3(0.2, 0.08, 0.07), vec3(0.32, 0.14, 0.12), smoothstep(${g(LENS_Y0)}, ${g(LENS_Y1)}, y));
      mask = 0.5;
    } else {
      col = BEZEL_C * 0.8 * light;
    }
  }
  // Panels: a beige bezel round black glass.
  for (int i = 0; i < ${String(MAX_GLASS)}; i++) {
    if (i >= uGlassCount) {
      break;
    }
    vec4 r = uGlass[i];
    float d = sdRect(vec2(s, y), r, 0.02);
    if (d < ${g(BEZEL)}) {
      if (d < 0.0) {
        // Glass: near black, with the ceiling lights' reflection near the top.
        float refl = 0.05 * smoothstep(r.y, r.w, y) + 0.04 * smoothstep(r.w - 0.12, r.w, y);
        col = GLASS + refl * vec3(1.0, 0.97, 0.92);
      } else {
        // Bezel: rounded, lit from above, its inner edge in shadow.
        float t = d / ${g(BEZEL)};
        float up = clamp((y - 0.5 * (r.y + r.w)) / max(0.01, 0.5 * (r.w - r.y)), -1.0, 1.0);
        float bevel = 1.0 + 0.18 * up * (1.0 - smoothstep(0.1, 0.6, t))
          - 0.25 * (1.0 - smoothstep(0.0, 0.25, t)) - 0.08 * smoothstep(0.6, 1.0, t);
        col = BEZEL_C * light * ao * bevel;
      }
    }
  }
  if (s >= ${g(ATLAS_S0)} && s <= ${g(ATLAS_S1)} && y >= ${g(ATLAS_Y0)} && y <= ${g(ATLAS_Y1)}) {
    mask = 1.0;
  }
  return vec4(col, mask);
}

vec3 radial(vec3 p, float cz) {
  return -normalize(vec3(p.x, 0.0, p.z - cz));
}

vec4 shade(vec3 d) {
  vec3 eye = vec3(0.0, EYE_Y, 0.0);
  float best = 1e9;
  int kind = 0;
  vec3 p = vec3(0.0);
  // Rail: cap top, cap inner edge, front face.
  if (d.y < 0.0) {
    float t = (${g(RAIL_TOP)} - EYE_Y) / d.y;
    vec3 q = eye + d * t;
    float r = length(vec2(q.x, q.z - ${g(RAIL_CZ)}));
    if (r > ${g(RAIL_IN)} && r < ${g(RAIL_OUT)}) {
      best = t;
      kind = 1;
      p = q;
    }
  }
  float tc = cylFar(d, ${g(RAIL_CZ)}, ${g(RAIL_IN)});
  vec3 qc = eye + d * tc;
  if (tc > 0.0 && tc < best && qc.y < ${g(RAIL_TOP)} && qc.y > ${g(RAIL_TOP - RAIL_CAP)}) {
    best = tc;
    kind = 2;
    p = qc;
  }
  float tf = cylFar(d, ${g(RAIL_CZ)}, ${g(RAIL_FACE)});
  vec3 qf = eye + d * tf;
  if (tf > 0.0 && tf < best && qf.y < ${g(RAIL_TOP - RAIL_CAP)}) {
    best = tf;
    kind = 3;
    p = qf;
  }
  if (kind == 0) {
    float tw = cylFar(d, WALL_CZ, WALL_R);
    float tl = cylFar(d, WALL_CZ, ${g(WALL_R - LEDGE_DEPTH)});
    // Console ledge: its top, then its front.
    if (d.y < 0.0) {
      float t = (${g(LEDGE_TOP)} - EYE_Y) / d.y;
      vec3 q = eye + d * t;
      float r = length(vec2(q.x, q.z - WALL_CZ));
      if (r > ${g(WALL_R - LEDGE_DEPTH)} && abs(wallS(q)) < ${g(LEDGE_S)} && t < tw) {
        kind = 4;
        p = q;
      }
    }
    if (kind == 0) {
      vec3 q = eye + d * tl;
      if (q.y < ${g(LEDGE_TOP)} && q.y > ${g(LEDGE_BOTTOM)} && abs(wallS(q)) < ${g(LEDGE_S)}) {
        kind = 5;
        p = q;
      }
    }
    if (kind == 0) {
      vec3 q = eye + d * tw;
      if (d.y > 0.0 && q.y > ${g(CEILING_Y)}) {
        kind = 6;
        p = eye + d * ((${g(CEILING_Y)} - EYE_Y) / d.y);
      } else {
        kind = 7;
        p = q;
      }
    }
  }
  if (kind == 1 || kind == 2) {
    // Wood: grain along the arc, a rounded inner edge, a satin highlight.
    float r = length(vec2(p.x, p.z - ${g(RAIL_CZ)}));
    float ang = atan(p.x, p.z - ${g(RAIL_CZ)});
    vec3 inward = radial(p, ${g(RAIL_CZ)});
    float e = kind == 1
      ? smoothstep(0.0, 0.035, r - ${g(RAIL_IN)})
      : 0.5 * smoothstep(0.0, 0.035, p.y - ${g(RAIL_TOP - RAIL_CAP)});
    vec3 n = normalize(mix(inward, vec3(0.0, 1.0, 0.0), e));
    float grain = 0.88 + 0.12 * vnoise(vec2(ang * 260.0, r * 14.0 + p.y * 14.0), 1e4)
      + 0.04 * sin(ang * 900.0 + vnoise(vec2(ang * 40.0, r * 3.0), 1e4) * 6.0);
    float light = ambient(n) + 0.6 * max(0.0, dot(n, KEY));
    vec3 refl = normalize(reflect(d, n));
    float spec = 0.22 * pow(max(0.0, dot(refl, KEY)), 12.0) + 0.05;
    return vec4(WOOD * grain * light + spec * vec3(1.0, 0.92, 0.8), 0.0);
  }
  if (kind == 3) {
    vec3 n = radial(p, ${g(RAIL_CZ)});
    float under = ${g(RAIL_TOP - RAIL_CAP)} - p.y;
    float ao = 0.45 + 0.55 * smoothstep(0.0, 0.18, under);
    float ang = atan(p.x, p.z - ${g(RAIL_CZ)});
    float seam = abs(fract(ang * ${g(RAIL_FACE / 0.9)}) - 0.5) * 0.9 > 0.447 ? 0.7 : 1.0;
    float light = ambient(n) + 0.5 * max(0.0, dot(n, KEY));
    return vec4(BASE_C * light * ao * seam * (0.85 + 0.15 * smoothstep(0.0, 0.9, p.y)), 0.0);
  }
  if (kind == 4) {
    float r = length(vec2(p.x, p.z - WALL_CZ));
    float front = smoothstep(0.0, 0.02, r - ${g(WALL_R - LEDGE_DEPTH)});
    return vec4(mix(vec3(0.7, 0.67, 0.62), vec3(0.24, 0.23, 0.23), front) * 1.025, 0.0);
  }
  if (kind == 5) {
    return vec4(vec3(0.66, 0.63, 0.58) * 0.7, 0.0);
  }
  if (kind == 6) {
    // Ceiling: recessed light strips parallel to the wall, darker towards the corner.
    float r = length(vec2(p.x, p.z - WALL_CZ));
    float ang = atan(p.x, p.z - WALL_CZ);
    float fromWall = WALL_R - r;
    float cell = abs(fract(ang * ${g(WALL_R / 1.3)}) - 0.5);
    if (fromWall > 0.7 && fromWall < 0.86 && cell < 0.4) {
      return vec4(LIGHT * 0.88, 0.0);
    }
    bool edge = fromWall > 0.67 && fromWall < 0.89 && cell < 0.42;
    float l = 0.55 + 0.25 * smoothstep(0.0, 1.5, fromWall);
    return vec4(CEIL * (edge ? l * 0.75 : l), 0.0);
  }
  return wallShade(wallS(p), p.y, radial(p, WALL_CZ));
}

${SUPERSAMPLE4_GLSL}
void main() {
  float aspect = uResolution.x / uResolution.y;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 ndc = (gl_FragCoord.xy + SS4_OFFSETS[i]) / uResolution * 2.0 - 1.0;
    acc += shade(rayDir(ndc, aspect)).rgb * 0.25;
  }
  vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
  outColor = vec4(acc, shade(rayDir(ndc, aspect)).a);
}
`;

/**
 * The outside view's stars and planet, in their own small target, with a ship
 * now and then. Every motion of the stars and planet repeats over the wrapped
 * time, so nothing jumps. Warp is drawn separately, with Warp Speed's starfield.
 */
const EXTERIOR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform int uKind;
uniform float uTime;
uniform float uAspect;
uniform float uFade;
// Planet: centre x (display widths), top y and radius (display heights).
uniform vec3 uPlanetPos;
// Planet: sea level, cloud level, ice latitude and banding.
uniform vec4 uPlanetK;
uniform vec3 uOcean;
uniform vec3 uLandLow;
uniform vec3 uLandHigh;
uniform vec3 uCloud;
uniform vec3 uAtmosphere;
uniform float uHaze;
// Towards the sun, with z towards the viewer.
uniform vec3 uLight;
uniform int uShipKind;
// Ship centre (view space, eye at the origin looking along +z) and turn.
uniform vec4 uShip;
uniform float uShipScale;
uniform float uShipPx;
out vec4 outColor;
${COMMON_GLSL}
${SHIP_GLSL}
const float PERIOD = ${g(EXTERIOR_PERIOD)};
const float TAU = 6.28318530718;

// One layer of stars in cells of 1/scale, drifting by cellsPerPeriod over PERIOD.
vec3 stars(vec2 xy, float scale, float cellsPerPeriod, float layer) {
  vec2 sp = vec2(xy.x * scale + uTime * cellsPerPeriod / PERIOD, xy.y * scale + layer * 17.0);
  vec2 cell = floor(sp);
  float cx = mod(cell.x, cellsPerPeriod);
  float h = hash2(vec2(cx + layer * 31.0, cell.y));
  if (h <= 0.9) {
    return vec3(0.0);
  }
  vec2 at = cell + 0.2 + 0.6 * vec2(hash2(vec2(cx, cell.y + 9.0)), hash2(vec2(cx + 5.0, cell.y)));
  vec2 dd = sp - at;
  float b = exp(-dot(dd, dd) * 60.0) * pow(hash2(vec2(cx + 3.0, cell.y + 3.0)), 2.5);
  return b * vec3(0.9, 0.92, 1.0);
}

void main() {
  vec2 xy = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  vec3 col = vec3(0.004, 0.006, 0.018);
  col += stars(xy, 30.0, 120.0, 0.0) + stars(xy, 55.0, 140.0, 1.0);
  if (uKind == 1) {
    // A planet below, turning once per period, its clouds twice, coloured for
    // where the ship is.
    vec2 dp = (xy - vec2(uPlanetPos.x * uAspect, uPlanetPos.y - uPlanetPos.z)) / uPlanetPos.z;
    float r = length(dp);
    if (r < 1.0) {
      float z = sqrt(1.0 - r * r);
      float lon = atan(dp.x, z) / TAU + uTime / PERIOD;
      float lat = asin(clamp(dp.y, -1.0, 1.0));
      float land = vnoise(vec2(lon * 24.0, lat * 5.0), 24.0) * 0.6
        + vnoise(vec2(lon * 64.0, lat * 13.0), 64.0) * 0.4;
      float cl = lon + uTime / PERIOD;
      float cloud = smoothstep(uPlanetK.y, uPlanetK.y + 0.25,
        vnoise(vec2(cl * 48.0, lat * 16.0), 48.0) * 0.7 + vnoise(vec2(cl * 128.0, lat * 30.0), 128.0) * 0.3);
      vec3 c = land > uPlanetK.x
        ? mix(uLandLow, uLandHigh, smoothstep(uPlanetK.x, uPlanetK.x + 0.25, land))
        : uOcean;
      // A gas giant's bands, stirred by the same noise.
      float band = 0.5 + 0.5 * sin(lat * 18.0 + land * 5.0);
      c = mix(c, mix(uLandLow, uLandHigh, band), uPlanetK.w);
      float ice = smoothstep(uPlanetK.z, uPlanetK.z + 0.08, abs(lat) + 0.1 * (land - 0.5));
      c = mix(c, vec3(0.92, 0.95, 0.98), ice);
      c = mix(c, uCloud, cloud * 0.85);
      float diff = max(0.0, dot(vec3(dp, z), uLight));
      col = c * (0.03 + 0.97 * diff) + uAtmosphere * uHaze * pow(1.0 - z, 3.0) * 0.6 * (0.3 + diff);
    } else {
      col += uAtmosphere * uHaze * exp(-(r - 1.0) * 40.0 * uPlanetPos.z) * 0.5;
    }
  }
  if (uShipKind >= 0) {
    // A visiting ship, in front of everything else.
    vec3 d = normalize(vec3(xy, ${g(SHIP_FOCAL)}));
    vec4 ship = shipHit(uShipKind, d, uShip.xyz, uShipScale, uShip.w, vec3(uLight.xy, -uLight.z), uShipPx);
    col = col * (1.0 - ship.a) + ship.rgb;
  }
  outColor = vec4(col * uFade, 1.0);
}
`;

/** Emission of the panels at a glow texel, for the light they cast on the room. */
const EMISSION_GLSL = /* glsl */ `
uniform sampler2D uAtlas;
uniform highp usampler2D uIndex;
uniform sampler2D uState;

vec4 blockState(vec2 uv) {
  ivec2 size = textureSize(uIndex, 0);
  ivec2 ip = clamp(ivec2(uv * vec2(size)), ivec2(0), size - 1);
  uint idx = texelFetch(uIndex, ip, 0).r;
  return texelFetch(uState, ivec2(int(idx), 0), 0);
}

vec3 emission(vec2 uv, out float lit) {
  vec4 a = texture(uAtlas, uv);
  vec4 st = blockState(uv);
  float text = mix(a.g, a.b, st.a);
  lit = abs(a.r - text);
  return st.rgb * lit;
}
`;

const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uTexel;
out vec4 outColor;
${EMISSION_GLSL}
void main() {
  float lit;
  vec3 e = emission(vUv + uTexel * vec2(-0.25, -0.25), lit);
  e += emission(vUv + uTexel * vec2(0.25, -0.25), lit);
  e += emission(vUv + uTexel * vec2(-0.25, 0.25), lit);
  e += emission(vUv + uTexel * vec2(0.25, 0.25), lit);
  outColor = vec4(e * 0.25, 1.0);
}
`;

/**
 * Every frame: the cached room, with the panels lit from the atlas and the block
 * states, the sweep and graph, the outside view, the panels' glow on the wall,
 * the room light (dimmed for the night shift or an alert) and the alert lenses.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uGlow;
uniform sampler2D uExterior;
uniform vec2 uResolution;
// Atlas texel per metre over the atlas size: uv = (s - S0, y - Y0) * uAtlasScale.
uniform vec2 uAtlasScale;
uniform vec2 uGlowTexel;
uniform vec4 uViewport;
uniform int uHasView;
uniform vec4 uWidget[${String(MAX_WIDGETS)}];
// Per widget: kind (0 sweep, 1 graph) and block index.
uniform vec2 uWidgetInfo[${String(MAX_WIDGETS)}];
uniform int uWidgetCount;
uniform float uTime;
// Each widget's row of graph samples (R8), and how far they have scrolled past the newest.
uniform sampler2D uGraph;
uniform float uGraphShift;
${GRAPH_DISTANCE_GLSL}
uniform vec3 uLight;
uniform vec3 uLens;
uniform float uLinePx;
out vec4 outColor;
${COMMON_GLSL}
${EMISSION_GLSL}
${DITHER_GLSL}
const float TAU = 6.28318530718;

vec3 widget(int i, vec2 p) {
  vec4 r = uWidget[i];
  if (p.x < r.x || p.x > r.z || p.y < r.y || p.y > r.w) {
    return vec3(0.0);
  }
  vec3 c = texelFetch(uState, ivec2(int(uWidgetInfo[i].y), 0), 0).rgb;
  float k = 0.0;
  if (uWidgetInfo[i].x < 0.5) {
    // Sweep: a wedge trailing the leading edge, one turn per 10 s.
    vec2 cen = 0.5 * (r.xy + r.zw);
    float rad = 0.5 * (r.z - r.x);
    vec2 dp = p - cen;
    float rr = length(dp) / rad;
    if (rr < 1.0) {
      float lead = fract(uTime / 10.0);
      float ang = fract(atan(dp.y, dp.x) / TAU + 1.0);
      float behind = fract(lead - ang + 2.0);
      k = exp(-behind * 7.0) * 0.55 * (1.0 - pow(rr, 6.0));
    }
  } else {
    // Graph: a polyline through the widget's row of random-walk samples,
    // scrolling left as new ones arrive. Measured to the nearest of the
    // segments around the pixel, in metres, so steep jumps keep their width.
    vec2 size = r.zw - r.xy;
    vec2 gp = (p - r.xy) / size;
    float dm = graphDistance(i, gp, size, vec2(0.0, 1.0));
    float core = 1.0 - smoothstep(${g(GRAPH_HALF_WIDTH)} - uLinePx, ${g(GRAPH_HALF_WIDTH)} + uLinePx, dm);
    float halo = 0.25 * exp(-dm / ${g(GRAPH_GLOW / 3)});
    float ends = smoothstep(0.0, 0.02, gp.x) * (1.0 - smoothstep(0.98, 1.0, gp.x));
    k = max(core, halo) * ends;
  }
  return c * k;
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec4 room = texelFetch(uRoom, fc, 0);
  vec3 col = room.rgb * uLight;
  if (room.a > 0.75) {
    vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
    vec3 d = rayDir(ndc, uResolution.x / uResolution.y);
    vec3 p = vec3(0.0, EYE_Y, 0.0) + d * cylFar(d, WALL_CZ, WALL_R);
    vec2 sy = vec2(wallS(p), p.y);
    vec2 uv = (sy - vec2(${g(ATLAS_S0)}, ${g(ATLAS_Y0)})) * uAtlasScale;
    if (uHasView == 1 && sy.x > uViewport.x && sy.x < uViewport.z && sy.y > uViewport.y && sy.y < uViewport.w) {
      col += texture(uExterior, (sy - uViewport.xy) / (uViewport.zw - uViewport.xy)).rgb;
    }
    float lit;
    vec3 e = emission(uv, lit);
    vec3 glow = texture(uGlow, uv + uGlowTexel * vec2(-1.5, -1.5)).rgb
      + texture(uGlow, uv + uGlowTexel * vec2(1.5, -1.5)).rgb
      + texture(uGlow, uv + uGlowTexel * vec2(-1.5, 1.5)).rgb
      + texture(uGlow, uv + uGlowTexel * vec2(1.5, 1.5)).rgb;
    col = col * (1.0 - lit) + e + glow * 0.06 * (1.0 - lit);
    for (int i = 0; i < ${String(MAX_WIDGETS)}; i++) {
      if (i >= uWidgetCount) {
        break;
      }
      col += widget(i, sy);
    }
  } else if (room.a > 0.25) {
    col += uLens;
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

const LIGHT_DAY: readonly number[] = [1, 1, 1];
const LIGHT_NIGHT: readonly number[] = [0.5, 0.5, 0.55];
const LENS_RED: readonly number[] = [1, 0.15, 0.1];
const LENS_YELLOW: readonly number[] = [1, 0.7, 0.2];

/** The panel font's capital height and the squeeze that makes its digits narrow. */
interface FontFit {
  /** Capital height at a 100 px font. */
  cap: number;
  squeeze: number;
}

const FONT_REF = 100;

function measureFont(ctx: OffscreenCanvasRenderingContext2D): FontFit {
  ctx.font = `600 ${String(FONT_REF)}px ${FONT_FAMILY}`;
  // Typed loosely: the tests' fake 2D context returns undefined from every method.
  const m = ctx.measureText("0") as TextMetrics | undefined;
  const cap = (m?.actualBoundingBoxAscent ?? 0) > 0 ? (m?.actualBoundingBoxAscent ?? 72) : 72;
  const digitW = (m?.width ?? 0) > 0 ? (m?.width ?? 55) : 55;
  return { cap, squeeze: Math.min(1, (DIGIT_WIDTH * cap) / digitW) };
}

/**
 * Draws `value` red and `alt` green (so they land in separate channels) at wall
 * position (x, y), with `top` the canvas row of atlas row `top` and the capital
 * height `size`. A positive `maxWidth` (m) squeezes it further to fit.
 */
function fillRun(
  ctx: OffscreenCanvasRenderingContext2D,
  fit: FontFit,
  tpm: number,
  top: number,
  run: { x: number; y: number; size: number; align: CanvasTextAlign },
  value: string,
  alt: string,
  maxWidth = 0,
): void {
  const px = (run.size * tpm * FONT_REF) / fit.cap;
  if (px < 3) {
    return;
  }
  ctx.font = `600 ${String(px)}px ${FONT_FAMILY}`;
  ctx.textAlign = run.align;
  let squeeze = fit.squeeze;
  if (maxWidth > 0) {
    const w = (ctx.measureText(value) as TextMetrics | undefined)?.width ?? 0;
    if (w * squeeze > maxWidth * tpm) {
      squeeze = (maxWidth * tpm) / w;
    }
  }
  const x = (run.x - ATLAS_S0) * tpm;
  const y = top - (run.y - ATLAS_Y0) * tpm;
  for (const [text, style] of [
    [value, "#ff0000"],
    [alt, "#00ff00"],
  ] as const) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(squeeze, 1);
    ctx.fillStyle = style;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}

/** A canvas's pixels, or null if it gave none (the tests' fake canvas). */
function canvasPixels(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  rows: number,
): Uint8ClampedArray | null {
  // Typed loosely: the tests' fake 2D context returns undefined from every method.
  const image = ctx.getImageData(0, 0, width, rows) as ImageData | undefined;
  const data = image?.data;
  return data && data.length >= width * rows * 4 ? data : null;
}

/**
 * Copies canvas pixels' red and green into the atlas's G (text) and B (alt), for
 * atlas rows r0 to r0 + rows - 1 and columns c0 to c1, flipping rows (the canvas
 * runs top down).
 */
function copyText(
  data: Uint8ClampedArray,
  atlas: AtlasImage,
  r0: number,
  rows: number,
  c0: number,
  c1: number,
): void {
  const { width, rgba } = atlas;
  for (let k = 0; k < rows; k++) {
    const src = (rows - 1 - k) * width * 4;
    const dst = (r0 + k) * width * 4;
    for (let i = c0; i <= c1; i++) {
      rgba[dst + i * 4 + 1] = data[src + i * 4];
      rgba[dst + i * 4 + 2] = data[src + i * 4 + 1];
    }
  }
}

function blankCanvas(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  const ctx = new OffscreenCanvas(width, height).getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "lighter";
  ctx.textBaseline = "alphabetic";
  return ctx;
}

/** Draws the static text runs into the atlas's G (text) and B (alt). */
function drawText(set: PanelSet, atlas: AtlasImage): void {
  const { width, height, tpm } = atlas;
  const ctx = blankCanvas(width, height);
  if (!ctx) {
    return;
  }
  const fit = measureFont(ctx);
  for (const t of set.texts) {
    fillRun(ctx, fit, tpm, height, t, t.text, t.alt);
  }
  const data = canvasPixels(ctx, width, height);
  if (data) {
    copyText(data, atlas, 0, height, 0, width - 1);
  }
}

/** Atlas rows (first, count) that the live readouts can draw in. */
function liveRows(set: PanelSet, atlas: AtlasImage): [number, number] {
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const t of set.live) {
    y0 = Math.min(y0, t.bounds.y0);
    y1 = Math.max(y1, t.bounds.y1);
  }
  if (y1 < y0) {
    return [0, 0];
  }
  const r0 = Math.max(0, Math.floor((y0 - ATLAS_Y0) * atlas.tpm));
  const r1 = Math.min(atlas.height - 1, Math.ceil((y1 - ATLAS_Y0) * atlas.tpm));
  return [r0, Math.max(0, r1 - r0 + 1)];
}

/**
 * Redraws the live readouts' values into the atlas image (clearing each one's
 * bounds first) and returns the rows (first, count) to re-upload.
 */
function drawLive(
  set: PanelSet,
  atlas: AtlasImage,
  values: Readonly<Record<LiveKey, string>>,
): [number, number] {
  const [r0, rows] = liveRows(set, atlas);
  if (rows === 0) {
    return [0, 0];
  }
  const ctx = blankCanvas(atlas.width, rows);
  if (!ctx) {
    return [0, 0];
  }
  const fit = measureFont(ctx);
  const { tpm } = atlas;
  for (const t of set.live) {
    const value = values[t.key];
    fillRun(ctx, fit, tpm, r0 + rows, t, value, value, t.bounds.s1 - t.bounds.s0);
  }
  const data = canvasPixels(ctx, atlas.width, rows);
  if (!data) {
    return [0, 0];
  }
  for (const t of set.live) {
    const c0 = Math.max(0, Math.floor((t.bounds.s0 - ATLAS_S0) * tpm));
    const c1 = Math.min(atlas.width - 1, Math.ceil((t.bounds.s1 - ATLAS_S0) * tpm));
    copyText(data, atlas, r0, rows, c0, c1);
  }
  return [r0, rows];
}

/**
 * Starship Bridge. The camera never moves, so the room is ray-traced once per
 * resize into a full-resolution target, and the panels are drawn once into an
 * atlas in wall coordinates. Each frame updates one small texture of block
 * states, re-renders the glow (at 1/8 of the atlas) and the outside view, then
 * composites everything in one full-screen pass. The band's real readouts
 * (stardate, local time and date, ship status, location) redraw into the atlas only when they change.
 */
export const bridge = defineEffect(bridgeMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uResolution", "uGlassCount"]);
      const exteriorProgram = program(FULLSCREEN_VERTEX, EXTERIOR_FRAGMENT);
      const eu = createUniforms(gl, exteriorProgram, [
        "uKind",
        "uTime",
        "uAspect",
        "uFade",
        "uPlanetPos",
        "uPlanetK",
        "uOcean",
        "uLandLow",
        "uLandHigh",
        "uCloud",
        "uAtmosphere",
        "uHaze",
        "uLight",
        "uShipKind",
        "uShip",
        "uShipScale",
        "uShipPx",
      ]);
      const glowProgram = program(FULLSCREEN_VERTEX, GLOW_FRAGMENT);
      const gu = createUniforms(gl, glowProgram, ["uTexel", "uAtlas", "uIndex", "uState"]);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, [
        "uRoom",
        "uGlow",
        "uExterior",
        "uAtlas",
        "uIndex",
        "uState",
        "uResolution",
        "uAtlasScale",
        "uGlowTexel",
        "uViewport",
        "uHasView",
        "uWidget",
        "uWidgetInfo",
        "uWidgetCount",
        "uTime",
        "uGraph",
        "uGraphShift",
        "uLight",
        "uLens",
        "uLinePx",
      ]);
      const streaks = scope.own(createStreakRenderer(gl, WARP_STARS, { chromatic: true }));
      const starfield = createStarfield(WARP_STARS);
      const warpZoom: Rgb = [1 + WARP_ABERRATION, 1, 1 - WARP_ABERRATION];
      const warpFrame: StarFrame = {
        width: 1,
        height: 1,
        scale: 1,
        speed: 1.2,
        count: WARP_STARS,
        streak: 1,
        size: 2,
        tintAmount: 0.5,
        star: [1, 1, 1],
        tint: hexToUnitRgb("#8fb8ff"),
      };
      const glassLoc = gl.getUniformLocation(roomProgram, "uGlass[0]");
      const glassData = new Float32Array(MAX_GLASS * 4);
      const widgetData = new Float32Array(MAX_WIDGETS * 4);
      const widgetInfo = new Float32Array(MAX_WIDGETS * 2);

      gl.useProgram(glowProgram);
      gu.i1("uAtlas", 1);
      gu.i1("uIndex", 2);
      gu.i1("uState", 3);
      gl.useProgram(compositeProgram);
      cu.i1("uRoom", 0);
      cu.i1("uAtlas", 1);
      cu.i1("uIndex", 2);
      cu.i1("uState", 3);
      cu.i1("uGlow", 4);
      cu.i1("uExterior", 5);
      cu.i1("uGraph", 6);
      // The POWER graphs' random walk, one row per widget, rebuilt with the seed.
      let graph = createGraphWalk(MAX_WIDGETS, 0);
      let graphStart = 0;
      const graphTex = createDataTexture(gl, {
        width: GRAPH_SAMPLES,
        height: MAX_WIDGETS,
        internalFormat: gl.R8,
        format: gl.RED,
        type: gl.UNSIGNED_BYTE,
        data: graph.values,
        filter: gl.NEAREST,
      });
      scope.defer(() => {
        gl.deleteTexture(graphTex);
      });

      // Resources rebuilt on resize or a layout change, released by the scope at the end.
      let room: RenderTarget | null = null;
      let glow: RenderTarget | null = null;
      let exterior: RenderTarget | null = null;
      let atlasTex: WebGLTexture | null = null;
      let indexTex: WebGLTexture | null = null;
      let stateTex: WebGLTexture | null = null;
      const freeAtlas = () => {
        if (atlasTex) {
          gl.deleteTexture(atlasTex);
        }
        if (indexTex) {
          gl.deleteTexture(indexTex);
        }
        atlasTex = indexTex = null;
      };
      const freeTargets = () => {
        room?.dispose();
        glow?.dispose();
        exterior?.dispose();
        room = glow = exterior = null;
      };
      scope.defer(() => {
        freeTargets();
        freeAtlas();
        if (stateTex) {
          gl.deleteTexture(stateTex);
        }
        stateTex = null;
      });

      let width = 1;
      let height = 1;
      let time = 0;
      let layoutKey = "";
      let atlasKey = "";
      let roomDrawn = false;
      let disposed = false;
      scope.defer(() => {
        disposed = true;
      });
      // Load the panel font in the background; once it's in, redraw the atlas with it.
      if (typeof FontFace !== "undefined" && typeof document !== "undefined") {
        const face = new FontFace(FONT_FACE, `url(${FONT_URL})`, { weight: "600" });
        face
          .load()
          .then((loaded) => {
            document.fonts.add(loaded);
            if (!disposed) {
              atlasKey = "";
            }
            return loaded;
          })
          .catch(() => {
            console.warn(`Starship Bridge: couldn't load ${FONT_URL}`);
          });
      }
      let layout: BridgeLayout = bridgeLayout("left", true);
      let set: PanelSet = buildPanels(layout, 0);
      let seed = 0;
      let state = new Uint8Array(4);
      let scratch: StateScratch = createStateScratch(1);
      let atlasW = 1;
      let atlasH = 1;
      let tpm = 1;
      const mix = createAlertMix();
      const light = [1, 1, 1];
      const shift = [1, 1, 1];
      let first = true;
      const ship = createShipPose();
      const shipPlan: ShipPlan = { kind: -1, stay: false, gap: 0 };
      /** When the ship settings last changed, so a newly chosen ship arrives soon. */
      let shipEpoch = 0;
      let shipChoice = "";
      let planetVisit = Number.NaN;
      let planetSeed = Number.NaN;
      /** The CPU copy of the atlas, kept for redrawing the live readouts. */
      let atlasImage: AtlasImage | null = null;
      const liveValues: Record<LiveKey, string> = {
        stardate: "",
        time: "",
        date: "",
        status: "",
        location: "",
      };
      let liveSecond = Number.NaN;

      /**
       * Updates the live readouts, re-uploading the band's rows if any changed: the
       * status as soon as the settings change it, the clock values once a second.
       */
      const updateLive = (status: string) => {
        const now = Date.now();
        const second = Math.floor(now / 1000);
        if ((second === liveSecond && status === liveValues.status) || !atlasImage || !atlasTex) {
          return;
        }
        liveSecond = second;
        const sd = formatStardate(stardate(now));
        const local = new Date(now);
        const clock = clockText(local);
        const day = dateText(local);
        const location = locationAt(now, seed);
        if (
          sd === liveValues.stardate &&
          clock === liveValues.time &&
          day === liveValues.date &&
          location === liveValues.location &&
          status === liveValues.status
        ) {
          return;
        }
        liveValues.stardate = sd;
        liveValues.time = clock;
        liveValues.date = day;
        liveValues.location = location;
        liveValues.status = status;
        const [r0, rows] = drawLive(set, atlasImage, liveValues);
        if (rows > 0) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, atlasTex);
          resetUnpackState(gl);
          const w = atlasImage.width;
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            r0,
            w,
            rows,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            atlasImage.rgba.subarray(r0 * w * 4, (r0 + rows) * w * 4),
          );
        }
      };

      /** Rebuilds the panels for a new layout or seed (CPU only). */
      const rebuildLayout = (
        display: "left" | "right",
        showView: boolean,
        newSeed: number,
        hidden: ReadonlySet<LiveKey>,
      ) => {
        layout = bridgeLayout(display, showView);
        seed = newSeed;
        set = buildPanels(layout, seed, hidden);
        if (graph.seed !== seed) {
          graph = createGraphWalk(MAX_WIDGETS, seed);
          graphStart = time;
          gl.activeTexture(gl.TEXTURE6);
          updateDataTexture(
            gl,
            graphTex,
            GRAPH_SAMPLES,
            MAX_WIDGETS,
            gl.RED,
            gl.UNSIGNED_BYTE,
            graph.values,
          );
        }
        state = new Uint8Array(set.blocks.length * 4);
        scratch = createStateScratch(groupCount(set));
        if (stateTex) {
          gl.deleteTexture(stateTex);
        }
        stateTex = null;
        stateTex = createDataTexture(gl, {
          width: set.blocks.length,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: state,
          filter: gl.NEAREST,
        });
        layout.panels.forEach((p, i) => {
          if (i < MAX_GLASS) {
            glassData.set([p.s0, p.y0, p.s1, p.y1], i * 4);
          }
        });
        widgetData.fill(0);
        widgetInfo.fill(0);
        set.widgets.forEach((w, i) => {
          widgetData.set([w.s0, w.y0, w.s1, w.y1], i * 4);
          widgetInfo.set([w.kind === "sweep" ? 0 : 1, w.block], i * 2);
        });
        roomDrawn = false;
        atlasKey = "";
      };

      /** Rasterises the atlas and index at the current size and uploads them. */
      const rebuildAtlas = () => {
        freeAtlas();
        const maxSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096;
        tpm = atlasTexelsPerMetre(height, maxSize);
        atlasW = Math.max(1, Math.ceil((ATLAS_S1 - ATLAS_S0) * tpm));
        atlasH = Math.max(1, Math.ceil((ATLAS_Y1 - ATLAS_Y0) * tpm));
        const image = createAtlasImage(atlasW, atlasH, tpm);
        rasterisePanels(set, image);
        drawText(set, image);
        atlasImage = image;
        // Redraw the live readouts into the new atlas on the next frame.
        liveValues.stardate = liveValues.time = liveValues.date = "";
        liveValues.status = liveValues.location = "";
        liveSecond = Number.NaN;
        atlasTex = createDataTexture(gl, {
          width: atlasW,
          height: atlasH,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: image.rgba,
        });
        indexTex = createDataTexture(gl, {
          width: atlasW,
          height: atlasH,
          internalFormat: gl.R16UI,
          format: gl.RED_INTEGER,
          type: gl.UNSIGNED_SHORT,
          data: image.index,
          filter: gl.NEAREST,
        });
        // The glow and outside-view targets follow the atlas size.
        glow?.dispose();
        exterior?.dispose();
        glow = createRenderTarget(
          gl,
          Math.max(1, Math.ceil(atlasW / GLOW_DIVISOR)),
          Math.max(1, Math.ceil(atlasH / GLOW_DIVISOR)),
          gl.RGBA8,
        );
        const vp = layout.viewport;
        exterior = vp
          ? createRenderTarget(
              gl,
              Math.max(8, Math.ceil((vp.s1 - vp.s0) * tpm * EXTERIOR_SCALE)),
              Math.max(8, Math.ceil((vp.y1 - vp.y0) * tpm * EXTERIOR_SCALE)),
              gl.RGBA8,
            )
          : null;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          room?.dispose();
          room = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          roomDrawn = false;
          atlasKey = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const showView = p.exterior !== "off";
          const display = p.display === "right" ? "right" : "left";
          const key = `${display}|${String(showView)}|${String(Math.floor(p.seed))}|${String(p.showTime)}|${String(p.showDate)}`;
          if (key !== layoutKey) {
            layoutKey = key;
            const hidden = new Set<LiveKey>();
            if (!p.showTime) {
              hidden.add("time");
            }
            if (!p.showDate) {
              hidden.add("date");
            }
            rebuildLayout(display, showView, Math.floor(p.seed), hidden);
          }
          const aKey = `${key}|${String(height)}`;
          if (aKey !== atlasKey) {
            atlasKey = aKey;
            rebuildAtlas();
          }
          if (!room || !glow || !atlasTex || !indexTex || !stateTex) {
            return;
          }

          // Alert colours and room light ease towards their targets.
          const fade = first ? 1e3 : step;
          first = false;
          stepAlert(mix, p.alert === "red" || p.alert === "yellow" ? p.alert : "normal", fade);
          const target = p.lighting === "night" ? LIGHT_NIGHT : LIGHT_DAY;
          for (let i = 0; i < 3; i++) {
            shift[i] = approach(shift[i], target[i], fade / LIGHTING_FADE);
          }
          const dim = 1 - 0.3 * mix.red;
          light[0] = shift[0] * dim;
          light[1] = shift[1] * dim * (1 - 0.25 * mix.red);
          light[2] = shift[2] * dim * (1 - 0.3 * mix.red);

          // 1. The room, when it may have changed.
          if (!roomDrawn) {
            room.bind();
            gl.useProgram(roomProgram);
            ru.f2("uResolution", width, height);
            ru.i1("uGlassCount", Math.min(MAX_GLASS, layout.panels.length));
            gl.uniform4fv(glassLoc, glassData);
            triangle.draw();
            roomDrawn = true;
          }

          // 2. The real readouts, then the block states.
          updateLive(shipStatus(p.alert, p.exterior));
          blockStates(set.blocks, seed, p.activity, mix, time, scratch, state);
          gl.activeTexture(gl.TEXTURE3);
          updateDataTexture(gl, stateTex, set.blocks.length, 1, gl.RGBA, gl.UNSIGNED_BYTE, state);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, atlasTex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, indexTex);

          // 3. Glow: the panels' emission at low resolution.
          glow.bind();
          gl.useProgram(glowProgram);
          gu.f2("uTexel", 1 / glow.width, 1 / glow.height);
          triangle.draw();

          // 4. The outside view.
          const vp = layout.viewport;
          if (exterior && vp) {
            exterior.bind();
            if (p.exterior === "warp") {
              // Warp Speed's starfield, streaking past as seen from the display.
              warpFrame.width = exterior.width;
              warpFrame.height = exterior.height;
              warpFrame.scale = Math.max(exterior.height / 1080, WARP_MIN_SCALE);
              const count = starfield.step(step, warpFrame, streaks.data);
              gl.clearColor(SPACE[0], SPACE[1], SPACE[2], 1);
              gl.clear(gl.COLOR_BUFFER_BIT);
              streaks.upload(count);
              streaks.draw(count, exterior.width, exterior.height, warpZoom);
              gl.disable(gl.BLEND);
            } else {
              const aspect = (vp.s1 - vp.s0) / (vp.y1 - vp.y0);
              const planet = p.exterior === "planet";
              gl.useProgram(exteriorProgram);
              eu.i1("uKind", planet ? 1 : 0);
              eu.f1("uTime", time % EXTERIOR_PERIOD);
              eu.f1("uAspect", aspect);
              // The planet matches the location readout, changing with it behind a quick fade.
              const now = Date.now();
              const visit = locationVisit(now);
              if (visit !== planetVisit || seed !== planetSeed) {
                planetVisit = visit;
                planetSeed = seed;
                const st = planetStyle(locationIndex(visit, seed), visit, seed);
                eu.f3("uPlanetPos", st.x, st.top, st.radius);
                eu.f4("uPlanetK", st.sea, st.clouds, st.ice, st.bands);
                eu.v3("uOcean", st.ocean);
                eu.v3("uLandLow", st.landLow);
                eu.v3("uLandHigh", st.landHigh);
                eu.v3("uCloud", st.cloud);
                eu.v3("uAtmosphere", st.atmosphere);
                eu.f1("uHaze", st.haze);
                const lz = 0.9;
                const ll = Math.hypot(1, lz);
                eu.f3("uLight", -Math.cos(st.light) / ll, Math.sin(st.light) / ll, lz / ll);
              }
              const hold = LOCATION_HOLD * 1000;
              const edge = Math.min(now - visit * hold, (visit + 1) * hold - now);
              eu.f1("uFade", planet ? Math.min(1, edge / PLANET_FADE_MS) : 1);
              // A visiting ship, now and then.
              if (p.ship !== shipChoice || p.shipStay !== shipPlan.stay) {
                shipChoice = p.ship;
                shipEpoch = time;
                // Options after "cycle" and "none" are in `SHIP_KINDS` order; cycling is -1.
                shipPlan.kind = Math.max(-1, SHIP_OPTIONS.findIndex((o) => o.value === p.ship) - 2);
              }
              shipPlan.stay = p.shipStay;
              shipPlan.gap = p.shipGap;
              if (p.ship === "none") {
                ship.kind = -1;
              } else {
                shipAt(time - shipEpoch, seed, shipPlan, ship);
              }
              if (ship.kind >= 0) {
                const kind = SHIP_KINDS[ship.kind] ?? "shuttlecraft";
                const scale = SHIP_SCALE[kind];
                const reach = (aspect * 0.5 * SHIP_DISTANCE) / SHIP_FOCAL + SHIP_RADIUS * scale;
                eu.f4("uShip", ship.across * reach, SHIP_Y + ship.bob, SHIP_DISTANCE, ship.yaw);
                eu.f1("uShipScale", scale);
                eu.f1("uShipPx", 1 / (exterior.height * SHIP_FOCAL));
              }
              eu.i1("uShipKind", ship.kind);
              triangle.draw();
            }
          }

          // 5. Composite to the canvas.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_2D, glow.texture);
          gl.activeTexture(gl.TEXTURE5);
          gl.bindTexture(gl.TEXTURE_2D, exterior ? exterior.texture : glow.texture);
          gl.activeTexture(gl.TEXTURE6);
          if (advanceGraph(graph, time - graphStart)) {
            updateDataTexture(
              gl,
              graphTex,
              GRAPH_SAMPLES,
              MAX_WIDGETS,
              gl.RED,
              gl.UNSIGNED_BYTE,
              graph.values,
            );
          } else {
            gl.bindTexture(gl.TEXTURE_2D, graphTex);
          }
          cu.f2("uResolution", width, height);
          cu.f2("uAtlasScale", tpm / atlasW, tpm / atlasH);
          cu.f2("uGlowTexel", 1 / glow.width, 1 / glow.height);
          cu.i1("uHasView", exterior && vp ? 1 : 0);
          if (vp) {
            cu.f4("uViewport", vp.s0, vp.y0, vp.s1, vp.y1);
          }
          gl.uniform4fv(cu.loc.uWidget, widgetData);
          gl.uniform2fv(cu.loc.uWidgetInfo, widgetInfo);
          cu.i1("uWidgetCount", set.widgets.length);
          cu.f1("uTime", time % WIDGET_PERIOD);
          cu.f1("uGraphShift", graphShift(time - graphStart));
          cu.f3("uLight", light[0], light[1], light[2]);
          const k = (mix.red + mix.yellow) * (0.25 + 0.75 * alertPulse(time));
          const share = mix.red + mix.yellow > 0 ? mix.red / (mix.red + mix.yellow) : 1;
          cu.f3(
            "uLens",
            k * (LENS_RED[0] * share + LENS_YELLOW[0] * (1 - share)),
            k * (LENS_RED[1] * share + LENS_YELLOW[1] * (1 - share)),
            k * (LENS_RED[2] * share + LENS_YELLOW[2] * (1 - share)),
          );
          cu.f1("uLinePx", 1 / tpm);
          triangle.draw();
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
