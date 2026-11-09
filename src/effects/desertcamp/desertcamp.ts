import { createChangeKey } from "../change-key";
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
} from "../gl";
import {
  BAND,
  createCampLayout,
  createFireState,
  createMeteorPose,
  createMeteors,
  createSparks,
  DENSITY_MAX,
  DUNE_CHANNELS,
  DUNE_COLUMNS,
  DUNE_TOP,
  FACING_GAIN,
  FACING_RANGE,
  fillDuneTable,
  fireAt,
  layoutCamp,
  LIGHT_R,
  LIGHT_SQUASH,
  MAX_SPARKS,
  meteorAt,
  REF_HEIGHT,
  skyPole,
  sparkGlow,
  stepMeteors,
  stepSparks,
  TENT_H,
  TENT_HALF_W,
  TONGUE_L,
  TONGUE_W,
  TONGUE_X,
  TONGUES,
} from "./desertcamp-sim";
import { desertcampMeta, ROTATION_MAX } from "./desertcamp.meta";
import { createLowResTarget } from "../lowres";
import { clamp } from "../math";
import { createNoise } from "../noise";
import { createSpriteBatch, polygonStrip } from "../sprites";
import {
  createMilkyWayNoise,
  createStarDraw,
  createStarSprites,
  glslColor as C,
  HAZE_COLOR,
  HAZE_GAIN,
  milkyWayGlsl,
  TO_SKY_GLSL,
} from "../starfield";
import { advanceRotation, seedSalt } from "../starfield-sim";
import { createStreakRenderer, STREAK_FLOATS } from "../streaks";
import { defineEffect } from "../types";
import { createSettledValue } from "../rebuild";
import { COVERAGE_GLSL } from "../sdf-glsl";

/** Sky pass: about 3 reference px per texel. The sky is all soft haze and gradient. */
const SKY_TEXEL_REF = 3;
/** Seconds the width and the Variation slider must hold still before the scene is rebuilt. */
const INPUT_SETTLE = 0.3;
/** Most point stars; a 21:9 frame at full density stays under it. */
const MAX_STARS = 64000;
/** Frame margin for listing stars, reference px (covers the largest sprite). */
const STAR_MARGIN = 6;
/** The Milky Way here is a little stronger than Star Trails'. */
const HAZE_BOOST = 1.6;
/** Firelight halo in the air: radius (reference px), height above the fire base and strength. */
const HALO_R = 95;
const HALO_LIFT = 26;
const HALO_GAIN = 0.07;
/** Flame bounding box around the fire base, reference px. */
const FLAME_BOX = [-40, -14, 40, 70] as const;
/** Spark sprite radius (reference px) and colour. */
const SPARK_R = 1.7;
const SPARK_RGB = [1, 0.62, 0.3] as const;
/** Meteor core and glow half-widths (reference px) and the glow's brightness. */
const METEOR_CORE = 0.7;
const METEOR_GLOW = 2.6;
const METEOR_GLOW_GAIN = 0.22;
const METEOR_RGB = [0.92, 0.96, 1] as const;

