/**
 * Such Background's pure logic, in reference px (the frame is `REF_HEIGHT` tall
 * and `refWidth` wide, y down): which phrase shows next, where it goes in the
 * ring round the edges, its colour, tilt and drift, its fade in and out, and the
 * shiba's blinks and side-eye glances.
 *
 * A phrase's whole drift is known when it spawns, so it reserves the box it
 * sweeps over its life: boxes are checked once, at placement, against the clear
 * centre, the frame's edges, the shiba's corner and every other live phrase's
 * box, and can never collide later.
 */
import { CLASHING_COLORS } from "../meme-art";
import { approach, clamp, smoothstep } from "../math";
import { createRng } from "../noise";
import { MAX_COUNT } from "./suchwow.meta";

export const REF_HEIGHT = 1080;

/** The phrases shown when the `phrases` param is empty. */
export const DEFAULT_PHRASES = [
  "such meeting",
  "very agenda",
  "much synergy",
  "so circle back",
  "many stakeholders",
  "wow",
  "very muted",
  "such bandwidth",
  "much deliverable",
  "so sync",
] as const;

/** The phrase colours: the meme palette plus a red and a blue. */
export const PHRASE_COLORS = [...CLASHING_COLORS, "#ff3030", "#2f6bff"] as const;

/**
 * The phrases in `text`, one per line: trimmed, single-spaced, lower-cased and
 * without repeats; the built-in list when there are none.
 */
export function phraseList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const phrase = line.trim().replace(/\s+/g, " ").toLowerCase();
    if (phrase !== "" && !out.includes(phrase)) {
      out.push(phrase);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_PHRASES];
}

// ---------------------------------------------------------------------------
// Layout

/** The clear centre, as shares of the frame's width and height. */
const CLEAR_WIDTH = 0.5;
const CLEAR_HEIGHT = 0.6;
/** Gap kept between a phrase and the frame's edge. */
export const EDGE_MARGIN = 20;
/** Gap kept between two phrases' boxes. */
const PHRASE_GAP = 14;
/** Boxes closer than this count as touching: they never share a colour. */
export const TOUCH_GAP = 80;
/** Font size, and the share either way it varies by. */
const FONT_SIZE = 54;
const FONT_SPREAD = 0.12;
/** Frames narrower than this get smaller text, down to this share of the size. */
const NARROW_WIDTH = 1440;
const NARROW_FONT = 0.65;
/** A phrase's box: its height in ems, and the padding either side, ems (room for the outline). */
const BOX_EMS = 1.45;
const SIDE_EMS = 0.15;
/** The width a phrase's text is taken to have, ems per character, where it can't be measured. */
const FALLBACK_EMS_PER_CHAR = 0.55;
/** Largest tilt either way, radians. */
const MAX_TILT = 0.09;
/** Drift speed range, px per second. */
const DRIFT_MIN = 1.5;
const DRIFT_MAX = 4;
/** Placement tries per spawn, and seconds before trying again when none fits. */
const CANDIDATES = 16;
const RETRY = 0.25;

/** The shiba's square, px, and its gap from the bottom-right corner. */
export const SHIBA_SIZE = 180;
const SHIBA_MARGIN = 18;

/** An axis-aligned box. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boxesWithin = (a: Box, b: Box, gap: number) =>
  a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap;

/** The clear centre for a frame `refWidth` wide. */
export function clearBox(refWidth: number, out: Box): Box {
  const x = (refWidth * (1 - CLEAR_WIDTH)) / 2;
  const y = (REF_HEIGHT * (1 - CLEAR_HEIGHT)) / 2;
  out.minX = x;
  out.maxX = refWidth - x;
  out.minY = y;
  out.maxY = REF_HEIGHT - y;
  return out;
}

/** The shiba's square in the bottom-right corner for a frame `refWidth` wide. */
export function shibaBox(refWidth: number, out: Box): Box {
  out.maxX = refWidth - SHIBA_MARGIN;
  out.maxY = REF_HEIGHT - SHIBA_MARGIN;
  out.minX = out.maxX - SHIBA_SIZE;
  out.minY = out.maxY - SHIBA_SIZE;
  return out;
}

// ---------------------------------------------------------------------------
// Phrases

/** Seconds a phrase fades in and out over at full motion, and its hold range. */
const FADE_IN = 1;
const FADE_OUT = 1;
const HOLD_MIN = 6;
const HOLD_MAX = 10;
/**
 * The slowest the fades run, as a share of full speed: at low motion, phrases
 * added or dismissed by a param change still come and go.
 */
const MIN_FADE_RATE = 0.25;

