import { unitRgbMemo } from "./color";
import {
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  createDataTexture,
  beginFrame,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
} from "./gl";
import {
  advancePulse,
  BREATH,
  camera,
  CORE_GAIN,
  CORE_MAX,
  driftUniform,
  FAR_FADE,
  GRID_ORIGIN,
  HALO,
  HALO_GAIN,
  HEAT_WIDTH,
  LOCAL_GLOW,
  LOCAL_WIDTH,
  JITTER,
  minDrop,
  PULSE_SPREAD,
  SEAM_DENSITY,
  sky,
} from "./lava-sim";
import { lavaMeta } from "./lava.meta";
import { lowResSize } from "./lowres";
import { buildPeriodicNoiseTexture, HASH32_GLSL } from "./noise";
import { defineEffect } from "./types";
import { VORONOI_GLSL } from "./voronoi";

/** Noise texture: texels per side, and the plate cells one tile covers. */
const TEX_SIZE = 128;
const TILE = 32;
/**
 * Channels (lattice cells per tile): R and G warp the plates (2-cell features) and
 * give the crust its mottling; B is the slow heat field (8-cell hot zones); A the
 * breathing phase offset.
 */
const NOISE_CHANNELS = [
  { period: 16, seed: 940 },
  { period: 16, seed: 941 },
  { period: 4, seed: 942 },
  { period: 8, seed: 943 },
];
/** Warp of the plate grid at full noise swing, in cells. */
const WARP = 0.8;
/** Crust mottling: tiles per noise tile (features of about 0.17 cells). */
const ROUGH = 24;
/** Sky and smoke render at 1/SKY_DIVISOR of the frame size; they hold no fine detail. */
const SKY_DIVISOR = 4;
/** Heat haze: largest shimmer offset (px at 1080p), feature size (px) and rise speed (px/s). */
const HAZE_PX = 2.2;
const HAZE_FEATURE = 30;
const HAZE_RISE = 14;
/** One noise tile of haze, in reference px (the R channel has 8 features per tile). */
const HAZE_TILE = 8 * HAZE_FEATURE;
/** Smoke drift across the sky, in frame heights per second, and its noise scale. */
const SMOKE_SPEED = 0.004;
const SMOKE_SCALE = 0.3;
/** Crust base colour, rim light reach (cells) and strength. */
const CRUST = [0.034, 0.03, 0.032] as const;
const RIM_REACH = 0.15;
const RIM = 0.16;
const RIM_COLOR = [1, 0.3, 0.08] as const;
/** Emission ramp: deep red at the seam edges, orange, then yellow in the hottest cores. */
const RED = [0.55, 0.04, 0.01] as const;
const ORANGE = [1, 0.33, 0.03] as const;
const YELLOW = [1, 0.78, 0.32] as const;
/** Glow intensity that reaches the yellow end of the ramp. */
const RAMP_TOP = 1.2;

const vec3 = (c: readonly number[]) => `vec3(${c.map(glslFloat).join(", ")})`;

