import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createLowResTarget } from "./lowres";
import { createSpriteBatch, polygonStrip } from "./sprites";
import {
  type Backdrop,
  backdropPositions,
  buildBackdrop,
  buildWeb,
  DROP_FLOATS,
  LIGHTS,
  MAX_BLOBS,
  REF_HEIGHT,
  type WebCorner,
  type WebFrame,
  type WebGeometry,
  type WebLight,
  writeDrops,
  writeThreads,
} from "./spiderweb-sim";
import { spiderwebMeta } from "./spiderweb.meta";
import { createStreakRenderer } from "./streaks";
import { defineEffect } from "./types";

/** Thread segments and drops the buffers hold; a size-1 web at full dew uses well under this. */
const MAX_THREADS = 4096;
const MAX_DROPS = 8192;
/** Backdrop pass: about 4 reference px per texel (divisor 8 at 4K). It is all soft. */
const BACKDROP_TEXEL_REF = 4;
/** Drop sprites reach this many drop radii, for the glint's halo. */
const DROP_EXTENT = 1.9;

/**
 * Backdrop: a gradient, a low sun glow on the web's side, then soft foliage blobs
 * (mixed over) and out-of-focus highlights (flat discs with a soft edge, added).
 * Rendered at low resolution; the blit adds dither.
 */
const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec2 uRefSize;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
/** Glow centre (reference px) and 1 / radius. */
uniform vec3 uGlowAt;
/** Per blob: x, y (reference px, y down), 1 / radius, kind (0 foliage, 1 bokeh). */
uniform vec4 uBlob[${MAX_BLOBS}];
/** Per blob: colour, strength. */
uniform vec4 uBlobColor[${MAX_BLOBS}];
uniform int uBlobCount;
out vec4 outColor;
void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uRefSize;
  vec3 c = mix(uBottom, uTop, vUv.y);
  vec2 g = (p - uGlowAt.xy) * uGlowAt.z;
  c += uGlow * exp(-dot(g, g));
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    if (i >= uBlobCount) break;
    vec4 b = uBlob[i];
    vec4 col = uBlobColor[i];
    vec2 d = (p - b.xy) * b.z;
    float q = dot(d, d);
    if (b.w < 0.5) {
      c = mix(c, col.rgb, col.a * exp(-2.5 * q));
    } else {
      float r = sqrt(q);
      float disc = (1.0 - smoothstep(0.72, 1.0, r)) * (0.8 + 0.2 * smoothstep(0.35, 0.9, r));
      c += col.rgb * (col.a * disc);
    }
  }
  outColor = vec4(c, 1.0);
}
`;

/** Drops: an octagon around each, `DROP_EXTENT` radii across. */
const DROP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y and radius (device px, y down), glint. */
layout(location = 1) in vec4 aDrop;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec2 vRadiusGlint;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner * ${glslFloat(DROP_EXTENT)};
  vRadiusGlint = aDrop.zw;
  gl_Position = pxToClip(aDrop.xy + vLocal * aDrop.z, uResolution);
}
`;

/**
 * A tiny lens, premultiplied over: a dark rim, a faint inverted scene brighter on
 * the side away from the light, and a specular glint offset toward the light with
 * a soft halo when it peaks. The glint keeps at least about a pixel's width, with
 * its energy kept roughly level, so small drops don't sparkle as they move.
 */
const DROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vRadiusGlint;
/** Unit direction toward the sun (y down). */
uniform vec2 uToLight;
uniform vec3 uLens;
uniform vec3 uRim;
uniform vec3 uSun;
out vec4 outColor;
void main() {
  float radius = vRadiusGlint.x;
  float glint = vRadiusGlint.y;
  float d = length(vLocal);
  float cover = clamp((1.0 - d) * radius + 0.5, 0.0, 1.0);
  float rim = smoothstep(0.4, 1.0, d);
  float far = max(0.0, -dot(vLocal, uToLight));
  vec3 col = mix(uLens * (0.65 + 0.9 * far), uRim, rim * 0.85);
  float a = cover * mix(0.5, 0.92, rim);
  vec2 s = vLocal - uToLight * 0.42;
  float s2 = dot(s, s);
  float k = min(30.0, radius * radius * 1.4);
  float spec = exp(-s2 * k) * sqrt(k * ${glslFloat(1 / 30)}) * glint * cover;
  float halo = exp(-s2 * 2.5) * glint * glint * 0.16;
  outColor = vec4(col * a + uSun * (spec * 1.6 + halo), a);
}
`;

/**
 * An orb web strung across one corner at dawn, beaded with dew. The threads catch
 * the low sun where they run across it, the drops glint as the web sways, and
 * behind it all a soft blur of foliage and warm light drifts very slowly.
 */
export const spiderweb = defineEffect(spiderwebMeta, {
  create(gl) {
    return withScope((scope) => {
      const target = scope.own(createLowResTarget(gl));
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => gl.deleteProgram(p));
      const backdropProgram = program(FULLSCREEN_VERTEX, BACKDROP_FRAGMENT);
      const bu = createUniforms(gl, backdropProgram, [
        "uRefSize",
        "uTop",
        "uBottom",
        "uGlow",
        "uGlowAt",
        "uBlob",
        "uBlobColor",
        "uBlobCount",
      ]);
      const dropProgram = program(DROP_VERTEX, DROP_FRAGMENT);
      const du = createUniforms(gl, dropProgram, [
        "uResolution",
        "uToLight",
        "uLens",
        "uRim",
        "uSun",
      ]);
      const drops = scope.own(
        createSpriteBatch(gl, MAX_DROPS, [DROP_FLOATS], [polygonStrip(8, Math.PI / 8)]),
      );
      const threads = scope.own(createStreakRenderer(gl, MAX_THREADS, { blend: "alpha" }));

      const blobPositions = new Float32Array(MAX_BLOBS * 4);
      const f: WebFrame = { time: 0, sway: 0, dew: 0, scale: 1, light: LIGHTS.dawn };
      let web: WebGeometry | null = null;
      let backdrop: Backdrop | null = null;

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      /** What the web and backdrop were built from; empty or NaN forces a rebuild. */
      let builtCorner = "";
      let builtSize = NaN;
      let builtSeed = NaN;
      let builtWidth = NaN;
      let builtLight = "";

      return {
        resize(v) {
          ({ width, height } = v);
          f.scale = v.scale;
          refWidth = v.width / v.scale;
          target.resize(width, height, Math.max(1, BACKDROP_TEXEL_REF * v.scale));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          f.time += dt;
          f.sway = p.sway;
          f.dew = p.dew;
          const lightId = (p.light in LIGHTS ? p.light : "dawn") as WebLight;
          f.light = LIGHTS[lightId];
          const corner = p.corner as WebCorner;
          const seed = Math.floor(p.seed);
          const layoutChanged =
            corner !== builtCorner || seed !== builtSeed || refWidth !== builtWidth;
          if (!web || layoutChanged || p.size !== builtSize) {
            web = buildWeb({ corner, size: p.size, seed, refWidth });
            builtSize = p.size;
          }
          if (!backdrop || layoutChanged || lightId !== builtLight) {
            backdrop = buildBackdrop(f.light, corner, seed, refWidth);
            gl.useProgram(backdropProgram);
            gl.uniform4fv(bu.loc.uBlobColor, backdrop.color);
            bu.i1("uBlobCount", backdrop.count);
            bu.f3("uGlowAt", backdrop.glowX, backdrop.glowY, backdrop.glowInvR);
            builtLight = lightId;
          }
          builtCorner = corner;
          builtSeed = seed;
          builtWidth = refWidth;

          // 1. The backdrop at low resolution, upscaled with dither.
          backdropPositions(backdrop, f.time, blobPositions);
          target.bind();
          gl.useProgram(backdropProgram);
          bu.f2("uRefSize", refWidth, REF_HEIGHT);
          bu.v3("uTop", f.light.top);
          bu.v3("uBottom", f.light.bottom);
          bu.v3("uGlow", f.light.glow);
          gl.uniform4fv(bu.loc.uBlob, blobPositions);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // 2. Threads, straight-alpha over the backdrop.
          const nThreads = writeThreads(web, f, threads.data);
          if (nThreads > 0) {
            threads.upload(nThreads);
            threads.draw(nThreads, width, height);
          }

          // 3. Drops, premultiplied over: dark rims and bright glints in one pass.
          const nDrops = writeDrops(web, f, drops.data);
          if (nDrops > 0) {
            drops.upload(nDrops);
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(dropProgram);
            du.f2("uResolution", width, height);
            du.f2("uToLight", -web.sunX, -web.sunY);
            du.v3("uLens", f.light.lens);
            du.v3("uRim", f.light.rim);
            du.v3("uSun", f.light.sun);
            drops.draw(0, nDrops);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
