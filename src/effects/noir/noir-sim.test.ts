import { describe, expect, it } from "vitest";
import { generateCity } from "../city/city-sim";
import {
  ADVERT_FADE,
  ADVERT_PALETTES,
  ADVERT_PATTERNS,
  advertAt,
  advertChange,
  advertPalette,
  advertPattern,
  CAR_LENGTH,
  CAR_STRIDE,
  carLanes,
  carsAt,
  createAdvertState,
  createSearchState,
  LANE_COUNT,
  MAX_CARS,
  MAX_SEARCH_GAP,
  MAX_SIGNS,
  MIN_SEARCH_GAP,
  roomLayout,
  SEARCH_SECONDS,
  searchAt,
  searchStart,
  SIGN_STRIDE,
  signLayout,
  slatHalfGap,
} from "./noir-sim";

const W = 1920;

function cars(seed: number, traffic: number, t: number, width = W) {
  const lanes = carLanes(seed, width);
  const out = new Float32Array(MAX_CARS * CAR_STRIDE);
  const n = carsAt(lanes, seed, traffic, t, width, out);
  return Array.from({ length: n }, (_, i) =>
    Array.from(out.subarray(i * CAR_STRIDE, (i + 1) * CAR_STRIDE)),
  );
}

describe("car lanes", () => {
  it("are deterministic per seed", () => {
    expect(carLanes(3, W)).toEqual(carLanes(3, W));
    expect(carLanes(4, W)).not.toEqual(carLanes(3, W));
    expect(carLanes(3, W)).toHaveLength(LANE_COUNT);
  });

  it("place the same cars at the same time for a seed", () => {
    for (const t of [0, 12.5, 400, 86400]) {
      expect(cars(9, 0.6, t)).toEqual(cars(9, 0.6, t));
    }
    expect(cars(9, 1, 100)).not.toEqual(cars(10, 1, 100));
  });

  it("never overlap cars in the same lane", () => {
    let firstOverlap: { seed: number; t: number; a: number; b: number; gap: number } | undefined;
    for (const seed of [1, 7, 99]) {
      const lanes = carLanes(seed, W);
      const out = new Float32Array(MAX_CARS * CAR_STRIDE);
      for (let t = 0; t < 600; t += 1.7) {
        const n = carsAt(lanes, seed, 1, t, W, out);
        for (let a = 0; a < n; a++) {
          for (let b = a + 1; b < n; b++) {
            const oa = a * CAR_STRIDE;
            const ob = b * CAR_STRIDE;
            // Lanes have distinct depths, so equal depth means the same lane.
            if (out[oa + 2] !== out[ob + 2]) {
              continue;
            }
            const gap = Math.abs(out[oa] - out[ob]);
            if (!firstOverlap && !(gap > CAR_LENGTH * 2)) {
              firstOverlap = { seed, t, a, b, gap };
            }
          }
        }
      }
    }
    expect(firstOverlap).toBeUndefined();
  });

  it("move smoothly, appearing and vanishing only off screen", () => {
    const seed = 5;
    const lanes = carLanes(seed, W);
    const out = new Float32Array(MAX_CARS * CAR_STRIDE);
    const dt = 1 / 60;
    const offScreen = (x: number) => x < -CAR_LENGTH || x > W + CAR_LENGTH;
    const problems: string[] = [];
    let prev: Map<number, number> | null = null;
    for (let t = 0; t < 240; t += dt) {
      const n = carsAt(lanes, seed, 0.7, t, W, out);
      const now = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const o = i * CAR_STRIDE;
        const id = out[o + 5];
        const speed = Math.abs(lanes[Math.floor(id / 1000)].speed);
        now.set(id, out[o]);
        if (!prev) {
          continue;
        }
        const before = prev.get(id);
        if (before === undefined && !offScreen(out[o])) {
          problems.push(`car ${String(id)} appeared at ${String(out[o])}`);
        }
        const jump = before === undefined ? 0 : Math.abs(out[o] - before);
        if (jump > speed * dt * 1.01 + 1e-3 && !(offScreen(before ?? 0) && offScreen(out[o]))) {
          problems.push(`car ${String(id)} jumped ${String(jump)} px`);
        }
      }
      for (const [id, x] of prev ?? []) {
        if (!now.has(id) && !offScreen(x)) {
          problems.push(`car ${String(id)} vanished at ${String(x)}`);
        }
      }
      prev = now;
    }
    expect(problems).toEqual([]);
  });

  it("follow the traffic level", () => {
    const count = (traffic: number) => {
      let total = 0;
      for (let t = 0; t < 300; t += 5) {
        total += cars(2, traffic, t).filter((c) => c[4] > 0).length;
      }
      return total;
    };
    expect(count(0)).toBe(0);
    expect(count(0.3)).toBeLessThan(count(0.7));
    expect(count(0.7)).toBeLessThan(count(1));
  });
});

