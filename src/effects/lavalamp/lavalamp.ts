import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  type Uniforms,
  withScope,
  scopedProgram,
} from "../gl";
import {
  BASE_RADIUS,
  type Blob,
  EPS,
  fillBlobs,
  makeBlobs,
  MAX_BLOBS,
  REF_H,
} from "./lavalamp-blobs";
import { createChangeKey } from "../change-key";
import { growLive, stepLife, trimLive } from "../fade";
import { lavalampMeta } from "./lavalamp.meta";
import { defineEffect } from "../types";

const TAU = Math.PI * 2;
/** Seconds a blob takes to grow in or shrink away when the count changes. */
const BLOB_FADE = 1.2;
/** Widest aspect ratio the lamp stretches to; wider frames stretch it horizontally. */
export const MAX_ASPECT = 4;
/** Field value of the blob surface. */
const THRESHOLD = 1;

/** Bound on the pool ripple: |sin a + 0.6 sin b| <= 1.6. */
export const POOL_WOB = 1.6;
/**
 * Side of the square pixel tiles the field is bounded over, as a power of two.
 * 16 px tiles are whole GPU warps/wavefronts (8x4 or 8x8), so the per-tile
 * shortcut in the main pass never diverges within one.
 */
export const TILE_SHIFT = 4;
export const TILE = 1 << TILE_SHIFT;
/** Mask texel values (R8): the tile is all background, or all saturated wax core. */
const MASK_BG = 1;
const MASK_CORE = 0.5;

/** Uniforms shared by both passes: the field in lamp units. */
const FIELD_UNIFORMS = /* glsl */ `
uniform vec2 uResolution;
/** Lamp units per device pixel, x and y. */
uniform vec2 uScale;
/**
 * Per blob, (q, c) such that d = p * q + c is the offset from the blob centre
 * pre-scaled by (sqrt(stretch), 1 / sqrt(stretch)), so the field term is r^2 / (d.d + EPS).
 */
uniform vec4 uBlobs[${String(MAX_BLOBS)}];
/** Per blob radius squared, in lamp units squared. */
uniform float uBlobR2[${String(MAX_BLOBS)}];
uniform int uCount;
uniform float uPoolR2;

const int MAX_BLOBS = ${String(MAX_BLOBS)};
const float REF_H = ${glslFloat(REF_H)};
const float THRESHOLD = ${glslFloat(THRESHOLD)};
const float EPS = ${glslFloat(EPS)};
`;

/**
 * Tile classifier, drawn at one fragment per TILE x TILE pixel tile. Each field term
 * falls off monotonically in |d.x| and |d.y|, so evaluating it at the nearest and
 * farthest offsets over the tile's rectangle bounds it exactly; summed, they bound
 * the field. A tile whose upper bound is below every threshold renders as pure
 * background, and one whose lower bound is above them all as pure core colour, so
 * the main pass can skip the field there with no change to the output.
 */
const MASK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${FIELD_UNIFORMS}
/** Field upper bound below which a pixel is pure background. */
uniform float uBgLimit;
/** Field lower bound above which a pixel is pure saturated core. */
uniform float uCoreLimit;

out vec4 outColor;

const float TILE = ${glslFloat(TILE)};
const float POOL_Y_MIN = REF_H * (1.025 - 0.009 * ${glslFloat(POOL_WOB)});
const float POOL_Y_MAX = REF_H * (1.025 + 0.009 * ${glslFloat(POOL_WOB)});

void main() {
  // The tile's pixel rectangle (slightly generous: whole pixel edges), in lamp units.
  vec2 lo = floor(gl_FragCoord.xy) * TILE;
  vec2 hi = lo + TILE;
  vec2 pMin = vec2(lo.x, uResolution.y - hi.y) * uScale;
  vec2 pMax = vec2(hi.x, uResolution.y - lo.y) * uScale;

  float fieldMax = 0.0;
  float fieldMin = 0.0;
  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uCount) break;
    vec4 b = uBlobs[i];
    // q > 0, so the offsets over the rectangle span [a, c] per axis.
    vec2 a = pMin * b.xy + b.zw;
    vec2 c = pMax * b.xy + b.zw;
    vec2 dNear = max(vec2(0.0), max(a, -c));
    vec2 dFar = max(-a, c);
    fieldMax += uBlobR2[i] / (dot(dNear, dNear) + EPS);
    fieldMin += uBlobR2[i] / (dot(dFar, dFar) + EPS);
  }
  float pdNear = max(0.0, POOL_Y_MIN - pMax.y);
  float pdFar = max(0.0, POOL_Y_MAX - pMin.y);
  fieldMax += uPoolR2 / (pdNear * pdNear + EPS);
  fieldMin += uPoolR2 / (pdFar * pdFar + EPS);

  float m = fieldMax < uBgLimit ? ${glslFloat(MASK_BG)} : (fieldMin > uCoreLimit ? ${glslFloat(MASK_CORE)} : 0.0);
  outColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${FIELD_UNIFORMS}
