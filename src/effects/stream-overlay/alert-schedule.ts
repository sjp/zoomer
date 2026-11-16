/**
 * The alert banner's logic, without any drawing: what an alert says, when it
 * shows and how it moves, and where its confetti goes.
 *
 * Alerts come from the overlay layer's shared stream events. Each shows for
 * `ALERT_IN_SECONDS + ALERT_HOLD_SECONDS + ALERT_OUT_SECONDS`: it slides down
 * a little and fades in with a gentle overshoot, holds while a soft sheen
 * crosses it once, then lifts and fades away. Events that arrive meanwhile
 * wait their turn (a couple at most).
 *
 * Alerts are the brightest thing the overlays show, so everything ramps: no
 * piece of the banner or its confetti appears or vanishes in one frame, the
 * confetti is capped below full opacity, and nothing moves faster than a
 * video codec can follow (`motion-limits.ts`), at every slider value.
 */
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import { sanitizeText } from "../params";
import { alertsMeta, type AlertStyle } from "./alerts.meta";
import type { StreamEvent, StreamEventKind, StreamEventKinds } from "./stream-events";

/** Seconds the banner takes to come in, holds, and takes to go. */
export const ALERT_IN_SECONDS = 0.5;
export const ALERT_HOLD_SECONDS = 5;
export const ALERT_OUT_SECONDS = 0.6;
/** Seconds it takes to go when the overlay is switched off, so it is gone before the layer's fade ends. */
const ALERT_CUT_SECONDS = 0.45;
/** Seconds between one alert going and a waiting one coming in. */
const ALERT_PAUSE_SECONDS = 0.8;
/** Most alerts waiting their turn; beyond it the oldest is dropped. */
const MAX_WAITING = 2;

/** At 1080p: how far the banner slides down coming in, and lifts going out. */
export const ALERT_SLIDE_PX = 24;
const ALERT_LIFT_PX = 20;
/** The ease-out-back overshoot: about 10 % of the slide. */
const OVERSHOOT = 1.70158;

/** When the sheen starts crossing, after the banner has come in, and its speed at 1080p. */
const SHEEN_DELAY_SECONDS = 0.5;
export const SHEEN_PX_PER_SECOND = 240;
/** The sheen's peak opacity: a soft glint, not a flash. */
export const SHEEN_PEAK = 0.18;

/** Share of alerts that use one of the viewer's own lines, when there are any. */
const OWN_SHARE = 0.5;

const SALT_OWN = 11;
const SALT_OWN_PICK = 12;

function hashOf(seed: number, salt: number, i: number): number {
  return hash32(hash32(seed ^ Math.imul(salt, 0x9e3779b1)) ^ hash32(i + 0x632be5ab));
}

const unit = (seed: number, salt: number, i: number) => hashOf(seed, salt, i) / 4294967296;

/** Whether an event of `kind` shows as an alert when `kinds` are picked. */
export function alertShows(kind: StreamEventKind, kinds: StreamEventKinds): boolean {
  return kinds === "all" || (kinds === "follows" ? kind === "follow" : kind === "gift");
}

/**
 * The viewer's own alert lines from the `alertText` text: sanitised as the
 * text param is (so a value that didn't come through the panel is safe too),
 * with runs of spaces collapsed and blank lines dropped.
 */
