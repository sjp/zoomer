/**
 * Film and tape grain that shimmers slowly: each cell's value is hashed from a
 * seed, and the grain eases from one seed's values to the next with cosine and
 * sine weights, so it changes at a low rate while its contrast holds steady.
 */

/**
 * `grainAt(cell, seed)`: a cell's grain for one seed, -0.5..0.5.
 * `easedGrain(cell, seed, w)`: the grain eased from `seed` to `seed + 1` with
 * weights `w` (cos, sin of the ease's progress times pi / 2), -1..1.
 * Needs `HASH32_GLSL` (from `noise.ts`) before it.
 */
export const EASED_GRAIN_GLSL = /* glsl */ `
float grainAt(uvec2 c, uint seed) {
  return float(hash32(c.x * 0x9e3779b9u ^ hash32(c.y + seed * 0x85ebca6bu)) >> 8) * (1.0 / 16777216.0) - 0.5;
}
float easedGrain(uvec2 c, uint seed, vec2 w) {
  return (grainAt(c, seed) * w.x + grainAt(c, seed + 1u) * w.y) * 2.0;
}
`;
