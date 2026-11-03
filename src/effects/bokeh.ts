import type { Rgb } from "./color";
import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { bokehMeta, MAX_LIGHTS } from "./bokeh.meta";
import { defineEffect } from "./types";
import { unitRgbMemo } from "./color";
import { createLights, type LightFrame } from "./bokeh-sim";

/** Hexagon apothem relative to the light radius, as the old pre-rendered sprite had. */
const HEX_APOTHEM = Math.cos(Math.PI / 6) * 1.04;
/**
 * Fill budget: the lights' polygons may cover at most this many screens in
 * total, so large sizes draw fewer lights rather than missing 4K/120 (additive
 * blending at 4K is fill-bound).
 */
const FILL_SCREENS = 4;
/** Area of the bounding octagon per radius², at a typical soft-edge reach of 1.1. */
const OCTAGON_AREA = 8 * Math.tan(Math.PI / 8) * 1.1 * 1.1;

/**
 * How many of `count` lights to draw so their expected total area stays within
 * `FILL_SCREENS` screens. Sizes are in 1080p reference px, `refWidth` is the
 * screen width in the same units. Radii are `size * exp(e)` with `e` uniform in
 * ±`variation * 1.1`, so the mean radius² is `size² * sinh(2s) / 2s`.
 */
export function bokehLightCount(
  count: number,
  size: number,
  variation: number,
  refWidth: number,
): number {
  const s = Math.max(0, variation) * 1.1;
  const meanR2 = size * size * (s > 1e-6 ? Math.sinh(2 * s) / (2 * s) : 1);
  const perLight = OCTAGON_AREA * meanR2;
  const fit = perLight > 0 ? Math.floor((FILL_SCREENS * refWidth * 1080) / perLight) : count;
  return Math.max(1, Math.min(MAX_LIGHTS, Math.floor(count), fit));
}

/**
 * Each light is drawn as a polygon (apothem 1 in `aCorner` units) fitted to its
 * shape: an octagon around a disc, a hexagon matching a hexagon. The light's
 * visible extent is `uExtent` radii (shape plus soft edge), so almost every
 * shaded fragment contributes: at 4K, fill and blending dominate this effect.
 */
const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down) and opacity. */
layout(location = 1) in vec4 aLight;
/** Colour index, 0..2. */
layout(location = 2) in float aHue;
uniform vec2 uResolution;
uniform vec3 uColors[3];
uniform float uExtent;
out vec2 vLocal;
flat out vec3 vColor;
flat out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  // Grow by a pixel so the anti-aliased edge of tiny lights is never clipped.
  float ext = aLight.z * uExtent + 1.0;
  vec2 px = aLight.xy + aCorner * ext;
  // In radii from the centre.
  vLocal = aCorner * (ext / aLight.z);
  vColor = uColors[int(aHue + 0.5)];
  vAlpha = aLight.w;
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * One lens-bokeh disc: soft edge, slightly brighter rim, mostly flat interior.
 * Output is premultiplied for additive blending.
 */
