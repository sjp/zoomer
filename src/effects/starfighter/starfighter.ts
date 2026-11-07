import { SDF_GLSL, shipMarchGlsl } from "../bridge/bridge-ship-shapes";
import { NOISE_GLSL } from "../cockpit/cockpit-layout";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
} from "../gl";
import { lowResSize } from "../lowres";
import { createStreakRenderer } from "../streaks";
import { createSwell, swayAt } from "../sway";
import { defineEffect } from "../types";
import { createStarfield, type StarFrame } from "../warp/warp-sim";
import { starfighterMeta } from "./starfighter.meta";
import {
  createDomeState,
  createIndicator,
  createWingman,
  domeAt,
  DROID_PITCH,
  DROID_R,
  DROID_REST,
  DROID_X,
  DROID_Y,
  indicatorAt,
  WING_DISTANCE,
  WING_FOCAL,
  wingmanAt,
} from "./starfighter-sim";

const f = glslFloat;

/** Most stars, and how many recede at once. */
const MAX_STARS = 900;
const STAR_COUNT = 800;
/** Negative: the stars recede, slowly, from a camera looking back. */
const STAR_SPEED = -0.03;
/** Star size (1080p px). */
const STAR_SIZE = 2;
/** The sky is smooth and still, so it renders once, at 1/2 size. */
const SKY_DIVISOR = 2;
/** Seconds after which the lamps' and display's shader time wraps. */
const SHADER_PERIOD = 3600;
/** Sway: a fraction of a degree of bank, and a few pixels of drift. */
const SWAY_SWELL = createSwell(90, [
  { cycles: 5, amplitude: 1, offset: 0 },
  { cycles: 8, amplitude: 0.45, offset: 0.29 },
  { cycles: 3, amplitude: 0.5, offset: 0.63 },
]);
const SWAY_ROLL = 0.004;
const SWAY_X = 3;
const SWAY_Y = 2.2;

/** The wingman: radius of the sphere it fits in, and how much the view looks down on it. */
const WING_RADIUS = 0.6;
const WING_TILT = 0.12;

/** Canopy frame: the arch's ellipse (centre height and radii) and the bars' half widths. */
const ARCH_CY = -0.62;
const ARCH_RX = 0.95;
const ARCH_RY = 1.07;
const ARCH_HW = 0.024;
const STRUT_HW = 0.011;
/** Each strut runs from the arch at |x| = STRUT_TOP down to the sill's inner corner. */
const STRUT_TOP = 0.2;
/** The cockpit sides' sill: from (SILL_IN, SILL_IN_Y) up to (SILL_OUT, SILL_OUT_Y). */
const SILL_IN = 0.42;
const SILL_IN_Y = -0.34;
const SILL_OUT = 0.89;
const SILL_OUT_Y = -0.2;
/** Height of the fuselage's and wings' top edge behind the cockpit. */
const DECK_Y = 0.015;
/** The wingtip engine intakes' centre (|x|, y) and radius. */
const POD_X = 0.66;
const POD_Y = -0.03;
const POD_R = 0.045;
/** The droid's barrel: how far it stands out of its socket, in dome radii. */
const BARREL = 0.8;
/** Lamp ids above this are the targeting display. */
const SCREEN_ID = 250;

/** Towards the key light (the nearest star), view space with z towards the viewer. */
const KEY: readonly [number, number, number] = (() => {
  const v = [-0.55, 0.6, 0.58];
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n] as const;
})();
const KEY_GLSL = `vec3(${f(KEY[0])}, ${f(KEY[1])}, ${f(KEY[2])})`;

/**
 * Shared layout GLSL: the sill, the droid's dome outline (its upper
 * hemisphere, the same in the cached layer, which leaves a hole for it, and
 * in the live pass, which fills it) and a few shapes.
 */
const LAYOUT_GLSL = /* glsl */ `
const vec3 KEY = ${KEY_GLSL};
const float PITCH = ${f(DROID_PITCH)};

/** Height of the cockpit sides' sill at |x|. */
float sill(float ax) {
  return ${f(SILL_IN_Y)} + (ax - ${f(SILL_IN)}) * ${f((SILL_OUT_Y - SILL_IN_Y) / (SILL_OUT - SILL_IN))};
}

/**
 * The dome at p: xyz the view-space normal and w its coverage, given the
 * dome's centre and radius and the size of a pixel.
 */
vec4 domeAt(vec2 p, vec2 c, float r, float px) {
  vec2 q = (p - c) / r;
  float q2 = dot(q, q);
  float edge = clamp((1.0 - sqrt(q2)) * r / px + 0.5, 0.0, 1.0);
  if (edge <= 0.0) {
    return vec4(0.0);
  }
  vec3 n = vec3(q, sqrt(max(0.0, 1.0 - q2)));
  // Only the upper hemisphere: its base hides in the barrel.
  float up = n.y * cos(PITCH) + n.z * sin(PITCH);
  float base = clamp(up * r / (px * max(0.3, n.z)) + 0.5, 0.0, 1.0);
  return vec4(n, edge * base);
}

float sdBox(vec2 p, vec2 c, vec2 h, float rr) {
  vec2 d = abs(p - c) - h + rr;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rr;
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

/** Approximate signed distance to an ellipse (centre c, radii r). */
float sdEllipse(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  float k = length(q);
  vec2 g = q / (r * max(k, 1e-5));
  return (k - 1.0) / max(length(g), 1e-5);
}
`;