describe("searchlight", () => {
  it("keeps its minimum gap between sweeps", () => {
    for (const seed of [0, 1, 7, 123]) {
      for (let k = 0; k < 200; k++) {
        const gap = searchStart(k + 1, seed) - searchStart(k, seed);
        expect(gap).toBeGreaterThanOrEqual(MIN_SEARCH_GAP);
        expect(gap).toBeLessThanOrEqual(MAX_SEARCH_GAP);
        expect(gap).toBeGreaterThan(SEARCH_SECONDS);
      }
    }
  });

  it("is deterministic per seed", () => {
    const a = createSearchState();
    const b = createSearchState();
    for (let t = 0; t < 400; t += 3.3) {
      expect(searchAt(t, 4, a)).toEqual(searchAt(t, 4, b));
    }
  });

  it("fades its beam and room stripes in and out continuously", () => {
    const s = createSearchState();
    const dt = 1 / 120;
    let beam = 0;
    let room = 0;
    let peak = 0;
    let sweepsIntoRoom = 0;
    let wasLit = false;
    let idleLight = 0;
    let step = 0;
    let roomOverBeam = -Infinity;
    for (let t = 0; t < 1200; t += dt) {
      searchAt(t, 11, s);
      // Checked once at the end: an `expect` per step dominates the run time.
      step = Math.max(step, Math.abs(s.beam - beam), Math.abs(s.room - room));
      roomOverBeam = Math.max(roomOverBeam, s.room - s.beam);
      idleLight += s.active ? 0 : s.beam + s.room;
      const lit = s.room > 0.5;
      if (lit && !wasLit) {
        sweepsIntoRoom++;
      }
      wasLit = lit;
      peak = Math.max(peak, s.room);
      beam = s.beam;
      room = s.room;
    }
    // At most a full change per second: every ramp takes at least a second.
    expect(step).toBeLessThanOrEqual(dt * 0.75);
    expect(roomOverBeam).toBeLessThanOrEqual(1e-12);
    expect(idleLight).toBe(0);
    expect(peak).toBeGreaterThan(0.9);
    expect(sweepsIntoRoom).toBeGreaterThan(3);
  });

  it("slides its stripes across the room over a few seconds", () => {
    const s = createSearchState();
    const litSweeps: { lit: number; slide: number; spot: number }[] = [];
    for (let k = 0; k < 40; k++) {
      const start = searchStart(k, 3);
      let lit = 0;
      let slideMin = Infinity;
      let slideMax = -Infinity;
      let spotMin = Infinity;
      let spotMax = -Infinity;
      for (let t = start; t < start + SEARCH_SECONDS; t += 0.01) {
        searchAt(t, 3, s);
        if (s.room > 0.5) {
          lit += 0.01;
          slideMin = Math.min(slideMin, s.slide);
          slideMax = Math.max(slideMax, s.slide);
          spotMin = Math.min(spotMin, s.spot);
          spotMax = Math.max(spotMax, s.spot);
        }
      }
      if (lit > 0) {
        litSweeps.push({ lit, slide: slideMax - slideMin, spot: spotMax - spotMin });
      }
    }
    expect(litSweeps.length).toBeGreaterThan(10);
    for (const sweep of litSweeps) {
      expect(sweep.lit).toBeGreaterThan(2);
      expect(sweep.lit).toBeLessThan(3.5);
      expect(sweep.slide).toBeGreaterThan(0.3);
      expect(sweep.spot).toBeGreaterThan(1.2);
    }
  });
});

