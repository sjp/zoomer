/**
 * Jet Cockpit model, all pure functions of time so it can be tested without
 * stepping:
 *
 * - The bank: about once a minute the view rolls a few degrees to one side,
 *   eased, holds, and rolls back to level.
 * - Near clouds: every 20 to 60 s the jet flies through the edge of a cloud,
 *   which softly fogs the view outside for a second or so.
 * - The displays' readings: each changes now and then, at the readout events
 *   of the bridge's panels, and dims for a moment at their dim events.
 * - The sky's palettes for each time of day, and how the cockpit is lit.
 */
import type { Block } from "../bridge/bridge-panels";
import { type BlockEvent, blockEvent, eventWeight, slotLength } from "../bridge/bridge-sim";
import { hexToUnitRgb, type Rgb } from "../color";
import { createDawnState, sampleDawn } from "../cloudsea/cloudsea-sim";
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import { ease } from "../starfighter/starfighter-sim";
import type { JetTime } from "./jetcockpit.meta";

/** Uniform 0..1 from three integers. */
function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x27d4eb2f))) / 4294967296;
}

const sane = (t: number) => (Number.isFinite(t) ? Math.max(0, t) : 0);

/* ----- Layout ----- */

/**
 * Height of the horizon when the view is level, in frame heights from the
 * frame's centre: below a typical speaker's shoulders.
 */
export const HORIZON = -0.2;

/* ----- The bank ----- */

/** Seconds per bank slot: at most one bank in each. */
export const BANK_SLOT = 60;
/** Chance a slot has a bank. */
const BANK_CHANCE = 0.85;
/** Seconds rolling into the bank (and back out), shortest and longest. */
export const ROLL_MIN = 5;
export const ROLL_MAX = 8;
/** Seconds holding the bank, shortest and longest. */
export const BANK_HOLD_MIN = 6;
export const BANK_HOLD_MAX = 16;
/** The fewest level seconds between one bank's end and the next one's start. */
export const BANK_MIN_GAP = 15;
/** The steepest bank, at `bank` 1 (radians): 8°. */
export const MAX_BANK = (8 * Math.PI) / 180;
/** The shallowest bank, as a fraction of the steepest. */
const MIN_BANK_FRACTION = 0.45;

export interface BankVisit {
  /** Start (s), seconds rolling in or out, seconds holding. */
  start: number;
  roll: number;
  hold: number;
  /** Signed bank at the hold, as a fraction of `MAX_BANK` (0 for no bank). */
  angle: number;
}

export function createBankVisit(): BankVisit {
  return { start: 0, roll: 0, hold: 0, angle: 0 };
}

/** The bank in slot `slot`, written into `out`; `angle` 0 when the slot has none. */
export function bankVisit(slot: number, seed: number, out: BankVisit): BankVisit {
  out.start = slot * BANK_SLOT;
  out.roll = ROLL_MIN + (ROLL_MAX - ROLL_MIN) * rand(slot, seed, 1);
  out.hold = BANK_HOLD_MIN + (BANK_HOLD_MAX - BANK_HOLD_MIN) * rand(slot, seed, 2);
  out.angle = 0;
  if (rand(slot, seed, 3) >= BANK_CHANCE) {
    return out;
  }
  const length = 2 * out.roll + out.hold;
  // Leaves room for the level gap before the next slot begins.
  out.start += (BANK_SLOT - length - BANK_MIN_GAP) * rand(slot, seed, 4);
  const side = rand(slot, seed, 5) < 0.5 ? -1 : 1;
  out.angle = side * (MIN_BANK_FRACTION + (1 - MIN_BANK_FRACTION) * rand(slot, seed, 6));
  return out;
}

const visit = createBankVisit();

/**
 * The view's bank at `t` seconds (radians, positive rolls the horizon
 * anticlockwise), with `amount` 0..1 scaling `MAX_BANK`. Smooth, within
 * ±`MAX_BANK` * `amount`, and level between banks. Allocates nothing.
 */