/** Lamp panels per side (centre |x|, y; half sizes), and their grids (columns, rows). */
interface Panel {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  cols: number;
  rows: number;
  kind: "lamps" | "toggles" | "display";
}
const PANELS: readonly Panel[] = [
  { cx: 0.78, cy: -0.29, hx: 0.06, hy: 0.024, cols: 4, rows: 2, kind: "lamps" },
  { cx: 0.6, cy: -0.39, hx: 0.085, hy: 0.035, cols: 6, rows: 1, kind: "toggles" },
  { cx: 0.775, cy: -0.385, hx: 0.08, hy: 0.058, cols: 4, rows: 3, kind: "display" },
  { cx: 0.67, cy: -0.468, hx: 0.19, hy: 0.017, cols: 10, rows: 1, kind: "lamps" },
];
const panelsGlsl = () =>
  PANELS.map(
    (p) =>
      `vec4(${f(p.cx)}, ${f(p.cy)}, ${f(p.hx)}, ${f(p.hy)}), vec4(${f(p.cols)}, ${f(p.rows)}, ${f(
        p.kind === "lamps" ? 0 : p.kind === "toggles" ? 1 : 2,
      )}, 0.0)`,
  ).join(",\n  ");

/**
 * The cockpit, drawn once per resize or change of side, seed or droid colour.
 * Pass 0 writes the colour, premultiplied, with alpha 0 where space shows
 * (and a hole where the droid's dome goes). Pass 1 writes ids: R the lamp
 * (1..) or the targeting display (SCREEN_ID) under the pixel, G a lamp's glow
 * or the position across the display, B the position up it.
 */
const COCKPIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform int uPass;
uniform float uSeed;
uniform float uSide;
uniform vec3 uAccent;

out vec4 outColor;
${NOISE_GLSL}
${LAYOUT_GLSL}

const vec3 WARM = vec3(1.0, 0.62, 0.32);
const vec3 COOL = vec3(0.62, 0.74, 1.0);
const vec4 PANELS[${String(PANELS.length * 2)}] = vec4[](
  ${panelsGlsl()}
);

float px;
vec4 acc;
vec3 ids;

void over(vec3 col, float cov, vec3 id) {
  acc = vec4(col, 1.0) * cov + acc * (1.0 - cov);
  if (cov > 0.5) {
    ids = id;
  }
}

float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}

/** Worn metal: blotches, and a few fine scuffs. */
float wear(vec2 p) {
  float b = fbm(p * 6.0, uSeed + 3.0);
  vec2 sp = vec2(p.x * 4.0 + p.y * 7.0, p.y * 3.0 - p.x * 60.0);
  float s = smoothstep(0.92, 0.99, vnoise(sp, uSeed + 5.0)) * smoothstep(0.45, 0.7, vnoise(p * 5.0, uSeed + 6.0));
  return 0.82 + 0.36 * b + 0.45 * s;
}

/** The instruments' warm glow, strongest just above the cockpit sides. */
float warmth(vec2 p) {
  float ax = abs(p.x);
  return exp(-max(0.0, p.y - sill(max(ax, ${f(SILL_IN)}))) * 6.0) * smoothstep(0.25, 0.55, ax);
}

/** A light-grey metal bar across its width: s in [-1, 1] across, nd the direction s grows in. */
vec3 bar(vec2 p, float s, vec2 nd, float base) {
  vec3 n = vec3(nd * s, sqrt(max(0.0, 1.0 - s * s)));
  float key = max(0.0, dot(n, KEY));
  float below = max(0.0, dot(n, normalize(vec3(0.0, -0.8, 0.6))));
  vec3 c = base * wear(p) * (0.1 + 0.75 * key * COOL + 0.9 * warmth(p) * below * WARM);
  c += 0.08 * pow(key, 12.0) * COOL;
  return c;
}

/** The seat: its back, and the headrest above it. */
float seat(vec2 p) {
  float back = sdBox(p, vec2(0.0, -0.36), vec2(0.34, 0.27), 0.11);
  float head = sdBox(p, vec2(0.0, 0.1), vec2(0.185, 0.15), 0.09);
  return min(back, head);
}

