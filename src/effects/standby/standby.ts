import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import { createCrossfadeSlots } from "../fade";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { createDayClock } from "../horizon/horizon-sim";
import { EASED_GRAIN_GLSL } from "../grain";
import { approach, clamp } from "../math";
import { HASH32_GLSL } from "../noise";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch, SPRITE_SPIN_GLSL, writeSprite } from "../sprites";
import { defineEffect } from "../types";
import { clockHands } from "../wall-clock";
import {
  createMeasure,
  DIAL_CELL,
  HAND_BAND,
  HAND_BAR_LENGTH,
  HAND_BAR_THICKNESS,
  HAND_CELL,
  NAIL_Y,
  paintCard,
  paintParts,
  paintSign,
  PART_CELLS,
  type SignArt,
  TV_CELL,
  TV_SHUT_CELL,
} from "./standby-art";
import {
  BAND_HALF,
  bandCentre,
  boardSwing,
  CLOCK_INSET,
  CLOCK_RADIUS,
  createStandbyClock,
  grainPhase,
  layoutSign,
  REF_HEIGHT,
  type SignLayout,
  signPulse,
  type StandbyStyle,
  standbyStyle,
  stepStandbyClock,
  TV_INSET,
  TV_SIZE,
  tvBlinking,
} from "./standby-sim";
import { standbyMeta } from "./standby.meta";

/** Seconds a style or text change crossfades. */
const CROSSFADE = 1;
/** Seconds the station clock fades in or out. */
const CLOCK_FADE = 0.6;
/** Seconds the typed text and the canvas size must hold before they are redrawn. */
const SETTLE = 0.3;
/** Bounds on the parts atlas's cell, px. */
const MIN_CELL = 16;
const MAX_CELL = 1024;
/** Analogue's look: grain depth at full static, the rolling band's lift at full motion, scanline depth. */
const GRAIN_DEPTH = 0.14;
const BAND_LIFT = 0.035;
const SCAN_DEPTH = 0.09;
/** Scanline period and grain cell, reference px. */
const SCAN_PERIOD = 4;
const GRAIN_CELL = 1.5;
/** Each hand: length and tail past the centre, thickness, as fractions of the dial's radius. */
const HANDS = [
  [0.5, 0.12, 0.075],
  [0.76, 0.14, 0.05],
  [0.84, 0.2, 0.022],
] as const;
const HAND_INK: Record<StandbyStyle, readonly [number, number, number]> = {
  analogue: [0.11, 0.11, 0.12],
  digital: [0.11, 0.11, 0.12],
  cartoon: [0.18, 0.13, 0.1],
};
const SECOND_HAND: readonly [number, number, number] = [0.82, 0.16, 0.12];

/** Sprites per slot: card, sign, dial, three hands, TV. */
const SLOT_SPRITES = 7;
const MAX_SPRITES = 2 * SLOT_SPRITES;

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down), half width, half height (px). */
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

/** One texture fetch, tinted; premultiplied out. */
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

/**
 * Analogue's CRT pass over the finished frame, blended as colour + frame * alpha:
 * alpha darkens by soft scanlines, a faint vignette and fine grain, colour lifts
 * the rolling band (and a touch of grain in the blacks). The grain is hashed per
 * cell and eases between two seeds with cosine / sine weights, so it shimmers
 * at a low rate with its contrast held steady.
 */
