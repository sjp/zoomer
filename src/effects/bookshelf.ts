/**
 * Out-of-focus bookcases for room backgrounds (Library Window, and any effect that
 * wants a shelf-lined wall): a seeded layout of book spines on a few shelves, baked
 * once into a small mipmapped texture, and a GLSL function that maps the left and
 * right edges of the frame onto it with a little perspective and a mip-level blur.
 *
 * The texture holds both bookcases side by side, the right one mirrored, so their
 * inner edges (both wooden side panels) meet at the seam and the mip chain never
 * bleeds books across it. Rows of texels run bottom to top (v up).
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { createDataTexture, glslFloat, updateDataTexture, type Scope } from "./gl";
import { createRng } from "./noise";

/** Baked texture size: two 256-texel bookcases side by side. */
export const SHELF_TEX_W = 512;
export const SHELF_TEX_H = 512;
/** Shelves per bookcase. */
export const SHELF_ROWS = 5;
/** Plinth top and cornice bottom, as fractions of the bookcase height. */
export const SHELF_PLINTH = 0.05;
export const SHELF_CORNICE = 0.955;
/** Height of one shelf (board plus the space above it), fraction of the height. */
export const SHELF_ROW_H = (SHELF_CORNICE - SHELF_PLINTH) / SHELF_ROWS;
/** Board thickness, fraction of the height. */
export const SHELF_BOARD = 0.022;
/** Where the inner side panel starts, in side units (0 = frame edge, 1 = inner edge). */
export const SHELF_PANEL_U = 0.95;
/** Spine widths, side units (about 15–35 reference px on a 16:9 frame). */
export const SPINE_W = [0.026, 0.062] as const;
/** Book heights, as fractions of the space above the board. */
export const SPINE_TOP = [0.58, 0.9] as const;
/** At most this many gaps between books per shelf. */
const MAX_GAPS = 2;
/** Gap chance after each book, and gap widths (side units). */
const GAP_CHANCE = 0.07;
const GAP_W = [0.03, 0.08] as const;
/** Bookcase width as a fraction of the frame width (never more than a third). */
export const SHELF_SIDE_FRAC = 0.3;
/** Vertical convergence towards the inner edge: 0 is flat-on. */
export const SHELF_PERSP = 0.22;
/** Eye level, fraction of the frame height: shelf lines converge on it. */
export const SHELF_EYE = 0.55;

export interface ShelfPalette {
  /** Shelves, plinth, cornice and side panels. */
  wood: string;
  /** The back of the bookcase, seen between and above the books. */
  back: string;
  /** Book cloth and leather colours; each spine picks one. */
  spines: readonly string[];
}

export interface Spine {
  /** 0 = left bookcase, 1 = right. */
  side: 0 | 1;
  row: number;
  /** Extent in side units, within [0, SHELF_PANEL_U]. */
  x0: number;
  x1: number;
  /** Height as a fraction of the space above the board. */
  top: number;
  /** Index into the palette's `spines`. */
  colour: number;
  /** Brightness multiplier, about 0.75–1.15. */
  tone: number;
  /** Whether the spine has gilt bands near its top and bottom. */
  bands: boolean;
}

/** Bookcase width in the frame's units: a fixed fraction, inside the outer thirds. */
export function shelfSideWidth(frameWidth: number): number {
  return frameWidth * SHELF_SIDE_FRAC;
}

/** Bottom of a row's board, fraction of the bookcase height. */
export function shelfRowBottom(row: number): number {
  return SHELF_PLINTH + row * SHELF_ROW_H;
}

/**
 * Seeded rows of spines for both bookcases. Each shelf is packed from the frame
 * edge to the side panel, with at most `MAX_GAPS` small gaps; a last book that
 * would overrun the panel is trimmed, or left out if the space is too narrow.
 */
