import { createCanvasTexture, paintCanvas, SANS_FONT_STACK } from "../canvas-texture";
import { unitRgbMemo } from "../color";
import { createCrossfadeSlots } from "../fade";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { approach } from "../math";
import { buildPeriodicNoiseTexture } from "../noise";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch } from "../sprites";
import { fillTabular } from "../stream-overlay/overlay-text";
import { createTextLayer, setTextPalette, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import {
  ART_FOG,
  artLights,
  LIGHT_STRIDE,
  MAX_LIGHTS,
  paintArt,
  toArtId,
} from "./loadingscreen-art";
import {
  BAR_MAX_WIDTH,
  createHudLayout,
  layoutHud,
  TIP_LINES,
  wrapWords,
} from "./loadingscreen-hud";
import {
  createDrift,
  createDriftWindow,
  createProgress,
  createProgressTrack,
  driftAt,
  driftWindow,
  emblemAngle,
  LABELS,
  OVERSCAN,
  type ProgressTrack,
  steadyAt,
  tipAt,
  tipList,
} from "./loadingscreen-sim";
import { type ArtId, loadingScreenMeta } from "./loadingscreen.meta";

/** Seconds an art change cross-fades over, and a tip or label change. */
const ART_FADE = 1.5;
const TEXT_FADE = 0.6;
/** The painting's tallest, px: it is soft, so a 4K frame upscales it a little. */
const MAX_PAINT_HEIGHT = 1440;
const MAX_PAINT_WIDTH = 4096;
/** Seconds a new frame size must hold before the paintings are repainted for it. */
const REPAINT_SETTLE = 0.3;
/**
 * The fastest the bar's fill may move, % a second: its end then moves at most
 * `MAX_FEATURE_PX_PER_FRAME` on the longest bar. The curves stay under this,
 * so it only bites on a seed or mode change.
 */
const MAX_FILL_RATE = (100 * 10 * 30) / BAR_MAX_WIDTH / 1.05;
/** The fastest the drift's window may move (painting widths a second), so a seed change glides. */
const MAX_WINDOW_RATE = 0.02;
/** How fast the fog drifts, noise tiles a second. */
const FOG_SPEED = 0.004;
/** The noise texture's size, and its tiles per painting height. */
const NOISE_SIZE = 128;
const FOG_TILES = 1.6;
/** Room round text on the canvas for its shadow, 1080p px. */
const TEXT_PAD = 10;
/** The bar's soft glow, 1080p px. */
const BAR_GLOW = 7;
/** Text colours, 0..1 sRGB. */
const TEXT_MAIN = [0.95, 0.96, 0.98] as const;
const TEXT_MUTED = [0.8, 0.83, 0.88] as const;
const BLACK = [0, 0, 0] as const;

/** Sprite kinds, and floats per sprite: rect, info (kind, alpha, value, margin), colour. */
const KIND_BAR = 0;
const KIND_EMBLEM = 1;
const KIND_LIGHT = 2;
const STRIDE = 12;
const MAX_SPRITES = 2 * MAX_LIGHTS + 2;

const ART_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
/** The window onto the paintings: left, top and size, 0..1 (y down). */
uniform vec3 uWindow;
uniform sampler2D uArtA;
uniform sampler2D uArtB;
uniform float uMix;
uniform sampler2D uNoise;
/** Fog: strength, band centre, band half-height, drift offset. */
uniform vec4 uFog;
uniform vec3 uFogColour;
/** Noise tiles across and down the painting. */
uniform vec2 uFogTiles;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 s = gl_FragCoord.xy / uResolution;
  s.y = 1.0 - s.y;
  vec2 uv = uWindow.xy + s * uWindow.z;
  vec3 c = texture(uArtA, uv).rgb;
  if (uMix > 0.0) {
    c = mix(c, texture(uArtB, uv).rgb, uMix);
  }
  if (uFog.x > 0.0) {
    vec2 n = uv * uFogTiles;
    float f = texture(uNoise, n + vec2(uFog.w, 0.0)).r * 0.65
      + texture(uNoise, n * 2.3 + vec2(0.37 - uFog.w * 0.6, 0.21)).r * 0.35;
    float y = (uv.y - uFog.y) / uFog.z;
    c = mix(c, uFogColour, uFog.x * exp(-y * y) * smoothstep(0.35, 0.75, f));
  }
  // The scrim: darker towards the bottom, where the text sits, and a soft vignette.
  c *= 1.0 - 0.62 * smoothstep(0.5, 1.0, s.y);
  vec2 v = s - 0.5;
  c *= 1.0 - 0.35 * dot(v, v);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre and half size (with the margin), px, y down. */
layout(location = 1) in vec4 aRect;
/** Kind, opacity, value (bar fill, emblem angle), margin px. */
layout(location = 2) in vec4 aInfo;
layout(location = 3) in vec4 aColour;
uniform vec2 uResolution;
out vec2 vP;
flat out vec2 vHalf;
flat out vec4 vInfo;
flat out vec3 vColour;
${TO_CLIP_GLSL}
void main() {
  vP = aCorner * aRect.zw;
  vHalf = max(aRect.zw - aInfo.w, vec2(0.5));
  vInfo = aInfo;
  vColour = aColour.rgb;
  gl_Position = pxToClip(aRect.xy + vP, uResolution);
}
`;

/** The bar, the emblem and the art's lights; premultiplied, lights added (zero alpha). */
const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec2 vHalf;
flat in vec4 vInfo;
flat in vec3 vColour;
out vec4 outColor;

float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float cover(float d) {
  return clamp(0.5 - d, 0.0, 1.0);
}

vec4 bar() {
  float r = vHalf.y;
  float d = sdBox(vP, vHalf, r);
  float fillX = -vHalf.x + 2.0 * vHalf.x * vInfo.z;
  float inFill = clamp(fillX - vP.x + 0.5, 0.0, 1.0);
  vec4 track = vec4(vec3(0.16), 0.16) * cover(d);
  vec4 fill = vec4(vColour, 1.0) * cover(d) * inFill;
  vec4 c = fill + track * (1.0 - fill.a);
  // A soft glow round the filled part, added.
  float hw = 0.5 * (fillX + vHalf.x);
  float gd = sdBox(vP - vec2(-vHalf.x + hw, 0.0), vec2(max(hw, r), r), r);
  float glow = exp(-max(gd, 0.0) / (0.35 * vInfo.w)) * (1.0 - cover(gd)) * smoothstep(0.0, 0.02, vInfo.z);
  c.rgb += vColour * glow * 0.35;
  return c;
}

vec4 emblem() {
  float R = vHalf.x;
  float r = length(vP);
  float ang = vInfo.z;
  // Three arcs of a ring, turning.
  float sector = 2.0943951;
  float a = atan(vP.y, vP.x) - ang;
  float seg = fract(a / sector);
  float gap = (min(seg, 1.0 - seg) * sector - 0.24) * r;
  float ring = max(abs(r - 0.8 * R) - 0.07 * R, -gap);
  // A faint whole ring outside, and a four-pointed star turning the other way inside.
  float faint = abs(r - 0.98 * R) - 0.018 * R;
  float c2 = cos(0.5 * ang);
  float s2 = sin(0.5 * ang);
  vec2 q = abs(mat2(c2, -s2, s2, c2) * vP);
  float star = (min(q.x + 0.22 * q.y, q.y + 0.22 * q.x) - 0.13 * R) / 1.03;
  float alpha = max(max(cover(ring), cover(star) * 0.95), cover(faint) * 0.3);
  vec4 c = vec4(vColour, 1.0) * alpha;
  c.rgb += vColour * 0.25 * exp(-max(ring, 0.0) / (0.12 * R)) * (1.0 - alpha);
  return c;
}

vec4 light() {
  float r = length(vP) / vHalf.x;
  float g = exp(-r * r * 3.0) * 0.6 + exp(-r * r * 40.0);
  return vec4(vColour * g, 0.0);
}

void main() {
  vec4 c = vInfo.x < 0.5 ? bar() : vInfo.x < 1.5 ? emblem() : light();
  outColor = c * vInfo.y;
}
`;

/** One painting slot: its texture, what's painted in it, and at what size. */
interface ArtSlot {
  readonly texture: ReturnType<typeof createCanvasTexture>;
  art: ArtId;
  /** The painting's size key (see `sizeKey`) when last painted, or -1. */
  painted: number;
}

/** A string's width in the context's font (0 from the test stand-in canvas, which measures nothing). */
const textWidth = (ctx: OffscreenCanvasRenderingContext2D, s: string) =>
  (ctx.measureText(s) as TextMetrics | undefined)?.width ?? 0;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const sizeKey = (w: number, h: number) => w * 65536 + h;

/**
 * A game's loading screen that never quite finishes: a painting (drawn once per
 * size on a 2D canvas, a little larger than the frame) drifts slowly behind,
 * with fog drifting across it and a few lights on top; the progress bar, its
 * label and percentage, a spinning emblem and a rotating tip sit in the bottom
 * corners. The text is canvas text redrawn only when it changes.
 */
export const loadingScreen = defineEffect(loadingScreenMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const artProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ART_FRAGMENT);
      const au = createUniforms(gl, artProgram, [
        "uResolution",
        "uWindow",
        "uArtA",
        "uArtB",
        "uMix",
        "uNoise",
        "uFog",
        "uFogColour",
        "uFogTiles",
      ]);
      gl.useProgram(artProgram);
      au.i1("uArtA", 0);
      au.i1("uArtB", 1);
      au.i1("uNoise", 2);
      const noise = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, [{ period: 4, seed: 0xf09 }]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const spriteProgram = scopedProgram(gl, scope, SPRITE_VERTEX, SPRITE_FRAGMENT);
      const su = createUniforms(gl, spriteProgram, ["uResolution"]);
      gl.useProgram(null);
      const batch = scope.own(createSpriteBatch(gl, MAX_SPRITES, [4, 4, 4]));
      if (batch.stride !== STRIDE) {
        throw new Error("Loading Screen: sprite layout mismatch");
      }

      const text = createTextLayer(gl, scope, 5);
      const palette = new Float32Array(TEXT_PALETTE_FLOATS);
      const accentRgb = unitRgbMemo();

      const slots: [ArtSlot, ArtSlot] = [
        { texture: createCanvasTexture(gl, scope), art: "ruins", painted: -1 },
        { texture: createCanvasTexture(gl, scope), art: "ruins", painted: -1 },
      ];
      const artFade = createCrossfadeSlots(slots, ART_FADE, () => {});
      const paintSize = createSettledValue<number>(REPAINT_SETTLE);
      let paintW = 1;
      let paintH = 1;
      let started = false;

      const layout = createHudLayout();
      let width = 1;
      let height = 1;
      let scale = 1;
      let laidOut = false;
      let time = 0;

      // Progress.
      let seed = Number.NaN;
      let track: ProgressTrack = createProgressTrack(0);
      const progress = createProgress();
      let shown = 0;
      let drawnPercent = -1;

      // Drift, eased towards its target so a seed change glides.
      const drift = createDrift();
      const target = createDriftWindow();
      const view = createDriftWindow();

      // Text: two tip rows and two label rows that cross-fade, and the percentage.
      let pad = 1;
      let tipRow = 1;
      let labelRow = 1;
      const tipFade = createCrossfadeSlots([0, 1] as const, TEXT_FADE, () => {});
      const labelFade = createCrossfadeSlots([0, 1] as const, TEXT_FADE, () => {});
      const tipText = ["", ""];
      const labelText = [-1, -1];
      let tipsSource: string | null = null;
      let tips: string[] = [];
      let tipSlot = 0;
      let tipStart = 0;
      let tipLength = 12;

      const lights = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE);

      const paint = (slot: ArtSlot, art: ArtId, key: number) => {
        slot.art = art;
        slot.painted = key;
        const w = paintW;
        const h = paintH;
        slot.texture.upload(
          paintCanvas(w, h, (ctx) => {
            paintArt(ctx, art, w, h);
          }),
        );
      };

      const shadow = (ctx: OffscreenCanvasRenderingContext2D) => {
        ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
        ctx.shadowBlur = Math.round(6 * layout.k);
        ctx.shadowOffsetY = Math.round(1.5 * layout.k);
      };
      const noShadow = (ctx: OffscreenCanvasRenderingContext2D) => {
        ctx.shadowColor = "rgba(0, 0, 0, 0)";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      };

      const tipRowW = () => layout.tip.w + 2 * pad;
      const labelRowW = () => layout.label.w + 2 * pad;
      const labelTop = (i: number) => 2 * tipRow + i * labelRow;

      const drawTip = (i: number, tip: string) => {
        tipText[i] = tip;
        const top = i * tipRow;
        text.clear(0, top, text.width, tipRow);
        const ctx = text.ctx;
        if (!ctx || tip.length === 0) {
          return;
        }
        const l = layout;
        const prefixFont = `800 ${String(l.tipPx)}px ${SANS_FONT_STACK}`;
        const bodyFont = `500 ${String(l.tipPx)}px ${SANS_FONT_STACK}`;
        ctx.font = prefixFont;
        const prefix = "TIP:";
        const prefixW = textWidth(ctx, prefix) + 0.4 * l.tipPx;
        ctx.font = bodyFont;
        const lines = wrapWords(
          tip,
          (s) => textWidth(ctx, s),
          l.tip.w - prefixW,
          l.tip.w,
          TIP_LINES,
        );
        shadow(ctx);
        const first = TIP_LINES - lines.length;
        const lineY = (k: number) => top + pad + (first + k + 0.5) * l.tipLine;
        text.fill(prefix, pad, lineY(0), TEXT_ROLES.up, prefixFont, prefixW);
        for (let k = 0; k < lines.length; k++) {
          const x = k === 0 ? pad + prefixW : pad;
          const room = k === 0 ? l.tip.w - prefixW : l.tip.w;
          text.fill(lines[k], x, lineY(k), TEXT_ROLES.muted, bodyFont, room);
        }
        noShadow(ctx);
      };

      const drawLabel = (i: number, label: number) => {
        labelText[i] = label;
        const top = labelTop(i);
        text.clear(0, top, text.width, labelRow);
        const ctx = text.ctx;
        if (!ctx) {
          return;
        }
        shadow(ctx);
        text.fill(
          LABELS[label] ?? LABELS[0],
          pad,
          top + labelRow / 2,
          TEXT_ROLES.primary,
          `600 ${String(layout.labelPx)}px ${SANS_FONT_STACK}`,
          layout.label.w * 0.75,
        );
        noShadow(ctx);
      };

      const drawPercent = (n: number) => {
        drawnPercent = n;
        const top = labelTop(2);
        text.clear(0, top, text.width, labelRow);
        const ctx = text.ctx;
        if (!ctx) {
          return;
        }
        shadow(ctx);
        fillTabular(
          ctx,
          `${String(n)}%`,
          pad + layout.label.w,
          top + labelRow / 2,
          `700 ${String(layout.labelPx)}px ${SANS_FONT_STACK}`,
          TEXT_ROLES.up,
          "right",
        );
        noShadow(ctx);
      };

      const relayout = () => {
        layoutHud(width, height, scale, layout);
        laidOut = true;
        pad = Math.max(1, Math.round(TEXT_PAD * layout.k));
        tipRow = layout.tip.h + 2 * pad;
        labelRow = layout.label.h + 2 * pad;
        text.resize(Math.max(tipRowW(), labelRowW()), 2 * tipRow + 3 * labelRow);
        // Redraw everything shown at the new size.
        for (let i = 0; i < 2; i++) {
          drawTip(i, tipText[i]);
          if (labelText[i] >= 0) {
            drawLabel(i, labelText[i]);
          }
        }
        drawPercent(Math.max(0, drawnPercent));
      };

      const tipQuad = (i: number, alpha: number) => {
        const w = tipRowW();
        text.quad(
          0,
          i * tipRow,
          w,
          tipRow,
          layout.tip.x - pad,
          layout.tip.y - pad,
          w,
          tipRow,
          alpha,
        );
      };
      const labelQuad = (i: number, alpha: number) => {
        const w = labelRowW();
        const x = layout.label.x - pad;
        text.quad(0, labelTop(i), w, labelRow, x, layout.label.y - pad, w, labelRow, alpha);
      };

      /** Writes one sprite at instance `n` and returns `n + 1`. */
      const sprite = (
        n: number,
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        kind: number,
        alpha: number,
        value: number,
        margin: number,
        rgb: ArrayLike<number>,
        rgbAt = 0,
      ) => {
        if (n >= MAX_SPRITES || !(alpha > 0)) {
          return n;
        }
        const d = batch.data;
        const o = n * STRIDE;
        d[o] = cx;
        d[o + 1] = cy;
        d[o + 2] = hw + margin;
        d[o + 3] = hh + margin;
        d[o + 4] = kind;
        d[o + 5] = alpha;
        d[o + 6] = value;
        d[o + 7] = margin;
        d[o + 8] = rgb[rgbAt];
        d[o + 9] = rgb[rgbAt + 1];
        d[o + 10] = rgb[rgbAt + 2];
        d[o + 11] = 0;
        return n + 1;
      };

      /** Adds slot `s`'s lights at `alpha` from sprite `n`; returns the next free one. */
      const addLights = (n: number, s: ArtSlot, alpha: number) => {
        if (!(alpha > 0)) {
          return n;
        }
        const count = artLights(s.art, width / height, time, lights);
        let next = n;
        for (let i = 0; i < count; i++) {
          const o = i * LIGHT_STRIDE;
          const x = ((lights[o] - view.u0) / view.size) * width;
          const y = ((lights[o + 1] - view.v0) / view.size) * height;
          const r = (lights[o + 2] / view.size) * height * 3;
          next = sprite(next, x, y, r, r, KIND_LIGHT, alpha * lights[o + 3], 0, 0, lights, o + 4);
        }
        return next;
      };

      return {
        resize(viewport) {
          width = Math.max(1, Math.floor(viewport.width));
          height = Math.max(1, Math.floor(viewport.height));
          scale = viewport.scale > 0 ? viewport.scale : height / 1080;
          laidOut = false;
          const aspect = width / height;
          paintH = Math.max(
            1,
            Math.min(
              Math.round(height * OVERSCAN),
              MAX_PAINT_HEIGHT,
              Math.floor(MAX_PAINT_WIDTH / aspect),
            ),
          );
          paintW = Math.max(1, Math.min(MAX_PAINT_WIDTH, Math.round(paintH * aspect)));
        },
        frame(dt, params) {
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          if (!laidOut) {
            relayout();
          }

          // The paintings: the wanted art cross-fades in; a new size repaints once it settles.
          const art = toArtId(params.art);
          const key = paintSize.update(sizeKey(paintW, paintH), step);
          if (!started) {
            paint(artFade.current, art, key);
            started = true;
          }
          if (!artFade.fading && art !== artFade.current.art) {
            paint(artFade.next, art, key);
            artFade.start();
          }
          artFade.step(step);
          if (artFade.current.painted !== key) {
            paint(artFade.current, artFade.current.art, key);
          }
          if (artFade.fading && artFade.next.painted !== key) {
            paint(artFade.next, artFade.next.art, key);
          }
          const mix = artFade.fading ? artFade.mix * artFade.mix * (3 - 2 * artFade.mix) : 0;

          // Seed: the progress curve, the tip order and the drift path.
          const wantSeed = Math.floor(Number.isFinite(params.seed) ? params.seed : 0);
          const first = Number.isNaN(seed);
          if (wantSeed !== seed) {
            // Allocates: only when the seed changes.
            seed = wantSeed;
            track = createProgressTrack(seed);
          }

          // Drift.
          driftWindow(driftAt(seed, time, drift), target);
          if (first) {
            view.u0 = target.u0;
            view.v0 = target.v0;
            view.size = target.size;
          } else {
            const m = MAX_WINDOW_RATE * step;
            view.u0 = approach(view.u0, target.u0, m);
            view.v0 = approach(view.v0, target.v0, m);
            view.size = approach(view.size, target.size, m);
          }

          // Progress.
          if (params.progress === "steady") {
            steadyAt(time, params.loop * 60, progress);
          } else {
            track.at(time, progress);
          }
          shown = first ? progress.value : approach(shown, progress.value, MAX_FILL_RATE * step);
          const percent = Math.min(100, Math.max(0, Math.floor(shown)));
          if (percent !== drawnPercent) {
            drawPercent(percent);
          }
          if (labelText[0] < 0) {
            drawLabel(0, progress.label);
          } else if (!labelFade.fading && progress.label !== labelText[labelFade.current]) {
            drawLabel(labelFade.next, progress.label);
            labelFade.start();
          }
          labelFade.step(step);

          // Tips: each shown for the `tipEvery` it started with.
          if (params.tips !== tipsSource) {
            // Allocates: only when the tips change.
            tipsSource = params.tips;
            tips = tipList(params.tips);
          }
          if (tipText[0].length === 0 && tipText[1].length === 0) {
            tipLength = params.tipEvery;
            tipStart = time;
          } else if (time - tipStart >= tipLength) {
            tipSlot++;
            tipStart = time;
            tipLength = params.tipEvery;
          }
          const tip = tips[tipAt(seed, tipSlot, tips.length)] ?? "";
          if (tipText[0].length === 0 && tipText[1].length === 0) {
            drawTip(0, tip);
          } else if (!tipFade.fading && tip !== tipText[tipFade.current]) {
            drawTip(tipFade.next, tip);
            tipFade.start();
          }
          tipFade.step(step);
          text.flush();

          // Draw: the painting, then lights, bar and emblem, then text.
          beginFrame(gl, width, height);
          gl.useProgram(artProgram);
          au.f2("uResolution", width, height);
          au.f3("uWindow", view.u0, view.v0, view.size);
          au.f1("uMix", mix);
          const fogA = ART_FOG[artFade.current.art];
          const fogB = artFade.fading ? ART_FOG[artFade.next.art] : fogA;
          const drift01 = (time * FOG_SPEED) % 1;
          au.f4(
            "uFog",
            lerp(fogA.strength, fogB.strength, mix),
            lerp(fogA.centre, fogB.centre, mix),
            lerp(fogA.half, fogB.half, mix),
            drift01,
          );
          au.f3(
            "uFogColour",
            lerp(fogA.colour[0], fogB.colour[0], mix),
            lerp(fogA.colour[1], fogB.colour[1], mix),
            lerp(fogA.colour[2], fogB.colour[2], mix),
          );
          au.f2("uFogTiles", (FOG_TILES * width) / height, FOG_TILES);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, artFade.current.texture.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, artFade.next.texture.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, noise);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, null);

          const accent = accentRgb(params.accent);
          let n = addLights(0, artFade.current, 1 - mix);
          if (artFade.fading) {
            n = addLights(n, artFade.next, mix);
          }
          const bar = layout.bar;
          const glow = BAR_GLOW * layout.k;
          n = sprite(
            n,
            bar.x + bar.w / 2,
            bar.y + bar.h / 2,
            bar.w / 2,
            bar.h / 2,
            KIND_BAR,
            1,
            shown / 100,
            3 * glow,
            accent,
          );
          n = sprite(
            n,
            layout.emblemX,
            layout.emblemY,
            layout.emblemR,
            layout.emblemR,
            KIND_EMBLEM,
            1,
            emblemAngle(time),
            0.3 * layout.emblemR,
            accent,
          );
          batch.upload(n);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(spriteProgram);
          su.f2("uResolution", width, height);
          batch.draw(0, n);

          // Text.
          const tm = tipFade.mix;
          tipQuad(tipFade.current, 1 - tm * tm * (3 - 2 * tm));
          if (tipFade.fading) {
            tipQuad(tipFade.next, tm * tm * (3 - 2 * tm));
          }
          const lm = labelFade.mix;
          labelQuad(labelFade.current, 1 - lm * lm * (3 - 2 * lm));
          if (labelFade.fading) {
            labelQuad(labelFade.next, lm * lm * (3 - 2 * lm));
          }
          labelQuad(2, 1);
          setTextPalette(palette, TEXT_MAIN, TEXT_MUTED, accent, accent, BLACK);
          text.draw(width, height, palette);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