/**
 * Sky and smoke, at 1/SKY_DIVISOR resolution: a zenith-to-horizon gradient and
 * two octaves of drifting smoke, lit red from below by the field. Rows below the
 * horizon repeat the horizon row, which the ground pass samples as its fog colour.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform vec3 uZenith;
uniform vec3 uHorizon;
/** Underglow on the smoke, already scaled by heat and breathing. */
uniform vec3 uUnder;
/** Horizon (fraction of the height from the top), smoke density, smoke scroll, aspect (w / h). */
uniform vec4 uSkyP;
in vec2 vUv;
out vec4 outColor;
void main() {
  float y = 1.0 - vUv.y;
  float a = max(uSkyP.x - y, 0.0) / uSkyP.x;
  vec3 c = mix(uHorizon, uZenith, sqrt(a));
  vec2 q = vec2(vUv.x * uSkyP.w * ${glslFloat(SMOKE_SCALE)} + uSkyP.z, a * 0.6);
  float sm = 0.65 * textureLod(uNoise, q, 0.0).b
    + 0.35 * textureLod(uNoise, q * 2.7 + vec2(0.31, 0.57), 0.0).a;
  float dens = uSkyP.y * smoothstep(0.32, 0.72, sm) * exp(-a * 4.0);
  vec3 smoke = uUnder * exp(-a * 5.0) + vec3(0.012, 0.01, 0.012);
  c = mix(c, smoke, dens) + uUnder * (0.22 * exp(-a * 12.0));
  outColor = vec4(c, 1.0);
}
`;

/**
 * Ground, full resolution: project the pixel to the ground, shimmer it over hot
 * zones, then one jittered-Voronoi lookup for the seams (skipped where the plates
 * are smaller than a pixel) and three texture fetches: the low-frequency noise
 * (warp, heat field, breathing phase), the crust mottling and the fog colour from
 * the sky texture. Rows above the horizon copy the sky texture.
 */
const GROUND_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform sampler2D uSky;
/** 1 / height px, -0.5 * width / height, 1 / width px. */
uniform vec3 uScreen;
/** Eye height (cells), focal length (frame heights), horizon (from the top), smallest drop. */
uniform vec4 uCam;
/** Footprint: across = z * x, along = across * z * y (cells per device px). */
uniform vec2 uFoot;
/** Shared creep point of the plate seeds, pre-scaled. */
uniform vec2 uDrift;
/** Heat (0..1) and breathing phase (cycles, 0..1). */
uniform vec2 uHeat;
/** Haze offset (device px at full swing), haze uv per device px, haze scroll, 1 / fog distance. */
uniform vec4 uHaze;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
/** Plate seeds: a jitter in a disc, plus the shared creep rotated by the seed's own vector. */
vec2 voronoiOffset(uint h) {
  vec4 b = vec4(uvec4(h, h >> 8, h >> 16, h >> 24) & 255u) * ${glslFloat(2 / 255)} - 1.0;
  vec2 jit = ${glslFloat(JITTER)} * b.xy * sqrt(1.0 - 0.5 * b.yx * b.yx);
  return jit + vec2(b.z * uDrift.x - b.w * uDrift.y, b.w * uDrift.x + b.z * uDrift.y);
}
${VORONOI_GLSL}
vec3 emission(float i) {
  float t = clamp(i * ${glslFloat(1 / RAMP_TOP)}, 0.0, 1.0);
  vec3 c = t < 0.5
    ? mix(${vec3(RED)}, ${vec3(ORANGE)}, t * 2.0)
    : mix(${vec3(ORANGE)}, ${vec3(YELLOW)}, t * 2.0 - 1.0);
  return c * i;
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float y = 1.0 - frag.y * uScreen.x;
  vec2 skyUv = vec2(frag.x * uScreen.z, frag.y * uScreen.x);
  if (y <= uCam.z) {
    outColor = vec4(texture(uSky, skyUv).rgb + dither8(frag), 1.0);
    return;
  }

  // Ground under the pixel, and the pixel's footprint there.
  float hf = uCam.x * uCam.y;
  float z0 = hf / max(y - uCam.z, uCam.w);
  vec2 g0 = vec2((frag.x * uScreen.x + uScreen.y) * z0 / uCam.y, z0) + ${glslFloat(GRID_ORIGIN)};
  float across = z0 * uFoot.x;
  float along = across * z0 * uFoot.y;
  float lod = log2(max(along * ${glslFloat(TEX_SIZE / TILE)}, 1e-4));
  vec4 n = textureLod(uNoise, g0 * ${glslFloat(1 / TILE)}, lod);
  float local = smoothstep(0.35, 0.75, n.b);
  float fog = 1.0 - exp(-z0 * uHaze.w);

  // Heat haze: a rising screen-space shimmer of the ground lookup over hot zones.
  vec2 p = frag;
  if (uHaze.x > 0.0) {
    vec2 hz = textureLod(uNoise, frag * uHaze.y + vec2(0.0, uHaze.z), 0.0).rg - 0.5;
    p += hz * (uHaze.x * local * (1.0 - fog));
  }
  float z = hf / max(1.0 - p.y * uScreen.x - uCam.z, uCam.w);
  vec2 g = vec2((p.x * uScreen.x + uScreen.y) * z / uCam.y, z) + ${glslFloat(GRID_ORIGIN)};

  // Seam glow: see seamGlow in lava-sim.ts.
  float heat = uHeat.x;
  float breath = 0.5 + 0.5 * sin(6.2831853 * (uHeat.y + ${glslFloat(PULSE_SPREAD)} * n.a));
  float w = ${glslFloat(CORE_MAX)} * (${glslFloat(HEAT_WIDTH[0])} + ${glslFloat(HEAT_WIDTH[1])} * heat)
    * (${glslFloat(LOCAL_WIDTH[0])} + ${glslFloat(LOCAL_WIDTH[1])} * local);
  float amp = heat * (${glslFloat(LOCAL_GLOW[0])} + ${glslFloat(LOCAL_GLOW[1])} * local)
    * (${glslFloat(1 - 2 * BREATH)} + ${glslFloat(2 * BREATH)} * breath);
  float s = ${glslFloat(HALO)} * w;
  float mean = min(${glslFloat(2 * SEAM_DENSITY)} * (${glslFloat(CORE_GAIN)} * w + ${glslFloat(HALO_GAIN)} * s), 1.0);
  float far = smoothstep(${glslFloat(FAR_FADE[0])}, ${glslFloat(FAR_FADE[1])}, along);
  float glow = mean;
  float rim = ${glslFloat(4 * RIM_REACH)};
  float plate = 0.5;
  if (far < 1.0) {
    // The plates, warped so the seams wander.
    VoronoiCell v = voronoiCell(g + (n.rg - 0.5) * ${glslFloat(WARP)});
    float fp = max(length(v.normal * vec2(across, along)), 1e-4);
    float e = v.edge;
    float cov = clamp((min(e + 0.5 * fp, w) - max(e - 0.5 * fp, -w)) / fp, 0.0, 1.0);
    float se = sqrt(s * s + 0.25 * fp * fp);
    float near = ${glslFloat(CORE_GAIN)} * cov + ${glslFloat(HALO_GAIN)} * (s / se) * exp(-e / se);
    glow = mix(near, mean, far);
    rim = mix(exp(-e * ${glslFloat(1 / RIM_REACH)}), rim, far);
    plate = mix(float(v.hash >> 24) * ${glslFloat(1 / 255)}, 0.5, far);
  }
  glow *= amp;

  // Crust: dark mottled rock, each plate a little different, lit red near the seams.
  vec2 rn = textureLod(uNoise, g * ${glslFloat(ROUGH / TILE)} + vec2(0.37, 0.71), lod + ${glslFloat(Math.log2(ROUGH))}).rg;
  float rough = 0.6 * rn.x + 0.4 * rn.y;
  vec3 col = ${vec3(CRUST)} * ((0.65 + 0.7 * rough) * (0.8 + 0.4 * plate));
  col += ${vec3(RIM_COLOR)} * (${glslFloat(RIM)} * amp * rim);
  col += emission(glow);

  // Far ground fades into the horizon smoke.
  vec3 fogColor = texture(uSky, vec2(skyUv.x, 1.0 - uCam.z)).rgb;
  col = mix(col, fogColor, fog);
  outColor = vec4(col + dither8(frag), 1.0);
}
`;

