import {
  beamFor,
  BEAM_HALF_WIDTH,
  catLayout,
  catPose,
  coatFor,
  createBeam,
  createCatClock,
  createCatLayout,
  createMotes,
  createPose,
  CUSHION_RX,
  CUSHION_RY,
  CUSHION_Y,
  MOTE_RADIUS,
  moteBrightness,
  SILL_BACK_Y,
  SILL_FRONT_Y,
  stepMotes,
  timeFor,
  WINDOW,
  WINDOW_BAR_X,
  WINDOW_BAR_Y,
  WINDOW_FRAME,
} from "./cat-sim";
import { catMeta, MAX_MOTES } from "./cat.meta";
import { type Rgb, unitRgbMemo } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createLowResTarget } from "./lowres";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { defineEffect } from "./types";

/** Room pass: about 3 reference px per texel. The room is all out of focus. */
const ROOM_TEXEL_REF = 3;
/** Mote brightness (additive, fraction of the sunlight colour) at full light. */
const MOTE_GAIN = 0.5;

const g = glslFloat;
const v2 = (x: number, y: number) => `vec2(${g(x)}, ${g(y)})`;
const norm = (v: readonly number[]) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const KEY = norm([-0.35, 0.75, 0.55]);
const RIM_DIR = norm([-0.55, 1]);

