import { createChangeKey } from "../change-key";
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
import { createSkyState } from "../horizon/horizon-sim";
import { lowResSize } from "../lowres";
import { approach, wrap } from "../math";
import { buildPeriodicNoiseTexture, createRng } from "../noise";
import { landColor, presetSky, SEA_PRESETS } from "../sea/sea-sim";
import { createSeaWater, createSeaWaterFrame, SEA_SKY_GLSL } from "../sea/sea-water";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { defineEffect } from "../types";
import {
  DEFAULT_CONFIG,
  createRainSim,
  instanceCapacity,
  type RainSimParams,
  resizeRainSim,
  stepRainSim,
  writeDropInstances,
} from "../windowrain/windowrain-sim";
import {
  DROP_CLEAR,
  DROP_DIR_GLSL,
  DROP_FRAGMENT,
  DROP_VERTEX,
  OFFSET_RANGE,
} from "../windowrain/windowrain-drops";
import { type LensSide, lamproomMeta } from "./lamproom.meta";
import {
  advanceLens,
  ASTRAGAL_PITCH,
  ASTRAGAL_SLOPE,
  ASTRAGAL_W,
  BAND_SIZE,
  BASE_H,
  BASE_RING,
  beamLevel,
  BEAMS,
  buildBandTable,
  CAM_Y,
  CAM_Z,
  cameraX,
  CLOUD_DRIFT,
  CLOUD_HEIGHT,
  CLOUD_NOISE,
  CLOUD_SCALE,
  cloudDensity,
  cloudUv,
  CORNICE_Y,
  createWeatherLook,
  CROWN_FOOT,
  CROWN_H,
  DRUM_HALF,
  easeWeather,
  facing,
  FOCAL,
  HORIZON_Y,
  LAMP_Y,
  LENS_PANELS,
  LENS_R,
  LENS_Y0,
  LENS_Y1,
  lensBox,
  LINTEL_Y,
  MOON_Y,
  moonX,
  MULLION_W,
  PANES,
  PEDESTAL_R,
  RAIL_HALF,
  RAIL_R,
  RAIL_Y,
  sampleTiled,
  SEA_HEIGHT_M,
  SILL_Y,
  towardCamera,
  UNIT_M,
  WALK_R,
  WALK_Y,
} from "./lamproom-sim";

const PI = Math.PI;
const v3 = (c: Rgb | readonly number[]) => `vec3(${F(c[0])}, ${F(c[1])}, ${F(c[2])})`;

/** The view outside renders at about this many reference px per texel: it is soft and seen through glass. */
const VIEW_TEXEL_REF = 2;
/** The lamp's warm white, and the beam's slightly cooler white in the haze. */
const LAMP: Rgb = [1, 0.84, 0.62];
const BEAM_RGB: Rgb = [1, 0.93, 0.8];
/** Seconds for a change of the `beam` param to take full effect, so dragging it never flashes. */
const BEAM_EASE = 1.5;
/** Strength of the refracted bands on the room's surfaces: always on, and the extra at full `beam`. */
const BAND_BASE = 0.7;
const BAND_BEAM = 1.6;
/** Beam haze: width at the lens (world units), spread (tan of the half-angle) and fade distance. */
const BEAM_W0 = 0.2;
const BEAM_SPREAD = 0.06;
const BEAM_FADE = 650 / UNIT_M;
/** Haze strength of a beam crossing the view, at `beam` = 1. */
const BEAM_HAZE = 0.22;
/** Refraction through the raindrops, as a share of Rain on a Window's: kept low so it doesn't shimmer. */
const REFRACTION = 0.4;
/** The moon disc's radius (frame heights). */
const MOON_R = 0.026;
/** Storm sky colours, mixed over the moonlit sky's. */
const STORM_ZENITH: Rgb = [0.025, 0.03, 0.04];
const STORM_HORIZON: Rgb = [0.07, 0.08, 0.09];

/** Camera and world-ray helpers, shared by the room, composite and lens passes. */
const CAMERA_GLSL = /* glsl */ `
/** Camera x, y, z (world), focal length (device px). */
uniform vec4 uCam;
/** Eye-level centre of the frame (device px). */
uniform vec2 uCentre;
/** The view ray through a device pixel, with z = 1 so a distance along it is a depth. */
vec3 viewRay(vec2 frag) { return vec3((frag - uCentre) / uCam.w, 1.0); }
/** Depth at which a ray from inside meets the ring of radius R. */
float ringFromInside(vec3 r, float R) {
  vec2 o = uCam.xz;
  vec2 d = r.xz;
  float a = dot(d, d);
  float b = dot(o, d);
  float c = dot(o, o) - R * R;
  return (-b + sqrt(max(b * b - a * c, 0.0))) / a;
}
/** z-component of the cross product of two vectors on the floor plane. */
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
`;

/** Value noise, for paint and grain in the cached room. */
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

const IRON: Rgb = [0.05, 0.065, 0.062];
const PAINT: Rgb = [0.1, 0.17, 0.15];
const BRASS: Rgb = [0.8, 0.58, 0.27];
const FLOOR: Rgb = [0.22, 0.075, 0.055];
const CEILING: Rgb = [0.035, 0.04, 0.045];

