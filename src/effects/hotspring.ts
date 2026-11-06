import { createFlameMotion, flameAt } from "./candle-sim";
import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  updateDataTexture,
  withScope,
} from "./gl";
import {
  buildFadeMask,
  buildRockTable,
  createEmitters,
  LANTERN_FIRE,
  LANTERN_H,
  MASK_H,
  MASK_W,
  paletteFor,
  RIPPLES,
  ripplePhases,
  ROCK_CHANNELS,
  ROCK_COLUMNS,
  ROCK_ROWS,
  springDraft,
  springEmitters,
  type SpringLayout,
  springLayout,
  STEAM_HEIGHT_DECAY,
  STEAM_RADIUS,
  steamFlow,
  steamGrid,
  steamRegion,
  timeIndex,
  WATERLINE,
  WISP_K,
  WISP_SPEED,
} from "./hotspring-sim";
import { hotspringMeta, MAX_SPRING_FLAKES } from "./hotspring.meta";
import { createLowResTarget } from "./lowres";
import { clamp, wrap } from "./math";
import { createNoise } from "./noise";
import { PINE_GLSL } from "./pines";
import type { StepClock } from "./reaction-sim";
import { createSmokeField } from "./smoke-field";
import { type Flow, simSteps, WAVE_COUNT, wavePhases } from "./smoke-sim";
import { createFlakes, type FlakeFrame } from "./snow-sim";
import { createFlakeRenderer } from "./snowflakes";
import { defineEffect } from "./types";

const g = glslFloat;
const vec4Of = (f: (r: (typeof RIPPLES)[number]) => number) =>
  `vec4(${RIPPLES.map((r) => g(f(r))).join(", ")})`;

/** Background pass: about 3 reference px per texel; it is soft and static. */
const SKY_TEXEL_REF = 3;
/** Water pass: about 2 reference px per texel, re-rendered every frame. */
const WATER_TEXEL_REF = 2;
/** Steam density to opacity: alpha = 1 - exp(-STEAM_OPACITY * density), at most STEAM_MAX. */
const STEAM_OPACITY = 1.6;
const STEAM_MAX = 0.85;
/** Lantern flicker (0..1, see `flameAt`): very subtle. */
const LANTERN_FLICKER = 0.5;
/** Rows of the rock table, as texture v. */
const NEAR_V = 0.25;
const FAR_V = 0.75;
/** Warm lantern light. */
const LAMP_GLSL = "const vec3 LAMP = vec3(1.0, 0.62, 0.3);";

/**
 * Low-res pass: the background behind the pool, y up in height units. Sky with
 * an afterglow, a snowy mountain slope, a far row of small pines at its foot,
 * the snowfield, and larger snowy spruces along the bank (more at the sides).
 * Static, so it renders only when the time of day or the size changes. The
 * water pass samples it for reflections, so it covers the whole frame.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Low-res px to height units, x and y. */
uniform vec2 uInvLow;
uniform float uAspect;
uniform vec3 uSkyTop;
uniform vec3 uSkyLow;
uniform vec3 uGlow;
uniform vec3 uMountain;
uniform vec3 uPine;
uniform vec3 uSnow;
out vec4 outColor;
${PINE_GLSL}
const float W = ${g(WATERLINE)};

float mountainLine(float x) {
  return 0.62 + 0.09 * sin(x * 1.9 + 0.7) + 0.035 * sin(x * 5.3 + 1.9) + 0.012 * sin(x * 13.1);
}
float footLine(float x) {
  return W + 0.13 + 0.02 * sin(x * 3.7 + 0.4) + 0.008 * sin(x * 9.1);
}
float bankLine(float x) {
  return W + 0.05 + 0.012 * sin(x * 4.1 + 2.0) + 0.006 * sin(x * 11.3 + 0.5);
}
/** 0 in the middle of the frame (behind the speaker), 1 toward the sides. */
float sideWeight(float x) {
  return smoothstep(0.1, 0.4, abs(x / uAspect - 0.5));
}

