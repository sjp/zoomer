import { createRays, fillRayTable } from "../caustics/caustics-sim";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { fract } from "../math";
import { buildPeriodicNoiseTexture, createRng } from "../noise";
import {
  buildSlopeMap,
  createMotes,
  eyeDepth,
  leafAt,
  moteBrightness,
  MOTE_COUNT,
  rescaleMotes,
  RGB_IOR,
  RIPPLE_A,
  RIPPLE_B,
  RIPPLE_B_ANGLE,
  RIPPLE_B_WEIGHT,
  SKY,
  SLOPE_MAX,
  SLOPE_SIZE,
  stepMotes,
  sunDirection,
  WATER,
  windowRadius,
  WINDOW_Y,
  DEPTH_REF,
  LEAF_LENGTH,
  LEAF_WIDTH,
  type LeafPose,
} from "./snell-sim";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { snellMeta } from "./snell.meta";
import { defineEffect } from "../types";
import { lookup } from "../lookup";

/** Low-res divisors: soft apart from the rim, which the Fresnel falloff softens anyway. */
const DIVISORS = { high: 1, balanced: 1.5, low: 2 } as const;
/** Sky noise: side in texels, and four octaves of lattice periods. */
const NOISE_SIZE = 256;
const NOISE_PERIODS = [4, 8, 16, 32];
/** Cloud plane: noise tiles per unit of `dir.xy / dir.z`, and the cloud drift in tiles/s. */
const CLOUD_SCALE = 0.12;
const CLOUD_DRIFT: readonly [number, number] = [0.0016, 0.0009];
/** Canopy plane: tiles per unit, the sway amplitude (tiles) and its rate (rad/s). */
const CANOPY_SCALE = 0.32;
const CANOPY_SWAY = 0.004;
const CANOPY_SWAY_RATE = 0.35;
/** Light shafts: table columns, shaft count, peak strength at `rays` 1. */
const RAY_COLUMNS = 256;
const RAY_COUNT = 11;
const RAY_STRENGTH = 0.5;
/** Mote glow strength. */
const MOTE_GAIN = 0.55;
/** Leaf opacity. */
const LEAF_ALPHA = 0.9;
/** Seconds a leaf fades over when the param is switched. */
const LEAF_FADE = 1.5;

const C_B = Math.cos(RIPPLE_B_ANGLE);
const S_B = Math.sin(RIPPLE_B_ANGLE);

/**
 * The window, at reduced resolution. Per pixel: two slope-map fetches give the
 * rippled surface normal; the view ray is refracted into air with per-channel
 * Fresnel transmittance (three indices, so the cutoff at the critical angle
 * splits into a rainbow fringe), and the refracted direction looks up the sky
 * (gradient, sun, one cloud fetch, plus one canopy fetch for "Trees"). Outside
 * the window the transmittance is 0 and the reflected deep water shows. Then a
 * floating leaf, water absorption along the slanting path, and the shaft table.
 */
