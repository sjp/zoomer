import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import {
  advancePhases,
  fillWarpUniforms,
  fillWaveUniforms,
  layoutWaves,
  lightVectors,
  MAX_BREEZE,
  MAX_FOLDS,
  MIN_FOLDS,
  slopeScale,
  WARP_WAVES,
  WARPS,
  WAVE_FLOATS,
  WAVES,
} from "./silk-sim";
import { defineEffect } from "./types";

/** Ambient light and Lambert gain: creases facing away from the light fall to AMBIENT. */
const AMBIENT = 0.1;
const DIFFUSE = 1.15;
/** Crease darkening (cheap AO from h) at depth 1 and above. */
const AO_K = 0.45;
/** Kajiya-Kay exponents: a tight satin highlight over a broad soft sheen (sin^8). */
const SHEEN_EXP = 70;
const SHEEN_BROAD = 0.3;
/** Highlight brightness at sheen 1, and how far it is tinted from the cloth colour towards white. */
const SHEEN_GAIN = 0.85;
const SHEEN_WHITE = 0.55;

/**
 * One analytic pass: six directional sine waves on a two-wave domain warp,
 * with the exact gradient (no fetch or finite difference); diffuse plus
 * Kajiya-Kay anisotropic sheen along the thread tangent, which runs across the
 * dominant folds so highlights stretch along the crests. Mirrors `silkField` in
 * silk-sim.ts.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Frame-height position (centred, y up) = gl_FragCoord.xy * xy + zw. */
uniform vec4 uPix;
/** Per wave: (kx, ky, phase, amplitude). */
uniform vec4 uWave[${WAVES}];
/** Per warp wave: (gx, gy, phase, amplitude). */
uniform vec4 uWarp[${WARPS}];
/** Gradient-to-slope factor (depth). */
uniform float uSlope;
/** Crease darkening strength. */
uniform float uAo;
/** Thread direction in the screen plane (the dominant wave vector, normalised). */
uniform vec2 uThread;
uniform vec3 uLight;
uniform vec3 uHalf;
uniform vec3 uColor;
uniform vec3 uShotColor;
uniform float uShot;
uniform float uSheen;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy * uPix.xy + uPix.zw;
  float w0 = dot(uWarp[0].xy, p) + uWarp[0].z;
  float w1 = dot(uWarp[1].xy, p) + uWarp[1].z;
  vec2 q = p + vec2(uWarp[0].w * sin(w0), uWarp[1].w * sin(w1));
  float h = 0.0;
  vec2 s = vec2(0.0);
  for (int i = 0; i < ${WAVES}; i++) {
    vec4 w = uWave[i];
    float th = dot(w.xy, q) + w.z;
    h += w.w * sin(th);
    s += (w.w * cos(th)) * w.xy;
  }
  // grad_p h = J^T grad_q h, with J = I + dW/dp.
  vec2 g = s + (uWarp[0].w * cos(w0) * s.x) * uWarp[0].xy + (uWarp[1].w * cos(w1) * s.y) * uWarp[1].xy;
  vec2 slope = g * uSlope;
  vec3 n = normalize(vec3(-slope, 1.0));

  float ndl = dot(n, uLight);
  float lit = ${glslFloat(AMBIENT)} + ${glslFloat(DIFFUSE)} * max(ndl, 0.0);
  // Cheap AO: the lowest parts of the height field are the deepest creases.
  float ao = 1.0 - uAo * (1.0 - smoothstep(-0.9, 0.5, h));
  // Shot silk: the second thread colour shows where the cloth turns from the light.
  vec3 base = mix(uColor, uShotColor, uShot * (1.0 - smoothstep(0.0, 0.9, ndl)));

  // Kajiya-Kay: thread tangent across the folds, lying on the surface.
  vec3 t0 = vec3(uThread, 0.0);
  vec3 t = normalize(t0 - n * dot(n, t0));
  float tdh = dot(t, uHalf);
  float s2 = max(1.0 - tdh * tdh, 0.0);
  float s8 = s2 * s2;
  s8 *= s8;
  float spec = pow(s8, ${glslFloat(SHEEN_EXP / 8)}) + ${glslFloat(SHEEN_BROAD)} * s8;
  spec *= smoothstep(-0.05, 0.35, ndl) * uSheen;
  vec3 sheenColor = mix(base, vec3(1.0), ${glslFloat(SHEEN_WHITE)});

  vec3 c = base * lit * ao + sheenColor * spec * (0.5 + 0.5 * ao);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Large folds of silk rippling slowly in a light breeze, with an anisotropic
 * satin sheen sliding across them and optional shot-silk colour shift. One
 * analytic full-screen pass.
 */
