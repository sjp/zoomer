import type { Rgb } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import {
  ADDENDUM,
  advanceDrive,
  balanceAngle,
  createDrive,
  DEDENDUM,
  driveAngle,
  type Gear,
  growTrain,
  LAYERS,
  LAYOUT_SPECS,
  METAL_BRASS,
  METAL_COPPER,
  METAL_STEEL,
  TOOTH_ROOT_HALF,
  TOOTH_TIP_HALF,
} from "./gears-sim";
import { type GearBackdropId, type GearLayoutId, gearsMeta, MAX_GEARS } from "./gears.meta";
import { createLowResTarget } from "./lowres";
import { wrap } from "./math";
import { HASH32_GLSL } from "./noise";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { defineEffect } from "./types";
import { lookup } from "./lookup";

const TAU = Math.PI * 2;
const g = glslFloat;

/** Backdrop pass: about 2 reference px per texel. It is static, so this only sets its detail. */
const BACKDROP_TEXEL_REF = 2;
/** Warm, low light from the upper left. */
const LIGHT: Rgb = [1, 0.8, 0.58];
const LIGHT_DIR = [-0.55, 0.835] as const;
const AMBIENT = 0.13;
/** Shadow offset and blur per layer of height above the plate (frame heights), and opacity. */
const SHADOW_OFFSET = 0.006;
const SHADOW_BLUR = 0.005;
const SHADOW_ALPHA = 0.55;

/** Metal colours: brass, steel, copper. */
const METALS: readonly Rgb[] = [
  [0.8, 0.6, 0.3],
  [0.58, 0.6, 0.62],
  [0.78, 0.44, 0.3],
];

interface Backdrop {
  kind: number;
  base: Rgb;
  alt: Rgb;
}

const BACKDROPS: Readonly<Record<GearBackdropId, Backdrop>> = {
  plate: { kind: 0, base: [0.15, 0.13, 0.11], alt: [0.11, 0.095, 0.08] },
  wood: { kind: 1, base: [0.3, 0.17, 0.09], alt: [0.17, 0.09, 0.045] },
  paper: { kind: 2, base: [0.6, 0.53, 0.42], alt: [0.5, 0.43, 0.33] },
};

/** Whether a `layout` select value is a known layout, e.g. not from an old or hand-edited URL. */
const isLayoutId = (v: string): v is GearLayoutId => Object.hasOwn(LAYOUT_SPECS, v);

/** The light pool's centre (frame heights) and falloff, per layout. */
function poolFor(layout: GearLayoutId, aspect: number, out: Float64Array): Float64Array {
  if (layout === "corner") {
    out.set([aspect - 0.25, 0.78, 4]);
  } else if (layout === "side") {
    out.set([aspect - 0.18, 0.62, 2.2]);
  } else {
    out.set([aspect * 0.5, 0.8, 0.7]);
  }
  return out;
}

const POOL_GLSL = /* glsl */ `
/** Light pool: centre (frame heights) and falloff. */
uniform vec3 uPool;
float pool(vec2 q) {
  vec2 d = q - uPool.xy;
  return 1.0 / (1.0 + uPool.z * dot(d, d));
}
`;

/**
 * The plate behind the gears at low resolution: brushed dark metal, dark wood or
 * warm paper, lit by a warm pool of light over the gears and vignetted. Static,
 * so it only re-renders when the backdrop, layout or size changes.
 */
const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> frame heights. */
uniform vec2 uPxToH;
/** Frame size in frame heights (aspect, 1). */
uniform vec2 uFrame;
/** 0: plate, 1: wood, 2: paper. */
uniform int uKind;
uniform vec3 uBase;
uniform vec3 uAlt;
uniform vec3 uLight;
out vec4 outColor;
${HASH32_GLSL}
${POOL_GLSL}
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 4096);
  return float(hash32(q.x * 1973u + hash32(q.y))) * (1.0 / 4294967295.0);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  vec3 col;
  if (uKind == 0) {
    // Brushed plate: fine horizontal streaks over a faint mottle.
    float streak = 0.6 * noise(vec2(p.x * 3.0, p.y * 160.0)) + 0.4 * noise(vec2(p.x * 1.2, p.y * 60.0));
    float mottle = noise(p * 3.0);
    col = mix(uAlt, uBase, 0.35 + 0.4 * streak + 0.25 * mottle);
  } else if (uKind == 1) {
    // Wood: wavy grain running along x, with fine fibres.
    float warp = noise(p * vec2(1.2, 5.0)) * 5.0 + 1.5 * sin(p.x * 1.7);
    float grain = 0.5 + 0.5 * sin((p.y * 26.0 + warp) * 3.14159);
    float fibre = noise(vec2(p.x * 6.0, p.y * 150.0));
    col = mix(uAlt, uBase, 0.25 + 0.5 * grain * grain + 0.25 * fibre);
  } else {
    // Paper: soft blotches and a faint fibre texture.
    float blot = noise(p * 6.0) * 0.6 + noise(p * 17.0) * 0.4;
    float fibre = noise(p * 140.0);
    col = mix(uAlt, uBase, 0.55 + 0.3 * blot + 0.15 * fibre);
  }
  col *= uLight * (0.32 + 0.9 * pool(p));
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.45 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * Per gear: an octagon round its outline (or its shadow, offset away from the
 * light and widened by the blur). Works in frame heights.
 */
const GEAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y, pitch radius, teeth (0 for the balance wheel). */
layout(location = 1) in vec4 aGear;
/** Angle (radians), style, spokes or holes, screws. */
layout(location = 2) in vec4 aShape;
/** Colour, layer. */
layout(location = 3) in vec4 aLook;
uniform vec2 uToClip;
uniform float uModule;
uniform float uPx;
/** Shadow offset per layer (xy), blur per layer, 1 for the shadow pass. */
uniform vec4 uShadow;
out vec2 vLocal;
out vec2 vWorld;
flat out vec4 vGear;
flat out vec4 vShape;
flat out vec4 vLook;
void main() {
  float depth = (aLook.w + 1.0) * uShadow.w;
  float outer = aGear.z + (aGear.w > 0.5 ? ${g(ADDENDUM)} * uModule : 0.0) + uShadow.z * depth + 2.0 * uPx;
  vec2 centre = aGear.xy + uShadow.xy * depth;
  vLocal = aCorner * outer;
  vWorld = centre + vLocal;
  vGear = aGear;
  vShape = aShape;
  vLook = aLook;
  gl_Position = vec4(vWorld * uToClip - 1.0, 0.0, 1.0);
}
`;

/**
 * A gear, premultiplied: the tooth outline as a smoothed trapezoid wave in
 * polar angle, spoke windows or round holes cut from the web, a raised hub with
 * a steel axle and screws, coverage antialiasing from fwidth, and fake bevel
 * normals lighting a circular-brushed metal. The shadow pass draws the same
 * outline (teeth averaged out) as a soft black.
 */
const GEAR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vWorld;
flat in vec4 vGear;
flat in vec4 vShape;
flat in vec4 vLook;
uniform float uModule;
uniform float uPx;
uniform vec4 uShadow;
uniform float uShadowAlpha;
uniform vec3 uLight;
/** Unit direction towards the light, in the screen plane. */
uniform vec2 uLDir;
uniform float uAmbient;
out vec4 outColor;
${POOL_GLSL}
const float TAU = 6.2831853;
float toothEdge(float pr, float n, float a) {
  float w = abs(fract(a * n / TAU + 0.5) - 0.5);
  float t = clamp((${g(TOOTH_ROOT_HALF)} - w) / ${g(TOOTH_ROOT_HALF - TOOTH_TIP_HALF)}, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  return pr + uModule * (${g(ADDENDUM + DEDENDUM)} * t - ${g(DEDENDUM)});
}
/** A brushed-ring term, faded out as its period nears the pixel size. */
float rings(float r, float period) {
  float x = uPx / period;
  return cos(TAU * r / period) * exp(-3.3 * x * x);
}
void main() {
  vec2 p = vLocal;
  float r = length(p);
  float m = uModule;
  float pr = vGear.z;
  float toothed = step(0.5, vGear.w);
  float style = vShape.y;
  float a = atan(p.y, p.x) - vShape.x;

  // Outline: teeth, or the balance wheel's plain rim; blurred shadows lose the teeth.
  float rRoot = pr - toothed * ${g(DEDENDUM)} * m;
  float edge = toothed > 0.5 ? toothEdge(pr, vGear.w, a) : pr;
  edge = mix(edge, rRoot + toothed * ${g((ADDENDUM + DEDENDUM) / 2)} * m, uShadow.w);
  float rimIn = rRoot - max(toothed * 1.8 * m, 0.13 * rRoot);
  float hubR = max(2.6 * m, (vShape.w > 0.5 ? 0.3 : 0.2) * rRoot);

  // Cut-outs: spoke windows between the hub and the rim, or a ring of round holes.
  float k = max(vShape.z, 1.0);
  float sector = TAU / k;
  float da = a - sector * floor(a / sector + 0.5);
  float spokeHalf = style > 2.5 ? 0.045 * pr : max(0.8 * m, 0.06 * rRoot);
  float windows = max(max(hubR - r, r - rimIn), spokeHalf - r * abs(sin(da)));
  float rc = 0.5 * (hubR + rimIn);
  float hr = min(0.39 * (rimIn - hubR), 0.72 * rc * sin(0.5 * sector));
  float holes = length(vec2(r * cos(da) - rc, r * sin(da))) - hr;
  float cut = style < 0.5 ? 1.0 : (style > 1.5 && style < 2.5 ? holes : windows);
  float sdf = max(r - edge, -cut);

  // Derivatives in uniform control flow: coverage and the bevel's outward direction.
  vec2 grad = vec2(dFdx(sdf), dFdy(sdf));
  float fw = max(abs(grad.x) + abs(grad.y), 1e-7);
  if (uShadow.w > 0.5) {
    float blur = uShadow.z * (vLook.w + 1.0);
    float s = uShadowAlpha * (1.0 - smoothstep(-blur, blur, sdf));
    outColor = vec4(0.0, 0.0, 0.0, s);
    return;
  }
  float cov = clamp(0.5 - sdf / fw, 0.0, 1.0);
  float slope = max(length(grad) / uPx, 1.0);
  float inset = -sdf / slope;
  vec2 outward = grad / max(length(grad), 1e-9);
  vec2 radial = p / max(r, 1e-6);
  float bw = 0.9 * m + 1.5 * uPx;
  float bev = 1.0 - smoothstep(0.0, bw, inset);
  vec3 n = vec3(outward * bev * 1.4, 1.0);
  // The raised hub's rounded rim.
  float hubBev = smoothstep(hubR - bw, hubR, r) * step(r, hubR);
  n.xy += radial * hubBev * 1.2;
  n = normalize(n);

  vec3 base = vLook.rgb;
  // Solid and holed gears have a recessed web inside the rim.
  float recessed = style < 0.5 || (style > 1.5 && style < 2.5) ? 1.0 : 0.0;
  float web = recessed * smoothstep(rimIn + uPx, rimIn - uPx, r) * step(hubR, r);
  float wall = recessed * exp(-pow((r - rimIn) / (0.6 * bw), 2.0));
  base *= 1.0 - 0.12 * web;

  vec3 L = normalize(vec3(uLDir * 0.75, 0.66));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, H), 0.0), 36.0);
  float light = (0.45 + 0.75 * pool(vWorld)) * (0.82 + 0.09 * vLook.w);
  // Circular brushing: fine rings, and a sheen along the radius towards the light.
  float brush = 0.4 * rings(r, 0.0021) + 0.3 * rings(r, 0.0037) + 0.3 * rings(r, 0.0093) * sin(r * 311.0);
  vec2 tang = vec2(-radial.y, radial.x);
  float tl = dot(tang, uLDir);
  float sheen = pow(max(1.0 - tl * tl, 0.0), 10.0) * (0.75 + 0.25 * brush);
  vec3 specCol = mix(base, vec3(1.0), 0.35) * uLight * light;
  vec3 col = base * (1.0 + 0.06 * brush) * (uAmbient + 0.85 * diff * light * uLight)
    + specCol * (0.6 * spec + 0.16 * sheen * (1.0 - bev));
  // The web's wall: lit on the side away from the light, shaded on the near side.
  col *= 1.0 + 0.5 * wall * dot(radial, -uLDir);
  col *= 1.0 - 0.35 * exp(-pow((r - hubR) / (0.5 * bw), 2.0));

  // Screws on the hub, turning with the gear: domed heads with a slot.
  if (vShape.w > 0.5) {
    float ss = TAU / vShape.w;
    float ds = a - ss * floor(a / ss + 0.5);
    vec2 sp = vec2(r * cos(ds) - 0.64 * hubR, r * sin(ds));
    float sr = 0.17 * hubR;
    float head = clamp((sr - length(sp)) / uPx + 0.5, 0.0, 1.0);
    vec2 sl = mat2(0.8, 0.6, -0.6, 0.8) * sp;
    float slot = clamp((0.16 * sr - abs(sl.y)) / uPx + 0.5, 0.0, 1.0) * step(length(sp), 0.8 * sr);
    // The dome's normal in screen space: turn the offset back by the screw's angle.
    float sa = a + vShape.x - ds;
    vec2 sw = mat2(cos(sa), sin(sa), -sin(sa), cos(sa)) * sp;
    vec3 sn = normalize(vec3(sw / sr * 0.9, 1.0));
    vec3 sc = vec3(0.5, 0.52, 0.54) * (uAmbient + 0.9 * max(dot(sn, L), 0.0) * light * uLight)
      + uLight * light * 0.6 * pow(max(dot(sn, H), 0.0), 30.0);
    col = mix(col, mix(sc, sc * 0.2, slot), head);
  }

  // The axle: a domed steel pin.
  float boreR = max(0.9 * m, 0.33 * hubR);
  float pin = clamp((boreR - r) / uPx + 0.5, 0.0, 1.0);
  vec3 pn = normalize(vec3(p / boreR * 0.85, 1.0));
  vec3 pc = vec3(0.32, 0.33, 0.35) * (uAmbient + 0.9 * max(dot(pn, L), 0.0) * light * uLight)
    + uLight * light * 0.7 * pow(max(dot(pn, H), 0.0), 40.0);
  col = mix(col * (1.0 - 0.4 * exp(-pow((r - boreR) / (0.6 * bw), 2.0))), pc, pin);

  col *= cov;
  float alpha = cov;
  // The balance wheel's hairspring: a blued-steel spiral over the open centre,
  // turning with the wheel, so its coils seem to breathe in and out.
  if (style > 2.5) {
    float r0 = boreR * 1.9;
    float r1 = rimIn * 0.84;
    float pitch = (r1 - r0) / 6.0;
    float t = (r - r0) / pitch - a / TAU;
    float dd = abs(fract(t + 0.5) - 0.5) * pitch;
    float lw = max(0.16 * pitch, 0.7 * uPx);
    float coil = clamp((lw - dd) / uPx + 0.5, 0.0, 1.0)
      * clamp((r - r0) / uPx + 0.5, 0.0, 1.0) * clamp((r1 - r) / uPx + 0.5, 0.0, 1.0);
    vec3 sc = vec3(0.1, 0.13, 0.22) * (uAmbient + 0.6 * light) + uLight * light * 0.25 * pow(max(1.0 - tl * tl, 0.0), 16.0);
    col = sc * coil + col * (1.0 - coil);
    alpha = coil + alpha * (1.0 - coil);
  }
  outColor = vec4(col, alpha);
}
`;

