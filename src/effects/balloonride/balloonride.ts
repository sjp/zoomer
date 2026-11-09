import { BALLOON_FLOATS, BALLOON_STRIP, paletteFor } from "../balloons/balloons-sim";
import { BALLOON_FRAGMENT, BALLOON_LAYOUT, BALLOON_VERTEX } from "../balloons/balloon-sprite";
import type { Rgb } from "../color";
import {
  buildRamp,
  fireNoiseChannels,
  NOISE_SIZE,
  PALETTES,
  RAMP_SIZE,
} from "../fireplace/fireplace-model";
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
  withScope,
  scopedProgram,
} from "../gl";
import { lowResSize } from "../lowres";
import { clamp, wrap } from "../math";
import { buildPeriodicNoiseTexture, VALUE_NOISE_GLSL, VALUE_FBM_GLSL } from "../noise";
import { createSpriteBatch } from "../sprites";
import { advanceSwell, createSwell, swayAt } from "../sway";
import { defineEffect } from "../types";
import { balloonrideMeta, MAX_OTHERS } from "./balloonride.meta";
import {
  buildLandscape,
  burnerGlow,
  CAMERA_HEIGHT,
  createBurner,
  createLightEase,
  createOthers,
  flickerAt,
  FOCAL,
  GORES,
  HAZE_METRES,
  HEIGHT_METRES,
  HORIZON,
  MAP_SIZE,
  MAX_SCHEME_COLOURS,
  type Others,
  primeBurner,
  RIVER_AMPLITUDES,
  riverPhases,
  schemeFor,
  stepBurner,
  stepOthers,
  sunDirection,
  sunOnScreen,
  TILE_METRES,
  timeFor,
  WIND_SPEED,
  windAngle,
  writeOthers,
  YAW_SWELL,
  yawAt,
} from "./balloonride-sim";

const f = glslFloat;
const TAU = Math.PI * 2;

/**
 * The last few landscape maps built, by seed, most recent last: each takes a
 * good fraction of a second to build, and stepping back and forth between
 * variations (or opening the scene again) needn't build them again.
 */
const landscapes = new Map<number, Uint8Array>();
const KEEP_LANDSCAPES = 3;

function landscapeFor(seed: number): Uint8Array {
  let map = landscapes.get(seed);
  if (map) {
    landscapes.delete(seed);
  } else {
    map = buildLandscape(seed);
    for (const oldest of landscapes.keys()) {
      if (landscapes.size < KEEP_LANDSCAPES) {
        break;
      }
      landscapes.delete(oldest);
    }
  }
  landscapes.set(seed, map);
  return map;
}

/** The landscape is soft and hazy, so it renders every frame at 1/3 size. */
const OUTSIDE_DIVISOR = 3;
/** The longest shadow, metres, so a low sun's shadows stay sampled. */
const MAX_SHADOW = 110;
/** How fast the valley mist creeps, noise texture widths per second. */
const MIST_DRIFT = 0.0012;
/** Noise texture widths of the flame's two octaves per second as it rises. */
const FLAME_RISE = 0.11;
const FLAME_RISE_2 = 0.19;
/** Seconds after which the flame's shader time wraps. */
const SHADER_PERIOD = 3600;
/** The burner's warm light, and how strongly a full burn lights the envelope. */
const FLAME_LIGHT: Rgb = [1, 0.62, 0.3];
const GLOW_GAIN = 0.6;
/** The flame's peak opacity, so it stays soft. */
const FLAME_PEAK = 0.85;
/** The ropes' sway: a slow swell, and its largest reach (frame heights). */
const ROPE_SWELL = createSwell(40, [
  { cycles: 3, amplitude: 1, offset: 0 },
  { cycles: 5, amplitude: 0.5, offset: 0.4 },
  { cycles: 8, amplitude: 0.2, offset: 0.75 },
]);
const ROPE_SWAY = 0.0022;

/* ----- Layout, frame heights from the frame's centre ----- */

/** The padded rim along the basket's far side: its top and bottom. */
const RIM_TOP = -0.325;
const RIM_BOTTOM = -0.383;
/** The uprights: base and top centres (right-hand one; the left mirrors it) and half width. */
const POLE_BASE: readonly [number, number] = [0.7, -0.36];
const POLE_TOP: readonly [number, number] = [0.41, 0.356];
const POLE_HW = 0.0165;
/** The burner frame's bar: height, half thickness and half length. */
const FRAME_Y = 0.356;
const FRAME_HH = 0.0085;
const FRAME_HX = 0.43;
/** The burner coil: lowest ring's centre height, ring spacing, ring radii and tube radius. */
const COIL_Y = 0.377;
const COIL_STEP = 0.0165;
const COIL_RINGS = 4;
const COIL_RX = 0.1;
const COIL_RY = 0.015;
const COIL_TUBE = 0.0062;
/** Where the flame leaves the burner, and its height. */
const JET_Y = 0.441;
const FLAME_H = 0.12;
/** The envelope's skirt: its hem's height straight ahead, and the skirt's curve. */
const ENV_Y = 0.29;
const ENV_F = 1.0;
/** The coil of rope lying on the rim (right-hand side). */
const COIL_ROPE: readonly [number, number] = [0.47, -0.318];
/** The ropes, right-hand side: from near the upright's base up out of the frame. */
const ROPES: readonly (readonly [number, number, number, number])[] = [
  [0.712, -0.33, 0.99, 0.62],
  [0.704, -0.33, 0.83, 0.62],
];
const ROPE_HW = 0.0034;

