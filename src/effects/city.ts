import { createChangeKey } from "./change-key";
import {
  BEACON_STRIDE,
  beaconPulse,
  createAircraft,
  createWindowState,
  FADE_SLOTS,
  generateCity,
  MAX_BEACONS,
  MAX_QUADS,
  MAX_STARS,
  QUAD_STRIDE,
  STAR_STRIDE,
  strobe,
  WINDOW_TEX_ROWS,
  WINDOW_TEX_WIDTH,
  type CityLayout,
} from "./city-sim";
import { unitRgbMemo } from "./color";
import {
  beginFrame,
  createDataTexture,
  createGradientBackground,
  createProgram,
  createUniforms,
  resetUnpackState,
  TO_CLIP_GLSL,
  updateDataTexture,
  withScope,
} from "./gl";
import { clamp } from "./math";
import { createSpriteBatch } from "./sprites";
import { cityMeta } from "./city.meta";
import { defineEffect } from "./types";

/** Light sprites: beacons, then the aircraft's two lights, then the stars. */
const PLANE_SLOTS = 2;
const MAX_LIGHTS = MAX_BEACONS + PLANE_SLOTS + MAX_STARS;
const LIGHT_STRIDE = 7;
/** Seconds per beacon pulse. */
const BEACON_PERIOD = 2.6;
const BEACON_RGB = [1, 0.13, 0.08] as const;
const STAR_RGB = [0.8, 0.86, 1] as const;
const STROBE_RGB = [1, 1, 1] as const;
const NAV_RGB = [1, 0.25, 0.2] as const;
/** Colour picks above this byte (of 255) are TV blue: about 2.5% of windows. */
const TV_PICK = 0.975;

/**
 * Building quads. Corners are `aCorner` (±1); everything else is per instance, in
 * 1080p reference px (y down), scaled by `uScale`. Quads are at least one device
 * pixel wide so thin antennas never vanish.
 */
const BUILDING_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aRect;
layout(location = 2) in vec4 aGrid;
layout(location = 3) in vec4 aWin;
layout(location = 4) in vec4 aMisc;
uniform vec2 uResolution;
uniform float uScale;
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
  gl_Position = pxToClip(centre + (t - 0.5) * size, uResolution);
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
uniform vec4 uFade[${FADE_SLOTS / 4}];
uniform vec3 uBuilding;
uniform vec3 uHaze;
uniform float uWarmth;
uniform float uScale;
out vec4 outColor;
const vec3 WARM = vec3(1.0, 0.7, 0.36);
const vec3 COOL = vec3(0.82, 0.88, 1.0);
const vec3 TV = vec3(0.32, 0.5, 1.0);
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
    vec4 w = texelFetch(uWindows, ivec2(idx & ${WINDOW_TEX_WIDTH - 1}, idx >> 8), 0);
    int slot = min(int(w.a * 255.0 + 0.5), ${FADE_SLOTS});
    float level = slot > 0 ? mix(w.r, w.g, uFade[(slot - 1) >> 2][(slot - 1) & 3]) : w.g;
    vec3 tint = w.b > ${TV_PICK} ? TV : (w.b < uWarmth * ${TV_PICK} ? WARM : COOL);
    // Unlit glass is a touch lighter than the wall; lit glass is tinted by layer.
    vec3 glass = wall * 1.25 + 0.006 + tint * (level * vMisc.z);
    glass = mix(glass, uHaze, vMisc.y * 0.35);
    color = mix(wall, glass, mask);
  }
  outColor = vec4(color, 1.0);
}
`;

/** Soft round lights (beacons, stars, aircraft) in reference px, added on top. */
const LIGHT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (reference px) and intensity. */
layout(location = 1) in vec4 aLight;
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
uniform float uScale;
out vec2 vLocal;
flat out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  float r = max(aLight.z * uScale, 1.5);
  vLocal = aCorner;
  vColor = aColor * aLight.w;
  gl_Position = pxToClip(aLight.xy * uScale + aCorner * r, uResolution);
}
`;

const LIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float d2 = dot(vLocal, vLocal);
  // A bright core in a soft halo, reaching zero at the quad's inscribed circle.
  float a = (exp(-d2 * 30.0) + 0.35 * exp(-d2 * 5.0)) * max(0.0, 1.0 - d2);
  outColor = vec4(vColor * a, 0.0);
}
`;

/**
 * A city skyline at night: building silhouettes in three hazy depth layers,
 * windows that occasionally fade on or off, pulsing red roof beacons and, now
 * and then, an aircraft blinking across the sky.
 */
export const city = defineEffect(cityMeta, {
  create(gl) {
    return withScope((scope) => {
      const buildingProgram = scope.add(
        createProgram(gl, BUILDING_VERTEX, BUILDING_FRAGMENT),
        (p) => gl.deleteProgram(p),
      );
      const bu = createUniforms(gl, buildingProgram, [
        "uResolution",
        "uScale",
        "uWindows",
        "uFade",
        "uBuilding",
        "uHaze",
        "uWarmth",
      ]);
      const lightProgram = scope.add(createProgram(gl, LIGHT_VERTEX, LIGHT_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const lu = createUniforms(gl, lightProgram, ["uResolution", "uScale"]);
      const background = scope.own(createGradientBackground(gl));
      const quads = scope.own(createSpriteBatch(gl, MAX_QUADS, [4, 4, 4, 4]));
      const lights = scope.own(createSpriteBatch(gl, MAX_LIGHTS, [4, 3]));
      const windows = createWindowState();
      const windowTexture = scope.add(
        createDataTexture(gl, {
          width: WINDOW_TEX_WIDTH,
          height: WINDOW_TEX_ROWS,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: windows.data,
          filter: gl.NEAREST,
        }),
        (t) => gl.deleteTexture(t),
      );
      const skyTop = unitRgbMemo();
      const skyHorizon = unitRgbMemo();
      const layoutKey = createChangeKey(3);

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let layout: CityLayout | undefined;
      let litWindows = Number.NaN;
      /** Beacon pulse phase in cycles, wrapped to [0, 1). */
      let beaconClock = 0;
      let plane = createAircraft(0);
      let planeSeed = Number.NaN;

      /** Writes the static star sprites after the beacon and aircraft slots. */
      const writeStars = (l: CityLayout) => {
        const d = lights.data;
        for (let i = 0; i < l.starCount; i++) {
          const o = (MAX_BEACONS + PLANE_SLOTS + i) * LIGHT_STRIDE;
          const s = i * STAR_STRIDE;
          d[o] = l.stars[s];
          d[o + 1] = l.stars[s + 1];
          d[o + 2] = l.stars[s + 2];
          d[o + 3] = l.stars[s + 3];
          d[o + 4] = STAR_RGB[0];
          d[o + 5] = STAR_RGB[1];
          d[o + 6] = STAR_RGB[2];
        }
        lights.upload(MAX_BEACONS + PLANE_SLOTS + l.starCount);
      };

      const writeLight = (
        slot: number,
        x: number,
        y: number,
        r: number,
        k: number,
        rgb: readonly number[],
      ) => {
        const d = lights.data;
        const o = slot * LIGHT_STRIDE;
        d[o] = x;
        d[o + 1] = y;
        d[o + 2] = r;
        d[o + 3] = k;
        d[o + 4] = rgb[0];
        d[o + 5] = rgb[1];
        d[o + 6] = rgb[2];
      };

      const uploadAllWindows = () => {
        gl.activeTexture(gl.TEXTURE0);
        const rows = Math.max(1, Math.ceil(windows.windowCount / WINDOW_TEX_WIDTH));
        updateDataTexture(
          gl,
          windowTexture,
          WINDOW_TEX_WIDTH,
          Math.min(rows, WINDOW_TEX_ROWS),
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          windows.data,
        );
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          const r = v.scale > 0 ? v.width / v.scale : 1920;
          refWidth = Math.round(clamp(Number.isFinite(r) ? r : 1920, 200, 8000));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);

          // Regenerate the skyline only when the seed, density or aspect changes.
          layoutKey.set(0, p.seed);
          layoutKey.set(1, p.density);
          layoutKey.set(2, refWidth);
          if (layoutKey.take() || !layout) {
            layout = generateCity(p.seed, p.density, refWidth);
            quads.data.set(layout.quads.subarray(0, layout.quadCount * QUAD_STRIDE));
            quads.upload(layout.quadCount);
            writeStars(layout);
            windows.reset(layout.windowCount, p.seed, p.litWindows);
            litWindows = p.litWindows;
            uploadAllWindows();
          } else if (p.litWindows !== litWindows) {
            litWindows = p.litWindows;
            windows.setLit(litWindows);
            uploadAllWindows();
          }
          if (p.seed !== planeSeed) {
            planeSeed = p.seed;
            plane = createAircraft(p.seed);
          }

          // Window fades: the CPU writes a texel only when a fade starts or settles.
          windows.step(dt, p.activity);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, windowTexture);
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

          // Sky, then stars (behind the buildings), then opaque buildings, then lights.
          background.draw(skyTop(p.skyTop), skyHorizon(p.skyHorizon));

          const l = layout;
          if (l.starCount > 0) {
            gl.useProgram(lightProgram);
            lu.f2("uResolution", width, height);
            lu.f1("uScale", scale);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            lights.draw(MAX_BEACONS + PLANE_SLOTS, l.starCount);
            gl.disable(gl.BLEND);
          }

          if (l.quadCount > 0) {
            gl.useProgram(buildingProgram);
            bu.f2("uResolution", width, height);
            bu.f1("uScale", scale);
            bu.i1("uWindows", 0);
            bu.rgb("uBuilding", p.buildings);
            bu.rgb("uHaze", p.skyHorizon);
            bu.f1("uWarmth", p.warmth);
            if (windows.fading) gl.uniform4fv(bu.loc.uFade, windows.fade);
            quads.draw(0, l.quadCount);
          }

          // Beacons pulse in sync per building; the aircraft strobes slowly.
          beaconClock = (beaconClock + dt / BEACON_PERIOD) % 1;
          const beaconCount = p.beacons ? l.beaconCount : 0;
          for (let i = 0; i < beaconCount; i++) {
            const b = i * BEACON_STRIDE;
            const k = beaconPulse(beaconClock + l.beacons[b + 3]);
            writeLight(i, l.beacons[b], l.beacons[b + 1], l.beacons[b + 2], k, BEACON_RGB);
          }
          plane.step(dt, refWidth, p.aircraft);
          const planeLights = plane.active ? PLANE_SLOTS : 0;
          if (plane.active) {
            writeLight(MAX_BEACONS, plane.x, plane.y, 3, 0.35, NAV_RGB);
            writeLight(MAX_BEACONS + 1, plane.x, plane.y, 6, strobe(plane.age), STROBE_RGB);
          }
          if (beaconCount + planeLights > 0) {
            // Upload the beacon and aircraft slots; the stars after them are static.
            lights.upload(MAX_BEACONS + PLANE_SLOTS);
            gl.useProgram(lightProgram);
            lu.f2("uResolution", width, height);
            lu.f1("uScale", scale);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            if (beaconCount > 0) lights.draw(0, beaconCount);
            if (planeLights > 0) lights.draw(MAX_BEACONS, planeLights);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
