import { type Rgb, unitRgbMemo } from "./color";
import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createChangeKey } from "./change-key";
import {
  createTableScratch,
  fillLayout,
  fillRidgeTable,
  goldenness,
  HORIZON,
  LAYOUT_FLOATS,
  startPhase,
  sunAt,
  type SunPosition,
  TABLE_CHANNELS,
  TABLE_COLUMNS,
} from "./dunes-sim";
import { createLowResTarget } from "./lowres";
import { clamp, fract } from "./math";
import { dunesMeta, MAX_RIDGES, MIN_RIDGES, MAX_SHADOW_SOFTNESS } from "./dunes.meta";
import { defineEffect } from "./types";

/** Screen distance (height units) per unit of tan(angle) from the view centre. */
const SUN_FOCAL = 0.9;
/** Sun disc radius, height units. */
const SUN_RADIUS = 0.032;
/**
 * Half-width of the shadow penumbra, radians of sun elevation: PENUMBRA_MIN at
 * shadow softness 0, plus PENUMBRA_PER_SOFTNESS per unit (0.45 at the default
 * of 2, 0.87 at the top of the slider). Wider means a longer, gentler fade from
 * light into shadow.
 */
const PENUMBRA_MIN = 0.03;
const PENUMBRA_PER_SOFTNESS = 0.21;
/**
 * The cached dune image is re-rendered when the sun has moved this far (radians).
 * Small next to the penumbra, so shadow edges creep rather than step; the sun disc
 * and glow are drawn every frame and move smoothly regardless.
 */
const SUN_STEP = 0.0015;
/** Ripple phase constant: ripples per unit of 1/depth (see the shader). */
const RIPPLE_K = 20;
/** Height (px) the ripple pixel-size fade is judged at, so ripples look alike at 1080p and up. */
const RIPPLE_REF_HEIGHT = 1080;

const NOON_SUN: Rgb = [1, 0.96, 0.88];
const GOLD_SUN: Rgb = [1, 0.58, 0.3];
const WARM_HORIZON: Rgb = [1, 0.62, 0.38];
const WHITE: Rgb = [1, 1, 1];

/*
 * Scene pass, rendered into a cached full-resolution texture only when something
 * changes. Coordinates are height units, y up (p = gl_FragCoord / height).
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

/** Per ridge, per column: height above base, slope, left and right horizon angles. */
uniform sampler2D uTable;
/** Per ridge: base height, face depth, haze, ripple contrast. */
uniform vec4 uRidge[${String(MAX_RIDGES)}];
uniform int uCount;
/** Table u = p.x * uXMap.x + uXMap.y. */
uniform vec2 uXMap;
/** Canvas height in px, and its reciprocal. */
uniform vec2 uHeight;
/** Height the ripple pixel-size fade uses: min(height, 1080). */
uniform float uRippleHeight;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSand;
uniform vec3 uAmbient;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
/** Weights picking the left or right horizon angle (whichever side the sun is on). */
uniform vec2 uHzSelect;
/** Sun elevation seen across the dunes (radians), penumbra half-width. */
uniform vec2 uShadow;
/** Rim light strength, and 1 / its falloff in px. */
uniform vec2 uRim;

out vec4 outColor;

const int MAX_RIDGES = ${String(MAX_RIDGES)};
const float INV_ROWS = ${glslFloat(1 / MAX_RIDGES)};
const float HORIZON = ${glslFloat(HORIZON)};
const float SKY_GRAD = ${glslFloat(1 / (1 - HORIZON))};
const float RIPPLE_K = ${glslFloat(RIPPLE_K)};
${DITHER_GLSL}
vec3 sky(float y) {
  float t = clamp((y - HORIZON) * SKY_GRAD, 0.0, 1.0);
  return mix(uSkyHorizon, uSkyTop, sqrt(t));
}

