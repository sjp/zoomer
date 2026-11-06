import { type Rgb, unitRgbMemo } from "./color";
import { BEAM_FRAGMENT, BEAM_VERTEX, type Beam, layoutBeams, writeBeamInstance } from "./fireflies";
import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import {
  BELL_A,
  CHAINS_PER_JELLY,
  createSwarm,
  DOME_H,
  paletteFor,
  QUAD_BOTTOM,
  RIM_E,
  RIM_Y,
  STRIP_FLOATS,
  STRIP_VERTS,
} from "./jellyfish-sim";
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { wrap } from "./math";
import { createNoise, createRng } from "./noise";
import { createSpriteBatch, polygonStrip, SPRITE_SPIN_GLSL } from "./sprites";
import { jellyfishMeta, MAX_JELLIES, MAX_SNOW } from "./jellyfish.meta";
import { defineEffect } from "./types";

const SHAFTS = 3;
/** Shaft colour times strength; pale aquarium light from above. */
const SHAFT_COLOR: Rgb = [0.05, 0.085, 0.11];
/** Marine snow: soft pale motes, dimmer when far. */
const SNOW_COLOR: Rgb = [0.55, 0.7, 0.8];
/** Seconds a mote takes to fade in when the count is raised. */
const SNOW_FADE_IN = 1;

/** The bell quad: full width, from the top to just below the rim (nothing is drawn lower). */
const BELL_SHAPE: readonly number[] = [-1, -1, 1, -1, -1, QUAD_BOTTOM, 1, QUAD_BOTTOM];

const bellVertex = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, quad half-width, half-height (device px, y down). */
layout(location = 1) in vec4 aBell;
/** Premultiplied colour, contraction. */
layout(location = 2) in vec4 aTint;
layout(location = ${String(spinLocation)}) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vTint;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vLocal = aCorner;
  vTint = aTint;
  gl_Position = pxToClip(aBell.xy + spinCorner(aCorner * aBell.zw, aSpin), uResolution);
}
`;

/**
 * A translucent bell, shaded analytically in quad-local units (x across, y down
 * the axis): a dome above the rim ellipse, brighter toward its edge, with the rim
 * ring (its back half seen through the dome), radial canals, an inner glow and a
 * faint halo that reaches zero inside the quad.
 */
const BELL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vTint;
uniform float uGlow;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float x = vLocal.x / ${glslFloat(BELL_A)};
  float dy = vLocal.y - ${glslFloat(RIM_Y)};
  // Silhouette: the dome above the rim, the near half of the rim ellipse below.
  float r = length(vec2(x, dy / (dy < 0.0 ? ${glslFloat(DOME_H)} : ${glslFloat(RIM_E)})));
  float body = 1.0 - smoothstep(0.9, 1.0, r);
  float edge = smoothstep(0.55, 1.0, r);
  float rim = edge * edge * edge;

  // Rim ring: distance to the whole rim ellipse, normalised by its gradient.
  float ey = dy / ${glslFloat(RIM_E)};
  float e = length(vec2(x, ey));
  vec2 grad = vec2(x / ${glslFloat(BELL_A)}, ey / ${glslFloat(RIM_E)}) / max(e, 1e-3);
  float d = (e - 1.0) / max(length(grad), 1e-3);
  float ring = exp(-(d * d) / 0.0012);

  // Radial canals: meridians of the dome, from the apex down to the rim.
  float h = min(dy, 0.0) / ${glslFloat(DOME_H)};
  float span = sqrt(max(1.0 - h * h, 1e-4));
  float lon = asin(clamp(x / span, -1.0, 1.0));
  float c = cos(lon * 4.0);
  float canal = smoothstep(0.8, 1.0, c * c) * smoothstep(0.0, 0.3, 1.0 + h) * step(dy, 0.0);

  // Inner glow, high in the bell.
  vec2 q = vec2(x * 1.6, (dy + 0.5 * ${glslFloat(DOME_H)}) / 0.45);
  float inner = exp(-3.0 * dot(q, q));

  float halo = max(0.0, 1.0 - (r - 1.0) / 0.2);
  halo *= halo * (1.0 - body);

  float con = vTint.a;
  float lum = body * (0.09 + (0.35 + 0.5 * uGlow) * rim + 0.3 * canal + 0.35 * inner)
    + 0.55 * ring
    + 0.22 * uGlow * halo;
  lum *= 1.0 + 0.3 * con;
  outColor = vec4(max(vTint.rgb * lum + dither8(gl_FragCoord.xy), 0.0), 0.0);
}
`;