/**
 * The room, drawn once per resize or change of side, premultiplied: the ring
 * of iron window frames with their diagonal astragals (alpha 0 over the
 * glass), the painted parapet and its sill, the brass handrail, the cornice
 * and the roof's ribs, the iron floor and grated walkway, and the lens's
 * cast-iron pedestal. Every surface is found by casting the pixel's ray at
 * the room's cylinders and planes, lit by a faint cool ambient and the warm
 * lamp light that leaks from the lens.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
${CAMERA_GLSL}
${NOISE_GLSL}
${DITHER_GLSL}
const float PI = ${F(PI)};
const vec3 IRON = ${v3(IRON)};
const vec3 PAINT = ${v3(PAINT)};
const vec3 BRASS = ${v3(BRASS)};
const vec3 FLOOR = ${v3(FLOOR)};
const vec3 CEILING = ${v3(CEILING)};
const vec3 LAMP = ${v3(LAMP)};
const vec3 AMBIENT = vec3(0.16, 0.19, 0.26);
const float PANE = ${F((2 * PI) / PANES)};
const vec3 LAMP_AT = vec3(0.0, ${F(LAMP_Y)}, 0.0);

/** Lamp light reaching P with normal N: a soft falloff, half-Lambert so nothing goes fully black. */
vec3 light(vec3 P, vec3 N) {
  vec3 d = LAMP_AT - P;
  float r2 = dot(d, d);
  float lambert = 0.35 + 0.65 * max(dot(N, d * inversesqrt(r2)), 0.0);
  return AMBIENT + LAMP * (0.8 * lambert / (1.0 + 1.6 * r2));
}

