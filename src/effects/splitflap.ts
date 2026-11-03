import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  resetUnpackState,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { clamp } from "./math";
import {
  boardLayout,
  boardLine,
  createBoard,
  createLayout,
  createMinuteClock,
  flapAngle,
  GLYPH_COUNT,
  GLYPHS,
  nextGlyph,
  resetCells,
  setTargets,
  stepBoard,
  textPages,
  tickClock,
} from "./splitflap-sim";
import { BOARD_COLS, MAX_ROWS, splitflapMeta, type SplitflapStyle } from "./splitflap.meta";
import { createSpriteBatch } from "./sprites";
import { defineEffect } from "./types";

/** Glyph tiles per row of the atlas. */
const ATLAS_COLS = 8;
/** Blank texels around each atlas tile, so linear filtering never reads a neighbour. */
const ATLAS_PAD = 2;
/** A system font stack for the glyphs: a bold grotesque, as on real boards. */
const FONT_FAMILY = `"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif`;
/** Cap height as a fraction of the cell height, and the widest a glyph may be. */
const CAP_FRACTION = 0.56;
const MAX_GLYPH_WIDTH = 0.82;
/** Housing corner radius, in cell heights. */
const HOUSING_RADIUS = 0.14;
/** Card corner radius and split gap half-width, in reference (1080p) px. */
const CARD_RADIUS = 2.5;
const SPLIT_HALF = 0.9;

interface Palette {
  ink: string;
  card: string;
  housing: string;
  wallTop: string;
  wallBottom: string;
}

const PALETTES: Record<string, Palette> & Record<SplitflapStyle, Palette> = {
  station: {
    ink: "#f2efe6",
    card: "#17181a",
    housing: "#2a2c30",
    wallTop: "#3b4149",
    wallBottom: "#15181c",
  },
  airport: {
    ink: "#ffc62b",
    card: "#121212",
    housing: "#1e1f22",
    wallTop: "#2f3642",
    wallBottom: "#111418",
  },
  retro: {
    ink: "#eee0bd",
    card: "#2a2521",
    housing: "#4b3a2b",
    wallTop: "#4b4139",
    wallBottom: "#1b1613",
  },
};

/**
 * The wall and the board's housing: a dark gradient wall with a vignette, a soft
 * shadow under the board, and the housing with a bevelled rim and a darker
 * recess behind the cells. ALU only.
 */
