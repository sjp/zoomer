import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import {
  ALERT_HOLD_SECONDS,
  ALERT_IN_SECONDS,
  ALERT_OUT_SECONDS,
  ALERT_SLIDE_PX,
  alertCopy,
  type AlertPose,
  alertShows,
  CONFETTI_KINDS,
  CONFETTI_LIFE_SECONDS,
  CONFETTI_MAX_SPEED,
  CONFETTI_PEAK,
  type ConfettiArea,
  confettiCount,
  confettiLimit,
  type ConfettiPiece,
  confettiPiece,
  createAlertRunner,
  fillName,
  parseAlertLines,
  SHEEN_PEAK,
  SHEEN_PX_PER_SECOND,
  sheenSeconds,
} from "./alert-schedule";
import {
  ALERT_KINDS_OPTIONS,
  ALERT_STYLE_OPTIONS,
  type AlertStyle,
  alertsMeta,
} from "./alerts.meta";
import { computeOverlayLayout } from "./overlay-layout";
import {
  EVENT_EVERY_KEY,
  EVENT_GAP_DEFAULT,
  EVENT_GAP_MAX,
  EVENT_GAP_MIN,
  EVENT_KINDS_KEY,
  eventKinds,
  type StreamEvent,
  streamEvent,
} from "./stream-events";

const DT = 1 / 60;
const SHOW = ALERT_IN_SECONDS + ALERT_HOLD_SECONDS + ALERT_OUT_SECONDS;

const event = (kind: StreamEvent["kind"], amount: number, index = 3): StreamEvent => ({
  index,
  kind,
  user: 200_000 + index,
  name: "PixelOtter42",
  amount,
});

describe("the alert params", () => {
  it("are the ones that shape the shared stream events, with the same range", () => {
    const every = alertsMeta.params[EVENT_EVERY_KEY];
    expect(every).toMatchObject({
      kind: "number",
      min: EVENT_GAP_MIN,
      max: EVENT_GAP_MAX,
      default: EVENT_GAP_DEFAULT,
    });
    const kinds = alertsMeta.params[EVENT_KINDS_KEY];
    expect(kinds).toMatchObject({ kind: "select", options: ALERT_KINDS_OPTIONS });
    for (const o of ALERT_KINDS_OPTIONS) {
      expect(eventKinds(o.value)).toBe(o.value);
    }
  });

  it("offer a style select defaulting to the banner", () => {
    expect(alertsMeta.params.alertStyle).toMatchObject({
      kind: "select",
      options: ALERT_STYLE_OPTIONS,
      default: "banner",
    });
  });
});

describe("alertShows", () => {
  it.each([
    ["all", "follow", true],
    ["all", "host", true],
    ["follows", "follow", true],
    ["follows", "gift", false],
    ["gifts", "gift", true],
    ["gifts", "sub", false],
  ] as const)("under %s shows a %s: %s", (kinds, kind, shows) => {
    expect(alertShows(kind, kinds)).toBe(shows);
  });
});