/**
 * The room at low resolution, in "outer" coordinates (x measured from the
 * cat's frame edge): a wall lit by the window's glow; the window with its
 * painted frame, sky, an out-of-focus tree and hedge, and glazing bars; the
 * sill's sunlit top, its nose and the shaded wall below; two backlit pot
 * plants on the ledge; the sunbeam's haze; and a vignette. Static, so it only
 * re-renders when the time of day, corner or cat size changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
uniform float uAspect;
/** +1: the cat (and the window) on the left; -1: on the right. */
uniform float uSide;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform vec3 uGarden;
uniform vec3 uSun;
uniform vec3 uWall;
uniform vec3 uSill;
/** Beam: landing point (height units) and unit direction up its axis. */
uniform vec4 uBeam;
/** Beam axis length and haze strength. */
uniform vec2 uBeamK;
out vec4 outColor;
float box(vec2 p, vec2 lo, vec2 hi, float soft) {
  vec2 a = smoothstep(lo - soft, lo + soft, p) * (1.0 - smoothstep(hi - soft, hi + soft, p));
  return a.x * a.y;
}
/** One upright blade of the snake plant: base x, lean, tip height, half-width. */
float blade(vec2 o, float x0, float lean, float h, float w) {
  float t = clamp((o.y - 0.3) / (h - 0.3), 0.0, 1.0);
  float hw = w * (1.0 - t * t) + 0.002;
  float inside = 1.0 - smoothstep(-0.006, 0.006, abs(o.x - x0 - lean * (o.y - 0.3)) - hw);
  return inside * step(0.3, o.y) * (1.0 - smoothstep(h - 0.03, h + 0.005, o.y));
}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  vec2 o = vec2(uSide > 0.0 ? p.x : uAspect - p.x, p.y);
  // Wall, lit by the window's glow.
  vec2 gw = (o - vec2(0.5, 0.62)) * vec2(0.9, 1.2);
  float glow = 1.0 / (1.0 + 2.5 * dot(gw, gw));
  vec3 col = uWall * (0.5 + 0.42 * glow);
  // Window frame (painted like the sill), then the glass.
  float frame = box(o, ${v2(WINDOW[0] - WINDOW_FRAME, WINDOW[1] - 0.01)},
    ${v2(WINDOW[2] + WINDOW_FRAME, WINDOW[3] + WINDOW_FRAME)}, 0.006);
  col = mix(col, uSill * (0.62 + 0.18 * glow), frame);
  float glass = box(o, ${v2(WINDOW[0], WINDOW[1])}, ${v2(WINDOW[2], WINDOW[3])}, 0.006);
  if (glass > 0.0) {
    float v = clamp((o.y - ${g(WINDOW[1])}) * ${g(1 / (WINDOW[3] - WINDOW[1]))}, 0.0, 1.0);
    vec3 view = mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, v));
    // A distant tree and the hedge, out of focus.
    float tree = 1.0 - smoothstep(0.75, 1.15, length((o - vec2(0.72, 0.6)) / vec2(0.2, 0.17)));
    view = mix(view, mix(uGarden, uSkyBottom, 0.45), tree * 0.85);
    float hedge = 0.43 + 0.035 * sin(o.x * 11.0 + 1.0) + 0.02 * sin(o.x * 27.0 + 2.0);
    float h = 1.0 - smoothstep(hedge - 0.02, hedge + 0.02, o.y);
    float far = 0.15 + 0.25 * clamp((o.y - ${g(WINDOW[1])}) * 5.0, 0.0, 1.0);
    view = mix(view, mix(uGarden, uSkyBottom, far), h);
    float bars = max(1.0 - smoothstep(0.008, 0.016, abs(o.x - ${g(WINDOW_BAR_X)})),
      1.0 - smoothstep(0.008, 0.016, abs(o.y - ${g(WINDOW_BAR_Y)})));
    view = mix(view, uSill * 0.7, bars);
    col = mix(col, view, glass);
  }
  // The sill: sunlit top, its rounded nose, the shaded wall below.
  if (o.y < ${g(SILL_BACK_Y + 0.004)}) {
    float top = smoothstep(${g(SILL_FRONT_Y - 0.004)}, ${g(SILL_FRONT_Y + 0.004)}, o.y)
      * (1.0 - smoothstep(${g(SILL_BACK_Y - 0.004)}, ${g(SILL_BACK_Y + 0.004)}, o.y));
    float nose = smoothstep(${g(SILL_FRONT_Y - 0.05)}, ${g(SILL_FRONT_Y - 0.042)}, o.y) * (1.0 - top)
      * step(o.y, ${g(SILL_FRONT_Y + 0.004)});
    vec3 sill = uSill * (0.72 + 0.2 * (o.y - ${g(SILL_FRONT_Y)}) * ${g(1 / (SILL_BACK_Y - SILL_FRONT_Y))});
    vec3 below = uWall * (0.36 + 0.12 * o.y * ${g(1 / SILL_FRONT_Y)});
    vec3 noseCol = uSill * (0.6 - 3.0 * (${g(SILL_FRONT_Y)} - o.y));
    vec3 c = mix(mix(below, noseCol, nose), sill, top);
    // The nose's shadow on the wall just below it.
    float under = ${g(SILL_FRONT_Y - 0.05)} - o.y;
    c *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.03, under)) * step(0.0, under);
    col = mix(col, c, smoothstep(${g(SILL_BACK_Y + 0.004)}, ${g(SILL_BACK_Y - 0.004)}, o.y));
  }
  // Two pot plants on the ledge, out of focus and backlit.
  vec3 pot = vec3(0.465, 0.27, 0.19);
  float blades = max(max(blade(o, 0.06, -0.12, 0.62, 0.022), blade(o, 0.09, 0.05, 0.7, 0.024)),
    max(blade(o, 0.115, 0.18, 0.55, 0.02), blade(o, 0.045, -0.25, 0.48, 0.018)));
  col = mix(col, uGarden * 0.45, blades);
  float potA = box(o, vec2(0.025, 0.215), vec2(0.135, 0.33), 0.007)
    * (1.0 - smoothstep(0.0, 0.01, abs(o.x - 0.08) - (0.055 - (0.33 - o.y) * 0.12)));
  col = mix(col, pot, potA);
  float bush = 1.0 - smoothstep(0.9, 1.15, length((o - vec2(0.88, 0.34)) / vec2(0.075, 0.065)));
  col = mix(col, uGarden * 0.55, bush);
  col = mix(col, pot, box(o, vec2(0.84, 0.215), vec2(0.92, 0.29), 0.007));
  // The sunbeam's haze, and the patch it lights where it lands.
  vec2 b = p - uBeam.xy;
  float along = dot(b, uBeam.zw);
  float across = b.x * uBeam.w - b.y * uBeam.z;
  float cr = clamp(1.0 - across * across * ${g(1 / (BEAM_HALF_WIDTH * BEAM_HALF_WIDTH))}, 0.0, 1.0);
  float ends = smoothstep(0.0, 0.12, along) * (1.0 - smoothstep(uBeamK.x - 0.25, uBeamK.x, along));
  col += uSun * (uBeamK.y * cr * cr * ends);
  vec2 vg = vec2(p.x / uAspect - 0.5, p.y - 0.5);
  col *= 1.0 - 0.35 * dot(vg, vg);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The cushion and the cat at full resolution inside their box, premultiplied
 * over the room. Everything is a signed-distance shape in the cat frame (see
 * cat-sim.ts), drawn back to front with coverage antialiasing: the cushion's
 * shadow on the sill, the cushion, the body (two smooth-unioned ellipses that
 * swell with each breath), the ears, the head with its closed eyes and nose,
 * the paws, and the tail (an arc of an ellipse round the front, plus a tip
 * that flicks). Each shape is shaded as a soft dome from its distance field,
 * lit by the room and the sun, with a rim light where the silhouette faces
 * the window, a contact shadow from the shapes in front of it, and tabby
 * stripes from a 1D pattern along the body's curve.
 */
