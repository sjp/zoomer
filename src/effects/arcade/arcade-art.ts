/**
 * The Arcade Attract Mode's pixel art, all pure so it can be tested: a made-up
 * 16-colour palette, the sprites (the salvage tug, crates, mines, debris and
 * sparkles) as small grids of palette digits, the 5x7 dot-matrix font as
 * sprites, bevelled blocks for the title logo, everything packed into one
 * RGBA8 atlas, and the logo's layout.
 */
import { GLYPH_H, GLYPH_W, GLYPHS, glyphRows } from "../dot-matrix";
import { packPixelAtlas, type PixelGrid } from "../pixel-atlas";

/** The arcade palette, by digit 0-f: a made-up set of 16 colours. */
export const ARCADE_PALETTE: readonly string[] = [
  "#000000",
  "#1c2040",
  "#3c4270",
  "#7c82aa",
  "#d6dbf0",
  "#ffffff",
  "#ff5050",
  "#ff9a3c",
  "#ffd84a",
  "#6ce05c",
  "#2fbaa6",
  "#4aa8ff",
  "#5a62ff",
  "#b45cff",
  "#ff70c2",
  "#8c5a3a",
];

/** Palette digits the title logo's colour cycles through, in order. */
export const CYCLE: readonly number[] = [6, 7, 8, 9, 10, 11, 12, 13, 14];

/** The tug, facing +x: a cab with a window, an orange stripe and a two-pronged grab at the front. */
const TUG: PixelGrid = [
  "......3333.....",
  "....33444433...",
  "..334bbbb4433..",
  ".2344bbbbb44333",
  "224777777774...",
  "224777777774...",
  ".2344444444333.",
  "..33444444333..",
  "....33333333...",
];

/** The engine's glow, drawn behind the tug while it accelerates. */
const FLAME: PixelGrid = ["778", "7888", "778"];

const CRATE: PixelGrid = [
  "88888888",
  "8f7777f8",
  "87f77f78",
  "877ff778",
  "877ff778",
  "87f77f78",
  "8f7777f8",
  "88888888",
];

const MINE: PixelGrid = [
  "....6....",
  ".6..6..6.",
  "..66666..",
  ".666e666.",
  "6666e5666",
  ".6666e66.",
  "..66666..",
  ".6..6..6.",
  "....6....",
];

const PLATE: PixelGrid = [
  "..33333.....",
  ".3444433....",
  "3444444433..",
  "34444444443.",
  ".3442244443.",
  "..333222333.",
  ".....3333...",
];

const GIRDER: PixelGrid = [
  ".33333333333.",
  "3444444444443",
  "34f222222f243",
  "3444444444443",
  ".33333333333.",
];

const CHUNK: PixelGrid = [
  "...fff...",
  ".ff77ff..",
  "f777777f.",
  "f7f7777ff",
  ".f77777f.",
  "ff7777f..",
  ".ffff7f..",
  "....ff...",
];

const SPARK: PixelGrid = [".5.", "555", ".5."];
const DOT: PixelGrid = ["5"];

/** A copyright sign, wider than the font's glyphs. */
const COPYRIGHT: PixelGrid = [
  "..555..",
  ".5...5.",
  "5..55.5",
  "5.5...5",
  "5..55.5",
  ".5...5.",
  "..555..",
];

/** Largest logo block, px. */
const MAX_BLOCK = 8;

/** A bevelled square block `size` px wide: light top and left, shaded bottom and right. */
function blockGrid(size: number): PixelGrid {
  if (size <= 1) {
    return ["4"];
  }
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = "";
    for (let x = 0; x < size; x++) {
      row += y === size - 1 || x === size - 1 ? "3" : y === 0 || x === 0 ? "5" : "4";
    }
    rows.push(row);
  }
  return rows;
}

/** A glyph of the dot-matrix font as a white sprite. */
function glyphGrid(ch: string): PixelGrid {
  return glyphRows(ch).map((r) => r.replaceAll("#", "5"));
}

