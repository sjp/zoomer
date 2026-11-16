import { BLOB_FIELD_FRAGMENT, writeBlobUniforms } from "../blob-field";
import { hexToLinear } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { blobsMeta, MAX_BLOBS } from "./blobs.meta";
import { defineEffect } from "../types";
import { growLive, stepLife, trimLive } from "../fade";
import { smoothstep } from "../math";

/** Wall seconds between low-res keyframes (~30 Hz); the blit cross-fades between two. */
export const KEYFRAME_INTERVAL = 1 / 30;
/** Low-res divisors: the image has no high frequencies, so even "high" is 1/16 of the pixels. */
const DIVISORS = { high: 4, balanced: 6, low: 8 } as const;
/** Grain amplitude (0..1 colour units, peak to peak) at `grain` = 1. */
const GRAIN_AMP = 0.06;
/** Seconds a blob takes to fade in or out when the count changes. */
const BLOB_FADE = 1.2;

// ---------------------------------------------------------------------------
// Palettes

export const PALETTES = {
  dusk: ["#ff6f61", "#b34fd1", "#4a58d9", "#ffb36b"],
  ocean: ["#0fa3b1", "#1e5fd8", "#5ce1e6", "#2b3a8c"],
  mint: ["#3ddc97", "#a8f0c6", "#1fb5a6", "#d6f5a3"],
  candy: ["#ff8fc7", "#ffd36e", "#8fd3ff", "#c79bff"],
  mono: ["#5a6274", "#8b93a6", "#3a4050", "#b8bfcc"],
} as const satisfies Record<string, readonly string[]>;

/**
 * The hex colour of blob `index` (colours repeat when there are more blobs than
 * palette entries). "custom" uses `custom`; unknown names fall back to "dusk".
 */
const isPaletteId = (v: string): v is keyof typeof PALETTES => Object.hasOwn(PALETTES, v);

export function paletteColor(palette: string, custom: readonly string[], index: number): string {
  const list: readonly string[] =
    palette === "custom" && custom.length > 0
      ? custom
      : isPaletteId(palette)
        ? PALETTES[palette]
        : PALETTES.dusk;
  return list[((index % list.length) + list.length) % list.length];
}

// ---------------------------------------------------------------------------
// Keyframe clock: low-res pass at ~30 Hz, cross-faded every frame.

export interface KeyframeClock {
  /** Wall seconds since keyframe A (the older of the two cached frames). */
  elapsed: number;
}

/**
 * Advances the keyframe clock by `dt` wall seconds and says how many low-res
 * keyframes to render this frame:
 * - 0: both cached frames are still valid; just cross-fade.
 * - 1: A has expired; the old B becomes A and a new B is rendered one interval ahead.
 * - 2: render both afresh (on `reset`, a non-positive interval, or after a gap of
 *   two intervals or more, when B is in the past too).
 * Non-finite or negative `dt` counts as 0.
 */
export function advanceKeyframes(
  clock: KeyframeClock,
  dt: number,
  interval: number,
  reset: boolean,
): 0 | 1 | 2 {
  if (reset || !(interval > 0)) {
    clock.elapsed = 0;
    return 2;
  }
  const e = clock.elapsed + (Number.isFinite(dt) && dt > 0 ? dt : 0);
  if (e < interval) {
    clock.elapsed = e;
    return 0;
  }
  if (e < 2 * interval) {
    clock.elapsed = e - interval;
    return 1;
  }
  clock.elapsed = 0;
  return 2;
}

/** Cross-fade weight of keyframe B: 0 shows A, 1 shows B. */
export function keyframeMix(clock: KeyframeClock, interval: number): number {
  return interval > 0 ? Math.min(1, Math.max(0, clock.elapsed / interval)) : 0;
}

/**
 * The two cached keyframe targets: which sim time each holds, and which one is
 * keyframe A (the older one, shown at mix 0).
 */
export interface KeyframeTargets {
  /** Sim time target 0 ("main") and target 1 ("aux") hold; NaN when stale. */
  readonly held: Float64Array;
  /** True when target 0 holds keyframe A. */
  mainIsA: boolean;
}

