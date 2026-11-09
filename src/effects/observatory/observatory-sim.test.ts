import { describe, expect, it } from "vitest";
import { type Meteor, METEOR_MIN_GAP } from "../desertcamp/desertcamp-sim";
import {
  ALT_RANGE,
  angleDiff,
  applyReschedule,
  AZ_RANGE,
  azAltDir,
  axesFor,
  azimuthOf,
  CAM_X,
  CAM_Y,
  CAM_Z,
  createPose,
  createReschedule,
  createSlitMeteors,
  createTarget,
  decAxis,
  DOME_LAG,
  DOME_R,
  DOME_SETTLE,
  ease,
  easeLights,
  LIGHT_FADE,
  pointing,
  POLAR,
  poseAt,
  project,
  REF_HEIGHT,
  reschedule,
  RESCHEDULE_TIME,
  SIDEREAL,
  sideX,
  skyPole,
  SLEW_JITTER,
  SLEW_MAX,
  SLEW_MIN,
  slewDuration,
  slewStart,
  SLIT_FROM,
  SLIT_HALF,
  SLIT_PAST,
  slitBounds,
  stepSlitMeteors,
  TARGET_KINDS,
  targetOf,
  WALL_H,
} from "./observatory-sim";
import { MAX_SLEW_GAP, MIN_SLEW_GAP } from "./observatory.meta";

const DEG = Math.PI / 180;
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The azimuth the tube points at in `pose`. */
const tubeAz = (p: { ha: number; dec: number }) => azimuthOf(pointing(p.ha, p.dec, [0, 0, 0]));

describe("mount geometry", () => {
  it("points the tube along unit vectors square to the declination axis", () => {
    const t = [0, 0, 0];
    const d = [0, 0, 0];
    for (const [ha, dec] of [
      [0, 0],
      [-1.2, 1.1],
      [2.5, -0.4],
    ]) {
      pointing(ha, dec, t);
      decAxis(ha, d);
      expect(Math.hypot(t[0], t[1], t[2])).toBeCloseTo(1, 12);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
      expect(dot(t, d)).toBeCloseTo(0, 12);
      expect(dot(d, POLAR)).toBeCloseTo(0, 12);
      expect(dot(t, POLAR)).toBeCloseTo(Math.sin(dec), 12);
    }
  });

  it("inverts pointing with axesFor", () => {
    const dir = [0, 0, 0];
    const axes: [number, number] = [0, 0];
    const back = [0, 0, 0];
    for (const [az, alt] of [
      [10 * DEG, 55 * DEG],
      [35 * DEG, 70 * DEG],
      [-20 * DEG, 30 * DEG],
    ]) {
      azAltDir(az, alt, dir);
      axesFor(dir, axes);
      pointing(axes[0], axes[1], back);
      for (let i = 0; i < 3; i++) {
        expect(back[i]).toBeCloseTo(dir[i], 10);
      }
      expect(azimuthOf(back)).toBeCloseTo(az, 10);
    }
  });

  it("measures angle differences the short way round", () => {
    expect(angleDiff(0.1, 0.3)).toBeCloseTo(0.2, 12);
    expect(angleDiff(3, -3)).toBeCloseTo(2 * Math.PI - 6, 12);
    expect(angleDiff(-3, 3)).toBeCloseTo(6 - 2 * Math.PI, 12);
  });

  it("puts the sky's pole where the polar axis projects", () => {
    const pole: [number, number] = [0, 0];
    const far: [number, number] = [0, 0];
    skyPole(1920, pole);
    const k = 1e6;
    expect(
      project(CAM_X + POLAR[0] * k, CAM_Y + POLAR[1] * k, CAM_Z + POLAR[2] * k, 1920, far),
    ).toBe(true);
    expect(far[0]).toBeCloseTo(960, 6);
    expect(far[1]).toBeCloseTo(pole[1], 3);
    // Above the slit's lower end, inside the frame.
    expect(pole[1]).toBeGreaterThan(REF_HEIGHT / 2);
    expect(pole[1]).toBeLessThan(REF_HEIGHT);
  });

  it("mirrors x for the telescope on the right", () => {
    expect(sideX(300, 1920, "left")).toBe(300);
    expect(sideX(300, 1920, "right")).toBe(1620);
  });
});

