/**
 * 1940s Detective Office's room: where everything stands, in metres, and the
 * GLSL that finds what a pixel sees and how the light reaches it.
 *
 * The camera sits at the origin looking down +z, y up, with a focal length of
 * FOCAL design px (a design px is a px of a 1080-tall frame at 16:9; narrower
 * frames show the room smaller, see `fitScale`). The back wall is at z = DEPTH,
 * the side walls at x = +-HALF_W, the ceiling at y = CEILING. The desk's top
 * runs along the bottom of the frame and the window, on the right wall, faces
 * a sign across the street, whose light comes in through the blinds and falls
 * across the back wall and the ceiling.
 */
import { glslFloat as f } from "../gl";
import { SLAT_GAP_GLSL } from "../slats";

export const FOCAL = 900;
const DEPTH = 4;
const HALF_W = 2.3;
const CEILING = 1.6;
const FLOOR = -1.45;
/** The desk top's height and its far edge. */
const DESK_Y = -0.55;
const DESK_Z = 1.35;

/** The window on the right wall: near and far edge (z), sill and head (y), and its frame's width. */
const WIN_Z0 = 2.35;
const WIN_Z1 = 3.8;
const WIN_Y0 = -0.6;
const WIN_Y1 = 0.9;
const WIN_FRAME = 0.07;
/** The blinds: slat pitch (m), and how far each gap reaches either side of its centre, in pitches. */
const SLAT_PITCH = 0.13;
const SLAT_HALF_GAP = 0.2;

/** Which way the sign's light travels into the room (unit length): left, a little up, towards the back. */
const LIGHT_RAW = [-0.9, 0.27, 0.342] as const;
const LIGHT_LEN = Math.hypot(...LIGHT_RAW);
const LIGHT = LIGHT_RAW.map((v) => v / LIGHT_LEN);
/**
 * The light the fan's shadow is cast along: the sign's, with less of its
 * sideways slant, so the blades' shadow on the back wall reads as a fan
 * rather than a long smear.
 */
const FAN_LIGHT_RAW = [LIGHT[0] * 0.35, LIGHT[1], LIGHT[2]] as const;
const FAN_LIGHT_LEN = Math.hypot(...FAN_LIGHT_RAW);
const FAN_LIGHT = FAN_LIGHT_RAW.map((v) => v / FAN_LIGHT_LEN);

/** The door on the left wall: near and far edge (z), top (y); and its glass panel. */
const DOOR_Z0 = 2.2;
const DOOR_Z1 = 3.2;
const DOOR_TOP = 0.78;
export const PANEL_Z0 = 2.34;
export const PANEL_Z1 = 3.06;
export const PANEL_Y0 = -0.02;
export const PANEL_Y1 = 0.62;

/** The ceiling fan: hub centre (x, y, z), blade reach (m). */
const FAN_X = -0.55;
const FAN_Y = 0.96;
const FAN_Z = 3.5;
const FAN_R = 0.45;

/** The banker's lamp's bulb, under its shade. */
const LAMP_X = -0.82;
const LAMP_Y = -0.27;
const LAMP_Z = 1.2;

/** The coffee cup on the desk: centre x, z, and its rim's radius and height. */
export const CUP_X = 0.62;
export const CUP_Z = 1.0;
export const CUP_R = 0.042;
export const CUP_TOP = -0.47;

/** Where a point at (x, y, z) shows, in design px from the frame's centre, y up. */
export function project(x: number, y: number, z: number, out: Float64Array): Float64Array {
  out[0] = (FOCAL * x) / z;
  out[1] = (FOCAL * y) / z;
  return out;
}

