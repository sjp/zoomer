import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import {
  createMobile,
  createMotion,
  CRESCENT_CUT_R,
  CRESCENT_CUT_X,
  CRESCENT_CUT_Y,
  MAX_SHAPES,
  MAX_WIRES,
  type Mobile,
  type MobileMotion,
  paletteFor,
  PETAL_OFFSET,
  PETAL_RADIUS,
  poseMobile,
  stepMotion,
  WIRE_FLOATS,
  writeWires,
} from "./mobile-sim";
import { mobileMeta } from "./mobile.meta";
import { QUAD } from "../sprites";
import { createStreakRenderer, STREAK_FLOATS } from "../streaks";
import { defineEffect } from "../types";

/** The shadow mask renders at 1 / SHADOW_DIV of the canvas size: it is all soft. */
const SHADOW_DIV = 4;
/** Wire half-width (px at 1080p) and colour. */
const WIRE_HALF = 0.9;
const WIRE: readonly [number, number, number] = [0.07, 0.068, 0.065];
/** Half the plate's thickness (px at 1080p): an edge-on plate still shows as a line. */
const PLATE_HALF = 0.8;
/** Plate shade with the visible face turned fully from the light, and fully to it. */
const SHADE_MIN = 0.62;
const SHADE_MAX = 1.04;
/**
 * Shadows, in frame heights, for a part at depth D in front of the wall: offset
 * (x right, y down) SHADOW_BASE + SHADOW_K * D, blur radius BLUR_BASE + BLUR_K * D.
 * The light is up and to the left, so shadows fall down and to the right.
 */
const SHADOW_BASE = [0.012, 0.018] as const;
const SHADOW_K = [0.11, 0.14] as const;
const BLUR_BASE = 0.0025;
const BLUR_K = 0.03;
/** How much a full shadow darkens the wall, per channel (slightly cool). */
const SHADOW_TINT = [0.3, 0.28, 0.24] as const;
/** Wire shadows: nested widths (fraction of the blur) and their strengths. */
const WIRE_SHADOW_WIDTH = [0.25, 0.6, 1] as const;
const WIRE_SHADOW_LEVEL = [0.55, 0.32, 0.14] as const;
/** Floats per shape instance: place (x, y, r, ux), look (cos, sin, kind, shade), colour + depth. */
const SHAPE_FLOATS = 12;

/** The wall: a gentle light falloff from the upper left, darkened by the shadow mask. */
const WALL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uWall;
uniform vec3 uShadowTint;
uniform vec2 uMaskScale;
uniform sampler2D uMask;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float light = 0.93 + 0.06 * vUv.y + 0.05 * (1.0 - vUv.x);
  float m = texture(uMask, gl_FragCoord.xy * uMaskScale).r;
  vec3 c = uWall * light * (1.0 - uShadowTint * m);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A flat plate, as a quad fitted to its foreshortened outline. Positions are in
 * canvas px (y down); the shadow pass shifts and pads the quad by the shadow's
 * offset and blur, then scales everything to the mask's px with uPxScale.
 * vLocal is the plate's own coordinates (radius 1, y up); its x axis turns with
 * the plate, so it is scaled by the signed ux and a back face comes out mirrored.
 */
