/**
 * The cloud tops of the sea of clouds, shared with other effects that fly over
 * a cloud deck: three octaves of the billow texture (`buildBillowTexture` in
 * `cloudsea-sim.ts`), each rotated to hide the shared lattice, summed into a
 * height and a world gradient for the normals, with octaves finer than a
 * pixel's footprint faded out. The drift moves each octave's uv offset, wrapped
 * to one tile.
 */
import { glslFloat } from "../gl";
import { BILLOW_CELLS } from "./cloudsea-sim";
import { wrap } from "../math";

const f = glslFloat;

/**
 * The three octaves of the cloud tops: tiles per world unit, rotation (radians,
 * to hide the shared lattice) and weight. Billows about 2 world units across at
 * the first octave.
 */
export const OCTAVES = [
  { scale: 0.12, angle: 0, weight: 1 },
  { scale: 0.31, angle: 0.6, weight: 0.45 },
  { scale: 0.83, angle: -0.9, weight: 0.2 },
] as const;

/** World height of the cloud tops per unit of the summed noise, for the normals. */
export const RELIEF = 0.18;

/** Octave k's matrix rows, world (x, z) to tile uv, as GLSL `mat2` columns. */
const octaveMatrix = (k: number) => {
  const { scale, angle } = OCTAVES[k];
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  // uv = M w with M = scale * R(angle); GLSL mat2 is column-major.
  return `mat2(${f(c)}, ${f(s)}, ${f(-s)}, ${f(c)})`;
};

/**
 * GLSL for the cloud tops. The including shader declares `uniform sampler2D
 * uBillow` (the billow texture, repeating) before it.
 *
 * - `float cloudTops(vec2 w, float foot, vec4 offA, vec2 offB, float slope, out vec2 g)`:
 *   the summed height at world point `w` (x across, z away), with `foot` world
 *   units per pixel, octave offsets (0.xy, 1.xy) in `offA` and 2 in `offB`, and
 *   the texture's slope scale; its world gradient goes in `g`.
 * - `RELIEF`: the tops' world height per unit of that sum, for normals.
 */
export const CLOUD_TOPS_GLSL = /* glsl */ `
const float RELIEF = ${f(RELIEF)};
/** Finest lattice cells per tile, for the footprint fade. */
const float FINE_CELLS = ${f(BILLOW_CELLS * 4)};
const mat2 M0 = ${octaveMatrix(0)};
const mat2 M1 = ${octaveMatrix(1)};
const mat2 M2 = ${octaveMatrix(2)};
const float S0 = ${f(OCTAVES[0].scale)};
const float S1 = ${f(OCTAVES[1].scale)};
const float S2 = ${f(OCTAVES[2].scale)};
const float A0 = ${f(OCTAVES[0].weight)};
const float A1 = ${f(OCTAVES[1].weight)};
const float A2 = ${f(OCTAVES[2].weight)};

/** Weight of an octave with \`s\` tiles per world unit at a footprint of \`w\` world units per pixel. */
float octaveFade(float w, float s) {
  return 1.0 - smoothstep(0.35, 1.0, w * s * FINE_CELLS * 0.5);
}

/** One octave: adds its height to h and its world gradient to g. */
void octave(vec2 w, mat2 M, vec2 off, float a, float slope, inout float h, inout vec2 g) {
  vec3 t = textureLod(uBillow, M * w + off, 0.0).rgb * 2.0 - 1.0;
  h += a * t.r;
  // uv = M w + off, so d/dw = transpose(M) d/duv.
  g += a * (transpose(M) * t.gb) * slope;
}

float cloudTops(vec2 w, float foot, vec4 offA, vec2 offB, float slope, out vec2 g) {
  float h = 0.0;
  g = vec2(0.0);
  float a0 = A0 * octaveFade(foot, S0);
  float a1 = A1 * octaveFade(foot, S1);
  float a2 = A2 * octaveFade(foot, S2);
  if (a0 > 0.0) octave(w, M0, offA.xy, a0, slope, h, g);
  if (a1 > 0.0) octave(w, M1, offA.zw, a1, slope, h, g);
  if (a2 > 0.0) octave(w, M2, offB, a2, slope, h, g);
  return h;
}
`;

/**
 * Moves the cloud tops by (`vx`, `vz`) world units (x across, z away), updating
 * each octave's uv offset in `offsets` (x and y per octave, from index 0),
 * wrapped to one tile of its own uv space.
 */
export function driftTops(offsets: Float64Array, vx: number, vz: number): void {
  for (let k = 0; k < OCTAVES.length; k++) {
    const { scale: s, angle } = OCTAVES[k];
    const c = Math.cos(angle) * s;
    const sn = Math.sin(angle) * s;
    offsets[2 * k] = wrap(offsets[2 * k] + c * vx - sn * vz, 0, 1);
    offsets[2 * k + 1] = wrap(offsets[2 * k + 1] + sn * vx + c * vz, 0, 1);
  }
}
