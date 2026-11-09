import { describe, expect, it } from "vitest";
import {
  advancePhase,
  bodyFromView,
  buildClouds,
  buildCloudsSteps,
  buildSurface,
  buildSurfaceSteps,
  CLOUD_H,
  CLOUD_W,
  cloudShaping,
  discNormal,
  framingAnchor,
  materialByte,
  mulMat3,
  planetLayout,
  raySphere,
  SEA_LEVEL,
  SHADOW_SHIFT,
  sphereUv,
  spherePoint,
  sunDirection,
  sunSide,
  SURFACE_H,
  SURFACE_W,
  WORLDS,
  worldStyle,
} from "./planet-sim";
import { FRAMING_OPTIONS, WORLD_OPTIONS } from "./planet.meta";
import type { BuildSteps } from "../rebuild";

/** Mean absolute byte difference between columns a and b over all rows and RGB. */
function columnDiff(data: Uint8Array, w: number, h: number, a: number, b: number): number {
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(data[(y * w + a) * 4 + c] - data[(y * w + b) * 4 + c]);
    }
  }
  return sum / (h * 3);
}

/** Mean difference between neighbouring columns away from the seam. */
function typicalDiff(data: Uint8Array, w: number, h: number): number {
  let sum = 0;
  const cols = [w / 4, w / 2, (3 * w) / 4];
  for (const x of cols) {
    sum += columnDiff(data, w, h, x - 1, x);
  }
  return sum / cols.length;
}

/** Whether two byte arrays hold the same values (cheaper than a deep `toEqual` on megabytes). */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Surfaces are slow to build, so each test shares one per world and seed. */
const surfaces = new Map<string, Uint8Array>();
function surface(world: string, seed: number): Uint8Array {
  const key = `${world}:${String(seed)}`;
  let data = surfaces.get(key);
  if (!data) {
    data = buildSurface(world, seed);
    surfaces.set(key, data);
  }
  return data;
}

describe("buildSurface", { timeout: 60_000 }, () => {
  const worlds = WORLD_OPTIONS.map((o) => o.value);

  it.each(worlds)("wraps seamlessly in longitude (%s)", (world) => {
    const data = surface(world, 3);
    const seam = columnDiff(data, SURFACE_W, SURFACE_H, SURFACE_W - 1, 0);
    expect(seam).toBeLessThan(typicalDiff(data, SURFACE_W, SURFACE_H) * 2 + 1);
  });

  it.each(worlds)("is deterministic per seed (%s)", (world) => {
    const a = surface(world, 3);
    expect(same(buildSurface(world, 3), a)).toBe(true);
    expect(same(surface(world, 8), a)).toBe(false);
  });

  it("gives Earth oceans and land with city lights", () => {
    const data = surface("earth", 3);
    let glossy = 0;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 128) {
        glossy++;
      } else if (data[i] > 160) {
        lit++;
      }
    }
    const n = SURFACE_W * SURFACE_H;
    expect(glossy / n).toBeGreaterThan(0.4);
    expect(glossy / n).toBeLessThan(0.85);
    expect(lit).toBeGreaterThan(100);
  });

  /** Glossy (ocean or ice) texels and texels with any city light. */
  function materials(data: Uint8Array): [number, number] {
    let glossy = 0;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 128) {
        glossy++;
      } else if (data[i] !== materialByte(0)) {
        lit++;
      }
    }
    return [glossy, lit];
  }

  it("gives the desert no oceans and the gas giant no oceans or cities", () => {
    expect(materials(surface("desert", 3))[0]).toBe(0);
    expect(materials(surface("gas", 3))).toEqual([0, 0]);
  });

  it("falls back to Earth for an unknown world", () => {
    expect(same(buildSurface("nope", 3), surface("earth", 3))).toBe(true);
  });
});

