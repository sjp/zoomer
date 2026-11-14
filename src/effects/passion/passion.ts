import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import { createCountFade } from "../fade";
import { beginFrame, createUniforms, scopedProgram, TO_CLIP_GLSL, withScope } from "../gl";
import { approach, clamp } from "../math";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch, SPRITE_SPIN_GLSL } from "../sprites";
import { defineEffect } from "../types";
import { CRITTER_FRAMES, paintCritterAtlas } from "./critters";
import {
  BURST_CELL,
  CLOUD_CELLS,
  createMeasure,
  DISC_CELL,
  MISC_COLS,
  MISC_ROWS,
  paintBackdrop,
  paintCaption,
  paintMiscAtlas,
  RING_CELL,
  SPARKLE_CELL,
} from "./passion-art";
import {
  bobOffset,
  BREATH_SCALE,
  type CaptionLayout,
  type CaptionStyle,
  captionStyle,
  CLOUD_HEIGHT,
  CLOUD_WIDTH,
  cloudCount,
  cloudX,
  createCloudLayout,
  createCritterState,
  createMotionClock,
  CRITTER_FEET,
  critterBox,
  type CritterBox,
  critterIndex,
  critterSide,
  fillCloudLayout,
  layoutCaption,
  MAX_CLOUDS,
  MAX_SPARKLES,
  MEME_SHADOW,
  REF_HEIGHT,
  type Sparkle,
  sparkleAt,
  stepCritter,
  stepMotion,
  WORDART_SHADOW,
} from "./passion-sim";
import { CAPTION_LENGTH, CAPTION_LINES, CRITTER_OPTIONS, passionMeta } from "./passion.meta";

/** Seconds a caption (text, style or variation) or cloud layout change crossfades. */
const CROSSFADE = 1;
/** Seconds the extras (flare, sparkles, Meme's drop shadow) fade in or out. */
const EXTRAS_FADE = 0.6;
/** Seconds an added or removed cloud fades, when the canvas's width changes the count. */
const CLOUD_COUNT_FADE = 1;
/** Seconds the typed text and the canvas size must hold before they are redrawn. */
const SETTLE = 0.3;
/** Opacity of Meme's thin drop shadow and WordArt's deep one. */
const MEME_SHADOW_ALPHA = 0.85;
const WORDART_SHADOW_ALPHA = 0.45;
/** A sparkle's sprite side at full swell, reference px. */
const SPARKLE_SIZE = 44;
/** Misc atlas cell side, reference px: a cloud's cell is two of these by one. */
const MISC_CELL = 180;
/** Bounds on any atlas cell, px. */
const MIN_CELL = 16;
const MAX_CELL = 680;

/**
 * The lens flare: a burst at the sun in the top-left corner, then ghosts along
 * the line through the frame's centre. Per piece: how far along the line (0 the
 * sun, 1 the opposite corner), size in reference px, misc cell, and opacity.
 */
const FLARE = [
  [0, 300, BURST_CELL, 0.75],
  [0.3, 70, DISC_CELL, 0.22],
  [0.42, 120, RING_CELL, 0.28],
  [0.6, 46, DISC_CELL, 0.25],
  [0.78, 170, RING_CELL, 0.18],
] as const;
const SUN_X = 0.07;
const SUN_Y = 70;

/** Words per caption, at most: one-letter words filling every line. */
const MAX_WORDS = CAPTION_LINES * Math.ceil(CAPTION_LENGTH / 2);
/**
 * Sprite slots: the backdrop, two cloud layouts, two critters, two captions
 * (each word and its shadow), sparkles and flare.
 */
