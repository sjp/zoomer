/**
 * The Starting Soon backdrops, each a calm full-frame background behind the
 * card, coloured from the accent:
 *
 * - Blobs: the Gradient Blobs field (`blob-field.ts`), at 1/8 resolution and
 *   upscaled.
 * - Rainy window: a lo-fi pixel-art room (a window onto a rainy city at night,
 *   a sill with a plant, a desk with a lamp in the accent colour), drawn at
 *   about 6 px per pixel and upscaled without smoothing, with the porch rain's
 *   drops (`porch-sim.ts`) falling past the glass as one-pixel streaks.
 * - Shapes: outlined rings, triangles, squares, pluses and dots rising slowly
 *   and turning over a dark gradient.
 * - Stars: the shared point stars (`starfield.ts`), turning slowly about the
 *   frame's centre over a night gradient.
 */
import { BLOB_FIELD_FRAGMENT, writeBlobUniforms } from "../blob-field";
import { MAX_BLOBS } from "../blobs/blobs.meta";
import { LINEAR_GAMMA, type Rgb } from "../color";
import {
  createFullscreenTriangle,
  createGradientBackground,
  createUniforms,
  FULLSCREEN_VERTEX,
  type Scope,
  scopedProgram,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { clamp } from "../math";
import { createRain, stepRain } from "../porch/porch-sim";
import { createStarDraw, createStarSprites } from "../starfield";
import { advanceRotation, seedSalt, wrapAngle } from "../starfield-sim";
import { createSpriteBatch, QUAD, SPRITE_SPIN_GLSL } from "../sprites";
import { createStreakRenderer, STREAK_FLOATS } from "../streaks";
import {
  blobColours,
  createShapes,
  createWindowGeometry,
  RAIN_DROPS,
  RAIN_PACE,
  rainProgress,
  rotateHue,
  SHAPE_COUNT,
  shapeAngle,
  shapeSway,
  stepShapes,
  windowGeometry,
} from "./startingsoon-backdrop-sim";
import type { BackdropId } from "./startingsoon.meta";

/** Binds the framebuffer a backdrop draws into, with a full-frame viewport. */
export type BindTarget = () => void;

/** The frame a backdrop draws for. */
interface BackdropFrame {
  width: number;
  height: number;
  /** Device px per 1080p px. */
  scale: number;
  /** The accent, 0..1 sRGB. */
  accent: Readonly<Rgb>;
}

interface Backdrop {
  /** Advances its motion; called every frame, shown or not. */
  step: (dt: number, frame: Readonly<BackdropFrame>) => void;
  /** Draws it over the whole of the target `bind` binds (with blending off). */
  draw: (bind: BindTarget, frame: Readonly<BackdropFrame>) => void;
}

const sameRgb = (a: Readonly<Rgb>, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// ---------------------------------------------------------------- Blobs

/** The blobs' low-res divisor: the field has no detail, so 1/64 of the pixels is plenty. */
const BLOB_DIVISOR = 8;
const BLOB_COUNT = 5;
const BLOB_SPEED = 0.25;
const BLOB_SOFTNESS = 1.1;
/** The field's background, linear light: a deep violet-black. */
const BLOB_BASE: Rgb = [0.004, 0.003, 0.012];

function createBlobs(gl: WebGL2RenderingContext, scope: Scope): Backdrop {
  const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BLOB_FIELD_FRAGMENT);
  const u = createUniforms(gl, program, ["uToUnits", "uBlobs", "uColors", "uBase", "uCount"]);
  const triangle = scope.own(createFullscreenTriangle(gl));
  const low = scope.own(createLowResTarget(gl, { keep: true }));
  const blobs = new Float32Array(MAX_BLOBS * 4);
  const colours = new Float32Array(MAX_BLOBS * 3);
  const scratch: Rgb = [0, 0, 0];
  const lastAccent: Rgb = [-1, -1, -1];
  let time = 0;
  return {
    step(dt) {
      time += dt * BLOB_SPEED;
    },
    draw(bind, f) {
      const aspect = f.width / Math.max(1, f.height);
      low.resize(f.width, f.height, BLOB_DIVISOR);
      gl.useProgram(program);
      if (!sameRgb(f.accent, lastAccent)) {
        lastAccent[0] = f.accent[0];
        lastAccent[1] = f.accent[1];
        lastAccent[2] = f.accent[2];
        blobColours(f.accent, LINEAR_GAMMA, colours, scratch);
        gl.uniform3fv(u.loc.uColors, colours);
      }
      writeBlobUniforms(blobs, BLOB_COUNT, time, aspect, BLOB_SOFTNESS);
      gl.uniform4fv(u.loc.uBlobs, blobs);
      u.f2("uToUnits", aspect / low.width, 1 / low.height);
      u.v3("uBase", BLOB_BASE);
      u.i1("uCount", BLOB_COUNT);
      low.bind();
      triangle.draw();
      bind();
      low.blit();
    },
  };
}

// ---------------------------------------------------------------- Rainy window

/** Reference px per pixel of the pixel-art room. */
const ROOM_PIXEL = 6;

const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** The pixel-art room's size, in its own pixels. */
uniform vec2 uRes;
/** The window: centre, half size (design units, y up). */
uniform vec4 uWin;
/** Bar width, cross bar height, lamp x, desk top. */
uniform vec4 uRoom;
uniform vec3 uAccent;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float box(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c);
  return step(d.x, h.x) * step(d.y, h.y);
}
float seg(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return step(length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)), r);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float bar = uRoom.x;
  float lampX = uRoom.z;
  float deskY = uRoom.w;
  vec2 head = vec2(lampX - 0.1, deskY + 0.25);
  vec2 pool = vec2(lampX - 0.16, deskY);
  vec3 warm = vec3(1.0, 0.72, 0.42);

  // The wall: dark plum, lit warm round the lamp.
  vec2 dh = p - head;
  float glow = 0.55 * exp(-dot(dh, dh) / 0.05) + 0.25 * exp(-dot(dh, dh) / 0.4);
  vec3 col = vec3(0.13, 0.09, 0.14) * (0.8 + 0.2 * smoothstep(-0.5, 0.5, p.y)) + warm * 0.22 * glow;

  // The window, frame and glass.
  vec2 w = p - uWin.xy;
  vec2 aw = abs(w);
  if (aw.x < uWin.z + bar && aw.y < uWin.w + bar) {
    bool glass = aw.x < uWin.z && aw.y < uWin.w && aw.x > 0.5 * bar && abs(w.y - uRoom.y) > 0.5 * bar;
    if (glass) {
      float t = (w.y + uWin.w) / (2.0 * uWin.w);
      col = mix(vec3(0.17, 0.13, 0.27), vec3(0.04, 0.05, 0.13), t);
      // Far towers, then nearer ones, each a column of pixels with a hashed height.
      float farCol = floor(p.x / 0.034 + 40.0);
      float farTop = -uWin.w + 2.0 * uWin.w * (0.35 + 0.3 * hash(vec2(farCol, 3.0)));
      if (w.y < farTop) {
        col = vec3(0.10, 0.09, 0.18);
      }
      float nearCol = floor(p.x / 0.06 + 40.0);
      float nearTop = -uWin.w + 2.0 * uWin.w * (0.12 + 0.3 * hash(vec2(nearCol, 7.0)));
      if (w.y < nearTop) {
        col = vec3(0.05, 0.045, 0.09);
        vec2 cell = floor(vec2(p.x, w.y) / vec2(0.012, 0.016));
        if (mod(cell.x, 2.0) < 1.0 && mod(cell.y, 2.0) < 1.0 && hash(cell) < 0.14) {
          col = warm * (0.45 + 0.25 * hash(cell + 9.0));
        }
      }
      // The lamp's faint reflection.
      col += warm * 0.06 * glow;
    } else {
      col = vec3(0.30, 0.21, 0.19) * (0.7 + 0.6 * glow);
    }
  }

  // The sill, and a plant on it.
  float sillTop = uWin.y - uWin.w - bar;
  if (aw.x < uWin.z + 2.0 * bar && p.y < sillTop && p.y > sillTop - 0.026) {
    col = vec3(0.38, 0.27, 0.23) * (0.75 + 0.5 * glow);
  }
  vec2 pot = vec2(uWin.x - uWin.z + 0.09, sillTop + 0.035);
  if (box(p, pot, vec2(0.035, 0.035)) > 0.0) {
    col = vec3(0.55, 0.30, 0.20) * (0.7 + 0.4 * glow);
  }
  vec2 lp = p - (pot + vec2(0.0, 0.09));
  float leaves = step(length(lp * vec2(1.0, 1.3)), 0.07) + step(length(lp - vec2(0.05, 0.045)), 0.04)
    + step(length(lp - vec2(-0.05, 0.035)), 0.038);
  if (leaves > 0.0) {
    col = mix(vec3(0.16, 0.34, 0.20), vec3(0.24, 0.46, 0.26), step(0.5, hash(floor(p * uRes.y / 2.0))));
  }

  // The desk, and the lamp's pool of light on it.
  if (p.y < deskY) {
    vec2 dp = (p - pool) * vec2(0.6, 2.2);
    float lit = exp(-dot(dp, dp) / 0.02);
    vec3 wood = p.y > deskY - 0.025 ? vec3(0.36, 0.23, 0.16) : vec3(0.21, 0.13, 0.10);
    col = wood * (0.6 + 1.1 * lit);
  }
  // A stack of books at the other end.
  float bx = -lampX + 0.05;
  if (box(p, vec2(bx, deskY + 0.015), vec2(0.09, 0.015)) > 0.0) col = vec3(0.24, 0.32, 0.45);
  if (box(p, vec2(bx + 0.01, deskY + 0.042), vec2(0.08, 0.012)) > 0.0) col = vec3(0.55, 0.42, 0.25);
  if (box(p, vec2(bx - 0.005, deskY + 0.066), vec2(0.085, 0.012)) > 0.0) col = vec3(0.45, 0.20, 0.22);

  // The lamp: a base, a two-part arm, a shade in the accent and its bulb.
  vec3 metal = vec3(0.22, 0.2, 0.24);
  if (box(p, vec2(lampX, deskY + 0.01), vec2(0.06, 0.012)) > 0.0) col = metal;
  vec2 elbow = vec2(lampX + 0.03, deskY + 0.17);
  if (seg(p, vec2(lampX, deskY + 0.02), elbow, 0.009) + seg(p, elbow, head + vec2(0.03, 0.02), 0.009) > 0.0) {
    col = metal * 1.3;
  }
  vec2 sp = p - head;
  sp = mat2(0.87, -0.5, 0.5, 0.87) * sp;
  float halfW = 0.03 + 0.5 * clamp(0.04 - sp.y, 0.0, 0.08);
  if (abs(sp.y) < 0.04 && abs(sp.x) < halfW) {
    col = uAccent * (0.55 + 0.45 * step(0.0, sp.x));
  }
  if (abs(sp.x) < 0.045 && sp.y < -0.04 && sp.y > -0.055) {
    col = vec3(1.0, 0.93, 0.75);
  }

  // A small palette, as pixel art has.
  outColor = vec4(floor(col * 40.0 + 0.5) / 40.0, 1.0);
}
`;

/** Nearest-neighbour upscale: every room pixel a crisp square. */
const NEAREST_COMPOSITE = /* glsl */ `
vec4 composite(vec2 uv) {
  return texelFetch(uLowRes, ivec2(min(uv * uLowResSize, uLowResSize - 1.0)), 0);
}
`;

/**
 * Writes to `out[o]`, `out[o + 1]` the first and count of the room's pixel
 * columns (or rows) whose centres fall strictly between `lo` and `hi` (room
 * pixels), as the room shader's glass test picks them: a scissor box.
 */
function pixelSpan(lo: number, hi: number, out: Int32Array, o: number) {
  const first = Math.floor(lo - 0.5) + 1;
  const last = Math.ceil(hi - 0.5) - 1;
  out[o] = first;
  out[o + 1] = Math.max(0, last - first + 1);
}

function createRainyWindow(gl: WebGL2RenderingContext, scope: Scope): Backdrop {
  const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROOM_FRAGMENT);
  const u = createUniforms(gl, program, ["uRes", "uWin", "uRoom", "uAccent"]);
  const triangle = scope.own(createFullscreenTriangle(gl));
  const low = scope.own(createLowResTarget(gl, { composite: NEAREST_COMPOSITE, dither: false }));
  const streaks = scope.own(createStreakRenderer(gl, RAIN_DROPS));
  const rain = createRain(7, RAIN_DROPS);
  const geo = createWindowGeometry();
  /** Scissor boxes of the four panes: x, w, y, h each. */
  const panes = new Int32Array(16);
  const spans = new Int32Array(4);
  return {
    step(dt) {
      // The porch rain's own units: its pool wraps at the same pace, and the
      // window maps each drop's fall onto the glass.
      stepRain(rain, RAIN_DROPS, Math.max(0, dt) * RAIN_PACE, 0, 1);
    },
    draw(bind, f) {
      const aspect = f.width / Math.max(1, f.height);
      windowGeometry(aspect, geo);
      const divisor = Math.max(1, Math.round(ROOM_PIXEL * f.scale));
      low.resize(f.width, f.height, divisor);
      const rw = low.width;
      const rh = low.height;
      gl.useProgram(program);
      u.f2("uRes", rw, rh);
      u.f4("uWin", geo.cx, geo.cy, geo.hw, geo.hh);
      u.f4("uRoom", geo.bar, geo.crossY, geo.lampX, geo.deskY);
      u.f3("uAccent", f.accent[0], f.accent[1], f.accent[2]);
      low.bind();
      triangle.draw();

      // Rain: one-pixel streaks in room pixels (y down), clipped to each pane.
      const toX = (x: number) => x * rh + 0.5 * rw;
      const toY = (y: number) => 0.5 * rh - y * rh;
      const d = streaks.data;
      const left = geo.cx - geo.hw;
      const top = geo.cy + geo.hh;
      for (let i = 0; i < RAIN_DROPS; i++) {
        const depth = rain.depth[i];
        const x = toX(left + rain.u[i] * 2 * geo.hw);
        const y = toY(top - clamp(rainProgress(rain.y[i], depth), 0, 1) * 2 * geo.hh);
        const len = (0.012 + 0.022 * depth) * rh;
        const b = (0.18 + 0.22 * depth) * rain.glint[i];
        const o = i * STREAK_FLOATS;
        d[o] = x;
        d[o + 1] = y - len;
        d[o + 2] = x;
        d[o + 3] = y;
        d[o + 4] = 0.55 * b;
        d[o + 5] = 0.65 * b;
        d[o + 6] = 0.85 * b;
        d[o + 7] = 0.5;
      }
      streaks.upload(RAIN_DROPS);
      // Pane edges in room pixels, y up for the scissor.
      const half = 0.5 * geo.bar;
      const yUp = (y: number) => y * rh + 0.5 * rh;
      pixelSpan(toX(left), toX(geo.cx - half), spans, 0);
      pixelSpan(toX(geo.cx + half), toX(geo.cx + geo.hw), spans, 2);
      const lowY = yUp(geo.cy - geo.hh);
      const crossLo = yUp(geo.cy + geo.crossY - half);
      const crossHi = yUp(geo.cy + geo.crossY + half);
      const topY = yUp(geo.cy + geo.hh);
      for (let k = 0; k < 4; k++) {
        const o = k * 4;
        panes[o] = spans[(k & 1) * 2];
        panes[o + 1] = spans[(k & 1) * 2 + 1];
      }
      pixelSpan(lowY, crossLo, spans, 0);
      pixelSpan(crossHi, topY, spans, 2);
      for (let k = 0; k < 4; k++) {
        const o = k * 4;
        panes[o + 2] = spans[(k >> 1) * 2];
        panes[o + 3] = spans[(k >> 1) * 2 + 1];
      }
      gl.enable(gl.SCISSOR_TEST);
      for (let k = 0; k < 4; k++) {
        const o = k * 4;
        gl.scissor(panes[o], panes[o + 2], panes[o + 1], panes[o + 3]);
        streaks.draw(RAIN_DROPS, rw, rh);
      }
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      bind();
      low.blit();
    },
  };
}

// ---------------------------------------------------------------- Shapes

const SHAPE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (device px, y down), half size (px), kind. */
layout(location = 1) in vec4 aShape;
/** Premultiplied colour. */
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vKind;
flat out vec4 vColor;
flat out float vPx;
${SPRITE_SPIN_GLSL}
void main() {
  vec2 px = aShape.xy + spinCorner(aCorner, aSpin) * aShape.z * 1.05;
  vLocal = aCorner * 1.05;
  vKind = aShape.w;
  vColor = aColor;
  vPx = 1.0 / max(aShape.z, 1.0);
  gl_Position = vec4(px.x / uResolution.x * 2.0 - 1.0, 1.0 - px.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vKind;
flat in vec4 vColor;
flat in float vPx;
out vec4 outColor;
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float sdTriangle(vec2 p, float r) {
  const float k = 1.7320508;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
void main() {
  vec2 p = vLocal;
  float d;
  if (vKind < 0.5) {
    d = abs(length(p) - 0.78) - 0.08;
  } else if (vKind < 1.5) {
    d = abs(sdTriangle(vec2(p.x, p.y - 0.12), 0.78)) - 0.07;
  } else if (vKind < 2.5) {
    d = abs(sdBox(p, vec2(0.58)) - 0.08) - 0.07;
  } else if (vKind < 3.5) {
    d = min(sdBox(p, vec2(0.72, 0.16)), sdBox(p, vec2(0.16, 0.72)));
  } else {
    d = length(p) - 0.42;
  }
  outColor = vColor * clamp(0.5 - d / vPx, 0.0, 1.0);
}
`;

