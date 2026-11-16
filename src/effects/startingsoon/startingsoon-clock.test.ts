import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clampMinutes,
  createCountdown,
  formatCountdown,
  toTimerMode,
  UNTIL_GRACE_HOURS,
} from "./startingsoon-clock";

// Pinned so local times of day are known.
const ZONE = "Europe/London";

beforeAll(() => {
  vi.stubEnv("TZ", ZONE);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

/** A local instant in the pinned zone. */
const local = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe("formatCountdown", () => {
  it.each([
    [0, "0:00"],
    [7, "0:07"],
    [59, "0:59"],
    [60, "1:00"],
    [299, "4:59"],
    [300, "5:00"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3601, "1:00:01"],
    [42_125, "11:42:05"],
  ])("shows %d s as %s", (seconds, text) => {
    expect(formatCountdown(seconds)).toBe(text);
  });

  it("reads negative and non-finite input as 0:00", () => {
    expect(formatCountdown(-5)).toBe("0:00");
    expect(formatCountdown(Number.NaN)).toBe("0:00");
  });
});

describe("params", () => {
  it("map unknown timer values to Duration", () => {
    expect(toTimerMode("off")).toBe("off");
    expect(toTimerMode("until")).toBe("until");
    expect(toTimerMode("duration")).toBe("duration");
    expect(toTimerMode("bogus")).toBe("duration");
  });

  it("clamp the minutes to 1-60 whole minutes", () => {
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(5.4)).toBe(5);
    expect(clampMinutes(99)).toBe(60);
    expect(clampMinutes(Number.NaN)).toBe(5);
  });
});

describe("Duration", () => {
  const t0 = local(2026, 11, 16, 14, 0);

  it("counts down from the start, rounding up", () => {
    const c = createCountdown(t0);
    expect(c.read("duration", 5, "", t0).seconds).toBe(300);
    expect(c.read("duration", 5, "", t0 + 1).seconds).toBe(300);
    expect(c.read("duration", 5, "", t0 + SECOND).seconds).toBe(299);
    expect(c.read("duration", 5, "", t0 + 4 * MINUTE + 59 * SECOND + 1).seconds).toBe(1);
  });

  it("holds at zero once reached", () => {
    const c = createCountdown(t0);
    expect(c.read("duration", 1, "", t0 + MINUTE).seconds).toBe(0);
    const { version } = c.read("duration", 1, "", t0 + 2 * MINUTE);
    expect(c.read("duration", 1, "", t0 + 5 * HOUR).seconds).toBe(0);
    expect(c.read("duration", 1, "", t0 + 30 * HOUR)).toMatchObject({ seconds: 0, version });
  });

  it("restarts when the minutes change", () => {
    const c = createCountdown(t0);
    const before = c.read("duration", 5, "", t0 + 2 * MINUTE).version;
    const r = c.read("duration", 10, "", t0 + 3 * MINUTE);
    expect(r.seconds).toBe(600);
    expect(r.version).toBe(before + 1);
    expect(c.read("duration", 10, "", t0 + 4 * MINUTE).seconds).toBe(540);
  });

  it("restarts when it comes back into effect, even after reaching zero", () => {
    const c = createCountdown(t0);
    expect(c.read("duration", 5, "", t0 + 10 * MINUTE).seconds).toBe(0);
    expect(c.read("off", 5, "", t0 + 11 * MINUTE)).toMatchObject({ mode: "off", seconds: 0 });
    expect(c.read("duration", 5, "", t0 + 12 * MINUTE).seconds).toBe(300);
  });

  it("keeps its version while the seconds tick", () => {
    const c = createCountdown(t0);
    const { version } = c.read("duration", 5, "", t0);
    for (let s = 1; s < 400; s += 7) {
      expect(c.read("duration", 5, "", t0 + s * SECOND).version).toBe(version);
    }
  });

  it("ignores endsAt", () => {
    const c = createCountdown(t0);
    const { version } = c.read("duration", 5, "", t0);
    expect(c.read("duration", 5, "15:00", t0 + SECOND)).toMatchObject({
      mode: "duration",
      seconds: 299,
      version,
    });
  });
});

describe("Until time", () => {
  it("counts down to a later time today, in h:mm:ss above an hour", () => {
    const now = local(2026, 11, 16, 14, 0);
    const r = createCountdown(now).read("until", 5, "19:30", now);
    expect(r.mode).toBe("until");
    expect(r.seconds).toBe(5.5 * 3600);
    expect(formatCountdown(r.seconds)).toBe("5:30:00");
  });

  it("reads 12-hour times", () => {
    const now = local(2026, 11, 16, 19, 0);
    expect(createCountdown(now).read("until", 5, "7:30pm", now).seconds).toBe(30 * 60);
  });

  it("counts across midnight to a time early tomorrow", () => {
    const now = local(2026, 11, 16, 23, 50);
    expect(createCountdown(now).read("until", 5, "0:10", now).seconds).toBe(20 * 60);
  });

  it("holds at zero for a time just before midnight, seen just after it", () => {
    const now = local(2026, 11, 17, 0, 5);
    const r = createCountdown(now).read("until", 5, "23:55", now);
    expect(r).toMatchObject({ mode: "until", seconds: 0 });
  });

  it("holds at zero for a time within the grace", () => {
    const now = local(2026, 11, 16, 14, 0);
    const r = createCountdown(now).read("until", 5, "2:30", now);
    expect(now - local(2026, 11, 16, 2, 30)).toBeLessThan(UNTIL_GRACE_HOURS * HOUR);
    expect(r.seconds).toBe(0);
  });

  it("counts down to tomorrow for a time beyond the grace", () => {
    const now = local(2026, 11, 16, 14, 0);
    const r = createCountdown(now).read("until", 5, "1:30", now);
    expect(r.seconds).toBe(11.5 * 3600);
  });

  it("holds at zero after reaching its time, then counts to tomorrow once the grace runs out", () => {
    const start = local(2026, 11, 16, 19, 29);
    const c = createCountdown(start);
    expect(c.read("until", 5, "19:30", start).seconds).toBe(60);
    expect(c.read("until", 5, "19:30", start + MINUTE).seconds).toBe(0);
    const held = c.read("until", 5, "19:30", start + 11 * HOUR);
    expect(held.seconds).toBe(0);
    const { version } = held;
    const next = c.read("until", 5, "19:30", local(2026, 11, 17, 7, 30));
    expect(next.seconds).toBe(12 * 3600);
    expect(next.version).toBe(version + 1);
  });

  it("is the same after a reload", () => {
    const load1 = local(2026, 11, 16, 18, 0);
    const load2 = local(2026, 11, 16, 18, 40);
    const a = createCountdown(load1);
    a.read("until", 5, "19:30", load1);
    const later = load2 + 7 * SECOND;
    const b = createCountdown(load2);
    expect(b.read("until", 5, "19:30", later).seconds).toBe(
      a.read("until", 5, "19:30", later).seconds,
    );
  });

  it.each(["", "soon", "25:00", "9:60", "7pm"])("falls back to Duration for %j", (text) => {
    const now = local(2026, 11, 16, 14, 0);
    const c = createCountdown(now);
    expect(c.read("until", 5, text, now + 2 * SECOND)).toMatchObject({
      mode: "duration",
      seconds: 298,
    });
  });

  it("cross-fades on a new time but not on the same time written differently", () => {
    const now = local(2026, 11, 16, 14, 0);
    const c = createCountdown(now);
    const v0 = c.read("until", 5, "19:30", now).version;
    expect(c.read("until", 5, "7:30pm", now + SECOND).version).toBe(v0);
    expect(c.read("until", 5, "20:00", now + 2 * SECOND).version).toBe(v0 + 1);
  });

  it("restarts Duration when an edit makes the time invalid", () => {
    const now = local(2026, 11, 16, 14, 0);
    const c = createCountdown(now);
    c.read("until", 5, "19:30", now + 10 * MINUTE);
    const r = c.read("until", 5, "19:3", now + 11 * MINUTE);
    expect(r).toMatchObject({ mode: "duration", seconds: 300 });
  });
});
