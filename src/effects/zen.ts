import {
  coverageThreshold,
  createRegionLayout,
  DRIFT_SPEED,
  gustLevel,
  LAYERS,
  layoutRegion,
  MID_WEIGHT,
  NEAR_WEIGHT,
  NOISE_PERIOD,
  NOISE_SEEDS,
  NOISE_SIZE,
  REGION_SOFT,
  softnessWidth,
  sunBasis,
  swayOffset,
} from "./dapple-sim";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createChangeKey } from "./change-key";
import { clamp, fract } from "./math";
import { buildPeriodicNoiseTexture, createNoise } from "./noise";
import { zenMeta, SPACING_MIN, MAX_STONES, SPACING_MAX } from "./zen.meta";
import { defineEffect } from "./types";
import {
  BOX_N,
  createRerake,
  fillStoneLayout,
  GAP,
  placeStones,
  RERAKE_BAND,
  RING_STEEP,
  STONE_FLOATS,
  stepRerake,
  sweepX,
  WAVE_FLOATS,
  waveLayout,
} from "./zen-sim";

/** Groove shading: slope (light-facing side) and crest brightness amplitudes. */
const RIDGE = 0.15;
const CREST = 0.04;
/** Grooves fade to flat between these frequencies (cycles per screen px). */
const AA_START = 0.18;
const AA_END = 0.4;
/** Gravel grain: texel size in reference px, and contrast (kept low: grain is codec-hostile). */
const GRAIN_TEXEL = 0.9;
const GRAIN = 0.05;
/** Moss and stone mottling: noise tile in reference px. */
const MOSS_TILE = 80;
/** Light from the upper left (y down), in the plane and in 3D. */
const LIGHT_X = -0.6;
const LIGHT_Y = -0.8;
const LIGHT3 = [-0.45, -0.6, 0.66].map((v, _, a) => v / Math.hypot(a[0], a[1], a[2]));
/** Stones: base colour, ambient and diffuse light, and the contact shadow's depth. */
const STONE_RGB = [0.3, 0.29, 0.28];
const MOSS_RGB = [0.3, 0.4, 0.15];
const CONTACT = 0.45;
/** Leaf shade colour (multiplies the lit garden) and the canopy's fixed look. */
const SHADE_RGB = [0.56, 0.6, 0.7];
const LEAF_COVERAGE = 0.45;
const LEAF_SOFTNESS = 0.6;
const LEAF_SWAY = 0.5;
const LEAF_GUSTS = 0.4;
const SUN_ANGLE = 20;
/** Grain channel: lattice cells across the texture (fine), and its seed. */
const GRAIN_PERIOD = 64;
const GRAIN_SEED = 501;

const vec3 = (v: readonly number[]) => `vec3(${v.map(glslFloat).join(", ")})`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
/** Canopy near (r), mid (g) and far (b, for moss) noise, and fine grain (a). */
uniform sampler2D uNoise;
/** Reference-unit position (1080 tall, y down) = gl_FragCoord.xy * xy + zw. */
uniform vec4 uPix;
/** Screen px per reference px, and 1 / (spacing * that): groove cycles per screen px per |∇θ|. */
uniform vec2 uRes;
/** Spacing and 2π / spacing. */
uniform vec2 uSpacing;
uniform int uCount;
/** Per stone: centre, radius. Look: two wobble phases, tone, moss amount. */
uniform vec4 uStone[${String(MAX_STONES)}];
uniform vec4 uLook[${String(MAX_STONES)}];
/** Per layout (old, then new) per stone: crest value, line slope, 1 / g, ring radius. */
uniform vec4 uLay[${String(2 * MAX_STONES)}];
/** Per layout: two sines (amplitude, wavenumber, phase). */
uniform vec3 uWave[4];
/** Rerake sweep line x and 1 / band width. */
uniform vec2 uSweep;
uniform vec3 uGravel;
/** Leaf shadows: sun basis, layer scales, layer offsets, spot thresholds, region, strength. */
uniform vec4 uBasis;
uniform vec2 uLeafScale;
uniform vec4 uLeafOff;
uniform vec2 uSpot;
uniform vec4 uRegion;
uniform float uShadow;
out vec4 outColor;

const int MAX_STONES = ${String(MAX_STONES)};
const vec2 LIGHT2 = vec2(${glslFloat(LIGHT_X)}, ${glslFloat(LIGHT_Y)});
const vec3 LIGHT3 = ${vec3(LIGHT3)};
${DITHER_GLSL}