/** One lamp panel at mirrored point q, side 0 left / 1 right. */
void panel(vec2 q, vec2 p, int i, float side, bool display) {
  vec4 r = PANELS[2 * i];
  vec4 g = PANELS[2 * i + 1];
  float d = sdBox(q, r.xy, r.zw, 0.004);
  if (d > px) {
    return;
  }
  float w = warmth(p);
  vec3 plate = vec3(0.05, 0.05, 0.052) * wear(q * 1.7 + float(i)) * (0.8 + 0.8 * w);
  plate *= 1.0 + 0.7 * smoothstep(0.004, 0.0, -d) * (q.y > r.y ? 1.0 : -0.5);
  over(plate, cover(d), vec3(0.0));
  int kind = int(g.z + 0.5);
  if (kind == 2 && display) {
    // The targeting display: a dark screen in a thick bezel.
    vec2 sh = r.zw - 0.01;
    float s = sdBox(q, r.xy, sh, 0.006);
    over(vec3(0.01, 0.007, 0.004), cover(s), vec3(0.0));
    if (s < 0.0) {
      vec2 uv = (q - (r.xy - sh)) / (2.0 * sh);
      // Mirrored on the left, so flip it back.
      uv.x = p.x < 0.0 ? 1.0 - uv.x : uv.x;
      ids = vec3(${f(SCREEN_ID)} / 255.0, uv);
    }
    return;
  }
  vec2 cell = 2.0 * r.zw / g.xy;
  vec2 gp = (q - (r.xy - r.zw)) / cell;
  vec2 ci = floor(gp);
  if (ci.x < 0.0 || ci.y < 0.0 || ci.x >= g.x || ci.y >= g.y) {
    return;
  }
  vec2 lp = (fract(gp) - 0.5) * cell;
  float idx = 1.0 + side * 60.0 + float(i) * 15.0 + ci.y * g.x + ci.x;
  float half_ = min(cell.x, cell.y) * 0.24;
  vec2 lc = vec2(0.0);
  if (kind == 1) {
    // A toggle: a round collar and a lever thrown up or down, with a lamp above.
    lc = vec2(0.0, cell.y * 0.3);
    half_ *= 0.7;
    vec2 cp = lp + vec2(0.0, cell.y * 0.15);
    float collar = length(cp) - cell.x * 0.17;
    over(vec3(0.06) + 0.1 * smoothstep(0.006, 0.0, length(cp - vec2(-0.002, 0.002))), cover(collar), vec3(0.0));
    float up = hash2(ci + vec2(float(i) * 7.0 + side * 31.0, 3.0), uSeed) < 0.55 ? 1.0 : -1.0;
    float lever = sdSeg(cp, vec2(0.0), vec2(0.0, 0.012 * up)) - 0.0022;
    over(vec3(0.42, 0.42, 0.44) * (0.5 + 0.9 * w), cover(lever), vec3(0.0));
  }
  vec2 lq = lp - lc;
  float bezel = sdBox(lq, vec2(0.0), vec2(half_ + 0.0016), 0.0012);
  over(vec3(0.025), cover(bezel), vec3(0.0));
  float lens = length(lq) - half_;
  over(vec3(0.05, 0.04, 0.035), cover(lens), vec3(0.0));
  float glow = cover(lens) + 0.5 * exp(-max(0.0, lens) / (0.7 * half_)) * (1.0 - cover(lens));
  if (acc.a > 0.5 && glow > 0.02) {
    ids = vec3(idx / 255.0, glow, 0.0);
  }
}

