import { unitRgbMemo } from "./color";
import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import {
  createPieces,
  MAX_BLOBS,
  type PieceFrame,
  SEASONS,
  SHAPES,
  writeFoliage,
} from "./leaves-sim";
import { PIECE_FRAGMENT, pieceVertex } from "./pieces";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { leavesMeta } from "./leaves.meta";
import { defineEffect } from "./types";

/** Most pieces: 300 leaves, or 450 blossom petals (blossom draws 1.5x the count). */
const MAX_PIECES = 450;

/** Foliage blobs: soft discs in an octagon (apothem 1 = the blob radius). */
const BLOB_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down), opacity. */
layout(location = 1) in vec4 aBlob;
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vColor;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = vec4(aColor, aBlob.w);
  gl_Position = pxToClip(aBlob.xy + aCorner * aBlob.z, uResolution);
}
`;

/** A very soft disc, (1 - d²)² falling smoothly to zero at its radius, dithered. */
const BLOB_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vColor;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float f = max(0.0, 1.0 - dot(vLocal, vLocal));
  float a = f * f * vColor.a;
  // The ramp is wide and shallow: dither it as the background is.
  outColor = vec4(vColor.rgb * a + dither8(gl_FragCoord.xy) * a, a);
}
`;

/**
 * Autumn leaves or cherry-blossom petals drifting down in a gusty breeze, each
 * swaying like a pendulum and tumbling (spinning and flipping) as it falls, in
 * three depth layers over a soft gradient framed by out-of-focus foliage.
 */
export const leaves = defineEffect(leavesMeta, {
  create(gl) {
    return withScope((scope) => {
      // Per piece: x, y, radius, opacity; r, g, b, softness; then the spin pair.
      const pieceBatch = scope.own(
        createSpriteBatch(gl, MAX_PIECES, [4, 4], SHAPES, { rotation: true }),
      );
      const pieceProgram = scope.add(
        createProgram(gl, pieceVertex(pieceBatch.spinLocation), PIECE_FRAGMENT),
        (p) => gl.deleteProgram(p),
      );
      const pieceU = createUniforms(gl, pieceProgram, ["uResolution", "uVein"]);
      // Per blob: x, y, radius, opacity; r, g, b.
      const blobBatch = scope.own(
        createSpriteBatch(gl, MAX_BLOBS, [4, 3], [polygonStrip(8, Math.PI / 8)]),
      );
      const blobProgram = scope.add(createProgram(gl, BLOB_VERTEX, BLOB_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const blobU = createUniforms(gl, blobProgram, ["uResolution"]);
      const background = scope.own(createGradientBackground(gl));
      const bgTop = unitRgbMemo();
      const bgBottom = unitRgbMemo();

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      // CPU-only, unwrapped in float64.
      let time = 0;
      const pieces = createPieces(MAX_PIECES, refWidth);
      const f: PieceFrame = {
        refWidth,
        scale: 1,
        season: SEASONS.autumn,
        count: 0,
        size: 0,
        speed: 0,
        wind: 0,
        gusts: 0,
        hazeTop: [0, 0, 0],
        hazeBottom: [0, 0, 0],
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          pieces.rescaleX(newRefWidth / refWidth);
          ({ width, height } = v);
          refWidth = f.refWidth = newRefWidth;
          f.scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const season = SEASONS[p.season] ?? SEASONS.autumn;
          const top = bgTop(p.customBackground ? p.topColor : season.top);
          const bottom = bgBottom(p.customBackground ? p.bottomColor : season.bottom);
          f.season = season;
          f.count = p.count;
          f.size = p.size;
          f.speed = p.speed;
          f.wind = p.wind;
          f.gusts = p.gusts;
          f.hazeTop = top;
          f.hazeBottom = bottom;
          const visible = pieces.step(dt, f, pieceBatch.data, pieceBatch.stride);

          background.draw(top, bottom);

          // Source-over with premultiplied output.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

          const lean = p.wind + (p.wind < 0 ? -1 : 1) * p.gusts * pieces.gust;
          const blobs = writeFoliage(
            blobBatch.data,
            blobBatch.stride,
            time,
            p.foliage,
            lean,
            refWidth,
            f.scale,
            season,
          );
          if (blobs > 0) {
            blobBatch.upload(blobs);
            gl.useProgram(blobProgram);
            blobU.f2("uResolution", width, height);
            blobBatch.draw(0, blobs);
          }

          if (visible > 0) {
            pieceBatch.upload(visible);
            gl.useProgram(pieceProgram);
            pieceU.f2("uResolution", width, height);
            pieceU.f1("uVein", season.vein ? 1 : 0);
            for (let g = 0; g < pieces.groups; g++) {
              pieceBatch.draw(pieces.groupFirst[g], pieces.groupCount[g], pieces.groupShape[g]);
            }
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