/**
 * Rake phase field θ of layout lay (0 old, 1 new) at p, and its gradient: the
 * wavy straight field, with each stone's rings and hairpins spliced in. The shader
 * twin of rakePhase in zen-sim.ts.
 */
float rakePhase(vec2 p, int lay, out vec2 grad) {
  vec3 w0 = uWave[lay * 2];
  vec3 w1 = uWave[lay * 2 + 1];
  float a0 = w0.y * p.x + w0.z;
  float a1 = w1.y * p.x + w1.z;
  float phi = p.y + w0.x * sin(a0) + w1.x * sin(a1);
  vec2 gs = vec2(w0.x * w0.y * cos(a0) + w1.x * w1.y * cos(a1), 1.0);
  float th = phi;
  grad = gs;
  for (int i = 0; i < MAX_STONES; i++) {
    if (i >= uCount) break;
    vec4 L4 = uLay[lay * MAX_STONES + i];
    vec2 q = p - uStone[i].xy;
    float rz = L4.w;
    float inv = L4.z;
    float n = (phi - L4.x) * inv;
    float t = (q.x - L4.y * q.y) * inv;
    float gap = ${glslFloat(GAP)} * rz;
    if (abs(t) >= gap || abs(n) >= ${glslFloat(BOX_N)} * rz) continue;
    float r = max(length(q), 1e-3);
    float ring = r + ${glslFloat(RING_STEEP)} * max(r - rz, 0.0);
    float u = gap - abs(t);
    float d = max(sqrt(u * u + n * n), 1e-3);
    float level = max(abs(n), rz);
    float s = n >= 0.0 ? 1.0 : -1.0;
    vec2 gn = gs * inv;
    float l;
    vec2 gL;
    if (ring <= d && ring <= level) {
      l = ring;
      gL = q * ((r > rz ? ${glslFloat(1 + RING_STEEP)} : 1.0) / r);
    } else if (d <= level) {
      l = d;
      gL = ((u * sign(t) * inv) * vec2(-1.0, L4.y) + n * gn) / d;
    } else {
      l = level;
      gL = abs(n) > rz ? s * gn : vec2(0.0);
    }
    float g = 1.0 / inv;
    th += s * g * l - g * n;
    grad += s * g * gL - gs;
  }
  return th;
}

/** Brightness change from the grooves: lit slopes, bright crests, faded out when too fine. */
float groove(float th, vec2 g) {
  float ph = th * uSpacing.y;
  float aa = 1.0 - smoothstep(${glslFloat(AA_START)}, ${glslFloat(AA_END)}, length(g) * uRes.y);
  return aa * (${glslFloat(RIDGE)} * sin(ph) * dot(g, LIGHT2) + ${glslFloat(CREST)} * cos(ph));
}

