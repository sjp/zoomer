import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  type RenderTarget,
  scopedProgram,
} from "../gl";
import {
  CHIPS_PER_RADIAN,
  createKaleido,
  INSTANCE_ATTRIBUTES,
  INSTANCE_STRIDE,
  isCircleView,
  paletteData,
  SEGMENTS,
  segmentCount,
  SHAPE_BEAD,
  SHAPE_DISC,
  SHAPE_ROD,
  sourceLayout,
  TAU,
  wedgeAngle,
  type KaleidoSim,
  type PaletteData,
  type SourceLayout,
} from "./kaleido-sim";
import { kaleidoMeta, ROTATION_MAX } from "./kaleido.meta";
import { createSpriteBatch, QUAD, SPRITE_SPIN_GLSL } from "../sprites";
import { defineEffect } from "../types";

/** Circle view: eyepiece radius as a fraction of the frame height. */
const CIRCLE_RADIUS = 0.47;
/** Vignette strength and the radius it starts at (view radii), per view. */
const FULL_VIGNETTE = [0.2, 0.35] as const;
const CIRCLE_VIGNETTE = [0.45, 0.55] as const;
/** Circle view: width of the soft edge into the surround, in view radii. */
const CIRCLE_EDGE = 0.02;
/** Glass edge glow: width in view radii and strength. */
const RIM_WIDTH = 0.008;
const RIM = 0.45;
/** AA padding around each chip's quad, in source texels. */
const PAD_TEXELS = 2;
/** The contrast control maps to this range of the mix from the flat mean to the full image. */
const CONTRAST_FLOOR = 0.25;
const MAX_CHIPS = Math.max(...SEGMENTS.map((n) => Math.round(CHIPS_PER_RADIAN * wedgeAngle(n))));

/**
 * Chips into the wedge's source texture. Each instance is a quad in wedge units
 * (rotated and foreshortened by its tumble); the fragment shader cuts the shape
 * from a signed distance with a one-texel anti-aliased edge, shades the glass and
 * adds an edge glow. Blending is screen (ONE, ONE_MINUS_SRC_COLOR), so
 * overlapping chips mix their colours, never clip, and draw in any order.
 */
