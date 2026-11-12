import { describe, expect, it } from "vitest";
import { GRID_X, GRID_Y, GRID_Z } from "./pipes-sim";
import { cameraMatrix, maxSegmentRate, ORBIT_RATE, tubeMesh } from "./pipes-view";
import { pipesMeta } from "./pipes.meta";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";

const ASPECTS = [16 / 9, 4 / 3, 1, 9 / 16, 21 / 9];

/** Projects a world point to normalised device coordinates. */
function project(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  expect(cw).toBeGreaterThan(0);
  return [cx / cw, cy / cw, cz / cw];
}

describe("pipes camera", () => {
  it("covers the frame with the volume's front face", () => {
    const m = new Float32Array(16);
    const eye = new Float32Array(3);
    for (const aspect of ASPECTS) {
      cameraMatrix(aspect, 0, m, eye);
      const [x, y] = project(m, GRID_X / 2, GRID_Y / 2, GRID_Z / 2);
      expect(x).toBeGreaterThanOrEqual(1 - 1e-4);
      expect(y).toBeGreaterThanOrEqual(1 - 1e-4);
      // One of them fits exactly.
      expect(Math.min(x, y)).toBeCloseTo(1, 4);
      // The whole volume is between the clip planes, at every orbit angle.
      for (let yaw = 0; yaw < 2 * Math.PI; yaw += 0.3) {
        cameraMatrix(aspect, yaw, m, eye);
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const [, , z] = project(m, (sx * GRID_X) / 2, GRID_Y / 2, (sz * GRID_Z) / 2);
            expect(Math.abs(z)).toBeLessThan(1);
          }
        }
      }
    }
  });

  it("puts the eye on the orbit and looks at the centre", () => {
    const m = new Float32Array(16);
    const eye = new Float32Array(3);
    cameraMatrix(16 / 9, 1.1, m, eye);
    const [x, y] = project(m, 0, 0, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(Math.atan2(eye[0], eye[2])).toBeCloseTo(1.1, 6);
  });
});

describe("pipes motion limits", () => {
  /** Px per reference frame of the sliding end at the volume's nearest point, by projection. */
  function endPx(aspect: number, yaw: number, rate: number, omega: number): number {
    const m = new Float32Array(16);
    const eye = new Float32Array(3);
    cameraMatrix(aspect, yaw, m, eye);
    // The nearest corner, towards the eye, moving one node sideways and sweeping with the orbit.
    const sx = Math.sign(Math.sin(yaw)) || 1;
    const sz = Math.sign(Math.cos(yaw)) || 1;
    const px = (sx * GRID_X) / 2;
    const pz = (sz * GRID_Z) / 2;
    const [ax, ay] = project(m, px, 0, pz);
    const [bx, by] = project(m, px + Math.cos(yaw), 0, pz - Math.sin(yaw));
    // NDC spans 2 per frame height vertically; x is scaled by the aspect.
    const heights = Math.hypot(((bx - ax) * aspect) / 2, (by - ay) / 2);
    const sweep = omega * Math.hypot(GRID_X, GRID_Z) * 0.5;
    return pxPerReferenceFrame(heights * (rate + sweep));
  }

  it("keeps the fastest growth within the per-frame limit", () => {
    const max = pipesMeta.params.speed.max;
    for (const aspect of ASPECTS) {
      for (const omega of [0, ORBIT_RATE]) {
        for (let yaw = 0; yaw < 2 * Math.PI; yaw += 0.25) {
          const rate = Math.min(max, maxSegmentRate(aspect, yaw, omega));
          expect(endPx(aspect, yaw, rate, omega)).toBeLessThanOrEqual(
            MAX_FEATURE_PX_PER_FRAME + 1e-4,
          );
        }
      }
    }
  });

  it("allows the default speed head-on at common aspects", () => {
    for (const aspect of [16 / 9, 4 / 3]) {
      expect(maxSegmentRate(aspect, 0, 0)).toBeGreaterThanOrEqual(pipesMeta.params.speed.default);
    }
  });

  it("keeps the orbit itself slow", () => {
    expect(maxSegmentRate(16 / 9, Math.PI / 4, ORBIT_RATE)).toBeGreaterThan(2);
  });
});

describe("tubeMesh", () => {
  it("builds whole triangles with both end discs", () => {
    const mesh = tubeMesh(3, 8);
    const vertices = mesh.length / 4;
    expect(vertices % 3).toBe(0);
    expect(vertices).toBe((3 * 6 + 6) * 8);
    let start = 0;
    let end = 0;
    let misplaced = 0;
    for (let v = 0; v < vertices; v++) {
      const u = mesh[v * 4];
      const disc = mesh[v * 4 + 3];
      start += disc < 0 ? 1 : 0;
      end += disc > 0 ? 1 : 0;
      const ok = u >= 0 && u <= 1 && (disc === 0 || u === (disc < 0 ? 0 : 1));
      misplaced += ok ? 0 : 1;
    }
    expect(misplaced).toBe(0);
    expect(start).toBe(24);
    expect(end).toBe(24);
  });
});
