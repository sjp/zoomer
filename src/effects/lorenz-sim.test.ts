import { describe, expect, it } from "vitest";
import {
  advanceOrbit,
  anchorX,
  buildTrajectory,
  deriv,
  EDGE_MARGIN,
  FADE_IN,
  flowStep,
  MAX_DT,
  ORBIT_RATE,
  paletteColor,
  PALETTES,
  PARTICLE_FLOATS,
  project,
  respawnChance,
  rk4Scratch,
  rk4Step,
  seedParticles,
  SIZE,
  SUBSTEPS,
  SYSTEMS,
  systemFor,
  paletteFor,
  trailKeep,
  TRAJ_SAMPLES,
  type Trajectory,
} from "./lorenz-sim";
import { PALETTE_OPTIONS, SYSTEM_OPTIONS } from "./lorenz.meta";
import { defined } from "../test/defined";

const TAU = Math.PI * 2;
const ids = SYSTEM_OPTIONS.map((o) => o.value);
const trajectories = new Map(ids.map((id) => [id, buildTrajectory(SYSTEMS[id])]));
const trajOf = (id: (typeof ids)[number]): Trajectory => defined(trajectories.get(id));

/** Framed radius (cylinder) and height of a system point. */
function framed(t: Trajectory, x: number, y: number, z: number): [number, number] {
  return [Math.hypot(x - t.centre[0], y - t.centre[1]) * t.norm, (z - t.centre[2]) * t.norm];
}

describe("systems", () => {
  it("has one system per option, with distinct shader indices", () => {
    expect(Object.keys(SYSTEMS).toSorted()).toEqual([...ids].toSorted());
    expect(new Set(ids.map((id) => SYSTEMS[id].index)).size).toBe(ids.length);
    expect(systemFor("nope")).toBe(SYSTEMS.lorenz);
  });

  it("computes the Lorenz derivative", () => {
    const out = new Float64Array(3);
    deriv(SYSTEMS.lorenz, 1, 2, 3, out);
    expect(out[0]).toBeCloseTo(10 * (2 - 1));
    expect(out[1]).toBeCloseTo(1 * (28 - 3) - 2);
    expect(out[2]).toBeCloseTo(1 * 2 - (8 / 3) * 3);
  });

  it("RK4 is fourth order", () => {
    // Halving the step should cut the error over a fixed span by about 16x.
    const sys = SYSTEMS.lorenz;
    const k = rk4Scratch();
    const run = (h: number) => {
      const p = Float64Array.from([1, 1, 20]);
      for (let i = 0; i < Math.round(0.2 / h); i++) {
        rk4Step(sys, p, h, k);
      }
      return p;
    };
    const ref = run(0.0005);
    const e1 = Math.hypot(...run(0.01).map((v, i) => v - ref[i]));
    const e2 = Math.hypot(...run(0.005).map((v, i) => v - ref[i]));
    expect(e1 / e2).toBeGreaterThan(10);
    expect(e1 / e2).toBeLessThan(24);
  });

  it.each(ids)("RK4 at the GPU step stays on the %s attractor over a long run", (id) => {
    const sys = SYSTEMS[id];
    const t = trajOf(id);
    // The largest per-substep step the effect uses (speed 2, a hitched frame).
    const h = flowStep(MAX_DT, 2, sys) / SUBSTEPS;
    const k = rk4Scratch();
    const p = Float64Array.from(t.points.subarray(0, 3));
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
      rk4Step(sys, p, h, k);
      const [r, z] = framed(t, p[0], p[1], p[2]);
      worst = Math.max(worst, r, Math.abs(z));
    }
    expect(Number.isFinite(worst)).toBe(true);
    expect(worst).toBeLessThan(1.2);
  });
});