/**
 * A row of spruces in cells \`cellW\` wide standing on the foot line (\`onBank\`
 * false) or the bank, sunk by \`sink\`: coverage, snow and shade. \`bias\` thins
 * them toward the middle. Trees can overhang the next cell, so three are tested.
 */
vec3 pineRow(vec2 p, float cellW, float tallest, float density, float bias, bool onBank,
             float sink, float salt, vec2 tiers, float px) {
  float cell0 = floor(p.x / cellW);
  vec3 best = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    float cell = cell0 + float(k);
    float dens = density * mix(1.0, sideWeight((cell + 0.5) * cellW), bias);
    vec3 pine = pineCell(cell, 4096.0, salt, dens);
    if (pine.x == 0.0) continue;
    float cx = (cell + pine.y) * cellW;
    float th = pine.z * tallest;
    float base = (onBank ? bankLine(cx) : footLine(cx)) - sink;
    float yr = (p.y - base) / th;
    if (yr < 0.0 || yr > 1.0) continue;
    float r = fract(pine.y * 7.31 + pine.z * 3.77);
    vec3 s = pineSpruce(vec2(p.x - cx, yr), th, floor(mix(tiers.x, tiers.y + 0.99, r)), r);
    float c = clamp(s.x / px + 0.5, 0.0, 1.0);
    if (c > best.x) best = vec3(c, s.yz);
  }
  return best;
}

