import { describe, expect, it } from "vitest";
import {
  BEACH_PRESETS,
  beachFront,
  beachPreset,
  BIRD_FADE,
  BIRD_FLIGHT,
  BIRD_FLOATS,
  BIRD_SPEED_MAX,
  birdState,
  buildClouds,
  CLOUD_H,
  CLOUD_W,
  createBeachScheduler,
  depthAt,
  faceHeight,
  HEIGHT_MAX,
  localTime,
  PEEL_KEEP,
  PEEL_MAX,
  FLAP_HZ,
  fillWaveTable,
  HORIZON,
  INTERVAL_HIGH,
  layoutClouds,
  layoutSand,
  LIFETIME,
  MAX_PRINTS,
  MAX_STONES,
  MAX_WAVES,
  N_BOTTOM,
  PRINT_FLOATS,
  REACH_MAX,
  REACH_HIGH,
  rowFresnel,
  rowForN,
  screenDx,
  SHORE_Y,
  shoreN,
  SPACING_MIN,
  STONE_FLOATS,
  STONE_N_MIN,
  sunDx,
  TOWEL_N,
  WAVE_COLUMNS,
  WAVE_ROWS,
  waveHeight,
  waveInterval,
  waveReach,
  worldX,
} from "./beachday-sim";
import { TIME_OPTIONS } from "./beachday.meta";
import { T_ACTIVE, T_APPROACH, T_STOP } from "../wash";

describe("projection", () => {
  it("puts the horizon and waterline where the framing needs them", () => {
    expect(HORIZON).toBeGreaterThanOrEqual(0.55);
    expect(HORIZON).toBeLessThanOrEqual(0.6);
    expect(SHORE_Y).toBeGreaterThanOrEqual(0.25);
    expect(SHORE_Y).toBeLessThanOrEqual(1 / 3);
    expect(shoreN(SHORE_Y)).toBeCloseTo(0, 9);
  });

  it("maps rows to shore normals and back", () => {
    for (const y of [0, 0.1, 0.25, 0.3, 0.45, 0.55]) {
      expect(rowForN(shoreN(y))).toBeCloseTo(y, 9);
    }
    // Landward is down the frame, and distance grows towards the horizon.
    expect(shoreN(0.1)).toBeGreaterThan(shoreN(0.2));
    expect(depthAt(0.5)).toBeGreaterThan(depthAt(0.2));
  });

  it("maps along-shore positions and back", () => {
    for (const [dx, y] of [
      [0.4, 0.1],
      [-0.7, 0.29],
      [0.2, 0.5],
    ]) {
      expect(screenDx(worldX(dx, y), shoreN(y))).toBeCloseTo(dx, 9);
    }
  });

  it("keeps every wave's wash on the sand below the waterline and above the frame's bottom", () => {
    const highest = rowForN(REACH_HIGH * REACH_MAX);
    expect(highest).toBeGreaterThan(0.1);
    expect(highest).toBeLessThan(SHORE_Y);
  });

  it("gives grazing water a high reflectance and steep water a low one", () => {
    expect(rowFresnel(HORIZON - 0.001)).toBeGreaterThan(0.9);
    expect(rowFresnel(0)).toBeLessThan(0.2);
    expect(rowFresnel(0.1)).toBeLessThan(rowFresnel(0.4));
  });
});

describe("presets", () => {
  it("covers every time option, with the sun lower in each", () => {
    let prev = Infinity;
    for (const { value } of TIME_OPTIONS) {
      const p = BEACH_PRESETS[value];
      expect(p).toBeDefined();
      expect(p.sunY).toBeLessThan(prev);
      expect(p.sunY).toBeGreaterThan(p.disc);
      expect(HORIZON + p.sunY + p.disc).toBeLessThan(1);
      prev = p.sunY;
    }
    expect(beachPreset("nonsense")).toBe(BEACH_PRESETS.afternoon);
  });

  it("puts the sun off to the named side, clear of the middle", () => {
    expect(sunDx("left", 16 / 9)).toBeLessThan(-0.4);
    expect(sunDx("right", 16 / 9)).toBeGreaterThan(0.4);
  });
});