export function layoutShelves(seed: number): Spine[] {
  const rng = createRng(seed ^ 0x5b00c);
  const spines: Spine[] = [];
  const colours = 1 << 16;
  for (const side of [0, 1] as const) {
    for (let row = 0; row < SHELF_ROWS; row++) {
      let x = 0;
      let gaps = 0;
      while (x < SHELF_PANEL_U) {
        const w = SPINE_W[0] + (SPINE_W[1] - SPINE_W[0]) * rng() * rng() * 1.4;
        let x1 = x + Math.min(w, SPINE_W[1]);
        if (x1 > SHELF_PANEL_U) {
          if (SHELF_PANEL_U - x < SPINE_W[0] * 0.6) {
            break;
          }
          x1 = SHELF_PANEL_U;
        }
        spines.push({
          side,
          row,
          x0: x,
          x1,
          top: SPINE_TOP[0] + (SPINE_TOP[1] - SPINE_TOP[0]) * rng(),
          colour: Math.floor(rng() * colours),
          tone: 0.75 + 0.4 * rng(),
          bands: rng() < 0.45,
        });
        x = x1;
        if (gaps < MAX_GAPS && rng() < GAP_CHANCE) {
          x += GAP_W[0] + (GAP_W[1] - GAP_W[0]) * rng();
          gaps++;
        }
      }
    }
  }
  return spines;
}

/** Fraction of each shelf's span [0, SHELF_PANEL_U] covered by books, per side and row. */
export function shelfCoverage(spines: readonly Spine[]): number[] {
  const out = Array.from({ length: 2 * SHELF_ROWS }, () => 0);
  for (const s of spines) {
    out[s.side * SHELF_ROWS + s.row] += (s.x1 - s.x0) / SHELF_PANEL_U;
  }
  return out;
}

const toByte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Paints the layout into RGBA8 texels (`SHELF_TEX_W` x `SHELF_TEX_H`, row 0 at
 * the bottom): wooden plinth, cornice, boards and inner panels, a shadowed back,
 * and the spines with round shading and the odd gilt band. Alpha is 255.
 */
export function bakeShelves(
  spines: readonly Spine[],
  palette: ShelfPalette,
  out = new Uint8Array(SHELF_TEX_W * SHELF_TEX_H * 4),
): Uint8Array {
  const wood = hexToUnitRgb(palette.wood);
  const back = hexToUnitRgb(palette.back);
  const cloth = palette.spines.map(hexToUnitRgb);
  const half = SHELF_TEX_W / 2;
  const put = (tx: number, ty: number, c: Rgb, k: number) => {
    const o = (ty * SHELF_TEX_W + tx) * 4;
    out[o] = toByte(c[0] * k);
    out[o + 1] = toByte(c[1] * k);
    out[o + 2] = toByte(c[2] * k);
    out[o + 3] = 255;
  };
  /** Paints side units [u0, u1) x height fractions [v0, v1) on one side. */
  const fill = (
    side: number,
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    c: Rgb,
    shade: (fu: number, fv: number) => number,
  ) => {
    const i0 = Math.round(u0 * half);
    const i1 = Math.round(u1 * half);
    const j0 = Math.round(v0 * SHELF_TEX_H);
    const j1 = Math.round(v1 * SHELF_TEX_H);
    for (let j = j0; j < j1; j++) {
      const fv = (j + 0.5 - j0) / Math.max(1, j1 - j0);
      for (let i = i0; i < i1; i++) {
        const k = shade((i + 0.5 - i0) / Math.max(1, i1 - i0), fv);
        // The right bookcase is mirrored: its inner edge meets the left one's at the seam.
        put(side === 0 ? i : SHELF_TEX_W - 1 - i, j, c, k);
      }
    }
  };

  for (let side = 0; side < 2; side++) {
    // Plinth and cornice: wood, a little darker, with a lit top edge on the plinth.
    fill(side, 0, 1, 0, SHELF_PLINTH, wood, (_, fv) => 0.6 + 0.25 * fv);
    fill(side, 0, 1, SHELF_CORNICE, 1, wood, (_, fv) => 0.85 - 0.3 * fv);
    for (let row = 0; row < SHELF_ROWS; row++) {
      const y0 = shelfRowBottom(row);
      // Back: in shadow, darkest under the board above.
      fill(
        side,
        0,
        SHELF_PANEL_U,
        y0 + SHELF_BOARD,
        y0 + SHELF_ROW_H,
        back,
        (_, fv) => 1 - 0.45 * fv,
      );
      // Board: lit along its top edge.
      fill(side, 0, SHELF_PANEL_U, y0, y0 + SHELF_BOARD, wood, (_, fv) => 0.75 + 0.4 * fv);
    }
    // Inner side panel: wood, rounding off towards the seam.
    fill(side, SHELF_PANEL_U, 1, SHELF_PLINTH, SHELF_CORNICE, wood, (fu) => 0.95 - 0.3 * fu);
  }

  const cavity = SHELF_ROW_H - SHELF_BOARD;
  for (const s of spines) {
    const c = cloth[s.colour % cloth.length];
    const v0 = shelfRowBottom(s.row) + SHELF_BOARD;
    fill(s.side, s.x0, s.x1, v0, v0 + cavity * s.top, c, (fu, fv) => {
      let k = s.tone * (0.68 + 0.32 * Math.sin(Math.PI * fu));
      if (s.bands && ((fv > 0.1 && fv < 0.14) || (fv > 0.84 && fv < 0.88))) {
        k *= 1.35;
      }
      // A touch of shadow at the foot and the head of each book.
      k *= 0.85 + 0.15 * Math.min(1, fv * 8, (1 - fv) * 8);
      return k;
    });
  }
  return out;
}

