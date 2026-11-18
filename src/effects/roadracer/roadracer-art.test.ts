import { describe, expect, it } from "vitest";
import {
  BACKDROP_WIDTH,
  buildBackdrop,
  buildSpriteAtlas,
  COURSES,
  SCENE_COLOURS,
  SPRITE,
  SPRITE_HEIGHT,
} from "./roadracer-art";
import { CAR_W } from "./roadracer-sim";

const atlas = buildSpriteAtlas();

/** Opaque texels in a cell of the day (half 0) or lit (half 1) colours. */
function opaque(kind: number, half: number): number {
  const c = atlas.cells[kind];
  let n = 0;
  for (let y = c.y; y < c.y + c.h; y++) {
    for (let x = c.x; x < c.x + c.w; x++) {
      n += atlas.pixels[((y + half * atlas.half) * atlas.width + x) * 4 + 3] > 0 ? 1 : 0;
    }
  }
  return n;
}

describe("sprite art", () => {
  it("packs every sprite, with a height for each", () => {
    const kinds = Object.values(SPRITE);
    expect(atlas.cells.length).toBe(kinds.length);
    expect(SPRITE_HEIGHT.length).toBe(kinds.length);
    for (const k of kinds) {
      const c = atlas.cells[k];
      expect(c.x + c.w).toBeLessThanOrEqual(atlas.width);
      expect(c.y + c.h).toBeLessThanOrEqual(atlas.half);
      expect(opaque(k, 0)).toBeGreaterThan(0);
    }
    expect(atlas.pixels.length).toBe(atlas.width * atlas.half * 2 * 4);
  });

  it("lights only tail lights, lamps and windows", () => {
    expect(opaque(SPRITE.car, 1)).toBeGreaterThan(0);
    expect(opaque(SPRITE.lamp, 1)).toBeGreaterThan(0);
    expect(opaque(SPRITE.building0, 1)).toBeGreaterThan(0);
    expect(opaque(SPRITE.palm, 1)).toBe(0);
    expect(opaque(SPRITE.rock, 1)).toBe(0);
    for (const k of Object.values(SPRITE)) {
      expect(opaque(k, 1)).toBeLessThan(opaque(k, 0));
    }
  });

  it("keeps every car within the width the lanes keep apart", () => {
    for (const k of [SPRITE.car, SPRITE.hatchBlue, SPRITE.hatchOrange, SPRITE.van]) {
      const c = atlas.cells[k];
      expect((SPRITE_HEIGHT[k] * c.w) / c.h).toBeLessThanOrEqual(CAR_W);
    }
  });

  it("draws the car in three different frames", () => {
    const rows = (k: number) => {
      const c = atlas.cells[k];
      const out: number[] = [];
      for (let y = c.y; y < c.y + c.h; y++) {
        for (let x = c.x; x < c.x + c.w; x++) {
          out.push(atlas.pixels[(y * atlas.width + x) * 4]);
        }
      }
      return out.join(",");
    };
    const frames = new Set([rows(SPRITE.car), rows(SPRITE.carLeft), rows(SPRITE.carRight)]);
    expect(frames.size).toBe(3);
  });
});

describe("course colours", () => {
  it.each(Object.keys(COURSES) as (keyof typeof COURSES)[])("gives %s every colour", (name) => {
    const look = COURSES[name];
    for (const key of SCENE_COLOURS) {
      expect(look.colours[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const hex of look.hud) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("backdrop", () => {
  it("loops round with outlines spanning their range", () => {
    const b = buildBackdrop();
    expect(b.length).toBe(BACKDROP_WIDTH * 4);
    for (let ch = 0; ch < 2; ch++) {
      const first = b[ch];
      const last = b[(BACKDROP_WIDTH - 1) * 4 + ch];
      // Smooth layers join up across the loop.
      expect(Math.abs(first - last)).toBeLessThan(12);
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < BACKDROP_WIDTH; i++) {
        lo = Math.min(lo, b[i * 4 + ch]);
        hi = Math.max(hi, b[i * 4 + ch]);
      }
      expect(lo).toBe(0);
      expect(hi).toBe(255);
    }
  });
});
