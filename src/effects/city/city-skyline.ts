/**
 * The city skyline's buildings on the GPU: one instanced quad per building
 * block with an analytic window grid, and the per-window data texture that
 * `createWindowState` keeps. Shared by City at Night and the Neon-Noir
 * Apartment's view.
 */
import type { Rgb } from "../color";
import {
  createDataTexture,
  createUniforms,
  resetUnpackState,
  TO_CLIP_GLSL,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import { createSpriteBatch } from "../sprites";
import {
  type CityLayout,
  createWindowState,
  FADE_SLOTS,
  MAX_QUADS,
  QUAD_STRIDE,
  WINDOW_TEX_ROWS,
  WINDOW_TEX_WIDTH,
  type WindowState,
} from "./city-sim";

/** Colour picks above this byte (of 255) are TV blue: about 2.5% of windows. */
const TV_PICK = 0.975;

/**
 * Building quads. Corners are `aCorner` (±1); everything else is per instance, in
 * 1080p reference px (y down), scaled by `uScale` and moved by `uOffset` (device
 * px). Quads are at least one device pixel wide so thin antennas never vanish.
 */
const BUILDING_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aGrid;
layout(location = 3) in vec4 aWin;
layout(location = 4) in vec4 aMisc;
uniform vec2 uResolution;
uniform float uScale;
uniform vec2 uOffset;
out vec2 vLocal;
flat out vec4 vGrid;
flat out vec4 vWin;
flat out vec3 vMisc;
${TO_CLIP_GLSL}
void main() {
  vec2 t = aCorner * 0.5 + 0.5;
  vec2 size = max(aRect.zw * uScale, vec2(1.0));
  vec2 centre = (aRect.xy + aRect.zw * 0.5) * uScale;
  vLocal = t * aRect.zw;
  vGrid = aGrid;
  vWin = aWin;
  vMisc = aMisc.xyz;
  gl_Position = pxToClip(centre + (t - 0.5) * size + uOffset, uResolution);
}
`;

/**
 * A flat silhouette with an analytic window grid. One texel per window gives its
 * fade levels, colour pick and fade slot. Below about 3 px the window pattern
 * fades to its average coverage, so far windows don't shimmer or moire.
 */
const BUILDING_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
in vec2 vLocal;
flat in vec4 vGrid;
flat in vec4 vWin;
flat in vec3 vMisc;
uniform sampler2D uWindows;
/** Fade progress of each slot, four slots per vec4 (a vec4 array uses a quarter of the uniform vectors). */
uniform vec4 uFade[${String(FADE_SLOTS / 4)}];
uniform vec3 uBuilding;
uniform vec3 uHaze;
uniform float uWarmth;
uniform float uScale;
/** Lit window tints: warm, cool and the rare TV. */
uniform vec3 uWarm;
uniform vec3 uCool;
uniform vec3 uTv;
out vec4 outColor;
void main() {
  vec3 wall = mix(uBuilding, uHaze, vMisc.y);
  // Grid coordinates and their derivatives, outside any branch.
  vec2 q = (vLocal - vWin.xy) / max(vGrid.xy, vec2(1e-3));
  vec2 aa = max(fwidth(q), vec2(1e-4));
  vec3 color = wall;
  vec2 cell = floor(q);
  if (vGrid.z > 0.5 && cell.x >= 0.0 && cell.y >= 0.0 && cell.x < vGrid.z && cell.y < vGrid.w) {
    vec2 g = abs(fract(q) - 0.5);
    vec2 m = clamp((vWin.zw * 0.5 - g) / aa + 0.5, 0.0, 1.0);
    float mask = m.x * m.y;
    float windowPx = min(vGrid.x * vWin.z, vGrid.y * vWin.w) * uScale;
    mask = mix(mask, vWin.z * vWin.w, clamp((3.0 - windowPx) * 0.5, 0.0, 1.0));
    int idx = int(vMisc.x + 0.5) + int(cell.y) * int(vGrid.z + 0.5) + int(cell.x);
    vec4 w = texelFetch(uWindows, ivec2(idx & ${String(WINDOW_TEX_WIDTH - 1)}, idx >> 8), 0);
    int slot = min(int(w.a * 255.0 + 0.5), ${String(FADE_SLOTS)});
    float level = slot > 0 ? mix(w.r, w.g, uFade[(slot - 1) >> 2][(slot - 1) & 3]) : w.g;
    vec3 tint = w.b > ${String(TV_PICK)} ? uTv : (w.b < uWarmth * ${String(TV_PICK)} ? uWarm : uCool);
    // Unlit glass is a touch lighter than the wall; lit glass is tinted by layer.
    vec3 glass = wall * 1.25 + 0.006 + tint * (level * vMisc.z);
    glass = mix(glass, uHaze, vMisc.y * 0.35);
    color = mix(wall, glass, mask);
  }
  outColor = vec4(color, 1.0);
}
`;

/** City at Night's window tints. */
export const WARM_RGB: Rgb = [1, 0.7, 0.36];
export const COOL_RGB: Rgb = [0.82, 0.88, 1];
export const TV_RGB: Rgb = [0.32, 0.5, 1];

/** How to draw the buildings: placement on the target and colours. */
export interface SkylineStyle {
  /** Target size in device px. */
  width: number;
  height: number;
  /** Device px per layout reference px. */
  scale: number;
  /** Device px added to every position after scaling (y down). */
  offsetX: number;
  offsetY: number;
  building: Rgb;
  haze: Rgb;
  /** Share of windows with the warm tint, 0..1. */
  warmth: number;
  warm: Rgb;
  cool: Rgb;
  tv: Rgb;
}

export interface Skyline {
  readonly windows: WindowState;
  /** Uploads a new layout's quads and resets every window for it. */
  setLayout: (layout: CityLayout, seed: number, litFraction: number) => void;
  /** Lights exactly `fraction` of the windows at once. */
  setLit: (fraction: number) => void;
  /**
   * Advances the window fades at `rate` toggles per second and uploads the
   * texels that changed. Returns whether the buildings look any different.
   * Leaves the window texture bound to unit 0.
   */
  step: (dt: number, rate: number) => boolean;
  /** Draws the buildings, opaque, into the bound framebuffer. */
  draw: (style: SkylineStyle) => void;
  dispose: () => void;
}

export function createSkyline(gl: WebGL2RenderingContext): Skyline {
  return withScope((scope) => {
    const program = scopedProgram(gl, scope, BUILDING_VERTEX, BUILDING_FRAGMENT);
    const u = createUniforms(gl, program, [
      "uResolution",
      "uScale",
      "uOffset",
      "uWindows",
      "uFade",
      "uBuilding",
      "uHaze",
      "uWarmth",
      "uWarm",
      "uCool",
      "uTv",
    ]);
    const quads = scope.own(createSpriteBatch(gl, MAX_QUADS, [4, 4, 4, 4]));
    const windows = createWindowState();
    const texture = scope.add(
      createDataTexture(gl, {
        width: WINDOW_TEX_WIDTH,
        height: WINDOW_TEX_ROWS,
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        data: windows.data,
        filter: gl.NEAREST,
      }),
      (t) => {
        gl.deleteTexture(t);
      },
    );
    let quadCount = 0;

    const uploadAll = () => {
      gl.activeTexture(gl.TEXTURE0);
      const rows = Math.max(1, Math.ceil(windows.windowCount / WINDOW_TEX_WIDTH));
      updateDataTexture(
        gl,
        texture,
        WINDOW_TEX_WIDTH,
        Math.min(rows, WINDOW_TEX_ROWS),
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        windows.data,
      );
    };

    return {
      windows,
      setLayout(layout, seed, litFraction) {
        quadCount = layout.quadCount;
        quads.data.set(layout.quads.subarray(0, quadCount * QUAD_STRIDE));
        quads.upload(quadCount);
        windows.reset(layout.windowCount, seed, litFraction);
        uploadAll();
      },
      setLit(fraction) {
        windows.setLit(fraction);
        uploadAll();
      },
      step(dt, rate) {
        // The CPU writes a texel only when a fade starts or settles.
        windows.step(dt, rate);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (windows.dirtyCount > 0) {
          resetUnpackState(gl);
          for (let n = 0; n < windows.dirtyCount; n++) {
            const i = windows.dirty[n];
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              i & (WINDOW_TEX_WIDTH - 1),
              i >> 8,
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              windows.data,
              i * 4,
            );
          }
        }
        return windows.dirtyCount > 0 || windows.fading;
      },
      draw(s) {
        if (quadCount === 0) {
          return;
        }
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        u.f2("uResolution", s.width, s.height);
        u.f1("uScale", s.scale);
        u.f2("uOffset", s.offsetX, s.offsetY);
        u.i1("uWindows", 0);
        u.v3("uBuilding", s.building);
        u.v3("uHaze", s.haze);
        u.f1("uWarmth", s.warmth);
        u.v3("uWarm", s.warm);
        u.v3("uCool", s.cool);
        u.v3("uTv", s.tv);
        if (windows.fading) {
          gl.uniform4fv(u.loc.uFade, windows.fade);
        }
        quads.draw(0, quadCount);
      },
      dispose: () => {
        scope.dispose();
      },
    };
  });
}