const OVERLAY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
uniform vec2 uResolution;
uniform float uStrength;
uniform float uGrain;
uniform vec2 uGrainMix;
uniform uint uSeed;
uniform float uCell;
uniform float uScanPeriod;
/** The rolling band: centre y (y up, px), half height (px), lift. */
uniform vec3 uBand;
out vec4 outColor;
${HASH32_GLSL}
${EASED_GRAIN_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy;
  float scan = 1.0 - ${SCAN_DEPTH.toFixed(3)} * (0.5 + 0.5 * cos(6.2831853 * p.y / uScanPeriod));
  vec2 q = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  float vig = 1.0 - 0.25 * smoothstep(0.45, 1.1, length(q));
  uvec2 cell = uvec2(p / uCell);
  float n = easedGrain(cell, uSeed, uGrainMix);
  float g = 0.5 + 0.35 * n;
  float m = scan * vig * (1.0 - uGrain * (1.0 - g));
  float d = (p.y - uBand.x) / uBand.y;
  float lift = uBand.z * exp(-d * d) + uGrain * 0.2 * g;
  outColor = vec4(vec3(lift * uStrength), mix(1.0, m, uStrength));
}
`;

/** One look: its params and the textures drawn for them. */
interface Slot {
  style: StandbyStyle;
  text: string;
  subtext: string;
  card: CanvasTexture;
  sign: CanvasTexture;
  parts: CanvasTexture;
  layout: SignLayout | null;
  /** Where the sign goes (its canvas dropped once uploaded). */
  art: SignArt | null;
  /** Whether the sign texture holds a sign. */
  signed: boolean;
  /** The canvas size key the textures were drawn for; -1 when empty. */
  painted: number;
}

/**
 * The "technical difficulties, please stand by" slate: colour bars, a sign in
 * the upper third, a station clock in a corner, and Analogue's CRT pass,
 * Digital's clean card or Cartoon's hand-drawn one. The card, sign and parts are
 * drawn on 2D canvases once per style, text and size (standby-art.ts); each frame
 * is a handful of textured sprites, plus one blended full-screen pass in Analogue.
 */
export const standby = defineEffect(standbyMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uTex"]);
      const overlay = scopedProgram(gl, scope, FULLSCREEN_VERTEX, OVERLAY_FRAGMENT);
      const uo = createUniforms(gl, overlay, [
        "uResolution",
        "uStrength",
        "uGrain",
        "uGrainMix",
        "uSeed",
        "uCell",
        "uScanPeriod",
        "uBand",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const batch = scope.own(
        createSpriteBatch(gl, MAX_SPRITES, [4, 4, 4], undefined, { rotation: true }),
      );
      const slots: Slot[] = [0, 1].map(() => ({
        style: "analogue",
        text: "",
        subtext: "",
        card: createCanvasTexture(gl, scope, { premultiply: true }),
        sign: createCanvasTexture(gl, scope, { premultiply: true }),
        parts: createCanvasTexture(gl, scope, { premultiply: true }),
        layout: null,
        art: null,
        signed: false,
        painted: -1,
      }));
      gl.useProgram(program);
      u.i1("uTex", 0);
      gl.useProgram(null);

      const measures = {
        analogue: createMeasure("analogue"),
        digital: createMeasure("digital"),
        cartoon: createMeasure("cartoon"),
      };
      const settledText = createSettledValue<string>(SETTLE);
      const settledSub = createSettledValue<string>(SETTLE);
      const settledSize = createSettledValue<number>(SETTLE);
      const anim = createStandbyClock();
      const day = createDayClock();
      const hands = new Float64Array(3);
      const grain = new Float64Array(2);
      const data = batch.data;

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let size = -1;
      let clockAlpha = -1;
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
        r: number,
        g: number,
        b: number,
        alpha: number,
        angle: number,
      ) => {
        const o = writeSprite(batch, count++, cx, cy, hw, hh, u0, v0, u1, v1, angle);
        data[o + 8] = r;
        data[o + 9] = g;
        data[o + 10] = b;
        data[o + 11] = alpha;
      };

      /** Draws a slot's card, sign and parts for its params at the current size. */
      const paint = (slot: Slot) => {
        slot.layout = layoutSign(slot.text, slot.subtext, refWidth, measures[slot.style]);
        const art = paintSign(slot.layout, slot.style, scale);
        slot.card.upload(paintCard(slot.style, width, height));
        slot.sign.upload(art.canvas);
        // Only the texture is drawn from: let the canvas go.
        slot.signed = art.canvas !== null;
        art.canvas = null;
        slot.art = art;
        slot.parts.upload(
          paintParts(slot.style, clamp(Math.round(TV_SIZE * scale), MIN_CELL, MAX_CELL)),
        );
        slot.painted = size;
      };
      const fill = (slot: Slot, style: StandbyStyle, text: string, subtext: string) => {
        slot.style = style;
        slot.text = text;
        slot.subtext = subtext;
        paint(slot);
      };
      /** Frees a slot's textures once nothing shows it. */
      const empty = (slot: Slot) => {
        slot.card.upload(null);
        slot.sign.upload(null);
        slot.parts.upload(null);
        slot.layout = null;
        slot.art = null;
        slot.signed = false;
        slot.painted = -1;
      };
      const fade = createCrossfadeSlots([slots[0], slots[1]], CROSSFADE, empty);

      /** The frame width, reference px, a slot's art was laid out for. */
      const refWidthOf = (slot: Slot) => (slot.layout ? slot.layout.x * 2 : refWidth);
      /** Writes a slot's sign sprite at opacity `alpha`. */
      const putSign = (slot: Slot, alpha: number, pulse: number, swing: number) => {
        const art = slot.art;
        if (!art || !slot.signed || alpha <= 0) {
          return;
        }
        // Device px per reference px across: stretched to the canvas until a new
        // size settles and the art is redrawn.
        const sx = width / refWidthOf(slot);
        let cx = (art.left + art.width / 2) * sx;
        let cy = (art.top + art.height / 2) * scale;
        let angle = 0;
        if (slot.style === "cartoon" && slot.layout) {
          // Swings about the nail.
          const px = slot.layout.x * sx;
          const py = NAIL_Y * scale;
          const s = Math.sin(swing);
          const k = Math.cos(swing);
          const dx = cx - px;
          const dy = cy - py;
          cx = px + dx * k - dy * s;
          cy = py + dx * s + dy * k;
          angle = swing;
        }
        put(
          cx,
          cy,
          (art.width / 2) * sx,
          (art.height / 2) * scale,
          0,
          0,
          1,
          1,
          pulse,
          pulse,
          pulse,
          alpha,
          angle,
        );
      };

      const cellU = (cell: number) => cell / PART_CELLS;
      /** Draws sprites `first .. last - 1` from `texture`. */
      const span = (first: number, last: number, texture: WebGLTexture) => {
        if (last > first) {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          batch.draw(first, last - first);
        }
      };

      /** Writes a slot's clock (dial and hands) and Cartoon's TV at opacity `alpha`. */
      const putParts = (slot: Slot, alpha: number, blink: boolean) => {
        if (alpha <= 0 || slot.painted < 0) {
          return;
        }
        const clockA = alpha * clockAlpha;
        if (clockA > 0) {
          const r = CLOCK_RADIUS * scale;
          const cx = width - CLOCK_INSET * scale;
          const cy = height - CLOCK_INSET * scale;
          const half = r / 0.92;
          put(cx, cy, half, half, cellU(DIAL_CELL), 0, cellU(DIAL_CELL + 1), 1, 1, 1, 1, clockA, 0);
          const ink = HAND_INK[slot.style];
          const v0 = 0.5 - HAND_BAND / 2;
          const v1 = 0.5 + HAND_BAND / 2;
          for (let i = 0; i < 3; i++) {
            const len = HANDS[i][0];
            const tail = HANDS[i][1];
            const thick = HANDS[i][2];
            const theta = hands[i] - Math.PI / 2;
            const dx = Math.cos(theta);
            const dy = Math.sin(theta);
            const off = ((len - tail) / 2) * r;
            const c = i === 2 ? SECOND_HAND : ink;
            put(
              cx + dx * off,
              cy + dy * off,
              ((len + tail) * r) / (2 * HAND_BAR_LENGTH),
              ((thick * r) / HAND_BAR_THICKNESS) * (HAND_BAND / 2),
              cellU(HAND_CELL),
              v0,
              cellU(HAND_CELL + 1),
              v1,
              c[0],
              c[1],
              c[2],
              clockA,
              theta,
            );
          }
        }
        if (slot.style === "cartoon") {
          const cell = blink ? TV_SHUT_CELL : TV_CELL;
          const half = (TV_SIZE / 2) * scale;
          put(
            TV_INSET * scale,
            height - TV_INSET * scale,
            half,
            half,
            cellU(cell),
            0,
            cellU(cell + 1),
            1,
            1,
            1,
            1,
            alpha,
            0,
          );
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
          const style = standbyStyle(p.style);
          const text = settledText.update(p.text, step);
          const subtext = settledSub.update(p.subtext, step);

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

          // A new style or text crossfades in, one change at a time.
          const shown = fade.current;
          if (shown.painted < 0) {
            fill(shown, style, text, subtext);
          } else if (
            !fade.fading &&
            (shown.style !== style || shown.text !== text || shown.subtext !== subtext)
          ) {
            fill(fade.next, style, text, subtext);
            fade.start();
          }
          fade.step(step);

          clockAlpha =
            clockAlpha < 0
              ? p.clock
                ? 1
                : 0
              : approach(clockAlpha, p.clock ? 1 : 0, step / CLOCK_FADE);
          clockHands(day.step(step, "local", 0, 0), hands);
          stepStandbyClock(anim, step, motion);
          const pulse = signPulse(anim, motion);
          const swing = boardSwing(anim, motion);
          const blink = tvBlinking(anim, motion);

          // The old look stays solid while the new one fades in over it, then
          // fades out underneath, so nothing turns see-through mid-change.
          const a = fade.current;
          const b = fade.next;
          const fading = fade.fading;
          const mix = fade.mix;
          const aAlpha = fading ? Math.min(1, 2 * (1 - mix)) : 1;
          const bAlpha = fading ? Math.min(1, 2 * mix) : 0;

          count = 0;
          put(width / 2, height / 2, width / 2, height / 2, 0, 0, 1, 1, 1, 1, 1, 1, 0);
          if (fading) {
            put(width / 2, height / 2, width / 2, height / 2, 0, 0, 1, 1, 1, 1, 1, mix, 0);
          }
          const signFirst = count;
          putSign(a, aAlpha, pulse, swing);
          const signB = count;
          if (fading) {
            putSign(b, bAlpha, pulse, swing);
          }
          const partsFirst = count;
          putParts(a, aAlpha, blink);
          const partsB = count;
          if (fading) {
            putParts(b, bAlpha, blink);
          }
          const end = count;

          batch.upload(count);
          gl.useProgram(program);
          u.f2("uResolution", width, height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, a.card.texture);
          batch.draw(0, 1);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          if (fading) {
            gl.bindTexture(gl.TEXTURE_2D, b.card.texture);
            batch.draw(1, 1);
          }
          span(signFirst, signB, a.sign.texture);
          span(signB, partsFirst, b.sign.texture);
          span(partsFirst, partsB, a.parts.texture);
          span(partsB, end, b.parts.texture);
          gl.bindTexture(gl.TEXTURE_2D, null);

          // Analogue's CRT pass, eased in and out with the crossfade.
          const strength =
            (a.style === "analogue" ? (fading ? 1 - mix : 1) : 0) +
            (fading && b.style === "analogue" ? mix : 0);
          if (strength > 0) {
            grainPhase(anim, grain);
            const f = grain[1] * (Math.PI / 2);
            gl.useProgram(overlay);
            uo.f2("uResolution", width, height);
            uo.f1("uStrength", strength);
            uo.f1("uGrain", GRAIN_DEPTH * clamp(p.static, 0, 1));
            uo.f2("uGrainMix", Math.cos(f), Math.sin(f));
            uo.u1("uSeed", grain[0] >>> 0);
            uo.f1("uCell", Math.max(1, Math.round(GRAIN_CELL * scale)));
            uo.f1("uScanPeriod", Math.max(2, Math.round(SCAN_PERIOD * scale)));
            uo.f3("uBand", height * (1 - bandCentre(anim)), BAND_HALF * height, BAND_LIFT * motion);
            gl.blendFunc(gl.ONE, gl.SRC_ALPHA);
            triangle.draw();
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
