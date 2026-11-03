import {
  BOOKSHELF_GLSL,
  createBookshelfTexture,
  shelfBlurLod,
  shelfSideWidth,
  SHELF_EYE,
  SHELF_PERSP,
} from "./bookshelf";
import { hexToUnitRgb, type Rgb } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import {
  BEAM_CORE,
  BEAM_IN,
  BEAM_OUT,
  BEAM_SPREAD,
  BEAM_W0,
  beamGeometry,
  beamMaskLocal,
  cloudLight,
  createBeamGeometry,
  createMotes,
  lampPosition,
  moteGlint,
  REF_HEIGHT,
  ROOM_PALETTES,
  stepMotes,
  SUN,
} from "./library-sim";
import { type BeamId, libraryMeta, MAX_DUST, type PaletteId } from "./library.meta";
import { createLowResTarget } from "./lowres";
import { approach } from "./math";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { defineEffect } from "./types";

/** Room pass: about 3 reference px per texel (divisor 6 at 4K). The room is all soft. */
const ROOM_TEXEL_REF = 3;
/** Where the floor meets the back wall, fraction of the height (the shelves' bottom at their inner edge). */
const FLOOR_Y = SHELF_EYE * SHELF_PERSP;
/** Lamp light pool radius (reference px) and strength. */
const LAMP_R = 300;
const LAMP_POOL = 0.85;
/** Lamp bokeh disc radius at blur 0 and 1 (reference px) and brightness. */
const LAMP_BOKEH_R = [36, 96] as const;
const LAMP_BOKEH = 0.42;
/** Beam scatter brightness, and its wide faint halo relative to the core. */
const BEAM_GAIN = 0.28;
const BEAM_HALO = 0.3;
/** Mote radius in focus and the extra at full depth and blur (reference px), and peak brightness. */
const MOTE_R0 = 1.4;
const MOTE_R1 = 9;
const MOTE_BRIGHT = 0.75;
/** Rates (per second) at which the beam and lamp fade on and off, and the cloud follows a toggle. */
const FADE_RATE = 0.8;

const vec3 = (c: readonly number[]) => `vec3(${c.map(glslFloat).join(", ")})`;

