import {
  APEX_Y,
  BALLOON_FLOATS,
  BALLOON_STRIP,
  BASKET_BOTTOM,
  BASKET_HALF,
  BASKET_TOP,
  type Balloons,
  CONE_COS,
  CONE_SIN,
  createBalloons,
  HILL_LAYERS,
  HILL_SHAPE,
  hillColor,
  lightFor,
  MOUTH_HALF,
  MOUTH_Y,
  paletteFor,
  stepBalloons,
  TANGENT_Y,
  writeBalloons,
} from "./balloons-sim";
import { balloonsMeta, LIGHT_OPTIONS, MAX_BALLOONS } from "./balloons.meta";
import type { Rgb } from "./color";
import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { BACK_BASE, buildHills, HILL_COLUMNS } from "./horizon-sim";
import { MAX_LAYERS as HILL_ROWS } from "./horizon.meta";
import { clamp } from "./math";
import { createSpriteBatch } from "./sprites";
import { defineEffect } from "./types";

/** Sun disc radius, as a fraction of the height. */
const SUN_RADIUS = 0.035;
/** Pixels the hill strips reach below the next layer's lowest point, so no gap opens between them. */
const STRIP_OVERLAP = 2;
/** Mist band half-thickness (height units) and peak opacity. */
const MIST_HALF = 0.07;
const MIST_ALPHA = 0.6;
/** Mist drift, radians of its pattern phase per second (the phase is wrapped to 2π). */
const MIST_RATE = 0.02;
const TAU = Math.PI * 2;
/** Warm burner light. */
const FLAME: Rgb = [1, 0.62, 0.28];

/** Index of a light select value, or -1; a loop, so nothing is allocated per frame. */
function lightIndex(id: string): number {
  for (let i = 0; i < LIGHT_OPTIONS.length; i++) if (LIGHT_OPTIONS[i].value === id) return i;
  return -1;
}

/**
 * Sky: horizon-to-zenith gradient, a two-term glow around the sun, the sun disc,
 * and sub-LSB dither. Drawn only over the rows above the back hills' lowest point.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uSunColor;
/** Sun centre x, y (px, y up), radius (px) and glow strength. */
uniform vec4 uSun;
/** Horizon y (px), 1 / (height - horizon y), 1 / height. */
uniform vec3 uSky;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy;
  float t = clamp((p.y - uSky.x) * uSky.y, 0.0, 1.0);
  t = t * (2.0 - t);
  vec3 col = mix(uHorizon, uZenith, t);
  float dist = length(p - uSun.xy);
  float d = dist * uSky.z;
  float glow = uSun.w * (0.5 * exp2(-9.0 * d) + 0.5 * exp2(-2.2 * d) * (1.0 - 0.6 * t));
  col = mix(col, uGlow, min(glow, 1.0));
  col = mix(col, uSunColor, 0.85 * clamp(uSun.z - dist + 0.5, 0.0, 1.0));
  outColor = vec4(col + dither8(p), 1.0);
}
`;

/**
 * Hills: one instanced triangle strip, an instance per layer from \`uLayerBase\`,
 * back first. Each column's top vertex sits on the profile (from the column
 * table), 1.5 px higher for the anti-aliased edge; the bottom vertex sits just
 * below the next layer's lowest point. No vertex attributes: gl_VertexID picks
 * the column and the top or bottom.
 */
const HILL_VERTEX = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uHeights;
uniform vec2 uResolution;
uniform int uLayerBase;
uniform vec3 uColors[${HILL_LAYERS}];
/** Bottom of each layer's strip, px (y up). */
uniform float uBottoms[${HILL_LAYERS}];
out float vEdge;
flat out vec3 vColor;
void main() {
  int layer = gl_InstanceID + uLayerBase;
  int col = gl_VertexID >> 1;
  float h = texelFetch(uHeights, ivec2(col, layer), 0).r * uResolution.y;
  float x = float(col) / ${glslFloat(HILL_COLUMNS - 1)} * uResolution.x;
  float y = (gl_VertexID & 1) == 1 ? h + 1.5 : uBottoms[layer];
  vEdge = h;
  vColor = uColors[layer];
  gl_Position = vec4(vec2(x, y) / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const HILL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vEdge;
flat in vec3 vColor;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  // Distance below the edge in px, made perpendicular to it by the screen-space gradient.
  float d = vEdge - gl_FragCoord.y;
  float g = length(vec2(dFdx(d), dFdy(d)));
  outColor = vec4(vColor + dither8(gl_FragCoord.xy), clamp(d / max(g, 0.001) + 0.5, 0.0, 1.0));
}
`;

