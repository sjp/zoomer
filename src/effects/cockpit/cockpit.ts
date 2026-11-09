import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import { lowResSize } from "../lowres";
import { approach } from "../math";
import { createStreakRenderer } from "../streaks";
import { createSwell, swayAt } from "../sway";
import { defineEffect } from "../types";
import { createStarfield, type StarFrame } from "../warp/warp-sim";
import { cockpitMeta } from "./cockpit.meta";
import {
  CLUSTER_INNER,
  CONSOLE_GLSL,
  type CockpitLayout,
  cockpitLayout,
  LIP,
  MAX_LIGHTS,
  MAX_PANELS,
  MAX_SCREENS,
  PANEL_FLOATS,
  PANEL_LAMPS,
  PANEL_LEVERS,
  PANEL_SCREEN,
  PANEL_TOGGLES,
  packPanels,
  SCREEN_ID,
} from "./cockpit-layout";
import {
  asteroidAt,
  createRateLatch,
  createAsteroid,
  jumpAt,
  createJumpState,
  createLampScratch,
  createScenery,
  type LampScratch,
  lampStates,
  sceneryAt,
  screenSetup,
  slotRate,
} from "./cockpit-sim";
import { VALUE_NOISE_GLSL, VALUE_FBM_GLSL } from "../noise";
import { createChangeKey } from "../change-key";

const f = glslFloat;

/** Most stars, and how many fly past at once. */
const MAX_STARS = 1800;
const STAR_COUNT = 1600;
/** Star speed and streak length at sublight and at full stretch (warp starfield units). */
const SUBLIGHT_SPEED = 0.05;
const JUMP_SPEED = 3.2;
const JUMP_STREAK = 9;
/** Star size (1080p px). */
const STAR_SIZE = 2.2;
/** Fastest change of the stretch and tunnel levels, per second: every ramp takes at least 1 s. */
const LEVEL_RATE = 1;
/** The sky (space, nebula, planet and tunnel) is smooth, so it renders at 1/2 size. */
const SKY_DIVISOR = 2;
/** Seconds after which the tunnel's pattern repeats exactly; its speeds are whole cycles of it. */
const TUNNEL_PERIOD = 64;
/** Seconds after which the screens' and lamps' shader time wraps. */
const SHADER_PERIOD = 3600;
/** Sway: a fraction of a degree of roll, and a few pixels of drift. */
const SWAY_SWELL = createSwell(72, [
  { cycles: 4, amplitude: 1, offset: 0 },
  { cycles: 7, amplitude: 0.5, offset: 0.37 },
  { cycles: 3, amplitude: 0.4, offset: 0.71 },
]);
const SWAY_ROLL = 0.003;
const SWAY_X = 2.5;
const SWAY_Y = 1.8;

/** Canopy geometry, in frame heights. The canopy's rings are ellipses, wider than tall. */
const ELLIPSE_X = 0.66;
const RING1 = 0.13;
const RING2 = 0.34;
const RIM = 0.56;
const RIM_WIDTH = 0.045;
/** Strut angles (degrees): those reaching in to the first ring, and those stopping at the second. */
const INNER_STRUTS = [90, 270, -9, 191];
const OUTER_STRUTS = [26, 151, 57, 122, -38, 217];

const strutDirs = (angles: readonly number[]) =>
  angles
    .map((a) => `vec2(${f(Math.cos((a * Math.PI) / 180))}, ${f(Math.sin((a * Math.PI) / 180))})`)
    .join(", ");

/**
 * The cockpit, drawn once per resize or seed. Pass 0 writes the colour,
 * premultiplied, with alpha 0 where the canopy's glass shows outside. Pass 1
 * writes ids: R the lamp (1..MAX_LIGHTS) or screen (SCREEN_ID + n) under the
 * pixel; for a lamp G its lens and glow, for a screen G and B the position on
 * it; elsewhere G how much the surface catches light from outside (or, on the
 * glass, how smudged it is) and B 1 on the glass.
 */
const COCKPIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform int uPass;
uniform float uSeed;
uniform int uPanelCount;
uniform vec4 uPanels[${String(MAX_PANELS * 3)}];

out vec4 outColor;
${VALUE_NOISE_GLSL}
${VALUE_FBM_GLSL}
${CONSOLE_GLSL}

const float EX = ${f(ELLIPSE_X)};
const vec3 WARM = vec3(1.0, 0.6, 0.3);
const vec3 COOL = vec3(0.45, 0.6, 0.85);
const vec2 INNER[${String(INNER_STRUTS.length)}] = vec2[](${strutDirs(INNER_STRUTS)});
const vec2 OUTER[${String(OUTER_STRUTS.length)}] = vec2[](${strutDirs(OUTER_STRUTS)});

float px;
vec4 acc;   // premultiplied colour so far
vec3 ids;   // id pass output so far

void over(vec3 col, float cov, vec3 id) {
  acc = vec4(col, 1.0) * cov + acc * (1.0 - cov);
  if (cov > 0.5) {
    ids = id;
  }
}

/** Glow from the console below: strongest just above it, fading upwards. */
float glowAt(vec2 p) {
  return exp(-max(0.0, p.y - consoleTop(p.x)) * 2.6);
}

