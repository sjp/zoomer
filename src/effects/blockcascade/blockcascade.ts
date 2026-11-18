import {
  createCanvasTexture,
  MONO_FONT_STACK,
  paintCanvas,
  SANS_FONT_STACK,
} from "../canvas-texture";
import { createColorEase, hexesToUnitRgb } from "../color";
import { createFadeThrough } from "../fade";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { createRng } from "../noise";
import { createSpriteBatch } from "../sprites";
import { createTextLayer, setTextPalette, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import { blockCascadeMeta } from "./blockcascade.meta";
import {
  buildWell,
  createLayout,
  createScene,
  GLOW_GAIN,
  headerText,
  type HeaderText,
  layoutWells,
  MAX_SPRITES,
  STRIDE,
} from "./blockcascade-scene";
import { COLOURS, createWell, shownScore, stepWell, type Well } from "./blockcascade-sim";

/** Seconds of play run before the first frame, so the wells start part-way through a game. */
const WARMUP = 150;
/** Seconds each half of the fade-through takes when the wells or the seed change. */
const SWAP_HALF = 0.5;
/** Seconds a palette eases over, and a block style crossfades over. */
const PALETTE_EASE = 1.2;
const STYLE_EASE = 1;
/** The backdrop's bokeh is painted at this fraction of the frame's size and upscaled. */
const BOKEH_SCALE = 0.25;
const BOKEH_DISCS = 16;

/**
 * Palettes: six block colours, then the backdrop's top and bottom, the two
 * bokeh tints (added), the panels' fill and border, and the text's main and
 * label colours. All made up.
 */
const PALETTES: Record<string, readonly string[]> = {
  candy: [
    "#ff6b9a",
    "#ffa94d",
    "#ffe066",
    "#69db7c",
    "#4dabf7",
    "#b197fc",
    "#2b1d40",
    "#552a5a",
    "#3a1f4a",
    "#4a2a3a",
    "#150b22",
    "#f0c0e8",
    "#fff4fb",
    "#e2b4da",
  ],
  pastel: [
    "#f4a3b5",
    "#f7c48c",
    "#eedc7c",
    "#a3d9ae",
    "#99c4ea",
    "#c4afe8",
    "#f3eef7",
    "#dbe1f2",
    "#0c0a10",
    "#0a0c10",
    "#ffffff",
    "#b4a6cc",
    "#4b3f5c",
    "#8a7ca0",
  ],
  ocean: [
    "#2ec4b6",
    "#3a86ff",
    "#48cae4",
    "#90e0ef",
    "#5e6ef0",
    "#80ffdb",
    "#06182b",
    "#0d3a56",
    "#0c3450",
    "#122a5c",
    "#040e1c",
    "#7fd0f5",
    "#e6fbff",
    "#8fc5d8",
  ],
  mono: [
    "#f2f2f2",
    "#cdcdcd",
    "#a8a8a8",
    "#868686",
    "#dcdcdc",
    "#b8b8b8",
    "#151517",
    "#2b2b2f",
    "#222222",
    "#191919",
    "#09090a",
    "#9c9c9c",
    "#f5f5f5",
    "#a0a0a0",
  ],
};
const PALETTE_FLOATS = (COLOURS + 8) * 3;
const PALETTE_RGB: Record<string, Float32Array> = Object.fromEntries(
  Object.entries(PALETTES).map(([k, v]) => [k, hexesToUnitRgb(v)]),
);
/** Offsets into a palette's floats. */
const TOP = COLOURS * 3;
const BOTTOM = TOP + 3;
const BOKEH_A = TOP + 6;
const BOKEH_B = TOP + 9;
const PANEL = TOP + 12;
const BORDER = TOP + 15;
const TEXT = TOP + 18;
const LABEL = TOP + 21;

const STYLES: Record<string, number> = { glass: 0, pixel: 1, neon: 2 };

const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uBokehA;
uniform vec3 uBokehB;
uniform sampler2D uBokeh;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 c = mix(uBottom, uTop, uv.y);
  vec2 b = texture(uBokeh, vec2(uv.x, 1.0 - uv.y)).rg;
  c += b.x * uBokehA + b.y * uBokehB;
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre and half size, px, y down. */
layout(location = 1) in vec4 aSprite;
/** Opacity, glow, colour index, kind. */
layout(location = 2) in vec4 aInfo;
uniform vec2 uResolution;
/** Px the quad reaches past the sprite, for shadows and halos. */
uniform float uMargin;
uniform vec3 uColours[${String(COLOURS)}];
out vec2 vP;
flat out vec2 vHalf;
flat out vec4 vInfo;
flat out vec3 vColour;
${TO_CLIP_GLSL}
void main() {
  vP = aCorner * (aSprite.zw + uMargin);
  vHalf = aSprite.zw;
  vInfo = aInfo;
  vColour = uColours[clamp(int(aInfo.z + 0.5), 0, ${String(COLOURS - 1)})];
  gl_Position = pxToClip(aSprite.xy + vP, uResolution);
}
`;

/**
 * Cells and panels. Pass 0 draws what lies under them (soft shadows, neon
 * halos), pass 1 the cells and panels themselves. The block style is chosen
 * here, and while it changes the old and new styles are mixed.
 */
const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec2 vHalf;
flat in vec4 vInfo;
flat in vec3 vColour;
uniform int uPass;
/** Style from, style to, and how far between. */
uniform vec3 uStyle;
uniform float uCell;
uniform vec3 uPanel;
uniform vec3 uBorder;
out vec4 outColor;

float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float cover(float d) {
  return clamp(0.5 - d, 0.0, 1.0);
}

vec4 under(float style) {
  float s = 2.0 * vHalf.x;
  if (style < 0.5) {
    // Glass: a soft shadow down and to the right.
    float d = sdBox(vP - vec2(0.05, 0.09) * s, vHalf * 0.92, 0.2 * s);
    return vec4(0.0, 0.0, 0.0, 0.3 * (1.0 - smoothstep(-0.12 * s, 0.16 * s, d)));
  }
  if (style < 1.5) {
    return vec4(0.0);
  }
  // Neon: a halo round the outline, added (zero alpha).
  float d = sdBox(vP, vHalf * 0.86, 0.12 * s);
  float g = d > 0.0 ? exp(-d / (0.11 * s)) : 1.0;
  return vec4(vColour * (0.3 + 0.3 * vInfo.y) * g, 0.0);
}

vec4 body(float style) {
  float s = 2.0 * vHalf.x;
  vec2 u = vP / vHalf;
  if (style < 0.5) {
    // Glass: rounded and slightly see-through, lit from the top left, with a bright inner rim.
    float d = sdBox(vP, vHalf - 0.05 * s, 0.2 * s);
    float light = clamp(0.5 - 0.35 * (u.x + u.y), 0.0, 1.0);
    vec3 c = vColour * (0.72 + 0.4 * light);
    float rim = smoothstep(-0.17 * s, -0.07 * s, d) * (1.0 - smoothstep(-0.05 * s, -0.01 * s, d));
    c += vec3(0.45) * rim * clamp(0.35 - 0.6 * (u.x + u.y), 0.0, 1.0);
    vec2 h = u - vec2(-0.42, -0.48);
    c += vec3(0.22) * exp(-dot(h, h) * 7.0);
    float a = 0.84;
    return vec4(min(c, vec3(1.0)) * a, a) * cover(d);
  }
  if (style < 1.5) {
    // Pixel: flat, eight art pixels a side, a one-pixel bevel lit from the top left.
    vec2 g = clamp(floor((u * 0.5 + 0.5) * 8.0), 0.0, 7.0);
    vec3 c = vColour;
    if (g.x < 0.5 || g.y < 0.5) {
      c = mix(c, vec3(1.0), 0.45);
    } else if (g.x > 6.5 || g.y > 6.5) {
      c *= 0.55;
    } else if (g.x < 1.5 && g.y < 1.5) {
      c = mix(c, vec3(1.0), 0.7);
    }
    return vec4(c, 1.0);
  }
  // Neon: a dark cell with a glowing outline.
  float d = sdBox(vP, vHalf * 0.86, 0.12 * s);
  float line = 1.0 - smoothstep(0.025 * s, 0.06 * s, abs(d + 0.03 * s));
  float inner = exp(min(d, 0.0) / (0.12 * s));
  vec3 fill = vColour * (0.08 + 0.3 * inner);
  vec3 c = mix(fill, min(mix(vColour, vec3(1.0), 0.3) * 1.1, vec3(1.0)), line);
  float a = mix(0.88, 1.0, line);
  return vec4(c * a, a) * cover(d - 0.06 * s);
}

vec4 panel() {
  if (uPass == 0) {
    float d = sdBox(vP - vec2(0.0, 0.15 * uCell), vHalf, 0.45 * uCell);
    return vec4(0.0, 0.0, 0.0, 0.3 * (1.0 - smoothstep(-0.3 * uCell, 0.4 * uCell, d)));
  }
  float d = sdBox(vP, vHalf, 0.4 * uCell);
  float ring = cover(abs(d + 0.06 * uCell) - 0.03 * uCell);
  vec4 c = mix(vec4(uPanel * 0.55, 0.55), vec4(uBorder * 0.7, 0.7), ring);
  return c * cover(d);
}

void main() {
  vec4 c;
  if (vInfo.w > 0.5) {
    c = panel();
  } else if (uPass == 0) {
    c = under(uStyle.x);
    if (uStyle.z > 0.0) {
      c = mix(c, under(uStyle.y), uStyle.z);
    }
  } else {
    c = body(uStyle.x);
    if (uStyle.z > 0.0) {
      c = mix(c, body(uStyle.y), uStyle.z);
    }
    // A clearing row brightens towards white.
    c.rgb += (vec3(c.a) - c.rgb) * vInfo.y * ${glslFloat(GLOW_GAIN)};
  }
  outColor = c * vInfo.x;
}
`;

/** Paints the backdrop's bokeh: soft discs, the first tint in red and the second in green. */
function paintBokeh(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  const rng = createRng(0x5eed);
  for (let i = 0; i < BOKEH_DISCS; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const r = (0.05 + 0.11 * rng()) * Math.min(w, h);
    const level = Math.round(90 + 140 * rng());
    const colour = i % 2 === 0 ? `rgba(${String(level)},0,0,` : `rgba(0,${String(level)},0,`;
    // Undefined from the test stand-in canvas, whose methods return nothing.
    const g = ctx.createRadialGradient(x, y, 0, x, y, r) as CanvasGradient | undefined;
    if (!g) {
      continue;
    }
    g.addColorStop(0, `${colour}1)`);
    g.addColorStop(0.55, `${colour}0.75)`);
    g.addColorStop(1, `${colour}0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Text slots in the canvas per well: the SCORE label, the score, the NEXT label. */
const SLOTS = 3;

/**
 * A falling-block puzzle playing itself in two wells (or one): every cell is
 * one instanced sprite drawn in the chosen block style, over a gradient and
 * bokeh backdrop painted once per size; the scores and labels are canvas text
 * redrawn only when they change.
 */
export const blockCascade = defineEffect(blockCascadeMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const backdrop = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BACKDROP_FRAGMENT);
      const bu = createUniforms(gl, backdrop, [
        "uResolution",
        "uTop",
        "uBottom",
        "uBokehA",
        "uBokehB",
        "uBokeh",
      ]);
      gl.useProgram(backdrop);
      bu.i1("uBokeh", 0);
      const bokeh = createCanvasTexture(gl, scope);

      const sprites = scopedProgram(gl, scope, SPRITE_VERTEX, SPRITE_FRAGMENT);
      const su = createUniforms(gl, sprites, [
        "uResolution",
        "uMargin",
        "uColours",
        "uPass",
        "uStyle",
        "uCell",
        "uPanel",
        "uBorder",
      ]);
      gl.useProgram(null);
      const batch = scope.own(createSpriteBatch(gl, MAX_SPRITES, [4, 4]));
      if (batch.stride !== STRIDE) {
        throw new Error("Block Cascade: sprite layout mismatch");
      }
      const text = createTextLayer(gl, scope, 2 * SLOTS);
      const textPalette = new Float32Array(TEXT_PALETTE_FLOATS);
      const textMain = new Float32Array(3);
      const textLabel = new Float32Array(3);
      const textInverse = new Float32Array(3);

      const scene = createScene();
      const layout = createLayout();
      const header: HeaderText = { x: 0, nextX: 0, labelY: 0, scoreY: 0 };
      const palette = createColorEase(PALETTE_FLOATS);
      const swap = createFadeThrough(SWAP_HALF);
      let width = 1;
      let height = 1;
      let wells: [Well, Well] | null = null;
      /** What's shown: the seed the wells play and whether two were asked for. */
      let seed = 0;
      let two = true;
      let laidOut = false;
      /** Style crossfade: from, to and progress (0 when settled). */
      let styleFrom = 0;
      let styleTo = 0;
      let styleMix = 0;
      /** The text canvas's slot size, and each well's score as last drawn. */
      let slotW = 0;
      let slotH = 0;
      const drawnScore = [-1, -1];

      const start = (s: number, speed: number, skill: number) => {
        seed = s;
        const a = createWell(s, 0, speed, skill);
        const b = createWell(s, 1, speed, skill);
        stepWell(a, WARMUP, speed, skill);
        stepWell(b, WARMUP, speed, skill);
        wells = [a, b];
        drawnScore[0] = drawnScore[1] = -1;
      };

      /** Lays the wells out, paints the bokeh and sizes the text canvas for this frame size. */
      const relayout = () => {
        layoutWells(width, height, two, layout);
        laidOut = true;
        const cell = layout.cell;
        const bw = Math.max(1, Math.round(width * BOKEH_SCALE));
        const bh = Math.max(1, Math.round(height * BOKEH_SCALE));
        bokeh.upload(
          paintCanvas(bw, bh, (ctx) => {
            paintBokeh(ctx, bw, bh);
          }),
        );
        slotW = Math.max(1, Math.ceil(4.2 * cell));
        slotH = Math.max(1, Math.ceil(1.1 * cell));
        const sizeChanged = text.width !== slotW || text.height !== slotH * SLOTS * 2;
        if (text.resize(slotW, slotH * SLOTS * 2) && sizeChanged) {
          const label = `700 ${String(Math.max(1, Math.round(0.42 * cell)))}px ${SANS_FONT_STACK}`;
          for (let k = 0; k < 2; k++) {
            text.fill("SCORE", 1, (k * SLOTS + 0.5) * slotH, TEXT_ROLES.muted, label, slotW - 2);
            text.fill("NEXT", 1, (k * SLOTS + 2.5) * slotH, TEXT_ROLES.muted, label, slotW - 2);
          }
          drawnScore[0] = drawnScore[1] = -1;
        }
      };

      const drawScore = (k: number, score: number) => {
        if (drawnScore[k] === score) {
          return;
        }
        drawnScore[k] = score;
        const y = (k * SLOTS + 1) * slotH;
        text.clear(0, y, slotW, slotH);
        const font = `700 ${String(Math.max(1, Math.round(0.8 * layout.cell)))}px ${MONO_FONT_STACK}`;
        text.fill(String(score), 1, y + slotH / 2, TEXT_ROLES.primary, font, slotW - 2);
      };

      /** Draws text slot `slot` with its left edge at `x`, centred on `y`. */
      const textRow = (slot: number, x: number, y: number, alpha: number) => {
        text.quad(
          0,
          slot * slotH,
          slotW,
          slotH,
          Math.round(x),
          Math.round(y - slotH / 2),
          slotW,
          slotH,
          alpha,
        );
      };

      return {
        resize({ width: w, height: h }) {
          width = Math.max(1, Math.floor(w));
          height = Math.max(1, Math.floor(h));
          laidOut = false;
        },
        frame(dt, params) {
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const speed = params.speed;
          const skill = params.skill;
          const wantSeed = Math.floor(Number.isFinite(params.seed) ? params.seed : 0);
          const wantTwo = params.wells !== "one";
          if (!wells) {
            start(wantSeed, speed, skill);
            two = wantTwo;
          } else if (swap.idle && (wantSeed !== seed || wantTwo !== two)) {
            swap.start();
          }
          if (swap.step(step)) {
            if (wantSeed !== seed && wells) {
              start(wantSeed, speed, skill);
            }
            two = wantTwo;
            laidOut = false;
          }
          if (!laidOut) {
            relayout();
          }
          if (wells) {
            stepWell(wells[0], step, speed, skill);
            stepWell(wells[1], step, speed, skill);
          }

          // Colours and style.
          const target = PALETTE_RGB[params.palette] ?? PALETTE_RGB.candy;
          const col = palette.step(target, step, PALETTE_EASE);
          const style = STYLES[params.style] ?? 0;
          if (styleMix === 0 && style !== styleTo) {
            styleFrom = styleTo;
            styleTo = style;
            styleMix = 1e-6;
          }
          if (styleMix > 0) {
            styleMix = Math.min(1, styleMix + step / STYLE_EASE);
            if (styleMix >= 1) {
              styleFrom = styleTo;
              styleMix = 0;
            }
          }
          const ease = styleMix * styleMix * (3 - 2 * styleMix);

          // Sprites.
          const alpha = swap.alpha;
          scene.count = 0;
          if (wells) {
            for (let k = 0; k < layout.count; k++) {
              buildWell(scene, wells[k], layout.boxes[k], layout.cell, alpha);
            }
          }
          batch.data.set(scene.data.subarray(0, scene.count * STRIDE));
          batch.upload(scene.count);

          beginFrame(gl, width, height);
          gl.useProgram(backdrop);
          bu.f2("uResolution", width, height);
          bu.f3("uTop", col[TOP], col[TOP + 1], col[TOP + 2]);
          bu.f3("uBottom", col[BOTTOM], col[BOTTOM + 1], col[BOTTOM + 2]);
          bu.f3("uBokehA", col[BOKEH_A], col[BOKEH_A + 1], col[BOKEH_A + 2]);
          bu.f3("uBokehB", col[BOKEH_B], col[BOKEH_B + 1], col[BOKEH_B + 2]);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, bokeh.texture);
          triangle.draw();

          gl.useProgram(sprites);
          su.f2("uResolution", width, height);
          su.f1("uCell", layout.cell);
          su.f3("uStyle", styleFrom, styleTo, ease);
          su.f3("uPanel", col[PANEL], col[PANEL + 1], col[PANEL + 2]);
          su.f3("uBorder", col[BORDER], col[BORDER + 1], col[BORDER + 2]);
          gl.uniform3fv(su.loc.uColours, col, 0, COLOURS * 3);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          su.i1("uPass", 0);
          su.f1("uMargin", 0.4 * layout.cell);
          batch.draw(0, scene.count);
          su.i1("uPass", 1);
          su.f1("uMargin", 0);
          batch.draw(0, scene.count);

          // Scores and labels.
          if (wells && text.ctx) {
            for (let k = 0; k < layout.count; k++) {
              drawScore(k, shownScore(wells[k], wells[k].time));
            }
            text.flush();
          }
          for (let k = 0; k < layout.count; k++) {
            const t = headerText(layout.boxes[k], layout.cell, header);
            textRow(k * SLOTS, t.x, t.labelY, alpha);
            textRow(k * SLOTS + 1, t.x, t.scoreY, alpha);
            textRow(k * SLOTS + 2, t.nextX, t.labelY, alpha);
          }
          for (let i = 0; i < 3; i++) {
            textMain[i] = col[TEXT + i];
            textLabel[i] = col[LABEL + i];
            textInverse[i] = col[PANEL + i];
          }
          setTextPalette(textPalette, textMain, textLabel, textMain, textMain, textInverse);
          text.draw(width, height, textPalette);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
