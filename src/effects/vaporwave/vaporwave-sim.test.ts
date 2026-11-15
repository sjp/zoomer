import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import { BUST_RADIUS } from "./bust-mesh";
import {
  type Box,
  computeLayout,
  createScene,
  FLOOR_CELL,
  floorDriftSpeed,
  floorRowSpeed,
  MAX_SWAY,
  palmBox,
  palmSway,
  REF_HEIGHT,
  REST_ANGLE,
  reseed,
  resizeScene,
  type Scene,
  skyBox,
  SPIN_RATE,
  startScene,
  stepScene,
  trackingBand,
  windowBox,
  windowOffset,
} from "./vaporwave-sim";

/** An angle difference brought into [-π, π], across the wrap. */
const wrapAngle = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

const ASPECTS = [0.5, 9 / 16, 0.75, 1, 4 / 3, 16 / 9, 21 / 9, 3];
const SEEDS = [0, 1, 2, 42, 999];
const CASES = ASPECTS.flatMap((a) => SEEDS.map((s) => [a, s] as const));

const box = (): Box => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
const overlap = (a: Box, b: Box) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
const inside = (a: Box, b: Box) =>
  a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY;

/** Every problem with the dialog boxes' current spots. */
function windowProblems(scene: Scene): string[] {
  const l = scene.layout;
  const sky = skyBox(l);
  const out: string[] = [];
  const live = scene.windows.filter((w) => w.live);
  live.forEach((w, i) => {
    const b = windowBox(l, w.x, w.y, box());
    if (!inside(b, sky)) {
      out.push(`window ${String(i)} outside the sky`);
    }
    if (overlap(b, l.caption)) {
      out.push(`window ${String(i)} over the caption`);
    }
    if (overlap(b, l.clear)) {
      out.push(`window ${String(i)} in the speaker's area`);
    }
    if (overlap(b, l.bust)) {
      out.push(`window ${String(i)} over the bust`);
    }
    live.slice(i + 1).forEach((o, k) => {
      if (overlap(b, windowBox(l, o.x, o.y, box()))) {
        out.push(`windows ${String(i)} and ${String(i + k + 1)} overlap`);
      }
    });
  });
  return out;
}

describe("computeLayout", () => {
  it.each(CASES)("keeps the bust and palms out of the speaker's area at %f, seed %i", (a, seed) => {
    const l = computeLayout(REF_HEIGHT * a, seed);
    expect(overlap(l.bust, l.clear)).toBe(false);
    expect(l.bust.minX).toBeGreaterThanOrEqual(0);
    expect(l.bust.maxY).toBeLessThanOrEqual(REF_HEIGHT);
    for (const p of l.palms) {
      for (const angle of [-MAX_SWAY, 0, MAX_SWAY]) {
        expect(overlap(palmBox(p, angle, box()), l.clear)).toBe(false);
      }
    }
  });

  it("makes the bust smaller and lower on a portrait frame", () => {
    const wide = computeLayout((REF_HEIGHT * 16) / 9, 1);
    const tall = computeLayout((REF_HEIGHT * 9) / 16, 1);
    expect(tall.bustUnit).toBeLessThan(wide.bustUnit * 0.75);
    expect(tall.bust.minY).toBeGreaterThan(wide.bust.minY + 100);
    expect(tall.bust.maxY).toBe(wide.bust.maxY);
  });

  it("lays out the same palms for a seed, and different ones for another", () => {
    const w = (REF_HEIGHT * 16) / 9;
    expect(computeLayout(w, 5).palms).toEqual(computeLayout(w, 5).palms);
    expect(computeLayout(w, 5).palms).not.toEqual(computeLayout(w, 6).palms);
  });
});

describe("dialog boxes", () => {
  it.each(CASES)("start in the sky, clear of everything, at %f, seed %i", (a, seed) => {
    const scene = createScene(seed, REF_HEIGHT * a);
    expect(windowProblems(scene)).toEqual([]);
    const live = scene.windows.filter((w) => w.live).length;
    expect(live).toBeGreaterThanOrEqual(a >= 16 / 9 ? 3 : a >= 1 ? 2 : 1);
  });

  it.each(SEEDS)("stay clear as they move about over ten minutes, seed %i", (seed) => {
    const scene = createScene(seed, (REF_HEIGHT * 16) / 9);
    const serials = scene.windows.map((w) => w.serial);
    const problems = new Set<string>();
    for (let f = 0; f < 600 * 10; f++) {
      stepScene(scene, 0.1, 1, true, false, true);
      for (const p of windowProblems(scene)) {
        problems.add(p);
      }
    }
    expect([...problems]).toEqual([]);
    // Some of them moved.
    expect(scene.windows.map((w) => w.serial)).not.toEqual(serials);
  });

  it("stay clear after a resize", () => {
    const scene = createScene(3, (REF_HEIGHT * 21) / 9);
    resizeScene(scene, (REF_HEIGHT * 9) / 16);
    for (let f = 0; f < 100; f++) {
      stepScene(scene, 0.05, 1, true, false, true);
    }
    expect(windowProblems(scene)).toEqual([]);
  });

  it("fade out when turned off, and back in when on", () => {
    const scene = createScene(1, (REF_HEIGHT * 16) / 9);
    for (let f = 0; f < 60; f++) {
      stepScene(scene, 0.1, 1, true, false, false);
    }
    expect(scene.windows.every((w) => w.alpha === 0)).toBe(true);
    for (let f = 0; f < 60; f++) {
      stepScene(scene, 0.1, 1, true, false, true);
    }
    expect(scene.windows.filter((w) => w.live).every((w) => w.alpha === 1)).toBe(true);
  });

  it("bob only a few px", () => {
    const scene = createScene(1, (REF_HEIGHT * 16) / 9);
    const offset = { x: 0, y: 0 };
    for (let f = 0; f < 600; f++) {
      stepScene(scene, 1 / 30, 1, true, false, true);
      for (const w of scene.windows) {
        windowOffset(scene, w, offset);
        expect(Math.abs(offset.x)).toBeLessThanOrEqual(8);
        expect(Math.abs(offset.y)).toBeLessThanOrEqual(8);
      }
    }
  });
});