describe("beachFront", () => {
  it("approaches, runs up to its reach and drains back to the waterline", () => {
    expect(beachFront(0, 1.5)).toBeLessThan(-20);
    expect(beachFront(T_STOP, 1.5)).toBeCloseTo(1.5, 9);
    expect(beachFront(T_ACTIVE + 1, 1.5)).toBe(0);
  });
});

describe("waves", () => {
  it("arrives every 7 to 12 seconds, more often for bigger waves", () => {
    expect(waveInterval(0)).toBe(12);
    expect(waveInterval(1)).toBe(7);
    expect(waveInterval(0.4)).toBeLessThan(waveInterval(0.2));
    expect(waveReach(1)).toBeGreaterThan(waveReach(0));
  });

  it("never needs more than MAX_WAVES slots", () => {
    expect(LIFETIME / (INTERVAL_HIGH * SPACING_MIN)).toBeLessThanOrEqual(MAX_WAVES);
    const sched = createBeachScheduler(3);
    let maxCount = 0;
    for (let t = 0; t < 600; t += 0.1) {
      sched.step(0.1, 1);
      maxCount = Math.max(maxCount, sched.count);
    }
    expect(maxCount).toBeLessThanOrEqual(MAX_WAVES);
    // About 600 s / ~7 s each, none dropped.
    expect(sched.spawned).toBeGreaterThan(70);
  });

  it("schedules deterministically per seed, with varied run-ups", () => {
    const run = (seed: number) => {
      const sched = createBeachScheduler(seed);
      const reaches: number[] = [];
      let last = -1;
      for (let t = 0; t < 120; t += 0.25) {
        sched.step(0.25, 0.4);
        if (sched.spawned !== last) {
          last = sched.spawned;
          reaches.push(sched.waves[sched.count - 1].reach);
        }
      }
      return reaches;
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
    const r = run(5);
    expect(Math.max(...r) - Math.min(...r)).toBeGreaterThan(0.2);
  });

  it("restarts on reset", () => {
    const sched = createBeachScheduler(1);
    for (let i = 0; i < 100; i++) {
      sched.step(0.5, 0.4);
    }
    sched.reset(1);
    expect(sched.count).toBe(0);
    expect(sched.time).toBe(0);
  });

  it("fills the wave table with the front peeling across the frame", () => {
    const sched = createBeachScheduler(9);
    const table = new Float32Array(WAVE_COLUMNS * WAVE_ROWS * 4).fill(7);
    sched.step(0, 0.4);
    sched.step(5, 0.4);
    fillWaveTable(sched, 1, table);
    const w = sched.waves[0];
    const at = (c: number) => table[c * 4];
    // The side the break starts from is further along its run-up.
    const first = w.peelDir > 0 ? 0 : WAVE_COLUMNS - 1;
    const last = w.peelDir > 0 ? WAVE_COLUMNS - 1 : 0;
    expect(at(first)).toBeGreaterThan(at(last));
    // Empty slots are zeroed.
    const stride = WAVE_COLUMNS * 4;
    for (let i = sched.count; i < MAX_WAVES; i++) {
      expect(table.subarray(2 * i * stride, (2 * i + 2) * stride).every((v) => v === 0)).toBe(true);
    }
  });
});

describe("localTime", () => {
  const wave = {
    start: 10,
    reach: 1,
    peelDir: 1,
    peelSpan: PEEL_MAX,
    phaseA: 0,
    phaseB: 0,
    height: 0.3,
  };

  it("is continuous and increasing everywhere on the frame", () => {
    for (const u of [0, 0.3, 1]) {
      let prev = localTime(wave, 10, u);
      for (let t = 10.01; t < 10 + LIFETIME; t += 0.01) {
        const tau = localTime(wave, t, u);
        expect(tau - prev).toBeGreaterThan(0);
        expect(tau - prev).toBeLessThan(0.02);
        prev = tau;
      }
    }
  });

  it("rolls in level, breaks first at the start side, and lands nearly level", () => {
    expect(localTime(wave, 12, 0)).toBe(localTime(wave, 12, 1));
    // The far side breaks a peel span after the near side.
    expect(localTime(wave, 10 + T_APPROACH, 0)).toBeCloseTo(T_APPROACH, 9);
    expect(localTime(wave, 10 + T_APPROACH + PEEL_MAX, 1)).toBeCloseTo(T_APPROACH, 9);
    const lag = (t: number) => localTime(wave, t, 0) - localTime(wave, t, 1);
    expect(lag(10 + T_ACTIVE + 3)).toBeCloseTo(PEEL_KEEP * PEEL_MAX, 9);
    expect(lag(10 + T_ACTIVE + 3)).toBeLessThan(lag(10 + T_APPROACH + PEEL_MAX));
  });
});

describe("faceHeight", () => {
  it("rises to the wave's height at the break and is gone before the run-up stops", () => {
    expect(faceHeight(0, 0.4)).toBe(0);
    expect(faceHeight(T_APPROACH, 0.4)).toBeCloseTo(0.4, 2);
    expect(faceHeight(T_STOP, 0.4)).toBe(0);
    let prev = 0;
    let peak = 0;
    for (let t = 0; t < T_STOP + 1; t += 0.01) {
      const h = faceHeight(t, 0.4);
      expect(Math.abs(h - prev)).toBeLessThan(0.01);
      peak = Math.max(peak, h);
      prev = h;
    }
    expect(peak).toBeLessThanOrEqual(0.4);
  });

  it("stays knee high", () => {
    expect(waveHeight(1) * HEIGHT_MAX).toBeLessThan(0.7);
    expect(waveHeight(0)).toBeGreaterThan(0.15);
  });
});

describe("layoutSand", () => {
  it("is deterministic per seed", () => {
    expect(layoutSand(4, 16 / 9, "left", true)).toEqual(layoutSand(4, 16 / 9, "left", true));
    expect(layoutSand(4, 16 / 9, "left", true).stones).not.toEqual(
      layoutSand(5, 16 / 9, "left", true).stones,
    );
  });

  it("keeps shells and pebbles on visible dry sand, to the sides of the speaker", () => {
    for (const seed of [0, 1, 2, 42, 999]) {
      for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
        const { stones } = layoutSand(seed, aspect, "right", true);
        let used = 0;
        for (let i = 0; i < MAX_STONES; i++) {
          const o = i * STONE_FLOATS;
          if (stones[o + 2] === 0) {
            continue;
          }
          used++;
          const n = stones[o + 1];
          expect(n).toBeGreaterThanOrEqual(STONE_N_MIN);
          expect(n).toBeLessThan(N_BOTTOM);
          const u = 0.5 + screenDx(stones[o], n) / aspect;
          expect(u).toBeGreaterThan(0);
          expect(u).toBeLessThan(1);
          expect(Math.abs(u - 0.5)).toBeGreaterThan(0.15);
        }
        expect(used).toBeGreaterThan(MAX_STONES / 2);
      }
    }
  });

  it("walks the footprints down towards the sea, opposite the towel", () => {
    const { prints, towel } = layoutSand(11, 16 / 9, "left", true);
    let prev = Infinity;
    let used = 0;
    for (let i = 0; i < MAX_PRINTS; i++) {
      const o = i * PRINT_FLOATS;
      if (prints[o + 3] === 0) {
        continue;
      }
      used++;
      expect(prints[o + 1]).toBeLessThan(prev + 0.2);
      prev = prints[o + 1];
      // Sun on the left: the trail is on the left, the towel on the right.
      expect(prints[o]).toBeLessThan(0);
    }
    expect(used).toBeGreaterThan(4);
    expect(towel[0]).toBeGreaterThan(0);
    expect(towel[5]).toBe(1);
  });

  it("puts the towel in the bottom corner, beyond the waves' reach", () => {
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      const { towel } = layoutSand(3, aspect, "right", true);
      const [x, n, hw, hl] = towel;
      expect(x).toBeLessThan(0);
      expect(n - hl).toBeCloseTo(TOWEL_N, 5);
      expect(TOWEL_N).toBeGreaterThan(REACH_HIGH * REACH_MAX + 0.5);
      // Its inner edge shows inside the frame at the bottom.
      const inner = 0.5 + screenDx(x + hw, N_BOTTOM) / aspect;
      expect(inner).toBeGreaterThan(0.1);
      expect(inner).toBeLessThan(0.35);
    }
    expect(layoutSand(3, 16 / 9, "right", false).towel[5]).toBe(0);
  });
});

