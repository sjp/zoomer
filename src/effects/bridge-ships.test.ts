import { describe, expect, it } from "vitest";
import { SHIP_OPTIONS } from "./bridge.meta";
import {
  ARRIVE,
  createShipPose,
  CRUISE,
  GAP,
  HOLD,
  SHIP_KINDS,
  shipAt,
  type ShipPlan,
  TURN,
  VISIT,
  visitDirection,
  visitKind,
  visitStart,
} from "./bridge-ships";

const SEED = 12;
const CYCLE: ShipPlan = { kind: -1, stay: false, gap: GAP };

describe("bridge visiting ships", () => {
  it("cruise in from off-screen, face the viewer for the hold, then leave the other way", () => {
    const pose = createShipPose();
    for (let visit = 0; visit < 6; visit++) {
      const t0 = visitStart(visit, GAP);
      const dir = visitDirection(visit, SEED);
      expect(shipAt(t0 - 0.01, SEED, CYCLE, pose).kind).toBe(-1);
      shipAt(t0, SEED, CYCLE, pose);
      expect(pose.kind).toBe(visitKind(visit, SEED));
      expect(pose.across).toBeCloseTo(-dir, 6);
      expect(pose.yaw).toBeCloseTo((dir * Math.PI) / 2, 6);
      shipAt(t0 + CRUISE + TURN + HOLD / 2, SEED, CYCLE, pose);
      expect(pose.across).toBe(0);
      expect(pose.yaw).toBe(0);
      shipAt(t0 + VISIT - 0.001, SEED, CYCLE, pose);
      expect(pose.across).toBeCloseTo(dir, 2);
      expect(shipAt(t0 + VISIT, SEED, CYCLE, pose).kind).toBe(-1);
    }
  });

  it("move smoothly, with no jumps", () => {
    for (const stay of [false, true]) {
      const plan: ShipPlan = { kind: -1, stay, gap: GAP };
      const pose = createShipPose();
      const t0 = visitStart(0, GAP);
      let prev = { ...shipAt(t0, SEED, plan, pose) };
      for (let t = t0; t < t0 + VISIT * 2; t += 1 / 60) {
        shipAt(t, SEED, plan, pose);
        if (pose.kind < 0) {
          break;
        }
        expect(Math.abs(pose.across - prev.across)).toBeLessThan(0.01);
        expect(Math.abs(pose.yaw - prev.yaw)).toBeLessThan(0.02);
        expect(Math.abs(pose.bob - prev.bob)).toBeLessThan(0.001);
        prev = { ...pose };
      }
    }
  });

  it("arrive soon after the start, then leave the chosen gap between visits", () => {
    expect(visitStart(0, GAP)).toBe(ARRIVE);
    for (const gap of [10, 60, 600]) {
      for (let visit = 0; visit < 5; visit++) {
        expect(visitStart(visit + 1, gap) - (visitStart(visit, gap) + VISIT)).toBeCloseTo(gap, 9);
      }
      const pose = createShipPose();
      expect(shipAt(visitStart(1, gap) - gap / 2, SEED, { ...CYCLE, gap }, pose).kind).toBe(-1);
    }
  });

  it("bring every ship before any comes twice", () => {
    const seen = new Set<number>();
    for (let visit = 0; visit < SHIP_KINDS.length; visit++) {
      seen.add(visitKind(visit, SEED));
    }
    expect(seen.size).toBe(SHIP_KINDS.length);
  });

  it("bring only the chosen ship when one is chosen", () => {
    const pose = createShipPose();
    for (let kind = 0; kind < SHIP_KINDS.length; kind++) {
      const plan: ShipPlan = { kind, stay: false, gap: 30 };
      for (let visit = 0; visit < 4; visit++) {
        const t = visitStart(visit, 30) + VISIT / 2;
        expect(shipAt(t, SEED, plan, pose).kind).toBe(kind);
      }
    }
  });

  it("stay facing the viewer once arrived, when asked to", () => {
    const pose = createShipPose();
    const plan: ShipPlan = { kind: 2, stay: true, gap: 10 };
    expect(shipAt(ARRIVE - 0.01, SEED, plan, pose).kind).toBe(-1);
    for (const t of [ARRIVE + CRUISE + TURN + 1, 1000, 100_000]) {
      shipAt(t, SEED, plan, pose);
      expect(pose.kind).toBe(2);
      expect(pose.across).toBe(0);
      expect(pose.yaw).toBe(0);
      expect(Math.abs(pose.bob)).toBeLessThanOrEqual(0.02);
    }
    // Cycling and staying keeps the first ship of the cycle.
    shipAt(100_000, SEED, { kind: -1, stay: true, gap: 10 }, pose);
    expect(pose.kind).toBe(visitKind(0, SEED));
  });

  it("list the ship options in the same order as the ships", () => {
    expect(SHIP_OPTIONS.slice(0, 2).map((o) => o.value)).toEqual(["cycle", "none"]);
    expect(SHIP_OPTIONS.length - 2).toBe(SHIP_KINDS.length);
    const expected = [
      "borg",
      "bird-of-prey",
      "federation",
      "warbird",
      "marauder",
      "galor",
      "shuttle",
    ];
    expect(SHIP_KINDS.map((_, i) => SHIP_OPTIONS[i + 2]?.value)).toEqual(expected);
  });
});
