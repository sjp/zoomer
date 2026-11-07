import { describe, expect, it } from "vitest";
import {
  BUBBLE_FLOATS,
  type BubbleFrame,
  createBubbles,
  emitCount,
  MAX_EMITTERS,
  MODES,
  RISE_MAX,
  riseSpeed,
  WOBBLE_MAX,
  WOBBLE_MIN_R,
  wobbleAmount,
  ZIG_MIN_R,
  ZIG_PX,
  zigAmplitude,
} from "./bubbles-sim";

const MAX = 400;
const frame = (over: Partial<BubbleFrame> = {}): BubbleFrame => ({
  refWidth: 1920,
  scale: 1,
  mode: MODES.soda,
  count: 300,
  size: 10,
  speed: 1,
  streams: false,
  ...over,
});
const radii = Array.from({ length: 400 }, (_, i) => i * 0.25);

describe("riseSpeed", () => {
  it("is monotonic in the radius and capped", () => {
    for (let i = 1; i < radii.length; i++) {
      expect(riseSpeed(radii[i])).toBeGreaterThanOrEqual(riseSpeed(radii[i - 1]));
    }
    expect(riseSpeed(1e6)).toBeLessThanOrEqual(RISE_MAX);
    expect(riseSpeed(1e6)).toBeGreaterThan(RISE_MAX * 0.99);
  });

  it("takes several seconds to cross the frame even at the fastest settings", () => {
    // The largest bubble at the largest size (24) and speed (1.5), with the most pace jitter.
    for (const m of Object.values(MODES)) {
      const v = riseSpeed(24 * m.sizeMul * m.sizeHi) * m.pace * 1.5 * 1.15;
      expect(1080 / v).toBeGreaterThan(3);
    }
  });
});

describe("zigzag and wobble", () => {
  it("are bounded and zero below their threshold radius", () => {
    for (const r of radii) {
      const z = zigAmplitude(r);
      const w = wobbleAmount(r);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(ZIG_PX);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(WOBBLE_MAX);
      expect(r <= ZIG_MIN_R ? z : 0).toBe(0);
      expect(r <= WOBBLE_MIN_R ? w : 0).toBe(0);
    }
    expect(zigAmplitude(100)).toBe(ZIG_PX);
    expect(wobbleAmount(100)).toBe(WOBBLE_MAX);
  });
});

describe("emitCount", () => {
  it("averages out to the rate", () => {
    const acc = new Float64Array(1);
    let n = 0;
    let t = 0;
    for (let i = 0; i < 10000; i++) {
      const dt = 0.005 + (i % 7) * 0.003;
      t += dt;
      n += emitCount(acc, 0, 3.7, dt);
    }
    expect(Math.abs(n - 3.7 * t)).toBeLessThanOrEqual(1);
  });
});

