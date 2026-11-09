import { BOOKSHELF_GLSL, createBookshelfTexture, shelfBlurLod, shelfSideWidth } from "../bookshelf";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { wrap } from "../math";
import {
  createLayout,
  drinkFor,
  HANDLE_DX,
  HANDLE_RX,
  HANDLE_RY,
  HANDLE_TH,
  HANDLE_Y,
  LIQUID_DROP,
  MUG_H,
  MUG_K,
  MUG_R,
  MUG_WALL,
  mugDraft,
  mugLayout,
  roomFor,
  SHADOW_DX,
  SHADOW_RX,
  SHADOW_RY,
  SHADOW_SOFT,
  SHELF_PALETTE,
  SHELF_SEED,
  STEAM_HALF_WIDTH,
  STEAM_HEIGHT_DECAY,
  STEAM_RADIUS,
  steamEmitter,
  type SteamEmitter,
  steamFlow,
  steamGrid,
  steamRegion,
  TABLE_Y,
  WISP_K,
  WISP_SPEED,
} from "./mug-sim";
import { mugMeta } from "./mug.meta";
import { createSmokeField } from "../smoke/smoke-field";
import { type Flow, simSteps, WAVE_COUNT, wavePhases } from "../smoke/smoke-sim";
import { defineEffect } from "../types";
import type { StepClock } from "../step-clock";
import { createChangeKey } from "../change-key";

/** Room pass: about 4 reference px per texel. The room is all out of focus. */
const ROOM_TEXEL_REF = 4;
/** Shelf blur (0..1, see `shelfBlurLod`). */
const SHELF_BLUR = 0.8;
/** Steam density to opacity: alpha = 1 - exp(-STEAM_OPACITY * density). */
const STEAM_OPACITY = 1.8;
/** Lit-edge gain per unit of density drop towards the light, and the fetch offset in cells. */
const LIT_GAIN = 6;
const LIT_CELLS = 1.5;
/** Direction towards the key light (outer side, above, in front), before normalising. */
const LIGHT = [0.55, 0.5, 0.67] as const;

const g = glslFloat;
const vec3Of = (v: readonly number[]) => `vec3(${v.map((x) => g(x)).join(", ")})`;
const norm = (v: readonly number[]) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const LDIR = norm(LIGHT);
const HALF = norm([LDIR[0], LDIR[1], LDIR[2] + 1]);

/**
 * The room at low resolution: a warm wall with a soft light pool on the outer
 * side, or a bright blurred window there, or the Library Window bookcases at both edges;
 * then the table, its far edge behind the mug, and a vignette. Static, so it
 * only re-renders when the room, position or size changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uShelf;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** +1 if the mug (and the light) is on the right, -1 left. */
