import { describe, expect, it } from "vitest";
import {
  BLOCK_COUNT,
  BLOCKS_PER_UNIT,
  consoleLayout,
  EYE_Y,
  FACE_LEN,
  FACE_Y1,
  facePoint,
  GRAPH_ROWS,
  MAX_BUTTONS,
  project,
  rayDir,
  rowFloor,
  ROWS,
  rowX0,
  rowZ,
  TABLE_TEXELS,
  TOP_Z1,
  UNIT_COUNT,
  UNIT_W,
  UNITS,
  unitBlock,
  WALL_GRAPH_ROWS,
  WALL_SCREENS,
  WALL_Z,
  wallHit,
} from "./missioncontrol-room";

const ASPECT = 16 / 9;
/** Slope (rise over distance) of the sight line from the eye to (y, z). */
const slope = (y: number, z: number) => (y - EYE_Y) / z;

describe("mission control room", () => {
  it("maps wall points to the screen and back", () => {
    for (const [x, y] of [
      [0, 2],
      [-7, 0.5],
      [8, 4.5],
    ] as const) {
      const p = project([x, y, WALL_Z], ASPECT);
      const hit = wallHit(rayDir(p.x, p.y, ASPECT));
      expect(hit.x).toBeCloseTo(x, 6);
      expect(hit.y).toBeCloseTo(y, 6);
    }
  });

  it("puts the map behind the speaker and the busy screens in the outer thirds at 16:9", () => {
    const corners = (r: (typeof WALL_SCREENS)["map"]) =>
      [
        [r.x0, r.y0],
        [r.x1, r.y0],
        [r.x0, r.y1],
        [r.x1, r.y1],
      ].map(([x, y]) => project([x, y, WALL_Z], ASPECT));
    const map = corners(WALL_SCREENS.map);
    // The map spans the whole middle third, and stays clear of the frame's edges.
    expect(Math.min(...map.map((p) => p.x))).toBeLessThan(-1 / 3);
    expect(Math.max(...map.map((p) => p.x))).toBeGreaterThan(1 / 3);
    for (const id of ["telemetry", "tv", "clock", "countdown", "graphs"] as const) {
      for (const p of corners(WALL_SCREENS[id])) {
        expect(Math.abs(p.x)).toBeGreaterThan(1 / 3);
        expect(Math.abs(p.x)).toBeLessThan(1);
        expect(Math.abs(p.y)).toBeLessThan(0.9);
      }
    }
    for (const p of map) {
      expect(Math.abs(p.y)).toBeLessThan(0.9);
    }
  });

  it("steps each row down so its screens show over the row in front, and the wall over the last", () => {
    for (let k = 1; k < ROWS; k++) {
      // Sight line over the top back edge of the row in front...
      const over = slope(rowFloor(k - 1) + FACE_Y1, rowZ(k - 1) + TOP_Z1);
      // ...passes below the top of this row's screens.
      const screenTop = facePoint(k, 0, 0.4);
      expect(slope(screenTop[1], screenTop[2])).toBeGreaterThan(over);
      // At least 15 px of this row's face shows at 1080p.
      const top = project(facePoint(k, 0, FACE_LEN), ASPECT);
      const hidden = project([0, EYE_Y + over * screenTop[2], screenTop[2]], ASPECT);
      expect((top.y - hidden.y) * 540).toBeGreaterThan(15);
    }
    const last = ROWS - 1;
    const over = slope(rowFloor(last) + FACE_Y1, rowZ(last) + TOP_Z1);
    for (const r of Object.values(WALL_SCREENS)) {
      expect(EYE_Y + over * WALL_Z).toBeLessThan(r.y0);
    }
    // The nearest row's top is in frame, at the bottom.
    const near = project([0, rowFloor(0) + FACE_Y1, rowZ(0) + TOP_Z1], ASPECT);
    expect(near.y).toBeGreaterThan(-1);
    expect(near.y).toBeLessThan(-0.7);
  });

  it("runs every row of consoles past both sides of the frame", () => {
    for (let k = 0; k < ROWS; k++) {
      const z = rowZ(k) + TOP_Z1;
      const y = rowFloor(k) + FACE_Y1;
      expect(project([rowX0(k), y, z], 21 / 9).x).toBeLessThan(-1);
      expect(project([rowX0(k) + UNITS * UNIT_W, y, z], 21 / 9).x).toBeGreaterThan(1);
    }
  });
});

