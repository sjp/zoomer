import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  resetUnpackState,
  withScope,
  scopedProgram,
} from "../gl";
import {
  breath,
  buildNeonTubes,
  measureLines,
  NEON_EMIT_GLSL,
  SHIMMER_GLSL,
  SHIMMER_PERIOD,
  warmUp,
} from "../neon-tubes";
import { LINE_PITCH, signLayout, signLines } from "./neon-sim";
import { neonMeta, type NeonPosition } from "./neon.meta";
import { HASH32_GLSL } from "../noise";
import { defineEffect } from "../types";
import { createSettledValue } from "../rebuild";

/** Seconds the text and the canvas aspect must hold still before the sign is rebuilt. */
const INPUT_SETTLE = 0.3;
/** Most mounting clips per line. */
const MAX_CLIPS = 4;
/** Wall light per unit of blurred tube coverage. */
const GLOW_GAIN = 7;
const WALL_INDEX: Record<string, number> = { brick: 0, concrete: 1, tile: 2 };

/**
 * One full-screen pass. Everywhere: a procedural wall lit by a faint ambient
 * gradient and the sign's blurred light (one fetch). Inside the sign's box: one
 * fetch of the distance field, giving the clips behind the tubes, then each
 * line's tube (white-hot core, coloured body) and halo, with a slow ripple.
 * Positions are in reference px, y down.
 */