const SHAPE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aPlace;
layout(location = 2) in vec4 aLook;
layout(location = 3) in vec4 aColor;
uniform vec2 uResolution;
uniform float uPxScale;
uniform float uShadow;
uniform vec2 uShadowBase;
uniform vec2 uShadowK;
uniform vec2 uBlur;
out vec2 vLocal;
flat out vec4 vLook;
flat out vec3 vColor;
flat out vec2 vSoft;
${TO_CLIP_GLSL}
void main() {
  float r = aPlace.z;
  float ux = aPlace.w;
  float sx = r * abs(ux);
  vec2 c = aPlace.xy;
  float blur = 0.0;
  float peak = 1.0;
  if (uShadow > 0.5) {
    c += uShadowBase + uShadowK * aColor.w;
    blur = uBlur.x + uBlur.y * aColor.w;
    // A plate narrower than the blur leaves only a faint shadow.
    peak = clamp(1.5 * sx / blur, 0.0, 1.0);
  }
  // One px of the target for the anti-aliased edge, plus the blur.
  vec2 halfSize = vec2(sx, r) + blur + 1.0 / uPxScale;
  vec2 off = aCorner * halfSize;
  vLocal = vec2(off.x / (r * ux), -off.y / r);
  vLook = aLook;
  vColor = aColor.rgb;
  vSoft = vec2(blur * uPxScale, peak);
  gl_Position = pxToClip((c + off) * uPxScale, uResolution);
}
`;

const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vLook;
flat in vec3 vColor;
flat in vec2 vSoft;
uniform float uShadow;
out vec4 outColor;
const float PETAL_OFFSET = ${glslFloat(PETAL_OFFSET)};
const float PETAL_RADIUS = ${glslFloat(PETAL_RADIUS)};
const vec2 CRESCENT_CUT = vec2(${glslFloat(CRESCENT_CUT_X)}, ${glslFloat(CRESCENT_CUT_Y)});
const float CRESCENT_CUT_R = ${glslFloat(CRESCENT_CUT_R)};

/** Signed distance to the outline, radius 1; the twin of shapeSdf in mobile-sim.ts. */
float shapeDist(vec2 p, float kind) {
  float disc = length(p) - 1.0;
  if (kind < 0.5) return disc;
  if (kind < 1.5) {
    return max(
      length(p - vec2(PETAL_OFFSET, 0.0)) - PETAL_RADIUS,
      length(p + vec2(PETAL_OFFSET, 0.0)) - PETAL_RADIUS
    );
  }
  return max(disc, CRESCENT_CUT_R - length(p - CRESCENT_CUT));
}

void main() {
  // Undo the outline's in-plane rotation (cos, sin in vLook.xy).
  vec2 p = vec2(
    vLook.x * vLocal.x + vLook.y * vLocal.y,
    -vLook.y * vLocal.x + vLook.x * vLocal.y
  );
  float d = shapeDist(p, vLook.z);
  // Distance in target px, from the outline's screen-space gradient.
  float px = d / max(length(vec2(dFdx(d), dFdy(d))), 1e-6);
  if (uShadow > 0.5) {
    float cover = (1.0 - smoothstep(-vSoft.x, vSoft.x, px)) * vSoft.y;
    outColor = vec4(cover);
  } else {
    float cover = clamp(0.5 - px, 0.0, 1.0);
    outColor = vec4(vColor * vLook.w * cover, cover);
  }
}
`;

/**
 * Hanging mobile: a shadow mask at quarter resolution (the plates and wires again,
 * shifted and blurred by their distance from the wall, max-blended so overlaps
 * don't stack), then the wall with the mask in one full-screen pass, the wires as
 * alpha streaks, and the plates as instanced quads, far to near.
 */