/** Phrase slots: the most visible at once, and as many again fading out. */
export const CAPACITY = 2 * MAX_COUNT;

interface Phrase {
  /** Whether the slot holds a phrase (shown or fading out). */
  live: boolean;
  /** Counts the slot's spawns, so the renderer knows when to repaint it. */
  serial: number;
  text: string;
  /** Index into `PHRASE_COLORS`. */
  color: number;
  /** Font size and the unrotated box, px. */
  font: number;
  width: number;
  height: number;
  /** Tilt, radians. */
  angle: number;
  /** Centre at spawn, drift velocity (px/s) and current centre. */
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
  /** Motion-scaled seconds since spawn, and when it starts to fade out. */
  t: number;
  leaveAt: number;
  /** Opacity, 0..1. */
  alpha: number;
  /** Fading out early (a lower count, a new variation, a resize or the shiba arriving). */
  dismissed: boolean;
  /** The box its rotated rectangle sweeps over its whole life. */
  readonly box: Box;
}

const createPhrase = (): Phrase => ({
  live: false,
  serial: 0,
  text: "",
  color: 0,
  font: FONT_SIZE,
  width: 0,
  height: 0,
  angle: 0,
  x0: 0,
  y0: 0,
  vx: 0,
  vy: 0,
  x: 0,
  y: 0,
  t: 0,
  leaveAt: 0,
  alpha: 0,
  dismissed: false,
  box: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
});

/** Measures `text`'s advance in ems of the phrase font, or undefined where it can't. */
export type MeasureEm = (text: string) => number | undefined;

export interface Field {
  readonly phrases: Phrase[];
  /** The phrases to pick from. */
  list: string[];
  /** The frame width, px. */
  refWidth: number;
  /** Whether the shiba's corner is kept clear. */
  shiba: boolean;
  started: boolean;
  /** When each phrase text last spawned, as a spawn count. */
  readonly lastShown: Map<string, number>;
  spawns: number;
  rng: () => number;
  /** Seconds until the next placement try. */
  retry: number;
  readonly measure: MeasureEm;
  /** Scratch: list indices, for picking the next phrase. */
  order: number[];
  /** Scratch boxes for placement. */
  readonly clear: Box;
  readonly corner: Box;
  readonly candidate: Box;
}

