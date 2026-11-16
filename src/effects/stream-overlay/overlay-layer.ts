/**
 * The stream overlay layer: chat, splits, goal bars, alerts and emotes drawn
 * over a streamer scene's picture. A scene builds it in `create`, passes on
 * its resizes, and calls `frame` last in its own `frame`:
 *
 * ```ts
 * const overlays = createStreamOverlays(gl, scope);
 * // resize(vp):     overlays.resize(vp);
 * // frame(dt, p):   ...draw the scene...; overlays.frame(dt, p);
 * ```
 *
 * Its params come from `streamOverlayParams` in `overlay-params.meta.ts`,
 * spread into the scene's own.
 *
 * Panels and text draw on one 2D canvas the size of the frame, each overlay
 * at its slot's place (so at rest it copies texel for texel), and only the
 * rects an overlay clears are uploaded. Things that move every frame (banners
 * sliding, confetti, emotes) don't touch the canvas: they are instanced quads
 * from a small sprite atlas painted once. Everything is one premultiplied
 * pass over the scene, in four instanced draws at most (back panels, back
 * sprites, front panels, front sprites); with every overlay off and faded out
 * there is no pass at all, and the canvas is freed.
 *
 * An overlay's toggle fades it in and out over `OVERLAY_FADE_SECONDS`; it
 * keeps updating while hidden, so it comes back in the right state. A column
 * overlay whose side changes slides there (`overlay-layout.ts`).
 */
import { createCanvasAtlas } from "../canvas-texture";
import { hexToUnitRgb, type Rgb } from "../color";
import { createUniforms, resetUnpackState, type Scope, scopedProgram } from "../gl";
import { approach, smoothstep } from "../math";
import { createSpriteBatch, SPRITE_SPIN_GLSL, writeSprite } from "../sprites";
import type { AnyParamValues, Viewport } from "../types";
import {
  assignColumns,
  computeOverlayLayout,
  createRectEase,
  freeCentre,
  type OverlayLayout,
  type Rect,
  slotRect,
  type SlotUse,
} from "./overlay-layout";
import {
  OVERLAY_ACCENT_KEY,
  OVERLAY_OPACITY_KEY,
  type OverlayMeta,
  type OverlaySide,
  type OverlaySlot,
} from "./overlay-params.meta";

/** Seconds an overlay takes to fade in or out when toggled. */
export const OVERLAY_FADE_SECONDS = 0.5;

/** Side length in pixels of a sprite atlas cell, and the gap kept round each. */
export const SPRITE_CELL = 128;
const SPRITE_GUTTER = 2;
const SPRITE_COLUMNS = 8;

/** Most panel quads, and most sprites, each layer (back, front) holds a frame. */
const MAX_PANEL_QUADS = 64;
export const MAX_SPRITES = 256;

/** What an overlay can read each frame. One object per overlay, updated in place. */
export interface OverlayView {
  /** The frame in device pixels, and pixels per 1080p pixel. */
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly layout: OverlayLayout;
  /** Its toggle's value. */
  readonly on: boolean;
  /** Its eased fade, 0 (hidden) to 1; multiply your own quads' opacity by it. */
  readonly fade: number;
  /** The side its column is on, or null when it isn't occupying one. */
  readonly side: OverlaySide | null;
  /** The shared accent colour, as `#rrggbb` (for the canvas) and unit RGB. */
  readonly accent: string;
  readonly accentRgb: Readonly<Rgb>;
  /** The shared panel background opacity. */
  readonly opacity: number;
  /**
   * Where `slot` (one of its own) lives on the canvas: draw it there. Whole
   * pixels. For `edges`, the whole frame. Returns the layout's object.
   */
  target: (slot: OverlaySlot) => Readonly<Rect>;
  /** Where `slot` is shown this frame: its target, or on the way there. */
  shown: (slot: OverlaySlot) => Readonly<Rect>;
}

/** The shared canvas, as an overlay sees it in `draw2d`. */
export interface OverlayCanvas {
  readonly ctx: OffscreenCanvasRenderingContext2D;
  /** Clears a rect and marks it for upload: clear before redrawing anything. */
  clear: (x: number, y: number, w: number, h: number) => void;
}

