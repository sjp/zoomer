import { describe, expect, it } from "vitest";
import {
  arrivalGap,
  CHAT_MAX_BATCH,
  CHAT_MESSAGES,
  CHAT_PREFILL,
  CHAT_STEP_SECONDS,
  chatBadge,
  chatEventLine,
  chatEventText,
  chatMessage,
  chatRate,
  chatTokens,
  createChatFeed,
  parseChatLines,
} from "./chat-feed";
import { emoteIndex } from "./emote-art";
import { type StreamEvent, streamEvent } from "./stream-events";

/** Runs a feed for `seconds` at `busy`, returning the time and size of each step. */
function run(seed: number, busy: number, seconds: number, dt = 1 / 30) {
  const feed = createChatFeed(seed);
  const steps: { time: number; n: number }[] = [];
  let maxBacklog = 0;
  for (let t = 0; t < seconds; t += dt) {
    const n = feed.step(dt, busy);
    if (n > 0) {
      steps.push({ time: feed.time, n });
    }
    maxBacklog = Math.max(maxBacklog, feed.arrived - feed.released);
  }
  return { feed, steps, maxBacklog };
}

describe("the built-in messages", () => {
  it("are about 150 short, distinct lines", () => {
    expect(CHAT_MESSAGES.length).toBeGreaterThanOrEqual(140);
    expect(new Set(CHAT_MESSAGES).size).toBe(CHAT_MESSAGES.length);
    for (const line of CHAT_MESSAGES) {
      expect(line.length).toBeLessThanOrEqual(60);
      expect(line).toBe(line.trim());
      expect(line).not.toMatch(/\s{2}/);
    }
  });

  it("use only emotes that exist", () => {
    const unknown = CHAT_MESSAGES.flatMap((line) =>
      [...line.matchAll(/:([a-z]+):/g)].filter((m) => emoteIndex(m[1]) < 0).map((m) => m[0]),
    );
    expect(unknown).toEqual([]);
  });

  it("name no platform", () => {
    const names = /twitch|youtube|kick\.com|discord|tiktok|facebook|instagram/i;
    expect(CHAT_MESSAGES.filter((l) => names.test(l))).toEqual([]);
  });
});

describe("chatTokens", () => {
  it("splits a line into words and emotes", () => {
    expect(chatTokens(" hi  :wave: :nope: there:heart:")).toEqual([
      { text: "hi", emote: -1 },
      { text: ":wave:", emote: emoteIndex("wave") },
      { text: ":nope:", emote: -1 },
      { text: "there:heart:", emote: -1 },
    ]);
  });
});

describe("parseChatLines", () => {
  it("sanitises the viewer's lines, dropping blanks and squeezing spaces", () => {
    const long = "x".repeat(80);
    expect(parseChatLines("  hi   there \n\n‮flipped\u0007\n😀 smile\n" + long)).toEqual([
      "hi there",
      "flipped",
      "smile",
      "x".repeat(60),
    ]);
  });

  it("keeps at most thirty lines", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join("\n");
    expect(parseChatLines(text)).toHaveLength(30);
  });

  it("gives nothing for empty text", () => {
    expect(parseChatLines("")).toEqual([]);
    expect(parseChatLines(" \n \n")).toEqual([]);
  });
});

