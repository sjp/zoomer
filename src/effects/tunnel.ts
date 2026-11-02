import { hexToRgb, hexToUnitRgb, mixRgb } from "./color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { createNoise, fbmPeriodic2 } from "./noise";
import { defineEffect } from "./types";

/** Tunnel wall texture size in texels (power of two so it tiles with REPEAT). */
const TEX = 256;
const MASK = TEX - 1;
/** Texture repeats around the circumference. Must be an integer so u = 0/1 has no seam. */
const U_REPS = 2;
/** Texels of depth per unit of 1/distance (distance measured in frame heights). */
const V_SCALE = 48;
/** Forward scroll in texels per second for a speed of 1. */
const SPEED_TEX = 24;
/** Spiral offset in u texels per v texel for a spiral of 1. */
const SPIRAL_K = 0.5;
/** Ring bands per texture tile in depth. Integer so the bands tile with the texture. */
const RINGS = 4;
/** Largest centre wander, as a fraction of the frame height. */
const BEND_MAX = 0.2;
/**
 * Distance from the frame centre, in frame heights, over which the wander fades
 * out, so near walls stay put; the gentle slope keeps the mapping fold-free.
 */
const BEND_REACH = 1.05;
/** Closest depth sampled, in frame heights, so 1/distance stays finite. */
const MIN_DIST = 0.004;

/** Wraps a texel offset into [0, TEX). */
const wrap = (x: number) => ((x % TEX) + TEX) % TEX;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uTex;
/** Maps gl_FragCoord to frame-height units from the centre, y down: p = xy * scale + offset. */
uniform vec2 uPixScale;
uniform vec2 uPixOffset;
/** Vanishing-point wander in frame heights, y down. */
uniform vec2 uBend;
/**
 * Texture scroll in texture tiles (u around, v into the tunnel), wrapped to [0, 1).
 * u also carries the half-turn of the atan offset and the half-texel centring.
 */
uniform vec2 uScroll;
/** Corkscrew: u texels per v texel. */
uniform float uSpiral;
uniform float uRings;
/** Brightness-scaled base gain: (0.85, 0.2) * brightness. */
uniform vec2 uGain;
uniform vec3 uColor1;
uniform vec3 uColor2;
/** Palette ramps: colour 2 - colour 1 and colour 3 - colour 2. */
uniform vec3 uRamp12;
uniform vec3 uRamp23;
/** Core glow colour times its gain. */
uniform vec3 uGlow;

out vec4 outColor;

const float TAU = 6.283185307179586;
const float TEX = ${glslFloat(TEX)};
const float U_REPS = ${glslFloat(U_REPS)};
const float V_SCALE = ${glslFloat(V_SCALE)};
const float RINGS = ${glslFloat(RINGS)};
const float BEND_REACH = ${glslFloat(BEND_REACH)};
const float MIN_DIST = ${glslFloat(MIN_DIST)};
/** exp(-(dn / 0.3)^2) as exp2(dn^2 * FOG_K). */
const float FOG_K = -1.4426950408889634 / 0.09;

void main() {
  vec2 p = gl_FragCoord.xy * uPixScale + uPixOffset;
  // The wander is weighted to 1 at the centre and 0 towards the frame edges.
  float w = 1.0 - smoothstep(0.0, BEND_REACH, length(p));
  vec2 d = p - uBend * w;
  float dn = max(MIN_DIST, length(d));
  // Depth in texture tiles.
  float dep = (V_SCALE / TEX) / dn;

  // Shearing u by depth keeps the corkscrew attached to the walls.
  float u = atan(d.y, d.x) * (U_REPS / TAU) + uSpiral * dep + uScroll.x;
  float v = dep + uScroll.y;
  // Texel i is centred at (i + 0.5) / TEX; u's half texel is in uScroll.
  float texel = texture(uTex, vec2(u, v + 0.5 / TEX)).r;
  float c = 0.5 + 0.5 * cos(fract(v) * (RINGS * TAU));
  float s = clamp(texel + uRings * (c * c * c - 0.3), 0.0, 1.0);

  // Depth fog: 0 at the far core, 1 on the near walls.
  float f0 = 1.0 - exp2(dn * dn * FOG_K);
  float fog = f0 * sqrt(f0);
  // Far texture fades towards mid-tone so fine distant detail stays calm.
  float t = 0.5 + (s - 0.5) * fog;
  float t2 = t * 2.0;
  vec3 col = t < 0.5 ? uColor1 + uRamp12 * t2 : uColor2 + uRamp23 * (t2 - 1.0);
  // Brighter texture values glow harder and lean slightly towards white.
  float hot = t * t * t * 0.3;
  float k = (uGain.x * t + uGain.y) * fog;
  float g = 1.0 - fog;
  vec3 rgb = (col + (1.0 - col) * hot) * k + uGlow * (g * g);
  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}
