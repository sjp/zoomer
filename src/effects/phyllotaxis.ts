import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import {
  createHead,
  divergence,
  headLayout,
  type HeadLayout,
  MAX_PETAL_SPRITES,
  PETAL_STRIDE,
  SEED_STRIDE,
  stepHead,
  styleFor,
  writePetals,
  writeSeeds,
} from "./phyllotaxis-sim";
import { MAX_SEEDS, phyllotaxisMeta } from "./phyllotaxis.meta";
import { createSpriteBatch, SPRITE_SPIN_GLSL } from "./sprites";
import { defineEffect } from "./types";

/** Petal half-width over half-length. */
const PETAL_ASPECT = 0.3;

/**
 * Light direction in screen space (y down), from the upper left. Each sprite
 * gets it in its own rotated frame, so every seed is lit from the same side.
 */
const LIGHT_GLSL = /* glsl */ `
vec2 localLight(float angle) {
  const vec2 L = vec2(-0.6, -0.8);
  float s = sin(angle);
  float k = cos(angle);
  return vec2(L.x * k + L.y * s, -L.x * s + L.y * k);
}
`;

const SEED_VERTEX = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, half-length (device px, y down), alpha. */
layout(location = 1) in vec4 aSeed;
/** Radius fraction, spiral hue, variation, unused. */
layout(location = 2) in vec4 aLook;
/** Angle (radians, local x points away from the centre), flip. */
layout(location = ${spinLocation}) in vec2 aSpin;
uniform vec2 uResolution;
uniform float uAspect;
out vec2 vLocal;
flat out vec2 vLight;
flat out vec4 vLook;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
${LIGHT_GLSL}
void main() {
  vec2 local = aCorner * vec2(1.0, uAspect);
  vLocal = local;
  vLight = localLight(aSpin.x);
  vLook = vec4(aLook.xyz, aSeed.w);
  gl_Position = pxToClip(aSeed.xy + spinCorner(local, aSpin) * aSeed.z, uResolution);
}
`;

/**
 * One seed, scale or leaf in its own frame: x from -1 (towards the centre) to 1
 * (outward), y across. uStyle picks the shape. Output is premultiplied.
 */
const SEED_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vLight;
flat in vec4 vLook;
uniform int uStyle;
uniform float uAspect;
out vec4 outColor;

/** Coverage of an edge at signed distance f (positive inside), about a pixel wide. */
float cover(float f) {
  return clamp(f / max(fwidth(f), 1e-5) + 0.5, 0.0, 1.0);
}

/** Lambert term for a dome normal over a unit disc coordinate q. */
float dome(vec2 q, float height) {
  float z = sqrt(max(0.0, 1.0 - dot(q, q)));
  vec3 n = normalize(vec3(q, z * height));
  return dot(n, normalize(vec3(vLight, 0.9)));
}

vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0, 1.0) / 3.0) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}

void main() {
  float tone = vLook.x;
  float vary = vLook.z;
  vec3 col;
  float a;
  if (uStyle == 0) {
    // Sunflower seed: a glossy dark ellipse, greener and paler at the very centre.
    vec2 q = vLocal / vec2(0.92, uAspect * 0.92);
    float d = length(q);
    a = cover(1.0 - d);
    float lam = dome(q, 1.4);
    vec3 base = mix(vec3(0.42, 0.38, 0.12), vec3(0.12, 0.075, 0.045), smoothstep(0.0, 0.3, tone));
    base *= 0.8 + 0.4 * vary;
    // A faint pale stripe down the seed's length.
    base += vec3(0.05, 0.045, 0.035) * (1.0 - smoothstep(0.08, 0.2, abs(q.y))) * step(0.3, tone);
    col = base * (0.55 + 0.6 * max(lam, 0.0)) + vec3(0.32, 0.29, 0.22) * pow(max(lam, 0.0), 14.0);
  } else if (uStyle == 1) {
    // Pine-cone scale: a shield whose inner half sits in the shadow of the scale
    // above it, with a woody umbo and a rim lit on the side facing the light.
    vec2 q = vLocal / vec2(1.0, uAspect);
    float d = length(vec2(q.x * (q.x > 0.0 ? 1.15 : 0.9), q.y));
    a = cover(1.0 - d);
    float lam = dome(q * 0.9, 0.8);
    vec3 base = mix(vec3(0.24, 0.14, 0.07), vec3(0.52, 0.33, 0.17), 0.5 + 0.5 * q.x);
    base *= (0.85 + 0.3 * vary) * (1.1 - 0.35 * tone);
    float facing = dot(normalize(q + 1e-4), vLight);
    float rim = smoothstep(0.6, 0.95, d);
    col = base * (0.5 + 0.6 * max(lam, 0.0));
    col *= 1.0 + rim * (0.7 * max(facing, 0.0) - 0.5 * max(-facing, 0.0));
    col *= mix(0.45, 1.0, smoothstep(-0.9, 0.2, q.x));
    float umbo = 1.0 - smoothstep(0.08, 0.16, length(q - vec2(0.45, 0.0)));
    col = mix(col, vec3(0.16, 0.1, 0.06), 0.6 * umbo);
  } else if (uStyle == 2) {
    // Succulent leaf: thick and pointed, a rounded cross-section, blushing pink
    // towards the tip and edges, shaded at the base under the leaves above.
    float u = 0.5 * (vLocal.x + 1.0);
    float w = uAspect * 1.56 * sqrt(max(u, 0.0)) * (1.0 - u);
    float f = w - abs(vLocal.y);
    a = cover(f);
    float t = clamp(vLocal.y / max(w, 1e-3), -1.0, 1.0);
    vec3 n = normalize(vec3(0.25 - 0.5 * u, t, sqrt(1.0 - t * t) + 0.3));
    float lam = dot(n, normalize(vec3(vLight, 0.9)));
    vec3 base = mix(vec3(0.7, 0.83, 0.66), vec3(0.44, 0.6, 0.5), tone) * (0.9 + 0.2 * vary);
    float blush = max(smoothstep(0.6, 1.0, u), 0.6 * smoothstep(0.75, 1.0, abs(t)));
    base = mix(base, vec3(0.86, 0.55, 0.6), blush * (0.4 + 0.5 * tone));
    col = base * (0.5 + 0.6 * max(lam, 0.0));
    col *= mix(0.6, 1.0, smoothstep(0.0, 0.35, u));
  } else {
    // Abstract: a softly shaded dot, its hue following one family of spirals.
    float d = length(vLocal) / 0.85;
    a = cover(1.0 - d);
    float lam = dome(vLocal / 0.85, 1.0);
    vec3 base = hsv(vLook.y, 0.55, 0.75 + 0.25 * tone);
    col = base * (0.7 + 0.35 * max(lam, 0.0));
  }
  a *= vLook.w;
  outColor = vec4(col * a, a);
}
`;

