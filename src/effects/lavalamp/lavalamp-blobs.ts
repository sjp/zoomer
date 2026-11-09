/**
 * The Lava Lamp's wax blobs: their per-seed constants, their slow rise and fall,
 * and the packing of their metaball field into shader uniforms. Shared with the
 * 1980s Bedroom's little lamp and the Chemistry Lab's goo.
 */
import { glslFloat } from "../gl";
import { createRng } from "../noise";

const TAU = Math.PI * 2;

export const MAX_BLOBS = 20;
/** Base blob radius as a fraction of the frame height, for a size of 1. */
export const BASE_RADIUS = 0.085;
/**
 * The field is evaluated in "lamp units": the frame is REF_H units tall, matching the
 * old CPU renderer's default (medium) buffer, so EPS and the look carry over unchanged.
 */
export const REF_H = 360;
/** Softens the 1/d² singularity at blob centres, in lamp units squared. */
export const EPS = 0.5;

/** Per-blob constants, drawn once per seed. Angular rates are in radians per lamp second. */
export interface Blob {
  /** Resting horizontal position, 0..1 across the usable width. */
  baseX: number;
  /** Size multiplier. */
  size: number;
  /** Vertical heat cycle: rate, phase and amplitude (fraction of height). */
  rise: number;
  risePhase: number;
  riseAmp: number;
  /** Two-component horizontal wander. */
  w1: number;
  p1: number;
  w2: number;
  p2: number;
  /** Radius breathing. */
  wr: number;
  pr: number;
}

export const makeBlobs = (seed: number): Blob[] => {
  const rng = createRng(seed * 7717 + 29);
  const start = rng();
  const blobs: Blob[] = [];
  for (let i = 0; i < MAX_BLOBS; i++) {
    // Golden-ratio spacing keeps any prefix of the list spread across the width.
    const g = (start + i * 0.618034) % 1;
    blobs.push({
      baseX: 0.15 + 0.7 * g,
      size: 0.7 + 0.6 * rng(),
      rise: TAU / (36 + 40 * rng()),
      risePhase: rng() * TAU,
      riseAmp: 0.32 + 0.22 * rng(),
      w1: TAU / (40 + 40 * rng()),
      p1: rng() * TAU,
      w2: TAU / (17 + 20 * rng()),
      p2: rng() * TAU,
      wr: TAU / (9 + 12 * rng()),
      pr: rng() * TAU,
    });
  }
  return blobs;
};

/** Vertical position (0 top, 1 bottom) of a blob at lamp time t. */
export const blobY = (b: Blob, t: number) => {
  // Odd cubic of a sine: quicker through the middle, lingering at the hot
  // bottom and the cool top like wax waiting to heat or cool.
  const s = Math.sin(t * b.rise + b.risePhase);
  return 0.5 + b.riseAmp * s * (1.25 - 0.25 * s * s);
};

/**
 * Packs the first `n` blobs at lamp time `t` into the shader's uniforms (see
 * `uBlobs` and `uBlobR2`): per blob, `(q, c)` with the offset from its centre
 * `d = p * q + c`, and its radius squared scaled by `life` (its count fade).
 * `baseR` and `lampW` are in lamp units.
 */
export function fillBlobs(
  data: Float32Array,
  r2: Float32Array,
  blobs: readonly Blob[],
  n: number,
  t: number,
  baseR: number,
  lampW: number,
  life: Float32Array,
): void {
  for (let i = 0; i < n; i++) {
    const b = blobs[i];
    const r = baseR * b.size * (1 + 0.12 * Math.sin(t * b.wr + b.pr));
    // Stay inside the frame horizontally; vertical travel may poke past the edges.
    const wander = 0.09 * Math.sin(t * b.w1 + b.p1) + 0.04 * Math.sin(t * b.w2 + b.p2);
    const margin = Math.min(r, lampW / 2);
    const vel = Math.abs(blobY(b, t + 0.25) - blobY(b, t - 0.25)) * 2;
    const cx = margin + (b.baseX + wander) * (lampW - 2 * margin);
    const cy = blobY(b, t) * REF_H;
    // Moving wax stretches along its travel, keeping its area: the term is
    // r² / (dx² s + dy² / s + EPS), i.e. offsets pre-scaled by (√s, 1/√s).
    const qx = Math.sqrt(1 + Math.min(0.35, vel * 4));
    const qy = 1 / qx;
    const o = i * 4;
    data[o] = qx;
    data[o + 1] = qy;
    data[o + 2] = -cx * qx;
    data[o + 3] = -cy * qy;
    // Shrinking r² with the fade grows or shrinks the blob from or to nothing.
    r2[i] = r * r * life[i];
  }
}

/**
 * GLSL `lavaField(p, pool)`: the metaball field of `count` blobs at `p` (lamp
 * px: x across the lamp's width in `fillBlobs` units, y down from the top, 0 to
 * `REF_H`), plus the pool of wax at the bottom with weight `pool`. Wax is where
 * the field passes about 1. The shader declares `uBlobs` and `uBlobR2` as filled
 * by `fillBlobs`.
 */
export const lavaFieldGlsl = (count: number) => /* glsl */ `
float lavaField(vec2 p, float pool) {
  float field = 0.0;
  for (int i = 0; i < ${String(count)}; i++) {
    vec4 b = uBlobs[i];
    vec2 o = p * b.xy + b.zw;
    field += uBlobR2[i] / (dot(o, o) + ${glslFloat(EPS)});
  }
  float pd = max(0.0, ${glslFloat(REF_H)} - p.y);
  field += pool / (pd * pd + ${glslFloat(EPS)});
  return field;
}
`;
