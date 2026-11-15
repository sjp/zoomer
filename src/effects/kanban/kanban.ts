import { type CanvasAtlas, createCanvasAtlas, SANS_FONT_STACK } from "../canvas-texture";
import { createChartRenderer, pushRect, pushRoundRect } from "../charts";
import { createColorEase, hexToUnitRgb } from "../color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  scopedProgram,
  withScope,
} from "../gl";
import { approach, clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { sanitizeText } from "../params";
import { createTextLayer, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import {
  type BoardLayout,
  boardLayout,
  CARD_CHIP_H,
  CARD_FOOTER_H,
  CARD_LINE_H,
  CARD_PAD,
  CARD_SPACING,
  cardHeight,
  COLUMN_W,
  MAX_COLUMNS,
} from "./kanban-layout";
import {
  applyLayout,
  type Board,
  type Card,
  cardPose,
  createBoard,
  createPose,
  LABELS,
  MAX_CARDS,
  PEOPLE,
  stepBoard,
} from "./kanban-sim";
import { COLUMN_SETS, kanbanMeta, MAX_PACE, MIN_PACE } from "./kanban.meta";

/** Seconds for look changes (theme, style), relabelling, panel moves, and each half of a board swap. */
const LOOK_EASE = 1.2;
const HEADER_FADE = 1;
const PANEL_SECONDS = 1.2;
const SWAP_HALF = 0.5;
/** Seconds a changed count or checklist stays tinted. */
const TINT_SECONDS = 1.2;
/** A lifted card grows this much and tilts this far (radians). */
const LIFT_SCALE = 0.035;
const LIFT_TILT = 0.04;
/** Sticky notes rest tilted up to this far either way (radians). */
const NOTE_TILT = 0.028;
/** Transparent border around each card in the atlas, for smooth edges when tilted, px. */
const ATLAS_PAD = 3;
/** Widest atlas row, px. */
const ATLAS_MAX_W = 4096;
/** Chart vertices and text regions a frame. */
const MESH_CAPACITY = 4000;
const MAX_QUADS = 32;
/** Reference sizes (1080p): count pill width, title region width. */
const COUNT_W = 44;
const TITLE_W = 640;

/** A handwritten-looking stack for sticky notes; no font is bundled. */
const HAND_FONT_STACK = `"Segoe Print", "Bradley Hand", "Marker Felt", "Chalkboard SE", "Comic Sans MS", cursive`;

/** Board palette slots: one RGB triple each, then scalars. */
const BG = 0;
const CHROME = 1;
const BORDER = 2;
const PANEL = 3;
const TEXT = 4;
const MUTED = 5;
const PILL = 6;
const ACCENT = 7;
const SHADOW = 8;
const AVATAR = 9;
const AVATARS = 3;
const COLORS = AVATAR + AVATARS;
const PANEL_A = COLORS * 3;
const CORK = PANEL_A + 1;
const STICKY = PANEL_A + 2;
const SHADOW_A = PANEL_A + 3;
const LOOK_FLOATS = SHADOW_A + 1;

/** Looks: theme (light, dark) plus 2 for sticky notes. */
const LOOKS: Float32Array[] = (
  [
    {
      colors: [
        ["#e8ecf1", "#ffffff", "#d5dbe2", "#dde3ea", "#1f2933", "#66717e"],
        ["#cbd3dc", "#2f7de1", "#0b1220", "#e5484d", "#2f7de1", "#0e9f8e"],
      ],
      scalars: [1, 0, 0, 0.16],
    },
    {
      colors: [
        ["#14171c", "#1b1f25", "#2a3038", "#1d2229", "#e3e7ec", "#8b95a2"],
        ["#2c333c", "#5a9cf0", "#000000", "#e5484d", "#2f7de1", "#0e9f8e"],
      ],
      scalars: [1, 0, 0, 0.45],
    },
    {
      colors: [
        ["#b98d5e", "#ece0cb", "#c9b28f", "#a37a4f", "#2e2014", "#4a3826"],
        ["#ece0cb", "#c2410c", "#1a0f05", "#c2410c", "#2563eb", "#15803d"],
      ],
      scalars: [0.35, 1, 1, 0.3],
    },
    {
      colors: [
        ["#4d3a28", "#2f241a", "#45362a", "#5e4834", "#f0e4d2", "#c7b49b"],
        ["#3a2d21", "#ff9a5c", "#000000", "#e5484d", "#5a9cf0", "#3fbf7a"],
      ],
      scalars: [0.4, 1, 1, 0.5],
    },
  ] as const
).map(({ colors, scalars }) => {
  const out = new Float32Array(LOOK_FLOATS);
  colors.flat().forEach((hex, i) => {
    out.set(hexToUnitRgb(hex), i * 3);
  });
  out.set(scalars, PANEL_A);
  return out;
});

/** How cards are painted in each look (CSS colours). */
interface CardLook {
  readonly bg: string;
  readonly border: string;
  readonly text: string;
  readonly muted: string;
  readonly done: string;
  /** Sticky-note colours, picked per card, or null for plain cards. */
  readonly notes: readonly string[] | null;
  readonly tape: string;
}

const CARD_LOOKS: readonly CardLook[] = [
  {
    bg: "#ffffff",
    border: "#dde2e8",
    text: "#1f2933",
    muted: "#6b7684",
    done: "#16a34a",
    notes: null,
    tape: "",
  },
  {
    bg: "#252a32",
    border: "#323843",
    text: "#e3e7ec",
    muted: "#97a1ae",
    done: "#3fbf7a",
    notes: null,
    tape: "",
  },
  {
    bg: "",
    border: "",
    text: "#2b2620",
    muted: "#5d554b",
    done: "#1f7a3a",
    notes: ["#fff1a8", "#ffd3de", "#cdf2d3", "#d3e7ff", "#ffdcb8"],
    tape: "rgba(255,255,255,0.5)",
  },
  {
    bg: "",
    border: "",
    text: "#1f1b16",
    muted: "#3f382f",
    done: "#1f5a2f",
    notes: ["#d8c977", "#d8a7b2", "#a3c9a9", "#a9bfd8", "#d8b48f"],
    tape: "rgba(255,255,255,0.3)",
  },
];

const PERSON_COLORS = ["#e5484d", "#2f7de1", "#0e9f8e", "#8b5cf6", "#d97706", "#db2777"];

/** Card corner radius at full card scale, px at 1080p: plain cards, sticky notes. */
const CARD_RADIUS = 8;
const NOTE_RADIUS = 2;

const CARD_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aSrc;
layout(location = 2) in float aAlpha;
uniform vec2 uResolution;
uniform vec2 uTexSize;
out vec2 vUv;
out float vAlpha;
void main() {
  vUv = aSrc / uTexSize;
  vAlpha = aAlpha;
  gl_Position = vec4(aPos.x / uResolution.x * 2.0 - 1.0, 1.0 - aPos.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

/** Two atlases of the same cards in two looks, crossfaded: `uMix` 1 shows `uCur` alone. */
const CARD_FRAGMENT = /* glsl */ `#version 300 es
// highp: the atlases are screen-sized, past what mediump texture coordinates resolve.
precision highp float;
uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform float uMix;
in vec2 vUv;
in float vAlpha;
out vec4 outColor;
void main() {
  vec4 c = texture(uCur, vUv);
  if (uMix < 1.0) {
    c = mix(texture(uPrev, vUv), c, uMix);
  }
  outColor = c * vAlpha;
}
`;

const SHADOW_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aLocal;
layout(location = 2) in vec4 aShape;
layout(location = 3) in vec4 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
out vec4 vShape;
out vec4 vColor;
void main() {
  vLocal = aLocal;
  vShape = aShape;
  vColor = aColor;
  gl_Position = vec4(aPos.x / uResolution.x * 2.0 - 1.0, 1.0 - aPos.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

/** A soft rounded rect: `vShape` is half size, corner radius, blur. Premultiplied colour. */
const SHADOW_FRAGMENT = /* glsl */ `#version 300 es
// highp: the shape is in device px, too coarse in mediump on big cards.
precision highp float;
in vec2 vLocal;
in vec4 vShape;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 q = abs(vLocal) - vShape.xy + vShape.z;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - vShape.z;
  outColor = vColor * (1.0 - smoothstep(-vShape.w, vShape.w, d));
}
`;

/** Cork: the board colour mottled by a fine grain and larger blotches from one tiling noise texture. */
const CORK_FRAGMENT = /* glsl */ `#version 300 es
// highp: gl_FragCoord runs to thousands of px, too coarse in mediump.
precision highp float;
uniform sampler2D uNoise;
uniform vec3 uBase;
uniform float uAmount;
uniform float uScale;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy / uScale;
  float fine = texture(uNoise, p / (2.5 * 128.0)).r;
  float blot = texture(uNoise, p / (26.0 * 128.0) + 0.37).r;
  float k = 1.0 + uAmount * (0.2 * (fine - 0.5) + 0.26 * (blot - 0.5));
  outColor = vec4(uBase * k, 1.0);
}
`;

const NOISE_SIZE = 128;

const CARD_STRIDE = 5;
const SHADOW_STRIDE = 12;
/** Quads per card in the shadow pass: its shadow and a tint glow. */
const SHADOW_QUADS = 2;

/** Card text fonts per style, sized for card scale `cs`. */
function cardFonts(cs: number, sticky: boolean) {
  const px = (n: number) => String(Math.max(4, Math.round(n * cs))) + "px ";
  const stack = sticky ? HAND_FONT_STACK : SANS_FONT_STACK;
  return {
    title: (sticky ? "400 " + px(17) : "500 " + px(15)) + stack,
    chip: "600 " + px(sticky ? 12 : 11) + stack,
    small: "400 " + px(12) + stack,
    initials: "600 " + px(10) + SANS_FONT_STACK,
  };
}

/** `s`'s width in the context's font, or an estimate from `fontPx` where there's no measure. */
function textWidth(ctx: OffscreenCanvasRenderingContext2D, s: string, fontPx: number): number {
  const w = (ctx.measureText(s) as TextMetrics | undefined)?.width;
  return w !== undefined && w >= 0 ? w : s.length * fontPx * 0.55;
}

/** A small hash in [0, 1) for card `id` on board `seed`. */
const cardHash = (seed: number, id: number, salt: number) =>
  hash32(Math.imul(seed + 1, 0x2c1b3c6d) ^ hash32(id * 31 + salt)) / 4294967296;

/**
 * A project board: a title bar, three or four columns with headers and counts,
 * and task cards that every so often lift, glide to the next column and settle
 * (`kanban-sim.ts`). Each card is painted once (and again when its checklist
 * ticks) into a card atlas and drawn as a textured quad with its own position,
 * scale and tilt over a soft shadow; a theme or style change paints a second
 * atlas and crossfades the two. Headers and counts are crisp text-layer labels;
 * the board is a chart mesh, over a cork texture for sticky notes.
 */
export const kanban = defineEffect(kanbanMeta, {
  create(gl) {
    return withScope((scope) => {
      const chart = createChartRenderer(gl, scope, MESH_CAPACITY);
      const mesh = chart.mesh;
      const text = createTextLayer(gl, scope, MAX_QUADS);
      const atlases: CanvasAtlas[] = [createCanvasAtlas(gl, scope), createCanvasAtlas(gl, scope)];
      const ease = createColorEase(LOOK_FLOATS);
      const v = ease.value;
      const col: Float32Array[] = [];
      for (let i = 0; i < COLORS; i++) {
        col.push(v.subarray(i * 3, i * 3 + 3));
      }
      const textPalette = new Float32Array(TEXT_PALETTE_FLOATS);

      const cardProgram = scopedProgram(gl, scope, CARD_VERTEX, CARD_FRAGMENT);
      const cu = createUniforms(gl, cardProgram, [
        "uResolution",
        "uTexSize",
        "uPrev",
        "uCur",
        "uMix",
      ]);
      const shadowProgram = scopedProgram(gl, scope, SHADOW_VERTEX, SHADOW_FRAGMENT);
      const su = createUniforms(gl, shadowProgram, ["uResolution"]);
      const corkProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, CORK_FRAGMENT);
      const ku = createUniforms(gl, corkProgram, ["uNoise", "uBase", "uAmount", "uScale"]);
      gl.useProgram(corkProgram);
      ku.i1("uNoise", 0);
      gl.useProgram(null);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const noiseData = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
      const noiseRng = createRng(0xc0a4);
      for (let i = 0; i < noiseData.length; i++) {
        noiseData[i] = Math.floor(noiseRng() * 256);
      }
      const noise = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: noiseData,
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      // Card and shadow vertex buffers.
      const cardVerts = new Float32Array(MAX_CARDS * 6 * CARD_STRIDE);
      const shadowVerts = new Float32Array(MAX_CARDS * SHADOW_QUADS * 6 * SHADOW_STRIDE);
      const makeVao = (data: Float32Array, stride: number, sizes: readonly number[]) => {
        const vao = scope.add(gl.createVertexArray(), (o) => {
          gl.deleteVertexArray(o);
        });
        const buffer = scope.add(gl.createBuffer(), (o) => {
          gl.deleteBuffer(o);
        });
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
        let offset = 0;
        sizes.forEach((n, i) => {
          gl.enableVertexAttribArray(i);
          gl.vertexAttribPointer(i, n, gl.FLOAT, false, stride * 4, offset * 4);
          offset += n;
        });
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return { vao, buffer };
      };
      const cardVao = makeVao(cardVerts, CARD_STRIDE, [2, 2, 1]);
      const shadowVao = makeVao(shadowVerts, SHADOW_STRIDE, [2, 2, 4, 4]);

      let width = 1;
      let height = 1;
      let scale = 1;
      let L: BoardLayout = boardLayout(1, 1, 1, MAX_COLUMNS);
      let board: Board | null = null;
      let setKey = "";
      let rawTitle = "";
      let title = "";
      const pose = createPose();

      // ---- Panels: four slots counted from the right (0 is the last column), eased between layouts.
      const panelX = new Float64Array(MAX_COLUMNS);
      const panelW = new Float64Array(MAX_COLUMNS);
      const panelA = new Float64Array(MAX_COLUMNS);
      const panelFromX = new Float64Array(MAX_COLUMNS);
      const panelFromW = new Float64Array(MAX_COLUMNS);
      const panelFromA = new Float64Array(MAX_COLUMNS);
      const panelToX = new Float64Array(MAX_COLUMNS);
      const panelToW = new Float64Array(MAX_COLUMNS);
      const panelToA = new Float64Array(MAX_COLUMNS);
      let panelT = 1;

      const targetPanels = (snap: boolean) => {
        for (let r = 0; r < MAX_COLUMNS; r++) {
          const c = L.columns - 1 - r;
          // A column that goes away fades where it is; one that appears fades in at its place.
          panelToX[r] = c >= 0 ? L.colX[c] : panelX[r];
          panelToW[r] = c >= 0 ? L.colW : panelW[r];
          panelToA[r] = c >= 0 ? 1 : 0;
          if (snap) {
            panelA[r] = panelToA[r];
          }
          if (snap || panelA[r] === 0) {
            panelX[r] = panelToX[r];
            panelW[r] = panelToW[r];
          }
          panelFromX[r] = panelX[r];
          panelFromW[r] = panelW[r];
          panelFromA[r] = panelA[r];
        }
        panelT = snap ? 1 : 0;
      };

      const stepPanels = (dt: number) => {
        if (panelT >= 1) {
          return;
        }
        panelT = Math.min(1, panelT + dt / PANEL_SECONDS);
        const f = smoothstep(0, 1, panelT);
        for (let r = 0; r < MAX_COLUMNS; r++) {
          panelX[r] = panelFromX[r] + (panelToX[r] - panelFromX[r]) * f;
          panelW[r] = panelFromW[r] + (panelToW[r] - panelFromW[r]) * f;
          panelA[r] = panelFromA[r] + (panelToA[r] - panelFromA[r]) * f;
        }
      };

      // ---- Text canvas: two header copies (title and column names), then the counts band.
      let titleW = 1;
      /** Room per column name on the canvas: the widest a column gets. */
      let nameW = 1;
      let rowH = 1;
      let countW = 1;
      let countBandY = 0;
      let hdrCur = 0;
      let hdrMix = 1;
      let hdrPainted = false;
      const hdrN = new Int32Array(2);
      const hdrColX = [new Float64Array(MAX_COLUMNS), new Float64Array(MAX_COLUMNS)];
      const hdrTitleX = new Float64Array(2);
      const hdrColW = new Float64Array(2);
      let hdrStyle = "";
      let hdrSet = "";
      let hdrTitle = "";
      let hdrColumns = 0;
      /** Counts per panel slot (from the right): shown, painted, and their tint. */
      const counts = new Int32Array(MAX_COLUMNS).fill(-1);
      const countTint = new Float64Array(MAX_COLUMNS);

      const R = (n: number) => Math.round(n * scale);
      const fill = (
        t: string,
        x: number,
        y: number,
        role: string,
        font: string,
        maxWidth: number,
        align: CanvasTextAlign = "left",
      ) => {
        const ctx = text.ctx;
        if (!ctx || !(maxWidth > 0) || t.length === 0) {
          return;
        }
        ctx.font = font;
        ctx.fillStyle = role;
        ctx.textAlign = align;
        ctx.textBaseline = "middle";
        ctx.fillText(t, Math.round(x), Math.round(y), maxWidth);
      };

      const headerFonts = (sticky: boolean) => {
        const stack = sticky ? HAND_FONT_STACK : SANS_FONT_STACK;
        const px = (n: number) => String(Math.max(4, R(n))) + "px ";
        return {
          title: (sticky ? "400 " + px(28) : "600 " + px(22)) + stack,
          column: (sticky ? "400 " + px(19) : "600 " + px(15)) + stack,
          count: "600 " + px(13) + SANS_FONT_STACK,
        };
      };

      const sizeText = () => {
        titleW = Math.max(1, Math.min(R(TITLE_W), Math.round(width * 0.5)));
        rowH = Math.max(L.titleH, L.headerH, 1);
        countW = Math.max(1, R(COUNT_W));
        countBandY = 2 * rowH;
        nameW = Math.max(1, R(COLUMN_W));
        text.resize(
          Math.max(titleW + MAX_COLUMNS * nameW, 2 * MAX_COLUMNS * countW),
          countBandY + L.headerH,
        );
        hdrPainted = false;
        counts.fill(-1);
      };

      /** Paints header copy `copy`: the title and the column names for the current layout. */
      const paintHeader = (copy: number, names: readonly string[], sticky: boolean) => {
        const f = headerFonts(sticky);
        const y = copy * rowH;
        text.clear(0, y, text.width, rowH);
        fill(title, 0, y + L.titleH / 2, TEXT_ROLES.primary, f.title, titleW);
        const first = names.length - L.columns;
        for (let c = 0; c < L.columns; c++) {
          fill(
            names[first + c] ?? "",
            titleW + c * nameW + R(12),
            y + L.headerH / 2,
            TEXT_ROLES.primary,
            f.column,
            L.colW - R(12) - countW - R(16),
          );
          hdrColX[copy][c] = L.colX[c];
        }
        hdrN[copy] = L.columns;
        hdrColW[copy] = L.colW;
        hdrTitleX[copy] = L.colX[0];
      };

      const paintCount = (r: number, n: number, sticky: boolean) => {
        counts[r] = n;
        const f = headerFonts(sticky);
        const x = 2 * r * countW;
        const y = countBandY;
        text.clear(x, y, 2 * countW, L.headerH);
        const s = String(n);
        fill(s, x + countW / 2, y + L.headerH / 2, TEXT_ROLES.muted, f.count, countW, "center");
        fill(s, x + 1.5 * countW, y + L.headerH / 2, TEXT_ROLES.up, f.count, countW, "center");
      };

      // ---- Card atlases: the current look and, while crossfading, the previous one.
      let cur = 0;
      let mixT = 1;
      const atlasLook = new Int32Array([-1, -1]);
      const slotId = [new Int32Array(MAX_CARDS).fill(-1), new Int32Array(MAX_CARDS).fill(-1)];
      const slotVer = [new Int32Array(MAX_CARDS), new Int32Array(MAX_CARDS)];
      /** The board each atlas's slots were painted from (a new board reuses ids and slots). */
      const atlasBoard: (Board | null)[] = [null, null];
      let slotW = 1;
      let slotH = 1;
      let perRow = 1;
      /** The card width and height the atlases are painted at. */
      let atlasCardW = -1;
      let atlasSlotH = -1;

      const slotX = (slot: number) => (slot % perRow) * slotW;
      const slotY = (slot: number) => Math.floor(slot / perRow) * slotH;

      const sizeAtlas = (a: number) => {
        atlases[a].resize(perRow * slotW, Math.ceil(MAX_CARDS / perRow) * slotH);
        slotId[a].fill(-1);
      };

      /** Paints `card` into atlas `a` in look `look`. */
      const paintCard = (a: number, look: number, card: Card, seed: number) => {
        const atlas = atlases[a];
        const ctx = atlas.ctx;
        slotId[a][card.slot] = card.id;
        slotVer[a][card.slot] = card.version;
        if (!ctx) {
          return;
        }
        const ox = slotX(card.slot);
        const oy = slotY(card.slot);
        atlas.clear(ox, oy, slotW, slotH);
        const cl = CARD_LOOKS[look] ?? CARD_LOOKS[0];
        const sticky = cl.notes !== null;
        const cs = L.s * L.k;
        const f = cardFonts(cs, sticky);
        const x0 = ox + ATLAS_PAD;
        const y0 = oy + ATLAS_PAD;
        const w = L.cardW;
        const h = cardHeight(L, card.lines.length);
        const pad = Math.round(CARD_PAD * cs);
        // Body.
        ctx.beginPath();
        if (cl.notes) {
          ctx.fillStyle = cl.notes[Math.floor(cardHash(seed, card.id, 1) * cl.notes.length)];
          ctx.roundRect(x0, y0, w, h, Math.max(1, NOTE_RADIUS * cs));
          ctx.fill();
          // A strip of tape across the top.
          ctx.fillStyle = cl.tape;
          const tw = Math.round(w * 0.28);
          ctx.fillRect(Math.round(x0 + (w - tw) / 2), y0, tw, Math.max(2, Math.round(9 * cs)));
        } else {
          ctx.fillStyle = cl.border;
          ctx.roundRect(x0, y0, w, h, CARD_RADIUS * cs);
          ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = cl.bg;
          const one = Math.max(1, Math.round(L.s));
          ctx.roundRect(
            x0 + one,
            y0 + one,
            Math.max(0, w - 2 * one),
            Math.max(0, h - 2 * one),
            Math.max(0, CARD_RADIUS * cs - one),
          );
          ctx.fill();
        }
        // Label chips.
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        let x = x0 + pad;
        const chipH = Math.round(CARD_CHIP_H * cs);
        const cy = y0 + pad + chipH / 2;
        ctx.font = f.chip;
        for (const li of card.labels) {
          const label = LABELS[li];
          const tw = textWidth(ctx, label.name, 11 * cs);
          const cw = Math.round(tw + 16 * cs);
          if (x + cw > x0 + w - pad) {
            break;
          }
          ctx.beginPath();
          if (sticky) {
            ctx.fillStyle = label.color;
            ctx.arc(x + 4 * cs, cy, 4 * cs, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = cl.muted;
            ctx.fillText(label.name, Math.round(x + 12 * cs), Math.round(cy));
            x += Math.round(tw + 24 * cs);
          } else {
            ctx.fillStyle = label.color;
            ctx.roundRect(x, y0 + pad, cw, chipH, chipH / 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.fillText(label.name, Math.round(x + 8 * cs), Math.round(cy));
            x += cw + Math.round(6 * cs);
          }
        }
        // Title.
        ctx.font = f.title;
        ctx.fillStyle = cl.text;
        const lineH = CARD_LINE_H * cs;
        const ty = y0 + pad + chipH + CARD_SPACING * cs;
        card.lines.forEach((line, i) => {
          ctx.fillText(line, x0 + pad, Math.round(ty + (i + 0.5) * lineH), w - 2 * pad);
        });
        // Footer: checklist and due date on the left, the assignee on the right.
        const fy = Math.round(y0 + h - pad - (CARD_FOOTER_H * cs) / 2);
        const rad = (CARD_FOOTER_H * cs) / 2;
        const ax = x0 + w - pad - rad;
        ctx.beginPath();
        ctx.fillStyle = PERSON_COLORS[card.person % PERSON_COLORS.length];
        ctx.arc(ax, fy, rad, 0, 2 * Math.PI);
        ctx.fill();
        ctx.font = f.initials;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.fillText(PEOPLE[card.person], Math.round(ax), fy, 2 * rad);
        ctx.textAlign = "left";
        ctx.font = f.small;
        x = x0 + pad;
        if (card.checkTotal > 0) {
          const box = Math.round(11 * cs);
          const complete = card.checkDone >= card.checkTotal;
          const lw = Math.max(1, cs * 1.4);
          ctx.lineWidth = lw;
          ctx.strokeStyle = complete ? cl.done : cl.muted;
          ctx.beginPath();
          ctx.roundRect(
            x + lw / 2,
            fy - box / 2 + lw / 2,
            Math.max(0, box - lw),
            Math.max(0, box - lw),
            Math.max(0, Math.min(2 * cs, (box - lw) / 2)),
          );
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + box * 0.25, fy);
          ctx.lineTo(x + box * 0.45, fy + box * 0.2);
          ctx.lineTo(x + box * 0.78, fy - box * 0.22);
          ctx.stroke();
          ctx.fillStyle = complete ? cl.done : cl.muted;
          const s = String(card.checkDone) + "/" + String(card.checkTotal);
          ctx.fillText(s, Math.round(x + box + 5 * cs), fy);
          x += box + 5 * cs + textWidth(ctx, s, 12 * cs) + 12 * cs;
        }
        if (card.due !== "" && x < ax - rad - 40 * cs) {
          ctx.fillStyle = cl.muted;
          ctx.fillText(card.due, Math.round(x), fy, ax - rad - x - 6 * cs);
        }
      };

      /** Repaints every live card into atlas `a` (in its look) that it doesn't show as it is now. */
      const syncAtlas = (a: number, b: Board) => {
        const look = atlasLook[a];
        if (look < 0) {
          return;
        }
        if (atlasBoard[a] !== b) {
          atlasBoard[a] = b;
          slotId[a].fill(-1);
        }
        for (const card of b.cards) {
          if (slotId[a][card.slot] !== card.id || slotVer[a][card.slot] !== card.version) {
            paintCard(a, look, card, b.seed);
          }
        }
      };

      /** Lays out for the current size and column set: everything snaps. */
      const relayout = (setColumns: number) => {
        L = boardLayout(width, height, scale, setColumns);
        if (board) {
          applyLayout(board, L, true);
        }
        targetPanels(true);
        sizeText();
        hdrMix = 1;
      };

      /** Sizes the atlases for the layout's cards; a new card size repaints from scratch. */
      const fitAtlas = () => {
        const sh = cardHeight(L, 2) + 2 * ATLAS_PAD;
        if (L.cardW === atlasCardW && sh === atlasSlotH) {
          return;
        }
        atlasCardW = L.cardW;
        atlasSlotH = sh;
        slotW = L.cardW + 2 * ATLAS_PAD;
        slotH = sh;
        perRow = Math.max(1, Math.min(MAX_CARDS, Math.floor(ATLAS_MAX_W / slotW)));
        sizeAtlas(cur);
        atlases[1 - cur].release();
        atlasLook[1 - cur] = -1;
        slotId[1 - cur].fill(-1);
        mixT = 1;
      };

      // ---- Per-frame geometry.

      const shadowPut = (
        o: number,
        x: number,
        y: number,
        lx: number,
        ly: number,
        hw: number,
        hh: number,
        rad: number,
        blur: number,
        c: ArrayLike<number>,
        a: number,
      ) => {
        const d = shadowVerts;
        d[o] = x;
        d[o + 1] = y;
        d[o + 2] = lx;
        d[o + 3] = ly;
        d[o + 4] = hw;
        d[o + 5] = hh;
        d[o + 6] = rad;
        d[o + 7] = blur;
        d[o + 8] = c[0] * a;
        d[o + 9] = c[1] * a;
        d[o + 10] = c[2] * a;
        d[o + 11] = a;
      };

      /** Writes a soft rounded-rect quad (centre, half size, rotation cos/sin) at shadow vertex `n`. */
      const shadowQuad = (
        n: number,
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        cos: number,
        sin: number,
        rad: number,
        blur: number,
        c: ArrayLike<number>,
        a: number,
      ) => {
        const ex = hw + 2 * blur;
        const ey = hh + 2 * blur;
        for (let i = 0; i < 6; i++) {
          // Two triangles: corners 0 1 2, 1 3 2 of the (-1, -1) .. (1, 1) square.
          const k = i < 3 ? i : i === 3 ? 1 : i === 4 ? 3 : 2;
          const sx = k & 1 ? 1 : -1;
          const sy = k & 2 ? 1 : -1;
          const lx = sx * ex;
          const ly = sy * ey;
          shadowPut(
            (n + i) * SHADOW_STRIDE,
            cx + lx * cos - ly * sin,
            cy + lx * sin + ly * cos,
            lx,
            ly,
            hw,
            hh,
            rad,
            blur,
            c,
            a,
          );
        }
      };

      /** Writes card `card`'s textured quad at card vertex `n`. */
      const cardQuad = (
        n: number,
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        cos: number,
        sin: number,
        slot: number,
        h: number,
        a: number,
      ) => {
        const sx0 = slotX(slot);
        const sy0 = slotY(slot);
        const sw = L.cardW + 2 * ATLAS_PAD;
        const shh = h + 2 * ATLAS_PAD;
        for (let i = 0; i < 6; i++) {
          const k = i < 3 ? i : i === 3 ? 1 : i === 4 ? 3 : 2;
          const ux = k & 1 ? 1 : 0;
          const uy = k & 2 ? 1 : 0;
          const lx = (ux * 2 - 1) * hw;
          const ly = (uy * 2 - 1) * hh;
          const o = (n + i) * CARD_STRIDE;
          cardVerts[o] = cx + lx * cos - ly * sin;
          cardVerts[o + 1] = cy + lx * sin + ly * cos;
          cardVerts[o + 2] = sx0 + ux * sw;
          cardVerts[o + 3] = sy0 + uy * shh;
          cardVerts[o + 4] = a;
        }
      };

      /** Card and shadow vertices: the resting cards, then the lifted ones on top. */
      let restCards = 0;
      let liftCards = 0;
      let restShadows = 0;
      let liftShadows = 0;

      const buildCards = (b: Board, ca: number) => {
        const sticky = v[STICKY];
        const cs = L.s * L.k;
        const rad = (CARD_RADIUS + (NOTE_RADIUS - CARD_RADIUS) * sticky) * cs;
        const now = b.time;
        let cards = 0;
        let shadows = 0;
        for (let pass = 0; pass < 2; pass++) {
          for (const card of b.cards) {
            cardPose(card, now, pose);
            if (pose.lift > 0 !== (pass === 1) || !(pose.alpha * ca > 0)) {
              continue;
            }
            const a = pose.alpha * ca;
            const h = cardHeight(L, card.lines.length);
            const sc = 1 + LIFT_SCALE * pose.lift;
            const tilt =
              sticky * NOTE_TILT * (2 * cardHash(b.seed, card.id, 2) - 1) +
              pose.lift * LIFT_TILT * (card.id % 2 === 0 ? 1 : -1);
            const cos = Math.cos(tilt) * sc;
            const sin = Math.sin(tilt) * sc;
            const cx = pose.x + L.cardW / 2;
            const cy = pose.y + h / 2;
            const hw = L.cardW / 2;
            const hh = h / 2;
            // The shadow grows and drops as the card lifts.
            const off = (1.5 + 9 * pose.lift) * cs;
            const blur = (2.5 + 7 * pose.lift) * cs;
            shadowQuad(
              shadows,
              cx,
              cy + off,
              hw * sc,
              hh * sc,
              Math.cos(tilt),
              Math.sin(tilt),
              rad * sc,
              blur,
              col[SHADOW],
              a * v[SHADOW_A] * (1 + 0.4 * pose.lift),
            );
            shadows += 6;
            const tint = 1 - smoothstep(0, 1, (now - card.tint) / TINT_SECONDS);
            if (tint > 0) {
              shadowQuad(
                shadows,
                cx,
                cy,
                hw * sc + 2 * cs,
                hh * sc + 2 * cs,
                Math.cos(tilt),
                Math.sin(tilt),
                rad * sc + 2 * cs,
                4 * cs,
                col[ACCENT],
                0.6 * tint * a,
              );
              shadows += 6;
            }
            cardQuad(cards, cx, cy, hw + ATLAS_PAD, hh + ATLAS_PAD, cos, sin, card.slot, h, a);
            cards += 6;
          }
          if (pass === 0) {
            restCards = cards;
            restShadows = shadows;
          }
        }
        liftCards = cards - restCards;
        liftShadows = shadows - restShadows;
      };

      const drawShadows = (first: number, count: number) => {
        if (count <= 0) {
          return;
        }
        gl.useProgram(shadowProgram);
        su.f2("uResolution", width, height);
        gl.bindVertexArray(shadowVao.vao);
        gl.drawArrays(gl.TRIANGLES, first, count);
        gl.bindVertexArray(null);
      };

      const drawCards = (first: number, count: number) => {
        if (count <= 0 || !atlases[cur].ready) {
          return;
        }
        gl.useProgram(cardProgram);
        cu.f2("uResolution", width, height);
        cu.f2("uTexSize", atlases[cur].width, atlases[cur].height);
        cu.i1("uPrev", 1);
        cu.i1("uCur", 0);
        cu.f1("uMix", smoothstep(0, 1, mixT));
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, atlases[1 - cur].texture);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, atlases[cur].texture);
        gl.bindVertexArray(cardVao.vao);
        gl.drawArrays(gl.TRIANGLES, first, count);
        gl.bindVertexArray(null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };

      const drawBoard = () => {
        const one = Math.max(1, R(1));
        // Title bar, with a filter pill and a stack of avatars on the right.
        pushRect(mesh, 0, 0, width, L.titleH, col[CHROME], 1);
        pushRect(mesh, 0, L.titleH - one, width, L.titleH, col[BORDER], 1);
        const right = width - L.colX[0];
        const ar = R(14);
        const cy = L.titleH / 2;
        for (let i = AVATARS - 1; i >= 0; i--) {
          const x = right - ar - i * R(22);
          pushRoundRect(
            mesh,
            x - ar - one,
            cy - ar - one,
            x + ar + one,
            cy + ar + one,
            ar + one,
            col[CHROME],
            1,
          );
          pushRoundRect(mesh, x - ar, cy - ar, x + ar, cy + ar, ar, col[AVATAR + i], 1);
        }
        const pillR = right - ar * 2 - (AVATARS - 1) * R(22) - R(20);
        if (pillR - R(200) > L.colX[0] + titleW) {
          pushRoundRect(mesh, pillR - R(90), cy - R(14), pillR, cy + R(14), R(14), col[PILL], 1);
          pushRoundRect(
            mesh,
            pillR - R(196),
            cy - R(14),
            pillR - R(102),
            cy + R(14),
            R(14),
            col[PILL],
            0.6,
          );
        }
        // Column panels and their count pills.
        const pa = v[PANEL_A];
        for (let r = 0; r < MAX_COLUMNS; r++) {
          const a = panelA[r];
          if (!(a > 0)) {
            continue;
          }
          const x0 = panelX[r];
          const x1 = x0 + panelW[r];
          pushRoundRect(mesh, x0, L.headerTop, x1, L.panelBottom, R(10), col[PANEL], pa * a);
          pushRect(
            mesh,
            x0 + R(10),
            L.headerTop + L.headerH - one,
            x1 - R(10),
            L.headerTop + L.headerH,
            col[BORDER],
            v[STICKY] * 0.8 * a,
          );
          const ph = R(22);
          const py = L.headerTop + (L.headerH - ph) / 2;
          pushRoundRect(mesh, x1 - R(10) - countW, py, x1 - R(10), py + ph, ph / 2, col[PILL], a);
        }
      };

      const queueText = () => {
        // Header copies: the current one, and the previous while it fades.
        const f = smoothstep(0, 1, hdrMix);
        for (let copy = 0; copy < 2; copy++) {
          const a = copy === hdrCur ? f : 1 - f;
          if (!(a > 0)) {
            continue;
          }
          const y = copy * rowH;
          text.quad(0, y, titleW, L.titleH, hdrTitleX[copy], 0, titleW, L.titleH, a);
          for (let c = 0; c < hdrN[copy]; c++) {
            const sx = titleW + c * nameW;
            const w = hdrColW[copy];
            text.quad(sx, y, w, L.headerH, hdrColX[copy][c], L.headerTop, w, L.headerH, a);
          }
        }
        for (let r = 0; r < MAX_COLUMNS; r++) {
          const a = panelA[r];
          if (!(a > 0) || counts[r] < 0) {
            continue;
          }
          const tint = 1 - smoothstep(0, 1, countTint[r] / TINT_SECONDS);
          const x = panelX[r] + panelW[r] - R(10) - countW;
          const sx = 2 * r * countW;
          const h = L.headerH;
          text.quad(sx, countBandY, countW, h, x, L.headerTop, countW, h, a * (1 - tint));
          text.quad(sx + countW, countBandY, countW, h, x, L.headerTop, countW, h, a * tint);
        }
      };

      /** Board swap: 1 fading out, 2 fading in. */
      let swapPhase = 0;
      let swapT = 0;

      return {
        resize(vp) {
          width = Math.max(1, Math.round(vp.width));
          height = Math.max(1, Math.round(vp.height));
          scale = vp.scale > 0 ? vp.scale : height / 1080;
          if (board) {
            relayout((COLUMN_SETS[setKey] ?? COLUMN_SETS.classic).length);
            fitAtlas();
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const pace = clamp(p.pace, MIN_PACE, MAX_PACE);
          const sticky = p.style === "sticky";
          const look = (p.theme === "dark" ? 1 : 0) + (sticky ? 2 : 0);
          const names = COLUMN_SETS[p.columns] ?? COLUMN_SETS.classic;
          if (p.title !== rawTitle) {
            // Allocates: the sanitised title, once per edit.
            rawTitle = p.title;
            title = sanitizeText(kanbanMeta.params.title, p.title).trim();
          }

          let b = board;
          if (!b) {
            // Allocates: the first board and its layout.
            setKey = p.columns;
            L = boardLayout(width, height, scale, names.length);
            b = createBoard(p.seed, L, pace);
            board = b;
            targetPanels(true);
            sizeText();
            fitAtlas();
            atlasLook[cur] = look;
            ease.snap();
          }

          // A new column set relabels the headers; a different number of columns reflows the cards.
          if (p.columns !== setKey) {
            // Allocates: the new layout, once per change.
            setKey = p.columns;
            const next = boardLayout(width, height, scale, names.length);
            if (next.columns !== L.columns) {
              L = next;
              applyLayout(b, L, false);
              targetPanels(false);
              fitAtlas();
            }
          }

          // A new variation fades the cards out and a fresh board in.
          if (swapPhase === 0 && b.seed !== p.seed) {
            swapPhase = 1;
            swapT = 0;
          }
          if (swapPhase === 1) {
            swapT = Math.min(1, swapT + step / SWAP_HALF);
            if (swapT >= 1) {
              // Allocates: the new board, once per change.
              b = createBoard(p.seed, L, pace);
              board = b;
              swapPhase = 2;
              swapT = 0;
            }
          } else if (swapPhase === 2) {
            swapT = Math.min(1, swapT + step / SWAP_HALF);
            if (swapT >= 1) {
              swapPhase = 0;
            }
          }
          const ca =
            swapPhase === 1
              ? 1 - smoothstep(0, 1, swapT)
              : swapPhase === 2
                ? smoothstep(0, 1, swapT)
                : 1;
          if (swapPhase !== 1) {
            stepBoard(b, step, pace);
          }

          // Colours, and the card atlases' crossfade to a new look.
          ease.step(LOOKS[look], step, LOOK_EASE);
          for (let k = 0; k < 3; k++) {
            textPalette[k] = col[TEXT][k];
            textPalette[3 + k] = col[MUTED][k];
            textPalette[6 + k] = col[ACCENT][k];
            textPalette[9 + k] = col[TEXT][k];
            textPalette[12 + k] = col[BG][k];
          }
          if (look !== atlasLook[cur]) {
            if (mixT < 1 && look === atlasLook[1 - cur]) {
              // Back to the look still fading out: turn the fade around.
              cur = 1 - cur;
              mixT = 1 - mixT;
            } else {
              cur = 1 - cur;
              mixT = 0;
              sizeAtlas(cur);
              atlasLook[cur] = look;
            }
          }
          if (mixT < 1) {
            mixT = Math.min(1, mixT + step / LOOK_EASE);
            if (mixT >= 1) {
              atlases[1 - cur].release();
              atlasLook[1 - cur] = -1;
              slotId[1 - cur].fill(-1);
            }
          }
          syncAtlas(cur, b);
          if (mixT < 1) {
            syncAtlas(1 - cur, b);
          }

          // Headers: a new title, column set, style or column count crossfades to a fresh copy.
          if (
            !hdrPainted ||
            title !== hdrTitle ||
            p.columns !== hdrSet ||
            p.style !== hdrStyle ||
            L.columns !== hdrColumns
          ) {
            const fade = hdrPainted;
            hdrTitle = title;
            hdrSet = p.columns;
            hdrStyle = p.style;
            hdrColumns = L.columns;
            if (fade) {
              hdrCur = 1 - hdrCur;
              hdrMix = 0;
            } else {
              hdrMix = 1;
            }
            paintHeader(hdrCur, names, sticky);
            hdrPainted = true;
            counts.fill(-1);
          }
          hdrMix = approach(hdrMix, 1, step / HEADER_FADE);
          for (let r = 0; r < MAX_COLUMNS; r++) {
            const c = L.columns - 1 - r;
            countTint[r] = Math.min(TINT_SECONDS, countTint[r] + step);
            if (c >= 0 && c < b.cols.length && b.cols[c].length !== counts[r]) {
              if (counts[r] >= 0) {
                countTint[r] = 0;
              } else {
                countTint[r] = TINT_SECONDS;
              }
              paintCount(r, b.cols[c].length, sticky);
            }
          }
          stepPanels(step);
          text.flush();
          atlases[0].flush();
          atlases[1].flush();

          // Geometry.
          mesh.count = 0;
          drawBoard();
          chart.upload();
          buildCards(b, ca);
          if (restShadows + liftShadows > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, shadowVao.buffer);
            gl.bufferSubData(
              gl.ARRAY_BUFFER,
              0,
              shadowVerts,
              0,
              (restShadows + liftShadows) * SHADOW_STRIDE,
            );
          }
          if (restCards + liftCards > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, cardVao.buffer);
            gl.bufferSubData(
              gl.ARRAY_BUFFER,
              0,
              cardVerts,
              0,
              (restCards + liftCards) * CARD_STRIDE,
            );
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, null);

          // Draw: background, board, labels, resting cards, then the carried card on top.
          if (v[CORK] > 0.001) {
            gl.useProgram(corkProgram);
            ku.v3("uBase", col[BG]);
            ku.f1("uAmount", v[CORK]);
            ku.f1("uScale", scale);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, noise);
            triangle.draw();
            gl.bindTexture(gl.TEXTURE_2D, null);
          } else {
            gl.clearColor(col[BG][0], col[BG][1], col[BG][2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          chart.draw(width, height, 0, mesh.count);
          queueText();
          text.draw(width, height, textPalette);
          drawShadows(0, restShadows);
          drawCards(0, restCards);
          drawShadows(restShadows, liftShadows);
          drawCards(restCards, liftCards);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
