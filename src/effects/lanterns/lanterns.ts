import { type Rgb, unitRgbMemo } from "../color";
import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import {
  BODY_HALF_HEIGHT,
  BODY_STRIP,
  createLanterns,
  HALO_RADIUS,
  type LanternFrame,
} from "./lanterns-sim";
import { createRng } from "../noise";
import { createSpriteBatch, polygonStrip, QUAD, SPRITE_SPIN_GLSL } from "../sprites";
import { lanternsMeta, MAX_LANTERNS } from "./lanterns.meta";
import { defineEffect } from "../types";

const STAR_COUNT = 160;
/** Lake horizon as a fraction of the height from the top. */
const LAKE_HORIZON = 0.76;
/** Reflections: vertical stretch, brightness, and wobble amplitude (px at 1080p) and rate (rad/s). */
const REFLECT_STRETCH = 1.9;
const REFLECT_DIM = 0.42;
const WOBBLE_PX = 3;
const WOBBLE_RATE = 1.1;
/** Lake colours relative to the sky they mirror. */
const LAKE_NEAR = 0.55;
const LAKE_FAR = 0.45;
const STAR_COLOR: Rgb = [0.9, 0.92, 1];
const TAU = Math.PI * 2;
/** Shape indices in the lantern batch. */
const SHAPE_BODY = 0;
const SHAPE_HALO = 1;

/**
 * Shared vertex code for bodies and halos: places a corner offset (device px)
 * around a lantern's centre, or, when `uMirror.w` is on, its reflection in the
 * lake: mirrored about the horizon, stretched vertically, dimmed, and wobbled
 * sideways a little by its distance below the horizon.
 */
const PLACE_GLSL = /* glsl */ `
uniform vec2 uResolution;
/** Horizon y (px, y down), vertical stretch, brightness, mirrored (0 or 1). */
uniform vec4 uMirror;
/** Wobble phase (radians, wrapped) and amplitude (px). */
uniform vec2 uWobble;
${TO_CLIP_GLSL}
vec4 place(vec2 centre, vec2 offset) {
  if (uMirror.w > 0.5) {
    centre.y = 2.0 * uMirror.x - centre.y;
    centre.x += uWobble.y * sin(uWobble.x + centre.y / uResolution.y * 40.0);
    offset.y *= -uMirror.y;
  }
  return pxToClip(centre + offset, uResolution);
}
`;

/** Lantern body: the rounded trapezoid fan, tilted by the spin pair. */
const bodyVertex = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, half-width (device px, y down), opacity. */
layout(location = 1) in vec4 aLantern;
/** Colour, then halo strength. */
layout(location = 2) in vec4 aTint;
layout(location = ${String(spinLocation)}) in vec2 aSpin;
out vec2 vLocal;
out float vEdge;
flat out vec4 vColor;
${PLACE_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vLocal = aCorner;
  vEdge = dot(aCorner, aCorner) > 0.0 ? 1.0 : 0.0;
  vColor = vec4(aTint.rgb, aLantern.w * (uMirror.w > 0.5 ? uMirror.z : 1.0));
  gl_Position = place(aLantern.xy, spinCorner(aCorner, aSpin) * aLantern.z);
}
`;

/**
 * Glowing paper: darker at the top, brightest low down where the flame is, with
 * a warm hot spot over the flame and slightly denser paper at the rim.
 * Premultiplied, for source-over blending.
 */
const BODY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vEdge;
flat in vec4 vColor;
out vec4 outColor;
void main() {
  // About a pixel of anti-aliasing at the rim.
  float edge = clamp((1.0 - vEdge) / max(fwidth(vEdge), 1e-4), 0.0, 1.0);
  float t = vLocal.y * ${glslFloat(0.5 / BODY_HALF_HEIGHT)} + 0.5;
  float glow = mix(0.58, 1.05, t * t);
  vec2 f = vec2(vLocal.x * 2.2, (vLocal.y - ${glslFloat(BODY_HALF_HEIGHT * 0.72)}) * 2.6);
  float flame = exp(-dot(f, f));
  float rim = 1.0 - 0.18 * vEdge * vEdge * vEdge * vEdge;
  vec3 col = vColor.rgb * glow * rim + flame * 0.4 * mix(vColor.rgb, vec3(1.0, 0.95, 0.8), 0.6);
  float a = edge * vColor.a;
  outColor = vec4(min(col, vec3(1.0)) * a, a);
}
`;

