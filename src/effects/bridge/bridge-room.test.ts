import { describe, expect, it } from "vitest";
import {
  ATLAS_MAX_WIDTH,
  ATLAS_S0,
  ATLAS_S1,
  ATLAS_Y0,
  ATLAS_Y1,
  atlasTexelsPerMetre,
  bridgeLayout,
  EYE_Y,
  project,
  RAIL_CZ,
  RAIL_IN,
  RAIL_TOP,
  rayDir,
  wallHit,
  wallPoint,
} from "./bridge-room";

const ASPECT = 16 / 9;

describe("bridge room", () => {
  it("maps wall points to the screen and back", () => {
    for (const [s, y] of [
      [0, 1.5],
      [-2.2, 1.0],
      [1.7, 2.2],
    ] as const) {
      const p = project(wallPoint(s, y), ASPECT);
      const hit = wallHit(rayDir(p.x, p.y, ASPECT));
      expect(hit?.s).toBeCloseTo(s, 6);
      expect(hit?.y).toBeCloseTo(y, 6);
    }
  });

  it("frames the rail along the bottom and the top of the wall at 16:9", () => {
    const rail = project([0, RAIL_TOP, RAIL_CZ + RAIL_IN], ASPECT);
    expect(rail.y).toBeGreaterThan(-0.7);
    expect(rail.y).toBeLessThan(-0.3);
    const top = project(wallPoint(0, ATLAS_Y1), ASPECT);
    expect(top.y).toBeLessThan(0.7);
    // The panels sit above the line of sight over the rail.
    const over = (RAIL_TOP - EYE_Y) / (RAIL_CZ + RAIL_IN);
    expect(EYE_Y + over * wallPoint(0, 0)[2]).toBeLessThan(ATLAS_Y0);
  });

  it("keeps every panel inside the atlas, in both layouts", () => {
    for (const side of ["left", "right"] as const) {
      for (const view of [true, false]) {
        const layout = bridgeLayout(side, view);
        for (const p of layout.panels) {
          expect(p.s0).toBeGreaterThanOrEqual(ATLAS_S0);
          expect(p.s1).toBeLessThanOrEqual(ATLAS_S1);
          expect(p.y0).toBeGreaterThanOrEqual(ATLAS_Y0);
          expect(p.y1).toBeLessThanOrEqual(ATLAS_Y1);
        }
        expect(layout.display === null).toBe(!view);
      }
    }
  });

  it("puts the outside view on the chosen side", () => {
    const left = bridgeLayout("left", true).viewport;
    const right = bridgeLayout("right", true).viewport;
    expect(left && left.s1 < 0).toBe(true);
    expect(right && right.s0 > 0).toBe(true);
  });

  it("keeps the middle third quieter than the outer thirds", () => {
    const layout = bridgeLayout("left", true);
    const busy = [0, 0, 0];
    for (let i = 0; i < 300; i++) {
      for (let j = 0; j < 60; j++) {
        const x = -1 + (2 * (i + 0.5)) / 300;
        const y = -0.3 + (0.9 * (j + 0.5)) / 60;
        const hit = wallHit(rayDir(x, y, ASPECT));
        if (!hit) {
          continue;
        }
        const p = layout.panels.find(
          (q) => q.kind !== "band" && hit.s > q.s0 && hit.s < q.s1 && hit.y > q.y0 && hit.y < q.y1,
        );
        const third = Math.min(2, Math.floor(((x + 1) / 2) * 3));
        busy[third] = busy[third] + (p ? p.busy : 0);
      }
    }
    expect(busy[1]).toBeLessThan(busy[0]);
    expect(busy[1]).toBeLessThan(busy[2]);
  });

  it("sizes the atlas to the canvas, within the width cap", () => {
    const hd = atlasTexelsPerMetre(1080);
    const uhd = atlasTexelsPerMetre(2160);
    expect(uhd).toBeGreaterThan(hd * 1.9);
    expect((ATLAS_S1 - ATLAS_S0) * uhd).toBeLessThanOrEqual(ATLAS_MAX_WIDTH);
    expect((ATLAS_S1 - ATLAS_S0) * atlasTexelsPerMetre(8640)).toBeLessThanOrEqual(ATLAS_MAX_WIDTH);
    expect((ATLAS_S1 - ATLAS_S0) * atlasTexelsPerMetre(2160, 2048)).toBeLessThanOrEqual(2048);
  });
});
