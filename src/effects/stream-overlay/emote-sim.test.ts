import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import {
  BURST_MAX,
  BURST_MIN,
  createEmoteWall,
  type EmotePose,
  type EmoteWall,
  eventBurstCount,
  HYPE_GAP_MAX,
  HYPE_GAP_MIN,
  hypeGap,
  MAX_BURSTS,
  MAX_EMOTES,
  RISE_MAX,
  TILT_REACH,
} from "./emote-sim";
import { emotesMeta } from "./emotes.meta";
import { computeOverlayLayout, type OverlayLayout } from "./overlay-layout";
import { streamEvent } from "./stream-events";

const layout1080 = computeOverlayLayout(1920, 1080);

const sizeDef = emotesMeta.params.emoteSize;
const EMOTE_SIZE_MAX = sizeDef.kind === "number" ? sizeDef.max : Number.NaN;

const blank = (): EmotePose => ({ id: 0, cell: 0, x: 0, y: 0, half: 0, angle: 0, alpha: 0 });

/** Every emote showing, keyed by id. */
function poses(wall: EmoteWall, layout: OverlayLayout, size = 1): Map<number, EmotePose> {
  const out = new Map<number, EmotePose>();
  for (let i = 0; i < MAX_EMOTES; i++) {
    const p = blank();
    if (wall.pose(i, layout, layout.height / 1080, size, p)) {
      out.set(p.id, p);
    }
  }
  return out;
}

const run = (wall: EmoteWall, seconds: number, dt: number, rate: number, bursts = true) => {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    wall.step(dt, rate, bursts);
  }
};

