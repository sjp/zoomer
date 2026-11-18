/**
 * Road Racer's sprite list for a frame, pure so it can be tested: the
 * roadside scenery from far to near, the traffic car and the player's car
 * merged in by distance, each with its shadow (and, at night, the lamps'
 * glows), faded in out of the fog and out again before it moves faster than
 * the codec's per-frame limit. Written into a flat instance array for one
 * instanced draw.
 */
import { type CourseLook, SPRITE, SPRITE_HEIGHT, type SpriteAtlas } from "./roadracer-art";
import {
  type Course,
  DRAW,
  distanceFade,
  type Drive,
  firstItemAt,
  HORIZON,
  K_MAX,
  LAP,
  laneOffset,
  motionFade,
  NEAR,
  projectSprite,
  type RoadFrame,
  ROW,
  sampleLoop,
  type SpriteProjection,
  type TrafficState,
} from "./roadracer-sim";

/** Floats per sprite: centre and half size (low-res px, y down), atlas rect, tint, then fog, clip row and "lit". */
export const STRIDE = 16;
export const MAX_SPRITES = 600;

interface Scene {
  data: Float32Array;
  count: number;
}

export const createScene = (): Scene => ({
  data: new Float32Array(MAX_SPRITES * STRIDE),
  count: 0,
});

/** The scenery kind a course shows for an item, or -1 for none. */
export function sceneryKind(row: number, side: number, hash: number, look: CourseLook): number {
  const city = look.scenery === "city";
  const h = (hash >>> 8) % 100;
  switch (row) {
    case ROW.sign:
      return SPRITE.sign;
    case ROW.lamp:
      return city ? SPRITE.lamp : -1;
    case ROW.near:
      if (city) {
        return h < 30 ? SPRITE.bush : -1;
      }
      if (side < 0) {
        return h < 75 ? ((hash & 1) === 0 ? SPRITE.palm : SPRITE.palmLean) : SPRITE.rock;
      }
      return h < 45
        ? (hash & 1) === 0
          ? SPRITE.palm
          : SPRITE.palmLean
        : h < 80
          ? SPRITE.bush
          : SPRITE.rock;
    default:
      if (city) {
        return SPRITE.building0 + (hash % 3);
      }
      if (side < 0) {
        return -1;
      }
      return h < 35 ? SPRITE.hut : h < 80 ? SPRITE.palm : SPRITE.bush;
  }
}

/** Everything the scene needs besides the course and the projected road. */
export interface SceneInput {
  look: CourseLook;
  atlas: SpriteAtlas;
  drive: Drive;
  traffic: TrafficState;
  /** The player car's distance ahead of the camera. */
  carZ: number;
  /** Low-res frame size. */
  width: number;
  height: number;
}

const proj: SpriteProjection = {
  x: 0,
  base: 0,
  halfWidth: 0,
  height: 0,
  clip: 0,
  motion: 0,
  fog: 0,
};

/** The lamp's light in the atlas cell, as shares of its width and height. */
const LAMP_HEAD_X = 3.5 / 14;
const LAMP_HEAD_Y = 6.5 / 50;
const LAMP_LIGHT: readonly [number, number, number] = [1, 0.82, 0.5];

function put(
  scene: Scene,
  input: SceneInput,
  kind: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  flip: boolean,
  r: number,
  g: number,
  b: number,
  a: number,
  fog: number,
  clip: number,
  lit: number,
): void {
  if (scene.count >= MAX_SPRITES || !(hw > 0.05) || !(hh > 0.05)) {
    return;
  }
  const c = input.atlas.cells[kind];
  const o = scene.count * STRIDE;
  const d = scene.data;
  d[o] = cx;
  d[o + 1] = cy;
  d[o + 2] = hw;
  d[o + 3] = hh;
  d[o + 4] = flip ? c.x + c.w : c.x;
  d[o + 5] = c.y;
  d[o + 6] = flip ? c.x : c.x + c.w;
  d[o + 7] = c.y + c.h;
  d[o + 8] = r;
  d[o + 9] = g;
  d[o + 10] = b;
  d[o + 11] = a;
  d[o + 12] = fog;
  d[o + 13] = clip;
  d[o + 14] = lit;
  d[o + 15] = 0;
  scene.count++;
}

