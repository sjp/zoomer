import { describe, expect, it } from "vitest";
import {
  buildScene,
  fillLayerColors,
  MAX_SHAPES,
  MAX_STACK,
  MOTION_AMP,
  NONE,
  parallaxOffset,
  pineHalfWidth,
  placeShape,
  resolvePalette,
  SCENE_PALETTES,
  sampleRow,
  sceneId,
  seatBoat,
  slotDepth,
  TABLE_CHANNELS,
  TABLE_COLUMNS,
  TABLE_PERIOD,
  TABLE_ROWS,
  yAt,
} from "./papercut-sim";
import { MAX_LAYERS, MIN_LAYERS, PALETTE_IDS, SCENE_IDS } from "./papercut.meta";

const newTable = () => new Float32Array(TABLE_ROWS * TABLE_COLUMNS * TABLE_CHANNELS);
const at = (table: Float32Array, row: number, col: number, ch: number) =>
  table[(row * TABLE_COLUMNS + col) * TABLE_CHANNELS + ch];

/** Every scene at every layer count. */
const cases = SCENE_IDS.flatMap((id) =>
  Array.from({ length: MAX_LAYERS - MIN_LAYERS + 1 }, (_, k) => [id, MIN_LAYERS + k] as const),
);

describe("buildScene", () => {
  it.each(cases)("%s with %i layers fits the stack and shape limits", (id, n) => {
    const scene = buildScene(id, n, newTable());
    expect(scene.layers.length).toBeLessThanOrEqual(MAX_STACK);
    const shapes = scene.layers.reduce((sum, l) => sum + l.shapes.length, 0);
    expect(shapes).toBeLessThanOrEqual(MAX_SHAPES);
    const scenery = scene.layers.filter((l) => l.band !== undefined).length;
    // Ocean's cloud frame counts as one of its scenery layers.
    expect(scenery + (id === "ocean" ? 1 : 0)).toBe(n);
  });

  it.each(cases)("%s with %i layers keeps bottom edges in their bands", (id, n) => {
    const table = newTable();
    const scene = buildScene(id, n, table);
    scene.layers.forEach((layer, slot) => {
      if (!layer.band) return;
      const [lo, hi] = layer.band;
      let min = Infinity;
      let max = -Infinity;
      for (let c = 0; c < TABLE_COLUMNS; c++) {
        const h = at(table, slot * 2, c, 0);
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
      expect(min).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(max).toBeLessThanOrEqual(hi + 1e-6);
    });
  });

  it.each(cases)("%s with %i layers stacks bands back to front and shows every one", (id, n) => {
    const table = newTable();
    const scene = buildScene(id, n, table);
    const slots = scene.layers.flatMap((l, slot) => (l.band ? [slot] : []));
    for (let k = 1; k < slots.length; k++) {
      const back = scene.layers[slots[k - 1]].band!;
      const front = scene.layers[slots[k]].band!;
      expect(front[0] + front[1]).toBeLessThan(back[0] + back[1]);
    }
    // Each layer peeks out above all the layers in front of it somewhere.
    for (let k = 0; k < slots.length - 1; k++) {
      let best = -Infinity;
      for (let c = 0; c < TABLE_COLUMNS; c++) {
        let front = -Infinity;
        for (let j = k + 1; j < slots.length; j++) {
          front = Math.max(front, at(table, slots[j] * 2, c, 0));
        }
        best = Math.max(best, at(table, slots[k] * 2, c, 0) - front);
      }
      expect(best).toBeGreaterThan(0.01);
    }
  });

  it.each(cases)("%s with %i layers has periodic x rows", (id, n) => {
    const table = newTable();
    const scene = buildScene(id, n, table);
    scene.layers.forEach((layer, slot) => {
      if (!layer.hasX) return;
      for (const ch of [0, 2]) {
        let maxStep = 0;
        for (let c = 1; c < TABLE_COLUMNS; c++) {
          maxStep = Math.max(
            maxStep,
            Math.abs(at(table, slot * 2, c, ch) - at(table, slot * 2, c - 1, ch)),
          );
        }
        const seam = Math.abs(
          at(table, slot * 2, 0, ch) - at(table, slot * 2, TABLE_COLUMNS - 1, ch),
        );
        expect(seam).toBeLessThanOrEqual(maxStep + 1e-6);
      }
    });
  });

  it("marks absent edges and leaves unused slots empty", () => {
    const table = newTable();
    const scene = buildScene("hills", MIN_LAYERS, table);
    // The sun layer has no table edges.
    expect(at(table, 0, 0, 0)).toBe(NONE);
    expect(at(table, 1, 5, 2)).toBe(NONE);
    for (let slot = scene.layers.length; slot < MAX_STACK; slot++) {
      expect(at(table, slot * 2, 7, 0)).toBe(NONE);
    }
  });

  it("puts pine walls on both sides of the forest, inside the canvas", () => {
    const table = newTable();
    const scene = buildScene("forest", 6, table);
    const walls = scene.layers.flatMap((l, slot) => (l.hasY ? [slot] : []));
    expect(walls.length).toBe(4);
    for (const slot of walls) {
      for (const ch of [0, 2]) {
        let reach = -Infinity;
        for (let c = 0; c < TABLE_COLUMNS / 2; c++) {
          const y = yAt(c);
          if (y > 1.2) break;
          reach = Math.max(reach, at(table, slot * 2 + 1, c, ch));
        }
        expect(reach).toBeGreaterThan(0.05);
        expect(reach).toBeLessThan(0.6);
      }
      // Nothing above the trees.
      expect(sampleRow(table, slot * 2 + 1, 0, 1.5)).toBe(NONE);
    }
  });

  it("is deterministic and clamps the layer count", () => {
    const a = newTable();
    const b = newTable();
    buildScene("ocean", 6, a);
    buildScene("ocean", 6, b);
    expect(a.every((v, i) => Object.is(v, b[i]))).toBe(true);
    expect(buildScene("hills", 99, newTable()).layers.length).toBe(MAX_LAYERS + 2);
    expect(buildScene("hills", 1, newTable()).layers.length).toBe(MIN_LAYERS + 2);
  });

  it("seats the ocean boat directly behind its wave", () => {
    const scene = buildScene("ocean", 7, newTable());
    expect(scene.boatSlot).toBeGreaterThan(0);
    expect(scene.waveSlot).toBe(scene.boatSlot + 1);
    expect(buildScene("hills", 7, newTable()).boatSlot).toBe(-1);
  });
});

describe("sampleRow", () => {
  it("interpolates between texels and wraps round the period", () => {
    const table = newTable();
    buildScene("hills", 6, table);
    const row = 2 * 3;
    const dx = TABLE_PERIOD / TABLE_COLUMNS;
    expect(sampleRow(table, row, 0, 5 * dx)).toBeCloseTo(at(table, row, 5, 0), 6);
    const mid = (at(table, row, 5, 0) + at(table, row, 6, 0)) / 2;
    expect(sampleRow(table, row, 0, 5.5 * dx)).toBeCloseTo(mid, 6);
    expect(sampleRow(table, row, 0, 0.3 + TABLE_PERIOD)).toBeCloseTo(
      sampleRow(table, row, 0, 0.3),
      5,
    );
    expect(sampleRow(table, row, 0, -0.3)).toBeCloseTo(
      sampleRow(table, row, 0, TABLE_PERIOD - 0.3),
      5,
    );
  });

  it("maps y rows to [-period/2, period/2)", () => {
    expect(yAt(0)).toBe(0);
    expect(yAt(TABLE_COLUMNS / 2)).toBeCloseTo(-TABLE_PERIOD / 2);
    expect(yAt(TABLE_COLUMNS - 1)).toBeLessThan(0);
  });
});

describe("pineHalfWidth", () => {
  it("tapers to a point and is absent outside the tree", () => {
    expect(pineHalfWidth(0, 0.1, 4)).toBeCloseTo(0.1);
    expect(pineHalfWidth(1, 0.1, 4)).toBeCloseTo(0);
    expect(pineHalfWidth(-0.1, 0.1, 4)).toBe(-Infinity);
    expect(pineHalfWidth(1.1, 0.1, 4)).toBe(-Infinity);
    for (let u = 0; u <= 1; u += 0.01) {
      expect(pineHalfWidth(u, 0.1, 4)).toBeLessThanOrEqual(0.1 * (1 - u) + 1e-9);
    }
  });
});

describe("parallaxOffset", () => {
  const out = new Float64Array(2);

  it("stays within the amplitude scaled by depth and motion", () => {
    for (let t = 0; t < 600; t += 0.37) {
      parallaxOffset(t, 0.5, 1, out);
      expect(Math.abs(out[0])).toBeLessThanOrEqual(MOTION_AMP * 0.5 + 1e-12);
      expect(Math.abs(out[1])).toBeLessThanOrEqual(MOTION_AMP * 0.5 + 1e-12);
    }
  });

  it("is continuous", () => {
    const prev = new Float64Array(2);
    parallaxOffset(0, 1, 1, prev);
    let worst = 0;
    for (let t = 1 / 60; t < 120; t += 1 / 60) {
      parallaxOffset(t, 1, 1, out);
      worst = Math.max(worst, Math.hypot(out[0] - prev[0], out[1] - prev[1]));
      prev.set(out);
    }
    expect(worst).toBeLessThan(MOTION_AMP * 0.01);
  });

  it("scales linearly with depth and vanishes at the back or without motion", () => {
    const front = new Float64Array(2);
    parallaxOffset(13.7, 1, 0.8, front);
    parallaxOffset(13.7, 0.25, 0.8, out);
    expect(out[0]).toBeCloseTo(front[0] * 0.25, 12);
    expect(out[1]).toBeCloseTo(front[1] * 0.25, 12);
    parallaxOffset(13.7, 0, 1, out);
    expect(out[0]).toBeCloseTo(0, 12);
    parallaxOffset(13.7, 1, 0, out);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(slotDepth(0, 5)).toBe(0);
    expect(slotDepth(4, 5)).toBe(1);
  });
});

describe("placeShape", () => {
  const out = new Float64Array(4);

  it("drifts clouds and wraps them just off-canvas", () => {
    const cloud = { kind: 2, x: 0.5, y: 0.8, size: 0.04, drift: 0.01 };
    const aspect = 16 / 9;
    for (let t = 0; t < 2000; t += 3.1) {
      placeShape(cloud, t, aspect, out);
      expect(out[0]).toBeGreaterThanOrEqual(-0.1);
      expect(out[0]).toBeLessThan(aspect + 0.1);
      expect(out[1]).toBe(0.8);
    }
  });

  it("keeps still shapes at their place", () => {
    placeShape({ kind: 1, x: 0.25, y: 0.7, size: 0.05, drift: 0 }, 1234, 2, out);
    expect([...out]).toEqual([0.5, 0.7, 1, 0]);
  });
});

describe("seatBoat", () => {
  it("rides its wave's surface with a small bob and roll", () => {
    const table = newTable();
    const scene = buildScene("ocean", 6, table);
    const spec = scene.layers[scene.boatSlot].shapes[0];
    const boatOff = new Float64Array([0.002, -0.001]);
    const waveOff = new Float64Array([0.003, 0.001]);
    const out = new Float64Array(4);
    for (let t = 0; t < 60; t += 0.5) {
      placeShape(spec, t, 16 / 9, out);
      seatBoat(table, scene.waveSlot, spec.size, t, boatOff, waveOff, out);
      const screenX = out[0] + boatOff[0];
      const surface = sampleRow(table, scene.waveSlot * 2, 0, screenX - waveOff[0]) + waveOff[1];
      const screenY = out[1] + boatOff[1];
      expect(Math.abs(screenY - surface - 0.1 * spec.size)).toBeLessThan(0.005);
      expect(Math.hypot(out[2], out[3])).toBeCloseTo(1, 9);
      expect(Math.abs(Math.atan2(out[3], out[2]))).toBeLessThan(0.6);
    }
  });
});

describe("palettes", () => {
  it("resolves the scene default and every shared palette", () => {
    expect(resolvePalette("night", "scene")).toBe(SCENE_PALETTES.night);
    expect(resolvePalette("night", "nonsense")).toBe(SCENE_PALETTES.night);
    for (const id of PALETTE_IDS) expect(resolvePalette("hills", id).sky).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("shades land from back to front and fills every layer", () => {
    const scene = buildScene("hills", 6, newTable());
    const out = new Float32Array(MAX_STACK * 3).fill(-1);
    const sky = fillLayerColors(scene, SCENE_PALETTES.hills, out);
    expect(sky.every((v) => v >= 0 && v <= 1)).toBe(true);
    for (let i = 0; i < scene.layers.length * 3; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(0);
      expect(out[i]).toBeLessThanOrEqual(1);
    }
    // Front hill is the darkest.
    const last = (scene.layers.length - 1) * 3;
    expect(out[last] + out[last + 1] + out[last + 2]).toBeLessThan(out[6] + out[7] + out[8]);
  });

  it("falls back to hills for an unknown scene", () => {
    expect(sceneId("ocean")).toBe("ocean");
    expect(sceneId("mars")).toBe("hills");
  });
});
