import { createChangeKey } from "../change-key";
import {
  BEACON_STRIDE,
  beaconPulse,
  createAircraft,
  generateCity,
  MAX_BEACONS,
  MAX_STARS,
  STAR_STRIDE,
  strobe,
  type CityLayout,
} from "./city-sim";
import { COOL_RGB, createSkyline, type SkylineStyle, TV_RGB, WARM_RGB } from "./city-skyline";
import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createGradientBackground,
  createUniforms,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import { clamp } from "../math";
import { createSpriteBatch } from "../sprites";
import { cityMeta } from "./city.meta";
import { defineEffect } from "../types";

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
      const skyline = scope.own(createSkyline(gl));
      const lightProgram = scopedProgram(gl, scope, LIGHT_VERTEX, LIGHT_FRAGMENT);
      const lu = createUniforms(gl, lightProgram, ["uResolution", "uScale"]);
      const background = scope.own(createGradientBackground(gl));
      const lights = scope.own(createSpriteBatch(gl, MAX_LIGHTS, [4, 3]));
      const skyTop = unitRgbMemo();
      const skyHorizon = unitRgbMemo();
      const buildingRgb = unitRgbMemo();
      const style: SkylineStyle = {
        width: 1,
        height: 1,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        building: [0, 0, 0],
        haze: [0, 0, 0],
        warmth: 0,
        warm: WARM_RGB,
        cool: COOL_RGB,
        tv: TV_RGB,
      };
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
            writeStars(layout);
            skyline.setLayout(layout, p.seed, p.litWindows);
            litWindows = p.litWindows;
          } else if (p.litWindows !== litWindows) {
            litWindows = p.litWindows;
            skyline.setLit(litWindows);
          }
          if (p.seed !== planeSeed) {
            planeSeed = p.seed;
            plane = createAircraft(p.seed);
          }

          skyline.step(dt, p.activity);

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

          style.width = width;
          style.height = height;
          style.scale = scale;
          style.building = buildingRgb(p.buildings);
          style.haze = skyHorizon(p.skyHorizon);
          style.warmth = p.warmth;
          skyline.draw(style);

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
            if (beaconCount > 0) {
              lights.draw(0, beaconCount);
            }
            if (planeLights > 0) {
              lights.draw(MAX_BEACONS, planeLights);
            }
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
