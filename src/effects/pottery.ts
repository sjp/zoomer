import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  updateDataTexture,
  withScope,
} from "./gl";
import { createLowResTarget } from "./lowres";
import { wrap } from "./math";
import { HASH32_GLSL } from "./noise";
import {
  clayFor,
  copyProfile,
  createLayout,
  createProfile,
  holeRadius,
  potBox,
  potteryLayout,
  PROFILE_N,
  profileAt,
  relaxProfile,
  RING_DRIFT,
  RING_PITCH,
  TILT_C,
  TILT_S,
  TRAY_FLOOR_Y,
  TRAY_R,
  TRAY_RIM_Y,
  WHEEL_R,
  WHEEL_T,
  WOBBLE,
} from "./pottery-sim";
import { potteryMeta } from "./pottery.meta";
import { defineEffect } from "./types";

/** Studio pass: about 4 reference px per texel. It is all out of focus. */
const ROOM_TEXEL_REF = 4;
/** Seconds for the shown pot to settle on a new target after a param change. */
const RESHAPE_TIME = 0.6;
/** Throwing ring depth (normal tilt) on an opened pot, and on the closed mound. */
const RING_AMP = 0.1;
const RING_AMP_MOUND = 0.04;
/** Direction towards the key light (outer side, above, in front), before normalising. */
const LIGHT = [0.5, 0.7, 0.5] as const;
/** Warm studio light, and the ambient level. */
const LIGHT_RGB = [1.0, 0.93, 0.82] as const;
const AMBIENT = 0.3;

const g = glslFloat;
const vec3Of = (v: readonly number[]) => `vec3(${v.map((x) => g(x)).join(", ")})`;
const norm = (v: readonly number[]) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const LDIR = norm(LIGHT);
/** Towards the viewer, in pot space (y up, z towards the front): seen from slightly above. */
const VIEW = [0, TILT_S, TILT_C];
const HALF = norm([LDIR[0] + VIEW[0], LDIR[1] + VIEW[1], LDIR[2] + VIEW[2]]);

const SHARED_GLSL = /* glsl */ `
const float S = ${g(TILT_S)};
const float C = ${g(TILT_C)};
const vec3 LDIR = ${vec3Of(LDIR)};
const vec3 HALF = ${vec3Of(HALF)};
const vec3 VIEW = ${vec3Of(VIEW)};
const vec3 LIGHT = ${vec3Of(LIGHT_RGB)};
const float AMB = ${g(AMBIENT)};
/** Approximate signed distance to an ellipse of radii r. */
float sdEllipse(vec2 q, vec2 r) {
  float k0 = length(q / r);
  float k1 = max(length(q / (r * r)), 1e-6);
  return k0 * (k0 - 1.0) / k1;
}
/** A vertical cylinder of radius r between heights y0 and y1, seen from above. */
float sdCylinder(vec2 q, float r, float y0, float y1) {
  float side = max(abs(q.x) - r, max(y0 * C - q.y, q.y - y1 * C));
  float ends = min(sdEllipse(q - vec2(0.0, y0 * C), vec2(r, r * S)),
    sdEllipse(q - vec2(0.0, y1 * C), vec2(r, r * S)));
  return min(side, ends);
}
`;

/**
 * The studio at low resolution: a dim, warm wall lit from a window high on
 * the outer side, a concrete floor, and two long shelves of pots, all out of
 * focus. Static, so it only re-renders when the corner or size changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** +1 if the wheel (and the light) is on the right, -1 left. */
