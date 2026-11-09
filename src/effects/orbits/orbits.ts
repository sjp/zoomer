import {
  DITHER_GLSL,
  beginFrame,
  createUniforms,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import { approach, clamp } from "../math";
import {
  BODY_FLOATS,
  centreFraction,
  createSystem,
  fillBodies,
  fillGlows,
  fillOrbitElements,
  fillOrbitMotion,
  GLOW_FLOATS,
  KEPLER_ITERATIONS,
  MAX_BODIES,
  type OrbitSystem,
  type OrbitView,
  resolveKind,
  RING_INNER,
  systemPositions,
} from "./orbits-sim";
import { orbitsMeta } from "./orbits.meta";
import { createSpriteBatch, polygonStrip, QUAD } from "../sprites";
import { createStarDraw, createStarSprites } from "../starfield";
import { seedSalt } from "../starfield-sim";
import { defineEffect } from "../types";
import { createChangeKey } from "../change-key";

/** Points along a trail strip and around an orbit line. */
const TRAIL_SAMPLES = 96;
const ORBIT_SAMPLES = 128;
/** Trail brightness at its head, and the orbit lines' brightness. */
const TRAIL_GAIN = 0.55;
const ORBIT_GAIN = 0.1;
/** Background colour (linear-ish 0..1). */
const BACKGROUND = [0.008, 0.011, 0.03] as const;
/** Background stars: share of cells occupied (sparse) and light. */
const STAR_DENSITY = 0.15;
const STAR_GAIN = 0.55;
/** Bounds the star list: a 32:9 frame at `STAR_DENSITY` lists about 4900. */
const MAX_STARS = 6000;
const STAR_MARGIN = 4;
const REF_HEIGHT = 1080;
/** How fast the tilt (radians per second) and the centre (frame widths per second) ease. */
const TILT_RATE = 0.5;
const CENTRE_RATE = 0.15;

const TRAIL_VERTEX = /* glsl */ `#version 300 es
/** a (reference px), e, argument of periapsis, parent index (-1: centre of mass). */
uniform vec4 uElem[${String(MAX_BODIES)}];
/** Wrapped mean anomaly now, mean motion (rad/s), unused, unused. */
uniform vec4 uMotion[${String(MAX_BODIES)}];
/** rgb, half-width (reference px). */
uniform vec4 uColor[${String(MAX_BODIES)}];
uniform vec2 uResolution;
/** Centre of mass (device px, y down), device px per reference px, cos(tilt). */
uniform vec4 uFrame;
/** Last sample index, mode (0 trail, 1 orbit line), trail length (orbits), gain. */
uniform vec4 uStrip;
uniform int uFirst;

out float vAcross;
out float vHalf;
out vec3 vColor;

${TO_CLIP_GLSL}

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;

// Twin of solveKepler in orbits-sim.ts.
float kepler(float m, float e) {
  m -= TAU * floor((m + PI) / TAU);
  float ea = m + 0.85 * e * sign(m);
  for (int i = 0; i < ${String(KEPLER_ITERATIONS)}; i++) {
    ea -= (ea - e * sin(ea) - m) / (1.0 - e * cos(ea));
  }
  return ea;
}

// Position relative to the focus (xy) and its derivative by the eccentric anomaly (zw).
vec4 orbitPoint(vec4 el, float ea) {
  float e = el.y;
  float b = sqrt(1.0 - e * e);
  float c = cos(ea);
  float s = sin(ea);
  vec2 p = el.x * vec2(c - e, b * s);
  vec2 d = el.x * vec2(-s, b * c);
  float co = cos(el.z);
  float so = sin(el.z);
  mat2 r = mat2(co, so, -so, co);
  return vec4(r * p, r * d);
}

// Position (xy) and velocity (zw) of body i, tau seconds ago, relative to its parent.
vec4 bodyAt(int i, float tau) {
  vec4 el = uElem[i];
  vec4 mo = uMotion[i];
  float ea = kepler(mo.x - mo.y * tau, el.y);
  vec4 o = orbitPoint(el, ea);
  return vec4(o.xy, o.zw * (mo.y / (1.0 - el.y * cos(ea))));
}

void main() {
  int i = gl_InstanceID + uFirst;
  int k = gl_VertexID >> 1;
  float side = (gl_VertexID & 1) == 1 ? 1.0 : -1.0;
  float s = float(k) / uStrip.x;
  vec4 el = uElem[i];
  int parent = int(el.w);
  vec2 p;
  vec2 v;
  float fade;
  float width;
  if (uStrip.y < 0.5) {
    // Trail: the body's own path, tau seconds back, its parent's motion included.
    float tau = s * uStrip.z * TAU / uMotion[i].y;
    vec4 o = bodyAt(i, tau);
    if (parent >= 0) o += bodyAt(parent, tau);
    p = o.xy;
    v = o.zw;
    fade = (1.0 - s) * (1.0 - s);
    width = mix(1.0, 0.4, s);
  } else {
    // Orbit line: the whole ellipse about the parent's current position.
    vec4 o = orbitPoint(el, s * TAU);
    p = o.xy;
    v = o.zw;
    if (parent >= 0) p += bodyAt(parent, 0.0).xy;
    fade = 1.0;
    width = 0.5;
  }
  vec2 px = uFrame.xy + vec2(p.x, -p.y * uFrame.w) * uFrame.z;
  vec2 t = vec2(v.x, -v.y * uFrame.w);
  float tl = length(t);
  t = tl > 1e-6 ? t / tl : vec2(1.0, 0.0);
  float hw = uColor[i].w * uFrame.z * width;
  // Lines thinner than a pixel draw a pixel wide at proportionally lower intensity.
  float drawn = max(hw, 0.5);
  float ext = drawn + 1.0;
  vAcross = side * ext;
  vHalf = drawn;
  vColor = uColor[i].rgb * (fade * uStrip.w * hw / drawn);
  gl_Position = pxToClip(px + vec2(-t.y, t.x) * (side * ext), uResolution);
}
`;

const TRAIL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in float vAcross;
in float vHalf;
in vec3 vColor;
out vec4 outColor;
void main() {
  float c = clamp(vHalf + 0.5 - abs(vAcross), 0.0, 1.0);
  outColor = vec4(vColor * c, c);
}
`;

const BODY_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (device px, y down), radius, quad half-size. */
layout(location = 1) in vec4 aBody;
/** rgb, cloud-band phase (-1: none). */
layout(location = 2) in vec4 aColor;
/** Light direction (x right, y up, z toward the viewer), ring outer radius / radius. */
layout(location = 3) in vec4 aLight;
uniform vec2 uResolution;
out vec2 vPx;
flat out float vRadius;
flat out vec4 vColor;
flat out vec4 vLight;
${TO_CLIP_GLSL}
void main() {
  vPx = aCorner * aBody.w;
  vRadius = aBody.z;
  vColor = aColor;
  vLight = aLight;
  gl_Position = pxToClip(aBody.xy + vec2(aCorner.x, -aCorner.y) * aBody.w, uResolution);
}
`;

const BODY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPx;
flat in float vRadius;
flat in vec4 vColor;
flat in vec4 vLight;
uniform float uCosTilt;
out vec4 outColor;
void main() {
  vec2 p = vPx;
  float r = vRadius;

  // The ring lies in the orbit plane: an annulus squashed by the tilt. Its far
  // half (above the centre) is behind the disc, its near half in front.
  vec4 ring = vec4(0.0);
  float outer = vLight.w;
  if (outer > 0.0) {
    float rr = length(vec2(p.x, p.y / uCosTilt)) / r;
    float aa = 1.0 / r;
    float cov = smoothstep(${glslFloat(RING_INNER)}, ${glslFloat(RING_INNER)} + aa, rr) * (1.0 - smoothstep(outer - aa, outer, rr));
    float a = cov * (0.45 + 0.15 * sin(rr * 23.0));
    ring = vec4(mix(vColor.rgb, vec3(1.0), 0.35) * (0.7 * a), a);
  }
  bool front = p.y < 0.0;
  vec4 col = front ? vec4(0.0) : ring;

  float cov = clamp(r + 0.5 - length(p), 0.0, 1.0);
  if (cov > 0.0) {
    vec2 u = p / r;
    float z = sqrt(max(0.0, 1.0 - dot(u, u)));
    float lit = dot(vec3(u, z), vLight.xyz);
    // A soft terminator, then Lambert, then a little limb darkening.
    float shade = smoothstep(-0.12, 0.25, lit) * (0.55 + 0.45 * max(lit, 0.0)) * (0.8 + 0.2 * z);
    vec3 base = vColor.rgb;
    if (vColor.a >= 0.0) base *= 0.9 + 0.12 * sin(u.y * 11.0 + vColor.a + 1.7 * sin(u.y * 4.0 + vColor.a));
    col = vec4(base * (0.035 + shade), 1.0) * cov + col * (1.0 - cov);
  }
  if (front) col = ring + col * (1.0 - ring.a);
  outColor = col;
}
`;

const GLOW_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (device px, y down), core radius, glow radius. */
layout(location = 1) in vec4 aGlow;
/** rgb, gain. */
layout(location = 2) in vec4 aTint;
uniform vec2 uResolution;
out vec2 vPx;
flat out vec4 vGlow;
flat out vec4 vTint;
${TO_CLIP_GLSL}
void main() {
  vPx = aCorner * aGlow.w;
  vGlow = aGlow;
  vTint = aTint;
  gl_Position = pxToClip(aGlow.xy + aCorner * aGlow.w, uResolution);
}
`;

const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPx;
flat in vec4 vGlow;
flat in vec4 vTint;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  float d = length(vPx);
  float rc = vGlow.z;
  float x = d / rc;
  float core = clamp(rc + 0.5 - d, 0.0, 1.0);
  // A soft corona, eased to zero at the octagon's inscribed circle.
  float fall = 1.0 - min(d * d / (vGlow.w * vGlow.w), 1.0);
  float halo = 0.55 / (1.0 + 1.5 * x * x) * fall * fall;
  vec3 c = (vTint.rgb * (halo + 0.6 * core) + vec3(0.7 * core)) * vTint.a;
  outColor = vec4(c + dither8(gl_FragCoord.xy), 0.0);
}
`;

/**
 * Orbiting bodies: a small planetary (or circumbinary) system seen from above,
 * every body on a fixed Kepler orbit. The CPU places the bodies and stars each
 * frame; the trails and orbit lines are attribute-free instanced strips whose
 * vertex shader evaluates the same orbits back in time, so no history is kept.
 * Draw order: sparse background stars, orbit lines and trails (additive), star
 * glows (additive), then the lit discs, farthest first.
 */
export const orbits = defineEffect(orbitsMeta, {
  create(gl) {
    return withScope((scope) => {
      const trailProgram = scopedProgram(gl, scope, TRAIL_VERTEX, TRAIL_FRAGMENT);
      const tu = createUniforms(gl, trailProgram, [
        "uElem",
        "uMotion",
        "uColor",
        "uResolution",
        "uFrame",
        "uStrip",
        "uFirst",
      ]);
      const bodyProgram = scopedProgram(gl, scope, BODY_VERTEX, BODY_FRAGMENT);
      const bu = createUniforms(gl, bodyProgram, ["uResolution", "uCosTilt"]);
      const glowProgram = scopedProgram(gl, scope, GLOW_VERTEX, GLOW_FRAGMENT);
      const gu = createUniforms(gl, glowProgram, ["uResolution"]);

      const stripVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const bodies = scope.own(createSpriteBatch(gl, MAX_BODIES, [4, 4, 4], [QUAD]));
      const glows = scope.own(createSpriteBatch(gl, 2, [4, 4], [polygonStrip(8)]));
      if (bodies.stride !== BODY_FLOATS || glows.stride !== GLOW_FLOATS) {
        throw new Error("Orbits: instance layout mismatch");
      }
      const stars = scope.own(createStarSprites(gl, MAX_STARS));
      const starDraw = createStarDraw();

      const elem = new Float32Array(MAX_BODIES * 4);
      const color = new Float32Array(MAX_BODIES * 4);
      const motion = new Float32Array(MAX_BODIES * 4);
      const pos = new Float64Array((MAX_BODIES + 2) * 2);
      const depth = new Float64Array(MAX_BODIES + 2);
      const order = new Int32Array(MAX_BODIES + 2);
      const view: OrbitView = { cx: 0, cy: 0, scale: 1, tilt: 0 };
      const pole: [number, number] = [0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      const starsKey = createChangeKey(2);
      const sysKey = createChangeKey(3);
      let sys: OrbitSystem | null = null;
      let gpuCount = 0;
      let elementsDirty = true;
      /** Orbit time (s at speed 1) and wall-clock time for the twinkle, both float64. */
      let time = 0;
      let clock = 0;
      let tilt = -1;
      let centre = -1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const seed = Math.floor(p.seed);
          const kind = resolveKind(p.system, seed);
          sysKey.setText(0, kind);
          sysKey.set(1, Math.round(p.planets));
          sysKey.set(2, seed);
          if (sysKey.take() || !sys) {
            sys = createSystem(kind, p.planets, seed);
            elementsDirty = true;
          }
          const refWidth = width / scale;
          starsKey.set(0, seed);
          starsKey.set(1, refWidth);
          if (starsKey.take()) {
            pole[0] = refWidth / 2;
            pole[1] = REF_HEIGHT / 2;
            // Allocates only for a new seed or frame width.
            stars.build({
              salt: seedSalt(seed),
              density: STAR_DENSITY,
              pole,
              refWidth,
              refHeight: REF_HEIGHT,
              rotates: false,
              margin: STAR_MARGIN,
            });
          }

          time += Math.max(0, dt) * p.speed;
          clock += Math.max(0, dt);
          const tiltTarget = (clamp(p.tilt, 0, 60) * Math.PI) / 180;
          const centreTarget = centreFraction(p.centre);
          tilt = tilt < 0 ? tiltTarget : approach(tilt, tiltTarget, dt * TILT_RATE);
          centre = centre < 0 ? centreTarget : approach(centre, centreTarget, dt * CENTRE_RATE);
          view.cx = centre * width;
          view.cy = height / 2;
          view.scale = scale;
          view.tilt = tilt;
          const cosT = Math.cos(tilt);

          gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);

          // 1. Background stars (additive; disables blending after).
          starDraw.width = width;
          starDraw.height = height;
          starDraw.scale = scale;
          starDraw.pole = pole;
          starDraw.rotation = 0;
          starDraw.time = clock;
          starDraw.colorful = 0.5;
          starDraw.gain = STAR_GAIN;
          starDraw.twinkle = 0.6;
          stars.draw(starDraw);

          // 2. Orbit lines and trails, additive strips.
          const planets = sys.planets;
          gl.useProgram(trailProgram);
          if (elementsDirty) {
            elementsDirty = false;
            gpuCount = fillOrbitElements(sys, elem, color);
            gl.uniform4fv(tu.loc.uElem, elem);
            gl.uniform4fv(tu.loc.uColor, color);
          }
          fillOrbitMotion(sys, time, motion);
          gl.uniform4fv(tu.loc.uMotion, motion);
          tu.f2("uResolution", width, height);
          tu.f4("uFrame", view.cx, view.cy, scale, cosT);
          gl.bindVertexArray(stripVao);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          if (p.orbits) {
            tu.f4("uStrip", ORBIT_SAMPLES - 1, 1, 0, ORBIT_GAIN);
            tu.i1("uFirst", 0);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, ORBIT_SAMPLES * 2, gpuCount);
          }
          const trail = clamp(p.trails, 0, 1);
          if (trail > 0) {
            tu.f4("uStrip", TRAIL_SAMPLES - 1, 0, trail, TRAIL_GAIN);
            tu.i1("uFirst", 0);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, TRAIL_SAMPLES * 2, planets);
            // Moons' trails are dimmer.
            if (gpuCount > planets) {
              tu.f4("uStrip", TRAIL_SAMPLES - 1, 0, trail, TRAIL_GAIN * 0.6);
              tu.i1("uFirst", planets);
              gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, TRAIL_SAMPLES * 2, gpuCount - planets);
            }
          }
          gl.bindVertexArray(null);

          // 3. Star glows, additive.
          systemPositions(sys, time, pos);
          const glowCount = fillGlows(sys, pos, view, glows.data);
          glows.upload(glowCount);
          gl.useProgram(glowProgram);
          gu.f2("uResolution", width, height);
          glows.draw(0, glowCount);

          // 4. Lit discs, farthest first, premultiplied alpha.
          const bodyCount = fillBodies(sys, pos, view, bodies.data, depth, order);
          bodies.upload(bodyCount);
          gl.useProgram(bodyProgram);
          bu.f2("uResolution", width, height);
          bu.f1("uCosTilt", cosT);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          bodies.draw(0, bodyCount);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
