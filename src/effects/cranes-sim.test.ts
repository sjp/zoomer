import { describe, expect, it } from "vitest";
import {
  BODY_BOTTOM,
  BODY_FRONT,
  BODY_SIDE,
  BODY_TOP,
  BOTTOM_LANE,
  buildCraneVertices,
  CRANE_NEIGHBOURS,
  CRANE_TRIANGLES,
  CRANE_VERTICES,
  craneMargin,
  craneMatrix,
  createCranes,
  createInstanceScratch,
  createPose,
  EXTENT,
  FLAP_MAX,
  FLAP_MIN,
  flapAngle,
  flyerPose,
  GLIDE,
  HANG_SIZE,
  hinge,
  HINGE_Y,
  hangerPose,
  INSTANCE_FLOATS,
  MAX_INSTANCES,
  PALETTES,
  paletteFor,
  paperFor,
  SKIES,
  skyFor,
  stepCranes,
  TIE_POINT,
  TOP_LANE,
  triangleNormal,
  VERTEX_FLOATS,
  writeInstances,
  zScale,
} from "./cranes-sim";
import { MAX_CRANES, MOBILE_CRANES, PALETTE_OPTIONS, SKY_OPTIONS } from "./cranes.meta";

const ASPECT = 16 / 9;
const DT = 1 / 30;
type V3 = [number, number, number];

/** Whether p is inside (or on) the body octahedron. */
function inBody(p: readonly number[]): boolean {
  const y = p[1] >= 0 ? p[1] / BODY_TOP : -p[1] / BODY_BOTTOM;
  return Math.abs(p[0]) / BODY_FRONT + y + Math.abs(p[2]) / BODY_SIDE <= 1 + 1e-9;
}