describe("advert", () => {
  it("changes scene every 10 to 20 seconds", () => {
    for (let k = -2; k < 100; k++) {
      const gap = advertChange(k + 1, 8) - advertChange(k, 8);
      expect(gap).toBeGreaterThanOrEqual(10);
      expect(gap).toBeLessThanOrEqual(20);
      expect(advertPalette(k + 1, 8)).not.toBe(advertPalette(k, 8));
      expect(advertPalette(k, 8)).toBeGreaterThanOrEqual(0);
      expect(advertPalette(k, 8)).toBeLessThan(ADVERT_PALETTES.length);
      expect(advertPattern(k, 8)).toBeLessThan(ADVERT_PATTERNS);
    }
  });

  it("cross-fades continuously", () => {
    const a = createAdvertState();
    let scene = advertAt(0, 2, a).scene;
    let mix = a.mix;
    const dt = 1 / 60;
    const problems: string[] = [];
    let changes = 0;
    for (let t = dt; t < 300; t += dt) {
      advertAt(t, 2, a);
      if (a.scene !== scene) {
        changes++;
        // A new scene starts from the old one, fully faded in.
        if (a.scene !== scene + 1 || mix !== 1 || a.mix > 0.01) {
          problems.push(`jump at ${String(t)}`);
        }
      } else if (Math.abs(a.mix - mix) > (1.5 * dt) / ADVERT_FADE + 1e-9) {
        problems.push(`fade step at ${String(t)}`);
      }
      scene = a.scene;
      mix = a.mix;
    }
    expect(problems).toEqual([]);
    expect(changes).toBeGreaterThan(10);
  });
});

describe("room", () => {
  it("frames the glass inside the window wall", () => {
    for (const w of [1440, 1920, 2520]) {
      const r = roomLayout(w);
      expect(r.wallX0).toBeLessThan(r.glassX0 - r.frame);
      expect(r.glassX1 + r.frame).toBeLessThan(r.wallX1);
      expect(r.wallY0).toBeLessThan(r.glassY0 - r.frame);
      expect(r.glassY1 + r.frame).toBeLessThan(r.wallY1);
      // The camera maps the wall's edges to where they are drawn.
      const halfRoom = ((r.wallX1 - w / 2) * r.depth) / r.focal;
      expect(w / 2 + (r.focal * halfRoom) / r.depth).toBeCloseTo(r.wallX1, 6);
    }
  });

  it("opens the slats as the blinds open", () => {
    expect(slatHalfGap(0)).toBeGreaterThan(slatHalfGap(0.5));
    expect(slatHalfGap(0.5)).toBeGreaterThan(slatHalfGap(1));
    expect(slatHalfGap(1)).toBeGreaterThan(0);
    expect(slatHalfGap(0)).toBeLessThan(0.5);
  });
});

describe("signs", () => {
  it("keep out of the middle of the frame", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const city = generateCity(seed, 0.75, W);
      const out = new Float32Array(MAX_SIGNS * SIGN_STRIDE);
      const n = signLayout(city, seed, out);
      expect(n).toBeLessThanOrEqual(MAX_SIGNS);
      for (let i = 0; i < n; i++) {
        const o = i * SIGN_STRIDE;
        const mid = (out[o] + out[o + 2] / 2) / W;
        expect(Math.abs(mid - 0.5)).toBeGreaterThan(0.05);
      }
    }
  });
});
