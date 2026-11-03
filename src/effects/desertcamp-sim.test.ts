import { describe, expect, it } from "vitest";
import {
  BAND,
  createCampLayout,
  createFireState,
  createMeteorPose,
  createMeteors,
  createSparks,
  DENSITY_MAX,
  DUNE_CHANNELS,
  DUNE_COLUMNS,
  DUNE_TOP,
  duneHeightAt,
  FIRE_FLICKER_RANGE,
  fireAt,
  fillDuneTable,
  layoutCamp,
  MAX_SPARKS,
  METEOR_MEAN_GAP,
  METEOR_MIN_GAP,
  meteorAt,
  POLE_DX,
  POLE_Y,
  REF_HEIGHT,
  sandLight,
  skyPole,
  sparkGlow,
  stepMeteors,
  stepSparks,
  TENT_HALF_W,
} from "./desertcamp-sim";
import { createNoise } from "./noise";
import {
  bandAcross,
  fillStars,
  seedSalt,
  STAR_FLOATS,
  type StarfieldLayout,
  TAU,
  toSky,
  wrapAngle,
  advanceRotation,
} from "./starfield-sim";

const WIDTHS = [1440, 1920, 2520];

const table = (seed: number, w: number) => {
  const t = new Float32Array(DUNE_COLUMNS * DUNE_CHANNELS);
  fillDuneTable(t, seed, w);
  return t;
};

describe("sky", () => {
  it("puts the pole above the frame and the Milky Way across the upper sky at every width", () => {
    const pole: [number, number] = [0, 0];
    const q: [number, number] = [0, 0];
    for (const w of WIDTHS) {
      skyPole(w, pole);
      expect(pole[1]).toBeGreaterThan(REF_HEIGHT);
      expect(pole[0]).toBe(w / 2 + POLE_DX);
      // The band's centre line crosses the frame at rotation 0, above the dunes.
      let hits = 0;
      for (let x = 0; x <= w; x += 20) {
        for (let y = DUNE_TOP * REF_HEIGHT; y <= REF_HEIGHT; y += 20) {
          toSky(x - pole[0], y - pole[1], 0, q);
          if (Math.abs(bandAcross(BAND, q[0], q[1])) < 10) hits++;
        }
      }
      expect(hits).toBeGreaterThan(20);
    }
    expect(POLE_Y).toBeGreaterThan(REF_HEIGHT);
  });

  it("has a deterministic star field", () => {
    const layout: StarfieldLayout = {
      salt: seedSalt(3),
      density: DENSITY_MAX * 0.6,
      pole: skyPole(1920, [0, 0]),
      refWidth: 1920,
      refHeight: REF_HEIGHT,
      rotates: true,
      margin: 4,
    };
    const a = new Float32Array(64000 * STAR_FLOATS);
    const b = new Float32Array(64000 * STAR_FLOATS);
    const n = fillStars(a, 64000, layout);
    expect(fillStars(b, 64000, layout)).toBe(n);
    let same = true;
    for (let i = 0; i < n * STAR_FLOATS; i++) same &&= a[i] === b[i];
    expect(same).toBe(true);
    // Under the cap at the default density.
    expect(n).toBeLessThan(64000);
  });

  it("rotates continuously through a full wrap", () => {
    let rot = TAU - 0.01;
    let prev = wrapAngle(rot);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      rot = advanceRotation(rot, 1 / 60, 20);
      const w = wrapAngle(rot);
      // A star's screen position is continuous: compare via cos/sin.
      worst = Math.max(
        worst,
        Math.hypot(Math.cos(w) - Math.cos(prev), Math.sin(w) - Math.sin(prev)),
      );
      prev = w;
    }
    expect(worst).toBeLessThan(1e-4);
  });
});

describe("dunes", () => {
  it("are deterministic, layered and below the sky", () => {
    for (const w of WIDTHS) {
      const a = table(5, w);
      const b = table(5, w);
      let same = true;
      let ok = true;
      for (let i = 0; i < a.length; i++) same &&= a[i] === b[i];
      for (let c = 0; c < DUNE_COLUMNS; c++) {
        const o = c * DUNE_CHANNELS;
        for (let l = 0; l < 3; l++) ok &&= a[o + l] > 0.04 && a[o + l] <= DUNE_TOP + 1e-6;
        ok &&= Number.isFinite(a[o + 3]) && Math.abs(a[o + 3]) < 3;
      }
      expect(same).toBe(true);
      expect(ok).toBe(true);
    }
    const a = table(5, 1920);
    const b = table(6, 1920);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
    expect(diff).toBeGreaterThan(0.01);
  });

  it("store the near dune's slope", () => {
    const t = table(9, 1920);
    const aspect = 1920 / REF_HEIGHT;
    let worst = 0;
    for (let c = 1; c < DUNE_COLUMNS - 1; c++) {
      const fd =
        (t[(c + 1) * DUNE_CHANNELS] - t[(c - 1) * DUNE_CHANNELS]) /
        ((2 * aspect) / (DUNE_COLUMNS - 1));
      worst = Math.max(worst, Math.abs(fd - t[c * DUNE_CHANNELS + 3]));
    }
    expect(worst).toBeLessThan(0.02);
  });
});

