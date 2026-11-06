import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { clamp } from "./math";
import { HASH32_GLSL } from "./noise";
import {
  createMilkyWayNoise,
  glslColor as C,
  HAZE_COLOR,
  HAZE_GAIN,
  milkyWayGlsl,
  STAR_TINT_GLSL,
  TO_SKY_GLSL,
} from "./starfield";
import {
  advanceRotation,
  BRIGHT_MIN,
  BRIGHT_POWER,
  DEG,
  EDGE_AA,
  HALF_WIDTH_MIN,
  HALF_WIDTH_RANGE,
  RING_MARGIN,
  RING_WIDTH,
  SECTORS_PER_RING,
  seedSalt,
  wrapAngle,
} from "./starfield-sim";
import {
  buildForeground,
  COMET_HEAD,
  COMET_TAIL,
  createLoneTree,
  END_TAPER,
  FG_COLUMNS,
  FOREGROUND_KINDS,
  HEAD_LENGTH,
  maxSectors,
  polePosition,
  SECTORS_CHECKED,
  TREE_BLOBS,
} from "./startrails-sim";
import { startrailsMeta, TRAIL_LENGTH_MAX, TRAIL_LENGTH_MIN } from "./startrails.meta";
import { defineEffect } from "./types";

/**
 * One full-screen pass: sky gradient and horizon glow, Milky Way haze (one
 * fetch), trails (one ring, `SECTORS_CHECKED` hashed cells), and the foreground
 * silhouette (one column-table fetch, plus a few circles for the lone tree inside
 * its box). Stars and haze are skipped under the solid silhouette.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uGround;
uniform sampler2D uNoise;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
/** 1 / scale (reference px per device px), 1 / height. */
uniform vec2 uInv;
/** Pole, reference px (y up). */
uniform vec2 uPole;
/** Sky rotation in [0, 2π), and its cosine and sine. */
uniform vec3 uRot;
uniform int uCap;
uniform uint uSalt;
/** Occupied share of cells x 65536. */
uniform float uDensity;
/** Trail length (radians), comet style (0 or 1), colour spread, Milky Way strength. */
uniform vec4 uTrail;
/** Foreground on, lone tree on. */
uniform vec2 uFg;
uniform vec3 uBlobs[${String(TREE_BLOBS)}];
uniform vec4 uTrunk;
uniform vec4 uTreeBox;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
${STAR_TINT_GLSL}
${TO_SKY_GLSL}
${milkyWayGlsl()}
const float TAU = 6.283185307179586;
const float W = ${glslFloat(RING_WIDTH)};
const float MARGIN = ${glslFloat(RING_MARGIN)};
const vec3 GLOW = ${C("#c06a3c")} * 0.24;
const vec3 HAZE = ${C(HAZE_COLOR, HAZE_GAIN)};
const vec3 FG = ${C("#04060a")};