/** What an overlay queues for the GPU each frame, in `drawGl`. */
export interface OverlayDraw {
  /**
   * Draws the canvas rect (`sx`, `sy`, `sw`, `sh`) at the screen rect (`dx`,
   * `dy`, `dw`, `dh`), at `alpha`. Copies texel for texel at the same size on
   * whole pixels. `back` puts it behind the other overlays' panels.
   */
  panel: (
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    alpha: number,
    back?: boolean,
  ) => void;
  /**
   * Draws sprite atlas cell `cell` centred on (`cx`, `cy`), `half` pixels
   * from centre to edge, turned `angle` radians, at `alpha`; `flip` scales
   * its width (the cosine of a tumble). `back` puts it behind the panels.
   */
  sprite: (
    cell: number,
    cx: number,
    cy: number,
    half: number,
    angle: number,
    alpha: number,
    back?: boolean,
    flip?: number,
  ) => void;
}

/** Paints sprite `index` (0-based within a reservation) in a `size`-pixel square at the origin. */
type SpritePainter = (ctx: OffscreenCanvasRenderingContext2D, index: number, size: number) => void;

/** What an overlay gets when it is built. */
export interface OverlayContext {
  readonly gl: WebGL2RenderingContext;
  /** The layer's scope: resources added here are freed with it. */
  readonly scope: Scope;
  /**
   * Reserves `count` cells of the shared sprite atlas (each `SPRITE_CELL`
   * pixels square) and returns the first one's number. `paint` draws each,
   * once, the first time any sprite is drawn. Call only while being built.
   */
  reserveSprites: (count: number, paint: SpritePainter) => number;
}

/** A running overlay. Every method is called by the layer; none is called after `dispose`. */
export interface OverlayInstance {
  /**
   * Advances its clocks and schedules by `dt` seconds and reads its params.
   * Called every frame, on or off, so it comes back showing the right state.
   */
  update: (dt: number, values: Readonly<AnyParamValues>, view: OverlayView) => void;
  /**
   * Redraws what has changed on the canvas, inside its own slots' targets,
   * clearing each area first. With `full`, the layer has just cleared its
   * slots (first show, resize, slot change, accent or opacity change): draw
   * everything. Called after `update`, only while it is visible.
   */
  draw2d: (canvas: OverlayCanvas, view: OverlayView, full: boolean) => void;
  /**
   * Queues its quads. Optional: without it, each of its slots (but `edges`)
   * is drawn whole from its target to where it is shown, at its fade.
   * Called only while it is visible.
   */
  drawGl?: (out: OverlayDraw, view: OverlayView) => void;
  dispose?: () => void;
}

/** An overlay's implementation, next to its metadata. */
export interface OverlayDefinition {
  readonly meta: OverlayMeta;
  readonly create: (ctx: OverlayContext) => OverlayInstance;
}

/** Every overlay's implementation, in the same order as `OVERLAY_METAS`. */
export const OVERLAY_DEFINITIONS: readonly OverlayDefinition[] = [];