uniform float uSide;
out vec4 outColor;
${HASH32_GLSL}
const vec3 WALL = vec3(0.34, 0.3, 0.26);
const vec3 FLOOR = vec3(0.24, 0.23, 0.22);
const vec3 WOOD = vec3(0.36, 0.25, 0.16);
const float SLOT = 0.11;
const float BLUR = 0.02;
float rand(uint h, uint k) { return float(hash32(h ^ (k * 0x9e3779b9u)) >> 8) * (1.0 / 16777216.0); }
/** One shelf: a board at height b, pots standing on it. Returns colour and coverage. */
vec4 shelf(vec2 p, float b, uint row, vec3 lit) {
  // Pots' colour (the board's where there is none) and coverage.
  vec3 c = WOOD * lit * 1.1;
  float a = 0.0;
  // Pots: one per slot, some slots empty.
  float top = b + 0.016;
  float slot = floor(p.x / SLOT);
  uint h = hash32(uint(int(slot) + 4096) * 2u + row);
  if (rand(h, 1u) < 0.78) {
    float ph = 0.045 + 0.065 * rand(h, 2u);
    float pw = 0.014 + 0.012 * rand(h, 3u);
    float cx = (slot + 0.5 + 0.12 * (rand(h, 4u) - 0.5)) * SLOT;
    float t = (p.y - top) / ph;
    // A belly, a neck and a lip: rounder or taller per pot.
    float belly = 0.25 + 0.4 * rand(h, 5u);
    float w = pw * (0.62 + 0.38 * exp(-9.0 * (t - belly) * (t - belly)) + 0.18 * smoothstep(0.85, 1.0, t));
    float ins = (1.0 - smoothstep(-BLUR, BLUR, abs(p.x - cx) - w))
      * smoothstep(-BLUR, BLUR, p.y - top) * (1.0 - smoothstep(-BLUR, BLUR, p.y - top - ph));
    float k = rand(h, 6u);
    vec3 glaze = k < 0.3 ? vec3(0.5, 0.27, 0.17) : k < 0.55 ? vec3(0.62, 0.6, 0.55)
      : k < 0.75 ? vec3(0.25, 0.36, 0.38) : k < 0.9 ? vec3(0.42, 0.4, 0.37) : vec3(0.55, 0.45, 0.25);
    float shade = 0.75 + 0.35 * smoothstep(-pw, pw, (p.x - cx) * uSide);
    c = mix(c, glaze * lit * shade, ins);
    a = ins;
  }
  // The board, in front of the pots' feet.
  float board = smoothstep(-BLUR, BLUR, p.y - b) * (1.0 - smoothstep(-BLUR, BLUR, p.y - b - 0.018));
  return vec4(mix(c, WOOD * lit * 1.1, board), max(a, board));
}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  // x measured from the outer edge, where the window is.
  vec2 o = vec2(uSide > 0.0 ? uFrame.x - p.x : p.x, p.y);
  vec2 l = (o - vec2(0.15, 0.95)) * vec2(0.9, 1.0);
  float pool = 1.0 / (1.0 + 2.2 * dot(l, l));
  vec3 lit = vec3(0.4 + 0.75 * pool);
  vec3 col = WALL * lit;
  // Shadows under the shelves.
  col *= 1.0 - 0.25 * smoothstep(0.49, 0.56, p.y) * step(p.y, 0.56)
    - 0.25 * smoothstep(0.73, 0.8, p.y) * step(p.y, 0.8);
  vec4 s0 = shelf(p, 0.56, 0u, lit);
  col = mix(col, s0.rgb, s0.a);
  vec4 s1 = shelf(p, 0.8, 1u, lit);
  col = mix(col, s1.rgb, s1.a);
  // The floor, meeting the wall in a soft line.
  float onFloor = 1.0 - smoothstep(0.27, 0.31, p.y);
  vec3 fl = FLOOR * (0.45 + 0.4 * pool + 0.25 * p.y);
  col = mix(col, fl, onFloor);
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.5 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The wheel at full resolution in its box, premultiplied over the studio: the
 * splash tray (its outer wall, rim, slurry-wet floor and inner back wall) and
 * the metal wheel head, with slow radial streaks turning with the wheel and a
 * ring of wet slip around the pot's foot. Local x is mirrored so the light is
 * always on the outer side (+x).
 */
