/**
 * The Vaporwave scene's layout and motion, with no GL: where the bust, palms,
 * caption and dialog boxes sit for a frame size, the bust's turn, the palms'
 * sway, the floor's drift, the dialog boxes' bob and occasional move, and the
 * Lo-fi tracking band.
 *
 * Everything animated runs on a motion clock that advances at the Motion
 * param's rate, and every amplitude is scaled by it too, so Motion 0 is a
 * still image. Param changes (a toggle, a new variation) still fade, at a
 * floor rate, so they never pop.
 */
import { approach, clamp, wrap } from "../math";
import { createRng, hash32 } from "../noise";
import { BUST_BOTTOM, BUST_RADIUS, BUST_TOP } from "./bust-mesh";

/** Layout is in reference px: the frame is 1080 tall. */
export const REF_HEIGHT = 1080;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---------------------------------------------------------------------------
// Layout

/** The horizon's height, as a fraction of the frame from the top. */
const HORIZON = 0.6;
/** The speaker's area: the middle 40% across, from a quarter of the way down. */
const CLEAR_LEFT = 0.3;
const CLEAR_RIGHT = 0.7;
const CLEAR_TOP = 0.25;
/** Margin kept from the frame's edges and between boxes, ref px. */
const MARGIN = 12;

/** The caption band: katakana over the spaced-out caption, centred along the top. */
const CAPTION_TOP = 40;
const CAPTION_BOTTOM = 250;
const CAPTION_HALF = 460;
const CAPTION_HALF_FRACTION = 0.46;
/** Line centres, ref px from the top. */
export const KANA_Y = 98;
export const CAPTION_Y = 188;
/** Font sizes, ref px, before shrinking to fit the band. */
export const KANA_PX = 54;
export const CAPTION_PX = 82;

/** The camera looks down on the bust by this much, radians, so the pillar's top shows. */
export const BUST_TILT = 0.09;
/** Ref px per bust unit, at most: the bust and pillar stand about 600 px tall. */
const BUST_UNIT = 88;
/** The bust layer's extent in bust units, with room for any turn and the tilt. */
const BUST_SPAN_TOP = BUST_TOP * Math.cos(BUST_TILT) + BUST_RADIUS * Math.sin(BUST_TILT);
const BUST_SPAN_BOTTOM = BUST_BOTTOM * Math.cos(BUST_TILT) - BUST_RADIUS * Math.sin(BUST_TILT);
/** Where the pillar's foot stands, as a fraction of the frame from the top. */
const BUST_FOOT = 0.965;

/** Dialog box size, ref px, before shrinking to fit narrow frames. */
export const WINDOW_W = 300;
export const WINDOW_H = 150;
const MIN_WINDOW_SCALE = 0.45;
/** A 16:9 frame's width, ref px. */
const WIDE_WIDTH = (REF_HEIGHT * 16) / 9;

/** Palm sprites are this wide for their height; the trunk's foot is at the bottom centre. */
export const PALM_ASPECT = 0.75;
/** The palms' zone (right of the speaker) is this wide before they shrink. */
const PALM_ZONE = 520;
/** Each palm slot: height and foot as fractions of the frame, and where across the zone. */
const PALM_SLOTS: readonly (readonly [number, number, number])[] = [
  [0.66, 0.9, 0.62],
  [0.52, 0.82, 0.3],
  [0.44, 0.78, 0.9],
];
/** Palm sway, radians each way at full motion: a degree and a half. */
export const MAX_SWAY = 0.026;
/** Palm art variants. */
export const PALM_VARIANTS = 3;

interface Palm {
  /** The trunk's foot, ref px. */
  x: number;
  y: number;
  /** Sprite height, ref px; its width is `PALM_ASPECT` times this. */
  height: number;
  variant: number;
  /** Mirrored left to right. */
  flip: boolean;
  /** Sway period, seconds, and phase, radians. */
  period: number;
  phase: number;
}

interface Layout {
  /** Frame width, ref px (the height is `REF_HEIGHT`). */
  width: number;
  horizon: number;
  clear: Box;
  caption: Box;
  /** The bust layer's rect (bust and pillar at any turn), ref px. */
  bust: Box;
  /** Ref px per bust unit, the turning axis's x, and the layer's top and bottom in bust units. */
  bustUnit: number;
  bustAxis: number;
  bustTop: number;
  bustBottom: number;
  palms: Palm[];
  windowScale: number;
}

const overlaps = (a: Box, b: Box, gap = 0) =>
  a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap;

