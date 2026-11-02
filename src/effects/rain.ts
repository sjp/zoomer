import { unitRgbMemo } from "./color";
import {
  beginFrame,
  createProgram,
  createUniforms,
  resetUnpackState,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createSpriteBatch, type SpriteBatch } from "./sprites";
import { defineEffect } from "./types";
import { HASH32_GLSL } from "./noise";

const CHARSETS: Record<string, string> = {
  katakana: "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>",
  binary: "01",
  hex: "0123456789ABCDEF",
  latin: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
};

const FONT_FAMILY = `"MS Gothic", "Noto Sans Mono CJK JP", monospace`;
/** Glyph tiles per row of the atlas texture. */
const ATLAS_COLS = 16;
/**
 * Trails are cut off once they fade below this fraction of full brightness: under
 * half an 8-bit step, so the cut is invisible.
 */
const CUTOFF = 1 / 512;

/**
 * `a` if it already holds `n` elements, else a new array of the same type and
 * length `n` whose first `keep` elements are copied from `a` (the rest zero).
 */
export function growArray<T extends Float32Array | Uint8Array>(a: T, n: number, keep: number): T {
  if (a.length >= n) return a;
  const b = new (a.constructor as new (length: number) => T)(n);
  b.set(a.subarray(0, Math.min(keep, a.length)));
  return b;
}

/**
 * One instance per falling drop, covering the rows of its column that are still
 * visibly lit. Pixel coordinates are y-down.
 */