/**
 * The basket, uprights, burner and envelope, drawn once per resize, scheme or
 * variation in neutral light. Mode 0 writes the colour (premultiplied, alpha
 * covering what's behind); mode 1 writes what the burner's light adds at a
 * full burn (premultiplied by the same coverage) and, in alpha, how much of
 * the pixel is the envelope's fabric, lit through from behind.
 */
const FOREGROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uSeed;
uniform int uMode;
uniform vec3 uGores[${String(MAX_SCHEME_COLOURS)}];
/** Colours in the scheme, and 1 for patchwork. */
uniform vec2 uScheme;

out vec4 outColor;
${VALUE_NOISE_GLSL}
${VALUE_FBM_GLSL}

const float PI = 3.14159265;
const float TAU = 6.2831853;

float px;
vec4 acc;
vec4 emi;

/** Lays an opaque-ish layer over everything so far; it adds no burner light. */
void over(vec3 col, float cov) {
  acc = vec4(col, 1.0) * cov + acc * (1.0 - cov);
  emi *= 1.0 - cov;
}

/** Lays a layer over everything so far, with the burner light it catches and its fabric share. */
void overLit(vec3 col, float cov, vec3 glow, float fabric) {
  acc = vec4(col, 1.0) * cov + acc * (1.0 - cov);
  emi = vec4(glow, fabric) * cov + emi * (1.0 - cov);
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

/** Approximate signed distance to an ellipse (centre c, radii r). */
float sdEllipse(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  float k = length(q);
  vec2 g = q / (r * max(k, 1e-5));
  return (k - 1.0) / max(length(g), 1e-5);
}

/** Polished steel with surface normal n: the sky above, the dark land below, a sharp highlight. */
vec3 steel(vec3 n) {
  vec3 env = mix(vec3(0.16, 0.17, 0.17), vec3(0.92, 0.94, 0.96), smoothstep(-0.25, 0.55, n.y));
  float spec = pow(max(0.0, dot(n, normalize(vec3(-0.35, 0.6, 0.7)))), 24.0);
  return env * 0.8 + spec * 0.6;
}

/** Suede: a soft nap, with colour col. */
vec3 suede(vec3 col, vec2 p, float s) {
  return col * (0.86 + 0.14 * vnoise(p * 420.0, uSeed + s) + 0.06 * vnoise(p * 60.0, uSeed + s + 1.0));
}

/** One gore panel's colour. */
vec3 goreColour(float gi, float ring) {
  float n = uScheme.x;
  float k = uScheme.y > 0.5 ? floor(hash2(vec2(gi, ring), uSeed + 9.0) * n) : mod(gi, n);
  return uGores[int(clamp(k, 0.0, n - 1.0))];
}

/** A burner coil ring: its near (upper) or far (lower) half. */
void ring(vec2 p, float y, bool near) {
  vec2 c = vec2(0.0, y);
  float de = sdEllipse(p, c, vec2(${f(COIL_RX)}, ${f(COIL_RY)}));
  float d = abs(de) - ${f(COIL_TUBE)};
  float side = p.y - y;
  if (d < px && (!near || side > -0.002)) {
    float s = clamp(de / ${f(COIL_TUBE)}, -1.0, 1.0);
    vec2 q = (p - c) / vec2(${f(COIL_RX * COIL_RX)}, ${f(COIL_RY * COIL_RY)});
    vec2 rn = normalize(q + 1e-6);
    vec3 n = normalize(vec3(rn * s, sqrt(max(0.0, 1.0 - s * s))));
    vec3 col = steel(n) * (near ? 1.0 : 0.6);
    // Blue-gold heat tint on the coil.
    col *= mix(vec3(1.0), vec3(0.85, 0.78, 0.9), 0.4 * vnoise(p * vec2(60.0, 200.0), uSeed + 31.0));
    // The flame lights the coil's upper faces warmly.
    vec3 glow = col * (0.5 + 0.5 * max(n.y, 0.0)) * 0.7;
    // Far halves are drawn whole; the near halves then cover their tops.
    overLit(col, cover(d) * (near ? smoothstep(-0.002, 0.002, side) : 1.0), glow, 0.0);
  }
}

void main() {
  px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  float ax = abs(p.x);
  float sx = p.x < 0.0 ? -1.0 : 1.0;
  acc = vec4(0.0);
  emi = vec4(0.0);

  // The envelope's skirt overhead, seen from inside: broad gores lit through
  // from behind, converging upwards, with load tapes and seams, and a band
  // of heat-proof fabric along the hem.
  {
    float phi = atan(p.x, ${f(ENV_F)});
    float cphi = cos(phi);
    float v = p.y * cphi - ${f(ENV_Y)};
    float g = phi * (1.0 + 1.1 * max(v, 0.0)) * ${f(GORES / TAU)};
    float gi = floor(g);
    float gf = g - gi;
    float gw = max(fwidth(g), 1e-4);
    float ringV = v / 0.075;
    float rw = max(fwidth(ringV), 1e-4);
    float d = ${f(ENV_Y)} / cphi - p.y;
    if (d < px) {
      vec3 gore = goreColour(gi, floor(ringV));
      float tape = 1.0 - smoothstep(0.025, 0.025 + gw, min(gf, 1.0 - gf));
      float rf = fract(ringV);
      float seam = 1.0 - smoothstep(0.03, 0.03 + rw, min(rf, 1.0 - rf));
      float bulge = 0.84 + 0.16 * sin(PI * gf);
      vec3 col = gore * bulge * (1.0 - 0.45 * tape) * (1.0 - 0.18 * seam);
      // Thinner light near the hem, where the skirt hangs in its own shade.
      col *= 0.72 + 0.32 * smoothstep(0.0, 0.2, v);
      col *= 0.95 + 0.08 * vnoise(p * vec2(30.0, 90.0), uSeed + 21.0);
      // The burner lights the fabric most just above the flame.
      float mask = 0.35 + 1.0 * exp(-(p.x * p.x * 2.2 + pow(max(0.0, 0.62 - p.y), 2.0) * 5.0));
      vec3 glow = gore * mask * (1.0 - 0.4 * tape);
      // The heat-proof band along the hem, and the hem's binding.
      float band = smoothstep(0.034, 0.034 - px, v);
      vec3 nomex = vec3(0.3, 0.27, 0.23) * (0.85 + 0.15 * sin(PI * gf)) * (1.0 - 0.3 * tape);
      nomex *= 1.0 - 0.45 * smoothstep(0.008, 0.0, v);
      col = mix(col, nomex, band);
      glow = mix(glow, nomex * mask * 0.5, band);
      overLit(col, cover(d), glow, 1.0);
    }
  }

  // The uprights, wrapped in suede, with straps near each end.
  {
    vec2 a = vec2(${f(POLE_BASE[0])}, ${f(POLE_BASE[1])});
    vec2 b = vec2(${f(POLE_TOP[0])}, ${f(POLE_TOP[1])});
    vec2 q = vec2(ax, p.y);
    vec2 ab = b - a;
    float h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
    vec2 dir = normalize(ab);
    float across = dot(q - a, vec2(dir.y, -dir.x)) / ${f(POLE_HW)};
    float d = length(q - a - ab * h) - ${f(POLE_HW)};
    if (d < px) {
      float s = clamp(across, -1.0, 1.0);
      float shade = 0.5 + 0.42 * sqrt(1.0 - s * s) + 0.12 * s * sx;
      vec3 col = suede(vec3(0.5, 0.37, 0.26), p, 41.0) * shade;
      // A stitched seam down the inside.
      float st = step(0.5, fract(h * 140.0)) * smoothstep(0.12, 0.0, abs(s - 0.55 * sx));
      col *= 1.0 - 0.3 * st;
      // Leather straps with steel buckles.
      float strap = max(smoothstep(0.012, 0.0, abs(h - 0.1)), smoothstep(0.012, 0.0, abs(h - 0.86)));
      col = mix(col, vec3(0.2, 0.13, 0.08) * shade, strap);
      float buckle = smoothstep(0.004, 0.0, abs(h - 0.1)) + smoothstep(0.004, 0.0, abs(h - 0.86));
      col = mix(col, steel(vec3(s, 0.3, 0.8)) * 0.8, buckle * step(abs(s), 0.4));
      // The burner lights their tops a little.
      overLit(col, cover(d), col * smoothstep(0.6, 1.0, h) * 0.5, 0.0);
    }
  }

  // The burner frame's bar, with brackets up to the coil.
  {
    float d = sdBox(p, vec2(0.0, ${f(FRAME_Y)}), vec2(${f(FRAME_HX)}, ${f(FRAME_HH)}), 0.003);
    for (int i = 0; i < 2; i++) {
      float s = i == 0 ? -1.0 : 1.0;
      d = min(d, sdBox(p, vec2(0.07 * s, ${f((FRAME_Y + COIL_Y) / 2)}), vec2(0.005, ${f((COIL_Y - FRAME_Y) / 2)}), 0.002));
    }
    if (d < px) {
      float t = clamp((p.y - ${f(FRAME_Y)}) / ${f(FRAME_HH)}, -1.0, 1.0);
      vec3 col = steel(normalize(vec3(0.0, t, 0.8))) * 0.85;
      overLit(col, cover(d), col * 0.4, 0.0);
    }
  }

  // The burner coil, far halves behind near ones, and the jet block on top.
  for (int i = 0; i < ${String(COIL_RINGS)}; i++) {
    ring(p, ${f(COIL_Y)} + float(i) * ${f(COIL_STEP)}, false);
  }
  for (int i = 0; i < ${String(COIL_RINGS)}; i++) {
    ring(p, ${f(COIL_Y)} + float(i) * ${f(COIL_STEP)}, true);
  }
  {
    float d = sdBox(p, vec2(0.0, ${f(JET_Y - 0.006)}), vec2(0.034, 0.007), 0.003);
    if (d < px) {
      float t = clamp((p.y - ${f(JET_Y - 0.006)}) / 0.007, -1.0, 1.0);
      vec3 col = steel(normalize(vec3(p.x * 10.0, t, 0.7))) * 0.55;
      overLit(col, cover(d), col * 0.8, 0.0);
    }
  }

  // The padded suede rim along the basket's far side.
  float rimC = ${f((RIM_TOP + RIM_BOTTOM) / 2)};
  float rimH = ${f((RIM_TOP - RIM_BOTTOM) / 2)} + 0.0015 * sin(p.x * 23.0 + uSeed);
  {
    // The wicker below it: weavers passing over and under upright stakes,
    // darker deeper into the basket.
    float d = p.y - rimC;
    if (d < px) {
      float row = (${f(RIM_BOTTOM)} - p.y) / 0.0135;
      float ri = floor(row);
      float rf = row - ri;
      float u = p.x / 0.032 + 0.5 * mod(ri, 2.0);
      float ui = floor(u + 0.5);
      float uf = u - ui;
      bool stakeFront = mod(ui + ri, 2.0) > 0.5;
      float weaver = sin(PI * rf);
      vec3 cane = vec3(0.6, 0.45, 0.27) * (0.88 + 0.24 * hash2(vec2(ri, floor(u)), uSeed + 51.0));
      vec3 col = cane * (0.35 + 0.65 * weaver) * smoothstep(0.0, 0.12, min(rf, 1.0 - rf));
      float stake = smoothstep(0.2, 0.12, abs(uf));
      if (stakeFront) {
        float sv = clamp(uf / 0.16, -1.0, 1.0);
        col = mix(col, cane * 0.9 * (0.55 + 0.45 * sqrt(1.0 - sv * sv)), stake);
      } else {
        col *= 1.0 - 0.35 * stake * (1.0 - weaver);
      }
      col *= mix(0.42, 0.85, smoothstep(-0.5, ${f(RIM_BOTTOM)}, p.y));
      // The rim's shadow just below it.
      col *= 1.0 - 0.5 * smoothstep(0.03, 0.0, rimC - rimH - p.y);
      over(col, cover(d));
    }
  }
  {
    float d = abs(p.y - rimC) - rimH;
    if (d < px) {
      float s = clamp((p.y - rimC) / rimH, -1.0, 1.0);
      float nz = sqrt(1.0 - s * s);
      float shade = 0.42 + 0.38 * nz + 0.3 * max(s, 0.0);
      vec3 col = suede(vec3(0.38, 0.25, 0.16), p, 61.0) * shade;
      // Two rows of stitching, and seams across between the padded panels.
      float st = step(0.5, fract(p.x * 160.0)) * smoothstep(0.1, 0.0, abs(abs(s) - 0.62));
      col *= 1.0 - 0.35 * st;
      float panel = abs(fract(p.x / 0.41 + 0.5 + uSeed * 0.013) - 0.5) * 0.41;
      col *= 1.0 - 0.45 * smoothstep(0.0025, 0.0, panel);
      over(col, cover(d));
    }
  }

  // A coil of rope lying on the rim, its end hanging over the side.
  {
    vec2 c0 = vec2(${f(COIL_ROPE[0])}, ${f(COIL_ROPE[1])});
    float tail = sdSeg(p, vec2(0.535, -0.33), vec2(0.556, -0.47)) - 0.0055;
    if (tail < px) {
      vec3 col = vec3(0.8, 0.78, 0.7) * (0.75 + 0.25 * step(0.5, fract(p.y * 180.0)));
      over(col * 0.75, cover(tail));
    }
    for (int k = 0; k < 4; k++) {
      vec2 c = c0 + vec2(0.004 * float(k), 0.0055 * float(k));
      vec2 r = vec2(0.064 - 0.003 * float(k), 0.013);
      float de = sdEllipse(p, c, r);
      float d = abs(de) - 0.0055;
      if (d < px) {
        float s = clamp(de / 0.0055, -1.0, 1.0);
        float ang = atan((p.y - c.y) / r.y, (p.x - c.x) / r.x);
        float twist = step(0.5, fract(ang * 9.0 + s * 0.8));
        vec3 col = vec3(0.82, 0.8, 0.72) * (0.55 + 0.45 * sqrt(1.0 - s * s)) * (0.85 + 0.15 * twist);
        // The near (lower) side of each loop is lit, the far side in shade.
        col *= mix(0.65, 1.0, smoothstep(0.004, -0.004, p.y - c.y));
        over(col, cover(d));
      }
    }
  }

  outColor = uMode == 0 ? acc : emi;
}
`;

/**
 * The view out, every frame at reduced size: the sky with its sun and glow
 * above the horizon, and below it the landscape map laid on the ground far
 * below, turned with the balloon, with long shadows towards the sun, mist
 * along the river's valley, and haze into the distance.
 */
const OUTSIDE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uMap;
uniform sampler2D uNoise;
/** Frame heights per pixel, aspect, and the turn's cos and sin. */
uniform vec4 uFrame;
/** The map's offset (uv), and the mist's. */
uniform vec4 uView;
/** The sun on screen (x, y), its glow strength, and the mist's thickness. */
uniform vec4 uSun;
/** The shadows' reach, map uv per unit of map height. */
uniform vec2 uShadow;
/** The river's meander: centre and three phases. */
uniform vec4 uRiver;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uDisc;
uniform vec3 uSunlight;
uniform vec3 uAmbient;
uniform vec3 uMist;

out vec4 outColor;

const float TAU = 6.2831853;
const float FOCAL = ${f(FOCAL)};
const float HORIZON = ${f(HORIZON)};
const float HEIGHT = ${f(CAMERA_HEIGHT)};
const float TILE = ${f(TILE_METRES)};
const float HAZE = ${f(HAZE_METRES)};

vec3 sky(vec2 p, float y) {
  float t = clamp(y / 0.55, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, t * (2.0 - t));
  float d = length(p - uSun.xy);
  float glow = uSun.z * (0.5 * exp(-d * 9.0) + 0.5 * exp(-d * 2.2) * (1.0 - 0.6 * t));
  col = mix(col, uGlow, min(glow, 1.0));
  return mix(col, uDisc, 0.9 * smoothstep(0.024, 0.02, d));
}

vec3 ground(vec2 p, float b) {
  float z = FOCAL * HEIGHT / b;
  float xv = p.x * HEIGHT / b;
  vec2 w = vec2(uFrame.z * xv + uFrame.w * z, -uFrame.w * xv + uFrame.z * z);
  vec2 uv = w / TILE + uView.xy;
  vec4 m = texture(uMap, uv);
  // Long shadows: anything tall enough between here and the sun.
  float h1 = texture(uMap, uv + uShadow * 0.3).a;
  float h2 = texture(uMap, uv + uShadow * 0.6).a;
  float h3 = texture(uMap, uv + uShadow).a;
  float shadow = max(smoothstep(0.3, 0.42, h1 - m.a), max(smoothstep(0.6, 0.72, h2 - m.a), smoothstep(0.9, 1.0, h3 - m.a)));
  // Tall things' own tops catch the light.
  vec3 col = m.rgb * (uAmbient + uSunlight * (1.0 - 0.8 * shadow) * (0.9 + 0.25 * m.a));
  // Mist lying along the river's valley, and in hollows here and there.
  float rc = uRiver.x + ${f(RIVER_AMPLITUDES[0])} * sin(TAU * uv.y + uRiver.y)
    + ${f(RIVER_AMPLITUDES[1])} * sin(2.0 * TAU * uv.y + uRiver.z)
    + ${f(RIVER_AMPLITUDES[2])} * sin(3.0 * TAU * uv.y + uRiver.w);
  float dx = abs(fract(uv.x - rc + 0.5) - 0.5) * TILE;
  float n = texture(uNoise, uv * 5.0 + uView.zw).r;
  float n2 = texture(uNoise, uv * 1.3 - uView.zw).g;
  float mist = uSun.w * (exp(-dx * dx / 52000.0) * (0.45 + 1.1 * (n - 0.5)) + 0.25 * smoothstep(0.5, 0.75, n2));
  col = mix(col, uMist, clamp(mist, 0.0, 0.8));
  // Haze into the distance, warmer towards the sun.
  float fog = 1.0 - exp(-z / HAZE);
  vec3 hz = mix(uHorizon, uGlow, uSun.z * 0.6 * exp(-abs(p.x - uSun.x) * 2.5));
  return mix(col, hz, fog);
}

void main() {
  float px = uFrame.x;
  vec2 p = gl_FragCoord.xy * px - vec2(0.5 * uFrame.y, 0.5);
  float y = p.y - HORIZON;
  vec3 g = ground(p, max(-y, 0.0015));
  vec3 s = sky(p, max(y, 0.0));
  outColor = vec4(mix(g, s, smoothstep(-px, px, y)), 1.0);
}
`;

/** The view out, upscaled to the frame. */
const BLIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uOutside;
uniform vec2 uResolution;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy;
  outColor = vec4(texture(uOutside, frag / uResolution).rgb + dither8(frag), 1.0);
}
`;

/**
 * The cached foreground over the view, each frame: lit for the time of day,
 * the envelope glowing from the burner, the ropes swaying a hair behind it,
 * and the flame above the coil. Premultiplied, blended over the view.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uForeground;
uniform sampler2D uEmission;
uniform sampler2D uNoise;
uniform sampler2D uRamp;
uniform vec2 uResolution;
uniform vec3 uSolid;
uniform vec3 uFabric;
/** The burner's light on the envelope: colour times glow. */
uniform vec3 uGlow;
/** The flame: its glow (0..1) and peak opacity. */
uniform vec2 uFlame;
/** The flame's noise offsets: two octaves. */
uniform vec4 uFlameOff;
/** Each rope's sway, left pair then right pair. */
uniform vec4 uSway;
uniform vec3 uRope;

out vec4 outColor;
${DITHER_GLSL}

const float PI = 3.14159265;

/** Rope coverage at p (right-hand side coordinates) for rope a -> b swaying by s. */
float rope(vec2 q, vec4 r, float s, float px, out float across) {
  float t = (q.y - r.y) / (r.w - r.y);
  float x = mix(r.x, r.z, t) + s * sin(PI * clamp(t, 0.0, 1.0));
  float slope = (r.z - r.x) / (r.w - r.y);
  float d = (q.x - x) / sqrt(1.0 + slope * slope);
  across = d / ${f(ROPE_HW)};
  return clamp(${f(ROPE_HW)} / px - abs(d) / px + 0.5, 0.0, 1.0) * step(0.0, t);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  ivec2 ip = ivec2(frag);
  vec4 fg = texelFetch(uForeground, ip, 0);
  vec4 em = texelFetch(uEmission, ip, 0);
  float px = 1.0 / uResolution.y;
  vec2 p = (frag - 0.5 * uResolution) * px;
  vec3 rgb = fg.rgb * mix(uSolid, uFabric, em.a) + em.rgb * uGlow;
  float a = fg.a;

  // The ropes, behind the foreground.
  if (abs(p.x) > 0.66 && a < 0.999) {
    vec2 q = vec2(abs(p.x), p.y);
    bool right = p.x > 0.0;
    for (int i = 0; i < 2; i++) {
      vec4 r = i == 0 ? vec4(${ROPES[0].map(f).join(", ")}) : vec4(${ROPES[1].map(f).join(", ")});
      float s = right ? (i == 0 ? uSway.z : uSway.w) : (i == 0 ? uSway.x : uSway.y);
      float across;
      float c = rope(q, r, s, px, across);
      if (c > 0.0) {
        float k = clamp(across, -1.0, 1.0);
        float lay = step(0.5, fract(p.y * 220.0 + k * 0.7));
        vec3 col = uRope * (0.5 + 0.5 * sqrt(1.0 - k * k)) * (0.85 + 0.15 * lay);
        rgb += (1.0 - a) * col * c;
        a += (1.0 - a) * c;
      }
    }
  }

  // The flame: a soft, flickering tongue rising from the coil, through the
  // fire's own heat ramp.
  if (uFlame.x > 0.0 && abs(p.x) < 0.09 && p.y > ${f(JET_Y - 0.01)}) {
    float v = (p.y - ${f(JET_Y)}) / ${f(FLAME_H)};
    float w = 0.024 + 0.03 * clamp(v, 0.0, 1.5);
    float u = p.x / w;
    vec2 nq = vec2(u * 0.05, v * 0.09);
    float n1 = textureLod(uNoise, nq + uFlameOff.xy, 0.0).r;
    float n2 = textureLod(uNoise, nq * 2.03 + uFlameOff.zw, 0.0).g;
    float fb = n1 * 0.66 + n2 * 0.34;
    float g = uFlame.x;
    float heat = (1.0 - 0.75 * v) * 1.05 + (fb - 0.5) * (1.3 + 1.6 * clamp(v, 0.0, 1.0));
    heat *= smoothstep(1.0, 0.45, abs(u + (n1 - 0.5) * 0.9 * v)) * smoothstep(-0.06, 0.04, v);
    // The flame grows from the coil as the burn ramps up, and sinks back.
    heat = clamp(heat * g * (0.55 + 0.45 * g), 0.0, 1.0);
    vec4 fl = textureLod(uRamp, vec2(heat * ${f((RAMP_SIZE - 1) / RAMP_SIZE)} + ${f(0.5 / RAMP_SIZE)}, 0.5), 0.0) * uFlame.y;
    rgb = fl.rgb + rgb * (1.0 - fl.a);
    a = fl.a + a * (1.0 - fl.a);
  }

  outColor = vec4(rgb + dither8(frag) * a, a);
}
`;