/** Bounds of a palm rotated by `angle` about its foot, ref px. */
export function palmBox(p: Palm, angle: number, out: Box): Box {
  const hw = (p.height * PALM_ASPECT) / 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out.minX = Infinity;
  out.minY = Infinity;
  out.maxX = -Infinity;
  out.maxY = -Infinity;
  for (const cx of [-hw, hw]) {
    for (const cy of [0, -p.height]) {
      const x = p.x + cx * c - cy * s;
      const y = p.y + cx * s + cy * c;
      out.minX = Math.min(out.minX, x);
      out.maxX = Math.max(out.maxX, x);
      out.minY = Math.min(out.minY, y);
      out.maxY = Math.max(out.maxY, y);
    }
  }
  return out;
}

/** The palms for a variation, right of the speaker: two or three, shrinking on narrow frames. */
function layoutPalms(seed: number, width: number, clear: Box): Palm[] {
  const zone = Math.max(0, width - clear.maxX);
  const scale = Math.min(1, zone / PALM_ZONE);
  const palms: Palm[] = [];
  if (scale <= 0) {
    return palms;
  }
  const count = hash32(seed * 31 + 7) % 2 === 0 ? 2 : 3;
  const box: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  for (let i = 0; i < count; i++) {
    // One stream per palm, so a variation's palms don't depend on each other.
    const rand = createRng(hash32(seed * 977 + i * 131 + 3));
    const [h, foot, across] = PALM_SLOTS[i];
    const palm: Palm = {
      x: clear.maxX + zone * (across + (rand() - 0.5) * 0.12),
      y: REF_HEIGHT * (foot + (rand() - 0.5) * 0.03),
      height: REF_HEIGHT * h * (0.92 + 0.16 * rand()) * scale,
      variant: Math.floor(rand() * PALM_VARIANTS) % PALM_VARIANTS,
      flip: rand() < 0.5,
      period: 7 + 4 * rand(),
      phase: rand() * 2 * Math.PI,
    };
    // Keep the whole sprite, at either end of its sway, right of the speaker.
    const left = Math.min(palmBox(palm, MAX_SWAY, box).minX, palmBox(palm, -MAX_SWAY, box).minX);
    const need = clear.maxX + MARGIN - left;
    if (need > 0) {
      palm.x += need;
    }
    palms.push(palm);
  }
  return palms;
}

/** Lays the scene out for a frame `width` ref px wide. */
export function computeLayout(width: number, seed: number): Layout {
  const w = Number.isFinite(width) && width > 0 ? width : REF_HEIGHT;
  const clear: Box = {
    minX: w * CLEAR_LEFT,
    minY: REF_HEIGHT * CLEAR_TOP,
    maxX: w * CLEAR_RIGHT,
    maxY: REF_HEIGHT,
  };
  const half = Math.min(CAPTION_HALF, w * CAPTION_HALF_FRACTION);
  const caption: Box = {
    minX: w / 2 - half,
    minY: CAPTION_TOP,
    maxX: w / 2 + half,
    maxY: CAPTION_BOTTOM,
  };
  // The bust fills the space left of the speaker, smaller (and so lower) on narrow frames.
  const span = 2 * BUST_RADIUS;
  const unit = clamp((clear.minX - 2 * MARGIN) / span, 0, BUST_UNIT);
  const axis = clear.minX / 2;
  const foot = REF_HEIGHT * BUST_FOOT;
  const bust: Box = {
    minX: axis - BUST_RADIUS * unit,
    maxX: axis + BUST_RADIUS * unit,
    minY: foot - (BUST_SPAN_TOP - BUST_SPAN_BOTTOM) * unit,
    maxY: foot,
  };
  // Dialog boxes shrink with the space beside the speaker, and on frames narrower than 16:9.
  const windowScale = clamp(
    Math.min((clear.minX - 2 * MARGIN) / (WINDOW_W + 2 * MARGIN), w / WIDE_WIDTH),
    MIN_WINDOW_SCALE,
    1,
  );
  return {
    width: w,
    horizon: REF_HEIGHT * HORIZON,
    clear,
    caption,
    bust,
    bustUnit: unit,
    bustAxis: axis,
    bustTop: BUST_SPAN_TOP,
    bustBottom: BUST_SPAN_BOTTOM,
    palms: layoutPalms(seed, w, clear),
    windowScale,
  };
}

// ---------------------------------------------------------------------------
// The floor

