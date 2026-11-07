import { type Rgb, unitRgbMemo } from "../color";
import {
  BEAM_FRAGMENT,
  BEAM_VERTEX,
  type Beam,
  layoutBeams,
  writeBeamInstance,
} from "../fireflies/fireflies";
import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import {
  CHAINS_PER_JELLY,
  createSwarm,
  paletteFor,
  STRIP_FLOATS,
  STRIP_VERTS,
} from "./jellyfish-sim";
import { FADE_OUT, growLive, stepLife, trimLive } from "../fade";
import { wrap } from "../math";
import { createNoise, createRng } from "../noise";
import { createSpriteBatch, polygonStrip } from "../sprites";
import {
  BELL_FRAGMENT,
  BELL_SHAPE,
  bellVertex,
  STRIP_FRAGMENT,
  STRIP_VERTEX,
} from "./jellyfish-shaders";
import { jellyfishMeta, MAX_JELLIES, MAX_SNOW } from "./jellyfish.meta";
import { defineEffect } from "../types";

const SHAFTS = 3;
/** Shaft colour times strength; pale aquarium light from above. */
const SHAFT_COLOR: Rgb = [0.05, 0.085, 0.11];
/** Marine snow: soft pale motes, dimmer when far. */
const SNOW_COLOR: Rgb = [0.55, 0.7, 0.8];
/** Seconds a mote takes to fade in when the count is raised. */
const SNOW_FADE_IN = 1;

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
          for (let i = 0; i < MAX_SNOW; i++) {
            snowX[i] *= k;
          }
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
            if (x !== mx || y !== my) {
              snowLife[i] = 0;
            }
            const l = stepLife(snowLife, i, target, inStep, outStep);
            const a = (0.25 + 0.45 * z) * l;
            if (a <= 0.003) {
              continue;
            }
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