uniform float uSide;
/** 0: warm wall, 1: window, 2: shelves. */
uniform int uKind;
uniform vec3 uWall;
uniform vec3 uTable;
uniform vec3 uLight;
/** Bookcase width (height units), mip level and edge softness. */
uniform vec3 uShelfGeom;
out vec4 outColor;
${BOOKSHELF_GLSL}
float box(vec2 p, vec2 lo, vec2 hi, float soft) {
  vec2 a = smoothstep(lo - soft, lo + soft, p) * (1.0 - smoothstep(hi - soft, hi + soft, p));
  return a.x * a.y;
}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  // x measured from the outer edge, where the light is.
  vec2 o = vec2(uSide > 0.0 ? uFrame.x - p.x : p.x, p.y);
  vec2 l = (o - vec2(0.25, 0.78)) * vec2(1.6, 1.3);
  float pool = 1.0 / (1.0 + 2.5 * dot(l, l));
  vec3 wall = uWall * (0.35 + 0.75 * pool) * (0.8 + 0.2 * smoothstep(1.0, 0.3, p.y));
  if (uKind == 1) {
    // A window on the outer side, glowing, with blurred glazing bars.
    vec2 w = (o - vec2(0.38, 0.66)) * vec2(1.4, 1.2);
    wall = uWall * (0.3 + 0.9 / (1.0 + 3.0 * dot(w, w)));
    float win = box(o, vec2(0.1, 0.34), vec2(0.66, 0.97), 0.045);
    float bars = max(1.0 - smoothstep(0.006, 0.03, abs(o.x - 0.38)),
      1.0 - smoothstep(0.006, 0.03, abs(o.y - 0.66)));
    vec3 sky = uLight * mix(1.05, 0.8, clamp((o.y - 0.34) * 1.6, 0.0, 1.0));
    wall = mix(wall, sky * max(1.0 - 0.45 * bars, 0.1), win);
  } else if (uKind == 2) {
    vec4 shelf = bookshelf(uShelf, p, uFrame, uShelfGeom.x, uShelfGeom.y, uShelfGeom.z);
    wall = mix(wall, shelf.rgb * (0.45 + 0.8 * pool), shelf.a);
  }
  // The table: brighter towards its far edge and under the light.
  float onTable = 1.0 - smoothstep(${g(TABLE_Y - 0.006)}, ${g(TABLE_Y + 0.006)}, p.y);
  vec2 t = (o - vec2(0.3, ${g(TABLE_Y)})) * vec2(1.2, 3.0);
  vec3 table = uTable * (0.45 + 0.35 * p.y * ${g(1 / TABLE_Y)} + 0.5 / (1.0 + 3.0 * dot(t, t)));
  table += uLight * 0.05 * smoothstep(${g(TABLE_Y - 0.02)}, ${g(TABLE_Y - 0.004)}, p.y);
  vec3 col = mix(wall, table, onTable);
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.4 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The mug at full resolution inside its box, premultiplied over the room: the
 * soft shadow on the table, the handle (an elliptical torus seen side-on), the
 * body (a cylinder with elliptical ends), the rim, the inner wall and the
 * liquid with the room light reflected in it. Analytic shapes with coverage
 * antialiasing; local x is mirrored so the handle and the light are always on
 * the outer side (+x).
 */