describe("targets", () => {
  it("stay in range, vary in kind and move a fair way each slew", () => {
    const a = createTarget();
    const b = createTarget();
    const kinds = new Set<number>();
    for (const seed of [0, 7, 431]) {
      for (let k = -2; k < 60; k++) {
        targetOf(seed, k, a);
        targetOf(seed, k + 1, b);
        expect(a.az).toBeGreaterThanOrEqual(AZ_RANGE[0]);
        expect(a.az).toBeLessThanOrEqual(AZ_RANGE[1]);
        expect(a.alt).toBeGreaterThanOrEqual(ALT_RANGE[0]);
        expect(a.alt).toBeLessThanOrEqual(ALT_RANGE[1]);
        expect(a.kind).toBeGreaterThanOrEqual(0);
        expect(a.kind).toBeLessThan(TARGET_KINDS);
        kinds.add(a.kind);
        const move = Math.hypot(b.az - a.az, b.alt - a.alt);
        expect(move).toBeGreaterThan(3 * DEG);
      }
    }
    expect(kinds.size).toBe(TARGET_KINDS);
  });

  it("are deterministic for a seed", () => {
    const a = targetOf(12, 5, createTarget());
    const b = targetOf(12, 5, createTarget());
    expect(a).toEqual(b);
    expect(targetOf(13, 5, createTarget())).not.toEqual(a);
  });
});