const HOUSING_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** One device px in height units. */
uniform float uPx;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** Housing left, top, right, bottom (height units, y down). */
uniform vec4 uHousing;
/** Housing corner radius and the recess's inset (height units). */
uniform vec2 uRadius;
uniform vec3 uWallTop;
uniform vec3 uWallBottom;
uniform vec3 uHousingCol;
out vec4 outColor;
${DITHER_GLSL}
float sdBox(vec2 p, vec2 c, vec2 h, float r) {
  vec2 q = abs(p - c) - h + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec2 p = vec2(gl_FragCoord.x * uPx, 1.0 - gl_FragCoord.y * uPx);
  vec2 c = 0.5 * (uHousing.xy + uHousing.zw);
  vec2 h = 0.5 * (uHousing.zw - uHousing.xy);
  vec3 col = mix(uWallTop, uWallBottom, smoothstep(0.0, 1.0, p.y));
  vec2 v = p / uFrame - vec2(0.5, 0.35);
  col *= 1.0 - 0.45 * dot(v, v);
  // A soft shadow cast down the wall.
  float sh = 1.0 - smoothstep(-0.01, 0.07, sdBox(p - vec2(0.0, 0.025), c, h, uRadius.x));
  col *= 1.0 - 0.55 * sh;
  float d = sdBox(p, c, h, uRadius.x);
  float a = clamp(0.5 - d / uPx, 0.0, 1.0);
  if (a > 0.0) {
    // Lit from above: lighter at the top, a bright upper rim and a dark lower one.
    float t = (p.y - uHousing.y) / max(uHousing.w - uHousing.y, 1e-4);
    vec3 hc = uHousingCol * mix(1.15, 0.85, t);
    float rim = smoothstep(-0.008, -0.001, d);
    hc *= 1.0 + rim * (p.y < c.y ? 0.45 : -0.35);
    float recess = sdBox(p, c, h - uRadius.y, uRadius.x * 0.5);
    hc *= mix(0.6, 1.0, smoothstep(-uPx, uPx, recess));
    col = mix(col, hc, a);
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** One instance per cell; pixel coordinates are y-down. */
const CELL_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Column, row, current glyph, next glyph. */
layout(location = 1) in vec4 aCell;
/** Flap angle (radians). */
layout(location = 2) in float aAngle;
uniform vec2 uResolution;
/** First cell's top-left, the pitch between cells and the cell size (px). */
uniform vec2 uOrigin;
uniform vec2 uPitch;
uniform vec2 uCellSize;
/** Across 0..1, and up 0..1 from the cell's bottom edge. */
out vec2 vLocal;
flat out vec3 vGlyph;
${TO_CLIP_GLSL}
void main() {
  vec2 c = aCorner * 0.5 + 0.5;
  vec2 px = uOrigin + aCell.xy * uPitch + c * uCellSize;
  vLocal = vec2(c.x, 1.0 - c.y);
  vGlyph = vec3(aCell.zw, aAngle);
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * A cell: the static upper half (the next glyph), the static lower half (the
 * current glyph) and the moving flap, which is the current glyph's upper half
 * folding down to the hinge (angle 0 to π/2), then the next glyph's lower half
 * falling into place (π/2 to π), foreshortened by the cosine of its angle. The
 * flap darkens as it turns edge-on and shades the half it passes over. Output is
 * premultiplied for the card's rounded corners.
 */
const CELL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec3 vGlyph;
uniform sampler2D uAtlas;
/** Tile pitch, pad and glyph area as fractions of the atlas. */
uniform vec2 uTile;
uniform vec2 uPad;
uniform vec2 uGlyphSize;
/** Cell size (px), card corner radius (px) and the split's half-width (px). */
uniform vec2 uCellPx;
uniform vec2 uCard;
uniform vec3 uInk;
uniform vec3 uCardCol;
out vec4 outColor;
float glyphAt(float g, vec2 uv) {
  vec2 tile = vec2(mod(g, ${ATLAS_COLS}.0), floor(g / ${ATLAS_COLS}.0));
  return texture(uAtlas, tile * uTile + uPad + vec2(uv.x, 1.0 - uv.y) * uGlyphSize).r;
}
void main() {
  vec2 uv = vLocal;
  float th = vGlyph.z;
  float c = cos(th);
  float s = sin(th);
  float y = uv.y - 0.5;
  float g;
  float shade;
  if (y >= 0.0) {
    if (y < 0.5 * c) {
      g = glyphAt(vGlyph.x, vec2(uv.x, 0.5 + y / max(c, 1e-4)));
      shade = 1.0 - 0.35 * s;
    } else {
      g = glyphAt(vGlyph.y, uv);
      shade = 1.0 - 0.4 * max(c, 0.0) * step(1e-4, th);
    }
  } else {
    if (-y < -0.5 * c) {
      g = glyphAt(vGlyph.y, vec2(uv.x, 0.5 + y / max(-c, 1e-4)));
      shade = 1.0 - 0.5 * s;
    } else {
      g = glyphAt(vGlyph.x, uv);
      shade = 1.0 - (c < 0.0 ? 0.4 : 0.15) * s;
    }
  }
  // Upper halves catch the light from above; the split between halves is a dark slit.
  vec3 card = uCardCol * (y >= 0.0 ? 1.15 + 0.2 * y : 0.95 + 0.2 * y);
  vec3 col = mix(card, uInk, g) * shade;
  float slit = smoothstep(uCard.y - 0.5, uCard.y + 0.5, abs(y) * uCellPx.y);
  col *= mix(0.15, 1.0, slit);
  vec2 q = abs(uv - 0.5) * uCellPx - 0.5 * uCellPx + uCard.x;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uCard.x;
  float a = clamp(0.5 - d, 0.0, 1.0);
  outColor = vec4(col * a, a);
}
`;

/**
 * A split-flap departures board across the top of the frame. The flaps rest
 * between changes; on a change each cell waits a staggered delay, then flips
 * through the drum in order until it reaches its new glyph (splitflap-sim.ts).
 *
 * Passes: the wall and housing (one full-screen ALU-only pass), then the cells
 * as one instanced draw of a quad per cell, sampling a glyph atlas drawn once per
 * cell size with a system font on an OffscreenCanvas.
 */
export const splitflap = defineEffect(splitflapMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const housingProgram = scope.add(
        createProgram(gl, FULLSCREEN_VERTEX, HOUSING_FRAGMENT),
        (p) => gl.deleteProgram(p),
      );
      const hu = createUniforms(gl, housingProgram, [
        "uPx",
        "uFrame",
        "uHousing",
        "uRadius",
        "uWallTop",
        "uWallBottom",
        "uHousingCol",
      ]);
      const cellProgram = scope.add(createProgram(gl, CELL_VERTEX, CELL_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const cu = createUniforms(gl, cellProgram, [
        "uResolution",
        "uOrigin",
        "uPitch",
        "uCellSize",
        "uAtlas",
        "uTile",
        "uPad",
        "uGlyphSize",
        "uCellPx",
        "uCard",
        "uInk",
        "uCardCol",
      ]);
      const maxCells = BOARD_COLS * MAX_ROWS;
      const batch = scope.own(createSpriteBatch(gl, maxCells, [4, 1]));
      const atlas = scope.add(gl.createTexture(), (t) => gl.deleteTexture(t));

      const board = createBoard(BOARD_COLS, MAX_ROWS);
      const layout = createLayout();
      const clock = createMinuteClock();
      const localMinutes = (ms: number) => {
        const d = new Date(ms);
        return d.getHours() * 60 + d.getMinutes();
      };
      const targets = new Uint8Array(maxCells);
      const blank = new Uint8Array(maxCells);

      let width = 1;
      let height = 1;
      let scale = 1;
      let layoutDirty = true;
      /** Atlas tile content size (px) it was last drawn at; 0 forces a rebuild. */
      let atlasW = 0;
      let atlasH = 0;

      // Content: the text's pages as glyph rows, rebuilt only when a param changes.
      let shownLines: string | undefined;
      let shownRows = 0;
      let shownClock = false;
      let pageGlyphs = new Uint8Array(0);
      let pageCount = 1;
      let textRows = 1;
      let page = 0;
      let still = 0;
      let change = 0;
      /** Whether the cells' instance data must be refilled. */
      let uploadNeeded = true;
      let wasMoving = false;

      /** Draws each glyph white on black into its own padded tile (red = coverage). */
      const buildAtlas = (cw: number, ch: number) => {
        const tileW = cw + 2 * ATLAS_PAD;
        const tileH = ch + 2 * ATLAS_PAD;
        const canvas = new OffscreenCanvas(
          ATLAS_COLS * tileW,
          Math.ceil(GLYPH_COUNT / ATLAS_COLS) * tileH,
        );
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Split-Flap Board: no 2D context for the glyph atlas");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        // Size the font so its capitals are CAP_FRACTION of the cell tall.
        let size = ch * 0.78;
        ctx.font = `bold ${size}px ${FONT_FAMILY}`;
        const capRatio = (ctx.measureText("H")?.actualBoundingBoxAscent || 0.72 * size) / size;
        size = (CAP_FRACTION * ch) / Math.max(0.5, capRatio);
        ctx.font = `bold ${size}px ${FONT_FAMILY}`;
        const cap = capRatio * size;
        Array.from(GLYPHS).forEach((g, i) => {
          if (g === " ") return;
          const x = (i % ATLAS_COLS) * tileW + ATLAS_PAD;
          const y = Math.floor(i / ATLAS_COLS) * tileH + ATLAS_PAD;
          const w = ctx.measureText(g)?.width || 0;
          const squeeze = w > MAX_GLYPH_WIDTH * cw ? (MAX_GLYPH_WIDTH * cw) / w : 1;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cw, ch);
          ctx.clip();
          ctx.translate(x + cw / 2, y + ch / 2 + cap / 2);
          ctx.scale(squeeze, 1);
          ctx.fillText(g, 0, 0);
          ctx.restore();
        });
        gl.bindTexture(gl.TEXTURE_2D, atlas);
        resetUnpackState(gl);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.useProgram(cellProgram);
        cu.f2("uTile", tileW / canvas.width, tileH / canvas.height);
        cu.f2("uPad", ATLAS_PAD / canvas.width, ATLAS_PAD / canvas.height);
        cu.f2("uGlyphSize", cw / canvas.width, ch / canvas.height);
      };

      /** Rebuilds the pages of glyph rows from the text, for `rows` rows. */
      const buildPages = (lines: string, rows: number, withClock: boolean) => {
        textRows = Math.max(1, rows - (withClock ? 1 : 0));
        const pages = textPages(lines, textRows);
        pageCount = pages.length;
        pageGlyphs = new Uint8Array(pageCount * textRows * BOARD_COLS);
        pages.forEach((pageLines, k) => {
          pageLines.forEach((line, r) => {
            boardLine(line, BOARD_COLS, pageGlyphs, (k * textRows + r) * BOARD_COLS);
          });
        });
        page %= pageCount;
      };

      /** Points the board at the current page and clock. */
      const retarget = (rows: number, withClock: boolean) => {
        targets.fill(0);
        let row = 0;
        if (withClock) {
          boardLine(clock.label, BOARD_COLS, targets, 0, "centre");
          row = 1;
        }
        const size = textRows * BOARD_COLS;
        targets.set(pageGlyphs.subarray(page * size, (page + 1) * size), row * BOARD_COLS);
        if (setTargets(board, targets, rows * BOARD_COLS, change)) change++;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          layoutDirty = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const rows = clamp(Math.round(p.rows), 2, MAX_ROWS);
          const count = rows * BOARD_COLS;
          const palette = PALETTES[p.style] ?? PALETTES.station;

          // 1. Content: rebuild on a param change, then follow the clock and the pages.
          let dirty = false;
          if (rows !== shownRows) {
            // A new board size starts blank and flips in.
            resetCells(board, blank, maxCells);
            uploadNeeded = true;
          }
          if (p.lines !== shownLines || rows !== shownRows || p.clock !== shownClock) {
            buildPages(p.lines, rows, p.clock);
            shownLines = p.lines;
            shownRows = rows;
            shownClock = p.clock;
            still = 0;
            dirty = true;
          }
          if (p.clock && tickClock(clock, Date.now(), localMinutes)) dirty = true;
          if (dirty) retarget(rows, p.clock);

          const moving = stepBoard(board, step, count);
          // The step that lands the last cell still changed the data.
          if (moving || wasMoving) uploadNeeded = true;
          wasMoving = moving;
          if (moving) {
            still = 0;
          } else {
            still += step;
            if (pageCount > 1 && still >= p.interval) {
              still = 0;
              page = (page + 1) % pageCount;
              retarget(rows, p.clock);
            }
          }

          // 2. Layout and atlas, on a resize.
          if (layoutDirty) {
            layoutDirty = false;
            boardLayout(width / height, BOARD_COLS, MAX_ROWS, MAX_ROWS, layout);
            const cw = Math.max(4, Math.round(layout.cellW * height));
            const ch = Math.max(4, Math.round(layout.cellH * height));
            if (cw !== atlasW || ch !== atlasH) {
              buildAtlas(cw, ch);
              atlasW = cw;
              atlasH = ch;
            }
          }
          boardLayout(width / height, BOARD_COLS, rows, MAX_ROWS, layout);

          // 3. Wall and housing.
          gl.useProgram(housingProgram);
          hu.f1("uPx", 1 / height);
          hu.f2("uFrame", width / height, 1);
          const hs = layout.housing;
          hu.f4("uHousing", hs[0], hs[1], hs[2], hs[3]);
          hu.f2("uRadius", HOUSING_RADIUS * layout.cellH, 0.6 * (layout.x - hs[0]));
          hu.rgb("uWallTop", palette.wallTop);
          hu.rgb("uWallBottom", palette.wallBottom);
          hu.rgb("uHousingCol", palette.housing);
          triangle.draw();

          // 4. Cells.
          if (uploadNeeded) {
            const data = batch.data;
            const stride = batch.stride;
            for (let i = 0; i < count; i++) {
              const o = i * stride;
              data[o] = i % BOARD_COLS;
              data[o + 1] = Math.floor(i / BOARD_COLS);
              data[o + 2] = board.cur[i];
              data[o + 3] = nextGlyph(board, i);
              data[o + 4] = board.phase[i] > 0 ? flapAngle(board.phase[i]) : 0;
            }
            batch.upload(count);
            uploadNeeded = false;
          }
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(cellProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, atlas);
          cu.i1("uAtlas", 0);
          cu.f2("uResolution", width, height);
          cu.f2("uOrigin", layout.x * height, layout.y * height);
          cu.f2("uPitch", layout.pitchX * height, layout.pitchY * height);
          cu.f2("uCellSize", layout.cellW * height, layout.cellH * height);
          cu.f2("uCellPx", layout.cellW * height, layout.cellH * height);
          cu.f2("uCard", CARD_RADIUS * scale, Math.max(0.5, SPLIT_HALF * scale));
          cu.rgb("uInk", palette.ink);
          cu.rgb("uCardCol", palette.card);
          batch.draw(0, count);
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