export function bankAt(t: number, seed: number, amount: number): number {
  const time = sane(t);
  if (!(amount > 0)) {
    return 0;
  }
  bankVisit(Math.floor(time / BANK_SLOT), seed, visit);
  const s = time - visit.start;
  const length = 2 * visit.roll + visit.hold;
  if (visit.angle === 0 || s <= 0 || s >= length) {
    return 0;
  }
  const envelope =
    s < visit.roll
      ? ease(s / visit.roll)
      : s < visit.roll + visit.hold
        ? 1
        : ease((length - s) / visit.roll);
  return visit.angle * envelope * MAX_BANK * clamp(amount, 0, 1);
}

/* ----- Near clouds ----- */

/** Each pass starts in its own slot, `PASS_JITTER` either side of the slot's middle. */
export const PASS_SLOT = 40;
export const PASS_JITTER = 10;
/** So passes start between these many seconds apart. */
export const MIN_PASS_GAP = PASS_SLOT - 2 * PASS_JITTER;
export const MAX_PASS_GAP = PASS_SLOT + 2 * PASS_JITTER;
/** Seconds the fog takes to thicken, holds at its thickest, and takes to clear. */
export const PASS_IN = 1.4;
export const PASS_HOLD = 0.9;
export const PASS_OUT = 2.2;
export const PASS_LENGTH = PASS_IN + PASS_HOLD + PASS_OUT;
/** The thickest a pass gets, at full cloud cover: never a full white-out. */
export const PASS_PEAK = 0.75;

export interface Pass {
  /** 0..`PASS_PEAK`: how thick the fog is. */
  level: number;
  /** 0..1 through the pass, for the cloud's shape streaming by. */
  phase: number;
  /** The pass under way (or the last one), for its own shape. */
  index: number;
}

export function createPass(): Pass {
  return { level: 0, phase: 0, index: 0 };
}

/** When pass `k` starts (s). */
export function passStart(k: number, seed: number): number {
  return (k + 0.5) * PASS_SLOT + PASS_JITTER * (2 * rand(k, seed, 20) - 1);
}

/**
 * The near cloud at `t` seconds, written into `out`, its thickness scaled by
 * cloud `cover` 0..1 (none at all in a clear sky). Allocates nothing.
 */
export function passAt(t: number, seed: number, cover: number, out: Pass): Pass {
  const time = sane(t);
  const k = Math.floor(time / PASS_SLOT);
  // A pass ends well before the next slot's could start, so it is this
  // slot's or the one before.
  let start = passStart(k, seed);
  out.index = k;
  if (time < start) {
    out.index = k - 1;
    start = passStart(k - 1, seed);
  }
  const s = time - start;
  out.level = 0;
  out.phase = 0;
  if (s >= 0 && s < PASS_LENGTH) {
    const thick = smoothstep(0, PASS_IN, s) * (1 - smoothstep(PASS_IN + PASS_HOLD, PASS_LENGTH, s));
    out.level = thick * PASS_PEAK * smoothstep(0.05, 0.4, clamp(cover, 0, 1));
    out.phase = s / PASS_LENGTH;
  }
  return out;
}

/* ----- Displays ----- */

/** Readout lines on the displays: two on each. */
export const READOUTS = 4;
/** Glyphs per readout line. */
export const READOUT_GLYPHS = 4;
/** Glyph atlas: one cell per glyph, 8 texels wide and 9 tall, in a row. */
export const GLYPH_CELL = 8;
export const GLYPH_ROWS = 9;
export const GLYPH_COUNT = 16;
export const GLYPH_DASH = 10;
export const GLYPH_DOT = 11;
export const GLYPH_BLANK = 12;