describe("buildClouds", () => {
  it("wraps seamlessly and stores shifted copies for shadows", () => {
    const data = buildClouds("earth", 5);
    const seam = columnDiff(data, CLOUD_W, CLOUD_H, CLOUD_W - 1, 0);
    expect(seam).toBeLessThan(typicalDiff(data, CLOUD_W, CLOUD_H) * 2 + 1);
    const y = CLOUD_H / 2;
    for (const x of [0, 1, CLOUD_W - 1]) {
      const o = (y * CLOUD_W + x) * 4;
      expect(data[o + 1]).toBe(data[(y * CLOUD_W + ((x + SHADOW_SHIFT) % CLOUD_W)) * 4]);
      expect(data[o + 2]).toBe(data[(y * CLOUD_W + ((x - SHADOW_SHIFT + CLOUD_W) % CLOUD_W)) * 4]);
    }
  });

  it("is deterministic and empty for cloudless worlds", () => {
    expect(same(buildClouds("earth", 9), buildClouds("earth", 9))).toBe(true);
    expect(buildClouds("gas", 9).every((v) => v === 0)).toBe(true);
  });

  it("shapes cover from the param and world", () => {
    const out = new Float64Array(2);
    expect(cloudShaping(0, WORLDS.earth, out)[1]).toBe(0);
    expect(cloudShaping(1, WORLDS.gas, out)[1]).toBe(0);
    const lo = cloudShaping(0.3, WORLDS.earth, out)[0];
    expect(cloudShaping(0.8, WORLDS.earth, out)[0]).toBeLessThan(lo);
  });
});

describe("sphere mapping", () => {
  it("round-trips texture coordinates through the sphere", () => {
    const p = new Float64Array(3);
    const uv = new Float64Array(2);
    for (const [u, v] of [
      [0.1, 0.3],
      [0.75, 0.6],
      [0.999, 0.5],
    ]) {
      spherePoint(u, v, p);
      expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(1, 12);
      sphereUv(p[0], p[1], p[2], uv);
      expect(uv[0]).toBeCloseTo(u, 9);
      expect(uv[1]).toBeCloseTo(v, 9);
    }
  });

  it("tilts the north pole towards the viewer with an orthonormal rotation", () => {
    const m = bodyFromView();
    const out = new Float64Array(3);
    // The view-space north axis is row 1; rotating it gives body +y.
    mulMat3(m, m[3], m[4], m[5], out);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(1, 12);
    expect(out[2]).toBeCloseTo(0, 12);
    expect(m[5]).toBeGreaterThan(0);
  });
});

describe("raySphere", () => {
  it("hits the near side of a sphere ahead", () => {
    expect(raySphere(0, 0, 10, 0, 0, -1, 0, 0, 0, 2)).toBeCloseTo(8, 12);
  });

  it("misses a sphere off to the side", () => {
    expect(raySphere(3, 0, 10, 0, 0, -1, 0, 0, 0, 2)).toBe(-1);
  });

  it("touches a sphere at the tangent", () => {
    expect(raySphere(2, 0, 10, 0, 0, -1, 0, 0, 0, 2)).toBeCloseTo(10, 12);
  });

  it("misses a sphere behind the origin and exits one around it", () => {
    expect(raySphere(0, 0, -10, 0, 0, -1, 0, 0, 0, 2)).toBe(-1);
    expect(raySphere(0, 0, 0, 0, 0, -1, 0, 0, 0, 2)).toBeCloseTo(2, 12);
  });

  it("agrees with the shader's orthographic disc normal", () => {
    const n = new Float64Array(3);
    const r = 3;
    for (const [dx, dy] of [
      [0, 0],
      [1, 2],
      [-2.5, 1],
      [3, 0],
    ]) {
      expect(discNormal(dx, dy, r, n)).toBe(true);
      const t = raySphere(dx, dy, 100, 0, 0, -1, 0, 0, 0, r);
      const z = 100 - t;
      expect(n[0]).toBeCloseTo(dx / r, 9);
      expect(n[1]).toBeCloseTo(dy / r, 9);
      expect(n[2]).toBeCloseTo(z / r, 6);
    }
  });

  it("clamps a miss to the limb normal", () => {
    const n = new Float64Array(3);
    expect(discNormal(6, 8, 5, n)).toBe(false);
    expect(n[0]).toBeCloseTo(0.6, 12);
    expect(n[1]).toBeCloseTo(0.8, 12);
    expect(n[2]).toBe(0);
  });
});

describe("rotation", () => {
  it("wraps to [0, 1) continuously", () => {
    let phase = 0.95;
    const step = 0.013;
    for (let i = 0; i < 200; i++) {
      const next = advancePhase(phase, step);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(1);
      // The circular step is always the same, also across the wrap.
      let d = next - phase;
      d -= Math.round(d);
      expect(d).toBeCloseTo(step, 9);
      phase = next;
    }
    expect(advancePhase(0.01, -0.02)).toBeCloseTo(0.99, 12);
  });
});

