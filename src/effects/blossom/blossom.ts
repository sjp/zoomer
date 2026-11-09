import {
  BLOSSOM_PALETTES,
  BREEZE_SWELL,
  buildScene,
  createPetalSource,
  createPose,
  createShedder,
  MAX_BACKDROP,
  MAX_BLOSSOMS,
  MAX_SEGMENTS_PER_BRANCH,
  PETAL_SEASONS,
  type Pose,
  poseScene,
  type Scene,
  SKIES,
  writeBackdrop,
  writeBlossoms,
  writeSegments,
} from "./blossom-sim";
import { type BlossomId, blossomMeta, type CornerId, type SkyId } from "./blossom.meta";
import {
  beginFrame,
  createGradientBackground,
  createUniforms,
  DITHER_GLSL,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import { createPieces, type PieceFrame, SHAPES } from "../leaves/leaves-sim";
import { PIECE_FRAGMENT, pieceVertex } from "../pieces";
import { createSpriteBatch, polygonStrip, QUAD } from "../sprites";
import { advanceSwell } from "../sway";
import { defineEffect } from "../types";

/** Falling-petal pool. The far depth layer is never used, so about 55% can fly at once. */
const MAX_PETALS = 160;
/** Petal size (reference px, before the depth layer's scale): smaller than a blossom. */
const PETAL_SIZE = 6;
/** Fall speed relative to Falling Leaves: petals drift down slowly. */
const PETAL_SPEED = 0.8;

/**
 * Branch segments as tapered capsules: a quad around the segment, shaded with a
 * rounded, top-lit bark tone and faint lengthwise bark streaks, and a soft edge.
 */
const BRANCH_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Start x, y, end x, y (device px, y down). */
layout(location = 1) in vec4 aSegment;
/** Half thickness at the start and end (device px), shade, bark seed. */
layout(location = 2) in vec4 aStyle;
uniform vec2 uResolution;
out vec2 vLocal;
/** Length, start and end half thickness, and which way is down across the segment. */
flat out vec4 vShape;
flat out vec2 vStyle;
${TO_CLIP_GLSL}
void main() {
  vec2 a = aSegment.xy;
  vec2 d = aSegment.zw - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r0 = max(aStyle.x, 0.5);
  float r1 = max(aStyle.y, 0.5);
  // Padding for the soft edge, which reaches zero 1.1 px outside the radius.
  float u = aCorner.x < 0.0 ? -r0 - 1.5 : len + r1 + 1.5;
  float v = aCorner.y * (max(r0, r1) + 1.5);
  vLocal = vec2(u, v);
  vShape = vec4(len, r0, r1, nrm.y < 0.0 ? -1.0 : 1.0);
  vStyle = aStyle.zw;
  gl_Position = pxToClip(a + dir * u + nrm * v, uResolution);
}
`;

const BRANCH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vShape;
flat in vec2 vStyle;
uniform vec3 uBark;
uniform float uScale;
out vec4 outColor;
void main() {
  float len = vShape.x;
  float t = clamp(vLocal.x / max(len, 1e-4), 0.0, 1.0);
  float r = mix(vShape.y, vShape.z, t);
  float dx = vLocal.x - clamp(vLocal.x, 0.0, len);
  float dist = length(vec2(dx, vLocal.y)) - r;
  float coverage = clamp(0.5 - dist / 1.2, 0.0, 1.0);
  // -1 on the upper edge, +1 on the lower one.
  float across = clamp(vLocal.y / r, -1.0, 1.0) * vShape.w;
  float shade = (1.0 - 0.3 * across * across) * (1.0 - 0.22 * across);
  // Bark: slow streaks along the wood, in reference px so they scale with the frame.
  float bark = 0.9 + 0.1 * sin(vLocal.x / uScale * 0.19 + across * 2.2 + vStyle.y * 6.2832);
  vec3 c = min(uBark * vStyle.x * shade * bark, vec3(1.0));
  outColor = vec4(c * coverage, coverage);
}
`;

/** Blossoms, buds and leaves: analytic shapes in an octagon around a unit circle. */
const BLOSSOM_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y, radius (device px, y down), spin (radians). */
layout(location = 1) in vec4 aBloom;
/** Colour, then kind: 0 blossom, 1 bud, 2 leaf. */
layout(location = 2) in vec4 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vColor;
flat out vec2 vRot;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = aColor;
  vRot = vec2(cos(aBloom.w), sin(aBloom.w));
  gl_Position = pxToClip(aBloom.xy + aCorner * aBloom.z, uResolution);
}
`;

const BLOSSOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vColor;
flat in vec2 vRot;
uniform vec3 uCentre;
out vec4 outColor;
void main() {
  vec2 p = vec2(vRot.x * vLocal.x + vRot.y * vLocal.y, vRot.x * vLocal.y - vRot.y * vLocal.x);
  vec3 c = vColor.rgb;
  float e;
  if (vColor.a < 0.5) {
    // Five rounded petals with a small notch at each tip, and a pale centre.
    float r = length(p);
    vec2 q = r > 1e-5 ? p : vec2(1.0, 0.0);
    float lobe = abs(cos(2.5 * atan(q.y, q.x)));
    float edge = 0.95 * (0.4 + 0.6 * sqrt(lobe)) - 0.08 * pow(lobe, 40.0);
    e = edge - r;
    c = mix(uCentre, c, smoothstep(0.1, 0.42, r)) * (1.0 - 0.1 * smoothstep(0.55, 0.95, r));
  } else if (vColor.a < 1.5) {
    // A closed bud: an upright oval, darker at its base.
    e = (1.0 - length(p / vec2(0.62, 0.95))) * 0.6;
    c *= 0.85 + 0.15 * smoothstep(-0.9, 0.6, -p.y);
  } else {
    // A fresh leaf: a pointed lens with a paler midrib.
    e = 0.4 * (1.0 - p.y * p.y) - abs(p.x);
    c *= 0.9 + 0.12 * (1.0 - smoothstep(0.0, 0.06, abs(p.x)));
  }
  // Outside the branches, so the derivative is well defined for every pixel.
  float coverage = clamp(e / max(fwidth(e), 1e-4) + 0.5, 0.0, 1.0);
  outColor = vec4(c * coverage, coverage);
}
`;

