import { createCanvasTexture, paintCanvas } from "../canvas-texture";
import { createColorEase, hexToUnitRgb } from "../color";
import { createCrossfadeSlots } from "../fade";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  scopedProgram,
  TO_CLIP_GLSL,
  type Uniforms,
  withScope,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { sanitizeText } from "../params";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch, SPRITE_SPIN_GLSL } from "../sprites";
import { defineEffect } from "../types";
import { arcadeMeta, DEFAULT_TITLE } from "./arcade.meta";
import { buildAtlas, hasGlyphs, layoutLogo } from "./arcade-art";
import { cabinetLayout, paintCabinet } from "./arcade-cabinet";
import {
  buildScene,
  createScene,
  createView,
  type GameView,
  MAX_SPRITES,
  STRIDE,
  WIPE_SOFT,
} from "./arcade-scene";
import {
  effectivePace,
  gameSize,
  highScores,
  isWide,
  LOOP_SECONDS,
  planDemo,
  sanitizeInitials,
  type DemoPlan,
} from "./arcade-sim";

/** Seconds a framing change crossfades, and a palette change eases. */
const CROSSFADE = 1.2;
const PALETTE_EASE = 1.2;
/** Seconds the typed title must hold before the marquee is repainted. */
const SETTLE = 0.4;
/** The title logo's largest block, px, and its share of the screen. */
const LOGO_BLOCK = 6;

/** Monochrome phosphor tints. */
const AMBER = hexToUnitRgb("#ffa833");
const GREEN = hexToUnitRgb("#5cff7a");

/** The game's sprites: atlas cells placed in game px (y down), masked by the scanline wipe. */
const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y and half width, height, game px. */
layout(location = 1) in vec4 aSprite;
/** Atlas rect, px: x0, y0, x1, y1 (y down). */
layout(location = 2) in vec4 aUv;
/** Premultiplied tint. */
layout(location = 3) in vec4 aTint;
/** Wipe layer: 0 shown, 1 the incoming phase, 2 the outgoing one. */
layout(location = 4) in float aLayer;
layout(location = 5) in vec2 aSpin;
uniform vec2 uResolution;
uniform vec2 uAtlasSize;
out vec2 vUv;
flat out vec4 vTint;
flat out float vLayer;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5) / uAtlasSize;
  vTint = aTint;
  vLayer = aLayer;
  gl_Position = pxToClip(aSprite.xy + spinCorner(aCorner * aSprite.zw, aSpin), uResolution);
}
`;

const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in vec4 vTint;
flat in float vLayer;
uniform sampler2D uAtlas;
/** The wipe's front (px from the top), its soft band (px) and the game's height. */
uniform vec3 uWipe;
out vec4 outColor;
void main() {
  // Whole scanlines, so the wipe steps down the screen a line at a time.
  float y = floor(uWipe.z - gl_FragCoord.y) + 0.5;
  float shown = clamp((uWipe.x - y) / uWipe.y, 0.0, 1.0);
  float m = vLayer < 0.5 ? 1.0 : vLayer < 1.5 ? shown : 1.0 - shown;
  outColor = texture(uAtlas, vUv) * vTint * m;
}
`;

/**
 * The CRT, drawn while upscaling the game: a barrel curve with dark rounded
 * corners, crisp pixels softened sideways by phosphor bleed, soft scanlines at
 * the game's own line pitch (faded out where they'd be too thin to survive a
 * codec), a mild bloom, a vignette, the glass's reflection streak, and the
 * monochrome palettes. Premultiplied by uAlpha, for crossfading framings.
 */
