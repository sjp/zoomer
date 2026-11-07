import { describe, expect, it } from "vitest";
import {
  createShipPose,
  CRUISE,
  HOLD,
  SHIP_KINDS,
  SHIP_SLOT,
  shipAt,
  TURN,
  VISIT,
  visitDirection,
  visitKind,
  visitStart,
} from "./bridge-ships";

const SEED = 12;

describe("bridge visiting ships", () => {
  it("cruise in from off-screen, face the viewer for the hold, then leave the other way", () => {
    const pose = createShipPose();
    for (let slot = 0; slot < 6; slot++) {
      const t0 = visitStart(slot, SEED);
      const dir = visitDirection(slot, SEED);
      expect(shipAt(t0 - 0.01, SEED, pose).kind).toBe(-1);
      shipAt(t0, SEED, pose);
      expect(pose.kind).toBe(visitKind(slot, SEED));
      expect(pose.across).toBeCloseTo(-dir, 6);
      expect(pose.yaw).toBeCloseTo((dir * Math.PI) / 2, 6);
      shipAt(t0 + CRUISE + TURN + HOLD / 2, SEED, pose);
      expect(pose.across).toBe(0);
      expect(pose.yaw).toBe(0);
      shipAt(t0 + VISIT - 0.001, SEED, pose);
      expect(pose.across).toBeCloseTo(dir, 2);
      expect(shipAt(t0 + VISIT, SEED, pose).kind).toBe(-1);
    }
  });

  it("move smoothly, with no jumps", () => {
    const pose = createShipPose();
    const t0 = visitStart(2, SEED);
    let prev = { ...shipAt(t0, SEED, pose) };
    for (let t = t0; t < t0 + VISIT; t += 1 / 60) {
      shipAt(t, SEED, pose);
      expect(Math.abs(pose.across - prev.across)).toBeLessThan(0.01);
      expect(Math.abs(pose.yaw - prev.yaw)).toBeLessThan(0.02);
      expect(Math.abs(pose.bob - prev.bob)).toBeLessThan(0.001);
      prev = { ...pose };
    }
  });

  it("leave a few minutes between visits", () => {
    for (let slot = 0; slot < 50; slot++) {
      const gap = visitStart(slot + 1, SEED) - (visitStart(slot, SEED) + VISIT);
      expect(gap).toBeGreaterThanOrEqual(2.5 * 60);
      expect(gap).toBeLessThanOrEqual(5 * 60);
    }
    expect(SHIP_SLOT).toBeGreaterThan(VISIT);
  });

  it("bring every ship before any comes twice", () => {
    const seen = new Set<number>();
    for (let slot = 0; slot < SHIP_KINDS.length; slot++) {
      seen.add(visitKind(slot, SEED));
    }
    expect(seen.size).toBe(SHIP_KINDS.length);
  });
});