/** Anti-aliased coverage of a band |x| < w, for x and w in world units at a footprint of fp per pixel. */
float band(float x, float w, float fp) { return clamp((w - abs(x)) / fp + 0.5, 0.0, 1.0); }

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 r = viewRay(frag);
  vec3 C = uCam.xyz;
  vec3 col;
  float alpha = 1.0;

  float tw = ringFromInside(r, 1.0);
  vec3 W = C + r * tw;
  bool done = false;

  // The pedestal under the lens: a cast-iron column from outside.
  {
    vec2 o = C.xz;
    vec2 d = r.xz;
    float a = dot(d, d);
    float b = dot(o, d);
    float c = dot(o, o) - ${F(PEDESTAL_R * PEDESTAL_R)};
    float disc = b * b - a * c;
    if (disc > 0.0) {
      float t = (-b - sqrt(disc)) / a;
      vec3 P = C + r * t;
      if (P.y > 0.0 && P.y < ${F(LENS_Y0 - 0.03)}) {
        vec3 N = vec3(P.x, 0.0, P.z) / ${F(PEDESTAL_R)};
        float az = atan(P.z, P.x);
        float flute = 0.85 + 0.15 * cos(az * 24.0);
        float collar = band(P.y - ${F(LENS_Y0 - 0.06)}, 0.012, t / uCam.w);
        col = mix(IRON * 1.2 * flute, BRASS * 0.7, collar) * light(P, N);
        // Darker into the floor.
        col *= 0.6 + 0.4 * smoothstep(0.0, 0.2, P.y);
        done = true;
      }
    }
  }

  // Floor and walkway, looking down.
  if (!done && r.y < 0.0) {
    float tWalk = (${F(WALK_Y)} - C.y) / r.y;
    vec3 Pw = C + r * tWalk;
    float rw = length(Pw.xz);
    float tFloor = -C.y / r.y;
    vec3 Pf = C + r * tFloor;
    float rf = length(Pf.xz);
    if (rw >= ${F(WALK_R)} && rw < 1.0) {
      // Grating: iron slats round the ring, with cross bars.
      float fp = tWalk / uCam.w;
      float ang = atan(Pw.z, Pw.x);
      float slat = band((fract(rw / 0.035 + 0.5) - 0.5) * 0.035, 0.008, fp);
      float bar = band((fract(ang * ${F(120 / (2 * PI))} + 0.5) - 0.5) * ${F((2 * PI) / 120)} * rw, 0.006, fp);
      float g = max(slat, bar);
      col = mix(IRON * 0.35, IRON * 1.6, g) * light(Pw, vec3(0.0, 1.0, 0.0));
      done = true;
    } else if (rw < ${F(WALK_R)} && rf < ${F(WALK_R)}) {
      // Painted iron plates, seamed radially under every mullion and once round.
      float fp = tFloor / uCam.w;
      float ang = atan(Pf.z, Pf.x);
      float sa = (fract(ang / PANE + 0.5) - 0.5) * PANE * rf;
      float seam = max(band(sa, 0.004, fp), band(rf - 0.5, 0.004, fp));
      float wear = 0.85 + 0.3 * vnoise(Pf.xz * 7.0);
      col = FLOOR * wear * (1.0 - 0.4 * seam) * light(Pf, vec3(0.0, 1.0, 0.0));
      // The pedestal's shadow pools round its foot.
      col *= mix(0.55, 1.0, smoothstep(${F(PEDESTAL_R)}, ${F(PEDESTAL_R + 0.12)}, rf));
      done = true;
    } else if (rw < ${F(WALK_R)} && rf < 1.0) {
      // The walkway's inner edge.
      col = IRON * 0.8 * light(Pf, vec3(-Pf.x, 0.0, -Pf.z) / max(rf, 1e-3));
      done = true;
    }
  }

  if (!done) {
    vec3 N = vec3(-W.x, 0.0, -W.z);
    float fp = tw / uCam.w;
    float ang = atan(W.x, W.z);
    // Arc position within the pane, measured from its mullion.
    float s = (fract(ang / PANE + 0.5) - 0.5) * PANE;
    if (W.y < ${F(SILL_Y)}) {
      // Parapet: painted iron panels, seamed under each mullion, with a sill ledge on top.
      float seam = band(s, 0.004, fp);
      float rail = band(W.y - 0.2, 0.004, fp);
      float sill = clamp((W.y - ${F(SILL_Y - 0.032)}) / fp + 0.5, 0.0, 1.0);
      float grain = 0.9 + 0.2 * vnoise(vec2(ang * 40.0, W.y * 30.0));
      col = PAINT * grain * (1.0 - 0.5 * max(seam, rail));
      vec3 lit = light(W, N);
      col = mix(col * lit, IRON * 1.6 * light(W, normalize(N + vec3(0.0, 1.5, 0.0))), sill);
      col *= 0.6 + 0.4 * smoothstep(0.0, ${F(SILL_Y)}, W.y);
    } else if (W.y < ${F(LINTEL_Y)}) {
      float h = W.y - ${F(SILL_Y)};
      float mull = band(s, ${F(MULLION_W / 2)}, fp);
      float d1 = (fract((s + h / ${F(ASTRAGAL_SLOPE)}) / ${F(ASTRAGAL_PITCH)}) - 0.5) * ${F(ASTRAGAL_PITCH)};
      float d2 = (fract((s - h / ${F(ASTRAGAL_SLOPE)}) / ${F(ASTRAGAL_PITCH)}) - 0.5) * ${F(ASTRAGAL_PITCH)};
      // Along the ring the diagonals cross at an angle: their normal width is narrower in s.
      float k = ${F(Math.sqrt(1 + 1 / (ASTRAGAL_SLOPE * ASTRAGAL_SLOPE)))};
      float astr = max(band(d1, ${F(ASTRAGAL_W / 2)} * k, fp * k), band(d2, ${F(ASTRAGAL_W / 2)} * k, fp * k));
      float bars = max(band(h - 0.012, 0.012, fp), band(W.y - ${F(LINTEL_Y - 0.012)}, 0.012, fp));
      float frame = max(max(mull, astr), bars);
      // Iron edges catch the lamp; the mullions' faces a little more than the thin astragals.
      vec3 iron = IRON * (1.0 + 0.6 * mull) * light(W, N) * 2.2;
      // Glass: alpha 0, with a faint cool sheen added over the view.
      vec3 sheen = vec3(0.006, 0.008, 0.011);
      col = mix(sheen, iron, frame);
      alpha = frame;
    } else if (W.y < ${F(CORNICE_Y)}) {
      // Cornice: an iron band with two mouldings.
      float m1 = band(W.y - ${F(LINTEL_Y + 0.03)}, 0.006, fp);
      float m2 = band(W.y - ${F(CORNICE_Y - 0.02)}, 0.008, fp);
      col = IRON * (1.3 + 1.2 * max(m1, m2)) * light(W, N);
    } else {
      // Roof: dark, ribbed above each mullion.
      float rib = band(s, 0.012, fp);
      col = mix(CEILING, IRON * 1.4, rib) * light(W, normalize(N - vec3(0.0, 0.6, 0.0)));
      col *= 1.0 - 0.5 * smoothstep(${F(CORNICE_Y)}, ${F(CORNICE_Y + 0.5)}, W.y);
    }
  }
  // The brass handrail, standing in from the glass, over the wall behind it.
  if (!done) {
    float tr = ringFromInside(r, ${F(RAIL_R)});
    vec3 P = C + r * tr;
    float dy = P.y - ${F(RAIL_Y)};
    float cov = band(dy, ${F(RAIL_HALF)}, tr / uCam.w);
    if (cov > 0.0) {
      float ny = clamp(dy / ${F(RAIL_HALF)}, -1.0, 1.0);
      vec3 N = normalize(vec3(-P.x, 0.0, -P.z) * (sqrt(1.0 - ny * ny) / ${F(RAIL_R)}) + vec3(0.0, ny, 0.0));
      vec3 brass = BRASS * light(P, N) * 1.3;
      brass += LAMP * 0.18 * pow(max(1.0 - abs(ny - 0.35) * 2.5, 0.0), 3.0);
      col = mix(col, brass, cov);
      alpha = mix(alpha, 1.0, cov);
    }
  }
  outColor = vec4(col + dither8(frag) * alpha, alpha);
}
`;

/**
 * The sky outside, at low resolution over the rows above the horizon: the
 * Calm Sea's moonlit sky, the moon, drifting clouds lit at their edges near
 * the moon, and the distant coastline from the water pass's headland table.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uNoise;
uniform sampler2D uLand;
/** Full-res px per low-res px, across and up. */
uniform vec2 uLowToFull;
/** Horizon centre x, y (full px), 1 / frame height, focal length (frame heights). */
uniform vec4 uView;
/** Moon disc radius (frame heights), moonlight on the clouds, cloud cover, storm. */
uniform vec4 uMoon;
/** Cloud drift offset (noise tiles), coast on, mirrored. */
uniform vec4 uCloud;
uniform vec3 uLandColor;
/** Frame height / width. */
uniform float uAspectInv;
out vec4 outColor;
${SEA_SKY_GLSL}
const vec3 MOON = vec3(0.95, 0.94, 0.88);
const vec3 CLOUD_DARK = vec3(0.035, 0.045, 0.07);
const vec3 CLOUD_STORM = vec3(0.045, 0.05, 0.058);
const vec3 MOONLIT = vec3(0.5, 0.55, 0.65);

/** Mirrors cloudDensity in lamproom-sim.ts. */
float cloudDensity(float n0, float n1, float cover) {
  float n = 0.65 * n0 + 0.35 * n1;
  float threshold = 0.66 - 0.4 * clamp(cover, 0.0, 1.0);
  return smoothstep(threshold - 0.08, threshold + 0.14, n);
}

void main() {
  vec2 p = gl_FragCoord.xy * uLowToFull;
  vec2 q = (p - uView.xy) * uView.z;
  vec3 col = sky(q);
  float aa = uLowToFull.y * uView.z;
  float dm = length(q - uSkyA.xy);
  col = mix(col, MOON, clamp((uMoon.x - dm) / aa + 0.5, 0.0, 1.0));
  // Clouds on a plane overhead, in perspective, thinning into haze at the horizon.
  vec2 s = q / uView.w;
  float k = ${F(CLOUD_HEIGHT * CLOUD_SCALE)} / max(s.y, 1e-3);
  vec2 uv = vec2(s.x, 1.0) * k + uCloud.xy;
  vec2 n = texture(uNoise, uv).rg;
  float dens = cloudDensity(n.r, n.g, uMoon.z) * smoothstep(0.015, 0.12, s.y);
  float rim = exp(-3.0 * dm) * (0.25 + 0.75 * (1.0 - smoothstep(0.2, 0.9, dens)));
  vec3 cloud = mix(CLOUD_DARK, CLOUD_STORM, uMoon.w) + MOONLIT * (uMoon.y * rim);
  col = mix(col, cloud, dens * 0.94);
  if (uCloud.z > 0.5) {
    float u = 0.5 + q.x * uAspectInv;
    u = mix(u, 1.0 - u, uCloud.w);
    float lh = texture(uLand, vec2(u, 0.5)).r;
    col = mix(col, uLandColor, clamp((lh - q.y) / aa + 0.5, 0.0, 1.0));
  }
  outColor = vec4(col, 1.0);
}
`;