const MUG_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** One device px in height units. */
uniform float uPx;
/** Mug centre x, base y (height units), and side (+1: outer side is right). */
uniform vec3 uMug;
uniform vec3 uGlaze;
uniform vec3 uDrink;
uniform vec3 uLight;
/** Ambient level and the drink's shine. */
uniform vec2 uAmbShine;
out vec4 outColor;
${DITHER_GLSL}
const float R = ${g(MUG_R)};
const float H = ${g(MUG_H)};
const float K = ${g(MUG_K)};
const vec3 LDIR = ${vec3Of(LDIR)};
const vec3 HALF = ${vec3Of(HALF)};
float cov(float sdf) { return clamp(0.5 - sdf / uPx, 0.0, 1.0); }
/** Approximate signed distance to an ellipse of radii r. */
float sdEllipse(vec2 q, vec2 r) {
  float k0 = length(q / r);
  float k1 = max(length(q / (r * r)), 1e-6);
  return k0 * (k0 - 1.0) / k1;
}
vec3 glaze(vec3 n, float occ) {
  float diff = max(dot(n, LDIR), 0.0);
  float nh = max(dot(n, HALF), 0.0);
  float spec = pow(nh, 80.0) * 0.9 + pow(nh, 10.0) * 0.1;
  return uGlaze * (uAmbShine.x * occ + 0.9 * diff * uLight) + uLight * spec * occ;
}
void main() {
  vec2 q = gl_FragCoord.xy * uPx - uMug.xy;
  q.x *= uMug.z;

  // Shadow: a soft pool thrown inwards plus a tight contact shadow.
  float soft = 1.0 - smoothstep(${g(-SHADOW_SOFT)}, ${g(SHADOW_SOFT)},
    sdEllipse(q - vec2(${g(SHADOW_DX)}, 0.0), vec2(${g(SHADOW_RX)}, ${g(SHADOW_RY)})));
  float contact = 1.0 - smoothstep(0.0, 0.012, sdEllipse(q, vec2(R, R * K)));
  float a = min(0.4 * soft + 0.35 * contact, 0.75);
  vec3 col = vec3(0.0);

  // Handle.
  vec2 hq = q - vec2(R + ${g(HANDLE_DX)}, ${g(HANDLE_Y)});
  vec2 hr = vec2(${g(HANDLE_RX)}, ${g(HANDLE_RY)});
  float he = sdEllipse(hq, hr);
  float hc = cov(abs(he) - ${g(HANDLE_TH)});
  if (hc > 0.0) {
    float across = clamp(he * ${g(1 / HANDLE_TH)}, -1.0, 1.0);
    vec2 radial = normalize(hq / (hr * hr) + vec2(0.0, 1e-6));
    vec3 n = normalize(vec3(radial * across, sqrt(1.0 - across * across)));
    col = glaze(n, 0.85) * hc + col * (1.0 - hc);
    a = hc + a * (1.0 - hc);
  }

  // Body silhouette: the side strip between the ends, plus both end ellipses.
  float top = sdEllipse(q - vec2(0.0, H), vec2(R, R * K));
  float body = min(max(abs(q.x) - R, max(-q.y, q.y - H)), min(sdEllipse(q, vec2(R, R * K)), top));
  float bc = cov(body);
  if (bc > 0.0) {
    float nx = clamp(q.x / R, -1.0, 1.0);
    // Darker near the table, which blocks the light from below.
    float occ = 0.55 + 0.45 * smoothstep(-0.02, 0.07, q.y);
    vec3 c = glaze(vec3(nx, 0.0, sqrt(1.0 - nx * nx)), occ);
    // The rim's flat top faces up.
    c = mix(c, glaze(normalize(vec3(0.5 * nx, 0.8, 0.45)), 1.0), cov(top));
    // The inner wall, in shade, lighter towards the rim.
    float rin = R - ${g(MUG_WALL)};
    float inner = sdEllipse(q - vec2(0.0, H), vec2(rin, rin * K));
    float ic = cov(inner);
    float up = clamp((q.y - H + ${g(LIQUID_DROP)}) / (rin * K + ${g(LIQUID_DROP)}), 0.0, 1.0);
    c = mix(c, uGlaze * (uAmbShine.x * (0.35 + 0.4 * up) + 0.25 * up * uLight), ic);
    // The liquid, seen through the opening, with the light's reflection.
    float rl = rin - 0.001;
    vec2 lq = q - vec2(0.0, H - ${g(LIQUID_DROP)});
    vec2 u = lq / vec2(rl, rl * K);
    float lc = min(cov(sdEllipse(lq, vec2(rl, rl * K))), ic);
    vec3 drink = uDrink * (0.55 + 0.6 * uAmbShine.x) * (1.0 - 0.35 * dot(u, u));
    vec2 hu = (u - vec2(0.35, 0.3)) / vec2(0.35, 0.28);
    drink += uLight * uAmbShine.y * (0.3 * exp(-dot(hu, hu)) + 0.06 * smoothstep(0.7, 1.0, dot(u, u)));
    c = mix(c, drink, lc);
    col = c * bc + col * (1.0 - bc);
    a = bc + a * (1.0 - bc);
  }
  // Same dither pattern as the room's blit, weighted so the blend keeps its sum.
  outColor = vec4(col + dither8(gl_FragCoord.xy) * a, a);
}
`;

/**
 * The steam at full resolution inside its box, premultiplied over the room
 * and mug: density to alpha with a lit edge towards the light (two bilinear
 * fetches), faded in just above the rim, out towards the top and the sides.
 */
const STEAM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uField;
uniform float uPx;
/** Steam box: x0, y0 (height units), 1 / width, 1 / height. */
uniform vec4 uBox;
/** uv offset of the lit-edge fetch, towards the light. */
uniform vec2 uLitStep;
uniform vec3 uLight;
uniform float uAmbient;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 uv = (gl_FragCoord.xy * uPx - uBox.xy) * uBox.zw;
  float d = texture(uField, uv).r;
  float toLight = texture(uField, uv + uLitStep).r;
  float fade = smoothstep(0.02, 0.12, uv.y) * (1.0 - smoothstep(0.45, 1.0, uv.y))
    * smoothstep(0.0, 0.12, uv.x) * smoothstep(0.0, 0.12, 1.0 - uv.x);
  float alpha = (1.0 - exp(-${g(STEAM_OPACITY)} * d)) * fade;
  float lit = clamp((d - toLight) * ${g(LIT_GAIN)}, 0.0, 1.0);
  // Mostly the light's colour, paled towards white.
  vec3 c = (0.6 * uLight + 0.4) * (uAmbient + 0.35 + 0.5 * lit);
  outColor = vec4((c + dither8(gl_FragCoord.xy)) * alpha, alpha);
}
`;

