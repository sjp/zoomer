/**
 * Textures drawn with a 2D canvas: labels, signs, screens and boards that the
 * Scenes (and a few other effects) letter with a system font on an
 * `OffscreenCanvas` and upload whole.
 */
import { resetUnpackState, type Scope } from "./gl";

/** A clean system sans-serif stack; no font is bundled. */
export const SANS_FONT_STACK = `"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif`;

/** A system monospaced stack, for figures that should line up in columns. */
export const MONO_FONT_STACK = `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace`;

interface CanvasTextureOptions {
  /** Min and mag filter. Defaults to `gl.LINEAR`. */
  filter?: GLenum;
  /** Premultiply the canvas's colour by its alpha on upload. Defaults to false. */
  premultiply?: boolean;
}

export interface CanvasTexture {
  readonly texture: WebGLTexture;
  /**
   * Replaces the texture with `source`, or with one transparent texel for null.
   * Leaves texture unit 0 active with nothing bound.
   */
  upload: (source: TexImageSource | null) => void;
}

/**
 * A clamped texture for canvas uploads, owned by `scope` and holding one
 * transparent texel until the first upload.
 */
export function createCanvasTexture(
  gl: WebGL2RenderingContext,
  scope: Scope,
  options: CanvasTextureOptions = {},
): CanvasTexture {
  const filter = options.filter ?? gl.LINEAR;
  const premultiply = options.premultiply ?? false;
  const texture = scope.add(gl.createTexture(), (t) => {
    gl.deleteTexture(t);
  });
  const upload = (source: TexImageSource | null) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    resetUnpackState(gl);
    if (source) {
      if (premultiply) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (premultiply) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(4),
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  upload(null);
  return { texture, upload };
}

/**
 * Draws on a new `width` x `height` OffscreenCanvas and returns it, or null where
 * there is no OffscreenCanvas or 2D context (old browsers, tests).
 */
export function paintCanvas(
  width: number,
  height: number,
  draw: (ctx: OffscreenCanvasRenderingContext2D) => void,
): OffscreenCanvas | null {
  if (typeof OffscreenCanvas === "undefined") {
    return null;
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  draw(ctx);
  return canvas;
}

/** Most dirty rects a `CanvasAtlas` keeps before a flush uploads the whole canvas instead. */
const MAX_DIRTY = 48;

/**
 * A 2D canvas mirrored into a texture a dirty rect at a time: draw on areas
 * cleared with `clear`, then `flush` uploads just those areas (premultiplied).
 * Text layers and card atlases draw labels and sprites on one and sample it.
 */
interface CanvasAtlas {
  /** Linear-filtered, clamped, premultiplied; one transparent texel until the first flush. */
  readonly texture: WebGLTexture;
  /**
   * The 2D context to draw on, or null before `resize` or where there is no
   * `OffscreenCanvas`. Draw only on areas cleared with `clear`, so the upload
   * picks them up.
   */
  readonly ctx: OffscreenCanvasRenderingContext2D | null;
  readonly width: number;
  readonly height: number;
  /** Whether the texture holds the canvas at its current size (after the first flush). */
  readonly ready: boolean;
  /**
   * Makes the canvas `width` x `height` and clears it all. Returns whether there
   * is a canvas to draw on. A no-op (keeping the contents) if the size is unchanged.
   */
  resize: (width: number, height: number) => boolean;
  /** Frees the canvas and the texture's storage; `resize` brings them back. */
  release: () => void;
  /** Clears a rect of the canvas and marks it for upload. */
  clear: (x: number, y: number, w: number, h: number) => void;
  /** Uploads the rects cleared (and drawn on) since the last flush. Leaves texture unit 0 active with nothing bound. */
  flush: () => void;
}

/** A canvas atlas owned by `scope`; `resize` gives it a canvas. */
export function createCanvasAtlas(gl: WebGL2RenderingContext, scope: Scope): CanvasAtlas {
  const texture = scope.add(gl.createTexture(), (t) => {
    gl.deleteTexture(t);
  });
  const empty = () => {
    resetUnpackState(gl);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
  };
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  empty();
  gl.bindTexture(gl.TEXTURE_2D, null);

  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  let width = 0;
  let height = 0;
  /** The texture matches the canvas's size (false until the first full upload). */
  let allocated = false;
  let fullDirty = false;
  const dirty = new Int32Array(MAX_DIRTY * 4);
  let dirtyCount = 0;

  return {
    texture,
    get ctx() {
      return ctx;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get ready() {
      return allocated;
    },
    resize(w, h) {
      const nw = Math.max(1, Math.round(w));
      const nh = Math.max(1, Math.round(h));
      if (canvas && nw === width && nh === height) {
        return ctx !== null;
      }
      width = nw;
      height = nh;
      if (typeof OffscreenCanvas === "undefined") {
        return false;
      }
      canvas = new OffscreenCanvas(width, height);
      ctx = canvas.getContext("2d");
      allocated = false;
      fullDirty = true;
      dirtyCount = 0;
      return ctx !== null;
    },
    release() {
      canvas = null;
      ctx = null;
      width = 0;
      height = 0;
      allocated = false;
      dirtyCount = 0;
      fullDirty = false;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      empty();
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    clear(x, y, w, h) {
      if (!ctx) {
        return;
      }
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
      if (x1 <= x0 || y1 <= y0) {
        return;
      }
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
      if (fullDirty) {
        return;
      }
      if (dirtyCount >= MAX_DIRTY) {
        fullDirty = true;
        return;
      }
      const o = dirtyCount * 4;
      dirty[o] = x0;
      dirty[o + 1] = y0;
      dirty[o + 2] = x1 - x0;
      dirty[o + 3] = y1 - y0;
      dirtyCount++;
    },
    flush() {
      if (!canvas || (!fullDirty && dirtyCount === 0)) {
        return;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      resetUnpackState(gl);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (fullDirty || !allocated) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        allocated = true;
      } else {
        // WebGL2 reads a sub-rectangle of the canvas through the row length and skip settings.
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
        for (let i = 0; i < dirtyCount; i++) {
          const o = i * 4;
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, dirty[o]);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, dirty[o + 1]);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            dirty[o],
            dirty[o + 1],
            dirty[o + 2],
            dirty[o + 3],
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            canvas,
          );
        }
      }
      resetUnpackState(gl);
      gl.bindTexture(gl.TEXTURE_2D, null);
      fullDirty = false;
      dirtyCount = 0;
    },
  };
}