/** The camera's focal length, ref px, at a height of 1 above the floor. */
export const FLOOR_FOCAL = 800;
/** Checker square size, in camera heights. */
export const FLOOR_CELL = 0.5;
/** Squares a second the floor drifts at full motion: far below a codec's limits. */
const DRIFT_CELLS_PER_SECOND = 0.25;

/** How fast the floor drifts towards the viewer, camera heights a second. */
export const floorDriftSpeed = (motion: number) =>
  DRIFT_CELLS_PER_SECOND * FLOOR_CELL * clamp(motion, 0, 1);

/**
 * How fast the floor's pattern moves down the screen at row `y` (ref px from
 * the top) for a drift `speed`, ref px a second: rows nearer the bottom move
 * fastest.
 */
export function floorRowSpeed(y: number, horizon: number, speed: number): number {
  const d = Math.max(0, y - horizon);
  return (d * d * speed) / FLOOR_FOCAL;
}

// ---------------------------------------------------------------------------
// Motion

/** The bust's turn at full motion, radians a second: once a minute. */
export const SPIN_RATE = (2 * Math.PI) / 60;
/** The bust's rest angle, turned a little towards the middle of the frame. */
export const REST_ANGLE = 0.45;
/** Seconds a fade (a dialog box, a palm, the floor's drift starting) takes. */
const FADE_SECONDS = 1.5;
/** Fades run at least this fast whatever the Motion, so param changes still finish. */
const MIN_FADE_RATE = 0.25;
/** Seconds Motion takes to ease from 0 to 1. */
const MOTION_EASE = 1;
/** Dialog box bob, ref px each way at full motion, and its periods. */
const BOB_X = 6;
const BOB_Y = 4;
const BOB_PERIOD_X = 9;
const BOB_PERIOD_Y = 6.5;
/** Seconds of motion clock between one dialog box moving and the next. */
const SWAP_GAP_MIN = 20;
const SWAP_GAP_SPAN = 14;
/** Most dialog boxes at once. */
export const WINDOW_COUNT = 3;
/** Tries to find a free spot for a dialog box. */
const PLACE_TRIES = 80;
/** Grid step of the sweep for a spot when the tries all fail, ref px. */
const PLACE_STEP = 8;
/** Randomness in which free spot is taken, ref px of distance from the sky's sides. */
const PLACE_JITTER = 160;
/** The tracking band: one roll up the screen every period, taking `TRACK_ROLL` seconds. */
const TRACK_PERIOD = 15;
const TRACK_ROLL = 6;

interface DialogBox {
  /** Whether it has a spot. */
  live: boolean;
  /** Centre, ref px. */
  x: number;
  y: number;
  alpha: number;
  /** Fading out to move elsewhere. */
  moving: boolean;
  /** Bumped each time it moves, so its art can change. */
  serial: number;
  /** The variation it was placed under, which picks its text with the serial. */
  artSeed: number;
  phaseX: number;
  phaseY: number;
}

export interface Scene {
  seed: number;
  layout: Layout;
  /** The variation the palms show; follows `seed` after they fade out. */
  palmSeed: number;
  palmAlpha: number;
  windows: DialogBox[];
  /** Seconds of motion clock (advances at the Motion param's rate). */
  clock: number;
  nextSwap: number;
  swaps: number;
  /** Eased Motion. */
  motion: number;
  angle: number;
  /** 1 while the bust turns, easing to 0 when it stops. */
  spin: number;
  /** 1 while the floor drifts. */
  drift: number;
  /** The floor's drift, camera heights, wrapped to two squares. */
  floor: number;
}

/** The box a dialog box reserves at its centre: its rect plus its bob. */
export function windowBox(layout: Layout, x: number, y: number, out: Box): Box {
  const hw = (WINDOW_W / 2) * layout.windowScale;
  const hh = (WINDOW_H / 2) * layout.windowScale;
  out.minX = x - hw - BOB_X;
  out.maxX = x + hw + BOB_X;
  out.minY = y - hh - BOB_Y;
  out.maxY = y + hh + BOB_Y;
  return out;
}

/** Where dialog boxes may float: the sky, inside the frame. */
export function skyBox(layout: Layout): Box {
  return {
    minX: MARGIN,
    minY: MARGIN,
    maxX: layout.width - MARGIN,
    maxY: layout.horizon - MARGIN,
  };
}