export function windowFragment(trees: boolean): string {
  const canopy = trees
    ? /* glsl */ `
  // Branches overhead: a nearer plane, denser towards the horizon.
  float b = dot(texture(uNoise, t.xy / (t.z + 0.05) * ${glslFloat(CANOPY_SCALE)} + uCloudOff.zw),
    vec4(0.45, 0.3, 0.17, 0.08));
  float th = mix(0.36, 0.6, e);
  col = mix(col, uCanopy, smoothstep(th - 0.025, th + 0.025, b));`
    : "";
  return /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uSlope;
uniform sampler2D uNoise;
uniform sampler2D uRays;
/** Reference position (1080 tall, y down) = gl_FragCoord.xy * xy + zw. */
uniform vec4 uPix;
/** Window centre (reference px), eye depth (reference px), flat-surface window radius. */
uniform vec4 uWin;
/** Slope-map uv per px for layers A and B, peak slope. */
uniform vec3 uRip;
/** Slope-map offsets: layer A (xy), layer B (zw). */
uniform vec4 uRipOff;
uniform vec3 uEta;
uniform vec3 uDeep;
uniform vec3 uHaze;
/** Absorption times depth. */
uniform vec3 uAbsorb;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uCloud;
uniform vec3 uCloudShade;
/** Cloud offset (xy), canopy offset (zw), in noise tiles. */
uniform vec4 uCloudOff;
/** Cloud cover thresholds. */
uniform vec2 uCloudCov;
uniform vec3 uCanopy;
uniform vec3 uRayCol;
/** Leaf centre relative to the window centre (reference px), cos and sin of its angle. */
uniform vec4 uLeaf;
/** Leaf colour and opacity (0: none). */
uniform vec4 uLeafCol;
out vec4 outColor;

vec3 sky(vec3 t) {
  float e = clamp(t.z, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, sqrt(e));
  float sd = max(dot(t, uSunDir), 0.0);
  float sd2 = sd * sd;
  float sd8 = sd2 * sd2;
  sd8 *= sd8;
  float sd64 = sd8 * sd8;
  sd64 *= sd64;
  sd64 *= sd64;
  col += uSunCol * (0.3 * sd8 + 3.0 * sd64 * sd64);
  vec4 nz = texture(uNoise, t.xy / (t.z + 0.12) * ${glslFloat(CLOUD_SCALE)} + uCloudOff.xy);
  float f = dot(nz, vec4(0.45, 0.3, 0.17, 0.08));
  float cov = smoothstep(uCloudCov.x, uCloudCov.y, f) * smoothstep(0.03, 0.3, e);
  col = mix(col, mix(uCloudShade, uCloud, smoothstep(0.35, 0.7, nz.g)), cov);${canopy}
  return col;
}

void main() {
  vec2 P = gl_FragCoord.xy * uPix.xy + uPix.zw - uWin.xy;
  // Rippled surface: layer B is sampled rotated, so its slope is rotated back.
  vec2 gA = texture(uSlope, P * uRip.x + uRipOff.xy).rg;
  vec2 gB = texture(uSlope, mat2(${glslFloat(C_B)}, ${glslFloat(S_B)}, ${glslFloat(-S_B)}, ${glslFloat(C_B)}) * P * uRip.y + uRipOff.zw).rg;
  // Bytes encode 0 as 128 and +-1 as 128 +- 127.
  gA = gA * ${glslFloat(255 / 127)} - ${glslFloat(128 / 127)};
  gB = gB * ${glslFloat(255 / 127)} - ${glslFloat(128 / 127)};
  vec2 g = (gA + mat2(${glslFloat(C_B)}, ${glslFloat(-S_B)}, ${glslFloat(S_B)}, ${glslFloat(C_B)}) * gB * ${glslFloat(RIPPLE_B_WEIGHT)}) * uRip.z;
  vec3 n = normalize(vec3(-g, 1.0));
  vec3 I = normalize(vec3(P, uWin.z));
  float ci = dot(I, n);

  // Fresnel transmittance per channel; exactly 0 past each channel's critical angle.
  vec3 s2 = uEta * uEta * (1.0 - ci * ci);
  vec3 ct = sqrt(max(1.0 - s2, 0.0));
  vec3 rs = (uEta * ci - ct) / (uEta * ci + ct);
  vec3 rp = (ci - uEta * ct) / (ci + uEta * ct);
  vec3 T = 1.0 - 0.5 * (rs * rs + rp * rp);

  // Refracted direction for green; past the cutoff it is unused (T = 0).
  vec3 t = uEta.g * I + (ct.g - uEta.g * ci) * n;
  t.z = max(t.z, 0.02);
  vec3 above = sky(normalize(t));

  // Reflected deep water: darkest looking steeply down, hazier near horizontal.
  vec3 r = I - 2.0 * ci * n;
  float h = 1.0 - clamp(-r.z, 0.0, 1.0);
  vec3 below = mix(uDeep, uHaze, h * h * 0.6);
  vec3 col = above * T + below * (1.0 - T);

  // A leaf floating on the surface: lit through from above wherever it is.
  vec2 q = P - uLeaf.xy;
  q = vec2(q.x * uLeaf.z + q.y * uLeaf.w, q.y * uLeaf.z - q.x * uLeaf.w);
  float lx = q.x * ${glslFloat(1 / LEAF_LENGTH)};
  float edge = abs(q.y) - ${glslFloat(LEAF_WIDTH)} * (1.0 - lx * lx);
  float leaf = (1.0 - smoothstep(-1.0, 1.0, edge)) * step(abs(lx), 1.0);
  float rib = 1.0 - 0.35 * (1.0 - smoothstep(0.4, 1.4, abs(q.y)));
  col = mix(col, uLeafCol.rgb * rib, leaf * uLeafCol.a);

  // Absorption and in-scattering along the slanting path through the water.
  vec3 atten = exp(-uAbsorb / I.z);
  col = mix(uHaze, col, atten);

  // Shafts fanning out from the window, strongest just outside the rim.
  float rad = length(P);
  // atan(0, 0) is undefined; the nudge keeps the window centre's pixel finite.
  float shaft = texture(uRays, vec2(atan(P.x, P.y + 1e-3) *${glslFloat(1 / (2 * Math.PI))} + 0.5, 0.5)).r;
  float out1 = max(rad - uWin.w, 0.0) / uWin.w;
  col += uRayCol * (shaft * smoothstep(0.75, 1.05, rad / uWin.w) * exp(-out1 * 0.8));
  outColor = vec4(col, 1.0);
}
`;
}

const MOTE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aMote;
layout(location = 2) in float aGlow;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vGlow;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vGlow = aGlow;
  gl_Position = pxToClip(aMote.xy + aCorner * aMote.z, uResolution);
}
`;

/** A soft round glow, additive. The sprite reaches three sigmas; the tail is cut at 0. */
const MOTE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in float vGlow;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float d2 = dot(vLocal, vLocal);
  float a = max(exp(-d2 * 4.5) - 0.011, 0.0) * vGlow;
  outColor = vec4(uColor * a, 0.0);
}
`;

const WINDOW_UNIFORMS = [
  "uSlope",
  "uNoise",
  "uRays",
  "uPix",
  "uWin",
  "uRip",
  "uRipOff",
  "uEta",
  "uDeep",
  "uHaze",
  "uAbsorb",
  "uZenith",
  "uHorizon",
  "uSunDir",
  "uSunCol",
  "uCloud",
  "uCloudShade",
  "uCloudOff",
  "uCloudCov",
  "uCanopy",
  "uRayCol",
  "uLeaf",
  "uLeafCol",
] as const;

/**
 * Snell's window: looking straight up from under calm water. The sky is squeezed
 * into a bright rippling circle with a thin rainbow rim, framed by reflected
 * deep water, with light shafts fanning out, glinting motes and the odd leaf
 * drifting across. One reduced-resolution pass plus a few dozen small sprites.
 */
export const snell = defineEffect(snellMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const programs = [false, true].map((trees) => {
        const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, windowFragment(trees));
        const u = createUniforms(gl, program, WINDOW_UNIFORMS);
        gl.useProgram(program);
        u.i1("uSlope", 0);
        u.i1("uNoise", 1);
        u.i1("uRays", 2);
        return u;
      });

      const slopeTex = scope.add(
        createDataTexture(gl, {
          width: SLOPE_SIZE,
          height: SLOPE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildSlopeMap(),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(
            NOISE_SIZE,
            NOISE_PERIODS.map((period, i) => ({ period, seed: 0x5ce1 + i })),
          ),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const rayTable = scope.own(createColumnTable(gl, RAY_COLUMNS, 1, { wrap: gl.REPEAT }));
      const rng = createRng(0x5e11);
      const shafts = createRays(rng, RAY_COUNT);

      const moteProgram = scopedProgram(gl, scope, MOTE_VERTEX, MOTE_FRAGMENT);
      const moteU = createUniforms(gl, moteProgram, ["uResolution", "uColor"]);
      // Per mote: centre x, centre y, sprite half-size (device px, y down), then glow.
      const batch = scope.own(createSpriteBatch(gl, MOTE_COUNT, [3, 1], [polygonStrip(8)]));

      let width = 1;
      let height = 1;
      let vpScale = 1;
      let refWidth = 1920;
      const motes = createMotes(rng, MOTE_COUNT, refWidth);

      // CPU-only time, kept unwrapped in float64; only wrapped offsets reach the shader.
      let time = 0;
      let offAx = 0;
      let offAy = 0;
      let offBx = 0;
      let offBy = 0;
      let cloudX = 0;
      let cloudY = 0;
      /** Leaf opacity, eased when the param is switched. */
      let leafFade = 1;
      const leaf: LeafPose = { x: 0, y: 0, angle: 0 };
      const sun = new Float64Array(3);

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          rescaleMotes(motes, newRefWidth / refWidth);
          refWidth = newRefWidth;
          width = v.width;
          height = v.height;
          vpScale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          offAx = fract(offAx + (RIPPLE_A.drift[0] * step) / RIPPLE_A.tile);
          offAy = fract(offAy + (RIPPLE_A.drift[1] * step) / RIPPLE_A.tile);
          offBx = fract(offBx + (RIPPLE_B.drift[0] * step) / RIPPLE_B.tile);
          offBy = fract(offBy + (RIPPLE_B.drift[1] * step) / RIPPLE_B.tile);
          cloudX = fract(cloudX + CLOUD_DRIFT[0] * step);
          cloudY = fract(cloudY + CLOUD_DRIFT[1] * step);
          const swayX = CANOPY_SWAY * Math.sin(time * CANOPY_SWAY_RATE);
          const swayY = CANOPY_SWAY * 0.6 * Math.sin(time * CANOPY_SWAY_RATE * 0.73 + 1.3);
          leafFade = Math.min(1, Math.max(0, leafFade + (p.leaf ? step : -step) / LEAF_FADE));

          const water = lookup(WATER, p.water, "blue");
          const skyPal = lookup(SKY, p.above, "sky");
          const depthPx = eyeDepth(p.depth);
          const radius = windowRadius(p.depth);
          const cx = refWidth / 2;
          const rays = Math.min(1, Math.max(0, p.rays)) * RAY_STRENGTH;

          // 1. Shaft table.
          fillRayTable(rayTable.data, shafts, time);
          gl.activeTexture(gl.TEXTURE2);
          rayTable.upload();
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, slopeTex);

          // 2. The window at reduced resolution.
          target.resize(width, height, qualityDivisor(p.quality, DIVISORS));
          const lw = target.width;
          const lh = target.height;
          const u = programs[p.above === "trees" ? 1 : 0];
          gl.useProgram(u.program);
          u.f4("uPix", refWidth / lw, -1080 / lh, 0, 1080);
          u.f4("uWin", cx, WINDOW_Y, depthPx, radius);
          u.f3("uRip", 1 / RIPPLE_A.tile, 1 / RIPPLE_B.tile, Math.max(0, p.ripples) * SLOPE_MAX);
          u.f4("uRipOff", offAx, offAy, offBx, offBy);
          u.v3("uEta", RGB_IOR);
          u.v3("uDeep", water.deep);
          u.v3("uHaze", water.haze);
          const d = depthPx / DEPTH_REF;
          u.f3("uAbsorb", water.absorb[0] * d, water.absorb[1] * d, water.absorb[2] * d);
          u.v3("uZenith", skyPal.zenith);
          u.v3("uHorizon", skyPal.horizon);
          sunDirection(sun, skyPal.sunElevation, skyPal.sunAzimuth);
          u.v3("uSunDir", sun);
          u.v3("uSunCol", skyPal.sun);
          u.v3("uCloud", skyPal.cloud);
          u.v3("uCloudShade", skyPal.cloudShade);
          u.f4("uCloudOff", cloudX, cloudY, 0.37 + swayX, 0.61 + swayY);
          u.f2("uCloudCov", skyPal.cloudLo, skyPal.cloudHi);
          u.v3("uCanopy", skyPal.canopy);
          u.f3("uRayCol", water.ray[0] * rays, water.ray[1] * rays, water.ray[2] * rays);
          const leafOn = leafFade > 0 && leafAt(leaf, time, refWidth);
          if (leafOn) {
            u.f4("uLeaf", leaf.x, leaf.y, Math.cos(leaf.angle), Math.sin(leaf.angle));
          }
          const lc = skyPal.leaf;
          u.f4("uLeafCol", lc[0], lc[1], lc[2], leafOn ? LEAF_ALPHA * leafFade : 0);
          target.bind();
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // 3. Motes, additive at full resolution.
          stepMotes(motes, step, refWidth);
          const data = batch.data;
          const stride = batch.stride;
          for (let i = 0; i < MOTE_COUNT; i++) {
            const o = i * stride;
            data[o] = motes.x[i] * vpScale;
            data[o + 1] = motes.y[i] * vpScale;
            // The glow reaches past the mote's radius; at least 1.5 px so it never aliases.
            data[o + 2] = Math.max(1.5, motes.r[i] * 2 * vpScale);
            data[o + 3] =
              MOTE_GAIN * moteBrightness(motes, i, time, cx, WINDOW_Y, Math.max(1, radius));
          }
          batch.upload(MOTE_COUNT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.useProgram(moteProgram);
          moteU.f2("uResolution", width, height);
          moteU.v3("uColor", water.ray);
          batch.draw(0, MOTE_COUNT);
          gl.disable(gl.BLEND);

          // Unbind the low-res texture so it is never sampled while it is a render target.
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
