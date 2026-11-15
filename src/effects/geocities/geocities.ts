import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import { createCrossfadeSlots } from "../fade";
import { beginFrame, createUniforms, scopedProgram, TO_CLIP_GLSL, withScope } from "../gl";
import { createLowResTarget, lowResSize } from "../lowres";
import { clamp } from "../math";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch, SPRITE_SPIN_GLSL } from "../sprites";
import { defineEffect } from "../types";
import type { TileId } from "./geocities.meta";
import {
  createGeoMeasure,
  MAX_TEXTURE,
  paintMarquee,
  paintPage,
  paintParts,
  type PartsArt,
} from "./geocities-art";
import {
  badgeAngle,
  blinkAlpha,
  COUNTER_DIGITS,
  createGeoClock,
  createHitCounter,
  geoStyle,
  type GeoStyle,
  geoTile,
  globeFrame,
  type HitCounter,
  layoutPage,
  marqueeOffset,
  PAGE_SHORT,
  type PageLayout,
  stepGeoClock,
  stepHitCounter,
  workerFrame,
} from "./geocities-sim";
import { geocitiesMeta } from "./geocities.meta";

/** Seconds a style, text or tile change crossfades. */
const CROSSFADE = 1;
/** Seconds the typed text and the canvas size must hold before the page is redrawn. */
const SETTLE = 0.3;

/** Sprites per slot: page, sign words, worker, badge, two globes, the digits, the marquee. */
const SLOT_SPRITES = 6 + COUNTER_DIGITS + 1;
const MAX_SPRITES = 2 * SLOT_SPRITES;

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (target px, y down), half width, half height (px). */
layout(location = 1) in vec4 aSprite;
/** Atlas rectangle: u0, v0, u1, v1 (v down). */
layout(location = 2) in vec4 aUv;
/** Tint and opacity. */
layout(location = 3) in vec4 aTint;
layout(location = 4) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vUv;
flat out vec4 vTint;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vTint = aTint;
  gl_Position = pxToClip(aSprite.xy + spinCorner(aCorner * aSprite.zw, aSpin), uResolution);
}
`;

/** One texture fetch, faded; premultiplied out. */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in vec4 vTint;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv) * vec4(vTint.rgb, 1.0) * vTint.a;
}
`;

/** Classic's upscale: nearest texel, faded by `uAlpha` (premultiplied). */
const NEAREST_COMPOSITE = /* glsl */ `
uniform float uAlpha;
vec4 composite(vec2 uv) {
  ivec2 size = ivec2(uLowResSize);
  ivec2 p = clamp(ivec2(uv * uLowResSize), ivec2(0), size - 1);
  return texelFetch(uLowRes, p, 0) * uAlpha;
}
`;

/** One look of the page: its params and the textures drawn for them. */
interface Slot {
  style: GeoStyle;
  text: string;
  marquee: string;
  tile: TileId;
  page: CanvasTexture;
  parts: CanvasTexture;
  strip: CanvasTexture;
  layout: PageLayout | null;
  art: PartsArt | null;
  /** The marquee strip's period, page px. */
  period: number;
  /** The size the textures were drawn at (target px), and target px per page px. */
  tw: number;
  th: number;
  kx: number;
  ky: number;
  /** The canvas size key the textures were drawn for; -1 when empty. */
  painted: number;
}

/** Classic's low-res divisor: the page's short side drawn at `PAGE_SHORT` px. */
const classicDivisor = (width: number, height: number) =>
  Math.max(1, Math.min(width, height) / PAGE_SHORT);

/**
 * A late-90s homepage, proudly under construction, framing the speaker: a
 * tiled background, a rainbow title between two spinning globes, a
 * construction sign with a digging worker, bevelled buttons with a spinning
 * NEW! badge, a hit counter, a rainbow rule, a marquee and a footer, all round
 * the edges. The static page, the moving parts and the marquee strip are drawn
 * on 2D canvases once per text, tile, style and size (geocities-art.ts); each
 * frame is a page quad and a dozen sprites. Classic draws them into an
 * 800 x 600-style low-res target and upscales it with nearest filtering.
 */