const fragment = (hexagon: boolean) => /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec3 vColor;
flat in float vAlpha;
uniform float uEdge;
uniform float uRimPos;
uniform float uRimWidth;
uniform float uRimAmp;
out vec4 outColor;
void main() {
${
  hexagon
    ? `  // Distance along the nearest edge normal (flat top and bottom), normalised so
  // edges sit at 1. Normals are at ±90°, ±30° and ±150°; fold into one quadrant.
  vec2 q = abs(vLocal);
  float d = max(q.y, dot(q, vec2(${glslFloat(Math.cos(Math.PI / 6))}, 0.5))) * ${glslFloat(1 / HEX_APOTHEM)};`
    : `  float d = length(vLocal);`
}
  // At least about a pixel of anti-aliasing, as the old bilinear-scaled sprite had.
  float hw = max(uEdge * 0.5, fwidth(d) * 0.5);
  float shape = 1.0 - smoothstep(1.0 - hw, 1.0 + hw, d);
  float r = (d - uRimPos) / uRimWidth;
  float rim = uRimAmp * exp(-r * r);
  float alpha = min(1.0, shape * (0.5 + 0.1 * d * d + rim));
  vec3 color = mix(vColor, vec3(1.0), rim * 0.35);
  outColor = vec4(color * (alpha * vAlpha), 0.0);
}
`;

/**
 * Out-of-focus city or fairy lights: soft discs drifting slowly, with larger
 * (nearer) lights fainter and faster for a sense of depth.
 */
export const bokeh = defineEffect(bokehMeta, {
  create(gl) {
    return withScope((scope) => {
      // One program per aperture shape; uniforms are set only when they change
      // (uniforms are per-program state, and these programs are ours alone).
      const variants = [false, true].map((hexagon) => {
        const program = scope.add(createProgram(gl, VERTEX, fragment(hexagon)), (p) =>
          gl.deleteProgram(p),
        );
        const u = createUniforms(gl, program, [
          "uResolution",
          "uColors",
          "uExtent",
          "uEdge",
          "uRimPos",
          "uRimWidth",
          "uRimAmp",
        ]);
        /** Colours `uColors` was last set from (memoised references); arrays aren't tracked by `u`. */
        const setColors: (Rgb | undefined)[] = [undefined, undefined, undefined];
        return { hexagon, u, setColors };
      });
      // Per light: centre x, centre y, radius, opacity, then colour index.
      const batch = scope.own(
        createSpriteBatch(
          gl,
          MAX_LIGHTS,
          [4, 1],
          // Octagon for discs; hexagon with vertices at 0° (flat top) for hexagons.
          [polygonStrip(8, Math.PI / 8), polygonStrip(6)],
        ),
      );
      const background = scope.own(createGradientBackground(gl));
      const colors = new Float32Array(9);
      const bgTop = unitRgbMemo();
      const bgBottom = unitRgbMemo();
      const lightColors = [unitRgbMemo(), unitRgbMemo(), unitRgbMemo()];

      let width = 1;
      let height = 1;
      let refWidth = 1920;
      const lights = createLights(MAX_LIGHTS, refWidth);
      const f: LightFrame = {
        refWidth,
        scale: 1,
        target: 0,
        size: 0,
        sizeVariation: 0,
        direction: 0,
        speed: 0,
        wander: 0,
        twinkle: 0,
        brightness: 0,
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          lights.rescaleX(newRefWidth / refWidth);
          ({ width, height } = v);
          refWidth = f.refWidth = newRefWidth;
          f.scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          // Bigger lights draw fewer of them, keeping the blended area within budget.
          f.target = bokehLightCount(p.count, p.size, p.sizeVariation, refWidth);
          f.size = p.size;
          f.sizeVariation = p.sizeVariation;
          f.direction = p.direction;
          f.speed = p.speed;
          f.wander = p.wander;
          f.twinkle = p.twinkle;
          f.brightness = p.brightness;
          const visible = lights.step(dt, f, batch.data, batch.stride);

          background.draw(bgTop(p.backgroundTop), bgBottom(p.backgroundBottom));
          if (visible === 0) return;

          batch.upload(visible);
          // "lighter": add each light's premultiplied colour.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE);
          const v = variants[p.shape === "hexagon" ? 1 : 0];
          gl.useProgram(v.u.program);

          const c1 = lightColors[0](p.color1);
          const c2 = lightColors[1](p.color2);
          const c3 = lightColors[2](p.color3);
          const { u, setColors } = v;
          if (setColors[0] !== c1 || setColors[1] !== c2 || setColors[2] !== c3) {
            setColors[0] = c1;
            setColors[1] = c2;
            setColors[2] = c3;
            colors.set(c1, 0);
            colors.set(c2, 3);
            colors.set(c3, 6);
            gl.uniform3fv(u.loc.uColors, colors);
          }
          u.f2("uResolution", width, height);
          // Aperture shape, as the old pre-rendered sprite computed it.
          const edge = 0.03 + p.softness * 0.36;
          // Where the soft edge reaches zero (the fwidth floor fits in the extra pixel).
          const reach = 1 + edge * 0.5;
          u.f1("uExtent", v.hexagon ? reach * HEX_APOTHEM : reach);
          u.f1("uEdge", edge);
          u.f1("uRimPos", 1 - edge * 0.5 - 0.03);
          u.f1("uRimWidth", 0.05 + edge * 0.25);
          u.f1("uRimAmp", 0.5 * (1 - p.softness * 0.6));
          batch.draw(0, visible, v.hexagon ? 1 : 0);
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