/**
 * Sky at low resolution: a deep blue-black gradient lighter towards the horizon
 * (airglow), and the Milky Way haze (one fetch) with darker dust lanes along
 * its core (one more fetch), all in sky coordinates so they turn with the stars.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
/** Pole (reference px), rotation cosine and sine. */
uniform vec4 uPole;
uniform float uMilky;
out vec4 outColor;
${TO_SKY_GLSL}
${milkyWayGlsl(BAND)}
const vec3 TOP = ${C("#02030a")};
const vec3 HORIZON = ${C("#0a1124")};
const vec3 AIRGLOW = ${C("#1b2a2e", 0.55)};
const vec3 HAZE = ${C(HAZE_COLOR, HAZE_GAIN * HAZE_BOOST)};
const vec3 CORE = ${C("#e8d2b0", 0.07)};
void main() {
  vec2 p = gl_FragCoord.xy * uPxToRef;
  float yN = p.y * ${glslFloat(1 / REF_HEIGHT)};
  vec3 col = mix(HORIZON, TOP, smoothstep(0.15, 1.0, yN));
  col += AIRGLOW * exp2(-max(yN - 0.22, 0.0) * 9.0);
  if (uMilky > 0.0) {
    vec2 q = toSky(p - uPole.xy, uPole.zw);
    float h = milkyWay(uNoise, q);
    if (h > 0.0) {
      float across = milkyWayAcross(q);
      float lanes = textureLod(uNoise, q * ${glslFloat(1 / 310)} + vec2(0.31, 0.77), 0.0).g;
      float lane = exp2(-(across + 24.0) * (across + 24.0) * ${glslFloat(1 / (60 * 60))})
        * smoothstep(0.35, 0.7, lanes);
      float core = exp2(-across * across * ${glslFloat(1 / (110 * 110))});
      col += (HAZE + CORE * core) * (h * (1.0 - 0.8 * lane) * uMilky);
    }
  }
  outColor = vec4(col, 1.0);
}
`;

/**
 * Land at full resolution, inside a scissor over the bottom of the frame: three
 * dune silhouettes (one table fetch, coverage from derivatives), firelight on
 * the near dune with distance falloff and a slope term, the tent, and the fire
 * itself (three flame tongues, the embers and a soft halo in the air, only
 * inside a small box). Premultiplied output over the sky.
 */
const LAND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
in vec2 vUv;
uniform sampler2D uDunes;
/** Device px per reference px. */
uniform float uScale;
/** Fire base x, y (reference px), light (0 with no fire), on (0 or 1). */
uniform vec4 uFire;
/** Per tongue: sway (radians, as a shear), stretch, brightness. */
uniform vec3 uTongue[${String(TONGUES)}];
/** Tent centre x, base y (reference px), on, the fire's side (-1 left, 1 right). */
uniform vec4 uTent;
out vec4 outColor;
${DITHER_GLSL}
const vec3 FAR = ${C("#1a1f30")};
const vec3 MID = ${C("#0e111c")};
const vec3 NEAR = ${C("#06070b")};
const vec3 SAND_LIT = ${C("#ff9a4a", 0.42)};
const vec3 TENT_DARK = ${C("#08080a")};
const vec3 TENT_LIT = ${C("#ffa860", 0.5)};
const vec3 EMBER = ${C("#ff5a1c", 0.9)};
const vec3 HALO = ${C("#ff8a3a", HALO_GAIN)};
const vec3 FLAME_RED = ${C("#c8320c")};
const vec3 FLAME_ORANGE = ${C("#ff8a1e")};
const vec3 FLAME_YELLOW = ${C("#ffd060")};
const vec3 FLAME_WHITE = ${C("#fff4d8")};
const float TX[${String(TONGUES)}] = float[](${TONGUE_X.map((v) => glslFloat(v)).join(", ")});
const float TL[${String(TONGUES)}] = float[](${TONGUE_L.map((v) => glslFloat(v)).join(", ")});
const float TW[${String(TONGUES)}] = float[](${TONGUE_W.map((v) => glslFloat(v)).join(", ")});

/** Coverage of a silhouette whose top is \`d\` device px above this pixel. */
${COVERAGE_GLSL}

float falloff(vec2 e) {
  float q = 1.0 + dot(e, e);
  return 1.0 / (q * q);
}

/** Isosceles triangle (apex up at height h, base half-width w): signed distance, from Inigo Quilez. */
float triangleDist(vec2 p, float w, float h) {
  vec2 q = vec2(w, -h);
  p.x = abs(p.x);
  p.y -= h;
  vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
  vec2 b = p - q * vec2(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  float s = -sign(q.y);
  vec2 d = min(vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)), vec2(dot(b, b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = frag / uScale;
  float s = vUv.x * ${glslFloat((DUNE_COLUMNS - 1) / DUNE_COLUMNS)} + ${glslFloat(0.5 / DUNE_COLUMNS)};
  vec4 h = texture(uDunes, vec2(s, 0.5));
  // Device px from each crest line down to this pixel (positive inside the dune).
  vec3 d = h.xyz * ${glslFloat(REF_HEIGHT)} * uScale - frag.y;
  float cNear = coverage(d.x);
  float cMid = coverage(d.y);
  float cFar = coverage(d.z);
  vec3 depth = max(d, 0.0) / uScale;

  // Far dunes catch a little starlight along their crests; the near one is dark.
  vec3 col = FAR * (0.7 + 0.3 * exp2(-depth.z * 0.05)) * cFar;
  float a = cFar;
  col = mix(col, MID * (0.75 + 0.25 * exp2(-depth.y * 0.06)), cMid);
  a = mix(a, 1.0, cMid);

  vec2 f = p - uFire.xy;
  vec3 nearCol = NEAR;
  if (uFire.z > 0.0) {
    float facing = clamp(1.0 + ${glslFloat(FACING_GAIN)} * h.w * sign(f.x), ${glslFloat(FACING_RANGE[0])}, ${glslFloat(FACING_RANGE[1])});
    nearCol += SAND_LIT * (uFire.z * facing * falloff(vec2(f.x, f.y * ${glslFloat(LIGHT_SQUASH)}) * ${glslFloat(1 / LIGHT_R)}));
  }
  col = mix(col, nearCol, cNear);
  a = mix(a, 1.0, cNear);

  if (uTent.z > 0.5) {
    vec2 t = p - uTent.xy;
    if (abs(t.x) < ${glslFloat(TENT_HALF_W + 4)} && t.y > -4.0 && t.y < ${glslFloat(TENT_H + 4)}) {
      float td = triangleDist(t, ${glslFloat(TENT_HALF_W)}, ${glslFloat(TENT_H)});
      float cTent = clamp(0.5 - td * uScale, 0.0, 1.0);
      // The half facing the fire is lit; the door is a dark slit.
      float facing = t.x * uTent.w < 0.0 ? 1.0 : 0.3;
      float door = (1.0 - smoothstep(-1.0, 1.0, abs(t.x) - 14.0 * (1.0 - t.y * ${glslFloat(1 / (TENT_H * 0.55))})))
        * step(t.y, ${glslFloat(TENT_H * 0.55)});
      vec3 tentCol = TENT_DARK + TENT_LIT * (uFire.z * facing * (1.0 - 0.85 * door) * falloff(f * ${glslFloat(1 / (LIGHT_R * 1.2))}));
      col = mix(col, tentCol, cTent);
      a = mix(a, 1.0, cTent);
    }
  }

  if (uFire.w > 0.5) {
    vec2 g = f - vec2(0.0, ${glslFloat(HALO_LIFT)});
    col += HALO * (uFire.z * exp2(-dot(g, g) * ${glslFloat(1 / (HALO_R * HALO_R))}));
    if (f.x > ${glslFloat(FLAME_BOX[0])} && f.x < ${glslFloat(FLAME_BOX[2])} && f.y > ${glslFloat(FLAME_BOX[1])} && f.y < ${glslFloat(FLAME_BOX[3])}) {
      float heat = 0.0;
      for (int i = 0; i < ${String(TONGUES)}; i++) {
        vec3 tg = uTongue[i];
        float t = f.y / (TL[i] * tg.y);
        if (t <= 0.0 || t >= 1.0) continue;
        float x = f.x - TX[i] - tg.x * f.y;
        float w = TW[i] * 2.0 * sqrt(t) * pow(1.0 - t, 0.7);
        heat += (1.0 - smoothstep(0.2 * w, w, abs(x))) * (1.15 - t) * tg.z;
      }
      vec3 fc = mix(FLAME_RED, FLAME_ORANGE, smoothstep(0.0, 0.5, heat));
      fc = mix(fc, FLAME_YELLOW, smoothstep(0.5, 1.0, heat));
      fc = mix(fc, FLAME_WHITE, smoothstep(1.0, 1.6, heat));
      col += fc * min(heat * 1.5, 1.0);
      vec2 e = (f - vec2(0.0, 2.0)) / vec2(22.0, 6.0);
      col += EMBER * (uFire.z * (1.0 - smoothstep(0.4, 1.0, length(e))));
    }
  }
  outColor = vec4(col + dither8(frag) * a, a);
}
`;

