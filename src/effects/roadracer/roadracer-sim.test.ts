import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import {
  BAND,
  BOUNDARIES,
  buildCourse,
  cameraHeight,
  CAR_LENGTH,
  CAR_W,
  carDistance,
  carScreenX,
  type Course,
  createDrive,
  createRoadFrame,
  cruiseSpeed,
  DRAW,
  firstItemAt,
  FOCAL,
  formatLapTime,
  GAP_START,
  HORIZON,
  K_MAX,
  LAP,
  LANE_CLEAR,
  laneBlocked,
  laneChangePeak,
  laneOffset,
  LAYER_PERIOD,
  NEAR,
  PARALLAX,
  panRate,
  projectRoad,
  projectSprite,
  projectX,
  projectY,
  ROAD_HALF,
  sampleLoop,
  SEGMENTS,
  speedKmh,
  type SpriteProjection,
  stepDrive,
  TRAFFIC_PERIOD,
  TRAFFIC_SPAN,
  trafficAt,
  type TrafficState,
  V_TOP,
  viewScale,
  WINDOW_WIDTH,
} from "./roadracer-sim";

const SEEDS = [0, 1, 2, 7, 42, 99, 123, 500, 998];

/** A flat, straight course for projection checks. */
function flatCourse(): Course {
  const course = buildCourse(1);
  course.curve.fill(0);
  course.elev.fill(0);
  return course;
}

const newTraffic = (): TrafficState => ({ active: false, gap: 0, closing: 0, appear: 0, hash: 0 });
const newProjection = (): SpriteProjection => ({
  x: 0,
  base: 0,
  halfWidth: 0,
  height: 0,
  clip: 0,
  motion: 0,
  fog: 0,
});

describe("course", () => {
  it.each(SEEDS)("is the same every time for seed %i, and differs from the next seed", (seed) => {
    const a = buildCourse(seed);
    const b = buildCourse(seed);
    expect(Array.from(a.curve)).toEqual(Array.from(b.curve));
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev));
    expect(Array.from(a.itemS)).toEqual(Array.from(b.itemS));
    expect(Array.from(a.itemHash)).toEqual(Array.from(b.itemHash));
    expect(Array.from(buildCourse(seed + 1).curve)).not.toEqual(Array.from(a.curve));
  });

  it.each(SEEDS)("loops with smooth curves and hills for seed %i", (seed) => {
    const { curve, elev } = buildCourse(seed);
    expect(curve.length).toBe(SEGMENTS);
    let sharpest = 0;
    let curveStep = 0;
    let elevStep = 0;
    let kink = 0;
    for (let i = 0; i < SEGMENTS; i++) {
      const prev = (i + SEGMENTS - 1) % SEGMENTS;
      const next = (i + 1) % SEGMENTS;
      sharpest = Math.max(sharpest, Math.abs(curve[i]));
      // Eased over several segments: no step in the curvature, no kink in the hills.
      curveStep = Math.max(curveStep, Math.abs(curve[next] - curve[i]));
      elevStep = Math.max(elevStep, Math.abs(elev[next] - elev[i]));
      kink = Math.max(kink, Math.abs(elev[next] - 2 * elev[i] + elev[prev]));
    }
    expect(sharpest).toBeLessThanOrEqual(K_MAX + 1e-6);
    expect(curveStep).toBeLessThan(0.02);
    expect(elevStep).toBeLessThan(0.25);
    expect(kink).toBeLessThan(0.06);
    // Straight and flat through the start line, where the loop joins.
    expect(curve[0]).toBe(0);
    expect(elev[0]).toBe(0);
    expect(sampleLoop(curve, LAP - 0.5)).toBe(0);
  });

  it.each(SEEDS)("has bends, mostly right-handers, and hills for seed %i", (seed) => {
    const { curve, elev } = buildCourse(seed);
    // Mostly right-handers, so the circuit runs clockwise.
    expect(Math.max(...curve)).toBeGreaterThan(0.02);
    expect(curve.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(Math.max(...elev.map((e) => Math.abs(e)))).toBeGreaterThan(0.5);
  });

  it("places scenery in order round the lap, beside the road", () => {
    const course = buildCourse(3);
    expect(course.itemCount).toBeGreaterThan(100);
    const items = Array.from(course.itemS.subarray(0, course.itemCount));
    expect(Math.min(...items)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...items)).toBeLessThan(LAP);
    expect(items).toEqual(items.toSorted((a, b) => a - b));
    const onRoad: number[] = [];
    for (let i = 0; i < course.itemCount; i++) {
      if (Math.abs(course.itemX[i]) <= ROAD_HALF) {
        onRoad.push(i);
      }
    }
    expect(onRoad).toEqual([]);
    expect(firstItemAt(course, 0)).toBe(0);
    expect(firstItemAt(course, LAP)).toBe(course.itemCount);
  });

  it("keeps the scenery's places when only another row would change (one stream per row and side)", () => {
    const a = buildCourse(4);
    const sAt = (c: Course, row: number) =>
      Array.from(c.itemS).filter((_, i) => c.itemRow[i] === row && c.itemX[i] > 0);
    expect(sAt(a, 0).length).toBeGreaterThan(20);
    expect(sAt(a, 1).length).toBeGreaterThan(20);
  });

  it.each(SEEDS)("draws a closed course map in 0..1 for seed %i", (seed) => {
    const { map } = buildCourse(seed);
    expect(Math.min(...map)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.max(...map)).toBeLessThanOrEqual(1 + 1e-6);
    const n = SEGMENTS;
    const gap = Math.hypot(map[0] - map[(n - 1) * 2], map[1] - map[(n - 1) * 2 + 1]);
    expect(gap).toBeLessThan(0.05);
  });
});

