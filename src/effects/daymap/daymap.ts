import { createChangeKey } from "../change-key";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import {
  createLatLon,
  createMapClock,
  latLonToPixel,
  latLonToVector,
  MAX_PINS,
  PIN_PRESETS,
  radiansPerPixel,
  subsolarPoint,
  sublunarPoint,
  TWILIGHT_WEIGHTS,
  twilightRamps,
} from "./daymap-sim";
import { wrap } from "../math";
import { HASH32_GLSL } from "../noise";
import { createSpriteBatch } from "../sprites";
import { daymapMeta } from "./daymap.meta";
import { has } from "../lookup";
import {
  LAND_MASK_BIAS,
  LAND_MASK_GAIN,
  LAND_MASK_WIDTH,
  loadLandMask,
  uploadLandMask,
} from "../land-mask";
import { defineEffect } from "../types";
import { createCanvasTexture } from "../canvas-texture";

/** City-light grid cell, in degrees. Each cell holds at most one light. */
const CITY_CELL = 2;
/** City-light radius at 1080p, in pixels. */
const CITY_RADIUS = 1.3;
/** Graticule spacing, in degrees. */
const GRID_STEP = 30;
/** Graticule and date-line width at 1080p, in pixels. */
const GRID_WIDTH = 1;
/** Moon marker radius at 1080p, in pixels. */
const MOON_RADIUS = 7;

/** Pin label slot at 1080p, in pixels: one per pin, stacked in the label atlas. */
const SLOT_W = 230;
const SLOT_H = 32;
/** Marker inset from the slot's end, and the gap from the marker to its text, at 1080p. */
const MARKER_INSET = 10;
const LABEL_GAP = 12;
const LABEL_FONT_PX = 16;
/** Label time steps, in milliseconds: every minute in real time, every 15 minutes in demo mode. */
const LABEL_STEP_REAL = 60000;
const LABEL_STEP_DEMO = 900000;

interface Style {
  ocean: string;
  /** Ocean colour near the coast. */
  shallow: string;
  land: string;
  /** Subtropical land colour, weighted by `desert`. */
  arid: string;
  /** Polar land colour. */
  ice: string;
  /** Coastline stroke colour, mixed in by `stroke`. */
  coast: string;
  /** Night multiplies the day colour by `nightMul` and adds `nightAdd`. */
  nightMul: string;
  nightAdd: string;
  /** Warm tint at the terminator, the subsolar glow and city lights (strength in the colour). */
  warm: string;
  glow: string;
  city: string;
  grid: string;
  desert: number;
  stroke: number;
  gridAlpha: number;
  /** Pin label text, halo and marker outline colours. */
  text: string;
  halo: string;
}

