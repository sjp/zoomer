import { createProgram, getUniforms } from "./gl";
import { createNoise } from "./noise";
import {
  createGradientBackground,
  createSpriteBatch,
  polygonStrip,
  QUAD,
  resetState,
  unitRgbMemo,
} from "./sprites";
import { defineEffect } from "./types";

const MAX_SPECKS = 300;
export const MAX_BEAMS = 3;
/** Sprite extent (where the halo reaches zero) relative to the `size` param. */
const HALO_EXTENT = 6;
/** Dust motes are smaller than fireflies. */
const DUST_SIZE = 0.6;
/** Reference wander speed in px/s at 1080p for a speed of 1. */
const FIREFLY_PX = 14;
const DUST_PX = 5;
/** Fraction of specks that are defocused (nearer the lens): larger and fainter. */
const DEFOCUS_SHARE = 0.25;
/** Base beam brightness (fraction of the light colour at the beam's brightest point). */
const BEAM_STRENGTH = 0.11;
const TAU = Math.PI * 2;

/** GLSL float literal, so shader constants come from the TS ones above. */
const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Firefly blink curve: a smooth sin² pulse during the first `duty` of the cycle,
 * then dark for the rest. `phase` is in [0, 1). Value and slope are zero at both
 * ends of the pulse, so blinks fade in and out without a pop.
 */
export function blink(phase: number, duty: number): number {
  if (duty <= 0 || phase < 0 || phase >= duty) return 0;
  const s = Math.sin((Math.PI * phase) / duty);
  return s * s;
}

/**
 * A light beam: a parallelogram with horizontal top and bottom edges at `y0` and
 * `y1` and slanted sides. Its centre line is `x = x0 + slope * y`, and it reaches
 * `halfWidth` horizontally either side of that line. Reference units (y down).
 */
export interface Beam {
  x0: number;
  slope: number;
  halfWidth: number;
  y0: number;
  y1: number;
  /** Peak brightness multiplier. */
  intensity: number;
}

/** Inner edge of the across-beam falloff, as a fraction of the half-width. */
const BEAM_CORE = 0.3;
/** Where along the beam (0 = top, 1 = bottom) the end fade starts. */
const BEAM_END = 0.72;
/** Brightness left at the bottom of the beam, before the end fade. */
const BEAM_TAIL = 0.35;

/** Across-beam profile: `a` is horizontal offset / half-width; 1 inside the core, 0 at |a| >= 1. */
export function beamAcross(a: number): number {
  return 1 - smoothstep(BEAM_CORE, 1, Math.abs(a));
}

/** Along-beam profile: `v` is 0 at the top, 1 at the bottom; a gentle fade then a soft end. */
export function beamAlong(v: number): number {
  if (v < 0 || v > 1) return 0;
  return (1 - (1 - BEAM_TAIL) * v) * (1 - smoothstep(BEAM_END, 1, v));
}

/**
 * Brightness of beam `b` at point (x, y), 0 outside it. The fragment shader
 * computes the same function, so motes light up exactly where the beam is visible.
 */
export function beamMembership(x: number, y: number, b: Beam): number {
  const v = (y - b.y0) / (b.y1 - b.y0);
  if (v < 0 || v > 1) return 0;
  const a = (x - (b.x0 + b.slope * y)) / b.halfWidth;
  if (a <= -1 || a >= 1) return 0;
  return beamAcross(a) * beamAlong(v) * b.intensity;
}

/** Relative mid-height x (fraction of width), half-width (px at 1080p) and intensity per beam. */
const BEAM_LAYOUT = [
  [0, 95, 1],
  [0.17, 55, 0.8],
  [-0.15, 70, 0.65],
] as const;

/**
 * Lays out `n` beams (clamped to 1..MAX_BEAMS) into `out`, slanting `angleDeg`
 * from vertical (positive leans right going down), spanning the frame height and
 * centred around 40% of the width at mid-height. Allocates nothing.
 */
