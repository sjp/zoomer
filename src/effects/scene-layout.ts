/** Layout helpers shared by the illustrated Scenes, which are designed at 16:9. */

/** The aspect ratio the Scenes are designed at. */
const DESIGN_ASPECT = 16 / 9;

/**
 * Design units per frame unit's worth of the frame's height: 1 at 16:9 and
 * wider (wider frames show more wall at the sides), less for narrower frames,
 * which show the whole room smaller, with more wall and ceiling above it.
 */
export function fitScale(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  return Math.min(1, a / DESIGN_ASPECT);
}

/**
 * GLSL `design(frag, res, k)`: a fragment's position in design units (frame
 * heights at 16:9, from the frame's centre, y up), given the frame's size in
 * pixels `res` and `k` from `fitScale`.
 */
export const DESIGN_GLSL = /* glsl */ `
vec2 design(vec2 frag, vec2 res, float k) {
  return (frag - 0.5 * res) / (res.y * k);
}
`;