/** Projects and adds one standing sprite (and its shadow); returns its opacity. */
function standing(
  scene: Scene,
  frame: RoadFrame,
  input: SceneInput,
  kind: number,
  d: number,
  lateral: number,
  size: number,
  flip: boolean,
  advance: number,
  fade: number,
  fixed: boolean,
): number {
  const cell = input.atlas.cells[kind];
  const height = SPRITE_HEIGHT[kind] * size;
  const width = (height * cell.w) / cell.h;
  const look = input.look;
  const [shadowAlpha, stretch, shift] = look.shadow;
  const lowH = input.height;
  const midX = input.width / 2;
  // The shadow first, flat on the ground under it.
  if (
    shadowAlpha > 0 &&
    projectSprite(
      frame,
      d,
      lateral + shift * width,
      width * 1.1 * stretch,
      width * 0.12,
      advance,
      proj,
    )
  ) {
    const a = shadowAlpha * fade * (fixed ? 1 : motionFade(proj.motion) * distanceFade(d));
    if (a > 0.002) {
      put(
        scene,
        input,
        SPRITE.shadow,
        midX + proj.x * lowH,
        (HORIZON + proj.base) * lowH,
        proj.halfWidth * lowH,
        (proj.height / 2) * lowH,
        false,
        0,
        0,
        0,
        a,
        proj.fog,
        fixed ? lowH + 1 : (HORIZON + proj.clip) * lowH,
        1,
      );
    }
  }
  if (!projectSprite(frame, d, lateral, width, height, advance, proj)) {
    return 0;
  }
  const alpha = fade * (fixed ? 1 : motionFade(proj.motion) * distanceFade(d));
  if (!(alpha > 0.002)) {
    return 0;
  }
  put(
    scene,
    input,
    kind,
    midX + proj.x * lowH,
    (HORIZON + proj.base - proj.height / 2) * lowH,
    proj.halfWidth * lowH,
    (proj.height / 2) * lowH,
    flip,
    alpha,
    alpha,
    alpha,
    alpha,
    fixed ? 0 : proj.fog,
    fixed ? lowH + 1 : (HORIZON + proj.clip) * lowH,
    0,
  );
  return alpha;
}

/** A lamp's glow round its head and its pool of light on the road, added on. */
function lampLight(
  scene: Scene,
  frame: RoadFrame,
  input: SceneInput,
  d: number,
  lateral: number,
  size: number,
  flip: boolean,
  alpha: number,
): void {
  const lit = input.look.lit * alpha;
  if (!(lit > 0.002)) {
    return;
  }
  const cell = input.atlas.cells[SPRITE.lamp];
  const height = SPRITE_HEIGHT[SPRITE.lamp] * size;
  const width = (height * cell.w) / cell.h;
  const headX = lateral + (flip ? 0.5 - LAMP_HEAD_X : LAMP_HEAD_X - 0.5) * width;
  const headUp = height * (1 - LAMP_HEAD_Y);
  const lowH = input.height;
  const midX = input.width / 2;
  const [r, g, b] = LAMP_LIGHT;
  if (projectSprite(frame, d, headX, 2.2, 0.35, 0, proj)) {
    const k = lit * 0.35;
    put(
      scene,
      input,
      SPRITE.glow,
      midX + proj.x * lowH,
      (HORIZON + proj.base) * lowH,
      proj.halfWidth * lowH,
      (proj.height / 2) * lowH,
      false,
      r * k,
      g * k,
      b * k,
      0,
      proj.fog,
      (HORIZON + proj.clip) * lowH,
      1,
    );
  }
  if (projectSprite(frame, d, headX, 1.1, 1.1, 0, proj)) {
    const k = lit * 0.8;
    const cy = HORIZON + proj.base - headUp * (proj.height / 1.1);
    put(
      scene,
      input,
      SPRITE.glow,
      midX + proj.x * lowH,
      cy * lowH,
      proj.halfWidth * lowH,
      (proj.height / 2) * lowH,
      false,
      r * k,
      g * k,
      b * k,
      0,
      proj.fog,
      (HORIZON + proj.clip) * lowH,
      1,
    );
  }
}

