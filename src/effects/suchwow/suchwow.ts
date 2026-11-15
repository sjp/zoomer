import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import { createColorEase, hexToUnitRgb } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { clamp } from "../math";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch, SPRITE_SPIN_GLSL } from "../sprites";
import { defineEffect } from "../types";
import {
  CELL_OPEN,
  CELL_PUPIL,
  CELL_SHUT,
  createPhraseMeasure,
  EYE_LEFT_X,
  EYE_RIGHT_X,
  EYE_Y,
  paintPhrase,
  paintShibaAtlas,
  PUPIL_CELL,
  PUPIL_TRAVEL,
  SHIBA_CELLS,
} from "./suchwow-art";
import {
  type Box,
  CAPACITY,
  createField,
  createShiba,
  type Field,
  phraseList,
  REF_HEIGHT,
  reseed,
  resizeField,
  setList,
  SHIBA_SIZE,
  shibaBox,
  stepField,
  stepShiba,
} from "./suchwow-sim";
import { suchwowMeta } from "./suchwow.meta";

/** Seconds a background change crossfades. */
const BACKGROUND_EASE = 1.2;
/** Seconds the typed phrases, and the canvas size and variation, must hold before they are used. */
const SETTLE_TEXT = 1;
const SETTLE_SIZE = 0.3;
/**
 * Phrases repainted per frame for a settled resize; the rest are drawn
 * stretched until their turn, so a resize doesn't repaint every slot at once.
 */
const RESCALES_PER_FRAME = 2;
/** Bounds on the shiba atlas's cell, px. */
const MIN_CELL = 16;
const MAX_CELL = 1024;
/** The pupils' rest look (eye radii, down a touch) and their side-eye look (towards the middle). */
const REST_LOOK_Y = 0.2;
const SIDE_LOOK_X = -1;
const SIDE_LOOK_Y = -0.1;

const EYES_X = [EYE_LEFT_X, EYE_RIGHT_X] as const;

/** Each background as three diagonal stops, top-left to bottom-right. */
const BACKGROUNDS: Record<string, readonly [string, string, string]> = {
  cream: ["#fff5dc", "#fff5dc", "#fff5dc"],
  sky: ["#dceeff", "#dceeff", "#dceeff"],
  pastel: ["#ffd9ec", "#e6defe", "#d4f5e6"],
};

/** Sprites: every phrase slot, and the shiba's head and two pupils. */
const MAX_SPRITES = CAPACITY + 3;

const BACKGROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uStops[3];
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float t = 0.5 * (vUv.x + 1.0 - vUv.y);
  vec3 c = t < 0.5 ? mix(uStops[0], uStops[1], t * 2.0) : mix(uStops[1], uStops[2], t * 2.0 - 1.0);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down), half width, half height (px). */
layout(location = 1) in vec4 aSprite;
/** Texture rectangle: u0, v0, u1, v1 (v down). */
layout(location = 2) in vec4 aUv;
layout(location = 3) in float aAlpha;
layout(location = 4) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vUv;
flat out float vAlpha;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vAlpha = aAlpha;
  gl_Position = pxToClip(aSprite.xy + spinCorner(aCorner * aSprite.zw, aSpin), uResolution);
}
`;

/** One texture fetch of premultiplied art, scaled by the sprite's opacity. */
const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in float vAlpha;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv) * vAlpha;
}
`;

/** A phrase slot's texture and what it was painted for. */
interface Slot {
  texture: CanvasTexture;
  serial: number;
  scale: number;
}

/**
 * Doge-speak round the edges of the frame: short broken-English phrases in a
 * cheesy font and clashing colours fade in, drift a few px and fade out one by
 * one, never in the speaker's area and never on top of each other, with an
 * optional clip-art shiba side-eyeing the speaker from the bottom-right corner.
 * Each phrase is rasterised once when it spawns; a frame is one background pass
 * and under twenty small sprites.
 */
