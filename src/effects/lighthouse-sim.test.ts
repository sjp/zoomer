import { describe, expect, it } from "vitest";
import {
  advancePhase,
  BEAM_MAX_LENGTH,
  BEAM_MIN_LENGTH,
  beamAngle,
  CLIFF_START,
  createBeamProjection,
  easeTilt,
  flareAt,
  flareTotal,
  headlandHeight,
  HORIZON,
  LAND_END,
  lanternHeight,
  MAX_TILT,
  projectBeam,
  TOWER_D,
  towerBase,
  Y_WATER,
} from "./lighthouse-sim";

const TURN = 3600;
const angle = (i: number) => (i / TURN) * Math.PI * 2;

describe("projectBeam", () => {
  it("is brightest facing the viewer, then pointing away, and faintest side-on", () => {
    const b = createBeamProjection();
    let best = -1;
    let bestAt = -1;
    for (let i = 0; i < TURN; i++) {
      projectBeam(angle(i), b);
      if (b.brightness > best) {
        best = b.brightness;
        bestAt = i;
      }
    }
    expect(bestAt).toBe(0);
    const front = projectBeam(0, b).brightness;
    const back = projectBeam(Math.PI, b).brightness;
    const side = projectBeam(Math.PI / 2, b).brightness;
    expect(front).toBeGreaterThan(back);
    expect(back).toBeGreaterThan(side);
    expect(front).toBeLessThanOrEqual(1);
  });

  it("is shortest pointing at or away from the viewer and longest side-on", () => {
    const b = createBeamProjection();
    expect(projectBeam(0, b).length).toBeCloseTo(BEAM_MIN_LENGTH);
    expect(projectBeam(Math.PI, b).length).toBeCloseTo(BEAM_MIN_LENGTH);
    expect(projectBeam(Math.PI / 2, b).length).toBeCloseTo(BEAM_MAX_LENGTH);
    expect(projectBeam(-Math.PI / 2, b).length).toBeCloseTo(BEAM_MAX_LENGTH);
    for (let i = 0; i < TURN; i++) {
      const l = projectBeam(angle(i), b).length;
      expect(l).toBeGreaterThanOrEqual(BEAM_MIN_LENGTH - 1e-12);
      expect(l).toBeLessThanOrEqual(BEAM_MAX_LENGTH + 1e-12);
    }
  });

  it("points right and left on opposite halves of the turn, narrow side-on and round head-on", () => {
    const b = createBeamProjection();
    expect(projectBeam(Math.PI / 2, b).dirX).toBe(1);
    expect(b.roundness).toBeCloseTo(0);
    expect(b.cosHalf).toBeGreaterThan(0.99);
    expect(projectBeam(-Math.PI / 2, b).dirX).toBe(-1);
    expect(projectBeam(0, b).roundness).toBe(1);
    expect(b.cosHalf).toBeCloseTo(0);
  });

  it("is continuous through a full turn, including where the direction flips", () => {
    const b = createBeamProjection();
    projectBeam(angle(-1), b);
    let prev = { ...b, wedge: b.dirX * (1 - b.roundness) };
    for (let i = 0; i <= TURN; i++) {
      projectBeam(angle(i), b);
      const wedge = b.dirX * (1 - b.roundness);
      expect(Math.abs(b.brightness - prev.brightness)).toBeLessThan(0.01);
      expect(Math.abs(b.length - prev.length)).toBeLessThan(0.01);
      expect(Math.abs(b.cosHalf - prev.cosHalf)).toBeLessThan(0.05);
      expect(Math.abs(b.roundness - prev.roundness)).toBeLessThan(0.01);
      // The direction only matters as much as the wedge is not round.
      expect(Math.abs(wedge - prev.wedge)).toBeLessThan(0.01);
      prev = { ...b, wedge };
    }
  });
});

