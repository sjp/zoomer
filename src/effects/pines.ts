/**
 * Shared pine silhouettes (Misty Ridges, Snowy Window, Meteor Shower): a row of cells along x,
 * some holding a tree. Small, distant trees can use the simple cone with three
 * tiers (\`pineHalfWidth\`); larger ones the spruce with drooping, snow-laden tiers
 * (\`pineSpruce\`). The caller works out the cell, the tree's base height and the
 * pixel size in its own units.
 */
import { HASH32_GLSL } from "./noise";

/**
 * GLSL for `pineCell`, `pineHalfWidth` and `pineSpruce`. Includes `HASH32_GLSL`, so don't
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

/**
 * A spruce \`th\` tall, at \`q\`: x across from its axis and y the height above its
 * base as a share of \`th\` (0..1). \`tiers\` layers of branches droop toward their
 * tips and alternate between the sides; \`r\` (0..1) varies the tree. Returns x
 * the signed distance inside the silhouette (height units, for anti-aliasing),
 * y the snow lying along the upper side of each tier (0..1) and z the shadow
 * under each tier and toward the trunk (0..1).
 */
vec3 pineSpruce(vec2 q, float th, float tiers, float r) {
  float yr = q.y;
  float ax = abs(q.x) / th;
  float droop = mix(0.3, 0.7, 1.0 - yr);
  float yy = yr * tiers + droop * ax * tiers + (q.x < 0.0 ? 0.0 : 0.5) + r * 0.3;
  // 0 at a tier's tips (its lower edge), 1 at its top.
  float t = fract(yy);
  float env = 0.33 * pow(max(1.0 - yr, 0.0), 0.95);
  float flare = 0.6 + 0.4 * (1.0 - t) * (1.0 - t);
  // Ragged clumps of needles along the tips.
  float rag = 1.0 + 0.045 * sin(yy * 19.0 + r * 40.0) + 0.03 * sin(yy * 47.0 + r * 13.0);
  float hw = env * flare * rag * smoothstep(0.04, 0.09, yr);
  if (yr < 0.08) hw = max(hw, 0.022);
  float across = ax / max(env * flare, 1e-4);
  float lumps = 0.65 + 0.35 * sin(ax * 31.0 + floor(yy) * 2.7 + r * 9.0);
  float snow = lumps * smoothstep(0.03, 0.1, t) * (1.0 - smoothstep(0.2, 0.36, t))
    * smoothstep(0.25, 0.75, across) * smoothstep(0.08, 0.14, yr) * (1.0 - smoothstep(0.88, 0.97, yr));
  float shade = 0.5 * (1.0 - smoothstep(0.0, 0.18, t)) + 0.3 * (1.0 - smoothstep(0.0, 0.5, across));
  return vec3((hw - ax) * th, snow, shade);
}
`;
