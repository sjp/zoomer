import { describe, expect, it } from "vitest";
import {
  BODY_ROWS,
  bodyProfile,
  buildPebbleTexture,
  createFish,
  createPads,
  createRipples,
  createStripScratch,
  fishLength,
  type FishFrame,
  HARD_MARGIN,
  MAX_RIPPLES,
  NOTCH,
  padOutline,
  rescaleFish,
  rescalePads,
  RIPPLE_LIFE,
  rippleAge,
  ROWS,
  solveSpine,
  sortByDepth,
  straightenSpine,
  SPINE_POINTS,
  spawnRipple,
  stepFish,
  stepPads,
  VERTEX_FLOATS,
  VERTS_PER_FISH,
  writeFishStrip,
  writeRipples,
  wrapAngle,
} from "./koi-sim";
import { createNoise, createRng } from "../noise";

const REF_WIDTH = 1920;

function run(
  seconds: number,
  frame: Partial<FishFrame> = {},
  onSample?: (s: ReturnType<typeof createFish>, n: number) => void,
  dt = 1 / 30,
) {
  const fish = createFish(15, REF_WIDTH, 7);
  const f: FishFrame = { refWidth: REF_WIDTH, count: 9, size: 130, speed: 1, ...frame };
  const noise = createNoise(3);
  const rng = createRng(4);
  for (let t = 0; t < seconds; t += dt) {
    stepFish(fish, dt, f, noise, rng);
    onSample?.(fish, fish.live);
  }
  return fish;
}

