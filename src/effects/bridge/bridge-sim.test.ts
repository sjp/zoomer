import { describe, expect, it } from "vitest";
import { buildPanels, groupCount } from "./bridge-panels";
import { bridgeLayout } from "./bridge-room";
import {
  ALERT_FADE,
  alertPulse,
  blockStates,
  createAlertMix,
  createStateScratch,
  eventsStarting,
  PULSE_PERIOD,
  stepAlert,
} from "./bridge-sim";
import {
  blockEvent,
  type BlockEvent,
  CHASE_SLOT,
  chaseStart,
  chaseWeight,
  eventWeight,
  slotLength,
} from "../console-blocks";

const set = buildPanels(bridgeLayout("left", true), 12);
const blocks = set.blocks;
const SEED = 12;

const event = (): BlockEvent => ({ kind: "none", start: 0, length: 0 });

describe("bridge activity", () => {
  it("keeps each event inside its slot", () => {
    const ev = event();
    const outside: string[] = [];
    let events = 0;
    for (let i = 1; i < blocks.length; i++) {
      const len = slotLength(i, SEED);
      for (let s = 0; s < 40; s++) {
        blockEvent(blocks[i], i, SEED, 1, s, ev);
        events += ev.kind === "none" ? 0 : 1;
        if (ev.kind !== "none" && (ev.start < s * len || ev.start + ev.length > (s + 1) * len)) {
          outside.push(`block ${String(i)} slot ${String(s)}`);
        }
      }
    }
    expect(events).toBeGreaterThan(100);
    expect(outside).toEqual([]);
  });

  it("has no events or chases at activity 0", () => {
    expect(eventsStarting(blocks, SEED, 0, 0, 600)).toBe(0);
    for (let s = 0; s < 50; s++) {
      expect(Number.isNaN(chaseStart(0, SEED, 0, s))).toBe(true);
    }
  });

  it("scales the event rate with activity, and keeps it to a few at a time", () => {
    const quiet = eventsStarting(blocks, SEED, 0.2, 0, 600);
    const busy = eventsStarting(blocks, SEED, 0.8, 0, 600);
    expect(busy).toBeGreaterThan(quiet * 2.5);
    // At the default activity, a few changes a second on average...
    expect(eventsStarting(blocks, SEED, 0.4, 0, 600) / 600).toBeLessThan(5);
    // ...and even when busiest, never a burst in any one second.
    let most = 0;
    for (let t = 0; t < 300; t++) {
      most = Math.max(most, eventsStarting(blocks, SEED, 1, t, t + 1));
    }
    expect(most).toBeLessThan(25);
  });

  it("fades events in and out, back to rest", () => {
    const ev: BlockEvent = { kind: "swap", start: 10, length: 3 };
    expect(eventWeight(ev, 9.99)).toBe(0);
    expect(eventWeight(ev, 11.5)).toBe(1);
    expect(eventWeight(ev, 13.01)).toBe(0);
    let prev = 0;
    for (let t = 9.9; t < 13.1; t += 0.001) {
      const w = eventWeight(ev, t);
      expect(Math.abs(w - prev)).toBeLessThan(0.02);
      prev = w;
    }
  });

  it("runs a chase down its buttons in order and returns to rest", () => {
    const start = 5;
    const peak = (order: number) => {
      let best = 0;
      let at = 0;
      for (let t = start; t < start + 3; t += 0.005) {
        const w = chaseWeight(start, order, t);
        if (w > best) {
          best = w;
          at = t;
        }
      }
      return at;
    };
    for (let k = 0; k < 6; k++) {
      expect(peak(k + 1)).toBeGreaterThan(peak(k));
      expect(chaseWeight(start, k, start + 3)).toBe(0);
    }
    expect(chaseWeight(Number.NaN, 0, start)).toBe(0);
  });

  it("starts chases inside their slots", () => {
    const starts = Array.from({ length: 100 }, (_, s) => [s, chaseStart(3, SEED, 1, s)] as const);
    const chases = starts.filter(([, t]) => !Number.isNaN(t));
    expect(chases.length).toBeGreaterThan(20);
    expect(chases.filter(([s, t]) => t < s * CHASE_SLOT || t + 2 >= (s + 1) * CHASE_SLOT)).toEqual(
      [],
    );
  });
});

describe("bridge alert", () => {
  it("fades between palettes continuously, summing to 1", () => {
    const mix = createAlertMix();
    const dt = 1 / 60;
    let prev = mix.red;
    for (let i = 0; i < 120; i++) {
      stepAlert(mix, "red", dt);
      expect(mix.normal + mix.yellow + mix.red).toBeCloseTo(1, 9);
      expect(mix.red - prev).toBeLessThanOrEqual(dt / ALERT_FADE + 1e-9);
      prev = mix.red;
    }
    expect(mix.red).toBe(1);
    stepAlert(mix, "yellow", ALERT_FADE);
    expect(mix.yellow).toBe(1);
  });

  it("pulses slowly and smoothly", () => {
    expect(PULSE_PERIOD).toBeGreaterThanOrEqual(1.5);
    for (let t = 0; t < 5; t += 0.1) {
      expect(alertPulse(t)).toBeCloseTo(alertPulse(t + PULSE_PERIOD), 9);
      expect(Math.abs(alertPulse(t + 0.01) - alertPulse(t))).toBeLessThan(0.02);
    }
  });
});

describe("bridge block states", () => {
  it("fills a texel per block, with block 0 dark", () => {
    const out = new Uint8Array(blocks.length * 4);
    const scratch = createStateScratch(groupCount(set));
    blockStates(blocks, SEED, 0.4, createAlertMix(), 33, scratch, out);
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    let lit = 0;
    for (let i = 1; i < blocks.length; i++) {
      lit += out[i * 4] + out[i * 4 + 1] + out[i * 4 + 2] > 100 ? 1 : 0;
    }
    expect(lit).toBeGreaterThan(blocks.length * 0.8);
  });

  it("is a function of time alone", () => {
    const a = new Uint8Array(blocks.length * 4);
    const b = new Uint8Array(blocks.length * 4);
    const mix = createAlertMix();
    const s1 = createStateScratch(groupCount(set));
    for (let t = 0; t < 50; t += 0.37) {
      blockStates(blocks, SEED, 0.7, mix, t, s1, a);
    }
    blockStates(blocks, SEED, 0.7, mix, 50 - 0.37 + 0.37, createStateScratch(groupCount(set)), b);
    blockStates(blocks, SEED, 0.7, mix, 50 - 0.37 + 0.37, s1, a);
    expect(a).toEqual(b);
  });
});