`;

/**
 * Builds the seamlessly tiling wall texture: domain-warped periodic fBm mixed
 * with ridged strands, normalised to [0, 1]. Runs once per instance.
 */
const buildTexture = (out: Float32Array, seed: number) => {
  const noise = createNoise(seed);
  const P = 4;
  for (let y = 0; y < TEX; y++) {
    const v = (y / TEX) * P;
    for (let x = 0; x < TEX; x++) {
      const u = (x / TEX) * P;
      // Low-octave warp keeps the swirls broad; a strong warp folds into
      // texel-scale speckle that shimmers once magnified on the near walls.
      const qx = fbmPeriodic2(noise, u + 5.2, v + 1.3, P, 2);
      const qy = fbmPeriodic2(noise, u + 1.7, v + 9.2, P, 2);
      const n = fbmPeriodic2(noise, u + 1.1 * qx, v + 1.1 * qy, P, 4);
      const ridge = 1 - Math.abs(n);
      const r2 = ridge * ridge;
      const val = 0.7 * (0.5 + 0.5 * n) + 0.3 * r2 * r2;
      out[y * TEX + x] = val;
    }
  }
  // Histogram-equalise, then shape: an even spread of values keeps every
  // palette colour on screen, and the curve keeps bright strands the minority.
  const order = new Uint32Array(out.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => out[a] - out[b]);
  const last = order.length - 1;
  for (let r = 0; r <= last; r++) {
    const t = r / last;
    out[order[r]] = t * Math.sqrt(t);
  }
  // One wrapping 3x3 blur softens texel-scale steps that equalisation can
  // sharpen, which would otherwise show as jaggies on the magnified near walls.
  const src = out.slice();
  for (let y = 0; y < TEX; y++) {
    const ym = ((y - 1) & MASK) * TEX;
    const y0 = y * TEX;
    const yp = ((y + 1) & MASK) * TEX;
    for (let x = 0; x < TEX; x++) {
      const xm = (x - 1) & MASK;
      const xp = (x + 1) & MASK;
      out[y0 + x] =
        (4 * src[y0 + x] +
          2 * (src[y0 + xm] + src[y0 + xp] + src[ym + x] + src[yp + x]) +
          src[ym + xm] +
          src[ym + xp] +
          src[yp + xm] +
          src[yp + xp]) /
        16;
    }
  }
};

let textureData: Float32Array | undefined;
/** The wall texture is deterministic, so build it once and reuse it across instances. */
const getTextureData = () => {
  if (!textureData) {
    textureData = new Float32Array(TEX * TEX);
    buildTexture(textureData, 1337);
  }
  return textureData;
};

/**
 * A texture-mapped wormhole, drawn by a WebGL2 fragment shader: per-pixel angle
 * and 1/distance lookups into a tiling energy texture, scrolled for forward flight and rotated for twist,
 * with a wandering vanishing point and depth fog towards the core.
 */
export const tunnel = defineEffect({
  id: "tunnel",
  name: "Wormhole Tunnel",
  description: "Fly forward through an endless, gently bending tunnel of glowing, swirling energy.",
  params: {
    speed: { kind: "number", label: "Forward speed", min: 0, max: 4, step: 0.05, default: 1 },
    twist: {
      kind: "number",
      label: "Twist (turns per minute)",
      min: -30,
      max: 30,
      step: 0.5,
      default: 4,
    },
    spiral: {
      kind: "number",
      label: "Spiral (corkscrew)",
      min: -2,
      max: 2,
      step: 0.05,
      default: 0.6,
    },
    bend: {
      kind: "number",
      label: "Bend (centre wander)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    color1: { kind: "color", label: "Colour 1 (dim)", default: "#0b0640" },
    color2: { kind: "color", label: "Colour 2 (mid)", default: "#7a2cff" },
    color3: { kind: "color", label: "Colour 3 (bright)", default: "#46e8ff" },
    rings: { kind: "number", label: "Ring bands", min: 0, max: 1, step: 0.01, default: 0.35 },
    core: {
      kind: "select",
      label: "Tunnel core",
      options: [
        { value: "bright", label: "Bright light" },
        { value: "dark", label: "Dark void" },
      ],
      default: "bright",
    },
    brightness: { kind: "number", label: "Brightness", min: 0.2, max: 2, step: 0.05, default: 1 },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const texture = scope.add(
        createDataTexture(gl, {
          width: TEX,
          height: TEX,
          // R16F is filterable in core WebGL2 and accepts FLOAT data; R32F is not.
          internalFormat: gl.R16F,
          format: gl.RED,
          type: gl.FLOAT,
          data: getTextureData(),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );
      const u = createUniforms(gl, program, [
        "uTex",
        "uPixScale",
        "uPixOffset",
        "uBend",
        "uScroll",
        "uSpiral",
        "uRings",
        "uGain",
        "uColor1",
        "uColor2",
        "uRamp12",
        "uRamp23",
        "uGlow",
      ]);
      // The sampler unit never changes; uniforms persist with the program even in a shared context.
      gl.useProgram(program);
      u.i1("uTex", 0);

      let width = 1;
      let height = 1;
      /** Seconds since start, kept in float64 on the CPU; only its sines reach the GPU. */
      let time = 0;
      // Scroll offsets in texels, wrapped to [0, TEX) so float32 uniforms stay precise.
      let vOff = 0;
      let uOff = 0;
      let spiralOff = 0;
      // Colours last derived from; the uniforms themselves skip unchanged uploads.
      let lastBrightness = NaN;
      let lastCore = "";
      let lastColor1 = "";
      let lastColor2 = "";
      let lastColor3 = "";

      return {
        resize(v) {
          width = v.width;
          height = v.height;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const dv = p.speed * SPEED_TEX * dt;
          vOff = wrap(vOff + dv);
          uOff = wrap(uOff + (p.twist / 60) * U_REPS * TEX * dt);
          const spk = p.spiral * SPIRAL_K;
          spiralOff = wrap(spiralOff + spk * dv);

          // Slow lissajous wander of the vanishing point, in frame heights.
          const amp = p.bend * BEND_MAX;
          const ox = amp * Math.sin(time * 0.19) * Math.cos(time * 0.07);
          const oy = amp * 0.75 * Math.sin(time * 0.27 + 1.3);

          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          const h = Math.max(1, height);
          u.f2("uPixScale", 1 / h, -1 / h);
          u.f2("uPixOffset", (-0.5 * width) / h, 0.5);
          u.f2("uBend", ox, oy);
          // Tile units; the atan half-turn and the half-texel centring ride along in u.
          const su = wrap(uOff + spiralOff + 0.5 + 0.5 * U_REPS * TEX);
          u.f2("uScroll", su / TEX, vOff / TEX);
          u.f1("uSpiral", spk);
          u.f1("uRings", p.rings);
          if (
            p.color1 !== lastColor1 ||
            p.color2 !== lastColor2 ||
            p.color3 !== lastColor3 ||
            p.core !== lastCore ||
            p.brightness !== lastBrightness
          ) {
            lastColor1 = p.color1;
            lastColor2 = p.color2;
            lastColor3 = p.color3;
            lastCore = p.core;
            lastBrightness = p.brightness;
            const c1 = hexToUnitRgb(p.color1);
            const c2 = hexToUnitRgb(p.color2);
            const c3 = hexToUnitRgb(p.color3);
            u.v3("uColor1", c1);
            u.v3("uColor2", c2);
            u.f3("uRamp12", c2[0] - c1[0], c2[1] - c1[1], c2[2] - c1[2]);
            u.f3("uRamp23", c3[0] - c2[0], c3[1] - c2[1], c3[2] - c2[2]);
            u.f2("uGain", 0.85 * p.brightness, 0.2 * p.brightness);
            // The core glow leans colour 3 towards white, pre-multiplied by its gain.
            const bright = p.core !== "dark";
            const glow = mixRgb(hexToRgb(p.color3), [255, 255, 255], 0.55);
            const gain = bright ? (1.15 * p.brightness) / 255 : 0;
            u.f3("uGlow", glow[0] * gain, glow[1] * gain, glow[2] * gain);
          }
          triangle.draw();
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
