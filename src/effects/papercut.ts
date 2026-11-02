import { createChangeKey } from "./change-key";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import { clamp } from "./math";
import { buildPeriodicNoiseTexture, HASH32_GLSL } from "./noise";
import {
  buildScene,
  fillLayerColors,
  MAX_LAYERS,
  MAX_SHAPES,
  MAX_STACK,
  MIN_LAYERS,
  PALETTE_IDS,
  parallaxOffset,
  placeShape,
  resolvePalette,
  type Scene,
  SCENE_IDS,
  sceneId,
  seatBoat,
  slotDepth,
  TABLE_CHANNELS,
  TABLE_COLUMNS,
  TABLE_PERIOD,
  TABLE_ROWS,
} from "./papercut-sim";
import { defineEffect } from "./types";

/** Layer spacing at depth 1, height units: sets the shadow offset and blur. */
const GAP = 0.012;
/** Shadow offset toward the light, as a fraction of the gap; the blur radius is the full gap. */
const OFFSET_SHARE = 0.5;
/** Direction toward the light (up and a little left), normalised. */
const LIGHT_X = -0.5 / Math.hypot(0.5, 1);
const LIGHT_Y = 1 / Math.hypot(0.5, 1);
/** Darkening of a full shadow at shadow strength 1. */
const SHADOW_DARK = 0.5;
/** Bevel highlight: width in px at 1080p and its strongest lightening. */
const BEVEL_PX = 2.5;
const BEVEL_LIGHT = 0.16;
/** Paper texture: texture side, lattice periods of its fine and coarse channels, texel size (px at 1080p). */
const PAPER_SIZE = 256;
const PAPER_FINE = 64;
const PAPER_COARSE = 8;
const PAPER_TEXEL_PX = 1.25;
/** Night sky stars: grid cell (height units), lowest row, fraction of cells lit. */
const STAR_CELL = 0.07;
const STAR_FLOOR = 0.4;
const STAR_CHANCE = 0.4;

const SCENE_LABELS: Record<(typeof SCENE_IDS)[number], string> = {
  hills: "Hills",
  ocean: "Ocean",
  forest: "Forest",
  night: "Night",
};
const PALETTE_LABELS: Record<(typeof PALETTE_IDS)[number], string> = {
  scene: "Scene default",
  sunset: "Sunset",
  pastel: "Pastel",
  autumn: "Autumn",
  mono: "Monochrome",
};

/*
 * One full-screen pass. Coordinates are height units, y up (p = gl_FragCoord / height).
 * Layers are walked front to back (uniform index 0 is the front); each layer's
 * signed distance D (positive inside) is the union of its table edges and analytic
 * shapes, and Do is the same at p + uLight (toward the light), which gives both its
 * drop shadow on everything behind and the bevel on edges facing the light.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uTable;
uniform sampler2D uPaper;
uniform int uCount;
/** Per layer, front first: parallax offset (xy), table slot (z). */
uniform vec4 uLayer[${MAX_STACK}];
/** Per layer: has x row, has y row, first shape, end of shapes. */
uniform ivec4 uFlags[${MAX_STACK}];
uniform vec3 uColor[${MAX_STACK}];
/** Per shape, in its layer's coordinates: centre, size, kind; and rotation (cos, sin). */
uniform vec4 uShape[${MAX_SHAPES}];
uniform vec2 uShapeRot[${MAX_SHAPES}];
uniform vec3 uSky;
uniform vec3 uStarColor;
uniform float uStars;
uniform float uAspect;
/** Canvas height in px, and its reciprocal. */
uniform vec2 uHeight;
/** Shadow offset toward the light, height units. */
uniform vec2 uLight;
/** Shadow darkening, blur radius (height units), 1 / |uLight|. */
uniform vec3 uShadow;
/** Bevel lightening, 1 / bevel width in px. */
uniform vec2 uBevel;
/** Paper fibre strength, texture coordinates per height unit. */
uniform vec2 uPaperK;

out vec4 outColor;