export function parseAlertLines(text: string): string[] {
  const def = alertsMeta.params.alertText;
  if (def.kind !== "text") {
    return [];
  }
  return sanitizeText(def, text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

/** `template` with every `{name}` replaced by `name`. */
export function fillName(template: string, name: string): string {
  // A function, so a `$` in the name is never read as a replacement pattern.
  return template.replaceAll("{name}", () => name);
}

/** What an alert says: a small title and the main line. */
interface AlertCopy {
  readonly title: string;
  readonly line: string;
}

/**
 * The words for `event`: a title for its kind, and its main line, which for
 * about half the alerts is one of `own` (the viewer's lines, from
 * `parseAlertLines`) with the name filled in. Allocates.
 */
export function alertCopy(seed: number, event: StreamEvent, own: readonly string[]): AlertCopy {
  const { name, amount } = event;
  const n = String(amount);
  let title: string;
  let line: string;
  if (event.kind === "follow") {
    title = "New follower";
    line = `${name} just followed!`;
  } else if (event.kind === "sub") {
    title = amount > 1 ? "Resubscribed" : "New subscriber";
    line = amount > 1 ? `${name} subscribed for ${n} months!` : `${name} just subscribed!`;
  } else if (event.kind === "gift") {
    title = amount > 1 ? "Gifted subs" : "Gifted sub";
    line = amount > 1 ? `Thanks for the ${n} gifts, ${name}!` : `Thanks for the gift, ${name}!`;
  } else {
    title = "Host";
    line = `${name} is hosting with ${n} viewers`;
  }
  if (own.length > 0 && unit(seed, SALT_OWN, event.index) < OWN_SHARE) {
    line = fillName(own[hashOf(seed, SALT_OWN_PICK, event.index) % own.length], name);
  }
  return { title, line };
}

/** `easeOutBack`: rises past 1 by about a tenth, then settles on it exactly. */
function overshoot(x: number): number {
  const c3 = OVERSHOOT + 1;
  const u = x - 1;
  return 1 + c3 * u * u * u + OVERSHOOT * u * u;
}

/** Where the banner is in its show. Plain numbers, written in place. */
export interface AlertPose {
  /** Its opacity, 0 to 1. */
  alpha: number;
  /** Its offset from rest, in px at 1080p (negative is up). */
  dy: number;
  /** How far the sheen is across it, 0 to 1, or -1 when there is none. */
  sheen: number;
  /** Seconds since it started coming in. */
  time: number;
}

/** One alert on show: the event, and its style (latched as it starts). */
interface Showing {
  readonly event: StreamEvent;
  readonly style: AlertStyle;
}

/** The banner's queue and clock. */
interface AlertRunner {
  /** The alert on show (coming in, holding or going), or null. */
  readonly current: Showing | null;
  /** Bumped when a new alert starts: the banner needs drawing. */
  readonly version: number;
  /** Queues `event` to show in `style` (latched when it comes in). */
  offer: (event: StreamEvent, style: AlertStyle) => void;
  /** Sends the alert on show out early (the overlay was switched off) and drops the waiting ones. */
  stop: () => void;
  /** Advances `dt` seconds. Allocates nothing. */
  step: (dt: number) => void;
  /**
   * Writes the current alert's pose to `out`, given how many seconds the
   * sheen takes to cross (from `sheenSeconds`).
   */
  pose: (sheenSeconds: number, out: AlertPose) => AlertPose;
}

/** Seconds the sheen takes to cross a banner `width` px wide at 1080p. */
export function sheenSeconds(width: number): number {
  return Math.max(1, (Number.isFinite(width) ? Math.max(0, width) : 0) / SHEEN_PX_PER_SECOND);
}

export function createAlertRunner(): AlertRunner {
  const waiting: Showing[] = [];
  let current: Showing | null = null;
  let version = 0;
  /** Seconds since the current alert started, and since the last one ended. */
  let t = 0;
  let idle = ALERT_PAUSE_SECONDS;
  /** When it started going (seconds since it started), how long it takes, and its pose then. */
  let outAt = ALERT_IN_SECONDS + ALERT_HOLD_SECONDS;
  let outFor = ALERT_OUT_SECONDS;
  let outAlpha = 1;
  let outDy = 0;
  const scratch: AlertPose = { alpha: 0, dy: 0, sheen: -1, time: 0 };

  /** The pose before it starts going. */
  const rise = (style: AlertStyle, time: number, out: AlertPose) => {
    const p = clamp(time / ALERT_IN_SECONDS, 0, 1);
    out.alpha = smoothstep(0, 1, p);
    const e = style === "minimal" ? smoothstep(0, 1, p) : overshoot(p);
    out.dy = -ALERT_SLIDE_PX * (1 - e);
  };

  return {
    get current() {
      return current;
    },
    get version() {
      return version;
    },
    offer(event, style) {
      waiting.push({ event, style });
      if (waiting.length > MAX_WAITING) {
        waiting.shift();
      }
    },
    stop() {
      waiting.length = 0;
      if (current !== null && t < outAt) {
        rise(current.style, t, scratch);
        outAlpha = scratch.alpha;
        outDy = scratch.dy;
        outAt = t;
        outFor = ALERT_CUT_SECONDS;
      }
    },
    step(dt) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (current !== null) {
        t += step;
        if (t >= outAt + outFor) {
          current = null;
          idle = 0;
        }
        return;
      }
      idle += step;
      if (idle >= ALERT_PAUSE_SECONDS && waiting.length > 0) {
        current = waiting.shift() ?? null;
        version++;
        t = 0;
        outAt = ALERT_IN_SECONDS + ALERT_HOLD_SECONDS;
        outFor = ALERT_OUT_SECONDS;
        outAlpha = 1;
        outDy = 0;
      }
    },
    pose(sheen, out) {
      out.time = t;
      out.sheen = -1;
      if (current === null) {
        out.alpha = 0;
        out.dy = 0;
        return out;
      }
      if (t < outAt) {
        rise(current.style, t, out);
        const s = (t - ALERT_IN_SECONDS - SHEEN_DELAY_SECONDS) / sheen;
        if (current.style !== "minimal" && s >= 0 && s <= 1) {
          out.sheen = s;
        }
        return out;
      }
      const q = smoothstep(0, 1, clamp((t - outAt) / outFor, 0, 1));
      out.alpha = outAlpha * (1 - q);
      out.dy = outDy - ALERT_LIFT_PX * q;
      return out;
    },
  };
}

/** Where confetti may go, in device pixels: the frame and the speaker's area. */
export interface ConfettiArea {
  readonly width: number;
  readonly height: number;
  /** Pixels per 1080p pixel. */
  readonly scale: number;
  /** The speaker's area: its left and right edges and its top. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

/** One confetti piece this frame. Plain numbers, written in place. */
export interface ConfettiPiece {
  x: number;
  y: number;
  /** Half its size, in device pixels. */
  half: number;
  angle: number;
  /** Its tumble: the cosine its width is scaled by. */
  flip: number;
  alpha: number;
  /** Which of `CONFETTI_KINDS` pieces it is. */
  kind: number;
}

/** How many kinds of piece there are (colours and shapes), for the sprite atlas. */
export const CONFETTI_KINDS = 6;
/** Its peak opacity. */
export const CONFETTI_PEAK = 0.85;
/** Seconds after the alert starts that the confetti bursts, and the longest a piece lives. */
const CONFETTI_DELAY_SECONDS = 0.3;
export const CONFETTI_LIFE_SECONDS = 3.6;
/**
 * At 1080p: the most sideways speed at the burst, the slowing of it, the most
 * upward speed, gravity, the fastest fall, and the sideways flutter.
 */
const SIDE_SPEED = 200;
const SIDE_DRAG_SECONDS = 1.2;
const POP_SPEED = 90;
const GRAVITY = 160;
const FALL_SPEED = 150;
const FLUTTER_PX = 10;
const FLUTTER_RATE = 3;
/** The fastest any piece moves at 1080p, in px per second (sideways, flutter and fall at their peaks). */
export const CONFETTI_MAX_SPEED = Math.hypot(SIDE_SPEED + FLUTTER_PX * FLUTTER_RATE, FALL_SPEED);
/** Width, at 1080p, over which a piece fades out before its limit. */
const FADE_BAND = 40;

const SALT_COUNT = 21;
const SALT_PIECE = 22;

/** How many pieces alert `index` throws: 30 to 60. */
export function confettiCount(seed: number, index: number): number {
  return 30 + (hashOf(seed, SALT_COUNT, index) % 31);
}

/**
 * How far down a piece at `x`, reaching `r` either side, may be before it has
 * faded out: the top third of the frame at the sides, but only the top band
 * where it is over the speaker, blending between the two just outside the
 * speaker's area so a piece crossing it fades rather than vanishes.
 */
export function confettiLimit(area: ConfettiArea, x: number, r: number): number {
  const ramp = 0.05 * area.width;
  const out = Math.max(area.left - (x + r), x - r - area.right, 0);
  const third = Math.max(area.top, area.height / 3);
  return area.top + (third - area.top) * smoothstep(0, ramp, out);
}

/** Piece `i`'s seeded unit value number `k`. */
const pieceUnit = (seed: number, index: number, i: number, k: number) =>
  unit(seed ^ Math.imul(index + 1, 0x85ebca6b), SALT_PIECE + k, i);

/**
 * Writes piece `i` of alert `index`'s confetti, `time` seconds after the alert
 * started, burst from the banner centred on (`cx`, `cy`) and `bannerWidth`
 * wide. `pixel` keeps it square on, without spin or tumble. Allocates nothing.
 */
export function confettiPiece(
  seed: number,
  index: number,
  i: number,
  time: number,
  cx: number,
  cy: number,
  bannerWidth: number,
  area: ConfettiArea,
  pixel: boolean,
  out: ConfettiPiece,
): ConfettiPiece {
  const s = area.scale;
  const life = CONFETTI_LIFE_SECONDS * (0.65 + 0.35 * pieceUnit(seed, index, i, 0));
  // Before the burst it waits where it starts; after its life it stays where it ended.
  const t = clamp(Number.isFinite(time) ? time - CONFETTI_DELAY_SECONDS : 0, 0, life);
  out.kind = Math.floor(pieceUnit(seed, index, i, 1) * CONFETTI_KINDS);
  out.half = (4 + 3 * pieceUnit(seed, index, i, 2)) * s;
  // From behind the banner, along its width, thrown outwards and a little up.
  const along = pieceUnit(seed, index, i, 3) * 2 - 1;
  const x0 = cx + along * 0.45 * bannerWidth;
  const side = (along < 0 ? -1 : 1) * (0.3 + 0.7 * pieceUnit(seed, index, i, 4)) * SIDE_SPEED;
  const pop = pieceUnit(seed, index, i, 5) * POP_SPEED;
  const drift = side * SIDE_DRAG_SECONDS * (1 - Math.exp(-t / SIDE_DRAG_SECONDS));
  const phase = pieceUnit(seed, index, i, 6) * Math.PI * 2;
  const flutter = FLUTTER_PX * (Math.sin(FLUTTER_RATE * t + phase) - Math.sin(phase));
  // Up at `pop`, slowing under gravity, then falling no faster than `FALL_SPEED`.
  const tFall = (pop + FALL_SPEED) / GRAVITY;
  const fall =
    t < tFall
      ? -pop * t + 0.5 * GRAVITY * t * t
      : -pop * tFall + 0.5 * GRAVITY * tFall * tFall + FALL_SPEED * (t - tFall);
  const x = x0 + (drift + flutter) * s;
  const y = cy + fall * s;
  const spin =
    (1 + 3 * pieceUnit(seed, index, i, 7)) * (pieceUnit(seed, index, i, 8) < 0.5 ? -1 : 1);
  const tumble = 2 + 3 * pieceUnit(seed, index, i, 9);
  if (pixel) {
    out.angle = 0;
    out.flip = 1;
  } else {
    out.angle = phase + spin * t;
    out.flip = Math.cos(tumble * t + phase);
  }
  out.x = x;
  out.y = y;
  // Its reach when turned: the half-diagonal.
  const r = out.half * Math.SQRT2;
  const limit = confettiLimit(area, x, r);
  const region = 1 - smoothstep(limit - FADE_BAND * s, limit, y + r);
  const age = smoothstep(0, 0.15, t) * (1 - smoothstep(life - 0.8, life, t));
  out.alpha = CONFETTI_PEAK * age * region;
  return out;
}
