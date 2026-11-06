import { describe, expect, it } from "vitest";
import {
  advanceOffsets,
  advanceSweep,
  buildColourScale,
  buildTerrain,
  cellEnvelope,
  formatStamp,
  FRONT_AHEAD,
  FRONT_BEHIND,
  frontPosition,
  inSpeakerZone,
  LABEL_COUNT,
  LABEL_MIN_HEIGHT,
  LABEL_WIDTH,
  LEVEL_COUNT,
  LEVEL_THRESHOLDS,
  MAX_CELLS,
  OFFSET_PAIRS,
  PALETTES,
  PLACE_NAMES,
  placeLabels,
  rainLevel,
  SCALE_SIZE,
  sampleTerrain,
  SWEEP_PERIOD,
  TERRAIN_COLS,
  TERRAIN_ROWS,
  type TerrainRegion,
  windSpan,
  writeStormCells,
} from "./radar-sim";
import { defined } from "../test/defined";

const TAU = Math.PI * 2;

describe("colour quantisation", () => {
  it("is monotonic, flat between thresholds and spans every level", () => {
    let prev = -1;
    let bad = 0;
    for (let i = 0; i <= 2000; i++) {
      const l = rainLevel(i / 2000);
      if (l < prev) {
        bad++;
      }
      prev = l;
    }
    expect(bad).toBe(0);
    expect(rainLevel(0)).toBe(0);
    expect(rainLevel(1)).toBe(LEVEL_COUNT);
    // Midway between two thresholds the level sits exactly on its step.
    for (let k = 0; k < LEVEL_COUNT - 1; k++) {
      expect(rainLevel((LEVEL_THRESHOLDS[k] + LEVEL_THRESHOLDS[k + 1]) / 2)).toBe(k + 1);
    }
  });

  it("builds colour scales whose opacity never falls as intensity rises", () => {
    const out = new Uint8Array(SCALE_SIZE * 4);
    for (const palette of Object.values(PALETTES)) {
      buildColourScale(palette, out);
      expect(out[3]).toBe(0);
      expect(out[(SCALE_SIZE - 1) * 4 + 3]).toBe(Math.round(255 * palette.alpha[LEVEL_COUNT - 1]));
      let bad = 0;
      for (let j = 1; j < SCALE_SIZE; j++) {
        if (out[j * 4 + 3] < out[(j - 1) * 4 + 3]) {
          bad++;
        }
      }
      expect(bad).toBe(0);
      expect(palette.steps).toHaveLength(LEVEL_COUNT);
      expect(palette.alpha).toHaveLength(LEVEL_COUNT);
    }
  });

  it("puts the heaviest step's colour at the top of the scale", () => {
    const out = new Uint8Array(SCALE_SIZE * 4);
    buildColourScale(PALETTES.classic, out);
    const o = (SCALE_SIZE - 1) * 4;
    const hex = `#${[out[o], out[o + 1], out[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    expect(hex).toBe(PALETTES.classic.steps[LEVEL_COUNT - 1]);
  });
});

describe("storm cells", () => {
  it("start and end their lives at zero intensity", () => {
    expect(cellEnvelope(0)).toBe(0);
    expect(cellEnvelope(1)).toBeCloseTo(0, 12);
    expect(cellEnvelope(0.5)).toBeCloseTo(1, 12);
  });

  it("never jump in intensity, even when a slot respawns", () => {
    const a = new Float32Array(MAX_CELLS * 4);
    const b = new Float32Array(MAX_CELLS * 4);
    const dt = 0.05;
    let maxStep = 0;
    let respawns = 0;
    writeStormCells(a, 0, 7, 16 / 9);
    for (let t = dt; t < 600; t += dt) {
      writeStormCells(b, t, 7, 16 / 9);
      for (let i = 0; i < MAX_CELLS; i++) {
        maxStep = Math.max(maxStep, Math.abs(b[i * 4 + 3] - a[i * 4 + 3]));
        // A respawn moves the cell; it must be invisible when it does.
        const moved = Math.hypot(b[i * 4] - a[i * 4], b[i * 4 + 1] - a[i * 4 + 1]);
        if (moved > 0.05) {
          respawns++;
          if (a[i * 4 + 3] > 0.01 || b[i * 4 + 3] > 0.01) {
            maxStep = Infinity;
          }
        }
      }
      a.set(b);
    }
    expect(respawns).toBeGreaterThan(MAX_CELLS);
    expect(maxStep).toBeLessThan(0.01);
  });

  it("are deterministic per seed", () => {
    const a = new Float32Array(MAX_CELLS * 4);
    const b = new Float32Array(MAX_CELLS * 4);
    writeStormCells(a, 123.4, 5, 1.5);
    writeStormCells(b, 123.4, 5, 1.5);
    expect(b).toEqual(a);
    writeStormCells(b, 123.4, 6, 1.5);
    expect(b).not.toEqual(a);
  });
});

describe("sweep", () => {
  it("wraps without a jump", () => {
    let angle = 0;
    let wraps = 0;
    let maxStep = 0;
    let outOfRange = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * SWEEP_PERIOD * 3 + 7; i++) {
      const next = advanceSweep(angle, dt);
      if (next < angle) {
        wraps++;
      }
      if (next < 0 || next >= TAU) {
        outOfRange++;
      }
      // The direction the line points moves by the same small step every frame.
      const step = Math.hypot(Math.cos(next) - Math.cos(angle), Math.sin(next) - Math.sin(angle));
      maxStep = Math.max(maxStep, step);
      angle = next;
    }
    expect(wraps).toBe(3);
    expect(outOfRange).toBe(0);
    const expected = 2 * Math.sin((Math.PI * dt) / SWEEP_PERIOD);
    expect(maxStep).toBeCloseTo(expected, 9);
  });
});

describe("front", () => {
  it("wraps only while its rain is off the canvas", () => {
    const span: [number, number] = [0, 0];
    windSpan(16 / 9, span);
    let prev = frontPosition(0, span[0], span[1]);
    let wraps = 0;
    let bad = 0;
    for (let t = 0.001; t < 20; t += 0.001) {
      const pos = frontPosition(t, span[0], span[1]);
      if (pos < prev) {
        wraps++;
        // Before the wrap all rain is downwind of the canvas; after it, all upwind.
        if (prev - 3 * FRONT_BEHIND < span[1]) {
          bad++;
        }
        if (pos + 3 * FRONT_AHEAD > span[0]) {
          bad++;
        }
      }
      prev = pos;
    }
    expect(wraps).toBeGreaterThan(2);
    expect(bad).toBe(0);
  });
});

describe("noise offsets", () => {
  it("stay in [0, 1) and move every pair", () => {
    const offsets = new Float32Array(OFFSET_PAIRS * 2);
    let bad = 0;
    for (let i = 0; i < 5000; i++) {
      advanceOffsets(offsets, 0.01);
      for (const v of offsets) {
        if (!(v >= 0 && v < 1)) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
    const moved = new Float32Array(OFFSET_PAIRS * 2);
    advanceOffsets(moved, 0.01);
    for (let i = 0; i < OFFSET_PAIRS; i++) {
      expect(Math.hypot(moved[i * 2], moved[i * 2 + 1])).toBeGreaterThan(0);
    }
  });
});

describe("terrain and labels", () => {
  const regions: TerrainRegion[] = ["coast", "islands", "inland"];
  const terrains = new Map(
    regions.map((r) => [r, buildTerrain(r, 3, new Float32Array(TERRAIN_COLS * TERRAIN_ROWS))]),
  );

  it("has both land and water in every region", () => {
    for (const t of terrains.values()) {
      let land = 0;
      for (const h of t) {
        if (h > 0) {
          land++;
        }
      }
      const frac = land / t.length;
      expect(frac).toBeGreaterThan(0.15);
      expect(frac).toBeLessThan(0.97);
    }
  });

  it("puts the coast's land on the radar's (west) side", () => {
    const t = defined(terrains.get("coast"));
    expect(sampleTerrain(t, 0.1, 0.5)).toBeGreaterThan(0);
    expect(sampleTerrain(t, 2.3, 0.5)).toBeLessThan(0);
  });

  it("is deterministic per seed", () => {
    const a = buildTerrain("islands", 9, new Float32Array(TERRAIN_COLS * TERRAIN_ROWS));
    expect(a).toEqual(buildTerrain("islands", 9, new Float32Array(TERRAIN_COLS * TERRAIN_ROWS)));
    expect(a).not.toEqual(terrains.get("islands"));
  });

  it("places made-up labels on land, clear of the speaker and each other", () => {
    for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
      for (const t of terrains.values()) {
        const labels = placeLabels(t, aspect, 3);
        expect(labels.length).toBeGreaterThan(1);
        expect(labels.length).toBeLessThanOrEqual(LABEL_COUNT);
        expect(new Set(labels.map((l) => l.name)).size).toBe(labels.length);
        let bad = 0;
        for (const l of labels) {
          if (!(PLACE_NAMES as readonly string[]).includes(l.name)) {
            bad++;
          }
          if (sampleTerrain(t, l.x, l.y) < LABEL_MIN_HEIGHT) {
            bad++;
          }
          if (inSpeakerZone(l.x, aspect) || inSpeakerZone(l.x + LABEL_WIDTH, aspect)) {
            bad++;
          }
          if (l.x < 0 || l.x + LABEL_WIDTH > aspect || l.y < 0 || l.y > 1) {
            bad++;
          }
        }
        expect(bad).toBe(0);
        expect(placeLabels(t, aspect, 3)).toEqual(labels);
      }
    }
  });
});

describe("timestamp", () => {
  it("formats a local date and time", () => {
    expect(formatStamp(new Date(2026, 10, 3, 9, 5))).toBe("TUE 03 NOV  09:05");
    expect(formatStamp(new Date(2027, 0, 31, 23, 59))).toBe("SUN 31 JAN  23:59");
  });
});
