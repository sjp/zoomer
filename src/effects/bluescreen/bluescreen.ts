import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import { hexToUnitRgb, type Rgb } from "../color";
import { createCrossfadeSlots } from "../fade";
import {
  beginFrame,
  createDataTexture,
  createUniforms,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { clamp, smoothstep } from "../math";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import {
  classicCursor,
  createMeasure,
  CURSOR_INK,
  logLineHeight,
  paintLog,
  paintPercent,
  paintScreen,
  screenBackground,
} from "./bluescreen-art";
import { type BlueLayout, layoutFor, REF_HEIGHT } from "./bluescreen-layout";
import {
  type BlueHue,
  blueHue,
  type BlueStyle,
  blueStyle,
  copyProgress,
  copyTraceLog,
  createProgress,
  createTraceLog,
  cursorAlpha,
  percentText,
  type Progress,
  stepProgress,
  stepTraceLog,
  TRACE_ROWS,
  type TraceLog,
  traceLine,
} from "./bluescreen-sim";
import { bluescreenMeta } from "./bluescreen.meta";

/** Seconds a style, hue, text, seed or size change crossfades. */
const CROSSFADE = 1;
/** Seconds the count crossfades on a tick, and on a restart. */
const TICK_FADE = 0.4;
const RESTART_FADE = 1;
/** Seconds the kernel log takes to step up a line. */
const SCROLL_SECONDS = 0.8;
/** Seconds the typed text and the canvas size must hold before they are redrawn. */
const SETTLE = 0.3;

/** Sprites per slot: screen, two count lines, log, cursor. */
const SLOT_SPRITES = 5;

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down), half width, half height (px). */
layout(location = 1) in vec4 aSprite;
/** Texture rectangle: u0, v0, u1, v1 (v down). */
layout(location = 2) in vec4 aUv;
/** Tint and opacity. */
layout(location = 3) in vec4 aTint;
uniform vec2 uResolution;
out vec2 vUv;
flat out vec4 vTint;
${TO_CLIP_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vTint = aTint;
  gl_Position = pxToClip(aSprite.xy + aCorner * aSprite.zw, uResolution);
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

/** One look: its params, its own progress and log, and the textures drawn for them. */
interface Slot {
  style: BlueStyle;
  hue: BlueHue;
  text: string;
  code: string;
  seed: number;
  layout: BlueLayout | null;
  background: Rgb;
  screen: CanvasTexture;
  /** The count line now shown, and the one fading in over it. */
  percent: [CanvasTexture, CanvasTexture];
  percentSize: Float64Array;
  /** Which `percent` texture is current; the other is the incoming one while `percentMix < 1`. */
  percentCurrent: number;
  percentMix: number;
  percentFade: number;
  /** The progress version the count textures show. */
  percentVersion: number;
  log: CanvasTexture;
  logWidth: number;
  logHeight: number;
  /** The log version painted, and the eased step up through it (1 when still). */
  logVersion: number;
  scroll: number;
  progress: Progress;
  trace: TraceLog;
  /** The canvas size key the textures were drawn for; -1 when empty. */
  painted: number;
}

/**
 * The crashed-computer screen: a sad face and a count that never finishes
 * (Modern), a text-mode error page (Classic) or a kernel panic (Kernel). Each
 * screen is drawn once on a 2D canvas (bluescreen-art.ts) and shown as one
 * textured quad; the count line, the log's lines and the cursor are small sprites
 * over it, redrawn only when they change.
 */
export const bluescreen = defineEffect(bluescreenMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uTex"]);
      const batch = scope.own(createSpriteBatch(gl, 2 * SLOT_SPRITES, [4, 4, 4]));
      const white = scope.add(
        createDataTexture(gl, {
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          width: 1,
          height: 1,
          data: new Uint8Array([255, 255, 255, 255]),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const texture = () => createCanvasTexture(gl, scope, { premultiply: true });
      const slots: Slot[] = [0, 1].map(() => ({
        style: "modern",
        hue: "blue",
        text: "",
        code: "",
        seed: 0,
        layout: null,
        background: [0, 0, 0],
        screen: texture(),
        percent: [texture(), texture()],
        percentSize: new Float64Array(4),
        percentCurrent: 0,
        percentMix: 1,
        percentFade: TICK_FADE,
        percentVersion: 0,
        log: texture(),
        logWidth: 1,
        logHeight: 1,
        logVersion: 0,
        scroll: 1,
        progress: createProgress(0),
        trace: createTraceLog(0),
        painted: -1,
      }));
      gl.useProgram(program);
      u.i1("uTex", 0);
      gl.useProgram(null);

      const measure = createMeasure();
      const settledText = createSettledValue<string>(SETTLE);
      const settledCode = createSettledValue<string>(SETTLE);
      const settledSize = createSettledValue<number>(SETTLE);
      const cursorBox = new Float64Array(4);
      const data = batch.data;
      const stride = batch.stride;

      let width = 1;
      let height = 1;
      let scale = 1;
      let size = -1;
      let time = 0;
      let count = 0;

      const put = (
        x: number,
        y: number,
        w: number,
        h: number,
        u0: number,
        v0: number,
        u1: number,
        v1: number,
        rgb: readonly number[],
        alpha: number,
      ) => {
        const o = count * stride;
        data[o] = x + w / 2;
        data[o + 1] = y + h / 2;
        data[o + 2] = w / 2;
        data[o + 3] = h / 2;
        data[o + 4] = u0;
        data[o + 5] = v0;
        data[o + 6] = u1;
        data[o + 7] = v1;
        data[o + 8] = rgb[0];
        data[o + 9] = rgb[1];
        data[o + 10] = rgb[2];
        data[o + 11] = alpha;
        count++;
      };
      const WHITE = [1, 1, 1] as const;

      /** Draws the count `which` for the slot's current percentage. */
      const paintCount = (slot: Slot, which: number) => {
        const layout = slot.layout;
        if (layout?.style !== "modern") {
          return;
        }
        const canvas = paintPercent(layout, percentText(slot.progress.percent), scale);
        slot.percent[which].upload(canvas);
        slot.percentSize[which * 2] = canvas ? canvas.width : 1;
        slot.percentSize[which * 2 + 1] = canvas ? canvas.height : 1;
      };
      /** Draws the log: the line about to scroll off, then the `TRACE_ROWS` shown after it. */
      const paintTrace = (slot: Slot) => {
        const layout = slot.layout;
        if (layout?.style !== "kernel") {
          return;
        }
        const lines: string[] = [];
        for (let i = slot.trace.head - TRACE_ROWS; i <= slot.trace.head; i++) {
          lines.push(traceLine(slot.trace.seed, i));
        }
        const canvas = paintLog(layout, lines, scale);
        slot.log.upload(canvas);
        slot.logWidth = canvas ? canvas.width : 1;
        slot.logHeight = canvas ? canvas.height : 1;
      };

      /** Draws a slot's screen, count and log for its params at the current size. */
      const paint = (slot: Slot) => {
        const layout = layoutFor(slot.style, slot.text, slot.code, width / scale, measure);
        slot.layout = layout;
        slot.background = hexToUnitRgb(screenBackground(slot.style, slot.hue));
        slot.screen.upload(paintScreen(layout, slot.hue, slot.seed, width, height, scale));
        // A size change lands the count and the log where they were heading.
        if (slot.percentMix < 1) {
          slot.percentCurrent = 1 - slot.percentCurrent;
          slot.percentMix = 1;
        }
        slot.percentVersion = slot.progress.version;
        paintCount(slot, slot.percentCurrent);
        slot.percent[1 - slot.percentCurrent].upload(null);
        slot.logVersion = slot.trace.version;
        slot.scroll = 1;
        paintTrace(slot);
        slot.painted = size;
      };
      const fill = (
        slot: Slot,
        from: Slot | null,
        style: BlueStyle,
        hue: BlueHue,
        text: string,
        code: string,
        seed: number,
      ) => {
        slot.style = style;
        slot.hue = hue;
        slot.text = text;
        slot.code = code;
        // The count and log carry on through a change of look; a new seed starts afresh.
        const carry = from?.seed === seed;
        slot.seed = seed;
        slot.progress = carry ? copyProgress(from.progress) : createProgress(seed);
        slot.trace = carry ? copyTraceLog(from.trace) : createTraceLog(seed);
        slot.percentMix = 1;
        paint(slot);
      };
      /** Frees a slot's textures once nothing shows it. */
      const empty = (slot: Slot) => {
        slot.screen.upload(null);
        slot.percent[0].upload(null);
        slot.percent[1].upload(null);
        slot.log.upload(null);
        slot.layout = null;
        slot.painted = -1;
      };
      const fade = createCrossfadeSlots([slots[0], slots[1]], CROSSFADE, empty);

      /** Steps a slot's count and log, crossfading the count and scrolling the log as they change. */
      const advance = (slot: Slot, step: number, simStep: number) => {
        stepProgress(slot.progress, simStep);
        stepTraceLog(slot.trace, simStep);
        if (slot.percentMix < 1) {
          slot.percentMix = Math.min(1, slot.percentMix + step / slot.percentFade);
          if (slot.percentMix >= 1) {
            slot.percentCurrent = 1 - slot.percentCurrent;
          }
        }
        if (slot.progress.version !== slot.percentVersion) {
          if (slot.percentMix < 1) {
            slot.percentCurrent = 1 - slot.percentCurrent;
          }
          slot.percentVersion = slot.progress.version;
          paintCount(slot, 1 - slot.percentCurrent);
          slot.percentMix = 0;
          slot.percentFade = slot.progress.restarted ? RESTART_FADE : TICK_FADE;
        }
        if (slot.trace.version !== slot.logVersion) {
          slot.logVersion = slot.trace.version;
          paintTrace(slot);
          slot.scroll = 0;
        }
        slot.scroll = Math.min(1, slot.scroll + step / SCROLL_SECONDS);
      };

      /** Writes a slot's sprites at opacity `alpha`; returns the first sprite's index. */
      const putSlot = (slot: Slot, alpha: number, blink: number) => {
        const first = count;
        const layout = slot.layout;
        put(0, 0, width, height, 0, 0, 1, 1, WHITE, alpha);
        if (layout?.style === "modern") {
          const x = Math.round(layout.percent.x * scale);
          const y = Math.round(layout.percent.y * scale);
          const c = slot.percentCurrent;
          const m = slot.percentMix < 1 ? slot.percentMix : 0;
          // Old count out, new count in, overlapping so the line never dims to nothing.
          const sz = slot.percentSize;
          put(x, y, sz[c * 2], sz[c * 2 + 1], 0, 0, 1, 1, WHITE, alpha * Math.min(1, 2 * (1 - m)));
          put(x, y, sz[2 - c * 2], sz[3 - c * 2], 0, 0, 1, 1, WHITE, alpha * Math.min(1, 2 * m));
        } else {
          put(0, 0, 0, 0, 0, 0, 0, 0, WHITE, 0);
          put(0, 0, 0, 0, 0, 0, 0, 0, WHITE, 0);
        }
        if (layout?.style === "kernel") {
          const lh = logLineHeight(layout, scale);
          const e = smoothstep(0, 1, slot.scroll) * lh;
          const v0 = e / slot.logHeight;
          const v1 = (e + TRACE_ROWS * lh) / slot.logHeight;
          put(
            Math.round(layout.log.x * scale),
            Math.round(layout.log.y * scale),
            slot.logWidth,
            TRACE_ROWS * lh,
            0,
            v0,
            1,
            v1,
            WHITE,
            alpha,
          );
        } else {
          put(0, 0, 0, 0, 0, 0, 0, 0, WHITE, 0);
        }
        if (layout?.style === "classic") {
          classicCursor(layout, scale, cursorBox);
        } else if (layout?.style === "kernel") {
          cursorBox[0] = Math.round(layout.cursor.x * scale);
          // Under the log's last whole-pixel line, wherever its rounding left it.
          const logBottom = layout.log.y + layout.log.h;
          cursorBox[1] =
            Math.round(layout.log.y * scale) +
            TRACE_ROWS * logLineHeight(layout, scale) +
            Math.round((layout.cursor.y - logBottom) * scale);
          cursorBox[2] = Math.max(1, Math.round(layout.cursor.w * scale));
          cursorBox[3] = Math.max(1, Math.round(layout.cursor.h * scale));
        }
        const hasCursor = layout !== null && layout.style !== "modern";
        put(
          cursorBox[0],
          cursorBox[1],
          hasCursor ? cursorBox[2] : 0,
          hasCursor ? cursorBox[3] : 0,
          0,
          0,
          1,
          1,
          CURSOR_INK[slot.style],
          hasCursor ? alpha * blink : 0,
        );
        return first;
      };

      const drawSlot = (slot: Slot, first: number) => {
        gl.bindTexture(gl.TEXTURE_2D, slot.screen.texture);
        batch.draw(first, 1);
        const style = slot.layout?.style;
        if (style === "modern") {
          gl.bindTexture(gl.TEXTURE_2D, slot.percent[slot.percentCurrent].texture);
          batch.draw(first + 1, 1);
          if (slot.percentMix < 1) {
            gl.bindTexture(gl.TEXTURE_2D, slot.percent[1 - slot.percentCurrent].texture);
            batch.draw(first + 2, 1);
          }
        } else if (style === "kernel") {
          gl.bindTexture(gl.TEXTURE_2D, slot.log.texture);
          batch.draw(first + 3, 1);
        }
        if (style === "classic" || style === "kernel") {
          gl.bindTexture(gl.TEXTURE_2D, white);
          batch.draw(first + 4, 1);
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / REF_HEIGHT;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const simStep = step * clamp(p.speed, 0, 3);
          time += step;
          const style = blueStyle(p.style);
          // Params a style doesn't show are pinned, so changing them doesn't redraw it.
          const hue = style === "modern" ? blueHue(p.hue) : "blue";
          const seed = Math.round(p.seed);
          const typed = settledText.update(p.text, step);
          const text = style === "kernel" ? "" : typed;
          const code = settledCode.update(p.code, step);

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

          // A new look crossfades in, one change at a time.
          const shown = fade.current;
          if (shown.painted < 0) {
            fill(shown, null, style, hue, text, code, seed);
          } else if (
            !fade.fading &&
            (shown.style !== style ||
              shown.hue !== hue ||
              shown.text !== text ||
              shown.code !== code ||
              shown.seed !== seed)
          ) {
            fill(fade.next, shown, style, hue, text, code, seed);
            fade.start();
          }
          fade.step(step);

          const a = fade.current;
          const b = fade.next;
          const fading = fade.fading;
          const mix = fade.mix;
          advance(a, step, simStep);
          if (fading) {
            advance(b, step, simStep);
          }

          const blink = cursorAlpha(time);
          count = 0;
          const firstA = putSlot(a, 1, blink);
          const firstB = fading ? putSlot(b, mix, blink) : -1;
          batch.upload(count);

          // The background colour behind everything, in case the screen has no canvas.
          const bg = a.background;
          const k = fading ? mix : 0;
          gl.clearColor(
            bg[0] + (b.background[0] - bg[0]) * k,
            bg[1] + (b.background[1] - bg[1]) * k,
            bg[2] + (b.background[2] - bg[2]) * k,
            1,
          );
          gl.clear(gl.COLOR_BUFFER_BIT);

          gl.useProgram(program);
          u.f2("uResolution", width, height);
          gl.activeTexture(gl.TEXTURE0);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          drawSlot(a, firstA);
          if (fading) {
            drawSlot(b, firstB);
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
