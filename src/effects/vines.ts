import { unitRgbMemo } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createSpriteBatch, SPRITE_SPIN_GLSL } from "./sprites";
import { defineEffect } from "./types";
import {
  createVines,
  MAX_PLANTS,
  MAX_SPRITES,
  PLANT_FLOATS,
  PLANT_SEGS,
  PLANTS,
  PREWARM,
  SEG_FLOATS,
  THICKEN_AGE,
  TIP_AGE,
  type VineFrame,
  VINE_SHAPES,
} from "./vines-sim";

/** Shadow offsets (ref px, light from the top left) and strength. */
const STEM_SHADOW = [4, 7] as const;
const LEAF_SHADOW = [6, 10] as const;
const SHADOW_ALPHA = 0.22;
/** Wood panel width (ref px). */
const PLANK = 150;
/** A stem never gets thinner than this fraction of its mature width once its tip has passed. */
const THIN = 0.45;

/**
 * Stem segments: one instance per segment, drawn as a 4-corner strip from end 0
 * to end 1, extruded along each end's normal. Neighbouring segments share their
 * joint's position, heading, width and birth, so the strip is seamless. Width
 * grows with age since that point was laid (the tip tapers to a point, the stem
 * thickens slowly), and plant uniforms carry the x anchor, clock and fade.
 */
const STEM_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** x0, y0, x1, y1 (plant-local ref px). */
layout(location = 1) in vec4 aEnds;
/** Heading at each end (rad), then mature width at each end (ref px). */
layout(location = 2) in vec4 aShape;
/** Birth at each end (plant s), plant index. */
layout(location = 3) in vec3 aMeta;
/** Per plant: x offset (ref px), age (plant s), alpha, wither. */
uniform vec4 uPlant[${MAX_PLANTS}];
uniform vec2 uResolution;
uniform float uScale;
/** Offset (device px) and width multiplier, for the shadow pass. */
uniform vec3 uOffset;
/** Edge softness (device px). */
uniform float uSoft;
out float vDist;
out float vHalf;
out vec2 vFade;
${TO_CLIP_GLSL}
void main() {
  vec4 plant = uPlant[int(aMeta.z + 0.5)];
  bool end1 = aCorner.x > 0.5;
  vec2 c = end1 ? aEnds.zw : aEnds.xy;
  float h = end1 ? aShape.y : aShape.x;
  float w = end1 ? aShape.w : aShape.z;
  float age = max(plant.y - (end1 ? aMeta.y : aMeta.x), 0.0);
  w *= (1.0 - exp(-age * ${glslFloat(1 / TIP_AGE)}))
    * (${glslFloat(THIN)} + ${glslFloat(1 - THIN)} * (1.0 - exp(-age * ${glslFloat(1 / THICKEN_AGE)})));
  float hw = 0.5 * w * uScale * uOffset.z;
  // Thinner than a pixel: keep a pixel-wide line and fade it instead.
  float hp = max(hw, 0.6);
  float reach = hp + uSoft;
  vec2 n = vec2(-sin(h), cos(h));
  vec2 px = (c + vec2(plant.x, 0.0)) * uScale + n * (aCorner.y * reach) + uOffset.xy;
  vDist = aCorner.y * reach;
  vHalf = hp;
  vFade = vec2(plant.z * min(1.0, hw / 0.6), plant.w);
  gl_Position = pxToClip(px, uResolution);
}
`;

/** A rounded stem: darker at its sides, browning as it withers. Premultiplied. */
const STEM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vDist;
in float vHalf;
in vec2 vFade;
uniform vec3 uStem;
uniform vec3 uDead;
/** Shadow strength; 0 for the stem itself. */
uniform float uShadow;
uniform float uSoft;
out vec4 outColor;
void main() {
  float d = abs(vDist);
  float a = clamp((vHalf - d) / max(uSoft, 1.0) + 0.5, 0.0, 1.0) * vFade.x;
  if (uShadow > 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, a * uShadow);
    return;
  }
  float u = d / vHalf;
  vec3 c = mix(uStem, uDead, vFade.y) * (1.1 - 0.45 * u * u);
  outColor = vec4(c * a, a);
}
`;

