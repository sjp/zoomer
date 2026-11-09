/**
 * The wall clocks in the Scenes: where the hands point for a time of day, and
 * the GLSL for the dial's marks and the hands. Both shader snippets need
 * `SDF2D_GLSL` (and the hands `OVER_GLSL`) from `sdf-glsl.ts` before them.
 */
import { fract } from "./math";

const TAU = Math.PI * 2;

/**
 * The clock's hands for a local time of day `phase` (0..1 from midnight):
 * hour, minute and second angles, clockwise from twelve in radians. All move
 * smoothly, the second hand sweeping.
 */
export function clockHands(phase: number, out: Float64Array): Float64Array {
  const p = fract(Number.isFinite(phase) ? phase : 0);
  out[0] = fract(p * 2) * TAU;
  out[1] = fract(p * 24) * TAU;
  out[2] = fract(p * 1440) * TAU;
  return out;
}

/**
 * `clockMarks(q, R, ring, size)`: distance to the nearest minute or hour mark of
 * a dial of radius `R` centred on `q`'s origin, clockwise from twelve. Marks end
 * at `ring * R` from the centre; `size` is the hour marks' length and half width,
 * then the minute marks', as fractions of `R`.
 */
export const CLOCK_MARKS_GLSL = /* glsl */ `
float clockMarks(vec2 q, float R, float ring, vec4 size) {
  float step6 = TAU / 60.0;
  float a = atan(q.x, q.y);
  float k = floor(a / step6 + 0.5);
  float ka = k * step6;
  vec2 qq = vec2(cos(ka) * q.x - sin(ka) * q.y, sin(ka) * q.x + cos(ka) * q.y);
  bool hour = mod(k + 60.0, 5.0) < 0.5;
  float len = hour ? size.x : size.z;
  float wd = hour ? size.y : size.w;
  return sdBox(qq - vec2(0.0, R * (ring - len)), vec2(R * wd, R * len), 0.0);
}
`;

/**
 * `clockHandsAt(q, hands, R, ink, red, counterweight)`: the hour, minute and
 * second hands at angles `hands` (see `clockHands`) on a dial of radius `R`,
 * with their soft shadows, as premultiplied colour. Hour and minute hands are
 * `ink`, the second hand and centre cap `red`; `counterweight` adds a disc to
 * the second hand's tail.
 */
export const CLOCK_HANDS_GLSL = /* glsl */ `
vec4 hand(vec2 q, float ang, float len, float tail, float w, vec3 c) {
  vec2 dir = vec2(sin(ang), cos(ang));
  float d = max(abs(q.x * dir.y - q.y * dir.x) - w, max(-tail - dot(q, dir), dot(q, dir) - len));
  float a = cover(d);
  return vec4(c * a, a);
}
vec4 clockHandsAt(vec2 q, vec3 hands, float R, vec3 ink, vec3 red, bool counterweight) {
  vec2 s = q - vec2(0.004, -0.006) * (R / 0.088);
  float sh = 0.0;
  for (int i = 0; i < 3; i++) {
    float ang = i == 0 ? hands.x : i == 1 ? hands.y : hands.z;
    float len = i == 0 ? 0.5 : i == 1 ? 0.76 : 0.8;
    float w = i == 0 ? 0.03 : i == 1 ? 0.02 : 0.008;
    vec2 dir = vec2(sin(ang), cos(ang));
    float d = max(abs(s.x * dir.y - s.y * dir.x) - w * R, max(-0.15 * R - dot(s, dir), dot(s, dir) - len * R));
    sh = max(sh, clamp(0.5 - d / (4.0 * px), 0.0, 1.0));
  }
  vec4 o = vec4(0.0, 0.0, 0.0, 0.3 * sh * step(length(q), 0.9 * R));
  o = over(hand(q, hands.x, 0.5 * R, 0.12 * R, 0.03 * R, ink), o);
  o = over(hand(q, hands.y, 0.76 * R, 0.14 * R, 0.02 * R, ink), o);
  vec4 sec = hand(q, hands.z, 0.8 * R, 0.2 * R, 0.0085 * R, red);
  if (counterweight) {
    vec2 dir = vec2(sin(hands.z), cos(hands.z));
    float cw = cover(length(q + dir * 0.16 * R) - 0.035 * R);
    sec = over(vec4(red * cw, cw), sec);
  }
  o = over(sec, o);
  float cap = cover(length(q) - 0.045 * R);
  o = over(vec4(red * cap, cap), o);
  return o;
}
`;