/**
 * Lava field at night: cooled crust plates (jittered Voronoi cells on a ground
 * plane seen in perspective) parted by glowing seams that breathe slowly, a
 * shimmer of heat haze over the hottest zones, and smoke lit red at the horizon.
 * A 1/16-size sky pass, then one full-resolution ground pass.
 */
export const lava = defineEffect(lavaMeta, {
  create(gl) {
    return withScope((scope) => {
      const skyProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SKY_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const su = createUniforms(gl, skyProgram, [
        "uNoise",
        "uZenith",
        "uHorizon",
        "uUnder",
        "uSkyP",
      ]);
      gl.useProgram(skyProgram);
      su.i1("uNoise", 0);

      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, GROUND_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uNoise",
        "uSky",
        "uScreen",
        "uCam",
        "uFoot",
        "uDrift",
        "uHeat",
        "uHaze",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);
      u.i1("uSky", 1);

      const triangle = scope.own(createFullscreenTriangle(gl));
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: TEX_SIZE,
          height: TEX_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(TEX_SIZE, NOISE_CHANNELS),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      // Mipmaps keep the far ground's noise from aliasing; the shader picks the level.
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      let skyTarget: RenderTarget | null = null;
      scope.defer(() => skyTarget?.dispose());

      const underglow = unitRgbMemo();
      const drift = [0, 0];
      let width = 1;
      let height = 1;
      let scale = 1;
      // CPU-only time, kept unwrapped in float64; only wrapped phases are uploaded.
      let time = 0;
      let phase = 0;
      let hazeRef = 0;
      let smoke = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / 1080;
          const sw = lowResSize(width, SKY_DIVISOR);
          const sh = lowResSize(height, SKY_DIVISOR);
          if (!skyTarget || skyTarget.width !== sw || skyTarget.height !== sh) {
            skyTarget?.dispose();
            skyTarget = null;
            skyTarget = createRenderTarget(gl, sw, sh, gl.RGBA8);
            if (!skyTarget) throw new Error("Lava field: RGBA8 is not renderable");
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          phase = advancePulse(phase, dt, p.pulse);
          hazeRef = (hazeRef + dt * HAZE_RISE) % HAZE_TILE;
          smoke = (smoke + dt * SMOKE_SPEED * SMOKE_SCALE) % 1;
          const heat = Number.isFinite(p.heat) ? Math.min(Math.max(p.heat, 0), 1) : 0;
          const haze = Number.isFinite(p.haze) ? Math.min(Math.max(p.haze, 0), 1) : 0;
          const cam = camera(p.camera);
          const sk = sky(p.sky);

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);

          // Sky and smoke, into the small target.
          if (skyTarget) {
            skyTarget.bind();
            gl.useProgram(skyProgram);
            su.rgb("uZenith", sk.zenith);
            su.rgb("uHorizon", sk.horizon);
            // The field lights the smoke: brighter when hotter, and breathing a little.
            const under =
              (0.35 + 0.65 * heat) * (1 - BREATH * 0.5 * (1 - Math.sin(2 * Math.PI * phase)));
            const ug = underglow(sk.underglow);
            su.f3("uUnder", ug[0] * under, ug[1] * under, ug[2] * under);
            su.f4("uSkyP", cam.horizon, sk.smoke, smoke, width / height);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // Ground, full resolution.
          gl.useProgram(program);
          u.f3("uScreen", 1 / height, (-0.5 * width) / height, 1 / width);
          u.f4("uCam", cam.height, cam.focal, cam.horizon, minDrop(cam));
          u.f2("uFoot", 1 / (cam.focal * height), 1 / cam.height);
          driftUniform(time, drift);
          u.f2("uDrift", drift[0], drift[1]);
          u.f2("uHeat", heat, phase);
          const k = 1 / (HAZE_TILE * scale);
          u.f4("uHaze", 2 * HAZE_PX * scale * haze, k, -hazeRef / HAZE_TILE, 1 / cam.fog);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, skyTarget?.texture ?? null);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