/**
 * Leaves and flowers: fan-strip outlines (see `fanStrip` in leaves-sim), so `vEdge`
 * runs 0 at the centre to 1 on the rim, and `vAcross` is the unrotated x.
 */
const spriteVertex = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px), opacity. */
layout(location = 1) in vec4 aSprite;
layout(location = 2) in vec3 aColor;
/** In-plane angle (radians), flip scale. */
layout(location = ${spinLocation}) in vec2 aSpin;
uniform vec2 uResolution;
/** Offset (device px), for the shadow pass. */
uniform vec2 uOffset;
out float vEdge;
out float vAcross;
flat out vec4 vColor;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vec2 px = aSprite.xy + spinCorner(aCorner, aSpin) * aSprite.z + uOffset;
  vEdge = dot(aCorner, aCorner) > 0.0 ? 1.0 : 0.0;
  vAcross = aCorner.x;
  vColor = vec4(aColor, aSprite.w);
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * Flat colour, one half a shade darker, a midrib for leaves and a tinted centre
 * for flowers, with an anti-aliased (or, for shadows, blurred) rim. Premultiplied.
 */
const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vEdge;
in float vAcross;
flat in vec4 vColor;
uniform float uVein;
/** Centre colour and how much of the face it covers. */
uniform vec4 uCore;
uniform float uShadow;
/** Rim softness as a fraction of the radius. */
uniform float uSoft;
out vec4 outColor;
void main() {
  float edge = clamp((1.0 - vEdge) / max(fwidth(vEdge), uSoft), 0.0, 1.0);
  float a = edge * vColor.a;
  if (uShadow > 0.0) {
    outColor = vec4(0.0, 0.0, 0.0, a * uShadow);
    return;
  }
  float hw = max(0.04, fwidth(vAcross));
  float vein = uVein * (0.04 / hw) * (1.0 - smoothstep(0.0, hw, abs(vAcross)));
  vec3 c = vColor.rgb * (0.92 + 0.1 * clamp(vAcross * 2.0, -1.0, 1.0)) * (1.0 - 0.3 * vein);
  c = mix(uCore.rgb, c, mix(1.0, smoothstep(0.08, 0.55, vEdge), uCore.a));
  outColor = vec4(c * a, a);
}
`;

/** The wall: a painted or dark plain colour, or vertical wood panels, with a soft vignette. */
const WALL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uColor;
/** 1 for wood panels. */
uniform float uWood;
/** Plank width (device px) and groove half-width as a fraction of a plank. */
uniform vec2 uPlank;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec3 c = uColor;
  if (uWood > 0.5) {
    float x = gl_FragCoord.x / uPlank.x;
    float id = floor(x);
    float f = x - id;
    float r = fract(sin(id * 91.7) * 43758.5453);
    // Broad, slow grain bands: large-scale, so the codec keeps them.
    float grain = sin(f * 7.0 + sin(vUv.y * 2.3 + r * 6.0) * 1.6 + r * 20.0);
    c *= (0.9 + 0.16 * r) * (1.0 + 0.035 * grain);
    c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, uPlank.y, min(f, 1.0 - f)));
  }
  vec2 d = vUv - vec2(0.45, 0.6);
  c *= 1.05 - 0.3 * dot(d, d);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Leafy vines growing in from the frame edges, curling and branching and
 * unfolding leaves and flowers, then withering and dropping their leaves while
 * new shoots start elsewhere. They stay in a border region around the speaker.
 */
export const vines = defineEffect({
  id: "vines",
  name: "Creeping Vines",
  description:
    "Leafy vines that slowly grow in from the edges, flower, then wither and drop their leaves.",
  params: {
    plant: {
      kind: "select",
      label: "Plant",
      options: [
        { value: "ivy", label: "Ivy" },
        { value: "morningGlory", label: "Morning glory" },
        { value: "wisteria", label: "Wisteria" },
      ],
      default: "ivy",
    },
    growth: { kind: "number", label: "Growth speed", min: 0.25, max: 3, step: 0.05, default: 1 },
    density: {
      kind: "number",
      label: "Vines at once",
      min: 1,
      max: MAX_PLANTS,
      step: 1,
      default: 5,
    },
    border: {
      kind: "number",
      label: "Reach in from the edges",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    flowers: { kind: "number", label: "Flowers", min: 0, max: 1, step: 0.01, default: 0.4 },
    wall: {
      kind: "select",
      label: "Wall",
      options: [
        { value: "painted", label: "Painted" },
        { value: "wood", label: "Wood panels" },
        { value: "dark", label: "Dark" },
      ],
      default: "painted",
    },
    background: { kind: "color", label: "Wall colour", default: "#d8cdb9" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      // Stems: a corner strip plus one instance per segment.
      const segCount = MAX_PLANTS * PLANT_SEGS;
      const stemVao = scope.add(gl.createVertexArray(), (v) => gl.deleteVertexArray(v));
      const cornerBuffer = scope.add(gl.createBuffer(), (b) => gl.deleteBuffer(b));
      const segBuffer = scope.add(gl.createBuffer(), (b) => gl.deleteBuffer(b));
      gl.bindVertexArray(stemVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, segBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, segCount * SEG_FLOATS * 4, gl.DYNAMIC_DRAW);
      const strideBytes = SEG_FLOATS * 4;
      [4, 4, 3].reduce((offset, size, i) => {
        gl.enableVertexAttribArray(i + 1);
        gl.vertexAttribPointer(i + 1, size, gl.FLOAT, false, strideBytes, offset);
        gl.vertexAttribDivisor(i + 1, 1);
        return offset + size * 4;
      }, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const stemProgram = scope.add(createProgram(gl, STEM_VERTEX, STEM_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const stemU = createUniforms(gl, stemProgram, [
        "uPlant",
        "uResolution",
        "uScale",
        "uOffset",
        "uSoft",
        "uStem",
        "uDead",
        "uShadow",
      ]);

      // Leaves and flowers: x, y, radius, opacity; r, g, b; then the spin pair.
      const sprites = scope.own(
        createSpriteBatch(gl, MAX_SPRITES, [4, 3], VINE_SHAPES, { rotation: true }),
      );
      const spriteProgram = scope.add(
        createProgram(gl, spriteVertex(sprites.spinLocation), SPRITE_FRAGMENT),
        (p) => gl.deleteProgram(p),
      );
      const spriteU = createUniforms(gl, spriteProgram, [
        "uResolution",
        "uOffset",
        "uVein",
        "uCore",
        "uShadow",
        "uSoft",
      ]);

      const wallProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, WALL_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const wallU = createUniforms(gl, wallProgram, ["uColor", "uWood", "uPlank"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const wallColor = unitRgbMemo();

      const sim = createVines();
      let width = 1;
      let height = 1;
      let scale = 1;
      let warmed = false;
      const f: VineFrame = {
        refWidth: 1920,
        type: PLANTS.ivy,
        growth: 1,
        density: 0,
        border: 0,
        flowers: 0,
      };

      /** Uploads each plant's changed segment range. */
      const uploadSegments = () => {
        let bound = false;
        for (let p = 0; p < MAX_PLANTS; p++) {
          const lo = sim.dirtyLo[p];
          const hi = sim.dirtyHi[p];
          if (lo > hi) continue;
          if (!bound) {
            gl.bindBuffer(gl.ARRAY_BUFFER, segBuffer);
            bound = true;
          }
          const first = p * PLANT_SEGS + lo;
          gl.bufferSubData(
            gl.ARRAY_BUFFER,
            first * strideBytes,
            sim.segData,
            first * SEG_FLOATS,
            (hi - lo + 1) * SEG_FLOATS,
          );
        }
        if (bound) gl.bindBuffer(gl.ARRAY_BUFFER, null);
        sim.clearDirty();
      };

      const drawStems = (shadow: boolean) => {
        // Slots past the last plant in use are zero (degenerate), so stop there.
        let last = -1;
        for (let p = 0; p < MAX_PLANTS; p++) if (sim.active[p]) last = p;
        if (last < 0) return;
        const count = last * PLANT_SEGS + sim.segUsed[last];
        if (count <= 0) return;
        if (shadow) {
          stemU.f3("uOffset", STEM_SHADOW[0] * scale, STEM_SHADOW[1] * scale, 1.15);
          stemU.f1("uSoft", 2.5 * scale);
          stemU.f1("uShadow", SHADOW_ALPHA);
        } else {
          stemU.f3("uOffset", 0, 0, 1);
          stemU.f1("uSoft", 1);
          stemU.f1("uShadow", 0);
        }
        gl.bindVertexArray(stemVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.bindVertexArray(null);
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          f.refWidth = v.width / v.scale;
          sim.resize(f.refWidth);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const type = PLANTS[p.plant] ?? PLANTS.ivy;
          f.type = type;
          f.growth = p.growth;
          f.density = p.density;
          f.border = p.border;
          f.flowers = p.flowers;
          if (!warmed) {
            // Start part-grown rather than on a bare wall.
            warmed = true;
            for (let t = 0; t < PREWARM; t += 0.1) sim.step(0.1, f);
          }
          sim.step(dt, f);
          uploadSegments();

          // Wall.
          const wall = wallColor(p.background);
          const dim = p.wall === "dark" ? 0.2 : 1;
          gl.useProgram(wallProgram);
          wallU.f3("uColor", wall[0] * dim, wall[1] * dim, wall[2] * dim);
          wallU.f1("uWood", p.wall === "wood" ? 1 : 0);
          wallU.f2("uPlank", PLANK * scale, Math.min(0.5, (1.5 * scale) / (PLANK * scale)));
          triangle.draw();

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

          const n = sim.writeSprites(sprites.data, sprites.stride, sprites.spinOffset, scale, type);
          sprites.upload(n);
          const leavesN = sim.leafSprites;
          const flowersN = sim.flowerSprites;

          // Stems: shadows first, then the stems themselves.
          gl.useProgram(stemProgram);
          gl.uniform4fv(stemU.loc.uPlant, sim.plantData, 0, MAX_PLANTS * PLANT_FLOATS);
          stemU.f2("uResolution", width, height);
          stemU.f1("uScale", scale);
          stemU.v3("uStem", type.stem);
          stemU.f3("uDead", 0.45, 0.36, 0.25);
          drawStems(true);

          gl.useProgram(spriteProgram);
          spriteU.f2("uResolution", width, height);
          if (n > 0) {
            spriteU.f2("uOffset", LEAF_SHADOW[0] * scale, LEAF_SHADOW[1] * scale);
            spriteU.f1("uShadow", SHADOW_ALPHA);
            spriteU.f1("uSoft", 0.3);
            sprites.draw(0, leavesN, type.leafShape);
            sprites.draw(leavesN, flowersN, type.flowerShape);
          }

          gl.useProgram(stemProgram);
          drawStems(false);

          if (n > 0) {
            gl.useProgram(spriteProgram);
            spriteU.f2("uOffset", 0, 0);
            spriteU.f1("uShadow", 0);
            spriteU.f1("uSoft", 0);
            spriteU.f1("uVein", type.vein);
            spriteU.f4("uCore", 0, 0, 0, 0);
            sprites.draw(0, leavesN, type.leafShape);
            spriteU.f1("uVein", 0);
            spriteU.f4("uCore", type.core[0], type.core[1], type.core[2], type.coreAmount);
            sprites.draw(leavesN, flowersN, type.flowerShape);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