const PETAL_VERTEX = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, half-length (device px, y down), alpha. */
layout(location = 1) in vec4 aPetal;
/** Colour, then kind: 0 petal, 1 backing disc. */
layout(location = 2) in vec4 aTint;
layout(location = ${spinLocation}) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec2 vLight;
flat out vec4 vTint;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
${LIGHT_GLSL}
void main() {
  vec2 local = aCorner * vec2(1.0, aTint.w > 0.5 ? 1.0 : ${PETAL_ASPECT.toFixed(2)});
  vLocal = local;
  vLight = localLight(aSpin.x);
  vTint = aTint;
  gl_Position = pxToClip(aPetal.xy + spinCorner(local, aSpin) * aPetal.z, uResolution);
}
`;

/** A pointed petal with a crease and a deeper base, or the soft backing disc. */
const PETAL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vLight;
flat in vec4 vTint;
out vec4 outColor;
float cover(float f) {
  return clamp(f / max(fwidth(f), 1e-5) + 0.5, 0.0, 1.0);
}
void main() {
  // Petal edge first, outside any branch, so its derivatives are always defined.
  float x = vLocal.x;
  float w = ${PETAL_ASPECT.toFixed(2)} * 1.3 * (1.0 - x) * sqrt(max(1.0 + x, 0.0));
  float a = cover(w - abs(vLocal.y));
  float t = clamp(vLocal.y / max(w, 1e-3), -1.0, 1.0);
  // Two gentle halves either side of the crease, one turned to the light.
  float side = 0.85 + 0.15 * sign(t) * sign(vLight.y) * smoothstep(0.0, 0.5, abs(t));
  float crease = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.12, abs(t)));
  float base = mix(0.7, 1.0, smoothstep(-1.0, -0.2, x));
  vec3 col = vTint.rgb * side * crease * base;
  if (vTint.w > 0.5) {
    // Backing disc, with a soft rim so the outer seeds fade into it.
    float d = length(vLocal);
    a = 1.0 - smoothstep(0.9, 1.0, d);
    col = vTint.rgb * (1.0 - 0.3 * d * d);
  }
  outColor = vec4(col * a, a);
}
`;

