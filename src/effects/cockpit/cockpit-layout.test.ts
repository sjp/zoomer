import { describe, expect, it } from "vitest";
import {
  CLUSTER_INNER,
  CLUSTER_OUTER,
  CONSOLE_HIGH,
  CONSOLE_LOW,
  cockpitLayout,
  consoleTop,
  MAX_LIGHTS,
  MAX_PANELS,
  MAX_SCREENS,
  PANEL_FLOATS,
  PANEL_LAMPS,
  PANEL_LEVERS,
  PANEL_SCREEN,
  PANEL_TOGGLES,
  packPanels,
} from "./cockpit-layout";

const SEEDS = [0, 1, 2, 3, 12, 99, 500, 999];

describe("console outline", () => {
  it("is low behind the speaker and rises to the sides", () => {
    expect(consoleTop(0)).toBe(CONSOLE_LOW);
    expect(consoleTop(0.15)).toBe(CONSOLE_LOW);
    expect(consoleTop(-0.9)).toBe(CONSOLE_HIGH);
    expect(consoleTop(0.9)).toBe(CONSOLE_HIGH);
    for (let x = 0; x < 1; x += 0.01) {
      expect(consoleTop(x)).toBe(consoleTop(-x));
      expect(consoleTop(x + 0.01)).toBeGreaterThanOrEqual(consoleTop(x));
    }
  });
});

describe("cockpit layout", () => {
  it("is deterministic per seed and varies between seeds", () => {
    for (const seed of SEEDS) {
      expect(cockpitLayout(seed)).toEqual(cockpitLayout(seed));
    }
    expect(cockpitLayout(1)).not.toEqual(cockpitLayout(2));
  });

  it("keeps its panels on the console, clear of the middle and of each other", () => {
    for (const seed of SEEDS) {
      const { panels } = cockpitLayout(seed);
      expect(panels.length).toBeLessThanOrEqual(MAX_PANELS);
      for (const p of panels) {
        expect(p.x1).toBeGreaterThan(p.x0);
        expect(p.y1).toBeGreaterThan(p.y0);
        expect(p.y0).toBeGreaterThanOrEqual(-0.5);
        expect(Math.min(Math.abs(p.x0), Math.abs(p.x1))).toBeGreaterThanOrEqual(
          CLUSTER_INNER - 1e-9,
        );
        expect(Math.max(Math.abs(p.x0), Math.abs(p.x1))).toBeLessThanOrEqual(CLUSTER_OUTER + 1e-9);
        expect(p.y1).toBeLessThan(consoleTop(p.x0));
        expect(p.y1).toBeLessThan(consoleTop(p.x1));
      }
      for (let i = 0; i < panels.length; i++) {
        for (let j = i + 1; j < panels.length; j++) {
          const a = panels[i];
          const b = panels[j];
          const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
          expect(apart).toBe(true);
        }
      }
    }
  });

  it("has two or three screens, levers on one side, and lamps that fit", () => {
    for (let seed = 0; seed < 1000; seed++) {
      const { panels, lamps, screens } = cockpitLayout(seed);
      expect(screens).toBeGreaterThanOrEqual(2);
      expect(screens).toBeLessThanOrEqual(MAX_SCREENS);
      const shown = panels.filter((p) => p.kind === PANEL_SCREEN).map((p) => p.variant);
      expect(shown.toSorted((x, y) => x - y)).toEqual([0, 1, 2].slice(0, screens));
      expect(panels.filter((p) => p.kind === PANEL_LEVERS)).toHaveLength(1);
      expect(lamps.length).toBeLessThanOrEqual(MAX_LIGHTS);
      // Lamp indices run 1..lamps.length without gaps or overlaps.
      let next = 1;
      const grids = panels.filter((p) => p.kind === PANEL_LAMPS || p.kind === PANEL_TOGGLES);
      for (const p of grids) {
        expect(p.base).toBe(next);
        expect(p.cols * p.rows).toBeGreaterThan(0);
        // The grid fits inside the panel.
        expect(p.cols * p.cellW).toBeLessThanOrEqual(p.x1 - p.x0);
        expect(p.rows * p.cellH).toBeLessThanOrEqual(p.y1 - p.y0);
        next += p.cols * p.rows;
      }
      expect(next - 1).toBe(lamps.length);
    }
  });

  it("packs panels into the shader's uniform arrays", () => {
    const { panels } = cockpitLayout(3);
    const out = new Float32Array(MAX_PANELS * PANEL_FLOATS);
    packPanels(panels, out);
    const p = panels[1];
    expect([...out.subarray(4, 8)]).toEqual([...new Float32Array([p.x0, p.y0, p.x1, p.y1])]);
    const info = (MAX_PANELS + 1) * 4;
    expect([...out.subarray(info, info + 4)]).toEqual([p.kind, p.cols, p.rows, p.base]);
    const extra = (2 * MAX_PANELS + 1) * 4;
    expect(out[extra + 3]).toBe(p.variant);
  });
});
