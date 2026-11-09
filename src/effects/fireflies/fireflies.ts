import {
  beginFrame,
  createGradientBackground,
  createUniforms,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import { createNoise, createRng } from "../noise";
import { createSpriteBatch, polygonStrip, QUAD } from "../sprites";
import { firefliesMeta, MAX_SPECKS, MAX_BEAMS } from "./fireflies.meta";
import { defineEffect } from "../types";
import { clamp } from "../math";
import { FADE_OUT, growLive, stepLife, trimLive, driftPoint } from "../fade";
import { unitRgbMemo } from "../color";
import {
  type Beam,
  BEAM_FRAGMENT,
  BEAM_VERTEX,
  beamMembership,
  layoutBeams,
  writeBeamInstance,
} from "../light-beams";

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
/** Seconds a speck or beam takes to fade in after appearing. */
const FADE_IN = 1;

/**
 * Firefly blink curve: a smooth sin² pulse during the first `duty` of the cycle,
 * then dark for the rest. `phase` is in [0, 1). Value and slope are zero at both
 * ends of the pulse, so blinks fade in and out without a pop.
 */
export function blink(phase: number, duty: number): number {
  if (duty <= 0 || phase < 0 || phase >= duty) {
    return 0;
  }
  const s = Math.sin((Math.PI * phase) / duty);
  return s * s;
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
${TO_CLIP_GLSL}
void main() {
  vec2 px = aSpeck.xy + aCorner * aSpeck.z;
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = pxToClip(px, uResolution);
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
 * Fireflies over a dusky forest, or dust motes drifting through soft window beams
 * in a dark room. Specks are one instanced draw of small octagons; beams are one
 * additive quad each.
 */
export const fireflies = defineEffect(firefliesMeta, {
  create(gl) {
    return withScope((scope) => {
      const speckProgram = scopedProgram(gl, scope, SPECK_VERTEX, SPECK_FRAGMENT);
      const speckU = createUniforms(gl, speckProgram, ["uResolution"]);
      const beamProgram = scopedProgram(gl, scope, BEAM_VERTEX, BEAM_FRAGMENT);
      const beamU = createUniforms(gl, beamProgram, ["uResolution", "uColor"]);
      // Per speck: x, y, extent radius; premultiplied colour.
      const specks = scope.own(
        createSpriteBatch(gl, MAX_SPECKS, [3, 3], [polygonStrip(8, Math.PI / 8)]),
      );
      // Per beam: x0, slope, half-width; y0, y1, intensity.
      const beamBatch = scope.own(createSpriteBatch(gl, MAX_BEAMS, [3, 3], [QUAD]));
      const background = scope.own(createGradientBackground(gl));
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
      /** Speed factor, including the square root of the speck's size factor. */
      const pace = new Float32Array(MAX_SPECKS);
      /** Size and brightness factors; defocused specks are larger and fainter. */
      const radiusK = new Float32Array(MAX_SPECKS);
      const brightK = new Float32Array(MAX_SPECKS);
      const blinkPhase = new Float32Array(MAX_SPECKS);
      const blinkPeriod = new Float32Array(MAX_SPECKS);
      const blinkDuty = new Float32Array(MAX_SPECKS);
      const seed = new Float32Array(MAX_SPECKS);
      const life = new Float32Array(MAX_SPECKS);
      const beamLife = new Float32Array(MAX_BEAMS);
      /** Specks and beams simulated: the count plus any still fading out after it dropped. */
      let live = 0;
      let beamLive = 0;

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      // Kept unwrapped: a wrap would jump every phase at once; doubles stay precise for weeks.
      let time = 0;

      const rng = createRng(Math.random() * 0xffffffff);
      const newBlink = (i: number) => {
        blinkPeriod[i] = 3 + rng() * 6;
        blinkDuty[i] = (0.5 + rng() * 0.7) / blinkPeriod[i];
      };

      for (let i = 0; i < MAX_SPECKS; i++) {
        xs[i] = rng() * refWidth;
        ys[i] = rng() * 1080;
        heading[i] = rng() * TAU;
        const speed = 0.6 + rng() * 0.8;
        const defocused = rng() < DEFOCUS_SHARE;
        radiusK[i] = defocused ? 1.8 + rng() * 1.2 : 0.75 + rng() * 0.5;
        // Larger (nearer) specks drift faster; folded in once rather than per frame.
        pace[i] = speed * Math.sqrt(radiusK[i]);
        brightK[i] = defocused ? 0.3 + rng() * 0.15 : 0.8 + rng() * 0.2;
        newBlink(i);
        blinkPhase[i] = rng();
        seed[i] = rng() * 100;
      }

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          const k = newRefWidth / refWidth;
          for (let i = 0; i < MAX_SPECKS; i++) {
            xs[i] *= k;
          }
          ({ width, height, scale } = v);
          refWidth = newRefWidth;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const dust = p.scene === "dust";
          const target = Math.min(Math.floor(p.count), MAX_SPECKS);
          const n = (live = growLive(life, live, target));
          const fadeStep = dt / FADE_IN;
          const outStep = dt / FADE_OUT;
          // Beams belong to the dust scene only; a scene change is a hard cut.
          const beamTarget = dust ? clamp(Math.round(p.beams), 1, MAX_BEAMS) : 0;
          if (!dust) {
            beamLive = 0;
          }
          const nBeams = (beamLive = growLive(beamLife, beamLive, beamTarget));
          if (dust) {
            layoutBeams(MAX_BEAMS, p.beamAngle, refWidth, beamShapes);
          }
          for (let b = 0; b < nBeams; b++) {
            stepLife(beamLife, b, beamTarget, fadeStep, outStep);
          }
          beamLive = trimLive(beamLife, beamLive, beamTarget);
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
            const sp = drift * pace[i];
            const radius = baseRadius * radiusK[i];
            const margin = radius;
            // Wrap within a margin of the edges, so the jump is off-screen. The margin
            // shrinks with the size, so a wrap can land a speck on-screen: fade it in
            // at its new place. Dust also settles very slowly, as it does in still air.
            const dx = Math.cos(heading[i]) * sp * dt;
            const dy = (Math.sin(heading[i]) * sp + (dust ? drift * 0.25 : 0)) * dt;
            const span = 2 * margin;
            if (driftPoint(xs, ys, i, dx, dy, -margin, -margin, refWidth + span, 1080 + span)) {
              life[i] = 0;
            }
            const x = xs[i];
            const y = ys[i];
            const l = stepLife(life, i, target, fadeStep, outStep);

            let level: number;
            if (dust) {
              let m = 0;
              for (let b = 0; b < nBeams; b++) {
                m += beamMembership(x, y, beamShapes[b]) * beamLife[b];
              }
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
            const a = level * brightK[i] * p.brightness * l * l;
            if (a <= 0.003) {
              continue;
            }
            const o = visible * stride;
            data[o] = x * scale;
            data[o + 1] = y * scale;
            data[o + 2] = radius * scale + 1;
            data[o + 3] = cr * a;
            data[o + 4] = cg * a;
            data[o + 5] = cb * a;
            visible++;
          }
          live = trimLive(life, live, target);

          background.draw(bgTop(p.topColor), bgBottom(p.bottomColor));

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE);
          if (nBeams > 0) {
            const bd = beamBatch.data;
            const bs = beamBatch.stride;
            for (let b = 0; b < nBeams; b++) {
              // Slow, slight breathing, as if thin cloud passes the window.
              const breathe = 0.85 + 0.15 * Math.sin(time * 0.21 + b * 2.1);
              const gain = breathe * BEAM_STRENGTH * p.brightness * beamLife[b];
              writeBeamInstance(bd, b * bs, beamShapes[b], scale, gain);
            }
            beamBatch.upload(nBeams);
            gl.useProgram(beamProgram);
            beamU.f2("uResolution", width, height);
            beamU.v3("uColor", color);
            beamBatch.draw(0, nBeams);
          }

          if (visible > 0) {
            specks.upload(visible);
            gl.useProgram(speckProgram);
            speckU.f2("uResolution", width, height);
            specks.draw(0, visible);
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
