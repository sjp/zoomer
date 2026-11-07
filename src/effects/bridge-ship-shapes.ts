/**
 * GLSL for the Starship Bridge's visiting ships: each one built from a few
 * signed-distance shapes (boxes, ellipsoids, capsules), in ship space with the
 * bow towards +z, up +y, about one unit long. `shipHit` ray-marches the chosen
 * ship inside its bounding sphere and shades it, so the cost is paid only on
 * the pixels near it, and only while one is in view.
 *
 * Material ids: 0 hull, 1 blue glow, 2 red-orange glow, 3 green glow.
 */
import { glslFloat as g } from "./gl";

/** Camera focal length for the outside view, in view heights. */
export const SHIP_FOCAL = 1.8;
/** Distance of a visiting ship from the camera. */
export const SHIP_DISTANCE = 4;
/** Radius of the sphere every ship (at scale 1) fits inside. */
export const SHIP_RADIUS = 0.75;
/** Tilt (radians) towards the eye, so it looks down on each ship a little. */
export const SHIP_TILT = 0.28;

export const SHIP_GLSL = /* glsl */ `
float sBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}
float sRound(vec3 p, vec3 b, float r) {
  return sBox(p, b - r) - r;
}
float sEll(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-6);
}
float sCap(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
vec2 sMin(vec2 a, vec2 b) {
  return a.x < b.x ? a : b;
}
mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

vec2 borgCube(vec3 p) {
  // Plates at different depths over the faces, and dim green light leaking from
  // some of the seams between them.
  vec3 cell = floor(p * 9.0);
  float h = fract(sin(dot(cell, vec3(12.9, 78.2, 37.7))) * 43758.5);
  float d = sBox(p, vec3(0.3)) + 0.006 * h;
  vec3 f = abs(fract(p * 9.0) - 0.5);
  float seam = min(f.x, min(f.y, f.z));
  return vec2(d, seam < 0.05 && h > 0.6 ? 3.0 : 0.0);
}

vec2 birdOfPrey(vec3 p) {
  vec2 r = vec2(sEll(p - vec3(0.0, 0.0, -0.1), vec3(0.16, 0.07, 0.2)), 0.0);
  r = sMin(r, vec2(sCap(p, vec3(0.0, 0.0, 0.05), vec3(0.0, -0.02, 0.32), 0.035), 0.0));
  r = sMin(r, vec2(sEll(p - vec3(0.0, -0.03, 0.4), vec3(0.08, 0.055, 0.09)), p.z > 0.47 ? 2.0 : 0.0));
  // Wings swept down from the body, tapering towards the tips.
  vec3 w = vec3(abs(p.x), p.y, p.z) - vec3(0.1, 0.0, -0.14);
  w.xy = rot2(0.25) * w.xy;
  float along = clamp(w.x / 0.52, 0.0, 1.0);
  w.x -= 0.26;
  w.z += 0.03 * along;
  float wing = sRound(w, vec3(0.26, 0.022, 0.15 - 0.07 * along), 0.01);
  r = sMin(r, vec2(wing * 0.8, 0.0));
  // Cannons at the wingtips.
  vec3 t = vec3(abs(p.x), p.y, p.z);
  r = sMin(r, vec2(sCap(t, vec3(0.6, -0.13, -0.12), vec3(0.6, -0.13, 0.08), 0.02), t.z > 0.06 ? 2.0 : 0.0));
  return r;
}

vec2 federation(vec3 p) {
  vec2 r = vec2(sEll(p - vec3(0.0, 0.04, 0.22), vec3(0.44, 0.055, 0.4)), 0.0);
  r = sMin(r, vec2(sEll(p - vec3(0.0, 0.1, 0.22), vec3(0.08, 0.035, 0.07)), 0.0));
  r = sMin(r, vec2(sRound(p - vec3(0.0, -0.05, -0.02), vec3(0.045, 0.07, 0.12), 0.03), 0.0));
  r = sMin(r, vec2(sEll(p - vec3(0.0, -0.13, -0.22), vec3(0.12, 0.11, 0.34)), 0.0));
  // The navigational deflector at the front of the engineering hull.
  r = sMin(r, vec2(sEll(p - vec3(0.0, -0.13, 0.1), vec3(0.065, 0.065, 0.025)), 1.0));
  vec3 q = vec3(abs(p.x), p.y, p.z);
  r = sMin(r, vec2(sCap(q, vec3(0.06, -0.12, -0.3), vec3(0.3, 0.0, -0.36), 0.018), 0.0));
  float nacelle = sCap(q, vec3(0.3, 0.02, -0.64), vec3(0.3, 0.02, -0.06), 0.05);
  float mat = q.z > -0.1 ? 2.0 : (q.x < 0.27 ? 1.0 : 0.0);
  return sMin(r, vec2(nacelle, mat));
}

vec2 warbird(vec3 p) {
  vec2 r = vec2(sEll(p - vec3(0.0, 0.0, 0.56), vec3(0.07, 0.05, 0.1)), 0.0);
  r = sMin(r, vec2(sCap(p, vec3(0.0, 0.0, 0.16), vec3(0.0, 0.0, 0.5), 0.032), 0.0));
  // Two arched hulls, above and below, joined fore and aft: a loop seen from the side.
  vec2 q = vec2(p.y, p.z + 0.06);
  vec2 rr = vec2(0.26, 0.4);
  float k0 = length(q / rr);
  float k1 = length(q / (rr * rr));
  float loop = abs(k0 * (k0 - 1.0) / max(k1, 1e-6)) - 0.022;
  // Seen from above, an ellipse: widest amidships, narrowing where the hulls meet.
  vec2 u = vec2(p.x, p.z + 0.06);
  vec2 ur = vec2(0.48, 0.44);
  float j0 = length(u / ur);
  float j1 = length(u / (ur * ur));
  float plan = j0 * (j0 - 1.0) / max(j1, 1e-6);
  r = sMin(r, vec2(max(loop, plan) * 0.9, p.z < -0.4 ? 3.0 : 0.0));
  return r;
}

vec2 marauder(vec3 p) {
  // A flat crescent opening aft, with a raised command section.
  float outer = length(p.xz) - 0.46;
  float cut = length(p.xz - vec2(0.0, -0.34)) - 0.3;
  float thick = abs(p.y) - (0.055 - 0.04 * clamp(length(p.xz) / 0.46, 0.0, 1.0));
  vec2 r = vec2(max(max(outer, -cut), thick) * 0.8, 0.0);
  r = sMin(r, vec2(sEll(p - vec3(0.0, 0.04, 0.14), vec3(0.14, 0.06, 0.16)), 0.0));
  r = sMin(r, vec2(sEll(p - vec3(0.0, -0.03, 0.42), vec3(0.06, 0.03, 0.04)), 3.0));
  return r;
}

vec2 galor(vec3 p) {
  // A long spine with a wide crescent bow and small fins aft.
  vec2 r = vec2(sEll(p - vec3(0.0, 0.0, -0.12), vec3(0.07, 0.06, 0.46)), 0.0);
  float bow = max(sEll(p - vec3(0.0, 0.0, 0.28), vec3(0.4, 0.04, 0.2)),
    -sEll(p - vec3(0.0, 0.0, 0.46), vec3(0.26, 0.1, 0.18)));
  r = sMin(r, vec2(bow, 0.0));
  r = sMin(r, vec2(sEll(p - vec3(0.0, 0.0, 0.32), vec3(0.04, 0.035, 0.05)), 2.0));
  vec3 q = vec3(abs(p.x), p.y, p.z);
  r = sMin(r, vec2(sRound(q - vec3(0.12, 0.0, -0.48), vec3(0.08, 0.008, 0.05), 0.005), 0.0));
  return r;
}

vec2 shuttle(vec3 p) {
  float body = sRound(p, vec3(0.1, 0.075, 0.2), 0.03);
  body = max(body, dot(p - vec3(0.0, 0.0, 0.13), normalize(vec3(0.0, 0.6, 0.8))));
  vec2 r = vec2(body, 0.0);
  vec3 q = vec3(abs(p.x), p.y, p.z);
  float pod = sRound(q - vec3(0.13, -0.03, -0.04), vec3(0.025, 0.025, 0.14), 0.012);
  return sMin(r, vec2(pod, q.z > 0.08 ? 2.0 : 1.0));
}

vec2 shipMap(int kind, vec3 p) {
  if (kind == 0) {
    return borgCube(p);
  }
  if (kind == 1) {
    return birdOfPrey(p);
  }
  if (kind == 2) {
    return federation(p);
  }
  if (kind == 3) {
    return warbird(p);
  }
  if (kind == 4) {
    return marauder(p);
  }
  if (kind == 5) {
    return galor(p);
  }
  return shuttle(p);
}

vec3 shipAlbedo(int kind) {
  if (kind == 0) {
    return vec3(0.16, 0.17, 0.16);
  }
  if (kind == 1) {
    return vec3(0.36, 0.4, 0.31);
  }
  if (kind == 3) {
    return vec3(0.28, 0.42, 0.3);
  }
  if (kind == 4) {
    return vec3(0.58, 0.38, 0.22);
  }
  if (kind == 5) {
    return vec3(0.6, 0.53, 0.36);
  }
  return vec3(0.72, 0.73, 0.76);
}

vec3 shipGlow(float mat) {
  if (mat > 2.5) {
    return vec3(0.25, 1.0, 0.35);
  }
  if (mat > 1.5) {
    return vec3(1.0, 0.35, 0.12);
  }
  return vec3(0.35, 0.65, 1.0);
}

// Ray-marches ship kind from the eye at the origin along d (unit), with the
// ship at centre c, scale s and turn yaw. Returns colour and coverage; px is
// the angular size of a pixel, for soft edges.
vec4 shipHit(int kind, vec3 d, vec3 c, float s, float yaw, vec3 light, float px) {
  float rad = ${g(SHIP_RADIUS)} * s;
  float b = dot(d, c);
  float disc = b * b - dot(c, c) + rad * rad;
  if (disc <= 0.0) {
    return vec4(0.0);
  }
  float t = max(0.0, b - sqrt(disc));
  float tEnd = b + sqrt(disc);
  // Bow points along f; at yaw 0 it faces the eye.
  vec3 f = vec3(sin(yaw), 0.0, -cos(yaw));
  vec3 r = vec3(-cos(yaw), 0.0, -sin(yaw));
  float near = 1e9;
  for (int i = 0; i < 72; i++) {
    vec3 w = (d * t - c) / s;
    // Seen from a little above, which shows the flat ships' shapes.
    w.yz = rot2(${g(SHIP_TILT)}) * w.yz;
    vec3 p = vec3(dot(w, r), w.y, dot(w, f));
    vec2 h = shipMap(kind, p);
    float dist = h.x * s;
    near = min(near, dist / t);
    if (dist < 0.0005 * t) {
      // Normal, by central differences in ship space.
      vec2 e = vec2(0.002, 0.0);
      vec3 n = normalize(vec3(
        shipMap(kind, p + e.xyy).x - shipMap(kind, p - e.xyy).x,
        shipMap(kind, p + e.yxy).x - shipMap(kind, p - e.yxy).x,
        shipMap(kind, p + e.yyx).x - shipMap(kind, p - e.yyx).x));
      // Back to view space.
      vec3 nv = normalize(n.x * r + vec3(0.0, n.y, 0.0) + n.z * f);
      nv.yz = rot2(${g(-SHIP_TILT)}) * nv.yz;
      vec3 albedo = shipAlbedo(kind) * (0.9 + 0.1 * fract(sin(dot(floor(p * 24.0), vec3(12.9, 78.2, 37.7))) * 43758.5));
      float diff = max(0.0, dot(nv, light));
      float rim = pow(1.0 - max(0.0, dot(nv, -d)), 3.0);
      float spec = pow(max(0.0, dot(reflect(d, nv), light)), 24.0);
      vec3 col = albedo * (0.06 + 0.95 * diff) + 0.18 * spec + albedo * rim * 0.15;
      if (h.y > 0.5) {
        col = mix(col, shipGlow(h.y), h.y > 2.5 && kind == 0 ? 0.55 : 0.9);
      }
      return vec4(col, 1.0);
    }
    t += max(dist, 0.0005 * t);
    if (t > tEnd) {
      break;
    }
  }
  // Missed: soften the silhouette by how close the ray came.
  float cov = 1.0 - smoothstep(0.0, px * 1.5, near);
  return vec4(shipAlbedo(kind) * 0.05 * cov, cov);
}
`;
