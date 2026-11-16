/**
 * The stream's made-up supporter events: follows, subscriptions, gifted subs
 * and hosts, at seeded times, each from a made-up viewer. One timeline shared
 * by every overlay that shows them (the alert banner, the chat's event lines,
 * the goal bar and its ticker), so a follow shows everywhere at once and under
 * the same name. The overlay layer builds and steps it every frame, whichever
 * overlays are on, so it reads the same whether or not any of them is shown.
 *
 * Event number `i`'s viewer, and the numbers it carries, are fixed by the seed
 * alone. Its kind is fixed by the seed and the kinds allowed when it arrives,
 * and the gap after it by the seed and the average gap when it arrives: both
 * latch per event, so a param change applies from the next one.
 */
import { hash32 } from "../noise";
import { makeUsername } from "./usernames";

/** What happened. */
type StreamEventKind = "follow" | "sub" | "gift" | "host";

/** Which kinds the stream holds: `all` mixes them, the others hold only that kind. */
export type StreamEventKinds = "all" | "follows" | "gifts";

/** The param keys (in the alert overlay's group) that shape the stream. */
export const EVENT_EVERY_KEY = "alertEvery";
export const EVENT_KINDS_KEY = "alertKinds";

/** The average gap's range and default, in seconds; each gap is 50 % to 150 % of it. */
export const EVENT_GAP_MIN = 20;
export const EVENT_GAP_MAX = 300;
export const EVENT_GAP_DEFAULT = 60;

/** The layer's seed for the stream. */
const STREAM_EVENT_SEED = 0xa1e7;

/** One event. Plain data, made once when it arrives. */
export interface StreamEvent {
  /** Its number in the stream, from 0 (negative for the ones before it started). */
  readonly index: number;
  readonly kind: StreamEventKind;
  /** The viewer: their number (for `makeUsername`) and name. */
  readonly user: number;
  readonly name: string;
  /**
   * For a sub, the months subscribed (1 for a new one); for a gift, how many
   * subs were gifted; for a host, how many viewers came along; 1 for a follow.
   */
  readonly amount: number;
}

/** Shares of each kind under `all`, in `KINDS` order. */
const KINDS: readonly StreamEventKind[] = ["follow", "sub", "gift", "host"];
const KIND_SHARES = [0.55, 0.25, 0.12, 0.08];

/** How many subs a gift may be: small ones are the most common. */
const GIFT_COUNTS = [1, 1, 2, 3, 5, 5, 10, 20];

/** Share of subs that are new (1 month); the rest have resubscribed for 2 to 24 months. */
const NEW_SUB_SHARE = 0.6;

/** Viewer numbers for the stream's viewers start here, plus the event number (clear of the chat's). */
const USER_BASE = 200_000;

/** After a pause longer than this (a stalled tab), the stream starts counting again from now. */
const STALL_SECONDS = 30;

const SALT_GAP = 1;
const SALT_KIND = 2;
const SALT_AMOUNT = 3;
const SALT_AMOUNT2 = 4;

function hashOf(seed: number, salt: number, i: number): number {
  return hash32(hash32(seed ^ Math.imul(salt, 0x9e3779b1)) ^ hash32(i + 0x632be5ab));
}

/** A seeded unit value in [0, 1) for `seed`, `salt` and the integer `i`. */
const unit = (seed: number, salt: number, i: number) => hashOf(seed, salt, i) / 4294967296;

/** `every` as an average gap: within the slider's range, the default if it isn't a number. */
export function clampEventEvery(every: number): number {
  return Number.isFinite(every)
    ? Math.min(EVENT_GAP_MAX, Math.max(EVENT_GAP_MIN, every))
    : EVENT_GAP_DEFAULT;
}

/** Seconds from event `index`'s arrival (or the start, for -1) to the next, at average `every`. */
export function eventGap(seed: number, index: number, every: number): number {
  return clampEventEvery(every) * (0.5 + unit(seed, SALT_GAP, index));
}

