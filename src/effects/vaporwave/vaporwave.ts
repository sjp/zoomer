import { type CanvasTexture, createCanvasTexture } from "../canvas-texture";
import { createColorEase, hexToUnitRgb } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createDepthTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  scopedProgram,
  type Scope,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { approach, clamp, smoothstep } from "../math";
import { VALUE_FBM_GLSL, VALUE_NOISE_GLSL } from "../noise";
import { createSettledValue } from "../rebuild";
import { createSpriteBatch, SPRITE_SPIN_GLSL } from "../sprites";
import { defineEffect } from "../types";
import { BUST_FLOATS, BUST_RADIUS, buildBustMesh } from "./bust-mesh";
import { canDrawKana, paintCaption, paintDialog, paintPalmAtlas } from "./vaporwave-art";
import {
  BUST_TILT,
  createScene,
  FLOOR_CELL,
  FLOOR_FOCAL,
  PALM_ASPECT,
  PALM_VARIANTS,
  palmSway,
  REF_HEIGHT,
  reseed,
  resizeScene,
  type Scene,
  startScene,
  stepScene,
  trackingBand,
  WINDOW_COUNT,
  WINDOW_H,
  WINDOW_W,
  windowOffset,
} from "./vaporwave-sim";
import { vaporwaveMeta } from "./vaporwave.meta";

/** Seconds a style change crossfades, and the caption's crossfade on a new text. */
const STYLE_EASE = 1.2;
const CAPTION_EASE = 1;
const FLOOR_EASE = 1.2;
/** Seconds the text, and the canvas size and variation, must hold before they are used. */
const SETTLE_TEXT = 1;
const SETTLE_SIZE = 0.3;
/** Lines of picture in the Lo-fi style, like a VHS tape. */
const LOFI_LINES = 480;
/** Bounds on the palm atlas's cell height, px. */
const MIN_PALM_CELL = 16;
const MAX_PALM_CELL = 2048;
/** The sun's radius as a fraction of the frame height; it sits half set on the horizon. */
const SUN_RADIUS = 0.22;

/** The floors' two colours each: pink and teal, black and white. */
const FLOORS: Record<string, readonly [string, string]> = {
  pastel: ["#f6a6d6", "#5fd0cc"],
  mono: ["#f2eff4", "#1e1b26"],
};

/** Thin cloud streaks: centre y and half thickness (ref px), then x span as fractions of the width. */
const STREAKS = [
  [432, 3.5, 0.06, 0.4],
  [474, 2.5, 0.56, 0.96],
  [528, 4, 0.3, 0.74],
  [584, 2, 0.04, 0.32],
] as const;

const rgb = (hex: string) => {
  const [r, g, b] = hexToUnitRgb(hex);
  return `vec3(${glslFloat(r)}, ${glslFloat(g)}, ${glslFloat(b)})`;
};

/** Sky above the horizon, the checkerboard below it, one pass. Positions in pass px, y down. */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uHorizon;
uniform float uFocal;
uniform float uFloorOffset;
/** Sun centre x, y and radius. */
uniform vec3 uSun;
/** Each streak: centre y, half thickness, left and right x. */
uniform vec4 uStreaks[4];
uniform vec3 uFloorA;
uniform vec3 uFloorB;
/** 1 for the Lo-fi style's coarse ordered dither, 0 for a fine one. */
uniform float uLofi;
out vec4 outColor;

