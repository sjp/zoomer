import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  resetUnpackState,
  withScope,
} from "./gl";
import {
  breath,
  centrelineDistance,
  drawClip,
  fallbackWidthEm,
  FIELD_TEXEL,
  fieldGrid,
  GLOW_TEXEL,
  glowField,
  glowGrid,
  HALO_RADII,
  LINE_PITCH,
  placeClips,
  REF_HEIGHT,
  SHIMMER_GLSL,
  SHIMMER_PERIOD,
  signLayout,
  signLines,
  tubeRadius,
  warmUp,
} from "./neon-sim";
import { neonMeta, type NeonPosition } from "./neon.meta";
import { HASH32_GLSL } from "./noise";
import { defineEffect } from "./types";

/**
 * A rounded system font stack at a light weight, so the strokes are thin and even
 * like bent tube. No font is bundled.
 */
const FONT_FAMILY = `ui-rounded, "SF Pro Rounded", "Varela Round", "Nunito", "Quicksand", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const FONT_WEIGHT = 300;
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
/** One line's light at centreline distance d: tube body with a white-hot core, then halo. */
vec3 emit(float d, vec3 c) {
  float r = uTube.x;
  float body = 1.0 - smoothstep(r - uTube.w, r + uTube.w, d);
  float x = d / (uTube.z * r);
  vec3 tube = mix(c * 1.3, vec3(1.0), 0.85 * exp(-x * x)) * body;
  float halo = 0.55 * exp(-d / (1.4 * r)) + 0.16 * exp(-d / (4.5 * r));
  halo *= 1.0 - smoothstep(0.5 * uTube.y, uTube.y, d);
  return tube + c * halo * (1.0 - body);
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
    col += s * (emit(f.r, uC1) + emit(f.g, uC2));
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A neon sign on a wall at night, spelling the user's text in glowing tubes. The
 * text is drawn once with a system font on an OffscreenCanvas, turned into a
 * distance field to the strokes' centrelines on the CPU (neon-sim.ts) and a
 * blurred low-res copy that lights the wall; both rebuild only when the text,
 * position or aspect ratio changes. Each frame is a single full-screen pass.
 */
export const neon = defineEffect(neonMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, NEON_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
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

      /** Lays out and rasterises the text, then rebuilds the field and glow textures. */
      const build = (text: string, position: NeonPosition, aspect: number) => {
        const lines = signLines(text);
        hasSign = lines.length > 0;
        if (!hasSign) {
          return;
        }
        const measure = new OffscreenCanvas(1, 1).getContext("2d");
        if (measure) {
          measure.font = `${String(FONT_WEIGHT)} 100px ${FONT_FAMILY}`;
        }
        const widths = lines.map((l) => {
          // Undefined without a context, and from the tests' fake one, whose methods all return undefined.
          const metrics = measure?.measureText(l.text);
          const w = metrics?.width;
          return typeof w === "number" && w > 0 ? w / 100 : fallbackWidthEm(l.text);
        });
        const layout = signLayout(aspect, position, widths);
        const radius = tubeRadius(layout.font);
        const reach = HALO_RADII * radius;
        const grid = fieldGrid(layout, radius);
        const { cols, rows } = grid;
        const toTexel = REF_HEIGHT / FIELD_TEXEL;

        // Line 1 in red, line 2 in green, so each gets its own field.
        const canvas = new OffscreenCanvas(cols, rows);
        const ctx = canvas.getContext("2d");
        const rowCentre = (k: number) =>
          (layout.y + (k + 0.5) * LINE_PITCH * layout.font) * toTexel - grid.top / FIELD_TEXEL;
        let pixels: Uint8ClampedArray | undefined;
        if (ctx) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, cols, rows);
          ctx.globalCompositeOperation = "lighter";
          ctx.font = `${String(FONT_WEIGHT)} ${String(layout.font * toTexel)}px ${FONT_FAMILY}`;
          ctx.textAlign = layout.align;
          ctx.textBaseline = "middle";
          const ax = layout.anchor * toTexel - grid.left / FIELD_TEXEL;
          lines.forEach((l, k) => {
            ctx.fillStyle = l.index === 0 ? "#f00" : "#0f0";
            ctx.fillText(l.text, ax, rowCentre(k));
          });
          const image = ctx.getImageData(0, 0, cols, rows) as ImageData | undefined;
          pixels = image?.data;
        }
        const masks = [new Uint8Array(cols * rows), new Uint8Array(cols * rows)];
        if (pixels) {
          for (let i = 0; i < cols * rows; i++) {
            masks[0][i] = pixels[4 * i] > 127 ? 1 : 0;
            masks[1][i] = pixels[4 * i + 1] > 127 ? 1 : 0;
          }
        }
        const dists = masks.map((m) => centrelineDistance(m, cols, rows, reach).dist);

        // Clips along each line's tubes.
        const cover = new Float32Array(cols * rows);
        const shade = new Float32Array(cols * rows);
        const halfPitch = Math.trunc(0.5 * LINE_PITCH * layout.font * toTexel);
        lines.forEach((l, k) => {
          const c = rowCentre(k);
          const top = Math.max(0, Math.floor(c - halfPitch));
          const bottom = Math.min(rows, Math.ceil(c + halfPitch));
          const mid = c + 0.08 * layout.font * toTexel;
          const dist = dists[l.index];
          for (const [x, y] of placeClips(dist, cols, top, bottom, mid, radius, MAX_CLIPS)) {
            drawClip(cover, shade, cols, rows, x, y, radius);
          }
        });

        const data = new Float32Array(cols * rows * 4);
        for (let i = 0; i < cols * rows; i++) {
          data[4 * i] = dists[0][i];
          data[4 * i + 1] = dists[1][i];
          data[4 * i + 2] = cover[i];
          data[4 * i + 3] = shade[i];
        }
        upload(fieldTex, cols, rows, gl.RGBA16F, gl.RGBA, data);

        const gg = glowGrid(grid);
        const g0 = glowField(dists[0], grid, gg, radius);
        const g1 = glowField(dists[1], grid, gg, radius);
        const glow = new Float32Array(gg.cols * gg.rows * 2);
        for (let i = 0; i < g0.length; i++) {
          glow[2 * i] = g0[i];
          glow[2 * i + 1] = g1[i];
        }
        upload(glowTex, gg.cols, gg.rows, gl.RG16F, gl.RG, glow);

        field4[0] = grid.left;
        field4[1] = grid.top;
        field4[2] = 1 / (cols * FIELD_TEXEL);
        field4[3] = 1 / (rows * FIELD_TEXEL);
        glow4[0] = gg.left;
        glow4[1] = gg.top;
        glow4[2] = 1 / (gg.cols * GLOW_TEXEL);
        glow4[3] = 1 / (gg.rows * GLOW_TEXEL);
        tube4[0] = radius;
        tube4[1] = reach;
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
          if (p.text !== builtText || position !== builtPosition || aspect !== builtAspect) {
            build(p.text, position, aspect);
            builtText = p.text;
            builtPosition = position;
            builtAspect = aspect;
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
