import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat as F,
  type RenderTarget,
  scopedProgram,
  withScope,
} from "../gl";
import { fitScale } from "../scene-layout";
import { SDF2D_GLSL } from "../sdf-glsl";
import { createShotSchedule, restartShots, screenFlicker, stepShots } from "../shot-schedule";
import { createStreamOverlays } from "../stream-overlay/overlay-layer";
import { defineEffect } from "../types";
import { type Genre, GENRE_PALETTES } from "./monitorglow-schedule";
import { monitorglowMeta } from "./monitorglow.meta";

/** Where the monitor sits, seen from the wall: in front of the speaker, below eye level (design units). */
const LIGHT_AXIS = [0, -0.25] as const;
/** Height of the light pool's centre on the wall. */
const POOL_Y = -0.04;
/** The corner, where the back wall meets the side wall on the left. */
const CORNER_X = -0.68;
/** How much of the monitor's light the back wall and the side wall catch. */
const BACK_WALL_LIGHT = 0.85;
const SIDE_WALL_LIGHT = 0.42;
/** Brightness of the lit wall per unit of light, and of the desk strip's. */
const LIGHT_GAIN = 4;
const STRIP_GAIN = 0.9;
/** The room's dim cool ambient light, from the rest of the night. */
const AMBIENT = [0.05, 0.055, 0.075] as const;
/** The silhouettes' colour, a cool near-black scaled by their grey albedo. */
const OBJECT_TINT = [0.9, 0.95, 1.1] as const;

/** The genre param's value as a `Genre` (an unknown value plays Adventure). */
function toGenre(value: string): Genre {
  switch (value) {
    case "shooter":
    case "racing":
    case "horror":
    case "cosy":
    case "film":
      return value;
    default:
      return "adventure";
  }
}

const v2 = (c: readonly number[]) => `vec2(${F(c[0])}, ${F(c[1])})`;
const v3 = (c: readonly number[]) => `vec3(${F(c[0])}, ${F(c[1])}, ${F(c[2])})`;

/**
 * The room, drawn once per resize with four samples per pixel. Each texel
 * holds: R, how much of the wall's paint shows (the paint colour is a param,
 * applied each frame); G, the grey albedo of the silhouettes in front of it
 * (poster, shelf, chair); B, how much of the desk strip's light reaches it;
 * A, how much of the monitor's light reaches it, with the soft shadows the
 * chair, shelf and poster cast away from the screen.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
/** Design units per frame unit (see fitScale). */
uniform float uK;
out vec4 outColor;
${SDF2D_GLSL}
const vec2 LIGHT = ${v2(LIGHT_AXIS)};
const float CORNER_X = ${F(CORNER_X)};

/** The chair's back and headrest, centred behind the speaker. */
float sdChair(vec2 p) {
  float head = sdBox(p - vec2(0.0, -0.02), vec2(0.17, 0.16), 0.08);
  float back = sdBox(p - vec2(0.0, -0.4), vec2(0.25, 0.26), 0.07);
  float neck = sdBox(p - vec2(0.0, -0.16), vec2(0.13, 0.06), 0.0);
  return min(min(head, back), neck);
}

/** The shelf board, its brackets and what stands on it. */
float sdShelf(vec2 p) {
  float d = sdBox(p - vec2(0.61, 0.08), vec2(0.19, 0.008), 0.002);
  d = min(d, sdBox(p - vec2(0.48, 0.055), vec2(0.008, 0.02), 0.0));
  d = min(d, sdBox(p - vec2(0.74, 0.055), vec2(0.008, 0.02), 0.0));
  // Books, leaning a little at the end.
  d = min(d, sdBox(p - vec2(0.452, 0.128), vec2(0.010, 0.040), 0.001));
  d = min(d, sdBox(p - vec2(0.474, 0.134), vec2(0.011, 0.046), 0.001));
  d = min(d, sdBox(p - vec2(0.497, 0.124), vec2(0.010, 0.036), 0.001));
  d = min(d, sdBox(p - vec2(0.519, 0.130), vec2(0.011, 0.042), 0.001));
  vec2 q = p - vec2(0.545, 0.122);
  q = mat2(0.94, 0.34, -0.34, 0.94) * q;
  d = min(d, sdBox(q, vec2(0.010, 0.036), 0.001));
  // A plant in a pot.
  d = min(d, sdBox(p - vec2(0.64, 0.104), vec2(0.022, 0.018), 0.004));
  d = min(d, length(p - vec2(0.628, 0.142)) - 0.022);
  d = min(d, length(p - vec2(0.655, 0.150)) - 0.026);
  d = min(d, length(p - vec2(0.642, 0.175)) - 0.018);
  // A boxed figure and a small speaker.
  d = min(d, sdBox(p - vec2(0.72, 0.126), vec2(0.024, 0.038), 0.003));
  d = min(d, sdBox(p - vec2(0.775, 0.112), vec2(0.016, 0.024), 0.004));
  return d;
}