describe("slew schedule", () => {
  it("respects the slew gap", () => {
    for (const gap of [MIN_SLEW_GAP, 180, 420, MAX_SLEW_GAP]) {
      for (let k = -1; k < 80; k++) {
        const a = slewStart(5, gap, k);
        const b = slewStart(5, gap, k + 1);
        expect(b - a).toBeGreaterThanOrEqual((1 - SLEW_JITTER) * gap - 1e-9);
        expect(b - a).toBeLessThanOrEqual((1 + SLEW_JITTER) * gap + 1e-9);
        // The dome has settled well before the next slew starts.
        expect(a + slewDuration(5, k) + DOME_SETTLE).toBeLessThan(b);
      }
    }
    // Gaps outside the range are clamped.
    expect(slewStart(5, 1, 3)).toBe(slewStart(5, MIN_SLEW_GAP, 3));
    expect(slewStart(5, 1e6, 3)).toBe(slewStart(5, MAX_SLEW_GAP, 3));
  });

  it("takes 10 to 20 s per slew", () => {
    for (let k = 0; k < 200; k++) {
      const d = slewDuration(9, k);
      expect(d).toBeGreaterThanOrEqual(SLEW_MIN);
      expect(d).toBeLessThanOrEqual(SLEW_MAX);
    }
  });

  it("moves continuously, with every slew in its slot", () => {
    const gap = MIN_SLEW_GAP;
    const prev = createPose();
    const pose = createPose();
    const dt = 0.05;
    poseAt(3, gap, 0, prev);
    const starts: number[] = [];
    // Fastest an axis can turn: a full turn eased over the shortest slew.
    const maxStep = (2 * Math.PI * 1.875 * dt) / SLEW_MIN;
    // The biggest step of each axis, checked once after the run.
    let ha = 0;
    let dec = 0;
    let dome = 0;
    for (let t = dt; t < 12 * gap; t += dt) {
      poseAt(3, gap, t, pose);
      ha = Math.max(ha, Math.abs(angleDiff(prev.ha, pose.ha)));
      dec = Math.max(dec, Math.abs(pose.dec - prev.dec));
      dome = Math.max(dome, Math.abs(angleDiff(prev.dome, pose.dome)));
      if (pose.to !== prev.to) {
        // Each new slew follows the last and has only just begun.
        starts.push(pose.to - prev.to, pose.slew);
      }
      prev.ha = pose.ha;
      prev.dec = pose.dec;
      prev.dome = pose.dome;
      prev.to = pose.to;
    }
    expect(ha).toBeLessThan(maxStep);
    expect(dec).toBeLessThan(maxStep);
    expect(dome).toBeLessThan(maxStep);
    expect(starts.length / 2).toBeGreaterThanOrEqual(11);
    for (let i = 0; i < starts.length; i += 2) {
      expect(starts[i]).toBe(1);
      expect(starts[i + 1]).toBeLessThan(0.01);
    }
  });

  it("eases in and out: barely moving at a slew's ends, fastest in the middle", () => {
    const a = createPose();
    const b = createPose();
    const h = 0.02;
    for (let k = 1; k < 6; k++) {
      const s = slewStart(2, 200, k);
      const d = slewDuration(2, k);
      const speed = (t: number) => {
        poseAt(2, 200, t, a);
        poseAt(2, 200, t + h, b);
        return Math.hypot(angleDiff(a.ha, b.ha), b.dec - a.dec) / h;
      };
      const mid = speed(s + d / 2);
      expect(mid).toBeGreaterThan(0.01);
      expect(speed(s + 1e-3)).toBeLessThan(mid * 0.01);
      expect(speed(s + d - h - 1e-3)).toBeLessThan(mid * 0.01);
      // Arrived: just tracking at the sidereal rate.
      expect(speed(s + d + 1)).toBeCloseTo(SIDEREAL, 9);
    }
  });

  it("tracks the target between slews", () => {
    const pose = createPose();
    const dir = [0, 0, 0];
    const axes: [number, number] = [0, 0];
    const k = 4;
    const s = slewStart(8, 300, k);
    const target = targetOf(8, k, createTarget());
    axesFor(azAltDir(target.az, target.alt, dir), axes);
    const t = s + 100;
    poseAt(8, 300, t, pose);
    expect(pose.to).toBe(k);
    expect(pose.dec).toBeCloseTo(axes[1], 12);
    expect(angleDiff(axes[0] + SIDEREAL * 100, pose.ha)).toBeCloseTo(0, 12);
  });

  it("ends every slew with the dome in line with the telescope", () => {
    const pose = createPose();
    for (const seed of [0, 1, 99]) {
      for (const gap of [MIN_SLEW_GAP, 240, MAX_SLEW_GAP]) {
        for (let k = 0; k < 20; k++) {
          const s = slewStart(seed, gap, k);
          const d = slewDuration(seed, k);
          for (const after of [0, 0.5, 10]) {
            poseAt(seed, gap, s + d + DOME_SETTLE + after, pose);
            expect(Math.abs(angleDiff(pose.dome, tubeAz(pose)))).toBeLessThan(1e-9);
          }
        }
      }
    }
  });

  it("lags the dome behind the telescope during a slew", () => {
    const pose = createPose();
    const lags: number[] = [];
    for (let k = 1; k < 10; k++) {
      const s = slewStart(6, 200, k);
      poseAt(6, 200, s + DOME_LAG * 0.9, pose);
      // Not yet turning: still where the previous target left it.
      const before = createPose();
      poseAt(6, 200, s - 0.01, before);
      expect(Math.abs(angleDiff(before.dome, pose.dome))).toBeLessThan(1e-3);
      poseAt(6, 200, s + slewDuration(6, k) * 0.5, pose);
      const start = tubeAz(before);
      const scope = angleDiff(start, tubeAz(pose));
      const dome = angleDiff(start, pose.dome);
      // How far the dome has turned, as a share of the telescope's turn so far.
      lags.push(Math.abs(scope) > 1e-3 ? Math.abs(dome) / Math.abs(scope) : 0);
    }
    expect(lags.filter((x) => x > 0).length).toBeGreaterThan(5);
    expect(Math.max(...lags)).toBeLessThan(1);
  });

  it("is a pure function of time", () => {
    const a = poseAt(4, 150, 1234.5, createPose());
    poseAt(4, 150, 99999, createPose());
    const b = poseAt(4, 150, 1234.5, createPose());
    expect(b).toEqual(a);
    expect(poseAt(4, 150, Number.NaN, createPose())).toEqual(poseAt(4, 150, 0, createPose()));
  });

  it("eases with smootherstep", () => {
    expect(ease(-1)).toBe(0);
    expect(ease(0)).toBe(0);
    expect(ease(0.5)).toBeCloseTo(0.5, 12);
    expect(ease(1)).toBe(1);
    expect(ease(2)).toBe(1);
  });
});

describe("rescheduling", () => {
  it("swings smoothly from the shown pose to the new schedule's", () => {
    const r = createReschedule();
    const oldPose = poseAt(1, 180, 500, createPose());
    const next = poseAt(2, 400, 500, createPose());
    const shown = createPose();
    reschedule(r, oldPose, next, 500);
    applyReschedule(r, next, 500, shown);
    expect(shown.ha).toBeCloseTo(oldPose.ha, 12);
    expect(shown.dec).toBeCloseTo(oldPose.dec, 12);
    expect(shown.dome).toBeCloseTo(oldPose.dome, 12);
    const later = poseAt(2, 400, 500 + RESCHEDULE_TIME, createPose());
    applyReschedule(r, later, 500 + RESCHEDULE_TIME, shown);
    expect(shown.ha).toBe(later.ha);
    expect(shown.dome).toBe(later.dome);
  });

  it("leaves the pose alone with no change pending", () => {
    const pose = poseAt(1, 180, 77, createPose());
    const shown = applyReschedule(createReschedule(), pose, 77, createPose());
    expect(shown).toEqual(pose);
  });
});

