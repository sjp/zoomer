import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  resetUnpackState,
  updateDataTexture,
  withScope,
} from "./gl";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { fract } from "./math";
import { buildPeriodicNoiseTexture, hash32, HASH32_GLSL } from "./noise";
import {
  advanceOffsets,
  advanceSweep,
  buildColourScale,
  buildTerrain,
  FRONT_AHEAD,
  FRONT_BEHIND,
  formatStamp,
  frontPosition,
  MAX_CELLS,
  NOISE_PERIODS,
  NOISE_TILE,
  OFFSET_PAIRS,
  PALETTES,
  placeLabels,
  RANGE,
  radarCentre,
  RING_COUNT,
  SCALE_SIZE,
  TERRAIN_COLS,
  TERRAIN_ROWS,
  TERRAIN_SPAN,
  type TerrainRegion,
  WIND_SPEED,
  WIND_X,
  WIND_Y,
  windSpan,
  writeStormCells,
} from "./radar-sim";
import { radarMeta } from "./radar.meta";
import { has } from "./lookup";
import { defineEffect } from "./types";

/** The Daylight World Map's land mask (see daymap.ts): a 1024x512 equirectangular distance field. */
const MASK_URL = `${import.meta.env.BASE_URL}land-mask.png`;
const MASK_GAIN = 255 / 8;
const MASK_BIAS = 128 / 8;
/** "World map" crop: centre longitude and latitude, and degrees of latitude per canvas height. */
const WORLD_LON = 22;
const WORLD_LAT = 50;
const WORLD_SPAN = 34;

/** Rain grid divisors: the radar look is blocky by nature, so even "High" is coarse. */
const DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** Rain noise texture size; the octave periods divide it. */
const NOISE_SIZE = 128;
/** Map grid spacing, in q units. */
const GRID_STEP = 1 / 6;
/** Amplitude of the shader's coastline detail on top of the CPU terrain, in terrain units. */
const DETAIL = 0.05;
/** Sweep line half-width at 1080p, in pixels, and the wedge's angular falloff (per radian, base 2). */
const SWEEP_LINE = 1.5;
const WEDGE_K = 1.6;
/** Place-label and timestamp text at 1080p, in pixels. */
const LABEL_FONT_PX = 15;
const STAMP_FONT_PX = 16;
const STAMP_W = 250;
const STAMP_H = 30;
const STAMP_MARGIN = 26;

const REGION_IDS: readonly (TerrainRegion | "world")[] = ["coast", "islands", "inland", "world"];
const PALETTE_IDS = Object.keys(PALETTES);

/** The rain noise: one tiling octave per channel, shared by every instance. */
let noiseData: Uint8Array | undefined;
const getNoiseData = () => {
  noiseData ??= buildPeriodicNoiseTexture(
    NOISE_SIZE,
    NOISE_PERIODS.map((period, i) => ({ period, seed: 1051 + i })),
  );
  return noiseData;
};

/** The static map: land and sea, coastline, grid, range rings and labels. Drawn on rebuild only. */
const MAP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uTerrain;
uniform sampler2D uMask;
uniform sampler2D uLabels;
uniform vec2 uSize;
uniform int uWorld;
uniform float uLabelsOn;
uniform uint uSeed;
/** Radar centre and range, in q units. */
uniform vec2 uCentre;
uniform float uRange;
uniform float uScale;
uniform vec3 uSea;
uniform vec3 uLand;
uniform vec3 uCoast;
uniform vec3 uGrid;
uniform vec3 uRing;

out vec4 outColor;

const float DEG = 0.017453292519943295;
const float MASK_GAIN = ${glslFloat(MASK_GAIN)};
const float MASK_BIAS = ${glslFloat(MASK_BIAS)};
const float WORLD_LON = ${glslFloat(WORLD_LON)};
const float WORLD_LAT = ${glslFloat(WORLD_LAT)};
const float WORLD_SPAN = ${glslFloat(WORLD_SPAN)};
const float TERRAIN_SPAN = ${glslFloat(TERRAIN_SPAN)};
const float DETAIL = ${glslFloat(DETAIL)};
const float GRID_STEP = ${glslFloat(GRID_STEP)};
const float RING_COUNT = ${glslFloat(RING_COUNT)};
${HASH32_GLSL}
${DITHER_GLSL}
float lattice(vec2 i) {
  uvec2 u = uvec2(i);
  return float(hash32(u.x * 73856093u ^ u.y * 19349663u ^ uSeed) >> 8) * (1.0 / 16777216.0);
}