/** Per-tile classification from MASK_FRAGMENT. */
uniform sampler2D uMask;
/** 1 / lamp width in lamp units (height is REF_H). */
uniform float uInvLampW;
/** Pool ripple phases, wrapped to [0, TAU) on the CPU. */
uniform vec2 uPoolPhase;
uniform vec3 uWaxTop;
uniform vec3 uWaxBottom;
uniform vec3 uBgTop;
uniform vec3 uBgBottom;
uniform float uGlow;
uniform float uSoftness;

out vec4 outColor;

const int TILE_SHIFT = ${String(TILE_SHIFT)};
${DITHER_GLSL}
void main() {
  // Lamp coordinates, y down like the 2D canvas.
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) * uScale;
  float t = clamp((p.y - 0.5) / (REF_H - 1.0), 0.0, 1.0);
  vec3 bg = mix(uBgTop, uBgBottom, t);
  // Sub-LSB dither on all three output paths, so tiles and per-pixel areas match:
  // the background gradient otherwise bands into strips about 47 px tall at 4K.
  float dith = dither8(gl_FragCoord.xy);

  // Whole tiles of background or saturated core don't need the field (see MASK_FRAGMENT).
  float tile = texelFetch(uMask, ivec2(gl_FragCoord.xy) >> TILE_SHIFT, 0).r;
  if (tile > ${glslFloat((1 + MASK_CORE) / 2)}) {
    outColor = vec4(clamp(bg + dith, 0.0, 1.0), 1.0);
    return;
  }
  vec3 wax = mix(uWaxTop, uWaxBottom, t);
  if (tile > ${glslFloat(MASK_CORE / 2)}) {
    outColor = vec4(clamp(wax + (1.0 - wax) * (uGlow * 0.4) + dith, 0.0, 1.0), 1.0);
    return;
  }

  float field = 0.0;
  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uCount) break;
    // Moving wax stretches along its travel, keeping its area (the stretch is in q).
    vec4 b = uBlobs[i];
    vec2 d = p * b.xy + b.zw;
    field += uBlobR2[i] / (dot(d, d) + EPS);
  }

  // Wax pool resting along the bottom, with a slow ripple on its surface.
  float u = p.x * uInvLampW;
  float wob = sin(u * 5.1 + uPoolPhase.x) + 0.6 * sin(u * 9.7 + uPoolPhase.y);
  float poolY = REF_H * (1.025 + 0.009 * wob);
  float pd = max(0.0, poolY - p.y);
  field += uPoolR2 / (pd * pd + EPS);

  float alpha = smoothstep(THRESHOLD - uSoftness, THRESHOLD + uSoftness, field);
  // Inside: a slightly dimmer rim and a core that brightens towards white.
  float core = smoothstep(THRESHOLD, THRESHOLD + 2.6, field);
  float shade = 0.78 + 0.22 * smoothstep(THRESHOLD, THRESHOLD + 0.8, field);
  float lift = uGlow * 0.4 * core * core;
  // Outside: a soft halo of wax colour fading out to about 1.7 radii.
  float h = smoothstep(0.38, THRESHOLD, field);
  float halo = uGlow * 0.5 * h * h * (1.0 - alpha);

  vec3 shaded = wax * shade;
  vec3 lit = shaded + (1.0 - shaded) * lift;
  vec3 outside = bg + wax * halo;
  outColor = vec4(clamp(mix(outside, lit, alpha) + dith, 0.0, 1.0), 1.0);
}
`;

/** Wraps an angle into [0, TAU) so float32 uniforms stay precise over long runs. */
const wrapPhase = (a: number) => ((a % TAU) + TAU) % TAU;

/**
 * A lava lamp, drawn by a WebGL2 fragment shader: a metaball field (sum of r²/d²)
 * of slowly rising and sinking wax blobs over a soft wax pool, thresholded with an
 * anti-aliased edge and shaded with a vertical colour gradient, a brighter core
 * and an outer glow. Blob motion runs on the CPU; the field is evaluated per pixel.
 */
export const lavalamp = defineEffect(lavalampMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const maskProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, MASK_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const fieldNames = [
        "uResolution",
        "uScale",
        "uBlobs",
        "uBlobR2",
        "uCount",
        "uPoolR2",
      ] as const;
      const u = createUniforms(gl, program, [
        ...fieldNames,
        "uMask",
        "uInvLampW",
        "uPoolPhase",
        "uWaxTop",
        "uWaxBottom",
        "uBgTop",
        "uBgBottom",
        "uGlow",
        "uSoftness",
      ]);
      const maskU = createUniforms(gl, maskProgram, [...fieldNames, "uBgLimit", "uCoreLimit"]);
      // Uniforms persist with their program even in a shared context, so the ones
      // that only change with resize or params are uploaded only when they change.
      gl.useProgram(program);
      u.i1("uMask", 0);

      // One R8 texel per tile; storage is (re)allocated when the tile grid changes.
      let mask: RenderTarget | null = null;
      // Replaced when the tile grid changes, so dispose whichever one is current.
      scope.defer(() => mask?.dispose());

      let width = 1;
      let height = 1;
      let seedKey = Number.NaN;
      let blobs: Blob[] = [];
      /** Lamp seconds (scaled by speed), kept in float64; only derived values reach the GPU. */
      let time = 0;
      const blobData = new Float32Array(MAX_BLOBS * 4);
      const blobR2 = new Float32Array(MAX_BLOBS);
      /** Count fade (see `fade.ts`): blobs grow in and shrink away on a count change. */
      const blobLife = new Float32Array(MAX_BLOBS);
      /** Blobs in the field: the count plus any still shrinking away; NaN before the first frame. */
      let live = Number.NaN;
      /** What blobData and blobR2 were last computed from. */
      const blobInputs = createChangeKey(5);
      /**
       * Bumped whenever the blob arrays change. The arrays aren't change-tracked
       * uniforms, so each program remembers the version it last received, and a
       * paused lamp uploads nothing.
       */
      let blobVersion = 0;
      const blobVersions = { mask: -1, main: -1 };

      // Per-frame values read by uploadField.
      let scaleX = 1;
      let scaleY = 1;
      let poolR2 = 0;
      let count = 1;
      /** Uploads the field uniforms shared by both programs. */
      const uploadField = (
        fu: Uniforms<(typeof fieldNames)[number]>,
        which: keyof typeof blobVersions,
      ) => {
        fu.f2("uResolution", width, height);
        fu.f2("uScale", scaleX, scaleY);
        fu.f1("uPoolR2", poolR2);
        if (blobVersions[which] !== blobVersion) {
          blobVersions[which] = blobVersion;
          gl.uniform4fv(fu.loc.uBlobs, blobData);
          gl.uniform1fv(fu.loc.uBlobR2, blobR2);
        }
        fu.i1("uCount", count);
      };

      return {
        resize(v) {
          width = v.width;
          height = v.height;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt * p.speed;
          if (p.seed !== seedKey) {
            seedKey = p.seed;
            blobs = makeBlobs(p.seed);
          }

          const lampW = Math.max(
            1,
            Math.min(REF_H * MAX_ASPECT, (REF_H * width) / Math.max(1, height)),
          );
          const target = Math.max(1, Math.min(MAX_BLOBS, Math.round(p.count)));
          if (Number.isNaN(live)) {
            // The lamp starts full rather than growing every blob in.
            blobLife.fill(1);
            live = target;
          }
          const n = (live = growLive(blobLife, live, target));
          const fadeStep = dt / BLOB_FADE;
          let fading = false;
          for (let i = 0; i < n; i++) {
            const before = blobLife[i];
            if (stepLife(blobLife, i, target, fadeStep, fadeStep) !== before) {
              fading = true;
            }
          }
          live = trimLive(blobLife, live, target);
          if (fading) {
            blobInputs.invalidate();
          }
          const baseR = BASE_RADIUS * p.size * REF_H;
          blobInputs.set(0, time);
          blobInputs.set(1, n);
          blobInputs.set(2, baseR);
          blobInputs.set(3, lampW);
          blobInputs.set(4, p.seed);
          const blobsChanged = blobInputs.take();
          if (blobsChanged) {
            blobVersion++;
          }
          if (blobsChanged) {
            fillBlobs(blobData, blobR2, blobs, n, time, baseR, lampW, blobLife);
          }

          // Tile classification pass, into the mask texture.
          const tw = (width + TILE - 1) >> TILE_SHIFT;
          const th = (height + TILE - 1) >> TILE_SHIFT;
          if (!mask || tw !== mask.width || th !== mask.height) {
            mask?.dispose();
            mask = null;
            // Allocates only when the mask's size changes.
            mask = createRenderTarget(gl, tw, th, gl.R8, { filter: gl.NEAREST });
            if (!mask) {
              throw new Error("Lava lamp: R8 mask is not renderable");
            }
          }
          scaleX = lampW / Math.max(1, width);
          scaleY = REF_H / Math.max(1, height);
          const poolR = 0.05 * Math.sqrt(p.size) * REF_H;
          poolR2 = poolR * poolR;
          count = n;

          mask.bind();
          gl.useProgram(maskProgram);
          uploadField(maskU, "mask");
          // A pixel is pure background once both the halo (from 0.38) and the edge
          // (from 1 - softness) are zero, and pure core once the edge, rim shade and
          // core lift have all saturated. 1% margins absorb float rounding in the bounds.
          maskU.f1("uBgLimit", 0.99 * Math.min(0.38, THRESHOLD - p.softness));
          maskU.f1("uCoreLimit", 1.01 * Math.max(THRESHOLD + 2.6, THRESHOLD + p.softness));
          triangle.draw();

          // Main pass, into the default framebuffer.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, mask.texture);
          uploadField(u, "main");
          u.f1("uInvLampW", 1 / lampW);
          u.f2("uPoolPhase", wrapPhase(time * 0.13), wrapPhase(1.7 - time * 0.21));
          u.f1("uSoftness", p.softness);
          u.f1("uGlow", p.glow);
          u.rgb("uWaxTop", p.colorTop);
          u.rgb("uWaxBottom", p.colorBottom);
          u.rgb("uBgTop", p.bgTop);
          u.rgb("uBgBottom", p.bgBottom);
          triangle.draw();
          // Unbind the mask so it is never sampled while it is the render target.
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