/**
 * Hot-Air Balloon Ride. The basket, uprights, burner and envelope are drawn
 * once per resize, scheme or variation into two targets (colour, and the
 * burner's light). Each frame renders the turning, drifting landscape at
 * reduced size, upscales it, draws the distant balloons with the Hot-Air
 * Balloons sprite, and lays the foreground over them, lit for the time of
 * day and glowing as the burner fires.
 */
export const balloonride = defineEffect(balloonrideMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const fgProgram = program(FULLSCREEN_VERTEX, FOREGROUND_FRAGMENT);
      const fu = createUniforms(gl, fgProgram, [
        "uResolution",
        "uSeed",
        "uMode",
        "uGores",
        "uScheme",
      ]);
      const outsideProgram = program(FULLSCREEN_VERTEX, OUTSIDE_FRAGMENT);
      const ou = createUniforms(gl, outsideProgram, [
        "uMap",
        "uNoise",
        "uFrame",
        "uView",
        "uSun",
        "uShadow",
        "uRiver",
        "uZenith",
        "uHorizon",
        "uGlow",
        "uDisc",
        "uSunlight",
        "uAmbient",
        "uMist",
      ]);
      const blitProgram = program(FULLSCREEN_VERTEX, BLIT_FRAGMENT);
      const bu = createUniforms(gl, blitProgram, ["uOutside", "uResolution"]);
      const balloonProgram = program(BALLOON_VERTEX, BALLOON_FRAGMENT);
      const su = createUniforms(gl, balloonProgram, [
        "uResolution",
        "uLightDir",
        "uLit",
        "uShade",
        "uHaze",
        "uFlame",
      ]);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, [
        "uForeground",
        "uEmission",
        "uNoise",
        "uRamp",
        "uResolution",
        "uSolid",
        "uFabric",
        "uGlow",
        "uFlame",
        "uFlameOff",
        "uSway",
        "uRope",
      ]);
      gl.useProgram(outsideProgram);
      ou.i1("uMap", 0);
      ou.i1("uNoise", 1);
      gl.useProgram(blitProgram);
      bu.i1("uOutside", 0);
      gl.useProgram(balloonProgram);
      su.v3("uFlame", FLAME_LIGHT);
      gl.useProgram(compositeProgram);
      cu.i1("uForeground", 0);
      cu.i1("uEmission", 1);
      cu.i1("uNoise", 2);
      cu.i1("uRamp", 3);
      gl.useProgram(null);

      const texture = (t: WebGLTexture) =>
        scope.add(t, (x) => {
          gl.deleteTexture(x);
        });
      const noiseTexture = texture(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, fireNoiseChannels()),
          wrap: gl.REPEAT,
        }),
      );
      const rampTexture = texture(
        createDataTexture(gl, {
          width: RAMP_SIZE,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildRamp(PALETTES.wood.ramp),
        }),
      );
      let mapTexture: WebGLTexture | null = null;
      scope.defer(() => {
        if (mapTexture) {
          gl.deleteTexture(mapTexture);
        }
        mapTexture = null;
      });
      const batch = scope.own(createSpriteBatch(gl, MAX_OTHERS, BALLOON_LAYOUT, [BALLOON_STRIP]));
      if (batch.stride !== BALLOON_FLOATS) {
        throw new Error("balloonride: instance layout mismatch");
      }

      let foreground: RenderTarget | null = null;
      let emission: RenderTarget | null = null;
      let outside: RenderTarget | null = null;
      scope.defer(() => {
        foreground?.dispose();
        emission?.dispose();
        outside?.dispose();
        foreground = emission = outside = null;
      });

      const gores = new Float32Array(MAX_SCHEME_COLOURS * 3);
      const sun: [number, number] = [0, 0];
      const lightDir: [number, number, number] = [0, 0, 0];
      const glow: [number, number, number] = [0, 0, 0];
      const rope: [number, number, number] = [0, 0, 0];
      const balloonPalette = paletteFor("classic");
      let phases = riverPhases(0);
      let others: Others = createOthers(0);
      let burner = createBurner(0);
      let width = 1;
      let height = 1;
      let time = 0;
      let yawPhase = 0;
      let ropePhase = 0;
      let wind = 0;
      /** Map offset (uv, wrapped), mist offset, and the flame's noise offsets. */
      let mapU = 0;
      let mapV = 0;
      let mistU = 0;
      let flameV1 = 0;
      let flameV2 = 0;
      let mapSeed = Number.NaN;
      let fgSeed = Number.NaN;
      let fgScheme = "";
      const lightEase = createLightEase();

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          foreground?.dispose();
          emission?.dispose();
          outside?.dispose();
          foreground = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          emission = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          outside = createRenderTarget(
            gl,
            lowResSize(width, OUTSIDE_DIVISOR),
            lowResSize(height, OUTSIDE_DIVISOR),
            gl.RGBA8,
          );
          fgSeed = Number.NaN;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const seed = Math.floor(clamp(p.seed, 0, 999));
          if (!foreground || !emission || !outside) {
            return;
          }

          // 1. The landscape map, the wind, the burner and the other
          //    balloons, when the variation changes.
          if (seed !== mapSeed) {
            mapSeed = seed;
            if (mapTexture) {
              gl.deleteTexture(mapTexture);
            }
            // Allocates only when the seed changes.
            mapTexture = createDataTexture(gl, {
              width: MAP_SIZE,
              height: MAP_SIZE,
              internalFormat: gl.RGBA8,
              format: gl.RGBA,
              type: gl.UNSIGNED_BYTE,
              data: landscapeFor(seed),
              wrap: gl.REPEAT,
            });
            gl.bindTexture(gl.TEXTURE_2D, mapTexture);
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.bindTexture(gl.TEXTURE_2D, null);
            phases = riverPhases(seed);
            wind = windAngle(seed);
            others = createOthers(seed);
            burner = createBurner(seed);
            primeBurner(burner, p.burner, 4 + 6 * ((seed * 0.618034) % 1));
          }

          // 2. The foreground, when it may have changed.
          if (seed !== fgSeed || p.envelope !== fgScheme) {
            fgSeed = seed;
            fgScheme = p.envelope;
            const scheme = schemeFor(p.envelope);
            gores.fill(0);
            for (let i = 0; i < scheme.colours.length; i++) {
              gores.set(scheme.colours[i], i * 3);
            }
            gl.useProgram(fgProgram);
            fu.f2("uResolution", width, height);
            fu.f1("uSeed", seed);
            gl.uniform3fv(fu.loc.uGores, gores);
            fu.f2("uScheme", scheme.colours.length, scheme.patch ? 1 : 0);
            fu.i1("uMode", 0);
            foreground.bind();
            triangle.draw();
            fu.i1("uMode", 1);
            emission.bind();
            triangle.draw();
          }

          // 3. Motion: the turn, the drift, the burner, the other balloons.
          const light = lightEase.step(timeFor(p.time), step);
          yawPhase = advanceSwell(YAW_SWELL, yawPhase, step);
          ropePhase = advanceSwell(ROPE_SWELL, ropePhase, step);
          const yaw = yawAt(yawPhase);
          const drift = (WIND_SPEED * step) / TILE_METRES;
          mapU = wrap(mapU - Math.sin(wind) * drift, 0, 1);
          mapV = wrap(mapV - Math.cos(wind) * drift, 0, 1);
          mistU = wrap(mistU + MIST_DRIFT * step, 0, 1);
          flameV1 = wrap(flameV1 - FLAME_RISE * step, 0, 1);
          flameV2 = wrap(flameV2 - FLAME_RISE_2 * step, 0, 1);
          stepBurner(burner, step, p.burner);
          stepOthers(others, step, p.others);
          const burn = burnerGlow(burner);
          const flicker = flickerAt(time % SHADER_PERIOD);
          sunOnScreen(light, yaw, sun);
          sunDirection(light, yaw, lightDir);
          const reach =
            Math.min(MAX_SHADOW, HEIGHT_METRES / Math.tan(Math.max(light.sunElev, 0.02))) /
            TILE_METRES;

          // 4. The view out.
          outside.bind();
          gl.useProgram(outsideProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, mapTexture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          ou.f4("uFrame", 1 / outside.height, width / height, Math.cos(yaw), Math.sin(yaw));
          ou.f4("uView", mapU, mapV, mistU, mistU * 0.6);
          ou.f4("uSun", sun[0], sun[1], light.base.glowStrength, light.mist);
          ou.f2("uShadow", Math.sin(light.sunAz) * reach, Math.cos(light.sunAz) * reach);
          ou.f4("uRiver", phases[0], phases[1], phases[2], phases[3]);
          ou.v3("uZenith", light.base.zenith);
          ou.v3("uHorizon", light.base.horizon);
          ou.v3("uGlow", light.base.glow);
          ou.v3("uDisc", light.base.sun);
          ou.v3("uSunlight", light.sun);
          ou.v3("uAmbient", light.ambient);
          ou.v3("uMist", light.base.mist);
          triangle.draw();

          // 5. Upscaled to the frame.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(blitProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, outside.texture);
          bu.f2("uResolution", width, height);
          triangle.draw();

          // 6. The other balloons, farthest first, premultiplied.
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          const n = writeOthers(others, batch.data, balloonPalette, width, height, yaw);
          if (n > 0) {
            batch.upload(n);
            gl.useProgram(balloonProgram);
            su.f2("uResolution", width, height);
            su.v3("uLightDir", lightDir);
            su.v3("uLit", light.base.lit);
            su.v3("uShade", light.base.shade);
            su.v3("uHaze", light.base.horizon);
            batch.draw(0, n);
          }

          // 7. The foreground over it all.
          const g = burn * flicker * GLOW_GAIN;
          glow[0] = FLAME_LIGHT[0] * g;
          glow[1] = FLAME_LIGHT[1] * g;
          glow[2] = FLAME_LIGHT[2] * g;
          rope[0] = 0.78 * light.solid[0];
          rope[1] = 0.74 * light.solid[1];
          rope[2] = 0.64 * light.solid[2];
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, foreground.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, emission.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, rampTexture);
          cu.f2("uResolution", width, height);
          cu.v3("uSolid", light.solid);
          cu.v3("uFabric", light.envelope);
          cu.v3("uGlow", glow);
          cu.f2("uFlame", burn, FLAME_PEAK);
          cu.f4("uFlameOff", 0.37, flameV1, 0.71, flameV2);
          cu.f4(
            "uSway",
            ROPE_SWAY * swayAt(ROPE_SWELL, ropePhase, 0),
            ROPE_SWAY * swayAt(ROPE_SWELL, ropePhase, 3),
            ROPE_SWAY * swayAt(ROPE_SWELL, ropePhase, 11),
            ROPE_SWAY * swayAt(ROPE_SWELL, ropePhase, 17),
          );
          cu.v3("uRope", rope);
          triangle.draw();
          gl.disable(gl.BLEND);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
