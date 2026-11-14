/**
 * Blue Screen's pure logic: the progress count (seeded ticks that slow near the
 * end, a long wait at 99% and a quiet restart), the kernel log's schedule and its
 * made-up stack-trace lines, the cursor's soft blink, and the Classic style's
 * mapping onto the dot-matrix font.
 */
import { glyphRows, GLYPHS } from "../dot-matrix";
import { smoothstep } from "../math";
import { hash32 } from "../noise";

export type BlueStyle = "modern" | "classic" | "kernel";
export type BlueHue = "blue" | "green" | "black";

/** The style for a `style` param value, Modern for anything unknown. */
export function blueStyle(value: string): BlueStyle {
  return value === "classic" || value === "kernel" ? value : "modern";
}

/** The hue for a `hue` param value, Blue for anything unknown. */
export function blueHue(value: string): BlueHue {
  return value === "green" || value === "black" ? value : "blue";
}

/** A uniform number in [0, 1) from a seed and two keys. */
function unit(seed: number, a: number, b: number): number {
  return (
    hash32(hash32(hash32(seed >>> 0) ^ Math.imul(a, 0x9e3779b1)) ^ Math.imul(b, 0x85ebca6b)) /
    4294967296
  );
}

/** Most sim events one step handles, so a huge `dt` can't stall a frame. */
const MAX_EVENTS = 1000;

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** The count stops here and waits; it never shows 100. */
export const TOP_PERCENT = 99;
/** Seconds between ticks, before the slow-down near the end. */
export const TICK_MIN = 5;
export const TICK_MAX = 20;
/** The count slows from here on, each step stretching the gaps by `SLOW_PER_STEP`. */
const SLOW_FROM = 90;
const SLOW_PER_STEP = 0.4;
/** Seconds the count waits at 99% before restarting. */
export const HOLD_MIN = 180;
export const HOLD_MAX = 300;
/** The count a fresh run starts from, and the range a restart drops back to. */
const FIRST_MIN = 12;
const FIRST_MAX = 48;
export const RESTART_MIN = 1;
export const RESTART_MAX = 9;

export interface Progress {
  readonly seed: number;
  /** Runs completed so far (restarts). */
  cycle: number;
  percent: number;
  /** Seconds until the next tick, or until the restart at 99%. */
  timer: number;
  /** Counts changes, so a renderer can tell when to redraw. */
  version: number;
  /** Whether the latest change was a restart (it crossfades longer). */
  restarted: boolean;
}

/** Seconds from `percent` to the next tick (or, at the top, to the restart). */
export function tickSeconds(seed: number, cycle: number, percent: number): number {
  const u = unit(seed, cycle, percent);
  if (percent >= TOP_PERCENT) {
    return HOLD_MIN + (HOLD_MAX - HOLD_MIN) * u;
  }
  const slow = percent < SLOW_FROM ? 1 : 1 + (percent - SLOW_FROM + 1) * SLOW_PER_STEP;
  return (TICK_MIN + (TICK_MAX - TICK_MIN) * u) * slow;
}

/** The count a run starts from: seeded, low for a restart, middling for the first. */
function startPercent(seed: number, cycle: number): number {
  const u = unit(seed, cycle, 1000);
  return cycle === 0
    ? FIRST_MIN + Math.floor(u * (FIRST_MAX - FIRST_MIN + 1))
    : RESTART_MIN + Math.floor(u * (RESTART_MAX - RESTART_MIN + 1));
}

export function createProgress(seed: number): Progress {
  const s = Math.floor(seed) >>> 0;
  const percent = startPercent(s, 0);
  return {
    seed: s,
    cycle: 0,
    percent,
    timer: tickSeconds(s, 0, percent),
    version: 0,
    restarted: false,
  };
}

/** Advances the count by `dt` seconds of its own time (already scaled by speed). */
export function stepProgress(p: Progress, dt: number): void {
  if (!(dt > 0)) {
    return;
  }
  p.timer -= dt;
  for (let n = 0; p.timer <= 0 && n < MAX_EVENTS; n++) {
    if (p.percent < TOP_PERCENT) {
      p.percent++;
      p.restarted = false;
    } else {
      p.cycle++;
      p.percent = startPercent(p.seed, p.cycle);
      p.restarted = true;
    }
    p.version++;
    p.timer += tickSeconds(p.seed, p.cycle, p.percent);
  }
  p.timer = Math.max(p.timer, 0);
}

export function copyProgress(from: Progress): Progress {
  return { ...from };
}

export const percentText = (percent: number) => `${String(percent)}% complete`;

// ---------------------------------------------------------------------------
// Kernel log
// ---------------------------------------------------------------------------

/** Stack-trace lines the Kernel style shows below "Call Trace:". */
export const TRACE_ROWS = 10;
/** Seconds between new trace lines. */
export const LINE_MIN = 10;
export const LINE_MAX = 20;

export interface TraceLog {
  readonly seed: number;
  /** Index of the newest line; the log shows `head - TRACE_ROWS + 1 .. head`. */
  head: number;
  timer: number;
  version: number;
}

const lineSeconds = (seed: number, index: number) =>
  LINE_MIN + (LINE_MAX - LINE_MIN) * unit(seed, index, 7);

export function createTraceLog(seed: number): TraceLog {
  const s = Math.floor(seed) >>> 0;
  const head = TRACE_ROWS - 1;
  return { seed: s, head, timer: lineSeconds(s, head + 1), version: 0 };
}

