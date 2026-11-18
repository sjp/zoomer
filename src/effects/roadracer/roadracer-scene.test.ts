import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { buildSpriteAtlas, COURSES, SPRITE } from "./roadracer-art";
import {
  buildScene,
  carFrame,
  createScene,
  MAX_SPRITES,
  type SceneInput,
  sceneryKind,
  STRIDE,
  trafficKind,
} from "./roadracer-scene";
import {
  buildCourse,
  carDistance,
  createDrive,
  createRoadFrame,
  distanceFade,
  firstItemAt,
  K_MAX,
  LAP,
  motionFade,
  NEAR,
  DRAW,
  projectRoad,
  projectSprite,
  ROW,
  type SpriteProjection,
  trafficAt,
  type TrafficState,
  V_TOP,
} from "./roadracer-sim";

const atlas = buildSpriteAtlas();
const newProjection = (): SpriteProjection => ({
  x: 0,
  base: 0,
  halfWidth: 0,
  height: 0,
  clip: 0,
  motion: 0,
  fog: 0,
});

function sceneAt(course: "coast" | "sunset" | "night", distance: number, seed = 1) {
  const c = buildCourse(seed);
  const drive = createDrive(1);
  drive.distance = distance;
  drive.speed = V_TOP;
  const traffic: TrafficState = { active: false, gap: 0, closing: 0, appear: 0, hash: 0 };
  trafficAt(seed, distance, traffic);
  const frame = createRoadFrame(600);
  projectRoad(frame, c, distance, 1, drive.speed, 540);
  const input: SceneInput = {
    look: COURSES[course],
    atlas,
    drive,
    traffic,
    carZ: carDistance(1),
    width: 960,
    height: 540,
  };
  const scene = createScene();
  buildScene(scene, frame, c, input);
  return scene;
}

/** Instances drawn from an atlas cell. */
const ofKind = (scene: ReturnType<typeof createScene>, kind: number) => {
  const cell = atlas.cells[kind];
  const out: number[] = [];
  for (let i = 0; i < scene.count; i++) {
    const o = i * STRIDE;
    const u = Math.min(scene.data[o + 4], scene.data[o + 6]);
    if (u === cell.x && scene.data[o + 5] === cell.y) {
      out.push(i);
    }
  }
  return out;
};

describe("scene", () => {
  it.each(["coast", "sunset", "night"] as const)(
    "draws the player's car once, unfogged and never hidden, on the %s course",
    (course) => {
      for (let s = 0; s < LAP; s += 23) {
        const scene = sceneAt(course, s);
        expect(scene.count).toBeLessThan(MAX_SPRITES);
        const cars = [SPRITE.car, SPRITE.carLeft, SPRITE.carRight].flatMap((k) => ofKind(scene, k));
        expect(cars.length).toBe(1);
        const o = cars[0] * STRIDE;
        expect(scene.data[o + 11]).toBe(1);
        expect(scene.data[o + 12]).toBe(0);
        expect(scene.data[o + 13]).toBeGreaterThan(540);
      }
    },
  );

  it("shows palms on the coast and lamps with glows in the city", () => {
    let palms = 0;
    let lamps = 0;
    let glows = 0;
    for (let s = 0; s < LAP; s += 37) {
      palms += ofKind(sceneAt("coast", s), SPRITE.palm).length;
      expect(ofKind(sceneAt("coast", s), SPRITE.lamp)).toEqual([]);
      const night = sceneAt("night", s);
      expect(ofKind(night, SPRITE.palm)).toEqual([]);
      lamps += ofKind(night, SPRITE.lamp).length;
      for (const i of ofKind(night, SPRITE.glow)) {
        // Added on: no alpha, so the glow lightens what is behind it.
        expect(night.data[i * STRIDE + 11]).toBe(0);
        glows++;
      }
    }
    expect(palms).toBeGreaterThan(10);
    expect(lamps).toBeGreaterThan(10);
    expect(glows).toBeGreaterThan(10);
  });

  it("puts nothing farther out on the sea side of the coast", () => {
    expect(sceneryKind(ROW.far, -1, 1234, COURSES.coast)).toBe(-1);
    expect(sceneryKind(ROW.far, 1, 1234, COURSES.coast)).toBeGreaterThanOrEqual(0);
    expect(sceneryKind(ROW.lamp, 1, 5, COURSES.coast)).toBe(-1);
    expect(sceneryKind(ROW.lamp, 1, 5, COURSES.night)).toBe(SPRITE.lamp);
    expect(sceneryKind(ROW.sign, -1, 0, COURSES.sunset)).toBe(SPRITE.sign);
    for (let h = 0; h < 50; h++) {
      expect([SPRITE.hatchBlue, SPRITE.hatchOrange, SPRITE.van]).toContain(trafficKind(h * 977));
    }
  });

  it("leans the car into bends", () => {
    const course = buildCourse(1);
    const drive = createDrive(1);
    course.curve.fill(K_MAX);
    expect(carFrame(course, drive, 2)).toBe(SPRITE.carRight);
    course.curve.fill(-K_MAX);
    expect(carFrame(course, drive, 2)).toBe(SPRITE.carLeft);
    course.curve.fill(0);
    expect(carFrame(course, drive, 2)).toBe(SPRITE.car);
  });

  it.each([1, 2, 3, 42])(
    "fades scenery out before it moves faster than the per-frame limit, frame to frame (seed %i)",
    (seed) => {
      const course = buildCourse(seed);
      const a = createRoadFrame(600);
      const b = createRoadFrame(600);
      const pa = newProjection();
      const pb = newProjection();
      const step = V_TOP / 30;
      let checked = 0;
      for (let s = 0.37; s < LAP; s += 1.9) {
        projectRoad(a, course, s, 1, V_TOP, 540);
        projectRoad(b, course, s + step, 1, V_TOP, 540);
        for (let i = firstItemAt(course, 0); i < course.itemCount; i++) {
          const rel = course.itemS[i] - (s % LAP);
          const d = rel - Math.floor(rel / LAP) * LAP;
          if (d < NEAR + step || d > DRAW) {
            continue;
          }
          // The largest scenery: a tall building.
          for (const [w, h] of [
            [2.6, 6.2],
            [0.8, 1.15],
          ]) {
            if (!projectSprite(a, d, course.itemX[i], w, h, 0, pa)) {
              continue;
            }
            const alpha = motionFade(pa.motion) * distanceFade(d);
            if (alpha <= 0 || !projectSprite(b, d - step, course.itemX[i], w, h, 0, pb)) {
              continue;
            }
            const corner = (p: SpriteProjection, sx: number, top: boolean) =>
              [p.x + sx * p.halfWidth, p.base - (top ? p.height : 0)] as const;
            let worst = 0;
            for (const sx of [-1, 1]) {
              for (const top of [false, true]) {
                const [x0, y0] = corner(pa, sx, top);
                const [x1, y1] = corner(pb, sx, top);
                worst = Math.max(worst, Math.hypot(x1 - x0, y1 - y0) * 1080);
              }
            }
            expect(worst).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME * 1.05);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
    },
  );
});