/** Tentacle strips: device-px positions, the across coordinate and a premultiplied colour. */
const STRIP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in float aAcross;
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
out float vAcross;
out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  vAcross = aAcross;
  vColor = aColor;
  gl_Position = pxToClip(aPos, uResolution);
}
`;

/** A soft ribbon: brightest along its middle, zero at both edges. */
const STRIP_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in float vAcross;
in vec3 vColor;
out vec4 outColor;
void main() {
  float f = max(1.0 - vAcross * vAcross, 0.0);
  outColor = vec4(vColor * f, 0.0);
}
`;

/** Marine snow: a soft dot in an octagon. */
const SNOW_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px), brightness. */
layout(location = 1) in vec4 aMote;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vBright;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vBright = aMote.w;
  gl_Position = pxToClip(aMote.xy + aCorner * aMote.z, uResolution);
}
`;

const SNOW_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in float vBright;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float t = max(1.0 - dot(vLocal, vLocal), 0.0);
  outColor = vec4(uColor * (t * t * vBright), 0.0);
}
`;

/**
 * Translucent jellyfish pulsing slowly through deep blue water, trailing soft
 * tentacles, with drifting marine snow and faint light shafts. Everything is
 * additive over a gradient: one instanced draw for the bells, one strip for every
 * tentacle, one for the motes.
 */