/** Whether dialog box `i` may sit with its centre at (x, y). */
function spotFree(scene: Scene, i: number, x: number, y: number): boolean {
  const l = scene.layout;
  const box = windowBox(l, x, y, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const sky = skyBox(l);
  if (box.minX < sky.minX || box.maxX > sky.maxX || box.minY < sky.minY || box.maxY > sky.maxY) {
    return false;
  }
  if (overlaps(box, l.clear) || overlaps(box, l.caption, MARGIN) || overlaps(box, l.bust, MARGIN)) {
    return false;
  }
  const other: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  for (let k = 0; k < scene.windows.length; k++) {
    const w = scene.windows[k];
    if (k !== i && w.live && overlaps(box, windowBox(l, w.x, w.y, other), MARGIN)) {
      return false;
    }
  }
  return true;
}

/** Finds dialog box `i` a free spot for its next serial; it goes dark if there is none. */
function place(scene: Scene, i: number): void {
  const w = scene.windows[i];
  w.live = false;
  w.artSeed = scene.seed;
  const sky = skyBox(scene.layout);
  const rand = createRng(hash32(scene.seed * 7919 + w.serial * 104729 + i * 31 + 1));
  w.phaseX = rand() * 2 * Math.PI;
  w.phaseY = rand() * 2 * Math.PI;
  const take = (x: number, y: number) => {
    if (!spotFree(scene, i, x, y)) {
      return false;
    }
    w.x = x;
    w.y = y;
    w.live = true;
    return true;
  };
  // Of a handful of random free spots, take the one nearest a side of the sky
  // (give or take), leaving the most room for the others.
  let bestX = 0;
  let bestY = 0;
  let best = Infinity;
  for (let t = 0; t < PLACE_TRIES; t++) {
    const x = sky.minX + rand() * (sky.maxX - sky.minX);
    const y = sky.minY + rand() * (sky.maxY - sky.minY);
    const score =
      Math.min(x - sky.minX, sky.maxX - x) +
      0.5 * Math.min(y - sky.minY, sky.maxY - y) +
      PLACE_JITTER * rand();
    if (score < best && spotFree(scene, i, x, y)) {
      best = score;
      bestX = x;
      bestY = y;
    }
  }
  if (best < Infinity && take(bestX, bestY)) {
    return;
  }
  // Space is tight (a narrow frame, or the others took the easy spots): sweep for one.
  const x0 = rand() * PLACE_STEP;
  const y0 = rand() * PLACE_STEP;
  for (let y = sky.minY + y0; y < sky.maxY; y += PLACE_STEP) {
    for (let x = sky.minX + x0; x < sky.maxX; x += PLACE_STEP) {
      if (take(x, y)) {
        return;
      }
    }
  }
}

const swapGap = (scene: Scene) =>
  SWAP_GAP_MIN + SWAP_GAP_SPAN * (hash32(scene.seed * 13 + scene.swaps * 7 + 5) / 4294967296);

/** A scene for a frame `width` ref px wide, everything shown and at rest. */
export function createScene(seed: number, width: number): Scene {
  const scene: Scene = {
    seed,
    layout: computeLayout(width, seed),
    palmSeed: seed,
    palmAlpha: 1,
    windows: [],
    clock: 0,
    nextSwap: 0,
    swaps: 0,
    motion: 1,
    angle: REST_ANGLE,
    spin: 1,
    drift: 0,
    floor: 0,
  };
  for (let i = 0; i < WINDOW_COUNT; i++) {
    scene.windows.push({
      live: false,
      x: 0,
      y: 0,
      alpha: 0,
      moving: false,
      serial: i,
      artSeed: seed,
      phaseX: 0,
      phaseY: 0,
    });
    place(scene, i);
    scene.windows[i].alpha = scene.windows[i].live ? 1 : 0;
  }
  scene.nextSwap = swapGap(scene);
  return scene;
}

/**
 * Starts the scene's first frame from the params: the toggles' current state
 * and Motion, without easing into them.
 */
export function startScene(
  scene: Scene,
  motion: number,
  spin: boolean,
  drift: boolean,
  windows: boolean,
): void {
  scene.motion = clamp(motion, 0, 1);
  scene.spin = spin ? 1 : 0;
  scene.drift = drift ? 1 : 0;
  if (!windows) {
    for (const w of scene.windows) {
      w.alpha = 0;
    }
  }
}

/** Takes a new variation: the palms and dialog boxes fade out and come back rearranged. */
export function reseed(scene: Scene, seed: number): void {
  if (seed === scene.seed) {
    return;
  }
  scene.seed = seed;
  for (const w of scene.windows) {
    w.moving = true;
  }
}

/**
 * Lays the scene out again for a new frame width. The bust and palms follow at
 * once; a dialog box that no longer fits fades out and moves.
 */
export function resizeScene(scene: Scene, width: number): void {
  const palms = computeLayout(width, scene.palmSeed);
  scene.layout = computeLayout(width, scene.seed);
  scene.layout.palms = palms.palms;
  scene.windows.forEach((w, i) => {
    if (!w.live || !spotFree(scene, i, w.x, w.y)) {
      w.moving = true;
      if (!w.live || w.alpha <= 0) {
        w.serial += WINDOW_COUNT;
        place(scene, i);
        w.moving = false;
      }
    }
  });
}

/** Advances the scene by `dt` seconds. */
export function stepScene(
  scene: Scene,
  dt: number,
  motionParam: number,
  spinOn: boolean,
  driftOn: boolean,
  windowsOn: boolean,
): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  scene.motion = approach(scene.motion, clamp(motionParam, 0, 1), step / MOTION_EASE);
  const m = scene.motion;
  const fade = (step * Math.max(m, MIN_FADE_RATE)) / FADE_SECONDS;
  scene.clock += step * m;

  // The bust turns at full rate while spinning; stopped, it eases back to rest,
  // never faster than it spins, so its veins stay within the codec budget.
  scene.spin = approach(scene.spin, spinOn ? 1 : 0, fade);
  const back = wrap(REST_ANGLE - scene.angle, -Math.PI, 2 * Math.PI);
  const ret = clamp(0.8 * back, -SPIN_RATE, SPIN_RATE);
  scene.angle += step * m * (SPIN_RATE * scene.spin + (1 - scene.spin) * ret);
  scene.angle = wrap(scene.angle, -Math.PI, 2 * Math.PI);

  scene.drift = approach(scene.drift, driftOn ? 1 : 0, fade);
  scene.floor = wrap(scene.floor + step * floorDriftSpeed(m) * scene.drift, 0, 2 * FLOOR_CELL);

  // A new variation's palms swap in once the old ones have faded out.
  const palmsDue = scene.palmSeed !== scene.seed;
  scene.palmAlpha = approach(scene.palmAlpha, palmsDue ? 0 : 1, fade);
  if (palmsDue && scene.palmAlpha <= 0) {
    scene.palmSeed = scene.seed;
    scene.layout.palms = computeLayout(scene.layout.width, scene.seed).palms;
  }

  // Now and then one dialog box fades out and comes back somewhere else.
  if (scene.clock >= scene.nextSwap) {
    let shown = 0;
    for (const w of scene.windows) {
      if (w.live && !w.moving && w.alpha >= 1) {
        shown++;
      }
    }
    if (shown > 0 && windowsOn) {
      let pick = scene.swaps % shown;
      for (const w of scene.windows) {
        if (w.live && !w.moving && w.alpha >= 1 && pick-- === 0) {
          w.moving = true;
        }
      }
    }
    scene.swaps++;
    scene.nextSwap = scene.clock + swapGap(scene);
  }
  for (let i = 0; i < scene.windows.length; i++) {
    const w = scene.windows[i];
    const show = windowsOn && w.live && !w.moving;
    w.alpha = approach(w.alpha, show ? 1 : 0, fade);
    if (w.moving && w.alpha <= 0) {
      w.moving = false;
      w.serial += WINDOW_COUNT;
      place(scene, i);
    }
  }
}

/** A dialog box's bob offset now, ref px. */
export function windowOffset(scene: Scene, w: DialogBox, out: { x: number; y: number }): void {
  const m = scene.motion;
  out.x = BOB_X * m * Math.sin((2 * Math.PI * scene.clock) / BOB_PERIOD_X + w.phaseX);
  out.y = BOB_Y * m * Math.sin((2 * Math.PI * scene.clock) / BOB_PERIOD_Y + w.phaseY);
}

/** A palm's sway now, radians. */
export const palmSway = (scene: Scene, p: Palm) =>
  MAX_SWAY * scene.motion * Math.sin((2 * Math.PI * scene.clock) / p.period + p.phase);

/**
 * The tracking band now: its centre as a fraction of the frame from the bottom
 * (it rolls up), and its strength, 0 between rolls and at Motion 0.
 */
export function trackingBand(scene: Scene, out: { y: number; strength: number }): void {
  const t = wrap(scene.clock, 0, TRACK_PERIOD);
  if (t >= TRACK_ROLL) {
    out.y = -1;
    out.strength = 0;
    return;
  }
  const f = t / TRACK_ROLL;
  out.y = -0.1 + 1.2 * f;
  out.strength = Math.sin(Math.PI * f) * scene.motion;
}