void main() {
  vec2 p = gl_FragCoord.xy * uInvLow;
  float px = uInvLow.y;

  vec3 col = mix(uSkyLow, uSkyTop, smoothstep(W + 0.2, 1.0, p.y));
  col = mix(col, uGlow, 0.55 * exp(-max(p.y - 0.5, 0.0) / 0.12));

  // The mountain slope: snowy, lighter toward its ridge, hazed into the sky.
  float m = mountainLine(p.x);
  vec3 slope = uMountain * mix(0.82, 1.05, smoothstep(m - 0.2, m, p.y));
  slope *= 1.0 + 0.05 * sin(p.x * 23.0 + p.y * 41.0) * sin(p.x * 7.0 - p.y * 13.0);
  col = mix(col, slope, clamp((m - p.y) / px + 0.5, 0.0, 1.0));

  // Small far pines at the foot of the slope, then the snowfield below them.
  vec3 haze = mix(uPine, uSkyLow, 0.55);
  vec3 far = pineRow(p, 0.022, 0.05, 0.8, 0.0, false, 0.004, 11.0, vec2(4.0, 5.0), px);
  col = mix(col, haze, far.x);
  float foot = footLine(p.x);
  vec3 field = mix(uSnow * 0.9, mix(uSnow, uSkyLow, 0.35), smoothstep(W, foot, p.y));
  col = mix(col, field, clamp((foot - p.y) / px + 0.5, 0.0, 1.0));

  // The bank behind the pool, and spruces along it, mostly toward the sides.
  float bank = bankLine(p.x);
  col = mix(col, uSnow * mix(0.8, 0.95, smoothstep(W, bank, p.y)), clamp((bank - p.y) / px + 0.5, 0.0, 1.0));
  vec3 near = pineRow(p, 0.12, 0.3, 0.85, 0.9, true, 0.01, 23.0, vec2(5.0, 8.0), px);
  vec3 needles = mix(uPine, uSkyLow, 0.12) * (1.0 - 0.45 * near.z);
  col = mix(col, mix(needles, uSnow * 0.9, 0.8 * near.y), near.x);
  outColor = vec4(col, 1.0);
}
`;

/**
 * Low-res pass: the water, below the far edge. The background reflected about
 * the far edge with ripple distortion growing toward the viewer, the far rim's
 * stones and the stones standing in the water reflected too, mixed into dark
 * teal by a Fresnel term, and the lantern's warm sheen.
 */
const WATER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSky;
uniform sampler2D uRocks;
/** Low-res px to height units, x and y. */
uniform vec2 uLowToH;
uniform float uAspect;
/** Ripple phases, wrapped on the CPU. */
uniform vec4 uPhase;
uniform vec3 uWater;
uniform vec3 uRock;
uniform vec3 uSnow;
uniform vec3 uSkyLow;
/** Lantern firebox (height units) and light strength. */
uniform vec3 uLamp;
out vec4 outColor;
${LAMP_GLSL}
const float W = ${g(WATERLINE)};
const vec4 KX = ${vec4Of((r) => r.kx)};
const vec4 KZ = ${vec4Of((r) => r.kz)};
const vec4 AMP = ${vec4Of((r) => r.amp)};

vec4 rockRow(float x, float v) {
  return textureLod(uRocks, vec2(x / uAspect, v), 0.0);
}
/** A reflected rock (row sample r) at height y: rgb premultiplied by coverage, a coverage. */
vec4 rockReflection(vec4 r, float y) {
  float cov = smoothstep(-0.004, 0.004, r.x - y) * smoothstep(-0.004, 0.004, y - r.y);
  vec3 c = mix(uRock, uSnow * 0.85, smoothstep(-0.004, 0.004, r.z - (r.x - y)));
  return vec4(c * cov, cov);
}

void main() {
  vec2 p = gl_FragCoord.xy * uLowToH;
  float depth = max(W - p.y, 0.0);
  // Rows near the far edge are far away: their ripples are fine and flattened.
  float z = 1.0 / (depth + 0.06);
  vec4 th = KX * p.x + KZ * z + uPhase;
  vec4 s = sin(th);
  float h = dot(AMP, s);
  float hx = dot(AMP * KX, cos(th));
  float amt = 0.002 + 0.03 * depth;
  vec2 q = vec2(p.x + hx * amt * 0.02, 2.0 * W - p.y + h * amt);

  vec3 refl = texture(uSky, vec2(q.x / uAspect, q.y)).rgb;
  // The far rim's stones, mirrored about the far edge.
  vec4 rim = rockReflection(rockRow(q.x, ${g(FAR_V)}), q.y);
  refl = rim.rgb + refl * (1.0 - rim.a);
  // Stones standing in the water, mirrored about their own waterline.
  vec4 nr = rockRow(p.x, ${g(NEAR_V)});
  if (nr.y > 0.0 && p.y < nr.y) {
    vec4 st = rockReflection(nr, 2.0 * nr.y - p.y + h * amt);
    refl = st.rgb * 0.8 + refl * (1.0 - st.a);
  }

  float fresnel = mix(0.82, 0.3, smoothstep(0.0, 0.22, depth));
  vec3 col = mix(uWater, refl * 0.9, fresnel);
  // Soft glints of the sky on the ripples' crests, fading toward the viewer.
  col += uSkyLow * (0.05 * max(h, 0.0) * (1.0 - smoothstep(0.0, 0.2, depth)));
  vec2 d = (p - uLamp.xy) * vec2(1.0, 2.2);
  col += LAMP * (uLamp.z * 0.16 * exp(-dot(d, d) / 0.03) * (0.75 + 0.2 * h));
  outColor = vec4(col, 1.0);
}
`;

/**
 * Full-resolution silhouette pass over the bottom of the frame, premultiplied:
 * the far rim's stones, the near boulders (column-table tops and bottoms with
 * coverage anti-aliasing, snow caps, creases where boulders meet, a wet band
 * at the waterline) and the stone lantern, all lit warmly near the lantern.
 */
const ROCK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uRocks;
/** One device px in height units. */
uniform float uPx;
uniform float uAspect;
/** One table column in height units. */
uniform float uColW;
uniform vec3 uRock;
uniform vec3 uSnow;
uniform vec3 uSkyLow;
/** Lantern firebox (height units) and light strength (0: no lantern). */
uniform vec3 uLamp;
/** Lantern foot centre, height units, and 1 if there is a lantern. */
uniform vec3 uFoot;
/** Lantern light strength for its own window (lit even by day). */
uniform float uWindow;
out vec4 outColor;
${DITHER_GLSL}
${LAMP_GLSL}
const float S = ${g(LANTERN_H)};