describe("framing and sun", () => {
  it("keeps part of the disc in frame for every framing", () => {
    const out = new Float64Array(3);
    const aspect = 16 / 9;
    for (const { value } of FRAMING_OPTIONS) {
      for (const size of [0.4, 1, 2]) {
        const [cx, cy, r] = planetLayout(value, size, aspect, out);
        // Closest point of the frame to the centre lies inside the disc.
        const nx = Math.max(-aspect / 2, Math.min(aspect / 2, cx));
        const ny = Math.max(-0.5, Math.min(0.5, cy));
        expect(Math.hypot(nx - cx, ny - cy)).toBeLessThan(r);
      }
    }
  });

  it("mirrors the corner framings", () => {
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    planetLayout("bottomLeft", 1, 1.5, a);
    planetLayout("bottomRight", 1, 1.5, b);
    expect(a[0]).toBeCloseTo(-b[0], 12);
    expect(a[1]).toBe(b[1]);
  });

  it("mirrors the edge and top framings", () => {
    const a = new Float64Array(3);
    const b = new Float64Array(3);
    for (const [x, y] of [
      ["left", "right"],
      ["bottom", "top"],
      ["topLeft", "bottomLeft"],
      ["topRight", "topLeft"],
    ]) {
      planetLayout(x, 1.3, 16 / 9, a);
      planetLayout(y, 1.3, 16 / 9, b);
      const [ax, ay] = framingAnchor(x);
      const [bx, by] = framingAnchor(y);
      expect(ax * a[0] + ay * a[1]).toBeCloseTo(bx * b[0] + by * b[1], 12);
      expect(a[2]).toBe(b[2]);
    }
  });

  it("gives every framing a distinct anchor", () => {
    const seen = new Set(FRAMING_OPTIONS.map(({ value }) => framingAnchor(value).join(",")));
    expect(seen.size).toBe(FRAMING_OPTIONS.length);
    expect(framingAnchor("nope")).toEqual(framingAnchor("bottomLeft"));
  });

  it("lights the visible side of the planet", () => {
    const side = new Float64Array(2);
    const sun = new Float64Array(3);
    const signs = FRAMING_OPTIONS.map(({ value }) => {
      sunSide(value, side);
      sunDirection(60, side[0], sun, side[1]);
      return [value, Math.sign(sun[0]), Math.sign(sun[1])];
    });
    // Horizontally from the planet's outer side (left when centred); vertically
    // from the frame's side of the planet.
    expect(signs).toEqual([
      ["bottomLeft", -1, 1],
      ["bottom", -1, 1],
      ["bottomRight", 1, 1],
      ["left", -1, 1],
      ["full", -1, 1],
      ["right", 1, 1],
      ["topLeft", -1, -1],
      ["top", -1, -1],
      ["topRight", 1, -1],
    ]);
  });

  it("returns a unit sun vector from the requested side", () => {
    const l = new Float64Array(3);
    sunDirection(90, -1, l);
    expect(Math.hypot(l[0], l[1], l[2])).toBeCloseTo(1, 12);
    expect(l[0]).toBeLessThan(0);
    expect(sunDirection(180, 1, l)[2]).toBeLessThan(0);
    expect(sunDirection(60, 1, l, -1)[1]).toBeLessThan(0);
  });

  it("has a style for every world", () => {
    for (const { value } of WORLD_OPTIONS) {
      expect(worldStyle(value)).toBe(WORLDS[value]);
    }
    expect(worldStyle("nope")).toBe(WORLDS.earth);
    expect(SEA_LEVEL).toBeGreaterThan(-1);
  });
});

describe("stepped texture builds", () => {
  /** Runs `steps`, returning the result, the yield count and the longest step in ms. */
  function run(steps: BuildSteps<Uint8Array>) {
    let yields = 0;
    let longest = 0;
    for (;;) {
      const t0 = performance.now();
      const r = steps.next();
      longest = Math.max(longest, performance.now() - t0);
      if (r.done === true) {
        return { data: r.value, yields, longest };
      }
      yields++;
    }
  }

  /** Whether two byte arrays match (toEqual is slow on megabyte arrays). */
  const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  it.each(["earth", "gas"])("gives exactly the one-shot %s textures, in small steps", (world) => {
    const built = run(buildSurfaceSteps(world, 3));
    expect(sameBytes(built.data, buildSurface(world, 3))).toBe(true);
    expect(built.yields).toBeGreaterThan(100);
    expect(built.longest).toBeLessThan(25);
    const clouds = run(buildCloudsSteps(world, 3));
    expect(sameBytes(clouds.data, buildClouds(world, 3))).toBe(true);
  });
});