export const geocities = defineEffect(geocitiesMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uTex"]);
      const batch = scope.own(
        createSpriteBatch(gl, MAX_SPRITES, [4, 4, 4], undefined, { rotation: true }),
      );
      const target = scope.own(
        createLowResTarget(gl, {
          composite: NEAREST_COMPOSITE,
          dither: false,
          premultiplied: true,
        }),
      );
      const ut = createUniforms(gl, target.program, ["uAlpha"]);
      const slots: Slot[] = [0, 1].map(() => ({
        style: "classic",
        text: "",
        marquee: "",
        tile: "stars",
        page: createCanvasTexture(gl, scope, { premultiply: true }),
        parts: createCanvasTexture(gl, scope, { premultiply: true }),
        strip: createCanvasTexture(gl, scope, { premultiply: true }),
        layout: null,
        art: null,
        period: 1,
        tw: 1,
        th: 1,
        kx: 1,
        ky: 1,
        painted: -1,
      }));
      gl.useProgram(program);
      u.i1("uTex", 0);
      gl.useProgram(null);

      const measure = createGeoMeasure();
      const settledText = createSettledValue<string>(SETTLE);
      const settledMarquee = createSettledValue<string>(SETTLE);
      const settledSize = createSettledValue<number>(SETTLE);
      const clock = createGeoClock();
      let counter: HitCounter | null = null;
      const data = batch.data;
      const stride = batch.stride;

      let width = 1;
      let height = 1;
      let size = -1;
      let count = 0;

      const put = (
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        u0: number,
        v0: number,
        u1: number,
        v1: number,
        alpha: number,
        angle: number,
        flip: number,
      ) => {
        const o = count * stride;
        data[o] = cx;
        data[o + 1] = cy;
        data[o + 2] = hw;
        data[o + 3] = hh;
        data[o + 4] = u0;
        data[o + 5] = v0;
        data[o + 6] = u1;
        data[o + 7] = v1;
        data[o + 8] = 1;
        data[o + 9] = 1;
        data[o + 10] = 1;
        data[o + 11] = alpha;
        data[o + 12] = angle;
        data[o + 13] = flip;
        count++;
      };

      /** Sets a texture's filter and horizontal wrap. */
      const texParams = (texture: WebGLTexture, filter: GLenum, wrapS: GLenum) => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };

      /** Draws a slot's page, parts and marquee strip for its params at the current size. */
      const paint = (slot: Slot) => {
        const classic = slot.style === "classic";
        const layout = layoutPage(width / height, slot.text, measure);
        if (classic) {
          const d = classicDivisor(width, height);
          slot.tw = lowResSize(width, d);
          slot.th = lowResSize(height, d);
        } else {
          const c = Math.min(1, MAX_TEXTURE / Math.max(width, height));
          slot.tw = Math.max(1, Math.round(width * c));
          slot.th = Math.max(1, Math.round(height * c));
        }
        slot.kx = slot.tw / layout.width;
        slot.ky = slot.th / layout.height;
        slot.layout = layout;
        slot.page.upload(paintPage(layout, slot.tile, slot.tw, slot.th, classic));
        const art = paintParts(layout, slot.kx, slot.ky, classic);
        slot.parts.upload(art.canvas);
        // The texture holds the parts now: keep only where each one sits.
        art.canvas = null;
        slot.art = art;
        const strip = paintMarquee(slot.marquee, layout, measure, slot.kx, slot.ky, classic);
        slot.period = strip.period;
        slot.strip.upload(strip.canvas);
        const filter = classic ? gl.NEAREST : gl.LINEAR;
        texParams(slot.page.texture, filter, gl.CLAMP_TO_EDGE);
        texParams(slot.parts.texture, filter, gl.CLAMP_TO_EDGE);
        texParams(slot.strip.texture, filter, gl.REPEAT);
        slot.painted = size;
      };
      const fill = (slot: Slot, style: GeoStyle, text: string, marquee: string, tile: TileId) => {
        slot.style = style;
        slot.text = text;
        slot.marquee = marquee;
        slot.tile = tile;
        paint(slot);
      };
      /** Frees a slot's textures and layout once nothing shows it. */
      const empty = (slot: Slot) => {
        slot.page.upload(null);
        slot.parts.upload(null);
        slot.strip.upload(null);
        slot.layout = null;
        slot.art = null;
        slot.painted = -1;
      };
      const fade = createCrossfadeSlots([slots[0], slots[1]], CROSSFADE, empty);

      /** Writes a slot's sprites (target px), every one at opacity `alpha`; returns the first marquee sprite. */
      const putSlot = (slot: Slot, alpha: number, blink: number) => {
        const layout = slot.layout;
        const art = slot.art;
        const kx = slot.kx;
        const ky = slot.ky;
        put(slot.tw / 2, slot.th / 2, slot.tw / 2, slot.th / 2, 0, 0, 1, 1, alpha, 0, 1);
        if (!layout || !art || !counter) {
          return count;
        }
        const st = layout.signText;
        const t = art.signText;
        put(
          (st.x + st.w / 2) * kx,
          (st.y + st.h / 2) * ky,
          (st.w / 2) * kx,
          (st.h / 2) * ky,
          t[0],
          t[1],
          t[2],
          t[3],
          alpha * blink,
          0,
          1,
        );
        const wk = layout.worker;
        const w = art.workers[workerFrame(clock)];
        put(
          (wk.x + wk.w / 2) * kx,
          (wk.y + wk.h / 2) * ky,
          (wk.w / 2) * kx,
          (wk.h / 2) * ky,
          w[0],
          w[1],
          w[2],
          w[3],
          alpha,
          0,
          1,
        );
        const b = layout.badge;
        const bu = art.badge;
        put(
          b.x * kx,
          b.y * ky,
          b.r * kx,
          b.r * ky,
          bu[0],
          bu[1],
          bu[2],
          bu[3],
          alpha,
          badgeAngle(clock),
          1,
        );
        const g = art.globes[globeFrame(clock)];
        for (let i = 0; i < 2; i++) {
          const r = layout.globes[i];
          put(
            (r.x + r.w / 2) * kx,
            (r.y + r.h / 2) * ky,
            (r.w / 2) * kx,
            (r.h / 2) * ky,
            g[0],
            g[1],
            g[2],
            g[3],
            alpha,
            0,
            i === 0 ? 1 : -1,
          );
        }
        const o = layout.odometer;
        const wheel = art.wheel;
        for (let i = 0; i < COUNTER_DIGITS; i++) {
          const v0 = wheel[1] + counter.wheels[i] * art.cell;
          put(
            (o.x + (i + 0.5) * layout.digitW) * kx,
            (o.y + layout.digitH / 2) * ky,
            (layout.digitW / 2) * kx,
            (layout.digitH / 2) * ky,
            wheel[0],
            v0,
            wheel[2],
            v0 + art.cell,
            alpha,
            0,
            1,
          );
        }
        const first = count;
        const m = layout.marquee;
        const e = Math.max(1, m.h / 20);
        const mw = m.w - 2 * e;
        const off = marqueeOffset(clock.distance, slot.period);
        put(
          (m.x + m.w / 2) * kx,
          (m.y + m.h / 2) * ky,
          (mw / 2) * kx,
          (m.h / 2 - e) * ky,
          off / slot.period,
          e / m.h,
          (off + mw) / slot.period,
          1 - e / m.h,
          alpha,
          0,
          1,
        );
        return first;
      };

      /** Draws a slot's sprites `first .. last - 1`: the page opaque unless `blendPage`. */
      const drawSlot = (
        slot: Slot,
        first: number,
        strip: number,
        last: number,
        blendPage: boolean,
      ) => {
        gl.useProgram(program);
        u.f2("uResolution", slot.tw, slot.th);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, slot.page.texture);
        if (blendPage) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        } else {
          gl.disable(gl.BLEND);
        }
        batch.draw(first, 1);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (strip > first + 1) {
          gl.bindTexture(gl.TEXTURE_2D, slot.parts.texture);
          batch.draw(first + 1, strip - first - 1);
        }
        if (last > strip) {
          gl.bindTexture(gl.TEXTURE_2D, slot.strip.texture);
          batch.draw(strip, last - strip);
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.disable(gl.BLEND);
      };

      /** Renders a slot to the canvas at opacity `alpha`: Classic through the low-res target. */
      const render = (slot: Slot, first: number, strip: number, last: number, alpha: number) => {
        if (slot.style === "classic") {
          target.resize(width, height, classicDivisor(width, height));
          target.bind();
          drawSlot(slot, first, strip, last, false);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.useProgram(target.program);
          ut.f1("uAlpha", alpha);
          target.blit();
        } else {
          gl.viewport(0, 0, width, height);
          drawSlot(slot, first, strip, last, alpha < 1);
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const motion = clamp(p.motion, 0, 1);
          const style = geoStyle(p.style);
          const tile = geoTile(p.tile);
          const text = settledText.update(p.text, step);
          const marquee = settledMarquee.update(p.marquee, step);

          // Size-dependent art, redrawn once the canvas size settles (stretched
          // until then), so a drag doesn't repaint on every frame.
          const nextSize = settledSize.update(width * 65536 + height, step);
          if (nextSize !== size) {
            size = nextSize;
            for (const slot of slots) {
              if (slot.painted >= 0) {
                paint(slot);
              }
            }
          }

          // A new style, text or tile crossfades in, one change at a time.
          const shown = fade.current;
          if (shown.painted < 0) {
            fill(shown, style, text, marquee, tile);
          } else if (
            !fade.fading &&
            (shown.style !== style ||
              shown.text !== text ||
              shown.marquee !== marquee ||
              shown.tile !== tile)
          ) {
            fill(fade.next, style, text, marquee, tile);
            fade.start();
          }
          fade.step(step);

          stepGeoClock(clock, step, motion);
          // Allocates once, on the first frame.
          counter ??= createHitCounter(p.counter);
          stepHitCounter(counter, step, clock.t, p.counter);
          const blink = blinkAlpha(clock, motion);

          const a = fade.current;
          const b = fade.next;
          const fading = fade.fading;
          const mix = fade.mix;
          count = 0;
          const aFirst = count;
          const aStrip = putSlot(a, 1, blink);
          const aLast = count;
          const bFirst = count;
          const bStrip = fading ? putSlot(b, b.style === "classic" ? 1 : mix, blink) : count;
          const bLast = count;
          batch.upload(count);

          render(a, aFirst, aStrip, aLast, 1);
          if (fading) {
            render(b, bFirst, bStrip, bLast, mix);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