describe("crane mesh", () => {
  it("has a few dozen triangles, none degenerate", () => {
    expect(CRANE_TRIANGLES.length).toBeGreaterThanOrEqual(20);
    expect(CRANE_TRIANGLES.length).toBeLessThanOrEqual(30);
    expect(CRANE_VERTICES).toBe(CRANE_TRIANGLES.length * 3);
    let bad = 0;
    for (const t of CRANE_TRIANGLES) {
      const n = triangleNormal(t.v[0], t.v[1], t.v[2]);
      if (!(Math.abs(Math.hypot(...n) - 1) < 1e-9)) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("is closed: every edge is met by a neighbour running the other way", () => {
    let bad = 0;
    CRANE_NEIGHBOURS.forEach((nb, i) => {
      for (let k = 0; k < 3; k++) {
        const j = nb[k];
        if (j < 0 || j === i || CRANE_TRIANGLES[j].part !== CRANE_TRIANGLES[i].part) {
          bad++;
        }
        // Symmetric: the neighbour lists this triangle back.
        else if (!CRANE_NEIGHBOURS[j].includes(i)) {
          bad++;
        }
      }
    });
    expect(bad).toBe(0);
    // Consistent winding: each edge is used as often one way as the other (a
    // crease in a two-sided sheet carries four triangles, two each way).
    const count = new Map<string, number>();
    for (const t of CRANE_TRIANGLES) {
      for (let k = 0; k < 3; k++) {
        const a = `${String(t.part)}:${t.v[k].join(",")}>${t.v[(k + 1) % 3].join(",")}`;
        const b = `${String(t.part)}:${t.v[(k + 1) % 3].join(",")}>${t.v[k].join(",")}`;
        count.set(a, (count.get(a) ?? 0) + 1);
        count.set(b, count.get(b) ?? 0);
      }
    }
    let unmatched = 0;
    for (const [key, n] of count) {
      const [part, edge] = key.split(":");
      const [a, b] = edge.split(">");
      if (n === 0 || n !== count.get(`${part}:${b}>${a}`)) {
        unmatched++;
      }
    }
    expect(unmatched).toBe(0);
  });

  it("has outward-facing body faces", () => {
    for (const t of CRANE_TRIANGLES.filter((tri) => tri.part === 0)) {
      const n = triangleNormal(t.v[0], t.v[1], t.v[2]);
      const c = [0, 1, 2].map((a) => (t.v[0][a] + t.v[1][a] + t.v[2][a]) / 3);
      expect(n[0] * c[0] + n[1] * c[1] + n[2] * c[2]).toBeGreaterThan(0);
    }
  });

  it("keeps the wings attached at every flap angle", () => {
    const wings = CRANE_TRIANGLES.filter((t) => t.side !== 0);
    expect(wings.length).toBeGreaterThan(0);
    const out: V3 = [0, 0, 0];
    let detached = 0;
    let stretched = 0;
    for (let a = FLAP_MIN - 0.2; a <= FLAP_MAX + 0.2; a += 0.05) {
      for (const t of wings) {
        const moved = t.v.map((v) => {
          hinge(v, t.side, a, true, out);
          return [...out] as V3;
        });
        for (let k = 0; k < 3; k++) {
          const v = t.v[k];
          // Root corners lie on the hinge, inside the body, and don't move.
          if (v[2] === 0) {
            if (!inBody(moved[k])) {
              detached++;
            }
            if (Math.hypot(moved[k][0] - v[0], moved[k][1] - v[1], moved[k][2] - v[2]) > 1e-12) {
              detached++;
            }
          }
          // The wing turns rigidly: its edge lengths don't change.
          const w = t.v[(k + 1) % 3];
          const m = moved[(k + 1) % 3];
          const before = Math.hypot(v[0] - w[0], v[1] - w[1], v[2] - w[2]);
          const after = Math.hypot(moved[k][0] - m[0], moved[k][1] - m[1], moved[k][2] - m[2]);
          if (Math.abs(before - after) > 1e-9) {
            stretched++;
          }
        }
      }
    }
    expect(detached).toBe(0);
    expect(stretched).toBe(0);
    // Every wing triangle reaches the hinge line, and each wing meets it along an edge.
    let unrooted = 0;
    for (const t of wings) {
      if (!t.v.some((v) => v[2] === 0 && v[1] === HINGE_Y)) {
        unrooted++;
      }
    }
    expect(unrooted).toBe(0);
    for (const side of [1, -1]) {
      const roots = new Set(
        wings
          .filter((t) => t.side === side)
          .flatMap((t) => t.v.filter((v) => v[2] === 0).map((v) => v.join(","))),
      );
      expect(roots.size).toBe(2);
    }
  });

  it("raises both wingtips together", () => {
    const out: V3 = [0, 0, 0];
    hinge([0, HINGE_Y, 1], 1, 0.5, true, out);
    expect(out[1]).toBeCloseTo(HINGE_Y + Math.sin(0.5));
    expect(out[2]).toBeCloseTo(Math.cos(0.5));
    hinge([0, HINGE_Y, -1], -1, 0.5, true, out);
    expect(out[1]).toBeCloseTo(HINGE_Y + Math.sin(0.5));
    expect(out[2]).toBeCloseTo(-Math.cos(0.5));
    // Body parts don't move.
    hinge([0.3, 0.2, 0.1], 0, 0.5, true, out);
    expect(out).toEqual([0.3, 0.2, 0.1]);
  });

  it("builds an interleaved vertex buffer", () => {
    const v = buildCraneVertices();
    expect(v.length).toBe(CRANE_VERTICES * VERTEX_FLOATS);
    // Each neighbour normal is the neighbour triangle's own normal.
    const t = 5;
    const j = CRANE_NEIGHBOURS[t][1];
    const o = (t * 3 + 2) * VERTEX_FLOATS + 7 + 3;
    const nb = CRANE_TRIANGLES[j];
    const n = triangleNormal(nb.v[0], nb.v[1], nb.v[2]);
    for (let a = 0; a < 3; a++) {
      expect(v[o + a]).toBeCloseTo(n[a]);
    }
  });
});

describe("crane rotation", () => {
  const m = new Float64Array(9);
  const apply = (v: V3): V3 => [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];

  it("is the identity with no angles, and orthonormal with any", () => {
    craneMatrix(0, 0, 0, 0, m);
    expect([...m]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    craneMatrix(0.7, -0.3, 0.4, 0.2, m);
    let bad = 0;
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        const d = m[a * 3] * m[b * 3] + m[a * 3 + 1] * m[b * 3 + 1] + m[a * 3 + 2] * m[b * 3 + 2];
        if (Math.abs(d - (a === b ? 1 : 0)) > 1e-12) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("faces left at yaw π, and shows the underside with positive tilt", () => {
    craneMatrix(Math.PI, 0, 0, 0, m);
    expect(apply([1, 0, 0])[0]).toBeCloseTo(-1);
    craneMatrix(0, 0.3, 0, 0, m);
    expect(apply([1, 0, 0])[1]).toBeGreaterThan(0);
    craneMatrix(0, 0, 0, 0.3, m);
    expect(apply([0, -1, 0])[2]).toBeGreaterThan(0);
  });
});

describe("flapping", () => {
  it("starts and ends at the glide angle", () => {
    for (const cycles of [2, 3]) {
      expect(flapAngle(0, cycles)).toBeCloseTo(GLIDE);
      expect(flapAngle(1, cycles)).toBeCloseTo(GLIDE);
    }
  });

  it("is bounded and continuous", () => {
    let outside = 0;
    let maxStep = 0;
    for (const cycles of [2, 3]) {
      let prev = flapAngle(0, cycles);
      for (let i = 1; i <= 2000; i++) {
        const a = flapAngle(i / 2000, cycles);
        if (a < FLAP_MIN - 1e-9 || a > FLAP_MAX + 1e-9) {
          outside++;
        }
        maxStep = Math.max(maxStep, Math.abs(a - prev));
        prev = a;
      }
    }
    expect(outside).toBe(0);
    expect(maxStep).toBeLessThan(0.01);
  });
});

describe("flight", () => {
  it("is deterministic per seed", () => {
    const a = createCranes(4, ASPECT, 9);
    const b = createCranes(4, ASPECT, 9);
    const c = createCranes(5, ASPECT, 9);
    for (let i = 0; i < 300; i++) {
      stepCranes(a, DT, ASPECT, 1, 9);
      stepCranes(b, DT, ASPECT, 1, 9);
      stepCranes(c, DT, ASPECT, 1, 9);
    }
    expect(a.flyers.map((f) => f.x)).toEqual(b.flyers.map((f) => f.x));
    expect(a.flyers.map((f) => f.x)).not.toEqual(c.flyers.map((f) => f.x));
  });

  it("moves continuously and respawns only off-screen", () => {
    const c = createCranes(11, ASPECT, MAX_CRANES);
    const pose = createPose();
    const prev = c.flyers.map((f) => {
      flyerPose(f, pose);
      return { x: pose.x, y: pose.y, flap: pose.flap, yaw: pose.yaw, size: pose.size };
    });
    /** Whether a crane of `size` at x shows nothing. */
    const off = (x: number, size: number) =>
      x <= -size * EXTENT + 1e-9 || x >= ASPECT + size * EXTENT - 1e-9;
    let jumps = 0;
    let badRespawns = 0;
    let respawns = 0;
    let inBand = 0;
    let flaps = 0;
    // Wingbeats turn the wings by up to about 5.2 radians per second.
    for (let step = 0; step < 60 * 240; step++) {
      stepCranes(c, 1 / 60, ASPECT, 1, MAX_CRANES);
      for (const [i, f] of c.flyers.entries()) {
        flyerPose(f, pose);
        const p = prev[i];
        if (pose.size !== p.size) {
          // A new flight (each draws a new depth): the old and new positions are both off-screen.
          respawns++;
          if (!off(p.x, p.size) || !off(pose.x, pose.size)) {
            badRespawns++;
          }
        } else {
          if (Math.hypot(pose.x - p.x, pose.y - p.y) > 0.002) {
            jumps++;
          }
          if (Math.abs(pose.flap - p.flap) > 0.1) {
            jumps++;
          }
          if (Math.abs(Math.sin(pose.yaw - p.yaw)) > 0.02) {
            jumps++;
          }
        }
        if (pose.y > BOTTOM_LANE[1] + 0.03 && pose.y < TOP_LANE[0] - 0.03) {
          inBand++;
        }
        if (pose.flap !== GLIDE) {
          flaps++;
        }
        p.x = pose.x;
        p.y = pose.y;
        p.flap = pose.flap;
        p.yaw = pose.yaw;
        p.size = pose.size;
      }
    }
    expect(respawns).toBeGreaterThan(10);
    expect(badRespawns).toBe(0);
    expect(jumps).toBe(0);
    expect(inBand).toBe(0);
    expect(flaps).toBeGreaterThan(0);
  });

  it("parks and launches cranes off-screen when the count changes", () => {
    const c = createCranes(3, ASPECT, MAX_CRANES);
    const onScreen = (x: number) => x > -craneMargin(0) && x < ASPECT + craneMargin(0);
    let popped = 0;
    let parkedSeen = 0;
    const wasParked = c.flyers.map((f) => f.parked);
    const lastX = c.flyers.map((f) => f.x);
    const check = () => {
      c.flyers.forEach((f, i) => {
        // Parking happens off-screen; so does launching.
        if (f.parked && !wasParked[i] && onScreen(lastX[i])) {
          popped++;
        }
        if (!f.parked && wasParked[i] && onScreen(f.x)) {
          popped++;
        }
        wasParked[i] = f.parked;
        lastX[i] = f.x;
      });
    };
    for (let i = 0; i < 30 * 200; i++) {
      stepCranes(c, DT, ASPECT, 1, 4);
      check();
    }
    parkedSeen = c.flyers.filter((f) => f.parked).length;
    expect(parkedSeen).toBe(MAX_CRANES - 4);
    stepCranes(c, DT, ASPECT, 1, MAX_CRANES);
    check();
    expect(c.flyers.filter((f) => f.parked).length).toBe(0);
    expect(popped).toBe(0);
  });

  it("stands still at speed 0", () => {
    const c = createCranes(1, ASPECT, 9);
    const before = c.flyers.map((f) => f.x);
    for (let i = 0; i < 100; i++) {
      stepCranes(c, DT, ASPECT, 0, 9);
    }
    expect(c.flyers.map((f) => f.x)).toEqual(before);
  });
});

describe("mobile", () => {
  it("hangs each crane by its back from the thread end", () => {
    const c = createCranes(9, ASPECT, 9);
    const pose = createPose();
    const tie: [number, number] = [0, 0];
    const m = new Float64Array(9);
    let off = 0;
    for (let t = 0; t < 60; t += 0.7) {
      for (const h of c.hangers) {
        hangerPose(h, t, ASPECT, pose, tie, m);
        const x = pose.x + HANG_SIZE * (m[0] * TIE_POINT[0] + m[3] * TIE_POINT[1]);
        const y = pose.y + HANG_SIZE * (m[1] * TIE_POINT[0] + m[4] * TIE_POINT[1]);
        if (Math.hypot(x - tie[0], y - tie[1]) > 1e-12) {
          off++;
        }
        // The thread hangs from the top edge, clear of the middle third.
        const ax = h.anchor * ASPECT;
        if (ax > ASPECT / 3 && ax < (2 * ASPECT) / 3) {
          off++;
        }
        if (!(tie[1] < 1 && tie[1] > 0.6)) {
          off++;
        }
      }
    }
    expect(off).toBe(0);
    expect(c.hangers.length).toBe(MOBILE_CRANES);
  });
});

describe("instances", () => {
  it("writes cranes far to near, each in its own slice of depth", () => {
    const c = createCranes(2, ASPECT, MAX_CRANES);
    const s = createInstanceScratch();
    const out = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
    for (let i = 0; i < 90; i++) {
      stepCranes(c, DT, ASPECT, 1, MAX_CRANES);
    }
    const n = writeInstances(c, true, paletteFor("washi"), 1920, 1080, s, out);
    expect(n).toBe(MAX_CRANES + MOBILE_CRANES);
    expect(writeInstances(c, false, paletteFor("washi"), 1920, 1080, s, out)).toBe(MAX_CRANES);
    writeInstances(c, true, paletteFor("washi"), 1920, 1080, s, out);
    const slots: number[] = [];
    const sizes: number[] = [];
    for (let r = 0; r < n; r++) {
      slots.push(out[r * INSTANCE_FLOATS + 11]);
      sizes.push(out[r * INSTANCE_FLOATS + 7]);
    }
    // Slots step nearer (smaller clip z) and stay apart by more than a crane's own depth.
    const gap = Math.min(...slots.slice(1).map((z, i) => slots[i] - z));
    expect(gap).toBeGreaterThan(2 * EXTENT * zScale(n));
    expect(Math.max(...slots) + EXTENT * zScale(n)).toBeLessThan(1);
    expect(Math.min(...slots) - EXTENT * zScale(n)).toBeGreaterThan(-1);
    // The mobile comes last, at its own size.
    expect(sizes[n - 1]).toBeCloseTo(HANG_SIZE * 1080);
  });
});

describe("palettes and skies", () => {
  it("covers every option", () => {
    expect(Object.keys(PALETTES).toSorted()).toEqual(
      PALETTE_OPTIONS.map((o) => o.value).toSorted(),
    );
    expect(Object.keys(SKIES).toSorted()).toEqual(SKY_OPTIONS.map((o) => o.value).toSorted());
    expect(paletteFor("nope")).toBe(PALETTES.pastel);
    expect(skyFor("nope")).toBe(SKIES.dawn);
  });

  it("picks a paper for every tint", () => {
    for (const p of Object.values(PALETTES)) {
      expect(paperFor(p, 0)).toBe(p[0]);
      expect(paperFor(p, 0.999999)).toBe(p[p.length - 1]);
    }
  });
});