function chipVertex(spinLocation: number) {
  return /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (units), half extents (units). */
layout(location = 1) in vec4 aBox;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aShape;
layout(location = ${String(spinLocation)}) in vec2 aSpin;
/** Source origin (units), 1 / span. */
uniform vec4 uMap;
uniform float uPad;
out vec2 vLocal;
flat out vec4 vColor;
flat out vec3 vShape;
${SPRITE_SPIN_GLSL}
void main() {
  vec2 local = aCorner * (aBox.zw + uPad);
  vLocal = local;
  vColor = aColor;
  vShape = vec3(aShape, aBox.zw);
  vec2 uv = (aBox.xy + spinCorner(local, aSpin) - uMap.xy) * uMap.zw;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;
}

const CHIP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vColor;
flat in vec3 vShape;
uniform float uRimWidth;
out vec4 outColor;
const vec2 LIGHT = vec2(-0.6, 0.8);
const vec3 LIGHT3 = vec3(-0.4, 0.5, 0.768);
void main() {
  float shape = vShape.x;
  vec2 h = vShape.yz;
  vec2 p = vLocal;
  float len = length(p);
  vec2 dir = len > 0.0 ? p / len : vec2(0.0);
  float d;
  float body;
  float spec = 0.0;
  vec2 edgeNormal = dir;
  if (shape < ${glslFloat(SHAPE_DISC + 0.5)}) {
    d = len - h.y;
    body = 0.9 + 0.2 * dot(p / h.y, LIGHT);
  } else if (shape < ${glslFloat(SHAPE_BEAD + 0.5)}) {
    d = len - h.y;
    float k = min(len / h.y, 1.0);
    float z = sqrt(1.0 - k * k);
    body = 0.35 + 0.65 * z;
    spec = 0.7 * pow(max(dot(vec3(p / h.y, z), LIGHT3), 0.0), 24.0);
  } else if (shape < ${glslFloat(SHAPE_ROD + 0.5)}) {
    vec2 q = vec2(max(abs(p.x) - (h.x - h.y), 0.0), p.y);
    d = length(q) - h.y;
    float u = clamp(p.y / h.y, -1.0, 1.0);
    body = 0.45 + 0.55 * sqrt(1.0 - u * u);
    float s = (u - 0.45) * 5.0;
    spec = 0.5 * exp(-s * s);
    edgeNormal = vec2(0.0, sign(p.y));
  } else {
    // Regular polygon with circumradius h.x: distance to the nearest edge's line.
    float sector = ${glslFloat(TAU)} / shape;
    float a = len > 0.0 ? atan(p.y, p.x) : 0.0;
    float edge = floor(a / sector + 0.5) * sector;
    d = cos(edge - a) * len - h.x * cos(${glslFloat(Math.PI)} / shape);
    body = 0.85 + 0.25 * dot(p / h.x, LIGHT);
    edgeNormal = vec2(cos(edge), sin(edge));
  }
  float cov = clamp(0.5 - d / max(fwidth(d), 1e-6), 0.0, 1.0);
  // Edges catch the light: a glow just inside the edge, brightest on edges facing the light.
  float rim = ${glslFloat(RIM)} * exp(min(d, 0.0) / uRimWidth)
    * (0.55 + 0.45 * dot(edgeNormal, LIGHT));
  vec3 light = vColor.rgb * vColor.a * body + vec3(rim * vColor.a + spec);
  outColor = vec4(min(light, vec3(1.0)) * cov, 1.0);
}
`;

/**
 * Full-resolution composite. Per pixel: centre and turn the view, fold the angle
 * into the wedge (mod a mirror pair, reflect the far half), one bilinear fetch
 * from the source, then screen it over the backlight, apply contrast, vignette
 * and (circle view) the eyepiece edge. The fold is continuous, and the source
 * holds the chips' real content past the mirrors, so the filter crosses each
 * mirror line without a seam.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSource;
/** View centre (device px) and 1 / view radius (device px). */
uniform vec3 uCentre;
/** cos and sin of the view's turn. */
uniform vec2 uRot;
uniform float uWedge;
uniform vec4 uMap;
uniform vec3 uBg;
uniform vec3 uMean;
uniform vec3 uSurround;
uniform float uContrast;
/** Vignette strength, vignette start radius, eyepiece edge width (0: full frame). */
uniform vec3 uView;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = (gl_FragCoord.xy - uCentre.xy) * uCentre.z;
  p = vec2(uRot.x * p.x - uRot.y * p.y, uRot.y * p.x + uRot.x * p.y);
  float r = length(p);
  float a = r > 0.0 ? atan(p.y, p.x) : 0.0;
  a = mod(a, 2.0 * uWedge);
  a = uWedge - abs(a - uWedge);
  vec2 q = r * vec2(cos(a), sin(a));
  vec3 light = texture(uSource, (q - uMap.xy) * uMap.zw).rgb;
  vec3 col = 1.0 - (1.0 - uBg) * (1.0 - light);
  col = mix(uMean, col, uContrast);
  col *= 1.0 - uView.x * smoothstep(uView.y, 1.0, r);
  if (uView.z > 0.0) col = mix(col, uSurround, smoothstep(1.0 - uView.z, 1.0, r));
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A kaleidoscope: glass chips, beads and rods drift and tumble in one wedge,
 * drawn into a small source texture only when they move, and a full-resolution
 * pass mirrors that wedge into a slowly turning mandala.
 */
export const kaleido = defineEffect(kaleidoMeta, {
  create(gl) {
    return withScope((scope) => {
      const batch = scope.own(
        createSpriteBatch(gl, MAX_CHIPS, INSTANCE_ATTRIBUTES, [QUAD], { rotation: true }),
      );
      if (batch.stride !== INSTANCE_STRIDE) {
        throw new Error("kaleido: instance layout mismatch");
      }
      const chipProgram = scopedProgram(gl, scope, chipVertex(batch.spinLocation), CHIP_FRAGMENT);
      const cu = createUniforms(gl, chipProgram, ["uMap", "uPad", "uRimWidth"]);
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
      const u = createUniforms(gl, program, [
        "uSource",
        "uCentre",
        "uRot",
        "uWedge",
        "uMap",
        "uBg",
        "uMean",
        "uSurround",
        "uContrast",
        "uView",
      ]);
      gl.useProgram(program);
      u.i1("uSource", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));
      // A number, or null once the context is lost (which Math.max treated as 0).
      const maxTextureSize: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const maxSize = Math.max(1, typeof maxTextureSize === "number" ? maxTextureSize : 0);

      let target: RenderTarget | null = null;
      scope.defer(() => {
        target?.dispose();
        target = null;
      });

      let width = 1;
      let height = 1;
      let sim: KaleidoSim | undefined;
      let layout: SourceLayout | undefined;
      let layoutSegments = 0;
      let layoutRadius = 0;
      /** Whether the source texture is out of date: chips moved, palette or target changed. */
      let dirty = true;
      let lastPalette: PaletteData | undefined;
      /** View turn, radians, wrapped to one turn (only its sine and cosine are used). */
      let turn = 0;

      function viewRadius(circle: boolean) {
        return circle ? CIRCLE_RADIUS * height : Math.hypot(width, height) / 2;
      }

      /** Rebuilds the chips on a segment or seed change and the source target on a size change. */
      function ensure(segments: number, seed: number, radiusPx: number) {
        const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
        if (!sim || sim.segments !== segments || sim.seed !== s) {
          sim = createKaleido(segments, s);
          dirty = true;
        }
        if (target && segments === layoutSegments && radiusPx === layoutRadius) {
          return;
        }
        layoutSegments = segments;
        layoutRadius = radiusPx;
        const l = sourceLayout(wedgeAngle(segments), radiusPx, maxSize);
        layout = l;
        if (!target || target.width !== l.width || target.height !== l.height) {
          target?.dispose();
          target = null;
          target = createRenderTarget(gl, l.width, l.height, gl.RGBA8);
          if (!target) {
            throw new Error("kaleido: RGBA8 render target unavailable");
          }
        }
        dirty = true;
      }

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const segments = segmentCount(p.segments);
          const circle = isCircleView(p.view);
          const radiusPx = viewRadius(circle);
          ensure(segments, p.seed, radiusPx);
          const s = sim;
          const l = layout;
          const t = target;
          if (!s || !l || !t) {
            throw new Error("kaleido: ensure left no sim, layout or target");
          }
          const pal = paletteData(p.palette);
          if (pal !== lastPalette) {
            lastPalette = pal;
            dirty = true;
          }
          const speed = Math.min(Math.max(p.speed, 0), 3);
          const simDt = dt * speed;
          if (simDt > 0) {
            s.step(simDt);
            dirty = true;
          }
          const rotation = Math.min(Math.max(p.rotation, -ROTATION_MAX), ROTATION_MAX);
          if (Number.isFinite(rotation) && dt > 0) {
            turn = (turn + (rotation * Math.PI * dt) / 180) % TAU;
          }

          if (dirty) {
            dirty = false;
            const n = s.write(batch.data, pal);
            batch.upload(n);
            t.bind();
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
            gl.useProgram(chipProgram);
            cu.f4("uMap", l.originX, l.originY, 1 / l.spanX, 1 / l.spanY);
            cu.f1("uPad", (PAD_TEXELS * l.spanX) / l.width);
            cu.f1("uRimWidth", RIM_WIDTH);
            batch.draw(0, n);
            gl.disable(gl.BLEND);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          gl.useProgram(program);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, t.texture);
          u.f3("uCentre", width / 2, height / 2, 1 / radiusPx);
          // Turning the view by +turn samples the pattern at -turn.
          u.f2("uRot", Math.cos(turn), -Math.sin(turn));
          u.f1("uWedge", wedgeAngle(segments));
          u.f4("uMap", l.originX, l.originY, 1 / l.spanX, 1 / l.spanY);
          u.v3("uBg", pal.bg);
          u.v3("uMean", pal.mean);
          u.v3("uSurround", pal.surround);
          const contrast = Math.min(Math.max(p.contrast, 0), 1);
          u.f1("uContrast", CONTRAST_FLOOR + (1 - CONTRAST_FLOOR) * contrast);
          const vig = circle ? CIRCLE_VIGNETTE : FULL_VIGNETTE;
          u.f3("uView", vig[0], vig[1], circle ? CIRCLE_EDGE : 0);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
