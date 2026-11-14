import { describe, expect, it } from "vitest";
import {
  BUST_BOTTOM,
  BUST_FLOATS,
  BUST_RADIUS,
  BUST_TOP,
  buildBustMesh,
  PILLAR_HALF,
} from "./bust-mesh";

const mesh = buildBustMesh();
const count = mesh.vertices.length / BUST_FLOATS;
const vertex = (k: number) =>
  Array.from(mesh.vertices.subarray(k * BUST_FLOATS, (k + 1) * BUST_FLOATS));

describe("buildBustMesh", () => {
  it("is a small indexed mesh of whole triangles", () => {
    expect(mesh.indices.length % 3).toBe(0);
    const triangles = mesh.indices.length / 3;
    expect(triangles).toBeGreaterThan(300);
    expect(triangles).toBeLessThan(1500);
    expect(Math.max(...mesh.indices)).toBeLessThan(count);
  });

  it("stays inside its published bounds, so any turn fits the layer", () => {
    const outside: string[] = [];
    for (let k = 0; k < count; k++) {
      const [x, y, z, , , , part] = vertex(k);
      const r = part === 0 ? Math.hypot(x, z) : Math.max(Math.abs(x), Math.abs(z));
      if (y > BUST_TOP || y < BUST_BOTTOM || r > BUST_RADIUS) {
        outside.push(`${String(k)}: ${String([x, y, z])}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("has finite, unit normals, pointing out of the head", () => {
    let inward = 0;
    let head = 0;
    for (let k = 0; k < count; k++) {
      const [x, y, z, nx, ny, nz] = vertex(k);
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 4);
      // The head is the part above the neck, centred on the origin.
      if (y > -0.4) {
        head++;
        if (x * nx + y * ny + z * nz <= 0) {
          inward++;
        }
      }
    }
    expect(head).toBeGreaterThan(100);
    expect(inward).toBe(0);
  });

  it("puts the nose tip frontmost on the face, on the centre line", () => {
    let best = -Infinity;
    let bestX = 0;
    let bestY = 0;
    for (let k = 0; k < count; k++) {
      const [x, y, z, , , , part] = vertex(k);
      if (part === 0 && y > -0.8 && z > best) {
        best = z;
        bestX = x;
        bestY = y;
      }
    }
    expect(Math.abs(bestX)).toBeLessThan(1e-6);
    expect(bestY).toBeLessThan(0.2);
    expect(bestY).toBeGreaterThan(-0.4);
  });

  it("has a turning bust and a static pillar standing at the foot", () => {
    const parts = new Set<number>();
    let lowest = Infinity;
    let widest = 0;
    for (let k = 0; k < count; k++) {
      const [x, y, , , , , part] = vertex(k);
      parts.add(part);
      if (part === 1) {
        lowest = Math.min(lowest, y);
        widest = Math.max(widest, Math.abs(x));
      }
    }
    expect(widest).toBeLessThanOrEqual(PILLAR_HALF + 1e-6);
    expect([...parts].toSorted((a, b) => a - b)).toEqual([0, 1]);
    expect(lowest).toBeCloseTo(BUST_BOTTOM, 6);
  });
});