/** The faint background tree: very soft discs in an octagon (apothem 1 = the radius). */
const BACKDROP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y, radius (device px, y down), opacity. */
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

const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vColor;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float f = max(0.0, 1.0 - dot(vLocal, vLocal));
  float a = f * f * vColor.a;
  outColor = vec4(vColor.rgb * a + dither8(gl_FragCoord.xy) * a, a);
}
`;

const cornerOf = (v: string): CornerId => (v === "topRight" || v === "both" ? v : "topLeft");
const skyOf = (v: string): SkyId => (v === "haze" || v === "dusk" ? v : "morning");
const blossomOf = (v: string): BlossomId => (v === "white" || v === "deep" ? v : "pink");

/**
 * A flowering cherry branch reaching in from a top corner against a soft spring
 * sky: tapered bark capsules and analytic five-petal blossoms, swaying with lag
 * towards the tips, shedding petals that tumble down as in Falling Leaves.
 */
export const blossom = defineEffect(blossomMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scope.own(createGradientBackground(gl));

      const backdropBatch = scope.own(
        createSpriteBatch(gl, MAX_BACKDROP, [4, 3], [polygonStrip(8, Math.PI / 8)]),
      );
      const backdropProgram = scopedProgram(gl, scope, BACKDROP_VERTEX, BACKDROP_FRAGMENT);
      const backdropU = createUniforms(gl, backdropProgram, ["uResolution"]);

      const branchBatch = scope.own(
        createSpriteBatch(gl, MAX_SEGMENTS_PER_BRANCH * 2, [4, 4], [QUAD]),
      );
      const branchProgram = scopedProgram(gl, scope, BRANCH_VERTEX, BRANCH_FRAGMENT);
      const branchU = createUniforms(gl, branchProgram, ["uResolution", "uBark", "uScale"]);

      const bloomBatch = scope.own(
        createSpriteBatch(gl, MAX_BLOSSOMS, [4, 4], [polygonStrip(8, Math.PI / 8)]),
      );
      const bloomProgram = scopedProgram(gl, scope, BLOSSOM_VERTEX, BLOSSOM_FRAGMENT);
      const bloomU = createUniforms(gl, bloomProgram, ["uResolution", "uCentre"]);

      const petalBatch = scope.own(
        createSpriteBatch(gl, MAX_PETALS, [4, 4], SHAPES, { rotation: true }),
      );
      const petalProgram = scopedProgram(
        gl,
        scope,
        pieceVertex(petalBatch.spinLocation),
        PIECE_FRAGMENT,
      );
      const petalU = createUniforms(gl, petalProgram, ["uResolution", "uVein"]);

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      // CPU-only, unwrapped in float64.
      let time = 0;
      /** Breeze swell phase, 0..1 over BREEZE_SWELL.period. */
      let phase = 0;

      let builtCorner = "";
      let builtSeed = Number.NaN;
      let builtDensity = Number.NaN;
      const state: { scene: Scene; pose: Pose } = {
        scene: { segments: [], blossoms: [], open: [] },
        pose: createPose(0, 0),
      };
      const shedder = createShedder(0x5ed);
      const pieces = createPieces(MAX_PETALS, refWidth, 0xb10, {
        spawn: createPetalSource(shedder, 0x9e7a1, state),
      });
      const f: PieceFrame = {
        refWidth,
        scale: 1,
        season: PETAL_SEASONS.pink,
        count: MAX_PETALS,
        size: PETAL_SIZE,
        speed: PETAL_SPEED,
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
          const corner = cornerOf(p.corner);
          const sky = SKIES[skyOf(p.sky)];
          const colour = blossomOf(p.blossom);
          const palette = BLOSSOM_PALETTES[colour];
          const breeze = Math.min(1, Math.max(0, p.breeze));
          const seed = Math.floor(p.seed);

          if (corner !== builtCorner || seed !== builtSeed || p.density !== builtDensity) {
            // Only on a param change: a new scene and its pose arrays.
            state.scene = buildScene(corner, seed, p.density);
            state.pose = createPose(state.scene.segments.length, state.scene.blossoms.length);
            builtCorner = corner;
            builtSeed = seed;
            builtDensity = p.density;
          }
          // A stronger breeze also moves a little faster.
          phase = advanceSwell(BREEZE_SWELL, phase, dt, 0.7 + 0.6 * breeze);
          poseScene(state.scene, phase, breeze, refWidth, state.pose);

          // Petals drift in from the branch's side: inwards, or rightwards with both.
          shedder.advance(dt, p.shedRate);
          f.season = PETAL_SEASONS[colour];
          f.wind = (corner === "topRight" ? -1 : 1) * (0.06 + 0.3 * breeze);
          f.gusts = 0.6 * breeze;
          f.hazeTop = sky.top;
          f.hazeBottom = sky.bottom;
          const petals = pieces.step(dt, f, petalBatch.data, petalBatch.stride);

          background.draw(sky.top, sky.bottom);

          // Source-over with premultiplied output from here on.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

          if (p.background) {
            const side = corner === "topRight" ? 0 : 1;
            const n = writeBackdrop(
              backdropBatch.data,
              side,
              time,
              refWidth,
              f.scale,
              sky,
              palette,
            );
            backdropBatch.upload(n);
            gl.useProgram(backdropProgram);
            backdropU.f2("uResolution", width, height);
            backdropBatch.draw(0, n);
          }

          const segments = writeSegments(
            state.scene,
            state.pose,
            refWidth,
            f.scale,
            branchBatch.data,
          );
          if (segments > 0) {
            branchBatch.upload(segments);
            gl.useProgram(branchProgram);
            branchU.f2("uResolution", width, height);
            branchU.v3("uBark", sky.bark);
            branchU.f1("uScale", f.scale);
            branchBatch.draw(0, segments);
          }

          const blooms = writeBlossoms(state.scene, state.pose, palette, f.scale, bloomBatch.data);
          if (blooms > 0) {
            bloomBatch.upload(blooms);
            gl.useProgram(bloomProgram);
            bloomU.f2("uResolution", width, height);
            bloomU.v3("uCentre", palette.centre);
            bloomBatch.draw(0, blooms);
          }

          if (petals > 0) {
            petalBatch.upload(petals);
            gl.useProgram(petalProgram);
            petalU.f2("uResolution", width, height);
            petalU.f1("uVein", 0);
            for (let g = 0; g < pieces.groups; g++) {
              petalBatch.draw(pieces.groupFirst[g], pieces.groupCount[g], pieces.groupShape[g]);
            }
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
