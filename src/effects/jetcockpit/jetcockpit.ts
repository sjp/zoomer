import { CAM_HEIGHT, FOCAL, buildBillowTexture } from "../cloudsea/cloudsea-sim";
import { CLOUD_TOPS_GLSL, driftTops } from "../cloudsea/cloudsea-tops";
import { cloudNoiseChannels, coverageOpacity, coverageThreshold } from "../clouds/clouds-sky";
import { NOISE_GLSL } from "../cockpit/cockpit-layout";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
} from "../gl";
import { lowResSize } from "../lowres";
import { lookup } from "../lookup";
import { clamp, wrap } from "../math";
import { buildPeriodicNoiseTexture } from "../noise";
import { createSwell, swayAt } from "../sway";
import { defineEffect } from "../types";
import { jetcockpitMeta } from "./jetcockpit.meta";
import {
  approachSky,
  bankAt,
  buildGlyphAtlas,
  createJetSky,
  createPass,
  GLYPH_CELL,
  GLYPH_COUNT,
  GLYPH_ROWS,
  HORIZON,
  passAt,
  PASS_PEAK,
  READOUT_GLYPHS,
  READOUTS,
  readingDim,
  readingGlyphs,
  readingKey,
  SKIES,
} from "./jetcockpit-sim";

const f = glslFloat;

/** The view outside is soft and moving, so it renders every frame at 1/3 size. */
const OUTSIDE_DIVISOR = 3;
/** Billow texture side, as in the sea of clouds. */
const BILLOW_SIZE = 128;
/** The scattered cloud's noise texture: side and seed. */
const NOISE_SIZE = 256;
const NOISE_SEED = 11;
/** How fast the cloud deck streams away, world units (deck depths) per second. */
const SPEED = 0.32;
/** The scattered clouds' plane: this far below the camera (deck depths), and noise tiles per world unit. */
const PUFF_HEIGHT = 0.5;
const PUFF_FREQ = 0.05;
/** Distance haze per world unit. */
const HAZE_K = 0.03;
/** Seconds after which the displays' shader time wraps. */
const SHADER_PERIOD = 3600;
/**
 * Turbulence: a very small, slow wobble of the view outside, scaled by the
 * bank amount: a fraction of a degree of roll and a few pixels of rise.
 */
const WOBBLE = createSwell(80, [
  { cycles: 4, amplitude: 1, offset: 0 },
  { cycles: 7, amplitude: 0.5, offset: 0.37 },
  { cycles: 11, amplitude: 0.25, offset: 0.71 },
]);
const WOBBLE_ROLL = 0.003;
const WOBBLE_LIFT = 0.003;
/** Degrees per second the heading turns per radian of bank, for the heading tape. */
const TURN_RATE = 9;

/* ----- Cockpit layout, frame heights from the frame's centre ----- */

/** Seat back and headrest boxes: centre y, half sizes, corner radius. */
const BACK_Y = -0.37;
const BACK_HX = 0.29;
const BACK_HY = 0.25;
const HEAD_Y = 0.1;
const HEAD_HX = 0.165;
const HEAD_HY = 0.175;
/** The seat's side rails, beside the headrest: |x|, half width and top. */
const RAIL_X = 0.2;
const RAIL_HW = 0.014;
const RAIL_TOP = 0.25;
/** The firing handles on the headrest's top corners: centre |x|, y and half sizes. */
const HANDLE_X = 0.13;
const HANDLE_Y = 0.292;
const HANDLE_HX = 0.04;
const HANDLE_HY = 0.02;
/** The canopy's rear arch: its ellipse (centre height and radii) and half width. */
const ARCH_CY = -0.62;
const ARCH_RX = 0.66;
const ARCH_RY = 1.0;
const ARCH_HW = 0.013;
/** The cockpit sides' sill: from (SILL_IN, SILL_IN_Y) up to (SILL_OUT, SILL_OUT_Y). */
const SILL_IN = 0.44;
const SILL_IN_Y = -0.44;
const SILL_OUT = 0.95;
const SILL_OUT_Y = -0.33;
/** The spine's top, and its half width there. */
const SPINE_Y = -0.175;
const SPINE_HW = 0.11;
/** The twin fins: root and tip centres, and their half widths. */
const FIN_ROOT: readonly [number, number] = [0.12, -0.17];
const FIN_TIP: readonly [number, number] = [0.36, 0.31];
const FIN_ROOT_HW = 0.042;
const FIN_TIP_HW = 0.024;
/** The wings, nearly edge-on: their height at the root and tip span. */
const WING_Y = -0.235;
const WING_TIP = 0.9;
/** The displays at the lower corners: centre |x| and y, and the screen's half sizes. */
const MFD_X = 0.7;
const MFD_Y = -0.455;
const MFD_HX = 0.092;
const MFD_HY = 0.062;

/** Towards the key light, view space with z towards the viewer: high and to the left. */
const KEY: readonly [number, number, number] = (() => {
  const v = [-0.5, 0.62, 0.6];
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n] as const;
})();

/**
 * The cockpit, drawn once per resize or change of seed, in neutral light (the
 * composite tints it for the time of day). Premultiplied colour, with alpha
 * marking how much it hides the sky: 0 for clear sky, a little for the
 * canopy's tint and reflections, 1 for the jet itself.
 */
const COCKPIT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform float uSeed;

out vec4 outColor;
${NOISE_GLSL}