const CAT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** 1 / canvas height. */
uniform float uInvH;
/** Cat frame origin (height units), side (+1: head to the right), 1 / size. */
uniform vec4 uOrigin;
/** Breath (0..1), near-ear and far-ear angles, tail-tip lift (rad). */
uniform vec4 uPose;
uniform vec3 uFur;
uniform vec3 uStripe;
uniform vec3 uPale;
uniform vec3 uEar;
uniform vec3 uNose;
uniform vec3 uLine;
uniform vec3 uCushion;
uniform vec3 uSun;
uniform vec3 uAmbient;
/** Stripe strength, pale-fur amount, rim strength. */
uniform vec3 uCoatK;
out vec4 outColor;
${DITHER_GLSL}
const vec3 KEY = vec3(${KEY.map(g).join(", ")});
const vec2 RIM_DIR = ${v2(RIM_DIR[0], RIM_DIR[1])};
const vec2 BODY_C = vec2(-0.05, 0.18);
const vec2 BODY_R = vec2(0.4, 0.2);
const vec2 HAUNCH_C = vec2(-0.21, 0.22);
const vec2 HAUNCH_R = vec2(0.24, 0.225);
const float BODY_K = 0.08;
const vec2 HEAD_C = vec2(0.3, 0.165);
const vec2 HEAD_R = vec2(0.165, 0.138);
const vec2 TAIL_C = vec2(-0.03, 0.2);
const vec2 TAIL_R = vec2(0.47, 0.185);
const float TAIL_A0 = -2.8;
const float TAIL_A1 = -0.95;
const float TAIL_W0 = 0.05;
const float TAIL_W1 = 0.042;
const float TIP_W = 0.03;
const float TIP_LEN = 0.13;

float px;
vec3 colP;
float alpha;

float cov(float d) { return clamp(0.5 - d / px, 0.0, 1.0); }
void over(vec3 c, float k) {
  colP = c * k + colP * (1.0 - k);
  alpha = k + alpha * (1.0 - k);
}
/** Approximate signed distance to an ellipse of radii r, and its outward direction. */
float sdEllipse(vec2 q, vec2 r) {
  float k0 = length(q / r);
  float k1 = max(length(q / (r * r)), 1e-6);
  return k0 * (k0 - 1.0) / k1;
}
vec2 gEllipse(vec2 q, vec2 r) { return normalize(q / (r * r) + vec2(0.0, 1e-6)); }
/** Exact signed distance to a triangle (Inigo Quilez). */
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0;
  vec2 e1 = p2 - p1;
  vec2 e2 = p0 - p2;
  vec2 v0 = p - p0;
  vec2 v1 = p - p1;
  vec2 v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
    vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
    vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