void main() {
  vec2 p = gl_FragCoord.xy * uPix.xy + uPix.zw;

  // Rake lines: the old pattern ahead of the sweep, the new one behind it.
  float wNew = clamp((uSweep.x - p.x) * uSweep.y + 0.5, 0.0, 1.0);
  float shade = 0.0;
  vec2 g;
  if (wNew < 1.0) {
    float th = rakePhase(p, 0, g);
    shade += (1.0 - wNew) * groove(th, g);
  }
  if (wNew > 0.0) {
    float th = rakePhase(p, 1, g);
    shade += wNew * groove(th, g);
  }
  float grain = texture(uNoise, p * ${glslFloat(1 / (NOISE_SIZE * GRAIN_TEXEL))}).a;
  vec3 col = uGravel * (1.0 + shade + ${glslFloat(GRAIN)} * (grain - 0.5) * 2.0);

  // Stones: wobbly domes with a contact shadow and a mossy base.
  float contact = 1.0;
  vec4 stone = vec4(0.0);
  float moss = 0.0;
  float mossLight = 1.0;
  float mottle = 0.5;
  for (int i = 0; i < MAX_STONES; i++) {
    if (i >= uCount) break;
    vec4 st = uStone[i];
    vec2 q = p - st.xy;
    float R = st.z;
    if (dot(q, q) > 3.4 * R * R) continue;
    vec2 qs = q - vec2(0.13, 0.18) * R;
    contact *= 1.0 - ${glslFloat(CONTACT)} * (1.0 - smoothstep(0.8, 1.5, length(qs) / R));
    vec4 lk = uLook[i];
    float r = length(q);
    float a = atan(q.y, q.x);
    float re = R * (1.0 + 0.06 * sin(2.0 * a + lk.x) + 0.035 * sin(3.0 * a + lk.y));
    float t = r / re;
    float mn = texture(uNoise, p * ${glslFloat(1 / MOSS_TILE)} + lk.xy * 0.37).b;
    float band = smoothstep(0.7, 0.95, t) * (1.0 - smoothstep(1.03, 1.22, t));
    moss = max(moss, lk.w * band * smoothstep(0.44, 0.6, mn));
    mottle = mn;
    float cov = clamp((re - r) * uRes.x + 0.5, 0.0, 1.0);
    if (cov > 0.0) {
      float z = sqrt(max(1.0 - t * t, 0.0));
      vec3 nrm = normalize(vec3(q / re, 0.9 * z + 0.05));
      float diff = max(dot(nrm, LIGHT3), 0.0);
      float lit = 0.35 + 0.85 * diff;
      vec3 c = ${vec3(STONE_RGB)} * (lk.z * (0.8 + 0.4 * mn) * lit) + 0.05 * pow(diff, 6.0);
      stone = vec4(c, cov);
      mossLight = lit;
    }
  }
  col *= contact;
  col = mix(col, stone.rgb, stone.a);
  col = mix(col, ${vec3(MOSS_RGB)} * (mix(1.0, mossLight, stone.a) * (0.8 + 0.4 * mottle)), moss);

  // Leaf shadows from an unseen tree on one side (the canopy noise of "Dappled sunlight").
  float top = 1.0 - smoothstep(uRegion.x - ${glslFloat(REGION_SOFT)}, uRegion.x + ${glslFloat(REGION_SOFT)}, p.y);
  float dd = (uRegion.y - p.x) * uRegion.z;
  float side = abs(uRegion.z)
    * (1.0 - smoothstep(uRegion.w - ${glslFloat(REGION_SOFT)}, uRegion.w + ${glslFloat(REGION_SOFT)}, dd));
  float amount = uShadow * (1.0 - (1.0 - top) * (1.0 - side));
  if (amount > 0.002) {
    vec2 qq = mat2(uBasis) * p;
    float nNear = texture(uNoise, qq * uLeafScale.x + uLeafOff.xy).r;
    float nMid = texture(uNoise, qq * uLeafScale.y + uLeafOff.zw).g;
    float lit = smoothstep(uSpot.x, uSpot.y,
      ${glslFloat(NEAR_WEIGHT)} * nNear + ${glslFloat(MID_WEIGHT)} * nMid);
    col *= mix(vec3(1.0), ${vec3(SHADE_RGB)}, amount * (1.0 - lit));
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A top-down raked gravel garden: wavy parallel rake lines that turn into
 * concentric rings round a few mossy stones, with soft leaf shadows swaying over
 * one side and, every few minutes, a slow rake sweep that redraws the lines in a
 * new wave shape. One full-screen pass: the rake field is analytic (a couple of
 * sines plus a short per-stone term near each stone), shaded from its analytic
 * gradient; one grain fetch, plus two canopy fetches in the shadow region and one
 * moss fetch near stones.
 */
export const zen = defineEffect(zenMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uNoise",
        "uPix",
        "uRes",
        "uSpacing",
        "uCount",
        "uStone",
        "uLook",
        "uLay",
        "uWave",
        "uSweep",
        "uGravel",
        "uBasis",
        "uLeafScale",
        "uLeafOff",
        "uSpot",
        "uRegion",
        "uShadow",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, [
            { period: NOISE_PERIOD, seed: NOISE_SEEDS[0] },
            { period: NOISE_PERIOD, seed: NOISE_SEEDS[1] },
            { period: NOISE_PERIOD, seed: NOISE_SEEDS[2] },
            { period: GRAIN_PERIOD, seed: GRAIN_SEED },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const pos = new Float32Array(MAX_STONES * STONE_FLOATS);
      const look = new Float32Array(MAX_STONES * STONE_FLOATS);
      const oldWave = new Float32Array(WAVE_FLOATS);
      const newWave = new Float32Array(WAVE_FLOATS);
      const waveData = new Float32Array(2 * WAVE_FLOATS);
      const oldLay = new Float32Array(MAX_STONES * STONE_FLOATS);
      const newLay = new Float32Array(MAX_STONES * STONE_FLOATS);
      const layData = new Float32Array(2 * MAX_STONES * STONE_FLOATS);
      const stoneKey = createChangeKey(2);
      const layKey = createChangeKey(5);
      const rerake = createRerake();
      let placed = 0;
      let lastSeed = Number.NaN;

      // Leaf shadows: dapple's canopy, its near and mid layers.
      const noise = createNoise(50);
      const region = createRegionLayout();
      const basis = sunBasis(new Float32Array(4), SUN_ANGLE);
      const sway = new Float64Array(2);
      const leafOff = new Float64Array(4);
      const leafScale = [1 / (LAYERS[0].cell * NOISE_PERIOD), 1 / (LAYERS[1].cell * NOISE_PERIOD)];
      const leafBase = [0.21, 0.66, 0.48, 0.09];
      const spotWidth = softnessWidth(LEAF_SOFTNESS);
      const spot = coverageThreshold(LEAF_COVERAGE, spotWidth);

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      // CPU-only time, kept unwrapped in float64.
      let time = 0;

      return {
        resize(v) {
          ({ width, height } = v);
          scale = v.scale > 0 ? v.scale : height / 1080;
          refWidth = width / scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          gl.useProgram(program);

          const seed = Math.round(clamp(p.seed, 1, 1e6)) || 1;
          if (seed !== lastSeed) {
            // A new layout starts afresh, without a sweep under way.
            lastSeed = seed;
            rerake.idle = 0;
            rerake.progress = -1;
            rerake.generation = 0;
          }
          stepRerake(rerake, step, p.rerake);

          stoneKey.set(0, seed);
          stoneKey.set(1, refWidth);
          if (stoneKey.take()) {
            placed = placeStones(pos, look, seed, refWidth);
            gl.uniform4fv(u.loc.uStone, pos);
            gl.uniform4fv(u.loc.uLook, look);
            layKey.invalidate();
          }
          u.i1("uCount", Math.min(placed, clamp(Math.round(p.stones), 0, MAX_STONES) || 0));

          const spacing = clamp(p.spacing, SPACING_MIN, SPACING_MAX) || 16;
          const waviness = clamp(p.waviness, 0, 1) || 0;
          layKey.set(0, seed);
          layKey.set(1, rerake.generation);
          layKey.set(2, waviness);
          layKey.set(3, spacing);
          layKey.set(4, placed);
          if (layKey.take()) {
            waveLayout(oldWave, seed, rerake.generation, waviness);
            waveLayout(newWave, seed, rerake.generation + 1, waviness);
            waveData.set(oldWave, 0);
            waveData.set(newWave, WAVE_FLOATS);
            fillStoneLayout(oldLay, oldWave, pos, placed, spacing);
            fillStoneLayout(newLay, newWave, pos, placed, spacing);
            layData.set(oldLay, 0);
            layData.set(newLay, oldLay.length);
            gl.uniform3fv(u.loc.uWave, waveData);
            gl.uniform4fv(u.loc.uLay, layData);
          }

          const inv = 1 / scale;
          u.f4("uPix", inv, -inv, 0, height * inv);
          u.f2("uRes", scale, 1 / (spacing * scale));
          u.f2("uSpacing", spacing, (2 * Math.PI) / spacing);
          u.f2("uSweep", sweepX(rerake, refWidth), 1 / RERAKE_BAND);
          u.rgb("uGravel", p.gravel);

          // Leaf shadows sway and drift as in dapple.ts.
          const gust = gustLevel(noise, time, LEAF_GUSTS);
          for (let i = 0; i < 2; i++) {
            swayOffset(sway, noise, i, time, LEAF_SWAY, gust);
            const ox = sway[0] + time * DRIFT_SPEED * LAYERS[i].drift;
            const oy = sway[1];
            const s = leafScale[i];
            leafOff[i * 2] = fract(leafBase[i * 2] - s * (basis[0] * ox + basis[2] * oy));
            leafOff[i * 2 + 1] = fract(leafBase[i * 2 + 1] - s * (basis[1] * ox + basis[3] * oy));
          }
          layoutRegion(region, seed % 2 === 0 ? "topLeft" : "topRight", refWidth);
          u.f4("uBasis", basis[0], basis[1], basis[2], basis[3]);
          u.f2("uLeafScale", leafScale[0], leafScale[1]);
          u.f4("uLeafOff", leafOff[0], leafOff[1], leafOff[2], leafOff[3]);
          u.f2("uSpot", spot - spotWidth, spot + spotWidth);
          u.f4("uRegion", region.topY, region.edgeX, region.side, region.sideW);
          u.f1("uShadow", clamp(p.shadows, 0, 1) || 0);

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
