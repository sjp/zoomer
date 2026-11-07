import { describe, expect, it } from "vitest";
import {
  BODY_FLOATS,
  BINARY_A,
  centreFraction,
  createSystem,
  fillBodies,
  fillGlows,
  fillOrbitElements,
  fillOrbitMotion,
  GLOW_FLOATS,
  MAX_BODIES,
  MAX_MOONS,
  meanAnomaly,
  moonPeriod,
  type OrbitSystem,
  type OrbitView,
  orbitPoint,
  planetPeriod,
  resolveKind,
  solveKepler,
  systemPositions,
  TAU,
  wrapAngle,
} from "./orbits-sim";
import { MAX_PLANETS, MIN_PLANETS } from "./orbits.meta";

const KINDS = ["single", "binary"] as const;

/** Every generated preset: both kinds, every planet count, a range of seeds. */
function presets(seeds = 40): OrbitSystem[] {
  const out: OrbitSystem[] = [];
  for (const kind of KINDS) {
    for (let n = MIN_PLANETS; n <= MAX_PLANETS; n++) {
      for (let seed = 0; seed < seeds; seed++) {
        out.push(createSystem(kind, n, seed));
      }
    }
  }
  return out;
}
const ALL = presets();

describe("solveKepler", () => {
  it("converges for eccentricities up to 0.7 over the whole orbit", () => {
    let worst = 0;
    for (let e = 0; e <= 0.7001; e += 0.05) {
      for (let k = -200; k <= 200; k++) {
        const m = (k / 100) * TAU;
        const ea = solveKepler(m, e);
        const mw = m - TAU * Math.floor((m + Math.PI) / TAU);
        worst = Math.max(worst, Math.abs(ea - e * Math.sin(ea) - mw));
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("is already float32-accurate after three steps (the shader runs five)", () => {
    let worst = 0;
    for (let k = 0; k < 400; k++) {
      const m = (k / 400) * TAU;
      const ea = solveKepler(m, 0.7, 3);
      worst = Math.max(
        worst,
        Math.abs(ea - 0.7 * Math.sin(ea) - (m - TAU * Math.floor((m + Math.PI) / TAU))),
      );
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("gives the circle's anomaly when e = 0", () => {
    expect(solveKepler(1.2, 0)).toBeCloseTo(1.2, 12);
  });
});

describe("orbits", () => {
  it("put periapsis and apoapsis at a(1 - e) and a(1 + e) from the focus", () => {
    const p = [0, 0];
    orbitPoint(100, 0.5, 0.3, 0, p);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(50, 9);
    orbitPoint(100, 0.5, 0.3, Math.PI, p);
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(150, 9);
  });

  it("have periods that follow a^1.5", () => {
    expect(planetPeriod(400) / planetPeriod(100)).toBeCloseTo(8, 9);
    expect(moonPeriod(96) / moonPeriod(24)).toBeCloseTo(8, 9);
    let bad = 0;
    for (const sys of ALL) {
      for (const b of sys.bodies) {
        if (b.a === 0) {
          continue;
        }
        const period =
          b.kind === "moon"
            ? moonPeriod(b.a)
            : b.kind === "star"
              ? planetPeriod(BINARY_A)
              : planetPeriod(b.a);
        if (Math.abs(b.n * period - TAU) > 1e-9) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("are continuous and periodic", () => {
    const sys = createSystem("binary", 6, 11);
    const a = new Float64Array(sys.bodies.length * 2);
    const b = new Float64Array(sys.bodies.length * 2);
    let maxStep = 0;
    let maxPeriodErr = 0;
    for (let t = 0; t < 400; t += 0.05) {
      systemPositions(sys, t, a);
      systemPositions(sys, t + 0.01, b);
      for (let i = 0; i < a.length; i++) {
        maxStep = Math.max(maxStep, Math.abs(a[i] - b[i]));
      }
    }
    // A body's own period brings it back to the same place relative to its parent.
    const rel = [0, 0];
    const back = [0, 0];
    for (const body of sys.bodies) {
      if (body.a === 0) {
        continue;
      }
      const period = TAU / body.n;
      for (let t = 0; t < 100; t += 7.3) {
        orbitPoint(body.a, body.e, body.omega, solveKepler(body.m0 + body.n * t, body.e), rel);
        orbitPoint(
          body.a,
          body.e,
          body.omega,
          solveKepler(body.m0 + body.n * (t + period), body.e),
          back,
        );
        maxPeriodErr = Math.max(maxPeriodErr, Math.hypot(rel[0] - back[0], rel[1] - back[1]));
      }
    }
    // The fastest body (a moon) moves well under a pixel in 10 ms.
    expect(maxStep).toBeLessThan(0.5);
    expect(maxPeriodErr).toBeLessThan(1e-6);
  });
});

describe("createSystem", () => {
  it("is deterministic per seed", () => {
    expect(createSystem("single", 5, 3)).toEqual(createSystem("single", 5, 3));
    expect(createSystem("single", 5, 3)).not.toEqual(createSystem("single", 5, 4));
  });

  it("builds the requested planets, a bounded number of moons, stars first", () => {
    let bad = 0;
    for (const sys of ALL) {
      const planets = sys.bodies.filter((b) => b.kind === "planet").length;
      const moons = sys.bodies.filter((b) => b.kind === "moon").length;
      const ordered = sys.bodies.every((b, i) =>
        i < sys.stars
          ? b.kind === "star"
          : i < sys.stars + sys.planets
            ? b.kind === "planet"
            : b.kind === "moon",
      );
      if (
        !ordered ||
        sys.stars !== (sys.kind === "binary" ? 2 : 1) ||
        planets !== sys.planets ||
        moons !== sys.moons ||
        moons > MAX_MOONS ||
        planets + moons > MAX_BODIES ||
        sys.bodies.some(
          (b) => b.parent >= 0 && (b.kind !== "moon" || sys.bodies[b.parent].kind !== "planet"),
        )
      ) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("has orbits that never cross, with moons and rings included", () => {
    let bad = 0;
    let maxApo = 0;
    let moonsSeen = 0;
    let ringsSeen = 0;
    for (const sys of ALL) {
      // The innermost planet clears the star(s).
      let edge = 0;
      for (let s = 0; s < sys.stars; s++) {
        const b = sys.bodies[s];
        edge = Math.max(edge, b.a * (1 + b.e) + b.radius);
      }
      for (let i = sys.stars; i < sys.stars + sys.planets; i++) {
        const b = sys.bodies[i];
        if (b.a * (1 - b.e) - b.reach <= edge) {
          bad++;
        }
        edge = b.a * (1 + b.e) + b.reach;
        maxApo = Math.max(maxApo, edge);
        if (b.ring > 0) {
          ringsSeen++;
        }
        if (b.radius < 3) {
          bad++;
        }
      }
      // Moons fit inside their planet's reach, don't touch the planet or each other.
      for (let i = sys.stars + sys.planets; i < sys.bodies.length; i++) {
        moonsSeen++;
        const m = sys.bodies[i];
        const p = sys.bodies[m.parent];
        if (m.a * (1 + m.e) + m.radius > p.reach + 1e-9 || m.a * (1 - m.e) - m.radius <= p.radius) {
          bad++;
        }
        if (p.ring > 0) {
          bad++;
        }
        const prev = sys.bodies[i - 1];
        if (prev.kind === "moon" && prev.parent === m.parent) {
          if (prev.a * (1 + prev.e) + prev.radius >= m.a * (1 - m.e) - m.radius) {
            bad++;
          }
        }
      }
    }
    expect(bad).toBe(0);
    expect(moonsSeen).toBeGreaterThan(0);
    expect(ringsSeen).toBeGreaterThan(0);
    // Keeps to about the frame: half a 1080 frame plus a little.
    expect(maxApo).toBeLessThan(700);
  });

  it("keeps the binary's centre of mass fixed", () => {
    let worst = 0;
    for (let seed = 0; seed < 20; seed++) {
      const sys = createSystem("binary", 4, seed);
      const [s0, s1] = sys.bodies;
      const pos = new Float64Array(sys.bodies.length * 2);
      for (let t = 0; t < 120; t += 0.37) {
        systemPositions(sys, t, pos);
        const cx = (s0.mass * pos[0] + s1.mass * pos[2]) / (s0.mass + s1.mass);
        const cy = (s0.mass * pos[1] + s1.mass * pos[3]) / (s0.mass + s1.mass);
        worst = Math.max(worst, Math.hypot(cx, cy));
      }
      // The stars stay apart: their separation follows the relative orbit.
      expect(s0.n).toBe(s1.n);
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("keeps a single star at the centre", () => {
    const sys = createSystem("single", 3, 1);
    const pos = new Float64Array(sys.bodies.length * 2);
    systemPositions(sys, 42, pos);
    expect([pos[0], pos[1]]).toEqual([0, 0]);
  });
});

describe("resolveKind", () => {
  it("passes explicit kinds through and picks both for random seeds", () => {
    expect(resolveKind("single", 1)).toBe("single");
    expect(resolveKind("binary", 1)).toBe("binary");
    const kinds = new Set<string>();
    for (let s = 0; s < 20; s++) {
      kinds.add(resolveKind("random", s));
    }
    expect(kinds).toEqual(new Set(["single", "binary"]));
    expect(resolveKind("random", 5)).toBe(resolveKind("random", 5));
  });
});

describe("instance data", () => {
  const view: OrbitView = { cx: 1400, cy: 540, scale: 2, tilt: 0.6 };

  it("sorts bodies farthest first and lights them from the star", () => {
    const sys = createSystem("single", 6, 9);
    const n = sys.bodies.length;
    const pos = new Float64Array(n * 2);
    const out = new Float32Array(MAX_BODIES * BODY_FLOATS);
    const depth = new Float64Array(n);
    const order = new Int32Array(n);
    let bad = 0;
    for (let t = 0; t < 60; t += 3.1) {
      systemPositions(sys, t, pos);
      const count = fillBodies(sys, pos, view, out, depth, order);
      if (count !== n - 1) {
        bad++;
      }
      let prevY = Infinity;
      for (let k = 0; k < count; k++) {
        const o = k * BODY_FLOATS;
        // Farther bodies have larger orbit-plane y (they tilt away), so it never increases.
        const planeY = (view.cy - out[o + 1]) / (Math.cos(view.tilt) * view.scale);
        if (planeY > prevY + 1e-3) {
          bad++;
        }
        prevY = planeY;
        // The light points from the body toward the star (screen y is flipped).
        const dx = view.cx - out[o];
        const dy = out[o + 1] - view.cy;
        if (dx * out[o + 8] + dy * out[o + 9] <= 0) {
          bad++;
        }
        if (Math.abs(Math.hypot(out[o + 8], out[o + 9], out[o + 10]) - 1) > 1e-5) {
          bad++;
        }
        if (out[o + 3] < out[o + 2]) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("places star glows on the stars and fills the orbit uniforms", () => {
    const sys = createSystem("binary", 4, 2);
    const pos = new Float64Array(sys.bodies.length * 2);
    systemPositions(sys, 10, pos);
    const glows = new Float32Array(2 * GLOW_FLOATS);
    expect(fillGlows(sys, pos, view, glows)).toBe(2);
    expect(glows[0]).toBeCloseTo(view.cx + pos[0] * view.scale, 3);
    expect(glows[1]).toBeCloseTo(view.cy - pos[1] * Math.cos(view.tilt) * view.scale, 3);

    const elem = new Float32Array(MAX_BODIES * 4);
    const color = new Float32Array(MAX_BODIES * 4);
    const motion = new Float32Array(MAX_BODIES * 4);
    const count = fillOrbitElements(sys, elem, color);
    fillOrbitMotion(sys, 1e7, motion);
    expect(count).toBe(sys.bodies.length - 2);
    for (let g = 0; g < count; g++) {
      const b = sys.bodies[g + 2];
      expect(elem[4 * g + 3]).toBe(b.parent < 0 ? -1 : b.parent - 2);
      expect(motion[4 * g]).toBeGreaterThanOrEqual(0);
      expect(motion[4 * g]).toBeLessThan(TAU);
      expect(motion[4 * g]).toBeCloseTo(meanAnomaly(b, 1e7), 5);
    }
  });
});

describe("helpers", () => {
  it("wraps angles and places the centre", () => {
    expect(wrapAngle(-0.5)).toBeCloseTo(TAU - 0.5, 12);
    expect(wrapAngle(TAU * 3 + 1)).toBeCloseTo(1, 9);
    expect(centreFraction("left")).toBeLessThan(0.5);
    expect(centreFraction("right")).toBeGreaterThan(0.5);
    expect(centreFraction("centre")).toBe(0.5);
  });
});