describe("createEmoteWall", () => {
  it("is deterministic", () => {
    const a = createEmoteWall();
    const b = createEmoteWall();
    for (let i = 0; i < 1800; i++) {
      a.step(1 / 60, 0.6, true);
      b.step(1 / 60, 0.6, true);
      if (i === 400) {
        a.burst(0.5, 12);
        b.burst(0.5, 12);
      }
    }
    expect(a.count).toBeGreaterThan(0);
    expect([...poses(a, layout1080)]).toEqual([...poses(b, layout1080)]);
  });

  it("places its trickle the same however time is cut into frames", () => {
    const a = createEmoteWall();
    const b = createEmoteWall();
    run(a, 20, 1 / 60, 0.5, false);
    run(b, 20, 1 / 24, 0.5, false);
    const pa = poses(a, layout1080);
    const pb = poses(b, layout1080);
    expect(pa.size).toBeGreaterThan(5);
    expect([...pb.keys()]).toEqual([...pa.keys()]);
    for (const [id, p] of pa) {
      const q = pb.get(id);
      expect(q?.cell).toBe(p.cell);
      expect(q?.x).toBeCloseTo(p.x, 6);
      expect(q?.y).toBeCloseTo(p.y, 6);
    }
  });

  it("trickles more at a higher rate, and none at 0", () => {
    const counts = [0, 0.3, 1].map((rate) => {
      const wall = createEmoteWall();
      run(wall, 30, 1 / 30, rate, false);
      return wall.count;
    });
    expect(counts[0]).toBe(0);
    expect(counts[1]).toBeGreaterThan(2);
    expect(counts[2]).toBeGreaterThan(2 * counts[1]);
  });

  it("never culls emotes in flight when the rate changes", () => {
    const kept = createEmoteWall();
    const changed = createEmoteWall();
    run(kept, 15, 1 / 30, 1, false);
    run(changed, 15, 1 / 30, 1, false);
    const before = [...poses(changed, layout1080).keys()];
    // Down to 0: every emote already rising carries on to the top.
    run(kept, 3, 1 / 30, 1, false);
    run(changed, 3, 1 / 30, 0, false);
    const still = (wall: EmoteWall) => {
      const now = poses(wall, layout1080);
      return before.filter((id) => now.has(id));
    };
    expect(still(changed).length).toBeGreaterThan(5);
    expect(still(changed)).toEqual(still(kept));
  });

  it("adds only new emotes when the rate goes up, leaving the others as they were", () => {
    const low = createEmoteWall();
    const high = createEmoteWall();
    run(low, 10, 1 / 30, 0.2, false);
    run(high, 10, 1 / 30, 0.2, false);
    run(low, 3, 1 / 30, 0.2, false);
    run(high, 3, 1 / 30, 1, false);
    const key = (p: EmotePose) => `${String(p.cell)} ${p.x.toFixed(6)} ${p.y.toFixed(6)}`;
    const lowKeys = [...poses(low, layout1080).values()].map((p) => key(p));
    const highKeys = new Set([...poses(high, layout1080).values()].map((p) => key(p)));
    expect(highKeys.size).toBeGreaterThan(lowKeys.length);
    for (const k of lowKeys) {
      expect(highKeys.has(k)).toBe(true);
    }
  });

  it("sends its own hype bursts only while bursts are on", () => {
    const on = createEmoteWall();
    const off = createEmoteWall();
    run(on, 600, 1 / 10, 0, true);
    run(off, 600, 1 / 10, 0, false);
    expect(on.bursts).toBeGreaterThanOrEqual(Math.floor(600 / HYPE_GAP_MAX));
    expect(on.bursts).toBeLessThanOrEqual(Math.ceil(600 / HYPE_GAP_MIN));
    expect(off.bursts).toBe(0);
    expect(off.count).toBe(0);
  });

  it("sends a burst of one emote up one side, staggered over about two seconds", () => {
    const wall = createEmoteWall();
    expect(wall.burst(0, 14)).toBe(true);
    const seen = new Map<number, EmotePose>();
    const firstSeen = new Map<number, number>();
    for (let i = 0; i < 90; i++) {
      wall.step(1 / 30, 0, false);
      for (const [id, p] of poses(wall, layout1080)) {
        seen.set(id, p);
        if (!firstSeen.has(id)) {
          firstSeen.set(id, wall.time);
        }
      }
    }
    expect(seen.size).toBe(14);
    const cells = new Set([...seen.values()].map((p) => p.cell));
    expect(cells.size).toBe(1);
    const left = [...seen.values()].every((p) => p.x < 1920 / 3);
    const right = [...seen.values()].every((p) => p.x > (2 * 1920) / 3);
    expect(left || right).toBe(true);
    const times = [...firstSeen.values()];
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(1.5);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(2.2);
  });

  it("clamps a burst's size and drops bursts past the queue", () => {
    const small = createEmoteWall();
    small.burst(0, 1);
    run(small, 3, 1 / 30, 0, false);
    expect(small.count).toBe(BURST_MIN);
    const big = createEmoteWall();
    for (let i = 0; i < MAX_BURSTS; i++) {
      expect(big.burst(5, 100)).toBe(true);
    }
    expect(big.burst(5, 10)).toBe(false);
    run(big, 8, 1 / 30, 0, false);
    expect(big.count).toBe(MAX_BURSTS * BURST_MAX);
  });

  it("stays under its cap with every burst overlapping at the highest rate", () => {
    const wall = createEmoteWall();
    run(wall, 20, 1 / 30, 1, true);
    let peak = 0;
    for (let i = 0; i < MAX_BURSTS; i++) {
      wall.burst(i * 0.3, BURST_MAX);
    }
    for (let i = 0; i < 150; i++) {
      wall.step(1 / 30, 1, true);
      peak = Math.max(peak, wall.count);
    }
    expect(peak).toBeLessThan(MAX_EMOTES);
    // Room to spare: no copy was dropped for want of a slot.
    expect(peak).toBeGreaterThan(MAX_BURSTS * BURST_MAX);
  });

  it("starts no backlog after a long frame", () => {
    const wall = createEmoteWall();
    wall.step(1 / 30, 1, true);
    wall.step(3600, 1, true);
    expect(wall.count).toBeLessThan(40);
    wall.step(Number.NaN, 1, true);
    wall.step(-1, Number.NaN, true);
    expect(Number.isFinite(wall.time)).toBe(true);
  });

  it.each([
    [1920, 1080],
    [1280, 960],
    [2560, 1080],
    [1080, 1080],
    [1080, 1920],
    [768, 1024],
    [400, 300],
  ])("keeps every emote out of the middle third at %i x %i", (w, h) => {
    const layout = computeOverlayLayout(w, h);
    const wall = createEmoteWall();
    let shown = 0;
    for (let i = 0; i < 900; i++) {
      wall.step(1 / 30, 1, true);
      if (i % 200 === 0) {
        wall.burst(0, BURST_MAX);
      }
      for (const p of poses(wall, layout, EMOTE_SIZE_MAX).values()) {
        shown++;
        const lo = p.x - p.half * TILT_REACH;
        const hi = p.x + p.half * TILT_REACH;
        const l = layout.edgeLeft;
        const r = layout.edgeRight;
        const inLeft = lo >= l.x && hi <= l.x + l.w;
        const inRight = lo >= r.x && hi <= r.x + r.w;
        expect(inLeft || inRight).toBe(true);
      }
    }
    expect(shown).toBeGreaterThan(0);
  });

  it("moves well inside the codec limits at the largest size and highest rate", () => {
    expect(pxPerReferenceFrame(RISE_MAX)).toBeLessThan(MAX_FEATURE_PX_PER_FRAME / 2);
    const wall = createEmoteWall();
    let last = new Map<number, EmotePose>();
    let worst = 0;
    for (let i = 0; i < 900; i++) {
      // 1080p at 30 fps: pixels per frame are the reference's.
      wall.step(1 / 30, 1, true);
      if (i % 150 === 0) {
        wall.burst(0, BURST_MAX);
      }
      const now = poses(wall, layout1080, EMOTE_SIZE_MAX);
      for (const [id, p] of now) {
        const q = last.get(id);
        if (q === undefined) {
          continue;
        }
        // The emote's centre and the four points of its rim.
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const at = (s: EmotePose) => {
            const c = Math.cos(s.angle);
            const n = Math.sin(s.angle);
            return [s.x + s.half * (dx * c - dy * n), s.y + s.half * (dx * n + dy * c)];
          };
          const [x0, y0] = at(q);
          const [x1, y1] = at(p);
          worst = Math.max(worst, Math.hypot(x1 - x0, y1 - y0));
        }
      }
      last = now;
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(MAX_FEATURE_PX_PER_FRAME);
  });
});