const WHEEL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** One device px in height units. */
uniform float uPx;
/** Wheel centre x, head top y (height units), pot units scale, side. */
uniform vec4 uWheel;
/** Wheel angle (rad), streak contrast, pot foot radius. */
uniform vec3 uTurn;
uniform vec3 uClay;
out vec4 outColor;
${DITHER_GLSL}
${SHARED_GLSL}
const float TR = ${g(TRAY_R)};
const float TRI = ${g(TRAY_R - 0.012)};
const float RIM = ${g(TRAY_RIM_Y)};
const float FLOORY = ${g(TRAY_FLOOR_Y)};
const float WR = ${g(WHEEL_R)};
const float WT = ${g(WHEEL_T)};
void main() {
  vec2 q = (gl_FragCoord.xy * uPx - uWheel.xy) / uWheel.z;
  q.x *= uWheel.w;
  float px = uPx / uWheel.z;
  float cov0 = clamp(0.5 - sdCylinder(q, TR, -4.0, RIM) / px, 0.0, 1.0);
  if (cov0 <= 0.0) { outColor = vec4(0.0); return; }

  // Splash tray: dark grey plastic, its outer wall lit from the outer side.
  float nx = clamp(q.x / TR, -1.0, 1.0);
  vec3 plastic = vec3(0.13, 0.135, 0.14);
  vec3 col = plastic * (AMB + 0.9 * max(dot(vec3(nx, 0.0, sqrt(1.0 - nx * nx)), LDIR), 0.0) * LIGHT);
  col *= 0.55 + 0.45 * smoothstep(-0.25, RIM * C, q.y);
  // The opening: the rim lip, then the inside.
  float top = sdEllipse(q - vec2(0.0, RIM * C), vec2(TR, TR * S));
  float inner = sdEllipse(q - vec2(0.0, RIM * C), vec2(TRI, TRI * S));
  vec3 lip = plastic * (AMB + 0.9 * LIGHT * LDIR.y) + 0.04 * LIGHT;
  col = mix(col, lip, clamp(0.5 - top / px, 0.0, 1.0));
  // Inside: the far inner wall above the floor's back edge, the wet floor below.
  float floorBack = FLOORY * C + sqrt(max(TRI * TRI - q.x * q.x, 0.0)) * S;
  vec3 wallIn = plastic * (AMB * 0.8 + 0.5 * LIGHT * smoothstep(floorBack, RIM * C + TRI * S, q.y));
  vec2 f = vec2(q.x, (FLOORY * C - q.y) / S);
  vec3 slurry = mix(plastic, uClay * 0.5, 0.6) * (AMB + 0.25 * LIGHT);
  slurry += LIGHT * 0.08 * exp(-dot(f - vec2(0.08, -0.12), f - vec2(0.08, -0.12)) * 30.0);
  vec3 inside = mix(slurry, wallIn, smoothstep(-px, px, q.y - floorBack));
  col = mix(col, inside, clamp(0.5 - inner / px, 0.0, 1.0));

  // Wheel head: a metal disc on a short side band.
  float head = sdCylinder(q, WR, -WT, 0.0);
  float hc = clamp(0.5 - head / px, 0.0, 1.0);
  if (hc > 0.0) {
    float hx = clamp(q.x / WR, -1.0, 1.0);
    vec3 n = vec3(hx, 0.0, sqrt(1.0 - hx * hx));
    vec3 metal = vec3(0.42, 0.43, 0.45);
    vec3 band = metal * (AMB * 0.7 + 0.8 * max(dot(n, LDIR), 0.0) * LIGHT)
      + LIGHT * 0.3 * pow(max(dot(n, HALF), 0.0), 30.0);
    // The top: radial streaks and fine lathe rings, turning with the wheel.
    vec2 d = vec2(q.x, -q.y / S);
    float r = length(d);
    float phi = atan(d.y, d.x * uWheel.w) - uTurn.x;
    float streak = sin(5.0 * phi) * 0.6 + sin(11.0 * phi + 1.3) * 0.4;
    vec3 disc = metal * (AMB + 0.8 * LDIR.y * LIGHT) * (1.0 + uTurn.y * streak * smoothstep(0.2, 0.9, r / WR));
    // A broad sheen towards the back, where the window reflects.
    disc += LIGHT * 0.12 * smoothstep(-0.05, 0.12, -d.y) * (1.0 - smoothstep(0.4 * WR, WR, r));
    // Wet slip around the pot's foot, and its contact shadow.
    float foot = uTurn.z;
    float wet = 1.0 - smoothstep(foot + 0.01, foot + 0.035, r);
    disc = mix(disc, uClay * (AMB + 0.6 * LIGHT) * 0.55 + LIGHT * 0.05, wet * 0.85);
    disc *= 1.0 - 0.45 * (1.0 - smoothstep(foot, foot + 0.02, r));
    float topCov = clamp(0.5 - sdEllipse(q, vec2(WR, WR * S)) / px, 0.0, 1.0);
    col = mix(col, mix(band, disc, topCov), hc);
  }
  outColor = vec4((col + dither8(gl_FragCoord.xy)) * cov0, cov0);
}
`;

/**
 * The pot at full resolution in its box, premultiplied over the wheel. For
 * each pixel, the front surface's height is found by a few fixed-point steps
 * through the radius profile (a 1D texture), and the wet clay is shaded with a
 * broad diffuse, a sharp specular and a throwing-ring normal tilt that spirals
 * with the wheel. The top is an ellipse: flat clay while closed, a rim and the
 * dark inside once opened.
 */
const POT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uProfile;
/** One device px in height units. */
uniform float uPx;
/** Wheel centre x, head top y (height units), pot units scale, side. */
uniform vec4 uWheel;
/** Pot height, top radius, hole radius, wobble offset at the top (pot units). */
uniform vec4 uPot;
/** Ring: radians per pot unit of height, phase offset, depth. */
uniform vec3 uRing;
/** Clay colour and shine. */
uniform vec4 uClay;
out vec4 outColor;
${DITHER_GLSL}
${SHARED_GLSL}
const float N = ${g(PROFILE_N)};
float radiusAt(float h) {
  float u = clamp(h / uPot.x, 0.0, 1.0);
  return texture(uProfile, vec2((u * (N - 1.0) + 0.5) / N, 0.5)).r;
}
vec3 wetClay(vec3 n, float occ) {
  float diff = max(dot(n, LDIR), 0.0);
  float nh = max(dot(n, HALF), 0.0);
  float spec = pow(nh, 90.0) * uClay.a + pow(nh, 12.0) * 0.06;
  float fres = pow(1.0 - max(dot(n, VIEW), 0.0), 4.0) * 0.12;
  return uClay.rgb * (AMB * occ + 0.85 * diff * LIGHT) + LIGHT * (spec + fres) * occ;
}
void main() {
  vec2 q = (gl_FragCoord.xy * uPx - uWheel.xy) / uWheel.z;
  q.x *= uWheel.w;
  float px = uPx / uWheel.z;
  float H = uPot.x;
  // Off-centre wobble, growing towards the top.
  float x = q.x - uPot.w * clamp(q.y / (C * H), 0.0, 1.0);

  // Front surface: solve h = (q.y + z(h) S) / C.
  float h = q.y / C;
  float r = radiusAt(h);
  for (int i = 0; i < 3; i++) {
    h = (q.y + sqrt(max(r * r - x * x, 0.0)) * S) / C;
    r = radiusAt(h);
  }
  float e = H / (N - 1.0);
  float slope = (radiusAt(h + e) - radiusAt(h - e)) / (2.0 * e);
  float body = max((abs(x) - r) * inversesqrt(1.0 + slope * slope), max(-h * C, (h - H) * C));

  // The top: an ellipse at the pot's height.
  float xt = q.x - uPot.w;
  vec2 tq = vec2(xt, q.y - H * C);
  float cap = sdEllipse(tq, vec2(uPot.y, uPot.y * S));
  float a = clamp(0.5 - min(body, cap) / px, 0.0, 1.0);
  if (a <= 0.0) { outColor = vec4(0.0); return; }

  // Body: the surface normal, tilted by the throwing rings.
  float z = sqrt(max(r * r - x * x, 0.0));
  float phi = atan(z, x * uWheel.w);
  float ring = h * uRing.x + phi + uRing.y;
  float depth = uRing.z * (1.0 - smoothstep(0.8, 2.0, fwidth(ring)));
  vec3 n = normalize(vec3(x / max(r, 1e-4), -slope + depth * sin(ring), z / max(r, 1e-4)));
  float occ = 0.55 + 0.45 * smoothstep(0.0, 0.05, h);
  vec3 col = wetClay(n, occ);

  // Top: the rim (or the closed top), then the dark inside.
  float cc = clamp(0.5 - cap / px, 0.0, 1.0);
  if (cc > 0.0) {
    vec2 d = vec2(xt, -tq.y / S);
    float rr = length(d);
    vec2 dn = d / max(rr, 1e-4);
    // Rounding off towards the edge, with faint spiral ridges.
    float swirl = sin(rr * uRing.x + atan(d.y, d.x * uWheel.w) + uRing.y);
    float tilt = 0.35 * smoothstep(0.3 * uPot.y, uPot.y, rr) + 0.5 * uRing.z * swirl;
    vec3 up = normalize(vec3(dn.x * tilt, 1.0, dn.y * tilt));
    vec3 topCol = wetClay(up, 1.0);
    float hole = uPot.z;
    if (hole > 0.0) {
      float hs = sdEllipse(tq, vec2(hole, hole * S));
      // Inside: the far wall, lit near its rim, darker down into the pot.
      float back = clamp((tq.y / (hole * S) + 1.0) * 0.5, 0.0, 1.0);
      vec3 inside = uClay.rgb * AMB * (0.25 + 0.75 * back * back) + uClay.rgb * LIGHT * 0.25 * back;
      topCol = mix(topCol, inside, clamp(0.5 - hs / px, 0.0, 1.0));
    }
    col = mix(col, topCol, cc);
  }
  outColor = vec4((col + dither8(gl_FragCoord.xy)) * a, a);
}
`;

