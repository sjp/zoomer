import { describe, expect, it } from "vitest";
import {
  buildCar,
  buildLights,
  buildScene,
  columnBlocked,
  columnSites,
  LIGHT_FLOATS,
  LIGHT_STAR,
  type Mesh,
  MATERIAL_COUNT,
  ROTATING,
  treeSites,
  VERTEX_FLOATS,
} from "./rollercoaster-mesh";
import { buildTrack } from "./rollercoaster-track";

const track = buildTrack();

function expectWellFormed(mesh: Mesh) {
  const vertices = mesh.vertices.length / VERTEX_FLOATS;
  expect(Number.isInteger(vertices)).toBe(true);
  expect(mesh.indices.length % 3).toBe(0);
  expect(mesh.indices.reduce((most, i) => Math.max(most, i), 0)).toBeLessThan(vertices);
  const nonFinite: number[] = [];
  const badMaterials = new Set<number>();
  // The normal length furthest from 1.
  let worstNormal = 1;
  for (let v = 0; v < vertices; v++) {
    const o = v * VERTEX_FLOATS;
    for (let k = 0; k < 6; k++) {
      if (!Number.isFinite(mesh.vertices[o + k])) {
        nonFinite.push(o + k);
      }
    }
    const length = Math.hypot(mesh.vertices[o + 3], mesh.vertices[o + 4], mesh.vertices[o + 5]);
    if (!(Math.abs(length - 1) <= Math.abs(worstNormal - 1))) {
      worstNormal = length;
    }
    const mat = mesh.vertices[o + 6] % ROTATING;
    if (!Number.isInteger(mat) || mat >= MATERIAL_COUNT) {
      badMaterials.add(mat);
    }
  }
  expect(nonFinite).toEqual([]);
  expect(worstNormal).toBeCloseTo(1, 4);
  expect([...badMaterials]).toEqual([]);
}

describe("buildScene", () => {
  it("is a well-formed indexed mesh of a sensible size", () => {
    const scene = buildScene(track);
    expectWellFormed(scene);
    expect(scene.indices.length / 3).toBeLessThan(120_000);
  });

  it("stands on the ground", () => {
    const scene = buildScene(track);
    let lowest = Infinity;
    for (let v = 0; v < scene.vertices.length; v += VERTEX_FLOATS) {
      lowest = Math.min(lowest, scene.vertices[v + 1]);
    }
    // The Ferris wheel's slanting legs sink a little way in.
    expect(lowest).toBeGreaterThan(-0.6);
  });
});

describe("buildCar", () => {
  it("is a well-formed mesh sitting on the rails", () => {
    const car = buildCar();
    expectWellFormed(car);
    let lowest = Infinity;
    for (let v = 0; v < car.vertices.length; v += VERTEX_FLOATS) {
      lowest = Math.min(lowest, car.vertices[v + 1]);
    }
    expect(lowest).toBeGreaterThanOrEqual(-0.05);
  });
});

describe("columnSites", () => {
  it("holds up the lift and the low runs, never through other track", () => {
    const sites = columnSites(track);
    expect(sites.length).toBeGreaterThan(30);
    for (const s of sites) {
      const i = Math.round(s / track.step);
      expect(columnBlocked(track, i)).toBe(false);
      expect(track.nrm[i * 3 + 1]).toBeGreaterThan(0.5);
    }
    // Some under the lift hill, before the crest.
    expect(sites.filter((s) => s < track.crest && s > track.crest - 40).length).toBeGreaterThan(2);
  });
});

describe("treeSites", () => {
  it("keeps every tree well clear of the track", () => {
    const trees = treeSites(track);
    expect(trees.length / 5).toBeGreaterThan(60);
    // The least clearance of any tree beyond its radius plus 6 m.
    let tightest = Number.POSITIVE_INFINITY;
    for (let t = 0; t < trees.length; t += 5) {
      const [x, z, , r] = trees.slice(t, t + 4);
      for (let i = 0; i < track.count; i++) {
        const d = Math.hypot(track.pos[i * 3] - x, track.pos[i * 3 + 2] - z);
        tightest = Math.min(tightest, d - (r + 6));
      }
    }
    expect(tightest).toBeGreaterThan(0);
  });
});

describe("buildLights", () => {
  it("lines the track, rings the wheel and fills the sky, all finite", () => {
    const lights = buildLights(track);
    expect(lights.length % LIGHT_FLOATS).toBe(0);
    expect(lights.every((v) => Number.isFinite(v))).toBe(true);
    let stars = 0;
    let badStars = 0;
    for (let o = 0; o < lights.length; o += LIGHT_FLOATS) {
      if (lights[o + 7] === LIGHT_STAR) {
        stars++;
        // Unit directions above the horizon.
        const length = Math.hypot(lights[o], lights[o + 1], lights[o + 2]);
        if (Math.abs(length - 1) > 1e-5 || lights[o + 1] <= 0) {
          badStars++;
        }
      }
    }
    expect(badStars).toBe(0);
    expect(stars).toBeGreaterThan(300);
    expect(lights.length / LIGHT_FLOATS - stars).toBeGreaterThan(400);
  });
});