/** Worn metal: low-frequency blotches and a few scratches. */
float wear(vec2 p) {
  float b = fbm(p * 7.0, uSeed + 3.0);
  vec2 sp = vec2(p.x * 3.0 + p.y * 9.0, p.y * 2.0 - p.x * 70.0);
  float s = smoothstep(0.93, 0.99, vnoise(sp, uSeed + 5.0)) * smoothstep(0.4, 0.7, vnoise(p * 4.0, uSeed + 6.0));
  return 0.8 + 0.4 * b + 0.5 * s;
}

/** A metal tube across its width: s in [-1, 1] across, nd the unit direction s grows in. */
vec3 tube(vec2 p, float s, vec2 nd, float base) {
  vec3 n = vec3(nd * s, sqrt(max(0.0, 1.0 - s * s)));
  float below = max(0.0, dot(n, normalize(vec3(0.0, -1.0, 0.7))));
  float above = max(0.0, dot(n, normalize(vec3(0.0, 0.6, 0.8))));
  float g = glowAt(p);
  vec3 c = base * wear(p) * (0.55 + 0.3 * above + 1.4 * g * below * WARM);
  // A soft sheen along the middle, catching the console glow.
  c += 0.05 * g * pow(max(0.0, n.z), 18.0) * WARM;
  c += 0.025 * smoothstep(0.6, 1.0, abs(s)) * COOL;
  return c;
}

float sdBox(vec2 p, vec2 c, vec2 h, float r) {
  vec2 d = abs(p - c) - h + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}

/** One panel's contents at p: lamps, toggles, a screen, levers or a plate's dial and vents. */
void panel(vec2 p, int i) {
  vec4 r = uPanels[i];
  vec4 info = uPanels[${String(MAX_PANELS)} + i];
  vec4 extra = uPanels[${String(2 * MAX_PANELS)} + i];
  vec2 c = 0.5 * (r.xy + r.zw);
  vec2 h = 0.5 * (r.zw - r.xy);
  float d = sdBox(p, c, h, 0.004);
  if (d > px) {
    return;
  }
  float tone = extra.z;
  vec3 tint = tone < 0.33 ? vec3(0.9, 0.95, 1.05) : tone < 0.66 ? vec3(1.0, 1.0, 0.86) : vec3(1.08, 0.95, 0.85);
  float g = glowAt(p);
  vec3 plate = (0.06 + 0.04 * fract(tone * 7.3)) * tint * wear(p * 1.7 + tone) * (0.8 + 0.6 * g);
  // Bevel: a lit top edge and a shadowed bottom one.
  float edge = -d;
  plate *= 1.0 + 0.6 * smoothstep(0.004, 0.0, edge) * (p.y > c.y ? 1.0 : -0.6);
  over(plate, cover(d), vec3(0.0, 0.1, 0.0));
  // Screws in the corners.
  vec2 sc = abs(p - c) - (h - 0.006);
  float screw = length(sc) - 0.0025;
  over(vec3(0.12, 0.12, 0.11) * (0.8 + 0.6 * (p.y - c.y + 0.5)), cover(screw), vec3(0.0, 0.2, 0.0));

  int kind = int(info.x + 0.5);
  float cols = info.y;
  float rows = info.z;
  float base = info.w;
  vec2 cell = extra.xy;
  if (kind == ${String(PANEL_LAMPS)} || kind == ${String(PANEL_TOGGLES)}) {
    vec2 grid = vec2(cols, rows) * cell;
    vec2 o = vec2(c.x - 0.5 * grid.x, c.y + 0.5 * grid.y);
    vec2 g2 = vec2(p.x - o.x, o.y - p.y) / cell;
    if (g2.x < 0.0 || g2.y < 0.0 || g2.x >= cols || g2.y >= rows) {
      return;
    }
    vec2 ci = floor(g2);
    vec2 lp = (fract(g2) - 0.5) * cell;
    lp.y = -lp.y;
    float idx = base + ci.y * cols + ci.x;
    vec2 lc = vec2(0.0);
    float half_ = 0.0055;
    if (kind == ${String(PANEL_TOGGLES)}) {
      lc = vec2(0.0, 0.014);
      half_ = 0.0042;
      // The switch: a round collar and a lever thrown up or down.
      vec2 cp = lp - vec2(0.0, -0.008);
      float collar = length(cp) - 0.0058;
      over(vec3(0.05) + 0.08 * smoothstep(0.006, 0.0, length(cp - vec2(-0.002, 0.002))), cover(collar), vec3(0.0, 0.3, 0.0));
      float up = hash2(ci + vec2(float(i) * 17.0, 3.0), uSeed) < 0.6 ? 1.0 : -1.0;
      vec2 a = vec2(0.0, 0.0);
      vec2 b = vec2(0.0, 0.013 * up);
      vec2 pa = cp - a;
      vec2 ba = b - a;
      float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      float lever = length(pa - ba * t) - mix(0.0018, 0.0028, t);
      float shine = 0.22 + 0.25 * smoothstep(0.002, -0.002, (pa - ba * t).x);
      over(vec3(shine) * (0.8 + 0.4 * g), cover(lever), vec3(0.0, 0.5, 0.0));
    }
    // The lamp: a dark bezel round a square lens.
    vec2 q = lp - lc;
    float bezel = sdBox(q, vec2(0.0), vec2(half_ + 0.0015), 0.0012);
    over(vec3(0.03), cover(bezel), vec3(0.0, 0.1, 0.0));
    float lens = sdBox(q, vec2(0.0), vec2(half_), 0.0008);
    over(vec3(0.045, 0.04, 0.04) + 0.03 * smoothstep(half_, -half_, q.x + q.y), cover(lens), vec3(0.0));
    // Its glow spreads a little round the lens.
    float glow = cover(lens) + 0.45 * exp(-max(0.0, lens) / (0.6 * half_)) * (1.0 - cover(lens));
    if (acc.a > 0.5 && glow > 0.02) {
      ids = vec3(idx / 255.0, glow, 0.0);
    }
  } else if (kind == ${String(PANEL_SCREEN)}) {
    vec2 sh = h - 0.009;
    float s = sdBox(p, c, sh, 0.005);
    over(vec3(0.012, 0.016, 0.014), cover(s), vec3(0.0));
    if (s < 0.0) {
      vec2 uv = (p - (c - sh)) / (2.0 * sh);
      ids = vec3((${String(SCREEN_ID)}.0 + extra.w) / 255.0, uv);
    }
  } else if (kind == ${String(PANEL_LEVERS)}) {
    float n = extra.w;
    float w = 2.0 * h.x / n;
    float k = clamp(floor((p.x - r.x) / w), 0.0, n - 1.0);
    float x = r.x + (k + 0.5) * w;
    float slot = sdBox(p, vec2(x, c.y), vec2(0.0035, h.y - 0.012), 0.003);
    over(vec3(0.008), cover(slot), vec3(0.0));
    float y = c.y + (hash2(vec2(k, float(i)), uSeed + 9.0) - 0.5) * (2.0 * h.y - 0.05);
    float grip = sdBox(p, vec2(x, y), vec2(0.012, 0.014), 0.006);
    float lit = 0.5 + 0.5 * smoothstep(-0.014, 0.014, p.y - y);
    vec3 gc = k == 0.0 && hash2(vec2(float(i), 1.0), uSeed) < 0.5 ? vec3(0.3, 0.05, 0.03) : vec3(0.11, 0.1, 0.09);
    over(gc * (0.6 + lit) * (0.8 + 0.6 * g), cover(grip), vec3(0.0, 0.5, 0.0));
    float cap = sdBox(p, vec2(x, y + 0.011), vec2(0.010, 0.0025), 0.0025);
    over(vec3(0.2, 0.19, 0.17) * (0.8 + 0.6 * g), cover(cap), vec3(0.0, 0.7, 0.0));
  } else {
    // A blank plate: a dial with a needle, and vent slots.
    float rad = min(h.x * 0.45, h.y * 0.7);
    vec2 dc = vec2(r.x + 0.012 + rad, c.y);
    vec2 dp = p - dc;
    float dial = length(dp) - rad;
    over(vec3(0.1, 0.1, 0.09), cover(dial), vec3(0.0, 0.3, 0.0));
    over(vec3(0.02, 0.022, 0.02), cover(dial + 0.0025), vec3(0.0));
    float ang = atan(dp.y, dp.x);
    float tick = step(0.7, fract(ang * 1.9099)) * step(rad * 0.75, length(dp)) * step(ang, 2.6) * step(-2.6, ang);
    over(vec3(0.22, 0.21, 0.18), tick * cover(dial + 0.0025), vec3(0.0));
    float na = 2.2 - 4.4 * hash2(vec2(float(i), 5.0), uSeed);
    vec2 nd = vec2(cos(na), sin(na));
    float along = clamp(dot(dp, nd), 0.0, rad * 0.85);
    float needle = length(dp - nd * along) - 0.0012;
    over(vec3(0.5, 0.42, 0.3), cover(needle), vec3(0.0));
    float vx = p.x - (dc.x + rad + 0.012);
    if (vx > 0.0 && vx < 2.0 * h.x - 2.0 * rad - 0.04) {
      float vy = fract((p.y - r.y) / 0.012);
      float vent = abs(vy - 0.5) * 0.012 - 0.002;
      float inside = step(r.y + 0.012, p.y) * step(p.y, r.w - 0.012);
      over(vec3(0.01), inside * cover(vent), vec3(0.0));
    }
  }
}

