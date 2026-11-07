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
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { createRng } from "../noise";
import {
  BASE_SPEED,
  BASE_WAVELENGTH,
  BRANCH_H,
  BRANCH_W,
  buildBranchMask,
  createRainState,
  DROP_STRIDE,
  MAX_DROPS,
  packDrops,
  stepRain,
} from "./ripples-sim";
import { ripplesMeta } from "./ripples.meta";
import { defineEffect } from "../types";

/** Reflection shift in reference px per unit of surface slope. */
const DISPLACE_REF = 18;
/** Sky reflection: brightness at the dark side, and its range across the frame. */
const SKY_MIN = 0.05;
const SKY_RANGE = 0.4;
/** The bright side of the sky, as a direction in the frame (top left). */
const SKY_DIR: readonly [number, number] = [-0.55, 0.835];
/** Gradient steepness: how much of the 0..1 sky ramp the frame spans. */
const SKY_SPAN = 0.85;
/** Crests tilted towards the bright side catch more sky: relative gain per unit slope. */
const SHADE = 1.4;
/** Specular glint on crests, relative to the sky, per unit slope squared. */
const SPEC = 2.5;
/** How much of the sky a branch blocks. */
const BRANCH_DARK = 0.92;

/**
 * Low-res water pass: sums the slope of every live ring (two vec4s each, see
 * `packDrops`), skipping a ring with one compare outside its outer radius and
 * one more outside its packet, then looks up the reflected sky (analytic) and,
 * with `branches`, the branch mask at the displaced position.
 */
export function waterFragment(branches: boolean): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uDrops[${String(MAX_DROPS * 2)}];
uniform int uCount;
/** 1 / target size in pixels. */
uniform vec2 uInvSize;
/** Slope to uv displacement. */
uniform vec2 uDisp;
uniform vec3 uWater;
uniform vec3 uSky;
/** Sky ramp: dot(uv, xy) + z. */
uniform vec3 uSkyRamp;
/** 1 when rendering straight to the canvas (no dithered blit after). */
uniform float uDither;
${branches ? "uniform sampler2D uBranches;" : ""}
out vec4 outColor;
${DITHER_GLSL}
const vec2 LIGHT = vec2(${glslFloat(SKY_DIR[0])}, ${glslFloat(SKY_DIR[1])});
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 s = vec2(0.0);
  for (int i = 0; i < ${String(MAX_DROPS)}; i++) {
    if (i >= uCount) break;
    vec4 a = uDrops[2 * i];
    vec2 d = p - a.xy;
    float d2 = dot(d, d);
    if (d2 >= a.z) continue;
    vec4 b = uDrops[2 * i + 1];
    float r = sqrt(d2);
    float x = r - b.x;
    float u = x * b.y;
    if (abs(u) >= 1.0) continue;
    float e = 1.0 - u * u;
    float ph = x * b.z;
    float slope = b.w * (-4.0 * u * e * a.w * cos(ph) - e * e * sin(ph));
    s += d * (slope / max(r, 1e-3));
  }
  // Looking straight down, a tilted surface reflects the sky in the direction -grad.
  vec2 q = p * uInvSize - s * uDisp;
  float g = clamp(dot(q, uSkyRamp.xy) + uSkyRamp.z, 0.0, 1.0);
  float sky = ${glslFloat(SKY_MIN)} + ${glslFloat(SKY_RANGE)} * g * g;
${
  branches
    ? `  float m = texture(uBranches, q).r;
  sky *= 1.0 - ${glslFloat(BRANCH_DARK)} * m;`
    : ""
}
  // Light crest, dark trough: slopes facing the bright side reflect more sky.
  float t = -dot(s, LIGHT);
  float lit = sky * max(0.0, 1.0 + ${glslFloat(SHADE)} * t) + ${glslFloat(SPEC)} * sky * max(t, 0.0) * max(t, 0.0);
  vec3 col = uWater + uSky * lit;
  outColor = vec4(col + dither8(p) * uDither, 1.0);
}
`;
}

const UNIFORMS = [
  "uDrops",
  "uCount",
  "uInvSize",
  "uDisp",
  "uWater",
  "uSky",
  "uSkyRamp",
  "uDither",
  "uBranches",
] as const;

/**
 * Looking down at dark, still water in light rain: drops land at random and send
 * out soft rings that bend the reflection of an overcast sky and overhanging
 * branches. A stateless sum of up to 32 analytic ring packets per low-res pixel.
 */
export const ripples = defineEffect(ripplesMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const variants = [false, true].map((branches) => {
        const program = scope.add(
          createProgram(gl, FULLSCREEN_VERTEX, waterFragment(branches)),
          (p) => {
            gl.deleteProgram(p);
          },
        );
        const u = createUniforms(gl, program, UNIFORMS);
        gl.useProgram(program);
        u.i1("uBranches", 0);
        return u;
      });
      const mask = scope.add(
        createDataTexture(gl, {
          width: BRANCH_W,
          height: BRANCH_H,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildBranchMask(),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const rng = createRng(0x46);
      const rain = createRainState(rng);
      const packed = new Float32Array(MAX_DROPS * DROP_STRIDE);

      let width = 1;
      let height = 1;
      let vpScale = 1;
      /** Rings drawn last frame; the cached image is reused while there are none. */
      let lastCount = -1;
      let lastVariant = -1;
      let lastW = 0;
      let lastH = 0;

      return {
        resize(v) {
          width = v.width;
          height = v.height;
          vpScale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const speed = BASE_SPEED * Math.max(0, p.ringSpeed);
          stepRain(rain, dt, p.rate, p.variation, speed, rng);

          target.resize(width, height, qualityDivisor(p.quality));
          const tw = target.width;
          const th = target.height;
          const pxPerRef = (vpScale * tw) / Math.max(1, width);
          const count = packDrops(
            packed,
            rain,
            tw,
            th,
            pxPerRef,
            BASE_WAVELENGTH * Math.max(0.1, p.ringSize),
          );

          const vi = p.branches ? 1 : 0;
          const u = variants[vi];
          gl.useProgram(u.program);
          let dirty = vi !== lastVariant || tw !== lastW || th !== lastH;
          lastVariant = vi;
          lastW = tw;
          lastH = th;
          if (u.f2("uInvSize", 1 / tw, 1 / th)) {
            dirty = true;
          }
          const k = (DISPLACE_REF * vpScale) / Math.max(1, height);
          if (u.f2("uDisp", (k * height) / Math.max(1, width), k)) {
            dirty = true;
          }
          // The ramp is in uv: aspect-correct the direction so it reads as a diagonal.
          const aspect = width / Math.max(1, height);
          const rx = SKY_DIR[0] * aspect * SKY_SPAN;
          const ry = SKY_DIR[1] * SKY_SPAN;
          if (u.f3("uSkyRamp", rx, ry, 0.5 - 0.5 * (rx + ry))) {
            dirty = true;
          }
          if (u.rgb("uWater", p.water)) {
            dirty = true;
          }
          if (u.rgb("uSky", p.skyTint)) {
            dirty = true;
          }
          if (u.f1("uDither", target.direct ? 1 : 0)) {
            dirty = true;
          }
          if (u.i1("uCount", count)) {
            dirty = true;
          }

          // Still water renders once; only the blit runs until the next drop.
          if (dirty || count > 0 || lastCount !== 0 || target.direct) {
            if (count > 0) {
              gl.uniform4fv(u.loc.uDrops, packed);
            }
            if (vi === 1) {
              gl.activeTexture(gl.TEXTURE0);
              gl.bindTexture(gl.TEXTURE_2D, mask);
            }
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          lastCount = count;
          target.blit();
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