describe("a new variation", () => {
  it("fades the palms and dialog boxes out and brings the new ones in", () => {
    const w = (REF_HEIGHT * 16) / 9;
    const scene = createScene(1, w);
    reseed(scene, 2);
    let lowest = 1;
    for (let f = 0; f < 120; f++) {
      stepScene(scene, 0.05, 1, true, false, true);
      lowest = Math.min(lowest, scene.palmAlpha);
    }
    expect(lowest).toBe(0);
    expect(scene.palmAlpha).toBe(1);
    expect(scene.layout.palms).toEqual(computeLayout(w, 2).palms);
    expect(windowProblems(scene)).toEqual([]);
  });
});

describe("motion", () => {
  /** Everything a frame draws that moves. */
  const snapshot = (scene: Scene) => {
    const offset = { x: 0, y: 0 };
    const band = { y: 0, strength: 0 };
    trackingBand(scene, band);
    return {
      angle: scene.angle,
      floor: scene.floor,
      palms: scene.layout.palms.map((p) => palmSway(scene, p)),
      palmAlpha: scene.palmAlpha,
      windows: scene.windows.map((w) => {
        windowOffset(scene, w, offset);
        return [w.x + offset.x, w.y + offset.y, w.alpha, w.serial];
      }),
      band: band.strength,
    };
  };

  it.each([
    [true, true],
    [false, false],
  ])("is a still image at Motion 0 (spin %s, drift %s)", (spin, drift) => {
    const scene = createScene(7, (REF_HEIGHT * 16) / 9);
    startScene(scene, 0, spin, drift, true);
    const first = snapshot(scene);
    for (let f = 0; f < 120 * 60; f++) {
      stepScene(scene, 1 / 60, 0, spin, drift, true);
    }
    expect(snapshot(scene)).toEqual(first);
  });

  it("turns the bust once a minute, and eases it back to rest when stopped", () => {
    const scene = createScene(1, (REF_HEIGHT * 16) / 9);
    for (let f = 0; f < 30 * 60; f++) {
      stepScene(scene, 1 / 60, 1, true, false, true);
    }
    // Half a turn from rest.
    expect(Math.abs(Math.abs(scene.angle - REST_ANGLE) - Math.PI)).toBeLessThan(0.01);
    let last = scene.angle;
    let biggest = 0;
    for (let f = 0; f < 60 * 60; f++) {
      stepScene(scene, 1 / 60, 1, false, false, true);
      const turn = Math.abs(wrapAngle(scene.angle - last));
      biggest = Math.max(biggest, turn);
      last = scene.angle;
    }
    expect(Math.abs(scene.angle - REST_ANGLE)).toBeLessThan(0.01);
    // The way back turns the veins no faster than the spin does.
    const l = computeLayout((REF_HEIGHT * 16) / 9, 1);
    const surface = (biggest * 60 * BUST_RADIUS * l.bustUnit) / REF_HEIGHT;
    expect(pxPerReferenceFrame(surface)).toBeLessThanOrEqual(1);
  });

  it("keeps the floor's drift within the codec limits at full motion", () => {
    const speed = floorDriftSpeed(1);
    expect(speed).toBeGreaterThan(0);
    // Squares pass any point of the screen at the same rate, near or far.
    expect(speed / FLOOR_CELL).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    // The nearest squares, along the bottom edge, move the furthest per frame.
    const l = computeLayout((REF_HEIGHT * 16) / 9, 1);
    const bottom = floorRowSpeed(REF_HEIGHT, l.horizon, speed);
    expect(pxPerReferenceFrame(bottom / REF_HEIGHT)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });

  it("turns the bust's veins slowly enough for a codec", () => {
    const l = computeLayout((REF_HEIGHT * 16) / 9, 1);
    const surface = (SPIN_RATE * BUST_RADIUS * l.bustUnit) / REF_HEIGHT;
    expect(pxPerReferenceFrame(surface)).toBeLessThanOrEqual(1);
  });

  it("rolls the tracking band up the screen and rests between rolls", () => {
    const scene = createScene(1, (REF_HEIGHT * 16) / 9);
    const band = { y: 0, strength: 0 };
    let lastY = -Infinity;
    let rests = 0;
    let backwards = 0;
    for (let f = 0; f < 15 * 30; f++) {
      stepScene(scene, 1 / 30, 1, true, false, true);
      trackingBand(scene, band);
      expect(band.strength).toBeGreaterThanOrEqual(0);
      expect(band.strength).toBeLessThanOrEqual(1);
      if (band.strength > 0) {
        backwards += band.y > lastY ? 0 : 1;
        lastY = band.y;
      } else {
        rests++;
      }
    }
    expect(backwards).toBe(0);
    expect(rests).toBeGreaterThan(5 * 30);
  });
});
