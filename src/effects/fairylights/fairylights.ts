import { type Rgb, unitRgbMemo } from "../color";
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
} from "../gl";
import {
  createFairyLights,
  type FairyFrame,
  type FairyPattern,
  MAX_GLOWS,
  PALETTES,
  paletteMean,
  type FairyLayout,
} from "./fairylights-sim";
import { fairylightsMeta } from "./fairylights.meta";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { createStreakRenderer } from "../streaks";
import { defineEffect } from "../types";

const LAYOUTS: readonly FairyLayout[] = ["swags", "curtain", "both"];
const PATTERNS: readonly FairyPattern[] = ["twinkle", "chase", "steady"];
const isFairyLayout = (v: string): v is FairyLayout => (LAYOUTS as readonly string[]).includes(v);
const isFairyPattern = (v: string): v is FairyPattern =>
  (PATTERNS as readonly string[]).includes(v);

const MAX_BULBS = 1024;
const MAX_POINTS = 2048;
/** Wall shading: the top is this much darker than the chosen colour. */
const WALL_TOP = 0.75;
/** Wires: this fraction of the wall colour, so they read as dark against it. */
const WIRE_SHADE = 0.3;

/**
 * Wall: a vertical gradient of the chosen colour plus a faint glow from the
 * lights, as a few large soft elliptical blobs (not one per bulb). Dithered,
 * since it is wide and shallow.
 */
const WALL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlowColor;
/** Frame size in reference px (1080 tall). */
uniform vec2 uRefSize;
/** Per glow: centre x, y (reference px, y down), 1 / x radius, 1 / y radius. */
uniform vec4 uGlow[${String(MAX_GLOWS)}];
uniform float uGlowStrength[${String(MAX_GLOWS)}];
uniform int uGlowCount;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uRefSize;
  vec3 c = mix(uTop, uBottom, 1.0 - vUv.y);
  float g = 0.0;
  for (int i = 0; i < ${String(MAX_GLOWS)}; i++) {
    if (i >= uGlowCount) break;
    vec2 d = (p - uGlow[i].xy) * uGlow[i].zw;
    float f = max(0.0, 1.0 - dot(d, d));
    g += uGlowStrength[i] * f * f;
  }
  outColor = vec4(c + uGlowColor * g + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Bulbs: an octagon (apothem 1 = the sprite radius) around each. */
const BULB_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y, radius (device px, y down), level. */
layout(location = 1) in vec4 aBulb;
/** Colour, then blur (0 in focus, 1 fully out of focus). */
layout(location = 2) in vec4 aTint;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec3 vColor;
flat out vec2 vLevelBlur;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = aTint.rgb;
  vLevelBlur = vec2(aBulb.w, aTint.a);
  gl_Position = pxToClip(aBulb.xy + aCorner * aBulb.z, uResolution);
}
`;

/**
 * In focus: a small white-hot core and a soft halo. Out of focus: a flat bokeh
 * disc with a soft edge and a faintly brighter rim, its light spread over a
 * larger area so dimmer. Blur mixes between the two. Additive, dithered.
 */
const BULB_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec3 vColor;
flat in vec2 vLevelBlur;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float d2 = dot(vLocal, vLocal);
  float d = sqrt(d2);
  float m = smoothstep(0.0, 0.5, vLevelBlur.y);
  float core = exp(-d2 * 90.0) * (1.0 - m);
  float h = max(0.0, 1.0 - d2);
  float halo = h * h * h * ${glslFloat(0.22)};
  float disc = (1.0 - smoothstep(0.8, 0.98, d)) * (0.85 + 0.15 * smoothstep(0.5, 0.9, d));
  float body = mix(halo, disc * ${glslFloat(0.3)}, m);
  vec3 col = vColor * body + mix(vColor, vec3(1.0), 0.55) * core;
  float level = vLevelBlur.x;
  outColor = vec4(col * level + dither8(gl_FragCoord.xy) * min(body * 8.0, 1.0), 0.0);
}
`;

/**
 * Strings of small warm bulbs draped in swags across the top of the frame (or
 * hanging as curtain strands at the sides), the near ones sharp on a thin dark
 * wire, the far ones soft bokeh discs, twinkling slowly and swaying slightly.
 */