/** Halo: an octagon (apothem 1 = the halo radius) a little below the centre, over the flame. */
const HALO_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aLantern;
layout(location = 2) in vec4 aTint;
out vec2 vLocal;
flat out vec3 vColor;
${PLACE_GLSL}
void main() {
  vLocal = aCorner;
  float a = aLantern.w * aTint.a * (uMirror.w > 0.5 ? uMirror.z : 1.0);
  vColor = aTint.rgb * a;
  vec2 offset = aCorner * (aLantern.z * ${glslFloat(HALO_RADIUS)}) + vec2(0.0, aLantern.z * 0.35);
  gl_Position = place(aLantern.xy, offset);
}
`;

/** A soft (1 - d²)² glow, additive, dithered since it is wide and shallow. */
const HALO_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float f = max(0.0, 1.0 - dot(vLocal, vLocal));
  float a = f * f;
  outColor = vec4(vColor * a + dither8(gl_FragCoord.xy) * a, 0.0);
}
`;

/** Stars: static points placed as fractions of the sky region. */
const STAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x, y (fractions of the sky, y down), radius (px at 1080), brightness. */
layout(location = 1) in vec4 aStar;
uniform vec2 uResolution;
/** Sky width and height in px. */
uniform vec2 uSky;
uniform float uScale;
out vec2 vLocal;
flat out float vBright;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vBright = aStar.w;
  gl_Position = pxToClip(aStar.xy * uSky + aCorner * max(aStar.z * uScale, 1.0), uResolution);
}
`;

const STAR_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in float vBright;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float t = max(1.0 - dot(vLocal, vLocal), 0.0);
  outColor = vec4(uColor * (vBright * t * t), 0.0);
}
`;

/**
 * Glowing paper sky lanterns rising slowly into a dusk sky, swaying and drifting
 * on the wind, far ones small and hazy, optionally over a still lake that
 * mirrors them.
 */