const MAX_SPRITES = 1 + 2 * MAX_CLOUDS + 2 + 2 * 2 * MAX_WORDS + MAX_SPARKLES + FLARE.length;

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down), half width, half height (px). */
layout(location = 1) in vec4 aSprite;
/** Atlas rectangle: u0, v0, u1, v1 (v down). */
layout(location = 2) in vec4 aUv;
/** Opacity, shade (1 draws a black silhouette), additive (1 adds, 0 blends), unused. */
layout(location = 3) in vec4 aLook;
layout(location = 4) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vUv;
flat out vec3 vLook;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vLook = aLook.xyz;
  gl_Position = pxToClip(aSprite.xy + spinCorner(aCorner * aSprite.zw, aSpin), uResolution);
}
`;

/** One texture fetch; premultiplied, with alpha zeroed for additive pieces. */
const FRAGMENT = /* glsl */ `#version 300 es
// highp: the atlases run to 4096 px, past what mediump texture coordinates resolve.
precision highp float;
in vec2 vUv;
flat in vec3 vLook;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUv) * vLook.x;
  outColor = vec4(c.rgb * (1.0 - vLook.y), c.a * (1.0 - vLook.z));
}
`;

/** One caption: its params, layout and rasterised words. */
interface CaptionSlot {
  texture: CanvasTexture;
  text: string;
  style: CaptionStyle;
  seed: number;
  layout: CaptionLayout;
  uv: Float32Array;
  /** The frame width the layout is for, and the em size the art was drawn at, px. */
  refWidth: number;
  builtPx: number;
}

/**
 * The "graphic design is my passion" meme as a calm background: a banded clip-art
 * sky with chunky clouds, a friendly critter on flat green grass, and the caption
 * in a cheesy font, each word in a clashing colour (or WordArt's rainbow), bobbing
 * gently. Everything is pre-drawn with a 2D canvas (passion-art.ts, critters.ts);
 * each frame is the backdrop as one opaque quad and a sprite batch of a few dozen
 * small quads, all one program.
 */
export const passion = defineEffect(passionMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uTex"]);
      const batch = scope.own(
        createSpriteBatch(gl, MAX_SPRITES, [4, 4, 4], undefined, { rotation: true }),
      );
      const backdrop = createCanvasTexture(gl, scope);
      const misc = createCanvasTexture(gl, scope, { premultiply: true });
      const critters = createCanvasTexture(gl, scope, { premultiply: true });
      const slots: CaptionSlot[] = [0, 1].map(() => ({
        texture: createCanvasTexture(gl, scope, { premultiply: true }),
        text: "",
        style: "meme",
        seed: 0,
        layout: { words: [], fontSize: 1, left: 0, top: 0, right: 0, bottom: 0 },
        uv: new Float32Array(0),
        refWidth: 0,
        builtPx: -1,
      }));
      gl.useProgram(program);
      u.i1("uTex", 0);
      gl.useProgram(null);

      const measures = { meme: createMeasure("meme"), wordart: createMeasure("wordart") };
      const settledText = createSettledValue<string>(SETTLE);
      const settledSize = createSettledValue<number>(SETTLE);
      const clouds = [createCloudLayout(0), createCloudLayout(0)];
      const cloudFade = createCountFade(MAX_CLOUDS);
      const critter = createCritterState();
      const box: CritterBox = { x: 0, y: 0, size: 0 };
      const sparkle: Sparkle = { x: 0, y: 0, alpha: 0 };
      const data = batch.data;
      const stride = batch.stride;

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let paintedSize = -1;
      let clock = createMotionClock(0);
      let started = false;
      /** Which slot holds the caption shown, and the crossfade to the other (0 when idle). */
      let current = 0;
      let captionMix = 0;
      let captionFading = false;
      /** Which cloud layout is shown, and the crossfade to the other. */
      let cloudShown = 0;
      let cloudMix = 0;
      let cloudFading = false;
      let extras = 0;
      let count = 0;

      /** Writes sprite `count` and moves on. */
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
        shade: number,
        add: number,
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
        data[o + 8] = alpha;
        data[o + 9] = shade;
        data[o + 10] = add;
        data[o + 11] = 0;
        data[o + 12] = angle;
        data[o + 13] = flip;
        count++;
      };
      /** A sprite from a misc atlas cell `rect` ([column, row, columns, rows]). */
      const putMisc = (
        rect: readonly number[],
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        alpha: number,
        add: number,
        flip: number,
      ) => {
        put(
          cx,
          cy,
          hw,
          hh,
          rect[0] / MISC_COLS,
          rect[1] / MISC_ROWS,
          (rect[0] + rect[2]) / MISC_COLS,
          (rect[1] + rect[3]) / MISC_ROWS,
          alpha,
          0,
          add,
          0,
          flip,
        );
      };

      /** Lays a slot's caption out for the current frame width. */
      const relayout = (slot: CaptionSlot) => {
        slot.layout = layoutCaption(
          slot.text,
          slot.style,
          slot.seed,
          refWidth,
          measures[slot.style],
        );
        slot.refWidth = refWidth;
      };
      /** Redraws a slot's words at their on-screen size. */
      const repaint = (slot: CaptionSlot) => {
        const px = Math.max(4, Math.round(slot.layout.fontSize * scale));
        const art = paintCaption(slot.layout, slot.style, px);
        slot.texture.upload(art.canvas);
        slot.uv = art.uv;
        slot.builtPx = px;
      };
      const fillSlot = (slot: CaptionSlot, text: string, style: CaptionStyle, seed: number) => {
        slot.text = text;
        slot.style = style;
        slot.seed = seed;
        relayout(slot);
        repaint(slot);
      };

      /** Writes a caption slot's shadows, then its words, at opacity `alpha`. */
      const putCaption = (slot: CaptionSlot, alpha: number, motion: number) => {
        const words = slot.layout.words;
        if (alpha <= 0 || words.length === 0) {
          return;
        }
        const wordart = slot.style === "wordart";
        const shadowAlpha = wordart ? WORDART_SHADOW_ALPHA : MEME_SHADOW_ALPHA * extras;
        const shadow = (wordart ? WORDART_SHADOW * slot.layout.fontSize : MEME_SHADOW) * scale;
        for (let pass = shadowAlpha > 0 ? 0 : 1; pass < 2; pass++) {
          const off = pass === 0 ? shadow : 0;
          for (let i = 0; i < words.length && 4 * i + 3 < slot.uv.length; i++) {
            const w = words[i];
            put(
              w.x * scale + off,
              (w.y + bobOffset(i, clock.bob, motion)) * scale + off,
              (w.width / 2) * scale,
              (w.height / 2) * scale,
              slot.uv[4 * i],
              slot.uv[4 * i + 1],
              slot.uv[4 * i + 2],
              slot.uv[4 * i + 3],
              pass === 0 ? alpha * shadowAlpha : alpha,
              pass === 0 ? 1 : 0,
              0,
              w.angle,
              1,
            );
          }
        }
      };

      /** Draws sprites `first .. end - 1` from `texture`. */
      const drawSpan = (first: number, end: number, texture: WebGLTexture) => {
        if (end > first) {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          batch.draw(first, end - first);
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / REF_HEIGHT;
          refWidth = width / scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const motion = clamp(p.motion, 0, 1);
          const style = captionStyle(p.style);
          const text = settledText.update(p.text, step);

          if (!started) {
            started = true;
            clock = createMotionClock(p.seed);
            fillCloudLayout(clouds[0], p.seed);
            cloudFade.snap(cloudCount(refWidth));
            extras = p.extras ? 1 : 0;
          }

          // Size-dependent art, redrawn once the canvas size settles; the
          // layouts follow the frame width at once.
          for (const slot of slots) {
            if (slot.builtPx > 0 && slot.refWidth !== refWidth) {
              relayout(slot);
            }
          }
          const size = settledSize.update(width * 65536 + height, step);
          if (size !== paintedSize) {
            paintedSize = size;
            backdrop.upload(paintBackdrop(width, height, refWidth));
            const miscCell = clamp(Math.round(MISC_CELL * scale), MIN_CELL, MAX_CELL);
            misc.upload(paintMiscAtlas(miscCell));
            critterBox("right", refWidth, box);
            critters.upload(
              paintCritterAtlas(clamp(Math.round(box.size * scale), MIN_CELL, MAX_CELL)),
            );
            for (const slot of slots) {
              if (slot.builtPx > 0) {
                repaint(slot);
              }
            }
          }

          // The caption crossfades to new text, style or variation, one change at a time.
          const was = slots[current];
          if (was.builtPx < 0) {
            fillSlot(was, text, style, p.seed);
          } else if (
            !captionFading &&
            (was.text !== text || was.style !== style || was.seed !== p.seed)
          ) {
            fillSlot(slots[1 - current], text, style, p.seed);
            captionFading = true;
            captionMix = 0;
          }
          if (captionFading) {
            captionMix = Math.min(1, captionMix + step / CROSSFADE);
            if (captionMix >= 1) {
              current = 1 - current;
              captionFading = false;
              captionMix = 0;
            }
          }

          // The clouds crossfade to a new variation's layout the same way.
          if (!cloudFading && clouds[cloudShown].seed !== p.seed) {
            fillCloudLayout(clouds[1 - cloudShown], p.seed);
            cloudFading = true;
            cloudMix = 0;
          }
          if (cloudFading) {
            cloudMix = Math.min(1, cloudMix + step / CROSSFADE);
            if (cloudMix >= 1) {
              cloudShown = 1 - cloudShown;
              cloudFading = false;
              cloudMix = 0;
            }
          }
          cloudFade.step(cloudCount(refWidth), step, CLOUD_COUNT_FADE, CLOUD_COUNT_FADE);

          stepCritter(critter, step, critterIndex(p.critter), critterSide(p.side));
          stepMotion(clock, step, motion);
          extras = approach(extras, p.extras ? 1 : 0, step / EXTRAS_FADE);

          // Sprites, back to front.
          count = 0;
          put(width / 2, height / 2, width / 2, height / 2, 0, 0, 1, 1, 1, 0, 0, 0, 1);
          const cloudsFirst = count;
          for (let layer = 0; layer < 2; layer++) {
            const c = clouds[layer === 0 ? cloudShown : 1 - cloudShown];
            const layerAlpha = layer === 0 ? 1 - cloudMix : cloudMix;
            if (layerAlpha <= 0) {
              continue;
            }
            for (let i = 0; i < cloudFade.live; i++) {
              const a = layerAlpha * cloudFade.life[i];
              if (a <= 0) {
                continue;
              }
              putMisc(
                CLOUD_CELLS[c.variant[i]],
                cloudX(c, i, clock.travel, refWidth) * scale,
                c.y[i] * scale,
                (CLOUD_WIDTH / 2) * c.size[i] * scale,
                (CLOUD_HEIGHT / 2) * c.size[i] * scale,
                a,
                0,
                c.flip[i],
              );
            }
          }

          const crittersFirst = count;
          if (critter.side !== "none" && critter.presence > 0) {
            critterBox(critter.side, refWidth, box);
            const breath = BREATH_SCALE * motion * Math.sin(2 * Math.PI * clock.breath);
            const hw = (box.size / 2) * (1 - breath / 2) * scale;
            const hh = (box.size / 2) * (1 + breath) * scale;
            const feet = (box.y + box.size * (CRITTER_FEET - 0.5)) * scale;
            const cy = feet - (2 * CRITTER_FEET - 1) * hh;
            // Facing in towards the middle of the frame.
            const flip = critter.side === "right" ? -1 : 1;
            const rows = CRITTER_OPTIONS.length;
            const u0 = clock.frame / CRITTER_FRAMES;
            const u1 = (clock.frame + 1) / CRITTER_FRAMES;
            const both = critter.next >= 0;
            const kinds = both ? 2 : 1;
            for (let k = 0; k < kinds; k++) {
              const row = k === 0 ? critter.shown : critter.next;
              const a = critter.presence * (both ? (k === 0 ? 1 - critter.mix : critter.mix) : 1);
              put(
                box.x * scale,
                cy,
                hw,
                hh,
                u0,
                row / rows,
                u1,
                (row + 1) / rows,
                a,
                0,
                0,
                0,
                flip,
              );
            }
          }

          const shown = slots[current];
          const captionFirst = count;
          putCaption(shown, 1 - captionMix, motion);
          const nextFirst = count;
          if (captionFading) {
            putCaption(slots[1 - current], captionMix, motion);
          }

          const topFirst = count;
          if (extras > 0) {
            // Sparkles dip out across a variation change, then come back at new spots.
            const sparkleSeed =
              cloudMix < 0.5 ? clouds[cloudShown].seed : clouds[1 - cloudShown].seed;
            const dip = cloudFading ? Math.abs(1 - 2 * cloudMix) : 1;
            for (let k = 0; k < MAX_SPARKLES; k++) {
              sparkleAt(sparkleSeed, k, clock.sparkle, refWidth, sparkle);
              const a = sparkle.alpha * extras * dip;
              if (a > 0.004) {
                const half = (SPARKLE_SIZE / 2) * (0.6 + 0.4 * sparkle.alpha) * scale;
                putMisc(SPARKLE_CELL, sparkle.x * scale, sparkle.y * scale, half, half, a, 0, 1);
              }
            }
            const sunX = SUN_X * refWidth;
            for (const piece of FLARE) {
              const x = sunX + piece[0] * (refWidth - 2 * sunX);
              const y = SUN_Y + piece[0] * (REF_HEIGHT - 2 * SUN_Y);
              const half = (piece[1] / 2) * scale;
              putMisc(piece[2], x * scale, y * scale, half, half, piece[3] * extras, 1, 1);
            }
          }

          batch.upload(count);
          gl.useProgram(program);
          u.f2("uResolution", width, height);
          gl.activeTexture(gl.TEXTURE0);
          // The backdrop is opaque: no blending.
          drawSpan(0, 1, backdrop.texture);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          drawSpan(cloudsFirst, crittersFirst, misc.texture);
          drawSpan(crittersFirst, captionFirst, critters.texture);
          drawSpan(captionFirst, nextFirst, shown.texture.texture);
          drawSpan(nextFirst, topFirst, slots[1 - current].texture.texture);
          drawSpan(topFirst, count, misc.texture);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