describe("the alert's words", () => {
  it.each([
    ["follow", 1, "New follower", "PixelOtter42 just followed!"],
    ["sub", 1, "New subscriber", "PixelOtter42 just subscribed!"],
    ["sub", 7, "Resubscribed", "PixelOtter42 subscribed for 7 months!"],
    ["gift", 1, "Gifted sub", "Thanks for the gift, PixelOtter42!"],
    ["gift", 5, "Gifted subs", "Thanks for the 5 gifts, PixelOtter42!"],
    ["host", 12, "Host", "PixelOtter42 is hosting with 12 viewers"],
  ] as const)("for a %s of %i", (kind, amount, title, line) => {
    expect(alertCopy(1, event(kind, amount), [])).toEqual({ title, line });
  });

  it("uses the viewer's own lines for about half the alerts, with the name filled in", () => {
    const own = ["Welcome {name}!", "{name}, you legend. Thanks {name}"];
    const lines = Array.from({ length: 1000 }, (_, i) => alertCopy(4, event("follow", 1, i), own));
    const mine = lines.filter((c) => !c.line.endsWith("just followed!"));
    expect(mine.length / lines.length).toBeGreaterThan(0.4);
    expect(mine.length / lines.length).toBeLessThan(0.6);
    expect(new Set(mine.map((c) => c.line))).toEqual(
      new Set(["Welcome PixelOtter42!", "PixelOtter42, you legend. Thanks PixelOtter42"]),
    );
    expect(mine.every((c) => c.title === "New follower")).toBe(true);
    expect(alertCopy(4, event("follow", 1, 9), own)).toEqual(
      alertCopy(4, event("follow", 1, 9), own),
    );
  });

  it("fills every {name}, taking the name literally", () => {
    expect(fillName("{name} and {name}", "a$&b")).toBe("a$&b and a$&b");
    expect(fillName("no name here", "x")).toBe("no name here");
  });

  it("sanitises the viewer's lines", () => {
    const text = [
      "  Hi   {name}  ",
      "",
      "evil‮line\u0007",
      "x".repeat(60),
      ...Array.from({ length: 12 }, (_, i) => `line ${String(i)}`),
    ].join("\n");
    const lines = parseAlertLines(text);
    expect(lines[0]).toBe("Hi {name}");
    expect(lines[1]).toBe("evilline");
    expect(lines[2]).toBe("x".repeat(40));
    // Ten lines in all, the blank one among them.
    expect(lines).toHaveLength(9);
    expect(parseAlertLines("   \n \n")).toEqual([]);
  });
});

/** Runs a runner showing one alert in `style` for `seconds`, recording its pose each frame. */
function poses(style: AlertStyle, seconds = SHOW + 0.5, stopAt = Infinity) {
  const runner = createAlertRunner();
  runner.offer(streamEvent(1, 0, "all"), style);
  const out: AlertPose[] = [];
  const pose: AlertPose = { alpha: 0, dy: 0, sheen: -1, time: 0 };
  let started = -1;
  for (let t = 0; t < seconds; t += DT) {
    if (t >= stopAt) {
      runner.stop();
      stopAt = Infinity;
    }
    runner.step(DT);
    if (runner.current !== null && started < 0) {
      started = t;
    }
    out.push({ ...runner.pose(sheenSeconds(400), pose) });
  }
  return { runner, out, started };
}