const vec3 SKY_TOP = ${rgb("#a998e0")};
const vec3 SKY_MID = ${rgb("#f2a2cc")};
const vec3 SKY_LOW = ${rgb("#ffcfa8")};
const vec3 SUN_TOP = ${rgb("#fff4b8")};
const vec3 SUN_BOTTOM = ${rgb("#ff92c6")};
const vec3 SUN_GLOW = ${rgb("#ffd0dc")};
const vec3 STREAK = ${rgb("#fde6f3")};
const vec3 HAZE = ${rgb("#ffd9d2")};
const float CELL = ${glslFloat(FLOOR_CELL)};
const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
${DITHER_GLSL}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);

  // The floor's checker coordinates, outside any branch so the derivatives are defined.
  float dy = max(p.y - uHorizon, 0.5);
  float z = uFocal / dy;
  vec2 q = vec2((p.x - 0.5 * uResolution.x) / dy, z + uFloorOffset) / CELL;
  // Box-filtered checkerboard: far squares fade to their average instead of aliasing.
  vec2 w = fwidth(q) + 1e-4;
  vec2 i = 2.0 * (abs(fract((q - 0.5 * w) * 0.5) - 0.5) - abs(fract((q + 0.5 * w) * 0.5) - 0.5)) / w;
  float checker = 0.5 - 0.5 * i.x * i.y;
  vec3 floorCol = mix(uFloorA, uFloorB, checker);
  floorCol = mix(floorCol, HAZE, 1.0 - exp(-z * 0.045));

  vec3 col = floorCol;
  if (p.y < uHorizon + 0.5) {
    float t = clamp(p.y / uHorizon, 0.0, 1.0);
    vec3 sky = t < 0.55 ? mix(SKY_TOP, SKY_MID, t / 0.55) : mix(SKY_MID, SKY_LOW, (t - 0.55) / 0.45);
    float dist = length(p - uSun.xy);
    sky = mix(sky, SUN_GLOW, 0.4 * exp(-max(dist - uSun.z, 0.0) / (0.3 * uSun.z)));
    vec3 sun = mix(SUN_TOP, SUN_BOTTOM, clamp((p.y - uSun.y + uSun.z) / uSun.z, 0.0, 1.0));
    sky = mix(sky, sun, clamp(uSun.z - dist + 0.5, 0.0, 1.0));
    for (int k = 0; k < 4; k++) {
      vec4 s = uStreaks[k];
      float d = (p.y - s.x) / s.y;
      float fadeIn = 0.25 * (s.w - s.z);
      float a = exp(-d * d) * smoothstep(s.z, s.z + fadeIn, p.x) * (1.0 - smoothstep(s.w - fadeIn, s.w, p.x));
      sky = mix(sky, STREAK, 0.6 * a);
    }
    sky = mix(sky, HAZE, 0.55 * exp(-(uHorizon - p.y) / (0.07 * uResolution.y)));
    col = mix(sky, floorCol, clamp(p.y - uHorizon + 0.5, 0.0, 1.0));
  }

  if (uLofi > 0.5) {
    ivec2 c = ivec2(gl_FragCoord.xy) & 3;
    float b = (BAYER[c.x + c.y * 4] + 0.5) / 16.0;
    col = floor(col * 31.0 + b) / 31.0;
  } else {
    col += dither8(gl_FragCoord.xy);
  }
  outColor = vec4(col, 1.0);
}
`;

const BUST_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aPart;
/** The bust's turn and the camera's tilt, as cos and sin. */
uniform vec2 uSpin;
uniform vec2 uTilt;
/** Clip units per bust unit, across and up, and the layer's middle height in bust units. */
uniform vec2 uScale;
uniform float uMid;
out vec3 vObj;
out vec3 vNormal;
flat out float vPart;
vec3 turn(vec3 v) {
  return vec3(v.x * uSpin.x + v.z * uSpin.y, v.y, v.z * uSpin.x - v.x * uSpin.y);
}
vec3 tilt(vec3 v) {
  return vec3(v.x, v.y * uTilt.x - v.z * uTilt.y, v.y * uTilt.y + v.z * uTilt.x);
}
void main() {
  vec3 p = aPos;
  vec3 n = aNormal;
  // Only the bust turns; the pillar stays square to the camera.
  if (aPart < 0.5) {
    p = turn(p);
    n = turn(n);
  }
  p = tilt(p);
  vNormal = tilt(n);
  vObj = aPos;
  vPart = aPart;
  gl_Position = vec4(p.x * uScale.x, (p.y - uMid) * uScale.y, -p.z * 0.4, 1.0);
}
`;