const STYLES: Record<string, Style> = {
  night: {
    ocean: "#17304d",
    shallow: "#1f4466",
    land: "#5e8073",
    arid: "#5e8073",
    ice: "#8fa7b2",
    coast: "#2c4c5c",
    nightMul: "#1c2647",
    nightAdd: "#02040b",
    warm: "#3a1d10",
    glow: "#2e2a1c",
    city: "#ffc970",
    grid: "#c8dcff",
    desert: 0,
    stroke: 0.35,
    gridAlpha: 0.14,
    text: "#ffffff",
    halo: "rgba(5,10,25,0.7)",
  },
  paper: {
    ocean: "#c9d8d5",
    shallow: "#d8e3de",
    land: "#ecdfc2",
    arid: "#ecdfc2",
    ice: "#f5f2e9",
    coast: "#9c8a6c",
    nightMul: "#5d6684",
    nightAdd: "#0a0d1a",
    warm: "#2c1408",
    glow: "#141008",
    city: "#ffe7a3",
    grid: "#6b5a45",
    desert: 0,
    stroke: 0.6,
    gridAlpha: 0.22,
    text: "#2a2620",
    halo: "rgba(250,245,232,0.8)",
  },
  satellite: {
    ocean: "#0b2847",
    shallow: "#18506f",
    land: "#4c6a35",
    arid: "#b39566",
    ice: "#e4ebef",
    coast: "#2f4628",
    nightMul: "#0e1630",
    nightAdd: "#010208",
    warm: "#40180a",
    glow: "#2a2618",
    city: "#ffbe62",
    grid: "#ffffff",
    desert: 0.85,
    stroke: 0,
    gridAlpha: 0.12,
    text: "#ffffff",
    halo: "rgba(0,0,0,0.65)",
  },
};
const STYLE_IDS = Object.keys(STYLES);
const PRESET_IDS = Object.keys(PIN_PRESETS);

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uMask;
/** Half the canvas size, in pixels. */
uniform vec2 uHalf;
/** Radians of longitude (and of Miller y) per pixel. */
uniform float uK;
/** Map centre longitude, radians. */
uniform float uCentre;
/** Unit vector to the sun, Earth-fixed (see latLonToVector). */
uniform vec3 uSun;
/** Twilight segment ramps in sin(elevation) (see twilightRamps). */
uniform vec4 uLo;
uniform vec4 uInvSpan;
/** Coastline anti-aliasing half-width, in mask texels. */
uniform float uAa;
/** 1080p-to-canvas pixel scale. */
uniform float uScale;
uniform vec3 uOcean;
uniform vec3 uShallow;
uniform vec3 uLand;
uniform vec3 uArid;
uniform vec3 uIce;
uniform vec3 uCoast;
uniform vec3 uNightMul;
uniform vec3 uNightAdd;
uniform vec3 uWarm;
uniform vec3 uGlow;
uniform vec3 uCity;
uniform vec3 uGrid;
/** Desert amount, coastline stroke, glow on/off, city lights on/off. */
uniform vec4 uLook;
/** Grid alpha, grid mode (0 none, 1 date line, 2 graticule). */
uniform vec2 uGridMode;
/** Moon marker centre in gl_FragCoord pixels, and its radius (0 hides it). */
uniform vec3 uMoon;

out vec4 outColor;

const float PI = 3.141592653589793;
const float DEG = PI / 180.0;
const vec4 WEIGHTS = vec4(${TWILIGHT_WEIGHTS.map((v) => glslFloat(v)).join(", ")});
const float LAND_MASK_GAIN = ${glslFloat(LAND_MASK_GAIN)};
const float LAND_MASK_BIAS = ${glslFloat(LAND_MASK_BIAS)};
const float CITY_CELL = ${glslFloat(CITY_CELL)};
const float CITY_K = ${glslFloat(1 / (CITY_RADIUS * CITY_RADIUS))};
const float GRID_STEP = ${glslFloat(GRID_STEP)};
const float GRID_HALF = ${glslFloat(GRID_WIDTH / 2)};
${HASH32_GLSL}
${DITHER_GLSL}
float millerY(float lat) {
  return 1.25 * log(tan(0.25 * PI + 0.4 * lat));
}