/** Floats per shape instance: centre, half size, kind; colour; spin. */
const SHAPE_FLOATS = 10;

function createShapeBackdrop(gl: WebGL2RenderingContext, scope: Scope): Backdrop {
  const program = scopedProgram(gl, scope, SHAPE_VERTEX, SHAPE_FRAGMENT);
  const u = createUniforms(gl, program, ["uResolution"]);
  const batch = scope.own(createSpriteBatch(gl, SHAPE_COUNT, [4, 4], [QUAD], { rotation: true }));
  if (batch.stride !== SHAPE_FLOATS) {
    throw new Error("Starting Soon shapes: layout mismatch");
  }
  const gradient = scope.own(createGradientBackground(gl));
  const top: Rgb = [0, 0, 0];
  const bottom: Rgb = [0, 0, 0];
  const tint: Rgb = [0, 0, 0];
  const shapes = createShapes(SHAPE_COUNT);
  return {
    step(dt) {
      stepShapes(shapes, dt);
    },
    draw(bind, f) {
      const a = f.accent;
      for (let c = 0; c < 3; c++) {
        top[c] = 0.025 + 0.08 * a[c];
        bottom[c] = 0.035 + 0.2 * a[c];
      }
      bind();
      gradient.draw(top, bottom);
      const data = batch.data;
      for (let i = 0; i < SHAPE_COUNT; i++) {
        rotateHue(a, (shapes.hue[i] - 0.5) * 140, tint);
        const alpha = shapes.alpha[i];
        const o = i * SHAPE_FLOATS;
        data[o] = shapes.x[i] * f.width + shapeSway(shapes, i) * f.scale;
        data[o + 1] = shapes.y[i] * f.scale;
        data[o + 2] = shapes.half[i] * f.scale;
        data[o + 3] = shapes.kind[i];
        data[o + 4] = (0.35 + 0.65 * tint[0]) * alpha;
        data[o + 5] = (0.35 + 0.65 * tint[1]) * alpha;
        data[o + 6] = (0.35 + 0.65 * tint[2]) * alpha;
        data[o + 7] = alpha;
        data[o + 8] = shapeAngle(shapes, i);
        data[o + 9] = 1;
      }
      batch.upload(SHAPE_COUNT);
      gl.useProgram(program);
      u.f2("uResolution", f.width, f.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      batch.draw(0, SHAPE_COUNT);
      gl.disable(gl.BLEND);
    },
  };
}

// ---------------------------------------------------------------- Stars

/** Bounds the star list: a 21:9 frame at `STAR_DENSITY` lists about 7000. */
const MAX_STARS = 12000;
const STAR_DENSITY = 0.14;
const STAR_MARGIN = 4;
/** The sky turns about the frame's centre this many degrees a minute. */
const STAR_TURN = 2.5;

function createStarBackdrop(gl: WebGL2RenderingContext, scope: Scope): Backdrop {
  const stars = scope.own(createStarSprites(gl, MAX_STARS));
  const gradient = scope.own(createGradientBackground(gl));
  const starDraw = createStarDraw();
  const pole: [number, number] = [0, 540];
  const top: Rgb = [0, 0, 0];
  const bottom: Rgb = [0, 0, 0];
  let builtWidth = -1;
  let rotation = 0;
  let time = 0;
  return {
    step(dt) {
      const d = Math.max(0, dt);
      rotation = wrapAngle(advanceRotation(rotation, d, STAR_TURN));
      time += d;
    },
    draw(bind, f) {
      const refWidth = Math.round(f.width / Math.max(1e-6, f.scale));
      if (refWidth !== builtWidth) {
        builtWidth = refWidth;
        pole[0] = refWidth / 2;
        // Allocates only when the frame's width changes.
        stars.build({
          salt: seedSalt(3),
          density: STAR_DENSITY,
          pole,
          refWidth,
          refHeight: 1080,
          rotates: true,
          margin: STAR_MARGIN,
        });
      }
      const a = f.accent;
      for (let c = 0; c < 3; c++) {
        top[c] = 0.01 + 0.03 * a[c];
        bottom[c] = 0.03 + 0.1 * a[c];
      }
      bind();
      gradient.draw(top, bottom);
      starDraw.width = f.width;
      starDraw.height = f.height;
      starDraw.scale = f.scale;
      starDraw.pole = pole;
      starDraw.rotation = rotation;
      starDraw.time = time;
      starDraw.colorful = 0.5;
      starDraw.gain = 0.9;
      starDraw.twinkle = 0.5;
      stars.draw(starDraw);
    },
  };
}

// ---------------------------------------------------------------- All four

interface Backdrops {
  /** Advances every backdrop (so one comes back where it would be). */
  step: (dt: number, frame: Readonly<BackdropFrame>) => void;
  draw: (id: BackdropId, bind: BindTarget, frame: Readonly<BackdropFrame>) => void;
}

export function createBackdrops(gl: WebGL2RenderingContext, scope: Scope): Backdrops {
  const all: Record<BackdropId, Backdrop> = {
    blobs: createBlobs(gl, scope),
    rain: createRainyWindow(gl, scope),
    shapes: createShapeBackdrop(gl, scope),
    stars: createStarBackdrop(gl, scope),
  };
  return {
    step(dt, f) {
      const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
      all.blobs.step(d, f);
      all.rain.step(d, f);
      all.shapes.step(d, f);
      all.stars.step(d, f);
    },
    draw(id, bind, f) {
      all[id].draw(bind, f);
    },
  };
}