/** The room's constants and the GLSL both passes share. */
export const ROOM_GLSL = /* glsl */ `
const float FOCAL = ${f(FOCAL)};
const float DEPTH = ${f(DEPTH)};
const float HALF_W = ${f(HALF_W)};
const float CEILING = ${f(CEILING)};
const float FLOOR = ${f(FLOOR)};
const float DESK_Y = ${f(DESK_Y)};
const float DESK_Z = ${f(DESK_Z)};
const vec4 WIN = vec4(${f(WIN_Z0)}, ${f(WIN_Z1)}, ${f(WIN_Y0)}, ${f(WIN_Y1)});
const float WIN_FRAME = ${f(WIN_FRAME)};
const float SLAT_PITCH = ${f(SLAT_PITCH)};
const float SLAT_HALF_GAP = ${f(SLAT_HALF_GAP)};
const vec3 LIGHT = vec3(${f(LIGHT[0])}, ${f(LIGHT[1])}, ${f(LIGHT[2])});
const vec3 LAMP_P = vec3(${f(LAMP_X)}, ${f(LAMP_Y)}, ${f(LAMP_Z)});
/** The door: centre z, half width, top. */
const vec3 DOOR = vec3(${f((DOOR_Z0 + DOOR_Z1) / 2)}, ${f((DOOR_Z1 - DOOR_Z0) / 2)}, ${f(DOOR_TOP)});
const vec3 FAN_LIGHT = vec3(${f(FAN_LIGHT[0])}, ${f(FAN_LIGHT[1])}, ${f(FAN_LIGHT[2])});
const vec3 FAN = vec3(${f(FAN_X)}, ${f(FAN_Y)}, ${f(FAN_Z)});
const float FAN_R = ${f(FAN_R)};
${SLAT_GAP_GLSL}

/**
 * The room's surfaces along ray r (r.z = 1, so t is the depth): returns the
 * depth and sets the normal and which surface (0 back wall, 1 left wall,
 * 2 right wall, 3 ceiling, 4 floor, 5 desk top).
 */
float roomHit(vec3 r, out vec3 N, out int id) {
  float t = DEPTH;
  N = vec3(0.0, 0.0, -1.0);
  id = 0;
  if (r.x < 0.0 && -HALF_W / r.x < t) { t = -HALF_W / r.x; N = vec3(1.0, 0.0, 0.0); id = 1; }
  if (r.x > 0.0 && HALF_W / r.x < t) { t = HALF_W / r.x; N = vec3(-1.0, 0.0, 0.0); id = 2; }
  if (r.y > 0.0 && CEILING / r.y < t) { t = CEILING / r.y; N = vec3(0.0, -1.0, 0.0); id = 3; }
  if (r.y < 0.0) {
    if (FLOOR / r.y < t) { t = FLOOR / r.y; N = vec3(0.0, 1.0, 0.0); id = 4; }
    float desk = DESK_Y / r.y;
    if (desk < DESK_Z && desk < t) { t = desk; N = vec3(0.0, 1.0, 0.0); id = 5; }
  }
  return t;
}

/** A soft 0..1 box test of p against lo..hi, edges soft by s. */
float inBox(vec2 p, vec2 lo, vec2 hi, float s) {
  vec2 a = smoothstep(lo - s, lo + s, p) * (1.0 - smoothstep(hi - s, hi + s, p));
  return a.x * a.y;
}

/**
 * The sign's light reaching point P (normal N) through the window and the
 * blinds, before its colour and level: traced back along the light to the
 * window, where the opening and the slats' gaps decide how much gets through.
 * The slats' shadows soften with distance from them. \`aa\` is a pixel's size
 * in metres, so the stripes never alias.
 */
float throughBlinds(vec3 P, vec3 N, float aa) {
  float lambert = dot(N, -LIGHT);
  float s = (HALF_W - P.x) / -LIGHT.x;
  if (lambert <= 0.0 || s <= 0.0) {
    return 0.0;
  }
  vec3 Q = P - LIGHT * s;
  float soft = max(0.004 + 0.014 * s, aa * 0.7);
  float m = inBox(Q.zy, WIN.xz, WIN.yw, soft);
  float gap = slatGap((Q.y - WIN.z) / SLAT_PITCH, soft / SLAT_PITCH * 1.6, SLAT_HALF_GAP + 0.06);
  return lambert * m * gap / (1.0 + 0.06 * s * s);
}

/**
 * The fan's blades and hub at q (metres from the hub, in its plane), turned by
 * the angle whose cosine and sine are cs: 1 on a blade, 0 off, edges soft by s.
 */
float fanBlades(vec2 q, vec2 cs, float s) {
  q = vec2(cs.x * q.x - cs.y * q.y, cs.y * q.x + cs.x * q.y);
  vec2 a = abs(q);
  vec2 b = a.x > a.y ? a : a.yx;
  float halfW = mix(0.04, 0.075, smoothstep(0.08, 0.4, b.x));
  float blade = (1.0 - smoothstep(halfW - s, halfW + s, b.y))
    * (1.0 - smoothstep(FAN_R - 0.04 - s, FAN_R + s, b.x + 0.25 * b.y));
  float hub = 1.0 - smoothstep(0.075 - s, 0.075 + s, length(q));
  return max(blade, hub);
}
`;