const vec3 KEY = vec3(${f(KEY[0])}, ${f(KEY[1])}, ${f(KEY[2])});
const vec3 OLIVE = vec3(0.26, 0.27, 0.17);
const vec3 SHELL = vec3(0.12, 0.125, 0.13);

float px;
vec4 acc;

void over(vec3 col, float cov) {
  acc = vec4(col, 1.0) * cov + acc * (1.0 - cov);
}

/** A translucent layer: colour col at opacity a. */
void glaze(vec3 col, float a) {
  acc = vec4(col * a, a) + acc * (1.0 - a);
}

float cover(float d) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}

float sdBox(vec2 p, vec2 c, vec2 h, float rr) {
  vec2 d = abs(p - c) - h + rr;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rr;
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

/** Approximate signed distance to an ellipse (centre c, radii r). */
float sdEllipse(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  float k = length(q);
  vec2 g = q / (r * max(k, 1e-5));
  return (k - 1.0) / max(length(g), 1e-5);
}

/** Height of the cockpit sides' sill at |x|. */
float sill(float ax) {
  return ${f(SILL_IN_Y)} + (ax - ${f(SILL_IN)}) * ${f((SILL_OUT_Y - SILL_IN_Y) / (SILL_OUT - SILL_IN))};
}

/** Two-tone grey camouflage in soft-edged patches, with faint panel lines. */
vec3 camo(vec2 p, vec2 seam) {
  float n = fbm(p * 4.2 + uSeed * 0.37, uSeed + 11.0);
  vec3 c = mix(vec3(0.5, 0.53, 0.56), vec3(0.36, 0.39, 0.43), smoothstep(0.47, 0.53, n));
  c *= 0.93 + 0.1 * vnoise(p * 40.0, uSeed + 12.0);
  float line = smoothstep(0.0016, 0.0, abs(fract(seam.x) - 0.5) / max(seam.y, 1e-3));
  return c * (1.0 - 0.25 * line);
}

/** Light on a surface with normal n: soft ambient plus the key. */
float shade(vec3 n) {
  return 0.3 + 0.75 * max(0.0, dot(normalize(n), KEY));
}

/** The seat's outline: its back and the headrest. */
float seat(vec2 p) {
  float back = sdBox(p, vec2(0.0, ${f(BACK_Y)}), vec2(${f(BACK_HX)}, ${f(BACK_HY)}), 0.09);
  float head = sdBox(p, vec2(0.0, ${f(HEAD_Y)}), vec2(${f(HEAD_HX)}, ${f(HEAD_HY)}), 0.07);
  return min(back, head);
}

void main() {
  px = 1.0 / uResolution.y;
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) * px;
  float ax = abs(p.x);
  float sx = p.x < 0.0 ? -1.0 : 1.0;
  acc = vec4(0.0);

  // The wings, nearly edge-on, reaching out to the sides just below the horizon.
  {
    float u = clamp((ax - ${f(SPINE_HW)}) / ${f(WING_TIP - SPINE_HW)}, 0.0, 1.0);
    float mid = ${f(WING_Y)} + 0.01 * u;
    float hw = 0.009 * (1.0 - 0.55 * u);
    float d = max(abs(p.y - mid) - hw, ax - ${f(WING_TIP)});
    if (d < px) {
      float t = (p.y - mid) / hw;
      vec3 col = camo(p * vec2(1.0, 6.0), vec2(ax * 9.0, 9.0 * px)) * shade(vec3(0.0, 1.0, 0.25 + 0.5 * t));
      // The upper surface catches the light; the underside is dark.
      col *= mix(0.45, 1.0, smoothstep(-0.6, 0.2, t));
      over(col, cover(d));
    }
  }

  // The spine, running back from the cockpit to the tail: wide below, narrowing
  // to its far end just above the horizon.
  {
    float hw = ${f(SPINE_HW)} + 0.55 * max(0.0, ${f(SPINE_Y)} - p.y);
    float d = max(p.y - ${f(SPINE_Y)}, ax - hw);
    d = max(d, -p.y - 0.7);
    if (d < px) {
      float across = clamp(p.x / hw, -1.0, 1.0);
      vec3 n = vec3(0.9 * across, 1.0, 0.45);
      // Panel seams across the spine, closer together into the distance.
      float depth = 1.0 / max(0.03, ${f(SPINE_Y + 0.06)} - p.y);
      vec3 col = camo(p * vec2(1.0, 2.5), vec2(depth * 0.5, 0.5 * depth * depth * px)) * shade(n);
      col *= 0.85 + 0.15 * smoothstep(0.0, 0.02, -d);
      over(col, cover(d));
    }
  }

  // The twin fins, canted out, seen from the front.
  {
    vec2 q = vec2(ax, p.y);
    vec2 a = vec2(${f(FIN_ROOT[0])}, ${f(FIN_ROOT[1])});
    vec2 b = vec2(${f(FIN_TIP[0])}, ${f(FIN_TIP[1])});
    vec2 ab = b - a;
    float h = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
    float hw = mix(${f(FIN_ROOT_HW)}, ${f(FIN_TIP_HW)}, h);
    float d = sdSeg(q, a, b) - hw;
    // A square-cut tip, raked back.
    vec2 dir = normalize(ab);
    d = max(d, dot(q - b, dir) - 0.004 * (1.0 + dot(q - b, vec2(-dir.y, dir.x)) / hw));
    if (d < px) {
      // The inner face, turned up and in towards the camera.
      vec3 n = vec3(-sx * 0.55, 0.25, 0.8);
      float across = dot(q - a, vec2(-dir.y, dir.x)) / hw;
      vec3 col = camo(p * vec2(2.5, 1.0) + sx * 3.0, vec2(h * 6.0, 6.0 * px / length(ab))) * shade(n);
      // Its leading edge, along the outer side, catches the light.
      col += 0.12 * smoothstep(0.55, 1.0, across) * max(0.0, dot(normalize(vec3(sx * 0.8, 0.3, 0.5)), KEY));
      // A dark band where it meets the spine.
      col *= mix(0.6, 1.0, smoothstep(0.0, 0.06, h));
      over(col, cover(d));
    }
  }

  // The bubble canopy: a slight tint, and faint curved reflections.
  {
    glaze(vec3(0.16, 0.2, 0.24), 0.06);
    float r1 = abs(sdEllipse(p, vec2(0.12, -0.75), vec2(0.95, 1.18)));
    float r2 = abs(sdEllipse(p, vec2(-0.2, -0.9), vec2(1.2, 1.12)));
    float band = smoothstep(0.05, 0.0, r1) * smoothstep(-0.05, 0.35, p.y) * smoothstep(-0.25, 0.4, p.x);
    band += 0.6 * smoothstep(0.03, 0.0, r2) * smoothstep(0.35, -0.05, p.y) * smoothstep(0.1, -0.5, p.x);
    glaze(vec3(0.92, 0.95, 1.0), 0.05 * band);
  }

  // The canopy's rear arch, behind the seat.
  {
    float de = sdEllipse(p, vec2(0.0, ${f(ARCH_CY)}), vec2(${f(ARCH_RX)}, ${f(ARCH_RY)}));
    float d = abs(de) - ${f(ARCH_HW)};
    if (d < px) {
      float s = clamp(de / ${f(ARCH_HW)}, -1.0, 1.0);
      vec2 q2 = p - vec2(0.0, ${f(ARCH_CY)});
      vec2 rn = normalize(q2 / vec2(${f(ARCH_RX ** 2)}, ${f(ARCH_RY ** 2)}));
      vec3 n = vec3(rn * s, sqrt(max(0.0, 1.0 - s * s)));
      vec3 col = vec3(0.2, 0.21, 0.22) * shade(n) + 0.1 * pow(max(0.0, dot(n, KEY)), 14.0);
      // Its inner edge holds a dark seal against the glass.
      col *= mix(0.45, 1.0, smoothstep(-0.85, -0.55, s));
      over(col, cover(d));
    }
  }

  // The ejection seat: side rails, the seat back and headrest in a dark grey
  // shell round olive cushions, the harness, and the firing handles on top.
  {
    float rail = sdBox(vec2(ax, p.y), vec2(${f(RAIL_X)}, -0.05), vec2(${f(RAIL_HW)}, ${f(RAIL_TOP + 0.05)}), 0.006);
    if (rail < px) {
      float s = clamp((ax - ${f(RAIL_X)}) / ${f(RAIL_HW)}, -1.0, 1.0);
      vec3 n = vec3(sx * s, 0.0, sqrt(max(0.0, 1.0 - s * s)));
      vec3 col = vec3(0.17, 0.175, 0.18) * shade(n);
      // Bolt heads up the rail.
      float bolt = length(vec2(ax - ${f(RAIL_X)}, (fract(p.y * 14.0) - 0.5) / 14.0)) - 0.0035;
      col *= 1.0 - 0.4 * cover(bolt);
      over(col, cover(rail));
    }
    float d = seat(p);
    if (d < px) {
      vec2 e = vec2(0.002, 0.0);
      vec2 grad = normalize(vec2(seat(p + e.xy) - seat(p - e.xy), seat(p + e.yx) - seat(p - e.yx)) + 1e-6);
      float edge = smoothstep(0.03, 0.0, -d);
      vec3 shell = SHELL * shade(vec3(grad * edge, 0.6));
      // Cushions, quilted in horizontal channels.
      float pad = min(
        sdBox(p, vec2(0.0, ${f(HEAD_Y - 0.01)}), vec2(${f(HEAD_HX - 0.03)}, ${f(HEAD_HY - 0.04)}), 0.05),
        sdBox(p, vec2(0.0, ${f(BACK_Y + 0.03)}), vec2(${f(BACK_HX - 0.04)}, ${f(BACK_HY - 0.02)}), 0.07));
      float channel = smoothstep(0.004, 0.0, abs(fract(p.y * 16.0) - 0.5) / 16.0);
      vec3 cushion = OLIVE * (0.75 + 0.25 * vnoise(p * 60.0, uSeed + 4.0)) * (1.0 - 0.35 * channel)
        * (0.7 + 0.45 * smoothstep(-0.5, 0.3, p.y));
      cushion *= 0.75 + 0.35 * smoothstep(0.0, -0.02, pad);
      vec3 col = mix(shell, cushion, cover(pad));
      over(col, cover(d));
    }
    // The harness: olive straps over the seat back, with metal fittings.
    for (int i = 0; i < 2; i++) {
      float s = i == 0 ? -1.0 : 1.0;
      vec2 a = vec2(0.095 * s, -0.08);
      vec2 b = vec2(0.14 * s, -0.66);
      float st = sdSeg(p, a, b) - 0.017;
      if (st < px) {
        vec2 dir = normalize(b - a);
        float across = dot(p - a, vec2(-dir.y, dir.x)) / 0.017;
        vec3 col = OLIVE * 1.15 * (0.8 + 0.2 * (1.0 - across * across));
        // Stitching down each side.
        col *= 1.0 - 0.3 * smoothstep(0.12, 0.0, abs(abs(across) - 0.72)) * step(0.5, fract(dot(p - a, dir) * 120.0));
        over(col, cover(st));
        float fit = sdBox(p, mix(a, b, 0.42), vec2(0.024, 0.012), 0.003);
        over(vec3(0.42, 0.43, 0.44) * shade(vec3(0.0, 0.5, 0.8)), cover(fit));
      }
    }
    // The firing handles: loops striped yellow and black.
    vec2 hq = vec2(ax, p.y) - vec2(${f(HANDLE_X)}, ${f(HANDLE_Y)});
    float loop = abs(sdBox(hq, vec2(0.0), vec2(${f(HANDLE_HX)}, ${f(HANDLE_HY)}), 0.016)) - 0.0075;
    if (loop < px) {
      float stripe = step(0.5, fract((p.x * sx + p.y) * 55.0));
      vec3 col = mix(vec3(0.85, 0.66, 0.06), vec3(0.03), stripe);
      col *= 0.55 + 0.6 * smoothstep(-0.01, 0.02, hq.y);
      over(col, cover(loop));
    }
  }

  // The cockpit sides at the lower corners, with the displays' bezels.
  {
    float inner = ${f(SILL_IN)} + 0.08 * (p.y - ${f(SILL_IN_Y)});
    float d = max(p.y - sill(ax), inner - ax);
    if (d < px) {
      float rim = smoothstep(0.012, 0.0, -d);
      vec3 col = vec3(0.15, 0.16, 0.17) * (0.55 + 0.2 * vnoise(p * 30.0, uSeed + 8.0));
      col += rim * 0.16;
      // The canopy rail along the sill.
      col *= 1.0 - 0.5 * smoothstep(0.003, 0.0, abs(-d - 0.016));
      over(col, cover(d));
      vec2 m = vec2(ax, p.y) - vec2(${f(MFD_X)}, ${f(MFD_Y)});
      float bezel = sdBox(m, vec2(0.0), vec2(${f(MFD_HX + 0.018)}, ${f(MFD_HY + 0.018)}), 0.008);
      if (bezel < px) {
        vec3 b = vec3(0.075, 0.078, 0.08) * (1.0 + 0.6 * smoothstep(0.004, 0.0, -bezel) * (m.y > 0.0 ? 1.0 : -0.4));
        over(b, cover(bezel));
        // Push buttons round the screen's edges.
        vec2 g = m;
        float btn = 1.0;
        if (abs(g.y) > ${f(MFD_HY + 0.004)}) {
          float cx = (fract(g.x / 0.03 + 0.5) - 0.5) * 0.03;
          btn = sdBox(vec2(cx, abs(g.y) - ${f(MFD_HY + 0.0095)}), vec2(0.0), vec2(0.0075, 0.0045), 0.0015);
          btn = max(btn, abs(g.x) - 0.08);
        } else if (abs(g.x) > ${f(MFD_HX + 0.004)}) {
          float cy = (fract(g.y / 0.03 + 0.5) - 0.5) * 0.03;
          btn = sdBox(vec2(abs(g.x) - ${f(MFD_HX + 0.0095)}, cy), vec2(0.0), vec2(0.0045, 0.0075), 0.0015);
          btn = max(btn, abs(g.y) - 0.05);
        }
        over(vec3(0.24, 0.245, 0.25), cover(btn));
        float screen = sdBox(m, vec2(0.0), vec2(${f(MFD_HX)}, ${f(MFD_HY)}), 0.004);
        over(vec3(0.008, 0.012, 0.01), cover(screen));
      }
    }
  }

  outColor = acc;
}
`;

/**
 * The view outside, every frame at reduced size, banked: the sky with its sun
 * or moon above the horizon, and below it the cloud deck (the sea of clouds'
 * cloud tops, with gaps to the ground by cover), scattered clouds on a nearer
 * plane, and now and then a near cloud fogging the view.
 */
const OUTSIDE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uBillow;
uniform sampler2D uNoise;
/** Frame heights per pixel, aspect, and the bank's cos and sin. */
uniform vec4 uFrame;
/** Horizon height, unused, billow slope scale, unused. */
uniform vec4 uView;
/** Deck threshold and opacity, scattered clouds' threshold and opacity. */
uniform vec4 uCover;
/** Octave offsets: (0.xy, 1.xy) and (2.xy, scattered clouds' xy). */
uniform vec4 uOffA;
uniform vec4 uOffB;
/** Near cloud: thickness, phase, and an offset for its shape. */
uniform vec4 uFog;
uniform vec3 uLight;
/** Sun or moon: across, above the horizon, disc radius, glow strength. */
uniform vec4 uSun;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uLightCol;
uniform vec3 uShade;
uniform vec3 uHaze;
uniform vec3 uGround;
uniform vec3 uDisc;

out vec4 outColor;

const float FOCAL = ${f(FOCAL)};
const float CAM_HEIGHT = ${f(CAM_HEIGHT)};
const float PUFF_HEIGHT = ${f(PUFF_HEIGHT)};
const float PUFF_FREQ = ${f(PUFF_FREQ)};
const float HAZE_K = ${f(HAZE_K)};
/** The clouds' noise: four octaves per fetch, their weights, mean and scale to unit spread. */
const vec4 OCT = vec4(0.5, 0.25, 0.125, 0.0625);
const float MEAN = 0.46875;
const float NORM = 10.0;
${CLOUD_TOPS_GLSL}

vec3 sky(vec2 q, float y) {
  float t = clamp(y / (0.75 - uView.x), 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 1.0, sqrt(t)));
  // A band of haze along the horizon.
  col = mix(col, uHaze, 0.55 * exp(-y * 22.0));
  vec2 sun = vec2(uSun.x, uView.x + uSun.y);
  float d = length(q - sun);
  float glow = uSun.w * (0.45 * exp(-d * 10.0) + 0.3 * exp(-d * 2.6) * (1.0 - 0.6 * t));
  col = mix(col, uGlow, clamp(glow, 0.0, 1.0));
  float disc = 1.0 - smoothstep(uSun.z * 0.85, uSun.z, d);
  return mix(col, uDisc, disc);
}

/** Cheap smooth variation for the ground, from the billow texture's height. */
float groundNoise(vec2 w) {
  return textureLod(uBillow, w * 0.031 + 0.37, 0.0).r;
}

vec3 below(vec2 q, float y) {
  float b = -y;
  float px = uFrame.x;
  // The cloud deck.
  float z = FOCAL * CAM_HEIGHT / b;
  vec2 w = vec2(q.x * CAM_HEIGHT / b, z);
  float foot = z * z * px / (FOCAL * CAM_HEIGHT);
  vec2 g;
  float h = cloudTops(w, foot, uOffA, uOffB.xy, uView.z, g);
  vec3 n = normalize(vec3(-RELIEF * g.x, 1.0, -RELIEF * g.y));
  float diffuse = clamp(dot(n, uLight) * 0.6 + 0.45, 0.0, 1.0);
  float top = smoothstep(-0.6, 0.7, h);
  vec3 cloud = mix(uShade, uLightCol, diffuse * mix(0.4, 1.0, top));
  // Looking toward the sun, the tops glow.
  float toward = pow(max(dot(normalize(vec2(q.x, FOCAL)), normalize(vec2(uSun.x, FOCAL))), 0.0), 40.0);
  cloud += uGlow * toward * uSun.w * 0.25;
  float dens = smoothstep(uCover.x, uCover.x + 0.35, h) * uCover.y;
  // Through the gaps, the ground far below, darker under the clouds' edges.
  vec3 ground = uGround * (0.75 + 0.5 * groundNoise(w * 0.7)) * mix(1.0, 0.6, smoothstep(uCover.x - 0.4, uCover.x, h));
  vec3 col = mix(ground, cloud, dens);
  col = mix(col, uHaze, 1.0 - exp(-HAZE_K * z));

  // Scattered clouds on a nearer plane, streaming by faster; the finer
  // octaves fade out where a pixel spans them.
  float z2 = FOCAL * PUFF_HEIGHT / b;
  if (uCover.w > 0.0 && z2 < 70.0) {
    vec2 w2 = vec2(q.x * PUFF_HEIGHT / b, z2);
    float foot2 = z2 * z2 * px / (FOCAL * PUFF_HEIGHT);
    vec4 fade = 1.0 - smoothstep(0.25, 0.6, foot2 * PUFF_FREQ * vec4(4.0, 8.0, 16.0, 32.0));
    vec4 t = texture(uNoise, w2 * PUFF_FREQ + uOffB.zw);
    float pn = dot(t - 0.5, OCT * fade) * NORM;
    float a = smoothstep(uCover.z, uCover.z + 0.9, pn) * uCover.w * (1.0 - smoothstep(30.0, 70.0, z2));
    if (a > 0.0) {
      vec3 puff = mix(uShade, uLightCol, 0.5 + 0.5 * smoothstep(uCover.z, uCover.z + 2.0, pn));
      puff = mix(puff, uHaze, 1.0 - exp(-HAZE_K * z2));
      col = mix(col, puff, a);
    }
  }
  return col;
}

void main() {
  float px = uFrame.x;
  vec2 p = gl_FragCoord.xy * px - vec2(0.5 * uFrame.y, 0.5);
  // Into the level world's frame: the bank turned back.
  vec2 q = vec2(uFrame.z * p.x + uFrame.w * p.y, -uFrame.w * p.x + uFrame.z * p.y);
  float y = q.y - uView.x;
  vec3 col = y >= 0.0 ? sky(q, y) : below(q, y);
  // Blend across the horizon's pixel, so it doesn't stair-step when banked.
  float edge = abs(y) / px;
  if (edge < 1.0) {
    vec3 other = y >= 0.0 ? below(q, -px) : sky(q, px);
    col = mix(other, col, 0.5 + 0.5 * edge);
  }

  // A near cloud streaming away from the camera: soft fog, its wisps
  // shrinking towards the horizon as the cloud recedes.
  if (uFog.x > 0.0) {
    vec2 r = (q - vec2(0.0, uView.x)) * (0.9 + 2.2 * uFog.y);
    float n = (dot(texture(uNoise, r * 0.32 + uFog.zw), OCT) - MEAN) * NORM;
    float dens = uFog.x * clamp(0.6 + 0.12 * n, 0.0, 1.0);
    col = mix(col, mix(uLightCol, uHaze, 0.35), dens);
  }
  outColor = vec4(col, 1.0);
}
`;