/** Shaded colour of a ridge at p, dPx pixels below its edge (T: table texel, R: uRidge). */
vec3 shade(vec4 T, vec4 R, vec2 p, float dPx) {
  // 0 at the crest, 1 deep down the face, where it turns toward the viewer.
  float t = clamp((R.x + T.x - p.y) / R.y, 0.0, 1.0);
  float s = T.y;
  vec3 n = normalize(vec3(-s * (1.0 - 0.6 * t), 1.0, 0.1 + 0.6 * t));
  // Softened (wrapped) Lambert: the sun is usually in front of the viewer, so the
  // faces seen are partly backlit, and plain Lambert would leave them black.
  float diffuse = clamp(dot(n, uSunDir) * 0.75 + 0.25, 0.0, 1.0);
  float hz = dot(T.zw, uHzSelect);
  // Smoothstep of a smoothstep: a softer start and end to the penumbra than a
  // single one, so shadow edges blend in without a visible line.
  float lit = smoothstep(0.0, 1.0, smoothstep(-uShadow.y, uShadow.y, uShadow.x - hz));
  float light = diffuse * lit;
  float albedo = 1.0;
  // Wind ripples: stripes parallel to the crest, crowding with distance (1 / depth),
  // faded out where they would be finer than a few pixels.
  if (R.w > 0.0) {
    float iz = 1.0 / (t + 0.06);
    float perPx = RIPPLE_K * iz * iz / (R.y * uRippleHeight);
    float fade = R.w * smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.15, 0.35, perPx));
    if (fade > 0.0) {
      float q = RIPPLE_K * iz + 0.5 * sin(p.x * 11.0 + t * 5.0);
      float r = fade * sin(6.2831853 * q);
      light *= 1.0 + r;
      albedo += 0.2 * r;
    }
  }
  vec3 col = uSand * (uAmbient * albedo + uSunColor * light);
  // Rim light hugging lit crests when the sun is low.
  col += uSunColor * (uRim.x * lit * exp(-max(dPx, 0.0) * uRim.y));
  // Aerial perspective: distant ridges fade toward the horizon colour.
  return mix(col, uSkyHorizon, R.z);
}