/** Marble: white with soft grey-blue veins, a warm key light and pink and cyan rims. */
const BUST_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 vObj;
in vec3 vNormal;
flat in float vPart;
out vec4 outColor;
const vec3 MARBLE = ${rgb("#f4efea")};
const vec3 VEIN = ${rgb("#9a9cb4")};
const vec3 AMBIENT = ${rgb("#a796c8")};
const vec3 KEY = ${rgb("#fff1e6")};
const vec3 RIM_PINK = ${rgb("#ff5fc0")};
const vec3 RIM_CYAN = ${rgb("#46e6ff")};
const vec3 KEY_DIR = vec3(-0.45, 0.55, 0.7);
${VALUE_NOISE_GLSL}
${VALUE_FBM_GLSL}
float vein(float f, float width) {
  return 1.0 - smoothstep(0.0, width + fwidth(f), abs(f - 0.5));
}
void main() {
  vec3 n = normalize(vNormal);
  vec2 mp = vObj.xy * 1.3 + vObj.z * vec2(0.8, -0.5);
  float veins = 0.5 * vein(fbm(mp, 7.0), 0.025) + 0.25 * vein(fbm(mp * 2.1 + 3.0, 11.0), 0.02);
  vec3 base = mix(MARBLE, VEIN, veins);
  base *= vPart > 0.5 ? vec3(1.0, 0.96, 0.97) : vec3(1.0);
  float key = max(dot(n, normalize(KEY_DIR)), 0.0);
  vec3 col = base * (0.45 * AMBIENT + 0.75 * KEY * key);
  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.5);
  col += rim * 0.5 * (RIM_PINK * smoothstep(-0.3, 0.8, n.x) + RIM_CYAN * smoothstep(-0.3, 0.8, -n.x));
  vec3 h = normalize(normalize(KEY_DIR) + vec3(0.0, 0.0, 1.0));
  col += 0.15 * pow(max(dot(n, h), 0.0), 24.0);
  outColor = vec4(min(col, vec3(1.0)), 1.0);
}
`;

const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y and half width, height, in ref px (y down). */
layout(location = 1) in vec4 aSprite;
/** Texture rect: u0, v0, u1, v1. */
layout(location = 2) in vec4 aUv;
layout(location = 3) in float aAlpha;
layout(location = 4) in vec2 aSpin;
uniform vec2 uResolution;
/** Pass px per ref px, across and down. */
uniform vec2 uK;
out vec2 vUv;
flat out float vAlpha;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vUv = mix(aUv.xy, aUv.zw, aCorner * 0.5 + 0.5);
  vAlpha = aAlpha;
  gl_Position = pxToClip((aSprite.xy + spinCorner(aCorner * aSprite.zw, aSpin)) * uK, uResolution);
}
`;