describe("buildTrajectory", () => {
  it.each(ids)("frames the %s trajectory in the unit cylinder", (id) => {
    const t = trajOf(id);
    expect(t.points.length).toBe(TRAJ_SAMPLES * 4);
    let worst = 0;
    let finite = true;
    for (let i = 0; i < TRAJ_SAMPLES; i++) {
      const o = i * 4;
      finite &&= [0, 1, 2].every((a) => Number.isFinite(t.points[o + a])) && t.points[o + 3] === 1;
      const [r, z] = framed(t, t.points[o], t.points[o + 1], t.points[o + 2]);
      worst = Math.max(worst, r, Math.abs(z));
    }
    expect(finite).toBe(true);
    expect(worst).toBeLessThanOrEqual(1 + 1e-6);
    expect(worst).toBeGreaterThan(0.999);
    expect(t.speedHi).toBeGreaterThan(t.speedLo);
    expect(t.speedLo).toBeGreaterThan(0);
  });

  it("puts the trajectory on the attractor: integrating on from a sample tracks it", () => {
    // Each stored sample is the previous one advanced by stride steps.
    const sys = SYSTEMS.lorenz;
    const t = trajOf("lorenz");
    const k = rk4Scratch();
    const p = Float64Array.from(t.points.subarray(400, 403));
    for (let s = 0; s < sys.stride; s++) {
      rk4Step(sys, p, sys.step, k);
    }
    for (let a = 0; a < 3; a++) {
      expect(p[a]).toBeCloseTo(t.points[404 + a], 3);
    }
  });

  it("visits both Lorenz wings, coloured apart", () => {
    const t = trajOf("lorenz");
    const w = SYSTEMS.lorenz.wing;
    let agree = 0;
    const both = [0, 0];
    for (let i = 0; i < TRAJ_SAMPLES; i++) {
      const o = i * 4;
      const x = t.points[o];
      const q = [0, 1, 2].map((a) => (t.points[o + a] - t.centre[a]) * t.norm);
      const d = q[0] * w[0] + q[1] * w[1] + q[2] * w[2];
      if (Math.sign(d) === Math.sign(x)) {
        agree++;
      }
      both[x > 0 ? 1 : 0]++;
    }
    expect(agree / TRAJ_SAMPLES).toBeGreaterThan(0.9);
    expect(Math.min(...both) / TRAJ_SAMPLES).toBeGreaterThan(0.25);
  });

  it("is deterministic", () => {
    const again = buildTrajectory(SYSTEMS.thomas);
    expect(again.points).toEqual(trajOf("thomas").points);
    expect(again.norm).toBe(trajOf("thomas").norm);
  });
});

describe("seedParticles", () => {
  it.each(ids)("seeds %s particles on the attractor, visible at once", (id) => {
    const t = trajOf(id);
    const n = 5000;
    const out = seedParticles(t, n, 1, new Float32Array(n * PARTICLE_FLOATS));
    // Every seed lies within the jitter of some trajectory sample.
    let worst = 0;
    let ageOk = true;
    for (let i = 0; i < n; i += 50) {
      const o = i * PARTICLE_FLOATS;
      let best = Infinity;
      for (let s = 0; s < TRAJ_SAMPLES; s++) {
        const dx = out[o] - t.points[s * 4];
        const dy = out[o + 1] - t.points[s * 4 + 1];
        const dz = out[o + 2] - t.points[s * 4 + 2];
        best = Math.min(best, dx * dx + dy * dy + dz * dz);
      }
      worst = Math.max(worst, Math.sqrt(best) * t.norm);
      ageOk &&= out[o + 3] >= FADE_IN;
    }
    expect(worst).toBeLessThan(0.01);
    expect(ageOk).toBe(true);
  });

  it("is deterministic per seed and spreads over the trajectory", () => {
    const t = trajOf("lorenz");
    const a = seedParticles(t, 2000, 7, new Float32Array(2000 * 4));
    const b = seedParticles(t, 2000, 7, new Float32Array(2000 * 4));
    expect(a).toEqual(b);
    let right = 0;
    for (let i = 0; i < 2000; i++) {
      if (a[i * 4] > 0) {
        right++;
      }
    }
    expect(right / 2000).toBeGreaterThan(0.25);
    expect(right / 2000).toBeLessThan(0.75);
  });
});

describe("timing", () => {
  it("clamps the frame time so a hitch doesn't jump the flow", () => {
    const sys = SYSTEMS.lorenz;
    expect(flowStep(1 / 60, 1, sys)).toBeCloseTo(sys.rate / 60);
    expect(flowStep(5, 1, sys)).toBeCloseTo(sys.rate * MAX_DT);
    expect(flowStep(-1, 1, sys)).toBe(0);
    expect(flowStep(Number.NaN, 1, sys)).toBe(0);
    expect(respawnChance(0)).toBe(0);
    expect(respawnChance(1 / 60)).toBeGreaterThan(0);
    expect(respawnChance(1 / 60)).toBeLessThan(0.01);
  });

  it("decays trails by a frame-rate independent amount", () => {
    expect(trailKeep(1 / 60) ** 2).toBeCloseTo(trailKeep(1 / 30), 10);
    expect(trailKeep(0)).toBe(1);
    expect(trailKeep(Number.NaN)).toBe(1);
  });
});

