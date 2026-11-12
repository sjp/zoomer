import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  scopedProgram,
  updateDataTexture,
  withScope,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { approach, smoothstep } from "../math";
import { hash32, VALUE_NOISE_GLSL } from "../noise";
import { defineEffect } from "../types";
import { mazeMeta, WALL_OPTIONS } from "./maze.meta";
import {
  advanceRat,
  advanceWalker,
  cellIndex,
  chooseTurn,
  clampSize,
  createMaze,
  createRat,
  createWalker,
  DIR_X,
  DIR_Y,
  distanceField,
  FOCAL,
  generateMaze,
  GRID,
  handSign,
  type Maze,
  OBJ_SMILEY,
  placeRat,
  resetWalker,
  ROLL_SECONDS,
  SEG_DONE,
  SEG_WALK,
  turnSeconds,
  walkSeconds,
  walkTarget,
} from "./maze-sim";

/** Maze texture side: one texel per cell plus the outer east and north walls. */
const TEX = GRID + 1;
/** Classic renders this many lines tall (at least), upscaled with hard pixel edges. */
const CLASSIC_LINES = 360;
/** Seconds to fade to black at the exit (or on a size or variation change), and back. */
const RESET_FADE = 1.5;
/** Seconds of the dip to black and back that switches between Classic and Modern. */
const STYLE_DIP = 0.5;
/** Seconds a wall, ceiling or objects change crossfades over. */
const CROSSFADE = 1;
/** Object spin rates, radians per second. */
const SPIN_A = 0.5;
const SPIN_B = 0.31;
const SMILE_SPIN = 0.6;
const TAU = Math.PI * 2;

/** Wall material index in the shader for each `walls` option. */
function wallIndex(kind: string): number {
  for (let i = 0; i < WALL_OPTIONS.length; i++) {
    if (WALL_OPTIONS[i].value === kind) {
      return i;
    }
  }
  return 0;
}

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

/**
 * One texel per cell, values 0..255: r = west wall of the cell (1 wall, 2 the
 * start sign), g = south wall, b = the object floating in it. Column and row
 * GRID hold the outer east and north walls.
 */
uniform sampler2D uMaze;
uniform float uSize;
/** Maps gl_FragCoord to frame heights from the centre, y up. */
uniform vec2 uPixScale;
uniform vec2 uPixOffset;
/** Camera position in cells. */
uniform vec2 uCam;
/** Heading (x, y) and the roll's (cos, sin). */
uniform vec4 uView;
/** Wall materials crossfading: from, to, mix. */
uniform vec3 uWalls;
/** 0 tiled ceiling, 1 open sky. */
uniform float uSky;
uniform bool uModern;
uniform float uFade;
/** Object-space rotation of the polyhedra. */
uniform mat3 uSpin;
/** The smiley's facing (cos, sin). */
uniform vec2 uSmile;
/** Cell of the object being touched (x, y), its scale, and every object's scale. */
uniform vec4 uCollect;
/** Rat position (x, y), facing on screen (+1 right, -1 left) and scale. */
uniform vec4 uRat;
/** The start sign's arrow: +1 points right, -1 left. */
uniform float uArrow;

out vec4 outColor;

const int GRID = ${String(GRID)};
const int MAX_STEPS = ${String(2 * GRID + 4)};
const float FOCAL = ${glslFloat(FOCAL)};
/** Classic texels per cell: nearest-neighbour sampling of the procedural textures. */
const float TEXELS = 64.0;
const float MORTAR = 0.01;
const float OBJ_R = 0.22;
const float SMILE_R = 0.26;
/** The polyhedra's face planes (pairs of opposite faces), unit circumradius. */
const float OCT_IN = 0.5773503;
const vec3 OCT_N[4] = vec3[4](
  vec3(0.5773503, 0.5773503, 0.5773503), vec3(0.5773503, 0.5773503, -0.5773503),
  vec3(0.5773503, -0.5773503, 0.5773503), vec3(-0.5773503, 0.5773503, 0.5773503));