const CRT_COMPOSITE = /* glsl */ `
uniform vec2 uRectSize;
uniform float uCrt;
/** Monochrome weight, then the phosphor's tint. */
uniform vec4 uMono;
uniform float uAlpha;
const float TAU = 6.28318530718;
vec4 composite(vec2 uv) {
  vec2 c = uv * 2.0 - 1.0;
  float k = 0.05 * uCrt;
  vec2 w = c * (1.0 + k * dot(c, c)) / (1.0 + k);
  // The tube's rounded corners, and the picture's edge where the curve pulls it in.
  vec2 p = abs(c) * 0.5 * uRectSize;
  float r = (0.025 + 0.045 * uCrt) * uRectSize.y;
  vec2 q = p - (0.5 * uRectSize - r);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float tube = clamp(0.5 - d, 0.0, 1.0);
  vec2 edge = clamp((1.0 - abs(w)) * 0.5 * uRectSize, 0.0, 1.0);
  float inside = edge.x * edge.y;

  vec2 g = (w * 0.5 + 0.5) * uLowResSize;
  vec2 texel = 1.0 / uLowResSize;
  float sharp = mix(12.0, 2.5, uCrt);
  float sx = floor(g.x) + 0.5 + clamp((fract(g.x) - 0.5) * sharp, -0.5, 0.5);
  vec2 st = vec2(sx, floor(g.y) + 0.5) * texel;
  vec3 pic = texture(uLowRes, st).rgb;
  pic += texture(uLowRes, st - vec2(texel.x, 0.0)).rgb * (0.3 * uCrt);
  vec3 halo = texture(uLowRes, (g + vec2(1.5, 1.5)) * texel).rgb
    + texture(uLowRes, (g + vec2(-1.5, 1.5)) * texel).rgb
    + texture(uLowRes, (g + vec2(1.5, -1.5)) * texel).rgb
    + texture(uLowRes, (g + vec2(-1.5, -1.5)) * texel).rgb;
  float linePx = uRectSize.y / uLowResSize.y;
  float depth = 0.5 * uCrt * smoothstep(1.6, 3.2, linePx);
  float scan = 1.0 - depth * (0.5 + 0.5 * cos(TAU * g.y));
  vec3 col = pic * scan * (1.0 + 0.5 * depth) + halo * (0.08 * uCrt);
  col *= 1.0 - 0.18 * uCrt * dot(c, c);
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, uMono.yzw * lum * 1.35, uMono.x);
  col *= inside;
  // The glass: faintly grey even where the picture is black, with a soft streak of reflection.
  float s = c.x * 0.35 + c.y;
  float streak = exp(-pow((s - 0.78) / 0.05, 2.0)) * smoothstep(-0.95, -0.4, c.x) * (1.0 - smoothstep(-0.1, 0.5, c.x));
  col += vec3(0.018, 0.02, 0.024) + vec3(0.05) * streak;
  col *= tube;
  return vec4(col * uAlpha, uAlpha);
}
`;

