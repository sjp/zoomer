/**
 * The Starting Soon card's countdown, kept free of GL and canvas so it can be
 * tested: which timer is in effect, what it counts to, how many whole seconds
 * are left, and how they read on the card.
 *
 * - Duration counts down `countdown` minutes from when the scene was created,
 *   and starts again whenever the minutes change or Duration comes back into
 *   effect (from Off, or from a valid "ends at" time).
 * - Until time counts down to the next local `endsAt` (see `clock-time.ts`), so
 *   it survives reloads. A time up to `UNTIL_GRACE_HOURS` ago has already been
 *   reached and holds at zero; an older one counts down to tomorrow. Text that
 *   isn't a time (or none) falls back to Duration.
 *
 * Once a countdown reaches zero it stays there.
 */
import { type ClockTime, nextOccurrence, parseClockTime } from "../stream-overlay/clock-time";
import { MAX_COUNTDOWN_MINUTES, MIN_COUNTDOWN_MINUTES, type TimerMode } from "./startingsoon.meta";

/** A time of day this many hours past still counts as reached, rather than tomorrow's. */
export const UNTIL_GRACE_HOURS = 12;

const HOUR_MS = 3_600_000;

/** The `timer` param's value as a `TimerMode` (an unknown value counts a Duration). */
export function toTimerMode(value: string): TimerMode {
  return value === "off" || value === "until" ? value : "duration";
}

/** Whole minutes within the param's bounds (a non-finite value gives the default 5). */
export function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) {
    return 5;
  }
  return Math.min(MAX_COUNTDOWN_MINUTES, Math.max(MIN_COUNTDOWN_MINUTES, Math.round(minutes)));
}

const two = (n: number) => (n < 10 ? `0${String(n)}` : String(n));

/**
 * Whole seconds left as the card shows them: `m:ss` under an hour (`4:59`,
 * `0:07`), `h:mm:ss` from an hour up (`1:00:00`, `11:42:05`). Negative or
 * non-finite input reads as `0:00`.
 */
export function formatCountdown(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${String(h)}:${two(m)}:${two(sec)}` : `${String(m)}:${two(sec)}`;
}

/** What `Countdown.read` reports. The same object is updated by every read. */
interface CountdownReading {
  /** The timer in effect: Until time falls back to Duration without a valid time. */
  readonly mode: TimerMode;
  /** Whole seconds left, rounded up (5:00 shows for the first second); 0 once reached. */
  readonly seconds: number;
  /**
   * Bumped whenever what the countdown counts to changes (the timer in effect,
   * the minutes, the time of day), but not as the seconds tick: the card
   * cross-fades its digits on a new version and redraws them in place otherwise.
   */
  readonly version: number;
}

interface Countdown {
  /**
   * The countdown at `now` (ms since the epoch) for the params `timer`,
   * `countdown` (minutes) and `endsAt`. Allocates only when `endsAt` changes
   * or a passed time of day rolls over to tomorrow.
   */
  read: (timer: TimerMode, minutes: number, endsAt: string, now: number) => CountdownReading;
}

/** A countdown whose Duration first starts at `start` (ms since the epoch: the scene's creation). */
export function createCountdown(start: number): Countdown {
  const reading = { mode: "duration" as TimerMode, seconds: 0, version: 0 };
  let first = true;
  let durationStart = start;
  let lastMinutes = 0;
  let endsText = "";
  let endsTime: ClockTime | null = null;
  let target = Number.NaN;

  return {
    read(timer, minutes, endsAt, now) {
      const mins = clampMinutes(minutes);
      const text = typeof endsAt === "string" ? endsAt : "";
      if (first || text !== endsText) {
        endsText = text;
        endsTime = parseClockTime(text);
        const next =
          endsTime === null ? Number.NaN : nextOccurrence(endsTime, now, UNTIL_GRACE_HOURS);
        // Only a new time counts: "7:30pm" and "19:30" are the same, and so are two invalid texts.
        if (
          !first &&
          timer === "until" &&
          next !== target &&
          !(Number.isNaN(next) && Number.isNaN(target))
        ) {
          reading.version++;
        }
        target = next;
      } else if (endsTime !== null && now - target >= UNTIL_GRACE_HOURS * HOUR_MS) {
        // Reached long enough ago: count down to the next one.
        target = nextOccurrence(endsTime, now, UNTIL_GRACE_HOURS);
        if (timer === "until") {
          reading.version++;
        }
      }
      const mode: TimerMode =
        timer === "off" ? "off" : timer === "until" && endsTime !== null ? "until" : "duration";
      if (!first) {
        if (mode !== reading.mode) {
          reading.version++;
          if (mode === "duration") {
            durationStart = now;
          }
        } else if (mode === "duration" && mins !== lastMinutes) {
          reading.version++;
          durationStart = now;
        }
      }
      first = false;
      reading.mode = mode;
      lastMinutes = mins;
      const end = mode === "until" ? target : durationStart + mins * 60_000;
      reading.seconds = mode === "off" ? 0 : Math.max(0, Math.ceil((end - now) / 1000));
      return reading;
    },
  };
}