vec2 rot(vec2 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
}
/**
 * Shades a dome-like shape: g is its outward direction, s how far out from its
 * crown (0) to its edge (1), rim where the silhouette faces the window, occ the
 * contact shadow from shapes in front.
 */
vec3 shadeN(vec3 albedo, vec2 g, float s, float rim, float occ) {
  vec3 n = vec3(g * s, sqrt(max(1.0 - s * s, 0.0)));
  float diff = max(dot(n, KEY), 0.0);
  float hemi = 0.75 + 0.25 * n.y;
  vec3 c = albedo * (uAmbient * (hemi * occ) + uSun * (0.62 * diff * (0.6 + 0.4 * occ)));
  float r = rim * smoothstep(-0.1, 0.7, dot(g, RIM_DIR));
  return c + uSun * (albedo * 0.5 + 0.35) * (uCoatK.z * 0.85 * r);
}
vec3 shade(vec3 albedo, vec2 g, float d, float radius, float rim, float occ) {
  return shadeN(albedo, g, clamp(1.0 + d / radius, 0.0, 1.0), rim, occ);
}
/** Contact shadow on a shape from one in front of it at distance d. */
float occFrom(float d) { return 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.05, d)) * step(0.0, d); }
/** A stripe mask from a periodic value s (-1..1): strength k, width w (0..1). */
float stripes(float s, float k, float w) {
  float x = s - (1.0 - 2.0 * w);
  float aa = max(fwidth(x), 0.08);
  return k * smoothstep(-aa, aa, x);
}
vec3 furAt(float stripe, float pale) {
  return mix(mix(uFur, uStripe, stripe * uCoatK.x), uPale, pale * uCoatK.y);
}
/**
 * An ear in the head frame: rounded triangle (base a, base b, tip t) turned by
 * angle about its base. x: distance; y: inner-ear distance; z: height above
 * the base.
 */
