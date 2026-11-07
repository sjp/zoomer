import { describe, expect, it } from "vitest";
import {
  ALERT_PERIOD,
  alertPulse,
  ANOMALY_GAP,
  ANOMALY_LEAD,
  ANOMALY_OPEN,
  anomalyOpen,
  CELL_BRIGHT,
  CELL_COUNT,
  CELL_DIM,
  CELL_RAMP,
  cellLevel,
  consoleBack,
  consoleFront,
  createScheduled,
  createShipPass,
  DOCK_Z,
  FRAME_W,
  fillCellLevels,
  GRAPH_COUNT,
  layoutK,
  opsLayout,
  PASS_LENGTH,
  project,
  ringTop,
  scheduled,
  SHIP_RADIUS,
  shipAt,
  STATION_Z,
  BUSY_GAP,
  QUIET_GAP,
  TRAFFIC_LEAD,
  VIEW_RX,
  VIEW_X,
  VIEW_Y,
  viewportDistance,
} from "./stationops-sim";
import type { OutsideId } from "./stationops.meta";

/** Start and end times of the spans where `on(t)` holds, sampled every `dt`. */
function spans(on: (t: number) => boolean, until: number, dt: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let t = 0; t <= until; t += dt) {
    const v = on(t);
    if (v && start < 0) {
      start = t;
    } else if (!v && start >= 0) {
      out.push([start, t]);
      start = -1;
    }
  }
  return out;
}

describe("layout", () => {
  it("keeps the viewports and their frames out of the middle third", () => {
    for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9]) {
      const k = layoutK(aspect);
      const inner = (VIEW_X - VIEW_RX - FRAME_W) * k;
      // The speaker is as wide on a wider frame, so the middle stays a 16:9 third.
      expect(inner).toBeGreaterThan(Math.min(aspect, 16 / 9) / 6);
    }
  });

  it("puts the graph screens on the consoles' tops, inside the frame", () => {
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      const layout = opsLayout(aspect);
      expect(layout.graphs).toHaveLength(GRAPH_COUNT);
      for (const g of layout.graphs) {
        expect(g.x1).toBeGreaterThan(g.x0);
        expect(Math.abs(g.x0)).toBeLessThan(aspect / 2);
        expect(Math.abs(g.x1)).toBeLessThan(aspect / 2);
        for (const x of [g.x0, g.x1]) {
          const u = Math.abs(x) / layout.k;
          expect(g.y0).toBeGreaterThan(consoleFront(u));
          expect(g.y1).toBeLessThan(consoleBack(u));
        }
      }
    }
  });

  it("puts the beacons in the left viewport", () => {
    const layout = opsLayout(16 / 9);
    for (const [x, y] of layout.beacons) {
      expect(viewportDistance(x, y)).toBeLessThan(0);
      expect(x).toBeLessThan(0);
    }
  });

  it("has the ring cross the bottom of the left viewport", () => {
    const y = ringTop(-VIEW_X);
    expect(y).toBeLessThan(VIEW_Y);
    expect(viewportDistance(-VIEW_X, y)).toBeLessThan(0);
    expect(Number.isNaN(ringTop(5))).toBe(true);
  });
});

describe("schedules", () => {
  it("never overlap, keep at least the lead apart, and start no sooner than it", () => {
    const s = createScheduled();
    for (const seed of [0, 9, 999]) {
      const runs = spans((t) => scheduled(t, seed, 5, 100, 30, 20, s).phase >= 0, 5000, 0.25);
      expect(runs.length).toBeGreaterThan(40);
      expect(runs[0][0]).toBeGreaterThanOrEqual(20);
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i][0] - runs[i - 1][1]).toBeGreaterThanOrEqual(20 - 0.5);
      }
      for (const [a, b] of runs) {
        expect(b - a).toBeGreaterThan(29);
        expect(b - a).toBeLessThan(31);
      }
    }
  });

  it("are deterministic per seed and differ between seeds", () => {
    const s = createScheduled();
    const at = (seed: number) =>
      spans((t) => scheduled(t, seed, 5, 100, 30, 20, s).phase >= 0, 2000, 0.5).map((r) => r[0]);
    expect(at(9)).toEqual(at(9));
    expect(at(9)).not.toEqual(at(10));
  });
});