void main() {
  vec2 p = gl_FragCoord.xy - uHalf;
  // Longitude is left unwrapped (|lon| < 2 pi); the mask repeats and the hashes wrap it.
  float lon = uCentre + p.x * uK;
  float lat = clamp(2.5 * atan(exp(0.8 * p.y * uK)) - 0.625 * PI, -0.5 * PI, 0.5 * PI);
  float cl = cos(lat);
  vec3 n = vec3(cl * cos(lon), cl * sin(lon), sin(lat));
  float s = dot(n, uSun);
  float light = dot(clamp((s - uLo) * uInvSpan, 0.0, 1.0), WEIGHTS);

  // Land mask: a distance field in texels from the coast, positive on land.
  vec2 uv = vec2(lon * (0.5 / PI) + 0.5, 0.5 - lat / PI);
  float d = texture(uMask, uv).r * LAND_MASK_GAIN - LAND_MASK_BIAS;
  float land = smoothstep(-uAa, uAa, d);
  float latDeg = lat / DEG;
  float absLat = abs(latDeg);

  vec3 ocean = mix(uOcean, uShallow, smoothstep(-4.0, 0.0, d));
  float arid = uLook.x * smoothstep(12.0, 19.0, absLat) * (1.0 - smoothstep(30.0, 38.0, absLat));
  arid *= 0.5 + 0.5 * smoothstep(0.0, 3.0, d);
  vec3 ground = mix(mix(uLand, uArid, arid), uIce, smoothstep(66.0, 74.0, absLat));
  vec3 base = mix(ocean, ground, land);
  base = mix(base, uCoast, uLook.y * (1.0 - smoothstep(0.0, 2.5 * uAa, abs(d))));

  vec3 col = mix(base * uNightMul + uNightAdd, base, light);
  float t = light * (1.0 - light) * 4.0;
  col += uWarm * (t * t);
  // Subsolar glow: about a quarter strength 30 degrees from the subsolar point.
  col += uGlow * (uLook.z * exp2((s - 1.0) * 14.0));

  float dark = 1.0 - light;
  if (uLook.w > 0.5 && land > 0.0 && dark > 0.0) {
    float lonDeg = mod(lon / DEG + 180.0, 360.0) - 180.0;
    vec2 deg = vec2(lonDeg, latDeg);
    vec2 cell = floor(deg / CITY_CELL);
    uint h = hash32(uint(cell.x + 200.0) + uint(cell.y + 100.0) * 512u);
    float r0 = float(h & 0xffffu) / 65535.0;
    vec2 jitter = vec2(float((h >> 16) & 0xffu), float(h >> 24)) / 255.0;
    // Lights crowd the coasts and thin out towards the poles.
    float coast = 1.0 - smoothstep(0.5, 4.0, d);
    float density = mix(0.12, 0.65, coast) * (1.0 - smoothstep(55.0, 68.0, absLat));
    vec2 dp = (deg - (cell + 0.25 + 0.5 * jitter) * CITY_CELL) * (DEG / uK);
    dp.y /= cos(0.8 * lat);
    float r2 = dot(dp, dp) / (uScale * uScale);
    float lit = step(r0, density) * (0.45 + 0.55 * fract(r0 * 37.0)) * exp2(-r2 * CITY_K);
    lit += 0.07 * coast * (1.0 - smoothstep(55.0, 68.0, absLat));
    col += uCity * (lit * land * dark * dark);
  }

  if (uGridMode.y > 0.5) {
    float lonDeg = lon / DEG;
    // The date line alone is the 180 degree meridian; the graticule every 30 degrees includes it.
    float stepLon = uGridMode.y > 1.5 ? GRID_STEP : 360.0;
    float a = (lonDeg - 180.0) / stepLon;
    float dx = abs(a - round(a)) * stepLon * DEG / uK;
    float dist = dx;
    if (uGridMode.y > 1.5) {
      float k = clamp(round(latDeg / GRID_STEP), -2.0, 2.0) * GRID_STEP;
      dist = min(dist, abs(p.y - millerY(k * DEG) / uK));
    }
    float hw = GRID_HALF * uScale;
    col = mix(col, uGrid, uGridMode.x * (1.0 - smoothstep(hw - 0.5, hw + 0.5, dist)));
  }

  if (uMoon.z > 0.0) {
    float period = 2.0 * PI / uK;
    vec2 dm = gl_FragCoord.xy - uMoon.xy;
    dm.x -= period * round(dm.x / period);
    float r = length(dm);
    float disc = 1.0 - smoothstep(uMoon.z - 0.75, uMoon.z + 0.75, r);
    float rim = 1.0 - smoothstep(0.0, 1.0, abs(r - uMoon.z - uScale));
    col = mix(col, vec3(0.04, 0.05, 0.09), 0.6 * rim);
    col = mix(col, vec3(0.9, 0.92, 0.96), 0.85 * disc);
  }

  outColor = vec4(clamp(col + dither8(gl_FragCoord.xy), 0.0, 1.0), 1.0);
}
`;

/** Pin label quads: one per pin, textured from the label atlas. */
const PIN_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Top-left corner and size in canvas pixels (y down). */
layout(location = 1) in vec4 aRect;
/** Atlas texture coordinates of the top-left and bottom-right corners. */
layout(location = 2) in vec4 aUv;
uniform vec2 uResolution;
out vec2 vUv;
${TO_CLIP_GLSL}
void main() {
  vec2 t = aCorner * 0.5 + 0.5;
  vUv = mix(aUv.xy, aUv.zw, t);
  gl_Position = pxToClip(aRect.xy + t * aRect.zw, uResolution);
}
`;