/** The kind of event `index` when `kinds` are allowed. */
export function eventKind(seed: number, index: number, kinds: StreamEventKinds): StreamEventKind {
  if (kinds === "follows") {
    return "follow";
  }
  if (kinds === "gifts") {
    return "gift";
  }
  let u = unit(seed, SALT_KIND, index);
  for (let k = 0; k < KINDS.length - 1; k++) {
    u -= KIND_SHARES[k];
    if (u < 0) {
      return KINDS[k];
    }
  }
  return KINDS[KINDS.length - 1];
}

/** Event `index` as `kind`. Allocates (its name): call it once, when it arrives. */
function makeEvent(seed: number, index: number, kind: StreamEventKind): StreamEvent {
  const u = unit(seed, SALT_AMOUNT, index);
  const v = unit(seed, SALT_AMOUNT2, index);
  let amount = 1;
  if (kind === "sub") {
    amount = u < NEW_SUB_SHARE ? 1 : 2 + Math.floor(v * 23);
  } else if (kind === "gift") {
    amount = GIFT_COUNTS[Math.floor(u * GIFT_COUNTS.length)];
  } else if (kind === "host") {
    // Mostly small hosts, now and then a bigger one: 3 to 60.
    amount = 3 + Math.floor(u * u * 58);
  }
  const user = USER_BASE + index;
  return { index, kind, user, name: makeUsername(seed, user), amount };
}

/** Event number `index` under `seed` when `kinds` are allowed. Allocates. */
export function streamEvent(seed: number, index: number, kinds: StreamEventKinds): StreamEvent {
  return makeEvent(seed, index, eventKind(seed, index, kinds));
}

/** `value` (a param's) as a kinds setting, `all` for anything unknown. */
export function eventKinds(value: unknown): StreamEventKinds {
  return value === "follows" || value === "gifts" ? value : "all";
}

/** The stream as the overlays see it: read-only. */
export interface StreamEventsView {
  /** Events so far. */
  readonly count: number;
  /** Follows so far. */
  readonly follows: number;
  /**
   * The events that arrived in the latest step, oldest first: read them in
   * `update`. The array is reused, so don't keep it.
   */
  readonly fresh: readonly StreamEvent[];
  /** The latest follow, and the latest sub or gift: one from before the start until there is one. */
  readonly latestFollow: StreamEvent;
  readonly latestSupport: StreamEvent;
}

/** The stream, as the layer owns it. */
interface StreamEvents extends StreamEventsView {
  /**
   * Advances `dt` seconds with average gap `every` and `kinds` allowed, both
   * latched per event. Allocates only for the events that arrive.
   */
  step: (dt: number, every: number, kinds: StreamEventKinds) => void;
}

/** A stream under `seed`, with no events yet. */
export function createStreamEvents(seed = STREAM_EVENT_SEED): StreamEvents {
  const fresh: StreamEvent[] = [];
  let count = 0;
  let follows = 0;
  let time = 0;
  let nextAt = -1;
  // The ones from before the start, so a ticker has a name from the first frame.
  let latestFollow = makeEvent(seed, -1, "follow");
  let latestSupport = makeEvent(seed, -2, "sub");
  return {
    get count() {
      return count;
    },
    get follows() {
      return follows;
    },
    get fresh() {
      return fresh;
    },
    get latestFollow() {
      return latestFollow;
    },
    get latestSupport() {
      return latestSupport;
    },
    step(dt, every, kinds) {
      fresh.length = 0;
      time += Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (nextAt < 0) {
        nextAt = eventGap(seed, -1, every);
      }
      if (time - nextAt > STALL_SECONDS) {
        nextAt = time;
      }
      while (time >= nextAt) {
        const event = streamEvent(seed, count, kinds);
        fresh.push(event);
        if (event.kind === "follow") {
          follows++;
          latestFollow = event;
        } else if (event.kind === "sub" || event.kind === "gift") {
          latestSupport = event;
        }
        nextAt += eventGap(seed, count, every);
        count++;
      }
    },
  };
}