/** The traffic car's kind for its hash. */
export const trafficKind = (hash: number) =>
  [SPRITE.hatchBlue, SPRITE.hatchOrange, SPRITE.van][(hash >>> 4) % 3];

/** Which frame of the player's car shows: leaning into a bend or a lane change. */
export function carFrame(course: Course, drive: Drive, carZ: number): number {
  let steer = sampleLoop(course.curve, drive.distance + carZ + 2) / K_MAX;
  if (drive.laneT > 0.15 && drive.laneT < 0.85) {
    steer += 0.6 * Math.sign(drive.laneTo - drive.laneFrom);
  }
  return steer > 0.35 ? SPRITE.carRight : steer < -0.35 ? SPRITE.carLeft : SPRITE.car;
}

/** Fills `scene` with this frame's sprites, far to near. */
export function buildScene(
  scene: Scene,
  frame: RoadFrame,
  course: Course,
  input: SceneInput,
): void {
  scene.count = 0;
  const { drive, traffic, look, carZ } = input;
  const S = drive.distance;
  const lane = laneOffset(drive);
  const trafficD = traffic.active ? carZ + traffic.gap : -1;
  let trafficDone = !traffic.active;
  let carDone = false;

  const dynamics = (beyond: number) => {
    if (!trafficDone && trafficD >= beyond) {
      trafficDone = true;
      const advance = (drive.speed * (1 - traffic.closing)) / 30;
      standing(
        scene,
        frame,
        input,
        trafficKind(traffic.hash),
        trafficD,
        -lane,
        1,
        false,
        advance,
        traffic.appear,
        false,
      );
    }
    if (!carDone && carZ >= beyond) {
      carDone = true;
      standing(
        scene,
        frame,
        input,
        carFrame(course, drive, carZ),
        carZ,
        lane,
        1,
        false,
        frame.refStep,
        1,
        true,
      );
    }
  };

  const n = course.itemCount;
  if (n > 0) {
    const farS = S + DRAW;
    let idx = firstItemAt(course, farS - Math.floor(farS / LAP) * LAP) - 1;
    for (let k = 0; k < n; k++) {
      if (idx < 0) {
        idx += n;
      }
      const s = course.itemS[idx];
      const rel = s - (S - Math.floor(S / LAP) * LAP);
      const d = rel - Math.floor(rel / LAP) * LAP;
      if (d < NEAR || d > DRAW) {
        break;
      }
      dynamics(d);
      const x = course.itemX[idx];
      const side = x < 0 ? -1 : 1;
      const hash = course.itemHash[idx];
      const row = course.itemRow[idx];
      const kind = sceneryKind(row, side, hash, look);
      if (kind >= 0) {
        const size = row === ROW.sign || row === ROW.lamp ? 1 : 0.85 + ((hash >>> 4) & 15) / 50;
        const flip = row === ROW.sign ? hash === 0 : row === ROW.lamp ? side < 0 : (hash & 2) !== 0;
        const alpha = standing(scene, frame, input, kind, d, x, size, flip, 0, 1, false);
        if (kind === SPRITE.lamp) {
          lampLight(scene, frame, input, d, x, size, flip, alpha);
        }
      }
      idx--;
    }
  }
  dynamics(-Infinity);
}
