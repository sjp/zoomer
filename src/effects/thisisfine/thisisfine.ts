import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import { hexToUnitRgb } from "../color";
import {
  fireNoiseChannels,
  buildRamp,
  NOISE_PERIOD,
  NOISE_SIZE,
  PALETTES,
  RAMP_SIZE,
} from "../fireplace/fireplace-model";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  scopedProgram,
  withScope,
} from "../gl";
import { approach, clamp, fract, smoothstep } from "../math";
import { buildPeriodicNoiseTexture, createNoise } from "../noise";
import { createSettledValue } from "../rebuild";
import { defineEffect } from "../types";
import { paintBubble, paintRoom } from "./room-art";
import {
  buildProfile,
  CLEAR_X,
  CLEAR_Y,
  CLOCK_START,
  createFire,
  EDGE_COUNT,
  FLAME_OCTAVES,
  layoutFire,
  PROFILE_CHANNELS,
  PROFILE_COLUMNS,
  roomLayout,
  type RoomLayout,
  SIDE_SKEW,
  SMOKE_NOISE,
  smokeDepth,
  type SteamPuff,
  steamPuff,
  stepFire,
  WARP,
  WARP_ALONG,
} from "./thisisfine-sim";
import { thisisfineMeta } from "./thisisfine.meta";

/** Seconds a style or room change crossfades. */
const STYLE_EASE = 1.2;
const ROOM_EASE = 1.2;
/** Seconds the speech bubble takes to fade in or out. */
const BUBBLE_FADE = 0.5;
/** Seconds the text, and the canvas size, must hold before they are repainted. */
const SETTLE_TEXT = 1;
const SETTLE_SIZE = 0.3;
/** Smoke billows: scallop width along the ceiling, ref px. */
const BILLOW = 170;
/** The mug's steam curl: height above the mug and sideways swing, ref px; turns of curl up its height. */
const STEAM_H = 120;
const STEAM_SWING = 11;
const STEAM_CURL = 1.3;
/** Halftone dot spacing and radius, ref px, and how much a dot darkens. */
const DOT_CELL = 9;
const DOT_R = 1.6;
const DOT_INK = 0.07;
/** Wall glow reaches this far from an edge, ref px, at most. */
const GLOW_REACH = 220;

const rgb = (hex: string) => {
  const [r, g, b] = hexToUnitRgb(hex);
  return `vec3(${glslFloat(r)}, ${glslFloat(g)}, ${glslFloat(b)})`;
};

/** Noise uv per ref px for a lattice cell `cell` ref px wide. */
const noiseScale = (cell: number) => 1 / (cell * NOISE_PERIOD);

/**
 * The whole frame in one pass, in ref px with y down: the painted room (two
 * slots crossfading on a room change), Comic halftone, the fire's warm light,
 * the smoke under the ceiling, the flames along the four edges and the mug's
 * steam. Flames read each edge's height profile at the pixel's position along
 * the edge, displaced by upward-scrolling noise; Comic cuts the heat into three
 * hard bands, Painted maps it through the Fireplace's heat ramp.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform sampler2D uRoomOld;
uniform sampler2D uProfile;
uniform sampler2D uNoise;
uniform sampler2D uRamp;
uniform vec2 uResolution;
/** Device px per ref px, and the frame in ref px. */
uniform float uK;
uniform vec2 uSize;
/** Weight of the old room slot. */
uniform float uOldMix;
/** 0 Comic, 1 Painted. */
uniform float uStyle;
/** Flame octave offsets and the smoke's, noise uv. */
uniform vec2 uOff0;
uniform vec2 uOff1;
uniform vec2 uSmokeOff;
/** Smoke depth and billow scroll, ref px. */
uniform float uSmoke;
uniform float uBillow;
/** Overall fire, 0..1: the warm light from below. */
uniform float uFire;
/** Glow reach from the side edges and from the top and bottom, ref px. */
uniform vec2 uGlowReach;
/** Steam: mug centre x, mug top y, opacity, curl phase. */
uniform vec4 uSteam;
out vec4 outColor;