void main() {
  px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  float ax = abs(p.x);
  acc = vec4(0.0);
  ids = vec3(0.0);

  vec2 dc = vec2(uSide * ${f(Math.abs(DROID_X))}, ${f(DROID_Y)});
  float R = ${f(DROID_R)};
  float sp = sin(PITCH);
  float cp = cos(PITCH);
  float barrel = ${f(BARREL)} * R * cp;
  vec2 socket = dc - vec2(0.0, barrel);

  // The fuselage and wings behind the cockpit, seen nearly edge-on, with a
  // fairing round the droid's socket. Below the wings, out at the sides,
  // space shows.
  {
    float top = ${f(DECK_Y)} - 0.03 * smoothstep(0.3, 0.9, ax);
    float fair = sdEllipse(p, socket + vec2(0.0, -0.012), vec2(R * 1.6, R * 0.55));
    float bottom = mix(-0.7, top - 0.032, smoothstep(0.42, 0.6, ax));
    float body = max(p.y - top, bottom - p.y);
    float d = min(body, fair);
    if (d < px) {
      // Panel seams converge on the vanishing point at the frame's centre.
      float depth = 1.0 / max(0.02, -p.y + 0.06);
      float lat = p.x * depth;
      float seam = smoothstep(0.0015, 0.0, abs(fract(lat * 1.2) - 0.5) / (1.2 * depth))
        + smoothstep(0.0015, 0.0, abs(fract(depth * 0.6) - 0.5) / (0.6 * depth * depth));
      float lit = 0.18 + 0.3 * smoothstep(-0.03, 0.0, p.y - top) + 0.15 * smoothstep(0.0, 0.05, fair + 0.05);
      vec3 col = vec3(0.4, 0.41, 0.43) * wear(p * 0.9 + 2.0) * lit * (1.0 - 0.45 * clamp(seam, 0.0, 1.0));
      // The fairing's rim catches the key light.
      col += 0.09 * smoothstep(0.012, 0.0, abs(fair)) * step(socket.y, p.y) * COOL;
      over(col, cover(d), vec3(0.0));
    }
    // The wingtip engines' intakes, end-on.
    vec2 pc = vec2(ax - ${f(POD_X)}, p.y - ${f(POD_Y)});
    float pod = length(pc) - ${f(POD_R)};
    if (pod < px) {
      float rr = length(pc) / ${f(POD_R)};
      float ring = smoothstep(0.62, 0.7, rr);
      float vanes = 0.5 + 0.5 * cos(atan(pc.y, pc.x) * 9.0);
      vec3 inner = vec3(0.015) + 0.02 * vanes * smoothstep(0.2, 0.6, rr);
      float lip = max(0.0, dot(normalize(vec3(pc, 0.02)), KEY));
      vec3 col = mix(inner, vec3(0.36, 0.37, 0.38) * (0.15 + 0.7 * lip), ring);
      over(col, cover(pod), vec3(0.0));
    }
  }

  // The droid: its socket, its barrel standing out of it, then the hole its dome fills.
  {
    float hole = sdEllipse(p, socket, vec2(R * 1.18, R * 1.18 * sp));
    over(vec3(0.012), cover(hole), vec3(0.0));
    float qx = (p.x - dc.x) / R;
    if (abs(qx) < 1.0) {
      float arc = sqrt(1.0 - qx * qx) * R * sp;
      float d = max(abs(p.x - dc.x) - R, max(p.y - (dc.y - arc + 0.002), socket.y - arc - p.y));
      if (d < px) {
        // A barrel's normal, facing out to the side.
        vec3 n = vec3(qx, -0.3 * sp, sqrt(1.0 - qx * qx) * cp);
        float lit = 0.12 + 0.85 * max(0.0, dot(normalize(n), KEY));
        float a = asin(qx);
        float h = (dc.y - arc - p.y) / barrel;
        // Accent panels on the barrel, and dark grooves between them.
        float acc1 = step(abs(a + 0.62), 0.22) * step(0.18, h) * step(h, 0.8);
        float acc2 = step(abs(a - 0.5), 0.16) * step(0.12, h) * step(h, 0.55);
        float groove = smoothstep(0.03, 0.0, abs(fract(a * 1.6 + 0.5) - 0.5) * 0.6);
        vec3 base = mix(vec3(0.78, 0.79, 0.8), uAccent * 0.85, max(acc1, acc2));
        base *= 1.0 - 0.6 * groove * step(0.1, h);
        vec3 col = base * lit * COOL * 0.95 + 0.25 * pow(max(0.0, dot(reflect(vec3(0.0, 0.0, -1.0), normalize(n)), KEY)), 20.0);
        over(col, cover(d), vec3(0.0));
      }
    }
    // The socket's front lip, over the barrel's foot.
    float lip = abs(sdEllipse(p, socket, vec2(R * 1.18, R * 1.18 * sp))) - 0.006;
    if (lip < px && p.y < socket.y) {
      over(vec3(0.3, 0.31, 0.32) * wear(p), cover(lip), vec3(0.0));
    }
    vec4 dome = domeAt(p, dc, R, px);
    acc *= 1.0 - dome.w;
  }

  // The seat: its back, then the headrest behind the pilot's head, in a
  // light metal shell round dark padding.
  {
    float d = seat(p);
    if (d < px) {
      float pad = d + 0.016;
      vec2 e = vec2(0.002, 0.0);
      vec2 grad = normalize(vec2(seat(p + e.xy) - seat(p - e.xy), seat(p + e.yx) - seat(p - e.yx)) + 1e-6);
      vec3 shell = vec3(0.34, 0.35, 0.36) * wear(p * 1.4 + 7.0)
        * (0.12 + 0.7 * max(0.0, dot(vec3(grad, 0.4), KEY)) + 0.5 * smoothstep(0.0, -0.45, p.y) * WARM);
      float channels = smoothstep(0.004, 0.0, abs(fract(p.x * 14.0) - 0.5) / 14.0) * step(-0.07, p.y);
      vec3 padding = vec3(0.05, 0.046, 0.044) * (1.0 - 0.45 * channels)
        * (0.7 + 0.5 * smoothstep(0.25, -0.3, p.y) * WARM + 0.3 * smoothstep(0.1, -0.2, p.x + p.y));
      vec3 col = mix(shell, padding, cover(pad));
      over(col, cover(d), vec3(0.0));
    }
  }

  // The canopy frame: two struts flanking the seat, and the arch over them.
  if (p.y > sill(max(ax, ${f(SILL_IN)})) - 0.02) {
    vec2 a = vec2(${f(STRUT_TOP)}, ${f(ARCH_CY)} + ${f(ARCH_RY)} * sqrt(1.0 - ${f((STRUT_TOP / ARCH_RX) ** 2)}));
    vec2 b = vec2(${f(SILL_IN)}, ${f(SILL_IN_Y)});
    vec2 q = vec2(ax, p.y);
    float ds = sdSeg(q, a, b) - ${f(STRUT_HW)};
    if (ds < px) {
      vec2 dir = normalize(b - a);
      // Across the strut, mirrored back from |x| on the left.
      vec2 nq = vec2(-dir.y, dir.x);
      vec2 nd = vec2(nq.x * (p.x < 0.0 ? -1.0 : 1.0), nq.y);
      float across = dot(q - a, nq) / ${f(STRUT_HW)};
      over(bar(p, clamp(across, -1.0, 1.0), nd, 0.42), cover(ds), vec3(0.0));
    }
    float de = sdEllipse(p, vec2(0.0, ${f(ARCH_CY)}), vec2(${f(ARCH_RX)}, ${f(ARCH_RY)}));
    float da = abs(de) - ${f(ARCH_HW)};
    if (da < px) {
      vec2 q2 = p - vec2(0.0, ${f(ARCH_CY)});
      vec2 rn = normalize(q2 / vec2(${f(ARCH_RX ** 2)}, ${f(ARCH_RY ** 2)}));
      vec3 col = bar(p, clamp(de / ${f(ARCH_HW)}, -1.0, 1.0), rn, 0.45);
      // Rivets along the middle of the arch.
      float ang = atan(q2.y, q2.x);
      float riv = length(vec2(de, (fract(ang * 18.0) - 0.5) / 18.0)) - 0.0035;
      col *= 1.0 - 0.35 * cover(riv);
      over(col, cover(da), vec3(0.0));
    }
  }

  // The cockpit sides at the lower corners, with their instruments.
  {
    float inner = ${f(SILL_IN)} + 0.08 * (p.y - ${f(SILL_IN_Y)});
    float d = max(p.y - sill(ax), inner - ax);
    if (d < px) {
      float rim = smoothstep(0.012, 0.0, -d);
      float w = warmth(p);
      vec3 col = vec3(0.3, 0.31, 0.32) * wear(p * 1.2 + 4.0) * (0.12 + 0.35 * w * WARM);
      // The sill's edge catches the key light.
      col += rim * (0.14 * COOL + 0.1 * WARM * w);
      // Seams across the side wall.
      col *= 1.0 - 0.4 * smoothstep(0.0015, 0.0, abs(fract((p.y - sill(ax)) * 9.0) - 0.5) / 9.0) * step(0.02, -d);
      over(col, cover(d), vec3(0.0));
      vec2 q = vec2(ax, p.y);
      float side = p.x < 0.0 ? 0.0 : 1.0;
      bool display = sign(p.x) != uSide;
      for (int i = 0; i < ${String(PANELS.length)}; i++) {
        panel(q, p, i, side, display);
      }
    }
  }

  if (uPass == 0) {
    outColor = acc;
  } else {
    outColor = vec4(ids, 1.0);
  }
}
`;

/**
 * Outside, once per resize or change of view, at reduced size: deep space,
 * the nearest star's glow in the droid's upper corner, and low in the frame a
 * planet's limb or a nebula. Alpha is the planet's coverage, so it hides the
 * stars behind it.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
uniform float uAspect;
uniform float uPx;
uniform float uSeed;
uniform float uSide;
uniform int uOutside;

out vec4 outColor;
${NOISE_GLSL}
${DITHER_GLSL}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec3 col = vec3(0.004, 0.005, 0.011) + vec3(0.004, 0.006, 0.012) * (0.5 + p.y);
  // Faint dust.
  col += vec3(0.012, 0.012, 0.02) * smoothstep(0.45, 0.85, fbm(p * 2.2 + uSeed * 0.13, uSeed + 2.0));
  // The nearest star, small and soft, high in the droid's corner.
  vec2 sun = vec2(uSide * (0.5 * uAspect - 0.1), 0.42);
  float sd = length(p - sun);
  col += vec3(1.0, 0.95, 0.85) * smoothstep(0.012, 0.008, sd) * 0.9;
  col += vec3(0.75, 0.82, 1.0) * (0.25 * exp(-sd * 40.0) + 0.06 * exp(-sd * 7.0));
  float alpha = 0.0;
  if (uOutside == 1) {
    // A planet far below: only its limb shows, low at the sides.
    vec2 c = vec2(0.0, -2.0);
    float R = 1.98;
    vec2 d = p - c;
    float r = length(d);
    vec3 L = normalize(vec3(-uSide * 0.5, 0.7, 0.4));
    if (r < R) {
      vec3 n = vec3(d / R, sqrt(max(0.0, 1.0 - r * r / (R * R))));
      vec2 sp = vec2(atan(d.x, d.y) * 9.0, n.z * 14.0);
      float land = fbm(sp + uSeed * 0.21, uSeed + 7.0);
      float cloud = smoothstep(0.5, 0.8, fbm(sp * vec2(1.6, 2.4) - 3.0, uSeed + 8.0));
      vec3 c0 = mix(vec3(0.05, 0.12, 0.2), vec3(0.2, 0.17, 0.1), smoothstep(0.5, 0.6, land));
      c0 = mix(c0, vec3(0.75, 0.78, 0.8), cloud * 0.8);
      float lit = 0.08 + 0.92 * max(0.0, dot(n, L));
      col = c0 * lit * 0.6 + vec3(0.1, 0.22, 0.4) * pow(1.0 - n.z, 4.0) * 0.6;
      alpha = clamp((R - r) / uPx + 0.5, 0.0, 1.0);
    }
    // A thin atmosphere above the limb.
    col += vec3(0.14, 0.3, 0.55) * exp(-max(0.0, r - R) * 60.0) * 0.35;
  } else if (uOutside == 2) {
    // A nebula, strongest low in the frame.
    float low = smoothstep(0.45, -0.25, p.y);
    float n = fbm(p * 2.4 + uSeed * 0.31, uSeed);
    float m = fbm(p * 4.1 - 5.0, uSeed + 1.0);
    float dens = smoothstep(0.3, 0.85, n) * low;
    col += mix(vec3(0.22, 0.05, 0.16), vec3(0.06, 0.2, 0.24), m) * dens * 0.55;
    col += vec3(0.5, 0.25, 0.3) * smoothstep(0.75, 0.95, n * m * 1.6) * low * 0.12;
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), alpha);
}
`;

