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
import { createCanvasTexture, paintCanvas, SANS_FONT_STACK } from "../canvas-texture";
import { createColorEase, hexToUnitRgb, unitRgbMemo } from "../color";
import { approach, clamp } from "../math";
import { createSettledValue } from "../rebuild";
import { defineEffect } from "../types";
import { createLogoSim, LOGO_PALETTES, logoHeight, paletteIndex } from "./bouncinglogo-sim";
import { bouncingLogoMeta, MAX_LOGO_SPEED, type BouncingLogoCorners } from "./bouncinglogo.meta";
import { drawLogo, letterFont, logoLayout } from "./logo-art";

/** Seconds the text and the logo's pixel size must hold still before the texture is redrawn. */
const INPUT_SETTLE = 0.3;
/** Time constant of the size slider's ease, seconds. */
const SIZE_EASE = 0.2;
/** Seconds to cross between Classic and Modern (glow in, CRT out). */
const STYLE_EASE = 1;
/** Seconds a bounce's colour change takes in Modern; Classic snaps. */
const MODERN_COLOUR_EASE = 0.15;
/** Seconds a palette or mono colour change takes. */
const PALETTE_EASE = 1;
/** Length of a corner hit's celebration, seconds, and how far it lifts towards white. */
const CELEBRATE = 1;
const CELEBRATE_WHITEN = 0.45;
/** Glow room around the logo in the texture, and the glow's blur, in letter heights. */
const GLOW_PAD = 0.3;
const GLOW_BLUR = 0.18;
/** Modern's glow opacity at full strength. */
const GLOW_ALPHA = 0.35;
/** Seconds to fade the logo out (and in again) when the variation changes. */
const SEED_FADE = 0.35;
/** Seconds to fade the corner counter in or out. */
const COUNTER_FADE = 0.5;
/** Counter text size and margin, reference px, and its grey. */
const COUNTER_FONT = 22;
const COUNTER_MARGIN = 28;
const COUNTER_GREY = 0.55;
/** Largest texture side for the logo, px. */
const MAX_TEXTURE = 2048;

/**
 * Plain background, or in Classic a faint CRT look: the tube's slightly lifted,
 * grey-blue black in the middle and darker corners. A few ALU per pixel.
 */
const BACKGROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uBg;
uniform float uCrt;
uniform vec2 uRes;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r2 = dot(q, q);
  vec3 lift = vec3(0.030, 0.034, 0.038) * (1.0 - smoothstep(0.0, 0.6, r2));
  vec3 c = uBg * (1.0 - 0.5 * uCrt * smoothstep(0.15, 0.9, r2)) + uCrt * lift;
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** A textured quad placed in device px (top-left origin): the logo or the counter. */
const QUAD_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Left, top, width, height in device px. */
uniform vec4 uBox;
uniform vec2 uRes;
out vec2 vUv;
${TO_CLIP_GLSL}
void main() {
  vUv = aCorner;
  gl_Position = pxToClip(uBox.xy + aCorner * uBox.zw, uRes);
}
`;

/**
 * Red is the shape's coverage, green its blurred glow. One texture fetch; the
 * colour is flat, lifted towards white by uWhite during a celebration.
 */
const QUAD_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec3 uColor;
uniform float uWhite;
uniform float uGlow;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec2 t = texture(uTex, vUv).rg;
  float a = t.r + uGlow * t.g * (1.0 - t.r);
  outColor = vec4(mix(uColor, vec3(1.0), uWhite * t.r), a * uAlpha);
}
`;

const cornerMode = (v: string): BouncingLogoCorners =>
  v === "natural" || v === "often" ? v : "sometimes";

/** A palette's colours as consecutive RGB triples, 0..1. */
const paletteRgb = (hexes: readonly string[]) =>
  new Float32Array(hexes.flatMap((h) => hexToUnitRgb(h)));

/**
 * The DVD player's idle screen. The motion is a pure sim (bouncinglogo-sim.ts):
 * the logo's box drifts at 45 degrees and reflects off the edges, and a planner
 * nudges one axis's speed at a bounce so it lands in a corner every so often.
 * The logo is drawn once into a texture with a 2D canvas (logo-art.ts), redrawn
 * only when the text or its pixel size settles on a new value, and each frame is
 * a background pass (a clear in Modern) plus one small blended quad, two with
 * the counter.
 */