/** Green and amber display symbols. */
const GREEN: readonly [number, number, number] = [0.35, 1.0, 0.45];
const AMBER: readonly [number, number, number] = [1.0, 0.68, 0.18];
const v3 = (c: readonly [number, number, number]) => `vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`;

/**
 * Each frame: the cached cockpit, lit for the time of day, over the view
 * outside (upscaled) with stars at night, and the displays' symbols and
 * readings in their screens.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uCockpit;
uniform sampler2D uOutside;
uniform sampler2D uGlyphs;
uniform vec2 uResolution;
uniform vec3 uCabin;
/** The bank's cos and sin, the horizon's height, and how many stars show. */
uniform vec4 uRoll;
uniform float uTime;
/** The heading tape's position (0..1 per turn). */
uniform float uHeading;
/** Each readout's glyphs, and its brightness. */
uniform vec4 uGlyph[${String(READOUTS)}];
uniform vec4 uLevels;

out vec4 outColor;
${NOISE_GLSL}
${DITHER_GLSL}

const vec2 MFD = vec2(${f(MFD_X)}, ${f(MFD_Y)});
const vec2 MFD_H = vec2(${f(MFD_HX)}, ${f(MFD_HY)});
const float GLYPH_W = ${f(GLYPH_CELL / (GLYPH_CELL * GLYPH_COUNT))};
const float GLYPH_ASPECT = ${f(GLYPH_CELL / GLYPH_ROWS)};