/** The cabinet painting, copied texel for texel, faded by uAlpha (premultiplied). */
const CABINET_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uCabinet;
uniform float uAlpha;
uniform float uHeight;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.x, uHeight - gl_FragCoord.y);
  outColor = texelFetch(uCabinet, p, 0) * uAlpha;
}
`;

type Framing = "screen" | "cabinet";

/** One framing's picture: its game target and CRT, and the game laid out for its screen. */
interface Slot {
  framing: Framing;
  target: ReturnType<typeof createLowResTarget>;
  u: Uniforms<"uRectSize" | "uCrt" | "uMono" | "uAlpha">;
  view: GameView | null;
  /** What `view` was laid out for. */
  seed: number;
  title: string;
  initials: string;
  /** The screen's rect on the canvas, px, y up. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * An arcade cabinet idling in attract mode: title, demo, high scores and
 * INSERT COIN on a loop. The game draws as atlas sprites into a low-res
 * target at about 224 lines; one CRT pass upscales it into the screen's rect,
 * either the whole frame or the screen of a cabinet painted once per size.
 */
export const arcade = defineEffect(arcadeMeta, {
  create(gl) {
    return withScope((scope) => {
      const atlas = buildAtlas();
      const atlasTexture = scope.add(
        createDataTexture(gl, {
          width: atlas.width,
          height: atlas.height,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: atlas.pixels,
          filter: gl.NEAREST,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const spriteProgram = scopedProgram(gl, scope, SPRITE_VERTEX, SPRITE_FRAGMENT);
      const su = createUniforms(gl, spriteProgram, [
        "uResolution",
        "uAtlasSize",
        "uAtlas",
        "uWipe",
      ]);
      gl.useProgram(spriteProgram);
      su.i1("uAtlas", 0);
      su.f2("uAtlasSize", atlas.width, atlas.height);
      const batch = scope.own(
        createSpriteBatch(gl, MAX_SPRITES, [4, 4, 4, 1], undefined, { rotation: true }),
      );
      if (batch.stride !== STRIDE) {
        throw new Error("Arcade: sprite layout mismatch");
      }

      const cabinetProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, CABINET_FRAGMENT);
      const cu = createUniforms(gl, cabinetProgram, ["uCabinet", "uAlpha", "uHeight"]);
      gl.useProgram(cabinetProgram);
      cu.i1("uCabinet", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const cabinet = createCanvasTexture(gl, scope, { filter: gl.NEAREST, premultiply: true });
      /** What the cabinet texture was painted for (width 0 when empty), and whether it holds a painting. */
      let cabinetW = 0;
      let cabinetH = 0;
      let cabinetTitle = "";
      let cabinetPainted = false;
      gl.useProgram(null);

      const makeSlot = (): Slot => {
        const target = scope.own(
          createLowResTarget(gl, { composite: CRT_COMPOSITE, premultiplied: true }),
        );
        return {
          framing: "screen",
          target,
          u: createUniforms(gl, target.program, ["uRectSize", "uCrt", "uMono", "uAlpha"]),
          view: null,
          seed: 0,
          title: "",
          initials: "",
          x: 0,
          y: 0,
          w: 1,
          h: 1,
        };
      };
      const slots: [Slot, Slot] = [makeSlot(), makeSlot()];
      const release = (slot: Slot) => {
        slot.view = null;
        slot.target.release();
      };
      const fade = createCrossfadeSlots(slots, CROSSFADE, release);

      const scene = createScene();
      const settledTitle = createSettledValue<string>(SETTLE);
      const paletteEase = createColorEase(4);
      const paletteTarget = new Float32Array(4);
      /** Demo plans by seed and game size, so a framing change or relayout reuses them. */
      const plans = new Map<string, DemoPlan>();
      let width = 1;
      let height = 1;
      let loopTime = 0;
      let starTime = 0;
      let started = false;
      /** The text params as last given, and what they give. */
      let rawTitle: string | null = null;
      let rawInitials: string | null = null;
      let typedTitle = DEFAULT_TITLE;
      let initials = "";

      const placeSlot = (slot: Slot) => {
        if (slot.framing === "cabinet") {
          const l = cabinetLayout(width, height);
          slot.x = l.screenX;
          slot.y = height - l.screenY - l.screenH;
          slot.w = l.screenW;
          slot.h = l.screenH;
        } else {
          slot.x = 0;
          slot.y = 0;
          slot.w = width;
          slot.h = height;
        }
      };

      /** (Re)lays out a slot's game when its screen, title, initials or seed change. */
      const prepare = (slot: Slot, title: string, owner: string, seed: number) => {
        placeSlot(slot);
        const size = gameSize(slot.w, slot.h);
        if (
          slot.view?.seed === seed &&
          slot.title === title &&
          slot.initials === owner &&
          slot.view.width === size.width &&
          slot.view.height === size.height
        ) {
          return;
        }
        const planKey = `${String(size.width)}x${String(size.height)}|${String(seed)}`;
        let plan = plans.get(planKey);
        if (!plan) {
          if (plans.size > 4) {
            plans.clear();
          }
          plan = planDemo(seed, size.width, size.height);
          plans.set(planKey, plan);
        }
        const logo = layoutLogo(title, size.width * 0.9, size.height * 0.3, LOGO_BLOCK);
        slot.view = createView(
          size.width,
          size.height,
          seed,
          plan,
          logo,
          highScores(seed, owner),
          isWide(size.width, size.height),
        );
        slot.title = title;
        slot.initials = owner;
      };

      /** Repaints the cabinet for this size and title, or frees it when no slot shows one. */
      const updateCabinet = (title: string) => {
        const used =
          fade.current.framing === "cabinet" || (fade.fading && fade.next.framing === "cabinet");
        if (!used) {
          if (cabinetW !== 0) {
            cabinet.upload(null);
            cabinetW = 0;
            cabinetPainted = false;
          }
          return;
        }
        if (cabinetW === width && cabinetH === height && cabinetTitle === title) {
          return;
        }
        const canvas = paintCanvas(width, height, (ctx) => {
          paintCabinet(ctx, width, height, title);
        });
        cabinet.upload(canvas);
        cabinetPainted = canvas !== null;
        cabinetW = width;
        cabinetH = height;
        cabinetTitle = title;
      };

      /** Draws a slot's game into its low-res target. */
      const drawGame = (slot: Slot) => {
        const view = slot.view;
        if (!view) {
          return;
        }
        const target = slot.target;
        target.resize(view.width, view.height, 1);
        buildScene(scene, atlas.cells, view, loopTime, starTime);
        batch.data.set(scene.data.subarray(0, scene.count * STRIDE));
        batch.upload(scene.count);
        target.bind();
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(spriteProgram);
        su.f2("uResolution", view.width, view.height);
        su.f3("uWipe", scene.front, WIPE_SOFT, view.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        batch.draw(0, scene.count);
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      };

      /** Draws a slot's framing onto the canvas at opacity `alpha`. */
      const compose = (slot: Slot, alpha: number, crt: number, mono: Float32Array) => {
        if (!slot.view) {
          return;
        }
        if (slot.framing === "cabinet" && cabinetPainted) {
          gl.viewport(0, 0, width, height);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(cabinetProgram);
          cu.f1("uAlpha", alpha);
          cu.f1("uHeight", height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cabinet.texture);
          triangle.draw();
          gl.disable(gl.BLEND);
        }
        gl.useProgram(slot.target.program);
        slot.u.f2("uRectSize", slot.w, slot.h);
        slot.u.f1("uCrt", crt);
        slot.u.f4("uMono", mono[0], mono[1], mono[2], mono[3]);
        slot.u.f1("uAlpha", alpha);
        slot.target.blit(slot.w, slot.h, slot.x, slot.y);
      };

      return {
        resize({ width: w, height: h }) {
          width = Math.max(1, Math.floor(w));
          height = Math.max(1, Math.floor(h));
        },
        frame(dt, params) {
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const pace = effectivePace(params.pace);
          loopTime = (loopTime + step * pace) % LOOP_SECONDS;
          starTime += step * pace;
          const framing: Framing = params.framing === "cabinet" ? "cabinet" : "screen";
          if (params.title !== rawTitle) {
            rawTitle = params.title;
            const typed = sanitizeText(arcadeMeta.params.title, rawTitle).trim();
            typedTitle = hasGlyphs(typed) ? typed : DEFAULT_TITLE;
          }
          if (params.initials !== rawInitials) {
            rawInitials = params.initials;
            initials = sanitizeInitials(sanitizeText(arcadeMeta.params.initials, rawInitials));
          }
          const title = settledTitle.update(typedTitle, step);
          const seed = Math.floor(Number.isFinite(params.seed) ? params.seed : 0);

          if (!started) {
            fade.current.framing = framing;
            started = true;
          } else if (!fade.fading && fade.current.framing !== framing) {
            fade.next.framing = framing;
            fade.start();
          }
          fade.step(step);
          prepare(fade.current, title, initials, seed);
          if (fade.fading) {
            prepare(fade.next, title, initials, seed);
          }
          updateCabinet(title);

          const palette = params.palette;
          paletteTarget[0] = palette === "amber" || palette === "green" ? 1 : 0;
          const tint = palette === "green" ? GREEN : AMBER;
          paletteTarget[1] = tint[0];
          paletteTarget[2] = tint[1];
          paletteTarget[3] = tint[2];
          // Out of monochrome, keep the last tint so only the weight eases.
          if (paletteTarget[0] === 0 && paletteEase.value[0] > 0) {
            paletteTarget[1] = paletteEase.value[1];
            paletteTarget[2] = paletteEase.value[2];
            paletteTarget[3] = paletteEase.value[3];
          }
          const mono = paletteEase.step(paletteTarget, step, PALETTE_EASE);
          const crt = Math.min(1, Math.max(0, Number.isFinite(params.crt) ? params.crt : 0.6));

          beginFrame(gl, width, height);
          drawGame(fade.current);
          if (fade.fading) {
            drawGame(fade.next);
          }
          gl.viewport(0, 0, width, height);
          if (fade.current.framing === "cabinet" && !cabinetPainted) {
            // No painting (no 2D canvas): a dark room round the screen.
            gl.clearColor(0.02, 0.02, 0.04, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
          compose(fade.current, 1, crt, mono);
          if (fade.fading) {
            compose(fade.next, fade.mix, crt, mono);
          }
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
