/**
 * GLSL for the ships that come and go past Station Ops' viewports, built from
 * the Starship Bridge's signed-distance shapes and ray-marcher. In ship space
 * the bow is towards +z and up is +y, each about one unit long. Kinds, in
 * `SHIP_NAMES` order: a boxy runabout with long engine pods, a freighter of
 * cargo pods clamped along a spine, and a broad bronze arrowhead cruiser.
 *
 * Material ids: 0 hull, 1 blue glow, 2 red-orange glow, 3 green glow, 4 lit windows.
 */
import { SDF_GLSL, shipMarchGlsl } from "../bridge/bridge-ship-shapes";
import { SHIP_RADIUS } from "./stationops-sim";

/** Tilt (radians) towards the eye, so it looks down on each ship a little. */
const TILT = 0.22;

export const OPS_SHIP_GLSL = /* glsl */ `
${SDF_GLSL}
vec2 runabout(vec3 p) {
  vec3 q = vec3(abs(p.x), p.y, p.z);
  // A long, flat, boxy hull, its nose sloping down to a blunt wedge.
  float body = sRound(p - vec3(0.0, 0.0, -0.02), vec3(0.12, 0.06, 0.34), 0.025);
  body = max(body, dot(p - vec3(0.0, 0.0, 0.25), vec3(0.0, 0.8, 0.6)));
  bool lit = p.z > 0.2 && p.y > -0.01 && q.x < 0.095;
  vec2 r = vec2(body, lit ? 4.0 : 0.0);
  // A module across the back of the roof.
  r = sMin(r, vec2(sRound(p - vec3(0.0, 0.08, -0.17), vec3(0.09, 0.03, 0.11), 0.015), 0.0));
  // Long engine pods slung low along each side: blue along their inner faces, red at the front.
  float pod = sCap(q, vec3(0.155, -0.045, -0.36), vec3(0.155, -0.045, 0.18), 0.03);
  return sMin(r, vec2(pod, q.z > 0.17 ? 2.0 : (q.x < 0.135 ? 1.0 : 0.0)));
}

vec2 freighter(vec3 p) {
  vec3 q = vec3(abs(p.x), p.y, p.z);
  // A long spine, a cab at the front with lit windows, an engine block at the back.
  vec2 r = vec2(sRound(p, vec3(0.032, 0.032, 0.42), 0.012), 0.0);
  r = sMin(r, vec2(sRound(p - vec3(0.0, 0.02, 0.45), vec3(0.08, 0.06, 0.07), 0.03),
    p.z > 0.5 && p.y > 0.03 ? 4.0 : 0.0));
  r = sMin(r, vec2(sRound(p - vec3(0.0, 0.0, -0.46), vec3(0.11, 0.07, 0.06), 0.02),
    p.z < -0.51 && q.x < 0.08 ? 2.0 : 0.0));
  // Cargo pods clamped either side of the spine, four along it.
  float cz = clamp(floor((p.z + 0.36) / 0.18), 0.0, 3.0);
  vec3 c = q - vec3(0.085, 0.0, -0.27 + cz * 0.18);
  return sMin(r, vec2(sRound(c, vec3(0.05, 0.05, 0.075), 0.01), 0.0));
}

vec2 cruiser(vec3 p) {
  vec3 q = vec3(abs(p.x), p.y, p.z);
  // A broad, flat arrowhead, notched at the back, with a raised spine.
  float hull = sEll(p, vec3(0.42, 0.05, 0.5));
  hull = max(hull, (q.x * 0.8 + p.z * 0.6 - 0.34) * 0.8);
  hull = max(hull, (-0.32 - 0.6 * q.x - p.z) * 0.85);
  vec2 r = vec2(hull, 0.0);
  r = sMin(r, vec2(sEll(p - vec3(0.0, 0.035, -0.02), vec3(0.06, 0.045, 0.42)), p.z > 0.3 && p.y > 0.05 ? 4.0 : 0.0));
  // Two engines glowing green at the back of the spine.
  return sMin(r, vec2(sEll(q - vec3(0.07, 0.0, -0.38), vec3(0.04, 0.03, 0.06)), p.z < -0.4 ? 3.0 : 0.0));
}

vec2 opsShipMap(int kind, vec3 p) {
  if (kind == 0) {
    return runabout(p);
  }
  if (kind == 1) {
    return freighter(p);
  }
  return cruiser(p);
}

vec3 opsShipAlbedo(int kind) {
  if (kind == 0) {
    return vec3(0.6, 0.61, 0.64);
  }
  if (kind == 1) {
    return vec3(0.48, 0.44, 0.37);
  }
  return vec3(0.5, 0.4, 0.27);
}

vec3 opsShipGlow(float mat) {
  if (mat > 3.5) {
    return vec3(1.0, 0.85, 0.55);
  }
  if (mat > 2.5) {
    return vec3(0.35, 1.0, 0.45);
  }
  if (mat > 1.5) {
    return vec3(1.0, 0.35, 0.12);
  }
  return vec3(0.35, 0.65, 1.0);
}

${shipMarchGlsl({
  name: "opsShip",
  args: "int kind",
  map: (p) => `opsShipMap(kind, ${p})`,
  albedo: "opsShipAlbedo(kind)",
  glow: "opsShipGlow(h.y)",
  glowMix: "0.85",
  radius: SHIP_RADIUS,
  tilt: TILT,
})}
`;