export const lanterns = defineEffect(lanternsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      // Per lantern: x, y, half-width, opacity; r, g, b, halo; then the spin pair.
      const batch = scope.own(
        createSpriteBatch(gl, MAX_LANTERNS, [4, 4], [BODY_STRIP, polygonStrip(8, Math.PI / 8)], {
          rotation: true,
        }),
      );
      const placeNames = ["uResolution", "uMirror", "uWobble"] as const;
      const bodyU = createUniforms(
        gl,
        program(bodyVertex(batch.spinLocation), BODY_FRAGMENT),
        placeNames,
      );
      const haloU = createUniforms(gl, program(HALO_VERTEX, HALO_FRAGMENT), placeNames);
      const starU = createUniforms(gl, program(STAR_VERTEX, STAR_FRAGMENT), [
        "uResolution",
        "uSky",
        "uScale",
        "uColor",
      ]);
      const stars = scope.own(createSpriteBatch(gl, STAR_COUNT, [4], [QUAD]));
      const sky = scope.own(createGradientBackground(gl));
      const lakeBackground = scope.own(createGradientBackground(gl));

      gl.useProgram(starU.program);
      starU.v3("uColor", STAR_COLOR);
      gl.useProgram(null);

      // Stars never move, so their instances are uploaded once. Fewer and fainter low down.
      {
        const rand = createRng(4107);
        const d = stars.data;
        for (let i = 0; i < STAR_COUNT; i++) {
          const o = i * stars.stride;
          const v = rand() ** 1.6 * 0.85;
          const bright = (0.2 + 0.6 * rand() ** 3) * (1 - v);
          d[o] = rand();
          d[o + 1] = v;
          d[o + 2] = 1.6 + 1.6 * bright;
          d[o + 3] = bright;
        }
        stars.upload(STAR_COUNT);
      }

      const skyTop = unitRgbMemo();
      const skyBottom = unitRgbMemo();
      const lanternColor = unitRgbMemo();
      const lakeTop: Rgb = [0, 0, 0];
      const lakeBottom: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      /** Wobble phase, wrapped to [0, 2π) on the CPU. */
      let wobble = 0;
      const field = createLanterns(MAX_LANTERNS, refWidth);
      const f: LanternFrame = {
        refWidth,
        scale,
        count: 0,
        size: 0,
        rise: 0,
        wind: 0,
        flicker: 0,
        bottom: 1080,
        lanternColor: [0, 0, 0],
        skyTop: [0, 0, 0],
        skyBottom: [0, 0, 0],
      };

      /** Draws the halos then the bodies of `n` instances, mirrored or not. */
      const drawLanterns = (n: number, mirrored: boolean, horizonPx: number) => {
        const mirror = mirrored ? 1 : 0;
        const wobbleAmp = WOBBLE_PX * scale;
        const first = field.haloFirst;
        if (n > first) {
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.useProgram(haloU.program);
          haloU.f2("uResolution", width, height);
          haloU.f4("uMirror", horizonPx, REFLECT_STRETCH, REFLECT_DIM, mirror);
          haloU.f2("uWobble", wobble, wobbleAmp);
          batch.draw(first, n - first, SHAPE_HALO);
        }
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(bodyU.program);
        bodyU.f2("uResolution", width, height);
        bodyU.f4("uMirror", horizonPx, REFLECT_STRETCH, REFLECT_DIM, mirror);
        bodyU.f2("uWobble", wobble, wobbleAmp);
        batch.draw(0, n, SHAPE_BODY);
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          field.rescaleX(newRefWidth / refWidth);
          ({ width, height, scale } = v);
          refWidth = f.refWidth = newRefWidth;
          f.scale = scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          wobble = (wobble + dt * WOBBLE_RATE) % TAU;
          const top = skyTop(p.skyTop);
          const bottom = skyBottom(p.skyBottom);
          // The sky ends at the lake horizon (px from the top), or the bottom of the frame.
          const horizonPx = p.lake ? Math.round(height * LAKE_HORIZON) : height;
          const lakePx = height - horizonPx;

          f.count = p.count;
          f.size = p.size;
          f.rise = p.rise;
          f.wind = p.wind;
          f.flicker = p.flicker;
          f.bottom = horizonPx / scale;
          f.lanternColor = lanternColor(p.lanternColor);
          f.skyTop = top;
          f.skyBottom = bottom;
          const n = field.step(dt, f, batch.data, batch.stride);

          // Sky (and lake), each clipped to its region; the scissor also bounds the
          // gradient's flat-colour clear.
          gl.enable(gl.SCISSOR_TEST);
          gl.viewport(0, lakePx, width, horizonPx);
          gl.scissor(0, lakePx, width, horizonPx);
          sky.draw(top, bottom);
          if (lakePx > 0) {
            for (let c = 0; c < 3; c++) {
              lakeTop[c] = bottom[c] * LAKE_NEAR;
              lakeBottom[c] = top[c] * LAKE_FAR;
            }
            gl.viewport(0, 0, width, lakePx);
            gl.scissor(0, 0, width, lakePx);
            lakeBackground.draw(lakeTop, lakeBottom);
          }
          gl.viewport(0, 0, width, height);

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          if (n > 0) {
            batch.upload(n);
          }

          // Reflections, below the horizon.
          if (lakePx > 0 && n > 0) {
            drawLanterns(n, true, horizonPx);
          }

          // Stars and lanterns, above it.
          gl.scissor(0, lakePx, width, horizonPx);
          if (p.stars) {
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(starU.program);
            starU.f2("uResolution", width, height);
            starU.f2("uSky", width, horizonPx);
            starU.f1("uScale", scale);
            stars.draw(0, STAR_COUNT);
          }
          if (n > 0) {
            drawLanterns(n, false, horizonPx);
          }

          gl.disable(gl.SCISSOR_TEST);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