vec4 rockRow(float x, float v) {
  return textureLod(uRocks, vec2(x / uAspect, v), 0.0);
}

float lampLight(vec2 p) {
  vec2 d = p - uLamp.xy;
  return uLamp.z / (1.0 + dot(d, d) * 60.0);
}

/** A row of rocks at p, premultiplied. */
vec4 rocks(vec2 p, float v) {
  vec4 r = rockRow(p.x, v);
  float gap = r.x - p.y;
  float span = max(uPx, uColW);
  float top;
  if (abs(gap) > 8.0 * span) {
    top = gap > 0.0 ? 1.0 : 0.0;
  } else {
    // Signed distance from the height gap and the local slope, through a one-pixel ramp.
    float s = (rockRow(p.x + span, v).x - rockRow(p.x - span, v).x) / (2.0 * span);
    top = clamp(gap / (uPx * sqrt(1.0 + s * s)) + 0.5, 0.0, 1.0);
  }
  float cov = top * clamp((p.y - r.y) / uPx + 0.5, 0.0, 1.0);
  if (cov <= 0.0) return vec4(0.0);
  float depth = gap;
  float light = lampLight(p);
  // Snow cap with a wavy lower edge, brightest on its upper surface.
  float cap = r.z * (1.0 + 0.3 * sin(p.x * 140.0) * sin(p.x * 37.0 + 1.0));
  float snow = clamp((cap - depth) / uPx + 0.5, 0.0, 1.0);
  vec3 sc = uSnow * mix(0.72, 1.0, smoothstep(0.0, 0.7, 1.0 - depth / max(cap, 1e-4)));
  sc += LAMP * (0.55 * light);
  // Rock: darker deeper below the cap, in the creases, and wet at the waterline.
  float ao = smoothstep(0.0, 0.12, depth);
  vec3 rc = uRock * (1.15 - 0.5 * ao) * (1.0 - 0.6 * r.w * smoothstep(0.0, 0.02, depth));
  rc += uSkyLow * (0.05 * (1.0 - ao));
  if (r.y > 0.0) rc *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.012, p.y - r.y));
  rc += LAMP * (0.22 * light) * (0.4 + uRock);
  return vec4(mix(rc, sc, snow) * cov, cov);
}

