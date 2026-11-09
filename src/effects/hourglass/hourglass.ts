import { hexToUnitRgb } from "../color";
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
import {
  BULB_K,
  BULB_R,
  bottomSand,
  CAP_END,
  CAP_W,
  createClock,
  createLayout,
  createSandTables,
  DIP_DEPTH,
  DIP_W,
  frameKind,
  hourglassLayout,
  NECK_R,
  PILE_ROUND,
  PILE_SLOPE,
  pileLevel,
  POST_X,
  REACH,
  SEAT_Y,
  SHADOW_RX,
  SHADOW_RY,
  stepClock,
  streamSpan,
  TABLE_BACK_Y,
  topLevel,
  topSand,
  turnAngle,
  turnBlend,
  turnDirection,
  turnLevel,
  turnLift,
  TURN_CLEAR,
  WALL,
} from "./hourglass-sim";
import { hourglassMeta } from "./hourglass.meta";
import { createLowResTarget } from "../lowres";
import { smoothstep } from "../math";
import { HASH32_GLSL } from "../noise";
import { defineEffect } from "../types";
import { PAINT_OVER_GLSL } from "../sdf-glsl";
import { createChangeKey } from "../change-key";

/** Room pass: about 4 reference px per texel. The room is all out of focus. */
const ROOM_TEXEL_REF = 4;
/** Seconds for the funnel dip to form at a run's start. */
const DIP_FORM = 1.5;
/** The stream's width flicker: phase speed (rad/s). */
const FLICK_RATE = 21;
const TAU = Math.PI * 2;

/** Palette (sRGB hex), parsed once. */
const WALL_COL = "#8a7462";
const DAYLIGHT = "#f4efe6";
const SKY = "#c9d8e4";
const TABLE = "#5b3c2a";
const WALNUT = "#5a3622";
const BRASS = "#c9a04e";

const g = glslFloat;
const vec3Hex = (hex: string) =>
  `vec3(${hexToUnitRgb(hex)
    .map((c) => g(c))
    .join(", ")})`;

/**
 * The room at low resolution: a warm wall lit from a tall, bright window on the
 * outer side, a table across the bottom and a vignette. Static, so it
 * re-renders only when the side or the canvas changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** +1 if the hourglass (and the window) is on the right, -1 left. */
uniform float uSide;
out vec4 outColor;
float box(vec2 p, vec2 lo, vec2 hi, float soft) {
  vec2 a = smoothstep(lo - soft, lo + soft, p) * (1.0 - smoothstep(hi - soft, hi + soft, p));
  return a.x * a.y;
}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  // x measured from the outer edge, where the window is.
  vec2 o = vec2(uSide > 0.0 ? uFrame.x - p.x : p.x, p.y);
  vec3 day = ${vec3Hex(DAYLIGHT)};
  // Light falling from the window across the wall, fading inwards.
  vec2 l = (o - vec2(0.15, 0.7)) * vec2(1.1, 1.4);
  float pool = 1.0 / (1.0 + 2.5 * dot(l, l));
  vec3 wall = ${vec3Hex(WALL_COL)} * (0.55 + 0.6 * pool);
  // The window, out of focus: pale sky above, a soft green blur of garden below, with bars.
  float win = box(o, vec2(0.05, 0.3), vec2(0.45, 1.08), 0.05);
  vec3 view = mix(vec3(0.55, 0.62, 0.5), ${vec3Hex(SKY)}, smoothstep(0.42, 0.7, o.y));
  view = mix(view, day, 0.35);
  float bars = max(1.0 - smoothstep(0.008, 0.035, abs(o.x - 0.25)),
    1.0 - smoothstep(0.008, 0.035, abs(o.y - 0.7)));
  view = mix(view, wall * 0.9, 0.55 * bars);
  wall = mix(wall, view, win);
  // The table: its top from the back edge to the canvas's bottom, lit from the window.
  float onTable = 1.0 - smoothstep(${g(TABLE_BACK_Y - 0.004)}, ${g(TABLE_BACK_Y + 0.004)}, p.y);
  vec3 table = ${vec3Hex(TABLE)} * (0.6 + 0.55 * pool + 0.2 * smoothstep(0.0, ${g(TABLE_BACK_Y)}, p.y));
  vec3 col = mix(wall, table, onTable);
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.4 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The hourglass at full resolution in its box, premultiplied over the room, in
 * glass units (see hourglass-sim.ts): the shadow on the table, the back post
 * seen through the glass, the sand and its stream, the glass's Fresnel rim,
 * highlight and window reflection, then the front posts and the end caps.
 * Analytic shapes with coverage antialiasing. Everything is point-symmetric
 * about the neck, so the frame resets after each turn without a jump.
 */
