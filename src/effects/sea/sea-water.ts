/**
 * The Calm Sea's water pass, shared with the Lighthouse Lamp Room: a moonlit or
 * sunlit sea seen through a pinhole camera looking level, rendered at reduced
 * resolution over the rows below the horizon. It owns the swells, the ripple
 * slope texture and the distant headland's table, and draws into whatever
 * framebuffer and viewport the caller has bound.
 */
import type { Rgb } from "../color";
import {
  createColumnTable,
  createDataTexture,
  createProgram,
  createUniforms,
  type FullscreenTriangle,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "../gl";
import type { SkyState } from "../horizon/horizon-sim";
import { wrap } from "../math";
import {
  advanceSwellPhases,
  buildHeadland,
  buildRippleSlopes,
  LAND_COLUMNS,
  resolveSwells,
  WATER_F0,
} from "./sea-sim";

const RIPPLE_SIZE = 256;
/** World size (m) of one ripple texture period for the two layers. */
const RIPPLE_TILE_A = 20;
const RIPPLE_TILE_B = 7;
/** Ripple layer B's rotation against layer A, radians. */
const RIPPLE_ROT_B = 0.7;
/** RMS slope of each ripple layer at `wind` = 1. */
const RIPPLE_RMS_A = 0.06;
const RIPPLE_RMS_B = 0.045;
/** Ripple drift velocities (m/s) at `wind` = 1, in each layer's own texture axes. */
const RIPPLE_DRIFT_A: readonly [number, number] = [0.12, -0.32];
const RIPPLE_DRIFT_B: readonly [number, number] = [-0.28, -0.2];

/**
 * Analytic sky in "frame heights" from the horizon centre: the horizon-to-zenith
 * gradient and the two-term sun glow of horizon.ts. Shared by the water (for its
 * reflections) and the effects' own sky passes, so they match exactly.
 */
export const SEA_SKY_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
/** Sun or moon centre (frame heights from the horizon centre), glow strength, 1 / sky height. */
uniform vec4 uSkyA;
vec3 sky(vec2 q) {
  float t = clamp(q.y * uSkyA.w, 0.0, 1.0);
  t = t * (2.0 - t);
  vec3 col = mix(uHorizon, uZenith, t);
  float d = length(q - uSkyA.xy);
  float glow = uSkyA.z * (0.5 * exp2(-9.0 * d) + 0.5 * exp2(-2.2 * d) * (1.0 - 0.7 * t));
  return mix(col, uGlow, min(glow, 1.0));
}
`;

/**
 * Water, at reduced resolution over the rows below the horizon. The view ray hits
 * the plane y = 0 analytically; three sine swells (analytic gradient) and two
 * ripple slope fetches perturb the normal, each faded out as the pixel's footprint
 * on the water outgrows it. The variance faded out widens the glitter lobe instead,
 * so the far glitter path is a smooth band rather than aliased sparkle.
 */
const WATER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uRipples;
uniform sampler2D uLand;
/** Full-res px per low-res px (x, y). */
uniform vec2 uLowToFull;
/** Centre x, horizon y (full px), 1 / focal (full px), focal in frame heights. */
uniform vec4 uView;
/** Camera height (m), footprint factor (m per low-res px per z²), frame height / width. */
uniform vec3 uCam;
/** Per swell: wave vector (rad/m), height amplitude (m), phase. */
uniform vec4 uWave[3];
/** Per swell: (k / 2)², for its footprint fade. */
uniform vec3 uWaveFade;
/** Ripple layer offsets in texture periods: A.xy, B.xy. */
uniform vec4 uRipOff;
uniform mat2 uRipRot;
/** 1 / tile size A and B (1/m), slope scale A and B. */
uniform vec4 uRip;
/** 1 / cell size A and B (1/m), slope variance A and B. */
uniform vec4 uRipFade;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
/** Base m², reflectance cap. */
uniform vec2 uRough;
uniform vec3 uDeep;
uniform vec3 uLandColor;
/** Land on (0 or 1), mirrored (0 or 1). */
uniform vec2 uLandMap;
out vec4 outColor;
${SEA_SKY_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy * uLowToFull;
  vec2 s = (p - uView.xy) * uView.z;
  // Rows at or above the horizon continue the far water, so the upscale stays smooth.
  s.y = min(s.y, -1e-4);
  float z = uCam.x / -s.y;
  vec2 P = vec2(s.x * z, z);
  float fp = z * z * uCam.y;

  // Swells: analytic gradient, each faded as its wavelength falls below the footprint.
  vec2 g = vec2(0.0);
  float lost = 0.0;
  vec3 fade = 1.0 / (1.0 + fp * fp * uWaveFade);
  for (int i = 0; i < 3; i++) {
    vec4 w = uWave[i];
    float a = w.z * fade[i];
    g += w.xy * (a * cos(dot(w.xy, P) + w.w));
    lost += 0.5 * dot(w.xy, w.xy) * (w.z * w.z - a * a);
  }

  // Ripples: two fetches at two scales, drifting in different directions.
  vec2 rf = clamp(1.5 - fp * uRipFade.xy, 0.0, 1.0);
  vec2 ra = texture(uRipples, P * uRip.x + uRipOff.xy).rg * 2.0 - 1.0;
  vec2 rb = texture(uRipples, (uRipRot * P) * uRip.y + uRipOff.zw).rg * 2.0 - 1.0;
  g += ra * (uRip.z * rf.x) + (rb * uRipRot) * (uRip.w * rf.y);
  lost += dot(uRipFade.zw, 1.0 - rf * rf);

  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 d = normalize(vec3(s, 1.0));
  vec3 r = reflect(d, n);
  r.y = max(r.y, 0.0);
  vec2 q = r.xy / max(r.z, 1e-3) * uView.w;
  vec3 refl = sky(q);
  if (uLandMap.x > 0.5) {
    float u = 0.5 + q.x * uCam.z;
    u = mix(u, 1.0 - u, uLandMap.y);
    float lh = texture(uLand, vec2(u, 0.5)).r;
    refl = mix(refl, uLandColor, smoothstep(0.0, 0.003, lh - q.y));
  }

  // Schlick Fresnel, capped.
  float m = 1.0 - max(dot(n, -d), 0.0);
  float m2 = m * m;
  float F = min(${glslFloat(WATER_F0)} + ${glslFloat(1 - WATER_F0)} * m2 * m2 * m, uRough.y);
  vec3 col = mix(uDeep, refl, F);

  // Glitter: normalised Blinn-Phong whose exponent falls as the footprint smooths the normals.
  float rough = uRough.x + lost;
  float sp = 2.0 / rough - 2.0;
  vec3 h = normalize(uLightDir - d);
  float ndh = max(dot(n, h), 0.0);
  col += uLightColor * (pow(ndh, sp) * (sp + 8.0) * (${glslFloat(1 / (8 * Math.PI))} * F));
  outColor = vec4(col, 1.0);
}
`;

export const SEA_SKY_UNIFORMS = ["uZenith", "uHorizon", "uGlow", "uSkyA"] as const;
export const SEA_LAND_UNIFORMS = ["uLand", "uLandColor", "uLandMap"] as const;

/** What one water draw needs, filled in place by the caller each frame. */
export interface SeaWaterFrame {
  /** Full-res px per low-res px, across and up. */
  lowToFullX: number;
  lowToFullY: number;
  /** Horizon centre: x and y (full px, y up). */
  centreX: number;
  horizonPx: number;
  /** Focal length in full px, and in frame heights. */
  focalPx: number;
  focal: number;
  /** Camera height above the water, metres. */
  cameraHeight: number;
  /** Frame height / width. */
  aspectInv: number;
  /** Swell height and ripple strength multipliers (1 = a calm sea). */
  swell: number;
  wind: number;
  /** Sun or moon centre, frame heights from the horizon centre. */
  lightX: number;
  lightY: number;
  /** The glitter path's light (colour times strength). */
  lightColor: Rgb;
  /** Base Beckmann m² of the glitter lobe, and the reflectance cap. */
  roughness: number;
  fresnelMax: number;
  /** Colour of the water seen straight down. */
  deep: Rgb;
  /** The sky the water reflects, and 1 / its height in frame heights. */
  sky: SkyState;
  skyK: number;
  /** The distant headland: on, mirrored (rising from the right), and its colour. */
  land: boolean;
  mirror: boolean;
  landColor: Rgb;
}

export function createSeaWaterFrame(sky: SkyState): SeaWaterFrame {
  return {
    lowToFullX: 1,
    lowToFullY: 1,
    centreX: 0,
    horizonPx: 0,
    focalPx: 1,
    focal: 1,
    cameraHeight: 3,
    aspectInv: 1,
    swell: 1,
    wind: 1,
    lightX: 0,
    lightY: 0,
    lightColor: [0, 0, 0],
    roughness: 0.01,
    fresnelMax: 0.8,
    deep: [0, 0, 0],
    sky,
    skyK: 1,
    land: false,
    mirror: false,
    landColor: [0, 0, 0],
  };
}

export interface SeaWater {
  /** Advances the swells and the ripples' drift by `dt` seconds at ripple strength `wind`. */
  advance: (dt: number, wind: number) => void;
  /**
   * Draws the water into the bound framebuffer and viewport. Leaves its program
   * bound, the ripples on texture unit 0 and the headland's table on unit 1
   * (active unit 0).
   */
  draw: (f: SeaWaterFrame) => void;
  /** The headland's heights (`LAND_COLUMNS` wide, R), for a sky pass to draw it too. */
  readonly landTexture: WebGLTexture;
  dispose: () => void;
}

/** Creates the water pass; `landSeed` shapes the distant headland. */
export function createSeaWater(
  gl: WebGL2RenderingContext,
  triangle: FullscreenTriangle,
  landSeed: number,
): SeaWater {
  return withScope((scope) => {
    const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, WATER_FRAGMENT), (p) => {
      gl.deleteProgram(p);
    });
    const u = createUniforms(gl, program, [
      "uRipples",
      "uLowToFull",
      "uView",
      "uCam",
      "uWave",
      "uWaveFade",
      "uRipOff",
      "uRipRot",
      "uRip",
      "uRipFade",
      "uLightDir",
      "uLightColor",
      "uRough",
      "uDeep",
      ...SEA_SKY_UNIFORMS,
      ...SEA_LAND_UNIFORMS,
    ]);
    const ripple = buildRippleSlopes(RIPPLE_SIZE, 0x5ea);
    const rippleTex = scope.add(
      createDataTexture(gl, {
        width: RIPPLE_SIZE,
        height: RIPPLE_SIZE,
        internalFormat: gl.RG8,
        format: gl.RG,
        type: gl.UNSIGNED_BYTE,
        data: ripple.data,
        wrap: gl.REPEAT,
      }),
      (t) => {
        gl.deleteTexture(t);
      },
    );
    const land = scope.own(createColumnTable(gl, LAND_COLUMNS, 1));
    buildHeadland(land.data, landSeed);
    land.upload();

    const cosB = Math.cos(RIPPLE_ROT_B);
    const sinB = Math.sin(RIPPLE_ROT_B);
    gl.useProgram(program);
    u.i1("uRipples", 0);
    u.i1("uLand", 1);
    gl.uniformMatrix2fv(u.loc.uRipRot, false, [cosB, sinB, -sinB, cosB]);
    gl.useProgram(null);

    const waves = resolveSwells();
    const phases = new Float64Array(waves.length);
    const waveData = new Float32Array(waves.length * 4);
    let ripAx = 0;
    let ripAy = 0;
    let ripBx = 0;
    let ripBy = 0;

    return {
      advance(dt, wind) {
        advanceSwellPhases(phases, waves, dt);
        const windDrift = dt * (0.5 + 0.5 * Math.max(0, wind));
        ripAx = wrap(ripAx + (RIPPLE_DRIFT_A[0] * windDrift) / RIPPLE_TILE_A, 0, 1);
        ripAy = wrap(ripAy + (RIPPLE_DRIFT_A[1] * windDrift) / RIPPLE_TILE_A, 0, 1);
        ripBx = wrap(ripBx + (RIPPLE_DRIFT_B[0] * windDrift) / RIPPLE_TILE_B, 0, 1);
        ripBy = wrap(ripBy + (RIPPLE_DRIFT_B[1] * windDrift) / RIPPLE_TILE_B, 0, 1);
      },
      draw(f) {
        const swell = Math.max(0, f.swell);
        const wind = Math.max(0, f.wind);
        for (let i = 0; i < waves.length; i++) {
          const w = waves[i];
          waveData[i * 4] = w.kx;
          waveData[i * 4 + 1] = w.kz;
          waveData[i * 4 + 2] = w.amp * swell;
          waveData[i * 4 + 3] = phases[i];
        }
        gl.useProgram(program);
        gl.uniform4fv(u.loc.uWave, waveData);
        u.f2("uLowToFull", f.lowToFullX, f.lowToFullY);
        u.f4("uView", f.centreX, f.horizonPx, 1 / f.focalPx, f.focal);
        u.f3("uCam", f.cameraHeight, f.lowToFullY / (f.focalPx * f.cameraHeight), f.aspectInv);
        u.f3("uWaveFade", (waves[0].k / 2) ** 2, (waves[1].k / 2) ** 2, (waves[2].k / 2) ** 2);
        u.f4("uRipOff", ripAx, ripAy, ripBx, ripBy);
        const ampA = (RIPPLE_RMS_A * wind) / ripple.rms;
        const ampB = (RIPPLE_RMS_B * wind) / ripple.rms;
        u.f4("uRip", 1 / RIPPLE_TILE_A, 1 / RIPPLE_TILE_B, ampA, ampB);
        // Fade each layer once the footprint passes its noise cell; its variance moves to the lobe.
        u.f4(
          "uRipFade",
          8 / RIPPLE_TILE_A,
          8 / RIPPLE_TILE_B,
          2 * (RIPPLE_RMS_A * wind) ** 2,
          2 * (RIPPLE_RMS_B * wind) ** 2,
        );
        const lx = f.lightX / f.focal;
        const ly = f.lightY / f.focal;
        const ln = 1 / Math.hypot(lx, ly, 1);
        u.f3("uLightDir", lx * ln, ly * ln, ln);
        u.v3("uLightColor", f.lightColor);
        u.f2("uRough", f.roughness, f.fresnelMax);
        u.v3("uDeep", f.deep);
        u.v3("uZenith", f.sky.zenith);
        u.v3("uHorizon", f.sky.horizon);
        u.v3("uGlow", f.sky.glow);
        u.f4("uSkyA", f.lightX, f.lightY, f.sky.glowStrength, f.skyK);
        u.v3("uLandColor", f.landColor);
        u.f2("uLandMap", f.land ? 1 : 0, f.mirror ? 1 : 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, land.texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, rippleTex);
        triangle.draw();
      },
      landTexture: land.texture,
      dispose: () => {
        scope.dispose();
      },
    };
  });
}