/**
 * A potter's wheel in a bottom corner of a dim studio, the clay rising from a
 * mound into a vase, a bowl or a jar and sinking back, over and over.
 *
 * Passes: the studio at 1/4 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; the wheel and splash tray in a scissored
 * full-resolution box; then the pot in its own tight box, with its radius
 * profile in a 64 x 1 R16F texture updated every frame.
 */
export const pottery = defineEffect(potteryMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => {
          gl.deleteProgram(p);
        });
      const profileTex = scope.add(
        createDataTexture(gl, {
          width: PROFILE_N,
          height: 1,
          internalFormat: gl.R16F,
          format: gl.RED,
          type: gl.FLOAT,
          data: new Float32Array(PROFILE_N),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const roomProgram = program(ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, ["uPxToH", "uFrame", "uSide"]);
      const wheelProgram = program(WHEEL_FRAGMENT);
      const wu = createUniforms(gl, wheelProgram, ["uPx", "uWheel", "uTurn", "uClay"]);
      const potProgram = program(POT_FRAGMENT);
      const pu = createUniforms(gl, potProgram, [
        "uProfile",
        "uPx",
        "uWheel",
        "uPot",
        "uRing",
        "uClay",
      ]);
      gl.useProgram(potProgram);
      pu.i1("uProfile", 0);
      gl.useProgram(null);

      const layout = createLayout();
      const goal = createProfile();
      const shown = createProfile();
      const box: [number, number, number, number] = [0, 0, 0, 0];

      let width = 1;
      let height = 1;
      /** Seconds since create and cycles thrown, unwrapped (float64). */
      let time = 0;
      let phase = 0;
      /** Wheel angle, radians, kept wrapped. */
      let angle = 0;
      let fresh = true;
      /** What the room target holds; cleared whenever it may have been reallocated. */
      let drawnSide = 0;
      let drawnAspect = 0;

      /** Scissors to a box given in height units (x0, y0, x1, y1). */
      const scissor = (b: readonly number[]) => {
        const x0 = Math.max(0, Math.floor(b[0] * height));
        const y0 = Math.max(0, Math.floor(b[1] * height));
        const x1 = Math.min(width, Math.ceil(b[2] * height));
        const y1 = Math.min(height, Math.ceil(b[3] * height));
        gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
      };

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
          drawnSide = 0;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          phase += step / Math.max(1, p.cycle);
          angle = wrap(angle + step * p.spin * Math.PI * 2, 0, Math.PI * 2);
          const aspect = width / height;
          potteryLayout(aspect, p.corner, layout);
          const clay = clayFor(p.clay);

          // The pot's profile: eased towards the cycle's shape, so param changes reshape it.
          profileAt(phase, p.form, goal);
          if (fresh) {
            copyProfile(goal, shown);
          } else {
            relaxProfile(shown, goal, 1 - Math.exp(-step / RESHAPE_TIME));
          }
          fresh = false;
          gl.activeTexture(gl.TEXTURE0);
          updateDataTexture(gl, profileTex, PROFILE_N, 1, gl.RED, gl.FLOAT, shown.radius);

          // 1. The studio, re-rendered only when it changes, upscaled every frame.
          if (target.direct || drawnSide !== layout.side || drawnAspect !== aspect) {
            target.bind();
            gl.useProgram(roomProgram);
            ru.f2("uFrame", aspect, 1);
            ru.f1("uSide", layout.side);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            drawnSide = layout.side;
            drawnAspect = aspect;
          }
          target.blit();

          // 2. The wheel, then 3. the pot, premultiplied, each in its own box.
          gl.viewport(0, 0, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          scissor(layout.wheelBox);
          gl.useProgram(wheelProgram);
          wu.f1("uPx", 1 / height);
          wu.f4("uWheel", layout.cx, layout.baseY, layout.scale, layout.side);
          // Streaks blur out as the wheel speeds up.
          wu.f3("uTurn", angle, 0.12 / (1 + 3 * p.spin), shown.radius[0]);
          wu.f3("uClay", clay.color[0], clay.color[1], clay.color[2]);
          triangle.draw();

          scissor(potBox(layout, shown, box));
          gl.useProgram(potProgram);
          gl.bindTexture(gl.TEXTURE_2D, profileTex);
          pu.f1("uPx", 1 / height);
          pu.f4("uWheel", layout.cx, layout.baseY, layout.scale, layout.side);
          pu.f4(
            "uPot",
            shown.height,
            shown.radius[PROFILE_N - 1],
            holeRadius(shown),
            WOBBLE * Math.sin(angle),
          );
          pu.f3(
            "uRing",
            (Math.PI * 2) / RING_PITCH,
            wrap(time * RING_DRIFT - angle, 0, Math.PI * 2),
            RING_AMP_MOUND + (RING_AMP - RING_AMP_MOUND) * shown.open,
          );
          pu.f4("uClay", clay.color[0], clay.color[1], clay.color[2], clay.shine);
          triangle.draw();

          gl.bindTexture(gl.TEXTURE_2D, null);
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