describe("work lights", () => {
  it("fade over LIGHT_FADE seconds", () => {
    let v = 1;
    for (let i = 0; i < 10; i++) {
      v = easeLights(v, 0, LIGHT_FADE / 20);
    }
    expect(v).toBeCloseTo(0.5, 9);
    expect(easeLights(0.3, 1, Number.NaN)).toBe(0.3);
  });
});

describe("the slit on screen", () => {
  it("bounds every point of the opening", () => {
    const bounds = [0, 0, 0, 0];
    const p: [number, number] = [0, 0];
    for (const side of ["left", "right"]) {
      for (const dome of [AZ_RANGE[0] - 0.1, 0.3, AZ_RANGE[1] + 0.1]) {
        slitBounds(dome, 1920, side, bounds);
        const fx = Math.sin(dome);
        const fz = -Math.cos(dome);
        for (let i = 0; i <= 40; i++) {
          for (let j = 0; j <= 10; j++) {
            const across = SLIT_HALF * (2 * (j / 10) - 1);
            const top = Math.sqrt(DOME_R * DOME_R - across * across);
            const lo = -SLIT_PAST;
            const hi = Math.sqrt(
              Math.max(0, (DOME_R * Math.cos(SLIT_FROM)) ** 2 - across * across),
            );
            const along = lo + ((Math.min(hi, top) - lo) * i) / 40;
            const up = Math.sqrt(Math.max(0, DOME_R * DOME_R - along * along - across * across));
            const x = fx * along - fz * across;
            const z = fz * along + fx * across;
            if (!project(x, WALL_H + up, z, 1920, p)) {
              continue;
            }
            const sx = sideX(p[0], 1920, side);
            if (sx < 0 || sx > 1920 || p[1] < 0 || p[1] > REF_HEIGHT) {
              continue;
            }
            expect(sx).toBeGreaterThanOrEqual(bounds[0]);
            expect(sx).toBeLessThanOrEqual(bounds[2]);
            expect(p[1]).toBeGreaterThanOrEqual(bounds[1]);
            expect(p[1]).toBeLessThanOrEqual(bounds[3]);
          }
        }
      }
    }
  });

  it("keeps the sky to the upper part of the frame", () => {
    const bounds = slitBounds(0.3, 1920, "left", [0, 0, 0, 0]);
    expect(bounds[1]).toBeGreaterThan(REF_HEIGHT * 0.4);
    expect(bounds[3]).toBe(REF_HEIGHT);
    expect(bounds[2] - bounds[0]).toBeLessThan(1920);
  });
});

describe("meteors", () => {
  it("come rarely, slowly, high in the slit", () => {
    const m = createSlitMeteors(4);
    const bounds = [0, 0, 0, 0];
    const seen: Meteor[] = [];
    slitBounds(0.35, 1920, "right", bounds);
    for (let t = 0; t < 3600; t += 0.5) {
      stepSlitMeteors(m, t, true, 0.35, 1920, "right");
      if (m.current.start !== (seen.at(-1)?.start ?? -Infinity)) {
        seen.push({ ...m.current });
      }
    }
    expect(m.started).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.length).toBeLessThan(60);
    for (let i = 0; i < seen.length; i++) {
      const c = seen[i];
      expect(c.start - (i > 0 ? seen[i - 1].start : -Infinity)).toBeGreaterThanOrEqual(
        METEOR_MIN_GAP,
      );
      expect(c.x).toBeGreaterThan(bounds[0]);
      expect(c.x).toBeLessThan(bounds[2]);
      expect(c.y).toBeGreaterThan(REF_HEIGHT * 0.6);
      expect(c.dy).toBeLessThan(0);
      expect(c.duration).toBeGreaterThanOrEqual(1.4);
    }
  });

  it("start none when off", () => {
    const m = createSlitMeteors(4);
    stepSlitMeteors(m, 3600, false, 0.2, 1920, "left");
    expect(m.started).toBe(0);
    expect(m.next).toBeGreaterThan(3600);
  });
});