vec3 ear(vec2 qh, vec2 a, vec2 b, vec2 t, float angle) {
  vec2 m = 0.5 * (a + b);
  vec2 p = rot(qh - m, -angle) + m;
  float d = sdTri(p, a, b, t) - 0.018;
  vec2 c = (a + b + t) / 3.0 - vec2(0.0, 0.01);
  float di = sdTri(p, c + (a - c) * 0.55, c + (b - c) * 0.55, c + (t - c) * 0.55) - 0.006;
  return vec3(d, di, p.y - m.y);
}
/** A closed eye: a downward arc of radius r, squashed vertically. */
float eyeLine(vec2 qh, vec2 e, float r) {
  vec2 v = (qh - e) * vec2(1.0, ${g(1 / 0.75)});
  return v.y < 0.0 ? abs(length(v) - r) : length(vec2(abs(v.x) - r, v.y));
}
void main() {
  vec2 p = gl_FragCoord.xy * uInvH;
  vec2 q = (p - uOrigin.xy) * uOrigin.w;
  q.x *= uOrigin.z;
  px = uInvH * uOrigin.w;
  colP = vec3(0.0);
  alpha = 0.0;
  float b = uPose.x;

  // The cushion's shadow on the sill.
  float sh = 1.0 - smoothstep(0.5, 1.0,
    length((q - vec2(0.03, ${g(CUSHION_Y - CUSHION_RY + 0.025)})) / vec2(0.7, 0.075)));
  over(vec3(0.0), 0.45 * sh);

  // Body: two ellipses, smooth-unioned, swelling about the base as it breathes.
  vec2 qb = q / vec2(1.0 + 0.012 * b, 1.0 + 0.04 * b);
  float d1 = sdEllipse(qb - BODY_C, BODY_R);
  float d2 = sdEllipse(qb - HAUNCH_C, HAUNCH_R);
  float hb = clamp(0.5 + 0.5 * (d2 - d1) / BODY_K, 0.0, 1.0);
  float dBody = mix(d2, d1, hb) - BODY_K * hb * (1.0 - hb);
  vec2 gBody = normalize(mix(gEllipse(qb - HAUNCH_C, HAUNCH_R), gEllipse(qb - BODY_C, BODY_R), hb));
  // Head and ears; the head rises a little with the chest.
  vec2 qh = q - HEAD_C - vec2(0.0, 0.012 * b);
  float dHead = sdEllipse(qh, HEAD_R);
  vec2 gHead = gEllipse(qh, HEAD_R);
  vec3 earN = ear(qh, vec2(0.015, 0.1), vec2(0.13, 0.065), vec2(0.12, 0.215), uPose.y);
  vec3 earF = ear(qh, vec2(-0.115, 0.075), vec2(-0.005, 0.11), vec2(-0.085, 0.21), uPose.z);
  // Paws, tucked under the chin.
  float dP1 = sdEllipse(q - vec2(0.37, 0.03), vec2(0.07, 0.034));
  float dP2 = sdEllipse(q - vec2(0.43, 0.045), vec2(0.055, 0.03));
  float dPaw = min(dP1, dP2);
  vec2 gPaw = dP1 < dP2 ? gEllipse(q - vec2(0.37, 0.03), vec2(0.07, 0.034))
    : gEllipse(q - vec2(0.43, 0.045), vec2(0.055, 0.03));
  // Tail: an arc of an ellipse round the front...
  vec2 t = q - TAIL_C;
  float th = atan(t.y / TAIL_R.y, t.x / TAIL_R.x);
  float ta = clamp((th - TAIL_A0) / (TAIL_A1 - TAIL_A0), 0.0, 1.0);
  vec2 e0 = TAIL_C + TAIL_R * vec2(cos(TAIL_A0), sin(TAIL_A0));
  vec2 e1 = TAIL_C + TAIL_R * vec2(cos(TAIL_A1), sin(TAIL_A1));
  float dArc;
  vec2 gArc;
  if (th >= TAIL_A0 && th <= TAIL_A1) {
    float de = sdEllipse(t, TAIL_R);
    dArc = abs(de) - mix(TAIL_W0, TAIL_W1, ta);
    gArc = gEllipse(t, TAIL_R) * (de < 0.0 ? -1.0 : 1.0);
  } else {
    float l0 = length(q - e0) - TAIL_W0;
    float l1 = length(q - e1) - TAIL_W1;
    dArc = min(l0, l1);
    gArc = normalize((l0 < l1 ? q - e0 : q - e1) + vec2(0.0, 1e-6));
  }
  // ...then a tapered tip along its tangent, lifted by the flick.
  vec2 td = rot(normalize(vec2(-TAIL_R.x * sin(TAIL_A1), TAIL_R.y * cos(TAIL_A1))), uPose.w);
  vec2 tp = q - e1;
  float h = clamp(dot(tp, td) / TIP_LEN, 0.0, 1.0);
  vec2 cp = tp - td * (TIP_LEN * h);
  float dTip = length(cp) - mix(TAIL_W1, TIP_W, h);
  vec2 gTip = normalize(cp + vec2(0.0, 1e-6));
  float ht = clamp(0.5 + 0.5 * (dTip - dArc) / 0.03, 0.0, 1.0);
  float dTail = mix(dTip, dArc, ht) - 0.03 * ht * (1.0 - ht);
  vec2 gTail = normalize(mix(gTip, gArc, ht) + vec2(0.0, 1e-6));
  float tailU = ht * ta * 0.85 + (1.0 - ht) * (0.85 + 0.15 * h);

  float dCat = min(min(min(dBody, dHead), min(earN.x, earF.x)), min(dPaw, dTail));
  float rim = 1.0 - smoothstep(0.0, 0.03, -dCat);

  // The cushion: a plump superellipse, flat on top and rounding over to its
  // edge, with the cat's contact shadow and piping round the top.
  vec2 cq = q - vec2(0.0, ${g(CUSHION_Y)});
  vec2 u = abs(cq) * vec2(${g(1 / CUSHION_RX)}, ${g(1 / CUSHION_RY)});
  float f = pow(u.x * u.x * u.x + u.y * u.y * u.y, ${g(1 / 3)});
  vec2 gf = sign(cq) * u * u * vec2(${g(1 / CUSHION_RX)}, ${g(1 / CUSHION_RY)});
  float dCush = (f - 1.0) / max(length(gf) / max(f * f, 1e-6), 1e-6);
  float cc = cov(dCush);
  if (cc > 0.0) {
    float sp = min(f, 1.0);
    vec3 c = shadeN(uCushion, normalize(gf + vec2(0.0, 1e-6)), sp * sp * sp, 0.0, 1.0);
    float csh = 1.0 - smoothstep(0.6, 1.0, length((q - vec2(0.02, 0.015)) / vec2(0.56, 0.11)));
    c *= 1.0 - 0.45 * csh;
    float sy = cq.y - 0.075;
    float seam = sdEllipse(vec2(cq.x, sy), vec2(${g(CUSHION_RX * 0.96)}, 0.075));
    float front = step(sy, 0.0);
    c *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.035, seam)) * step(0.0, seam) * front;
    c = mix(c, c * 1.22, (1.0 - smoothstep(0.006, 0.006 + px, abs(seam))) * front);
    over(c, cc);
  }

  // Body, with stripes fanning round the curl and a pale chest.
  float cb = cov(dBody);
  if (cb > 0.0) {
    vec2 r = q + vec2(0.06, 0.0);
    float ra = atan(r.y, r.x);
    float rr = length(r);
    float st = stripes(sin(ra * 15.0 + rr * 6.0 + 0.6 * sin(ra * 4.0)), smoothstep(0.17, 0.3, rr), 0.3);
    float chest = 1.0 - smoothstep(0.6, 1.0, length((q - vec2(0.2, 0.1)) / vec2(0.13, 0.12)));
    float occ = min(min(occFrom(dHead), occFrom(dTail)), occFrom(dPaw));
    over(shade(furAt(st, chest), gBody, dBody, 0.2, rim, occ), cb);
  }
  // Ears, far then near, behind the head.
  float ce = cov(earF.x);
  if (ce > 0.0) {
    vec3 c = shade(uFur, normalize(q - HEAD_C - vec2(-0.06, 0.16) + 1e-6), min(earF.x, -0.02), 0.05, rim, 0.75);
    c = mix(c, uEar * 0.55, cov(earF.y) * smoothstep(0.0, 0.04, earF.z));
    over(c, ce);
  }
  ce = cov(earN.x);
  if (ce > 0.0) {
    vec3 c = shade(uFur, normalize(q - HEAD_C - vec2(0.07, 0.16) + 1e-6), min(earN.x, -0.02), 0.05, rim, 1.0);
    c = mix(c, uEar * 0.8, cov(earN.y) * smoothstep(0.0, 0.04, earN.z));
    over(c, ce);
  }
  // Head: forehead stripes, pale muzzle, closed eyes and nose.
  float ch = cov(dHead);
  if (ch > 0.0) {
    float mz = (1.0 - smoothstep(0.6, 1.0, length((qh - vec2(0.06, -0.07)) / vec2(0.12, 0.085))))
      * (1.0 - smoothstep(-0.02, 0.0, qh.y));
    float forehead = smoothstep(0.05, 0.11, qh.y) * (1.0 - smoothstep(0.04, 0.12, abs(qh.x - 0.04)));
    float st = stripes(sin((qh.x - 0.03) * 70.0), forehead, 0.3);
    vec3 c = shade(furAt(st, mz), gHead, dHead, 0.13, rim, min(occFrom(dTail), occFrom(dPaw)));
    float eyes = min(eyeLine(qh, vec2(0.0), 0.028), eyeLine(qh, vec2(0.105, -0.004), 0.032));
    c = mix(c, uLine, 0.9 * (1.0 - smoothstep(0.0055, 0.0055 + px, eyes)));
    float dn = sdTri(qh, vec2(0.04, -0.035), vec2(0.085, -0.035), vec2(0.062, -0.058)) - 0.006;
    c = mix(c, uNose, cov(dn));
    over(c, ch);
  }
  float cp2 = cov(dPaw);
  if (cp2 > 0.0) over(shade(furAt(0.0, 0.55), gPaw, dPaw, 0.04, rim, occFrom(dTail)), cp2);
  float ct = cov(dTail);
  if (ct > 0.0) {
    float st = stripes(sin(tailU * 40.0), 1.0, 0.34);
    over(shade(furAt(st, 0.0), gTail, dTail, 0.05, rim, 1.0), ct);
  }
  // Same dither as the room's blit, weighted so the blend keeps its sum.
  outColor = vec4(colP + dither8(gl_FragCoord.xy) * alpha, alpha);
}
`;

const MOTE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, extent radius (device px, y down). */
layout(location = 1) in vec3 aMote;
/** Additive colour times brightness. */
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = pxToClip(aMote.xy + aCorner * aMote.z, uResolution);
}
`;