describe("chatMessage", () => {
  it("is the same for the same seed and number, and differs between seeds", () => {
    const a = Array.from({ length: 50 }, (_, i) => chatMessage(5, i, []));
    const b = Array.from({ length: 50 }, (_, i) => chatMessage(5, i, []));
    const c = Array.from({ length: 50 }, (_, i) => chatMessage(6, i, []));
    expect(a).toEqual(b);
    expect(a.filter((m, i) => m.text === c[i].text).length).toBeLessThan(5);
  });

  it("uses every built-in line once before repeating any", () => {
    const texts = Array.from({ length: CHAT_MESSAGES.length }, (_, i) => chatMessage(3, i, []))
      .filter((m) => !m.event)
      .map((m) => m.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it.each([
    [1, 0.06],
    [2, 0.12],
    [5, 0.3],
    [20, 0.3],
  ])("mixes in %i of the viewer's own lines, a share of %s", (count, share) => {
    const own = parseChatLines(
      Array.from({ length: count }, (_, i) => `my own line ${String(i)} :heart:`).join("\n"),
    );
    const texts = Array.from({ length: 4000 }, (_, i) => chatMessage(3, i, own))
      .filter((m) => !m.event)
      .map((m) => m.text);
    const mine = texts.filter((t) => own.includes(t));
    expect(mine.length / texts.length).toBeGreaterThan(share * 0.8);
    expect(mine.length / texts.length).toBeLessThan(share * 1.2);
    expect(new Set(mine).size).toBe(count);
  });

  it("has regulars who come back, no events of its own, and badges per viewer", () => {
    const messages = Array.from({ length: 2000 }, (_, i) => chatMessage(3, i, []));
    expect(messages.filter((m) => m.event)).toEqual([]);
    const byUser = new Map<number, number>();
    for (const m of messages) {
      byUser.set(m.user, (byUser.get(m.user) ?? 0) + 1);
      expect(m.badge).toBe(chatBadge(3, m.user));
    }
    expect(Math.max(...byUser.values())).toBeGreaterThan(20);
    const badged = [...byUser.keys()].filter((u) => chatBadge(3, u) > 0).length;
    expect(badged / byUser.size).toBeGreaterThan(0.35);
    expect(badged / byUser.size).toBeLessThan(0.55);
  });
});

describe("chatEventLine", () => {
  const event = (kind: StreamEvent["kind"], amount: number): StreamEvent => ({
    index: 7,
    kind,
    user: 200_007,
    name: "mossy_kettle",
    amount,
  });

  it.each([
    ["follow", 1, "followed!"],
    ["sub", 1, "subscribed!"],
    ["sub", 6, "subscribed for 6 months!"],
    ["gift", 1, "gifted a sub!"],
    ["gift", 5, "gifted 5 subs!"],
    ["host", 12, "is hosting with 12 viewers!"],
  ] as const)("says what a %s of %i did", (kind, amount, text) => {
    expect(chatEventText(event(kind, amount))).toBe(text);
  });

  it("is a highlighted line under the event's own name", () => {
    const e = streamEvent(2, 3, "all");
    expect(chatEventLine(e)).toEqual({
      index: 3,
      user: e.user,
      name: e.name,
      badge: 0,
      text: chatEventText(e),
      event: true,
    });
  });
});

describe("arrival rate", () => {
  it("runs from about 4 messages a minute at 0 to about 120 at 1", () => {
    expect(chatRate(0)).toBeCloseTo(4);
    expect(chatRate(1)).toBeCloseTo(120);
    expect(chatRate(0.3)).toBeGreaterThan(8);
    expect(chatRate(0.3)).toBeLessThan(14);
    expect(chatRate(-1)).toBe(chatRate(0));
    expect(chatRate(Number.NaN)).toBe(chatRate(0.3));
  });

  it.each([
    [0, 4],
    [1, 120],
  ])("averages the rate over half an hour at busy %d", (busy, perMinute) => {
    const { feed } = run(11, busy, 30 * 60, 0.1);
    const perMin = (feed.arrived - CHAT_PREFILL) / 30;
    expect(perMin).toBeGreaterThan(perMinute * 0.9);
    expect(perMin).toBeLessThan(perMinute * 1.1);
  });

  it("spreads gaps around the mean", () => {
    const gaps = Array.from({ length: 1000 }, (_, i) => arrivalGap(2, i, 1));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0.3 * 0.5);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1.7 * 0.5);
  });
});

describe("createChatFeed", () => {
  it("is deterministic per seed", () => {
    const a = run(4, 0.6, 120);
    const b = run(4, 0.6, 120);
    const c = run(5, 0.6, 120);
    expect(a.steps).toEqual(b.steps);
    expect(c.steps).not.toEqual(a.steps);
  });

  it("starts with the column already full, and steps in nothing at first", () => {
    const feed = createChatFeed(1);
    expect(feed.released).toBe(CHAT_PREFILL);
    expect(feed.step(1 / 60, 0.3)).toBe(0);
  });

  it("keeps the column's steps under two a second at the busiest", () => {
    const { feed, steps, maxBacklog } = run(8, 1, 10 * 60);
    for (let i = 0; i + 2 < steps.length; i++) {
      expect(steps[i + 2].time - steps[i].time).toBeGreaterThan(1);
    }
    for (let i = 0; i + 1 < steps.length; i++) {
      expect(steps[i + 1].time - steps[i].time).toBeGreaterThanOrEqual(CHAT_STEP_SECONDS - 1e-9);
    }
    expect(Math.max(...steps.map((s) => s.n))).toBe(CHAT_MAX_BATCH);
    // It keeps up: nearly every message is shown.
    const shown = steps.reduce((sum, s) => sum + s.n, 0);
    expect(shown / (feed.arrived - CHAT_PREFILL)).toBeGreaterThan(0.97);
    expect(maxBacklog).toBeLessThanOrEqual(6);
  });

  it("latches the busy value per arrival: the gap under way keeps its length", () => {
    const quiet = createChatFeed(2);
    const busy = createChatFeed(2);
    const dt = 1 / 60;
    let quietFirst = -1;
    let busyFirst = -1;
    for (let t = 0; t < 60; t += dt) {
      quiet.step(dt, 0);
      busy.step(dt, t < dt / 2 ? 0 : 1);
      if (quietFirst < 0 && quiet.arrived > CHAT_PREFILL) {
        quietFirst = quiet.time;
      }
      if (busyFirst < 0 && busy.arrived > CHAT_PREFILL) {
        busyFirst = busy.time;
      }
    }
    expect(busyFirst).toBeGreaterThan(4);
    expect(busyFirst).toBeCloseTo(quietFirst, 5);
    // Then the busy one speeds up.
    expect(busy.arrived - quiet.arrived).toBeGreaterThan(50);
  });

  it("brings waiting event lines in first, within the step's batch and spacing", () => {
    const feed = createChatFeed(5);
    let waiting = 3;
    const steps: { time: number; n: number; events: number }[] = [];
    /** Event lines counted on frames without a step: always 0. */
    const quiet: number[] = [];
    for (let t = 0; t < 30; t += 1 / 60) {
      const n = feed.step(1 / 60, 1, waiting);
      quiet.push(n > 0 ? 0 : feed.events);
      if (n > 0) {
        steps.push({ time: feed.time, n, events: feed.events });
        waiting -= feed.events;
      }
    }
    expect(waiting).toBe(0);
    expect(quiet.every((e) => e === 0)).toBe(true);
    expect(steps[0]).toEqual({ time: steps[0].time, n: 2, events: 2 });
    expect(steps[1].events).toBe(1);
    expect(steps[1].time - steps[0].time).toBeGreaterThanOrEqual(CHAT_STEP_SECONDS - 1e-9);
    for (const s of steps) {
      expect(s.n).toBeLessThanOrEqual(CHAT_MAX_BATCH);
    }
  });

  it("steps for an event line even when no message is waiting", () => {
    const feed = createChatFeed(1);
    expect(feed.step(1 / 60, 0, 1)).toBe(1);
    expect(feed.events).toBe(1);
    expect(feed.released).toBe(CHAT_PREFILL);
  });

  it("drops a long backlog after a stall rather than replaying it", () => {
    const feed = createChatFeed(3);
    feed.step(1 / 60, 1);
    feed.step(3600, 1);
    expect(feed.arrived - feed.released).toBeLessThanOrEqual(6);
    expect(feed.arrived).toBeLessThan(CHAT_PREFILL + 200);
  });
});