export const fairylights = defineEffect(fairylightsMeta, {
  create(gl) {
    return withScope((scope) => {
      const wallProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, WALL_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const wallU = createUniforms(gl, wallProgram, [
        "uTop",
        "uBottom",
        "uGlowColor",
        "uRefSize",
        "uGlow",
        "uGlowStrength",
        "uGlowCount",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const bulbProgram = scope.add(createProgram(gl, BULB_VERTEX, BULB_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const bulbU = createUniforms(gl, bulbProgram, ["uResolution"]);
      const bulbs = scope.own(
        createSpriteBatch(gl, MAX_BULBS, [4, 4], [polygonStrip(8, Math.PI / 8)]),
      );
      const wires = scope.own(createStreakRenderer(gl, MAX_POINTS, { blend: "alpha" }));

      const sim = createFairyLights(MAX_BULBS, MAX_POINTS);
      const glowData = new Float32Array(MAX_GLOWS * 4);
      const glowStrength = new Float32Array(MAX_GLOWS);
      const wallColor = unitRgbMemo();
      const top: Rgb = [0, 0, 0];
      const glowColor: Rgb = [0, 0, 0];
      const f: FairyFrame = {
        time: 0,
        twinkle: 0,
        pattern: "twinkle",
        focus: 0,
        scale: 1,
        palette: PALETTES.warm,
        wall: [0, 0, 0],
        wire: [0, 0, 0],
      };

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      /** What the current layout was built from; NaN forces a rebuild. */
      let builtStrings = Number.NaN;
      let builtLayout = "";
      let builtSeed = Number.NaN;
      let builtWidth = Number.NaN;

      const rebuild = (strings: number, layout: string, seed: number) => {
        builtStrings = strings;
        builtLayout = layout;
        builtSeed = seed;
        builtWidth = refWidth;
        // The sim draws both swags and curtain for any layout it doesn't know.
        sim.build({ strings, layout: isFairyLayout(layout) ? layout : "both", seed, refWidth });
        for (let i = 0; i < sim.glowCount; i++) {
          const g = sim.glows[i];
          glowData[i * 4] = g.x;
          glowData[i * 4 + 1] = g.y;
          glowData[i * 4 + 2] = 1 / g.rx;
          glowData[i * 4 + 3] = 1 / g.ry;
          glowStrength[i] = g.strength;
        }
        gl.useProgram(wallProgram);
        gl.uniform4fv(wallU.loc.uGlow, glowData);
        gl.uniform1fv(wallU.loc.uGlowStrength, glowStrength);
        wallU.i1("uGlowCount", sim.glowCount);
      };

      return {
        resize(v) {
          ({ width, height } = v);
          f.scale = v.scale;
          refWidth = v.width / v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          if (
            p.strings !== builtStrings ||
            p.layout !== builtLayout ||
            p.seed !== builtSeed ||
            refWidth !== builtWidth
          ) {
            rebuild(p.strings, p.layout, p.seed);
          }
          f.time += dt;
          f.twinkle = p.twinkle;
          // The sim twinkles for any pattern it doesn't know.
          f.pattern = isFairyPattern(p.pattern) ? p.pattern : "twinkle";
          f.focus = p.focus;
          f.palette = PALETTES[p.palette] ?? PALETTES.warm;
          const wall = wallColor(p.wall);
          for (let c = 0; c < 3; c++) {
            f.wall[c] = wall[c];
            f.wire[c] = wall[c] * WIRE_SHADE;
            top[c] = wall[c] * WALL_TOP;
          }
          paletteMean(f.palette, glowColor);
          const nBulbs = sim.step(f, bulbs.data, wires.data);
          const nWires = sim.wireCount;

          gl.useProgram(wallProgram);
          wallU.v3("uTop", top);
          wallU.v3("uBottom", wall);
          wallU.v3("uGlowColor", glowColor);
          wallU.f2("uRefSize", refWidth, 1080);
          triangle.draw();

          if (nWires > 0) {
            wires.upload(nWires);
            wires.draw(nWires, width, height);
          }
          if (nBulbs > 0) {
            bulbs.upload(nBulbs);
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.useProgram(bulbProgram);
            bulbU.f2("uResolution", width, height);
            bulbs.draw(0, nBulbs);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