describe("eventBurstCount", () => {
  it("bursts after every gift, bigger for bigger gifts", () => {
    const gifts = Array.from({ length: 200 }, (_, i) => streamEvent(7, i, "gifts")).filter(
      (e) => e.kind === "gift",
    );
    expect(gifts.length).toBeGreaterThan(50);
    for (const g of gifts) {
      const n = eventBurstCount(g);
      expect(n).toBeGreaterThanOrEqual(BURST_MIN);
      expect(n).toBeLessThanOrEqual(BURST_MAX);
    }
    const one = gifts.find((g) => g.amount === 1);
    const many = gifts.find((g) => g.amount >= 10);
    expect(eventBurstCount(many ?? gifts[0])).toBeGreaterThan(eventBurstCount(one ?? gifts[0]));
  });

  it("bursts after about half of subs, and never after a follow or host", () => {
    const events = Array.from({ length: 2000 }, (_, i) => streamEvent(3, i, "all"));
    const subs = events.filter((e) => e.kind === "sub");
    const share = subs.filter((e) => eventBurstCount(e) > 0).length / subs.length;
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.65);
    for (const e of events.filter((x) => x.kind === "follow" || x.kind === "host")) {
      expect(eventBurstCount(e)).toBe(0);
    }
  });
});

describe("hypeGap", () => {
  it("keeps hype bursts 45 to 150 seconds apart", () => {
    for (let n = 0; n < 500; n++) {
      expect(hypeGap(n)).toBeGreaterThanOrEqual(HYPE_GAP_MIN);
      expect(hypeGap(n)).toBeLessThanOrEqual(HYPE_GAP_MAX);
    }
  });
});