describe("projection", () => {
  it("puts a point on the horizon at any height as it recedes, and a near one low", () => {
    expect(projectY(1, 1e6)).toBeCloseTo(0, 5);
    expect(projectX(5, 1e8)).toBeCloseTo(0, 5);
    expect(projectY(1, 2)).toBeCloseTo(0.5 * FOCAL);
    expect(projectX(ROAD_HALF, 1)).toBeCloseTo(ROAD_HALF * FOCAL);
  });

  it("fills every row below the horizon with a flat road's depth, and none above", () => {
    const frame = createRoadFrame(600);
    const rows = 540;
    projectRoad(frame, flatCourse(), 10, 1, 1, rows);
    const t = frame.table;
    const horizonRow = rows * (HORIZON + projectY(1, NEAR + BOUNDARIES - 1));
    for (let r = 0; r < rows; r++) {
      const z = t[r * 4 + 3];
      expect(z === 0).toBe(r + 0.5 <= horizonRow);
    }
    for (let r = Math.ceil(horizonRow); r < rows; r++) {
      const yh = (r + 0.5) / rows - HORIZON;
      const z = t[r * 4 + 3];
      // The ground point under the row: depth from the camera height, centred road.
      expect(z).toBeCloseTo(FOCAL / yh, 2);
      expect(t[r * 4]).toBeCloseTo(0, 6);
      expect(t[r * 4 + 1]).toBeCloseTo((ROAD_HALF * FOCAL) / z, 4);
      expect(t[r * 4 + 2]).toBeCloseTo((10 + z) % LAP, 2);
    }
    // The bottom row is close to the camera, the top ground row near the draw distance.
    expect(t[(rows - 1) * 4 + 3]).toBeLessThan(2);
  });

  it("projects a sprite at the car's distance onto the car's base line", () => {
    const frame = createRoadFrame(600);
    projectRoad(frame, flatCourse(), 0, 1, 0, 540);
    const p = newProjection();
    const carZ = carDistance(1);
    expect(projectSprite(frame, carZ, 0, 1, 1, 0, p)).toBe(true);
    expect(p.base).toBeCloseTo(0.47, 3);
    expect(p.halfWidth).toBeCloseTo(0.5 / carZ, 4);
    expect(projectSprite(frame, NEAR / 2, 0, 1, 1, 0, p)).toBe(false);
    expect(projectSprite(frame, DRAW + 5, 0, 1, 1, 0, p)).toBe(false);
  });

  it("hides the road beyond a crest: rows above the crest's line show no ground from behind it", () => {
    const course = flatCourse();
    for (let i = 10; i <= 40; i++) {
      course.elev[i] = 2 * Math.sin(((i - 10) / 30) * Math.PI);
    }
    const frame = createRoadFrame(600);
    // Near the top of the hill, the road beyond drops out of view.
    projectRoad(frame, course, 24, 1, 1, 540);
    let sky = 0;
    for (let r = 0; r < 540; r++) {
      if (frame.table[r * 4 + 3] === 0) {
        sky++;
      }
    }
    expect(sky).toBeGreaterThan(540 * HORIZON);
  });
});