export interface BookshelfTexture {
  readonly texture: WebGLTexture;
  /** Rebakes the texture (and its mipmaps) for a layout seed and palette. */
  update: (seed: number, palette: ShelfPalette) => void;
}

/**
 * Creates the mipmapped shelf texture, owned by `scope`. Leaves the texture bound
 * to the active unit after each `update`.
 */
export function createBookshelfTexture(gl: WebGL2RenderingContext, scope: Scope): BookshelfTexture {
  const pixels = new Uint8Array(SHELF_TEX_W * SHELF_TEX_H * 4);
  const texture = scope.add(
    createDataTexture(gl, {
      width: SHELF_TEX_W,
      height: SHELF_TEX_H,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      data: pixels,
    }),
    (t) => {
      gl.deleteTexture(t);
    },
  );
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return {
    texture,
    update(seed, palette) {
      bakeShelves(layoutShelves(seed), palette, pixels);
      updateDataTexture(gl, texture, SHELF_TEX_W, SHELF_TEX_H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.generateMipmap(gl.TEXTURE_2D);
    },
  };
}

/** Mip level for a blur of 0..1: about 6–55 reference px of softness at 1080p. */
export function shelfBlurLod(blur: number): number {
  return 1.5 + 3.2 * Math.max(0, Math.min(1, blur));
}

/**
 * GLSL for `vec4 bookshelf(sampler2D tex, vec2 p, vec2 frame, float sideW, float lod, float soft)`:
 * the bookcases at the frame's left and right edges, `sideW` wide. `p` and
 * `frame` are in any one unit (y up); `soft` is the edge softness in side units.
 * Returns the shelf colour and its coverage (0 on the back wall between and
 * above or below the bookcases, which shrink towards the inner edge). Four
 * diagonal taps at mip `lod` smooth out the blocky look of a single mip fetch.
 */
export const BOOKSHELF_GLSL = /* glsl */ `
vec4 bookshelf(sampler2D tex, vec2 p, vec2 frame, float sideW, float lod, float soft) {
  float right = step(frame.x * 0.5, p.x);
  float f = mix(p.x, frame.x - p.x, right) / sideW;
  float fc = min(f, 1.0);
  float eye = ${glslFloat(SHELF_EYE)};
  float v = eye + (p.y / frame.y - eye) / (1.0 - ${glslFloat(SHELF_PERSP)} * fc);
  vec2 uv = vec2(mix(0.5 * fc, 1.0 - 0.5 * fc, right), v);
  vec2 o = exp2(lod) * vec2(${glslFloat(0.35 / SHELF_TEX_W)}, ${glslFloat(0.35 / SHELF_TEX_H)});
  vec3 c = textureLod(tex, uv + vec2(-o.x, -o.y), lod).rgb
    + textureLod(tex, uv + vec2(o.x, -o.y), lod).rgb
    + textureLod(tex, uv + vec2(-o.x, o.y), lod).rgb
    + textureLod(tex, uv + vec2(o.x, o.y), lod).rgb;
  float cover = (1.0 - smoothstep(1.0 - soft, 1.0 + soft, f))
    * smoothstep(-soft, soft, v) * (1.0 - smoothstep(1.0 - soft, 1.0 + soft, v));
  return vec4(c * 0.25, cover);
}
`;