const PIN_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D uAtlas;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uAtlas, vUv);
}
`;

/**
 * A flat world map showing where it is day and night right now. One full-screen
 * pass maps each pixel to latitude and longitude (Miller projection), shades it by
 * the sun's elevation through the twilight bands, and looks up land in a signed
 * distance field; city pins and their local times are a few textured quads.
 */
export const daymap = defineEffect(daymapMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const pinProgram = scopedProgram(gl, scope, PIN_VERTEX, PIN_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const pins = scope.own(createSpriteBatch(gl, MAX_PINS, [4, 4]));
      // Until the mask loads, a single "far out at sea" texel: day and night over plain ocean.
      const mask = scope.add(
        createDataTexture(gl, {
          width: 1,
          height: 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: new Uint8Array([0]),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const labelAtlas = createCanvasTexture(gl, scope);
      const atlas = labelAtlas.texture;

      const u = createUniforms(gl, program, [
        "uMask",
        "uHalf",
        "uK",
        "uCentre",
        "uSun",
        "uLo",
        "uInvSpan",
        "uAa",
        "uScale",
        "uOcean",
        "uShallow",
        "uLand",
        "uArid",
        "uIce",
        "uCoast",
        "uNightMul",
        "uNightAdd",
        "uWarm",
        "uGlow",
        "uCity",
        "uGrid",
        "uLook",
        "uGridMode",
        "uMoon",
      ]);
      const pu = createUniforms(gl, pinProgram, ["uAtlas", "uResolution"]);
      gl.useProgram(program);
      u.i1("uMask", 0);
      gl.useProgram(pinProgram);
      pu.i1("uAtlas", 0);

      // Load the mask in the background; the next frame uploads it.
      const maskImage = loadLandMask(scope, "Daylight World Map");

      const clock = createMapClock();
      const sun = createLatLon();
      const moon = createLatLon();
      const sunVec: [number, number, number] = [0, 0, 0];
      const px: [number, number] = [0, 0];
      const lo = new Float32Array(4);
      const hi = new Float32Array(4);
      let lastTwilight = "";

      // Pin labels: drawn on a 2D canvas only when the text, layout or scale changes.
      let canvas: OffscreenCanvas | undefined;
      let slotW = 0;
      let slotH = 0;
      const labelKey = createChangeKey(6);
      const date = new Date(0);
      const formats = new Map<string, Intl.DateTimeFormat>();
      const formatFor = (zone: string) => {
        let f = formats.get(zone);
        if (!f) {
          f = new Intl.DateTimeFormat("en-GB", {
            timeZone: zone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          });
          formats.set(zone, f);
        }
        return f;
      };

      let width = 1;
      let height = 1;
      let scale = 1;

      const drawLabels = (preset: string, styleId: string, labelMs: number, sides: number) => {
        const cities = PIN_PRESETS[preset];
        const style = STYLES[styleId];
        const w = Math.ceil(SLOT_W * scale);
        const h = Math.ceil(SLOT_H * scale);
        if (!canvas || slotW !== w || slotH !== h) {
          canvas = new OffscreenCanvas(w, h * MAX_PINS);
          slotW = w;
          slotH = h;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          return;
        }
        ctx.clearRect(0, 0, w, h * MAX_PINS);
        ctx.font = `600 ${String(Math.round(LABEL_FONT_PX * scale))}px system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        date.setTime(labelMs);
        const inset = MARKER_INSET * scale;
        const gap = LABEL_GAP * scale;
        for (let i = 0; i < cities.length; i++) {
          const c = cities[i];
          const left = (sides >> i) & 1;
          const mx = left ? w - inset : inset;
          const my = (i + 0.5) * h;
          ctx.beginPath();
          ctx.arc(mx, my, 4.5 * scale, 0, Math.PI * 2);
          ctx.fillStyle = style.text;
          ctx.strokeStyle = style.halo;
          ctx.lineWidth = 2 * scale;
          ctx.fill();
          ctx.stroke();
          const text = `${c.name}  ${formatFor(c.zone).format(date)}`;
          ctx.textAlign = left ? "right" : "left";
          const tx = left ? mx - gap : mx + gap;
          ctx.lineWidth = 3.5 * scale;
          ctx.strokeText(text, tx, my);
          ctx.fillText(text, tx, my);
        }
        labelAtlas.upload(canvas);
      };

      return {
        resize(v) {
          width = v.width;
          height = v.height;
          scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const ms = clock.step(dt, p.demo);
          const styleId = has(STYLES, p.style) ? p.style : "night";
          const style = STYLES[styleId];
          const centre = wrap(p.centre, -180, 360);
          const k = radiansPerPixel(width, height);

          gl.activeTexture(gl.TEXTURE0);
          const image = maskImage.take();
          if (image) {
            gl.bindTexture(gl.TEXTURE_2D, mask);
            uploadLandMask(gl, image);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
          }

          gl.useProgram(program);
          gl.bindTexture(gl.TEXTURE_2D, mask);
          u.f2("uHalf", 0.5 * width, 0.5 * height);
          u.f1("uK", k);
          u.f1("uCentre", (centre * Math.PI) / 180);
          u.f1("uScale", scale);
          // Smooth coastlines over about one and a half pixels.
          u.f1("uAa", Math.max(0.05, (0.75 * k * LAND_MASK_WIDTH) / (2 * Math.PI)));
          u.v3("uSun", latLonToVector(subsolarPoint(ms, sun), sunVec));
          if (p.twilight !== lastTwilight) {
            lastTwilight = p.twilight;
            twilightRamps(p.twilight === "bands" ? "bands" : "smooth", lo, hi);
            u.f4("uLo", lo[0], lo[1], lo[2], lo[3]);
            u.f4(
              "uInvSpan",
              1 / (hi[0] - lo[0]),
              1 / (hi[1] - lo[1]),
              1 / (hi[2] - lo[2]),
              1 / (hi[3] - lo[3]),
            );
          }
          u.rgb("uOcean", style.ocean);
          u.rgb("uShallow", style.shallow);
          u.rgb("uLand", style.land);
          u.rgb("uArid", style.arid);
          u.rgb("uIce", style.ice);
          u.rgb("uCoast", style.coast);
          u.rgb("uNightMul", style.nightMul);
          u.rgb("uNightAdd", style.nightAdd);
          u.rgb("uWarm", style.warm);
          u.rgb("uGlow", style.glow);
          u.rgb("uCity", style.city);
          u.rgb("uGrid", style.grid);
          u.f4("uLook", style.desert, style.stroke, p.glow ? 1 : 0, p.cities ? 1 : 0);
          u.f2(
            "uGridMode",
            style.gridAlpha,
            p.grid === "graticule" ? 2 : p.grid === "dateline" ? 1 : 0,
          );
          if (p.moon) {
            latLonToPixel(sublunarPoint(ms, moon), width, height, centre, px);
            // gl_FragCoord has y up.
            u.f3("uMoon", px[0], height - px[1], MOON_RADIUS * scale);
          } else {
            u.f3("uMoon", 0, 0, 0);
          }
          triangle.draw();

          const cities = PIN_PRESETS[p.pins] ?? PIN_PRESETS.none;
          if (cities.length === 0) {
            return;
          }
          // Labels sit right of their marker unless that would run off the right edge.
          const w = Math.ceil(SLOT_W * scale);
          const h = Math.ceil(SLOT_H * scale);
          const inset = MARKER_INSET * scale;
          let sides = 0;
          const data = pins.data;
          for (let i = 0; i < cities.length; i++) {
            latLonToPixel(cities[i], width, height, centre, px);
            const left = px[0] + w - inset > width ? 1 : 0;
            sides |= left << i;
            const o = i * pins.stride;
            data[o] = Math.round(px[0] - (left ? w - inset : inset));
            data[o + 1] = Math.round(px[1] - 0.5 * h);
            data[o + 2] = w;
            data[o + 3] = h;
            data[o + 4] = 0;
            data[o + 5] = i / MAX_PINS;
            data[o + 6] = 1;
            data[o + 7] = (i + 1) / MAX_PINS;
          }
          const step = p.demo ? LABEL_STEP_DEMO : LABEL_STEP_REAL;
          const labelMs = Math.floor(ms / step) * step;
          labelKey.set(0, PRESET_IDS.indexOf(p.pins));
          labelKey.set(1, STYLE_IDS.indexOf(styleId));
          labelKey.set(2, labelMs);
          labelKey.set(3, sides);
          labelKey.set(4, w);
          labelKey.set(5, h);
          if (labelKey.take()) {
            drawLabels(p.pins, styleId, labelMs, sides);
          }
          pins.upload(cities.length);

          gl.useProgram(pinProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, atlas);
          pu.f2("uResolution", width, height);
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
          pins.draw(0, cities.length);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