const HOURGLASS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** One device px in height units. */
uniform float uPx;
/** Neck centre (height units, lift included), glass unit, side (+1: outer side is right). */
uniform vec4 uHg;
/** cos and sin of the rotation from glass to screen. */
uniform vec2 uRot;
/** Top sand level from the neck, and the funnel dip's depth. */
uniform vec2 uTop;
/** The pile's apex above the -y glass end. */
uniform float uPile;
/** During the turn: the -y bulb's level along "up", and the blend from pile to level. */
uniform vec2 uTurn;
/** The stream's span below the neck (upper, lower) and flicker phase. */
uniform vec3 uStream;
uniform vec3 uSand;
/** 0 walnut, 1 brass, 2 none. */
uniform int uFrame;
/** Shadow: rest centre x, strength, half-width (glass units). */
uniform vec3 uShadow;
out vec4 outColor;
${DITHER_GLSL}
${HASH32_GLSL}
const vec3 WALNUT = ${vec3Hex(WALNUT)};
const vec3 BRASS = ${vec3Hex(BRASS)};
const vec3 DAY = ${vec3Hex(DAYLIGHT)};
const vec3 SKY = ${vec3Hex(SKY)};

/** One device px in glass units, set by main. */
float pxU;
float cov(float sdf) { return clamp(0.5 - sdf / pxU, 0.0, 1.0); }
${PAINT_OVER_GLSL}
/** A Gaussian bump of width w centred on c. */
float bump(float x, float c, float w) {
  float u = (x - c) / w;
  return exp(-u * u);
}
/** Approximate signed distance to an ellipse of radii r. */
float sdEllipse(vec2 q, vec2 r) {
  float k0 = length(q / r);
  float k1 = max(length(q / (r * r)), 1e-6);
  return k0 * (k0 - 1.0) / k1;
}
float bulbR(float h) {
  float s = ${g(BULB_R)} * sin(${g(BULB_K)} * clamp(h, 0.0, 1.0));
  return sqrt(${g(NECK_R * NECK_R)} + s * s);
}
/** dR/dh. */
float bulbSlope(float h) {
  float a = ${g(BULB_K)} * clamp(h, 0.0, 1.0);
  return ${g(BULB_R * BULB_R * BULB_K)} * sin(a) * cos(a) / bulbR(h);
}
/** Glass-frame direction to screen. */
vec2 toScreen(vec2 v) { return vec2(uRot.x * v.x - uRot.y * v.y, uRot.y * v.x + uRot.x * v.y); }
/** Diffuse and specular from the window light (upper outer side) for a screen normal. */
vec2 light(vec3 n) {
  vec3 l = normalize(vec3(uHg.w * 0.6, 0.45, 0.65));
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  return vec2(max(dot(n, l), 0.0), pow(max(dot(n, h), 0.0), 40.0));
}
/** Shading of a turned (cylindrical) part across its width: u = -1..1 across, in glass x. */
vec3 turned(vec3 base, float u, bool brass) {
  float uc = clamp(u, -1.0, 1.0);
  vec3 n = vec3(toScreen(vec2(uc, 0.0)), sqrt(1.0 - uc * uc));
  vec2 li = light(n);
  if (brass) return base * (0.25 + 0.7 * li.x) + vec3(1.0, 0.92, 0.75) * 0.8 * li.y;
  return base * (0.35 + 0.8 * li.x) + vec3(1.0, 0.9, 0.8) * 0.12 * li.y;
}
/** Wood grain along a turned part: rings in |y|, wavering with |x|. */
float grain(vec2 q) {
  return 0.92 + 0.08 * cos(abs(q.y) * 140.0 + 5.0 * cos(abs(q.x) * 11.0));
}
/** A post's half-width at y: turned beads near the ends and in the middle. */
float postW(float y) {
  float a = abs(y);
  return 0.026 + 0.016 * bump(a, 0.9, 0.05) + 0.012 * bump(a, 0.0, 0.06)
    + 0.008 * bump(a, 0.5, 0.035);
}
void post(inout vec4 acc, vec2 q, float x, float shade, bool brass) {
  float w = postW(q.y) * (brass ? 0.8 : 1.0);
  float d = q.x - x;
  float sd = max(abs(d) - w, abs(q.y) - 1.02);
  float c = cov(sd);
  if (c <= 0.0) return;
  vec3 base = brass ? BRASS : WALNUT * grain(q);
  over(acc, turned(base, d / w, brass) * shade, c);
}
void cap(inout vec4 acc, vec2 q, bool brass) {
  float a = abs(q.y);
  float t = clamp((a - 1.0) / ${g(CAP_END - 1)}, 0.0, 1.0);
  // A turned profile: rounded edges and a fine groove.
  float w = ${g(CAP_W - 0.05)} + 0.05 * sqrt(max(sin(3.14159 * t), 0.0))
    - 0.012 * bump(t, 0.55, 0.07);
  float sd = max(abs(q.x) - w, abs(a - ${g((CAP_END + 1) / 2)}) - ${g((CAP_END - 1) / 2)});
  float c = cov(sd);
  if (c <= 0.0) return;
  vec3 base = brass ? BRASS : WALNUT * grain(q) * 1.1;
  // The face towards the glass is in shadow.
  float face = mix(0.7, 1.0, smoothstep(0.0, 0.35, t));
  over(acc, turned(base, q.x / w, brass) * face, c);
}
void main() {
  vec2 p = gl_FragCoord.xy * uPx;
  vec2 d = (p - uHg.xy) / uHg.z;
  vec2 q = vec2(uRot.x * d.x + uRot.y * d.y, -uRot.y * d.x + uRot.x * d.y);
  pxU = uPx / uHg.z;
  vec4 acc = vec4(0.0);
  // Shadow on the table under the hourglass, fading as it lifts.
  vec2 sp = (p - vec2(uShadow.x, ${g(SEAT_Y)})) / uHg.z;
  float sh = 1.0 - smoothstep(-0.15, 0.15, sdEllipse(sp, vec2(uShadow.z, ${g(SHADOW_RY)})));
  acc.a = 0.45 * sh * uShadow.y;
  if (length(q) > ${g(REACH + 0.03)}) {
    outColor = vec4(acc.rgb, acc.a);
    return;
  }
  bool framed = uFrame < 2;
  bool brass = uFrame == 1;
  if (framed) post(acc, q, 0.0, 0.6, brass);

  float ax = abs(q.x);
  float ay = abs(q.y);
  float R = bulbR(ay);
  float k = inversesqrt(1.0 + bulbSlope(ay) * bulbSlope(ay));
  float glass = cov(max((ax - R) * k, ay - 1.0));
  if (glass > 0.0) {
    // The glass's far wall dims what is behind it a little.
    acc.rgb *= 1.0 - 0.18 * glass;
    over(acc, mix(SKY, DAY, 0.5) * 0.3, 0.06 * glass);

    // Sand: the top bulb's surface with its funnel dip, the pile (or the level during a turn).
    float wallSd = ax - (R - ${g(WALL)});
    float f;
    if (q.y > 0.0) {
      f = q.y - (uTop.x - uTop.y * bump(q.x, 0.0, ${g(DIP_W)}));
    } else {
      float c = 1.0 + q.y;
      float pile = c - (uPile - ${g(PILE_SLOPE)} * (sqrt(ax * ax + ${g(PILE_ROUND * PILE_ROUND)}) - ${g(PILE_ROUND)}));
      vec2 up = vec2(uRot.y, uRot.x);
      float level = dot(q, up) - uTurn.x;
      f = mix(pile * ${g(1 / Math.hypot(1, PILE_SLOPE))}, level, uTurn.y);
    }
    float sand = cov(max(f, wallSd)) * glass;
    if (sand > 0.0) {
      // Grain in a point-symmetric frame, about 1.5 px at 1080p.
      vec2 gq = (q.y < 0.0 ? -q : q) * 90.0;
      uvec2 gc = uvec2(ivec2(floor(gq)) + 4096);
      float h = float(hash32(gc.x * 9781u ^ hash32(gc.y))) / 4294967295.0;
      float u = clamp(q.x / max(R, 1e-3), -1.0, 1.0);
      vec2 li = light(vec3(toScreen(vec2(u, 0.0)), sqrt(1.0 - u * u)));
      vec3 s = uSand * (0.62 + 0.45 * li.x) * (0.95 + 0.1 * h);
      // Lighter just under the surface, where the light reaches.
      s *= 1.0 + 0.12 * exp(f * 30.0);
      over(acc, s, sand);
    }
    // The stream: a thin flickering column from the neck down to the pile.
    float sw = 0.011 * (1.0 + 0.25 * sin(q.y * 47.0 + uStream.z));
    float st = max(max(ax - sw, q.y + uStream.x), -q.y - uStream.y);
    float stream = cov(st) * glass * step(uStream.x, uStream.y - 1e-4);
    if (stream > 0.0) over(acc, uSand * 0.85, stream);

    // The glass: a Fresnel rim, a darker edge line, the window's reflection and a highlight.
    float xn = clamp(q.x / R, -1.0, 1.0);
    float z = sqrt(1.0 - xn * xn);
    vec3 n = normalize(vec3(xn, -bulbSlope(ay) * sign(q.y) * k, z));
    n.xy = toScreen(n.xy);
    float fres = pow(1.0 - z, 3.0);
    vec3 col = mix(DAY, SKY, 0.3) * fres * 0.35;
    float a = 0.08 * fres + 0.3 * smoothstep(R - 3.0 * pxU, R - 0.5 * pxU, ax);
    // The window, mirrored in the bulb: a bright pane at the normals facing it.
    vec2 wn = n.xy - vec2(uHg.w * 0.42, 0.32);
    float win = 1.0 - smoothstep(-0.02, 0.04, max(abs(wn.x) - 0.12, abs(wn.y) - 0.2));
    float bars = 1.0 - smoothstep(0.006, 0.02, abs(wn.x));
    col += DAY * 0.35 * win * (1.0 - 0.7 * bars);
    a += 0.08 * win;
    col += DAY * 0.7 * light(n).y;
    acc = vec4(col, a) * glass + acc * (1.0 - a * glass);
    // The glass ends, seen edge-on when unframed.
    if (!framed) {
      float rim = cov(abs(ay - 0.99) - 0.012) * cov(ax - R);
      over(acc, mix(DAY, SKY, 0.4) * 0.8, 0.5 * rim);
    }
  }
  if (framed) {
    post(acc, q, ${g(POST_X)}, 1.0, brass);
    post(acc, q, ${g(-POST_X)}, 1.0, brass);
    cap(acc, q, brass);
  }
  // Same dither pattern as the room's blit, weighted so the blend keeps its sum.
  outColor = vec4(acc.rgb + dither8(gl_FragCoord.xy) * acc.a, acc.a);
}
`;

/**
 * An hourglass on a table in a bottom corner: the sand runs from the top bulb
 * into a growing pile, and when the top is empty it turns itself over.
 *
 * Passes: the room at 1/4 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; then the hourglass in one scissored
 * full-resolution box. The clock and the sand levels come from
 * hourglass-sim.ts (volume tables built once at creation).
 */
export const hourglass = defineEffect(hourglassMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);

      const roomProgram = program(ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uPxToH", "uFrame", "uSide"]);
      const hgProgram = program(HOURGLASS_FRAGMENT);
      const hu = createUniforms(gl, hgProgram, [
        "uPx",
        "uHg",
        "uRot",
        "uTop",
        "uPile",
        "uTurn",
        "uStream",
        "uSand",
        "uFrame",
        "uShadow",
      ]);

      const tables = createSandTables();
      const layout = createLayout();
      const clock = createClock();
      const span = new Float64Array(2);
      let flick = 0;

      let width = 1;
      let height = 1;
      /** The inputs the room target was drawn from. */
      const roomKey = createChangeKey(1);

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
          const aspect = width / height;
          hourglassLayout(aspect, p.position, p.size, layout);
          stepClock(clock, dt, p.duration);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          flick = (flick + step * FLICK_RATE) % TAU;

          // 1. The room, re-rendered only when it changes, upscaled every frame.
          roomKey.set(0, layout.side);
          if (target.needsRedraw(roomKey)) {
            target.bind();
            gl.useProgram(roomProgram);
            ru.f2("uFrame", aspect, 1);
            ru.f1("uSide", layout.side);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          target.blit();

          // 2. The hourglass, premultiplied, in its box.
          const angle = turnAngle(clock);
          const rot = angle * turnDirection(clock) * -layout.side;
          const lift = turnLift(angle);
          const top = topLevel(tables, topSand(clock, tables));
          const apex = pileLevel(tables, bottomSand(clock, tables));
          const dip =
            clock.phase === "run"
              ? DIP_DEPTH * smoothstep(0, DIP_FORM, clock.time) * Math.min(1, top / 0.15)
              : 0;
          streamSpan(clock, apex, span);
          const framed = frameKind(p.frame) !== 2;

          const x0 = Math.max(0, Math.floor(layout.box[0] * height));
          const y0 = Math.max(0, Math.floor(layout.box[1] * height));
          const x1 = Math.min(width, Math.ceil(layout.box[2] * height));
          const y1 = Math.min(height, Math.ceil(layout.box[3] * height));
          gl.viewport(0, 0, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(hgProgram);
          hu.f1("uPx", 1 / height);
          hu.f4("uHg", layout.cx, layout.cy + lift * layout.unit, layout.unit, layout.side);
          hu.f2("uRot", Math.cos(rot), Math.sin(rot));
          hu.f2("uTop", top, dip);
          hu.f1("uPile", apex);
          hu.f2("uTurn", turnLevel(tables, angle), turnBlend(clock));
          hu.f3("uStream", span[0], span[1], flick);
          hu.rgb("uSand", p.sand);
          hu.i1("uFrame", frameKind(p.frame));
          hu.f3(
            "uShadow",
            layout.cx,
            1 - 0.7 * Math.min(1, lift / (3 * TURN_CLEAR)),
            framed ? SHADOW_RX * (1 + 0.2 * Math.sin(angle) ** 2) : 0.45,
          );
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
