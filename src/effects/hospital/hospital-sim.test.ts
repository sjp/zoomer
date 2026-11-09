import { describe, expect, it } from "vitest";
import {
  beatInterval,
  BEZEL,
  type Box,
  COLUMN_SECONDS,
  createMonitor,
  DESIGN_ASPECT,
  DRIP_PERIOD,
  DRIP_SWELL,
  dripDrop,
  ecgBeat,
  ERASE_COLUMNS,
  FLASH_SECONDS,
  heartFlash,
  packRoomLayout,
  plethBeat,
  PULSE_DELAY,
  R_TIME,
  respWave,
  ROOM_SLOT,
  ROOM_SLOTS,
  roomLayout,
  stepMonitor,
  SWEEP_SECONDS,
  TRACE_CHANNELS,
  TRACE_COLUMNS,
} from "./hospital-sim";

const edges = ([cx, cy, hw, hh]: Box) => [cx - hw, cx + hw, cy - hh, cy + hh] as const;
const overlap = (a: Box, b: Box) => {
  const [ax0, ax1, ay0, ay1] = edges(a);
  const [bx0, bx1, by0, by1] = edges(b);
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
};

describe("roomLayout", () => {
  for (const aspect of [DESIGN_ASPECT, 16 / 10, 4 / 3, 21 / 9]) {
    const l = roomLayout(aspect);
    const half = aspect / 2;
    const screen: Box = [l.screen[0], l.screen[1], l.screen[2] + BEZEL, l.screen[3] + BEZEL];
    const clock: Box = [l.clock[0], l.clock[1], l.clock[2], l.clock[2]];

    it(`keeps everything inside the frame at ${aspect.toFixed(2)}`, () => {
      for (const b of [screen, clock, l.board, l.chart, l.bag, l.pump, l.oxygen, l.gloves]) {
        const [x0, x1, y0, y1] = edges(b);
        expect(x0).toBeGreaterThanOrEqual(-half);
        expect(x1).toBeLessThanOrEqual(half);
        expect(y0).toBeGreaterThanOrEqual(-0.5);
        expect(y1).toBeLessThanOrEqual(0.5);
      }
    });

    it(`keeps the wall's things off the bed and out of each other's way at ${aspect.toFixed(2)}`, () => {
      const wall = [screen, clock, l.board, l.chart, l.pump, l.gloves];
      for (const b of wall) {
        expect(overlap(b, l.headboard)).toBe(false);
        expect(overlap(b, l.pillow)).toBe(false);
      }
      for (let i = 0; i < wall.length; i++) {
        for (let j = i + 1; j < wall.length; j++) {
          expect(overlap(wall[i], wall[j])).toBe(false);
        }
      }
      // The curtain stays beyond the board, the clock and the chart.
      for (const b of [clock, l.board, l.chart]) {
        expect(edges(b)[1]).toBeLessThan(l.curtain);
      }
    });
  }

  it("puts the monitor on the left and the drip on the right", () => {
    const l = roomLayout(DESIGN_ASPECT);
    expect(l.screen[0]).toBeLessThan(0);
    expect(l.pole).toBeGreaterThan(0);
    expect(l.board[0]).toBeGreaterThan(0);
  });

  it("falls back to 16:9 for a bad aspect", () => {
    expect(roomLayout(Number.NaN)).toEqual(roomLayout(DESIGN_ASPECT));
    expect(roomLayout(0)).toEqual(roomLayout(DESIGN_ASPECT));
  });
});

describe("waveforms", () => {
  it("peaks the ECG at the R wave and keeps the baseline flat between beats", () => {
    expect(ecgBeat(R_TIME, 0.8)).toBeCloseTo(1, 1);
    let max = -Infinity;
    for (let t = 0; t < 0.8; t += 0.001) {
      max = Math.max(max, ecgBeat(t, 0.8));
    }
    expect(max).toBeCloseTo(ecgBeat(R_TIME, 0.8), 2);
    expect(Math.abs(ecgBeat(0.75, 0.8))).toBeLessThan(0.02);
    expect(ecgBeat(R_TIME + 0.024, 0.8)).toBeLessThan(0);
    expect(ecgBeat(Number.NaN, 0.8)).toBe(0);
  });

  it("brings the T wave in sooner in a shorter beat", () => {
    const tPeak = (len: number) => {
      let best = 0;
      let at = 0;
      for (let t = R_TIME + 0.1; t < 0.9; t += 0.001) {
        const v = ecgBeat(t, len);
        if (v > best) {
          best = v;
          at = t;
        }
      }
      return at;
    };
    expect(tPeak(0.5)).toBeLessThan(tPeak(1.2));
  });

  it("delays the pulse after the R wave, then rises and falls", () => {
    expect(plethBeat(0)).toBe(0);
    expect(plethBeat(PULSE_DELAY)).toBe(0);
    const peak = plethBeat(PULSE_DELAY + 0.13);
    expect(peak).toBeGreaterThan(0.9);
    expect(plethBeat(PULSE_DELAY + 0.8)).toBeLessThan(peak * 0.3);
  });

  it("breathes in, out, and pauses", () => {
    expect(respWave(0)).toBeCloseTo(0);
    expect(respWave(0.38)).toBeCloseTo(1);
    expect(respWave(0.9)).toBe(0);
    expect(respWave(1.38)).toBeCloseTo(1);
    expect(respWave(Number.NaN)).toBeCloseTo(0);
  });
});