export const createKeyframeTargets = (): KeyframeTargets => ({
  held: new Float64Array([Number.NaN, Number.NaN]),
  mainIsA: true,
});

/** Calls `render(target, t)` unless `target` already holds sim time `t`. */
function renderKeyframe(
  k: KeyframeTargets,
  target: 0 | 1,
  t: number,
  render: (target: 0 | 1, t: number) => void,
): void {
  if (k.held[target] === t) {
    return;
  }
  render(target, t);
  k.held[target] = t;
}

/**
 * Renders the keyframes this frame needs, after `advanceKeyframes` returned
 * `due`, with sim time `time` now and `clock.elapsed` wall seconds since A:
 * - `invalid` (the image changed) marks both targets stale first;
 * - 2 renders A at `time` into target 0 and B one interval of sim time ahead;
 * - 1 makes the old B the new A and renders the next B into the old A's target,
 *   at the sim time it will be shown at (one interval after the old B);
 * - a speed change moves that time, so B is re-rendered for it (A is shown already).
 */
export function updateKeyframes(
  k: KeyframeTargets,
  due: 0 | 1 | 2,
  invalid: boolean,
  time: number,
  speed: number,
  speedChanged: boolean,
  clock: KeyframeClock,
  interval: number,
  render: (target: 0 | 1, t: number) => void,
): void {
  if (invalid) {
    k.held.fill(Number.NaN);
  }
  if (due === 2) {
    k.mainIsA = true;
    renderKeyframe(k, 0, time, render);
    renderKeyframe(k, 1, time + speed * interval, render);
  } else if (due === 1 || speedChanged) {
    if (due === 1) {
      k.mainIsA = !k.mainIsA;
    }
    const lead = speed * (interval - clock.elapsed);
    renderKeyframe(k, k.mainIsA ? 1 : 0, time + lead, render);
  }
}

// ---------------------------------------------------------------------------
// Shaders