const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
flat in float vAlpha;
uniform sampler2D uTex;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vUv) * vAlpha;
}
`;

/**
 * The Lo-fi upscale: a short horizontal smear, a red and blue fringe, and the
 * tracking band (a few rows nudged sideways, lifted and washed out) as it rolls
 * up the screen. Premultiplied by the style's weight for the crossfade.
 */
const LOFI_COMPOSITE = /* glsl */ `
uniform float uAlpha;
/** The tracking band's centre (0 at the bottom) and strength. */
uniform vec2 uBand;
vec4 composite(vec2 uv) {
  float tx = 1.0 / uLowResSize.x;
  float d = (uv.y - uBand.x) / 0.03;
  float band = exp(-d * d) * uBand.y;
  vec2 u = vec2(uv.x + band * (0.004 + 0.003 * sin(uv.y * 400.0)), uv.y);
  vec3 c = texture(uLowRes, u).rgb * 0.55
    + texture(uLowRes, u - vec2(tx, 0.0)).rgb * 0.3
    + texture(uLowRes, u - vec2(2.0 * tx, 0.0)).rgb * 0.15;
  c.r = mix(c.r, texture(uLowRes, u + vec2(1.5 * tx, 0.0)).r, 0.6);
  c.b = mix(c.b, texture(uLowRes, u - vec2(1.5 * tx, 0.0)).b, 0.6);
  c = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), 0.3 * band) + 0.07 * band;
  return vec4(c * uAlpha, uAlpha);
}
`;

/** Sprite instances: palms, the bust in each style, the dialog boxes, the two caption slots. */
const PALM_FIRST = 0;
const BUST_CLEAN = 3;
const BUST_LOFI = 4;
const WINDOW_FIRST = 5;
const CAPTION_FIRST = WINDOW_FIRST + WINDOW_COUNT;
const SPRITES = CAPTION_FIRST + 2;

/**
 * The bust's own layer: rendered with a depth buffer (multisampled where the
 * GPU allows) into a texture the size of its rect on screen, then drawn as a
 * sprite. Redrawn only when the turn or size changes.
 */
interface BustLayer {
  /** Makes the layer `w` x `h`; false if it can't be rendered to. */
  ensure: (w: number, h: number) => boolean;
  /** Binds the layer to draw into, cleared. */
  begin: () => void;
  /** Resolves the multisampled image into the texture and unbinds. */
  end: () => void;
  /** Frees the texture and buffer storage until the next `ensure`. */
  release: () => void;
  readonly texture: WebGLTexture | null;
  /** The angle the texture shows, NaN when it must be redrawn. */
  drawn: number;
}

function createBustLayer(gl: WebGL2RenderingContext, scope: Scope): BustLayer {
  const depth = createDepthTarget(gl, scope, { msaa: true });
  let width = 0;
  let height = 0;
  const layer: BustLayer = {
    drawn: Number.NaN,
    get texture() {
      return depth.target?.texture ?? null;
    },
    ensure(w, h) {
      if (w === width && h === height) {
        return depth.target !== null;
      }
      width = w;
      height = h;
      layer.drawn = Number.NaN;
      return depth.resize(w, h) !== null;
    },
    begin() {
      depth.bind();
      gl.clearColor(0, 0, 0, 0);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
    },
    end() {
      gl.disable(gl.DEPTH_TEST);
      depth.resolve();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    release() {
      if (width === 0) {
        return;
      }
      width = 0;
      height = 0;
      layer.drawn = Number.NaN;
      depth.release();
    },
  };
  return layer;
}

/**
 * A E S T H E T I C: a pastel dusk over a checkerboard floor, a marble bust
 * slowly turning on its pillar to one side and palm silhouettes on the other,
 * a few 90s dialog boxes floating in the sky and the caption along the top.
 * One full-screen pass for the sky and floor, a small multisampled layer for
 * the bust, and a dozen sprites. Lo-fi draws it all at VHS resolution and
 * upscales with a smear, a colour fringe and a rolling tracking band.
 */
export const vaporwave = defineEffect(vaporwaveMeta, {
  create(gl) {
    return withScope((scope) => {
      const sceneProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, SCENE_FRAGMENT);
      const us = createUniforms(gl, sceneProgram, [
        "uResolution",
        "uHorizon",
        "uFocal",
        "uFloorOffset",
        "uSun",
        "uStreaks",
        "uFloorA",
        "uFloorB",
        "uLofi",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const bustProgram = scopedProgram(gl, scope, BUST_VERTEX, BUST_FRAGMENT);
      const ub = createUniforms(gl, bustProgram, ["uSpin", "uTilt", "uScale", "uMid"]);
      const mesh = buildBustMesh();
      const bustVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const bustVertices = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const bustIndices = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(bustVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, bustVertices);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bustIndices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      [3, 3, 1].reduce((offset, size, loc) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, BUST_FLOATS * 4, offset * 4);
        return offset + size;
      }, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
      const indexCount = mesh.indices.length;
      const bustLayers = [createBustLayer(gl, scope), createBustLayer(gl, scope)] as const;

      const spriteProgram = scopedProgram(gl, scope, SPRITE_VERTEX, SPRITE_FRAGMENT);
      const usp = createUniforms(gl, spriteProgram, ["uResolution", "uK", "uTex"]);
      gl.useProgram(spriteProgram);
      usp.i1("uTex", 0);
      gl.useProgram(null);
      const batch = scope.own(
        createSpriteBatch(gl, SPRITES, [4, 4, 1], undefined, { rotation: true }),
      );
      const data = batch.data;
      const stride = batch.stride;

      const lofi = scope.own(
        createLowResTarget(gl, { composite: LOFI_COMPOSITE, premultiplied: true }),
      );
      const ul = createUniforms(gl, lofi.program, ["uAlpha", "uBand"]);

      const palmArt = createCanvasTexture(gl, scope, { premultiply: true });
      const windowArt: CanvasTexture[] = [];
      /** What each dialog box's texture shows: its variation, serial and scale. */
      const windowPainted = new Float64Array(WINDOW_COUNT * 3).fill(Number.NaN);
      for (let i = 0; i < WINDOW_COUNT; i++) {
        windowArt.push(createCanvasTexture(gl, scope, { premultiply: true }));
      }
      const captionArt = [
        createCanvasTexture(gl, scope, { premultiply: true }),
        createCanvasTexture(gl, scope, { premultiply: true }),
      ] as const;
      const captionAlpha = [0, 0];
      let captionSlot = 0;
      /** What the current caption slot shows; a scale of 0 before the first paint. */
      let captionText = "";
      let captionScale = 0;
      let captionWidth = 0;
      let kana: boolean | null = null;

      const settledText = createSettledValue<string>(SETTLE_TEXT);
      const settledSize = createSettledValue<number>(SETTLE_SIZE);
      const settledSeed = createSettledValue<number>(SETTLE_SIZE);
      const floorEase = createColorEase(6);
      const floorTarget = new Float32Array(6);
      let floorKey = "";
      const streaks = new Float32Array(16);
      const offset = { x: 0, y: 0 };
      const band = { y: -1, strength: 0 };

      let width = 1;
      let height = 1;
      let scale = 1;
      let scene: Scene | null = null;
      let paintedSize = -1;
      let artScale = 1;
      let palmKey = -1;
      /** The Lo-fi style's weight, 0..1. */
      let lofiWeight = -1;

      const put = (
        index: number,
        cx: number,
        cy: number,
        hw: number,
        hh: number,
        u0: number,
        v0: number,
        u1: number,
        v1: number,
        alpha: number,
        angle: number,
        flip: number,
      ) => {
        const o = index * stride;
        data[o] = cx;
        data[o + 1] = cy;
        data[o + 2] = hw;
        data[o + 3] = hh;
        data[o + 4] = u0;
        data[o + 5] = v0;
        data[o + 6] = u1;
        data[o + 7] = v1;
        data[o + 8] = alpha;
        data[o + 9] = angle;
        data[o + 10] = flip;
      };

      /** Repaints any art whose content or scale changed. */
      const paintArt = (s: Scene, text: string) => {
        const l = s.layout;
        if (text !== captionText || artScale !== captionScale || l.width !== captionWidth) {
          // The first caption shows at once; later ones crossfade in.
          const first = captionScale === 0;
          captionText = text;
          captionScale = artScale;
          captionWidth = l.width;
          kana ??= canDrawKana();
          captionSlot = 1 - captionSlot;
          const c = l.caption;
          captionArt[captionSlot].upload(
            paintCaption(
              (c.maxX - c.minX) * artScale,
              (c.maxY - c.minY) * artScale,
              artScale,
              c.minY,
              text,
              kana,
            ),
          );
          if (first) {
            captionAlpha[captionSlot] = 1;
          }
        }
        let tallest = 0;
        for (const p of l.palms) {
          tallest = Math.max(tallest, p.height);
        }
        const cell = clamp(Math.round(tallest * artScale), MIN_PALM_CELL, MAX_PALM_CELL);
        if (cell !== palmKey) {
          palmKey = cell;
          palmArt.upload(paintPalmAtlas(cell));
        }
        const ws = artScale * l.windowScale;
        for (let i = 0; i < WINDOW_COUNT; i++) {
          const w = s.windows[i];
          const o = i * 3;
          if (
            w.live &&
            (windowPainted[o] !== w.artSeed ||
              windowPainted[o + 1] !== w.serial ||
              windowPainted[o + 2] !== ws)
          ) {
            windowPainted[o] = w.artSeed;
            windowPainted[o + 1] = w.serial;
            windowPainted[o + 2] = ws;
            windowArt[i].upload(paintDialog(ws, w.artSeed, w.serial));
          }
        }
      };

      /** Fills every sprite but the bust (which depends on the pass). */
      const fillSprites = (s: Scene) => {
        const l = s.layout;
        for (let i = 0; i < 3; i++) {
          if (i >= l.palms.length) {
            put(PALM_FIRST + i, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
            continue;
          }
          const p = l.palms[i];
          const a = palmSway(s, p);
          const hh = p.height / 2;
          put(
            PALM_FIRST + i,
            p.x + hh * Math.sin(a),
            p.y - hh * Math.cos(a),
            (p.height * PALM_ASPECT) / 2,
            hh,
            p.variant / PALM_VARIANTS,
            0,
            (p.variant + 1) / PALM_VARIANTS,
            1,
            s.palmAlpha,
            a,
            p.flip ? -1 : 1,
          );
        }
        const hw = (WINDOW_W / 2) * l.windowScale;
        const hh = (WINDOW_H / 2) * l.windowScale;
        for (let i = 0; i < WINDOW_COUNT; i++) {
          const w = s.windows[i];
          windowOffset(s, w, offset);
          put(WINDOW_FIRST + i, w.x + offset.x, w.y + offset.y, hw, hh, 0, 0, 1, 1, w.alpha, 0, 1);
        }
        const c = l.caption;
        for (let k = 0; k < 2; k++) {
          put(
            CAPTION_FIRST + k,
            (c.minX + c.maxX) / 2,
            (c.minY + c.maxY) / 2,
            (c.maxX - c.minX) / 2,
            (c.maxY - c.minY) / 2,
            0,
            0,
            1,
            1,
            smoothstep(0, 1, captionAlpha[k]),
            0,
            1,
          );
        }
      };

      /**
       * Renders the bust's layer for a pass `pw` x `ph` px and fills its sprite,
       * snapped to whole pass px so the layer's texels land one to one.
       */
      const renderBust = (s: Scene, index: number, layer: BustLayer, pw: number, ph: number) => {
        const l = s.layout;
        const kx = pw / l.width;
        const ky = ph / REF_HEIGHT;
        const x0 = Math.round(l.bust.minX * kx);
        const x1 = Math.round(l.bust.maxX * kx);
        const y0 = Math.round(l.bust.minY * ky);
        const y1 = Math.round(l.bust.maxY * ky);
        const lw = x1 - x0;
        const lh = y1 - y0;
        if (lw < 1 || lh < 1 || !layer.ensure(lw, lh)) {
          put(index, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
          return;
        }
        put(
          index,
          (x0 + x1) / 2 / kx,
          (y0 + y1) / 2 / ky,
          lw / 2 / kx,
          lh / 2 / ky,
          0,
          1,
          1,
          0,
          1,
          0,
          1,
        );
        if (layer.drawn === s.angle) {
          return;
        }
        layer.drawn = s.angle;
        layer.begin();
        gl.useProgram(bustProgram);
        ub.f2("uSpin", Math.cos(s.angle), Math.sin(s.angle));
        ub.f2("uTilt", Math.cos(BUST_TILT), Math.sin(BUST_TILT));
        ub.f2("uScale", 1 / BUST_RADIUS, 2 / (l.bustTop - l.bustBottom));
        ub.f1("uMid", (l.bustTop + l.bustBottom) / 2);
        gl.bindVertexArray(bustVao);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(null);
        layer.end();
      };

      /** Draws the sky, floor and sprites into the bound pass, `pw` x `ph` px. */
      const drawPass = (
        s: Scene,
        pw: number,
        ph: number,
        isLofi: boolean,
        layer: BustLayer,
        bust: number,
      ) => {
        const l = s.layout;
        const ky = ph / REF_HEIGHT;
        const horizon = l.horizon * ky;
        gl.useProgram(sceneProgram);
        us.f2("uResolution", pw, ph);
        us.f1("uHorizon", horizon);
        us.f1("uFocal", FLOOR_FOCAL * ky);
        us.f1("uFloorOffset", s.floor);
        us.f3("uSun", pw / 2, horizon, SUN_RADIUS * ph);
        for (let k = 0; k < STREAKS.length; k++) {
          const [y, half, left, right] = STREAKS[k];
          streaks[k * 4] = y * ky;
          streaks[k * 4 + 1] = half * ky;
          streaks[k * 4 + 2] = left * pw;
          streaks[k * 4 + 3] = right * pw;
        }
        gl.uniform4fv(us.loc.uStreaks, streaks);
        const floor = floorEase.value;
        us.f3("uFloorA", floor[0], floor[1], floor[2]);
        us.f3("uFloorB", floor[3], floor[4], floor[5]);
        us.f1("uLofi", isLofi ? 1 : 0);
        triangle.draw();

        gl.useProgram(spriteProgram);
        usp.f2("uResolution", pw, ph);
        usp.f2("uK", pw / l.width, ky);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.activeTexture(gl.TEXTURE0);
        if (s.palmAlpha > 0 && l.palms.length > 0) {
          gl.bindTexture(gl.TEXTURE_2D, palmArt.texture);
          batch.draw(PALM_FIRST, l.palms.length);
        }
        if (layer.texture && data[bust * stride + 8] > 0) {
          gl.bindTexture(gl.TEXTURE_2D, layer.texture);
          batch.draw(bust, 1);
        }
        for (let i = 0; i < WINDOW_COUNT; i++) {
          if (s.windows[i].alpha > 0) {
            gl.bindTexture(gl.TEXTURE_2D, windowArt[i].texture);
            batch.draw(WINDOW_FIRST + i, 1);
          }
        }
        for (let k = 0; k < 2; k++) {
          if (captionAlpha[k] > 0) {
            gl.bindTexture(gl.TEXTURE_2D, captionArt[k].texture);
            batch.draw(CAPTION_FIRST + k, 1);
          }
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.disable(gl.BLEND);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / REF_HEIGHT;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const text = settledText.update(p.text, step);
          const seed = settledSeed.update(p.seed, step);
          const size = settledSize.update(width * 65536 + height, step);
          if (!scene) {
            // Allocates: the scene, once.
            scene = createScene(seed, width / scale);
            startScene(scene, p.motion, p.spin, p.drift, p.windows);
            paintedSize = size;
            artScale = scale;
          }
          const s = scene;
          reseed(s, seed);
          if (size !== paintedSize) {
            paintedSize = size;
            artScale = scale;
            resizeScene(s, width / scale);
          }
          stepScene(s, step, p.motion, p.spin, p.drift, p.windows);
          paintArt(s, text);

          // Style, floor and caption crossfades.
          const lofiTarget = p.style === "clean" ? 0 : 1;
          lofiWeight =
            lofiWeight < 0 ? lofiTarget : approach(lofiWeight, lofiTarget, step / STYLE_EASE);
          const lofiW = smoothstep(0, 1, lofiWeight);
          if (floorKey !== p.floor) {
            // Allocates: parsing the colours, only when the floor changes.
            floorKey = p.floor;
            const [a, b] = FLOORS[p.floor] ?? FLOORS.pastel;
            floorTarget.set(hexToUnitRgb(a), 0);
            floorTarget.set(hexToUnitRgb(b), 3);
          }
          floorEase.step(floorTarget, step, FLOOR_EASE);
          for (let k = 0; k < 2; k++) {
            captionAlpha[k] = approach(
              captionAlpha[k],
              k === captionSlot ? 1 : 0,
              step / CAPTION_EASE,
            );
          }

          fillSprites(s);
          if (lofiW > 0) {
            lofi.resize(width, height, Math.max(1, height / LOFI_LINES));
            renderBust(s, BUST_LOFI, bustLayers[1], lofi.width, lofi.height);
          }
          if (lofiW < 1) {
            renderBust(s, BUST_CLEAN, bustLayers[0], width, height);
          }
          batch.upload(SPRITES);

          if (lofiW < 1) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            drawPass(s, width, height, false, bustLayers[0], BUST_CLEAN);
          }
          if (lofiW > 0) {
            lofi.bind();
            drawPass(s, lofi.width, lofi.height, true, bustLayers[1], BUST_LOFI);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            trackingBand(s, band);
            gl.useProgram(lofi.program);
            ul.f1("uAlpha", lofiW);
            ul.f2("uBand", band.y, band.strength);
            lofi.blit();
          }
          // Free the look that has faded out until it comes back.
          if (lofiW <= 0) {
            bustLayers[1].release();
            lofi.release();
          } else if (lofiW >= 1) {
            bustLayers[0].release();
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