/** The poster's frame (outer box). */
float sdPoster(vec2 p) {
  return sdBox(p - vec2(-0.45, 0.16), vec2(0.105, 0.15), 0.004);
}

/** How much a shadow covers a point at distance d from its edge, blurred over w. */
float softShadow(float d, float w) {
  return 1.0 - smoothstep(-w, w, d);
}

vec4 room(vec2 p) {
  // The wall: the back wall, or the side wall left of the corner, darker at the corner.
  float paint = 1.0;
  float albedo = 0.0;
  float side = cover(p.x - CORNER_X);
  float lit = mix(${F(BACK_WALL_LIGHT)}, ${F(SIDE_WALL_LIGHT)}, side);
  lit *= 1.0 - 0.35 * exp(-abs(p.x - CORNER_X) / 0.03);
  paint *= 1.0 - 0.06 * side;
  // The desk strip's light, rising from the bottom edge across the desk's width.
  float yb = p.y + 0.5 / uK;
  float strip = (0.9 * exp(-yb / 0.08) + 0.25 * exp(-yb / 0.3)) * smoothstep(1.15, 0.75, abs(p.x));

  // Shadows on the wall, cast away from the screen: the further an object stands
  // from the wall, the bigger and softer its shadow.
  vec2 rel = p - LIGHT;
  float shade = 0.65 * softShadow(sdChair(LIGHT + rel / 1.22), 0.07);
  shade = max(shade, 0.6 * softShadow(sdShelf(LIGHT + rel / 1.06), 0.012));
  shade = max(shade, 0.4 * softShadow(sdPoster(LIGHT + rel / 1.01), 0.006));
  lit *= 1.0 - shade;
  // The chair also blocks the strip's light from the wall just above its back.
  strip *= 1.0 - 0.6 * softShadow(sdChair(p - vec2(0.0, 0.04)), 0.06);

  // The poster: a dark frame round a dim print of hills under a sun.
  float dp = sdPoster(p);
  float c = cover(dp);
  if (c > 0.0) {
    vec2 q = p - vec2(-0.45, 0.16);
    float inner = cover(sdBox(q, vec2(0.093, 0.138), 0.0));
    float art = 0.24 + 0.1 * smoothstep(0.1, -0.1, q.y);
    art = mix(art, 0.42, cover(length(q - vec2(0.03, 0.05)) - 0.035));
    art = mix(art, 0.12, cover(q.y + 0.04 - 0.035 * sin(q.x * 32.0 + 1.0)));
    float a = mix(0.1, art, inner);
    paint = mix(paint, 0.0, c);
    albedo = mix(albedo, a, c);
    lit = mix(lit, ${F(BACK_WALL_LIGHT)} * 0.95, c);
    strip *= 1.0 - 0.2 * c;
  }

  // The shelf and its things, in silhouette.
  c = cover(sdShelf(p));
  if (c > 0.0) {
    paint = mix(paint, 0.0, c);
    albedo = mix(albedo, 0.12, c);
    lit = mix(lit, 0.75, c);
  }

  // The chair, nearest the screen: darker at its rounded edges, with two
  // lighter stripes down its back.
  float dc = sdChair(p);
  c = cover(dc);
  if (c > 0.0) {
    float stripe = cover(abs(abs(p.x) - 0.09) - 0.014);
    float a = mix(0.1, 0.26, stripe);
    float rim = 0.55 + 0.45 * smoothstep(0.0, 0.07, -dc);
    float topLit = 0.8 + 0.2 * smoothstep(-0.3, 0.1, p.y);
    paint = mix(paint, 0.0, c);
    albedo = mix(albedo, a, c);
    lit = mix(lit, rim * topLit, c);
    strip = mix(strip, 0.25 * exp(-yb / 0.25), c);
  }
  return vec4(paint, albedo, clamp(strip, 0.0, 1.0), clamp(lit, 0.0, 1.0));
}