export const suchwow = defineEffect(suchwowMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT);
      const ub = createUniforms(gl, background, ["uStops"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = scopedProgram(gl, scope, SPRITE_VERTEX, SPRITE_FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uTex"]);
      const batch = scope.own(
        createSpriteBatch(gl, MAX_SPRITES, [4, 4, 1], undefined, { rotation: true }),
      );
      const slots: Slot[] = Array.from({ length: CAPACITY }, () => ({
        texture: createCanvasTexture(gl, scope, { premultiply: true }),
        serial: -1,
        scale: 0,
      }));
      const shibaArt = createCanvasTexture(gl, scope, { premultiply: true });
      gl.useProgram(program);
      u.i1("uTex", 0);
      gl.useProgram(null);

      const measure = createPhraseMeasure();
      const settledText = createSettledValue<string>(SETTLE_TEXT);
      const settledSize = createSettledValue<number>(SETTLE_SIZE);
      const settledSeed = createSettledValue<number>(SETTLE_SIZE);
      const ease = createColorEase(9);
      const stops = new Float32Array(9);
      const corner: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      const data = batch.data;
      const stride = batch.stride;

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let field: Field | null = null;
      let shiba = createShiba(0);
      let listText = "";
      let seed = 0;
      let paintedSize = -1;
      /** The device px scale the shiba atlas was painted at. */
      let shibaScale = 0;
      let backgroundKey = "";
      let stopsStale = true;
      /** The device px per reference px the art is painted at: the scale once the size settles. */
      let artScale = 1;
      let count = 0;

      const put = (
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        u0: number,
        u1: number,
        alpha: number,
        angle: number,
      ) => {
        const o = count * stride;
        data[o] = cx;
        data[o + 1] = cy;
        data[o + 2] = hw;
        data[o + 3] = hh;
        data[o + 4] = u0;
        data[o + 5] = 0;
        data[o + 6] = u1;
        data[o + 7] = 1;
        data[o + 8] = alpha;
        data[o + 9] = angle;
        data[o + 10] = 1;
        count++;
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
          const text = settledText.update(p.phrases, step);

          // A variation swaps the whole arrangement, so wait for the slider to settle.
          const nextSeed = settledSeed.update(p.seed, step);
          if (!field) {
            listText = text;
            seed = nextSeed;
            field = createField(seed, refWidth, phraseList(text), measure);
            shiba = createShiba(seed);
          }
          const f = field;
          if (text !== listText) {
            listText = text;
            setList(f, phraseList(text));
          }
          if (nextSeed !== seed) {
            seed = nextSeed;
            reseed(f, seed);
          }
          // Phrases are laid out for a settled canvas size, stretched across until then.
          const size = settledSize.update(width * 65536 + height, step);
          if (size !== paintedSize) {
            paintedSize = size;
            resizeField(f, refWidth);
            artScale = scale;
          }
          stepShiba(shiba, step, motion, p.shiba);
          stepField(f, step, p.count, motion, p.shiba || shiba.presence > 0);

          // The background, eased across a change.
          if (backgroundKey !== p.background) {
            backgroundKey = p.background;
            stopsStale = true;
            const colours = BACKGROUNDS[p.background] ?? BACKGROUNDS.cream;
            for (let k = 0; k < 3; k++) {
              stops.set(hexToUnitRgb(colours[k]), 3 * k);
            }
          }
          if (ease.moving) {
            // This step moves the stops (to their end, on the last one).
            stopsStale = true;
          }
          const eased = ease.step(stops, step, BACKGROUND_EASE);
          gl.useProgram(background);
          if (stopsStale || ease.moving) {
            gl.uniform3fv(ub.loc.uStops, eased);
            stopsStale = false;
          }
          triangle.draw();

          // Sprites: phrases (one slot each), then the shiba.
          const sx = width / f.refWidth;
          count = 0;
          let rescales = 0;
          for (let i = 0; i < CAPACITY; i++) {
            const ph = f.phrases[i];
            const slot = slots[i];
            if (!ph.live || ph.alpha <= 0) {
              continue;
            }
            // A new phrase is painted at once; one only resized waits its turn.
            const fresh = slot.serial !== ph.serial;
            if (fresh || (slot.scale !== artScale && rescales++ < RESCALES_PER_FRAME)) {
              slot.texture.upload(
                paintPhrase(
                  ph.text,
                  ph.color,
                  ph.font * artScale,
                  ph.width * artScale,
                  ph.height * artScale,
                ),
              );
              slot.serial = ph.serial;
              slot.scale = artScale;
            }
          }
          for (let i = 0; i < CAPACITY; i++) {
            const ph = f.phrases[i];
            // Hidden slots still take a (zero-opacity) sprite, keeping slot i at instance i.
            const shown = ph.live && ph.alpha > 0;
            put(
              ph.x * sx,
              ph.y * scale,
              (ph.width / 2) * sx,
              (ph.height / 2) * scale,
              0,
              1,
              shown ? ph.alpha : 0,
              ph.angle,
            );
          }
          const shibaFirst = count;
          if (shiba.presence > 0) {
            if (shibaScale !== artScale) {
              shibaScale = artScale;
              const cell = clamp(Math.round(SHIBA_SIZE * artScale), MIN_CELL, MAX_CELL);
              shibaArt.upload(paintShibaAtlas(cell));
            }
            shibaBox(f.refWidth, corner);
            const half = (SHIBA_SIZE / 2) * scale;
            const cell = shiba.blink ? CELL_SHUT : CELL_OPEN;
            put(
              (corner.minX + SHIBA_SIZE / 2) * sx,
              (corner.minY + SHIBA_SIZE / 2) * scale,
              half,
              half,
              cell / SHIBA_CELLS,
              (cell + 1) / SHIBA_CELLS,
              shiba.presence,
              0,
            );
            if (!shiba.blink) {
              const lookX = SIDE_LOOK_X * shiba.look;
              const lookY = REST_LOOK_Y + (SIDE_LOOK_Y - REST_LOOK_Y) * shiba.look;
              const pupilHalf = (PUPIL_CELL / 2) * SHIBA_SIZE * scale;
              for (const ex of EYES_X) {
                put(
                  (corner.minX + (ex + lookX * PUPIL_TRAVEL) * SHIBA_SIZE) * sx,
                  (corner.minY + (EYE_Y + lookY * PUPIL_TRAVEL) * SHIBA_SIZE) * scale,
                  pupilHalf,
                  pupilHalf,
                  CELL_PUPIL / SHIBA_CELLS,
                  (CELL_PUPIL + 1) / SHIBA_CELLS,
                  shiba.presence,
                  0,
                );
              }
            }
          }

          batch.upload(count);
          gl.useProgram(program);
          u.f2("uResolution", width, height);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.activeTexture(gl.TEXTURE0);
          for (let i = 0; i < CAPACITY; i++) {
            const ph = f.phrases[i];
            if (ph.live && ph.alpha > 0) {
              gl.bindTexture(gl.TEXTURE_2D, slots[i].texture.texture);
              batch.draw(i, 1);
            }
          }
          if (count > shibaFirst) {
            gl.bindTexture(gl.TEXTURE_2D, shibaArt.texture);
            batch.draw(shibaFirst, count - shibaFirst);
          }
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