describe("createBubbles", () => {
  const data = new Float32Array(MAX * BUBBLE_FLOATS);

  it("is deterministic for a seed", () => {
    const a = createBubbles(MAX, 1920, 7);
    const b = createBubbles(MAX, 1920, 7);
    for (let i = 0; i < 100; i++) {
      a.step(1 / 30, frame(), data, BUBBLE_FLOATS);
      b.step(1 / 30, frame(), data, BUBBLE_FLOATS);
    }
    expect(Array.from(a.ys)).toEqual(Array.from(b.ys));
  });

  it("keeps the count constant as bubbles respawn", () => {
    const sim = createBubbles(MAX, 1920);
    const f = frame();
    let bad = 0;
    for (let i = 0; i < 20 * 40; i++) {
      const visible = sim.step(1 / 20, f, data, BUBBLE_FLOATS);
      if (sim.live !== sim.target || visible > sim.target) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    // Long after every bubble has crossed the frame a few times, nearly all are on screen.
    expect(sim.step(1 / 60, f, data, BUBBLE_FLOATS)).toBeGreaterThan(sim.target * 0.9);
  });

  it("writes finite instances inside the frame's margins", () => {
    const sim = createBubbles(MAX, 1920);
    const f = frame({ mode: MODES.aquarium, size: 24, count: 400 });
    const bad: string[] = [];
    for (let i = 0; i < 300; i++) {
      const n = sim.step(1 / 30, f, data, BUBBLE_FLOATS);
      for (let k = 0; k < n; k++) {
        const o = k * BUBBLE_FLOATS;
        for (let j = 0; j < BUBBLE_FLOATS; j++) {
          if (!Number.isFinite(data[o + j])) {
            bad.push(`non-finite ${String(j)}`);
          }
        }
        if (!(data[o + 3] > 0 && data[o + 3] <= 1)) {
          bad.push(`alpha ${String(data[o + 3])}`);
        }
        if (!(data[o + 7] > 0 && data[o + 7] <= 1)) {
          bad.push(`flip ${String(data[o + 7])}`);
        }
        if (!(data[o] > -100 && data[o] < 2020)) {
          bad.push(`x ${String(data[o])}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("emits streams at about their rate and keeps stream bubbles on their emitters", () => {
    const mode = MODES.champagne;
    const sim = createBubbles(MAX, 1920);
    const f = frame({ mode, streams: true, count: 240, size: 10 });
    const seconds = 60;
    // Settle first, then measure.
    for (let i = 0; i < 20 * 30; i++) {
      sim.step(1 / 20, f, data, BUBBLE_FLOATS);
    }
    const before = Array.from(sim.emitted);
    let changed = 0;
    for (let i = 0; i < 20 * seconds; i++) {
      sim.step(1 / 20, f, data, BUBBLE_FLOATS);
      if (sim.live !== sim.target) {
        changed++;
      }
    }
    expect(changed).toBe(0);
    let parked = 0;
    for (let i = 0; i < sim.target; i++) {
      parked += sim.parked[i];
    }
    expect(parked).toBeLessThan(sim.target * 0.25);
    expect(mode.emitters.length).toBe(MAX_EMITTERS);
    for (let e = 0; e < MAX_EMITTERS; e++) {
      const got = (sim.emitted[e] - before[e]) / seconds;
      // Emitters run 10% fast, so a stream fires whenever a bubble is waiting:
      // the emission rate then matches the rate its bubbles come back round.
      expect(sim.rates[e]).toBeGreaterThan(0);
      expect(got).toBeGreaterThan(sim.rates[e] * 0.8);
      expect(got).toBeLessThanOrEqual(sim.rates[e] * 1.01);
    }
  });

  it("returns parked bubbles to the random pool when streams turn off", () => {
    const sim = createBubbles(MAX, 1920);
    const on = frame({ mode: MODES.champagne, streams: true });
    for (let i = 0; i < 20 * 30; i++) {
      sim.step(1 / 20, on, data, BUBBLE_FLOATS);
    }
    sim.step(1 / 60, { ...on, streams: false }, data, BUBBLE_FLOATS);
    for (let i = 0; i < MAX; i++) {
      expect(sim.parked[i]).toBe(0);
    }
  });

  it("fades out bubbles when the count drops, then stops simulating them", () => {
    const sim = createBubbles(MAX, 1920);
    sim.step(1 / 60, frame({ count: 300 }), data, BUBBLE_FLOATS);
    for (let i = 0; i < 120; i++) {
      sim.step(1 / 60, frame({ count: 300 }), data, BUBBLE_FLOATS);
    }
    const high = sim.live;
    sim.step(1 / 60, frame({ count: 50 }), data, BUBBLE_FLOATS);
    expect(sim.live).toBe(high);
    for (let i = 0; i < 120; i++) {
      sim.step(1 / 60, frame({ count: 50 }), data, BUBBLE_FLOATS);
    }
    expect(sim.live).toBe(sim.target);
  });

  it("starts an emitter column at emitY and keeps it narrow and above the emitter", () => {
    const mode = {
      ...MODES.aquarium,
      density: 1,
      streamShare: 1,
      emitters: [0.1],
      emitY: 0.8,
      emitJitter: 6,
    };
    const sim = createBubbles(MAX, 1920);
    const f = frame({ mode, streams: true, count: 60, size: 4 });
    const bad: string[] = [];
    let seen = 0;
    for (let i = 0; i < 20 * 40; i++) {
      const n = sim.step(1 / 20, f, data, BUBBLE_FLOATS);
      for (let k = 0; k < n; k++) {
        const o = k * BUBBLE_FLOATS;
        // Small bubbles barely zigzag: the column stays within a few px of x = 192.
        if (Math.abs(data[o] - 192) > ZIG_PX + 6) {
          bad.push(`x ${String(data[o])}`);
        }
        if (data[o + 1] > 0.8 * 1080 + 0.01) {
          bad.push(`y ${String(data[o + 1])}`);
        }
        seen++;
      }
    }
    expect(bad).toEqual([]);
    expect(seen).toBeGreaterThan(0);
    expect(sim.emitted[0]).toBeGreaterThan(20);
    // The rate covers the shorter climb from the emitter.
    expect(sim.rates[0]).toBeGreaterThan(0);
  });

  it("is unchanged by the emitter option's defaults", () => {
    const a = createBubbles(MAX, 1920, 3);
    const b = createBubbles(MAX, 1920, 3);
    const plain = frame({ mode: MODES.champagne, streams: true });
    const explicit = frame({ mode: { ...MODES.champagne, emitJitter: 3 }, streams: true });
    for (let i = 0; i < 200; i++) {
      a.step(1 / 30, plain, data, BUBBLE_FLOATS);
      b.step(1 / 30, explicit, data, BUBBLE_FLOATS);
    }
    expect(Array.from(a.ys)).toEqual(Array.from(b.ys));
    expect(Array.from(a.xs)).toEqual(Array.from(b.xs));
  });

  it("freezes at speed 0", () => {
    const sim = createBubbles(MAX, 1920);
    const f = frame({ speed: 0 });
    sim.step(1 / 60, f, data, BUBBLE_FLOATS);
    const ys = Array.from(sim.ys);
    for (let i = 0; i < 30; i++) {
      sim.step(1 / 60, f, data, BUBBLE_FLOATS);
    }
    expect(Array.from(sim.ys)).toEqual(ys);
  });
});
