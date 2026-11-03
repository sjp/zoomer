/**
 * Shared pine silhouettes (Misty Ridges, Snowy Window): a row of cells along x,
 * some holding a tree, each tree a cone with three tiers of branches. The caller
 * works out the cell, the tree's base height and the pixel size in its own units.
 */
import { HASH32_GLSL } from "./noise";

/**
 * GLSL for `pineCell` and `pineHalfWidth`. Includes `HASH32_GLSL`, so don't
 * include that again.
 */
export const PINE_GLSL = /* glsl */ `
${HASH32_GLSL}
/**
 * The pine in cell \`cell\` of a row that repeats every \`cells\` cells, for
 * \`seed\` (a whole number): x is 1 if the cell has a tree (a share \`density\` of
 * cells do), else 0; y the tree's centre within the cell (0.35..0.65 of a cell);
 * z its height as a share of the tallest (0.45..1).
 */
vec3 pineCell(float cell, float cells, float seed, float density) {
  uint id = uint(mod(cell, cells));
  uint hsh = hash32(id * 2654435761u + uint(seed));
  float has = float(hsh & 0xffffu) * (1.0 / 65535.0) < density ? 1.0 : 0.0;
  float r1 = float((hsh >> 16) & 0xffu) * (1.0 / 255.0);
  float r2 = float(hsh >> 24) * (1.0 / 255.0);
  return vec3(has, 0.35 + 0.3 * r1, mix(0.45, 1.0, r2));
}

/**
 * Half-width of a pine \`th\` tall at \`yr\`, the height above its base as a share
 * of \`th\` (>= 0): a cone with three tiers of branches, negative above the tip.
 */
float pineHalfWidth(float yr, float th) {
  return th * 0.28 * (1.0 - yr) * (0.72 + 0.28 * fract(yr * 3.0));
}
`;