/** Valley mist: a soft horizontal band with slow, broad wisps, drawn over a viewport of its rows. */
const MIST_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uMist;
/** Band centre y (px), 1 / half-thickness (px), pattern phase (radians), 1 / height. */
uniform vec4 uBand;
uniform float uAlpha;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float t = (gl_FragCoord.y - uBand.x) * uBand.y;
  float body = max(1.0 - t * t, 0.0);
  body *= body;
  float x = gl_FragCoord.x * uBand.w;
  float wisp = 0.72 + 0.28 * sin(x * 5.0 + uBand.z) * sin(x * 2.3 + 2.0 * uBand.z + 1.3);
  outColor = vec4(uMist + dither8(gl_FragCoord.xy), uAlpha * body * wisp);
}
`;

/**
 * Balloons: one instance each, drawn in a tight outline. \`vLocal\` is in radius
 * units (the envelope's round top is the unit circle), y up.
 */
const BALLOON_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (px, y up), radius (px), opacity. */
layout(location = 1) in vec4 aPos;
/** Colour A, haze. */
layout(location = 2) in vec4 aA;
/** Colour B, burner glow. */
layout(location = 3) in vec4 aB;
/** Colour C, gores. */
layout(location = 4) in vec4 aC;
/** Spin (radians), colour count. */
layout(location = 5) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
/** Spin, colour count, radius (px), opacity. */
flat out vec4 vMisc;
void main() {
  // 1.5 px of margin outwards, for the anti-aliased edge.
  vec2 px = aPos.xy + aCorner * aPos.z + sign(aCorner) * 1.5;
  vLocal = (px - aPos.xy) / aPos.z;
  vA = aA;
  vB = aB;
  vC = aC;
  vMisc = vec4(aSpin, aPos.zw);
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

const BALLOON_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vMisc;
/** Unit vector towards the sun (x right, y up, z towards the viewer). */
uniform vec3 uLightDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uHaze;
uniform vec3 uFlame;
out vec4 outColor;
${DITHER_GLSL}
const float TAU = 6.2831853;
const float APEX = ${glslFloat(APEX_Y)};
const float SIN_B = ${glslFloat(CONE_SIN)};
const float COS_B = ${glslFloat(CONE_COS)};
const float TAN_B = ${glslFloat(CONE_SIN / CONE_COS)};
const float TANGENT_Y = ${glslFloat(TANGENT_Y)};
const float MOUTH_Y = ${glslFloat(MOUTH_Y)};
const float MOUTH_HALF = ${glslFloat(MOUTH_HALF)};
const float BASKET_TOP = ${glslFloat(BASKET_TOP)};
const float BASKET_BOTTOM = ${glslFloat(BASKET_BOTTOM)};
const float BASKET_HALF = ${glslFloat(BASKET_HALF)};

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 p = vLocal;
  float rpx = vMisc.z;
  float ax = abs(p.x);

  // Envelope: the unit circle merged with a cone whose sides are tangent to it,
  // cut off at the mouth. Both terms are distances (radius units) inside.
  float eCircle = 1.0 - length(p);
  float eCone = min(min((p.y - APEX) * SIN_B - ax * COS_B, p.y - MOUTH_Y), TANGENT_Y - p.y);
  float cover = clamp(max(eCircle, eCone) * rpx + 0.5, 0.0, 1.0);

  // Gores: the horizontal coordinate mapped round a cylinder of the row's half-width.
  bool upper = p.y >= TANGENT_Y;
  float w = upper ? sqrt(max(1.0 - p.y * p.y, 0.0)) : max((p.y - APEX) * TAN_B, 0.0);
  float s = clamp(p.x / max(w, 0.001), -1.0, 1.0);
  float c = sqrt(1.0 - s * s);
  float theta = asin(s);
  float g = (theta + vMisc.x) * vC.w / TAU;
  float gi = floor(g);
  float gf = g - gi;
  float n = vMisc.y;
  float idx = mod(gi, n);
  float nb = mod(gi + (gf < 0.5 ? -1.0 : 1.0) + n, n);
  vec3 fabric = idx < 0.5 ? vA.rgb : (idx < 1.5 ? vB.rgb : vC.rgb);
  vec3 other = nb < 0.5 ? vA.rgb : (nb < 1.5 ? vB.rgb : vC.rgb);
  vec3 average = n < 2.5 ? 0.5 * (vA.rgb + vB.rgb) : (vA.rgb + vB.rgb + vC.rgb) / 3.0;
  // Seams anti-aliased with the neighbouring gore; where gores crowd below a
  // pixel near the limb, fade to the average colour.
  float gw = max(fwidth(g), 0.0001);
  float seam = clamp(min(gf, 1.0 - gf) / gw + 0.5, 0.5, 1.0);
  fabric = mix(other, fabric, seam);
  float crowd = smoothstep(0.25, 0.8, gw);
  fabric = mix(fabric, average, crowd);
  // Each gore bulges a little between its seams.
  fabric *= mix(0.9 + 0.1 * sin(3.1415927 * gf), 0.95, crowd);

  // Sphere-like normal: the circle's on top, the cone's below.
  float h = upper ? w : COS_B;
  float ny = upper ? p.y : -SIN_B;
  vec3 normal = vec3(h * s, ny, h * c);
  float light = smoothstep(-0.4, 1.0, dot(normal, uLightDir));
  vec3 env = fabric * mix(uShade, uLit, light);
  // Burner: lights the fabric round the mouth from inside.
  float glow = vB.w;
  vec2 dm = p - vec2(0.0, MOUTH_Y + 0.1);
  env += uFlame * (glow * 0.6 * exp2(-2.5 * dot(dm, dm)));

  // Basket, and the lines from the mouth down to it.
  vec2 bq = vec2(ax - BASKET_HALF, max(BASKET_BOTTOM - p.y, p.y - BASKET_TOP));
  float basket = clamp(-max(bq.x, bq.y) * rpx + 0.5, 0.0, 1.0);
  vec3 basketColor = vec3(0.36, 0.24, 0.14) * mix(uShade, uLit, 0.65 + 0.35 * sign(p.x * uLightDir.x));
  vec2 q = vec2(ax, p.y);
  float dl = min(
    segDist(q, vec2(MOUTH_HALF * 0.92, MOUTH_Y), vec2(BASKET_HALF * 0.9, BASKET_TOP)),
    segDist(q, vec2(MOUTH_HALF * 0.3, MOUTH_Y), vec2(BASKET_HALF * 0.3, BASKET_TOP))
  ) * rpx;
  float lw = clamp(0.012 * rpx, 0.3, 1.2);
  float lines = clamp(lw + 0.5 - dl, 0.0, 1.0) * 0.8;

  // Premultiplied: lines, then the basket over them, then the envelope over both.
  vec4 col = vec4(basketColor * 0.6, 1.0) * lines;
  col = vec4(basketColor, 1.0) * basket + col * (1.0 - basket);
  col = vec4(env, 1.0) * cover + col * (1.0 - cover);
  // Atmospheric haze towards the horizon sky.
  col.rgb = mix(col.rgb, uHaze * col.a, vA.w);
  // The burner flame itself: a small additive light at the mouth.
  vec2 df = p - vec2(0.0, MOUTH_Y);
  col.rgb += uFlame * (glow * (1.0 - 0.5 * vA.w) * 0.7 * exp2(-40.0 * dot(df, df)));
  col.rgb += dither8(gl_FragCoord.xy) * col.a;
  outColor = col * vMisc.w;
}
`;

