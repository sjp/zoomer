import { describe, expect, it } from "vitest";
import {
  clampEventEvery,
  createStreamEvents,
  EVENT_GAP_DEFAULT,
  EVENT_GAP_MAX,
  EVENT_GAP_MIN,
  eventGap,
  eventKind,
  eventKinds,
  type StreamEvent,
  type StreamEventKinds,
  streamEvent,
} from "./stream-events";
import { USERNAME_FIRST_WORDS } from "./usernames";

const DT = 1 / 60;

/** Every event over `seconds`, with the time it arrived. */
function collect(
  seed: number,
  seconds: number,
  every = EVENT_GAP_DEFAULT,
  kinds: StreamEventKinds = "all",
  dt = DT,
) {
  const stream = createStreamEvents(seed);
  const out: { time: number; event: StreamEvent }[] = [];
  let time = 0;
  for (let t = 0; t < seconds; t += dt) {
    stream.step(dt, every, kinds);
    time += dt;
    for (const event of stream.fresh) {
      out.push({ time, event });
    }
  }
  return { stream, out };
}

describe("eventGap", () => {
  it.each([
    [EVENT_GAP_MIN, EVENT_GAP_MIN],
    [EVENT_GAP_MAX, EVENT_GAP_MAX],
    [5, EVENT_GAP_MIN],
    [1000, EVENT_GAP_MAX],
    [Number.NaN, EVENT_GAP_DEFAULT],
  ])("keeps each gap at average %f within half to one and a half of %f", (every, mean) => {
    let sum = 0;
    for (let i = 0; i < 400; i++) {
      const gap = eventGap(3, i, every);
      expect(gap).toBeGreaterThanOrEqual(0.5 * mean);
      expect(gap).toBeLessThan(1.5 * mean);
      sum += gap;
    }
    expect(sum / 400).toBeGreaterThan(0.9 * mean);
    expect(sum / 400).toBeLessThan(1.1 * mean);
  });

  it("clamps the average to the slider's range", () => {
    expect(clampEventEvery(1)).toBe(EVENT_GAP_MIN);
    expect(clampEventEvery(90)).toBe(90);
    expect(clampEventEvery(Infinity)).toBe(EVENT_GAP_DEFAULT);
  });
});

/** Each kind's smallest and largest amount. */
const RANGES = { follow: [1, 1], sub: [1, 24], gift: [1, 20], host: [3, 60] } as const;

describe("streamEvent", () => {
  it("mixes the kinds under all, mostly follows", () => {
    const kinds = Array.from({ length: 4000 }, (_, i) => eventKind(5, i, "all"));
    const share = (k: string) => kinds.filter((x) => x === k).length / kinds.length;
    expect(share("follow")).toBeGreaterThan(0.5);
    expect(share("follow")).toBeLessThan(0.6);
    expect(share("sub")).toBeGreaterThan(0.2);
    expect(share("gift")).toBeGreaterThan(0.08);
    expect(share("host")).toBeGreaterThan(0.05);
  });

  it.each([
    ["follows", "follow"],
    ["gifts", "gift"],
  ] as const)("holds only one kind under %s", (kinds, kind) => {
    for (let i = 0; i < 200; i++) {
      expect(eventKind(5, i, kinds)).toBe(kind);
    }
  });

  it("gives each kind sensible numbers and a made-up name", () => {
    for (let i = 0; i < 2000; i++) {
      const e = streamEvent(9, i, "all");
      expect(e.index).toBe(i);
      expect(streamEvent(9, i, "all")).toEqual(e);
      expect(USERNAME_FIRST_WORDS.some((w) => e.name.toLowerCase().startsWith(w))).toBe(true);
      const [lo, hi] = RANGES[e.kind];
      expect(e.amount).toBeGreaterThanOrEqual(lo);
      expect(e.amount).toBeLessThanOrEqual(hi);
      expect(Number.isInteger(e.amount)).toBe(true);
    }
  });

  it("keeps the viewer whatever the kind", () => {
    expect(streamEvent(9, 12, "follows").name).toBe(streamEvent(9, 12, "gifts").name);
  });

  it("reads an unknown kinds value as all", () => {
    expect(eventKinds("gifts")).toBe("gifts");
    expect(eventKinds("nope")).toBe("all");
    expect(eventKinds(undefined)).toBe("all");
  });
});