describe("camp layout", () => {
  it("puts the fire at its edge on the near dune and the tent beside it, out of the centre third", () => {
    for (const w of WIDTHS) {
      const t = table(2, w);
      for (const fire of ["left", "right", "none"]) {
        const l = layoutCamp(createCampLayout(), t, fire, w);
        expect(l.fire).toBe(fire !== "none");
        const crest = (x: number) => duneHeightAt(t, 0, x / w) * REF_HEIGHT;
        expect(l.fireY).toBeLessThan(Math.max(crest(l.fireX), 60));
        expect(l.fireY).toBeGreaterThan(0);
        expect(fire === "right" ? l.fireX > (2 * w) / 3 : l.fireX < w / 3).toBe(true);
        const lo = l.tentX - TENT_HALF_W;
        const hi = l.tentX + TENT_HALF_W;
        expect(lo > 0 && hi < w).toBe(true);
        expect(hi <= w / 3 || lo >= (2 * w) / 3).toBe(true);
      }
    }
  });

  it("lights the sand less with distance, more on faces turned to the fire", () => {
    expect(sandLight(10, 0, 0)).toBeGreaterThan(sandLight(200, 0, 0));
    expect(sandLight(200, 0, 0)).toBeGreaterThan(sandLight(600, 0, 0));
    expect(sandLight(0, 40, 0)).toBeGreaterThan(sandLight(0, 120, 0));
    // Right of the fire, a slope rising to the right faces it.
    expect(sandLight(150, 0, 0.4)).toBeGreaterThan(sandLight(150, 0, -0.4));
    expect(sandLight(-150, 0, -0.4)).toBeGreaterThan(sandLight(-150, 0, 0.4));
  });
});

describe("fire", () => {
  it("flickers within its bounds, under 2 Hz", () => {
    const noise = createNoise(11);
    const s = createFireState();
    const dt = 1 / 120;
    let lo = Infinity;
    let hi = -Infinity;
    let maxRate = 0;
    let prev = fireAt(noise, 0, s).light;
    for (let i = 1; i < 120 * 120; i++) {
      const v = fireAt(noise, i * dt, s).light;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      maxRate = Math.max(maxRate, Math.abs(v - prev) / dt);
      prev = v;
    }
    expect(lo).toBeGreaterThanOrEqual(1 - FIRE_FLICKER_RANGE);
    expect(hi).toBeLessThanOrEqual(1 + FIRE_FLICKER_RANGE);
    // A few percent.
    expect(FIRE_FLICKER_RANGE).toBeLessThan(0.1);
    expect(hi - lo).toBeGreaterThan(0.01);
    // Bernstein: a signal of amplitude A with nothing above f changes at most 2π f A per second.
    expect(maxRate).toBeLessThanOrEqual(2 * Math.PI * 2 * FIRE_FLICKER_RANGE);
  });
});

describe("sparks", () => {
  it("rise from the fire, stay few, fade out and stop when off", () => {
    const s = createSparks(4);
    let maxCount = 0;
    let bad = 0;
    for (let i = 0; i < 60 * 30; i++) {
      stepSparks(s, 1 / 60, true, 200, 100, 0.2);
      maxCount = Math.max(maxCount, s.count);
      for (let k = 0; k < s.count; k++) {
        const g = sparkGlow(s, k);
        if (s.y[k] < 100 || Math.abs(s.x[k] - 200) > 150 || !(g >= 0 && g <= 1)) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(maxCount).toBeLessThanOrEqual(MAX_SPARKS);
    expect(maxCount).toBeGreaterThan(4);
    for (let i = 0; i < 60 * 4; i++) stepSparks(s, 1 / 60, false, 200, 100, 0);
    expect(s.count).toBe(0);
  });
});

describe("meteors", () => {
  it("come at the scheduled rate, never closer than the minimum gap", () => {
    const m = createMeteors(8);
    const hours = 20;
    let prevStart = -Infinity;
    let minGap = Infinity;
    for (let t = 0; t < hours * 3600; t += 0.5) {
      stepMeteors(m, t, true, 1920);
      if (m.current.start !== prevStart) {
        minGap = Math.min(minGap, m.current.start - prevStart);
        prevStart = m.current.start;
      }
    }
    const expected = (hours * 3600) / METEOR_MEAN_GAP;
    expect(m.started / expected).toBeGreaterThan(0.9);
    expect(m.started / expected).toBeLessThan(1.1);
    expect(minGap).toBeGreaterThanOrEqual(METEOR_MIN_GAP - 1e-9);
  });

  it("are deterministic, start nothing while off, and keep out of the centre", () => {
    const a = createMeteors(3);
    const b = createMeteors(3);
    stepMeteors(a, 3000, true, 1920);
    stepMeteors(b, 3000, true, 1920);
    expect(b.current).toEqual(a.current);
    const off = createMeteors(3);
    stepMeteors(off, 3000, false, 1920);
    expect(off.started).toBe(0);
    // Turning them on later doesn't release a burst.
    const before = off.next;
    stepMeteors(off, 3001, true, 1920);
    expect(off.started).toBeLessThanOrEqual(before <= 3001 ? 1 : 0);

    const m = createMeteors(12);
    const pose = createMeteorPose();
    let bad = 0;
    let seen = 0;
    for (let k = 0; k < 200; k++) {
      stepMeteors(m, m.next, true, 1920);
      const c = m.current;
      let peak = 0;
      for (let i = 0; i <= 40; i++) {
        meteorAt(c, c.start + (c.duration * i) / 40, pose);
        if (pose.bright > 0) {
          seen++;
          peak = Math.max(peak, pose.bright);
          const inCentre = (x: number) => x > 640 && x < 1280;
          if (inCentre(pose.headX) || inCentre(pose.tailX) || pose.headY > REF_HEIGHT) bad++;
        }
      }
      if (peak > c.bright + 1e-9) bad++;
      if (meteorAt(c, c.start, pose).bright !== 0) bad++;
      if (meteorAt(c, c.start + c.duration, pose).bright > 1e-9) bad++;
    }
    expect(bad).toBe(0);
    expect(seen).toBeGreaterThan(1000);
  });
});
