/**
 * The falling-leaves piece shaders, shared by Falling Leaves and Blossom Branch:
 * a leaf or petal fan strip (see `fanStrip` in `leaves-sim.ts`) with a spin pair
 * from a `createSpriteBatch(..., { rotation: true })` batch, a soft rim and an
 * optional midrib. Instances are the `PIECE_FLOATS` that `createPieces` writes.
 */
import { TO_CLIP_GLSL } from "./gl";
import { SPRITE_SPIN_GLSL } from "./sprites";

/**
 * Vertex shader for one leaf or petal. Each shape is a fan strip (see `fanStrip`)
 * whose centre is the only corner at the origin, so `vEdge` runs 0 at the centre
 * to 1 on the rim: `(1 - vEdge) / fwidth(vEdge)` is then the distance to the
 * edge in pixels, for the anti-aliased (or blurred) rim without a texture.
 */
export const pieceVertex = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down), opacity. */
layout(location = 1) in vec4 aPiece;
/** Shaded colour, then edge softness as a fraction of the radius. */
layout(location = 2) in vec4 aTint;
/** In-plane angle (radians), flip scale. */
layout(location = ${String(spinLocation)}) in vec2 aSpin;
uniform vec2 uResolution;
out float vEdge;
out float vAcross;
flat out vec4 vColor;
flat out float vSoft;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vec2 px = aPiece.xy + spinCorner(aCorner, aSpin) * aPiece.z;
  vEdge = dot(aCorner, aCorner) > 0.0 ? 1.0 : 0.0;
  vAcross = aCorner.x;
  vColor = vec4(aTint.rgb, aPiece.w);
  vSoft = aTint.a;
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * The piece's flat, pre-shaded colour with a soft rim and, for leaves, a faint
 * midrib. Output is premultiplied for source-over blending.
 */
export const PIECE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vEdge;
in float vAcross;
flat in vec4 vColor;
flat in float vSoft;
uniform float uVein;
out vec4 outColor;
void main() {
  // About a pixel of anti-aliasing, or the depth blur when that is wider.
  float edge = clamp((1.0 - vEdge) / max(fwidth(vEdge), vSoft), 0.0, 1.0);
  // Midrib: a thin darker line down the leaf's axis, fading out once it would be
  // thinner than a pixel so small far leaves don't shimmer.
  float hw = max(0.035, fwidth(vAcross));
  float vein = uVein * (0.035 / hw) * (1.0 - smoothstep(0.0, hw, abs(vAcross)));
  float a = edge * vColor.a;
  outColor = vec4(vColor.rgb * (1.0 - 0.3 * vein) * a, a);
}
`;