export const mobile = defineEffect(mobileMeta, {
  create(gl) {
    return withScope((scope) => {
      const wallProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, WALL_FRAGMENT);
      const wu = createUniforms(gl, wallProgram, ["uWall", "uShadowTint", "uMaskScale", "uMask"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const shapeProgram = scopedProgram(gl, scope, SHAPE_VERTEX, SHAPE_FRAGMENT);
      const su = createUniforms(gl, shapeProgram, [
        "uResolution",
        "uPxScale",
        "uShadow",
        "uShadowBase",
        "uShadowK",
        "uBlur",
      ]);
      const wires = scope.own(createStreakRenderer(gl, MAX_WIRES, { blend: "alpha" }));
      const wireShadows = scope.own(
        createStreakRenderer(gl, MAX_WIRES * WIRE_SHADOW_WIDTH.length, { blend: "max" }),
      );

      const vao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const cornerBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const instanceBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const instances = new Float32Array(MAX_SHAPES * SHAPE_FLOATS);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(QUAD), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
      for (let i = 0; i < 3; i++) {
        gl.enableVertexAttribArray(1 + i);
        gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, SHAPE_FLOATS * 4, i * 16);
        gl.vertexAttribDivisor(1 + i, 1);
      }
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      gl.useProgram(wallProgram);
      wu.i1("uMask", 0);
      wu.f3("uShadowTint", SHADOW_TINT[0], SHADOW_TINT[1], SHADOW_TINT[2]);
      gl.useProgram(null);

      let target: RenderTarget | null = null;
      scope.defer(() => target?.dispose());

      const wall = unitRgbMemo();
      const wireData = new Float32Array(MAX_WIRES * WIRE_FLOATS);
      /** Shape indices, sorted far to near each frame. */
      const order: number[] = Array.from({ length: MAX_SHAPES }, (_, i) => i);
      let mob: Mobile | null = null;
      let mobSeed = Number.NaN;
      let mobLevels = Number.NaN;
      let mobSide = "";
      let mobAspect = Number.NaN;
      let motion: MobileMotion | null = null;
      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
          const tw = Math.max(1, Math.ceil(width / SHADOW_DIV));
          const th = Math.max(1, Math.ceil(height / SHADOW_DIV));
          if (!target || target.width !== tw || target.height !== th) {
            target?.dispose();
            target = null;
            target =
              createRenderTarget(gl, tw, th, gl.R8) ?? createRenderTarget(gl, tw, th, gl.RGBA8);
            if (!target) {
              throw new Error("Hanging Mobile: no renderable shadow buffer");
            }
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const levels = Math.round(p.levels);
          const seed = Math.floor(p.seed);
          if (
            mob === null ||
            seed !== mobSeed ||
            levels !== mobLevels ||
            p.side !== mobSide ||
            aspect !== mobAspect
          ) {
            mob = createMobile(seed, levels, p.side, aspect);
            mobSeed = seed;
            mobLevels = levels;
            mobSide = p.side;
            mobAspect = aspect;
            for (let i = 0; i < MAX_SHAPES; i++) {
              order[i] = i;
            }
          }
          motion ??= createMotion(p.draught);
          stepMotion(motion, dt, p.draught);
          poseMobile(mob, motion);
          const nWires = writeWires(mob, wireData);
          const shapes = mob.shapes;
          const nShapes = Math.min(shapes.length, MAX_SHAPES);
          const h = height;
          const wallZ = mob.wallZ;

          // Plates far to near (insertion sort: the order barely changes per frame).
          for (let i = 1; i < nShapes; i++) {
            const k = order[i];
            let j = i - 1;
            while (j >= 0 && shapes[order[j]].z > shapes[k].z) {
              order[j + 1] = order[j];
              j--;
            }
            order[j + 1] = k;
          }
          const palette = paletteFor(p.palette);
          const thin = PLATE_HALF * scale;
          for (let i = 0; i < nShapes; i++) {
            const sh = shapes[order[i]];
            const o = i * SHAPE_FLOATS;
            const r = sh.r * h;
            const minUx = Math.min(1, thin / r);
            const ux = sh.ux < 0 ? Math.min(sh.ux, -minUx) : Math.max(sh.ux, minUx);
            const colour = palette[sh.colour];
            instances[o] = sh.x * h;
            instances[o + 1] = (1 - sh.y) * h;
            instances[o + 2] = r;
            instances[o + 3] = ux;
            instances[o + 4] = Math.cos(sh.spin);
            instances[o + 5] = Math.sin(sh.spin);
            instances[o + 6] = sh.kind;
            instances[o + 7] = SHADE_MIN + (SHADE_MAX - SHADE_MIN) * (0.5 + 0.5 * sh.lit);
            instances[o + 8] = colour[0];
            instances[o + 9] = colour[1];
            instances[o + 10] = colour[2];
            instances[o + 11] = sh.z - wallZ;
          }
          if (nShapes > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, nShapes * SHAPE_FLOATS);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
          }

          // Wires (canvas px) and their shadows (mask px), from the posed segments.
          const wireHalf = WIRE_HALF * scale;
          const inv = 1 / SHADOW_DIV;
          const wd = wires.data;
          const sd = wireShadows.data;
          let ns = 0;
          for (let i = 0; i < nWires; i++) {
            const w = i * WIRE_FLOATS;
            const x0 = wireData[w] * h;
            const y0 = (1 - wireData[w + 1]) * h;
            const d0 = wireData[w + 2] - wallZ;
            const x1 = wireData[w + 3] * h;
            const y1 = (1 - wireData[w + 4]) * h;
            const d1 = wireData[w + 5] - wallZ;
            const o = i * STREAK_FLOATS;
            wd[o] = x0;
            wd[o + 1] = y0;
            wd[o + 2] = x1;
            wd[o + 3] = y1;
            wd[o + 4] = WIRE[0];
            wd[o + 5] = WIRE[1];
            wd[o + 6] = WIRE[2];
            wd[o + 7] = wireHalf;
            const blur = (BLUR_BASE + BLUR_K * 0.5 * (d0 + d1)) * h;
            const q = Math.min(1, (4 * wireHalf) / blur);
            const sx0 = (x0 + (SHADOW_BASE[0] + SHADOW_K[0] * d0) * h) * inv;
            const sy0 = (y0 + (SHADOW_BASE[1] + SHADOW_K[1] * d0) * h) * inv;
            const sx1 = (x1 + (SHADOW_BASE[0] + SHADOW_K[0] * d1) * h) * inv;
            const sy1 = (y1 + (SHADOW_BASE[1] + SHADOW_K[1] * d1) * h) * inv;
            for (let k = 0; k < WIRE_SHADOW_WIDTH.length; k++) {
              const so = ns++ * STREAK_FLOATS;
              const v = WIRE_SHADOW_LEVEL[k] * q;
              sd[so] = sx0;
              sd[so + 1] = sy0;
              sd[so + 2] = sx1;
              sd[so + 3] = sy1;
              sd[so + 4] = v;
              sd[so + 5] = v;
              sd[so + 6] = v;
              sd[so + 7] = (wireHalf + blur * WIRE_SHADOW_WIDTH[k]) * inv;
            }
          }

          // 1. Shadow mask: plates, then wires, max-blended.
          const mask = target;
          if (mask) {
            mask.bind();
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            if (nShapes > 0) {
              gl.enable(gl.BLEND);
              gl.blendEquation(gl.MAX);
              gl.blendFunc(gl.ONE, gl.ONE);
              gl.useProgram(shapeProgram);
              su.f2("uResolution", mask.width, mask.height);
              su.f1("uPxScale", inv);
              su.f1("uShadow", 1);
              su.f2("uShadowBase", SHADOW_BASE[0] * h, SHADOW_BASE[1] * h);
              su.f2("uShadowK", SHADOW_K[0] * h, SHADOW_K[1] * h);
              su.f2("uBlur", BLUR_BASE * h, BLUR_K * h);
              gl.bindVertexArray(vao);
              gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nShapes);
              gl.bindVertexArray(null);
              gl.blendEquation(gl.FUNC_ADD);
            }
            if (ns > 0) {
              wireShadows.upload(ns);
              wireShadows.draw(ns, mask.width, mask.height);
            }
            gl.disable(gl.BLEND);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. Wall, with the shadows.
          gl.useProgram(wallProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, mask ? mask.texture : null);
          wu.v3("uWall", wall(p.wall));
          if (mask) {
            wu.f2("uMaskScale", 1 / (mask.width * SHADOW_DIV), 1 / (mask.height * SHADOW_DIV));
          }
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);

          // 3. Wires, behind the plates they hold.
          if (nWires > 0) {
            wires.upload(nWires);
            wires.draw(nWires, width, height);
          }

          // 4. Plates, far to near.
          if (nShapes > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(shapeProgram);
            su.f2("uResolution", width, height);
            su.f1("uPxScale", 1);
            su.f1("uShadow", 0);
            gl.bindVertexArray(vao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nShapes);
            gl.bindVertexArray(null);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