/** Sparks: soft additive dots in device px. */
const SPARK_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y up), radius, unused. */
layout(location = 1) in vec4 aSprite;
/** Colour times brightness, unused. */
layout(location = 2) in vec4 aColor;
uniform vec2 uInvRes;
out vec2 vLocal;
flat out vec3 vColor;
void main() {
  vLocal = aCorner;
  vColor = aColor.rgb;
  gl_Position = vec4((aSprite.xy + aCorner * aSprite.z) * uInvRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SPARK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float f = max(0.0, 1.0 - dot(vLocal, vLocal));
  outColor = vec4(vColor * (f * f), 0.0);
}
`;

/**
 * A clear desert night: dark dunes low in the frame, a deep sky of stars and
 * the Milky Way turning very slowly about a pole above the frame, and a small
 * campfire at one edge lighting the nearest dune, with an optional tent, rising
 * sparks and the odd faint meteor.
 */
export const desertcamp = defineEffect(desertcampMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const sky = scope.own(createLowResTarget(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const su = createUniforms(gl, skyProgram, ["uNoise", "uPxToRef", "uPole", "uMilky"]);
      const landProgram = program(FULLSCREEN_VERTEX, LAND_FRAGMENT);
      const lu = createUniforms(gl, landProgram, ["uDunes", "uScale", "uFire", "uTongue", "uTent"]);
      const sparkProgram = program(SPARK_VERTEX, SPARK_FRAGMENT);
      const pu = createUniforms(gl, sparkProgram, ["uInvRes"]);
      const noiseTex = scope.add(createMilkyWayNoise(gl), (t) => {
        gl.deleteTexture(t);
      });
      const dunes = scope.own(createColumnTable(gl, DUNE_COLUMNS, DUNE_CHANNELS));
      const stars = scope.own(createStarSprites(gl, MAX_STARS));
      const sparkBatch = scope.own(
        createSpriteBatch(gl, MAX_SPARKS, [4, 4], [polygonStrip(6, Math.PI / 6)]),
      );
      const streaks = scope.own(createStreakRenderer(gl, 2));
      gl.useProgram(skyProgram);
      su.i1("uNoise", 0);
      gl.useProgram(landProgram);
      lu.i1("uDunes", 0);
      gl.useProgram(null);

      const noise = createNoise(0xf12e);
      const fire = createFireState();
      const camp = createCampLayout();
      const pose = createMeteorPose();
      const starDraw = createStarDraw();
      const pole: [number, number] = [0, 0];
      const tongues = new Float32Array(TONGUES * 3);
      const sceneInputs = createChangeKey(3);
      const starInputs = createChangeKey(3);
      let sparks = createSparks(0);
      let meteors = createMeteors(0);
      let simSeed = Number.NaN;
      const settledWidth = createSettledValue<number>(INPUT_SETTLE);
      const settledSeed = createSettledValue<number>(INPUT_SETTLE);

      let width = 1;
      let height = 1;
      let scale = 1;
      /** CPU-only time and sky rotation, unwrapped float64. */
      let time = 0;
      let rot = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
          sky.resize(width, height, Math.max(1, SKY_TEXEL_REF * scale));
          gl.useProgram(skyProgram);
          su.f2("uPxToRef", sky.fullWidth / sky.width / scale, sky.fullHeight / sky.height / scale);
          gl.useProgram(sparkProgram);
          pu.f2("uInvRes", 1 / width, 1 / height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, dt);
          time += step;
          rot = advanceRotation(rot, step, clamp(p.rotation, 0, ROTATION_MAX));
          const refWidth = width / scale;
          // The dune table, camp layout and stars follow the width and seed once they
          // settle, so dragging the window or the slider rebuilds them once, not every
          // frame; until then the scene stretches with the canvas.
          const sceneWidth = settledWidth.update(refWidth, step);
          const seed = settledSeed.update(Math.floor(p.seed), step);
          skyPole(sceneWidth, pole);

          gl.activeTexture(gl.TEXTURE0);
          sceneInputs.set(0, seed);
          sceneInputs.set(1, sceneWidth);
          sceneInputs.set(2, p.fire === "right" ? 1 : p.fire === "left" ? 0 : 2);
          if (sceneInputs.take()) {
            fillDuneTable(dunes.data, seed, sceneWidth);
            dunes.upload();
            layoutCamp(camp, dunes.data, p.fire, sceneWidth);
          }
          starInputs.set(0, seed);
          starInputs.set(1, sceneWidth);
          starInputs.set(2, p.stars);
          if (starInputs.take()) {
            stars.build({
              salt: seedSalt(seed),
              density: clamp(p.stars, 0, 1) * DENSITY_MAX,
              pole,
              refWidth: sceneWidth,
              refHeight: REF_HEIGHT,
              rotates: true,
              margin: STAR_MARGIN,
            });
          }
          if (seed !== simSeed) {
            sparks = createSparks(seed);
            meteors = createMeteors(seed);
            // Start the schedule from now, so a new seed doesn't release a burst.
            meteors.next += time;
            simSeed = seed;
          }

          // 1. Sky, low resolution, upscaled with dither.
          sky.bind();
          gl.useProgram(skyProgram);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          su.f4("uPole", pole[0], pole[1], Math.cos(rot), Math.sin(rot));
          su.f1("uMilky", clamp(p.milkyWay, 0, 1));
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          sky.blit();

          // 2. Stars, additive at full resolution.
          starDraw.width = width;
          starDraw.height = height;
          starDraw.scale = scale;
          starDraw.pole = pole;
          starDraw.rotation = rot;
          starDraw.time = time;
          stars.draw(starDraw);

          // 3. The odd meteor, behind the dunes.
          stepMeteors(meteors, time, p.meteors, refWidth);
          meteorAt(meteors.current, time, pose);
          if (pose.bright > 0) {
            const d = streaks.data;
            const hx = pose.headX * scale;
            const hy = height - pose.headY * scale;
            const tx = pose.tailX * scale;
            const ty = height - pose.tailY * scale;
            for (let k = 0; k < 2; k++) {
              const o = k * STREAK_FLOATS;
              const b = k === 0 ? pose.bright * METEOR_GLOW_GAIN : pose.bright;
              d[o] = tx;
              d[o + 1] = ty;
              d[o + 2] = hx;
              d[o + 3] = hy;
              d[o + 4] = METEOR_RGB[0] * b;
              d[o + 5] = METEOR_RGB[1] * b;
              d[o + 6] = METEOR_RGB[2] * b;
              d[o + 7] = (k === 0 ? METEOR_GLOW : METEOR_CORE) * scale;
            }
            streaks.upload(2);
            streaks.draw(2, width, height);
            gl.disable(gl.BLEND);
          }

          // 4. Land, fire and tent over the bottom of the frame.
          const hasFire = camp.fire;
          fireAt(noise, time, fire);
          const light = hasFire ? fire.light : 0;
          const m = fire.motion;
          for (let i = 0; i < TONGUES; i++) {
            tongues[i * 3] = Math.tan(m.sway[i]);
            tongues[i * 3 + 1] = m.stretch[i];
            tongues[i * 3 + 2] = m.bright[i];
          }
          let top = DUNE_TOP * REF_HEIGHT;
          if (hasFire) {
            top = Math.max(top, camp.fireY + HALO_LIFT + 2.5 * HALO_R);
          }
          if (p.tent) {
            top = Math.max(top, camp.tentY + TENT_H);
          }
          gl.useProgram(landProgram);
          gl.bindTexture(gl.TEXTURE_2D, dunes.texture);
          lu.f1("uScale", scale);
          lu.f4("uFire", camp.fireX, camp.fireY, light, hasFire ? 1 : 0);
          gl.uniform3fv(lu.loc.uTongue, tongues);
          lu.f4("uTent", camp.tentX, camp.tentY, p.tent ? 1 : 0, camp.side);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, width, Math.min(height, Math.ceil((top + 4) * scale)));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);

          // 5. Sparks, additive.
          stepSparks(sparks, step, hasFire && p.sparks, camp.fireX, camp.fireY, fire.lean);
          if (sparks.count > 0) {
            const d = sparkBatch.data;
            const r = SPARK_R * scale + 0.5;
            for (let i = 0; i < sparks.count; i++) {
              const g = sparkGlow(sparks, i);
              const o = i * 8;
              d[o] = sparks.x[i] * scale;
              d[o + 1] = sparks.y[i] * scale;
              d[o + 2] = r;
              d[o + 3] = 0;
              d[o + 4] = SPARK_RGB[0] * g;
              d[o + 5] = SPARK_RGB[1] * g;
              d[o + 6] = SPARK_RGB[2] * g;
              d[o + 7] = 0;
            }
            gl.useProgram(sparkProgram);
            gl.blendFunc(gl.ONE, gl.ONE);
            sparkBatch.upload(sparks.count);
            sparkBatch.draw(0, sparks.count);
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