/** Value noise in [0, 1], for p >= 0. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = lattice(i);
  float b = lattice(i + vec2(1.0, 0.0));
  float c = lattice(i + vec2(0.0, 1.0));
  float d = lattice(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/** Coverage of a line dist pixels away with half-width hw pixels. */
float line(float dist, float hw) {
  return 1.0 - smoothstep(hw - 0.5, hw + 0.5, dist);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 q = vec2(fc.x, uSize.y - fc.y) / uSize.y;
  float pxPerQ = uSize.y;

  float d;
  if (uWorld == 1) {
    float lon = WORLD_LON + (q.x - 0.5 * uSize.x / uSize.y) * WORLD_SPAN / cos(WORLD_LAT * DEG);
    float lat = WORLD_LAT - (q.y - 0.5) * WORLD_SPAN;
    d = texture(uMask, vec2(lon / 360.0 + 0.5, 0.5 - lat / 180.0)).r * MASK_GAIN - MASK_BIAS;
  } else {
    d = texture(uTerrain, vec2(q.x / TERRAIN_SPAN, q.y)).r;
    d += DETAIL * (vnoise(q * 48.0) - 0.5) + 0.5 * DETAIL * (vnoise(q * 130.0) - 0.5);
  }
  // Signed distance to the coast in pixels, roughly.
  float sd = d / max(fwidth(d), 1e-6);
  float land = smoothstep(-0.75, 0.75, sd);
  vec3 col = mix(uSea, uLand, land);
  col = mix(col, uCoast, 0.75 * line(abs(sd), 0.6 * uScale));

  vec2 g = abs(fract(q / GRID_STEP + 0.5) - 0.5) * (GRID_STEP * pxPerQ);
  col = mix(col, uGrid, 0.6 * line(min(g.x, g.y), 0.5 * uScale));

  vec2 dc = q - uCentre;
  float dist = length(dc);
  float inRange = step(dist, uRange);
  float ringStep = uRange / RING_COUNT;
  float rd = abs(fract(dist / ringStep + 0.5) - 0.5) * ringStep * pxPerQ;
  float ring = line(rd, 0.6 * uScale) * step(0.5 * ringStep, dist) * step(dist, uRange + 0.5 * ringStep);
  col = mix(col, uRing, 0.45 * ring);
  vec2 spokes = abs(dc) * pxPerQ;
  col = mix(col, uRing, 0.16 * inRange * line(min(spokes.x, spokes.y), 0.5 * uScale));
  col = mix(col, uRing, 0.8 * line(dist * pxPerQ, 2.5 * uScale));
  // Beyond the radar's range: a little darker, as nothing is measured there.
  col *= mix(0.7, 1.0, smoothstep(uRange + 2.0 / pxPerQ, uRange, dist));

  if (uLabelsOn > 0.5) {
    vec4 l = texture(uLabels, vec2(fc.x / uSize.x, 1.0 - fc.y / uSize.y));
    col = mix(col, l.rgb, l.a);
  }
  outColor = vec4(clamp(col + dither8(fc), 0.0, 1.0), 1.0);
}
`;

/** Rain intensity at reduced resolution: advected noise, a front band or storm cells. */
const RAIN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uNoise;
uniform float uAspect;
/** Noise offsets: octaves 0 and 1, octaves 2 and 3, and the coverage field. */
uniform vec4 uOff01;
uniform vec4 uOff23;
uniform vec2 uOffCov;
/** 0 showers, 1 front, 2 storm cells. */
uniform int uMode;
/** Front line position along the wind. */
uniform float uFront;
/** Storm cells: centre x, y, radius (q units) and intensity. */
uniform vec4 uCells[${String(MAX_CELLS)}];
uniform vec2 uCentre;
uniform float uRange;

in vec2 vUv;
out vec4 outColor;

const vec2 WIND = vec2(${glslFloat(WIND_X)}, ${glslFloat(WIND_Y)});
const float INV_TILE = ${glslFloat(1 / NOISE_TILE)};
const float FRONT_AHEAD = ${glslFloat(FRONT_AHEAD)};
const float FRONT_BEHIND = ${glslFloat(FRONT_BEHIND)};

void main() {
  vec2 q = vec2(vUv.x * uAspect, 1.0 - vUv.y);
  vec2 uv = q * INV_TILE;
  float o0 = texture(uNoise, uv - uOff01.xy).r;
  float o1 = texture(uNoise, uv - uOff01.zw).g;
  float o2 = texture(uNoise, uv - uOff23.xy).b;
  float o3 = texture(uNoise, uv - uOff23.zw).a;
  float cov = texture(uNoise, uv - uOffCov).r;
  // Roughly unit spread around 0.
  float m = (0.5 * o0 + 0.27 * o1 + 0.15 * o2 + 0.08 * o3 - 0.5) * 10.0;
  float c = (cov - 0.5) * 5.0;
  float showers = clamp((m + 0.6 * c - 0.6) * 0.42, 0.0, 1.0);

  float rain = showers;
  if (uMode == 1) {
    float ds = dot(q, WIND) - uFront + 0.5 * (o0 - 0.5);
    float w = ds > 0.0 ? FRONT_AHEAD : FRONT_BEHIND;
    float band = exp(-(ds * ds) / (w * w));
    rain = max(band * (0.42 + 0.32 * m), 0.6 * showers);
  } else if (uMode == 2) {
    vec2 p = q + 0.05 * vec2(o1 - 0.5, o2 - 0.5);
    float sum = 0.0;
    for (int i = 0; i < ${String(MAX_CELLS)}; i++) {
      vec4 cell = uCells[i];
      vec2 d = p - cell.xy;
      sum += cell.w * exp(-dot(d, d) / (cell.z * cell.z));
    }
    rain = max(sum * (0.85 + 0.12 * m), 0.5 * showers);
  }
  rain *= 1.0 - smoothstep(0.96 * uRange, uRange, length(q - uCentre));
  outColor = vec4(rain, 0.0, 0.0, 1.0);
}
`;