/** Advances the log by `dt` seconds of its own time, adding lines as they fall due. */
export function stepTraceLog(log: TraceLog, dt: number): void {
  if (!(dt > 0)) {
    return;
  }
  log.timer -= dt;
  for (let n = 0; log.timer <= 0 && n < MAX_EVENTS; n++) {
    log.head++;
    log.version++;
    log.timer += lineSeconds(log.seed, log.head + 1);
  }
  log.timer = Math.max(log.timer, 0);
}

export function copyTraceLog(from: TraceLog): TraceLog {
  return { ...from };
}

/** Made-up kernel functions, the joke of the stack trace. */
const TRACE_FUNCTIONS: readonly string[] = [
  "snooze_alarm",
  "reply_all_storm",
  "unmute_self",
  "you_are_on_mute",
  "share_wrong_screen",
  "can_you_see_my_screen",
  "circle_back",
  "synergy_alloc",
  "touch_base",
  "calendar_conflict",
  "take_this_offline",
  "coffee_underflow",
  "blame_the_wifi",
  "jiggle_mouse",
  "fix_hair_in_preview",
  "echo_cancel_fail",
  "dog_barking_irq",
  "doorbell_interrupt",
  "status_set_away",
  "inbox_zero_panic",
  "lunch_overrun",
  "agenda_not_found",
  "ping_everyone",
  "kick_can_down_road",
  "deadline_extend",
  "blur_background_oom",
  "frozen_face_detect",
  "quick_sync_spawn",
  "parking_lot_push",
  "per_my_last_email",
];

const hex = (n: number, digits: number) => (n >>> 0).toString(16).padStart(digits, "0");

/** The longest trace line, in characters. */
export const MAX_TRACE_CHARS =
  " [<ffffffff12345678>] ".length + Math.max(...TRACE_FUNCTIONS.map((f) => f.length)) + 12;

/**
 * Trace line `index` for `seed`: an address, a silly function name and an
 * offset, in the shape of a kernel stack trace. Blank for negative indices.
 */
export function traceLine(seed: number, index: number): string {
  if (index < 0) {
    return "";
  }
  const h = hash32(hash32(seed >>> 0) ^ Math.imul(index + 1, 0x27d4eb2d));
  const name = TRACE_FUNCTIONS[h % TRACE_FUNCTIONS.length];
  const addr = hex(0x81000000 + (hash32(h) & 0x00fffff0), 8);
  const size = 0x40 + (hash32(h ^ 0x5bd1e995) % 0x3c0);
  const off = (hash32(h + 1) % size) & ~3;
  return ` [<ffffffff${addr}>] ${name}+0x${off.toString(16)}/0x${size.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** The cursor's blinks per second. */
export const CURSOR_HZ = 1;

/** The cursor's opacity at `time` seconds: a soft, faded blink rather than a hard on / off. */
export function cursorAlpha(time: number): number {
  return smoothstep(-0.5, 0.5, Math.cos(2 * Math.PI * CURSOR_HZ * time));
}

// ---------------------------------------------------------------------------
// Classic text
// ---------------------------------------------------------------------------

/**
 * Glyphs the Classic style adds to the dot-matrix font, as seven rows of five
 * dots, top first, for the punctuation its messages use.
 */
const EXTRA_GLYPHS: ReadonlyMap<string, string> = new Map([
  ["_", ".....|.....|.....|.....|.....|.....|#####"],
  [",", ".....|.....|.....|.....|.##..|..#..|.#..."],
  ["'", "..#..|..#..|.#...|.....|.....|.....|....."],
  ["!", "..#..|..#..|..#..|..#..|..#..|.....|..#.."],
  ["?", ".###.|#...#|....#|...#.|..#..|.....|..#.."],
  ["(", "...#.|..#..|.#...|.#...|.#...|..#..|...#."],
  [")", ".#...|..#..|...#.|...#.|...#.|..#..|.#..."],
  ["*", ".....|..#..|#.#.#|.###.|#.#.#|..#..|....."],
  ["=", ".....|.....|#####|.....|#####|.....|....."],
  ["%", "##...|##..#|...#.|..#..|.#...|#..##|...##"],
  ["#", ".#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#."],
]);

/** Every character the Classic style can draw. */
export const CLASSIC_CHARS = GLYPHS + [...EXTRA_GLYPHS.keys()].join("");

/** Stand-ins for characters the Classic font lacks. */
const CLASSIC_SUBSTITUTES: ReadonlyMap<string, string> = new Map([
  ['"', "'"],
  ["‘", "'"],
  ["’", "'"],
  ["“", "'"],
  ["”", "'"],
  [";", ":"],
  ["&", "+"],
  ["–", "-"],
  ["—", "-"],
  ["[", "("],
  ["]", ")"],
  ["{", "("],
  ["}", ")"],
  ["…", "."],
]);

/**
 * `text` as the Classic style shows it: upper case, with characters the font
 * lacks swapped for a near one or a space. Line breaks are kept.
 */
export function classicText(text: string): string {
  let out = "";
  for (const raw of text) {
    if (raw === "\n") {
      out += raw;
      continue;
    }
    const ch = raw.toUpperCase();
    if (ch.length === 1 && CLASSIC_CHARS.includes(ch)) {
      out += ch;
    } else {
      out += CLASSIC_SUBSTITUTES.get(raw) ?? " ";
    }
  }
  return out;
}

/** A Classic glyph's dots: `GLYPH_H` strings of "#" or ".", top row first. */
export function classicGlyphRows(ch: string): string[] {
  const extra = EXTRA_GLYPHS.get(ch);
  return extra === undefined ? glyphRows(ch) : extra.split("|");
}