/** Stars in the banked sky: one hashed cell per point. */
vec3 stars(vec2 p) {
  vec2 q = vec2(uRoll.x * p.x + uRoll.y * p.y, -uRoll.y * p.x + uRoll.x * p.y);
  float y = q.y - uRoll.z;
  if (y < 0.01) {
    return vec3(0.0);
  }
  vec2 c = q / 0.012;
  vec2 cell = floor(c);
  float h = hash2(cell, 3.0);
  if (h > 0.07) {
    return vec3(0.0);
  }
  vec2 at = vec2(hash2(cell, 4.0), hash2(cell, 5.0)) * 0.6 + 0.2;
  float d = length(fract(c) - at) * 0.012 * uResolution.y;
  float b = (0.25 + 0.75 * hash2(cell, 6.0)) * exp(-d * d * 0.9);
  return vec3(0.85, 0.9, 1.0) * b * smoothstep(0.01, 0.06, y);
}

/** Readout line \`line\`'s glyphs at uv (0..1 over the line's box). */
float readout(int line, vec2 uv) {
  float gi = floor(uv.x * ${f(READOUT_GLYPHS)});
  if (uv.y < 0.0 || uv.y > 1.0 || gi < 0.0 || gi >= ${f(READOUT_GLYPHS)}) {
    return 0.0;
  }
  float glyph = uGlyph[line][int(gi)];
  vec2 t = vec2((glyph + fract(uv.x * ${f(READOUT_GLYPHS)})) * GLYPH_W, uv.y);
  return texture(uGlyphs, t).r;
}