/**
 * The room at low resolution: back wall and floor, the bookcases (four mip taps),
 * the lamp's light pool, and the beam's soft wedge with a faint halo, all in one
 * pass. The beam mask mirrors `beamMaskLocal`.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uShelf;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
/** Frame size, reference px. */
uniform vec2 uFrame;
uniform float uSideW;
uniform float uLod;
uniform float uSoft;
uniform vec3 uWall;
uniform vec3 uFloor;
uniform vec3 uAmbient;
/** Lamp x, y (reference px), 1 / radius, strength. */
uniform vec4 uLamp;
uniform vec3 uLampColor;
/** Beam origin x, y (reference px) and unit direction. */
uniform vec4 uBeamO;
/** Beam length (reference px), brightness. */
uniform vec2 uBeam;
out vec4 outColor;
${BOOKSHELF_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToRef;
  vec2 q = p / uFrame;
  // Back wall, darker towards the ceiling, over a floor that fades into shadow.
  vec3 albedo = uWall * (0.6 + 0.4 * smoothstep(1.0, 0.35, q.y));
  float onFloor = 1.0 - smoothstep(${glslFloat(FLOOR_Y)} - uSoft, ${glslFloat(FLOOR_Y)} + uSoft, q.y);
  albedo = mix(albedo, uFloor * (0.6 + 3.0 * q.y), onFloor);
  vec4 shelf = bookshelf(uShelf, p, uFrame, uSideW, uLod, uSoft);
  albedo = mix(albedo, shelf.rgb, shelf.a);

  vec2 l = (p - uLamp.xy) * uLamp.z;
  float pool = uLamp.w / (1.0 + dot(l, l));

  vec2 d = p - uBeamO.xy;
  float s = dot(d, uBeamO.zw);
  float x = abs(dot(d, vec2(-uBeamO.w, uBeamO.z))) / (${glslFloat(BEAM_W0)} + ${glslFloat(BEAM_SPREAD)} * max(s, 0.0));
  float along = smoothstep(${glslFloat(BEAM_IN[0])}, ${glslFloat(BEAM_IN[1])}, s)
    * (1.0 - smoothstep(${glslFloat(BEAM_OUT)} * uBeam.x, uBeam.x, s));
  float beam = along * (1.0 - smoothstep(${glslFloat(BEAM_CORE)}, 1.0, x) + ${glslFloat(BEAM_HALO)} * exp2(-1.5 * x * x));

  vec3 col = albedo * (uAmbient + uLampColor * pool) + ${vec3(SUN)} * (beam * uBeam.y);
  vec2 v = q - 0.5;
  col *= 1.0 - 0.35 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * Soft additive sprites in device px: dust motes (a smooth blob) and the lamp's
 * bokeh disc (flat, soft-edged, a slightly brighter rim), on an octagon.
 */
const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y up), radius, flatness (0 = blob, 1 = disc). */
layout(location = 1) in vec4 aSprite;
/** Colour times brightness, disc edge width (fraction of the radius). */
layout(location = 2) in vec4 aColor;
uniform vec2 uInvRes;
out vec2 vLocal;
flat out vec4 vColor;
flat out float vFlat;
void main() {
  vLocal = aCorner;
  vColor = aColor;
  vFlat = aSprite.w;
  gl_Position = vec4((aSprite.xy + aCorner * aSprite.z) * uInvRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vColor;
flat in float vFlat;
out vec4 outColor;
void main() {
  float d2 = dot(vLocal, vLocal);
  float blob = max(0.0, 1.0 - d2);
  blob *= blob;
  float d = sqrt(d2);
  float disc = (1.0 - smoothstep(1.0 - vColor.w, 1.0, d)) * (0.85 + 0.15 * smoothstep(0.4, 0.95, d));
  outColor = vec4(vColor.rgb * mix(blob, disc, vFlat), 0.0);
}
`;

/**
 * A deeply out-of-focus library corner: bookcases at both edges, a warm lamp
 * with a big bokeh highlight, and a sunbeam from a high window with dust motes
 * glinting in it, dimming now and then as a cloud passes.
 */
export const library = defineEffect(libraryMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const shelves = createBookshelfTexture(gl, scope);
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => gl.deleteProgram(p));

      const roomProgram = program(FULLSCREEN_VERTEX, ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uPxToRef",
        "uFrame",
        "uSideW",
        "uLod",
        "uSoft",
        "uWall",
        "uFloor",
        "uAmbient",
        "uLamp",
        "uLampColor",
        "uBeamO",
        "uBeam",
      ]);
      const spriteProgram = program(SPRITE_VERTEX, SPRITE_FRAGMENT);
      const su = createUniforms(gl, spriteProgram, ["uInvRes"]);
      const sprites = scope.own(
        createSpriteBatch(gl, MAX_DUST + 1, [4, 4], [polygonStrip(8, Math.PI / 8)]),
      );

      const geom = createBeamGeometry();
      const lamp = { x: 0, y: 0 };
      let motes = createMotes(0, MAX_DUST);
      let motesSeed = 0;

      let width = 1;
      let height = 1;
      let scale = 1;
      /** CPU-only time, unwrapped (float64); nothing time-based is uploaded. */
      let time = 0;
      let beamLevel = -1;
      let lampLevel = -1;
      /** Cloud dimming, eased towards 1 when clouds are turned off. */
      let sunLight = 1;
      let bakedSeed = -1;
      let bakedPalette = "";
      let lastSide: "left" | "right" = "left";
      let builtSide = "";
      let builtBeam = "";
      let builtWidth = -1;
      let lampRgb: Rgb = [0, 0, 0];

      return {
        resize(v) {
          ({ width, height, scale } = v);
          target.resize(width, height, Math.max(1, ROOM_TEXEL_REF * scale));
          gl.useProgram(roomProgram);
          ru.f2(
            "uPxToRef",
            target.fullWidth / target.width / scale,
            target.fullHeight / target.height / scale,
          );
          gl.useProgram(spriteProgram);
          su.f2("uInvRes", 1 / width, 1 / height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const refWidth = width / scale;
          const seed = Math.floor(p.seed);
          const palette = ROOM_PALETTES[p.palette as PaletteId] ?? ROOM_PALETTES.oak;

          gl.activeTexture(gl.TEXTURE0);
          if (seed !== bakedSeed || p.palette !== bakedPalette) {
            shelves.update(seed, palette);
            lampRgb = hexToUnitRgb(palette.lamp);
            gl.useProgram(roomProgram);
            ru.v3("uWall", hexToUnitRgb(palette.wall));
            ru.v3("uFloor", hexToUnitRgb(palette.floor));
            ru.v3("uLampColor", lampRgb);
            bakedSeed = seed;
            bakedPalette = p.palette;
          }
          if (seed !== motesSeed) {
            motes = createMotes(seed, MAX_DUST);
            motesSeed = seed;
          }

          // The beam fades on and off; with it off, the geometry stays on its last side.
          const beam: BeamId = p.beam === "left" || p.beam === "right" ? p.beam : "off";
          const beamOn = beam !== "off";
          if (beam !== "off") lastSide = beam;
          beamLevel =
            beamLevel < 0 ? (beamOn ? 1 : 0) : approach(beamLevel, beamOn ? 1 : 0, dt * FADE_RATE);
          lampLevel =
            lampLevel < 0 ? (p.lamp ? 1 : 0) : approach(lampLevel, p.lamp ? 1 : 0, dt * FADE_RATE);
          sunLight = p.clouds
            ? approach(sunLight, cloudLight(seed, time), dt * FADE_RATE)
            : approach(sunLight, 1, dt * FADE_RATE * 0.5);
          if (lastSide !== builtSide || beam !== builtBeam || refWidth !== builtWidth) {
            beamGeometry(geom, lastSide, refWidth);
            lampPosition(lamp, beam, refWidth);
            builtSide = lastSide;
            builtBeam = beam;
            builtWidth = refWidth;
          }
          const sun = beamLevel * sunLight;
          const blur = Math.max(0, Math.min(1, p.blur));

          // 1. The room at low resolution, then upscaled with dither.
          target.bind();
          gl.useProgram(roomProgram);
          gl.bindTexture(gl.TEXTURE_2D, shelves.texture);
          ru.f2("uFrame", refWidth, REF_HEIGHT);
          ru.f1("uSideW", shelfSideWidth(refWidth));
          ru.f1("uLod", shelfBlurLod(blur));
          ru.f1("uSoft", 0.015 + 0.05 * blur);
          // The window lights the room a little too, so the ambient follows the clouds.
          const amb = 0.6 + 0.25 * sun;
          ru.f3("uAmbient", amb, amb * 0.96, amb * 0.9);
          ru.f4("uLamp", lamp.x, lamp.y, 1 / LAMP_R, LAMP_POOL * lampLevel);
          ru.f4("uBeamO", geom.ox, geom.oy, geom.dx, geom.dy);
          ru.f2("uBeam", geom.length, BEAM_GAIN * sun);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // 2. Lamp bokeh and dust motes, additive.
          const d = sprites.data;
          let n = 0;
          if (lampLevel > 0) {
            const k = LAMP_BOKEH * lampLevel;
            d[0] = lamp.x * scale;
            d[1] = lamp.y * scale;
            d[2] = (LAMP_BOKEH_R[0] + (LAMP_BOKEH_R[1] - LAMP_BOKEH_R[0]) * blur) * scale;
            d[3] = 1;
            d[4] = lampRgb[0] * k;
            d[5] = lampRgb[1] * k;
            d[6] = lampRgb[2] * k;
            d[7] = 0.06 + 0.25 * blur;
            n = 1;
          }
          const count = Math.min(MAX_DUST, Math.max(0, Math.floor(p.dust)));
          if (sun > 0) {
            stepMotes(motes, geom, count, time, dt);
            for (let i = 0; i < count; i++) {
              const s = motes.s[i] * geom.length;
              const t = motes.t[i] * geom.halfBox;
              const mask = beamMaskLocal(geom, s, t);
              if (mask < 0.004) continue;
              const depth = motes.depth[i];
              const r = MOTE_R0 + depth * depth * MOTE_R1 * (0.3 + 0.7 * blur);
              // Larger (more defocused) motes spread the same light over more area.
              const spread = Math.min(1, (2.5 * MOTE_R0 * MOTE_R0) / (r * r));
              const b = MOTE_BRIGHT * mask * sun * spread * moteGlint(motes.phase[i], mask);
              const o = n * 8;
              d[o] = (geom.ox + s * geom.dx + t * geom.nx) * scale;
              d[o + 1] = (geom.oy + s * geom.dy + t * geom.ny) * scale;
              d[o + 2] = r * scale + 0.5;
              d[o + 3] = 0;
              d[o + 4] = SUN[0] * b;
              d[o + 5] = SUN[1] * b;
              d[o + 6] = SUN[2] * b;
              d[o + 7] = 0;
              n++;
            }
          }
          if (n > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(spriteProgram);
            sprites.upload(n);
            sprites.draw(0, n);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