const MOTE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float t = max(1.0 - dot(vLocal, vLocal), 0.0);
  float halo = t * t;
  float core = halo * halo;
  outColor = vec4(vColor * (0.35 * halo + core), 0.0);
}
`;

/**
 * A cat asleep on a cushion on a sunny windowsill, in a bottom corner.
 *
 * Passes: the room at 1/3 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; the cushion and cat in a scissored
 * full-resolution box; then the dust motes as additive sprites.
 */
export const cat = defineEffect(catMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => gl.deleteProgram(p));

      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uPxToH",
        "uAspect",
        "uSide",
        "uSkyTop",
        "uSkyBottom",
        "uGarden",
        "uSun",
        "uWall",
        "uSill",
        "uBeam",
        "uBeamK",
      ]);
      const catProgram = program(FULLSCREEN_VERTEX, CAT_FRAGMENT);
      const cu = createUniforms(gl, catProgram, [
        "uInvH",
        "uOrigin",
        "uPose",
        "uFur",
        "uStripe",
        "uPale",
        "uEar",
        "uNose",
        "uLine",
        "uCushion",
        "uSun",
        "uAmbient",
        "uCoatK",
      ]);
      const moteProgram = program(MOTE_VERTEX, MOTE_FRAGMENT);
      const mu = createUniforms(gl, moteProgram, ["uResolution"]);
      const motes = scope.own(
        createSpriteBatch(gl, MAX_MOTES, [3, 3], [polygonStrip(8, Math.PI / 8)]),
      );

      const layout = createCatLayout();
      const beam = createBeam();
      const clock = createCatClock();
      const pose = createPose();
      const dust = createMotes(MAX_MOTES);
      const sunRgb = unitRgbMemo();
      const moteRgb: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Seconds since create, unwrapped (float64); only the pose reaches the GPU. */
      let time = 0;
      /** What the room target holds; cleared whenever it may have been reallocated. */
      let drawnRoom = "";

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          target.resize(width, height, Math.max(1, ROOM_TEXEL_REF * scale));
          gl.useProgram(roomProgram);
          ru.f2(
            "uPxToH",
            target.fullWidth / target.width / height,
            target.fullHeight / target.height / height,
          );
          drawnRoom = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const aspect = width / height;
          catLayout(aspect, p.corner, p.size, layout);
          const look = timeFor(p.time);
          const coat = coatFor(p.coat);
          beamFor(layout, look.slope, beam);

          // 1. The room, re-rendered only when it changes, upscaled every frame.
          const key = `${p.time}|${layout.side}|${layout.size}`;
          if (target.direct || drawnRoom !== key) {
            target.bind();
            gl.useProgram(roomProgram);
            ru.f1("uAspect", aspect);
            ru.f1("uSide", layout.side);
            ru.rgb("uSkyTop", look.skyTop);
            ru.rgb("uSkyBottom", look.skyBottom);
            ru.rgb("uGarden", look.garden);
            ru.rgb("uSun", look.sun);
            ru.rgb("uWall", look.wall);
            ru.rgb("uSill", look.sill);
            ru.f4("uBeam", beam.x, beam.y, beam.dx, beam.dy);
            ru.f2("uBeamK", beam.length, look.haze);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            drawnRoom = key;
          }
          target.blit();

          // 2. Cushion and cat, premultiplied, in their box.
          catPose(clock, time, pose);
          gl.viewport(0, 0, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          const bx = layout.box;
          const x0 = Math.max(0, Math.floor(bx[0] * height));
          const y0 = Math.max(0, Math.floor(bx[1] * height));
          const x1 = Math.min(width, Math.ceil(bx[2] * height));
          const y1 = Math.min(height, Math.ceil(bx[3] * height));
          gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
          gl.useProgram(catProgram);
          cu.f1("uInvH", 1 / height);
          cu.f4("uOrigin", layout.x, layout.y, layout.side, 1 / layout.size);
          cu.f4("uPose", pose.breath, pose.earNear, pose.earFar, pose.tail);
          cu.rgb("uFur", coat.fur);
          cu.rgb("uStripe", coat.stripe);
          cu.rgb("uPale", coat.pale);
          cu.rgb("uEar", coat.ear);
          cu.rgb("uNose", coat.nose);
          cu.rgb("uLine", coat.line);
          cu.rgb("uCushion", p.cushion);
          cu.rgb("uSun", look.sun);
          cu.rgb("uAmbient", look.ambient);
          cu.f3("uCoatK", coat.stripes, coat.paleAmount, coat.rim);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);

          // 3. Dust motes drifting in the beam, additive.
          stepMotes(dust, beam, time, step);
          const sun = sunRgb(look.sun);
          for (let i = 0; i < 3; i++) moteRgb[i] = sun[i] * MOTE_GAIN;
          const data = motes.data;
          const stride = motes.stride;
          const len = beam.length;
          let visible = 0;
          for (let i = 0; i < MAX_MOTES; i++) {
            const k = moteBrightness(dust, beam, i, time, p.motes);
            if (k <= 0.004) continue;
            const a = dust.along[i] * len;
            const c = dust.across[i] * BEAM_HALF_WIDTH;
            const x = beam.x + a * beam.dx + c * beam.dy;
            const y = beam.y + a * beam.dy - c * beam.dx;
            const r = MOTE_RADIUS[0] + dust.size[i] * (MOTE_RADIUS[1] - MOTE_RADIUS[0]);
            // Bigger motes are nearer and softer, so a little dimmer.
            const kk = k * (1.15 - 0.4 * dust.size[i]);
            const o = visible * stride;
            data[o] = x * height;
            data[o + 1] = (1 - y) * height;
            data[o + 2] = r * scale + 1;
            data[o + 3] = moteRgb[0] * kk;
            data[o + 4] = moteRgb[1] * kk;
            data[o + 5] = moteRgb[2] * kk;
            visible++;
          }
          if (visible > 0) {
            gl.blendFunc(gl.ONE, gl.ONE);
            motes.upload(visible);
            gl.useProgram(moteProgram);
            mu.f2("uResolution", width, height);
            motes.draw(0, visible);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