/**
 * The beams in the haze outside, added over the low-res view, and the storm's
 * murk over it all (premultiplied). For each beam, the pixel's ray is matched
 * to the beam's axis at their closest approach: the light there falls off
 * across the cone, which widens with distance, and fades into the night.
 */
const BEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Full-res px per low-res px. */
uniform vec2 uLowToFull;
/** Camera x, y, z (world), focal length (full px). */
uniform vec4 uCam;
uniform vec2 uCentre;
/** Per beam: direction (x, z), haze strength. */
uniform vec3 uBeam[${String(BEAMS)}];
uniform vec3 uBeamColor;
/** Murk colour and amount. */
uniform vec4 uMurk;
/** Fade distance (world units). */
uniform float uFade;
out vec4 outColor;
const vec3 LAMP_AT = vec3(0.0, ${F(LAMP_Y)}, 0.0);

void main() {
  vec2 p = gl_FragCoord.xy * uLowToFull;
  vec3 r = normalize(vec3((p - uCentre) / uCam.w, 1.0));
  vec3 w0 = uCam.xyz - LAMP_AT;
  float sum = 0.0;
  for (int i = 0; i < ${String(BEAMS)}; i++) {
    vec3 B = uBeam[i];
    if (B.z <= 0.0) continue;
    vec3 d = vec3(B.x, 0.0, B.y);
    float b = dot(r, d);
    float dd = dot(r, w0);
    float e = dot(d, w0);
    float den = max(1.0 - b * b, 1e-4);
    float s = max((e - b * dd) / den, 0.0);
    float t = max(b * s - dd, 0.0);
    vec3 gap = w0 + r * t - d * s;
    float w = ${F(BEAM_W0)} + s * ${F(BEAM_SPREAD)};
    float x = length(gap) / w;
    sum += B.z * exp(-x * x) * (${F(BEAM_W0)} / w) / max(sqrt(den), 0.2) * exp(-s / uFade);
  }
  float m = uMurk.w;
  outColor = vec4(uBeamColor * sum + uMurk.rgb * m, m);
}
`;

/**
 * The frame, at full size: the cached room, with the view through its glass
 * (refracted by any rain on it), the bands of refracted light the lens throws
 * on the iron and brass, and the soft glow round the lens as a beam passes
 * the camera.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uView;
uniform sampler2D uDrops;
uniform sampler2D uBands;
uniform vec2 uResolution;
/** Toward the camera from the lens (x, z), lens angle, band strength. */
uniform vec4 uLens;
/** Lens's lamp on screen (device px), glow radius (px), glow level. */
uniform vec4 uGlow;
/** Rain on (0 or 1), then the refraction offset scale (decoded drop offset to uv). */
uniform vec3 uRain;
out vec4 outColor;
${CAMERA_GLSL}
${DROP_DIR_GLSL}
const vec3 LAMP = ${v3(LAMP)};

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uResolution;
  vec4 room = texture(uRoom, uv);
  vec3 col = room.rgb;
  float glass = 1.0 - room.a;
  if (glass > 0.0) {
    vec2 off = vec2(0.0);
    float spec = 0.0;
    float dim = 1.0;
    if (uRain.x > 0.5) {
      vec4 d = texture(uDrops, uv);
      vec2 dir = dropDir(d);
      off = dir * uRain.yz;
      float rim = d.a * (1.0 - smoothstep(0.0, 0.45, d.z));
      dim = 1.0 - 0.35 * rim;
      spec = pow(max(d.z * 0.8 + dot(dir, vec2(0.35, -0.3)) * 0.3, 0.0), 30.0) * d.a;
    }
    vec3 v = texture(uView, uv + off).rgb * dim + LAMP * (spec * 0.08);
    col += v * glass;
  }
  // Bands of refracted light, by angle round the room from the lens.
  vec3 r = viewRay(frag);
  vec3 P;
  float w = 1.0;
  if (r.y < 0.0 && length((uCam.xz + r.xz * (-uCam.y / r.y))) < 1.0) {
    P = uCam.xyz + r * (-uCam.y / r.y);
    w = 0.3;
  } else {
    P = uCam.xyz + r * ringFromInside(r, 1.0);
  }
  float dy = (P.y - ${F(LAMP_Y)}) * 1.8;
  w *= exp(-dy * dy);
  float az = atan(cross2(uLens.xy, P.xz), dot(uLens.xy, P.xz)) - uLens.z;
  float b = texture(uBands, vec2(az * ${F(1 / PI)}, 0.5)).r;
  col += LAMP * (b * w * uLens.w) * (room.rgb * 2.5 + room.a * 0.04 + glass * 0.02);
  // The glow round the lens while a beam faces the camera, and a faint veil over everything.
  vec2 g = (frag - uGlow.xy) / uGlow.z;
  col += LAMP * (uGlow.w * (exp(-dot(g, g)) + 0.12)) + room.rgb * (uGlow.w * 1.5);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The lens, inside a scissor round it, premultiplied over the frame: a stack
 * of glass rings on a beehive profile, found by casting the pixel's ray at
 * the surface of revolution (two fixed-point steps). The central belt holds
 * the bull's-eye panels, whose magnified image of the lamp swells as they turn
 * to face the camera; the prism rings above and below carry a refracted
 * highlight each, with soft rainbow edges and a few glints that turn with the
 * lens; behind it all, a dim, mirrored and stretched copy of the room and the
 * view. Brass bars between the panels slide past as the lens turns.
 */
const LENS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uView;
uniform vec2 uResolution;
/** Toward the camera from the lens (x, z), lens angle, lamp glow. */
uniform vec4 uLens;
/** How squarely each bull's-eye faces the camera, times the beam's strength. */
uniform vec2 uFace;
out vec4 outColor;
${CAMERA_GLSL}
${DITHER_GLSL}
const float PI = ${F(PI)};
const float TAU = ${F(2 * PI)};
const vec3 LAMP = ${v3(LAMP)};
const vec3 BRASS = ${v3(BRASS)};
const vec3 GLASS = vec3(0.62, 0.74, 0.72);
const float PANEL = ${F((2 * PI) / LENS_PANELS)};
const float Y0 = ${F(LENS_Y0)};
const float Y1 = ${F(LENS_Y1)};
const float LAMP_Y = ${F(LAMP_Y)};
const float DRUM = ${F(DRUM_HALF)};
const float BASE_Y = ${F(LENS_Y0 - BASE_H)};
const float TOP_Y = ${F(LENS_Y1 + CROWN_H)};

/** Mirrors lensProfile in lamproom-sim.ts: brass base ring, glass, brass crown. */
float profile(float y) {
  if (y < BASE_Y || y > TOP_Y) return 0.0;
  if (y < Y0) return ${F(LENS_R * BASE_RING)};
  if (y > Y1) {
    float u = (y - Y1) / ${F(CROWN_H)};
    return ${F(LENS_R * CROWN_FOOT)} * sqrt(max(1.0 - u * u, 0.0)) + 0.012 * (1.0 - u);
  }
  if (y >= LAMP_Y) {
    float u = (y - LAMP_Y) / (Y1 - LAMP_Y);
    return ${F(LENS_R)} * (1.0 - 0.5 * u * u);
  }
  float u = (LAMP_Y - y) / (LAMP_Y - Y0);
  return ${F(LENS_R)} * (1.0 - 0.3 * u * u);
}

float wrapPi(float a) { return a - TAU * floor(a / TAU + 0.5); }
float sq(float x) { return x * x; }
float hash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
vec3 spectrum(float t) { return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67))); }

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec3 r = viewRay(frag);
  vec3 C = uCam.xyz;
  float dl = length(r.xz);
  vec2 hd = r.xz / dl;
  float tc = -dot(C.xz, hd);
  vec2 cp = C.xz + hd * tc;
  float m = length(cp);
  // Two fixed-point steps onto the front of the surface of revolution.
  float rho = ${F(LENS_R)};
  float th = tc;
  float y = C.y;
  for (int i = 0; i < 2; i++) {
    th = tc - sqrt(max(rho * rho - m * m, 0.0));
    y = C.y + r.y * th / dl;
    rho = max(profile(y), 1e-3);
  }
  th = tc - sqrt(max(rho * rho - m * m, 0.0));
  y = C.y + r.y * th / dl;
  float depth = th / dl;
  float px = depth / uCam.w;
  float prof = profile(y);
  float cover = clamp((prof - m) / px + 0.5, 0.0, 1.0);
  cover *= clamp((y - BASE_Y) / px + 0.5, 0.0, 1.0);
  if (cover <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  vec2 P = C.xz + hd * th;
  // Where on the lens: azimuth from the camera's side, and within the turning lens.
  float az = atan(cross2(uLens.xy, P), dot(uLens.xy, P));
  float a = az - uLens.z;
  float mu = sqrt(max(1.0 - (m * m) / (rho * rho), 0.0));
  float side = cross2(uLens.xy, P) / rho;

  vec3 col;
  if (y < Y0 || y > Y1) {
    // Brass: lit from the lamp inside the glass, with a soft sheen across the curve.
    float sheen = pow(mu, 3.0);
    col = BRASS * (0.12 + 0.35 * sheen) + LAMP * 0.06 * sheen;
    if (y > Y1) {
      col *= 0.8 + 0.4 * smoothstep(Y1, TOP_Y, y);
    }
  } else {
    // Behind the glass: the room and the view, mirrored and squeezed toward the axis, dim.
    vec2 uv = frag / uResolution;
    vec2 buv = uv + vec2(-side * 1.6 * ${F(LENS_R)} * uCam.w / depth / uResolution.x, 0.0);
    vec4 room = texture(uRoom, buv);
    vec3 back = room.rgb + texture(uView, buv).rgb * (1.0 - room.a);
    col = back * GLASS * (0.45 + 0.25 * mu);
    // The lamp, smeared sideways by the prisms into a glowing belt at its height.
    float dy = y - LAMP_Y;
    float lampGlow = uLens.w * (0.32 * exp(-dy * dy * 900.0) * (0.4 + 0.6 * mu) + 0.06 * exp(-dy * dy * 40.0));
    col += LAMP * lampGlow;
    float pa = wrapPi(a + PANEL * 0.5);
    float j = floor(pa / PANEL + 3.0);
    float local = (pa - (j - 3.0) * PANEL) - PANEL * 0.5;
    if (abs(dy) < DRUM) {
      // The central belt. Panels 0 and 3 hold bull's-eyes; the rest refract a plain band.
      bool bull = j == 3.0 || j == 0.0;
      if (bull) {
        float f = j == 3.0 ? uFace.x : uFace.y;
        // How far this panel is from facing the camera: the lamp's image slides across it.
        float off = wrapPi(az - a + (j == 3.0 ? 0.0 : PI));
        vec2 q = vec2(local * rho, dy);
        vec2 spot = vec2(-off * 0.12, 0.0);
        float rr = length(q);
        float rings = fract(rr / 0.017);
        float edge = smoothstep(0.75, 1.0, rings);
        float sz = 0.025 + 0.05 * f;
        vec2 sq = (q - spot) / sz;
        float bloom = exp(-dot(sq, sq));
        float lit = f * (0.55 * bloom + 0.25 * exp(-rr * rr * 60.0)) + 0.05 * exp(-rr * rr * 200.0);
        col += LAMP * lit * (1.0 - 0.25 * edge) + spectrum(rr * 9.0) * edge * (0.05 + 0.25 * f) * mu;
        col *= 1.0 - 0.15 * edge;
      } else {
        float t = fract(dy / 0.022 + 0.5);
        col += spectrum(t + az * 0.3) * 0.03 * mu;
      }
    } else {
      // Prism rings above and below the belt.
      float up = dy > 0.0 ? 1.0 : -1.0;
      float k = (abs(dy) - DRUM) / (up > 0.0 ? 0.034 : 0.042);
      float ring = floor(k);
      float t = fract(k);
      // Each ring catches the lamp in a highlight across it, nearer the inner edge further out.
      float t0 = 0.35 + 0.25 * sin(ring * 1.7 + up);
      float hl = exp(-sq((t - t0) / 0.16));
      float glint = 0.0;
      for (int g = 0; g < 3; g++) {
        float ga = hash(ring * 7.0 + float(g) * 3.1 + up * 13.0) * TAU;
        float x = wrapPi(a - ga) / 0.07;
        glint += exp(-x * x);
      }
      float fall = 1.0 - 0.06 * ring;
      col += LAMP * hl * (0.07 + 0.14 * mu + 0.35 * glint * mu) * uLens.w * fall;
      // Rainbow fringes on the highlight's edges.
      float fringe = exp(-sq((t - t0 - 0.2) / 0.08)) + exp(-sq((t - t0 + 0.2) / 0.08));
      col += spectrum(t * 1.6 + ring * 0.13) * fringe * 0.035 * mu * uLens.w;
      // The dark joint between rings.
      col *= 1.0 - 0.5 * smoothstep(0.85, 1.0, t);
    }
    // Brass: the rings that hold the belt, and the bars between the panels, sliding past as it turns.
    float bandW = 0.009;
    float hb = min(abs(abs(dy) - DRUM), min(y - Y0, Y1 - y));
    float bar = min(abs(abs(local) - PANEL * 0.5) * rho, 1.0);
    float frame = max(clamp((bandW - hb) / px + 0.5, 0.0, 1.0), clamp((0.007 - bar) / (px / max(mu, 0.1)) + 0.5, 0.0, 1.0));
    vec3 brass = BRASS * (0.1 + 0.3 * pow(mu, 2.0)) + LAMP * 0.08 * exp(-dy * dy * 30.0) * mu;
    col = mix(col, brass, frame);
  }
  outColor = vec4((col + dither8(frag)) * cover, cover);
}
`;