describe("clouds", () => {
  it("lays out a few clouds, deterministic per seed", () => {
    const a = layoutClouds(8);
    expect(a).toEqual(layoutClouds(8));
    expect(a).not.toEqual(layoutClouds(9));
    expect(a.length).toBeGreaterThan(10);
  });

  it("builds a strip that tiles seamlessly and is mostly clear sky", () => {
    const data = buildClouds(21);
    let covered = 0;
    let seam = 0;
    let inner = 0;
    for (let j = 0; j < CLOUD_H; j++) {
      const row = j * CLOUD_W * 2;
      seam = Math.max(seam, Math.abs(data[row] - data[row + (CLOUD_W - 1) * 2]));
      for (let i = 0; i < CLOUD_W; i++) {
        if (data[row + i * 2] > 128) {
          covered++;
        }
        if (i > 0) {
          inner = Math.max(inner, Math.abs(data[row + i * 2] - data[row + (i - 1) * 2]));
        }
      }
    }
    const share = covered / (CLOUD_W * CLOUD_H);
    expect(share).toBeGreaterThan(0.02);
    expect(share).toBeLessThan(0.35);
    // The wrap is no sharper than steps inside the strip.
    expect(seam).toBeLessThanOrEqual(inner);
  });
});

describe("birdState", () => {
  const sample = (seed: number, index: number, t: number) => {
    const out = new Float32Array(BIRD_FLOATS);
    birdState(t, seed, index, 16 / 9, out);
    return out;
  };

  it("is a pure function of time", () => {
    expect(sample(3, 1, 1234.5)).toEqual(sample(3, 1, 1234.5));
  });

  it("glides slowly and fades in and out without popping", () => {
    const dt = 0.05;
    let flights = 0;
    let maxFade = 0;
    let maxSpeed = 0;
    let maxLift = 0;
    const outside: string[] = [];
    for (const index of [0, 1]) {
      let prev = sample(5, index, 0);
      for (let t = dt; t < 2000; t += dt) {
        const s = sample(5, index, t);
        maxFade = Math.max(maxFade, Math.abs(s[3] - prev[3]));
        const flying = s[3] > 0 && prev[3] > 0;
        const speed = Math.hypot(s[0] - prev[0], s[1] - prev[1]) / dt;
        maxSpeed = Math.max(maxSpeed, flying ? speed : 0);
        maxLift = Math.max(maxLift, flying ? Math.abs(s[4] - prev[4]) / dt : 0);
        const inside = s[0] > 0 && s[0] < 16 / 9 && s[1] > HORIZON && s[1] < HORIZON + 0.16;
        if (s[3] > 0 && !inside && outside.length < 5) {
          outside.push(`${String(index)} @ ${String(t)}: ${String(s[0])}, ${String(s[1])}`);
        }
        if (s[3] > 0 && prev[3] === 0) {
          flights++;
        }
        prev = s;
      }
    }
    expect(maxFade).toBeLessThan((dt / BIRD_FADE) * 1.6);
    expect(maxSpeed).toBeLessThan(BIRD_SPEED_MAX * 1.2);
    // Wing lift changes no faster than a slow wingbeat allows.
    expect(maxLift).toBeLessThan(2 * Math.PI * FLAP_HZ * 0.45);
    expect(outside).toEqual([]);
    // Now and then, not all the time.
    expect(flights).toBeGreaterThan(10);
    expect(flights).toBeLessThan((2 * 2000) / BIRD_FLIGHT);
  });
});