const float ICO_IN = 0.7946545;
const vec3 ICO_N[10] = vec3[10](
  vec3(0.5773503, 0.5773503, 0.5773503), vec3(0.5773503, 0.5773503, -0.5773503),
  vec3(0.5773503, -0.5773503, 0.5773503), vec3(-0.5773503, 0.5773503, 0.5773503),
  vec3(0.0, 0.3568221, 0.9341724), vec3(0.0, 0.3568221, -0.9341724),
  vec3(0.3568221, 0.9341724, 0.0), vec3(-0.3568221, 0.9341724, 0.0),
  vec3(0.9341724, 0.0, 0.3568221), vec3(-0.9341724, 0.0, 0.3568221));
const vec3 LIGHT = vec3(0.95, 0.94, 0.86);
const vec3 KEY = vec3(-0.37, 0.48, 0.79);

${VALUE_NOISE_GLSL}
${DITHER_GLSL}

ivec4 cellAt(ivec2 c) {
  return ivec4(texelFetch(uMaze, clamp(c, ivec2(0), ivec2(GRID)), 0) * 255.0 + 0.5);
}

/** Distance to the nearest joint of a running-bond grid; id is the block. */
float joints(vec2 uv, vec2 block, float stagger, out vec2 id) {
  float row = floor(uv.y / block.y);
  float x = uv.x / block.x + stagger * row;
  id = vec2(floor(x), row);
  vec2 f = vec2(fract(x), fract(uv.y / block.y));
  return min(min(f.x, 1.0 - f.x) * block.x, min(f.y, 1.0 - f.y) * block.y);
}

/** Wall material k at uv (cells along the wall, height), mortar filtered over fw. */
vec3 wallColour(int k, vec2 uv, float fw, float salt) {
  vec2 id;
  if (k == 0) {
    float d = joints(uv, vec2(0.5, 0.25), 0.5, id);
    float v = hash2(id + salt, 3.0);
    vec3 brick = vec3(0.63, 0.17, 0.11) * (0.86 + 0.24 * v);
    return mix(vec3(0.27, 0.1, 0.07), brick, smoothstep(MORTAR - fw, MORTAR + fw, d));
  }
  if (k == 1) {
    // Courses of stone blocks, each course shifted by its own amount.
    float row = floor(uv.y * 4.0);
    float d = joints(uv + vec2(0.5 * hash2(vec2(row, salt), 5.0), 0.0), vec2(0.5, 0.25), 0.0, id);
    float v = hash2(id + salt, 7.0);
    vec3 stone = vec3(0.5, 0.5, 0.53) * (0.8 + 0.35 * v);
    // A lighter top edge on each block reads as a bevel.
    stone *= 1.0 + 0.12 * smoothstep(0.17, 0.24, fract(uv.y * 4.0) * 0.25);
    return mix(vec3(0.2, 0.2, 0.21), stone, smoothstep(MORTAR - fw, MORTAR + fw, d));
  }
  // Horizontal boards a cell long, joints staggered per board.
  float row = floor(uv.y * 4.0);
  float d = joints(uv + vec2(hash2(vec2(row, salt), 9.0), 0.0), vec2(1.0, 0.25), 0.0, id);
  float v = hash2(id + salt, 11.0);
  float fy = fract(uv.y * 4.0);
  float grain = sin(fy * 40.0 + 3.0 * sin(uv.x * 2.5 + v * 6.0)) * (1.0 - smoothstep(0.02, 0.06, fw));
  vec3 wood = vec3(0.46, 0.29, 0.15) * (0.85 + 0.25 * v + 0.05 * grain);
  return mix(vec3(0.17, 0.1, 0.05), wood, smoothstep(MORTAR * 0.8 - fw, MORTAR * 0.8 + fw, d));
}

