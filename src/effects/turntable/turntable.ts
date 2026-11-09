import { createColorEase, unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { smoothstep } from "../math";
import {
  advanceArm,
  advanceRotation,
  ARM_FLOATS,
  ARM_Y,
  armGeometry,
  armPose,
  BOKEH_COUNT,
  bokehLights,
  createArmPose,
  createArmState,
  createLayout,
  GAP_HALF,
  GROOVE_IN,
  GROOVE_OUT,
  LABEL_R,
  lightDir,
  PIVOT_BASE_H,
  PIVOT_BASE_R,
  PIVOT_X,
  PIVOT_Z,
  PLATTER_H,
  PLATTER_R,
  PLINTH_BACK,
  PLINTH_FRONT,
  PLINTH_H,
  PLINTH_LEFT,
  PLINTH_RIGHT,
  plinthFor,
  type PlinthLook,
  RECORD_R,
  RECORD_Y,
  revsPerSecond,
  roomFor,
  type RoomLook,
  SPINDLE_R,
  SURFACE_BACK,
  TRACK_GAPS,
  turntableLayout,
  VIEW_K,
  VIEW_V,
} from "./turntable-sim";
import { turntableMeta } from "./turntable.meta";
import { defineEffect } from "../types";
import { createChangeKey } from "../change-key";

/** Room pass: about 4 reference px per texel. The room is all out of focus. */
const ROOM_TEXEL_REF = 4;
/** Seconds for a change of room or plinth to crossfade. */
const ROOM_FADE = 1.5;
/** Anisotropic sheen exponent: higher makes the light cone narrower. */
const SHEEN_N = 120;
/** Tonearm radii (local units): tube, headshell, counterweight, finger lift, pillar. */
const TUBE_R = 0.0042;
const HEAD_R = 0.0068;
const WEIGHT_R = 0.013;
const FINGER_R = 0.0022;
const POST_R = 0.0062;

const g = glslFloat;
const vec2Of = (x: number, y: number) => `vec2(${g(x)}, ${g(y)})`;

/** Local screen y of the plinth's front top edge and bottom edge, and its back edge. */
const FRONT_TOP = -PLINTH_FRONT * VIEW_K;
const FRONT_BOTTOM = FRONT_TOP - PLINTH_H * VIEW_V;
const BACK_TOP = PLINTH_BACK * VIEW_K;
/** Local screen centres of the platter top, the record top and the pivot base. */
const PLATTER_TOP_Y = PLATTER_H * VIEW_V;
const RECORD_TOP_Y = RECORD_Y * VIEW_V;
const PIVOT_SY = PIVOT_Z * VIEW_K;

/**
 * The room at low resolution: a wall lit by a lamp glow on the outer side,
 * or a bright blurred window there, or a dark room; out-of-focus lights; then
 * the sideboard the turntable stands on, and a vignette. Static, so it only
 * re-renders when the room, position or size changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** +1 if the turntable (and the lamp) is on the right, -1 left. */
uniform float uSide;
/** 0: warm lamp, 1: window, 2: dark. */
uniform int uKind;
uniform vec3 uWall;
uniform vec3 uSurface;
uniform vec3 uLight;
uniform vec3 uBokehA;
uniform vec3 uBokehB;
/** Bokeh brightness, and the sideboard's back edge (height units). */
uniform vec2 uBokehSurf;
/** Bokeh lights: x (fraction of the width), y, radius, brightness. */
uniform vec4 uBokeh[${String(BOKEH_COUNT)}];
out vec4 outColor;
float box(vec2 p, vec2 lo, vec2 hi, float soft) {
  vec2 a = smoothstep(lo - soft, lo + soft, p) * (1.0 - smoothstep(hi - soft, hi + soft, p));
  return a.x * a.y;
}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  // x measured from the outer edge, where the light is.
  vec2 o = vec2(uSide > 0.0 ? uFrame.x - p.x : p.x, p.y);
  vec2 l = (o - vec2(0.22, 0.72)) * vec2(1.5, 1.2);
  float pool = 1.0 / (1.0 + 2.8 * dot(l, l));
  vec3 wall = uWall * (0.35 + 0.8 * pool) * (0.85 + 0.15 * smoothstep(1.0, 0.3, p.y));
  if (uKind == 0) {
    // The lamp itself: a soft bright shade high on the outer side.
    vec2 s = (o - vec2(0.2, 0.62)) * vec2(1.0, 1.6);
    wall += uLight * 0.55 / (1.0 + 160.0 * dot(s, s));
  } else if (uKind == 1) {
    vec2 w = (o - vec2(0.4, 0.68)) * vec2(1.4, 1.2);
    wall = uWall * (0.3 + 0.9 / (1.0 + 3.0 * dot(w, w)));
    float win = box(o, vec2(0.08, 0.38), vec2(0.72, 0.98), 0.05);
    float bars = max(1.0 - smoothstep(0.006, 0.03, abs(o.x - 0.4)),
      1.0 - smoothstep(0.006, 0.03, abs(o.y - 0.68)));
    vec3 sky = uLight * mix(1.05, 0.82, clamp((o.y - 0.38) * 1.6, 0.0, 1.0));
    wall = mix(wall, sky * max(1.0 - 0.45 * bars, 0.1), win);
  } else {
    wall *= 0.6 + 0.4 * pool;
  }
  // Out-of-focus lights: soft discs with a slightly brighter rim.
  vec3 glow = vec3(0.0);
  for (int i = 0; i < ${String(BOKEH_COUNT)}; i++) {
    vec4 b = uBokeh[i];
    float d = length(p - vec2(b.x * uFrame.x, b.y));
    float disc = 1.0 - smoothstep(b.z * 0.86, b.z, d);
    float rim = 0.75 + 0.25 * smoothstep(b.z * 0.5, b.z * 0.95, d);
    vec3 tint = mix(uBokehA, uBokehB, fract(float(i) * 0.618034));
    glow += tint * (b.w * disc * rim);
  }
  wall += glow * uBokehSurf.x * (0.4 + 0.6 * smoothstep(0.25, 0.6, p.y));
  // The sideboard: brighter towards its back edge and under the lamp.
  float onSurf = 1.0 - smoothstep(uBokehSurf.y - 0.004, uBokehSurf.y + 0.004, p.y);
  vec2 t = (o - vec2(0.25, uBokehSurf.y)) * vec2(1.0, 3.0);
  vec3 surf = uSurface * (0.5 + 0.35 * p.y / uBokehSurf.y + 0.5 / (1.0 + 3.0 * dot(t, t)));
  surf += uLight * 0.05 * smoothstep(uBokehSurf.y - 0.02, uBokehSurf.y - 0.003, p.y);
  vec3 col = mix(wall, surf, onSurf);
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.4 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The turntable at full resolution inside its box, premultiplied over the
 * room. Works in local screen units (record centre on the plinth top at the
 * origin; see turntable-sim.ts). Back to front: the plinth's soft shadow, the
 * plinth with its buttons, the platter, the record (filtered grooves, the
 * fixed anisotropic sheen, the turning label), the tonearm's shadow, then the
 * pivot, counterweight, arm, finger lift and headshell. Analytic shapes with
 * coverage antialiasing.
 */
const TURNTABLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** One device px in height units. */
uniform float uPx;
/** Record centre on the plinth top (height units), and height units per local unit. */
uniform vec3 uOrigin;
uniform vec3 uLight;
/** Unit light direction (world) and the half vector towards the viewer. */
uniform vec3 uLDir;
uniform vec3 uHalf;
/** Ambient level, label rotation (radians), 1 at 45 rpm. */
uniform vec3 uAmbRotRpm;
uniform vec3 uLabel;
uniform vec3 uPlinthTop;
uniform vec3 uPlinthFront;
/** Plinth grain and gloss, and the tonearm's lift (0..1). */
uniform vec3 uPlinthLift;
/** Tonearm segments (see ARM_* in turntable-sim.ts), local screen units. */
uniform vec4 uArm[6];
out vec4 outColor;
${DITHER_GLSL}
const float K = ${g(VIEW_K)};
const float V = ${g(VIEW_V)};
const float TAU = 6.2831853;
vec3 col;
float alpha;
float px;
void over(vec3 c, float a) {
  col = c * a + col * (1.0 - a);
  alpha = a + alpha * (1.0 - a);
}
void shade(float s) {
  col *= 1.0 - s;
  alpha = s + alpha * (1.0 - s);
}
float cov(float sdf) { return clamp(0.5 - sdf / px, 0.0, 1.0); }
/** Approximate signed distance to an ellipse of radii r. */
float sdEllipse(vec2 q, vec2 r) {
  float k0 = length(q / r);
  float k1 = max(length(q / (r * r)), 1e-6);
  return k0 * (k0 - 1.0) / k1;
}
float sdBox(vec2 q, vec2 c, vec2 h, float rad) {
  vec2 d = abs(q - c) - h + rad;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rad;
}
/** A vertical cylinder of radius r and screen height h standing at c: its silhouette. */
float sdCylinder(vec2 q, vec2 c, float r, float h) {
  vec2 d = q - c;
  float side = max(abs(d.x) - r, max(-d.y, d.y - h));
  return min(side, min(sdEllipse(d, vec2(r, r * K)), sdEllipse(d - vec2(0.0, h), vec2(r, r * K))));
}
/** Distance to segment a-b; 'n' gets a tube normal (screen space, z towards the viewer). */
float sdTube(vec2 q, vec4 s, float r, out vec3 n) {
  vec2 pa = q - s.xy;
  vec2 ba = s.zw - s.xy;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  vec2 v = pa - ba * h;
  float d = length(v);
  float across = clamp(d / r, 0.0, 1.0);
  n = vec3(v / max(d, 1e-6) * across, sqrt(1.0 - across * across));
  return d - r;
}
/** Shading for a metal or painted part with screen-space normal n. */
vec3 lit(vec3 base, vec3 n, float shine) {
  vec3 ls = normalize(vec3(uLDir.x, 0.75, 0.6));
  vec3 hs = normalize(ls + vec3(0.0, 0.0, 1.0));
  float diff = max(dot(n, ls), 0.0);
  float spec = pow(max(dot(n, hs), 0.0), 40.0);
  return base * (uAmbRotRpm.x + 0.85 * diff * uLight) + uLight * spec * shine;
}
float filteredRing(float r, float p, float fw) {
  float x = fw / p;
  return cos(TAU * r / p) * exp(-3.3 * x * x);
}
void main() {
  px = uPx / uOrigin.z;
  vec2 q = (gl_FragCoord.xy * uPx - uOrigin.xy) / uOrigin.z;
  col = vec3(0.0);
  alpha = 0.0;
  float amb = uAmbRotRpm.x;

  // The record's surface coordinates; derivatives taken here, in uniform control flow.
  vec2 w = vec2(q.x, (q.y - ${g(RECORD_TOP_Y)}) / K);
  float r = length(w);
  float fw = max(fwidth(r), 1e-6);

  // 1. The plinth's soft shadow on the sideboard, thrown forwards.
  vec2 shOff = vec2(-uLDir.x, -uLDir.z * K) * ${g(PLINTH_H)} / uLDir.y;
  float ground = sdBox(q, vec2(${g((PLINTH_RIGHT - PLINTH_LEFT) / 2)}, ${g((FRONT_BOTTOM + BACK_TOP - PLINTH_H * VIEW_V) / 2)}) + shOff,
    vec2(${g((PLINTH_LEFT + PLINTH_RIGHT) / 2)}, ${g((BACK_TOP - PLINTH_H * VIEW_V - FRONT_BOTTOM) / 2)}), 0.01);
  shade(0.5 * (1.0 - smoothstep(-0.015, 0.03, ground)));

  // 2. The plinth: front face, top face with grain, a bevel highlight, buttons.
  float pl = sdBox(q, vec2(${g((PLINTH_RIGHT - PLINTH_LEFT) / 2)}, ${g((FRONT_BOTTOM + BACK_TOP) / 2)}),
    vec2(${g((PLINTH_LEFT + PLINTH_RIGHT) / 2)}, ${g((BACK_TOP - FRONT_BOTTOM) / 2)}), 0.007);
  float pc = cov(pl);
  if (pc > 0.0) {
    float z = q.y / K;
    float grain = sin(z * 170.0 + 2.2 * sin(q.x * 6.0 + z * 11.0) + 0.8 * sin(q.x * 31.0));
    float figure = sin(z * 37.0 + q.x * 3.0);
    vec3 top = uPlinthTop * (1.0 + uPlinthLift.x * (0.1 * grain + 0.07 * figure));
    // Lit from above; a broad gloss towards the back, where the lamp reflects.
    top = top * (amb + 0.75 * uLDir.y * uLight)
      + uLight * uPlinthLift.y * smoothstep(${g(FRONT_TOP)}, ${g(BACK_TOP)}, q.y);
    float fy = clamp((q.y - ${g(FRONT_BOTTOM)}) / ${g(PLINTH_H * VIEW_V)}, 0.0, 1.0);
    vec3 front = uPlinthFront * (amb * 0.9 + 0.2 * fy * uLight);
    if (uPlinthLift.x > 0.0) front *= 1.0 + 0.08 * uPlinthLift.x * sin(q.x * 90.0 + 3.0 * sin(q.y * 140.0));
    vec3 c = mix(front, top, smoothstep(${g(FRONT_TOP)} - px, ${g(FRONT_TOP)} + px, q.y));
    // The rounded front edge catches the light.
    float edge = q.y - ${g(FRONT_TOP)};
    c += uLight * 0.18 * exp(-edge * edge * 2.0e5);
    // Start / stop at the front left; speed buttons and their light at the front right.
    vec3 metal = vec3(0.62, 0.62, 0.6);
    float start = cov(sdEllipse(q - ${vec2Of(-0.152, -0.148 * VIEW_K)}, vec2(0.016, 0.016 * K)));
    c = mix(c, lit(metal, vec3(0.0, 0.6, 0.8), 0.4), start);
    float b33 = cov(sdEllipse(q - ${vec2Of(0.215, -0.15 * VIEW_K)}, vec2(0.009, 0.009 * K)));
    float b45 = cov(sdEllipse(q - ${vec2Of(0.245, -0.15 * VIEW_K)}, vec2(0.009, 0.009 * K)));
    c = mix(c, lit(metal * 0.8, vec3(0.0, 0.6, 0.8), 0.3), max(b33, b45));
    vec2 ledAt = mix(${vec2Of(0.215, -0.128 * VIEW_K)}, ${vec2Of(0.245, -0.128 * VIEW_K)}, uAmbRotRpm.z);
    vec2 ld = (q - ledAt) / vec2(1.0, K);
    c += vec3(1.0, 0.55, 0.15) * (cov(length(ld) - 0.003) * 0.9 + 0.25 * exp(-dot(ld, ld) * 2.0e4));
    over(c, pc);
  }

  // 3. The platter: a brushed metal cylinder, its top showing round the record.
  float plat = sdCylinder(q, vec2(0.0), ${g(PLATTER_R)}, ${g(PLATTER_TOP_Y)});
  float ptc = cov(plat);
  if (ptc > 0.0) {
    float nx = clamp(q.x / ${g(PLATTER_R)}, -1.0, 1.0);
    vec3 metal = vec3(0.55, 0.55, 0.54);
    vec3 c = lit(metal, vec3(nx, 0.0, sqrt(1.0 - nx * nx)), 0.6);
    float ptop = cov(sdEllipse(q - vec2(0.0, ${g(PLATTER_TOP_Y)}), vec2(${g(PLATTER_R)}, ${g(PLATTER_R)} * K)));
    c = mix(c, metal * (amb + 0.7 * uLight), ptop);
    // The record's edge, a thin black band.
    float rside = cov(sdCylinder(q, vec2(0.0, ${g(PLATTER_TOP_Y)}), ${g(RECORD_R)}, ${g(RECORD_TOP_Y - PLATTER_TOP_Y)}));
    c = mix(c, vec3(0.02) + 0.08 * uLight * max(nx * uLDir.x, 0.0), rside);
    over(c, ptc);
  }

  // 4. The record's top surface.
  float rc = cov(sdEllipse(q - vec2(0.0, ${g(RECORD_TOP_Y)}), vec2(${g(RECORD_R)}, ${g(RECORD_R)} * K)));
  if (rc > 0.0) {
    vec2 dir = w / max(r, 1e-6);
    // Anisotropic sheen: the grooves reflect where their tangent is square to the half vector.
    float th = dot(vec2(-dir.y, dir.x), uHalf.xz);
    float sin2 = max(1.0 - th * th, 0.0);
    float aniso = pow(sin2, ${g(SHEEN_N / 2)});
    float grooved = smoothstep(${g(GROOVE_IN)} - fw, ${g(GROOVE_IN)} + fw, r)
      * (1.0 - smoothstep(${g(GROOVE_OUT)} - fw, ${g(GROOVE_OUT)} + fw, r));
    ${TRACK_GAPS.map((gap) => `grooved *= smoothstep(${g(GAP_HALF)} - fw, ${g(GAP_HALF)} + fw, abs(r - ${g(gap)}));`).join("\n    ")}
    // Groove texture, each term faded out as it nears the pixel footprint.
    float rings = 0.35 * filteredRing(r, 0.0021, fw) + 0.25 * filteredRing(r, 0.0034, fw)
      + 0.4 * filteredRing(r, 0.0091, fw) * (0.6 + 0.4 * sin(r * 170.0));
    float sheen = grooved * aniso * (0.62 + 0.38 * rings) + (1.0 - grooved) * aniso * aniso * aniso * 0.6;
    // The raised bead at the edge.
    float bead = smoothstep(${g(RECORD_R - 0.003)} - fw, ${g(RECORD_R - 0.0015)}, r);
    sheen += bead * aniso * 0.5;
    vec3 c = vec3(0.016) + amb * 0.04 + uLight * (0.55 * sheen + 0.025 * grooved);

    // The label turns with the record (clockwise from above): material angle = world angle + rotation.
    float cr = cos(uAmbRotRpm.y);
    float sr = sin(uAmbRotRpm.y);
    vec2 lw = vec2(cr * w.x - sr * w.y, sr * w.x + cr * w.y);
    float ang = atan(lw.y, lw.x);
    float lum = dot(uLabel, vec3(0.299, 0.587, 0.114));
    vec3 ink = lum > 0.45 ? uLabel * 0.28 : mix(uLabel, vec3(0.95, 0.92, 0.84), 0.8);
    vec3 lab = uLabel;
    // A printed ring near the edge.
    lab = mix(lab, ink, 0.6 * (1.0 - smoothstep(0.0006 - fw, 0.0006 + fw, abs(r - 0.0445))));
    // "Lettering": irregular dashes along two arcs.
    float aa = 1.5 * px / (K * max(r, 0.005));
    float arc1 = smoothstep(0.4, 0.4 + aa, ang) * (1.0 - smoothstep(2.7 - aa, 2.7, ang))
      * (1.0 - smoothstep(0.0024 - fw, 0.0024 + fw, abs(r - 0.0365)));
    float f1 = fract(ang * 14.0 + 0.35 * sin(ang * 37.0));
    arc1 *= smoothstep(0.32 - aa * 14.0, 0.32, f1) * (1.0 - smoothstep(0.9, 0.9 + aa * 14.0, f1));
    float arc2 = smoothstep(-2.5, -2.5 + aa, ang) * (1.0 - smoothstep(-0.7 - aa, -0.7, ang))
      * (1.0 - smoothstep(0.0014 - fw, 0.0014 + fw, abs(r - 0.027)));
    float f2 = fract(ang * 22.0 + 0.4 * sin(ang * 53.0));
    arc2 *= smoothstep(0.4 - aa * 22.0, 0.4, f2) * (1.0 - smoothstep(0.88, 0.88 + aa * 22.0, f2));
    lab = mix(lab, ink, max(arc1, arc2) * 0.85);
    // A small round logo.
    vec2 lg = lw - vec2(0.0, 0.0185);
    float logo = 1.0 - smoothstep(0.0065 - fw, 0.0065 + fw, length(lg));
    lab = mix(lab, ink, logo);
    lab = lab * (amb + 0.75 * uLDir.y * uLight) * (1.0 - 0.15 * smoothstep(0.03, ${g(LABEL_R)}, r));
    float onLabel = 1.0 - smoothstep(${g(LABEL_R)} - fw, ${g(LABEL_R)} + fw, r);
    c = mix(c, lab, onLabel);
    // The spindle.
    float spin = 1.0 - smoothstep(${g(SPINDLE_R)} - fw, ${g(SPINDLE_R)} + fw, r);
    c = mix(c, lit(vec3(0.7), normalize(vec3(w.x, 0.5 * w.y, 0.004)), 0.8), spin);
    over(c, rc);
  }

  // 5. The tonearm's shadow, softer when lifted.
  vec3 n;
  float lift = uPlinthLift.z;
  float soft = 0.004 + 0.006 * lift;
  float sh = min(sdTube(q, uArm[4], ${g(TUBE_R)}, n), sdTube(q, uArm[5], ${g(HEAD_R)}, n));
  shade((0.45 - 0.12 * lift) * (1.0 - smoothstep(-soft, soft, sh)));

  // 6. Counterweight, pivot base and pillar, arm tube, finger lift, headshell.
  vec2 pb = vec2(${g(PIVOT_X)}, ${g(PIVOT_SY)});
  float d = sdTube(q, uArm[2], ${g(WEIGHT_R)}, n);
  over(lit(vec3(0.09), n, 0.5), cov(d));
  float base = sdCylinder(q, pb, ${g(PIVOT_BASE_R)}, ${g(PIVOT_BASE_H * VIEW_V)});
  float bc = cov(base);
  if (bc > 0.0) {
    float nx = clamp((q.x - pb.x) / ${g(PIVOT_BASE_R)}, -1.0, 1.0);
    vec3 c = lit(vec3(0.12), vec3(nx, 0.0, sqrt(1.0 - nx * nx)), 0.5);
    float btop = cov(sdEllipse(q - pb - vec2(0.0, ${g(PIVOT_BASE_H * VIEW_V)}), vec2(${g(PIVOT_BASE_R)}, ${g(PIVOT_BASE_R)} * K)));
    c = mix(c, vec3(0.1) * (amb + 0.7 * uLight), btop);
    over(c, bc);
  }
  d = sdTube(q, vec4(pb + vec2(0.0, ${g(PIVOT_BASE_H * VIEW_V)}), pb + vec2(0.0, ${g(ARM_Y * VIEW_V)})), ${g(POST_R)}, n);
  over(lit(vec3(0.55), n, 0.7), cov(d));
  d = sdTube(q, uArm[0], ${g(TUBE_R)}, n);
  over(lit(vec3(0.62), n, 1.0), cov(d));
  d = sdTube(q, uArm[3], ${g(FINGER_R)}, n);
  over(lit(vec3(0.6), n, 0.8), cov(d));
  d = sdTube(q, uArm[1], ${g(HEAD_R)}, n);
  over(lit(vec3(0.06), n, 0.45), cov(d));

  // Same dither pattern as the room's blit, weighted so the blend keeps its sum.
  outColor = vec4(col + dither8(gl_FragCoord.xy) * alpha, alpha);
}
`;

/**
 * A record player in a bottom corner: the record turning at 33⅓ or 45 rpm
 * under a fixed light cone, the tonearm creeping inwards, lifting at the end
 * of the side and swinging back, and a warm, out-of-focus room behind.
 *
 * Passes: the room at 1/4 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; then the turntable in a scissored
 * full-resolution box.
 */
export const turntable = defineEffect(turntableMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);

      const roomProgram = program(ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uPxToH",
        "uFrame",
        "uSide",
        "uKind",
        "uWall",
        "uSurface",
        "uLight",
        "uBokehA",
        "uBokehB",
        "uBokehSurf",
        "uBokeh",
      ]);
      const ttProgram = program(TURNTABLE_FRAGMENT);
      const tu = createUniforms(gl, ttProgram, [
        "uPx",
        "uOrigin",
        "uLight",
        "uLDir",
        "uHalf",
        "uAmbRotRpm",
        "uLabel",
        "uPlinthTop",
        "uPlinthFront",
        "uPlinthLift",
        "uArm",
      ]);

      const layout = createLayout();
      const arm = createArmState();
      const pose = createArmPose();
      const armData = new Float32Array(ARM_FLOATS);
      const bokeh = new Float32Array(BOKEH_COUNT * 4);
      const light = new Float64Array(3);

      let width = 1;
      let height = 1;
      /** Record rotation in revolutions, wrapped to [0, 1). */
      let rotation = 0;
      /** The room shown, the one it is fading from, and how far the fade is (1: done). */
      let shownRoom = "";
      let fromRoom = "";
      let roomMix = 1;
      const drawRoom = (room: RoomLook) => {
        ru.i1("uKind", room.kind);
        ru.rgb("uWall", room.wall);
        ru.rgb("uSurface", room.surface);
        ru.rgb("uLight", room.light);
        ru.rgb("uBokehA", room.bokehA);
        ru.rgb("uBokehB", room.bokehB);
        ru.f2("uBokehSurf", room.bokeh, layout.oy + SURFACE_BACK * layout.scale);
        gl.uniform4fv(ru.loc.uBokeh, bokehLights(room.seed, bokeh));
        triangle.draw();
      };
      /**
       * The light on the turntable and the plinth's look, eased as one block:
       * the key light (RGB), ambient, plinth top and front (RGB), grain, gloss.
       */
      const lookEase = createColorEase(12);
      const lookTarget = new Float32Array(12);
      const plinthTop = lookEase.value.subarray(4, 7);
      const plinthFront = lookEase.value.subarray(7, 10);
      const lightRgb = unitRgbMemo();
      const topRgb = unitRgbMemo();
      const frontRgb = unitRgbMemo();
      const packLook = (room: RoomLook, plinth: PlinthLook) => {
        lookTarget.set(lightRgb(room.light), 0);
        lookTarget[3] = room.ambient;
        lookTarget.set(topRgb(plinth.top), 4);
        lookTarget.set(frontRgb(plinth.front), 7);
        lookTarget[10] = plinth.grain;
        lookTarget[11] = plinth.gloss;
        return lookTarget;
      };
      const roomKey = createChangeKey(3);

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          const scale = v.scale > 0 ? v.scale : height / 1080;
          target.resize(width, height, Math.max(1, ROOM_TEXEL_REF * scale));
          gl.useProgram(roomProgram);
          ru.f2(
            "uPxToH",
            target.fullWidth / target.width / height,
            target.fullHeight / target.height / height,
          );
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const rps = revsPerSecond(p.rpm);
          rotation = advanceRotation(rotation, rps, step);
          advanceArm(arm, step, rps);
          const aspect = width / height;
          turntableLayout(aspect, p.position, layout);
          const plinth = plinthFor(p.plinth);

          // 1. The room, re-rendered only when it changes, upscaled every
          //    frame. A new room crossfades from the old one, both drawn.
          if (p.room !== shownRoom) {
            if (shownRoom === "") {
              roomMix = 1;
            } else {
              // Mid-fade, fade from whichever room shows more.
              fromRoom = roomMix < 0.5 ? fromRoom : shownRoom;
              roomMix = 0;
            }
            shownRoom = p.room;
          }
          const fading = roomMix < 1;
          if (fading) {
            roomMix = Math.min(1, roomMix + step / ROOM_FADE);
          }
          const room = roomFor(shownRoom);
          // Mid-fade, the mix changes every frame; the frame it reaches 1 draws the room alone.
          roomKey.setText(0, shownRoom);
          roomKey.set(1, layout.side);
          roomKey.set(2, roomMix);
          if (target.needsRedraw(roomKey)) {
            target.bind();
            gl.useProgram(roomProgram);
            ru.f2("uFrame", aspect, 1);
            ru.f1("uSide", layout.side);
            if (roomMix < 1) {
              drawRoom(roomFor(fromRoom));
              gl.enable(gl.BLEND);
              gl.blendColor(0, 0, 0, smoothstep(0, 1, roomMix));
              gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
              drawRoom(room);
              gl.disable(gl.BLEND);
            } else {
              drawRoom(room);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          target.blit();

          // 2. The turntable, premultiplied, in its box.
          const b = layout.box;
          const x0 = Math.max(0, Math.floor(b[0] * height));
          const y0 = Math.max(0, Math.floor(b[1] * height));
          const x1 = Math.min(width, Math.ceil(b[2] * height));
          const y1 = Math.min(height, Math.ceil(b[3] * height));
          gl.viewport(0, 0, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(ttProgram);
          lightDir(layout.side, light);
          // Half vector between the light and the view (towards the viewer, from above).
          const hx = light[0];
          const hy = light[1] + VIEW_K;
          const hz = light[2] - VIEW_V;
          const hl = Math.hypot(hx, hy, hz);
          tu.f1("uPx", 1 / height);
          tu.f3("uOrigin", layout.ox, layout.oy, layout.scale);
          const look = lookEase.step(packLook(room, plinth), step, ROOM_FADE);
          tu.v3("uLight", look);
          tu.f3("uLDir", light[0], light[1], light[2]);
          tu.f3("uHalf", hx / hl, hy / hl, hz / hl);
          tu.f3("uAmbRotRpm", look[3], rotation * Math.PI * 2, p.rpm === "45" ? 1 : 0);
          tu.rgb("uLabel", p.label);
          tu.v3("uPlinthTop", plinthTop);
          tu.v3("uPlinthFront", plinthFront);
          armPose(arm, pose);
          tu.f3("uPlinthLift", look[10], look[11], pose.lift);
          gl.uniform4fv(tu.loc.uArm, armGeometry(pose, light, armData));
          triangle.draw();
          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