describe("beatInterval", () => {
  it("follows the rate, with a little variation", () => {
    for (const rate of [50, 72, 120]) {
      for (let i = 0; i < 50; i++) {
        const len = beatInterval(rate, 3, i, i / 7);
        expect(len).toBeGreaterThanOrEqual((60 / rate) * 0.9);
        expect(len).toBeLessThanOrEqual((60 / rate) * 1.1);
      }
    }
    expect(beatInterval(72, 3, 5, 0.25)).not.toBe(beatInterval(72, 3, 6, 0.25));
  });

  it("clamps silly rates", () => {
    expect(beatInterval(1, 0, 0, 0)).toBeLessThanOrEqual(2.2);
    expect(beatInterval(1e6, 0, 0, 0)).toBeGreaterThanOrEqual(0.27);
    expect(Number.isFinite(beatInterval(Number.NaN, 0, 0, 0))).toBe(true);
  });
});

describe("monitor", () => {
  it("starts a full sweep in, with sensible numbers", () => {
    const m = createMonitor(7, 72);
    expect(m.traces.length).toBe(TRACE_COLUMNS * TRACE_CHANNELS);
    expect(m.time).toBeCloseTo(SWEEP_SECONDS, 6);
    expect(Math.abs(m.vitals.hr - 72)).toBeLessThanOrEqual(4);
    expect(m.vitals.spo2).toBeGreaterThanOrEqual(97);
    expect(m.vitals.spo2).toBeLessThanOrEqual(99);
    expect(m.vitals.rr).toBeGreaterThanOrEqual(12);
    expect(m.vitals.rr).toBeLessThanOrEqual(18);
    expect(m.vitals.sys).toBeGreaterThan(m.vitals.dia);
    expect(m.vitals.map).toBeGreaterThan(m.vitals.dia);
    expect(m.vitals.map).toBeLessThan(m.vitals.sys);
    expect(m.traces.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("is deterministic per seed", () => {
    const a = createMonitor(11, 72);
    const b = createMonitor(11, 72);
    stepMonitor(a, 3.3, 72);
    stepMonitor(b, 3.3, 72);
    expect(Array.from(a.traces)).toEqual(Array.from(b.traces));
    expect(createMonitor(12, 72).traces).not.toEqual(a.traces);
  });

  it("writes one column per column's time, wherever the frames fall", () => {
    const a = createMonitor(5, 80);
    const b = createMonitor(5, 80);
    stepMonitor(a, 1.2, 80);
    for (let i = 0; i < 72; i++) {
      stepMonitor(b, 1 / 60, 80);
    }
    expect(a.cursor).toBe(b.cursor);
    for (let i = 0; i < a.traces.length; i++) {
      expect(a.traces[i]).toBeCloseTo(b.traces[i], 4);
    }
    expect(stepMonitor(a, COLUMN_SECONDS * 0.4, 80)).toBe(false);
    expect(stepMonitor(a, COLUMN_SECONDS * 0.7, 80)).toBe(true);
  });

  it("shows one R wave per beat on the ECG", () => {
    const m = createMonitor(3, 60);
    stepMonitor(m, SWEEP_SECONDS, 60);
    let peaks = 0;
    for (let i = 1; i < TRACE_COLUMNS - 1; i++) {
      const v = m.traces[i * TRACE_CHANNELS];
      if (
        v > 0.5 &&
        v >= m.traces[(i - 1) * TRACE_CHANNELS] &&
        v > m.traces[(i + 1) * TRACE_CHANNELS]
      ) {
        peaks++;
      }
    }
    // About six beats in a six-second sweep at 60 bpm.
    expect(peaks).toBeGreaterThanOrEqual(5);
    expect(peaks).toBeLessThanOrEqual(7);
  });

  it("settles the shown rate on a new heart rate", () => {
    const m = createMonitor(9, 60);
    stepMonitor(m, 10, 110);
    expect(Math.abs(m.vitals.hr - 110)).toBeLessThanOrEqual(5);
  });

  it("skips a long pause without drawing more than a sweep", () => {
    const m = createMonitor(9, 72);
    const before = m.time;
    stepMonitor(m, 100, 72);
    expect(m.time).toBeCloseTo(before + 100, 1);
    expect(m.cursor).toBeGreaterThanOrEqual(0);
    expect(m.cursor).toBeLessThan(TRACE_COLUMNS);
    expect(m.traces.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("ignores bad steps", () => {
    const m = createMonitor(1, 72);
    const t = m.time;
    stepMonitor(m, Number.NaN, 72);
    stepMonitor(m, -1, 72);
    expect(m.time).toBe(t);
  });

  it("lights the heart for a moment after each R wave", () => {
    const m = createMonitor(2, 72);
    let lit = 0;
    let samples = 0;
    for (let i = 0; i < 600; i++) {
      stepMonitor(m, 1 / 120, 72);
      const f = heartFlash(m);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      if (f > 0) {
        lit++;
      }
      samples++;
    }
    // Lit for FLASH_SECONDS of each 0.83 s beat.
    const share = lit / samples;
    expect(share).toBeGreaterThan((FLASH_SECONDS / (60 / 72)) * 0.6);
    expect(share).toBeLessThan((FLASH_SECONDS / (60 / 72)) * 1.4);
  });

  it("leaves a gap ahead of the cursor narrower than the screen", () => {
    expect(ERASE_COLUMNS).toBeGreaterThan(0);
    expect(ERASE_COLUMNS).toBeLessThan(TRACE_COLUMNS / 10);
  });
});

describe("dripDrop", () => {
  const out = new Float64Array(2);

  it("swells at the spout, then falls", () => {
    dripDrop(0, out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    dripDrop(DRIP_PERIOD * DRIP_SWELL * 0.5, out);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeLessThan(1);
    expect(out[1]).toBe(0);
    dripDrop(DRIP_PERIOD * (DRIP_SWELL + (1 - DRIP_SWELL) / 2), out);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(1);
  });

  it("repeats every period and survives bad times", () => {
    const a = Array.from(dripDrop(0.7, out));
    expect(Array.from(dripDrop(0.7 + DRIP_PERIOD * 3, out))[0]).toBeCloseTo(a[0]);
    dripDrop(Number.NaN, out);
    expect(Array.from(out).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("packRoomLayout", () => {
  const slot = (out: Float32Array, i: number) => Array.from(out.subarray(i * 4, i * 4 + 4));
  const f32 = (v: readonly number[]) => Array.from(new Float32Array(v));
  const S = ROOM_SLOT;

  it("gives every part its own slot, filling the array", () => {
    const used = Object.values(S).toSorted((a, b) => a - b);
    expect(used).toEqual(Array.from({ length: ROOM_SLOTS }, (_, i) => i));
  });

  it("puts each part where the shader reads it, and nothing past the slots", () => {
    for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
      const l = roomLayout(aspect);
      const out = new Float32Array(ROOM_SLOTS * 4 + 8).fill(Number.NaN);
      packRoomLayout(l, true, out);
      expect(slot(out, S.screen)).toEqual(f32(l.screen));
      expect(slot(out, S.clock)).toEqual(f32([...l.clock, 1]));
      expect(slot(out, S.board)).toEqual(f32(l.board));
      expect(slot(out, S.chart)).toEqual(f32(l.chart));
      expect(slot(out, S.bag)).toEqual(f32(l.bag));
      expect(slot(out, S.drip)).toEqual(f32(l.drip));
      expect(slot(out, S.pump)).toEqual(f32(l.pump));
      expect(slot(out, S.oxygen)).toEqual(f32(l.oxygen));
      expect(slot(out, S.gloves)).toEqual(f32(l.gloves));
      expect(slot(out, S.pillow)).toEqual(f32(l.pillow));
      expect(slot(out, S.headboard)).toEqual(f32(l.headboard));
      expect(slot(out, S.headwall)).toEqual(f32(l.headwall));
      expect(slot(out, S.misc)).toEqual(f32([l.pole, l.rail, l.curtain, aspect / 2]));
      expect(slot(out, S.rails)).toEqual(f32(l.rails));
      expect(Array.from(out.subarray(0, ROOM_SLOTS * 4)).every((v) => Number.isFinite(v))).toBe(
        true,
      );
      expect(Array.from(out.subarray(ROOM_SLOTS * 4)).every((v) => Number.isNaN(v))).toBe(true);
    }
  });

  it("flags a hidden clock", () => {
    const out = new Float32Array(ROOM_SLOTS * 4);
    packRoomLayout(roomLayout(16 / 9), false, out);
    expect(out[S.clock * 4 + 3]).toBe(0);
  });
});