describe("koi steering", () => {
  it("keeps fish in bounds and mostly out of the centre third", () => {
    let samples = 0;
    let centre = 0;
    let outside = 0;
    let offFrame = 0;
    run(
      400,
      {},
      (s, n) => {
        for (let i = 0; i < n; i++) {
          samples++;
          const x = s.x[i];
          const y = s.y[i];
          const m = HARD_MARGIN;
          if (x < -m || x > REF_WIDTH + m || y < -m || y > 1080 + m) {
            outside++;
          }
          if (x < 0 || x > REF_WIDTH || y < 0 || y > 1080) {
            offFrame++;
          }
          if (x > REF_WIDTH / 3 && x < (REF_WIDTH * 2) / 3) {
            centre++;
          }
        }
      },
      1 / 15,
    );
    expect(outside).toBe(0);
    expect(offFrame / samples).toBeLessThan(0.02);
    // Uniformly spread fish would spend a third of their time there.
    expect(centre / samples).toBeLessThan(0.2);
  });

  it("produces no NaN when the fish are stationary or stacked", () => {
    const fish = createFish(15, REF_WIDTH, 1);
    // Everyone on one spot, spines collapsed onto the head.
    fish.x.fill(500);
    fish.y.fill(500);
    fish.spine.fill(500);
    const f: FishFrame = { refWidth: REF_WIDTH, count: 15, size: 130, speed: 0 };
    const noise = createNoise(1);
    const rng = createRng(2);
    for (let k = 0; k < 20; k++) {
      stepFish(fish, 1 / 60, f, noise, rng);
    }
    f.speed = 1;
    for (let k = 0; k < 20; k++) {
      stepFish(fish, 1 / 60, f, noise, rng);
    }
    const out = new Float32Array(15 * VERTS_PER_FISH * VERTEX_FLOATS);
    const scratch = createStripScratch();
    for (let i = 0; i < 15; i++) {
      writeFishStrip(
        fish,
        i,
        fishLength(fish, i, 130),
        1,
        2,
        out,
        i * VERTS_PER_FISH * VERTEX_FLOATS,
        scratch,
      );
    }
    for (const arr of [fish.x, fish.y, fish.heading, fish.speed, fish.spine, out]) {
      expect(arr.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("limits the turn rate", () => {
    const fish = createFish(15, REF_WIDTH, 5);
    const f: FishFrame = { refWidth: REF_WIDTH, count: 6, size: 130, speed: 1 };
    const noise = createNoise(5);
    const rng = createRng(6);
    const dt = 1 / 60;
    for (let k = 0; k < 600; k++) {
      const before = Array.from(fish.heading.subarray(0, 6));
      stepFish(fish, dt, f, noise, rng);
      for (let i = 0; i < 6; i++) {
        expect(Math.abs(wrapAngle(fish.heading[i] - before[i]))).toBeLessThanOrEqual(
          0.9 * dt + 1e-9,
        );
      }
    }
  });

  it("fades fish in and out with the count", () => {
    const fish = run(5, { count: 3 });
    expect(fish.live).toBe(3);
    const f: FishFrame = { refWidth: REF_WIDTH, count: 10, size: 130, speed: 1 };
    stepFish(fish, 1 / 60, f, createNoise(1), createRng(1));
    expect(fish.live).toBe(10);
    expect(fish.life[9]).toBeLessThan(0.1);
    f.count = 3;
    for (let k = 0; k < 120; k++) {
      stepFish(fish, 1 / 60, f, createNoise(1), createRng(1));
    }
    expect(fish.live).toBe(3);
  });
});

describe("koi spine", () => {
  it("keeps every segment at its length as the head moves", () => {
    const fish = run(60);
    for (let i = 0; i < fish.live; i++) {
      const seg = fish.segment[i];
      expect(seg).toBeGreaterThan(0);
      const o = i * SPINE_POINTS * 2;
      for (let k = 1; k < SPINE_POINTS; k++) {
        const d = Math.hypot(
          fish.spine[o + k * 2] - fish.spine[o + k * 2 - 2],
          fish.spine[o + k * 2 + 1] - fish.spine[o + k * 2 - 1],
        );
        expect(d).toBeCloseTo(seg, 6);
      }
    }
  });

  it("starts with the head at the fish's position", () => {
    const fish = createFish(4, REF_WIDTH);
    fish.x[2] = 321;
    fish.y[2] = 456;
    solveSpine(fish, 2, 10);
    const o = 2 * SPINE_POINTS * 2;
    expect([fish.spine[o], fish.spine[o + 1]]).toEqual([321, 456]);
  });
});

describe("koi strip", () => {
  it("has the expected vertex count and no degenerate triangles", () => {
    expect(VERTS_PER_FISH).toBe(ROWS * 2);
    const fish = run(30, { count: 15 });
    const out = new Float32Array(15 * VERTS_PER_FISH * VERTEX_FLOATS);
    const scratch = createStripScratch();
    const scale = 2;
    for (let i = 0; i < 15; i++) {
      const length = fishLength(fish, i, 130);
      const base = i * VERTS_PER_FISH * VERTEX_FLOATS;
      writeFishStrip(fish, i, length, 1, scale, out, base, scratch);
      const px = (v: number) => {
        const o = base + v * VERTEX_FLOATS;
        return [out[o] + out[o + 2], out[o + 1] + out[o + 3]];
      };
      for (let v = 0; v + 2 < VERTS_PER_FISH; v++) {
        const [ax, ay] = px(v);
        const [bx, by] = px(v + 1);
        const [cx, cy] = px(v + 2);
        const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
        // Comfortably more than a hundredth of a square pixel.
        expect(area).toBeGreaterThan(0.01);
      }
      // u runs nose to fin tip, v alternates sides.
      expect(out[base + 4]).toBe(0);
      expect(out[base + (BODY_ROWS - 1) * 2 * VERTEX_FLOATS + 4]).toBe(1);
      expect(out[base + (VERTS_PER_FISH - 1) * VERTEX_FLOATS + 4]).toBeCloseTo(1.5);
      expect(out[base + 5]).toBe(-1);
      expect(out[base + VERTEX_FLOATS + 5]).toBe(1);
    }
  });

  it("has a width profile that is round at the head and tapers to the tail", () => {
    expect(bodyProfile(0.3)).toBe(1);
    expect(bodyProfile(0)).toBeGreaterThan(0.2);
    expect(bodyProfile(0)).toBeLessThan(0.5);
    expect(bodyProfile(1)).toBeCloseTo(0.15);
  });

  it("sorts fish deepest first", () => {
    const fish = createFish(5, REF_WIDTH);
    fish.depth.set([0.2, 0.9, 0.5, 0.1, 0.7]);
    const order = new Int32Array(5);
    sortByDepth(fish, 5, order);
    expect(Array.from(order)).toEqual([1, 4, 2, 0, 3]);
  });
});

describe("koi ripples", () => {
  it("recycles the oldest event when full", () => {
    const r = createRipples(MAX_RIPPLES);
    for (let k = 0; k < MAX_RIPPLES; k++) {
      spawnRipple(r, k, 0);
      r.time += 0.1;
    }
    spawnRipple(r, 99, 0);
    expect(r.x[0]).toBe(99);
    expect(r.x[1]).toBe(1);
    expect(r.next).toBe(1);
  });

  it("bounds every lifetime and uploads zeros for expired slots", () => {
    const r = createRipples(4);
    spawnRipple(r, 10, 20);
    const out = new Float32Array(16);
    r.time += 1;
    writeRipples(r, 2, 1, out);
    expect(out[0]).toBe(20);
    expect(out[1]).toBe(40);
    expect(out[3]).toBeGreaterThan(0);
    expect(rippleAge(r, 1)).toBe(-1);
    r.time += RIPPLE_LIFE;
    expect(rippleAge(r, 0)).toBe(-1);
    writeRipples(r, 2, 1, out);
    expect(Array.from(out)).toEqual(Array.from({ length: 16 }, () => 0));
  });

  it("are spawned by fish near the surface", () => {
    const fish = createFish(15, REF_WIDTH, 7);
    const f: FishFrame = { refWidth: REF_WIDTH, count: 15, size: 130, speed: 1 };
    const noise = createNoise(3);
    const rng = createRng(4);
    let spawned = 0;
    const onSurface = () => {
      spawned++;
    };
    for (let k = 0; k < 30 * 120; k++) {
      stepFish(fish, 1 / 30, f, noise, rng, onSurface);
    }
    expect(spawned).toBeGreaterThan(5);
    // Now and then, not constantly: under one a second for the whole pond.
    expect(spawned).toBeLessThan(120);
  });
});

describe("lily pads", () => {
  it("is a notched outline, star-shaped about the origin", () => {
    const o = padOutline(40);
    // The rim runs strictly anticlockwise round from the notch...
    let prev = -Infinity;
    for (let k = 0; k < o.length - 2; k += 2) {
      const a = Math.atan2(o[k + 1], o[k]);
      const angle = a < 0 ? a + Math.PI * 2 : a;
      expect(angle).toBeGreaterThan(prev);
      prev = angle;
      expect(Math.hypot(o[k], o[k + 1])).toBeCloseTo(1);
    }
    // ...then closes through a point just off the centre, inside the notch.
    const [x, y] = o.slice(-2);
    expect(Math.hypot(x, y)).toBeLessThan(0.1);
    expect(Math.abs(Math.atan2(y, x))).toBeLessThan(NOTCH);
  });

  it("drift within the padded frame and fade with the count", () => {
    const pads = createPads(20, REF_WIDTH);
    for (let k = 0; k < 600; k++) {
      stepPads(pads, 1 / 10, 8, REF_WIDTH);
    }
    expect(pads.live).toBe(8);
    for (let i = 0; i < 8; i++) {
      const m = pads.r[i] * 1.6;
      expect(pads.x[i]).toBeGreaterThanOrEqual(-m);
      expect(pads.x[i]).toBeLessThan(REF_WIDTH + m);
      expect(pads.life[i]).toBe(1);
    }
  });
});

describe("pebble texture", () => {
  it("is deterministic, varied and tiles seamlessly", () => {
    const size = 64;
    const a = buildPebbleTexture(size, 6, 3);
    expect(a).toEqual(buildPebbleTexture(size, 6, 3));
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThan(100);
    // Opposite edges join: the wrap step is no larger than a typical interior step.
    let edge = 0;
    let interior = 0;
    for (let y = 0; y < size; y++) {
      edge += Math.abs(a[y * size] - a[y * size + size - 1]);
      interior += Math.abs(a[y * size + size / 2] - a[y * size + size / 2 - 1]);
    }
    expect(edge).toBeLessThan(interior * 3 + size * 8);
  });
});

describe("straightenSpine", () => {
  it("lays the spine straight back from the head at the segment length", () => {
    const s = createFish(4, 1920);
    s.x[2] = 500;
    s.y[2] = 300;
    s.heading[2] = Math.PI / 3;
    straightenSpine(s, 2, 7);
    expect(s.segment[2]).toBe(7);
    const o = 2 * SPINE_POINTS * 2;
    expect([s.spine[o], s.spine[o + 1]]).toEqual([500, 300]);
    for (let k = 1; k < SPINE_POINTS; k++) {
      const dx = s.spine[o + k * 2] - s.spine[o + k * 2 - 2];
      const dy = s.spine[o + k * 2 + 1] - s.spine[o + k * 2 - 1];
      expect(Math.hypot(dx, dy)).toBeCloseTo(7, 9);
      // Each step runs opposite the heading.
      expect(dx).toBeCloseTo(-7 * Math.cos(Math.PI / 3), 9);
      expect(dy).toBeCloseTo(-7 * Math.sin(Math.PI / 3), 9);
    }
  });

  it("leaves the other fish alone", () => {
    const s = createFish(3, 1920);
    const before = Array.from(s.spine);
    s.heading[1] += 1;
    straightenSpine(s, 1, 3);
    const per = SPINE_POINTS * 2;
    expect(Array.from(s.spine.subarray(0, per))).toEqual(before.slice(0, per));
    expect(Array.from(s.spine.subarray(2 * per))).toEqual(before.slice(2 * per));
  });
});

describe("rescaleFish and rescalePads", () => {
  it("scale x (and the fish's spines) by k, leaving y alone", () => {
    const s = createFish(6, 1920);
    const x = Array.from(s.x);
    const y = Array.from(s.y);
    const spine = Array.from(s.spine);
    rescaleFish(s, 0.75);
    expect(Array.from(s.x)).toEqual(x.map((v) => v * 0.75));
    expect(Array.from(s.y)).toEqual(y);
    expect(Array.from(s.spine)).toEqual(spine.map((v, j) => (j % 2 === 0 ? v * 0.75 : v)));

    const p = createPads(5, 1920);
    const px = Array.from(p.x);
    const py = Array.from(p.y);
    rescalePads(p, 1.5);
    expect(Array.from(p.x)).toEqual(px.map((v) => v * 1.5));
    expect(Array.from(p.y)).toEqual(py);
  });

  it("keep fish and pads at the same share of the width through a resize and back", () => {
    const s = createFish(6, 1920);
    const p = createPads(5, 1920);
    const share = Array.from(s.x, (v) => v / 1920);
    const padShare = Array.from(p.x, (v) => v / 1920);
    const drift = (now: Float64Array, width: number, was: number[]) =>
      Math.max(...Array.from(now, (v, i) => Math.abs(v / width - was[i])));
    rescaleFish(s, 1440 / 1920);
    rescalePads(p, 1440 / 1920);
    expect(drift(s.x, 1440, share)).toBeLessThan(1e-12);
    expect(drift(p.x, 1440, padShare)).toBeLessThan(1e-12);
    rescaleFish(s, 1920 / 1440);
    rescalePads(p, 1920 / 1440);
    expect(drift(s.x, 1920, share)).toBeLessThan(1e-12);
    expect(drift(p.x, 1920, padShare)).toBeLessThan(1e-12);
  });
});
