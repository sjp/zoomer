import { createColorEase, hexToUnitRgb } from "../color";
import { beginFrame, createUniforms, scopedProgram, TO_CLIP_GLSL, withScope } from "../gl";
import { QUAD, createSpriteBatch } from "../sprites";
import { defineEffect } from "../types";
import { createMesh, MAX_INDICES, MAX_VERTICES, VERTEX_FLOATS } from "./memphis-mesh";
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

/** The people: filled outlines, straight colour per vertex (the fringe fades to 0). */
const MESH_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec4 aColor;
uniform vec2 uResolution;
uniform float uScale;
out vec4 vColor;
${TO_CLIP_GLSL}
void main() {
  vColor = aColor;
  gl_Position = pxToClip(aPosition * uScale, uResolution);
}
`;

const MESH_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor.rgb * vColor.a, vColor.a);
}
`;

/**
 * Corporate Memphis: flat people in the mix-and-match illustration-kit style
 * at the sides of the frame, among oversized plants, floating props and soft
 * blobs, swaying, waving and now and then changing pose. The background and
 * props are signed-distance sprites in one instanced batch; the people are a
 * mesh of antialiased outlines drawn between its back and front shapes.
 */
export const memphis = defineEffect(memphisMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, SHAPE_VERTEX, SHAPE_FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uScale"]);
      const batch = scope.own(createSpriteBatch(gl, MAX_SHAPES, [4, 4, 4], [QUAD]));
      const list = createShapeList(batch.data);
      const meshProgram = scopedProgram(gl, scope, MESH_VERTEX, MESH_FRAGMENT);
      const mu = createUniforms(gl, meshProgram, ["uResolution", "uScale"]);
      const mesh = createMesh();
      const meshVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const meshVertices = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const meshIndices = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(meshVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, meshVertices);
      gl.bufferData(gl.ARRAY_BUFFER, MAX_VERTICES * VERTEX_FLOATS * 4, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VERTEX_FLOATS * 4, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, VERTEX_FLOATS * 4, 8);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshIndices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, MAX_INDICES * 2, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
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
      // What the people's mesh was last built from, and the indices last
      // uploaded: a still frame (Motion 0, nothing fading) reuses both.
      const keyHead = 6;
      const builtKey = new Float64Array(keyHead + 4 * scene.figures.length + ROLE_COUNT * 3);
      const key = new Float64Array(builtKey.length);
      builtKey[0] = Number.NaN;
      const uploadedIndices = new Uint16Array(MAX_INDICES);
      let uploadedIndexCount = -1;
      /** Fills `key` with everything the people's mesh depends on; true when it changed. */
      const peopleChanged = (palette: Float32Array): boolean => {
        key[0] = scene.seed;
        key[1] = scene.swap;
        key[2] = scene.motion;
        key[3] = scene.motion > 0 ? scene.clock : 0;
        key[4] = layout.width * 100003 + layout.height;
        key[5] = scale;
        let k = keyHead;
        for (const f of scene.figures) {
          key[k++] = f.from;
          key[k++] = f.to;
          key[k++] = f.t;
          key[k++] = f.alpha;
        }
        for (let i = 0; i < ROLE_COUNT * 3; i++) {
          key[k++] = palette[i];
        }
        for (let i = 0; i < key.length; i++) {
          if (key[i] !== builtKey[i]) {
            builtKey.set(key);
            return true;
          }
        }
        return false;
      };

      const sameIndices = (): boolean => {
        if (mesh.indexCount !== uploadedIndexCount) {
          return false;
        }
        for (let i = 0; i < mesh.indexCount; i++) {
          if (mesh.indices[i] !== uploadedIndices[i]) {
            return false;
          }
        }
        return true;
      };

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

          const rebuild = peopleChanged(palette);
          const count = emitScene(list, mesh, scene, layout, palette, 1 / scale, rebuild);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          if (count > 0) {
            batch.upload(count);
            gl.useProgram(program);
            u.f2("uResolution", width, height);
            u.f1("uScale", scale);
            batch.draw(0, list.split);
          }
          if (mesh.indexCount > 0) {
            gl.bindVertexArray(meshVao);
            if (rebuild) {
              gl.bindBuffer(gl.ARRAY_BUFFER, meshVertices);
              gl.bufferSubData(
                gl.ARRAY_BUFFER,
                0,
                mesh.vertices,
                0,
                mesh.vertexCount * VERTEX_FLOATS,
              );
              gl.bindBuffer(gl.ARRAY_BUFFER, null);
              // The triangles only change when a part comes or goes.
              if (!sameIndices()) {
                gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, mesh.indices, 0, mesh.indexCount);
                uploadedIndices.set(mesh.indices.subarray(0, mesh.indexCount));
                uploadedIndexCount = mesh.indexCount;
              }
            }
            gl.useProgram(meshProgram);
            mu.f2("uResolution", width, height);
            mu.f1("uScale", scale);
            gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
            gl.bindVertexArray(null);
          }
          if (count > list.split) {
            gl.useProgram(program);
            batch.draw(list.split, count - list.split);
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