/** Full-resolution composite: map, colour-scaled rain, sweep and timestamp. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uLut;
uniform sampler2D uStamp;
/** Radar centre in gl_FragCoord pixels, and the range in pixels. */
uniform vec2 uCentrePx;
uniform float uRangePx;
/** Sweep direction (cos, sin; y down) and on/off; sweep angle in radians. */
uniform vec3 uSweep;
uniform float uSweepAngle;
uniform float uLineW;
uniform vec3 uSweepCol;
/** Timestamp rectangle in gl_FragCoord pixels: left, bottom, width, height. */
uniform vec4 uStampRect;

const float TAU = 6.283185307179586;
const float LUT_SCALE = ${glslFloat((SCALE_SIZE - 1) / SCALE_SIZE)};
const float LUT_BIAS = ${glslFloat(0.5 / SCALE_SIZE)};
const float WEDGE_K = ${glslFloat(WEDGE_K)};

vec4 composite(vec2 uv) {
  vec3 col = texture(uMap, uv).rgb;
  float r = texture(uLowRes, uv).r;
  vec4 rain = texture(uLut, vec2(r * LUT_SCALE + LUT_BIAS, 0.5));
  if (uSweep.z > 0.5) {
    // y down, so the angle grows clockwise on screen like the sweep.
    vec2 p = (gl_FragCoord.xy - uCentrePx) * vec2(1.0, -1.0);
    float dist = length(p);
    float inRange = 1.0 - smoothstep(uRangePx - 2.0, uRangePx, dist);
    float ang = dist > 0.5 ? atan(p.y, p.x) : uSweepAngle;
    float behind = mod(uSweepAngle - ang, TAU);
    float wedge = exp2(-behind * WEDGE_K) * inRange;
    float along = dot(p, uSweep.xy);
    float perp = abs(p.x * uSweep.y - p.y * uSweep.x);
    float beam = step(0.0, along) * (1.0 - smoothstep(0.0, uLineW, perp)) * inRange;
    col = mix(col, rain.rgb * (1.0 + 0.3 * wedge), rain.a);
    col += uSweepCol * (0.09 * wedge + 0.4 * beam);
  } else {
    col = mix(col, rain.rgb, rain.a);
  }
  vec2 s = (gl_FragCoord.xy - uStampRect.xy) / uStampRect.zw;
  if (s.x >= 0.0 && s.y >= 0.0 && s.x <= 1.0 && s.y <= 1.0) {
    vec4 t = texture(uStamp, vec2(s.x, 1.0 - s.y));
    col = mix(col, t.rgb, t.a);
  }
  return vec4(col, 1.0);
}
`;

/**
 * A stylised weather radar. The map (land, coastline, grid, range rings and place
 * labels) is baked into a full-size texture whenever the size, region, palette or
 * seed changes. Each frame, one reduced-resolution pass computes rain intensity
 * from drifting noise octaves (plus a front band or storm cells), and one
 * full-resolution composite colours it through the radar scale, adds the sweep
 * and the timestamp.
 */
export const radar = defineEffect(radarMeta, {
  create(gl) {
    return withScope((scope) => {
      const mapProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, MAP_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const rainProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, RAIN_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const triangle = scope.own(createFullscreenTriangle(gl));
      const terrain = scope.own(createColumnTable(gl, TERRAIN_COLS, 1, { rows: TERRAIN_ROWS }));
      const rgba8 = (width: number, height: number, data: Uint8Array, wrapMode?: GLenum) =>
        scope.add(
          createDataTexture(gl, {
            width,
            height,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data,
            wrap: wrapMode,
          }),
          (t) => {
            gl.deleteTexture(t);
          },
        );
      const noise = rgba8(NOISE_SIZE, NOISE_SIZE, getNoiseData(), gl.REPEAT);
      const lutData = new Uint8Array(SCALE_SIZE * 4);
      const lut = rgba8(SCALE_SIZE, 1, lutData);
      const labelTex = rgba8(1, 1, new Uint8Array(4));
      const stampTex = rgba8(1, 1, new Uint8Array(4));
      // Until the land mask loads: one "far out at sea" texel.
      const mask = scope.add(
        createDataTexture(gl, {
          width: 1,
          height: 1,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: new Uint8Array([0]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      let mapTarget: RenderTarget | null = null;
      scope.defer(() => mapTarget?.dispose());

      const mu = createUniforms(gl, mapProgram, [
        "uTerrain",
        "uMask",
        "uLabels",
        "uSize",
        "uWorld",
        "uLabelsOn",
        "uSeed",
        "uCentre",
        "uRange",
        "uScale",
        "uSea",
        "uLand",
        "uCoast",
        "uGrid",
        "uRing",
      ]);
      const ru = createUniforms(gl, rainProgram, [
        "uNoise",
        "uAspect",
        "uOff01",
        "uOff23",
        "uOffCov",
        "uMode",
        "uFront",
        "uCells",
        "uCentre",
        "uRange",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uMap",
        "uLut",
        "uStamp",
        "uCentrePx",
        "uRangePx",
        "uSweep",
        "uSweepAngle",
        "uLineW",
        "uSweepCol",
        "uStampRect",
      ]);
      gl.useProgram(mapProgram);
      mu.i1("uTerrain", 0);
      mu.i1("uMask", 1);
      mu.i1("uLabels", 2);
      gl.useProgram(rainProgram);
      ru.i1("uNoise", 0);
      gl.useProgram(target.program);
      cu.i1("uMap", 1);
      cu.i1("uLut", 2);
      cu.i1("uStamp", 3);

      // Load the land mask in the background; the next frame uploads it and re-bakes.
      let pendingMask: HTMLImageElement | undefined;
      let maskLoaded = 0;
      if (typeof Image !== "undefined") {
        const img = new Image();
        img.decoding = "async";
        const onLoad = () => {
          pendingMask = img;
        };
        const onError = () => {
          console.warn(`Weather Radar: couldn't load ${MASK_URL}`);
        };
        img.addEventListener("load", onLoad);
        img.addEventListener("error", onError);
        img.src = MASK_URL;
        scope.defer(() => {
          img.removeEventListener("load", onLoad);
          img.removeEventListener("error", onError);
          pendingMask = undefined;
        });
      }

      const terrainKey = createChangeKey(2);
      const mapKey = createChangeKey(6);
      const lutKey = createChangeKey(1);
      const stampKey = createChangeKey(4);
      const centre: [number, number] = [0, 0];
      const span: [number, number] = [0, 0];
      const offsets = new Float32Array(OFFSET_PAIRS * 2);
      const cells = new Float32Array(MAX_CELLS * 4);
      const date = new Date(0);
      let offsetSeed = Number.NaN;
      /** Weather seconds (speed-scaled) and front travel in q units: float64, unwrapped. */
      let weatherTime = 0;
      let frontTravel = 0;
      let sweepAngle = 0;
      let labelCanvas: OffscreenCanvas | undefined;
      let stampCanvas: OffscreenCanvas | undefined;

      let width = 1;
      let height = 1;
      let scale = 1;

      const canvas2d = (c: OffscreenCanvas | undefined, w: number, h: number) => {
        if (typeof OffscreenCanvas === "undefined") {
          return undefined;
        }
        if (!c || c.width !== w || c.height !== h) {
          c = new OffscreenCanvas(w, h);
        }
        return c;
      };
      const uploadCanvas = (tex: WebGLTexture, c: OffscreenCanvas) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        resetUnpackState(gl);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
      };

      /** Draws the place labels for the current terrain onto a canvas-sized texture. */
      const drawLabels = (seed: number, paletteId: string): boolean => {
        labelCanvas = canvas2d(labelCanvas, width, height);
        const ctx = labelCanvas?.getContext("2d");
        if (!labelCanvas || !ctx) {
          return false;
        }
        const palette = PALETTES[paletteId];
        ctx.clearRect(0, 0, width, height);
        ctx.font = `500 ${String(Math.round(LABEL_FONT_PX * scale))}px system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.lineJoin = "round";
        ctx.fillStyle = palette.text;
        ctx.strokeStyle = palette.sea;
        ctx.lineWidth = 3 * scale;
        for (const l of placeLabels(terrain.data, width / height, seed)) {
          const x = l.x * height;
          const y = l.y * height;
          const r = 2.5 * scale;
          ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
          ctx.strokeText(l.name, x + 8 * scale, y);
          ctx.fillText(l.name, x + 8 * scale, y);
        }
        uploadCanvas(labelTex, labelCanvas);
        return true;
      };

      const bakeMap = (region: string, seed: number, paletteId: string) => {
        if (!mapTarget || mapTarget.width !== width || mapTarget.height !== height) {
          mapTarget?.dispose();
          mapTarget = null;
          mapTarget = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          if (!mapTarget) {
            throw new Error("Weather Radar: RGBA8 is not renderable");
          }
        }
        const world = region === "world";
        const labels = !world && drawLabels(seed, paletteId);
        const palette = PALETTES[paletteId];
        gl.useProgram(mapProgram);
        mu.f2("uSize", width, height);
        mu.i1("uWorld", world ? 1 : 0);
        mu.f1("uLabelsOn", labels ? 1 : 0);
        mu.u1("uSeed", hash32(seed));
        mu.f2("uCentre", centre[0], centre[1]);
        mu.f1("uRange", RANGE);
        mu.f1("uScale", scale);
        mu.rgb("uSea", palette.sea);
        mu.rgb("uLand", palette.land);
        mu.rgb("uCoast", palette.coast);
        mu.rgb("uGrid", palette.grid);
        mu.rgb("uRing", palette.ring);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, terrain.texture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, mask);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, labelTex);
        mapTarget.bind();
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
      };

      const drawStamp = (ms: number, paletteId: string, w: number, h: number) => {
        stampCanvas = canvas2d(stampCanvas, w, h);
        const ctx = stampCanvas?.getContext("2d");
        if (!stampCanvas || !ctx) {
          return;
        }
        const palette = PALETTES[paletteId];
        date.setTime(ms);
        ctx.clearRect(0, 0, w, h);
        ctx.font = `500 ${String(Math.round(STAMP_FONT_PX * scale))}px ui-monospace, monospace`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "right";
        ctx.lineJoin = "round";
        ctx.lineWidth = 3 * scale;
        ctx.strokeStyle = palette.sea;
        ctx.fillStyle = palette.text;
        const text = formatStamp(date);
        ctx.strokeText(text, w - 2 * scale, h / 2);
        ctx.fillText(text, w - 2 * scale, h / 2);
        uploadCanvas(stampTex, stampCanvas);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.floor(v.width));
          height = Math.max(1, Math.floor(v.height));
          scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const aspect = width / height;
          const regionIndex = Math.max(0, (REGION_IDS as readonly string[]).indexOf(p.region));
          const region = REGION_IDS[regionIndex];
          const paletteId = has(PALETTES, p.palette) ? p.palette : "classic";
          const palette = PALETTES[paletteId];
          const seed = Math.round(p.seed);
          radarCentre(aspect, centre);

          // Weather clocks: the rain always moves (at `speed`); the sweep is independent.
          if (seed !== offsetSeed) {
            offsetSeed = seed;
            for (let i = 0; i < offsets.length; i++) {
              offsets[i] = fract(seed * 0.6180339887 + i * 0.37);
            }
          }
          const travel = step * p.speed * WIND_SPEED;
          weatherTime += step * p.speed;
          frontTravel += travel;
          advanceOffsets(offsets, travel);
          sweepAngle = advanceSweep(sweepAngle, step);

          if (pendingMask) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, mask);
            resetUnpackState(gl);
            // The mask is data, not a colour image: no colour-space conversion.
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, pendingMask);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
            pendingMask = undefined;
            maskLoaded = 1;
          }

          if (region !== "world") {
            terrainKey.set(0, regionIndex);
            terrainKey.set(1, seed);
            if (terrainKey.take()) {
              buildTerrain(region, seed, terrain.data);
              gl.activeTexture(gl.TEXTURE0);
              terrain.upload();
              mapKey.invalidate();
            }
          }
          mapKey.set(0, width);
          mapKey.set(1, height);
          mapKey.set(2, regionIndex);
          mapKey.set(3, seed);
          mapKey.set(4, PALETTE_IDS.indexOf(paletteId));
          mapKey.set(5, maskLoaded);
          if (mapKey.take() || !mapTarget) {
            bakeMap(region, seed, paletteId);
          }

          lutKey.set(0, PALETTE_IDS.indexOf(paletteId));
          if (lutKey.take()) {
            buildColourScale(palette, lutData);
            gl.activeTexture(gl.TEXTURE0);
            updateDataTexture(gl, lut, SCALE_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, lutData);
          }

          const stampW = Math.ceil(STAMP_W * scale);
          const stampH = Math.ceil(STAMP_H * scale);
          const minute = Math.floor(Date.now() / 60000);
          stampKey.set(0, minute);
          stampKey.set(1, PALETTE_IDS.indexOf(paletteId));
          stampKey.set(2, stampW);
          stampKey.set(3, stampH);
          if (stampKey.take()) {
            drawStamp(minute * 60000, paletteId, stampW, stampH);
          }

          // Rain intensity at reduced resolution.
          target.resize(width, height, qualityDivisor(p.quality, DIVISORS));
          target.bind();
          gl.useProgram(rainProgram);
          ru.f1("uAspect", aspect);
          ru.f4("uOff01", offsets[0], offsets[1], offsets[2], offsets[3]);
          ru.f4("uOff23", offsets[4], offsets[5], offsets[6], offsets[7]);
          ru.f2("uOffCov", offsets[8], offsets[9]);
          ru.f2("uCentre", centre[0], centre[1]);
          ru.f1("uRange", RANGE);
          const mode = p.weather === "cells" ? 2 : p.weather === "showers" ? 0 : 1;
          ru.i1("uMode", mode);
          if (mode === 1) {
            windSpan(aspect, span);
            ru.f1("uFront", frontPosition(frontTravel, span[0], span[1]));
          } else if (mode === 2) {
            writeStormCells(cells, weatherTime, seed, aspect);
            gl.uniform4fv(ru.loc.uCells, cells);
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noise);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);

          // Composite at full resolution.
          gl.useProgram(target.program);
          cu.f2("uCentrePx", centre[0] * height, height - centre[1] * height);
          cu.f1("uRangePx", RANGE * height);
          cu.f3("uSweep", Math.cos(sweepAngle), Math.sin(sweepAngle), p.sweep ? 1 : 0);
          cu.f1("uSweepAngle", sweepAngle);
          cu.f1("uLineW", SWEEP_LINE * scale);
          cu.rgb("uSweepCol", palette.sweep);
          const margin = STAMP_MARGIN * scale;
          cu.f4("uStampRect", width - margin - stampW, height - margin - stampH, stampW, stampH);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, mapTarget?.texture ?? null);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, lut);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, stampTex);
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