/** The start sign: a pale plaque with an arrow, over the wall at uv (cell-local). */
vec3 startSign(vec3 wall, vec2 uv) {
  vec2 p = (uv - vec2(0.5, 0.52)) * vec2(uArrow, 1.0);
  vec2 q = abs(p);
  if (q.x > 0.2 || q.y > 0.12) {
    return wall;
  }
  if (q.x > 0.185 || q.y > 0.105) {
    return vec3(0.15, 0.12, 0.1);
  }
  // Shaft and head of an arrow pointing to +x.
  bool shaft = p.x > -0.13 && p.x < 0.04 && q.y < 0.025;
  bool head = p.x >= 0.04 && p.x < 0.13 && q.y < 0.07 * (0.13 - p.x) / 0.09;
  return shaft || head ? vec3(0.1, 0.45, 0.16) : vec3(0.93, 0.9, 0.8);
}

vec3 floorColour(vec2 uv, float fw) {
  vec2 id;
  float d = joints(uv, vec2(0.5), 0.5, id);
  float v = hash2(id, 13.0);
  vec3 stone = vec3(0.43, 0.42, 0.4) * (0.82 + 0.3 * v);
  return mix(vec3(0.24, 0.23, 0.22), stone, smoothstep(MORTAR - fw, MORTAR + fw, d));
}

vec3 ceilingColour(vec2 uv, float fw) {
  vec2 id;
  float d = joints(uv, vec2(0.5), 0.0, id);
  return mix(vec3(0.62, 0.61, 0.58), vec3(0.87, 0.86, 0.81), smoothstep(MORTAR * 0.8 - fw, MORTAR * 0.8 + fw, d));
}

vec3 skyColour(vec3 rd) {
  vec3 n = normalize(rd);
  vec3 sky = mix(vec3(0.62, 0.76, 0.92), vec3(0.24, 0.45, 0.82), smoothstep(0.2, 0.9, n.z));
  // Clouds on a distant dome: they move only with the view, never with walking.
  vec2 q = n.xy / (n.z + 0.35) * 1.6;
  float c = 0.65 * vnoise(q, 1.0) + 0.35 * vnoise(q * 2.3 + 7.1, 2.0);
  return mix(sky, vec3(0.97), smoothstep(0.5, 0.75, c) * 0.85);
}

/** Ray against a polyhedron's face slabs, object space, unit circumradius. Returns t or -1. */
float polyHit(bool ico, vec3 o, vec3 d, out vec3 n) {
  float tn = -1e9;
  float tf = 1e9;
  n = vec3(0.0, 0.0, 1.0);
  for (int k = 0; k < 10; k++) {
    if (!ico && k >= 4) {
      break;
    }
    vec3 pn = ico ? ICO_N[k] : OCT_N[min(k, 3)];
    float h = ico ? ICO_IN : OCT_IN;
    float dn = dot(d, pn);
    dn = abs(dn) < 1e-6 ? 1e-6 : dn;
    float on = dot(o, pn);
    float t1 = (-h - on) / dn;
    float t2 = (h - on) / dn;
    float ta = min(t1, t2);
    if (ta > tn) {
      tn = ta;
      n = dn > 0.0 ? -pn : pn;
    }
    tf = min(tf, max(t1, t2));
  }
  return tn <= tf ? tn : -1.0;
}

/**
 * The object of kind k floating in cell c, if the ray hits it within (t0, t1):
 * returns t and its colour, or -1.
 */