export function layoutBeams(n: number, angleDeg: number, refWidth: number, out: Beam[]): number {
  const count = Math.max(1, Math.min(MAX_BEAMS, Math.round(n), out.length));
  const slope = Math.tan((angleDeg * Math.PI) / 180);
  // Lean the group against the slant so the beams stay central on screen.
  const centre = refWidth * (0.42 - 0.08 * Math.sign(slope));
  for (let i = 0; i < count; i++) {
    const [dx, hw, intensity] = BEAM_LAYOUT[i];
    const b = out[i];
    b.slope = slope;
    b.x0 = centre + dx * refWidth - slope * 540;
    b.halfWidth = hw;
    b.y0 = -20;
    b.y1 = 1080;
    b.intensity = intensity;
  }
  return count;
}

/** Wraps `x` into [-margin, span + margin] once it leaves, so the jump is off-screen. */
export function wrap(x: number, span: number, margin: number): number {
  if (x < -margin) return x + span + margin * 2;
  if (x > span + margin) return x - span - margin * 2;
  return x;
}

/**
 * Each speck is an octagon around a radial glow: a bright core and a wide faint
 * halo, both reaching zero at the octagon's inscribed circle (`vLocal` length 1).
 */
const SPECK_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, extent radius (device px, y down). */
layout(location = 1) in vec3 aSpeck;
/** Premultiplied colour times brightness. */
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec3 vColor;
void main() {
  vec2 px = aSpeck.xy + aCorner * aSpeck.z;
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = vec4(px.x / uResolution.x * 2.0 - 1.0, 1.0 - px.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

const SPECK_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float t = max(1.0 - dot(vLocal, vLocal), 0.0);
  float halo = t * t;
  float core = halo * halo;
  core *= core;
  core *= core;
  outColor = vec4(vColor * (0.22 * halo + core), 0.0);
}
`;

/**
 * Each beam is one quad mapped onto its parallelogram: `aCorner.x` runs across
 * (±1 = the soft edges), `aCorner.y` along (-1 top, 1 bottom). The profiles match
 * `beamAcross` and `beamAlong`.
 */
const BEAM_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x0, slope, half-width (device px; slope is unitless). */
layout(location = 1) in vec3 aShape;
/** y0, y1 (device px), intensity. */
layout(location = 2) in vec3 aSpan;
uniform vec2 uResolution;
out vec2 vBeam;
flat out float vIntensity;
void main() {
  float v = aCorner.y * 0.5 + 0.5;
  float y = mix(aSpan.x, aSpan.y, v);
  float x = aShape.x + aShape.y * y + aCorner.x * aShape.z;
  vBeam = vec2(aCorner.x, v);
  vIntensity = aSpan.z;
  gl_Position = vec4(x / uResolution.x * 2.0 - 1.0, 1.0 - y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

const BEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vBeam;
flat in float vIntensity;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float across = 1.0 - smoothstep(${f(BEAM_CORE)}, 1.0, abs(vBeam.x));
  float v = clamp(vBeam.y, 0.0, 1.0);
  float along = (1.0 - ${f(1 - BEAM_TAIL)} * v) * (1.0 - smoothstep(${f(BEAM_END)}, 1.0, v));
  vec3 c = uColor * (across * along * vIntensity);
  // Sub-LSB dither hides banding in the wide, shallow beam. Clamped at zero, since
  // a negative additive output would be clamped anyway and bias the edges.
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  outColor = vec4(max(c + (n - 0.5) / 255.0, 0.0), 0.0);
}
`;

/**
 * Fireflies over a dusky forest, or dust motes drifting through soft window beams
 * in a dark room. Specks are one instanced draw of small octagons; beams are one
 * additive quad each.
 */
export const fireflies = defineEffect({
  id: "fireflies",
  name: "Fireflies",
  description:
    "Glowing fireflies blinking over a dusky gradient, or dust motes drifting through soft beams of light.",
  params: {
    scene: {
      kind: "select",
      label: "Scene",
      options: [
        { value: "fireflies", label: "Fireflies" },
        { value: "dust", label: "Dust in light" },
      ],
      default: "fireflies",
    },
    count: { kind: "number", label: "Specks", min: 5, max: MAX_SPECKS, step: 1, default: 70 },
    size: { kind: "number", label: "Speck size", min: 1, max: 10, step: 0.1, default: 3 },
    speed: { kind: "number", label: "Drift speed", min: 0, max: 4, step: 0.05, default: 1 },
    brightness: {
      kind: "number",
      label: "Brightness",
      min: 0.2,
      max: 2,
      step: 0.05,
      default: 1,
    },
    glowColor: { kind: "color", label: "Firefly colour", default: "#d8ff6a" },
    lightColor: { kind: "color", label: "Light colour (dust)", default: "#ffe6bf" },
    topColor: { kind: "color", label: "Background top colour", default: "#0c1a26" },
    bottomColor: { kind: "color", label: "Background bottom colour", default: "#050c08" },
    beams: { kind: "number", label: "Beams (dust)", min: 1, max: MAX_BEAMS, step: 1, default: 2 },
    beamAngle: {
      kind: "number",
      label: "Beam angle (dust, degrees)",
      min: -45,
      max: 45,
      step: 1,
      default: 24,
    },
  },
  context: "webgl2",
  create(gl) {
    const speckProgram = createProgram(gl, SPECK_VERTEX, SPECK_FRAGMENT);
    const speckLoc = getUniforms(gl, speckProgram, ["uResolution"]);
    const beamProgram = createProgram(gl, BEAM_VERTEX, BEAM_FRAGMENT);
    const beamLoc = getUniforms(gl, beamProgram, ["uResolution", "uColor"]);
    // Per speck: x, y, extent radius; premultiplied colour.
    const specks = createSpriteBatch(gl, MAX_SPECKS, [3, 3], [polygonStrip(8, Math.PI / 8)]);
    // Per beam: x0, slope, half-width; y0, y1, intensity.
    const beamBatch = createSpriteBatch(gl, MAX_BEAMS, [3, 3], [QUAD]);
    const background = createGradientBackground(gl);
    const bgTop = unitRgbMemo();
    const bgBottom = unitRgbMemo();
    const glowRgb = unitRgbMemo();
    const lightRgb = unitRgbMemo();
    const noise = createNoise(6);

    const beamShapes: Beam[] = Array.from({ length: MAX_BEAMS }, () => ({
      x0: 0,
      slope: 0,
      halfWidth: 1,
      y0: 0,
      y1: 1,
      intensity: 0,
    }));

    // Positions are in reference units (1 = 1080 device-independent pixels).
    const xs = new Float32Array(MAX_SPECKS);
    const ys = new Float32Array(MAX_SPECKS);
    const heading = new Float32Array(MAX_SPECKS);
    const pace = new Float32Array(MAX_SPECKS);
    /** Size and brightness factors; defocused specks are larger and fainter. */
    const radiusK = new Float32Array(MAX_SPECKS);
    const brightK = new Float32Array(MAX_SPECKS);
    const blinkPhase = new Float32Array(MAX_SPECKS);
    const blinkPeriod = new Float32Array(MAX_SPECKS);
    const blinkDuty = new Float32Array(MAX_SPECKS);
    const seed = new Float32Array(MAX_SPECKS);

    let width = 1;
    let height = 1;
    let scale = 1;
    let refWidth = 1920;
    let time = 0;
    /** Inputs the uniforms were last set from. */
    let speckW = 0;
    let speckH = 0;
    let beamW = 0;
    let beamH = 0;
    let beamColorSet: unknown = null;

    const newBlink = (i: number) => {
      blinkPeriod[i] = 3 + Math.random() * 6;
      blinkDuty[i] = (0.5 + Math.random() * 0.7) / blinkPeriod[i];
    };

    for (let i = 0; i < MAX_SPECKS; i++) {
      xs[i] = Math.random() * refWidth;
      ys[i] = Math.random() * 1080;
      heading[i] = Math.random() * TAU;
      pace[i] = 0.6 + Math.random() * 0.8;
      const defocused = Math.random() < DEFOCUS_SHARE;
      radiusK[i] = defocused ? 1.8 + Math.random() * 1.2 : 0.75 + Math.random() * 0.5;
      brightK[i] = defocused ? 0.3 + Math.random() * 0.15 : 0.8 + Math.random() * 0.2;
      newBlink(i);
      blinkPhase[i] = Math.random();
      seed[i] = Math.random() * 100;
    }

    return {
      resize(v) {
        const newRefWidth = v.width / v.scale;
        const k = newRefWidth / refWidth;
        for (let i = 0; i < MAX_SPECKS; i++) xs[i] *= k;
        ({ width, height, scale } = v);
        refWidth = newRefWidth;
      },
      frame(dt, p) {
        time = (time + dt) % 10000;
        const dust = p.scene === "dust";
        const n = Math.min(p.count, MAX_SPECKS);
        const nBeams = dust ? layoutBeams(p.beams, p.beamAngle, refWidth, beamShapes) : 0;
        const color = dust ? lightRgb(p.lightColor) : glowRgb(p.glowColor);
        const cr = color[0];
        const cg = color[1];
        const cb = color[2];
        const baseRadius = p.size * HALO_EXTENT * (dust ? DUST_SIZE : 1);
        const drift = p.speed * (dust ? DUST_PX : FIREFLY_PX);
        const turn = dust ? 0.5 : 1.2;
        const noiseT = time * (dust ? 0.05 : 0.12);

        const data = specks.data;
        const stride = specks.stride;
        let visible = 0;
        for (let i = 0; i < n; i++) {
          // Smooth random walk: the heading turns by slow 1D noise, never jitters.
          heading[i] += noise.noise2(noiseT, seed[i]) * turn * dt;
          const sp = drift * pace[i] * radiusK[i] ** 0.5;
          const radius = baseRadius * radiusK[i];
          const margin = radius;
          const x = wrap(xs[i] + Math.cos(heading[i]) * sp * dt, refWidth, margin);
          // Dust also settles very slowly, as it does in still air.
          const y = wrap(
            ys[i] + (Math.sin(heading[i]) * sp + (dust ? drift * 0.25 : 0)) * dt,
            1080,
            margin,
          );
          xs[i] = x;
          ys[i] = y;

          let level: number;
          if (dust) {
            let m = 0;
            for (let b = 0; b < nBeams; b++) m += beamMembership(x, y, beamShapes[b]);
            // A gentle glint as each mote tumbles.
            level = Math.min(1, m) * (0.75 + 0.25 * Math.sin(time * 1.3 + seed[i]));
          } else {
            let ph = blinkPhase[i] + dt / blinkPeriod[i];
            if (ph >= 1) {
              ph -= Math.floor(ph);
              newBlink(i);
            }
            blinkPhase[i] = ph;
            level = blink(ph, blinkDuty[i]);
          }
          const a = level * brightK[i] * p.brightness;
          if (a <= 0.003) continue;
          const o = visible * stride;
          data[o] = x * scale;
          data[o + 1] = y * scale;
          data[o + 2] = radius * scale + 1;
          data[o + 3] = cr * a;
          data[o + 4] = cg * a;
          data[o + 5] = cb * a;
          visible++;
        }

        resetState(gl, width, height);
        background.draw(bgTop(p.topColor), bgBottom(p.bottomColor));

        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        if (nBeams > 0) {
          const bd = beamBatch.data;
          const bs = beamBatch.stride;
          for (let b = 0; b < nBeams; b++) {
            const s = beamShapes[b];
            const o = b * bs;
            // Slow, slight breathing, as if thin cloud passes the window.
            const breathe = 0.85 + 0.15 * Math.sin(time * 0.21 + b * 2.1);
            bd[o] = s.x0 * scale;
            bd[o + 1] = s.slope;
            bd[o + 2] = s.halfWidth * scale;
            bd[o + 3] = s.y0 * scale;
            bd[o + 4] = s.y1 * scale;
            bd[o + 5] = s.intensity * breathe * BEAM_STRENGTH * p.brightness;
          }
          beamBatch.upload(nBeams);
          gl.useProgram(beamProgram);
          if (beamW !== width || beamH !== height) {
            beamW = width;
            beamH = height;
            gl.uniform2f(beamLoc.uResolution, width, height);
          }
          if (beamColorSet !== color) {
            beamColorSet = color;
            gl.uniform3fv(beamLoc.uColor, color);
          }
          beamBatch.draw(0, nBeams);
        }

        if (visible > 0) {
          specks.upload(visible);
          gl.useProgram(speckProgram);
          if (speckW !== width || speckH !== height) {
            speckW = width;
            speckH = height;
            gl.uniform2f(speckLoc.uResolution, width, height);
          }
          specks.draw(0, visible);
        }
        gl.disable(gl.BLEND);
      },
      dispose() {
        gl.deleteProgram(speckProgram);
        gl.deleteProgram(beamProgram);
        specks.dispose();
        beamBatch.dispose();
        background.dispose();
      },
    };
  },
});