describe("createAlertRunner", () => {
  it("comes in, holds at rest and goes, ramping its opacity", () => {
    const { out, runner } = poses("banner");
    const shown = out.filter((p) => p.alpha > 0);
    expect(shown.length * DT).toBeGreaterThan(SHOW - 0.1);
    expect(shown.length * DT).toBeLessThan(SHOW + 0.1);
    for (let i = 1; i < out.length; i++) {
      expect(Math.abs(out[i].alpha - out[i - 1].alpha)).toBeLessThan(0.1);
    }
    const hold = out.filter((p) => p.time > ALERT_IN_SECONDS && p.time < SHOW - ALERT_OUT_SECONDS);
    expect(hold.every((p) => p.alpha === 1 && p.dy === 0)).toBe(true);
    expect(runner.current).toBeNull();
  });

  it("slides down with a gentle overshoot, and lifts away", () => {
    const { out } = poses("banner");
    const first = out.find((p) => p.alpha > 0);
    expect(first?.dy).toBeLessThan(-0.8 * ALERT_SLIDE_PX);
    const peak = Math.max(...out.map((p) => p.dy));
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(0.15 * ALERT_SLIDE_PX);
    const last = out.filter((p) => p.alpha > 0).at(-1);
    expect(last?.dy).toBeLessThan(-10);
  });

  it.each(["banner", "pixel", "minimal"] as const)(
    "moves within the codec's limits in the %s style",
    (style) => {
      const { out } = poses(style);
      // Per frame at 30 fps, in 1080p pixels.
      const moves = out.flatMap((p, i) =>
        i >= 2 && p.alpha > 0 && out[i - 2].alpha > 0 ? [Math.abs(p.dy - out[i - 2].dy)] : [],
      );
      expect(moves.length).toBeGreaterThan(SHOW / DT - 10);
      expect(Math.max(...moves)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      expect(SHEEN_PX_PER_SECOND / 30).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    },
  );

  it("sends the sheen across once while it holds, but not in the minimal style", () => {
    const banner = poses("banner").out.filter((p) => p.sheen >= 0);
    expect(banner.length * DT).toBeCloseTo(sheenSeconds(400), 1);
    expect(banner[0].time).toBeGreaterThan(ALERT_IN_SECONDS);
    expect(banner.at(-1)?.time).toBeLessThan(SHOW - ALERT_OUT_SECONDS);
    for (let i = 1; i < banner.length; i++) {
      expect(banner[i].sheen).toBeGreaterThan(banner[i - 1].sheen);
    }
    expect(poses("minimal").out.filter((p) => p.sheen >= 0)).toEqual([]);
    expect(poses("minimal").out.every((p) => p.dy <= 0)).toBe(true);
    expect(SHEEN_PEAK).toBeLessThanOrEqual(0.25);
  });

  it("takes a sheen slow enough to read, however narrow the banner", () => {
    expect(sheenSeconds(0)).toBe(1);
    expect(sheenSeconds(Number.NaN)).toBe(1);
    expect(sheenSeconds(640)).toBeCloseTo(640 / SHEEN_PX_PER_SECOND);
  });

  it.each([0.2, 2])("goes smoothly and soon when stopped %f s in", (at) => {
    const { out, started, runner } = poses("banner", SHOW, at);
    const from = Math.round(at / DT);
    for (let i = from; i < out.length; i++) {
      expect(Math.abs(out[i].alpha - out[i - 1].alpha)).toBeLessThan(0.1);
    }
    const gone = out.findIndex((p, i) => i > from && p.alpha === 0);
    expect((gone - from) * DT).toBeLessThan(0.5);
    expect(started).toBeGreaterThanOrEqual(0);
    expect(runner.current).toBeNull();
  });

  it("queues alerts that arrive while one shows, a couple at most, with a pause between", () => {
    const runner = createAlertRunner();
    runner.offer(streamEvent(1, 0, "all"), "banner");
    runner.step(DT);
    for (let i = 1; i < 5; i++) {
      runner.offer(streamEvent(1, i, "all"), "banner");
    }
    const shown: number[] = [];
    let gapFrames = 0;
    let longestGap = 0;
    for (let t = 0; t < 4 * SHOW; t += DT) {
      runner.step(DT);
      const index = runner.current?.event.index ?? -1;
      if (index >= 0 && shown.at(-1) !== index) {
        shown.push(index);
        longestGap = Math.max(longestGap, gapFrames);
      }
      gapFrames = index < 0 ? gapFrames + 1 : 0;
    }
    // The first, then the two newest that were waiting.
    expect(shown).toEqual([0, 3, 4]);
    expect(runner.version).toBe(3);
    expect(longestGap * DT).toBeGreaterThan(0.7);
  });

  it("drops the waiting alerts when stopped", () => {
    const runner = createAlertRunner();
    runner.offer(streamEvent(1, 0, "all"), "banner");
    runner.offer(streamEvent(1, 1, "all"), "banner");
    for (let t = 0; t < 2; t += DT) {
      runner.step(DT);
    }
    runner.stop();
    for (let t = 0; t < 3 * SHOW; t += DT) {
      runner.step(DT);
    }
    expect(runner.version).toBe(1);
    expect(runner.current).toBeNull();
  });
});

const areaOf = (w: number, h: number): ConfettiArea => {
  const layout = computeOverlayLayout(w, h);
  return {
    width: w,
    height: h,
    scale: h / 1080,
    left: layout.speaker.x,
    right: layout.speaker.x + layout.speaker.w,
    top: layout.speaker.y,
  };
};

describe("confetti", () => {
  it("throws 30 to 60 pieces", () => {
    const counts = Array.from({ length: 500 }, (_, i) => confettiCount(2, i));
    expect(Math.min(...counts)).toBe(30);
    expect(Math.max(...counts)).toBe(60);
  });

  it("keeps the speed limit at every piece's peak", () => {
    expect(CONFETTI_MAX_SPEED / 30).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });

  it("limits a piece to the top band over the speaker and the top third at the sides", () => {
    const area = areaOf(1920, 1080);
    expect(confettiLimit(area, 960, 5)).toBe(area.top);
    expect(confettiLimit(area, 100, 5)).toBe(360);
    expect(confettiLimit(area, area.left - 3, 5)).toBe(area.top);
  });

  it.each([
    [1920, 1080, false],
    [3840, 2160, false],
    [1440, 1080, true],
    [2560, 1080, false],
    [1080, 1920, false],
    [1000, 1000, true],
  ])(
    "stays out of the speaker's area and in the top third, within the motion limits, at %ix%i",
    (w, h, pixel) => {
      const area = areaOf(w, h);
      const layout = computeOverlayLayout(w, h);
      const s = h / 1080;
      const banner = Math.min(layout.topCentre.w, 520 * s);
      const cx = layout.topCentre.x + layout.topCentre.w / 2;
      const cy = layout.topCentre.y + 36 * s;
      const a: ConfettiPiece = { x: 0, y: 0, half: 0, angle: 0, flip: 1, alpha: 0, kind: 0 };
      const b: ConfettiPiece = { ...a };
      const third = Math.max(area.top, h / 3);
      let seen = 0;
      let fastest = 0;
      let brightest = 0;
      let highestKind = 0;
      // Pieces showing below their limit, and pieces still showing after their life.
      const low: string[] = [];
      const lingering: string[] = [];
      for (let alert = 0; alert < 6; alert++) {
        const n = confettiCount(7, alert);
        for (let i = 0; i < n; i++) {
          for (let t = 0; t < 5; t += 1 / 30) {
            confettiPiece(7, alert, i, t, cx, cy, banner, area, pixel, a);
            confettiPiece(7, alert, i, t + 1 / 30, cx, cy, banner, area, pixel, b);
            // Per frame at 30 fps, in 1080p pixels, while it shows.
            const move = a.alpha > 0 || b.alpha > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / s : 0;
            fastest = Math.max(fastest, move);
            brightest = Math.max(brightest, a.alpha);
            highestKind = Math.max(highestKind, a.kind);
            if (a.alpha > 0) {
              seen++;
            }
            const r = a.half * Math.SQRT2;
            const overSpeaker = a.x + r > area.left && a.x - r < area.right;
            if (a.alpha > 0 && a.y + r > (overSpeaker ? area.top : third)) {
              low.push(`alert ${String(alert)} piece ${String(i)} at ${t.toFixed(2)} s`);
            }
          }
          confettiPiece(7, alert, i, CONFETTI_LIFE_SECONDS + 0.31, cx, cy, banner, area, pixel, a);
          if (a.alpha !== 0) {
            lingering.push(`alert ${String(alert)} piece ${String(i)}`);
          }
        }
      }
      expect(fastest).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      expect(brightest).toBeLessThanOrEqual(CONFETTI_PEAK);
      expect(highestKind).toBeLessThan(CONFETTI_KINDS);
      expect(low).toEqual([]);
      expect(lingering).toEqual([]);
      expect(seen).toBeGreaterThan(1000);
    },
  );

  it("fades in and out rather than popping", () => {
    const area = areaOf(1920, 1080);
    const a: ConfettiPiece = { x: 0, y: 0, half: 0, angle: 0, flip: 1, alpha: 0, kind: 0 };
    let biggest = 0;
    for (let i = 0; i < 40; i++) {
      let last = 0;
      for (let t = 0; t < 5; t += DT) {
        confettiPiece(3, 0, i, t, 960, 60, 500, area, false, a);
        biggest = Math.max(biggest, Math.abs(a.alpha - last));
        last = a.alpha;
      }
    }
    expect(biggest).toBeLessThan(0.2);
  });

  it("doesn't spin or tumble in the pixel style", () => {
    const area = areaOf(1920, 1080);
    const a: ConfettiPiece = { x: 0, y: 0, half: 0, angle: 0, flip: 1, alpha: 0, kind: 0 };
    confettiPiece(3, 0, 5, 1.2, 960, 60, 500, area, true, a);
    expect([a.angle, a.flip]).toEqual([0, 1]);
    confettiPiece(3, 0, 5, 1.2, 960, 60, 500, area, false, a);
    expect(a.angle).not.toBe(0);
  });
});