/** Cell indices in the atlas. Glyphs follow `CELL.glyph0` in the font's order. */
export const CELL = {
  tug: 0,
  flame: 1,
  crate: 2,
  mine: 3,
  /** The three debris shapes. */
  debris0: 4,
  spark: 7,
  dot: 8,
  copyright: 9,
  /** Blocks of 1 to `MAX_BLOCK` px; block `s` is at `block1 + s - 1`. */
  block1: 10,
  glyph0: 10 + MAX_BLOCK,
} as const;

/** The grids in cell order. */
function atlasGrids(): PixelGrid[] {
  const grids: PixelGrid[] = [TUG, FLAME, CRATE, MINE, PLATE, GIRDER, CHUNK, SPARK, DOT, COPYRIGHT];
  for (let s = 1; s <= MAX_BLOCK; s++) {
    grids.push(blockGrid(s));
  }
  for (const ch of GLYPHS) {
    grids.push(glyphGrid(ch));
  }
  return grids;
}

const ATLAS_WIDTH = 128;
/** Transparent px round each cell, so a rotated sprite never samples its neighbour. */
const PAD = 1;

/** Packs every sprite into one atlas, in rows. */
export const buildAtlas = () => packPixelAtlas(atlasGrids(), ARCADE_PALETTE, ATLAS_WIDTH, PAD);

/** The atlas cell for a character of the font (-1 for a space or one it lacks). */
export function glyphCell(ch: string): number {
  const i = GLYPHS.indexOf(ch.toUpperCase());
  return i <= 0 ? -1 : CELL.glyph0 + i;
}

/** Dot columns a glyph advances (five dots and a gap), and dot rows a logo line advances. */
export const GLYPH_ADVANCE = GLYPH_W + 1;
const LINE_ADVANCE = GLYPH_H + 2;

/** Px a line of `n` characters spans at text scale `scale`. */
export const textWidth = (n: number, scale: number) => Math.max(0, n * GLYPH_ADVANCE - 1) * scale;

/** The title logo: block size and every lit dot, in dots from its top-left. */
export interface LogoLayout {
  /** Block size, px. */
  size: number;
  /** Size in dots. */
  cols: number;
  rows: number;
  /** Lit dots as (column, row) pairs. */
  dots: Int16Array;
  count: number;
}

/** Whether the font can draw any of `text`. */
export const hasGlyphs = (text: string) => Array.from(text).some((ch) => glyphCell(ch) >= 0);

/**
 * Lays the title out in dot-matrix blocks as large as fit in `maxW` x `maxH` px
 * (at most `maxBlock`): on one line, or split at a space onto two when that
 * gives bigger blocks. Each line is centred.
 */
export function layoutLogo(
  title: string,
  maxW: number,
  maxH: number,
  maxBlock = MAX_BLOCK,
): LogoLayout {
  const text = title.trim().toUpperCase();
  const options: string[][] = [[text]];
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    options.push([words.slice(0, i).join(" "), words.slice(i).join(" ")]);
  }
  let best = options[0];
  let bestSize = -1;
  let bestCols = 0;
  for (const lines of options) {
    const chars = Math.max(...lines.map((l) => Array.from(l).length));
    const cols = Math.max(1, chars * GLYPH_ADVANCE - 1);
    const rows = lines.length * LINE_ADVANCE - 2;
    const size = Math.max(1, Math.min(maxBlock, Math.floor(Math.min(maxW / cols, maxH / rows))));
    // Fewer lines win a tie; a wider line wins nothing.
    if (size > bestSize) {
      best = lines;
      bestSize = size;
      bestCols = cols;
    }
  }
  const rows = best.length * LINE_ADVANCE - 2;
  const dots: number[] = [];
  best.forEach((line, li) => {
    const chars = Array.from(line);
    const lineCols = chars.length * GLYPH_ADVANCE - 1;
    const x0 = Math.floor((bestCols - lineCols) / 2);
    chars.forEach((ch, ci) => {
      if (glyphCell(ch) < 0) {
        return;
      }
      glyphRows(ch).forEach((row, ry) => {
        for (let rx = 0; rx < GLYPH_W; rx++) {
          if (row[rx] === "#") {
            dots.push(x0 + ci * GLYPH_ADVANCE + rx, li * LINE_ADVANCE + ry);
          }
        }
      });
    });
  });
  return {
    size: bestSize,
    cols: bestCols,
    rows,
    dots: Int16Array.from(dots),
    count: dots.length / 2,
  };
}