describe("traffic", () => {
  const pass = createShipPass();
  const next = createShipPass();

  it("has none when off", () => {
    for (let t = 0; t < 2000; t += 3) {
      expect(shipAt(t, 9, "off", 1, pass).kind).toBe(-1);
    }
  });

  it("keeps passes apart, as often as the setting says", () => {
    for (const traffic of ["quiet", "busy"] as const) {
      const runs = spans((t) => shipAt(t, 9, traffic, 1, pass).kind >= 0, 7200, 0.5);
      const gap = traffic === "busy" ? BUSY_GAP : QUIET_GAP;
      expect(runs.length).toBeGreaterThanOrEqual(Math.floor(7200 / gap) - 1);
      expect(runs[0][0]).toBeGreaterThanOrEqual(TRAFFIC_LEAD);
      for (let i = 1; i < runs.length; i++) {
        expect(runs[i][0] - runs[i - 1][1]).toBeGreaterThanOrEqual(TRAFFIC_LEAD - 0.5);
      }
      for (const [a, b] of runs) {
        expect(b - a).toBeLessThanOrEqual(PASS_LENGTH + 0.5);
      }
    }
  });

  it("moves smoothly, and is out of sight at both ends of a pass", () => {
    const p = new Float64Array(2);
    const prev = new Float64Array(2);
    let kinds = 0;
    let arrivals = 0;
    let departures = 0;
    let shown = 0;
    let jump = 0;
    let dz = 0;
    for (const traffic of ["quiet", "busy"]) {
      for (const seed of [1, 9, 77]) {
        let was = -1;
        let wasZ = 0;
        for (let t = 0; t < 3600; t += 0.1) {
          shipAt(t, seed, traffic, 1, pass);
          if (pass.kind < 0) {
            was = -1;
            continue;
          }
          kinds |= 1 << pass.kind;
          project(pass.x, pass.y, pass.z, p);
          const r = (SHIP_RADIUS * pass.scale * 1.8) / pass.z;
          // Out of sight: far off the viewports, or behind the station below the ring.
          const hidden =
            viewportDistance(p[0], p[1]) > r || (pass.z > STATION_Z && p[1] + r < ringTop(p[0]));
          const ends =
            was < 0 || pass.z > DOCK_Z - 0.01 || shipAt(t + 0.1, seed, traffic, 1, next).kind < 0;
          if (ends && !hidden) {
            shown++;
          }
          if (was < 0) {
            arrivals += pass.arriving ? 1 : 0;
            departures += pass.arriving ? 0 : 1;
          } else {
            jump = Math.max(jump, Math.hypot(p[0] - prev[0], p[1] - prev[1]));
            dz = Math.max(dz, Math.abs(pass.z - wasZ));
          }
          prev[0] = p[0];
          prev[1] = p[1];
          wasZ = pass.z;
          was = pass.kind;
        }
      }
    }
    expect(shown).toBe(0);
    expect(jump).toBeLessThan(0.05);
    expect(dz).toBeLessThan(0.2);
    expect(kinds).toBe(7);
    expect(arrivals).toBeGreaterThan(3);
    expect(departures).toBeGreaterThan(3);
  });
});

describe("anomaly", () => {
  it("stays shut when disabled", () => {
    for (let t = 0; t < 4000; t += 1) {
      expect(anomalyOpen(t, 9, "anomaly", false)).toBe(0);
    }
  });

  it("opens rarely, slowly and smoothly, never in the first minute's lead", () => {
    for (const outside of ["station", "anomaly", "planet"] as OutsideId[]) {
      for (const seed of [0, 9, 500]) {
        let biggest = 0;
        let prev = 0;
        let opened = 0;
        let lo = 0;
        let hi = 0;
        let early = 0;
        for (let t = 0; t < 7200; t += 0.1) {
          const o = anomalyOpen(t, seed, outside, true);
          lo = Math.min(lo, o);
          hi = Math.max(hi, o);
          early = Math.max(early, t < ANOMALY_LEAD ? o : 0);
          if (o >= 1 && prev < 1) {
            opened++;
          }
          biggest = Math.max(biggest, Math.abs(o - prev));
          prev = o;
        }
        expect(lo).toBe(0);
        expect(hi).toBe(1);
        expect(early).toBe(0);
        // Smootherstep's steepest slope is 1.875 over the opening time.
        expect(biggest).toBeLessThanOrEqual((0.1 * 1.9) / ANOMALY_OPEN);
        expect(opened).toBeGreaterThanOrEqual(Math.floor(7200 / ANOMALY_GAP[outside]) - 1);
        expect(opened).toBeLessThanOrEqual(Math.ceil(7200 / ANOMALY_GAP[outside]));
      }
    }
  });

  it("is deterministic per seed", () => {
    for (let t = 0; t < 2000; t += 7) {
      expect(anomalyOpen(t, 4, "anomaly", true)).toBe(anomalyOpen(t, 4, "anomaly", true));
    }
  });
});

describe("console lights", () => {
  it("stay in range and change only gradually", () => {
    for (const seed of [0, 9]) {
      for (let id = 0; id < CELL_COUNT; id += 11) {
        let prev = cellLevel(id, 0, seed);
        let lo = prev;
        let hi = prev;
        let step = 0;
        let changes = 0;
        for (let t = 0.05; t < 600; t += 0.05) {
          const v = cellLevel(id, t, seed);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
          step = Math.max(step, Math.abs(v - prev));
          if (v !== prev) {
            changes++;
          }
          prev = v;
        }
        expect(lo).toBeGreaterThanOrEqual(CELL_DIM - 1e-9);
        expect(hi).toBeLessThanOrEqual(CELL_BRIGHT + 1e-9);
        expect(step).toBeLessThanOrEqual((0.05 * 1.5 * (CELL_BRIGHT - CELL_DIM)) / CELL_RAMP);
        expect(changes).toBeGreaterThan(0);
      }
    }
  });

  it("fill a byte table deterministically", () => {
    const a = fillCellLevels(123.4, 9, new Uint8Array(CELL_COUNT));
    const b = fillCellLevels(123.4, 9, new Uint8Array(CELL_COUNT));
    expect(a).toEqual(b);
    expect(Math.max(...a)).toBeLessThanOrEqual(255);
    expect(Math.min(...a)).toBeGreaterThan(0);
  });
});

describe("red alert", () => {
  it("pulses slowly and smoothly", () => {
    expect(ALERT_PERIOD).toBeGreaterThanOrEqual(2);
    expect(alertPulse(0)).toBeCloseTo(0);
    expect(alertPulse(ALERT_PERIOD / 2)).toBeCloseTo(1);
    let prev = alertPulse(0);
    for (let t = 0.01; t < 20; t += 0.01) {
      const v = alertPulse(t);
      expect(Math.abs(v - prev)).toBeLessThanOrEqual((0.01 * Math.PI) / ALERT_PERIOD + 1e-9);
      prev = v;
    }
  });
});