/** Floats per instance: aGear, aShape, aLook. */
const ATTRIBUTES = [4, 4, 4] as const;

/**
 * A train of brass, steel and copper gears meshing at the right ratios in one
 * corner, along one side or round the frame, with a balance wheel swinging and
 * the drive stepping forwards tick by tick.
 *
 * Passes: the backdrop at low resolution, re-rendered only when it changes and
 * upscaled with dither every frame; then, for each depth layer from the back,
 * its gears' soft shadows and the gears themselves, as instanced octagons.
 */
export const gears = defineEffect(gearsMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });
      const bu = createUniforms(gl, program(FULLSCREEN_VERTEX, BACKDROP_FRAGMENT), [
        "uPxToH",
        "uFrame",
        "uKind",
        "uBase",
        "uAlt",
        "uLight",
        "uPool",
      ]);
      const gu = createUniforms(gl, program(GEAR_VERTEX, GEAR_FRAGMENT), [
        "uToClip",
        "uModule",
        "uPx",
        "uShadow",
        "uShadowAlpha",
        "uLight",
        "uLDir",
        "uAmbient",
        "uPool",
      ]);
      const batch = scope.own(createSpriteBatch(gl, MAX_GEARS, ATTRIBUTES, [polygonStrip(8)]));

      const drive = createDrive(gearsMeta.params.tick.default);
      const pool = new Float64Array(3);
      /** Gear indices back to front, and each layer's range in that order. */
      const order = new Int32Array(MAX_GEARS);
      const layerFirst = new Int32Array(LAYERS);
      const layerCount = new Int32Array(LAYERS);
      let train: Gear[] = [];
      let trainLayout = "";
      let trainSeed = Number.NaN;
      let trainAspect = Number.NaN;

      let width = 1;
      let height = 1;
      /**
       * What the backdrop target holds; cleared whenever it may have been
       * reallocated or the light pool moved.
       */
      let drawnBackdrop = "";

      /** Regrows the train when the layout, seed or aspect changes. */
      const ensureTrain = (layout: GearLayoutId, seed: number, aspect: number) => {
        if (layout === trainLayout && seed === trainSeed && aspect === trainAspect) {
          return;
        }
        trainLayout = layout;
        trainSeed = seed;
        trainAspect = aspect;
        train = growTrain(layout, aspect, seed).slice(0, MAX_GEARS);
        let k = 0;
        for (let layer = 0; layer < LAYERS; layer++) {
          layerFirst[layer] = k;
          for (let i = 0; i < train.length; i++) {
            if (train[i].layer === layer) {
              order[k++] = i;
            }
          }
          layerCount[layer] = k - layerFirst[layer];
        }
        drawnBackdrop = "";
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          const scale = v.scale > 0 ? v.scale : height / 1080;
          target.resize(width, height, Math.max(1, BACKDROP_TEXEL_REF * scale));
          drawnBackdrop = "";
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const layout = isLayoutId(p.layout) ? p.layout : "corner";
          ensureTrain(layout, p.seed, aspect);
          poolFor(layout, aspect, pool);
          advanceDrive(drive, dt, (p.speed * TAU) / 60, p.tick);
          const angle = driveAngle(drive);
          const swing = balanceAngle(drive);

          // 1. The backdrop, re-rendered only when it changes, upscaled every frame.
          if (target.direct || drawnBackdrop !== p.backdrop) {
            const b = lookup(BACKDROPS, p.backdrop, "plate");
            target.bind();
            gl.useProgram(bu.program);
            bu.f2(
              "uPxToH",
              target.fullWidth / target.width / height,
              target.fullHeight / target.height / height,
            );
            bu.f2("uFrame", aspect, 1);
            bu.i1("uKind", b.kind);
            bu.v3("uBase", b.base);
            bu.v3("uAlt", b.alt);
            bu.v3("uLight", LIGHT);
            bu.f3("uPool", pool[0], pool[1], pool[2]);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            drawnBackdrop = p.backdrop;
          }
          target.blit();
          gl.viewport(0, 0, width, height);

          // 2. The gears: angle and colour per instance, back to front.
          const n = train.length;
          if (n === 0) {
            return;
          }
          const d = batch.data;
          const stride = batch.stride;
          for (let k = 0; k < n; k++) {
            const gear = train[order[k]];
            const o = k * stride;
            const turn = gear.teeth > 0 ? gear.phase + gear.ratio * angle : gear.phase + swing;
            const metal =
              p.metal === "brass" ? METAL_BRASS : p.metal === "steel" ? METAL_STEEL : gear.metal;
            const c = METALS[metal];
            // Some brass is older and darker; steel varies less.
            const shade = 1 + gear.tint * (metal === METAL_STEEL ? 0.05 : 0.09);
            const warm = metal === METAL_COPPER ? 0 : gear.tint * 0.03;
            d[o] = gear.x;
            d[o + 1] = gear.y;
            d[o + 2] = gear.pitchR;
            d[o + 3] = gear.teeth;
            d[o + 4] = wrap(turn, 0, TAU);
            d[o + 5] = gear.style;
            d[o + 6] = gear.spokes;
            d[o + 7] = gear.screws;
            d[o + 8] = c[0] * shade + warm;
            d[o + 9] = c[1] * shade;
            d[o + 10] = c[2] * shade - warm;
            d[o + 11] = gear.layer;
          }
          batch.upload(n);

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(gu.program);
          gu.f2("uToClip", 2 / aspect, 2);
          gu.f1("uModule", LAYOUT_SPECS[layout].module);
          gu.f1("uPx", 1 / height);
          gu.f1("uShadowAlpha", SHADOW_ALPHA);
          gu.v3("uLight", LIGHT);
          gu.f2("uLDir", LIGHT_DIR[0], LIGHT_DIR[1]);
          gu.f1("uAmbient", AMBIENT);
          gu.f3("uPool", pool[0], pool[1], pool[2]);
          const sx = -LIGHT_DIR[0] * SHADOW_OFFSET;
          const sy = -LIGHT_DIR[1] * SHADOW_OFFSET;
          for (let layer = 0; layer < LAYERS; layer++) {
            const count = layerCount[layer];
            if (count === 0) {
              continue;
            }
            // Shadows fall on the plate and on the layers below, then the gears go on top.
            gu.f4("uShadow", sx, sy, SHADOW_BLUR, 1);
            batch.draw(layerFirst[layer], count);
            gu.f4("uShadow", sx, sy, SHADOW_BLUR, 0);
            batch.draw(layerFirst[layer], count);
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
