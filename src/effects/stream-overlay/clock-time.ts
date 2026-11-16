/**
 * Times of day typed into a text param, for clocks pinned to the wall clock
 * rather than to page load: a stream's uptime counted from when it went live,
 * or a countdown to when it starts. Pinned to a time of day, they come out the
 * same after a reload or a browser-source restart.
 *
 * Everything is in the viewer's local time zone. Instants are built from local
 * date fields (`new Date(y, m, d, h, min)`), never by adding 24 hours, so the
 * days either side of a daylight-saving change come out right. A link opened
 * in another time zone counts to that zone's local time.
 */

/** A local time of day, 24-hour. */
export interface ClockTime {
  /** 0..23. */
  readonly hour: number;
  /** 0..59. */
  readonly minute: number;
}

const CLOCK = /^(\d{1,2}):(\d{2})(?: ?([ap])m)?$/i;

const HOUR_MS = 3_600_000;

/**
 * Parses `H:MM` or `HH:MM` (24-hour), or `H:MM am` / `H:MMpm` (12-hour, any
 * case, an optional space before the suffix), ignoring surrounding spaces.
 * Anything else, including an empty string, `24:00` or `9:60`, gives null.
 * Never throws.
 */
export function parseClockTime(text: string): ClockTime | null {
  if (typeof text !== "string") {
    return null;
  }
  const m = CLOCK.exec(text.trim());
  if (!m) {
    return null;
  }
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59) {
    return null;
  }
  const suffix = m.at(3);
  if (suffix === undefined) {
    return hour <= 23 ? { hour, minute } : null;
  }
  if (hour < 1 || hour > 12) {
    return null;
  }
  // 12 am is midnight and 12 pm is noon.
  hour %= 12;
  if (suffix.toLowerCase() === "p") {
    hour += 12;
  }
  return { hour, minute };
}

/** The instant (ms) `days` days from `now`'s local date, at `time`. */
function atDay(time: ClockTime, now: number, days: number): number {
  const d = new Date(now);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    time.hour,
    time.minute,
  ).getTime();
}

/**
 * The most recent instant at or before `now` (ms since the epoch) that falls
 * at local `time`: within the last day.
 */
export function lastOccurrence(time: ClockTime, now: number): number {
  const today = atDay(time, now, 0);
  return today <= now ? today : atDay(time, now, -1);
}

/**
 * The next instant after `now` (ms since the epoch) at local `time`, except
 * that one less than `graceHours` in the past (or exactly now) wins: a
 * countdown that has just reached its time stays ended rather than jumping a
 * day ahead.
 */
export function nextOccurrence(time: ClockTime, now: number, graceHours: number): number {
  const last = lastOccurrence(time, now);
  if (now - last < Math.max(0, graceHours) * HOUR_MS) {
    return last;
  }
  const today = atDay(time, now, 0);
  return today > now ? today : atDay(time, now, 1);
}