void main() {
  px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  float halfW = 0.5 * uResolution.x * px;
  acc = vec4(0.0);
  // On the glass: G is how smudged it is, B marks glass.
  float smudge = 0.25 * smoothstep(0.55, 0.85, fbm(p * vec2(5.0, 9.0), uSeed + 11.0));
  ids = vec3(0.0, smudge + 0.25 * glowAt(p) * smoothstep(0.2, -0.05, p.y), 1.0);

  // Canopy struts, radiating from straight ahead.
  vec2 e = vec2(p.x * EX, p.y);
  float rho = length(e);
  vec2 rn = normalize(vec2(p.x * EX * EX, p.y) + 1e-6);
  float gr = length(vec2(p.x * EX * EX, p.y)) / max(rho, 1e-6);
  for (int k = 0; k < ${String(INNER_STRUTS.length + OUTER_STRUTS.length)}; k++) {
    vec2 dir = k < ${String(INNER_STRUTS.length)} ? INNER[k] : OUTER[k - ${String(INNER_STRUTS.length)}];
    float from = k < ${String(INNER_STRUTS.length)} ? ${f(RING1)} : ${f(RING2)};
    float along = dot(p, dir);
    if (along <= 0.0 || rho < from - 0.02) {
      continue;
    }
    vec2 nd = vec2(-dir.y, dir.x);
    float across = dot(p, nd);
    float hw = 0.006 + 0.055 * along;
    float d = abs(across) - hw;
    if (d < px) {
      over(tube(p, clamp(across / hw, -1.0, 1.0), nd, 0.11), cover(d), vec3(0.0, smoothstep(0.55, 1.0, abs(across / hw)), 0.0));
    }
  }
  // Rings, over the struts' ends.
  for (int k = 0; k < 2; k++) {
    float R = k == 0 ? ${f(RING1)} : ${f(RING2)};
    float hr = k == 0 ? 0.008 : 0.016;
    float s = (rho - R) / hr;
    float d = (abs(rho - R) - hr) / gr;
    if (d < px) {
      over(tube(p, clamp(s, -1.0, 1.0), rn, 0.12), cover(d), vec3(0.0, smoothstep(0.55, 1.0, abs(s)), 0.0));
    }
  }
  // The canopy's heavy outer frame, then the hull beyond it.
  {
    float hr = ${f(RIM_WIDTH)};
    float s = (rho - ${f(RIM)} - hr) / hr;
    float d = (${f(RIM)} - rho) / gr;
    if (d < px) {
      vec3 col = s < 1.0 ? tube(p, clamp(s, -1.0, 1.0), rn, 0.1) : vec3(0.0);
      if (s >= 1.0) {
        // The hull: dark panels with seams and rivets.
        float g = glowAt(p);
        float ang = atan(p.y, p.x);
        float seamR = abs(fract((rho - ${f(RIM)}) * 9.0) - 0.5);
        float seamA = abs(fract(ang * 2.2 + 0.3) - 0.5);
        float seam = smoothstep(0.002, 0.0, seamR * 0.11 / gr) + smoothstep(0.002, 0.0, seamA * rho * 0.45);
        float tone = 0.06 + 0.015 * hash2(vec2(floor(ang * 2.2 + 0.3), floor((rho - ${f(RIM)}) * 9.0)), uSeed);
        col = vec3(tone) * wear(p * 0.8) * (0.6 + 1.2 * g * WARM) * (1.0 - 0.6 * seam);
        float rv = rho - (${f(RIM)} + 2.0 * hr + 0.012);
        float riv = length(vec2(rv / gr, (fract(ang * 9.0) - 0.5) * rho / 9.0 * 6.28)) - 0.0035;
        col += vec3(0.05) * (0.6 + g) * cover(riv);
      }
      over(col, cover(d), vec3(0.0, s < 1.0 ? smoothstep(-0.6, -1.0, s) : 0.15, 0.0));
    }
  }

  // The console along the bottom: a glare shield, then the face with its panels.
  float top = consoleTop(p.x);
  float dc = p.y - top;
  if (dc < px) {
    float g = glowAt(p);
    // The top edge catches the light from outside.
    float shield = smoothstep(-0.003, 0.0, dc);
    vec3 col = vec3(0.025, 0.026, 0.028) * wear(p * 1.3) + 0.1 * shield * COOL;
    if (dc < -${f(LIP)}) {
      float seam = smoothstep(0.0015, 0.0, abs(dc + ${f(LIP)}));
      float face = 0.05 + 0.02 * smoothstep(-0.2, 0.0, dc);
      col = vec3(face) * wear(p * 1.1 + 4.0) * (0.7 + 0.5 * g * WARM) * (1.0 - 0.7 * seam);
      // Bare plating across the middle, seamed into slabs.
      float slab = smoothstep(0.0015, 0.0, (0.5 - abs(fract(p.x * 6.0) - 0.5)) / 6.0);
      col *= 1.0 - 0.4 * slab * step(abs(p.x), ${f(CLUSTER_INNER)});
    }
    over(col, cover(dc), vec3(0.0, 0.8 * shield, 0.0));
    for (int i = 0; i < ${String(MAX_PANELS)}; i++) {
      if (i >= uPanelCount) {
        break;
      }
      panel(p, i);
    }
  }

  // The pilots' seat backs at the lower corners, mostly in silhouette.
  for (int k = 0; k < 2; k++) {
    float side = k == 0 ? -1.0 : 1.0;
    float sx = side * (halfW - 0.08);
    float back = sdBox(p, vec2(sx, -0.46), vec2(0.165, 0.25), 0.08);
    float head = sdBox(p, vec2(sx + side * 0.01, -0.145), vec2(0.085, 0.055), 0.04);
    float post = sdBox(vec2(abs(p.x - sx - side * 0.01), p.y), vec2(0.045, -0.2), vec2(0.006, 0.05), 0.003);
    float d = min(min(back, head), post);
    if (d < px) {
      float inner = -d;
      // Rim light along the edges from the console, stitched seams across the back.
      float rim = smoothstep(0.016, 0.0, inner) * (0.4 + 0.6 * smoothstep(-0.2, 0.2, (sx - p.x) * side + p.y + 0.3));
      float seam = smoothstep(0.002, 0.0, abs(fract((p.y + 0.46) * 18.0) - 0.5) / 18.0) * step(0.02, -back) * step(p.y, -0.26);
      vec3 col = vec3(0.018, 0.016, 0.016) * (1.0 - 0.4 * seam) + rim * (0.09 * WARM + 0.03 * COOL);
      over(col, cover(d), vec3(0.0, rim, 0.0));
    }
  }

  if (uPass == 0) {
    outColor = acc;
  } else {
    outColor = vec4(ids, 1.0);
  }
}
`;

/**
 * Outside, at reduced size: deep space with now and then a faint nebula or a
 * distant planet, blended into the tunnel during a jump. The tunnel is pale
 * blue and white streaks streaming out from ahead, slowly swirling, over soft
 * cloudy noise; its noise is periodic so its time can wrap.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
uniform float uAspect;
uniform float uPx;
uniform float uSeed;
uniform float uTunnel;
uniform float uTunnelTime;
uniform vec4 uPlanet;
uniform vec4 uPlanetShape;
uniform vec3 uPlanetA;
uniform vec3 uPlanetB;
uniform vec4 uNebula;
uniform vec3 uNebulaA;
uniform vec3 uNebulaB;

out vec4 outColor;
${VALUE_NOISE_GLSL}
${VALUE_FBM_GLSL}
${DITHER_GLSL}

/** Value noise whose lattice repeats every 'period' cells in each axis. */
float pnoise(vec2 p, vec2 period) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  vec2 i0 = mod(i, period);
  vec2 i1 = mod(i + 1.0, period);
  return mix(mix(hash2(i0, 31.0), hash2(vec2(i1.x, i0.y), 31.0), t.x),
             mix(hash2(vec2(i0.x, i1.y), 31.0), hash2(i1, 31.0), t.x), t.y);
}

vec3 space(vec2 p) {
  vec3 col = vec3(0.004, 0.006, 0.013) + 0.006 * vec3(0.3, 0.5, 1.0) * (0.5 - p.y);
  if (uNebula.z > 0.0) {
    vec2 q = p - uNebula.xy;
    float mask = exp(-dot(q, q) / 0.12);
    float n = fbm(p * uNebula.w + uSeed * 0.37, uSeed);
    float m = fbm(p * uNebula.w * 1.7 - 5.0, uSeed + 1.0);
    float dens = smoothstep(0.35, 0.85, n) * mask;
    col += mix(uNebulaA, uNebulaB, m) * dens * uNebula.z * 4.0;
  }
  if (uPlanet.z > 0.0) {
    vec2 d = (p - uPlanet.xy) / uPlanet.z;
    float r = length(d);
    vec3 L = normalize(vec3(uPlanetShape.zw, 0.45));
    if (r < 1.0) {
      vec3 n = vec3(d, sqrt(1.0 - r * r));
      float ct = cos(uPlanetShape.y);
      float st = sin(uPlanetShape.y);
      float lat = st * n.x + ct * n.y;
      float lon = ct * n.x - st * n.y;
      float band = 0.5 + 0.5 * sin(lat * uPlanetShape.x + 2.5 * vnoise(vec2(lat * 6.0, lon * 1.5), uSeed + 2.0));
      float lit = smoothstep(-0.08, 0.35, dot(n, L));
      vec3 c = mix(uPlanetA, uPlanetB, band) * lit * 0.55;
      // Limb darkening, and the edge anti-aliased over a pixel.
      c *= 0.55 + 0.45 * n.z;
      float cov = clamp((1.0 - r) * uPlanet.z / uPx, 0.0, 1.0);
      col = mix(col, c, cov);
    }
    // A thin lit atmosphere just outside the limb.
    float halo = exp(-abs(r - 1.0) * uPlanet.z * 120.0);
    float sunward = smoothstep(-0.3, 0.6, dot(d / (r + 1e-6), uPlanetShape.zw));
    col += uPlanetB * 0.12 * halo * sunward;
  }
  return col;
}

vec3 tunnel(vec2 p) {
  float r = length(p);
  float z = 0.3 / max(r, 0.004);
  float t = uTunnelTime;
  // Turns round the tunnel, swirling slowly, one turn per tunnel period, more with depth.
  float a = atan(p.y, p.x) / 6.2831853 + t / ${f(TUNNEL_PERIOD)} + 0.04 * z;
  // Each layer moves a whole number of its periods per tunnel period, so wrapping t is seamless.
  float n1 = pnoise(vec2(a * 48.0, 1.5 * z + 0.5 * t), vec2(48.0, ${f(TUNNEL_PERIOD / 2)}));
  float n2 = pnoise(vec2(a * 96.0 + 0.5, 3.0 * z + t), vec2(96.0, ${f(TUNNEL_PERIOD)}));
  float cl = pnoise(vec2(a * 8.0, 0.5 * z + 0.25 * t), vec2(8.0, ${f(TUNNEL_PERIOD / 4)}));
  float streak = pow(n1, 3.0) * 0.9 + pow(n2, 4.0) * 0.6;
  // Far down the tunnel the streaks blur into a soft glow.
  float far = smoothstep(0.16, 0.03, r);
  streak = mix(streak, 0.35, far);
  vec3 col = vec3(0.03, 0.07, 0.2) + cl * vec3(0.08, 0.15, 0.32);
  col += streak * vec3(0.5, 0.68, 0.95);
  col += vec3(0.35, 0.48, 0.7) * exp(-r * 7.0);
  // Never brighter than a soft pale blue.
  return min(col, vec3(0.7, 0.8, 0.95));
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec3 col = uTunnel < 1.0 ? space(p) : vec3(0.0);
  if (uTunnel > 0.0) {
    col = mix(col, tunnel(p), uTunnel);
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Each frame: the cached cockpit (swayed a touch), its lamps and screens, and
 * through the glass the sky, an asteroid, and the stars already on the canvas.
 * Drawn premultiplied over the stars, so they show only through the glass.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uCockpit;
uniform sampler2D uIds;
uniform sampler2D uSky;
uniform sampler2D uLamps;
uniform vec2 uResolution;
uniform vec4 uSway;
uniform float uTime;
uniform float uTunnel;
uniform vec4 uRock;
uniform vec4 uRockShape;
uniform vec2 uSun;
uniform vec4 uScreens[${String(MAX_SCREENS)}];

out vec4 outColor;
${VALUE_NOISE_GLSL}
${VALUE_FBM_GLSL}
${DITHER_GLSL}

vec3 screen(int n, vec2 uv) {
  vec4 s = uScreens[n];
  int kind = int(s.x + 0.5);
  float t = uTime * s.z + s.w * 100.0;
  float v = 0.0;
  if (kind == 0) {
    // A scrolling trace over a faint grid.
    float y = 0.5 + 0.28 * sin(uv.x * 11.0 + t * 1.1) * sin(uv.x * 3.1 - t * 0.37);
    v = smoothstep(0.07, 0.0, abs(uv.y - y));
    vec2 gd = abs(fract(uv * vec2(6.0, 4.0)) - 0.5);
    v += 0.18 * step(0.46, max(gd.x, gd.y));
  } else if (kind == 1) {
    // Lines of figures scrolling up a line at a time.
    float step_ = floor(t * 0.6);
    float scroll = step_ + smoothstep(0.75, 1.0, fract(t * 0.6));
    float ly = uv.y * 6.0 - scroll;
    float line = floor(ly);
    float inLine = step(0.25, fract(ly)) * step(fract(ly), 0.75);
    float word = floor(uv.x * 7.0);
    float len = hash2(vec2(word, line), s.w * 50.0);
    float ch = step(fract(uv.x * 28.0), 0.7) * step(fract(uv.x * 7.0), 0.3 + 0.7 * len);
    v = inLine * ch * step(0.3, len) * (0.55 + 0.45 * hash2(vec2(line, 3.0), s.w));
  } else if (kind == 2) {
    // A slow sweep round a ranging grid, with a few contacts fading after it.
    vec2 q = (uv - 0.5) * vec2(1.5, 1.0);
    float r = length(q);
    float ang = fract(atan(q.y, q.x) / 6.2831853 - t * 0.12);
    v = exp(-ang * 7.0) * step(r, 0.48) * 0.8;
    v += 0.25 * smoothstep(0.012, 0.0, abs(fract(r * 6.0) - 0.5) / 6.0) * step(r, 0.48);
    for (int k = 0; k < 3; k++) {
      vec2 b = vec2(hash2(vec2(float(k), 1.0), s.w * 70.0), hash2(vec2(float(k), 2.0), s.w * 70.0)) - 0.5;
      b *= vec2(0.6, 0.8);
      float ba = fract(atan(b.y, b.x) / 6.2831853 - t * 0.12);
      v += exp(-ba * 4.0) * smoothstep(0.03, 0.01, length(q - b * vec2(1.5, 1.0) * 0.6));
    }
  } else {
    // A bar chart whose bars rise and fall.
    float k = floor(uv.x * 9.0);
    float hgt = 0.15 + 0.75 * vnoise(vec2(k * 3.7, t * 0.35), s.w * 90.0);
    v = step(0.18, fract(uv.x * 9.0)) * step(fract(uv.x * 9.0), 0.82) * step(uv.y, hgt);
    v *= 0.5 + 0.5 * step(hgt - 0.04, uv.y);
  }
  vec3 phosphor = s.y < 0.5 ? vec3(0.35, 1.0, 0.45) : vec3(1.0, 0.62, 0.15);
  vec2 edge = min(uv, 1.0 - uv);
  float vig = smoothstep(0.0, 0.12, min(edge.x, edge.y));
  float scan = 0.85 + 0.15 * sin(uv.y * 140.0);
  return phosphor * (0.05 + 0.5 * clamp(v, 0.0, 1.0)) * scan * (0.55 + 0.45 * vig);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 c = 0.5 * uResolution;
  vec2 d = frag - c;
  // The cockpit's sway: a small roll about the centre and a drift.
  vec2 src = c + vec2(uSway.x * d.x + uSway.y * d.y, -uSway.y * d.x + uSway.x * d.y) - uSway.zw;
  vec4 ck = texture(uCockpit, src / uResolution);
  vec4 id = texelFetch(uIds, clamp(ivec2(src), ivec2(0), ivec2(uResolution) - 1), 0);
  int idx = int(id.r * 255.0 + 0.5);

  // Outside: the sky, with the asteroid over it.
  vec3 out_ = texture(uSky, frag / uResolution).rgb;
  float rockA = 0.0;
  if (uRock.w > 0.0) {
    vec2 q = frag - uRock.xy;
    float r = length(q);
    if (r < uRock.z * 1.35) {
      vec2 l = vec2(uRockShape.x * q.x + uRockShape.y * q.y, -uRockShape.y * q.x + uRockShape.x * q.y);
      float a = atan(l.y, l.x);
      float h = uRockShape.z;
      float edge = uRock.z * (1.0 + 0.12 * sin(3.0 * a + h) + 0.07 * sin(5.0 * a + 2.1 * h) + 0.04 * sin(9.0 * a + 3.7 * h));
      float cov = clamp(edge - r + 0.5, 0.0, 1.0);
      if (cov > 0.0) {
        vec2 dl = q / edge;
        vec3 n = vec3(dl, sqrt(max(0.0, 1.0 - dot(dl, dl))));
        vec2 bp = l / uRock.z * 3.0;
        float bump = vnoise(bp, h * 13.0) * 0.6 + vnoise(bp * 2.3, h * 7.0) * 0.4;
        n = normalize(n + vec3(vnoise(bp + 4.0, h) - 0.5, vnoise(bp - 4.0, h) - 0.5, 0.0) * 0.8);
        float lit = max(0.0, dot(n, normalize(vec3(uSun, 0.35))));
        vec3 rc = vec3(0.3, 0.27, 0.24) * (0.03 + lit * (0.55 + 0.45 * bump));
        rockA = cov * uRock.w;
        out_ = mix(out_, rc, rockA);
      }
    }
  }
  bool glass = id.b > 0.5 && idx == 0;
  // Through the glass: slightly dimmed, with smudges catching the light.
  vec3 haze = mix(vec3(0.05, 0.035, 0.025), vec3(0.08, 0.14, 0.28), uTunnel);
  vec3 outside = out_ * 0.94 + (glass ? id.g * haze : vec3(0.0));

  // The cockpit, tinted blue in the tunnel and rim-lit from outside.
  vec3 col = ck.rgb * mix(vec3(1.0), vec3(0.78, 0.9, 1.3), 0.55 * uTunnel);
  if (idx == 0 && !glass) {
    col += ck.a * id.g * mix(vec3(0.03, 0.04, 0.06), vec3(0.16, 0.28, 0.5), uTunnel);
  } else if (idx > 0 && idx < ${String(SCREEN_ID)}) {
    vec3 lamp = texelFetch(uLamps, ivec2(idx, 0), 0).rgb;
    float g = id.g;
    col += lamp * (g * 1.1 + 0.6 * g * g * g);
  } else if (idx >= ${String(SCREEN_ID)}) {
    col += screen(idx - ${String(SCREEN_ID)}, id.gb);
  }

  float a = ck.a + (1.0 - ck.a) * rockA;
  outColor = vec4(col + (1.0 - ck.a) * outside + dither8(frag), a);
}
`;