void main() {
  px = 1.0 / (uRes.y * uK);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 1 || i == 2 ? 0.25 : -0.25, i >= 2 ? 0.25 : -0.25);
    vec2 f = (gl_FragCoord.xy + o - 0.5 * uRes) / uRes.y;
    sum += room(f / uK);
  }
  outColor = sum * 0.25;
}
`;

/**
 * Every frame: the cached room lit by the monitor's pool of light (its colour,
 * centre and radius from the shot schedule) and the desk strip, with dither.
 */
const LIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform vec2 uRes;
uniform float uK;
uniform vec3 uWall;
uniform vec3 uLight;
/** The pool's centre (design units) and radius. */
uniform vec3 uPool;
uniform vec3 uStrip;
out vec4 outColor;
${DITHER_GLSL}
const vec3 AMBIENT = ${v3(AMBIENT)};
const vec3 OBJECT_TINT = ${v3(OBJECT_TINT)};
void main() {
  vec4 r = texelFetch(uRoom, ivec2(gl_FragCoord.xy), 0);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (uRes.y * uK);
  vec2 d = (p - uPool.xy) / uPool.z;
  d.y *= 1.15;
  float pool = 1.0 / (1.0 + 2.5 * dot(d, d));
  vec3 albedo = uWall * r.r + OBJECT_TINT * r.g;
  vec3 light = AMBIENT + uLight * (pool * r.a) + uStrip * r.b;
  outColor = vec4(albedo * light + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A dark bedroom wall at night, lit by a big monitor just out of shot in front
 * of the speaker: a painted wall with a corner on the left, a poster, a shelf
 * and the top of a gaming chair behind the speaker's head, all drawn once per
 * resize. Each frame relights that from a few uniforms: the screen's light (a
 * seeded schedule of shots in the genre's palette, with the odd bright burst),
 * its pool's centre and size, and the desk's LED strip along the bottom. The
 * stream overlays draw on top.
 */
export const monitorglow = defineEffect(monitorglowMeta, {
  create(gl) {
    return withScope((scope) => {
      const roomProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const lightProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, LIGHT_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ru = createUniforms(gl, roomProgram, ["uRes", "uK"]);
      const lu = createUniforms(gl, lightProgram, [
        "uRoom",
        "uRes",
        "uK",
        "uWall",
        "uLight",
        "uPool",
        "uStrip",
      ]);
      gl.useProgram(lightProgram);
      lu.i1("uRoom", 0);
      gl.useProgram(null);
      const overlays = createStreamOverlays(gl, scope);

      let roomTarget: RenderTarget | null = null;
      scope.defer(() => {
        roomTarget?.dispose();
      });
      let width = 1;
      let height = 1;
      let k = 1;
      let roomDrawn = false;
      const wallRgb = unitRgbMemo();
      const stripRgb = unitRgbMemo();
      const schedule = createShotSchedule(0, GENRE_PALETTES.adventure, 0);
      let started = false;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          k = fitScale(width / height);
          roomTarget?.dispose();
          roomTarget = null;
          roomTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          roomDrawn = false;
          overlays.resize(v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const palette = GENRE_PALETTES[toGenre(p.genre)];
          if (!started) {
            // The first frame starts the show on the link's settings, with no ease in.
            started = true;
            restartShots(schedule, p.seed, palette, p.intensity);
          }
          stepShots(schedule, dt, palette, p.intensity, p.seed);

          if (roomTarget) {
            // 1. The room, once per resize.
            if (!roomDrawn) {
              roomDrawn = true;
              gl.useProgram(roomProgram);
              ru.f2("uRes", width, height);
              ru.f1("uK", k);
              roomTarget.bind();
              triangle.draw();
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              gl.viewport(0, 0, width, height);
            }

            // 2. The room, lit.
            const wall = wallRgb(p.wall);
            const strip = stripRgb(p.strip);
            const flicker = screenFlicker(schedule.time) * LIGHT_GAIN;
            const light = schedule.light;
            gl.useProgram(lightProgram);
            lu.f2("uRes", width, height);
            lu.f1("uK", k);
            lu.f3("uWall", wall[0], wall[1], wall[2]);
            lu.f3("uLight", light[0] * flicker, light[1] * flicker, light[2] * flicker);
            lu.f3("uPool", schedule.centre, POOL_Y, schedule.radius);
            lu.f3("uStrip", strip[0] * STRIP_GAIN, strip[1] * STRIP_GAIN, strip[2] * STRIP_GAIN);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, roomTarget.texture);
            triangle.draw();
            gl.bindTexture(gl.TEXTURE_2D, null);
          }

          // 3. The stream overlays, last.
          overlays.frame(dt, p);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
