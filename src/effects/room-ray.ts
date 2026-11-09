/**
 * GLSL shared by the Scenes whose rooms are ray-traced into a cached pass (the
 * starship bridge, mission control, the station ring): the camera's rays, a
 * rectangle distance and the supersampling pattern.
 */
import { glslFloat as g } from "./gl";

/**
 * `FORWARD`, `UPV` and `TAN_HALF` for a camera looking along `forward` (in the
 * y-z plane) with `up`, and `rayDir(ndc, aspect)`: the unnormalised ray through
 * a point in normalised device coordinates.
 */
export const cameraRayGlsl = (
  forward: readonly number[],
  up: readonly number[],
  tanHalf: number,
) => /* glsl */ `
const vec3 FORWARD = vec3(0.0, ${g(forward[1])}, ${g(forward[2])});
const vec3 UPV = vec3(0.0, ${g(up[1])}, ${g(up[2])});
const float TAN_HALF = ${g(tanHalf)};
vec3 rayDir(vec2 ndc, float aspect) {
  vec2 a = ndc * vec2(TAN_HALF * aspect, TAN_HALF);
  return vec3(a.x, FORWARD.y + a.y * UPV.y, FORWARD.z + a.y * UPV.z);
}
`;

/** `sdRect(p, rect, radius)`: distance to a rectangle given as (x0, y0, x1, y1), rounded by `radius`. */
export const SD_RECT_GLSL = /* glsl */ `
float sdRect(vec2 p, vec4 r, float rad) {
  vec2 c = 0.5 * (r.xy + r.zw);
  vec2 h = 0.5 * (r.zw - r.xy) - rad;
  vec2 q = abs(p - c) - h;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
`;

/** `SS4_OFFSETS`: the four sub-pixel offsets of a rotated-grid supersample, in pixels. */
export const SUPERSAMPLE4_GLSL = /* glsl */ `
const vec2 SS4_OFFSETS[4] = vec2[4](vec2(-0.25, -0.125), vec2(0.125, -0.25), vec2(0.25, 0.125), vec2(-0.125, 0.25));
`;