describe("console layouts", () => {
  it("are deterministic per seed and differ between seeds", () => {
    expect(consoleLayout(5).table).toEqual(consoleLayout(5).table);
    expect(consoleLayout(5).table).not.toEqual(consoleLayout(6).table);
  });

  it("keep screens and buttons on the face, apart from each other", () => {
    for (const seed of [0, 7, 123, 999]) {
      const { units } = consoleLayout(seed);
      expect(units).toHaveLength(UNIT_COUNT);
      for (const u of units) {
        const rects = [...u.screens.map((s) => s.rect), u.bank];
        for (const r of rects) {
          expect(r.x0).toBeGreaterThan(0.03);
          expect(r.x1).toBeLessThan(UNIT_W - 0.03);
          expect(r.y0).toBeGreaterThan(0.02);
          expect(r.y1).toBeLessThan(FACE_LEN - 0.02);
        }
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i];
            const b = rects[j];
            const apart =
              a.x1 + 0.03 < b.x0 || b.x1 + 0.03 < a.x0 || a.y1 + 0.03 < b.y0 || b.y1 + 0.03 < a.y0;
            expect(apart).toBe(true);
          }
        }
        expect(u.cols * u.rows).toBeLessThanOrEqual(MAX_BUTTONS);
        expect(u.screens.length).toBeGreaterThanOrEqual(1);
        expect(u.screens.length).toBeLessThanOrEqual(2);
        expect(u.clutterX).toBeGreaterThan(0.1);
        expect(u.clutterX).toBeLessThan(UNIT_W - 0.1);
        for (const s of u.screens.filter((sc) => sc.mode === "graph")) {
          expect(s.graphRow).toBeGreaterThanOrEqual(WALL_GRAPH_ROWS);
          expect(s.graphRow).toBeLessThan(GRAPH_ROWS);
        }
      }
    }
  });

  it("number every block, and fill the shaders' table to match", () => {
    const { units, blocks, table } = consoleLayout(7);
    expect(blocks).toHaveLength(BLOCK_COUNT);
    expect(table).toHaveLength(UNIT_COUNT * TABLE_TEXELS * 4);
    units.forEach((u, i) => {
      const o = i * TABLE_TEXELS * 4;
      expect(table[o]).toBeCloseTo(u.screens[0].rect.x0, 6);
      expect(table[o + 12]).toBe(u.cols);
      expect(table[o + 13]).toBe(u.rows);
      expect(blocks[unitBlock(i, 0)].kind).toBe("readout");
      expect(blocks[unitBlock(i, 1)].kind).toBe(u.screens.length > 1 ? "readout" : "widget");
      for (let b = 0; b < MAX_BUTTONS; b++) {
        expect(blocks[unitBlock(i, 2 + b)].kind).toBe(b < u.cols * u.rows ? "button" : "widget");
      }
    });
    expect(unitBlock(UNIT_COUNT - 1, BLOCKS_PER_UNIT - 1)).toBeLessThan(BLOCK_COUNT);
  });

  it("keeps the consoles behind the speaker quieter than those at the sides", () => {
    const { units } = consoleLayout(7);
    const centre = (u: (typeof units)[number]) => rowX0(u.row) + (u.index + 0.5) * UNIT_W;
    const middle = units.filter((u) => Math.abs(centre(u)) < 1);
    const sides = units.filter((u) => Math.abs(centre(u)) > 3.5);
    expect(Math.max(...middle.map((u) => u.busy))).toBeLessThan(
      Math.min(...sides.map((u) => u.busy)),
    );
  });
});
