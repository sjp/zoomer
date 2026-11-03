import { hexToUnitRgb } from "./color";
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
} from "./gl";
import {
  createMarble,
  KIND_DROP,
  MAX_COLOURS,
  MAX_OPS,
  marblePalette,
  OP_FLOATS,
  packOps,
  STRIPE_WIDTH,
  type Extent,
  type MarblePalette,
  type MarbleSim,
} from "./marble-sim";
import { marbleMeta } from "./marble.meta";
import { defineEffect } from "./types";

/**
 * Tine and stripe spacing (in device px) below which the colours fade to the palette
 * mean, so heavily combed or squeezed detail averages out instead of aliasing.
 */
const MINIFY = [0.35, 0.9] as const;

/**
 * One full-resolution pass. Per pixel: map the position into pattern units, then
 * undo the live operations newest first. Each drop met on the way covers the pixel
 * by its anti-aliased disc (front-to-back compositing, with `fwidth` on the signed
 * distance to the rim), and the chain carries on from the drop centre so the rim
 * blends against the paint it pushed aside. What is left samples the baked base,
 * or the initial stripes (anti-aliased with `fwidth` on the stripe index field)
 * before the first bake. The bake runs the same shader into an RGBA8 target with
 * only the oldest finished operations and no dither.
 *
 * Every branch and loop bound depends only on uniforms, so the derivatives stay
 * in uniform control flow.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uOpA[${MAX_OPS}];
uniform vec4 uOpB[${MAX_OPS}];
uniform int uCount;
uniform vec3 uPalette[${MAX_COLOURS}];
uniform int uColours;
uniform vec3 uMean;
/** Frame centre (device px) and units per device px. */
uniform vec3 uView;
uniform sampler2D uBase;
/** Units to base texture coordinates: uv = p * xy + zw. */
uniform vec4 uBaseMap;
uniform float uHasBase;
uniform float uDither;
out vec4 outColor;
${DITHER_GLSL}

vec3 stripes(vec2 p) {
  float f = p.y * ${glslFloat(1 / STRIPE_WIDTH)};
  float fw = max(fwidth(f), 1e-6);
  float i = floor(f);
  float fr = f - i;
  float nb = fr < 0.5 ? i - 1.0 : i + 1.0;
  float n = float(uColours);
  vec3 a = uPalette[int(mod(i, n))];
  vec3 b = uPalette[int(mod(nb, n))];
  vec3 c = mix(a, b, clamp(0.5 - min(fr, 1.0 - fr) / fw, 0.0, 0.5));
  return mix(c, uMean, smoothstep(${glslFloat(MINIFY[0])}, ${glslFloat(MINIFY[1])}, fw));
}