/** The wingman: a slim fuselage, straight wings with an engine at each tip, a canopy and a fin. */
const WINGMAN_GLSL = /* glsl */ `
uniform float uWingRoll;

vec2 wingmanShape(vec3 p) {
  p.xy = rot2(uWingRoll) * p.xy;
  vec2 r = vec2(sEll(p - vec3(0.0, 0.0, 0.02), vec3(0.055, 0.05, 0.4)), 0.0);
  r = sMin(r, vec2(sCap(p, vec3(0.0, 0.0, 0.25), vec3(0.0, -0.006, 0.5), 0.02), 0.0));
  r = sMin(r, vec2(sEll(p - vec3(0.0, 0.042, 0.12), vec3(0.034, 0.03, 0.09)), 1.0));
  vec3 q = vec3(abs(p.x), p.y, p.z);
  float along = clamp(q.x / 0.42, 0.0, 1.0);
  vec3 w = vec3(q.x - 0.22, q.y + 0.004, q.z + 0.1 + 0.1 * along);
  r = sMin(r, vec2(sRound(w, vec3(0.2, 0.009, 0.085 - 0.03 * along), 0.004) * 0.8, 0.0));
  float pod = sCap(q, vec3(0.43, 0.0, -0.3), vec3(0.43, 0.0, 0.1), 0.034);
  r = sMin(r, vec2(pod, q.z < -0.31 ? 2.0 : 0.0));
  vec3 t = p - vec3(0.0, 0.07, -0.3);
  t.z += 0.5 * t.y;
  r = sMin(r, vec2(sRound(t, vec3(0.006, 0.06, 0.06), 0.004) * 0.8, 0.0));
  return r;
}

vec3 wingmanGlow(float mat) {
  return mat > 1.5 ? vec3(1.0, 0.55, 0.25) : vec3(0.03, 0.05, 0.07);
}
`;