/**
 * A sunflower head (or pine cone, succulent rosette or abstract dots) built by
 * Vogel's phyllotaxis model in a corner of the frame. New seeds appear at the
 * centre and push outward, and the whole head turns slowly.
 */
export const phyllotaxis = defineEffect(phyllotaxisMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scope.own(createGradientBackground(gl));
      // Per seed: x, y, size, alpha; tone, hue, variation, 0; then the spin pair.
      const seedBatch = scope.own(
        createSpriteBatch(gl, MAX_SEEDS, [4, 4], undefined, { rotation: true }),
      );
      const seedProgram = scope.add(
        createProgram(gl, SEED_VERTEX(seedBatch.spinLocation), SEED_FRAGMENT),
        (p) => gl.deleteProgram(p),
      );
      const seedU = createUniforms(gl, seedProgram, ["uResolution", "uAspect", "uStyle"]);
      // Per petal: x, y, half-length, alpha; r, g, b, kind; then the spin pair.
      const petalBatch = scope.own(
        createSpriteBatch(gl, MAX_PETAL_SPRITES, [4, 4], undefined, { rotation: true }),
      );
      const petalProgram = scope.add(
        createProgram(gl, PETAL_VERTEX(petalBatch.spinLocation), PETAL_FRAGMENT),
        (p) => gl.deleteProgram(p),
      );
      const petalU = createUniforms(gl, petalProgram, ["uResolution"]);
      if (seedBatch.stride !== SEED_STRIDE || petalBatch.stride !== PETAL_STRIDE) {
        throw new Error("Phyllotaxis instance layout mismatch");
      }

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      const layout: HeadLayout = { cx: 0, cy: 0, radius: 0 };
      const head = createHead(phyllotaxisMeta.params.seeds.default);

      return {
        resize(v) {
          ({ width, height, scale } = v);
          refWidth = v.width / v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const style = styleFor(p.style);
          const phi = divergence(p.angle);
          stepHead(head, dt, p.growth, p.spin, phi, Math.min(MAX_SEEDS, p.seeds));
          headLayout(p.position, refWidth, layout);

          background.draw(style.top, style.bottom);

          // Source-over with premultiplied output.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

          const petals = writePetals(head, style, layout, scale, petalBatch.data, PETAL_STRIDE);
          if (petals > 0) {
            petalBatch.upload(petals);
            gl.useProgram(petalProgram);
            petalU.f2("uResolution", width, height);
            petalBatch.draw(0, petals);
          }

          const seeds = writeSeeds(head, phi, style, layout, scale, seedBatch.data, SEED_STRIDE);
          if (seeds > 0) {
            seedBatch.upload(seeds);
            gl.useProgram(seedProgram);
            seedU.f2("uResolution", width, height);
            seedU.f1("uAspect", style.aspect);
            seedU.i1("uStyle", style.shader);
            seedBatch.draw(0, seeds);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