const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Column, head position (rows), fall rate (rows/s) and glyph seed. */
layout(location = 1) in vec4 aDrop;
/** First row and end row (exclusive) to draw. */
layout(location = 2) in vec2 aRows;
uniform vec2 uResolution;
uniform float uCell;
flat out float vCol;
flat out float vHead;
flat out float vRate;
flat out float vSeed;
${TO_CLIP_GLSL}
void main() {
  vec2 c = aCorner * 0.5 + 0.5;
  vec2 px = vec2((aDrop.x + c.x) * uCell, mix(aRows.x, aRows.y, c.y) * uCell);
  vCol = aDrop.x;
  vHead = aDrop.y;
  vRate = aDrop.z;
  vSeed = aDrop.w;
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * Each cell shows a glyph picked by hashing (column, row, drop seed), so it stays
 * fixed while its drop lasts. Brightness falls off with the time since the head
 * passed the cell, reproducing the old translucent-fill persistence trail
 * analytically, with no feedback buffer.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
flat in float vCol;
flat in float vHead;
flat in float vRate;
flat in float vSeed;
uniform sampler2D uAtlas;
uniform int uCellPx;
uniform int uCount;
uniform int uRows;
uniform float uHeight;
/** Natural-log brightness decay per second (negative). */
uniform float uDecay;
uniform bool uBrightHead;
uniform vec3 uBackground;
uniform vec3 uBody;
uniform vec3 uHeadColor;
out vec4 outColor;

${HASH32_GLSL}
void main() {
  int px = int(gl_FragCoord.x);
  int py = int(uHeight - gl_FragCoord.y);
  int col = int(vCol);
  int row = py / uCellPx;
  ivec2 local = ivec2(px - col * uCellPx, py - row * uCellPx);

  uint h = hash32(uint(col) * 0x9e3779b1u ^ hash32(uint(row) + uint(vSeed) * 0x85ebca77u));
  int g = int(h % uint(uCount));
  ivec2 tile = ivec2(g % ${ATLAS_COLS}, g / ${ATLAS_COLS}) * uCellPx;
  float glyph = texelFetch(uAtlas, tile + local, 0).r;

  // Rows the head has passed, including the cell it is in now.
  float d = vHead - float(row);
  // The bright head is repainted in the body colour once the head moves on, which
  // restarts its fade; the old renderer never repainted the bottom row.
  bool isHead = uBrightHead && (d < 1.0 || row == uRows - 1);
  float age = (uBrightHead && !isHead) ? d - 1.0 : d;
  float lit = glyph * exp(uDecay * age / vRate);
  outColor = vec4(mix(uBackground, isHead ? uHeadColor : uBody, lit), 1.0);
}
`;

/** Falling columns of glyphs that fade behind a bright leading character. */
export const rain = defineEffect({
  id: "rain",
  name: "Digital Rain",
  description: "Cascading columns of glowing glyphs.",
  params: {
    fontSize: { kind: "number", label: "Glyph size", min: 8, max: 48, step: 1, default: 20 },
    speed: { kind: "number", label: "Speed", min: 1, max: 40, step: 0.5, default: 14 },
    density: { kind: "number", label: "Density", min: 0.05, max: 1, step: 0.01, default: 0.7 },
    fade: { kind: "number", label: "Trail fade", min: 0.03, max: 0.3, step: 0.005, default: 0.07 },
    charset: {
      kind: "select",
      label: "Characters",
      options: [
        { value: "katakana", label: "Katakana" },
        { value: "binary", label: "Binary" },
        { value: "hex", label: "Hex" },
        { value: "latin", label: "Latin" },
      ],
      default: "katakana",
    },
    color: { kind: "color", label: "Glyph colour", default: "#00ff66" },
    brightHead: { kind: "boolean", label: "Bright leading glyph", default: true },
    background: { kind: "color", label: "Background", default: "#000000" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const backgroundRgb = unitRgbMemo();
      const colorRgb = unitRgbMemo();
      const program = scope.add(createProgram(gl, VERTEX, FRAGMENT), (p) => gl.deleteProgram(p));
      const u = createUniforms(gl, program, [
        "uResolution",
        "uCell",
        "uCellPx",
        "uAtlas",
        "uCount",
        "uRows",
        "uHeight",
        "uDecay",
        "uBrightHead",
        "uBackground",
        "uBody",
        "uHeadColor",
      ]);
      const atlas = scope.add(gl.createTexture(), (t) => gl.deleteTexture(t));
      let atlasCell = 0;
      let atlasCharset = "";
      let glyphCount = 1;
      let batch: SpriteBatch | undefined;
      scope.defer(() => batch?.dispose());
      let capacity = 0;
      /** The batch's instance data and stride, and how many instances this frame. */
      let data: Float32Array = new Float32Array(0);
      let stride = 0;
      let emitted = 0;
      /** This frame's head length (rows) and trail length (seconds), read by `emit`. */
      let lead = 0;
      let trailAge = 0;

      let width = 1;
      let height = 1;
      let scale = 1;
      let sizeDirty = true;
      let cell = 0;
      let rows = 0;
      let cols = 0;
      // The current drop of each column, and the previous one, whose trail can still
      // be fading below the current drop's head.
      let heads = new Float32Array(0);
      let pace = new Float32Array(0);
      let seed = new Float32Array(0);
      let active = new Uint8Array(0);
      let prevHeads = new Float32Array(0);
      let prevPace = new Float32Array(0);
      let prevSeed = new Float32Array(0);
      let prevActive = new Uint8Array(0);

      const resetColumn = (c: number, density: number, scatter: boolean) => {
        heads[c] = -Math.random() * rows * (scatter ? 1.5 : 0.5);
        pace[c] = 0.6 + Math.random() * 0.8;
        seed[c] = Math.floor(Math.random() * 65536);
        active[c] = Math.random() < density ? 1 : 0;
      };

      /**
       * Fits the column grid to the canvas. With `restart` (a new cell size) every
       * column is re-scattered; otherwise (a resize) the columns already on screen
       * keep falling and only newly exposed ones are scattered, so dragging the
       * window edge doesn't restart the rain.
       */
      const layout = (density: number, restart: boolean) => {
        const keep = restart ? 0 : cols;
        cols = Math.ceil(width / cell);
        rows = Math.ceil(height / cell);
        heads = growArray(heads, cols, keep);
        pace = growArray(pace, cols, keep);
        seed = growArray(seed, cols, keep);
        active = growArray(active, cols, keep);
        prevHeads = growArray(prevHeads, cols, keep);
        prevPace = growArray(prevPace, cols, keep);
        prevSeed = growArray(prevSeed, cols, keep);
        prevActive = growArray(prevActive, cols, keep);
        for (let c = Math.min(keep, cols); c < cols; c++) {
          resetColumn(c, density, true);
          prevActive[c] = 0;
        }
        if (capacity < cols * 2) {
          batch?.dispose();
          batch = undefined;
          capacity = cols * 2;
          batch = createSpriteBatch(gl, capacity, [4, 2]);
          data = batch.data;
          stride = batch.stride;
        }
      };

      /** Appends one drop instance covering its still-visible rows from `minRow` down. */
      const emit = (c: number, head: number, rate: number, s: number, minRow: number) => {
        const r0 = Math.max(minRow, Math.floor(head - lead - trailAge * rate));
        const r1 = Math.min(rows, Math.floor(head) + 1);
        if (r0 >= r1) return;
        const o = emitted++ * stride;
        data[o] = c;
        data[o + 1] = head;
        data[o + 2] = rate;
        data[o + 3] = s;
        data[o + 4] = r0;
        data[o + 5] = r1;
      };

      /** Renders each glyph, white on black, into its own cell-sized tile (red = coverage). */
      const buildAtlas = (chars: string) => {
        const glyphs = Array.from(chars);
        glyphCount = glyphs.length;
        const canvas = new OffscreenCanvas(
          ATLAS_COLS * cell,
          Math.ceil(glyphCount / ATLAS_COLS) * cell,
        );
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Digital Rain: no 2D context for the glyph atlas");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = `${cell}px ${FONT_FAMILY}`;
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        glyphs.forEach((ch, i) => {
          const x = (i % ATLAS_COLS) * cell;
          const y = Math.floor(i / ATLAS_COLS) * cell;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, cell, cell);
          ctx.clip();
          ctx.fillText(ch, x + cell / 2, y);
          ctx.restore();
        });
        gl.bindTexture(gl.TEXTURE_2D, atlas);
        resetUnpackState(gl);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };

      return {
        resize(v) {
          if (v.width !== width || v.height !== height) sizeDirty = true;
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const newCell = Math.max(4, Math.round(p.fontSize * scale));
          if (cell !== newCell) {
            cell = newCell;
            sizeDirty = false;
            layout(p.density, true);
          } else if (sizeDirty) {
            sizeDirty = false;
            layout(p.density, false);
          }
          const charset = CHARSETS[p.charset] ? p.charset : "katakana";
          if (atlasCell !== cell || atlasCharset !== charset) {
            buildAtlas(CHARSETS[charset]);
            atlasCell = cell;
            atlasCharset = charset;
          }

          // The old renderer faded the canvas by `fade` per 60th of a second.
          const decay = 60 * Math.log(1 - p.fade);
          trailAge = Math.log(CUTOFF) / decay;
          lead = p.brightHead ? 1 : 0;

          if (!batch) return;
          emitted = 0;

          for (let c = 0; c < cols; c++) {
            heads[c] += dt * p.speed * pace[c];
            prevHeads[c] += dt * p.speed * prevPace[c];
            if (Math.floor(heads[c]) > rows + rows * 0.3 * pace[c]) {
              prevHeads[c] = heads[c];
              prevPace[c] = pace[c];
              prevSeed[c] = seed[c];
              prevActive[c] = active[c];
              resetColumn(c, p.density, false);
            }
            const head = heads[c];
            if (active[c]) emit(c, head, p.speed * pace[c], seed[c], 0);
            if (prevActive[c]) {
              // The current drop repaints the cells it has passed.
              const minRow = active[c] ? Math.max(0, Math.floor(head) + 1) : 0;
              emit(c, prevHeads[c], p.speed * prevPace[c], prevSeed[c], minRow);
            }
          }

          const bg = backgroundRgb(p.background);
          const color = colorRgb(p.color);

          gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          const n = emitted;
          if (n === 0) return;

          batch.upload(n);
          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, atlas);
          u.i1("uAtlas", 0);
          u.f2("uResolution", width, height);
          u.f1("uCell", cell);
          u.i1("uCellPx", cell);
          u.i1("uCount", glyphCount);
          u.i1("uRows", rows);
          u.f1("uHeight", height);
          u.f1("uDecay", decay);
          u.i1("uBrightHead", p.brightHead ? 1 : 0);
          u.v3("uBackground", bg);
          u.v3("uBody", color);
          // mix(color, white, 0.8)
          u.f3("uHeadColor", 0.2 * color[0] + 0.8, 0.2 * color[1] + 0.8, 0.2 * color[2] + 0.8);
          batch.draw(0, n);
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