float treeDist(vec2 p) {
  float d = 1e9;
  for (int i = 0; i < ${String(TREE_BLOBS)}; i++) d = min(d, length(p - uBlobs[i].xy) - uBlobs[i].z);
  vec2 q = vec2(abs(p.x - uTrunk.x) - uTrunk.w, max(uTrunk.y - p.y, p.y - uTrunk.z));
  return min(d, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float yN = frag.y * uInv.y;
  vec3 col = mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, yN));
  col += GLOW * exp2(-max(yN - 0.08, 0.0) * 9.0);

  // Foreground: coverage and depth inside the silhouette (device px).
  float cover = 0.0;
  float depth = 1e4;
  if (uFg.x > 0.5) {
    float s = vUv.x * ${glslFloat((FG_COLUMNS - 1) / FG_COLUMNS)} + ${glslFloat(0.5 / FG_COLUMNS)};
    float d = texture(uGround, vec2(s, 0.5)).r / uInv.y - frag.y;
    float g = length(vec2(dFdx(d), dFdy(d)));
    depth = d / max(g, 0.001);
    cover = clamp(depth + 0.5, 0.0, 1.0);
    vec2 pr = frag * uInv.x;
    if (uFg.y > 0.5 && all(greaterThan(pr, uTreeBox.xy)) && all(lessThan(pr, uTreeBox.zw))) {
      float td = -treeDist(pr) / uInv.x;
      depth = max(depth, td);
      cover = max(cover, clamp(td + 0.5, 0.0, 1.0));
    }
  }

  if (cover < 1.0) {
    vec2 d = frag * uInv.x - uPole;
    float r = length(d);

    // Milky Way haze, in sky coordinates so it turns with the stars.
    if (uTrail.w > 0.0) {
      col += HAZE * (milkyWay(uNoise, toSky(d, uRot.yz)) * uTrail.w);
    }

    if (r > 0.01) {
      float phi = mod(atan(d.y, d.x) - uRot.x, TAU);
      float ringF = floor(r / W);
      uint ring = uint(ringF);
      int n = clamp(int((ringF + 0.5) * ${glslFloat(SECTORS_PER_RING)}), 1, uCap);
      float sector = TAU / float(n);
      float x = phi / sector;
      float jf = floor(x);
      float f = x - jf;
      uint j = uint(jf);
      uint rh = hash32(ring ^ uSalt);
      float len = uTrail.x;
      vec3 sum = vec3(0.0);
      for (int i = 0; i < ${String(SECTORS_CHECKED)}; i++) {
        uint h1 = hash32(rh + (j + uint(i)) % uint(n));
        if (float(h1 & 0xffffu) >= uDensity) continue;
        float delta = (float(i) + (float(h1 >> 16) + 0.5) * ${glslFloat(1 / 65536)} - f) * sector;
        if (delta <= 0.0 || delta >= len) continue;
        uint h2 = hash32(h1);
        float rs = ringF * W + MARGIN + (float(h2 & 0xffffu) + 0.5) * ${glslFloat((RING_WIDTH - 2 * RING_MARGIN) / 65536)};
        float bx = (float((h2 >> 16) & 0xffu) + 0.5) * ${glslFloat(1 / 256)};
        float b = ${glslFloat(BRIGHT_MIN)} + ${glslFloat(1 - BRIGHT_MIN)} * pow(bx, ${glslFloat(BRIGHT_POWER)});
        float hw = ${glslFloat(HALF_WIDTH_MIN)} + ${glslFloat(HALF_WIDTH_RANGE)} * b;
        float cov = 1.0 - smoothstep(hw - ${glslFloat(EDGE_AA)}, hw + ${glslFloat(EDGE_AA)}, abs(r - rs));
        if (cov <= 0.0) continue;
        float arcHead = delta * rs;
        float prof = smoothstep(0.0, ${glslFloat(END_TAPER)}, arcHead)
          * smoothstep(0.0, ${glslFloat(END_TAPER)}, (len - delta) * rs);
        float t = 1.0 - delta / len;
        prof *= mix(1.0, ${glslFloat(COMET_TAIL)} * t * t + ${glslFloat(COMET_HEAD)} * exp2(-arcHead * ${glslFloat(1 / HEAD_LENGTH)}), uTrail.y);
        float temp = (float(h2 >> 24) + 0.5) * ${glslFloat(2 / 256)};
        sum += starTint(temp, uTrail.z) * (b * prof * cov);
      }
      col += sum;
    }
  }

  // Silhouette: near black, with a faint rim of the horizon glow along its edge.
  vec3 fg = FG + GLOW * (0.5 * exp2(-max(depth, 0.0) * 0.5 * uInv.x));
  col = mix(col, fg, cover);
  outColor = vec4(col + dither8(frag), 1.0);
}
`;

/**
 * A long-exposure night sky: stars draw concentric arcs around the celestial
 * pole over a dark landscape silhouette, and the whole sky turns slowly.
 */
export const startrails = defineEffect(startrailsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uGround",
        "uNoise",
        "uSkyTop",
        "uSkyBottom",
        "uInv",
        "uPole",
        "uRot",
        "uCap",
        "uSalt",
        "uDensity",
        "uTrail",
        "uFg",
        "uBlobs",
        "uTrunk",
        "uTreeBox",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const ground = scope.own(createColumnTable(gl, FG_COLUMNS, 1));
      const noiseTex = scope.add(createMilkyWayNoise(gl), (t) => {
        gl.deleteTexture(t);
      });
      gl.useProgram(program);
      u.i1("uGround", 0);
      u.i1("uNoise", 1);
      gl.useProgram(null);

      const tree = createLoneTree();
      const fgInputs = createChangeKey(3);
      const pole: [number, number] = [0, 0];
      let hasGround = false;
      let hasTree = false;
      let width = 1;
      let height = 1;
      let scale = 1;
      /** Sky rotation, radians, unwrapped float64. */
      let rot = 0;
      let lastSeed = Number.NaN;
      let salt = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          rot = advanceRotation(rot, dt, p.speed);
          const refWidth = width / scale;
          const kind = (FOREGROUND_KINDS as readonly string[]).indexOf(p.foreground);
          const seed = Math.floor(p.seed);
          if (seed !== lastSeed) {
            lastSeed = seed;
            salt = seedSalt(seed);
          }

          gl.useProgram(program);
          fgInputs.set(0, kind);
          fgInputs.set(1, seed);
          fgInputs.set(2, refWidth);
          if (fgInputs.take()) {
            hasTree = buildForeground(ground.data, p.foreground, seed, refWidth, tree);
            hasGround = kind >= 0 && p.foreground !== "none";
            gl.activeTexture(gl.TEXTURE0);
            ground.upload();
            gl.uniform3fv(u.loc.uBlobs, tree.blobs);
            const t = tree.trunk;
            u.f4("uTrunk", t[0], t[1], t[2], t[3]);
            const b = tree.box;
            u.f4("uTreeBox", b[0], b[1], b[2], b[3]);
          }

          const length = clamp(p.trailLength, TRAIL_LENGTH_MIN, TRAIL_LENGTH_MAX) * DEG;
          polePosition(p.pole, refWidth, pole);
          const r = wrapAngle(rot);
          u.rgb("uSkyTop", p.skyTop);
          u.rgb("uSkyBottom", p.skyBottom);
          u.f2("uInv", 1 / scale, 1 / height);
          u.f2("uPole", pole[0], pole[1]);
          u.f3("uRot", r, Math.cos(r), Math.sin(r));
          u.i1("uCap", maxSectors(length));
          u.u1("uSalt", salt);
          u.f1("uDensity", Math.round(clamp(p.density, 0, 1) * 65536));
          u.f4(
            "uTrail",
            length,
            p.style === "comet" ? 1 : 0,
            clamp(p.colorful, 0, 1),
            clamp(p.milkyWay, 0, 1),
          );
          u.f2("uFg", hasGround ? 1 : 0, hasTree ? 1 : 0);

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, ground.texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
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