const NEON_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
/** Device px per reference px. */
uniform float uScale;
uniform int uWall;
/** Field and glow boxes: left, top (reference px), then 1 / width, 1 / height. */
uniform vec4 uField;
uniform vec4 uGlowBox;
/** Tube radius, halo reach, core width (radii) and edge softness (reference px). */
uniform vec4 uTube;
uniform vec3 uC1;
uniform vec3 uC2;
/** Brightness: warm-up times the slow breath. */
uniform float uLit;
uniform float uShimmer;
uniform float uTime;
/** 1 when there is text to show. */
uniform float uSign;
uniform sampler2D uFieldTex;
uniform sampler2D uGlowTex;
out vec4 outColor;
${DITHER_GLSL}
${HASH32_GLSL}
${SHIMMER_GLSL}
${NEON_EMIT_GLSL}
float hash2(vec2 c) {
  uvec2 u = uvec2(ivec2(c) + 65536);
  return float(hash32(u.x ^ hash32(u.y + 0x9e3779b9u)) >> 8) / 16777215.0;
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
             mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
}
/** Wall colour; relief darkens recessed joints, gloss adds extra reflected sign light. */
vec3 wall(vec2 p, out float relief, out float gloss) {
  relief = 1.0;
  gloss = 0.0;
  if (uWall == 0) {
    // Stretcher bond: 90 x 28 bricks in 6 px of mortar.
    const vec2 B = vec2(96.0, 34.0);
    float row = floor(p.y / B.y);
    float x = p.x + mod(row, 2.0) * 0.5 * B.x;
    vec2 cell = vec2(floor(x / B.x), row);
    vec2 f = vec2(x, p.y) - cell * B;
    vec2 e = min(f, B - f);
    float mortar = 1.0 - smoothstep(2.0, 4.0, min(e.x, e.y));
    float h = hash2(cell);
    vec3 brick = mix(vec3(0.42, 0.16, 0.10), vec3(0.30, 0.15, 0.12), hash2(cell + 71.0));
    brick *= (0.75 + 0.4 * h) * (0.82 + 0.3 * vnoise(p * 0.11));
    // The top edge of each brick catches a little more of the light from above.
    brick *= 1.0 + 0.12 * (1.0 - smoothstep(4.0, 9.0, f.y));
    relief = mix(1.0, 0.6, mortar);
    return mix(brick, vec3(0.2, 0.19, 0.18) * (0.8 + 0.3 * vnoise(p * 0.3)), mortar);
  }
  if (uWall == 1) {
    // Cast concrete panels with tie holes.
    const vec2 P = vec2(360.0, 240.0);
    vec2 f = mod(p, P);
    vec2 e = min(f, P - f);
    float seam = 1.0 - smoothstep(0.5, 1.8, min(e.x, e.y));
    vec2 t = mod(f, vec2(P.x * 0.5, P.y * 0.5)) - vec2(P.x * 0.25, P.y * 0.25);
    float hole = 1.0 - smoothstep(3.0, 5.0, length(t));
    float n = 0.6 * vnoise(p * 0.025) + 0.4 * vnoise(p * 0.13);
    vec3 c = vec3(0.30, 0.30, 0.29) * (0.75 + 0.45 * n) * (0.95 + 0.1 * hash2(floor(p / P)));
    relief = 1.0 - 0.45 * seam - 0.6 * hole;
    return c;
  }
  // Dark glazed tiles: 72 px squares in 3 px of grout.
  const float T = 72.0;
  vec2 cell = floor(p / T);
  vec2 f = p - cell * T;
  vec2 e = min(f, T - f);
  float grout = 1.0 - smoothstep(1.0, 2.5, min(e.x, e.y));
  vec3 tile = vec3(0.07, 0.08, 0.10) * (0.85 + 0.3 * hash2(cell));
  relief = mix(1.0, 0.7, grout);
  gloss = (1.0 - grout) * (0.8 + 0.4 * hash2(cell + 13.0));
  return mix(tile, vec3(0.16, 0.16, 0.16), grout);
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  float relief;
  float gloss;
  vec3 albedo = wall(p, relief, gloss);
  // A dim ambient wash, a little lighter low down (light from the street).
  float v = p.y * uScale / uRes.y;
  vec2 q = vec2(p.x * uScale / uRes.x - 0.5, v - 0.4);
  float ambient = (0.05 + 0.04 * v) * (1.0 - 0.5 * dot(q, q));
  vec3 light = vec3(0.0);
  if (uSign > 0.5) {
    vec2 g = texture(uGlowTex, (p - uGlowBox.xy) * uGlowBox.zw).rg;
    light = (uC1 * g.r + uC2 * g.g) * (${glslFloat(GLOW_GAIN)} * uLit);
  }
  vec3 col = albedo * relief * (ambient + light * (1.0 + 2.0 * gloss)) + 0.04 * gloss * light;
  vec2 fu = (p - uField.xy) * uField.zw;
  if (uSign > 0.5 && all(greaterThanEqual(fu, vec2(0.0))) && all(lessThanEqual(fu, vec2(1.0)))) {
    vec4 f = texture(uFieldTex, fu);
    float r = uTube.x;
    float body = max(1.0 - smoothstep(r - uTube.w, r + uTube.w, f.r),
                     1.0 - smoothstep(r - uTube.w, r + uTube.w, f.g));
    // Clips behind the tubes: dark metal, lit from the front by the sign.
    vec3 clip = vec3(0.12, 0.12, 0.13) * mix(1.3, 0.45, f.a) * (ambient * 2.0 + 0.4 + 2.0 * light);
    col = mix(col, clip, f.b * (1.0 - body));
    // Unlit glass shows faintly while the tubes warm up.
    col = mix(col, vec3(0.08, 0.085, 0.09), body * (1.0 - uLit) * 0.7);
    float s = uLit * (1.0 + uShimmer * ripple(p.x, uTime));
    col += s * (neonEmit(f.r, uC1, uTube) + neonEmit(f.g, uC2, uTube));
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A neon sign on a wall at night, spelling the user's text in glowing tubes. The
 * text is drawn once with a system font on an OffscreenCanvas, turned into a
 * distance field to the strokes' centrelines on the CPU (neon-tubes.ts) and a
 * blurred low-res copy that lights the wall; both rebuild only when the text,
 * position or aspect ratio changes. Each frame is a single full-screen pass.
 */
export const neon = defineEffect(neonMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, NEON_FRAGMENT);
      const u = createUniforms(gl, program, [
        "uRes",
        "uScale",
        "uWall",
        "uField",
        "uGlowBox",
        "uTube",
        "uC1",
        "uC2",
        "uLit",
        "uShimmer",
        "uTime",
        "uSign",
        "uFieldTex",
        "uGlowTex",
      ]);
      const fieldTex = scope.add(gl.createTexture(), (t) => {
        gl.deleteTexture(t);
      });
      const glowTex = scope.add(gl.createTexture(), (t) => {
        gl.deleteTexture(t);
      });

      let width = 1;
      let height = 1;
      let scale = 1;
      let time = 0;

      // What the sign was last built for.
      let builtText: string | undefined;
      let builtPosition = "";
      let builtAspect = 0;
      let hasSign = false;
      const field4 = [0, 0, 1, 1];
      const glow4 = [0, 0, 1, 1];
      const tube4 = [1, 1, 1, 1];

      const upload = (
        tex: WebGLTexture,
        w: number,
        h: number,
        internal: GLenum,
        format: GLenum,
        data: Float32Array,
      ) => {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        resetUnpackState(gl);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };

      // Start with blank textures, so nothing samples an incomplete one.
      upload(fieldTex, 1, 1, gl.RGBA16F, gl.RGBA, new Float32Array(4));
      upload(glowTex, 1, 1, gl.RG16F, gl.RG, new Float32Array(2));

      const settledText = createSettledValue<string>(INPUT_SETTLE);
      const settledAspect = createSettledValue<number>(INPUT_SETTLE);
      /** Lays out and rasterises the text, then rebuilds the field and glow textures. */
      const build = (text: string, position: NeonPosition, aspect: number) => {
        const lines = signLines(text);
        hasSign = lines.length > 0;
        if (!hasSign) {
          return;
        }
        const layout = signLayout(aspect, position, measureLines(lines.map((l) => l.text)));
        const tubes = buildNeonTubes(lines, { ...layout, pitch: LINE_PITCH }, MAX_CLIPS);
        upload(fieldTex, tubes.field.cols, tubes.field.rows, gl.RGBA16F, gl.RGBA, tubes.field.data);
        upload(glowTex, tubes.glow.cols, tubes.glow.rows, gl.RG16F, gl.RG, tubes.glow.data);
        field4.splice(0, 4, ...tubes.fieldBox);
        glow4.splice(0, 4, ...tubes.glowBox);
        tube4[0] = tubes.radius;
        tube4[1] = tubes.reach;
        tube4[2] = 0.45;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          if (Number.isFinite(dt) && dt > 0) {
            time += dt;
          }
          const aspect = width / height;
          const position: NeonPosition =
            p.position === "left" || p.position === "right" ? p.position : "centre";
          // Typing and window resizes rebuild once they pause; the sign keeps its old
          // text (stretched with the canvas, if need be) until then.
          const text = settledText.update(p.text, dt);
          const signAspect = settledAspect.update(aspect, dt);
          if (text !== builtText || position !== builtPosition || signAspect !== builtAspect) {
            build(text, position, signAspect);
            builtText = text;
            builtPosition = position;
            builtAspect = signAspect;
          }
          const shimmer = Math.min(1, Math.max(0, p.shimmer));

          gl.useProgram(program);
          u.f2("uRes", width, height);
          u.f1("uScale", scale);
          u.i1("uWall", WALL_INDEX[p.wall] ?? 0);
          u.f4("uField", field4[0], field4[1], field4[2], field4[3]);
          u.f4("uGlowBox", glow4[0], glow4[1], glow4[2], glow4[3]);
          u.f4("uTube", tube4[0], tube4[1], tube4[2], Math.max(0.5, 0.7 / scale));
          u.rgb("uC1", p.colour);
          u.rgb("uC2", p.twoTone ? p.second : p.colour);
          u.f1("uLit", warmUp(time) * breath(time, shimmer));
          u.f1("uShimmer", shimmer);
          u.f1("uTime", time % SHIMMER_PERIOD);
          u.f1("uSign", hasSign ? 1 : 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, fieldTex);
          u.i1("uFieldTex", 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, glowTex);
          u.i1("uGlowTex", 1);
          gl.activeTexture(gl.TEXTURE0);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