const float INV_PERIOD = ${glslFloat(1 / TABLE_PERIOD)};
const float HALF_TEXEL = ${glslFloat(0.5 / TABLE_COLUMNS)};
const float INV_ROWS = ${glslFloat(1 / TABLE_ROWS)};
const float STAR_CELL = ${glslFloat(STAR_CELL)};
const float STAR_FLOOR = ${glslFloat(STAR_FLOOR)};
const float STAR_CHANCE = ${glslFloat(STAR_CHANCE)};
${DITHER_GLSL}
${HASH32_GLSL}
/** Signed distance (negative inside) to shape kind k of size s, at local point r. */
float shapeSdf(vec2 r, float s, float k) {
  if (k < 1.5) {
    return length(r) - s;
  }
  if (k < 2.5) {
    // Cloud: three puffs over a flat base.
    float d = length(r) - s;
    d = min(d, length(r - vec2(-1.05 * s, -0.3 * s)) - 0.68 * s);
    d = min(d, length(r - vec2(1.1 * s, -0.35 * s)) - 0.62 * s);
    return max(d, -0.72 * s - r.y);
  }
  if (k < 3.5) {
    // Crescent: a disc less an offset disc.
    return max(length(r) - s, 0.86 * s - length(r - vec2(0.42 * s, 0.2 * s)));
  }
  // Boat: a trapezoid hull with two triangular sails.
  float hull = max(max(r.y, -0.35 * s - r.y), (abs(r.x) - r.y - s) * 0.7071);
  float main = max(max(0.05 * s - r.x, 0.08 * s - r.y),
                   dot(r - vec2(0.75 * s, 0.08 * s), vec2(0.8245, 0.5659)));
  float jib = max(max(r.x + 0.02 * s, 0.15 * s - r.y),
                  dot(r - vec2(-0.55 * s, 0.15 * s), vec2(-0.8192, 0.5735)));
  return min(hull, min(main, jib));
}

/** Union of a straight edge's distance d with slope s along gradient g, into D and Do. */
void edge(float d, vec2 g, inout float D, inout float Do) {
  float n = inversesqrt(dot(g, g));
  D = max(D, d * n);
  Do = max(Do, (d + dot(g, uLight)) * n);
}

/** Sky paper: flat, with small cut-out stars at night (and their shadows). */
vec3 sky(vec2 p) {
  vec3 col = uSky;
  if (uStars > 0.5 && p.y > STAR_FLOOR) {
    vec2 cell = floor(p / STAR_CELL);
    uint h = hash32(uint(int(cell.x) + 4096) * 7919u + uint(int(cell.y) + 4096));
    float pick = float(h & 1023u) / 1024.0;
    if (pick < STAR_CHANCE) {
      vec2 jitter = vec2(float((h >> 10) & 255u), float((h >> 18) & 255u)) / 255.0;
      vec2 c = (cell + 0.2 + 0.6 * jitter) * STAR_CELL;
      float r = STAR_CELL * (0.045 + 0.05 * pick / STAR_CHANCE);
      // Four-pointed star.
      vec2 a = abs(p - c);
      float d = (min(a.x + 2.5 * a.y, 2.5 * a.x + a.y) - r) * 0.5;
      vec2 ao = abs(p + uLight - c);
      float dOff = (min(ao.x + 2.5 * ao.y, 2.5 * ao.x + ao.y) - r) * 0.5;
      col *= 1.0 - uShadow.x * (1.0 - smoothstep(-uShadow.y, uShadow.y, dOff));
      col = mix(col, uStarColor, clamp(0.5 - d * uHeight.x, 0.0, 1.0));
    }
  }
  return col;
}

