import { describe, expect, it } from "vitest";
import {
  BASE_RADIUS,
  blobY,
  EPS,
  fillBlobs,
  makeBlobs,
  MAX_ASPECT,
  MAX_BLOBS,
  POOL_WOB,
  REF_H,
  TILE,
} from "./lavalamp";
import { createRng } from "../noise";

describe("makeBlobs", () => {
  it("is deterministic per seed", () => {
    expect(makeBlobs(7)).toEqual(makeBlobs(7));
    expect(makeBlobs(8)).not.toEqual(makeBlobs(7));
  });

  it("keeps every parameter in its documented range", () => {
    const TAU = Math.PI * 2;
    for (const seed of [1, 2, 500, 9999]) {
      const blobs = makeBlobs(seed);
      expect(blobs).toHaveLength(MAX_BLOBS);
      for (const b of blobs) {
        expect(b.baseX).toBeGreaterThanOrEqual(0.15);
        expect(b.baseX).toBeLessThanOrEqual(0.85);
        expect(b.size).toBeGreaterThanOrEqual(0.7);
        expect(b.size).toBeLessThanOrEqual(1.3);
        expect(b.riseAmp).toBeGreaterThanOrEqual(0.32);
        expect(b.riseAmp).toBeLessThanOrEqual(0.54);
        for (const rate of [b.rise, b.w1, b.w2, b.wr]) {
          expect(rate).toBeGreaterThan(0);
          expect(rate).toBeLessThanOrEqual(TAU / 9);
        }
        for (const phase of [b.risePhase, b.p1, b.p2, b.pr]) {
          expect(phase).toBeGreaterThanOrEqual(0);
          expect(phase).toBeLessThan(TAU);
        }
      }
    }
  });

  it("spreads any prefix of the list across the width", () => {
    const xs = makeBlobs(3)
      .slice(0, 5)
      .map((b) => b.baseX)
      .toSorted((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeGreaterThan(0.05);
    }
  });
});

describe("blobY", () => {
  it("travels within 0.5 +- riseAmp", () => {
    for (const b of makeBlobs(11)) {
      for (let t = 0; t < 200; t += 0.7) {
        expect(Math.abs(blobY(b, t) - 0.5)).toBeLessThanOrEqual(b.riseAmp + 1e-12);
      }
    }
  });
});

/**
 * The field and its per-tile bounds, mirroring FRAGMENT and MASK_FRAGMENT in
 * float64, to check the bound argument the mask pass relies on: each term falls
 * off monotonically in |d.x| and |d.y|, so the nearest and farthest offsets over a
 * tile bound it, and the pool's surface stays within its POOL_WOB ripple.
 */
describe("lava lamp tile bounds", () => {
  interface Scene {
    width: number;
    height: number;
    lampW: number;
    scale: [number, number];
    data: Float32Array;
    r2: Float32Array;
    n: number;
    poolR2: number;
    phase: [number, number];
  }

  function field(s: Scene, fx: number, fy: number): number {
    const px = fx * s.scale[0];
    const py = (s.height - fy) * s.scale[1];
    let f = 0;
    for (let i = 0; i < s.n; i++) {
      const dx = px * s.data[i * 4] + s.data[i * 4 + 2];
      const dy = py * s.data[i * 4 + 1] + s.data[i * 4 + 3];
      f += s.r2[i] / (dx * dx + dy * dy + EPS);
    }
    const u = px / s.lampW;
    const wob = Math.sin(u * 5.1 + s.phase[0]) + 0.6 * Math.sin(u * 9.7 + s.phase[1]);
    const pd = Math.max(0, REF_H * (1.025 + 0.009 * wob) - py);
    return f + s.poolR2 / (pd * pd + EPS);
  }

  function tileBounds(s: Scene, tx: number, ty: number): [number, number] {
    const lo = [tx * TILE, ty * TILE];
    const hi = [lo[0] + TILE, lo[1] + TILE];
    const pMin = [lo[0] * s.scale[0], (s.height - hi[1]) * s.scale[1]];
    const pMax = [hi[0] * s.scale[0], (s.height - lo[1]) * s.scale[1]];
    let fMax = 0;
    let fMin = 0;
    for (let i = 0; i < s.n; i++) {
      const near = [0, 0];
      const far = [0, 0];
      for (let k = 0; k < 2; k++) {
        const a = pMin[k] * s.data[i * 4 + k] + s.data[i * 4 + 2 + k];
        const c = pMax[k] * s.data[i * 4 + k] + s.data[i * 4 + 2 + k];
        near[k] = Math.max(0, a, -c);
        far[k] = Math.max(-a, c);
      }
      fMax += s.r2[i] / (near[0] ** 2 + near[1] ** 2 + EPS);
      fMin += s.r2[i] / (far[0] ** 2 + far[1] ** 2 + EPS);
    }
    const pdNear = Math.max(0, REF_H * (1.025 - 0.009 * POOL_WOB) - pMax[1]);
    const pdFar = Math.max(0, REF_H * (1.025 + 0.009 * POOL_WOB) - pMin[1]);
    fMax += s.poolR2 / (pdNear * pdNear + EPS);
    fMin += s.poolR2 / (pdFar * pdFar + EPS);
    return [fMin, fMax];
  }

  function randomScene(rng: () => number): Scene {
    const sizes = [
      [1920, 1080],
      [3840, 2160],
      [1080, 1920],
      [7000, 1000],
      [333, 77],
    ];
    const [width, height] = sizes[Math.floor(rng() * sizes.length)];
    const lampW = Math.max(1, Math.min(REF_H * MAX_ASPECT, (REF_H * width) / height));
    const size = 0.5 + 1.5 * rng();
    const n = 1 + Math.floor(rng() * MAX_BLOBS);
    const life = new Float32Array(MAX_BLOBS).map(() => (rng() < 0.3 ? rng() : 1));
    const data = new Float32Array(MAX_BLOBS * 4);
    const r2 = new Float32Array(MAX_BLOBS);
    const blobs = makeBlobs(1 + Math.floor(rng() * 9999));
    fillBlobs(data, r2, blobs, n, rng() * 1000, BASE_RADIUS * size * REF_H, lampW, life);
    const poolR = 0.05 * Math.sqrt(size) * REF_H;
    return {
      width,
      height,
      lampW,
      scale: [lampW / width, REF_H / height],
      data,
      r2,
      n,
      poolR2: poolR * poolR,
      phase: [rng() * Math.PI * 2, rng() * Math.PI * 2],
    };
  }

  it("bounds the field at every pixel of a tile", () => {
    const rng = createRng(2024);
    let checked = 0;
    for (let k = 0; k < 40; k++) {
      const s = randomScene(rng);
      const tw = Math.ceil(s.width / TILE);
      const th = Math.ceil(s.height / TILE);
      // Random tiles, plus the ones holding each blob centre, where the field peaks.
      const tiles: [number, number][] = [];
      for (let i = 0; i < 15; i++) {
        tiles.push([Math.floor(rng() * tw), Math.floor(rng() * th)]);
      }
      for (let i = 0; i < s.n; i++) {
        const cx = -s.data[i * 4 + 2] / s.data[i * 4] / s.scale[0];
        const cy = s.height - -s.data[i * 4 + 3] / s.data[i * 4 + 1] / s.scale[1];
        const tx = Math.floor(cx / TILE);
        const ty = Math.floor(cy / TILE);
        if (tx >= 0 && tx < tw && ty >= 0 && ty < th) {
          tiles.push([tx, ty]);
        }
      }
      for (const [tx, ty] of tiles) {
        const [fMin, fMax] = tileBounds(s, tx, ty);
        let lo = Infinity;
        let hi = -Infinity;
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) {
            const f = field(s, tx * TILE + x + 0.5, ty * TILE + y + 0.5);
            lo = Math.min(lo, f);
            hi = Math.max(hi, f);
            checked++;
          }
        }
        expect(lo).toBeGreaterThanOrEqual(fMin * (1 - 1e-12));
        expect(hi).toBeLessThanOrEqual(fMax * (1 + 1e-12));
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });
});