describe("codec limits", () => {
  it.each([0.2, 0.5, 1])("passes stripes at most MAX_PATTERN_HZ at speed %f", (slider) => {
    for (const seed of SEEDS) {
      const course = buildCourse(seed);
      for (let s = 0; s < LAP; s += 5) {
        // Bands of BAND alternate, so the pattern repeats every two.
        expect(cruiseSpeed(course, s, slider) / (2 * BAND)).toBeLessThanOrEqual(MAX_PATTERN_HZ);
      }
    }
  });

  it.each(SEEDS)(
    "keeps every sharp stripe row under the per-frame limit at the top speed (seed %i)",
    (seed) => {
      const course = buildCourse(seed);
      const frame = createRoadFrame(1100);
      const rows = 1080;
      // The fastest row's motion and the furthest a row is drawn from its point, in px.
      let fastest = 0;
      let offset = 0;
      for (let s = 0; s < LAP; s += 7.3) {
        projectRoad(frame, course, s, 1, V_TOP, rows);
        const step = V_TOP / 30;
        const camNext = sampleLoop(course.elev, s + step) + 1;
        for (let r = 0; r < rows; r++) {
          const z = frame.table[r * 4 + 3];
          const contrast = frame.table[rows * 4 + r * 4];
          if (z === 0 || contrast === 0) {
            continue;
          }
          // The ground point the row shows, now and one 30 fps frame later.
          const ground = sampleLoop(course.elev, s + z);
          const now = projectY(frame.camY - ground, z);
          const after = projectY(camNext - ground, z - step);
          fastest = Math.max(fastest, Math.abs(after - now) * 1080);
          // And the row is where that point is drawn, give or take the table's straight steps.
          offset = Math.max(offset, Math.abs(now - ((r + 0.5) / rows - HORIZON)) * 1080);
        }
      }
      expect(fastest).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      expect(offset).toBeLessThan(4);
    },
  );

  it("pans the background layers within the limits on the sharpest bend at the top speed", () => {
    for (const share of [PARALLAX.far, PARALLAX.near, PARALLAX.clouds]) {
      expect(pxPerReferenceFrame(panRate(K_MAX, V_TOP, share))).toBeLessThanOrEqual(
        MAX_FEATURE_PX_PER_FRAME,
      );
    }
    // Columns of skyline windows pass slower than the pattern limit.
    expect(panRate(K_MAX, V_TOP, PARALLAX.far) / WINDOW_WIDTH.far).toBeLessThanOrEqual(
      MAX_PATTERN_HZ,
    );
    expect(panRate(K_MAX, V_TOP, PARALLAX.near) / WINDOW_WIDTH.near).toBeLessThanOrEqual(
      MAX_PATTERN_HZ,
    );
    // The window columns tile their layer's loop exactly, so the wrap is seamless.
    for (const key of ["far", "near"] as const) {
      const n = LAYER_PERIOD[key] / WINDOW_WIDTH[key];
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9);
    }
  });

  it("changes lanes slower than the per-frame limit, the camera's turn included", () => {
    const carZ = carDistance(1);
    expect(pxPerReferenceFrame(laneChangePeak(carZ))).toBeLessThan(MAX_FEATURE_PX_PER_FRAME);
    expect(pxPerReferenceFrame(laneChangePeak(carZ) + K_MAX * V_TOP * FOCAL)).toBeLessThan(
      2 * MAX_FEATURE_PX_PER_FRAME,
    );
  });
});