/**
 * Freighter Cockpit. The cockpit is drawn once per resize or seed into a
 * colour target and an id target. Each frame renders the sky at half size,
 * draws the stars (the warp starfield, stretching into streaks on a jump) on
 * the canvas, then one composite lays the cockpit, its lamps and screens, the
 * sky and any asteroid over them.
 */
export const cockpit = defineEffect(cockpitMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const cockpitProgram = program(FULLSCREEN_VERTEX, COCKPIT_FRAGMENT);
      const pu = createUniforms(gl, cockpitProgram, [
        "uResolution",
        "uPass",
        "uSeed",
        "uPanelCount",
        "uPanels",
      ]);
      const skyProgram = program(FULLSCREEN_VERTEX, SKY_FRAGMENT);
      const su = createUniforms(gl, skyProgram, [
        "uAspect",
        "uPx",
        "uSeed",
        "uTunnel",
        "uTunnelTime",
        "uPlanet",
        "uPlanetShape",
        "uPlanetA",
        "uPlanetB",
        "uNebula",
        "uNebulaA",
        "uNebulaB",
      ]);
      const compositeProgram = program(FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, [
        "uCockpit",
        "uIds",
        "uSky",
        "uLamps",
        "uResolution",
        "uSway",
        "uTime",
        "uTunnel",
        "uRock",
        "uRockShape",
        "uSun",
        "uScreens",
      ]);
      gl.useProgram(compositeProgram);
      cu.i1("uCockpit", 0);
      cu.i1("uIds", 1);
      cu.i1("uSky", 2);
      cu.i1("uLamps", 3);

      const streaks = scope.own(createStreakRenderer(gl, MAX_STARS));
      const stars = createStarfield(MAX_STARS);
      const sf: StarFrame = {
        width: 1,
        height: 1,
        scale: 1,
        speed: SUBLIGHT_SPEED,
        count: STAR_COUNT,
        streak: 0,
        size: STAR_SIZE,
        tintAmount: 0.5,
        star: [0.92, 0.94, 1],
        tint: [0.7, 0.82, 1],
      };

      const lampBytes = new Uint8Array((MAX_LIGHTS + 1) * 4);
      const lampTex = scope.add(
        createDataTexture(gl, {
          width: MAX_LIGHTS + 1,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: lampBytes,
          filter: gl.NEAREST,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      let colour: RenderTarget | null = null;
      let ids: RenderTarget | null = null;
      let sky: RenderTarget | null = null;
      scope.defer(() => {
        colour?.dispose();
        ids?.dispose();
        sky?.dispose();
        colour = ids = sky = null;
      });

      let width = 1;
      let height = 1;
      let time = 0;
      let seed = Number.NaN;
      let drawn = false;
      let layout: CockpitLayout = cockpitLayout(0);
      let lampScratch: LampScratch = createLampScratch(layout.groups);
      const panelData = new Float32Array(MAX_PANELS * PANEL_FLOATS);
      const screenData = new Float32Array(MAX_SCREENS * 4);

      const jump = createJumpState();
      const scheduleKey = createChangeKey(3);
      let epoch = 0;
      let legBase = 0;
      let leg = Number.NaN;
      let scenerySeed = Number.NaN;
      let stretch = -1;
      let tunnel = -1;
      const scenery = createScenery();
      const rock = createAsteroid();
      const rockRate = createRateLatch();
      let swayPhase = 0;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          sf.width = width;
          sf.height = height;
          sf.scale = v.scale;
          colour?.dispose();
          ids?.dispose();
          sky?.dispose();
          colour = createRenderTarget(gl, width, height, gl.RGBA8);
          ids = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          sky = createRenderTarget(
            gl,
            lowResSize(width, SKY_DIVISOR),
            lowResSize(height, SKY_DIVISOR),
            gl.RGBA8,
          );
          drawn = false;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const newSeed = Math.floor(p.seed);
          if (newSeed !== seed) {
            seed = newSeed;
            layout = cockpitLayout(seed);
            lampScratch = createLampScratch(layout.groups);
            packPanels(layout.panels, panelData);
            for (let n = 0; n < MAX_SCREENS; n++) {
              screenSetup(n, seed, screenData, n * 4);
            }
            drawn = false;
          }

          // The jump schedule restarts when its settings change, keeping the scenery.
          scheduleKey.setText(0, p.view);
          scheduleKey.set(1, p.jumpGap);
          scheduleKey.set(2, seed);
          if (scheduleKey.take()) {
            legBase += jump.leg;
            epoch = time;
          }
          jumpAt(time - epoch, p.view, p.jumpGap, seed, jump);
          // The levels follow the schedule, but never faster than LEVEL_RATE, so a
          // change of settings mid-jump ramps too.
          const rate = step * LEVEL_RATE;
          stretch = stretch < 0 ? jump.stretch : approach(stretch, jump.stretch, rate);
          tunnel = tunnel < 0 ? jump.tunnel : approach(tunnel, jump.tunnel, rate);
          if (legBase + jump.leg !== leg || seed !== scenerySeed) {
            leg = legBase + jump.leg;
            scenerySeed = seed;
            sceneryAt(leg, seed, scenery);
          }

          if (!colour || !ids || !sky) {
            return;
          }

          // 1. The cockpit, when it may have changed.
          if (!drawn) {
            gl.useProgram(cockpitProgram);
            pu.f2("uResolution", width, height);
            pu.f1("uSeed", seed);
            pu.i1("uPanelCount", Math.min(layout.panels.length, MAX_PANELS));
            gl.uniform4fv(pu.loc.uPanels, panelData);
            colour.bind();
            pu.i1("uPass", 0);
            triangle.draw();
            ids.bind();
            pu.i1("uPass", 1);
            triangle.draw();
            drawn = true;
          }

          // 2. The sky, at reduced size.
          sky.bind();
          gl.useProgram(skyProgram);
          su.f1("uAspect", width / height);
          su.f1("uPx", SKY_DIVISOR / height);
          su.f1("uSeed", seed % 1000);
          su.f1("uTunnel", tunnel);
          su.f1("uTunnelTime", time % TUNNEL_PERIOD);
          su.f4("uPlanet", scenery.planetX, scenery.planetY, scenery.planetR, 0);
          su.f4("uPlanetShape", scenery.bands, scenery.tilt, scenery.sunX, scenery.sunY);
          su.v3("uPlanetA", scenery.planetA);
          su.v3("uPlanetB", scenery.planetB);
          su.f4("uNebula", scenery.nebulaX, scenery.nebulaY, scenery.nebula, scenery.nebulaScale);
          su.v3("uNebulaA", scenery.nebulaA);
          su.v3("uNebulaB", scenery.nebulaB);
          triangle.draw();

          // 3. The stars, stretching into streaks on a jump and dimmed in the tunnel.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          const s2 = stretch * stretch;
          sf.speed = SUBLIGHT_SPEED + (JUMP_SPEED - SUBLIGHT_SPEED) * s2;
          sf.streak = JUMP_STREAK * stretch;
          const dimming = 1 - 0.55 * tunnel;
          sf.star[0] = 0.92 * dimming;
          sf.star[1] = 0.94 * dimming;
          sf.star[2] = dimming;
          sf.tint[0] = 0.7 * dimming;
          sf.tint[1] = 0.82 * dimming;
          sf.tint[2] = dimming;
          const count = stars.step(step, sf, streaks.data);
          streaks.upload(count);
          streaks.draw(count, width, height);

          // 4. Console lamps.
          lampStates(layout.lamps, seed, p.lights, time, lampScratch, lampBytes);
          gl.activeTexture(gl.TEXTURE3);
          updateDataTexture(gl, lampTex, MAX_LIGHTS + 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, lampBytes);

          // 5. Composite over the stars.
          asteroidAt(time, seed, slotRate(rockRate, time, p.asteroids), rock);
          // Asteroids keep clear of jumps.
          const rockAlpha = rock.visible ? rock.alpha * (1 - stretch) : 0;
          swayPhase = (swayPhase + step / SWAY_SWELL.period) % 1;
          const roll = SWAY_ROLL * swayAt(SWAY_SWELL, swayPhase, 0);
          const scale = height / 1080;
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, colour.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, ids.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, sky.texture);
          cu.f2("uResolution", width, height);
          cu.f4(
            "uSway",
            Math.cos(roll),
            Math.sin(roll),
            SWAY_X * scale * swayAt(SWAY_SWELL, swayPhase, 9),
            SWAY_Y * scale * swayAt(SWAY_SWELL, swayPhase, 23),
          );
          cu.f1("uTime", time % SHADER_PERIOD);
          cu.f1("uTunnel", tunnel);
          cu.f4(
            "uRock",
            width / 2 + rock.x * height,
            height / 2 + rock.y * height,
            Math.max(1, rock.radius * height),
            rockAlpha,
          );
          cu.f4("uRockShape", Math.cos(rock.angle), Math.sin(rock.angle), rock.shape * 0.01, 0);
          cu.f2("uSun", scenery.sunX, scenery.sunY);
          gl.uniform4fv(cu.loc.uScreens, screenData);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();
          gl.disable(gl.BLEND);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