export function createField(
  seed: number,
  refWidth: number,
  list: readonly string[],
  measure: MeasureEm,
): Field {
  return {
    phrases: Array.from({ length: CAPACITY }, createPhrase),
    list: [...list],
    refWidth,
    shiba: false,
    started: false,
    lastShown: new Map(),
    spawns: 0,
    rng: createRng(seed * 7919 + 17),
    retry: 0,
    measure,
    order: [],
    clear: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    corner: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    candidate: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
}

/** Phrases shown and not on their way out. */
export function wantedCount(f: Field): number {
  let n = 0;
  for (const p of f.phrases) {
    if (p.live && !p.dismissed && p.t < p.leaveAt) {
      n++;
    }
  }
  return n;
}

/** The phrases visible at all (alpha above zero). */
export function visibleTexts(f: Field): string[] {
  return f.phrases.filter((p) => p.live && p.alpha > 0).map((p) => p.text);
}

function isLive(f: Field, text: string): boolean {
  for (const p of f.phrases) {
    if (p.live && p.text === text) {
      return true;
    }
  }
  return false;
}

/**
 * Picks the next phrase: one not on screen, chosen at random from the third of
 * the list shown longest ago, so a phrase comes back only once most of the
 * others have had a turn. Undefined when every phrase is on screen.
 */
function pickText(f: Field): string | undefined {
  const order = f.order;
  order.length = 0;
  for (let i = 0; i < f.list.length; i++) {
    if (!isLive(f, f.list[i])) {
      order.push(i);
    }
  }
  if (order.length === 0) {
    return undefined;
  }
  const shown = (i: number) => f.lastShown.get(f.list[i]) ?? -1;
  order.sort((a, b) => shown(a) - shown(b) || a - b);
  const pool = Math.max(1, Math.ceil(f.list.length / 3));
  const k = Math.floor(f.rng() * Math.min(pool, order.length));
  return f.list[order[k]];
}

/** The width of `text`'s box in ems. */
function boxEms(f: Field, text: string): number {
  const measured = f.measure(text);
  const ems =
    measured !== undefined && Number.isFinite(measured) && measured > 0
      ? measured
      : Array.from(text).length * FALLBACK_EMS_PER_CHAR;
  return ems + 2 * SIDE_EMS;
}

/**
 * Whether `box` is clear of the shiba's corner and every live phrase but `self`
 * (or, with `keptOnly`, every one not on its way out).
 */
function boxFree(f: Field, box: Box, self: Phrase, keptOnly = false): boolean {
  if (f.shiba && boxesWithin(box, shibaBox(f.refWidth, f.corner), PHRASE_GAP)) {
    return false;
  }
  for (const p of f.phrases) {
    if (p !== self && p.live && !(keptOnly && p.dismissed) && boxesWithin(box, p.box, PHRASE_GAP)) {
      return false;
    }
  }
  return true;
}

/** Whether `box` lies inside the frame (less its margin) and clear of the centre. */
function boxInRing(f: Field, box: Box): boolean {
  const W = f.refWidth;
  if (
    box.minX < EDGE_MARGIN - 1e-6 ||
    box.minY < EDGE_MARGIN - 1e-6 ||
    box.maxX > W - EDGE_MARGIN + 1e-6 ||
    box.maxY > REF_HEIGHT - EDGE_MARGIN + 1e-6
  ) {
    return false;
  }
  return !boxesWithin(box, clearBox(W, f.clear), 0);
}

/**
 * Tries to place a phrase in slot `p`: a few random tilts, drifts and spots in
 * the ring, keeping the first that is clear of everything. `t` and `alpha` start
 * it part-way through its life. Returns whether it was placed.
 */
function spawn(f: Field, p: Phrase, text: string, t: number, alpha: number): boolean {
  const rng = f.rng;
  const W = f.refWidth;
  const H = REF_HEIGHT;
  const ems = boxEms(f, text);
  const leaveAt = FADE_IN + HOLD_MIN + (HOLD_MAX - HOLD_MIN) * rng();
  const life = leaveAt + FADE_OUT;
  // Shrink the font of a phrase too long for the widest band.
  const widest = Math.max(W - 2 * EDGE_MARGIN, (W * (1 - CLEAR_WIDTH)) / 2 - EDGE_MARGIN);
  // Narrow frames (portrait) get smaller text, so more than a couple fit.
  const narrow = clamp(Math.sqrt(W / NARROW_WIDTH), NARROW_FONT, 1);
  const font = Math.min(
    FONT_SIZE * narrow * (1 + FONT_SPREAD * (2 * rng() - 1)),
    (0.85 * widest - DRIFT_MAX * life) / ems,
  );
  if (!(font > 8)) {
    return false;
  }
  const width = ems * font;
  const height = BOX_EMS * font;
  const clear = clearBox(W, f.clear);
  const box = f.candidate;
  for (let k = 0; k < CANDIDATES; k++) {
    const angle = MAX_TILT * (2 * rng() - 1);
    const heading = 2 * Math.PI * rng();
    const speed = DRIFT_MIN + (DRIFT_MAX - DRIFT_MIN) * rng();
    const vx = speed * Math.cos(heading);
    const vy = speed * Math.sin(heading);
    const c = Math.abs(Math.cos(angle));
    const s = Math.abs(Math.sin(angle));
    const sw = width * c + height * s + Math.abs(vx) * life;
    const sh = width * s + height * c + Math.abs(vy) * life;
    // The four bands round the centre, as ranges for the box's top-left corner.
    const m = EDGE_MARGIN;
    const spanX = W - 2 * m - sw;
    const spanTop = clear.minY - m - sh;
    const spanBottom = H - m - clear.maxY - sh;
    const spanSide = H - 2 * m - sh;
    const spanLeft = clear.minX - m - sw;
    const spanRight = W - m - clear.maxX - sw;
    const wTop = spanX >= 0 && spanTop >= 0 ? (spanX + 1) * (spanTop + 1) : 0;
    const wBottom = spanX >= 0 && spanBottom >= 0 ? (spanX + 1) * (spanBottom + 1) : 0;
    const wLeft = spanSide >= 0 && spanLeft >= 0 ? (spanLeft + 1) * (spanSide + 1) : 0;
    const wRight = spanSide >= 0 && spanRight >= 0 ? (spanRight + 1) * (spanSide + 1) : 0;
    const total = wTop + wBottom + wLeft + wRight;
    const pick = rng() * total;
    const u = rng();
    const v = rng();
    if (total <= 0) {
      continue;
    }
    if (pick < wTop) {
      box.minX = m + u * spanX;
      box.minY = m + v * spanTop;
    } else if (pick < wTop + wBottom) {
      box.minX = m + u * spanX;
      box.minY = clear.maxY + v * spanBottom;
    } else if (pick < wTop + wBottom + wLeft) {
      box.minX = m + u * spanLeft;
      box.minY = m + v * spanSide;
    } else {
      box.minX = clear.maxX + u * spanRight;
      box.minY = m + v * spanSide;
    }
    box.maxX = box.minX + sw;
    box.maxY = box.minY + sh;
    if (!boxInRing(f, box) || !boxFree(f, box, p)) {
      continue;
    }
    p.live = true;
    p.serial++;
    p.text = text;
    p.color = pickColor(f, box, p);
    p.font = font;
    p.width = width;
    p.height = height;
    p.angle = angle;
    p.vx = vx;
    p.vy = vy;
    p.x0 = box.minX + (width * c + height * s) / 2 - Math.min(0, vx) * life;
    p.y0 = box.minY + (width * s + height * c) / 2 - Math.min(0, vy) * life;
    p.leaveAt = leaveAt;
    p.t = Math.min(t, leaveAt);
    p.x = p.x0 + vx * p.t;
    p.y = p.y0 + vy * p.t;
    p.alpha = alpha;
    p.dismissed = false;
    p.box.minX = box.minX;
    p.box.minY = box.minY;
    p.box.maxX = box.maxX;
    p.box.maxY = box.maxY;
    f.lastShown.set(text, f.spawns++);
    return true;
  }
  return false;
}

/**
 * A colour for a phrase placed at `box`: never one a touching phrase has,
 * preferably one no phrase on screen has, otherwise at random.
 */
function pickColor(f: Field, box: Box, self: Phrase): number {
  const n = PHRASE_COLORS.length;
  let near = 0;
  let used = 0;
  for (const p of f.phrases) {
    if (p !== self && p.live) {
      used |= 1 << p.color;
      if (boxesWithin(box, p.box, TOUCH_GAP)) {
        near |= 1 << p.color;
      }
    }
  }
  const all = (1 << n) - 1;
  const fresh = all & ~used & ~near;
  const allowed = all & ~near;
  const mask = fresh !== 0 ? fresh : allowed !== 0 ? allowed : all;
  let count = 0;
  for (let i = 0; i < n; i++) {
    count += (mask >> i) & 1;
  }
  let k = Math.floor(f.rng() * count);
  for (let i = 0; i < n; i++) {
    if ((mask >> i) & 1) {
      if (k === 0) {
        return i;
      }
      k--;
    }
  }
  return 0;
}

/** Spawns one phrase in a free slot. Returns whether it did. */
function spawnOne(f: Field, t: number, alpha: number): boolean {
  for (const slot of f.phrases) {
    if (!slot.live) {
      const text = pickText(f);
      return text !== undefined && spawn(f, slot, text, t, alpha);
    }
  }
  return false;
}

/** Phrases to show for a `count` param: never more than the list has. */
export const targetCount = (f: Field, count: number) =>
  clamp(Math.min(Math.round(count), f.list.length, MAX_COUNT), 0, MAX_COUNT);

/** Sends every phrase on its way out. */
function dismissAll(f: Field): void {
  for (const p of f.phrases) {
    if (p.live) {
      p.dismissed = true;
    }
  }
}

/**
 * Switches to a new variation: the phrases on screen fade out and new ones,
 * picked and placed from the new seed, take their place.
 */
export function reseed(f: Field, seed: number): void {
  f.rng = createRng(seed * 7919 + 17);
  dismissAll(f);
  f.retry = 0;
}

/** New phrases come from `list`; those on screen live out their time. */
export function setList(f: Field, list: readonly string[]): void {
  f.list = [...list];
}

/**
 * Carries the phrases over to a frame `refWidth` wide: positions scale across
 * with the frame, and any phrase that no longer fits (in the centre, off the
 * edge, or on another) fades out.
 */
export function resizeField(f: Field, refWidth: number): void {
  if (refWidth === f.refWidth || !(refWidth > 0)) {
    return;
  }
  const k = refWidth / f.refWidth;
  f.refWidth = refWidth;
  for (const p of f.phrases) {
    if (!p.live) {
      continue;
    }
    const dx = p.x0 * (k - 1);
    p.x0 += dx;
    p.x += dx;
    p.box.minX += dx;
    p.box.maxX += dx;
  }
  for (const p of f.phrases) {
    if (p.live && !p.dismissed && (!boxInRing(f, p.box) || !boxFree(f, p.box, p, true))) {
      p.dismissed = true;
    }
  }
  f.retry = 0;
}

/**
 * Advances the phrases by `dt` seconds: `count` phrases shown at once (fewer if
 * the list is short or the ring is full), `motion` scaling their drift, hold and
 * fades, and `shiba` keeping its corner clear.
 */
export function stepField(
  f: Field,
  dt: number,
  count: number,
  motion: number,
  shiba: boolean,
): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const m = clamp(Number.isFinite(motion) ? motion : 0, 0, 1);
  const target = targetCount(f, count);
  if (shiba && !f.shiba) {
    // The shiba arrives: phrases in its corner make way.
    const corner = shibaBox(f.refWidth, f.corner);
    for (const p of f.phrases) {
      if (p.live && boxesWithin(p.box, corner, PHRASE_GAP)) {
        p.dismissed = true;
      }
    }
  }
  f.shiba = shiba;

  if (!f.started) {
    // A settled arrangement from the first frame, leaving times spread out.
    f.started = true;
    for (let i = 0; i < target; i++) {
      spawnOne(f, (i / target) * HOLD_MIN, 1);
    }
  }

  // A lower count sends the oldest extra phrases out.
  let wanted = wantedCount(f);
  while (wanted > target) {
    let oldest: Phrase | null = null;
    for (const p of f.phrases) {
      if (p.live && !p.dismissed && p.t < p.leaveAt && (!oldest || p.t > oldest.t)) {
        oldest = p;
      }
    }
    if (!oldest) {
      break;
    }
    oldest.dismissed = true;
    wanted--;
  }

  const fade = Math.max(m, MIN_FADE_RATE) * step;
  for (const p of f.phrases) {
    if (!p.live) {
      continue;
    }
    p.t = Math.min(p.t + m * step, p.leaveAt + FADE_OUT);
    p.x = p.x0 + p.vx * p.t;
    p.y = p.y0 + p.vy * p.t;
    const leaving = p.dismissed || p.t >= p.leaveAt;
    p.alpha = leaving
      ? approach(p.alpha, 0, fade / FADE_OUT)
      : approach(p.alpha, 1, fade / FADE_IN);
    if (leaving && p.alpha <= 0) {
      p.live = false;
    }
  }

  f.retry -= step;
  if (f.retry <= 0 && wantedCount(f) < target) {
    f.retry = spawnOne(f, 0, 0) ? 0 : RETRY;
  }
}