float objectHit(int k, ivec2 c, vec3 ro, vec3 rd, float t0, float t1, out vec3 col) {
  col = vec3(0.0);
  float s = uCollect.w * (c == ivec2(uCollect.xy) ? uCollect.z : 1.0);
  float r = (k == 3 ? SMILE_R : OBJ_R) * s;
  vec3 centre = vec3(vec2(c) + 0.5, 0.5);
  vec3 oc = ro - centre;
  float a = dot(rd, rd);
  float b = dot(oc, rd);
  float disc = b * b - a * (dot(oc, oc) - r * r);
  if (r < 1e-4 || disc < 0.0) {
    return -1.0;
  }
  if (k == 3) {
    vec3 n = vec3(uSmile, 0.0);
    float dn = dot(rd, n);
    if (abs(dn) < 1e-5) {
      return -1.0;
    }
    float t = -dot(oc, n) / dn;
    vec3 p = (oc + rd * t) / r;
    // Seen from behind, mirror it so the face still reads the right way round.
    vec2 f = vec2(dot(p, vec3(-n.y, n.x, 0.0)) * (dn > 0.0 ? -1.0 : 1.0), p.z);
    float rr = length(f);
    if (t <= t0 || t >= t1 || rr > 1.0) {
      return -1.0;
    }
    col = vec3(1.0, 0.86, 0.12);
    vec2 e = vec2(abs(f.x) - 0.33, f.y - 0.25) / vec2(0.1, 0.17);
    float smile = abs(length(f - vec2(0.0, 0.08)) - 0.55);
    if (rr > 0.92 || dot(e, e) < 1.0 || (smile < 0.07 && f.y < -0.1)) {
      col = vec3(0.12, 0.08, 0.02);
    }
    return t;
  }
  vec3 n;
  float t = polyHit(k == 1, uSpin * oc / r, uSpin * rd / r, n);
  if (t <= t0 || t >= t1) {
    return -1.0;
  }
  vec3 nw = transpose(uSpin) * n;
  vec3 rdn = normalize(rd);
  float diff = max(dot(nw, KEY), 0.0);
  float spec = pow(max(dot(reflect(rdn, nw), KEY), 0.0), 16.0);
  float head = max(-dot(nw, rdn), 0.0);
  col = vec3(0.6, 0.62, 0.66) * (0.3 + 0.4 * diff + 0.4 * head) + vec3(0.5) * spec;
  return t;
}

/** The rat seen side-on at q (cells: x along its nose, y up). Alpha in w. */
vec4 ratColour(vec2 q) {
  vec3 fur = vec3(0.5, 0.49, 0.47);
  vec3 pink = vec3(0.86, 0.6, 0.6);
  vec2 b = (q - vec2(-0.02, 0.06)) / vec2(0.11, 0.05);
  vec2 h = (q - vec2(0.1, 0.055)) / vec2(0.065, 0.032);
  if (length(q - vec2(0.13, 0.065)) < 0.008) {
    return vec4(0.05, 0.05, 0.05, 1.0);
  }
  if (length(q - vec2(0.09, 0.09)) < 0.022) {
    return vec4(pink, 1.0);
  }
  if (dot(b, b) < 1.0 || dot(h, h) < 1.0) {
    return vec4(fur * (0.8 + 0.3 * smoothstep(0.03, 0.1, q.y)), 1.0);
  }
  float tailY = 0.04 + 0.18 * (q.x + 0.12) + 0.6 * (q.x + 0.12) * (q.x + 0.12);
  if (q.x < -0.11 && q.x > -0.3 && abs(q.y - tailY) < 0.006) {
    return vec4(pink * 0.85, 1.0);
  }
  if (q.y < 0.02 && (abs(q.x - 0.05) < 0.008 || abs(q.x + 0.08) < 0.008)) {
    return vec4(fur * 0.7, 1.0);
  }
  return vec4(0.0);
}