float sdBox(vec2 q, vec2 h) {
  vec2 d = abs(q) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/** The stone lantern at q (from its foot, in lantern heights), premultiplied. */
vec4 lantern(vec2 q, float px) {
  float foot = sdBox(q - vec2(0.0, 0.06), vec2(0.18, 0.05)) - 0.02;
  float post = sdBox(q - vec2(0.0, 0.26), vec2(0.075, 0.16));
  float plat = sdBox(q - vec2(0.0, 0.44), vec2(0.22, 0.03)) - 0.01;
  float box = sdBox(q - vec2(0.0, ${g(LANTERN_FIRE)}), vec2(0.15, 0.13));
  // The roof: wide eaves tapering to the peak, their tips turned up a touch.
  float ry = q.y - 0.73;
  float hw = mix(0.36, 0.07, clamp(ry / 0.17, 0.0, 1.0)) + 0.04 * (1.0 - smoothstep(0.0, 0.05, ry));
  float roof = max(max(-ry, ry - 0.17), (abs(q.x) - hw) * 0.8);
  float knob = length(q - vec2(0.0, 0.94)) - 0.05;
  float d = min(min(min(foot, post), min(plat, box)), min(roof, knob));
  float cov = clamp(0.5 - d / px, 0.0, 1.0);
  if (cov <= 0.0) return vec4(0.0);
  vec2 f = q - vec2(0.0, ${g(LANTERN_FIRE)});
  vec3 stone = uRock * (1.5 + 0.4 * smoothstep(-0.3, 0.3, -q.x));
  stone += LAMP * (uLamp.z * 0.5 * exp(-dot(f, f) / 0.04));
  // Snow on the roof, the platform and the foot.
  float sn = 0.0;
  if (roof < px) sn = smoothstep(0.06, 0.06 + px, ry + 0.012 * sin(q.x * 31.0));
  if (plat < px) sn = max(sn, smoothstep(0.455, 0.455 + px, q.y));
  if (foot < px) sn = max(sn, smoothstep(0.1, 0.1 + px, q.y));
  if (knob < px) sn = max(sn, smoothstep(0.93, 0.93 + px, q.y));
  vec3 col = mix(stone, uSnow * 0.95 + LAMP * (0.25 * uLamp.z), sn);
  // The firebox window: warm and glowing, brighter in the middle.
  float win = clamp(0.5 - sdBox(f, vec2(0.085, 0.08)) / px, 0.0, 1.0);
  vec3 fire = LAMP * uWindow * (1.0 + 0.5 * exp(-dot(f, f) / 0.004));
  col = mix(col, fire, win);
  return vec4(col * cov, cov);
}

void main() {
  vec2 p = gl_FragCoord.xy * uPx;
  vec4 c = vec4(0.0);
  if (p.y < ${g(WATERLINE + 0.06)}) c = rocks(p, ${g(FAR_V)});
  vec4 n = rocks(p, ${g(NEAR_V)});
  c = n + c * (1.0 - n.a);
  if (uFoot.z > 0.0) {
    vec2 q = (p - uFoot.xy) / S;
    if (q.y > -0.05 && q.y < 1.05 && abs(q.x) < 0.45) {
      vec4 l = lantern(q, uPx / S);
      c = l + c * (1.0 - l.a);
    }
  }
  c.rgb += c.a * dither8(gl_FragCoord.xy);
  outColor = c;
}
`;

/**
 * The steam at full resolution inside its box, premultiplied: density to alpha,
 * faded in just above the bottom of the box and out toward its top and sides,
 * tinted warm near the lantern.
 */
const STEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField;
uniform float uPx;
/** Steam box: x0, y0 (height units), 1 / width, 1 / height. */
uniform vec4 uBox;
uniform vec3 uSteam;
uniform vec3 uLamp;
out vec4 outColor;
${DITHER_GLSL}
${LAMP_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy * uPx;
  vec2 uv = (p - uBox.xy) * uBox.zw;
  float d = texture(uField, uv).r;
  float fade = smoothstep(0.0, 0.12, uv.y) * (1.0 - smoothstep(0.5, 1.0, uv.y))
    * smoothstep(0.0, 0.15, uv.x) * smoothstep(0.0, 0.15, 1.0 - uv.x);
  float alpha = (1.0 - exp(-${g(STEAM_OPACITY)} * d)) * fade * ${g(STEAM_MAX)};
  vec2 l = p - uLamp.xy;
  vec3 c = uSteam * (0.9 + 0.1 * uv.y) + LAMP * (uLamp.z * 0.45 / (1.0 + dot(l, l) * 40.0));
  outColor = vec4((c + dither8(gl_FragCoord.xy)) * alpha, alpha);
}
`;

/** The lantern's halo, added over everything inside a scissored box around it. */
const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uPx;
uniform vec3 uLamp;
out vec4 outColor;
${DITHER_GLSL}
${LAMP_GLSL}
void main() {
  vec2 d = gl_FragCoord.xy * uPx - uLamp.xy;
  float r2 = dot(d, d);
  float glow = uLamp.z * (0.2 * exp(-r2 / 0.0005) + 0.06 * exp(-r2 / 0.012));
  // Dither where the halo is bright enough to band; output can't go negative.
  vec3 c = LAMP * glow + dither8(gl_FragCoord.xy) * clamp(glow * 100.0, 0.0, 1.0);
  outColor = vec4(max(c, 0.0), 1.0);
}
`;

/** Radius of the glow pass's box around the lantern, height units. */
const GLOW_R = 0.3;

/**
 * An outdoor hot spring among snowy rocks: a static low-res background, a
 * low-res rippled water pass reflecting it, the rocks and stone lantern at full
 * resolution, steam from the shared smoke field rising off the water, the shared
 * snowflakes melting in it (their fade mask), and the lantern's additive glow.
 */
export const hotspring = defineEffect(hotspringMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const sky = scope.own(createLowResTarget(gl));
      const water = scope.own(createLowResTarget(gl));
      const field = createSmokeField(gl, scope, "hotspring");
      const adv = field.uniforms;
      const rocksTable = scope.own(
        createColumnTable(gl, ROCK_COLUMNS, ROCK_CHANNELS, { rows: ROCK_ROWS }),
      );
      const flakeRenderer = scope.own(
        createFlakeRenderer(gl, MAX_SPRING_FLAKES, { fadeMask: true }),
      );
      const maskData = new Uint8Array(MASK_W * MASK_H);
      const maskTexture = scope.add(
        createDataTexture(gl, {
          width: MASK_W,
          height: MASK_H,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: maskData,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => {
          gl.deleteProgram(p);
        });

      const skyProgram = program(SKY_FRAGMENT);
      const ku = createUniforms(gl, skyProgram, [
        "uInvLow",
        "uAspect",
        "uSkyTop",
        "uSkyLow",
        "uGlow",
        "uMountain",
        "uPine",
        "uSnow",
      ]);
      const waterProgram = program(WATER_FRAGMENT);
      const wu = createUniforms(gl, waterProgram, [
        "uSky",
        "uRocks",
        "uLowToH",
        "uAspect",
        "uPhase",
        "uWater",
        "uRock",
        "uSnow",
        "uSkyLow",
        "uLamp",
      ]);
      const rockProgram = program(ROCK_FRAGMENT);
      const ru = createUniforms(gl, rockProgram, [
        "uRocks",
        "uPx",
        "uAspect",
        "uColW",
        "uRock",
        "uSnow",
        "uSkyLow",
        "uLamp",
        "uFoot",
        "uWindow",
      ]);
      const steamProgram = program(STEAM_FRAGMENT);
      const su = createUniforms(gl, steamProgram, ["uField", "uPx", "uBox", "uSteam", "uLamp"]);
      const glowProgram = program(GLOW_FRAGMENT);
      const gu = createUniforms(gl, glowProgram, ["uPx", "uLamp"]);
      gl.useProgram(waterProgram);
      wu.i1("uSky", 0);
      wu.i1("uRocks", 1);
      gl.useProgram(rockProgram);
      ru.i1("uRocks", 0);
      gl.useProgram(steamProgram);
      su.i1("uField", 0);
      gl.useProgram(null);

      let layout: SpringLayout = springLayout(16 / 9);
      const layoutKey = createChangeKey(1);
      const maskKey = createChangeKey(2);
      const skyKey = createChangeKey(4);
      const region = new Float64Array(4);
      const grid = new Int32Array(2);
      const phases = new Float32Array(WAVE_COUNT);
      const ripples = new Float32Array(RIPPLES.length);
      const flow: Flow = steamFlow({ rise: 0, draft: 0, curl: 0, onset0: 0, onset1: 1 });
      const emitters = createEmitters();
      const clock: StepClock = { acc: 0 };
      const noise = createNoise(0x1a7e);
      const flame = createFlameMotion();

      let width = 1;
      let height = 1;
      let waterHeight = 1;
      let refWidth = 1920;
      /** Seconds since create, unwrapped (float64); only wrapped phases reach the GPU. */
      let time = 0;
      const flakes = createFlakes(MAX_SPRING_FLAKES, refWidth);
      const f: FlakeFrame = {
        refWidth,
        scale: 1,
        count: 0,
        speed: 0.55,
        wind: 0.12,
        gustiness: 0.3,
        sway: 0.5,
        size: 3,
        depthBlur: 0.6,
        brightness: 0.85,
      };

      /** Scissors to a box given in height units (x0, y0, x1, y1). */
      const scissor = (x0: number, y0: number, x1: number, y1: number) => {
        const a = Math.max(0, Math.floor(x0 * height));
        const b = Math.max(0, Math.floor(y0 * height));
        const c = Math.min(width, Math.ceil(x1 * height));
        const d = Math.min(height, Math.ceil(y1 * height));
        gl.scissor(a, b, Math.max(0, c - a), Math.max(0, d - b));
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          const scale = v.scale > 0 ? v.scale : height / 1080;
          const newRefWidth = width / scale;
          flakes.rescaleX(newRefWidth / refWidth);
          refWidth = f.refWidth = newRefWidth;
          f.scale = scale;
          // At least 2, so the background always has a texture for the water to reflect.
          sky.resize(width, height, Math.max(2, SKY_TEXEL_REF * scale));
          waterHeight = Math.min(height, Math.ceil(WATERLINE * height) + 2);
          water.resize(width, waterHeight, Math.max(1, WATER_TEXEL_REF * scale));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const aspect = width / height;
          const pal = paletteFor(p.time);
          const steam = clamp(Number.isFinite(p.steam) ? p.steam : 0, 0, 1);
          gl.activeTexture(gl.TEXTURE0);

          layoutKey.set(0, aspect);
          if (layoutKey.take()) {
            layout = springLayout(aspect);
            buildRockTable(layout, rocksTable.data);
            rocksTable.upload();
            maskKey.invalidate();
          }
          maskKey.set(0, aspect);
          maskKey.set(1, steam);
          if (maskKey.take()) {
            buildFadeMask(layout, steam, maskData);
            updateDataTexture(gl, maskTexture, MASK_W, MASK_H, gl.RED, gl.UNSIGNED_BYTE, maskData);
          }

          // The lantern: firebox position and a very subtle flicker.
          flameAt(noise, 0, time, LANTERN_FLICKER, 0, flame);
          const lampX = layout.lanternX;
          const lampY = layout.lanternY + LANTERN_FIRE * LANTERN_H;
          const lamp = p.lantern ? pal.lantern * flame.bright[0] : 0;

          // 1. Steam simulation.
          steamGrid(layout, grid);
          const hasSteam = field.resize(grid[0], grid[1]);
          const n = simSteps(clock, step);
          if (hasSteam && n > 0) {
            gl.useProgram(field.program);
            steamRegion(layout, region);
            springEmitters(layout, steam, emitters);
            wavePhases(time, phases);
            flow.draft = springDraft(time);
            const radius = Math.max(STEAM_RADIUS, (0.9 * region[2]) / grid[0]);
            const e0 = emitters.far;
            const e1 = emitters.near;
            adv.f4("uRegion", region[0], region[1], region[2], region[3]);
            adv.f4("uPhase", phases[0], phases[1], phases[2], phases[3]);
            adv.f3("uFlow", flow.rise, flow.draft, flow.curl);
            adv.f2("uOnset", flow.onset0, 1 / (flow.onset1 - flow.onset0));
            adv.f4("uEmit0", e0[0], e0[1], e0[2], e0[3]);
            adv.f4("uEmit1", e1[0], e1[1], e1[2], e1[3]);
            adv.f1("uInvR2", 1 / (radius * radius));
            adv.f3("uWisp", WISP_K, wrap(time * WISP_SPEED, 0, Math.PI * 2), emitters.wisp);
            adv.f2("uDecay", 1 / emitters.life, STEAM_HEIGHT_DECAY);
            field.advance(n);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          // 2. The background, re-rendered only when it changes, upscaled every frame.
          skyKey.set(0, timeIndex(p.time));
          skyKey.set(1, aspect);
          skyKey.set(2, sky.width);
          skyKey.set(3, sky.height);
          if (skyKey.take() || sky.direct) {
            sky.bind();
            gl.useProgram(skyProgram);
            ku.f2(
              "uInvLow",
              sky.fullWidth / sky.width / height,
              sky.fullHeight / sky.height / height,
            );
            ku.f1("uAspect", aspect);
            ku.v3("uSkyTop", pal.skyTop);
            ku.v3("uSkyLow", pal.skyLow);
            ku.v3("uGlow", pal.glow);
            ku.v3("uMountain", pal.mountain);
            ku.v3("uPine", pal.pine);
            ku.v3("uSnow", pal.snow);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          sky.blit();

          // 3. The water, every frame (it ripples), into the bottom strip.
          water.bind();
          gl.useProgram(waterProgram);
          ripplePhases(time, ripples);
          wu.f2(
            "uLowToH",
            water.fullWidth / water.width / height,
            water.fullHeight / water.height / height,
          );
          wu.f1("uAspect", aspect);
          wu.f4("uPhase", ripples[0], ripples[1], ripples[2], ripples[3]);
          wu.v3("uWater", pal.water);
          wu.v3("uRock", pal.rock);
          wu.v3("uSnow", pal.snow);
          wu.v3("uSkyLow", pal.skyLow);
          wu.f3("uLamp", lampX, lampY, lamp);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rocksTable.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, sky.texture);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          water.blit(width, waterHeight);

          // 4. Rocks and lantern, premultiplied, over the bottom of the frame.
          gl.viewport(0, 0, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          scissor(0, 0, aspect, layout.top);
          gl.useProgram(rockProgram);
          gl.bindTexture(gl.TEXTURE_2D, rocksTable.texture);
          ru.f1("uPx", 1 / height);
          ru.f1("uAspect", aspect);
          ru.f1("uColW", aspect / ROCK_COLUMNS);
          ru.v3("uRock", pal.rock);
          ru.v3("uSnow", pal.snow);
          ru.v3("uSkyLow", pal.skyLow);
          ru.f3("uLamp", lampX, lampY, lamp);
          ru.f3("uFoot", layout.lanternX, layout.lanternY, p.lantern ? 1 : 0);
          ru.f1("uWindow", Math.max(lamp, p.lantern ? 0.8 * flame.bright[0] : 0));
          triangle.draw();

          // 5. Steam over the water.
          const tex = field.texture;
          if (tex) {
            const s = layout.steam;
            scissor(s[0], s[1], s[2], s[3]);
            gl.useProgram(steamProgram);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            su.f1("uPx", 1 / height);
            su.f4("uBox", s[0], s[1], 1 / (s[2] - s[0]), 1 / (s[3] - s[1]));
            su.v3("uSteam", pal.steam);
            su.f3("uLamp", lampX, lampY, lamp);
            triangle.draw();
          }
          gl.disable(gl.SCISSOR_TEST);

          // 6. Snow, fading out in the steam and the water.
          f.count = Math.round(
            clamp(Number.isFinite(p.snow) ? p.snow : 0, 0, 1) * MAX_SPRING_FLAKES,
          );
          const visible = flakes.step(step, f, flakeRenderer.data, flakeRenderer.stride);
          if (visible > 0) {
            flakeRenderer.upload(visible);
            flakeRenderer.draw(0, visible, width, height, pal.flake, maskTexture);
          }

          // 7. The lantern's glow, additive.
          if (lamp > 0) {
            gl.enable(gl.SCISSOR_TEST);
            scissor(lampX - GLOW_R, lampY - GLOW_R, lampX + GLOW_R, lampY + GLOW_R);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(glowProgram);
            gu.f1("uPx", 1 / height);
            gu.f3("uLamp", lampX, lampY, lamp);
            triangle.draw();
            gl.disable(gl.SCISSOR_TEST);
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
