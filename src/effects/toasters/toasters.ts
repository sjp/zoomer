import { createCanvasTexture } from "../canvas-texture";
import { unitRgbMemo } from "../color";
import { beginFrame, createUniforms, scopedProgram, TO_CLIP_GLSL, withScope } from "../gl";
import { approach } from "../math";
import { createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import { ATLAS_COLS, ATLAS_ROWS, paintClassicAtlas, paintModernAtlas } from "./toaster-sprites";
import {
  CELL,
  createFlock,
  type FlockParams,
  SLOTS,
  stepFlock,
  writeSprites,
} from "./toasters-sim";
import { toastersMeta } from "./toasters.meta";

/** Seconds a style change takes to crossfade the sprites from one atlas to the other. */
const STYLE_FADE = 1;
/** Bounds on the Modern atlas's cell side, px. */
const MIN_MODERN_CELL = 16;
const MAX_MODERN_CELL = 512;

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down), half-size (px), opacity. */
layout(location = 1) in vec4 aSprite;
/** Atlas cells A and B, the mix from A to B, brightness. */
layout(location = 2) in vec4 aCell;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vCell;
flat out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  // Cell coordinates, 0 to 1 with y down, like the canvas the atlas was drawn on.
  vLocal = aCorner * 0.5 + 0.5;
  vCell = aCell;
  vAlpha = aSprite.w;
  gl_Position = pxToClip(aSprite.xy + aCorner * aSprite.z, uResolution);
}
`;

/**
 * Samples both atlases (Classic, Modern) at two cells and mixes them by the
 * style crossfade and the cell mix. Premultiplied; brightness dims the colour.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec4 vCell;
flat in float vAlpha;
uniform sampler2D uClassic;
uniform sampler2D uModern;
/** 0 Classic to 1 Modern. */
uniform float uStyle;
out vec4 outColor;
const vec2 GRID = vec2(${String(ATLAS_COLS)}.0, ${String(ATLAS_ROWS)}.0);

vec4 sampleCell(float cell, vec2 local) {
  float row = floor(cell / GRID.x + 0.001);
  vec2 uv = (vec2(cell - row * GRID.x, row) + local) / GRID;
  return mix(texture(uClassic, uv), texture(uModern, uv), uStyle);
}

void main() {
  // Kept off the cell's border so neither filter reaches into the next cell.
  vec2 local = clamp(vLocal, 0.01, 0.99);
  vec4 c = sampleCell(vCell.x, local);
  if (vCell.z > 0.0) {
    c = mix(c, sampleCell(vCell.y, local), vCell.z);
  }
  outColor = vec4(c.rgb * vCell.w, c.a) * vAlpha;
}
`;

/**
 * The After Dark flying toasters: winged chrome toasters and slices of toast
 * drifting down and to the left across a black sky, in three depth layers, the
 * toasters flapping out of step and bobbing with their wing beats.
 */
export const toasters = defineEffect(toastersMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uClassic", "uModern", "uStyle"]);
      const batch = scope.own(createSpriteBatch(gl, SLOTS, [4, 4]));
      const classic = createCanvasTexture(gl, scope, { filter: gl.NEAREST, premultiply: true });
      const modern = createCanvasTexture(gl, scope, { premultiply: true });
      classic.upload(paintClassicAtlas());
      gl.useProgram(program);
      u.i1("uClassic", 0);
      u.i1("uModern", 1);
      gl.useProgram(null);

      const background = unitRgbMemo();
      const flock = createFlock(0);
      const fp: FlockParams = { toasters: 0, toast: 0, doneness: "", speed: 0, seed: 0 };
      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let modernCell = 0;
      /** The style crossfade, 0 Classic to 1 Modern; snaps on the first frame. */
      let style = -1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
          refWidth = width / scale;
          // The Modern sprites are redrawn at their on-screen size, to stay sharp.
          const cell = Math.round(
            Math.min(MAX_MODERN_CELL, Math.max(MIN_MODERN_CELL, CELL * scale)),
          );
          if (cell !== modernCell) {
            modernCell = cell;
            modern.upload(paintModernAtlas(cell));
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const target = p.style === "modern" ? 1 : 0;
          style = style < 0 ? target : approach(style, target, dt / STYLE_FADE);

          fp.toasters = p.toasters;
          fp.toast = p.toast;
          fp.doneness = p.doneness;
          fp.speed = p.speed;
          fp.seed = p.seed;
          stepFlock(flock, dt, refWidth, fp);
          const n = writeSprites(flock, batch.data, refWidth, scale);

          const bg = background(p.background);
          gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (n === 0) {
            return;
          }
          batch.upload(n);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(program);
          u.f2("uResolution", width, height);
          u.f1("uStyle", style);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, modern.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, classic.texture);
          batch.draw(0, n);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