void main() {
  vec2 q = (gl_FragCoord.xy - uView.xy) * uView.z;
  vec3 acc = vec3(0.0);
  float w = 1.0;
  for (int i = 0; i < ${MAX_OPS}; i++) {
    int k = uCount - 1 - i;
    if (k < 0) break;
    vec4 a = uOpA[k];
    vec4 b = uOpB[k];
    vec2 d = q - a.yz;
    if (a.x == ${glslFloat(KIND_DROP)}) {
      // Drop, a.w = r^2: the disc is its paint; outside, pull back towards the centre.
      float d2 = dot(d, d);
      float sd = sqrt(d2) - sqrt(a.w);
      float cov = clamp(0.5 - sd / max(fwidth(sd), 1e-6), 0.0, 1.0);
      acc += w * cov * uPalette[int(b.x)];
      w *= 1.0 - cov;
      q = a.yz + d * sqrt(max(1.0 - a.w / max(d2, 1e-12), 0.0));
    } else if (a.x < 0.0) {
      // Swirl, a.w = angle, b.x = 1 / falloff: turn back by the radius's angle.
      float ang = -a.w * exp(-length(d) * b.x);
      float cs = cos(ang);
      float sn = sin(ang);
      q = a.yz + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
    } else {
      // Comb of a.x tines, a.w = shift, b.xy = direction, b.z = 1 / falloff, b.w = spacing.
      float across = dot(d, vec2(-b.y, b.x));
      float h = 0.5 * (a.x - 1.0);
      float j = clamp(floor(across / b.w + h + 0.5), 0.0, a.x - 1.0);
      float t = abs(across - (j - h) * b.w);
      q -= b.xy * (a.w * exp(-t * b.z));
    }
  }
  vec3 base;
  if (uHasBase > 0.5) {
    base = texture(uBase, q * uBaseMap.xy + uBaseMap.zw).rgb;
  } else {
    base = stripes(q);
  }
  vec3 col = acc + w * base;
  outColor = vec4(col + uDither * dither8(gl_FragCoord.xy), 1.0);
}
`;

interface PaletteData {
  colours: Float32Array;
  count: number;
  mean: [number, number, number];
}

const PALETTE_DATA = new Map<MarblePalette, PaletteData>();
function paletteData(p: MarblePalette): PaletteData {
  let d = PALETTE_DATA.get(p);
  if (!d) {
    const colours = new Float32Array(MAX_COLOURS * 3);
    const mean: [number, number, number] = [0, 0, 0];
    p.colours.forEach((hex, i) => {
      const c = hexToUnitRgb(hex);
      colours.set(c, i * 3);
      for (let k = 0; k < 3; k++) mean[k] += c[k] / p.colours.length;
    });
    d = { colours, count: p.colours.length, mean };
    PALETTE_DATA.set(p, d);
  }
  return d;
}

/**
 * Paper marbling in motion. Strokes and drops are closed-form invertible maps kept
 * as uniforms; each pixel undoes them in reverse and reads the starting pattern.
 * When the queue fills, the oldest finished operations are baked into a full-res
 * RGBA8 base (ping-ponged between two targets), at most every few seconds.
 */
export const marble = defineEffect(marbleMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, [
        "uOpA",
        "uOpB",
        "uCount",
        "uPalette",
        "uColours",
        "uMean",
        "uView",
        "uBase",
        "uBaseMap",
        "uHasBase",
        "uDither",
      ]);
      gl.useProgram(program);
      u.i1("uBase", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));

      let base: RenderTarget | null = null;
      let spare: RenderTarget | null = null;
      scope.defer(() => {
        base?.dispose();
        spare?.dispose();
        base = null;
        spare = null;
      });
      let hasBase = false;
      /** Device px per unit when the base was baked, and the base's size. */
      let baseK = 1;
      let baseW = 1;
      let baseH = 1;

      const opA = new Float32Array(MAX_OPS * OP_FLOATS);
      const opB = new Float32Array(MAX_OPS * OP_FLOATS);
      const extent: Extent = { hx: 1, hy: 1 };

      let sim: MarbleSim | undefined;
      let simPalette: MarblePalette | undefined;
      let lastPalette: PaletteData | undefined;
      let width = 1;
      let height = 1;
      let scale = 1;

      function uploadOps(from: number, count: number) {
        packOps(sim!.ops, from, count, sim!.time, opA, opB);
        gl.uniform4fv(u.loc.uOpA, opA);
        gl.uniform4fv(u.loc.uOpB, opB);
        u.i1("uCount", count);
      }

      function bindBase() {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, hasBase && base ? base.texture : null);
        u.f1("uHasBase", hasBase && base ? 1 : 0);
        u.f4("uBaseMap", baseK / baseW, baseK / baseH, 0.5, 0.5);
      }

      /** Renders the pattern with the oldest `k` operations into the spare target and makes it the base. */
      function bake(k: number, pxPerUnit: number) {
        if (!spare || spare.width !== width || spare.height !== height) {
          spare?.dispose();
          spare = null;
          spare = createRenderTarget(gl, width, height, gl.RGBA8, { wrap: gl.MIRRORED_REPEAT });
        }
        if (spare) {
          uploadOps(0, k);
          bindBase();
          u.f1("uDither", 0);
          spare.bind();
          triangle.draw();
          const old = base;
          base = spare;
          spare = old;
          hasBase = true;
          baseK = pxPerUnit;
          baseW = width;
          baseH = height;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
        }
        // Without a target (a lost context) the operations are dropped rather than stalling the queue.
        sim!.commitBake(k);
      }

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          gl.useProgram(program);

          const ps = Number.isFinite(p.scale) ? Math.min(Math.max(p.scale, 0.25), 4) : 1;
          const pxPerUnit = scale * ps;
          extent.hx = width / (2 * pxPerUnit);
          extent.hy = height / (2 * pxPerUnit);

          const palette = marblePalette(p.palette);
          const seed = Number.isFinite(p.seed) ? Math.floor(p.seed) : 0;
          const pal = paletteData(palette);
          if (!sim || sim.seed !== seed || simPalette !== palette) {
            // Baked paint carries the old colours, so a new palette or variation starts afresh.
            sim = createMarble({ seed, colours: pal.count, extent });
            simPalette = palette;
            hasBase = false;
          }
          if (pal !== lastPalette) {
            lastPalette = pal;
            gl.uniform3fv(u.loc.uPalette, pal.colours);
          }
          u.i1("uColours", pal.count);
          u.v3("uMean", pal.mean);
          u.f3("uView", width / 2, height / 2, 1 / pxPerUnit);

          sim.step(dt, p, extent);
          const k = sim.bakeCount();
          if (k > 0) bake(k, pxPerUnit);

          uploadOps(0, sim.ops.length);
          bindBase();
          u.f1("uDither", 1);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