/**
 * Lighthouse Lamp Room. Per frame:
 * 1. the room, cached at full size per resize or change of side;
 * 2. the view at low resolution: the Calm Sea's water below the horizon, the
 *    moonlit sky with clouds and the coastline above, then the beams' haze and
 *    any storm murk over both;
 * 3. in a storm, the rain's drop map (Rain on a Window's simulation and drop shaders);
 * 4. one full-size pass for the room, the view through the glass and the light
 *    the lens throws round the room;
 * 5. the lens, inside a scissor round it.
 */
export const lamproom = defineEffect(lamproomMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const water = scope.own(createSeaWater(gl, triangle, 128));

      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uCam", "uCentre"]);
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const su = createUniforms(gl, skyProgram, [
        "uNoise",
        "uLand",
        "uLowToFull",
        "uView",
        "uMoon",
        "uCloud",
        "uLandColor",
        "uAspectInv",
        "uZenith",
        "uHorizon",
        "uGlow",
        "uSkyA",
      ]);
      const beamProgram = program(FULLSCREEN_VERTEX, BEAM_FRAGMENT);
      const bu = createUniforms(gl, beamProgram, [
        "uLowToFull",
        "uCam",
        "uCentre",
        "uBeam",
        "uBeamColor",
        "uMurk",
        "uFade",
      ]);
      const compProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compProgram, [
        "uRoom",
        "uView",
        "uDrops",
        "uBands",
        "uResolution",
        "uLens",
        "uGlow",
        "uRain",
        "uCam",
        "uCentre",
      ]);
      const lensProgram = program(FULLSCREEN_VERTEX, LENS_FRAGMENT);
      const lu = createUniforms(gl, lensProgram, [
        "uRoom",
        "uView",
        "uResolution",
        "uLens",
        "uFace",
        "uCam",
        "uCentre",
      ]);
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

      const noiseData = buildPeriodicNoiseTexture(CLOUD_NOISE, [
        { period: 4, seed: 71 },
        { period: 8, seed: 73 },
      ]);
      const noise = scope.add(
        createDataTexture(gl, {
          width: CLOUD_NOISE,
          height: CLOUD_NOISE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: noiseData,
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const bands = scope.add(
        createDataTexture(gl, {
          width: BAND_SIZE,
          height: 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildBandTable(BAND_SIZE),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      gl.useProgram(skyProgram);
      su.i1("uNoise", 0);
      su.i1("uLand", 1);
      gl.useProgram(compProgram);
      cu.i1("uRoom", 0);
      cu.i1("uView", 1);
      cu.i1("uDrops", 2);
      cu.i1("uBands", 3);
      gl.useProgram(lensProgram);
      lu.i1("uRoom", 0);
      lu.i1("uView", 1);
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
          throw new Error("Lighthouse Lamp Room: render target is not renderable");
        }
        return t;
      };

      const sim = createRainSim(1920, 1080, createRng(0x6c616d70));
      const rainParams: RainSimParams = { rain: 0, speed: 1 };
      const sky = createSkyState();
      const moonPreset = SEA_PRESETS.moonlight;
      const wf = createSeaWaterFrame(sky);
      const look = createWeatherLook();
      const beamData = new Float32Array(BEAMS * 3);
      const toCam = { x: 0, z: 0 };
      const cuv = { u: 0, v: 0 };
      const roomKey = createChangeKey(3);

      let width = 1;
      let height = 1;
      let scale = 1;
      let angle = 0.9;
      let beamGain = Number.NaN;
      let primed = false;
      let cloudU = 0;
      let cloudV = 0;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          disposeTargets();
          room = makeTarget(width, height);
          const d = Math.max(1, VIEW_TEXEL_REF * scale);
          view = makeTarget(lowResSize(width, d), lowResSize(height, d));
          dropMap = makeTarget(lowResSize(width, scale), lowResSize(height, scale));
          resizeRainSim(sim, width / scale, 1080);
          roomKey.set(0, -1);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          if (!room || !view || !dropMap) {
            return;
          }
          const side: LensSide = p.lens === "right" ? "right" : "left";
          const aspect = width / height;
          const camX = cameraX(side, aspect);
          const focalPx = FOCAL * height;
          const cx = width / 2;
          const cy = HORIZON_Y * height;
          towardCamera(side, aspect, toCam);

          // Motion: the lens, the weather, the clouds and the beam's strength.
          angle = advanceLens(angle, step, p.period);
          easeWeather(look, p.weather, step, !primed);
          primed = true;
          const target = Math.min(1, Math.max(0, Number.isFinite(p.beam) ? p.beam : 0));
          beamGain = Number.isNaN(beamGain) ? target : approach(beamGain, target, step / BEAM_EASE);
          cloudU = wrap(cloudU + step * CLOUD_DRIFT, 0, 1);
          cloudV = wrap(cloudV + step * CLOUD_DRIFT * 0.3, 0, 1);
          water.advance(step, look.wind);

          // 1. The room cache.
          roomKey.set(0, width);
          roomKey.set(1, height);
          roomKey.set(2, side === "left" ? 0 : 1);
          if (roomKey.take()) {
            room.bind();
            gl.useProgram(roomProgram);
            ru.f4("uCam", camX, CAM_Y, CAM_Z, focalPx);
            ru.f2("uCentre", cx, cy);
            triangle.draw();
          }

          // 2. The view outside.
          const lowToFullX = width / view.width;
          const lowToFullY = height / view.height;
          // Low-res rows whose centres lie below eye level hold the water; the rest the sky.
          const waterRows = Math.min(view.height, Math.max(0, Math.ceil(cy / lowToFullY - 0.5)));
          // Sky colours: the Calm Sea's moonlight, darkened by the storm.
          presetSky(moonPreset, sky);
          for (let c = 0; c < 3; c++) {
            sky.zenith[c] += (STORM_ZENITH[c] - sky.zenith[c]) * look.storm;
            sky.horizon[c] += (STORM_HORIZON[c] - sky.horizon[c]) * look.storm;
          }
          landColor(sky, wf.landColor);
          const lightX = (moonX(side) - 0.5) * aspect;
          const lightY = MOON_Y;
          // How much of the moon shows through the clouds in front of it.
          cloudUv(lightX / FOCAL, lightY / FOCAL, cuv);
          const n0 = sampleTiled(noiseData, CLOUD_NOISE, 2, 0, cuv.u + cloudU, cuv.v + cloudV);
          const n1 = sampleTiled(noiseData, CLOUD_NOISE, 2, 1, cuv.u + cloudU, cuv.v + cloudV);
          const moonVis = 1 - 0.94 * cloudDensity(n0, n1, look.cover);
          sky.glowStrength *= 0.3 + 0.7 * moonVis * (1 - look.storm);
          const glitter = moonPreset.intensity * 0.55 * moonVis * (1 - 0.8 * look.storm);
          for (let c = 0; c < 3; c++) {
            wf.lightColor[c] = moonPreset.lightColor[c] * glitter;
          }
          const skyK = height / Math.max(1, height - cy);

          view.bind();
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, waterRows, view.width, view.height - waterRows);
          gl.useProgram(skyProgram);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, water.landTexture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noise);
          su.f2("uLowToFull", lowToFullX, lowToFullY);
          su.f4("uView", cx, cy, 1 / height, FOCAL);
          su.f4("uMoon", MOON_R, moonVis * (1 - 0.7 * look.storm), look.cover, look.storm);
          su.f4("uCloud", cloudU, cloudV, 1, side === "left" ? 1 : 0);
          su.v3("uLandColor", wf.landColor);
          su.f1("uAspectInv", height / width);
          su.v3("uZenith", sky.zenith);
          su.v3("uHorizon", sky.horizon);
          su.v3("uGlow", sky.glow);
          su.f4("uSkyA", lightX, lightY, sky.glowStrength, skyK);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);

          wf.lowToFullX = lowToFullX;
          wf.lowToFullY = lowToFullY;
          wf.centreX = cx;
          wf.horizonPx = cy;
          wf.focalPx = focalPx;
          wf.focal = FOCAL;
          wf.cameraHeight = SEA_HEIGHT_M;
          wf.aspectInv = height / width;
          wf.swell = look.swell;
          wf.wind = look.wind;
          wf.lightX = lightX;
          wf.lightY = lightY;
          wf.roughness = moonPreset.roughness * (1 + look.storm * 2);
          wf.fresnelMax = 0.8;
          wf.deep = moonPreset.deep;
          wf.skyK = skyK;
          wf.land = true;
          // The coast and the moon lie across from the lens, where the lens doesn't hide them.
          wf.mirror = side === "left";
          gl.viewport(0, 0, view.width, waterRows);
          water.draw(wf);

          // The beams' haze and the storm's murk.
          for (let k = 0; k < BEAMS; k++) {
            const a = angle + (k * 2 * Math.PI) / BEAMS;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            // Rotate the toward-camera direction by the beam's angle.
            beamData[k * 3] = toCam.x * ca - toCam.z * sa;
            beamData[k * 3 + 1] = toCam.x * sa + toCam.z * ca;
            // Head-on, the beam is the glow round the lens instead; hold its haze back.
            beamData[k * 3 + 2] = BEAM_HAZE * (0.25 + beamGain) * (1 - 0.85 * facing(a));
          }
          gl.viewport(0, 0, view.width, view.height);
          gl.useProgram(beamProgram);
          bu.f2("uLowToFull", lowToFullX, lowToFullY);
          bu.f4("uCam", camX, CAM_Y, CAM_Z, focalPx);
          bu.f2("uCentre", cx, cy);
          gl.uniform3fv(bu.loc.uBeam, beamData);
          bu.v3("uBeamColor", BEAM_RGB);
          bu.f4("uMurk", 0.05, 0.055, 0.06, 0.3 * look.storm);
          bu.f1("uFade", BEAM_FADE * (1 - 0.6 * look.storm));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();
          gl.disable(gl.BLEND);

          // 3. Rain on the glass.
          rainParams.rain = look.rain;
          stepRainSim(sim, step, rainParams);
          const count = writeDropInstances(sim, drops.data, scale);
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

          // 4. The room, the view through the glass and the lens's light round the room.
          const face0 = facing(angle) * beamGain;
          const face1 = facing(angle + Math.PI) * beamGain;
          const glow = beamLevel(angle, beamGain);
          const box = lensBox(side, aspect);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, bands);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, dropMap.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, view.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, room.texture);
          gl.useProgram(compProgram);
          cu.f2("uResolution", width, height);
          cu.f4("uCam", camX, CAM_Y, CAM_Z, focalPx);
          cu.f2("uCentre", cx, cy);
          cu.f4("uLens", toCam.x, toCam.z, angle, 0.25 * (BAND_BASE + BAND_BEAM * beamGain));
          cu.f4("uGlow", box.lampX * height, box.lampY * height, 0.45 * height, glow);
          const k = OFFSET_RANGE * REFRACTION * scale;
          cu.f3("uRain", count > 0 ? 1 : 0, k / width, k / height);
          triangle.draw();

          // 5. The lens.
          gl.enable(gl.SCISSOR_TEST);
          const sx = Math.max(0, Math.floor(box.x0 * height));
          const sy = Math.max(0, Math.floor(box.y0 * height));
          const ex = Math.min(width, Math.ceil(box.x1 * height));
          const ey = Math.min(height, Math.ceil(box.y1 * height));
          gl.scissor(sx, sy, Math.max(0, ex - sx), Math.max(0, ey - sy));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(lensProgram);
          lu.f2("uResolution", width, height);
          lu.f4("uCam", camX, CAM_Y, CAM_Z, focalPx);
          lu.f2("uCentre", cx, cy);
          lu.f4("uLens", toCam.x, toCam.z, angle, 1);
          lu.f2("uFace", face0, face1);
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