/**
 * A mug on a table in a bottom corner, with steam curling up from it into a
 * soft, out-of-focus room.
 *
 * Passes: the steam simulation (the smoke field from smoke-field.ts on a fixed
 * ~130 x 140 grid over a box above the mug, at most four 1/60 s steps a
 * frame); the room at 1/4 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; the mug in a scissored full-resolution box;
 * then the steam composite in its scissored box.
 */
export const mug = defineEffect(mugMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const field = createSmokeField(gl, scope, "mug");
      const adv = field.uniforms;
      const shelves = createBookshelfTexture(gl, scope);
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);

      const roomProgram = program(ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uShelf",
        "uPxToH",
        "uFrame",
        "uSide",
        "uKind",
        "uWall",
        "uTable",
        "uLight",
        "uShelfGeom",
      ]);
      const mugProgram = program(MUG_FRAGMENT);
      const mu = createUniforms(gl, mugProgram, [
        "uPx",
        "uMug",
        "uGlaze",
        "uDrink",
        "uLight",
        "uAmbShine",
      ]);
      const steamProgram = program(STEAM_FRAGMENT);
      const su = createUniforms(gl, steamProgram, [
        "uField",
        "uPx",
        "uBox",
        "uLitStep",
        "uLight",
        "uAmbient",
      ]);
      gl.useProgram(roomProgram);
      ru.i1("uShelf", 0);
      gl.useProgram(steamProgram);
      su.i1("uField", 0);
      gl.useProgram(null);

      const layout = createLayout();
      const region = new Float64Array(4);
      const grid = new Int32Array(2);
      const phases = new Float32Array(WAVE_COUNT);
      const flow: Flow = steamFlow({ rise: 0, draft: 0, curl: 0, onset0: 0, onset1: 1 });
      const emitter: SteamEmitter = { strength: 0, life: 1, wisp: 0 };
      const clock: StepClock = { acc: 0 };

      let width = 1;
      let height = 1;
      /** Seconds since create, unwrapped (float64); only wrapped phases reach the GPU. */
      let time = 0;
      let shelvesBaked = false;
      /** The inputs the room target was drawn from. */
      const roomKey = createChangeKey(2);

      /** Scissors to a box given in height units (x0, y0, x1, y1). */
      const scissor = (b: readonly number[]) => {
        const x0 = Math.max(0, Math.floor(b[0] * height));
        const y0 = Math.max(0, Math.floor(b[1] * height));
        const x1 = Math.min(width, Math.ceil(b[2] * height));
        const y1 = Math.min(height, Math.ceil(b[3] * height));
        gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          const scale = v.scale > 0 ? v.scale : height / 1080;
          target.resize(width, height, Math.max(1, ROOM_TEXEL_REF * scale));
          gl.useProgram(roomProgram);
          ru.f2(
            "uPxToH",
            target.fullWidth / target.width / height,
            target.fullHeight / target.height / height,
          );
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const aspect = width / height;
          mugLayout(aspect, p.position, layout);
          const room = roomFor(p.room);
          const drink = drinkFor(p.drink);
          gl.activeTexture(gl.TEXTURE0);

          // 1. Steam simulation.
          steamGrid(layout, grid);
          const gw = grid[0];
          const hasSteam = field.resize(gw, grid[1]);
          const n = simSteps(clock, step);
          if (hasSteam && n > 0) {
            gl.useProgram(field.program);
            steamRegion(layout, region);
            steamEmitter(p.steam, emitter);
            wavePhases(time, phases);
            flow.draft = mugDraft(p.draft, time, layout.side);
            const radius = Math.max(STEAM_RADIUS, (0.9 * region[2]) / gw);
            adv.f4("uRegion", region[0], region[1], region[2], region[3]);
            adv.f4("uPhase", phases[0], phases[1], phases[2], phases[3]);
            adv.f3("uFlow", flow.rise, flow.draft, flow.curl);
            adv.f2("uOnset", flow.onset0, 1 / (flow.onset1 - flow.onset0));
            adv.f4("uEmit0", 0, 0, STEAM_HALF_WIDTH, emitter.strength);
            adv.f4("uEmit1", 0, 0, 0, 0);
            adv.f1("uInvR2", 1 / (radius * radius));
            adv.f3("uWisp", WISP_K, wrap(time * WISP_SPEED, 0, Math.PI * 2), emitter.wisp);
            adv.f2("uDecay", 1 / emitter.life, STEAM_HEIGHT_DECAY);
            field.advance(n);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          // 2. The room, re-rendered only when it changes, upscaled every frame.
          roomKey.setText(0, p.room);
          roomKey.set(1, layout.side);
          if (target.needsRedraw(roomKey)) {
            // Baked once, whatever the room: the room shader always has it bound.
            if (!shelvesBaked) {
              shelves.update(SHELF_SEED, SHELF_PALETTE);
              shelvesBaked = true;
            }
            target.bind();
            gl.useProgram(roomProgram);
            gl.bindTexture(gl.TEXTURE_2D, shelves.texture);
            ru.f2("uFrame", aspect, 1);
            ru.f1("uSide", layout.side);
            ru.i1("uKind", room.kind);
            ru.rgb("uWall", room.wall);
            ru.rgb("uTable", room.table);
            ru.rgb("uLight", room.light);
            ru.f3(
              "uShelfGeom",
              shelfSideWidth(aspect),
              shelfBlurLod(SHELF_BLUR),
              0.015 + 0.05 * SHELF_BLUR,
            );
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          target.blit();

          // 3. The mug, then 4. the steam, premultiplied, each in its own box.
          gl.viewport(0, 0, width, height);
          gl.enable(gl.SCISSOR_TEST);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          scissor(layout.box);
          gl.useProgram(mugProgram);
          mu.f1("uPx", 1 / height);
          mu.f3("uMug", layout.cx, layout.baseY, layout.side);
          mu.rgb("uGlaze", p.mugColor);
          mu.rgb("uDrink", drink.color);
          mu.rgb("uLight", room.light);
          mu.f2("uAmbShine", room.ambient, drink.shine);
          triangle.draw();

          const tex = field.texture;
          if (tex) {
            const s = layout.steam;
            scissor(s);
            gl.useProgram(steamProgram);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            const dirLen = Math.hypot(0.9, 0.44);
            su.f1("uPx", 1 / height);
            su.f4("uBox", s[0], s[1], 1 / (s[2] - s[0]), 1 / (s[3] - s[1]));
            su.f2(
              "uLitStep",
              ((layout.side * 0.9) / dirLen) * (LIT_CELLS / field.width),
              (0.44 / dirLen) * (LIT_CELLS / field.height),
            );
            su.rgb("uLight", room.light);
            su.f1("uAmbient", room.ambient);
            triangle.draw();
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