/**
 * Each frame: the cached cockpit (swayed a touch) with its lamps and
 * targeting display, the droid's dome in the hole left for it, and behind
 * them the cached sky and the wingman, over the stars already on the canvas.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uCockpit;
uniform sampler2D uIds;
uniform sampler2D uSky;
uniform vec2 uResolution;
uniform vec4 uSway;
uniform float uTime;
uniform float uSeed;
uniform vec4 uDroid;
uniform vec3 uAccent;
uniform vec3 uIndicator;
uniform vec4 uWing;
uniform float uWingYaw;

out vec4 outColor;
${NOISE_GLSL}
${DITHER_GLSL}
${LAYOUT_GLSL}
${SDF_GLSL}
${WINGMAN_GLSL}
${shipMarchGlsl({
  name: "wingmanHit",
  args: "",
  map: (p) => `wingmanShape(${p})`,
  albedo: "vec3(0.5, 0.51, 0.53)",
  glow: "wingmanGlow(h.y)",
  glowMix: "h.y > 1.5 ? 0.9 : 0.85",
  radius: WING_RADIUS,
  tilt: WING_TILT,
})}

/** Angle between unit vectors, cheaply: 0 when equal. */
float apart(vec3 a, vec3 b) {
  return acos(clamp(dot(a, b), -1.0, 1.0));
}

/** The dome, premultiplied, at p. */
vec4 dome(vec2 p, float px) {
  vec4 d = domeAt(p, uDroid.xy, uDroid.z, px);
  if (d.w <= 0.0) {
    return vec4(0.0);
  }
  vec3 n = d.xyz;
  // Into the dome's own frame: tipped back by the pitch, then turned.
  float cp = cos(PITCH);
  float sp = sin(PITCH);
  vec3 l = vec3(n.x, n.y * cp + n.z * sp, n.z * cp - n.y * sp);
  float ct = cos(uDroid.w);
  float st = sin(uDroid.w);
  l = vec3(ct * l.x - st * l.z, l.y, st * l.x + ct * l.z);
  float lon = atan(l.x, l.z);
  float lat = asin(clamp(l.y, 0.0, 1.0));

  vec3 base = vec3(0.8, 0.81, 0.83);
  float accent = 0.0;
  float dark = 0.0;
  // Two seam rings, and the seams between the band's eight panels.
  float seam = smoothstep(0.016, 0.006, abs(lat - 0.3)) + smoothstep(0.016, 0.006, abs(lat - 0.8));
  float sector = lon / 0.7853982 + 0.5;
  float inBand = step(0.3, lat) * step(lat, 0.8);
  seam += inBand * smoothstep(0.03, 0.01, abs(fract(sector) - 0.5) * 0.785 * cos(lat) * 2.0);
  // The band's panels: accent at the sides and back, a small accent plate either side of the eye.
  float k = mod(floor(sector), 8.0);
  accent = max(accent, inBand * (k == 2.0 || k == 6.0 || k == 4.0 ? 1.0 : 0.0));
  float plate = inBand * step(lat, 0.46) * step(abs(abs(lon) - 0.785), 0.2) * step(0.33, lat);
  accent = max(accent, plate);
  // A dashed accent ring low on the dome, and a ring round the cap.
  float dash = step(0.07, lat) * step(lat, 0.22) * step(0.5, fract(lon / 0.5236 + 0.25));
  accent = max(accent, dash);
  accent = max(accent, step(1.12, lat) * step(lat, 1.22));
  vec3 col = mix(base, uAccent, accent);
  col *= 1.0 - 0.55 * clamp(seam, 0.0, 1.0);

  // Lighting: the cool key, a little fill, and a metallic sheen.
  float diff = max(0.0, dot(n, KEY));
  vec3 refl = reflect(vec3(0.0, 0.0, -1.0), n);
  float spec = pow(max(0.0, dot(refl, KEY)), 30.0);
  vec3 lit = col * (0.1 + 0.85 * diff * vec3(0.9, 0.95, 1.0)) + 0.35 * spec;

  // The eye: a black lens in a dark bezel, catching the light as the dome turns.
  vec3 eye = vec3(0.0, sin(0.5), cos(0.5));
  float e = apart(l, eye);
  if (e < 0.2) {
    float bez = smoothstep(0.2, 0.19, e);
    float lens = smoothstep(0.15, 0.14, e);
    vec3 glass = vec3(0.012, 0.012, 0.016) + vec3(0.06, 0.02, 0.015) * smoothstep(0.1, 0.0, e);
    glass += 0.9 * pow(max(0.0, dot(refl, KEY)), 90.0) + 0.25 * spec;
    lit = mix(lit, vec3(0.06, 0.06, 0.065) * (0.4 + diff), bez);
    lit = mix(lit, glass, lens);
  }
  // A small projector knob above the band.
  float kb = apart(l, normalize(vec3(sin(0.55), 0.9, cos(0.55))));
  lit = mix(lit, vec3(0.05) + 0.2 * diff * smoothstep(0.03, 0.06, kb), smoothstep(0.075, 0.065, kb));
  // The indicator, glowing.
  float ib = apart(l, normalize(vec3(sin(-0.36) * cos(0.62), sin(0.62), cos(-0.36) * cos(0.62))));
  float lamp = smoothstep(0.055, 0.04, ib);
  lit = mix(lit, vec3(0.04) + uIndicator, lamp);
  lit += uIndicator * 0.35 * exp(-ib * 25.0) * (1.0 - lamp);
  return vec4(lit, 1.0) * d.w;
}

