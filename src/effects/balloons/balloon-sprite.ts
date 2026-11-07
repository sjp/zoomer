/**
 * The hot-air balloon sprite: an instanced outline per balloon, shaded
 * analytically (gored envelope, burner glow, basket and lines, haze). Shared by
 * the Hot-Air Balloons effect and the distant balloons of the Hot-Air Balloon
 * Ride. Instances are `BALLOON_FLOATS` floats each, in `BALLOON_LAYOUT` groups
 * (see `writeBalloons`), drawn with `BALLOON_STRIP`, premultiplied.
 */
import { DITHER_GLSL, glslFloat } from "../gl";
import {
  APEX_Y,
  BASKET_BOTTOM,
  BASKET_HALF,
  BASKET_TOP,
  CONE_COS,
  CONE_SIN,
  MOUTH_HALF,
  MOUTH_Y,
  TANGENT_Y,
} from "./balloons-sim";

/** The instance attribute groups, for `createSpriteBatch`: `BALLOON_FLOATS` in all. */
export const BALLOON_LAYOUT: readonly number[] = [4, 4, 4, 4, 2];

/**
 * Balloons: one instance each, drawn in a tight outline. \`vLocal\` is in radius
 * units (the envelope's round top is the unit circle), y up.
 */
export const BALLOON_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (px, y up), radius (px), opacity. */
layout(location = 1) in vec4 aPos;
/** Colour A, haze. */
layout(location = 2) in vec4 aA;
/** Colour B, burner glow. */
layout(location = 3) in vec4 aB;
/** Colour C, gores. */
layout(location = 4) in vec4 aC;
/** Spin (radians), colour count. */
layout(location = 5) in vec2 aSpin;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
/** Spin, colour count, radius (px), opacity. */
flat out vec4 vMisc;
void main() {
  // 1.5 px of margin outwards, for the anti-aliased edge.
  vec2 px = aPos.xy + aCorner * aPos.z + sign(aCorner) * 1.5;
  vLocal = (px - aPos.xy) / aPos.z;
  vA = aA;
  vB = aB;
  vC = aC;
  vMisc = vec4(aSpin, aPos.zw);
  gl_Position = vec4(px / uResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const BALLOON_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vMisc;
/** Unit vector towards the sun (x right, y up, z towards the viewer). */
uniform vec3 uLightDir;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uHaze;
uniform vec3 uFlame;
out vec4 outColor;
${DITHER_GLSL}
const float TAU = 6.2831853;
const float APEX = ${glslFloat(APEX_Y)};
const float SIN_B = ${glslFloat(CONE_SIN)};
const float COS_B = ${glslFloat(CONE_COS)};
const float TAN_B = ${glslFloat(CONE_SIN / CONE_COS)};
const float TANGENT_Y = ${glslFloat(TANGENT_Y)};
const float MOUTH_Y = ${glslFloat(MOUTH_Y)};
const float MOUTH_HALF = ${glslFloat(MOUTH_HALF)};
const float BASKET_TOP = ${glslFloat(BASKET_TOP)};
const float BASKET_BOTTOM = ${glslFloat(BASKET_BOTTOM)};
const float BASKET_HALF = ${glslFloat(BASKET_HALF)};

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 p = vLocal;
  float rpx = vMisc.z;
  float ax = abs(p.x);

  // Envelope: the unit circle merged with a cone whose sides are tangent to it,
  // cut off at the mouth. Both terms are distances (radius units) inside.
  float eCircle = 1.0 - length(p);
  float eCone = min(min((p.y - APEX) * SIN_B - ax * COS_B, p.y - MOUTH_Y), TANGENT_Y - p.y);
  float cover = clamp(max(eCircle, eCone) * rpx + 0.5, 0.0, 1.0);

  // Gores: the horizontal coordinate mapped round a cylinder of the row's half-width.
  bool upper = p.y >= TANGENT_Y;
  float w = upper ? sqrt(max(1.0 - p.y * p.y, 0.0)) : max((p.y - APEX) * TAN_B, 0.0);
  float s = clamp(p.x / max(w, 0.001), -1.0, 1.0);
  float c = sqrt(1.0 - s * s);
  float theta = asin(s);
  float g = (theta + vMisc.x) * vC.w / TAU;
  float gi = floor(g);
  float gf = g - gi;
  float n = vMisc.y;
  float idx = mod(gi, n);
  float nb = mod(gi + (gf < 0.5 ? -1.0 : 1.0) + n, n);
  vec3 fabric = idx < 0.5 ? vA.rgb : (idx < 1.5 ? vB.rgb : vC.rgb);
  vec3 other = nb < 0.5 ? vA.rgb : (nb < 1.5 ? vB.rgb : vC.rgb);
  vec3 average = n < 2.5 ? 0.5 * (vA.rgb + vB.rgb) : (vA.rgb + vB.rgb + vC.rgb) / 3.0;
  // Seams anti-aliased with the neighbouring gore; where gores crowd below a
  // pixel near the limb, fade to the average colour.
  float gw = max(fwidth(g), 0.0001);
  float seam = clamp(min(gf, 1.0 - gf) / gw + 0.5, 0.5, 1.0);
  fabric = mix(other, fabric, seam);
  float crowd = smoothstep(0.25, 0.8, gw);
  fabric = mix(fabric, average, crowd);
  // Each gore bulges a little between its seams.
  fabric *= mix(0.9 + 0.1 * sin(3.1415927 * gf), 0.95, crowd);

  // Sphere-like normal: the circle's on top, the cone's below.
  float h = upper ? w : COS_B;
  float ny = upper ? p.y : -SIN_B;
  vec3 normal = vec3(h * s, ny, h * c);
  float light = smoothstep(-0.4, 1.0, dot(normal, uLightDir));
  vec3 env = fabric * mix(uShade, uLit, light);
  // Burner: lights the fabric round the mouth from inside.
  float glow = vB.w;
  vec2 dm = p - vec2(0.0, MOUTH_Y + 0.1);
  env += uFlame * (glow * 0.6 * exp2(-2.5 * dot(dm, dm)));

  // Basket, and the lines from the mouth down to it.
  vec2 bq = vec2(ax - BASKET_HALF, max(BASKET_BOTTOM - p.y, p.y - BASKET_TOP));
  float basket = clamp(-max(bq.x, bq.y) * rpx + 0.5, 0.0, 1.0);
  vec3 basketColor = vec3(0.36, 0.24, 0.14) * mix(uShade, uLit, 0.65 + 0.35 * sign(p.x * uLightDir.x));
  vec2 q = vec2(ax, p.y);
  float dl = min(
    segDist(q, vec2(MOUTH_HALF * 0.92, MOUTH_Y), vec2(BASKET_HALF * 0.9, BASKET_TOP)),
    segDist(q, vec2(MOUTH_HALF * 0.3, MOUTH_Y), vec2(BASKET_HALF * 0.3, BASKET_TOP))
  ) * rpx;
  float lw = clamp(0.012 * rpx, 0.3, 1.2);
  float lines = clamp(lw + 0.5 - dl, 0.0, 1.0) * 0.8;

  // Premultiplied: lines, then the basket over them, then the envelope over both.
  vec4 col = vec4(basketColor * 0.6, 1.0) * lines;
  col = vec4(basketColor, 1.0) * basket + col * (1.0 - basket);
  col = vec4(env, 1.0) * cover + col * (1.0 - cover);
  // Atmospheric haze towards the horizon sky.
  col.rgb = mix(col.rgb, uHaze * col.a, vA.w);
  // The burner flame itself: a small additive light at the mouth.
  vec2 df = p - vec2(0.0, MOUTH_Y);
  col.rgb += uFlame * (glow * (1.0 - 0.5 * vA.w) * 0.7 * exp2(-40.0 * dot(df, df)));
  col.rgb += dither8(gl_FragCoord.xy) * col.a;
  outColor = col * vMisc.w;
}
`;
