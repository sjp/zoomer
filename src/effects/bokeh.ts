import type { Rgb } from "./color";
import { createProgram, getUniforms } from "./gl";
import {
  createGradientBackground,
  createSpriteBatch,
  polygonStrip,
  resetState,
  unitRgbMemo,
} from "./sprites";
import { defineEffect } from "./types";

const MAX_LIGHTS = 200;
/** Off-screen margin before a light wraps, relative to its radius. */
const SPRITE_PAD = 1.25;
/** Hexagon apothem relative to the light radius, as the old pre-rendered sprite had. */
const HEX_APOTHEM = Math.cos(Math.PI / 6) * 1.04;
/** Reference drift speed in px/s at 1080p for a speed of 1. */
const DRIFT_PX = 18;
/** Seconds a light takes to fade in after (re)appearing. */
const FADE_IN = 2;
const TAU = Math.PI * 2;

/** GLSL float literal, so shader constants come from the TS ones above. */
const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

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
void main() {
  // Grow by a pixel so the anti-aliased edge of tiny lights is never clipped.
  float ext = aLight.z * uExtent + 1.0;
  vec2 px = aLight.xy + aCorner * ext;
  // In radii from the centre.
  vLocal = aCorner * (ext / aLight.z);
  vColor = uColors[int(aHue + 0.5)];
  vAlpha = aLight.w;
  gl_Position = vec4(px.x / uResolution.x * 2.0 - 1.0, 1.0 - px.y / uResolution.y * 2.0, 0.0, 1.0);
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
  float d = max(q.y, dot(q, vec2(${f(Math.cos(Math.PI / 6))}, 0.5))) * ${f(1 / HEX_APOTHEM)};`
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
export const bokeh = defineEffect({
  id: "bokeh",
  name: "Bokeh Lights",
  description: "Soft, out-of-focus discs of light drifting slowly, like lights behind a wide lens.",
  params: {
    count: { kind: "number", label: "Lights", min: 5, max: MAX_LIGHTS, step: 1, default: 55 },
    size: { kind: "number", label: "Light size", min: 20, max: 220, step: 1, default: 80 },
    sizeVariation: {
      kind: "number",
      label: "Size variation",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    softness: { kind: "number", label: "Edge softness", min: 0, max: 1, step: 0.01, default: 0.35 },
    speed: { kind: "number", label: "Drift speed", min: 0, max: 5, step: 0.1, default: 1 },
    direction: {
      kind: "number",
      label: "Drift direction (degrees, 90 = up)",
      min: 0,
      max: 360,
      step: 1,
      default: 100,
    },
    wander: { kind: "number", label: "Wander", min: 0, max: 1, step: 0.01, default: 0.5 },
    twinkle: { kind: "number", label: "Twinkle", min: 0, max: 1, step: 0.01, default: 0.35 },
    brightness: {
      kind: "number",
      label: "Brightness",
      min: 0.2,
      max: 2,
      step: 0.05,
      default: 1,
    },
    color1: { kind: "color", label: "Light colour 1", default: "#ffb347" },
    color2: { kind: "color", label: "Light colour 2", default: "#ff6f91" },
    color3: { kind: "color", label: "Light colour 3", default: "#ffe08a" },
    shape: {
      kind: "select",
      label: "Aperture shape",
      options: [
        { value: "circle", label: "Circle" },
        { value: "hexagon", label: "Hexagon" },
      ],
      default: "circle",
    },
    backgroundTop: { kind: "color", label: "Background top colour", default: "#07050f" },
    backgroundBottom: { kind: "color", label: "Background bottom colour", default: "#2a0f22" },
  },
  context: "webgl2",
  create(gl) {
    // One program per aperture shape; uniforms are set only when their inputs change
    // (uniforms are per-program state, and these programs are ours alone).
    const variants = [false, true].map((hexagon) => {
      const program = createProgram(gl, VERTEX, fragment(hexagon));
      const loc = getUniforms(gl, program, [
        "uResolution",
        "uColors",
        "uExtent",
        "uEdge",
        "uRimPos",
        "uRimWidth",
        "uRimAmp",
      ]);
      /** Inputs the uniforms were last set from; colours are memoised references. */
      const set = { width: 0, height: 0, softness: Number.NaN, colors: [] as Rgb[] };
      return { hexagon, program, loc, set };
    });
    // Per light: centre x, centre y, radius, opacity, then colour index.
    const batch = createSpriteBatch(
      gl,
      MAX_LIGHTS,
      [4, 1],
      // Octagon for discs; hexagon with vertices at 0° (flat top) for hexagons.
      [polygonStrip(8, Math.PI / 8), polygonStrip(6)],
    );
    const background = createGradientBackground(gl);
    const colors = new Float32Array(9);
    const bgTop = unitRgbMemo();
    const bgBottom = unitRgbMemo();
    const lightColors = [unitRgbMemo(), unitRgbMemo(), unitRgbMemo()];

    // Positions are in reference units (1 = 1080 device-independent pixels).
    const xs = new Float32Array(MAX_LIGHTS);
    const ys = new Float32Array(MAX_LIGHTS);
    /** 0 = far/small, 1 = near/large. */
    const depth = new Float32Array(MAX_LIGHTS);
    const hue = new Uint8Array(MAX_LIGHTS);
    const heading = new Float32Array(MAX_LIGHTS);
    const turnRate = new Float32Array(MAX_LIGHTS);
    const turnPhase = new Float32Array(MAX_LIGHTS);
    const twinkleRate = new Float32Array(MAX_LIGHTS);
    const twinklePhase = new Float32Array(MAX_LIGHTS);
    const life = new Float32Array(MAX_LIGHTS);

    let width = 1;
    let height = 1;
    let scale = 1;
    let refWidth = 1920;
    let time = 0;
    let prevCount = 0;

    for (let i = 0; i < MAX_LIGHTS; i++) {
      xs[i] = Math.random() * refWidth;
      ys[i] = Math.random() * 1080;
      depth[i] = Math.random();
      hue[i] = i % 3;
      heading[i] = Math.random() * TAU;
      turnRate[i] = 0.05 + Math.random() * 0.15;
      turnPhase[i] = Math.random() * TAU;
      twinkleRate[i] = 0.3 + Math.random() * 0.9;
      twinklePhase[i] = Math.random() * TAU;
    }

    return {
      resize(v) {
        const newRefWidth = v.width / v.scale;
        const k = newRefWidth / refWidth;
        for (let i = 0; i < MAX_LIGHTS; i++) xs[i] *= k;
        ({ width, height, scale } = v);
        refWidth = newRefWidth;
      },
      frame(dt, p) {
        time = (time + dt) % 10000;

        const n = Math.min(p.count, MAX_LIGHTS);
        for (let i = prevCount; i < n; i++) life[i] = 0;
        prevCount = n;

        const dir = (p.direction * Math.PI) / 180;
        const driftX = Math.cos(dir) * p.speed * DRIFT_PX;
        const driftY = -Math.sin(dir) * p.speed * DRIFT_PX;
        const wanderPx = p.wander * DRIFT_PX * 0.9;
        const spread = p.sizeVariation * 1.1;
        const fadeStep = dt / FADE_IN;

        const data = batch.data;
        const stride = batch.stride;
        let visible = 0;
        for (let i = 0; i < n; i++) {
          const z = depth[i];
          const e = spread * (z * 2 - 1);
          const sizeFactor = Math.exp(e);
          const radius = p.size * sizeFactor;
          const pace = 0.45 + z * 0.9;

          heading[i] += Math.sin(time * turnRate[i] + turnPhase[i]) * dt * 0.6;
          let x = xs[i] + (driftX * pace + Math.cos(heading[i]) * wanderPx * pace) * dt;
          let y = ys[i] + (driftY * pace + Math.sin(heading[i]) * wanderPx * pace) * dt;

          // Wrap once fully off-screen, so the jump is never visible.
          const margin = radius * SPRITE_PAD;
          const spanX = refWidth + margin * 2;
          const spanY = 1080 + margin * 2;
          if (x < -margin) x += spanX;
          else if (x > refWidth + margin) x -= spanX;
          if (y < -margin) y += spanY;
          else if (y > 1080 + margin) y -= spanY;
          xs[i] = x;
          ys[i] = y;

          const l = Math.min(1, life[i] + fadeStep);
          life[i] = l;

          const tw = 0.5 + 0.5 * Math.sin(time * twinkleRate[i] + twinklePhase[i]);
          const pulse = 1 - p.twinkle * 0.6 * tw;
          // Nearer, larger discs spread their light wider and look fainter.
          const alpha = 0.75 * Math.exp(-0.6 * e) * pulse * p.brightness * l * l;
          if (alpha <= 0.002) continue;
          const o = visible * stride;
          data[o] = x * scale;
          data[o + 1] = y * scale;
          data[o + 2] = radius * scale;
          data[o + 3] = Math.min(1, alpha);
          data[o + 4] = hue[i];
          visible++;
        }

        resetState(gl, width, height);
        background.draw(bgTop(p.backgroundTop), bgBottom(p.backgroundBottom));
        if (visible === 0) return;

        batch.upload(visible);
        // "lighter": add each light's premultiplied colour.
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        const v = variants[p.shape === "hexagon" ? 1 : 0];
        gl.useProgram(v.program);

        const c1 = lightColors[0](p.color1);
        const c2 = lightColors[1](p.color2);
        const c3 = lightColors[2](p.color3);
        const set = v.set;
        if (
          set.width !== width ||
          set.height !== height ||
          set.softness !== p.softness ||
          set.colors[0] !== c1 ||
          set.colors[1] !== c2 ||
          set.colors[2] !== c3
        ) {
          set.width = width;
          set.height = height;
          set.softness = p.softness;
          set.colors = [c1, c2, c3];
          // Aperture shape, as the old pre-rendered sprite computed it.
          const edge = 0.03 + p.softness * 0.36;
          colors.set(c1, 0);
          colors.set(c2, 3);
          colors.set(c3, 6);
          const { loc } = v;
          gl.uniform2f(loc.uResolution, width, height);
          gl.uniform3fv(loc.uColors, colors);
          // Where the soft edge reaches zero (the fwidth floor fits in the extra pixel).
          const reach = 1 + edge * 0.5;
          gl.uniform1f(loc.uExtent, v.hexagon ? reach * HEX_APOTHEM : reach);
          gl.uniform1f(loc.uEdge, edge);
          gl.uniform1f(loc.uRimPos, 1 - edge * 0.5 - 0.03);
          gl.uniform1f(loc.uRimWidth, 0.05 + edge * 0.25);
          gl.uniform1f(loc.uRimAmp, 0.5 * (1 - p.softness * 0.6));
        }
        batch.draw(0, visible, v.hexagon ? 1 : 0);
        gl.disable(gl.BLEND);
      },
      dispose() {
        for (const v of variants) gl.deleteProgram(v.program);
        batch.dispose();
        background.dispose();
      },
    };
  },
});
