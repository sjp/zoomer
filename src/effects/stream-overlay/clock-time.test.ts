import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ClockTime, lastOccurrence, nextOccurrence, parseClockTime } from "./clock-time";

// Pinned so the daylight-saving dates below are known: in 2026 New York's clocks
// go forward at 02:00 on 8 March and back at 02:00 on 1 November.
const ZONE = "America/New_York";

beforeAll(() => {
  // Node re-reads the zone whenever TZ is assigned.
  vi.stubEnv("TZ", ZONE);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** A local instant in the pinned zone. */
const local = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

/** The instant's local "y-m-d hh:mm". */
const show = (t: number) => {
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

const HOUR = 3_600_000;

describe("the pinned zone", () => {
  it("is in effect", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(ZONE);
    // Winter is UTC-5 and summer UTC-4.
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
  });
});

describe("parseClockTime", () => {
  it.each([
    ["0:00", 0, 0],
    ["9:05", 9, 5],
    ["09:05", 9, 5],
    ["19:30", 19, 30],
    ["23:59", 23, 59],
    ["  7:45  ", 7, 45],
    ["12:00 am", 0, 0],
    ["12:30pm", 12, 30],
    ["12:30 PM", 12, 30],
    ["7:30pm", 19, 30],
    ["7:30 Pm", 19, 30],
    ["07:30am", 7, 30],
    ["1:00 AM", 1, 0],
    ["11:59 pm", 23, 59],
  ])("reads %j", (text, hour, minute) => {
    expect(parseClockTime(text)).toEqual({ hour, minute });
  });

  it.each([
    "",
    "   ",
    "24:00",
    "9:60",
    "25:10",
    "7",
    "730",
    "7:3",
    "7:300",
    "123:00",
    ":30",
    "7:30 xm",
    "7:30  pm",
    "7:30 p",
    "0:30 am",
    "13:00 pm",
    "00:15pm",
    "-1:00",
    "7.30",
    "7:30:00",
    "noon",
    "７:３０",
  ])("rejects %j", (text) => {
    expect(parseClockTime(text)).toBeNull();
  });

  it("never throws on a non-string", () => {
    expect(parseClockTime(undefined as unknown as string)).toBeNull();
    expect(parseClockTime(42 as unknown as string)).toBeNull();
  });
});

describe("lastOccurrence", () => {
  const t: ClockTime = { hour: 19, minute: 30 };

  it("is today once the time has passed", () => {
    expect(show(lastOccurrence(t, local(2026, 6, 10, 21)))).toBe("2026-06-10 19:30");
  });

  it("is yesterday before the time", () => {
    expect(show(lastOccurrence(t, local(2026, 6, 10, 18)))).toBe("2026-06-09 19:30");
  });

  it("is now exactly at the time", () => {
    const now = local(2026, 6, 10, 19, 30);
    expect(lastOccurrence(t, now)).toBe(now);
  });

  it("reaches back across midnight", () => {
    const late = { hour: 23, minute: 50 };
    const now = local(2026, 6, 11, 0, 20);
    expect(show(lastOccurrence(late, now))).toBe("2026-06-10 23:50");
    expect(now - lastOccurrence(late, now)).toBe(30 * 60_000);
  });

  it("reaches back across New Year", () => {
    expect(show(lastOccurrence(t, local(2027, 1, 1, 1)))).toBe("2026-12-31 19:30");
  });

  it("is always within the last day or so", () => {
    for (let h = 0; h < 24; h++) {
      const now = local(2026, 6, 10, h, 7);
      const last = lastOccurrence(t, now);
      expect(last).toBeLessThanOrEqual(now);
      expect(now - last).toBeLessThan(24 * HOUR);
    }
  });

  it("loses an hour over the spring-forward night", () => {
    // 22:00 on 7 March to 21:00 on 8 March is 23 hours on the clock but 22 real ones.
    const now = local(2026, 3, 8, 21);
    const last = lastOccurrence({ hour: 22, minute: 0 }, now);
    expect(show(last)).toBe("2026-03-07 22:00");
    expect(now - last).toBe(22 * HOUR);
  });

  it("gains an hour over the fall-back night", () => {
    const now = local(2026, 11, 1, 21);
    const last = lastOccurrence({ hour: 22, minute: 0 }, now);
    expect(show(last)).toBe("2026-10-31 22:00");
    expect(now - last).toBe(24 * HOUR);
  });
});

describe("nextOccurrence", () => {
  const t = { hour: 19, minute: 30 };

  it("is later today before the time", () => {
    expect(show(nextOccurrence(t, local(2026, 6, 10, 18), 12))).toBe("2026-06-10 19:30");
  });

  it("stays on a time just passed, within the grace", () => {
    expect(show(nextOccurrence(t, local(2026, 6, 10, 20), 12))).toBe("2026-06-10 19:30");
  });

  it("is now exactly at the time", () => {
    const now = local(2026, 6, 10, 19, 30);
    expect(nextOccurrence(t, now, 12)).toBe(now);
    expect(nextOccurrence(t, now, 0)).toBe(local(2026, 6, 11, 19, 30));
  });

  it("moves to tomorrow beyond the grace", () => {
    const morning = { hour: 7, minute: 0 };
    expect(show(nextOccurrence(morning, local(2026, 6, 10, 20), 12))).toBe("2026-06-11 07:00");
  });

  it("moves to tomorrow just past the grace, and not just inside it", () => {
    const passed = local(2026, 6, 10, 19, 30);
    expect(nextOccurrence(t, passed + 12 * HOUR - 1, 12)).toBe(passed);
    expect(show(nextOccurrence(t, passed + 12 * HOUR, 12))).toBe("2026-06-11 19:30");
  });

  it("counts down across midnight", () => {
    const early = { hour: 0, minute: 15 };
    const now = local(2026, 6, 10, 23, 50);
    expect(show(nextOccurrence(early, now, 12))).toBe("2026-06-11 00:15");
    expect(nextOccurrence(early, now, 12) - now).toBe(25 * 60_000);
  });

  it("holds a time just before midnight once past it", () => {
    const late = { hour: 23, minute: 50 };
    expect(show(nextOccurrence(late, local(2026, 6, 11, 0, 20), 12))).toBe("2026-06-10 23:50");
  });

  it("with no grace is always ahead", () => {
    for (let h = 0; h < 24; h++) {
      const now = local(2026, 6, 10, h, 7);
      const next = nextOccurrence(t, now, 0);
      expect(next).toBeGreaterThan(now);
      expect(next - now).toBeLessThanOrEqual(24 * HOUR);
    }
  });

  it("loses an hour counting down over the spring-forward night", () => {
    const now = local(2026, 3, 7, 20);
    const next = nextOccurrence({ hour: 19, minute: 0 }, now, 0);
    expect(show(next)).toBe("2026-03-08 19:00");
    expect(next - now).toBe(22 * HOUR);
  });

  it("gains an hour counting down over the fall-back night", () => {
    const now = local(2026, 10, 31, 20);
    const next = nextOccurrence({ hour: 19, minute: 0 }, now, 0);
    expect(show(next)).toBe("2026-11-01 19:00");
    expect(next - now).toBe(24 * HOUR);
  });

  it("lands on the local time on a daylight-saving day itself", () => {
    expect(show(nextOccurrence(t, local(2026, 3, 8, 1), 0))).toBe("2026-03-08 19:30");
    expect(show(nextOccurrence(t, local(2026, 11, 1, 1), 0))).toBe("2026-11-01 19:30");
    expect(nextOccurrence(t, local(2026, 3, 8, 1), 0) - local(2026, 3, 8, 1)).toBe(17.5 * HOUR);
    expect(nextOccurrence(t, local(2026, 11, 1, 1), 0) - local(2026, 11, 1, 1)).toBe(19.5 * HOUR);
  });
});