/** A 5 x 7 pixel font, rows top to bottom, bit 4 the left column: 0-9, "-" and ".". */
const FONT: readonly (readonly number[])[] = [
  [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
];

/**
 * The glyph atlas: `GLYPH_COUNT` cells of `GLYPH_CELL` x `GLYPH_ROWS` in one row, R8, row 0
 * at the bottom (as GL uploads it), 255 where a glyph is lit. Each glyph sits
 * in its cell with a one-pixel margin, so filtering never bleeds between cells.
 */
export function buildGlyphAtlas(): Uint8Array {
  const w = GLYPH_CELL * GLYPH_COUNT;
  const out = new Uint8Array(w * GLYPH_ROWS);
  FONT.forEach((rows, g) => {
    rows.forEach((bits, r) => {
      // Font row 0 is the top; atlas row 0 the bottom, under a one-pixel margin.
      const y = GLYPH_ROWS - 2 - r;
      for (let c = 0; c < 5; c++) {
        if (bits & (0x10 >> c)) {
          out[y * w + g * GLYPH_CELL + 1 + c] = 255;
        }
      }
    });
  });
  return out;
}

/** Each readout's range of made-up readings, and how many decimals it shows. */
const READOUT_RANGES: readonly { lo: number; hi: number; decimals: number }[] = [
  { lo: 2400, hi: 9800, decimals: 0 },
  { lo: 0.62, hi: 0.94, decimals: 2 },
  { lo: 120, hi: 480, decimals: 0 },
  { lo: 18, hi: 86, decimals: 1 },
];

/** A readout behaves like one of the bridge's readout blocks at full activity. */
const READOUT_BLOCK: Block = {
  kind: "readout",
  colour: 0,
  alt: 0,
  level: 1,
  busy: 1,
  group: -1,
  order: 0,
};
const ACTIVITY = 0.8;
const event: BlockEvent = { kind: "none", start: 0, length: 0 };
/** How many slots back to look for the latest change before settling on the oldest. */
const LOOKBACK = 12;

/**
 * Which reading readout `line` shows at `t` seconds: a key that changes at
 * each of its "tick" events, and stays put between them.
 */
export function readingKey(line: number, seed: number, t: number): number {
  const time = sane(t);
  const block = line + 1;
  const len = slotLength(block, seed);
  const now = Math.floor(time / len);
  for (let s = now; s > now - LOOKBACK; s--) {
    blockEvent(READOUT_BLOCK, block, seed, ACTIVITY, s, event);
    if (event.kind === "tick" && event.start <= time) {
      return s;
    }
  }
  return now - LOOKBACK;
}

/** 0..1: how far readout `line` is dimmed at `t` seconds (by its "dim" events). */
export function readingDim(line: number, seed: number, t: number): number {
  const time = sane(t);
  const block = line + 1;
  const slot = Math.floor(time / slotLength(block, seed));
  blockEvent(READOUT_BLOCK, block, seed, ACTIVITY, slot, event);
  return event.kind === "dim" ? eventWeight(event, time) : 0;
}

/**
 * The glyphs of readout `line` for reading `key`, right-aligned, written into
 * `out` from `o` (`READOUT_GLYPHS` of them).
 */
export function readingGlyphs(
  line: number,
  seed: number,
  key: number,
  out: Float32Array,
  o: number,
): void {
  const r = READOUT_RANGES[line % READOUT_RANGES.length];
  const value = r.lo + (r.hi - r.lo) * rand(line + 100, seed, key);
  let n = Math.round(value * 10 ** r.decimals);
  let digits = 0;
  let dot = r.decimals === 0;
  for (let i = READOUT_GLYPHS - 1; i >= 0; i--) {
    if (!dot && digits === r.decimals) {
      out[o + i] = GLYPH_DOT;
      dot = true;
    } else if (n > 0 || digits <= r.decimals) {
      // At least one digit before the point, so 0.62 rather than .62.
      out[o + i] = n % 10;
      n = Math.floor(n / 10);
      digits++;
    } else {
      out[o + i] = GLYPH_BLANK;
    }
  }
}

/* ----- Sky ----- */

export interface JetSky {
  zenith: Rgb;
  horizon: Rgb;
  /** The glow round the sun or moon, and its strength. */
  glow: Rgb;
  glowStrength: number;
  /** Lit cloud tops, cloud in shadow, the far haze, and the ground through gaps. */
  light: Rgb;
  shade: Rgb;
  haze: Rgb;
  ground: Rgb;
  /** The sun or moon: across (frame heights from the centre) and above the horizon. */
  sunX: number;
  sunY: number;
  /** Its disc's radius and colour. */
  sunR: number;
  disc: Rgb;
  /** 0..1: how many stars show. */
  stars: number;
  /** The light on the cockpit. */
  cabin: Rgb;
}

const hex = (h: string) => hexToUnitRgb(h);

/** Dusk takes the sea of clouds' sky just before sunrise: orange under purple. */
const DUSK_DAWN = sampleDawn(5.82, createDawnState());

export const SKIES: Readonly<Record<JetTime, JetSky>> = {
  day: {
    zenith: hex("#2a5fb8"),
    horizon: hex("#a9c8e8"),
    glow: hex("#fff3d6"),
    glowStrength: 0.55,
    light: hex("#ffffff"),
    shade: hex("#8c9cb8"),
    haze: hex("#c4d6ea"),
    ground: hex("#3d5a4c"),
    sunX: -0.62,
    sunY: 0.3,
    sunR: 0.022,
    disc: hex("#fffaf0"),
    stars: 0,
    cabin: hex("#f4f2ee"),
  },
  dusk: {
    zenith: DUSK_DAWN.zenith,
    horizon: DUSK_DAWN.horizon,
    glow: DUSK_DAWN.glow,
    glowStrength: 0.9,
    light: DUSK_DAWN.light,
    shade: DUSK_DAWN.shade,
    haze: DUSK_DAWN.haze,
    ground: hex("#2a2440"),
    sunX: -0.6,
    sunY: 0.035,
    sunR: 0.028,
    disc: hex("#ffd8a0"),
    stars: 0.15,
    cabin: hex("#c89a8e"),
  },
  night: {
    zenith: hex("#03060f"),
    horizon: hex("#141d33"),
    glow: hex("#8ea4c8"),
    glowStrength: 0.35,
    light: hex("#8796b4"),
    shade: hex("#1c2438"),
    haze: hex("#2a3550"),
    ground: hex("#06080e"),
    sunX: 0.6,
    sunY: 0.24,
    sunR: 0.02,
    disc: hex("#e8eef8"),
    stars: 1,
    cabin: hex("#3a4258"),
  },
};

export function createJetSky(from: JetSky = SKIES.day): JetSky {
  return {
    ...from,
    zenith: [...from.zenith],
    horizon: [...from.horizon],
    glow: [...from.glow],
    light: [...from.light],
    shade: [...from.shade],
    haze: [...from.haze],
    ground: [...from.ground],
    disc: [...from.disc],
    cabin: [...from.cabin],
  };
}

/** Seconds for a change of time of day to get about two-thirds of the way. */
export const SKY_EASE = 0.8;

const RGB_KEYS = [
  "zenith",
  "horizon",
  "glow",
  "light",
  "shade",
  "haze",
  "ground",
  "disc",
  "cabin",
] as const;
const NUMBER_KEYS = ["glowStrength", "sunX", "sunY", "sunR", "stars"] as const;

/**
 * Eases `sky` toward `target` over `dt` seconds, so a change of time of day
 * glides rather than jumps. Allocates nothing.
 */
export function approachSky(sky: JetSky, target: JetSky, dt: number): void {
  const k = 1 - Math.exp(-Math.max(0, Number.isFinite(dt) ? dt : 0) / SKY_EASE);
  for (const key of RGB_KEYS) {
    const a = sky[key];
    const b = target[key];
    a[0] += (b[0] - a[0]) * k;
    a[1] += (b[1] - a[1]) * k;
    a[2] += (b[2] - a[2]) * k;
  }
  for (const key of NUMBER_KEYS) {
    sky[key] += (target[key] - sky[key]) * k;
  }
}