export const silk = defineEffect({
  id: "silk",
  name: "Silk drapery",
  description:
    "Deep folds of satin rippling slowly in a breeze, with a sheen that slides along the crests.",
  params: {
    layout: {
      kind: "select",
      label: "Layout",
      options: [
        { value: "hanging", label: "Hanging" },
        { value: "flowing", label: "Flowing" },
        { value: "billowing", label: "Billowing" },
      ],
      default: "hanging",
    },
    color: { kind: "color", label: "Colour", default: "#7a1a36" },
    shotColor: { kind: "color", label: "Shot colour", default: "#c7862c" },
    shot: { kind: "number", label: "Shot", min: 0, max: 1, step: 0.01, default: 0.35 },
    sheen: { kind: "number", label: "Sheen", min: 0, max: 1, step: 0.01, default: 0.6 },
    folds: {
      kind: "number",
      label: "Folds",
      min: MIN_FOLDS,
      max: MAX_FOLDS,
      step: 0.5,
      default: 6,
    },
    depth: { kind: "number", label: "Fold depth", min: 0, max: 2, step: 0.05, default: 1 },
    breeze: { kind: "number", label: "Breeze", min: 0, max: MAX_BREEZE, step: 0.05, default: 1 },
    lightAngle: {
      kind: "number",
      label: "Light angle (degrees)",
      min: 0,
      max: 360,
      step: 1,
      default: 120,
    },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, [
        "uPix",
        "uWave",
        "uWarp",
        "uSlope",
        "uAo",
        "uThread",
        "uLight",
        "uHalf",
        "uColor",
        "uShotColor",
        "uShot",
        "uSheen",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const phases = new Float64Array(WAVES);
      const warpPhases = new Float64Array(WARPS);
      const waveData = new Float32Array(WAVES * WAVE_FLOATS);
      const warpData = new Float32Array(WARPS * WAVE_FLOATS);
      const light = new Float32Array(6);

      let width = 1;
      let height = 1;
      let lastLightAngle = Number.NaN;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const specs = layoutWaves(p.layout);
          const t = dt * Math.min(Math.max(p.breeze, 0), MAX_BREEZE);
          advancePhases(phases, specs, t);
          advancePhases(warpPhases, WARP_WAVES, t);
          fillWaveUniforms(waveData, specs, p.folds, phases);
          fillWarpUniforms(warpData, p.folds, warpPhases);

          gl.useProgram(program);
          const inv = 1 / height;
          u.f4("uPix", inv, inv, -0.5 * width * inv, -0.5);
          gl.uniform4fv(u.loc.uWave, waveData);
          gl.uniform4fv(u.loc.uWarp, warpData);
          u.f1("uSlope", slopeScale(p.folds, p.depth));
          u.f1("uAo", AO_K * Math.min(Math.max(p.depth, 0), 1));
          const a = (specs[0].angle * Math.PI) / 180;
          u.f2("uThread", Math.cos(a), Math.sin(a));
          if (p.lightAngle !== lastLightAngle) {
            lastLightAngle = p.lightAngle;
            lightVectors(light, p.lightAngle);
            u.f3("uLight", light[0], light[1], light[2]);
            u.f3("uHalf", light[3], light[4], light[5]);
          }
          u.rgb("uColor", p.color);
          u.rgb("uShotColor", p.shotColor);
          u.f1("uShot", p.shot);
          u.f1("uSheen", p.sheen * SHEEN_GAIN);
          triangle.draw();
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