const vec3 RED = ${rgb("#d8341f")};
const vec3 ORANGE = ${rgb("#f57b20")};
const vec3 YELLOW = ${rgb("#ffd53d")};
const vec3 GLOW = ${rgb("#ff8a2a")};
const vec3 SMOKE_LIGHT = ${rgb("#5a5250")};
const vec3 SMOKE_DARK = ${rgb("#2c2828")};
${DITHER_GLSL}

/** Per edge: profile height and glow at along-edge position t (ref px) of an edge len long. */
vec2 profileAt(float t, float len, float row) {
  return texture(uProfile, vec2(t / len, (row + 0.5) / ${glslFloat(EDGE_COUNT)})).rg;
}

/**
 * Heat 1 at the edge falling to 0 at the flame's outline, or below 0 outside it.
 * Keeps the hottest edge's heat in best.x and its flame height in best.y.
 */
void heat(vec2 pr, float d, float warp, inout vec2 best) {
  float h = pr.r;
  float e = h < 0.5 ? -1.0 : 1.0 - (d + warp * ${glslFloat(WARP)} * h) / h;
  if (e > best.x) {
    best = vec2(e, h);
  }
}

void main() {
  vec2 dev = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 p = dev / uK;
  vec2 uv = dev / uResolution;
  vec3 col = texture(uRoom, uv).rgb;
  if (uOldMix > 0.0) {
    col = mix(col, texture(uRoomOld, uv).rgb, uOldMix);
  }

  // Comic halftone: a fixed 45-degree dot screen.
  if (uStyle < 1.0) {
    vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * p / ${glslFloat(DOT_CELL)};
    float dist = length(fract(q) - 0.5) * ${glslFloat(DOT_CELL)};
    float aa = 0.6 / uK;
    float dotMask = 1.0 - smoothstep(${glslFloat(DOT_R)} - aa, ${glslFloat(DOT_R)} + aa, dist);
    col *= 1.0 - ${glslFloat(DOT_INK)} * dotMask * (1.0 - uStyle);
  }

  float W = uSize.x;
  float H = uSize.y;
  float dB = H - p.y;
  float dT = p.y;
  float dL = p.x;
  float dR = W - p.x;
  bool clear = p.x > W * ${glslFloat(CLEAR_X)} && p.x < W * ${glslFloat(1 - CLEAR_X)}
    && p.y > H * ${glslFloat(CLEAR_Y)} && p.y < H * ${glslFloat(1 - CLEAR_Y)};

  // Warm light from below, plus glow near the flames.
  float light = uFire * 0.22 * smoothstep(0.25 * H, H, p.y);
  // The hottest edge's heat and flame height.
  vec2 best = vec2(-1.0, 1.0);
  float fb = 0.5;
  if (!clear) {
    vec2 n0 = texture(uNoise, p * ${glslFloat(noiseScale(FLAME_OCTAVES[0].cell))} + uOff0).rg;
    float n1 = texture(uNoise, p * ${glslFloat(noiseScale(FLAME_OCTAVES[1].cell))} + uOff1).r;
    float warp = clamp((n0.r - 0.5) * 1.6 + (n1 - 0.5) * 0.8, -1.0, 1.0);
    float along = (n0.g - 0.5) * 2.0 * ${glslFloat(WARP_ALONG)};
    fb = n0.r * 0.65 + n1 * 0.35;
    vec2 pb = profileAt(p.x + along, W, 0.0);
    vec2 pr = profileAt(p.y + along + dR * ${glslFloat(SIDE_SKEW)}, H, 1.0);
    vec2 pt = profileAt(p.x + along, W, 2.0);
    vec2 pl = profileAt(p.y + along + dL * ${glslFloat(SIDE_SKEW)}, H, 3.0);
    heat(pb, dB, warp, best);
    heat(pt, dT, warp, best);
    heat(pr, dR, warp, best);
    heat(pl, dL, warp, best);
    vec2 side = max(1.0 - vec2(dL, dR) / uGlowReach.x, 0.0);
    vec2 across = max(1.0 - vec2(dB, dT) / uGlowReach.y, 0.0);
    light += pb.g * across.x * across.x + pt.g * across.y * across.y
      + pl.g * side.x * side.x + pr.g * side.y * side.y;
  }
  col = col * (1.0 + 0.3 * light) + GLOW * (0.12 * light);

  // Smoke under the ceiling, billowing along its soft lower edge.
  if (uSmoke > 0.5 && p.y < uSmoke * 1.6 + 8.0) {
    float s = texture(uNoise, p * ${glslFloat(noiseScale(SMOKE_NOISE.cell))} + uSmokeOff).g;
    float b = fract((p.x + uBillow) / ${glslFloat(BILLOW)}) * 2.0 - 1.0;
    float scallop = sqrt(max(0.0, 1.0 - b * b));
    float edge = uSmoke * (0.8 + 0.18 * scallop + 0.35 * (s - 0.5));
    float soft = 0.1 * uSmoke + 6.0;
    float comic = 1.0 - smoothstep(edge - soft, edge + soft, p.y);
    float painted = 1.0 - smoothstep(edge - 3.0 * soft, edge + 2.0 * soft, p.y + (fb - 0.5) * uSmoke * 0.5);
    float a = 0.88 * mix(comic, painted, uStyle);
    vec3 sc = mix(SMOKE_DARK, SMOKE_LIGHT, clamp(p.y / max(edge, 1.0) + (s - 0.5) * uStyle, 0.0, 1.0));
    col = mix(col, sc, a);
  }

  // Flames.
  float e = best.x;
  if (e > -0.5) {
    if (uStyle < 1.0) {
      // Heat falls by 1 over the flame's height: half a device px of it, for antialiasing.
      float aa = 0.5 / (max(best.y, 1.0) * uK);
      vec3 c = col;
      c = mix(c, RED, clamp(e / aa + 0.5, 0.0, 1.0));
      c = mix(c, ORANGE, clamp((e - 0.3) / aa + 0.5, 0.0, 1.0));
      c = mix(c, YELLOW, clamp((e - 0.62) / aa + 0.5, 0.0, 1.0));
      col = mix(c, col, uStyle);
    }
    if (uStyle > 0.0) {
      float hp = clamp(e * 1.15 + (fb - 0.5) * 0.9, 0.0, 1.0);
      vec4 f = texture(uRamp, vec2(hp * ${glslFloat((RAMP_SIZE - 1) / RAMP_SIZE)} + ${glslFloat(0.5 / RAMP_SIZE)}, 0.5));
      vec3 c = col * (1.0 - f.a) + f.rgb;
      col = mix(col, c, uStyle);
    }
  }

  // The mug's steam: a curl rising and fading.
  if (uSteam.z > 0.0) {
    float rel = (uSteam.y - p.y) / ${glslFloat(STEAM_H)};
    float dx = p.x - uSteam.x;
    if (rel > 0.0 && rel < 1.0 && abs(dx) < ${glslFloat(STEAM_SWING * 3)}) {
      float a = rel * ${glslFloat(STEAM_CURL * 2 * Math.PI)} - uSteam.w;
      float cx = sin(a) * ${glslFloat(STEAM_SWING)} * (0.5 + rel);
      float slope = cos(a) * ${glslFloat((STEAM_SWING * STEAM_CURL * 2 * Math.PI) / STEAM_H)} * (0.5 + rel);
      float d = abs(dx - cx) / sqrt(1.0 + slope * slope);
      float w = 4.0 * (1.0 - 0.4 * rel);
      float aa = 0.7 / uK;
      float stroke = 1.0 - smoothstep(w - aa, w + aa, d);
      float fade = smoothstep(0.0, 0.12, rel) * (1.0 - smoothstep(0.55, 1.0, rel));
      col = mix(col, vec3(1.0), 0.8 * stroke * fade * uSteam.z);
    }
  }

  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** The speech bubble: a premultiplied canvas texture over its own viewport. */
const BUBBLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)) * uAlpha;
}
`;

/** Texture units. */
const UNIT_ROOM = 0;
const UNIT_ROOM_OLD = 1;
const UNIT_PROFILE = 2;
const UNIT_NOISE = 3;
const UNIT_RAMP = 4;

/**
 * This is fine: a cosy cartoon room, painted once into a canvas texture, with
 * flames licking along its edges, smoke under the ceiling and a steaming mug,
 * all in one full-screen pass, plus an optional speech bubble.
 */
export const thisisfine = defineEffect(thisisfineMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, [
        "uRoom",
        "uRoomOld",
        "uProfile",
        "uNoise",
        "uRamp",
        "uResolution",
        "uK",
        "uSize",
        "uOldMix",
        "uStyle",
        "uOff0",
        "uOff1",
        "uSmokeOff",
        "uSmoke",
        "uBillow",
        "uFire",
        "uGlowReach",
        "uSteam",
      ]);
      gl.useProgram(program);
      u.i1("uRoom", UNIT_ROOM);
      u.i1("uProfile", UNIT_PROFILE);
      u.i1("uNoise", UNIT_NOISE);
      u.i1("uRamp", UNIT_RAMP);
      u.i1("uRoomOld", UNIT_ROOM_OLD);

      const bubbleProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BUBBLE_FRAGMENT);
      const bu = createUniforms(gl, bubbleProgram, ["uTex", "uAlpha"]);
      gl.useProgram(bubbleProgram);
      bu.i1("uTex", 0);

      const rooms: CanvasTexture[] = [
        createCanvasTexture(gl, scope),
        createCanvasTexture(gl, scope),
      ];
      const bubbleTex = createCanvasTexture(gl, scope, { premultiply: true });
      const profile = scope.own(
        createColumnTable(gl, PROFILE_COLUMNS, PROFILE_CHANNELS, { rows: EDGE_COUNT }),
      );
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, fireNoiseChannels()),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const rampTex = scope.add(
        createDataTexture(gl, {
          width: RAMP_SIZE,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildRamp(PALETTES.wood.ramp),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      gl.bindTexture(gl.TEXTURE_2D, null);

      const fire = createFire();
      const flickerNoise = createNoise(0xf1e5);
      const puff: SteamPuff = { alpha: 0, rise: 0 };
      const settledSize = createSettledValue<number>(SETTLE_SIZE);
      const settledText = createSettledValue<string>(SETTLE_TEXT);

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Motion clock: advances at the Motion setting, so Motion 0 stills everything. */
      let clock = CLOCK_START;
      let style = -1;
      let layout: RoomLayout | null = null;
      /** Motion clock and flicker amount the profile table was last built for. */
      let profileClock = Number.NaN;
      let profileMotion = Number.NaN;

      /** Current room slot, and what it shows. */
      let roomSlot = 0;
      let roomOld = 0;
      let paintedRoom = "";
      let paintedSeed = Number.NaN;
      let paintedSize = -1;

      /** What the bubble texture shows, and its eased opacity. */
      let bubbleKey = "";
      let bubbleAlpha = 0;
      let bubbleX = 0;
      let bubbleY = 0;
      let bubbleW = 0;
      let bubbleH = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const motion = clamp(p.motion, 0, 1);
          clock += step * motion;
          const refW = width / scale;
          const refH = height / scale;
          const seed = Math.round(p.seed);

          let profileStale = false;
          if (
            layout === null ||
            layout.width !== refW ||
            layout.height !== refH ||
            fire.seed !== seed
          ) {
            layout = roomLayout(refW, refH, seed);
            layoutFire(fire, refW, refH, seed);
            profileStale = true;
          }
          // The flame profile only changes as the fire eases or the flicker moves.
          if (
            stepFire(fire, step, p.intensity, p.smoke) ||
            profileStale ||
            clock !== profileClock ||
            motion !== profileMotion
          ) {
            buildProfile(fire, profile.data, flickerNoise, clock, motion);
            profile.upload();
            profileClock = clock;
            profileMotion = motion;
          }

          // The room: repaint on a room or variation change (crossfading from the
          // old slot), or on a settled resize (in place).
          const sizeKey = settledSize.update(width * 100003 + height, step);
          if (paintedSize === -1 || sizeKey !== paintedSize) {
            rooms[roomSlot].upload(paintRoom(p.room, layout, seed, width, height, scale));
            paintedSize = sizeKey;
            paintedRoom = p.room;
            paintedSeed = seed;
            roomOld = 0;
          } else if (p.room !== paintedRoom || seed !== paintedSeed) {
            // The slot showing most becomes the old one; a change mid-fade repaints
            // the fainter slot.
            if (roomOld <= 0.5) {
              roomSlot = 1 - roomSlot;
            }
            rooms[roomSlot].upload(paintRoom(p.room, layout, seed, width, height, scale));
            paintedRoom = p.room;
            paintedSeed = seed;
            roomOld = 1;
          }
          roomOld = Math.max(0, roomOld - step / ROOM_EASE);

          const targetStyle = p.style === "painted" ? 1 : 0;
          style = style < 0 ? targetStyle : approach(style, targetStyle, step / STYLE_EASE);

          // The speech bubble fades out before showing a new text or size.
          const text = settledText.update(p.text, step);
          const key = `${text}\n${String(paintedSize)}`;
          if (key !== bubbleKey && bubbleAlpha <= 0) {
            const art = paintBubble(text, layout, scale);
            bubbleTex.upload(art.canvas);
            bubbleKey = key;
            bubbleX = art.x;
            bubbleY = art.y;
            bubbleW = art.width;
            bubbleH = art.height;
          }
          const showBubble = p.caption && key === bubbleKey;
          bubbleAlpha = approach(bubbleAlpha, showBubble ? 1 : 0, step / BUBBLE_FADE);

          // Noise offsets, wrapped to the texture's period.
          const o0 = fract(
            (FLAME_OCTAVES[0].rise * clock) / (FLAME_OCTAVES[0].cell * NOISE_PERIOD),
          );
          const o1 = fract(
            (FLAME_OCTAVES[1].rise * clock) / (FLAME_OCTAVES[1].cell * NOISE_PERIOD),
          );
          const smokeSpan = SMOKE_NOISE.cell * NOISE_PERIOD;
          steamPuff(clock, puff);

          gl.useProgram(program);
          u.f2("uResolution", width, height);
          u.f1("uK", scale);
          u.f2("uSize", refW, refH);
          u.f1("uStyle", smoothstep(0, 1, style));
          u.f2("uOff0", 0.37, o0);
          u.f2("uOff1", 0.71, o1);
          u.f2(
            "uSmokeOff",
            fract((SMOKE_NOISE.drift * clock) / smokeSpan),
            fract((SMOKE_NOISE.churn * clock) / smokeSpan),
          );
          u.f1("uSmoke", smokeDepth(fire));
          u.f1("uBillow", (SMOKE_NOISE.drift * clock) % BILLOW);
          u.f1("uFire", 0.3 + 0.7 * fire.intensity);
          u.f2(
            "uGlowReach",
            Math.min(GLOW_REACH, refW * CLEAR_X),
            Math.min(GLOW_REACH, refH * CLEAR_Y),
          );
          const mug = layout.mug;
          u.f4(
            "uSteam",
            mug.x + mug.w / 2,
            mug.y - 4,
            puff.alpha,
            puff.rise * Math.PI * 2 * STEAM_CURL,
          );
          u.f1("uOldMix", smoothstep(0, 1, roomOld));
          gl.activeTexture(gl.TEXTURE0 + UNIT_ROOM_OLD);
          gl.bindTexture(gl.TEXTURE_2D, rooms[1 - roomSlot].texture);
          gl.activeTexture(gl.TEXTURE0 + UNIT_NOISE);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.activeTexture(gl.TEXTURE0 + UNIT_RAMP);
          gl.bindTexture(gl.TEXTURE_2D, rampTex);
          gl.activeTexture(gl.TEXTURE0 + UNIT_PROFILE);
          gl.bindTexture(gl.TEXTURE_2D, profile.texture);
          gl.activeTexture(gl.TEXTURE0 + UNIT_ROOM);
          gl.bindTexture(gl.TEXTURE_2D, rooms[roomSlot].texture);
          triangle.draw();

          if (bubbleAlpha > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(bubbleProgram);
            bu.f1("uAlpha", smoothstep(0, 1, bubbleAlpha));
            gl.bindTexture(gl.TEXTURE_2D, bubbleTex.texture);
            gl.viewport(
              Math.round(bubbleX),
              Math.round(height - bubbleY - bubbleH),
              bubbleW,
              bubbleH,
            );
            triangle.draw();
            gl.viewport(0, 0, width, height);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