/** One display's symbols and readings at uv (0..1 over its screen): 1 the left, 0 the right. */
vec3 display(vec2 uv, float left) {
  float aspect = MFD_H.x / MFD_H.y;
  float v = 0.0;
  // A thin frame just inside the screen.
  vec2 e = abs(uv - 0.5) * vec2(aspect, 1.0);
  float fr = max(e.x - (0.46 * aspect), e.y - 0.46);
  v += 0.3 * smoothstep(0.012, 0.0, abs(fr));
  vec2 s = (uv - vec2(0.5, 0.7)) * vec2(aspect, 1.0);
  if (left > 0.5) {
    // Attitude: a horizon that rolls with the bank, a short pitch ladder, the
    // aircraft's mark fixed in the middle.
    vec2 r = vec2(uRoll.x * s.x + uRoll.y * s.y, -uRoll.y * s.x + uRoll.x * s.y);
    if (abs(s.x) < 0.55 && abs(s.y) < 0.24) {
      v += smoothstep(0.014, 0.0, abs(r.y));
      for (int i = -1; i <= 1; i += 2) {
        float ly = float(i) * 0.12;
        v += 0.6 * smoothstep(0.01, 0.0, abs(r.y - ly)) * step(abs(r.x), 0.18) * step(0.06, abs(r.x));
      }
    }
    float wing = min(length(s - vec2(clamp(s.x, -0.2, -0.06), 0.0)), length(s - vec2(clamp(s.x, 0.06, 0.2), 0.0)));
    v += smoothstep(0.016, 0.006, wing) + smoothstep(0.022, 0.012, length(s));
  } else {
    // Heading: a tape of ticks sliding as the jet turns, with a fixed caret,
    // and a level bar beside it.
    if (abs(s.x) < 0.6 && s.y > -0.02 && s.y < 0.12) {
      // A tick every 10 degrees, a long one every 30.
      float u = s.x * 8.0 + uHeading * 36.0;
      float k = floor(u + 0.5);
      float d = abs(u - k) / 8.0;
      float top = mod(k, 3.0) < 0.5 ? 0.11 : 0.05;
      v += 0.8 * smoothstep(0.008, 0.003, d) * step(s.y, top);
    }
    float caret = 0.04 + (s.y + 0.03) * 0.8;
    v += step(abs(s.x), caret) * step(s.y, -0.03);
    float lvl = 0.5 + 0.35 * sin(uTime * 0.07) + 0.1 * sin(uTime * 0.19);
    vec2 bq = (uv - vec2(0.82, 0.6)) / vec2(0.06, 0.26);
    if (abs(bq.x) < 1.0 && abs(bq.y) < 1.0) {
      float fill = step(bq.y * 0.5 + 0.5, lvl);
      v += 0.25 + 0.55 * fill * step(0.5, fract(bq.y * 6.0 + 0.25));
    }
  }
  // Two readouts below, right-aligned, each after a short label bar.
  int base = left > 0.5 ? 0 : 2;
  for (int i = 0; i < 2; i++) {
    float y0 = i == 0 ? 0.28 : 0.08;
    float gh = 0.15;
    float gw = gh * GLYPH_ASPECT / aspect;
    vec2 lu = vec2((uv.x - (0.9 - gw * ${f(READOUT_GLYPHS)})) / (gw * ${f(READOUT_GLYPHS)}), (uv.y - y0) / gh);
    float lvl = uLevels[base + i];
    v += readout(base + i, lu) * lvl;
    float label = step(0.12, uv.x) * step(uv.x, 0.3) * step(abs(uv.y - y0 - gh * 0.5), gh * 0.18);
    v += 0.35 * label * lvl;
  }
  vec3 tint = left > 0.5 ? ${v3(GREEN)} : ${v3(AMBER)};
  // Faint scanlines.
  return tint * v * 0.85 * (0.9 + 0.1 * sin(uv.y * 160.0));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec4 ck = texelFetch(uCockpit, ivec2(frag), 0);
  vec3 outside = texture(uOutside, frag / uResolution).rgb;
  vec2 p = (frag - 0.5 * uResolution) / uResolution.y;
  if (uRoll.w > 0.0 && ck.a < 0.999) {
    outside += stars(p) * uRoll.w;
  }
  vec3 col = ck.rgb * uCabin + (1.0 - ck.a) * outside;
  vec2 m = vec2(abs(p.x), p.y) - MFD;
  if (abs(m.x) < MFD_H.x && abs(m.y) < MFD_H.y) {
    vec2 uv = (m + MFD_H) / (2.0 * MFD_H);
    // The right-hand screen reads left to right too.
    uv.x = p.x < 0.0 ? 1.0 - uv.x : uv.x;
    col += display(uv, p.x < 0.0 ? 1.0 : 0.0);
  }
  outColor = vec4(col + dither8(frag), 1.0);
}
`;

/**
 * Jet Cockpit. The cockpit is drawn once per resize or change of variation
 * into its own target. Each frame renders the banked view outside at reduced
 * size, then one composite lays the cockpit, lit for the time of day, and its
 * displays over it.
 */
export const jetcockpit = defineEffect(jetcockpitMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fs: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fs), (p) => {
          gl.deleteProgram(p);
        });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const cockpitProgram = program(COCKPIT_FRAGMENT);
      const pu = createUniforms(gl, cockpitProgram, ["uResolution", "uSeed"]);
      const outsideProgram = program(OUTSIDE_FRAGMENT);
      const ou = createUniforms(gl, outsideProgram, [
        "uBillow",
        "uNoise",
        "uFrame",
        "uView",
        "uCover",
        "uOffA",
        "uOffB",
        "uFog",
        "uLight",
        "uSun",
        "uZenith",
        "uHorizon",
        "uGlow",
        "uLightCol",
        "uShade",
        "uHaze",
        "uGround",
        "uDisc",
      ]);
      const compositeProgram = program(COMPOSITE_FRAGMENT);
      const cu = createUniforms(gl, compositeProgram, [
        "uCockpit",
        "uOutside",
        "uGlyphs",
        "uResolution",
        "uCabin",
        "uRoll",
        "uTime",
        "uHeading",
        "uGlyph",
        "uLevels",
      ]);
      gl.useProgram(outsideProgram);
      ou.i1("uBillow", 0);
      ou.i1("uNoise", 1);
      gl.useProgram(compositeProgram);
      cu.i1("uCockpit", 0);
      cu.i1("uOutside", 1);
      cu.i1("uGlyphs", 2);
      gl.useProgram(null);

      const texture = (t: WebGLTexture) =>
        scope.add(t, (x) => {
          gl.deleteTexture(x);
        });
      const billow = buildBillowTexture(BILLOW_SIZE, 0xc10d);
      const billowTexture = texture(
        createDataTexture(gl, {
          width: BILLOW_SIZE,
          height: BILLOW_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: billow.data,
          wrap: gl.REPEAT,
        }),
      );
      const noiseTexture = texture(
        createDataTexture(gl, {
          width: NOISE_SIZE,
          height: NOISE_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(NOISE_SIZE, cloudNoiseChannels(NOISE_SEED)),
          wrap: gl.REPEAT,
        }),
      );
      const glyphTexture = texture(
        createDataTexture(gl, {
          width: GLYPH_CELL * GLYPH_COUNT,
          height: GLYPH_ROWS,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildGlyphAtlas(),
        }),
      );

      let cockpit: RenderTarget | null = null;
      let outside: RenderTarget | null = null;
      scope.defer(() => {
        cockpit?.dispose();
        outside?.dispose();
        cockpit = outside = null;
      });

      const sky = createJetSky();
      const pass = createPass();
      /** Cloud-top octave offsets (0..5), then the scattered clouds' (6, 7). */
      const offsets = new Float64Array(8);
      const glyphs = new Float32Array(READOUTS * READOUT_GLYPHS);
      const keys = new Float64Array(READOUTS).fill(Number.NaN);
      const light: [number, number, number] = [0, 0, 0];
      let glyphSeed = Number.NaN;
      let width = 1;
      let height = 1;
      let time = 0;
      let wobble = 0;
      let heading = 0;
      let cockpitSeed = Number.NaN;
      let started = false;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          cockpit?.dispose();
          outside?.dispose();
          cockpit = createRenderTarget(gl, width, height, gl.RGBA8, { filter: gl.NEAREST });
          outside = createRenderTarget(
            gl,
            lowResSize(width, OUTSIDE_DIVISOR),
            lowResSize(height, OUTSIDE_DIVISOR),
            gl.RGBA8,
          );
          cockpitSeed = Number.NaN;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const seed = Math.floor(clamp(p.seed, 0, 999));
          if (!cockpit || !outside) {
            return;
          }

          // 1. The cockpit, when it may have changed.
          if (seed !== cockpitSeed) {
            cockpitSeed = seed;
            gl.useProgram(cockpitProgram);
            pu.f2("uResolution", width, height);
            pu.f1("uSeed", seed);
            cockpit.bind();
            triangle.draw();
          }

          // 2. The time of day, the bank, and the clouds' drift.
          const target = lookup(SKIES, p.time, "day");
          if (!started) {
            approachSky(sky, target, Infinity);
            started = true;
          } else {
            approachSky(sky, target, step);
          }
          const amount = clamp(p.bank, 0, 1);
          const cover = clamp(p.clouds, 0, 1);
          const bank = bankAt(time, seed, amount);
          wobble = (wobble + step / WOBBLE.period) % 1;
          const roll = bank + WOBBLE_ROLL * amount * swayAt(WOBBLE, wobble, 0);
          const horizon = HORIZON + WOBBLE_LIFT * amount * swayAt(WOBBLE, wobble, 23);
          heading = wrap(heading + (step * TURN_RATE * Math.tan(bank)) / 360, 0, 1);
          passAt(time, seed, cover, pass);
          driftTops(offsets, 0, -SPEED * step);
          offsets[7] = wrap(offsets[7] - SPEED * step * PUFF_FREQ, 0, 1);
          const sunLen = Math.hypot(sky.sunX, Math.max(sky.sunY, 0.05), FOCAL);
          light[0] = sky.sunX / sunLen;
          light[1] = Math.max(sky.sunY, 0.05) / sunLen;
          light[2] = FOCAL / sunLen;
          const cos = Math.cos(roll);
          const sin = Math.sin(roll);

          // 3. The view outside.
          outside.bind();
          gl.useProgram(outsideProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, billowTexture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTexture);
          ou.f4("uFrame", 1 / outside.height, width / height, cos, sin);
          ou.f4("uView", horizon, 0, billow.slopeScale, 0);
          ou.f4(
            "uCover",
            0.9 - 1.9 * cover,
            coverageOpacity(cover),
            coverageThreshold(cover * 0.6),
            0.9 * coverageOpacity(cover),
          );
          ou.f4("uOffA", offsets[0], offsets[1], offsets[2], offsets[3]);
          ou.f4("uOffB", offsets[4], offsets[5], offsets[6], offsets[7]);
          ou.f4(
            "uFog",
            pass.level,
            pass.phase,
            ((pass.index * 0.618034) % 1) + seed * 0.0131,
            ((pass.index * 0.414214) % 1) + 0.5,
          );
          ou.v3("uLight", light);
          ou.f4("uSun", sky.sunX, sky.sunY, sky.sunR, sky.glowStrength);
          ou.v3("uZenith", sky.zenith);
          ou.v3("uHorizon", sky.horizon);
          ou.v3("uGlow", sky.glow);
          ou.v3("uLightCol", sky.light);
          ou.v3("uShade", sky.shade);
          ou.v3("uHaze", sky.haze);
          ou.v3("uGround", sky.ground);
          ou.v3("uDisc", sky.disc);
          triangle.draw();

          // 4. The readouts, when they change.
          let changed = seed !== glyphSeed;
          glyphSeed = seed;
          for (let i = 0; i < READOUTS; i++) {
            const key = readingKey(i, seed, time);
            if (changed || key !== keys[i]) {
              keys[i] = key;
              readingGlyphs(i, seed, key, glyphs, i * READOUT_GLYPHS);
              changed = true;
            }
          }

          // 5. The composite.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(compositeProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, cockpit.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, outside.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
          cu.f2("uResolution", width, height);
          cu.v3("uCabin", sky.cabin);
          cu.f4("uRoll", cos, sin, horizon, sky.stars * (1 - pass.level / PASS_PEAK));
          cu.f1("uTime", time % SHADER_PERIOD);
          cu.f1("uHeading", heading);
          if (changed) {
            gl.uniform4fv(cu.loc.uGlyph, glyphs);
          }
          cu.f4(
            "uLevels",
            1 - 0.5 * readingDim(0, seed, time),
            1 - 0.5 * readingDim(1, seed, time),
            1 - 0.5 * readingDim(2, seed, time),
            1 - 0.5 * readingDim(3, seed, time),
          );
          triangle.draw();
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