export const jellyfish = defineEffect(jellyfishMeta, {
  create(gl) {
    return withScope((scope) => {
      const bellBatch = scope.own(
        createSpriteBatch(gl, MAX_JELLIES, [4, 4], [BELL_SHAPE], { rotation: true }),
      );
      const bellProgram = scope.add(
        createProgram(gl, bellVertex(bellBatch.spinLocation), BELL_FRAGMENT),
        (p) => {
          gl.deleteProgram(p);
        },
      );
      const bellU = createUniforms(gl, bellProgram, ["uResolution", "uGlow"]);

      const stripProgram = scope.add(createProgram(gl, STRIP_VERTEX, STRIP_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const stripU = createUniforms(gl, stripProgram, ["uResolution"]);
      const strips = new Float32Array(MAX_JELLIES * CHAINS_PER_JELLY * STRIP_VERTS * STRIP_FLOATS);
      const stripVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const stripBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(stripVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, stripBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, strips.byteLength, gl.DYNAMIC_DRAW);
      const strideBytes = STRIP_FLOATS * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, strideBytes, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, strideBytes, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, strideBytes, 12);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const snowBatch = scope.own(
        createSpriteBatch(gl, MAX_SNOW, [4], [polygonStrip(8, Math.PI / 8)]),
      );
      const snowProgram = scope.add(createProgram(gl, SNOW_VERTEX, SNOW_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const snowU = createUniforms(gl, snowProgram, ["uResolution", "uColor"]);

      const shaftBatch = scope.own(createSpriteBatch(gl, SHAFTS, [3, 3]));
      const shaftProgram = scope.add(createProgram(gl, BEAM_VERTEX, BEAM_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const shaftU = createUniforms(gl, shaftProgram, ["uResolution", "uColor"]);
      const shafts: Beam[] = Array.from({ length: SHAFTS }, () => ({
        x0: 0,
        slope: 0,
        halfWidth: 1,
        y0: 0,
        y1: 1,
        intensity: 0,
      }));

      const background = scope.own(createGradientBackground(gl));
      const waterRgb = unitRgbMemo();
      let lastWater: Rgb | undefined;
      const top: Rgb = [0, 0, 0];
      const bottom: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      // CPU-only, unwrapped in float64.
      let time = 0;
      const rng = createRng(Math.random() * 0xffffffff);
      const swarm = createSwarm(rng, refWidth);
      const frameIn = {
        refWidth,
        scale,
        count: 0,
        size: 0,
        pulse: 1,
        tentacles: 0,
        glow: 0,
        palette: paletteFor("mixed"),
      };

      // Marine snow, in reference units.
      const noise = createNoise(11);
      const snowX = new Float32Array(MAX_SNOW);
      const snowY = new Float32Array(MAX_SNOW);
      const snowZ = new Float32Array(MAX_SNOW);
      const snowSeed = new Float32Array(MAX_SNOW);
      const snowLife = new Float32Array(MAX_SNOW);
      let snowLive = 0;
      for (let i = 0; i < MAX_SNOW; i++) {
        snowX[i] = rng() * refWidth;
        snowY[i] = rng() * 1080;
        snowZ[i] = rng();
        snowSeed[i] = rng() * 100;
      }
      layoutBeams(SHAFTS, -14, refWidth, shafts);

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          const k = newRefWidth / refWidth;
          swarm.rescaleX(k);
          for (let i = 0; i < MAX_SNOW; i++) snowX[i] *= k;
          ({ width, height, scale } = v);
          refWidth = newRefWidth;
          layoutBeams(SHAFTS, -14, refWidth, shafts);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;

          frameIn.refWidth = refWidth;
          frameIn.scale = scale;
          frameIn.count = p.count;
          frameIn.size = p.size;
          frameIn.pulse = p.pulse;
          frameIn.tentacles = p.tentacles;
          frameIn.glow = p.glow;
          frameIn.palette = paletteFor(p.palette);
          swarm.step(dt, frameIn, bellBatch.data, bellBatch.stride, bellBatch.spinOffset, strips);

          // Background: the water colour, brighter toward the surface.
          const water = waterRgb(p.water);
          if (water !== lastWater) {
            lastWater = water;
            for (let c = 0; c < 3; c++) {
              top[c] = Math.min(1, water[c] * 1.9 + 0.02);
              bottom[c] = water[c] * 0.3;
            }
          }
          background.draw(top, bottom);

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE);

          // Light shafts, slowly breathing.
          {
            const d = shaftBatch.data;
            for (let b = 0; b < SHAFTS; b++) {
              const gain = 0.75 + 0.25 * Math.sin(time * 0.17 + b * 2.3);
              writeBeamInstance(d, b * shaftBatch.stride, shafts[b], scale, gain);
            }
            shaftBatch.upload(SHAFTS);
            gl.useProgram(shaftProgram);
            shaftU.f2("uResolution", width, height);
            shaftU.v3("uColor", SHAFT_COLOR);
            shaftBatch.draw(0, SHAFTS);
          }

          // Marine snow: slow sinking with a gentle sideways meander.
          const target = Math.min(Math.floor(p.particles), MAX_SNOW);
          snowLive = growLive(snowLife, snowLive, target);
          const inStep = dt / SNOW_FADE_IN;
          const outStep = dt / FADE_OUT;
          const sd = snowBatch.data;
          let motes = 0;
          for (let i = 0; i < snowLive; i++) {
            const z = snowZ[i];
            const pace = 0.4 + 0.6 * z;
            const mx = snowX[i] + noise.noise2(time * 0.07, snowSeed[i]) * 6 * pace * dt;
            const my = snowY[i] + 7 * pace * dt;
            const x = wrap(mx, -6, refWidth + 12);
            const y = wrap(my, -6, 1092);
            snowX[i] = x;
            snowY[i] = y;
            if (x !== mx || y !== my) snowLife[i] = 0;
            const l = stepLife(snowLife, i, target, inStep, outStep);
            const a = (0.25 + 0.45 * z) * l;
            if (a <= 0.003) continue;
            const o = motes * snowBatch.stride;
            sd[o] = x * scale;
            sd[o + 1] = y * scale;
            sd[o + 2] = (1.8 + 2.2 * z) * scale + 1;
            sd[o + 3] = a;
            motes++;
          }
          snowLive = trimLive(snowLife, snowLive, target);
          if (motes > 0) {
            snowBatch.upload(motes);
            gl.useProgram(snowProgram);
            snowU.f2("uResolution", width, height);
            snowU.v3("uColor", SNOW_COLOR);
            snowBatch.draw(0, motes);
          }

          const verts = swarm.stripVerts;
          if (verts > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, stripBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, strips, 0, verts * STRIP_FLOATS);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.useProgram(stripProgram);
            stripU.f2("uResolution", width, height);
            gl.bindVertexArray(stripVao);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, verts);
            gl.bindVertexArray(null);
          }

          const bells = swarm.bells;
          if (bells > 0) {
            bellBatch.upload(bells);
            gl.useProgram(bellProgram);
            bellU.f2("uResolution", width, height);
            bellU.f1("uGlow", p.glow);
            bellBatch.draw(0, bells);
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
