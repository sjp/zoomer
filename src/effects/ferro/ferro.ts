import {
  BACKDROPS,
  backdropOf,
  CAMERA,
  CELL_Y,
  CONE_RADIUS,
  crownHeight,
  DOME_HEIGHT,
  initialState,
  layoutPool,
  lipschitz,
  maxHeight,
  poolBounds,
  positionOf,
  rhythmOf,
  SHADOW_DEPTH,
  SHADOW_RADIUS,
  spacingFor,
  spikeHeight,
  stepState,
  type Field,
  type FerroState,
  type Layout,
  type Rect,
} from "./ferro-sim";
import { FERRO_STEPS, ferroMeta } from "./ferro.meta";
import {
  beginFrame,
  createFullscreenTriangle,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "../gl";
import { unitRgbMemo } from "../color";
import { defineEffect } from "../types";

/** The march's shortest step, as a fraction of an even step (see POOL_FRAGMENT). */
const MIN_STEP = 2 / 3;
/** Bisection steps after the march brackets the surface. */
const REFINE = 5;
/** Reflectance at normal incidence: an oily, glass-like black. */
const F0 = 0.04;
/** The fluid's own (diffuse) colour: nearly black. */
const BASE = 0.008;
/** Reflected floor, relative to the wall's bottom colour. */
const FLOOR_DIM = 0.8;

/**
 * Pool pass, drawn only inside a scissor around the pool (see `poolBounds`). Each
 * pixel casts a ray from the pool's camera, clips it to the slab under the field's
 * bound at its closest approach to the pool's axis and to the pool's cylinder, then
 * marches at most uSteps steps to bracket the surface and bisects REFINE times. Each
 * step is the larger of MIN_STEP even steps and the distance the Lipschitz bound
 * proves free of fluid, so clear air is crossed fast and thin spike tips near the
 * ray are sampled finely; the last step always lands on the segment's end. Normals come from the analytic gradient. The
 * fluid reflects an environment of the backdrop gradient plus three soft boxes,
 * weighted by Fresnel. Rays that miss keep the backdrop (darkened by a contact
 * shadow on the floor) and take partial coverage from their closest approach, so the
 * silhouette is anti-aliased. Mirrors `heightAt` and `gradientAt` in `ferro-sim.ts`.
 */
const POOL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uResolution;
uniform vec3 uTop;
uniform vec3 uBottom;
/** Soft-box radiance (tint times intensity). */
uniform vec3 uLight;
/** Screen position of the pool's centre, pixels. */
uniform vec2 uAnchor;
uniform float uFocal;
/** Lattice: cos and sin of its angle, 1 / spacing. */
uniform vec3 uLattice;
/** Crown height, spike height, slab top, Lipschitz bound. */
uniform vec4 uShape;
uniform int uSteps;
out vec4 outColor;

const int MAX_STEPS = ${String(FERRO_STEPS.high)};
const int REFINE = ${String(REFINE)};
const float MIN_STEP = ${glslFloat(MIN_STEP)};
const vec3 CAM_POS = vec3(0.0, ${glslFloat(CAMERA.pos[1])}, ${glslFloat(CAMERA.pos[2])});
const vec3 CAM_UP = vec3(0.0, ${glslFloat(CAMERA.up[1])}, ${glslFloat(CAMERA.up[2])});
const vec3 CAM_FWD = vec3(0.0, ${glslFloat(CAMERA.fwd[1])}, ${glslFloat(CAMERA.fwd[2])});
const vec2 CELL = vec2(1.0, ${glslFloat(CELL_Y)});
const float H0 = ${glslFloat(DOME_HEIGHT)};
const float INV_CONE = ${glslFloat(1 / CONE_RADIUS)};
const float SHADOW_R = ${glslFloat(SHADOW_RADIUS)};
const float SHADOW_DEPTH = ${glslFloat(SHADOW_DEPTH)};
const float F0 = ${glslFloat(F0)};
const float BASE = ${glslFloat(BASE)};
const float FLOOR_DIM = ${glslFloat(FLOOR_DIM)};
${DITHER_GLSL}

/** Offset from the nearest lattice point, lattice units (see latticeOffset). */
vec2 latticeOffset(vec2 xz) {
  vec2 lp = vec2(uLattice.x * xz.x - uLattice.y * xz.y, uLattice.y * xz.x + uLattice.x * xz.y) * uLattice.z;
  vec2 a = mod(lp + 0.5 * CELL, CELL) - 0.5 * CELL;
  vec2 b = mod(lp, CELL) - 0.5 * CELL;
  return dot(a, a) < dot(b, b) ? a : b;
}

float heightAt(vec2 xz) {
  float r2 = dot(xz, xz);
  if (r2 >= 1.0) return 0.0;
  float e = 1.0 - r2;
  float c = max(0.0, 1.0 - length(latticeOffset(xz)) * INV_CONE);
  return H0 * (1.0 - r2 * r2) + e * e * (uShape.x + uShape.y * c * c * (2.0 - c));
}

/** Upper bound of heightAt over the circle of squared radius r2 (see boundAt). */
float boundAt(float r2) {
  if (r2 >= 1.0) return 0.0;
  float e = 1.0 - r2;
  return H0 * (1.0 - r2 * r2) + e * e * (uShape.x + uShape.y);
}

vec2 gradientAt(vec2 xz) {
  float r2 = dot(xz, xz);
  if (r2 >= 1.0) return vec2(0.0);
  float e = 1.0 - r2;
  vec2 a = latticeOffset(xz);
  float d = length(a);
  float c = max(0.0, 1.0 - d * INV_CONE);
  float s = uShape.x + uShape.y * c * c * (2.0 - c);
  vec2 g = (-4.0 * H0 * r2 - 4.0 * e * s) * xz;
  if (c > 0.0 && d > 1e-6) {
    vec2 u = a / d;
    float k = -e * e * uShape.y * c * (4.0 - 3.0 * c) * INV_CONE * uLattice.z;
    g += k * vec2(uLattice.x * u.x + uLattice.y * u.y, -uLattice.y * u.x + uLattice.x * u.y);
  }
  return g;
}

/** A soft-edged rectangle: 1 inside, 0 outside. */
float softBox(vec2 q, vec2 centre, vec2 halfSize, float soft) {
  vec2 d = abs(q - centre) - halfSize;
  return 1.0 - smoothstep(-soft, soft, max(d.x, d.y));
}

/** Radiance seen along direction r: the studio backdrop and its soft boxes. */
vec3 environment(vec3 r) {
  vec3 wall = mix(uBottom, uTop, smoothstep(0.0, 0.6, r.y));
  vec3 col = mix(uBottom * FLOOR_DIM, wall, smoothstep(-0.08, 0.04, r.y));
  // Overhead key: a box on the plane y = 1, above and a little behind the pool.
  if (r.y > 0.05) col += uLight * softBox(r.xz / r.y, vec2(-0.4, -1.3), vec2(0.55, 0.3), 0.05);
  // Tall strip lights on the planes x = +-1: a bright one right, a dimmer fill left.
  if (abs(r.x) > 0.05) {
    float strip = softBox(r.yz / abs(r.x), vec2(0.4, -0.3), vec2(0.25, 0.9), 0.04);
    col += uLight * strip * (r.x > 0.0 ? 0.8 : 0.3);
  }
  return col;
}

vec3 shadeFluid(vec3 p, vec3 dir) {
  vec2 g = gradientAt(p.xz);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  float cosv = clamp(-dot(dir, n), 0.0, 1.0);
  float f = 1.0 - cosv;
  float f2 = f * f;
  float fres = F0 + (1.0 - F0) * f2 * f2 * f;
  return vec3(BASE) + fres * environment(reflect(dir, n));
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  // Matches createGradientBackground, drawn outside the scissor.
  vec3 bg = mix(uTop, uBottom, 1.0 - frag.y / uResolution.y);
  vec2 q = frag - uAnchor;
  vec3 dir = normalize(vec3(q.x, 0.0, 0.0) + q.y * CAM_UP + uFocal * CAM_FWD);
  float cover = 0.0;
  vec3 fluid = vec3(0.0);

  if (dir.y < -1e-4) {
    float invDy = -1.0 / dir.y;
    float tFloor = CAM_POS.y * invDy;
    vec2 floorXz = CAM_POS.xz + tFloor * dir.xz;
    float rFloor = length(floorXz);
    float shadow = 1.0 - smoothstep(1.0, SHADOW_R, rFloor);
    bg *= 1.0 - SHADOW_DEPTH * shadow * shadow;

    // Clip the ray to the pool's cylinder, and to the slab under the field's bound at
    // the ray's closest approach to the axis (the bound falls with the radius).
    float qa = dot(dir.xz, dir.xz);
    float qb = dot(CAM_POS.xz, dir.xz);
    float o2 = dot(CAM_POS.xz, CAM_POS.xz);
    float qc = o2 - 1.0;
    float top = min(uShape.z, boundAt(max(0.0, o2 - qb * qb / qa)) * 1.001 + 1e-4);
    float tTop = (CAM_POS.y - top) * invDy;
    float disc = qb * qb - qa * qc;
    vec3 hitP = vec3(0.0);
    bool shade = false;
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float t0 = max(tTop, (-qb - sq) / qa);
      float t1 = min(tFloor, (-qb + sq) / qa);
      if (t1 > t0) {
        float minStep = MIN_STEP * (t1 - t0) / float(uSteps);
        // Gap shrinks at most this fast along the ray: 1 / (L |dir.xz| + |dir.y|).
        float rate = 1.0 / (uShape.w * sqrt(qa) - dir.y);
        float gap = 0.0;
        float tPrev = t0;
        float t = t0;
        bool hit = false;
        float minGap = 1e9;
        float tGap = t0;
        for (int i = 1; i <= MAX_STEPS; i++) {
          if (i > uSteps) break;
          t = i == uSteps ? t1 : min(t1, t + max(minStep, gap * rate));
          vec3 p = CAM_POS + t * dir;
          gap = p.y - heightAt(p.xz);
          if (gap < 0.0) {
            hit = true;
            break;
          }
          // The gap in pixels: a world unit at distance t spans uFocal / t pixels.
          float gapPx = gap * uFocal / t;
          if (gapPx < minGap) {
            minGap = gapPx;
            tGap = t;
          }
          tPrev = t;
          if (t >= t1) break;
        }
        if (hit) {
          float lo = tPrev;
          float hi = t;
          for (int j = 0; j < REFINE; j++) {
            float m = 0.5 * (lo + hi);
            vec3 p = CAM_POS + m * dir;
            if (p.y < heightAt(p.xz)) hi = m;
            else lo = m;
          }
          hitP = CAM_POS + hi * dir;
          cover = 1.0;
          shade = true;
        } else {
          cover = clamp(1.0 - minGap, 0.0, 1.0);
          if (cover > 0.0) {
            hitP = CAM_POS + tGap * dir;
            hitP.y = heightAt(hitP.xz);
            shade = true;
          }
        }
      }
    }
    // The rim where it meets the floor: coverage from the floor hit's distance past
    // it, in pixels (foreshortened along the view).
    if (rFloor > 1.0 && cover < 1.0) {
      vec2 n = floorXz / rFloor;
      float px = (rFloor - 1.0) * uFocal / tFloor * length(vec2(n.x, n.y * dir.y));
      float rim = clamp(1.0 - px, 0.0, 1.0);
      if (rim > cover) {
        cover = rim;
        hitP = vec3(n * 0.999, 0.0);
        hitP.y = heightAt(hitP.xz);
        shade = true;
      }
    }
    if (shade) fluid = shadeFluid(hitP, dir);
  }
  outColor = vec4(clamp(mix(bg, fluid, cover) + dither8(frag), 0.0, 1.0), 1.0);
}
`;

/**
 * Ferrofluid: a glossy black pool in a bottom corner, ray-marched as a height field
 * inside a scissor around it, rising into a hexagonal crown of spikes as an unseen
 * magnet pulses, and relaxing again. The rest of the frame is the studio backdrop.
 */
export const ferro = defineEffect(ferroMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scope.own(createGradientBackground(gl));
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, POOL_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const u = createUniforms(gl, program, [
        "uResolution",
        "uTop",
        "uBottom",
        "uLight",
        "uAnchor",
        "uFocal",
        "uLattice",
        "uShape",
        "uSteps",
      ]);
      const rgb = unitRgbMemo();

      let width = 1;
      let height = 1;
      let state: FerroState | null = null;
      const field: Field = { amp: 0, spacing: 1, angle: 0 };
      const layout: Layout = { focal: 1, anchorX: 0, anchorY: 0 };
      const bounds: Rect = { x: 0, y: 0, w: 0, h: 0 };

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const rhythm = rhythmOf(p.rhythm);
          state ??= initialState(rhythm);
          stepState(state, dt, p.period, rhythm);

          const backdrop = BACKDROPS[backdropOf(p.backdrop)];
          const top = rgb(backdrop.top);
          const bottom = rgb(backdrop.bottom);
          background.draw(top, bottom);

          field.amp = state.amp;
          field.angle = state.angle;
          field.spacing = spacingFor(p.spikes, state.amp);
          // A hair above the centre spike's tip, so the slab never clips it.
          const slabTop = maxHeight(field) * 1.001 + 1e-4;
          layoutPool(width, height, p.size, positionOf(p.position), layout);
          poolBounds(layout, slabTop, width, height, bounds);
          if (bounds.w <= 0 || bounds.h <= 0) {
            return;
          }

          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(bounds.x, bounds.y, bounds.w, bounds.h);
          gl.useProgram(program);
          u.f2("uResolution", width, height);
          u.v3("uTop", top);
          u.v3("uBottom", bottom);
          u.v3("uLight", backdrop.light);
          u.f2("uAnchor", layout.anchorX, layout.anchorY);
          u.f1("uFocal", layout.focal);
          u.f3("uLattice", Math.cos(field.angle), Math.sin(field.angle), 1 / field.spacing);
          u.f4("uShape", crownHeight(field), spikeHeight(field), slabTop, lipschitz(field));
          u.i1("uSteps", p.quality === "low" ? FERRO_STEPS.low : FERRO_STEPS.high);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
