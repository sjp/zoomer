/**
 * 2D signed-distance helpers shared by the illustrated Scenes, which draw in
 * design units (frame heights) and anti-alias every edge over one pixel.
 *
 * `SDF2D_GLSL` declares the global `px` (one pixel in design units: set it at the
 * top of `main`), `cover(d)` (the pixel coverage of a shape at signed distance
 * `d`), a rounded box `sdBox(p, halfSize, radius)`, a segment `sdSeg(p, a, b)`
 * and `TAU`.
 */
export const SDF2D_GLSL = /* glsl */ `
float px;
float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}
float sdBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
const float TAU = 6.28318530718;
`;
