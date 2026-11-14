import { createColorEase, hexToUnitRgb } from "../color";
import { beginFrame, createUniforms, scopedProgram, TO_CLIP_GLSL, withScope } from "../gl";
import { QUAD, createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import { createShapeList, emitScene, MAX_SHAPES, STRIDE } from "./memphis-shapes";
import {
  C_BG,
  createLayout,
  createScene,
  PALETTES,
  REF_HEIGHT,
  ROLE_COUNT,
  stepScene,
  updateLayout,
} from "./memphis-sim";
import { memphisMeta } from "./memphis.meta";

/** Seconds a palette change crossfades. */
const PALETTE_EASE = 1.2;

/**
 * One flat shape per instance, its quad fitted round the shape in a frame along
 * a -> b: x along, y across, in reference px.
 */
const SHAPE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** End points a and b, reference px, y down. */
layout(location = 1) in vec4 aEnds;
/** Radius at a, radius at b (or the blob's phase, 0..2π), corner radius (or wobble), kind. */
layout(location = 2) in vec4 aShape;
/** Straight RGB and opacity. */
layout(location = 3) in vec4 aColor;
uniform vec2 uResolution;
/** Device px per reference px. */
uniform float uScale;
out vec2 vLocal;
flat out vec4 vShape;
flat out float vLength;
flat out vec4 vColor;
${TO_CLIP_GLSL}
void main() {
  vec2 a = aEnds.xy;
  vec2 d = aEnds.zw - a;
  float len = length(d);
  vec2 u = len > 1e-3 ? d / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  float ra = aShape.x;
  float rb = aShape.y;
  int kind = int(aShape.w + 0.5);
  vec2 lo;
  vec2 hi;
  if (kind == 1) {
    lo = vec2(0.0, -ra);
    hi = vec2(len, ra);
  } else if (kind == 2) {
    float r = max(ra, rb);
    lo = vec2(0.0, -r);
    hi = vec2(len, r);
  } else if (kind == 3) {
    lo = vec2(-(ra + rb));
    hi = -lo;
  } else if (kind == 4) {
    lo = vec2(-ra * (1.0 + aShape.z));
    hi = -lo;
  } else {
    float r = max(ra, rb);
    lo = vec2(-r);
    hi = vec2(len + r, r);
  }
  // A device px of room for the anti-aliased edge.
  float pad = 1.5 / uScale;
  vec2 local = mix(lo - pad, hi + pad, aCorner * 0.5 + 0.5);
  vLocal = local;
  vShape = aShape;
  vLength = len;
  vColor = aColor;
  gl_Position = pxToClip((a + u * local.x + v * local.y) * uScale, uResolution);
}
`;

/** Signed distances (reference px) per kind; coverage from one device px of edge. */
const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vShape;
flat in float vLength;
flat in vec4 vColor;
uniform float uScale;
out vec4 outColor;

// Inigo Quilez's distance functions; p.x across, p.y along.
float unevenCapsule(vec2 p, float r1, float r2, float h) {
  p.x = abs(p.x);
  float b = (r1 - r2) / h;
  float a = sqrt(1.0 - b * b);
  float k = dot(p, vec2(-b, a));
  if (k < 0.0) {
    return length(p) - r1;
  }
  if (k > a * h) {
    return length(p - vec2(0.0, h)) - r2;
  }
  return dot(p, vec2(a, b)) - r1;
}

float trapezoid(vec2 p, float r1, float r2, float he) {
  vec2 k1 = vec2(r2, he);
  vec2 k2 = vec2(r2 - r1, 2.0 * he);
  p.x = abs(p.x);
  vec2 ca = vec2(p.x - (p.y < 0.0 ? r1 : r2), abs(p.y) - he);
  vec2 cb = p - k1 + k2 * clamp(dot(k1 - p, k2) / dot(k2, k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}

/** An approximate ellipse distance, good near the edge. */
float ellipse(vec2 p, vec2 ab) {
  float k0 = length(p / ab);
  if (k0 < 1e-4) {
    return -min(ab.x, ab.y);
  }
  float k1 = length(p / (ab * ab));
  return k0 * (k0 - 1.0) / k1;
}

void main() {
  vec2 p = vLocal;
  float len = vLength;
  float ra = vShape.x;
  float rb = vShape.y;
  float corner = vShape.z;
  int kind = int(vShape.w + 0.5);
  float d;
  if (kind == 1) {
    d = ellipse(vec2(p.x - 0.5 * len, p.y), vec2(max(0.5 * len, 1e-3), max(ra, 1e-3)));
  } else if (kind == 2) {
    float he = max(0.5 * len, 1e-3);
    float c = min(corner, he);
    d = trapezoid(vec2(p.y, p.x - 0.5 * len), max(ra - c, 0.0), max(rb - c, 0.0), max(he - c, 1e-3)) - c;
  } else if (kind == 3) {
    d = abs(length(p) - ra) - rb;
  } else if (kind == 4) {
    float ang = atan(p.y, p.x);
    float r = ra * (1.0 + corner * (0.6 * sin(3.0 * ang + rb) + 0.4 * sin(2.0 * ang - 2.0 * rb)));
    d = (length(p) - r) * 0.8;
  } else if (len < 1e-3 || abs(ra - rb) >= len) {
    d = min(length(p) - ra, length(p - vec2(len, 0.0)) - rb);
  } else {
    d = unevenCapsule(vec2(p.y, p.x), ra, rb, len);
  }
  float a = vColor.a * clamp(0.5 - d * uScale, 0.0, 1.0);
  outColor = vec4(vColor.rgb * a, a);
}
`;

/**
 * Corporate Memphis: lanky flat people with tiny heads at the sides of the
 * frame, among oversized plants, floating props and soft blobs, swaying,
 * waving and now and then changing pose. Every shape is a signed-distance
 * sprite in one instanced draw over a cleared background.
 */
export const memphis = defineEffect(memphisMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, SHAPE_VERTEX, SHAPE_FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uScale"]);
      const batch = scope.own(createSpriteBatch(gl, MAX_SHAPES, [4, 4, 4], [QUAD]));
      const list = createShapeList(batch.data);
      if (batch.stride !== STRIDE) {
        throw new Error("Corporate Memphis: shape stride mismatch");
      }
      const targets: Record<string, Float32Array> = {};
      for (const [key, colors] of Object.entries(PALETTES)) {
        const t = new Float32Array(ROLE_COUNT * 3);
        colors.forEach((hex, i) => {
          t.set(hexToUnitRgb(hex), 3 * i);
        });
        targets[key] = t;
      }
      const ease = createColorEase(ROLE_COUNT * 3);
      const layout = createLayout();
      const scene = createScene(0);

      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / REF_HEIGHT;
          updateLayout(layout, width / scale, height / scale);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          stepScene(scene, layout, step, p);
          const palette = ease.step(targets[p.palette] ?? targets.startup, step, PALETTE_EASE);

          gl.clearColor(palette[3 * C_BG], palette[3 * C_BG + 1], palette[3 * C_BG + 2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);

          const count = emitScene(list, scene, layout, palette);
          if (count > 0) {
            batch.upload(count);
            gl.useProgram(program);
            u.f2("uResolution", width, height);
            u.f1("uScale", scale);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            batch.draw(0, count);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