/** The targeting display: a reticle, a slowly wandering target bracket and range bars. */
vec3 display(vec2 uv) {
  vec2 q = (uv - 0.5) * vec2(1.4, 1.0);
  float r = length(q);
  float v = 0.12 * smoothstep(0.008, 0.0, abs(r - 0.32)) + 0.2 * smoothstep(0.008, 0.0, abs(r - 0.16));
  v += 0.25 * smoothstep(0.006, 0.0, min(abs(q.x), abs(q.y))) * step(r, 0.42) * step(0.05, r);
  float t = uTime;
  vec2 tgt = vec2(0.22 * sin(t * 0.13) + 0.08 * sin(t * 0.31), 0.16 * sin(t * 0.17 + 1.0));
  vec2 b = abs(q - tgt);
  float box = step(max(b.x, b.y), 0.07) * step(0.06, max(b.x, b.y)) * step(min(b.x, b.y), 0.035);
  vec3 col = vec3(1.0, 0.55, 0.12) * (0.06 + v) + vec3(1.0, 0.18, 0.08) * box * 0.7;
  // Range bars down the side.
  float bar = step(0.9, uv.x) * step(uv.x, 0.96) * step(fract(uv.y * 8.0), 0.6);
  float lvl = 0.5 + 0.4 * sin(t * 0.21);
  col += vec3(1.0, 0.45, 0.1) * bar * (uv.y < lvl ? 0.45 : 0.08);
  float scan = 0.88 + 0.12 * sin(uv.y * 120.0);
  return col * scan;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 c = 0.5 * uResolution;
  vec2 dd = frag - c;
  // The cockpit's bank and drift.
  vec2 src = c + vec2(uSway.x * dd.x + uSway.y * dd.y, -uSway.y * dd.x + uSway.x * dd.y) - uSway.zw;
  vec4 ck = texture(uCockpit, src / uResolution);
  vec4 id = texelFetch(uIds, clamp(ivec2(src), ivec2(0), ivec2(uResolution) - 1), 0);
  int idx = int(id.r * 255.0 + 0.5);
  float px = 1.0 / uResolution.y;
  vec2 p = (frag - c) * px;
  vec2 ps = (src - c) * px;

  // Behind the cockpit: the sky, the wingman, and the dome.
  vec4 sky = texture(uSky, frag / uResolution);
  vec3 back = sky.rgb;
  float backA = sky.a;
  if (uWing.z > 0.0 && length(p - uWing.xy) < uWing.z * 1.7) {
    vec3 d = normalize(vec3(p, ${f(WING_FOCAL)}));
    float dist = ${f(WING_DISTANCE)};
    vec3 centre = vec3(uWing.xy * dist / ${f(WING_FOCAL)}, dist);
    float s = uWing.z * dist / (${f(WING_RADIUS)} * ${f(WING_FOCAL)});
    vec4 ship = wingmanHit(d, centre, s, uWingYaw, vec3(${f(KEY[0])}, ${f(KEY[1])}, ${f(-KEY[2])}), px / ${f(WING_FOCAL)});
    back = back * (1.0 - ship.a) + ship.rgb;
    backA = backA + (1.0 - backA) * ship.a;
  }
  if (abs(ps.x - uDroid.x) < uDroid.z * 1.05 && abs(ps.y - uDroid.y) < uDroid.z * 1.05) {
    vec4 dm = dome(ps, px);
    back = back * (1.0 - dm.a) + dm.rgb;
    backA = backA + (1.0 - backA) * dm.a;
  }

  vec3 col = ck.rgb;
  if (idx == ${String(SCREEN_ID)}) {
    col += display(id.gb);
  } else if (idx > 0) {
    // Lamps: amber and red, a few pale green; most blink, each at its own slow rate.
    float h = hash2(vec2(float(idx), 1.0), uSeed);
    vec3 lamp = h < 0.55 ? vec3(1.0, 0.55, 0.12) : h < 0.88 ? vec3(1.0, 0.16, 0.08) : vec3(0.55, 1.0, 0.5);
    float rate = 0.06 + 0.3 * hash2(vec2(float(idx), 2.0), uSeed);
    float phase = hash2(vec2(float(idx), 3.0), uSeed);
    float wave = 0.5 + 0.5 * sin(6.2831853 * (uTime * rate + phase));
    float steady = step(0.7, hash2(vec2(float(idx), 4.0), uSeed));
    float level = mix(0.25 + 0.75 * smoothstep(0.25, 0.75, wave), 0.85, steady);
    float g = id.g;
    col += lamp * level * (g * 0.9 + 0.5 * g * g * g);
  }
  float a = ck.a + (1.0 - ck.a) * backA;
  outColor = vec4(col + (1.0 - ck.a) * back + dither8(frag), a);
}
`;

/**
 * Starfighter Cockpit. The cockpit and the sky are drawn once per resize or
 * change of view into their own targets. Each frame draws the receding stars
 * on the canvas, then one composite lays the swayed cockpit, its lamps and
 * display, the droid's turning dome, the sky and any wingman over them.
 */
export const starfighter = defineEffect(starfighterMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const cockpitProgram = program(FULLSCREEN_VERTEX, COCKPIT_FRAGMENT);
      const pu = createUniforms(gl, cockpitProgram, [
        "uResolution",
        "uPass",
        "uSeed",
        "uSide",
        "uAccent",
      ]);
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const su = createUniforms(gl, skyProgram, ["uAspect", "uPx", "uSeed", "uSide", "uOutside"]);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, [
        "uCockpit",
        "uIds",
        "uSky",
        "uResolution",
        "uSway",
        "uTime",
        "uSeed",
        "uDroid",
        "uAccent",
        "uIndicator",
        "uWing",
        "uWingYaw",
        "uWingRoll",
      ]);
      gl.useProgram(compositeProgram);
      cu.i1("uCockpit", 0);
      cu.i1("uIds", 1);
      cu.i1("uSky", 2);

      const streaks = scope.own(createStreakRenderer(gl, MAX_STARS));
      const stars = createStarfield(MAX_STARS);
      const sf: StarFrame = {
        width: 1,
        height: 1,
        scale: 1,
        speed: STAR_SPEED,
        count: STAR_COUNT,
        streak: 0,
        size: STAR_SIZE,
        tintAmount: 0.5,
        star: [0.9, 0.92, 1],
        tint: [1, 0.85, 0.7],
      };

      let colour: RenderTarget | null = null;
      let ids: RenderTarget | null = null;
      let sky: RenderTarget | null = null;
      scope.defer(() => {
        colour?.dispose();
        ids?.dispose();
        sky?.dispose();
        colour = ids = sky = null;
      });

      const dome = createDomeState();
      const indicator = createIndicator();
      const wing = createWingman();
      let width = 1;
      let height = 1;
      let time = 0;
      let cockpitKey = "";
      let skyKey = "";
      let swayPhase = 0;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          sf.width = width;
          sf.height = height;
          sf.scale = v.scale;
          colour?.dispose();
          ids?.dispose();
          sky?.dispose();
          colour = createRenderTarget(gl, width, height, gl.RGBA8);
          ids = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          sky = createRenderTarget(
            gl,
            lowResSize(width, SKY_DIVISOR),
            lowResSize(height, SKY_DIVISOR),
            gl.RGBA8,
          );
          cockpitKey = skyKey = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const seed = Math.floor(p.seed);
          const side = p.droidSide === "right" ? 1 : -1;
          if (!colour || !ids || !sky) {
            return;
          }

          // 1. The cockpit, when it may have changed.
          const ck = `${String(side)}|${String(seed)}|${p.droid}`;
          if (ck !== cockpitKey) {
            cockpitKey = ck;
            gl.useProgram(cockpitProgram);
            pu.f2("uResolution", width, height);
            pu.f1("uSeed", seed % 1000);
            pu.f1("uSide", side);
            pu.rgb("uAccent", p.droid);
            colour.bind();
            pu.i1("uPass", 0);
            triangle.draw();
            ids.bind();
            pu.i1("uPass", 1);
            triangle.draw();
          }

          // 2. The sky, when it may have changed.
          const sk = `${String(side)}|${String(seed)}|${p.outside}`;
          if (sk !== skyKey) {
            skyKey = sk;
            sky.bind();
            gl.useProgram(skyProgram);
            su.f1("uAspect", width / height);
            su.f1("uPx", SKY_DIVISOR / height);
            su.f1("uSeed", seed % 1000);
            su.f1("uSide", side);
            su.i1("uOutside", p.outside === "planet" ? 1 : p.outside === "nebula" ? 2 : 0);
            triangle.draw();
          }

          // 3. The stars, receding.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          const count = stars.step(step, sf, streaks.data);
          streaks.upload(count);
          streaks.draw(count, width, height);

          // 4. The composite over them.
          domeAt(time, seed, dome);
          indicatorAt(time, indicator);
          const lamp = indicator.level * 0.9;
          wingmanAt(time, seed, width / height, -side, wing);
          const showWing = p.wingman && wing.visible;
          swayPhase = (swayPhase + step / SWAY_SWELL.period) % 1;
          const roll = SWAY_ROLL * swayAt(SWAY_SWELL, swayPhase, 0);
          const scale = height / 1080;
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, colour.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, ids.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, sky.texture);
          cu.f2("uResolution", width, height);
          cu.f4(
            "uSway",
            Math.cos(roll),
            Math.sin(roll),
            SWAY_X * scale * swayAt(SWAY_SWELL, swayPhase, 11),
            SWAY_Y * scale * swayAt(SWAY_SWELL, swayPhase, 29),
          );
          cu.f1("uTime", time % SHADER_PERIOD);
          cu.f1("uSeed", seed % 1000);
          cu.f4(
            "uDroid",
            side * Math.abs(DROID_X),
            DROID_Y,
            DROID_R,
            -side * DROID_REST + dome.angle,
          );
          cu.rgb("uAccent", p.droid);
          if (indicator.blue) {
            cu.f3("uIndicator", 0.15 * lamp, 0.4 * lamp, lamp);
          } else {
            cu.f3("uIndicator", lamp, 0.12 * lamp, 0.06 * lamp);
          }
          cu.f4("uWing", wing.x, wing.y, showWing ? wing.radius : 0, 0);
          cu.f1("uWingYaw", wing.yaw);
          cu.f1("uWingRoll", wing.roll);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();
          gl.disable(gl.BLEND);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