void main() {
  vec2 p = gl_FragCoord.xy * uHeight.y;
  float u = p.x * uXMap.x + uXMap.y;
  // Nearest ridge covering the pixel, then (at its anti-aliased edge) the next one.
  vec4 T0 = vec4(0.0), R0 = vec4(0.0), T1 = vec4(0.0), R1 = vec4(0.0);
  float d0 = 0.0, d1 = 0.0, c0 = 0.0, c1 = 0.0;
  int found = 0;
  for (int i = 0; i < MAX_RIDGES; i++) {
    if (i >= uCount) break;
    vec4 R = uRidge[i];
    vec4 T = textureLod(uTable, vec2(u, (float(i) + 0.5) * INV_ROWS), 0.0);
    float dPx = (R.x + T.x - p.y) * uHeight.x * inversesqrt(1.0 + T.y * T.y);
    float c = clamp(dPx + 0.5, 0.0, 1.0);
    if (c <= 0.0) continue;
    if (found == 0) {
      T0 = T; R0 = R; d0 = dPx; c0 = c;
      found = 1;
      if (c >= 1.0) break;
    } else {
      T1 = T; R1 = R; d1 = dPx; c1 = c;
      found = 2;
      break;
    }
  }
  vec3 col;
  // Alpha is the sky's coverage, where the per-frame pass adds the sun.
  float skyA;
  if (found == 0) {
    col = sky(p.y);
    skyA = 1.0;
  } else if (c0 >= 1.0) {
    col = shade(T0, R0, p, d0);
    skyA = 0.0;
  } else {
    vec3 back = sky(p.y);
    skyA = 1.0 - c0;
    if (found == 2) {
      back = mix(back, shade(T1, R1, p, d1), c1);
      skyA *= 1.0 - c1;
    }
    col = mix(back, shade(T0, R0, p, d0), c0);
  }
  outColor = vec4(clamp(col + dither8(gl_FragCoord.xy), 0.0, 1.0), skyA);
}
`;

/**
 * Per-frame pass: copies the cached scene and adds the sun disc and glow, so the
 * sun moves smoothly while the dunes re-render only every SUN_STEP.
 */
const COMPOSITE = /* glsl */ `
${DITHER_GLSL}
/** Sun centre in px (gl_FragCoord space). */
uniform vec2 uSunPx;
/** Disc radius in px, and 1 / its edge softness. */
uniform vec2 uSunR;
uniform vec3 uDisc;
uniform vec3 uGlow;
/** Glow falloffs (1/px): tight and broad. */
uniform vec2 uGlowFall;
vec4 composite(vec2 uv) {
  vec4 c = texelFetch(uLowRes, ivec2(gl_FragCoord.xy), 0);
  float r = length(gl_FragCoord.xy - uSunPx);
  vec3 glow = uGlow * (0.55 * exp(-r * uGlowFall.x) + 0.45 * exp(-r * uGlowFall.y));
  // Sky gets the full glow and the disc; the dunes a little haze glow.
  vec3 col = c.rgb + glow * mix(0.25, 1.0, c.a);
  float disc = clamp((uSunR.x - r) * uSunR.y + 0.5, 0.0, 1.0) * c.a;
  col = mix(col, uDisc, disc);
  return vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

const mixInto = (out: Rgb, a: Rgb, b: Rgb, t: number, k = 1) => {
  out[0] = (a[0] + (b[0] - a[0]) * t) * k;
  out[1] = (a[1] + (b[1] - a[1]) * t) * k;
  out[2] = (a[2] + (b[2] - a[2]) * t) * k;
  return out;
};

/**
 * Desert dunes receding to the horizon under a clear sky. Each ridge is a 1D
 * height profile in a small lookup table (height, slope and shadow horizon angles
 * per column); one full-screen pass shades the nearest covering ridge with Lambert
 * light, cast shadows, crest rim light, fine ripples and aerial perspective. The
 * sun drifts over minutes, so that pass is cached and re-rendered only when the
 * sun has moved a little; each frame just copies it and draws the sun.
 */
export const dunes = defineEffect(dunesMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const table = scope.own(
        createColumnTable(gl, TABLE_COLUMNS, TABLE_CHANNELS, { rows: MAX_RIDGES }),
      );
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE, dither: false }));
      const u = createUniforms(gl, program, [
        "uTable",
        "uRidge",
        "uCount",
        "uXMap",
        "uHeight",
        "uRippleHeight",
        "uSkyTop",
        "uSkyHorizon",
        "uSand",
        "uAmbient",
        "uSunColor",
        "uSunDir",
        "uHzSelect",
        "uShadow",
        "uRim",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uSunPx",
        "uSunR",
        "uDisc",
        "uGlow",
        "uGlowFall",
      ]);
      gl.useProgram(program);
      u.i1("uTable", 0);
      gl.useProgram(null);

      const toRgb = unitRgbMemo();
      const scratch = createTableScratch();
      const layout = new Float32Array(MAX_RIDGES * LAYOUT_FLOATS);
      const tableKey = createChangeKey(4);
      const layoutKey = createChangeKey(2);
      const sun: SunPosition = { elevation: 0, azimuth: 0 };
      const skyHorizon: Rgb = [0, 0, 0];
      const sunColor: Rgb = [0, 0, 0];
      const ambient: Rgb = [0, 0, 0];
      const glow: Rgb = [0, 0, 0];
      const disc: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      let sizeDirty = true;
      /** Sun cycle progress added to the start phase, kept in [0, 1) (the path has period 1). */
      let drift = 0;
      /** Sun position the cached scene was shaded with; NaN forces a first render. */
      let shownElevation = Number.NaN;
      let shownAzimuth = Number.NaN;
      /** Set by `track` when any scene uniform uploads, meaning the cache is stale. */
      let changed = false;
      const track = (uploaded: boolean) => {
        if (uploaded) changed = true;
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          sizeDirty = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          changed = false;
          if (sizeDirty) {
            target.resize(width, height, 1);
            sizeDirty = false;
            changed = true;
          }
          const count = clamp(Math.round(p.ridges), MIN_RIDGES, MAX_RIDGES);
          const aspect = width / height;

          // Sun: the start phase sets the height, drift carries it round the cycle.
          if (p.sunDrift) drift = fract(drift + dt / (Math.max(1, p.driftSpeed) * 60));
          sunAt(startPhase(p.sunHeight) + drift, sun);
          const el = sun.elevation;
          const az = sun.azimuth;
          // The cached scene follows the sun in small steps (exactly when not drifting).
          if (
            !p.sunDrift ||
            !(Math.abs(el - shownElevation) < SUN_STEP && Math.abs(az - shownAzimuth) < SUN_STEP)
          ) {
            shownElevation = el;
            shownAzimuth = az;
          }

          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          tableKey.set(0, count);
          tableKey.set(1, aspect);
          tableKey.set(2, p.seed);
          tableKey.set(3, p.crestSoftness);
          if (tableKey.take()) {
            fillRidgeTable(table.data, count, aspect, p.seed, scratch, p.crestSoftness);
            table.upload();
            changed = true;
          } else {
            gl.bindTexture(gl.TEXTURE_2D, table.texture);
          }
          layoutKey.set(0, count);
          layoutKey.set(1, p.ripples);
          if (layoutKey.take()) {
            fillLayout(layout, count, p.ripples);
            gl.uniform4fv(u.loc.uRidge, layout);
            changed = true;
          }
          track(u.i1("uCount", count));
          // Column j sits at x = j / (cols - 1) * aspect; texel centres at (j + 0.5) / cols.
          track(u.f2("uXMap", (TABLE_COLUMNS - 1) / (aspect * TABLE_COLUMNS), 0.5 / TABLE_COLUMNS));
          track(u.f2("uHeight", height, 1 / height));
          track(u.f1("uRippleHeight", Math.min(height, RIPPLE_REF_HEIGHT)));

          // Lighting from the cached sun position.
          const sinE = Math.sin(shownElevation);
          const cosE = Math.cos(shownElevation);
          const g = goldenness(sinE);
          const top = toRgb(p.skyTop);
          mixInto(skyHorizon, toRgb(p.skyHorizon), WARM_HORIZON, 0.5 * g);
          mixInto(sunColor, NOON_SUN, GOLD_SUN, g, 0.95);
          mixInto(ambient, skyHorizon, top, 0.55, 0.42);
          track(u.v3("uSkyTop", top));
          track(u.v3("uSkyHorizon", skyHorizon));
          track(u.rgb("uSand", p.sandColor));
          track(u.v3("uAmbient", ambient));
          track(u.v3("uSunColor", sunColor));
          const sx = Math.sin(shownAzimuth) * cosE;
          track(u.f3("uSunDir", sx, sinE, -Math.cos(shownAzimuth) * cosE));
          track(u.f2("uHzSelect", sx < 0 ? 1 : 0, sx < 0 ? 0 : 1));
          const penumbra =
            PENUMBRA_MIN + PENUMBRA_PER_SOFTNESS * clamp(p.shadowSoftness, 0, MAX_SHADOW_SOFTNESS);
          track(u.f2("uShadow", Math.atan2(sinE, Math.abs(sx)), penumbra));
          track(u.f2("uRim", 0.5 * g, 1 / (6 * scale)));

          if (changed) {
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          // Sun disc and glow at the live (unquantised) sun position.
          gl.useProgram(target.program);
          const live = goldenness(Math.sin(el));
          const sunX = aspect / 2 + SUN_FOCAL * Math.tan(az);
          const sunY = HORIZON + (SUN_FOCAL * Math.tan(el)) / Math.cos(az);
          cu.f2("uSunPx", sunX * height, sunY * height);
          cu.f2("uSunR", SUN_RADIUS * height, 1 / (1.5 * scale));
          mixInto(sunColor, NOON_SUN, GOLD_SUN, live, 0.95);
          cu.v3("uDisc", mixInto(disc, sunColor, WHITE, 0.7));
          cu.v3("uGlow", mixInto(glow, sunColor, sunColor, 0, 0.25 + 0.3 * live));
          cu.f2("uGlowFall", 1 / (0.06 * height), 1 / (0.35 * height));
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