describe("projectBeam with tilt", () => {
  it("points straight left or right at zero tilt", () => {
    const b = createBeamProjection();
    for (let i = 0; i < TURN; i += 37) {
      projectBeam(angle(i), b, 0);
      expect(b.dirY).toBeCloseTo(0, 12);
      expect(Math.abs(b.dirX)).toBeCloseTo(1, 12);
    }
  });

  it("points below level, most steeply facing the viewer, and never opens fully round", () => {
    const b = createBeamProjection();
    for (const tilt of [5, 15, MAX_TILT]) {
      projectBeam(0, b, tilt);
      expect(b.dirX).toBeCloseTo(0);
      expect(b.dirY).toBeCloseTo(-1);
      expect(b.roundness).toBeLessThan(1);
      for (let i = 0; i < TURN; i += 7) {
        projectBeam(angle(i), b, tilt);
        expect(b.dirY).toBeLessThan(0);
        expect(Math.hypot(b.dirX, b.dirY)).toBeCloseTo(1);
        expect(b.length).toBeGreaterThan(BEAM_MIN_LENGTH);
      }
      // Side-on, the beam dips by the tilt itself.
      projectBeam(Math.PI / 2, b, tilt);
      expect(Math.atan2(-b.dirY, b.dirX)).toBeCloseTo((tilt * Math.PI) / 180);
    }
  });

  it("is continuous through a full turn when tilted", () => {
    const b = createBeamProjection();
    for (const tilt of [1, 10, MAX_TILT]) {
      projectBeam(angle(-1), b, tilt);
      let prev = { ...b };
      for (let i = 0; i <= TURN; i++) {
        projectBeam(angle(i), b, tilt);
        // The direction only matters as much as the wedge is not round.
        const open = 1 - b.roundness;
        expect(Math.abs(b.dirX - prev.dirX) * open).toBeLessThan(0.02);
        expect(Math.abs(b.dirY - prev.dirY) * open).toBeLessThan(0.02);
        expect(Math.abs(b.brightness - prev.brightness)).toBeLessThan(0.01);
        expect(Math.abs(b.length - prev.length)).toBeLessThan(0.01);
        expect(Math.abs(b.roundness - prev.roundness)).toBeLessThan(0.01);
        prev = { ...b };
      }
    }
  });
});

describe("easeTilt", () => {
  it("starts at the target, then eases toward it slowly and clamps", () => {
    expect(easeTilt(Number.NaN, 12, 0.016)).toBe(12);
    expect(easeTilt(Number.NaN, 99, 0.016)).toBe(MAX_TILT);
    let t = 0;
    t = easeTilt(t, 20, 1);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(5);
    for (let i = 0; i < 600; i++) t = easeTilt(t, 20, 0.1);
    expect(t).toBe(20);
    expect(easeTilt(5, Number.NaN, 100)).toBe(0);
  });
});

describe("beamAngle", () => {
  it("puts the second beam 180° from the first", () => {
    for (const phase of [0, 0.13, 0.5, 0.99]) {
      expect(beamAngle(phase, 1) - beamAngle(phase, 0)).toBeCloseTo(Math.PI);
    }
  });

  it("turns once per period", () => {
    let phase = 0.25;
    for (let i = 0; i < 120; i++) phase = advancePhase(phase, 0.1, 12);
    expect(phase).toBeCloseTo(0.25);
    expect(advancePhase(0.5, 1, 0)).toBe(0.5);
  });
});

describe("flare", () => {
  it("is bounded and peaks once per turn per beam", () => {
    for (const beams of [1, 2]) {
      let peaks = 0;
      const at = (i: number) => flareTotal(((i % TURN) + TURN) / TURN, beams);
      for (let i = 0; i < TURN; i++) {
        const v = at(i);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        if (v > 0.5 && v >= at(i - 1) && v > at(i + 1)) peaks++;
      }
      expect(peaks).toBe(beams);
    }
  });

  it("peaks facing the viewer and is about 10-15° wide at half height", () => {
    expect(flareAt(0)).toBe(1);
    expect(flareAt(Math.PI * 2)).toBeCloseTo(1);
    const deg = (d: number) => (d * Math.PI) / 180;
    expect(flareAt(deg(5))).toBeGreaterThan(0.5);
    expect(flareAt(deg(8))).toBeLessThan(0.5);
    expect(flareAt(Math.PI / 2)).toBeLessThan(1e-6);
  });

  it("dims as the beam tilts below the viewer", () => {
    expect(flareAt(0, 0)).toBe(1);
    expect(flareAt(0, 5)).toBeLessThan(1);
    expect(flareAt(0, 10)).toBeLessThan(flareAt(0, 5));
    expect(flareAt(0, MAX_TILT)).toBeLessThan(1e-4);
    expect(flareTotal(0, 2, 5)).toBeCloseTo(flareAt(0, 5));
  });
});

describe("scene layout", () => {
  it("stands the tower on the plateau and the lantern above the horizon", () => {
    expect(towerBase()).toBeGreaterThan(HORIZON);
    expect(towerBase()).toBeLessThan(headlandHeight(TOWER_D));
    expect(lanternHeight()).toBeGreaterThan(towerBase() + 0.15);
    expect(lanternHeight()).toBeLessThan(0.8);
    expect(TOWER_D).toBeLessThan(CLIFF_START);
  });

  it("drops the headland below the waterline before it ends", () => {
    expect(headlandHeight(0)).toBeGreaterThan(HORIZON);
    expect(headlandHeight(LAND_END)).toBeLessThan(Y_WATER);
  });
});
