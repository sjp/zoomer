import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
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
  BAND,
  createGroundLayout,
  createMeteorPose,
  createShower,
  createSkyFrame,
  fillHillTable,
  HILL_CHANNELS,
  HILL_COLUMNS,
  layoutGround,
  MAX_ACTIVE,
  MAX_TREES,
  meteorAt,
  REF_HEIGHT,
  setSkyFrame,
  skyPole,
  STAR_DENSITY,
  stepShower,
  TENT_H,
  TENT_HALF_W,
} from "./meteors-sim";
import { meteorsMeta } from "./meteors.meta";
import { PINE_GLSL } from "./pines";
import {
  createMilkyWayNoise,
  createStarDraw,
  createStarSprites,
  glslColor as C,
  HAZE_COLOR,
  HAZE_GAIN,
  milkyWayGlsl,
} from "./starfield";
import { seedSalt } from "./starfield-sim";
import { createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";

/** Most point stars; a 21:9 frame at the effect's density stays well under it. */
const MAX_STARS = 16000;
/** Frame margin for listing stars, reference px (covers the largest sprite). */
const STAR_MARGIN = 4;
/** Nested core segments per meteor (a stepped fade toward the tail), and streaks per meteor in all. */
const CORE_STEPS = 4;
const STREAKS_PER_METEOR = CORE_STEPS + 3;
/** Core and glow half-widths (reference px), and the glow's share of the core's brightness. */
const CORE_HALF_W = 0.75;
const GLOW_HALF_W = 2.6;
const GLOW_GAIN = 0.16;
/** Trail half-widths (reference px) at the end of the flight, how much they widen as it fades, and their gains. */
const TRAIL_INNER_W = 2;
const TRAIL_OUTER_W = 5;
const TRAIL_WIDEN = 1.4;
const TRAIL_INNER_GAIN = 0.55;
const TRAIL_OUTER_GAIN = 0.22;

/**
 * Sky, drawn once into the cached background: a deep blue-black gradient,
 * lighter toward the horizon, and the faint Milky Way (one noise fetch inside
 * the band), with dither baked in.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform float uScale;
/** Pole, reference px. */
uniform vec2 uPole;
uniform float uMilky;
out vec4 outColor;
${DITHER_GLSL}
${milkyWayGlsl(BAND)}
const vec3 TOP = ${C("#010208")};
const vec3 HORIZON = ${C("#0b1430")};
const vec3 AIRGLOW = ${C("#1a2a34", 0.45)};
const vec3 HAZE = ${C(HAZE_COLOR, HAZE_GAIN * 1.2)};
void main() {
  vec2 p = gl_FragCoord.xy / uScale;
  float yN = p.y * ${glslFloat(1 / REF_HEIGHT)};
  vec3 col = mix(HORIZON, TOP, smoothstep(0.05, 1.0, yN));
  col += AIRGLOW * exp2(-max(yN - 0.1, 0.0) * 8.0);
  if (uMilky > 0.0) col += HAZE * milkyWay(uNoise, p - uPole);
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Ground, drawn once over the sky inside a scissor: two hill silhouettes (one
 * table fetch, coverage from derivatives), and the trees or the tent. The cost
 * is paid only when the background is rebuilt. Premultiplied output.
 */
const GROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
in vec2 vUv;
uniform sampler2D uHills;
uniform float uScale;
/** Per tree: x, base y, height (reference px). */
uniform vec3 uTrees[${String(MAX_TREES)}];
uniform int uTreeCount;
/** Tent centre x, base y (reference px), on (0 or 1). */
uniform vec3 uTent;
out vec4 outColor;
${DITHER_GLSL}
${PINE_GLSL}
const vec3 FAR = ${C("#0c1222")};
const vec3 FAR_RIM = ${C("#1b2440")};
const vec3 NEAR = ${C("#040509")};
const vec3 TENT = ${C("#08080b")};
const vec3 TENT_GLOW = ${C("#ff9a50", 0.07)};
const vec3 DOOR = ${C("#ffb468", 0.32)};
const vec3 POOL = ${C("#ff9a50", 0.05)};

/** Coverage of a silhouette whose top is \`d\` device px above this pixel. */
float coverage(float d) {
  float g = length(vec2(dFdx(d), dFdy(d)));
  return clamp(d / max(g, 0.001) + 0.5, 0.0, 1.0);
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
  float s = vUv.x * ${glslFloat((HILL_COLUMNS - 1) / HILL_COLUMNS)} + ${glslFloat(0.5 / HILL_COLUMNS)};
  vec2 h = texture(uHills, vec2(s, 0.5)).rg;
  vec2 d = h * ${glslFloat(REF_HEIGHT)} * uScale - frag.y;
  float cNear = coverage(d.x);
  float cFar = coverage(d.y);
  // The far hill's crest catches a little skylight.
  vec3 col = mix(FAR, FAR_RIM, exp2(-max(d.y, 0.0) / uScale * 0.08)) * cFar;
  float a = cFar;
  vec3 nearCol = NEAR;
  if (uTent.z > 0.5) {
    vec2 g = (p - uTent.xy) / vec2(170.0, 40.0);
    nearCol += POOL * exp2(-dot(g, g));
  }
  col = mix(col, nearCol, cNear);
  a = mix(a, 1.0, cNear);

  for (int i = 0; i < ${String(MAX_TREES)}; i++) {
    if (i >= uTreeCount) break;
    vec3 t = uTrees[i];
    vec2 q = p - t.xy;
    if (abs(q.x) > t.z * 0.38 + 2.0 || q.y < -2.0 || q.y > t.z + 2.0) continue;
    // A spruce silhouette: drooping, ragged tiers, varied per tree.
    float r = float(hash32(uint(i) * 2654435761u + 977u) >> 8) * (1.0 / 16777216.0);
    float tiers = floor(mix(7.0, 10.99, r));
    float dTree = pineSpruce(vec2(q.x, q.y / t.z), t.z, tiers, r).x;
    float cTree = clamp(dTree * uScale + 0.5, 0.0, 1.0);
    col = mix(col, NEAR, cTree);
    a = mix(a, 1.0, cTree);
  }

  if (uTent.z > 0.5) {
    vec2 t = p - uTent.xy;
    if (abs(t.x) < ${glslFloat(TENT_HALF_W + 4)} && t.y > -4.0 && t.y < ${glslFloat(TENT_H + 4)}) {
      float td = triangleDist(t, ${glslFloat(TENT_HALF_W)}, ${glslFloat(TENT_H)});
      float cTent = clamp(0.5 - td * uScale, 0.0, 1.0);
      // A lantern inside: the fabric glows faintly, brightest low down, and the door is a lit slit.
      float doorW = 11.0 * (1.0 - t.y * ${glslFloat(1 / (TENT_H * 0.6))});
      float door = clamp((doorW - abs(t.x)) * uScale + 0.5, 0.0, 1.0) * step(0.0, doorW);
      vec3 tentCol = TENT + TENT_GLOW * (1.0 - t.y * ${glslFloat(0.8 / TENT_H)}) + DOOR * door;
      col = mix(col, tentCol, cTent);
      a = mix(a, 1.0, cTent);
    }
  }
  outColor = vec4(col + dither8(frag) * a, a);
}
`;

/** Per frame: the cached background, one fetch per pixel. */
const BLIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uBackground;
out vec4 outColor;
void main() {
  outColor = vec4(texelFetch(uBackground, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}
`;

const GROUND_INDEX: Record<string, number> = { hills: 0, trees: 1, tent: 2, none: 3 };

/**
 * A meteor shower over a still, starry sky and a dark hillside. The sky, stars
 * and ground are drawn once into a full-resolution background (rebuilt on
 * resize or when a look param changes) and blitted each frame; the meteors are
 * a few additive streaks on top, all heading away from the radiant.
 */
export const meteors = defineEffect(meteorsMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => {
          gl.deleteProgram(p);
        });
      const skyProgram = program(SKY_FRAGMENT);
      const su = createUniforms(gl, skyProgram, ["uNoise", "uScale", "uPole", "uMilky"]);
      const groundProgram = program(GROUND_FRAGMENT);
      const gu = createUniforms(gl, groundProgram, [
        "uHills",
        "uScale",
        "uTrees",
        "uTreeCount",
        "uTent",
      ]);
      const blitProgram = program(BLIT_FRAGMENT);
      const bu = createUniforms(gl, blitProgram, ["uBackground"]);
      const noiseTex = scope.add(createMilkyWayNoise(gl), (t) => {
        gl.deleteTexture(t);
      });
      const hills = scope.own(createColumnTable(gl, HILL_COLUMNS, HILL_CHANNELS));
      const stars = scope.own(createStarSprites(gl, MAX_STARS));
      const streaks = scope.own(createStreakRenderer(gl, MAX_ACTIVE * STREAKS_PER_METEOR));
      gl.useProgram(skyProgram);
      su.i1("uNoise", 0);
      gl.useProgram(groundProgram);
      gu.i1("uHills", 0);
      gl.useProgram(blitProgram);
      bu.i1("uBackground", 0);
      gl.useProgram(null);

      let background: RenderTarget | null = null;
      scope.defer(() => background?.dispose());

      const ground = createGroundLayout();
      const sky = createSkyFrame();
      const pose = createMeteorPose();
      const starDraw = createStarDraw();
      starDraw.rotation = 0;
      starDraw.twinkle = 0;
      starDraw.time = 0;
      const pole: [number, number] = [0, 0];
      const bgInputs = createChangeKey(5);
      let shower = createShower(0);
      let showerSeed = Number.NaN;

      let width = 1;
      let height = 1;
      let scale = 1;
      /** CPU-only time, unwrapped float64. */
      let time = 0;

      /** Streaks written this frame. */
      let n = 0;
      /** Writes a streak from a to b (reference px, y up) in colour (r, g, b) x k, `halfW` reference px. */
      const put = (
        ax: number,
        ay: number,
        bx: number,
        by: number,
        r: number,
        g: number,
        b: number,
        k: number,
        halfW: number,
      ) => {
        const d = streaks.data;
        const o = n++ * STREAK_FLOATS;
        d[o] = ax * scale;
        d[o + 1] = height - ay * scale;
        d[o + 2] = bx * scale;
        d[o + 3] = height - by * scale;
        d[o + 4] = r * k;
        d[o + 5] = g * k;
        d[o + 6] = b * k;
        d[o + 7] = halfW * scale;
      };

      /** Draws the sky, stars and ground into the background target. */
      const bake = (seed: number, groundId: string, milky: boolean) => {
        const target = background;
        if (!target) {
          return;
        }
        const refWidth = width / scale;
        skyPole(refWidth, pole);
        fillHillTable(hills.data, seed, refWidth);
        hills.upload();
        layoutGround(ground, hills.data, groundId, seed, refWidth);
        stars.build({
          salt: seedSalt(seed),
          density: STAR_DENSITY,
          pole,
          refWidth,
          refHeight: REF_HEIGHT,
          rotates: false,
          margin: STAR_MARGIN,
        });

        target.bind();
        gl.activeTexture(gl.TEXTURE0);
        gl.useProgram(skyProgram);
        gl.bindTexture(gl.TEXTURE_2D, noiseTex);
        su.f1("uScale", scale);
        su.f2("uPole", pole[0], pole[1]);
        su.f1("uMilky", milky ? 1 : 0);
        triangle.draw();

        starDraw.width = width;
        starDraw.height = height;
        starDraw.scale = scale;
        starDraw.pole = pole;
        stars.draw(starDraw);

        if (groundId !== "none") {
          gl.useProgram(groundProgram);
          gl.bindTexture(gl.TEXTURE_2D, hills.texture);
          gu.f1("uScale", scale);
          gl.uniform3fv(gu.loc.uTrees, ground.trees);
          gu.i1("uTreeCount", ground.treeCount);
          gu.f3("uTent", ground.tentX, ground.tentY, ground.tent ? 1 : 0);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, width, Math.min(height, Math.ceil((ground.top + 4) * scale)));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();
          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          if (!background || background.width !== width || background.height !== height) {
            background?.dispose();
            background = null;
            background = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
            if (!background) {
              throw new Error("Meteor Shower: RGBA8 render target unavailable");
            }
            bgInputs.invalidate();
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += Math.max(0, dt);
          const seed = Math.floor(p.seed);
          bgInputs.set(0, seed);
          bgInputs.set(1, width);
          bgInputs.set(2, height);
          bgInputs.set(3, GROUND_INDEX[p.ground] ?? 0);
          bgInputs.set(4, p.milkyWay ? 1 : 0);
          if (bgInputs.take()) {
            bake(seed, p.ground, p.milkyWay);
          }
          if (seed !== showerSeed) {
            shower = createShower(seed);
            showerSeed = seed;
          }

          // 1. The cached background.
          gl.activeTexture(gl.TEXTURE0);
          gl.useProgram(blitProgram);
          gl.bindTexture(gl.TEXTURE_2D, background ? background.texture : null);
          triangle.draw();

          // 2. Meteors and trails, additive.
          setSkyFrame(sky, width / scale, p.radiant, ground.top);
          stepShower(shower, time, p.rate, p.bright, sky);
          n = 0;
          for (let i = 0; i < shower.count; i++) {
            const m = shower.list[i];
            meteorAt(m, time, pose);
            if (pose.trail > 0) {
              const w = 1 + TRAIL_WIDEN * pose.spread;
              const k = pose.trail / w;
              put(
                m.x,
                m.y,
                pose.trailEndX,
                pose.trailEndY,
                m.r,
                m.g,
                m.b,
                k * TRAIL_INNER_GAIN,
                TRAIL_INNER_W * w,
              );
              put(
                m.x,
                m.y,
                pose.trailEndX,
                pose.trailEndY,
                m.r,
                m.g,
                m.b,
                k * TRAIL_OUTER_GAIN,
                TRAIL_OUTER_W * w,
              );
            }
            if (pose.core > 0) {
              // Nested segments from the head back: brightest at the head, fading toward the tail.
              const k = pose.core / CORE_STEPS;
              for (let j = 1; j <= CORE_STEPS; j++) {
                const f = j / CORE_STEPS;
                const tx = pose.headX + (pose.tailX - pose.headX) * f;
                const ty = pose.headY + (pose.tailY - pose.headY) * f;
                put(tx, ty, pose.headX, pose.headY, m.r, m.g, m.b, k, CORE_HALF_W);
              }
              const gx = pose.headX + (pose.tailX - pose.headX) * 0.5;
              const gy = pose.headY + (pose.tailY - pose.headY) * 0.5;
              put(
                gx,
                gy,
                pose.headX,
                pose.headY,
                m.r,
                m.g,
                m.b,
                pose.core * GLOW_GAIN,
                GLOW_HALF_W,
              );
            }
          }
          if (n > 0) {
            streaks.upload(n);
            streaks.draw(n, width, height);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