/**
 * Hot-air balloons drifting slowly across a hazy valley: a sky gradient with a
 * sun glow, three layers of rolling hills (from horizon-sim), optional valley
 * mist, and up to ten analytically shaded balloons, one instanced outline each.
 */
export const balloons = defineEffect(balloonsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => gl.deleteProgram(p));
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const hillProgram = program(HILL_VERTEX, HILL_FRAGMENT);
      const mistProgram = program(FULLSCREEN_VERTEX, MIST_FRAGMENT);
      const balloonProgram = program(BALLOON_VERTEX, BALLOON_FRAGMENT);
      const skyU = createUniforms(gl, skyProgram, [
        "uZenith",
        "uHorizon",
        "uGlow",
        "uSunColor",
        "uSun",
        "uSky",
      ]);
      const hillU = createUniforms(gl, hillProgram, [
        "uHeights",
        "uResolution",
        "uLayerBase",
        "uColors",
        "uBottoms",
      ]);
      const mistU = createUniforms(gl, mistProgram, ["uMist", "uBand", "uAlpha"]);
      const balloonU = createUniforms(gl, balloonProgram, [
        "uResolution",
        "uLightDir",
        "uLit",
        "uShade",
        "uHaze",
        "uFlame",
      ]);

      const triangle = scope.own(createFullscreenTriangle(gl));
      /** The hill strip has no attributes, but draws with a VAO of its own bound. */
      const hillVao = scope.add(gl.createVertexArray(), (v) => gl.deleteVertexArray(v));
      const hills = scope.own(createColumnTable(gl, HILL_COLUMNS, 1, { rows: HILL_ROWS }));
      const batch = scope.own(
        createSpriteBatch(gl, MAX_BALLOONS, [4, 4, 4, 4, 2], [BALLOON_STRIP]),
      );
      if (batch.stride !== BALLOON_FLOATS) throw new Error("balloons: instance layout mismatch");

      gl.useProgram(hillProgram);
      hillU.i1("uHeights", 0);
      gl.useProgram(balloonProgram);
      balloonU.v3("uFlame", FLAME);
      gl.useProgram(null);

      const hillMin = new Float64Array(HILL_ROWS);
      const hillMax = new Float64Array(HILL_ROWS);
      const hillInputs = createChangeKey(1);
      const layoutInputs = createChangeKey(3);
      const colors = new Float32Array(HILL_LAYERS * 3);
      const bottoms = new Float32Array(HILL_LAYERS);
      const rgb: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let field: Balloons | null = null;
      let fieldSeed = Number.NaN;
      /** Mist pattern phase, wrapped to 2π. */
      let mistPhase = 0;

      return {
        resize(v) {
          ({ width, height } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const light = lightFor(p.light);
          const seed = Math.floor(p.seed);

          // Balloons: rebuilt when the seed changes.
          if (field === null || seed !== fieldSeed) {
            field = createBalloons(seed, aspect);
            fieldSeed = seed;
          }
          stepBalloons(field, dt, aspect, p.drift, p.count);
          mistPhase = (mistPhase + MIST_RATE * dt) % TAU;

          // Hill profiles: rebuilt when the seed changes.
          hillInputs.set(0, seed);
          if (hillInputs.take()) {
            buildHills(hills.data, HILL_LAYERS, seed, HILL_SHAPE, hillMin, hillMax);
            gl.activeTexture(gl.TEXTURE0);
            hills.upload();
            layoutInputs.invalidate();
          }

          // Hill colours and strip bottoms: when the light or the height changes.
          gl.useProgram(hillProgram);
          layoutInputs.set(0, lightIndex(p.light));
          layoutInputs.set(1, height);
          layoutInputs.set(2, seed);
          if (layoutInputs.take()) {
            for (let l = 0; l < HILL_LAYERS; l++) {
              hillColor(rgb, light, l, HILL_LAYERS);
              colors.set(rgb, l * 3);
              bottoms[l] =
                l + 1 < HILL_LAYERS ? Math.floor(hillMin[l + 1] * height - STRIP_OVERLAP) : -1;
            }
            gl.uniform3fv(hillU.loc.uColors, colors);
            gl.uniform1fv(hillU.loc.uBottoms, bottoms);
          }

          // 1. Sky, over the rows the hills can leave uncovered.
          const skyBottom = clamp(Math.floor(hillMin[0] * height - STRIP_OVERLAP), 0, height);
          const horizonPx = BACK_BASE * height;
          gl.viewport(0, skyBottom, width, height - skyBottom);
          gl.useProgram(skyProgram);
          skyU.v3("uZenith", light.zenith);
          skyU.v3("uHorizon", light.horizon);
          skyU.v3("uGlow", light.glow);
          skyU.v3("uSunColor", light.sun);
          skyU.f4(
            "uSun",
            light.sunX * width,
            light.sunY * height,
            SUN_RADIUS * height,
            light.glowStrength,
          );
          skyU.f3("uSky", horizonPx, 1 / Math.max(1, height - horizonPx), 1 / height);
          triangle.draw();
          gl.viewport(0, 0, width, height);

          // 2. The back hill layers.
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(hillProgram);
          hillU.f2("uResolution", width, height);
          hillU.i1("uLayerBase", 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, hills.texture);
          gl.bindVertexArray(hillVao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, HILL_COLUMNS * 2, HILL_LAYERS - 1);
          gl.bindVertexArray(null);

          // 3. Mist lying in the valley behind the front hills.
          if (p.mist) {
            const centre = hillMin[HILL_LAYERS - 2] * height;
            const half = MIST_HALF * height;
            const y0 = clamp(Math.floor(centre - half), 0, height);
            const y1 = clamp(Math.ceil(centre + half), 0, height);
            if (y1 > y0) {
              gl.viewport(0, y0, width, y1 - y0);
              gl.useProgram(mistProgram);
              mistU.v3("uMist", light.mist);
              mistU.f4("uBand", centre, 1 / half, mistPhase, 1 / height);
              mistU.f1("uAlpha", MIST_ALPHA);
              triangle.draw();
              gl.viewport(0, 0, width, height);
            }
          }

          // 4. The front hill layer.
          gl.useProgram(hillProgram);
          hillU.i1("uLayerBase", HILL_LAYERS - 1);
          gl.bindVertexArray(hillVao);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, HILL_COLUMNS * 2, 1);
          gl.bindVertexArray(null);

          // 5. Balloons, farthest first, premultiplied.
          const n = writeBalloons(field, batch.data, paletteFor(p.palette), height, p.burners);
          if (n > 0) {
            batch.upload(n);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(balloonProgram);
            balloonU.f2("uResolution", width, height);
            balloonU.f3("uLightDir", light.dir[0], light.dir[1], light.dir[2]);
            balloonU.v3("uLit", light.lit);
            balloonU.v3("uShade", light.shade);
            balloonU.v3("uHaze", light.horizon);
            batch.draw(0, n);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