void main() {
  vec2 p = gl_FragCoord.xy * uHeight.y;
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float lit = 1.0;
  // Offset of the paper texture: the parallax of the layer the pixel lands on.
  vec2 paperOff = vec2(0.0);
  for (int i = 0; i < ${MAX_STACK}; i++) {
    if (i >= uCount) break;
    vec4 L = uLayer[i];
    ivec4 F = uFlags[i];
    vec2 q = p - L.xy;
    float D = -1e4;
    float Do = -1e4;
    if (F.x != 0) {
      vec4 T = textureLod(uTable, vec2(q.x * INV_PERIOD + HALF_TEXEL, (2.0 * L.z + 0.5) * INV_ROWS), 0.0);
      // Bottom edge: covers y below T.x. Top edge: covers y above 1 - T.z.
      edge(T.x - q.y, vec2(T.y, -1.0), D, Do);
      edge(q.y - 1.0 + T.z, vec2(T.w, 1.0), D, Do);
    }
    if (F.y != 0) {
      vec4 S = textureLod(uTable, vec2(q.y * INV_PERIOD + HALF_TEXEL, (2.0 * L.z + 1.5) * INV_ROWS), 0.0);
      // Left side: covers x left of S.x. Right side: covers x right of aspect - S.z.
      edge(S.x - q.x, vec2(-1.0, S.y), D, Do);
      edge(q.x - uAspect + S.z, vec2(1.0, S.w), D, Do);
    }
    for (int s = F.z; s < F.w; s++) {
      vec4 sh = uShape[s];
      vec2 rot = uShapeRot[s];
      vec2 r = q - sh.xy;
      vec2 ro = r + uLight;
      r = vec2(rot.x * r.x + rot.y * r.y, rot.x * r.y - rot.y * r.x);
      ro = vec2(rot.x * ro.x + rot.y * ro.y, rot.x * ro.y - rot.y * ro.x);
      D = max(D, -shapeSdf(r, sh.z, sh.w));
      Do = max(Do, -shapeSdf(ro, sh.z, sh.w));
    }
    float dPx = D * uHeight.x;
    float c = clamp(dPx + 0.5, 0.0, 1.0);
    if (c > 0.0) {
      // Edges facing the light (D falls toward it) catch a faint bevel highlight.
      float facing = clamp((D - Do) * uShadow.z, 0.0, 1.0);
      float bevel = uBevel.x * facing * (1.0 - smoothstep(0.0, 1.0, dPx * uBevel.y));
      vec3 col = mix(uColor[i], vec3(1.0), bevel) * lit;
      acc += trans * c * col;
      trans *= 1.0 - c;
      paperOff = L.xy;
      if (trans <= 0.0) break;
    }
    // This layer shades everything behind it.
    lit *= 1.0 - uShadow.x * smoothstep(-uShadow.y, uShadow.y, Do);
  }
  if (trans > 0.0) acc += trans * lit * sky(p);
  vec2 paper = texture(uPaper, (p - paperOff) * uPaperK.y).rg - 0.5;
  vec3 col = acc * (1.0 + uPaperK.x * (0.14 * paper.x + 0.1 * paper.y));
  // Soft box lighting: a little darker toward the corners.
  vec2 v = (p - vec2(0.5 * uAspect, 0.6)) / vec2(uAspect, 1.2);
  col *= 1.0 - 0.35 * dot(v, v);
  outColor = vec4(clamp(col + dither8(gl_FragCoord.xy), 0.0, 1.0), 1.0);
}
`;

/**
 * A layered paper-cut shadow box: 5–8 sheets of matte coloured paper cut into
 * hills, waves or pine forests, with a sun, moon, clouds or a boat, each sheet
 * casting a soft drop shadow on those behind. Edges come from a small lookup table
 * built once per scene (bottom and top edges indexed by x, side edges by y);
 * one full-screen pass walks the layers front to back and stops at the first
 * opaque one. The layers drift on a slow parallax path as if the box breathes.
 */
export const papercut = defineEffect({
  id: "papercut",
  name: "Paper-cut Layers",
  description:
    "A layered paper-cut shadow box of hills, waves or forest, with soft shadows between the sheets.",
  params: {
    scene: {
      kind: "select",
      label: "Scene",
      options: SCENE_IDS.map((value) => ({ value, label: SCENE_LABELS[value] })),
      default: "hills",
    },
    palette: {
      kind: "select",
      label: "Palette",
      options: PALETTE_IDS.map((value) => ({ value, label: PALETTE_LABELS[value] })),
      default: "scene",
    },
    layers: {
      kind: "number",
      label: "Layers",
      min: MIN_LAYERS,
      max: MAX_LAYERS,
      step: 1,
      default: 6,
    },
    shadow: { kind: "number", label: "Shadow", min: 0, max: 1, step: 0.01, default: 0.6 },
    depth: { kind: "number", label: "Layer depth", min: 0.25, max: 2, step: 0.01, default: 1 },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.01, default: 0.5 },
    texture: { kind: "number", label: "Paper texture", min: 0, max: 1, step: 0.01, default: 0.5 },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const table = scope.own(
        createColumnTable(gl, TABLE_COLUMNS, TABLE_CHANNELS, {
          rows: TABLE_ROWS,
          wrap: gl.REPEAT,
        }),
      );
      const paperTex = scope.add(
        createDataTexture(gl, {
          width: PAPER_SIZE,
          height: PAPER_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(PAPER_SIZE, [
            { period: PAPER_FINE, seed: 53 },
            { period: PAPER_COARSE, seed: 530 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );
      const u = createUniforms(gl, program, [
        "uTable",
        "uPaper",
        "uCount",
        "uLayer",
        "uFlags",
        "uColor",
        "uShape",
        "uShapeRot",
        "uSky",
        "uStarColor",
        "uStars",
        "uAspect",
        "uHeight",
        "uLight",
        "uShadow",
        "uBevel",
        "uPaperK",
      ]);
      gl.useProgram(program);
      u.i1("uTable", 0);
      u.i1("uPaper", 1);
      gl.useProgram(null);

      // GPU-side arrays, front first.
      const layerData = new Float32Array(MAX_STACK * 4);
      const flagData = new Int32Array(MAX_STACK * 4);
      const colorData = new Float32Array(MAX_STACK * 3);
      const shapeData = new Float32Array(MAX_SHAPES * 4);
      const rotData = new Float32Array(MAX_SHAPES * 2);
      // CPU-side, back first.
      const backColors = new Float32Array(MAX_STACK * 3);
      const offsets: Float64Array[] = [];
      for (let i = 0; i < MAX_STACK; i++) offsets.push(new Float64Array(2));
      const placed = new Float64Array(4);
      const sceneKey = createChangeKey(2);

      let scene: Scene | undefined;
      /** Palette the colours were last filled from; reset when the scene changes. */
      let paletteParam: string | undefined;
      let width = 1;
      let height = 1;
      let scale = 1;
      /** Seconds since creation, unwrapped (CPU only: the shader gets offsets). */
      let time = 0;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          const id = sceneId(p.scene);
          const layerCount = clamp(Math.round(p.layers), MIN_LAYERS, MAX_LAYERS);
          const aspect = width / height;

          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          sceneKey.set(0, SCENE_IDS.indexOf(id));
          sceneKey.set(1, layerCount);
          if (sceneKey.take() || !scene) {
            scene = buildScene(id, layerCount, table.data);
            table.upload();
            // Flags and colours are static per scene; the shape list is too.
            const count = scene.layers.length;
            let shapeIndex = 0;
            for (let slot = 0; slot < count; slot++) {
              const layer = scene.layers[slot];
              const i = count - 1 - slot;
              flagData[i * 4] = layer.hasX ? 1 : 0;
              flagData[i * 4 + 1] = layer.hasY ? 1 : 0;
              flagData[i * 4 + 2] = shapeIndex;
              shapeIndex = Math.min(MAX_SHAPES, shapeIndex + layer.shapes.length);
              flagData[i * 4 + 3] = shapeIndex;
              layerData[i * 4 + 2] = slot;
            }
            gl.uniform4iv(u.loc.uFlags, flagData);
            paletteParam = undefined;
          } else {
            gl.bindTexture(gl.TEXTURE_2D, table.texture);
          }
          const s = scene;
          const count = s.layers.length;
          u.i1("uCount", count);

          if (p.palette !== paletteParam) {
            paletteParam = p.palette;
            const palette = resolvePalette(id, p.palette);
            u.v3("uSky", fillLayerColors(s, palette, backColors));
            for (let slot = 0; slot < count; slot++) {
              const i = count - 1 - slot;
              colorData[i * 3] = backColors[slot * 3];
              colorData[i * 3 + 1] = backColors[slot * 3 + 1];
              colorData[i * 3 + 2] = backColors[slot * 3 + 2];
            }
            gl.uniform3fv(u.loc.uColor, colorData);
            u.rgb("uStarColor", palette.sun);
          }
          u.f1("uStars", s.stars ? 1 : 0);

          // Parallax offsets, then the shapes riding on them.
          for (let slot = 0; slot < count; slot++) {
            const off = offsets[slot];
            parallaxOffset(time, slotDepth(slot, count), p.motion, off);
            const i = count - 1 - slot;
            layerData[i * 4] = off[0];
            layerData[i * 4 + 1] = off[1];
          }
          gl.uniform4fv(u.loc.uLayer, layerData);
          let shapeIndex = 0;
          for (let slot = 0; slot < count; slot++) {
            const shapes = s.layers[slot].shapes;
            for (let k = 0; k < shapes.length && shapeIndex < MAX_SHAPES; k++) {
              const shape = shapes[k];
              placeShape(shape, time, aspect, placed);
              if (slot === s.boatSlot) {
                seatBoat(
                  table.data,
                  s.waveSlot,
                  shape.size,
                  time,
                  offsets[slot],
                  offsets[s.waveSlot],
                  placed,
                );
              }
              shapeData[shapeIndex * 4] = placed[0];
              shapeData[shapeIndex * 4 + 1] = placed[1];
              shapeData[shapeIndex * 4 + 2] = shape.size;
              shapeData[shapeIndex * 4 + 3] = shape.kind;
              rotData[shapeIndex * 2] = placed[2];
              rotData[shapeIndex * 2 + 1] = placed[3];
              shapeIndex++;
            }
          }
          if (shapeIndex > 0) {
            gl.uniform4fv(u.loc.uShape, shapeData);
            gl.uniform2fv(u.loc.uShapeRot, rotData);
          }

          u.f1("uAspect", aspect);
          u.f2("uHeight", height, 1 / height);
          const gap = GAP * p.depth;
          const reach = OFFSET_SHARE * gap;
          u.f2("uLight", LIGHT_X * reach, LIGHT_Y * reach);
          u.f3("uShadow", SHADOW_DARK * clamp(p.shadow, 0, 1), gap, 1 / reach);
          u.f2("uBevel", BEVEL_LIGHT, 1 / (BEVEL_PX * scale));
          u.f2("uPaperK", clamp(p.texture, 0, 1), 1080 / (PAPER_SIZE * PAPER_TEXEL_PX));

          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, paperTex);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