describe("traffic", () => {
  it("is a pure function of the distance driven", () => {
    const a = newTraffic();
    const b = newTraffic();
    for (let d = 0; d < 3000; d += 13.7) {
      trafficAt(5, d, a);
      trafficAt(5, d, b);
      expect(a).toEqual(b);
    }
  });

  it("appears far ahead, closes, and drops behind, one car at a time", () => {
    const t = newTraffic();
    let cars = 0;
    let wasActive = false;
    let lastGap = Infinity;
    let firstGap = Infinity;
    let lastBeforeGone = -Infinity;
    let widening = 0;
    let closing = [1, 0];
    for (let d = 0; d < TRAFFIC_PERIOD * 20; d += 0.25) {
      trafficAt(9, d, t);
      if (t.active && !wasActive) {
        cars++;
        firstGap = Math.min(firstGap, t.gap);
        lastGap = Infinity;
      }
      if (t.active) {
        widening += t.gap >= lastGap ? 1 : 0;
        closing = [Math.min(closing[0], t.closing), Math.max(closing[1], t.closing)];
        lastGap = t.gap;
      } else if (wasActive) {
        lastBeforeGone = Math.max(lastBeforeGone, lastGap);
      }
      wasActive = t.active;
    }
    expect(cars).toBe(20);
    expect(firstGap).toBeGreaterThan(GAP_START - 1);
    expect(widening).toBe(0);
    expect(closing[0]).toBeGreaterThan(0);
    expect(closing[1]).toBeLessThan(1);
    expect(lastBeforeGone).toBeLessThan(-CAR_LENGTH);
    expect(TRAFFIC_SPAN).toBeLessThan(TRAFFIC_PERIOD);
  });

  it.each(SEEDS)("is never alongside the player's car in its lane (seed %i)", (seed) => {
    const course = buildCourse(seed);
    const drive = createDrive(1);
    const t = newTraffic();
    let want = 1;
    let toggle = 3 + (seed % 5);
    let blockedOnce = false;
    let closest = Infinity;
    const dt = 1 / 15;
    for (let i = 0; i < 15 * 60 * 40; i++) {
      toggle -= dt;
      if (toggle <= 0) {
        want = -want;
        toggle = 2 + ((i * 7919) % 23);
      }
      const blocked = laneBlocked(seed, drive.distance);
      blockedOnce ||= blocked;
      stepDrive(drive, course, 1, want, blocked, dt);
      trafficAt(seed, drive.distance, t);
      if (t.active && Math.abs(t.gap) < CAR_LENGTH) {
        // Traffic keeps to the other lane: the gap across is twice the player's offset.
        closest = Math.min(closest, 2 * Math.abs(laneOffset(drive)));
      }
    }
    expect(closest).toBeGreaterThanOrEqual(CAR_W);
    expect(blockedOnce).toBe(true);
    expect(LANE_CLEAR).toBeGreaterThan(CAR_LENGTH);
  });
});

describe("driving", () => {
  it("eases up to the cruising speed and slows for sharp bends", () => {
    const course = buildCourse(2);
    const drive = createDrive(1);
    for (let i = 0; i < 600; i++) {
      stepDrive(drive, course, 1, 1, false, 1 / 30);
    }
    expect(drive.speed).toBeGreaterThan(0.7 * V_TOP);
    expect(drive.speed).toBeLessThanOrEqual(V_TOP);
    expect(speedKmh(V_TOP)).toBe(180);
    expect(speedKmh(0)).toBe(0);
  });

  it("restarts the lap clock at the start line", () => {
    const course = buildCourse(2);
    const drive = createDrive(1);
    drive.distance = LAP - 0.05;
    drive.speed = 1;
    drive.lapTime = 123.4;
    stepDrive(drive, course, 0.6, 1, false, 0.1);
    expect(drive.distance).toBeGreaterThan(LAP);
    expect(drive.lapTime).toBeGreaterThan(0);
    expect(drive.lapTime).toBeLessThan(0.1);
    stepDrive(drive, course, 0.6, 1, false, 0.5);
    expect(drive.lapTime).toBeGreaterThan(0.5);
  });

  it("formats lap times to tenths", () => {
    expect(formatLapTime(0)).toBe("0:00.0");
    expect(formatLapTime(83.47)).toBe("1:23.4");
    expect(formatLapTime(59.99)).toBe("0:59.9");
    expect(formatLapTime(600)).toBe("10:00.0");
    expect(formatLapTime(1e9)).toBe("99:59.9");
    expect(formatLapTime(Number.NaN)).toBe("0:00.0");
  });

  it("waits for traffic to clear before changing lanes, then eases across", () => {
    const course = buildCourse(2);
    const drive = createDrive(1);
    stepDrive(drive, course, 0.5, -1, true, 1);
    expect(drive.laneTo).toBe(1);
    stepDrive(drive, course, 0.5, -1, false, 1);
    expect(drive.laneTo).toBe(-1);
    expect(laneOffset(drive)).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) {
      stepDrive(drive, course, 0.5, -1, false, 1);
    }
    expect(laneOffset(drive)).toBeCloseTo(-0.7);
  });
});

describe("view", () => {
  it.each([
    [1920, 1080],
    [2560, 1080],
    [1080, 1920],
    [1024, 768],
  ])("keeps the car inside a %i x %i frame", (w, h) => {
    const cam = cameraHeight(viewScale(w, h));
    const carZ = carDistance(cam);
    const frame = createRoadFrame(600);
    projectRoad(frame, flatCourse(), 0, cam, 0, 540);
    const halfFrame = w / h / 2;
    for (const lane of [-0.7, 0.7]) {
      const x = carScreenX(frame, lane, carZ);
      expect(Math.abs(x) + (CAR_W / 2) * (FOCAL / carZ)).toBeLessThan(halfFrame);
    }
  });
});