/** The layer a streamer scene owns. */
export interface StreamOverlays {
  /** The current slots (for a scene placing its own content round them). */
  readonly layout: OverlayLayout;
  resize: (viewport: Viewport) => void;
  /**
   * Updates every overlay and draws the visible ones over the default
   * framebuffer. Call last in the scene's `frame`. Leaves blending off, the
   * default framebuffer and no vertex array bound, texture unit 0 active with
   * nothing bound.
   */
  frame: (dt: number, values: Readonly<AnyParamValues>) => void;
  /**
   * Writes to `out` the centred rect clear of the overlays that are on (as of
   * the last frame), for a scene's own centred content. See `freeCentre`.
   */
  freeRect: (out: Rect) => Rect;
}

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aUv;
layout(location = 3) in float aAlpha;
layout(location = 4) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vUv;
out float vAlpha;
${SPRITE_SPIN_GLSL}
void main() {
  vec2 px = aRect.xy + spinCorner(aCorner, aSpin) * aRect.zw;
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vAlpha = aAlpha;
  gl_Position = vec4(px.x / uResolution.x * 2.0 - 1.0, 1.0 - px.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
// highp: the panel canvas is frame-sized, past what mediump texture coordinates resolve.
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
in float vAlpha;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv) * vAlpha;
}
`;

/** Instance segments in the shared batch, in draw order. */
const BACK_PANELS = 0;
const BACK_SPRITES = 1;
const FRONT_PANELS = 2;
const FRONT_SPRITES = 3;
const SEGMENT_BASE = [
  0,
  MAX_PANEL_QUADS,
  MAX_PANEL_QUADS + MAX_SPRITES,
  2 * MAX_PANEL_QUADS + MAX_SPRITES,
];
const SEGMENT_CAP = [MAX_PANEL_QUADS, MAX_SPRITES, MAX_PANEL_QUADS, MAX_SPRITES];
const MAX_INSTANCES = 2 * (MAX_PANEL_QUADS + MAX_SPRITES);

/** One overlay's state in the layer. */
interface Entry {
  readonly meta: OverlayMeta;
  readonly instance: OverlayInstance;
  readonly view: MutableView;
  /** Index into the column bookkeeping, or -1. */
  readonly column: number;
  /** Shown rect per slot, in `meta.slots` order. */
  readonly eases: ReturnType<typeof createRectEase>[];
  /** Target per slot last frame (the layout's objects), to spot a change. */
  readonly targets: (Rect | null)[];
  /** Linear fade 0..1; `view.fade` is its eased value. */
  fade: number;
  /** It was hidden (faded out) at the start of this frame. */
  wasHidden: boolean;
  /** Redraw everything on the next `draw2d`. */
  full: boolean;
}

type MutableView = { -readonly [K in keyof OverlayView]: OverlayView[K] };

/**
 * Builds the overlay layer, owned by `scope`, with `definitions` (the
 * registry by default; tests pass their own).
 */
export function createStreamOverlays(
  gl: WebGL2RenderingContext,
  scope: Scope,
  definitions: readonly OverlayDefinition[] = OVERLAY_DEFINITIONS,
): StreamOverlays {
  const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
  const u = createUniforms(gl, program, ["uResolution", "uTex"]);
  gl.useProgram(program);
  u.i1("uTex", 0);
  gl.useProgram(null);
  const batch = scope.own(
    createSpriteBatch(gl, MAX_INSTANCES, [4, 4, 1], undefined, { rotation: true }),
  );
  const counts = new Int32Array(4);

  const panels = createCanvasAtlas(gl, scope);
  /** What `draw2d` gets: remade whenever the atlas makes a new canvas. */
  let canvas: OverlayCanvas | null = null;

  // The sprite atlas: cells reserved while overlays are built, painted on first use.
  const painters: { first: number; count: number; paint: SpritePainter }[] = [];
  let spriteCells = 0;
  let spriteTexture: WebGLTexture | null = null;
  let spriteUv = new Float32Array(0);
  let building = true;
  const reserveSprites = (count: number, paint: SpritePainter) => {
    if (!building) {
      throw new Error("Sprites can only be reserved while an overlay is being built");
    }
    const n = Math.max(0, Math.floor(count));
    const first = spriteCells;
    painters.push({ first, count: n, paint });
    spriteCells += n;
    return first;
  };

  let layout = computeOverlayLayout(1, 1);
  let scale = 1 / 1080;
  let accentHex = "";
  let opacity = -1;
  const accentRgb: Rgb = [0, 0, 0];

  // Column bookkeeping, in registration order among the column overlays.
  const wanted: OverlaySide[] = [];
  const occupying: boolean[] = [];
  const sides: (OverlaySide | null)[] = [];
  const use: SlotUse = { left: false, right: false, top: false };

  const byId = new Map(definitions.map((d) => [d.meta.id, d]));
  if (byId.size !== definitions.length) {
    throw new Error("Two stream overlays share an id");
  }
  const context: OverlayContext = { gl, scope, reserveSprites };
  let columns = 0;
  const build = (def: OverlayDefinition): Entry => {
    const meta = def.meta;
    const eases = meta.slots.map(() => createRectEase());
    const column = meta.slots.includes("column") ? columns++ : -1;
    if (column >= 0) {
      wanted.push("right");
      occupying.push(false);
      sides.push(null);
    }
    const view: MutableView = {
      width: 1,
      height: 1,
      scale,
      layout,
      on: false,
      fade: 0,
      side: null,
      accent: "#000000",
      accentRgb,
      opacity: 1,
      target: (slot) => targetOf(column, slot),
      shown: (slot) => {
        const i = meta.slots.indexOf(slot);
        return i >= 0 ? eases[i].rect : layout.full;
      },
    };
    const instance = def.create(context);
    scope.defer(() => instance.dispose?.());
    return {
      meta,
      instance,
      view,
      column,
      eases,
      targets: meta.slots.map(() => null),
      fade: 0,
      wasHidden: true,
      full: true,
    };
  };
  const entries = definitions.map((d) => build(d));
  building = false;

  /** Where a slot of the overlay with column index `column` (or -1) goes on the canvas. */
  function targetOf(column: number, slot: OverlaySlot): Rect {
    const side = column >= 0 ? (sides[column] ?? wanted[column]) : "left";
    return slotRect(layout, slot, side);
  }

  if (spriteCells > 0) {
    spriteTexture = scope.add(gl.createTexture(), (t) => {
      gl.deleteTexture(t);
    });
    // Each cell's uv rect, inside its gutter.
    const rows = Math.ceil(spriteCells / SPRITE_COLUMNS);
    const stride = SPRITE_CELL + 2 * SPRITE_GUTTER;
    const tw = Math.min(spriteCells, SPRITE_COLUMNS) * stride;
    const th = rows * stride;
    spriteUv = new Float32Array(spriteCells * 4);
    for (let c = 0; c < spriteCells; c++) {
      const x = (c % SPRITE_COLUMNS) * stride + SPRITE_GUTTER;
      const y = Math.floor(c / SPRITE_COLUMNS) * stride + SPRITE_GUTTER;
      spriteUv.set([x / tw, y / th, (x + SPRITE_CELL) / tw, (y + SPRITE_CELL) / th], c * 4);
    }
  }
  /** Whether the sprite atlas has been painted (tried), and whether that worked. */
  let spritesPainted = false;
  let spritesReady = false;

  /** Paints every reserved sprite into the atlas and uploads it, mipmapped. */
  const paintSprites = () => {
    spritesPainted = true;
    if (!spriteTexture || typeof OffscreenCanvas === "undefined") {
      return;
    }
    const stride = SPRITE_CELL + 2 * SPRITE_GUTTER;
    const tw = Math.min(spriteCells, SPRITE_COLUMNS) * stride;
    const th = Math.ceil(spriteCells / SPRITE_COLUMNS) * stride;
    const atlas = new OffscreenCanvas(tw, th);
    const ctx = atlas.getContext("2d");
    if (!ctx) {
      return;
    }
    for (const { first, count, paint } of painters) {
      for (let i = 0; i < count; i++) {
        const c = first + i;
        ctx.save();
        ctx.translate(
          (c % SPRITE_COLUMNS) * stride + SPRITE_GUTTER,
          Math.floor(c / SPRITE_COLUMNS) * stride + SPRITE_GUTTER,
        );
        ctx.beginPath();
        ctx.rect(0, 0, SPRITE_CELL, SPRITE_CELL);
        ctx.clip();
        paint(ctx, i, SPRITE_CELL);
        ctx.restore();
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, spriteTexture);
    resetUnpackState(gl);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    resetUnpackState(gl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    spritesReady = true;
  };

  const push = (segment: number) => {
    const n = counts[segment];
    if (n >= SEGMENT_CAP[segment]) {
      return -1;
    }
    counts[segment] = n + 1;
    return SEGMENT_BASE[segment] + n;
  };

  const out: OverlayDraw = {
    panel(sx, sy, sw, sh, dx, dy, dw, dh, alpha, back = false) {
      if (!(alpha > 0) || !(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0)) {
        return;
      }
      const i = push(back ? BACK_PANELS : FRONT_PANELS);
      if (i < 0) {
        return;
      }
      const tw = panels.width;
      const th = panels.height;
      const o = writeSprite(
        batch,
        i,
        dx + dw / 2,
        dy + dh / 2,
        dw / 2,
        dh / 2,
        sx / tw,
        sy / th,
        (sx + sw) / tw,
        (sy + sh) / th,
      );
      batch.data[o + 8] = Math.min(1, alpha);
    },
    sprite(cell, cx, cy, half, angle, alpha, back = false, flip = 1) {
      if (!(alpha > 0) || !(half > 0) || !(cell >= 0 && cell < spriteCells)) {
        return;
      }
      const i = push(back ? BACK_SPRITES : FRONT_SPRITES);
      if (i < 0) {
        return;
      }
      const c = Math.floor(cell) * 4;
      const o = writeSprite(
        batch,
        i,
        cx,
        cy,
        half,
        half,
        spriteUv[c],
        spriteUv[c + 1],
        spriteUv[c + 2],
        spriteUv[c + 3],
        angle,
        flip,
      );
      batch.data[o + 8] = Math.min(1, alpha);
    },
  };

  /** The default `drawGl`: each slot but `edges` whole, from its target to where it's shown. */
  const drawSlots = (entry: Entry) => {
    const slots = entry.meta.slots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === "edges") {
        continue;
      }
      const t = targetOf(entry.column, slot);
      const s = entry.eases[i].rect;
      out.panel(t.x, t.y, t.w, t.h, s.x, s.y, s.w, s.h, entry.view.fade, slot === "border");
    }
  };

  /** Clears an overlay's canvas slots (not `edges`), at their current targets. */
  const clearSlots = (entry: Entry) => {
    for (const slot of entry.meta.slots) {
      if (slot !== "edges") {
        const t = targetOf(entry.column, slot);
        panels.clear(t.x, t.y, t.w, t.h);
      }
    }
  };

  let width = 1;
  let height = 1;
  let resized = true;

  return {
    get layout() {
      return layout;
    },
    resize(viewport) {
      if (viewport.width === width && viewport.height === height && !resized) {
        return;
      }
      width = Math.max(1, viewport.width);
      height = Math.max(1, viewport.height);
      scale = viewport.scale;
      layout = computeOverlayLayout(width, height);
      resized = true;
    },
    frame(dt, values) {
      // Shared look: a change redraws every panel.
      const accent = String(values[OVERLAY_ACCENT_KEY] ?? "#a48cf0");
      const op = Number(values[OVERLAY_OPACITY_KEY] ?? 0.85);
      const restyled = accent !== accentHex || op !== opacity || resized;
      if (accent !== accentHex) {
        // Allocates only when the accent changes.
        const rgb = hexToUnitRgb(accent);
        accentRgb[0] = rgb[0];
        accentRgb[1] = rgb[1];
        accentRgb[2] = rgb[2];
        accentHex = accent;
      }
      opacity = op;
      const step = dt / OVERLAY_FADE_SECONDS;

      // Fades and toggles first, so the columns know who still holds one.
      let visible = 0;
      for (const e of entries) {
        const on = values[e.meta.toggle] === true;
        e.wasHidden = e.fade <= 0;
        e.fade = approach(e.fade, on ? 1 : 0, Number.isFinite(step) && step > 0 ? step : 0);
        if (e.wasHidden && e.fade > 0) {
          e.full = true;
        }
        const view = e.view;
        view.on = on;
        view.fade = smoothstep(0, 1, e.fade);
        if (e.column >= 0) {
          wanted[e.column] = values[e.meta.sideKey ?? ""] === "left" ? "left" : "right";
          occupying[e.column] = on || e.fade > 0;
        }
        if (on || e.fade > 0) {
          visible++;
        }
      }
      assignColumns(wanted, occupying, sides);

      // Targets, eases, and clearing what moved.
      use.left = false;
      use.right = false;
      use.top = false;
      for (const e of entries) {
        const view = e.view;
        view.width = width;
        view.height = height;
        view.scale = scale;
        view.layout = layout;
        view.side = e.column >= 0 ? sides[e.column] : null;
        view.accent = accentHex;
        view.opacity = opacity;
        const slots = e.meta.slots;
        const hadContent = !e.full;
        for (let i = 0; i < slots.length; i++) {
          const target = targetOf(e.column, slots[i]);
          const before = e.targets[i];
          if (before !== target) {
            // What it has on the canvas (if anything: `full` means it has nothing
            // there yet) moves with it. A resize remakes the canvas anyway.
            if (before !== null && hadContent && !resized && slots[i] !== "edges") {
              panels.clear(before.x, before.y, before.w, before.h);
              e.full = true;
            }
            // It slides only if it was already showing; otherwise it appears in place.
            e.eases[i].set(target, resized || e.wasHidden || before === null);
            e.targets[i] = target;
          }
          e.eases[i].step(dt);
          if (view.on) {
            if (slots[i] === "column") {
              if (view.side === "left") {
                use.left = true;
              } else {
                use.right = true;
              }
            } else if (
              slots[i] === "topLeft" ||
              slots[i] === "topCentre" ||
              slots[i] === "topRight"
            ) {
              use.top = true;
            }
          }
        }
        if (restyled) {
          e.full = true;
        }
        e.instance.update(dt, values, view);
      }
      resized = false;

      if (visible === 0) {
        // Nothing to show: no pass, and no frame-sized canvas held.
        if (panels.width > 0) {
          panels.release();
        }
        return;
      }

      // Redraw what changed on the canvas.
      const fresh = panels.width !== width || panels.height !== height;
      const ctx = panels.resize(width, height) ? panels.ctx : null;
      if (ctx === null) {
        canvas = null;
      } else if (canvas?.ctx !== ctx) {
        // Allocates only when the atlas makes a new canvas (first show, resize).
        canvas = { ctx, clear: panels.clear };
      }
      // Overlays that have just faded out free their areas before anyone draws,
      // since another may be moving into one.
      for (const e of entries) {
        if (e.fade <= 0 && !e.full) {
          clearSlots(e);
          e.full = true;
        }
      }
      for (const e of entries) {
        if (e.fade <= 0 || canvas === null) {
          continue;
        }
        const full = e.full || fresh;
        if (full) {
          clearSlots(e);
        }
        e.full = false;
        e.instance.draw2d(canvas, e.view, full);
      }
      panels.flush();

      // Queue and draw.
      counts.fill(0);
      for (const e of entries) {
        if (e.fade <= 0) {
          continue;
        }
        if (e.instance.drawGl) {
          e.instance.drawGl(out, e.view);
        } else if (panels.ready) {
          drawSlots(e);
        }
      }
      let last = 0;
      for (let s = 0; s < 4; s++) {
        if (counts[s] > 0) {
          last = SEGMENT_BASE[s] + counts[s];
        }
      }
      if (last === 0) {
        return;
      }
      if ((counts[BACK_SPRITES] > 0 || counts[FRONT_SPRITES] > 0) && !spritesPainted) {
        paintSprites();
      }
      if (!spritesReady) {
        // An unpainted atlas would sample as opaque black.
        counts[BACK_SPRITES] = 0;
        counts[FRONT_SPRITES] = 0;
      }
      if (
        counts[BACK_PANELS] +
          counts[FRONT_PANELS] +
          counts[BACK_SPRITES] +
          counts[FRONT_SPRITES] ===
        0
      ) {
        return;
      }
      batch.upload(last);
      gl.useProgram(program);
      u.f2("uResolution", width, height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE0);
      for (let s = 0; s < 4; s++) {
        if (counts[s] === 0) {
          continue;
        }
        const sprites = s === BACK_SPRITES || s === FRONT_SPRITES;
        gl.bindTexture(gl.TEXTURE_2D, sprites ? spriteTexture : panels.texture);
        batch.draw(SEGMENT_BASE[s], counts[s]);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.disable(gl.BLEND);
    },
    freeRect(rect) {
      return freeCentre(layout, use, rect);
    },
  };
}