/** Blit body: cross-fade the two keyframes, then optional static grain. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uAux;
/** Weight of uAux (unit 1) against uLowRes (unit 0). */
uniform float uMix;
uniform float uGrain;
vec4 composite(vec2 uv) {
  vec3 c = mix(texture(uLowRes, uv).rgb, texture(uAux, uv).rgb, uMix);
  if (uGrain > 0.0) {
    // Static per-pixel hash: hides banding, and a still pattern costs a codec nothing.
    uvec2 q = uvec2(gl_FragCoord.xy);
    uint h = q.x * 1664525u + q.y * 1013904223u;
    h ^= h >> 16u;
    h *= 2246822519u;
    h ^= h >> 13u;
    float g = float(h & 65535u) * (1.0 / 65535.0) - 0.5;
    c += g * uGrain;
  }
  return vec4(c, 1.0);
}
`;

/**
 * Soft gradient blobs: a handful of large Gaussian colour fields drifting on slow
 * Lissajous paths, blended in linear light over a base colour. Rendered at 1/8 res
 * (by default) at ~30 Hz into two cached keyframes, which the full-res blit
 * cross-fades every frame so the motion never steps.
 */
export const blobs = defineEffect(blobsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BLOB_FIELD_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const mainT = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      // Sampled by mainT's composite, so it must never render direct: DIVISORS are all > 1.
      const auxT = scope.own(createLowResTarget(gl));
      const u = createUniforms(gl, program, ["uToUnits", "uBlobs", "uColors", "uBase", "uCount"]);
      const cu = createUniforms(gl, mainT.program, ["uAux", "uMix", "uGrain"]);
      gl.useProgram(mainT.program);
      cu.i1("uAux", 1);

      const blobData = new Float32Array(MAX_BLOBS * 4);
      /** Count fade (see `fade.ts`), and its eased weight per blob. */
      const blobLife = new Float32Array(MAX_BLOBS);
      const blobWeight = new Float32Array(MAX_BLOBS);
      /** Blobs drawn: the count plus any still fading out; NaN before the first frame. */
      let live = Number.NaN;
      const colorData = new Float32Array(MAX_BLOBS * 3);
      const custom = ["", "", "", ""];
      const clock: KeyframeClock = { elapsed: 0 };

      let width = 1;
      let height = 1;
      let aspect = 1;
      /** Sim seconds (speed-scaled), float64. */
      let time = 0;
      const keys = createKeyframeTargets();
      let lastAspect = 0;
      let lastPalette = "";
      let lastC1 = "";
      let lastC2 = "";
      let lastC3 = "";
      let lastC4 = "";
      let lastBg = "";
      let lastSoftness = Number.NaN;
      let lastSpeed = Number.NaN;
      let count = 3;
      let softness = 1;

      /** Renders the blob field at sim time `t` into target 0 (main) or 1 (aux). */
      const renderKey = (target: 0 | 1, t: number): void => {
        writeBlobUniforms(blobData, count, t, aspect, softness, blobWeight);
        gl.useProgram(program);
        gl.uniform4fv(u.loc.uBlobs, blobData);
        (target === 0 ? mainT : auxT).bind();
        triangle.draw();
      };

      return {
        resize(v) {
          width = v.width;
          height = v.height;
          aspect = width / Math.max(1, height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += (Number.isFinite(dt) && dt > 0 ? dt : 0) * p.speed;
          let invalid = false;

          const divisor = qualityDivisor(p.quality, DIVISORS);
          mainT.resize(width, height, divisor);
          auxT.resize(width, height, divisor);
          gl.useProgram(program);
          // Blob positions depend on the aspect too, so it invalidates on its own.
          if (u.f2("uToUnits", aspect / mainT.width, 1 / mainT.height) || aspect !== lastAspect) {
            lastAspect = aspect;
            invalid = true;
          }
          const target = Math.max(1, Math.min(MAX_BLOBS, Math.round(p.blobs)));
          if (Number.isNaN(live)) {
            // Start with the blobs shown rather than fading them all in.
            blobLife.fill(1);
            live = target;
          }
          count = live = growLive(blobLife, live, target);
          const fadeStep = (Number.isFinite(dt) && dt > 0 ? dt : 0) / BLOB_FADE;
          for (let i = 0; i < count; i++) {
            const before = blobLife[i];
            const l = stepLife(blobLife, i, target, fadeStep, fadeStep);
            blobWeight[i] = smoothstep(0, 1, l);
            // While a blob fades, both keyframes are re-rendered each frame (briefly).
            if (l !== before) {
              invalid = true;
            }
          }
          live = trimLive(blobLife, live, target);
          if (u.i1("uCount", count)) {
            invalid = true;
          }
          if (p.softness !== lastSoftness) {
            lastSoftness = softness = p.softness;
            invalid = true;
          }
          if (
            p.palette !== lastPalette ||
            p.color1 !== lastC1 ||
            p.color2 !== lastC2 ||
            p.color3 !== lastC3 ||
            p.color4 !== lastC4
          ) {
            lastPalette = p.palette;
            custom[0] = lastC1 = p.color1;
            custom[1] = lastC2 = p.color2;
            custom[2] = lastC3 = p.color3;
            custom[3] = lastC4 = p.color4;
            for (let i = 0; i < MAX_BLOBS; i++) {
              colorData.set(hexToLinear(paletteColor(p.palette, custom, i)), i * 3);
            }
            gl.uniform3fv(u.loc.uColors, colorData);
            invalid = true;
          }
          if (p.background !== lastBg) {
            lastBg = p.background;
            u.v3("uBase", hexToLinear(p.background));
            invalid = true;
          }
          const due = advanceKeyframes(clock, dt, KEYFRAME_INTERVAL, invalid);
          const speedChanged = p.speed !== lastSpeed;
          updateKeyframes(
            keys,
            due,
            invalid,
            time,
            p.speed,
            speedChanged,
            clock,
            KEYFRAME_INTERVAL,
            renderKey,
          );
          lastSpeed = p.speed;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          // Blit: main on unit 0 (bound by blit), aux on unit 1.
          gl.useProgram(mainT.program);
          const b = keyframeMix(clock, KEYFRAME_INTERVAL);
          const mix = keys.mainIsA ? b : 1 - b;
          cu.f1("uMix", mix);
          cu.f1("uGrain", Math.max(0, p.grain) * GRAIN_AMP);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, auxT.texture);
          mainT.blit();
          // Unbind both so neither is sampled while it is a render target next frame.
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