// ---------------------------------------------------------------------------
// The shiba

/** Seconds the shiba fades in or out when switched on or off. */
const SHIBA_FADE = 1;
/** Seconds between blinks, and a blink's length. */
const BLINK_MIN = 3;
const BLINK_MAX = 7;
const BLINK_LENGTH = 0.15;
/** Seconds between side-eye glances, the slide each way, and the hold. */
const GLANCE_MIN = 7;
const GLANCE_MAX = 13;
const GLANCE_SLIDE = 0.9;
const GLANCE_HOLD = 2.5;

interface Shiba {
  /** Opacity, 0..1. */
  presence: number;
  /** Motion-scaled seconds. */
  time: number;
  blinkAt: number;
  glanceAt: number;
  /** Eyes closed this frame. */
  blink: boolean;
  /** How far the eyes have slid into the side-eye, 0..1. */
  look: number;
  readonly rng: () => number;
}

export function createShiba(seed: number): Shiba {
  const rng = createRng(seed * 104729 + 3);
  return {
    presence: 0,
    time: 0,
    blinkAt: 1 + BLINK_MIN * rng(),
    glanceAt: 2 + GLANCE_MIN * rng(),
    blink: false,
    look: 0,
    rng,
  };
}

/** Advances the shiba by `dt`: fading with `on`, its clocks scaled by `motion`. */
export function stepShiba(s: Shiba, dt: number, motion: number, on: boolean): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  s.presence = approach(s.presence, on ? 1 : 0, step / SHIBA_FADE);
  s.time += clamp(Number.isFinite(motion) ? motion : 0, 0, 1) * step;
  while (s.time >= s.blinkAt + BLINK_LENGTH) {
    s.blinkAt += BLINK_MIN + (BLINK_MAX - BLINK_MIN) * s.rng();
  }
  const glanceLength = 2 * GLANCE_SLIDE + GLANCE_HOLD;
  while (s.time >= s.glanceAt + glanceLength) {
    s.glanceAt += glanceLength + GLANCE_MIN + (GLANCE_MAX - GLANCE_MIN) * s.rng();
  }
  s.blink = s.time >= s.blinkAt;
  const g = s.time - s.glanceAt;
  s.look =
    g <= 0
      ? 0
      : smoothstep(0, GLANCE_SLIDE, g) *
        (1 - smoothstep(glanceLength - GLANCE_SLIDE, glanceLength, g));
}