describe("advanceOrbit", () => {
  it("is continuous and wraps into [0, 2 pi)", () => {
    let a = 0;
    let prev = 0;
    let worstJump = 0;
    let inRange = true;
    let wraps = 0;
    for (let i = 0; i < 10000; i++) {
      a = advanceOrbit(a, 1 / 60, 1);
      inRange &&= a >= 0 && a < TAU;
      // The step, measured around the circle.
      let d = a - prev;
      if (d < -Math.PI) {
        d += TAU;
        wraps++;
      }
      worstJump = Math.max(worstJump, Math.abs(d - ORBIT_RATE / 60));
      prev = a;
    }
    expect(inRange).toBe(true);
    expect(worstJump).toBeLessThan(1e-9);
    expect(wraps).toBe(Math.floor(((10000 / 60) * ORBIT_RATE) / TAU));
  });

  it("runs backwards for a negative orbit and holds for zero or a bad dt", () => {
    expect(advanceOrbit(0.1, 1, -1)).toBeCloseTo(0.1 - ORBIT_RATE);
    expect(advanceOrbit(0.001, 1, -1)).toBeCloseTo(TAU + 0.001 - ORBIT_RATE);
    expect(advanceOrbit(1, 1, 0)).toBe(1);
    expect(advanceOrbit(1, Number.NaN, 1)).toBe(1);
    expect(advanceOrbit(TAU + 1, 0, 1)).toBeCloseTo(1);
  });
});

describe("framing", () => {
  it("projects the centre to the anchor and nearer points larger", () => {
    const out = new Float64Array(4);
    project(0, 0, 0, 1, 0, out);
    expect([...out]).toEqual([0, 0, 0, 1]);
    // Yaw 0: +y faces the viewer.
    project(0, 0.5, 0, 1, 0, out);
    expect(out[2]).toBeGreaterThan(0);
    expect(out[3]).toBeGreaterThan(1);
    // A quarter turn swaps x into depth.
    project(1, 0, 0, Math.cos(Math.PI / 2), Math.sin(Math.PI / 2), out);
    expect(out[0]).toBeCloseTo(0);
  });

  it.each(["left", "right", "centre"])(
    "keeps every system on a 16:9 screen at %s for every yaw",
    (position) => {
      const aspect = 16 / 9;
      const ax = anchorX(position, aspect);
      const out = new Float64Array(4);
      let lo = Infinity;
      let hi = -Infinity;
      let top = -Infinity;
      for (const id of ids) {
        const t = trajOf(id);
        for (let y = 0; y < 12; y++) {
          const yaw = (y / 12) * TAU;
          for (let i = 0; i < TRAJ_SAMPLES; i += 7) {
            const o = i * 4;
            project(
              (t.points[o] - t.centre[0]) * t.norm,
              (t.points[o + 1] - t.centre[1]) * t.norm,
              (t.points[o + 2] - t.centre[2]) * t.norm,
              Math.cos(yaw),
              Math.sin(yaw),
              out,
            );
            const x = ax + out[0] * SIZE;
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
            top = Math.max(top, Math.abs(out[1] * SIZE));
          }
        }
      }
      expect(lo).toBeGreaterThan(-aspect / 2 + EDGE_MARGIN);
      expect(hi).toBeLessThan(aspect / 2 - EDGE_MARGIN);
      expect(top).toBeLessThan(0.5 - EDGE_MARGIN);
    },
  );

  it("puts the side anchors outside the middle third on 16:9", () => {
    expect(anchorX("left", 16 / 9)).toBeLessThan(-16 / 9 / 6);
    expect(anchorX("right", 16 / 9)).toBeGreaterThan(16 / 9 / 6);
  });

  it("pulls the side anchor in on narrow screens and centres unknown positions", () => {
    expect(anchorX("centre", 2)).toBe(0);
    expect(anchorX("bogus", 2)).toBe(0);
    expect(anchorX("left", 2)).toBe(-anchorX("right", 2));
    expect(anchorX("right", 0.5)).toBeGreaterThanOrEqual(0);
    expect(anchorX("right", 0.5)).toBeLessThan(0.25);
  });
});

describe("palettes", () => {
  it("has one palette per option, all in gamut", () => {
    expect(Object.keys(PALETTES).toSorted()).toEqual(
      PALETTE_OPTIONS.map((o) => o.value).toSorted(),
    );
    expect(paletteFor("bogus")).toBe(PALETTES.cyanamber);
    const c = new Float64Array(3);
    let ok = true;
    for (const p of Object.values(PALETTES)) {
      for (let t = 0; t <= 1; t += 0.05) {
        paletteColor(p, t, c);
        ok &&= c.every((v) => v >= -1e-9 && v <= 1 + 1e-9);
      }
    }
    expect(ok).toBe(true);
  });

  it("colours the two wings cyan and amber", () => {
    const c = new Float64Array(3);
    paletteColor(PALETTES.cyanamber, 0, c);
    expect(c[0]).toBeGreaterThan(c[2]); // amber
    paletteColor(PALETTES.cyanamber, 1, c);
    expect(c[2]).toBeGreaterThan(c[0]); // cyan
  });
});
