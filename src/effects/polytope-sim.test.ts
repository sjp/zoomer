import { describe, expect, it } from "vitest";
import type { Rgb } from "./color";
import {
  buildPolytope,
  EYE_Z,
  projectPolytope,
  PROJECTED_FLOATS,
  rainbow,
  rotationMatrix,
  signedPermutations,
  toShape,
} from "./polytope-sim";
import { SHAPE_OPTIONS, type PolytopeShape } from "./tesseract.meta";

const EXPECTED: Record<PolytopeShape, [vertices: number, edges: number, degree: number]> = {
  tesseract: [16, 32, 4],
  cell16: [8, 24, 6],
  cell24: [24, 96, 8],
  cell120: [600, 1200, 4],
};

const polytopes = new Map(SHAPE_OPTIONS.map((o) => [o.value, buildPolytope(o.value)]));

describe("signedPermutations", () => {
  it("dedupes repeated entries and zero signs", () => {
    expect(signedPermutations([1, 0, 0, 0])).toHaveLength(8);
    expect(signedPermutations([1, 1, 0, 0])).toHaveLength(24);
    expect(signedPermutations([1, 1, 1, 1])).toHaveLength(16);
  });

  it("keeps only even permutations when asked", () => {
    // 12 even orderings of four distinct entries, 8 sign choices for the non-zero three.
    expect(signedPermutations([0, 1, 2, 3], true)).toHaveLength(96);
    expect(signedPermutations([0, 1, 2, 3])).toHaveLength(192);
  });
});

describe("buildPolytope", () => {
  for (const { value } of SHAPE_OPTIONS) {
    it(`builds the ${value} with equal edges on the unit sphere`, () => {
      const poly = polytopes.get(value)!;
      const [vertices, edges, degree] = EXPECTED[value];
      expect(poly.vertexCount).toBe(vertices);
      expect(poly.edgeCount).toBe(edges);
      const v = poly.vertices;
      let worstRadius = 0;
      for (let i = 0; i < poly.vertexCount; i++) {
        const r = Math.hypot(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]);
        worstRadius = Math.max(worstRadius, Math.abs(r - 1));
      }
      const lengths: number[] = [];
      const degrees = new Array<number>(poly.vertexCount).fill(0);
      for (let e = 0; e < poly.edgeCount; e++) {
        const a = poly.edges[e * 2];
        const b = poly.edges[e * 2 + 1];
        degrees[a]++;
        degrees[b]++;
        lengths.push(
          Math.hypot(
            v[a * 4] - v[b * 4],
            v[a * 4 + 1] - v[b * 4 + 1],
            v[a * 4 + 2] - v[b * 4 + 2],
            v[a * 4 + 3] - v[b * 4 + 3],
          ),
        );
      }
      expect(worstRadius).toBeLessThan(1e-12);
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-9);
      expect(new Set(degrees)).toEqual(new Set([degree]));
    });
  }

  it("has the known edge lengths for unit circumradius", () => {
    const edge = (shape: PolytopeShape) => {
      const { vertices: v, edges } = polytopes.get(shape)!;
      const [a, b] = [edges[0], edges[1]];
      return Math.hypot(...[0, 1, 2, 3].map((k) => v[a * 4 + k] - v[b * 4 + k]));
    };
    expect(edge("tesseract")).toBeCloseTo(1, 12);
    expect(edge("cell16")).toBeCloseTo(Math.SQRT2, 12);
    expect(edge("cell24")).toBeCloseTo(1, 12);
    // 120-cell: edge 2/φ² at circumradius √8.
    expect(edge("cell120")).toBeCloseTo((3 - Math.sqrt(5)) / Math.sqrt(8), 12);
  });
});

describe("rotationMatrix", () => {
  it("is orthonormal and preserves vertex norms", () => {
    const m = new Float64Array(16);
    const poly = polytopes.get("cell120")!;
    const v = poly.vertices;
    let worst = 0;
    for (let k = 0; k < 20; k++) {
      rotationMatrix(m, k * 0.7, k * 1.3 - 2, k * 0.31 + 0.2);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let dot = 0;
          for (let i = 0; i < 4; i++) dot += m[r * 4 + i] * m[c * 4 + i];
          worst = Math.max(worst, Math.abs(dot - (r === c ? 1 : 0)));
        }
      }
      for (let i = 0; i < poly.vertexCount; i++) {
        let n2 = 0;
        for (let r = 0; r < 4; r++) {
          let x = 0;
          for (let c = 0; c < 4; c++) x += m[r * 4 + c] * v[i * 4 + c];
          n2 += x * x;
        }
        worst = Math.max(worst, Math.abs(n2 - 1));
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("is the identity at zero angles", () => {
    const m = new Float64Array(16);
    rotationMatrix(m, 0, 0, 0);
    expect([...m]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});

describe("projectPolytope", () => {
  it("keeps points within bounds and nearness in [0, 1]", () => {
    const m = new Float64Array(16);
    const out = new Float32Array(600 * PROJECTED_FLOATS);
    const bound = EYE_Z / (EYE_Z - 1) + 1e-6;
    let bad = 0;
    for (const poly of polytopes.values()) {
      for (let k = 0; k < 10; k++) {
        rotationMatrix(m, k * 0.9, k * 0.4, k * 0.25);
        projectPolytope(poly, m, out);
        for (let i = 0; i < poly.vertexCount; i++) {
          const o = i * PROJECTED_FLOATS;
          if (Math.hypot(out[o], out[o + 1]) > bound) bad++;
          if (!(out[o + 2] >= 0 && out[o + 2] <= 1)) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("shrinks the far cell of the tesseract: the inner cube", () => {
    const m = new Float64Array(16);
    rotationMatrix(m, 0, 0, 0);
    const poly = polytopes.get("tesseract")!;
    const out = new Float32Array(poly.vertexCount * PROJECTED_FLOATS);
    projectPolytope(poly, m, out);
    const near: number[] = [];
    const far: number[] = [];
    for (let i = 0; i < poly.vertexCount; i++) {
      const o = i * PROJECTED_FLOATS;
      const r = Math.hypot(out[o], out[o + 1]);
      (poly.vertices[i * 4 + 3] > 0 ? near : far).push(r);
    }
    expect(Math.max(...far)).toBeLessThan(Math.min(...near));
  });
});

describe("toShape", () => {
  it("passes known shapes through and falls back to the tesseract", () => {
    expect(toShape("cell120")).toBe("cell120");
    expect(toShape("cell24")).toBe("cell24");
    expect(toShape("bogus")).toBe("tesseract");
  });
});

describe("rainbow", () => {
  it("runs from blue-violet when far to red when near, within 0..1", () => {
    const c: Rgb = [0, 0, 0];
    rainbow(0, c);
    expect(c[2]).toBeGreaterThan(c[0]);
    expect(c[2]).toBeGreaterThan(c[1]);
    rainbow(1, c);
    expect(c[0]).toBe(1);
    expect(c[0]).toBeGreaterThan(c[2]);
    let outside = 0;
    for (let t = -0.5; t <= 1.5; t += 0.01) {
      rainbow(t, c);
      for (const x of c) if (!(x >= 0 && x <= 1)) outside++;
    }
    expect(outside).toBe(0);
  });
});