describe("createStreamEvents", () => {
  it("is deterministic per seed, whatever the frame rate", () => {
    const a = collect(7, 1800).out;
    expect(collect(7, 1800).out).toEqual(a);
    expect(collect(8, 1800).out).not.toEqual(a);
    const coarse = collect(7, 1800, EVENT_GAP_DEFAULT, "all", 0.5).out;
    expect(coarse.map((e) => e.event)).toEqual(a.map((e) => e.event));
    coarse.forEach((e, i) => {
      expect(Math.abs(e.time - a[i].time)).toBeLessThan(0.5 + DT);
    });
  });

  it.each([EVENT_GAP_MIN, EVENT_GAP_MAX])("averages one event per %i s", (every) => {
    const { stream } = collect(2, 60 * every, every, "all", 0.25);
    expect(stream.count).toBeGreaterThan(50);
    expect(stream.count).toBeLessThan(70);
  });

  it("counts follows and keeps the latest follow and support", () => {
    const { stream, out } = collect(4, 1800);
    const follows = out.filter((e) => e.event.kind === "follow");
    expect(stream.follows).toBe(follows.length);
    expect(stream.latestFollow).toBe(follows.at(-1)?.event);
    const support = out.filter((e) => e.event.kind === "sub" || e.event.kind === "gift");
    expect(stream.latestSupport).toBe(support.at(-1)?.event);
  });

  it("has a follower and supporter from before the start", () => {
    const stream = createStreamEvents(4);
    expect(stream.count).toBe(0);
    expect(stream.latestFollow.kind).toBe("follow");
    expect(stream.latestFollow.index).toBeLessThan(0);
    expect(stream.latestSupport.kind).toBe("sub");
    expect(stream.latestSupport.name).not.toBe(stream.latestFollow.name);
  });

  it("latches the average gap per event: the gap under way keeps its length", () => {
    const slow = createStreamEvents(6);
    const fast = createStreamEvents(6);
    let slowFirst = -1;
    let fastFirst = -1;
    let t = 0;
    for (; t < 600; t += DT) {
      slow.step(DT, EVENT_GAP_MAX, "all");
      fast.step(DT, t < DT / 2 ? EVENT_GAP_MAX : EVENT_GAP_MIN, "all");
      if (slowFirst < 0 && slow.count > 0) {
        slowFirst = t;
      }
      if (fastFirst < 0 && fast.count > 0) {
        fastFirst = t;
      }
    }
    expect(fastFirst).toBeGreaterThan(0.5 * EVENT_GAP_MAX - 1);
    expect(fastFirst).toBeCloseTo(slowFirst, 5);
    expect(fast.count).toBeGreaterThan(slow.count + 5);
  });

  it("latches the kinds per event", () => {
    const stream = createStreamEvents(1);
    const kinds: string[] = [];
    for (let t = 0; t < 1200; t += DT) {
      stream.step(DT, EVENT_GAP_MIN, t < 600 ? "follows" : "gifts");
      for (const e of stream.fresh) {
        kinds.push(e.kind);
      }
    }
    const first = kinds.indexOf("gift");
    expect(first).toBeGreaterThan(10);
    expect(kinds.slice(0, first).every((k) => k === "follow")).toBe(true);
    expect(kinds.slice(first).every((k) => k === "gift")).toBe(true);
  });

  it("doesn't replay a stall", () => {
    const stream = createStreamEvents(3);
    stream.step(DT, EVENT_GAP_MIN, "all");
    stream.step(3600, EVENT_GAP_MIN, "all");
    expect(stream.fresh.length).toBeLessThanOrEqual(4);
  });

  it("empties its fresh list each step", () => {
    const stream = createStreamEvents(3);
    stream.step(EVENT_GAP_MAX * 2, EVENT_GAP_MIN, "all");
    expect(stream.fresh.length).toBeGreaterThan(0);
    stream.step(DT, EVENT_GAP_MIN, "all");
    expect(stream.fresh).toHaveLength(0);
  });
});