export const bouncingLogo = defineEffect(bouncingLogoMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const bgProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BACKGROUND_FRAGMENT);
      const ub = createUniforms(gl, bgProgram, ["uBg", "uCrt", "uRes"]);
      const quadProgram = scopedProgram(gl, scope, QUAD_VERTEX, QUAD_FRAGMENT);
      const uq = createUniforms(gl, quadProgram, [
        "uBox",
        "uRes",
        "uTex",
        "uColor",
        "uWhite",
        "uGlow",
        "uAlpha",
      ]);
      const vao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const buffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const logoTex = createCanvasTexture(gl, scope);
      const counterTex = createCanvasTexture(gl, scope);

      const palettes = {
        classic: paletteRgb(LOGO_PALETTES.classic),
        pastel: paletteRgb(LOGO_PALETTES.pastel),
      };
      const monoRgb = unitRgbMemo();
      const bgRgb = unitRgbMemo();
      const colour = createColorEase(3);
      const target = new Float32Array(3);

      let width = 1;
      let height = 1;
      let scale = 1;
      let first = true;

      const measure = (s: string): number | undefined => {
        let w: number | undefined;
        paintCanvas(1, 1, (ctx) => {
          ctx.font = letterFont(100);
          // Undefined from the tests' fake context, whose methods all return undefined.
          const metrics = ctx.measureText(s) as TextMetrics | undefined;
          w = metrics?.width;
        });
        return w === undefined ? undefined : w / 100;
      };

      const settledText = createSettledValue<string>(INPUT_SETTLE);
      const settledPx = createSettledValue<number>(INPUT_SETTLE);
      let layout = logoLayout(bouncingLogoMeta.params.text.default, measure);
      let layoutText: string | undefined;
      let builtText: string | undefined;
      let builtPx = -1;
      /** Glow room around the box, as a fraction of the box height. */
      let padFraction = GLOW_PAD / layout.height;

      /** Redraws the logo texture for a box `px` device px tall. */
      const buildLogo = (px: number) => {
        let unit = Math.max(1, px) / layout.height;
        const span = Math.max(layout.width, layout.height) + 2 * GLOW_PAD;
        unit = Math.min(unit, MAX_TEXTURE / span);
        const pad = GLOW_PAD * unit;
        const cw = Math.max(1, Math.ceil(layout.width * unit + 2 * pad));
        const ch = Math.max(1, Math.ceil(layout.height * unit + 2 * pad));
        const shape = paintCanvas(cw, ch, (ctx) => {
          ctx.fillStyle = "#f00";
          drawLogo(ctx, layout, pad, pad, unit);
        });
        const art =
          shape &&
          paintCanvas(cw, ch, (ctx) => {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, cw, ch);
            ctx.globalCompositeOperation = "lighter";
            // The glow: the shape's blurred shadow in green, cast from a copy drawn
            // just off the canvas so only the shadow lands on it.
            ctx.shadowColor = "#0f0";
            ctx.shadowBlur = GLOW_BLUR * unit;
            ctx.shadowOffsetX = cw;
            ctx.drawImage(shape, -cw, 0);
            ctx.shadowColor = "rgba(0, 0, 0, 0)";
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.drawImage(shape, 0, 0);
          });
        logoTex.upload(art ?? null);
        padFraction = GLOW_PAD / layout.height;
      };

      let counterShown = -1;
      let counterPx = -1;
      let counterW = 1;
      let counterH = 1;
      /** Redraws the counter's label for `count` corner hits. */
      const buildCounter = (count: number, px: number) => {
        const label = `corners: ${String(count)}`;
        counterW = Math.ceil(px * 0.62 * label.length) + 4;
        counterH = Math.ceil(px * 1.4);
        const canvas = paintCanvas(counterW, counterH, (ctx) => {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, counterW, counterH);
          ctx.font = `500 ${String(px)}px ${SANS_FONT_STACK}`;
          ctx.fillStyle = "#f00";
          ctx.textBaseline = "middle";
          ctx.fillText(label, 2, counterH / 2);
        });
        counterTex.upload(canvas);
        counterShown = count;
        counterPx = px;
      };

      let sim: ReturnType<typeof createLogoSim> | undefined;
      let size = 0;
      let modern = 0;
      let seedShown = 0;
      let fade = 1;
      let celebrate = CELEBRATE;
      let counterAlpha = 0;
      let easeSeconds = 0;
      let shownPalette = "";
      let shownMono = "";

      const drawQuad = (left: number, top: number, w: number, h: number) => {
        uq.f4("uBox", left, top, w, h);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const aspect = width / height;
          const smooth = p.style === "modern";

          // The letters change once typing pauses.
          const text = settledText.update(p.text, step);
          if (text !== layoutText) {
            layout = logoLayout(text, measure);
            layoutText = text;
          }
          const sizeTarget = clamp(p.size, 0.01, 1);
          size = first
            ? sizeTarget
            : size + (sizeTarget - size) * (1 - Math.exp(-step / SIZE_EASE));
          const logoAspect = layout.width / layout.height;
          const boxH = logoHeight(size, aspect, logoAspect);
          const boxW = boxH * logoAspect;
          const freeW = 1080 * aspect - boxW;
          const freeH = 1080 - boxH;
          const speed = clamp(p.speed, 0, MAX_LOGO_SPEED);
          const mode = cornerMode(p.corners);
          if (sim === undefined) {
            seedShown = p.seed;
            sim = createLogoSim(seedShown, freeW, freeH, mode, speed);
          } else {
            sim.setMode(mode);
            sim.setBounds(freeW, freeH);
          }

          // A new variation fades the logo out, moves it, and fades it back in.
          if (p.seed !== seedShown) {
            fade = Math.max(0, fade - step / SEED_FADE);
            if (fade === 0) {
              seedShown = p.seed;
              sim.reset(seedShown);
            }
          } else {
            fade = Math.min(1, fade + step / SEED_FADE);
          }

          const bounced = sim.step(step, speed);
          celebrate = sim.lastCorners > 0 ? 0 : Math.min(CELEBRATE, celebrate + step);
          const celebrating = celebrate < CELEBRATE;

          // The texture follows the text and, once it settles, the logo's pixel size.
          const px = settledPx.update(Math.round(boxH * scale), step);
          if (text !== builtText || px !== builtPx) {
            buildLogo(px);
            builtText = text;
            builtPx = px;
          }

          // Colour: the next palette entry per bounce; a celebration runs through
          // the palette once, snapping in Classic and blending in Modern.
          const mono = p.palette === "mono";
          const palette = p.palette === "pastel" ? palettes.pastel : palettes.classic;
          if (mono) {
            const c = monoRgb(p.color);
            target[0] = c[0];
            target[1] = c[1];
            target[2] = c[2];
          } else {
            const n = palette.length / 3;
            const base = paletteIndex(sim.bounces, n);
            const phase = celebrating ? (celebrate / CELEBRATE) * n : 0;
            const whole = Math.floor(phase);
            const f = smooth ? phase - whole : 0;
            const a = 3 * paletteIndex(base + whole, n);
            const b = 3 * paletteIndex(base + whole + 1, n);
            for (let i = 0; i < 3; i++) {
              target[i] = palette[a + i] + (palette[b + i] - palette[a + i]) * f;
            }
          }
          if (p.palette !== shownPalette || (mono && p.color !== shownMono)) {
            easeSeconds = first ? 0 : PALETTE_EASE;
            shownPalette = p.palette;
            shownMono = p.color;
          } else if (celebrating) {
            easeSeconds = 0;
          } else if (bounced > 0) {
            easeSeconds = smooth ? MODERN_COLOUR_EASE : 0;
          }
          const rgb = colour.step(target, step, easeSeconds);

          modern = first ? (smooth ? 1 : 0) : approach(modern, smooth ? 1 : 0, step / STYLE_EASE);
          counterAlpha = first
            ? Number(p.counter)
            : approach(counterAlpha, p.counter ? 1 : 0, step / COUNTER_FADE);
          first = false;

          // Background.
          const bg = bgRgb(p.background);
          const crt = 1 - modern;
          if (crt > 0.001) {
            gl.useProgram(bgProgram);
            ub.v3("uBg", bg);
            ub.f1("uCrt", crt);
            ub.f2("uRes", width, height);
            triangle.draw();
          } else {
            gl.clearColor(bg[0], bg[1], bg[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(quadProgram);
          uq.f2("uRes", width, height);
          uq.i1("uTex", 0);
          gl.activeTexture(gl.TEXTURE0);

          // The counter sits in the bottom-left corner, under the logo.
          if (counterAlpha > 0) {
            const cpx = Math.max(6, Math.round(COUNTER_FONT * scale));
            if (sim.corners !== counterShown || cpx !== counterPx) {
              buildCounter(sim.corners, cpx);
            }
            gl.bindTexture(gl.TEXTURE_2D, counterTex.texture);
            uq.f3("uColor", COUNTER_GREY, COUNTER_GREY, COUNTER_GREY);
            uq.f1("uWhite", 0);
            uq.f1("uGlow", 0);
            uq.f1("uAlpha", counterAlpha);
            const margin = COUNTER_MARGIN * scale;
            drawQuad(margin, height - margin - counterH, counterW, counterH);
          }

          const whiten = celebrating
            ? CELEBRATE_WHITEN * Math.sin((Math.PI * celebrate) / CELEBRATE)
            : 0;
          gl.bindTexture(gl.TEXTURE_2D, logoTex.texture);
          uq.v3("uColor", rgb);
          uq.f1("uWhite", whiten);
          uq.f1("uGlow", GLOW_ALPHA * modern * (1 + whiten));
          uq.f1("uAlpha", fade);
          const pad = padFraction * boxH * scale;
          drawQuad(
            sim.x * scale - pad,
            sim.y * scale - pad,
            boxW * scale + 2 * pad,
            boxH * scale + 2 * pad,
          );
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