void main() {
  vec2 p = gl_FragCoord.xy * uPixScale + uPixOffset;
  p = vec2(p.x * uView.z - p.y * uView.w, p.x * uView.w + p.y * uView.z);
  vec2 fwd = uView.xy;
  vec2 right = vec2(fwd.y, -fwd.x);
  vec3 rd = vec3(fwd * FOCAL + right * p.x, p.y);
  vec3 ro = vec3(uCam, 0.5);
  int n = int(uSize + 0.5);

  // DDA through the cell grid; t is in units of rd.
  ivec2 cell = ivec2(floor(uCam));
  vec2 dd = vec2(abs(rd.x) < 1e-6 ? 1e-6 : rd.x, abs(rd.y) < 1e-6 ? 1e-6 : rd.y);
  ivec2 stp = ivec2(dd.x > 0.0 ? 1 : -1, dd.y > 0.0 ? 1 : -1);
  vec2 tDelta = abs(1.0 / dd);
  vec2 tMax = (vec2(cell) + vec2(greaterThan(dd, vec2(0.0))) - uCam) / dd;
  float tPlane = rd.z > 1e-6 ? 0.5 / rd.z : (rd.z < -1e-6 ? -0.5 / rd.z : 1e9);
  // Surfaces: 0 floor or ceiling, 1 wall across x, 2 wall across y, 3 object, 4 light outside.
  int surf = 4;
  int code = 0;
  float t = 0.0;
  vec3 objCol = vec3(0.0);
  ivec4 cur = cellAt(cell);
  for (int i = 0; i < MAX_STEPS; i++) {
    if (any(lessThan(cell, ivec2(0))) || any(greaterThanEqual(cell, ivec2(n)))) {
      surf = 4;
      break;
    }
    float tExit = min(min(tMax.x, tMax.y), tPlane);
    if (cur.b > 0) {
      float to = objectHit(cur.b, cell, ro, rd, t, tExit, objCol);
      if (to > 0.0) {
        surf = 3;
        t = to;
        break;
      }
    }
    if (tPlane <= min(tMax.x, tMax.y)) {
      surf = 0;
      t = tPlane;
      break;
    }
    if (tMax.x < tMax.y) {
      ivec2 nc = cell + ivec2(stp.x, 0);
      ivec4 nxt = cellAt(nc);
      t = tMax.x;
      code = stp.x > 0 ? nxt.r : cur.r;
      if (code > 0) {
        surf = 1;
        break;
      }
      cell = nc;
      cur = nxt;
      tMax.x += tDelta.x;
    } else {
      ivec2 nc = cell + ivec2(0, stp.y);
      ivec4 nxt = cellAt(nc);
      t = tMax.y;
      code = stp.y > 0 ? nxt.g : cur.g;
      if (code > 0) {
        surf = 2;
        break;
      }
      cell = nc;
      cur = nxt;
      tMax.y += tDelta.y;
    }
  }

  vec3 hit = ro + rd * t;
  // Surface coordinates in cells, set for every pixel so their derivatives are
  // taken in uniform control flow: the filter width for the joints.
  vec2 suv = surf == 1 ? hit.yz : (surf == 2 ? hit.xz : hit.xy);
  vec2 fw2 = fwidth(suv);
  float fw = uModern ? min(0.7 * length(fw2), 0.08) : 0.0;
  if (!uModern) {
    suv = (floor(suv * TEXELS) + 0.5) / TEXELS;
  }

  vec3 col;
  float shade = 1.0;
  if (surf == 4) {
    col = LIGHT;
  } else if (surf == 3) {
    col = objCol;
  } else if (surf == 0) {
    if (rd.z > 0.0) {
      vec3 tiles = ceilingColour(suv, fw);
      col = uSky > 0.0 ? mix(tiles, skyColour(rd), uSky) : tiles;
    } else {
      col = floorColour(suv, fw);
    }
    if (uModern) {
      // Soft shadow where the floor or ceiling meets a wall of this cell.
      vec2 f = hit.xy - vec2(cell);
      ivec4 east = cellAt(cell + ivec2(1, 0));
      ivec4 north = cellAt(cell + ivec2(0, 1));
      float d = 1.0;
      d = cur.r > 0 ? min(d, f.x) : d;
      d = east.r > 0 ? min(d, 1.0 - f.x) : d;
      d = cur.g > 0 ? min(d, f.y) : d;
      d = north.g > 0 ? min(d, 1.0 - f.y) : d;
      shade = mix(0.72, 1.0, smoothstep(0.0, 0.18, d));
    }
  } else {
    // Each wall line gets its own brick variation.
    float salt = surf == 1 ? floor(hit.x + 0.5) * 17.0 : floor(hit.y + 0.5) * 29.0 + 3.0;
    int ka = int(uWalls.x + 0.5);
    col = wallColour(ka, suv, fw, salt);
    if (uWalls.z > 0.0) {
      col = mix(col, wallColour(int(uWalls.y + 0.5), suv, fw, salt), uWalls.z);
    }
    if (code == 2) {
      col = startSign(col, vec2(fract(suv.x), suv.y));
    }
    // Flat lighting, a little darker on the walls running east-west.
    shade = surf == 1 ? 1.0 : 0.8;
    if (uModern) {
      float e = min(hit.z, 1.0 - hit.z);
      shade *= mix(0.75, 1.0, smoothstep(0.0, 0.14, e));
    }
  }
  if (uModern && surf < 4) {
    // Gentle darkening with distance; not on the open sky.
    float dist = t * length(rd.xy);
    float fog = 1.0 / (1.0 + 0.035 * dist * dist);
    shade *= surf == 0 && rd.z > 0.0 ? mix(fog, 1.0, uSky) : fog;
  }
  col *= shade;

  // The rat, a side-on sprite standing on the floor and always facing the camera plane.
  if (uRat.w > 0.0) {
    float tr = dot(uRat.xy - uCam, fwd) / FOCAL;
    if (tr > 0.05 && tr < t) {
      vec2 hp = uCam + rd.xy * tr;
      vec2 q = vec2(dot(hp - uRat.xy, right) * uRat.z, 0.5 + rd.z * tr) / uRat.w;
      vec4 rat = ratColour(q);
      if (rat.w > 0.0) {
        col = rat.rgb;
      }
    }
  }

  if (uModern) {
    col += dither8(gl_FragCoord.xy);
  } else {
    // 90s colour depth: 5 bits a channel.
    col = floor(col * 31.0 + 0.5) / 31.0;
  }
  outColor = vec4(clamp(col * uFade, 0.0, 1.0), 1.0);
}
`;

/** The Classic upscale: nearest-neighbour, so its pixels stay hard-edged. */
const NEAREST_COMPOSITE = /* glsl */ `
vec4 composite(vec2 uv) {
  ivec2 size = ivec2(uLowResSize);
  return texelFetch(uLowRes, min(ivec2(uv * uLowResSize), size - 1), 0);
}
`;

/** Writes the maze walls and objects into the texture data (see the shader's `uMaze`). */
function writeMazeTexture(maze: Maze, out: Uint8Array): void {
  out.fill(0);
  const n = maze.size;
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const o = (y * TEX + x) * 4;
      if (y < n) {
        const west =
          x < n
            ? (maze.open[cellIndex(x, y)] & 4) === 0
            : (maze.open[cellIndex(n - 1, y)] & 1) === 0;
        out[o] = x === 0 && y === 0 ? 2 : west ? 1 : 0;
      }
      if (x < n) {
        const south = y < n ? (maze.open[cellIndex(x, y)] & 8) === 0 : true;
        out[o + 1] = south ? 1 : 0;
      }
      if (x < n && y < n) {
        out[o + 2] = maze.objects[cellIndex(x, y)];
      }
    }
  }
}

/**
 * A first-person walk through a random maze in the style of the old Windows
 * screensaver. A fragment shader casts one ray per pixel through the maze grid
 * (a short DDA over a small data texture), shades procedural brick, stone or wood
 * walls, flagstones and ceiling tiles or sky, and ray-traces the spinning
 * polyhedra and smiley in the cells the ray crosses, plus a rat sprite.
 */
export const maze = defineEffect(mazeMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(
        createLowResTarget(gl, { composite: NEAREST_COMPOSITE, dither: false }),
      );
      const texData = new Uint8Array(TEX * TEX * 4);
      const texture = scope.add(
        createDataTexture(gl, {
          width: TEX,
          height: TEX,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: texData,
          filter: gl.NEAREST,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      const u = createUniforms(gl, program, [
        "uMaze",
        "uSize",
        "uPixScale",
        "uPixOffset",
        "uCam",
        "uView",
        "uWalls",
        "uSky",
        "uModern",
        "uFade",
        "uSpin",
        "uSmile",
        "uCollect",
        "uRat",
        "uArrow",
      ]);
      gl.useProgram(program);
      u.i1("uMaze", 0);
      const spin = new Float32Array(9);

      const mazeState = createMaze();
      const walker = createWalker();
      const rat = createRat(0);
      const dist = new Int16Array(GRID * GRID);
      const queue = new Int16Array(GRID * GRID);

      let width = 1;
      let height = 1;
      /** The size and variation the current maze was built with, and the mazes built so far. */
      let builtSize = Number.NaN;
      let builtSeed = Number.NaN;
      let mazes = 0;
      let textureDirty = true;
      /** 0 black .. 1 shown: the reset fade, and whether it is fading out. */
      let shown = 0;
      let leaving = false;
      /** The style on screen, and the dip to black that switches it. */
      let style = "";
      let dip = 1;
      let dipping = false;
      /** Wall crossfade: the old and new materials and the old one's share. */
      let wallFrom = 0;
      let wallTo = 0;
      let wallMix = 0;
      let sky = Number.NaN;
      let objScale = Number.NaN;
      /** The upside-down roll, 0..1 towards `rollTarget`. */
      let roll = 0;
      let rollTarget = 0;
      /** The object being touched: its cell and the walk that reaches it (-1 none). */
      let collecting = -1;
      let collectWalk = 0;
      let seenWalks = 0;
      let walkerCell = -1;
      let arrow = 1;
      let ratFace = 1;
      let spinA = 0;
      let spinB = 0;
      let smile = 0;

      const buildMaze = (size: number, seed: number, hand: number) => {
        builtSize = size;
        builtSeed = seed;
        generateMaze(mazeState, size, hash32(Math.floor(seed) * 7919 + mazes));
        mazes++;
        resetWalker(walker);
        seenWalks = walker.walks;
        collecting = -1;
        roll = 0;
        rollTarget = 0;
        walkerCell = -1;
        // The sign points the way the walker first turns.
        arrow = chooseTurn(mazeState, 0, 0, walker.dir, hand) < 0 ? 1 : -1;
        distanceField(mazeState, 0, 0, dist, queue);
        placeRat(rat, mazeState, dist);
        textureDirty = true;
      };

      return {
        resize(v) {
          width = v.width;
          height = v.height;
        },
        frame(dt, p) {
          const step = Math.max(0, dt);
          const size = clampSize(p.size);
          const hand = handSign(p.hand);
          if (Number.isNaN(builtSize)) {
            buildMaze(size, p.seed, hand);
            style = p.style;
            wallTo = wallIndex(p.walls);
            sky = p.ceiling === "sky" ? 1 : 0;
            objScale = p.objects ? 1 : 0;
          }

          // Resets: out through the exit, or a new size or variation, fade to black first.
          const exiting =
            walker.kind === SEG_DONE ||
            (walker.kind === SEG_WALK && walkTarget(walker, mazeState) < 0);
          if (exiting || size !== builtSize || p.seed !== builtSeed) {
            leaving = true;
          }
          shown = approach(shown, leaving ? 0 : 1, step / RESET_FADE);
          if (leaving && shown === 0) {
            leaving = false;
            buildMaze(size, p.seed, hand);
          }
          // A style switch dips to black and back.
          if (p.style !== style) {
            dipping = true;
          }
          dip = approach(dip, dipping ? 0 : 1, step / STYLE_DIP);
          if (dipping && dip === 0) {
            dipping = false;
            style = p.style;
          }

          // wallMix runs 1 -> 0: the share of the old material still showing. A
          // change made mid-crossfade starts once it ends.
          const wantWall = wallIndex(p.walls);
          wallMix = approach(wallMix, 0, step / CROSSFADE);
          if (wallMix === 0 && wantWall !== wallTo) {
            wallFrom = wallTo;
            wallTo = wantWall;
            wallMix = 1;
          }
          sky = approach(sky, p.ceiling === "sky" ? 1 : 0, step / CROSSFADE);
          objScale = approach(objScale, p.objects ? 1 : 0, step / CROSSFADE);

          // The walk.
          advanceWalker(walker, mazeState, step, hand, walkSeconds(p.speed), turnSeconds(p.speed));
          if (collecting >= 0 && (walker.walks !== collectWalk || walker.kind !== SEG_WALK)) {
            // Touched: the object is gone, and a polyhedron may turn the world over.
            if (p.flip && mazeState.objects[collecting] !== OBJ_SMILEY) {
              rollTarget = 1 - rollTarget;
            }
            mazeState.objects[collecting] = 0;
            collecting = -1;
            textureDirty = true;
          }
          if (walker.walks !== seenWalks) {
            seenWalks = walker.walks;
            const next = walkTarget(walker, mazeState);
            if (walker.kind === SEG_WALK && next >= 0 && mazeState.objects[next] !== 0) {
              collecting = next;
              collectWalk = walker.walks;
            }
          }
          if (!p.flip) {
            rollTarget = 0;
          }
          roll = approach(roll, rollTarget, step / ROLL_SECONDS);

          // The rat keeps out of the walker's cell and heads its way when far off.
          const here = walker.kind === SEG_DONE ? -1 : cellIndex(walker.cx, walker.cy);
          if (here !== walkerCell && here >= 0) {
            walkerCell = here;
            distanceField(mazeState, walker.cx, walker.cy, dist, queue);
          }
          advanceRat(rat, mazeState, step, dist, walkerCell);

          spinA = (spinA + step * SPIN_A) % TAU;
          spinB = (spinB + step * SPIN_B) % TAU;
          smile = (smile + step * SMILE_SPIN) % TAU;

          // Draw.
          const classic = style !== "modern";
          beginFrame(gl, width, height);
          let w = width;
          let h = height;
          if (classic) {
            target.resize(width, height, Math.max(1, height / CLASSIC_LINES));
            target.bind();
            w = target.width;
            h = target.height;
          }
          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          if (textureDirty) {
            textureDirty = false;
            writeMazeTexture(mazeState, texData);
            updateDataTexture(gl, texture, TEX, TEX, gl.RGBA, gl.UNSIGNED_BYTE, texData);
          } else {
            gl.bindTexture(gl.TEXTURE_2D, texture);
          }
          const hh = Math.max(1, h);
          u.f1("uSize", mazeState.size);
          u.f2("uPixScale", 1 / hh, 1 / hh);
          u.f2("uPixOffset", (-0.5 * w) / hh, -0.5);
          u.f2("uCam", walker.x, walker.y);
          const ca = Math.cos(walker.angle);
          const sa = Math.sin(walker.angle);
          const r = Math.PI * smoothstep(0, 1, roll);
          u.f4("uView", ca, sa, Math.cos(r), Math.sin(r));
          u.f3("uWalls", wallTo, wallFrom, smoothstep(0, 1, wallMix));
          u.f1("uSky", smoothstep(0, 1, sky));
          u.i1("uModern", classic ? 0 : 1);
          u.f1("uFade", smoothstep(0, 1, shown) * smoothstep(0, 1, dip));
          // Polyhedra tumble about two axes: rotate about z by a, then x by b.
          const c1 = Math.cos(spinA);
          const s1 = Math.sin(spinA);
          const c2 = Math.cos(spinB);
          const s2 = Math.sin(spinB);
          // Column-major Rx(b) * Rz(a).
          spin[0] = c1;
          spin[1] = c2 * s1;
          spin[2] = s2 * s1;
          spin[3] = -s1;
          spin[4] = c2 * c1;
          spin[5] = s2 * c1;
          spin[6] = 0;
          spin[7] = -s2;
          spin[8] = c2;
          gl.uniformMatrix3fv(u.loc.uSpin, false, spin);
          u.f2("uSmile", Math.cos(smile), Math.sin(smile));
          let collectScale = 1;
          if (collecting >= 0) {
            collectScale = 1 - smoothstep(0.2, 0.75, walker.progress);
          }
          const cx = collecting >= 0 ? collecting % GRID : -1;
          const cy = collecting >= 0 ? (collecting - cx) / GRID : -1;
          u.f4("uCollect", cx, cy, collectScale, smoothstep(0, 1, objScale));
          // Face the rat the way it runs across the view; keep the last facing head-on.
          const across = DIR_X[rat.dir] * sa - DIR_Y[rat.dir] * ca;
          if (Math.abs(across) > 0.3) {
            ratFace = across > 0 ? 1 : -1;
          }
          u.f4("uRat", rat.x, rat.y, ratFace, smoothstep(0, 1, objScale));
          u.f1("uArrow", arrow);
          triangle.draw();
          if (classic) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            target.blit();
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
