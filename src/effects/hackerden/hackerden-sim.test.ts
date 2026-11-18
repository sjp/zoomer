import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import { MAX_SCREENS } from "./hackerden.meta";
import {
  ADD_ORDER,
  ALERT_IN,
  ALERT_MAX_GAP,
  ALERT_MAX_HOLD,
  ALERT_MIN_GAP,
  ALERT_MIN_HOLD,
  ALERT_OUT,
  alertLevel,
  assignKinds,
  CENTRE_SLOT,
  createAlerts,
  createCode,
  createDecrypt,
  createDen,
  createMap,
  createNetwork,
  createScreen,
  createTerminal,
  DIRTY_ALL,
  DIRTY_NONE,
  HOP_SPEED,
  hopPeakPx,
  lineStepOffset,
  LINE_STEP_SECONDS,
  MAX_HOPS,
  MAX_TICK_HZ,
  networkLinked,
  PULSE_SPEED,
  SCREEN_KINDS,
  screenCount,
  SLOTS,
  stepAlerts,
  stepDen,
  stepScreen,
  terminalLine,
  tickSeconds,
  WAVE_HZ,
} from "./hackerden-sim";

const DT = 1 / 30;

describe("hacker den layout", () => {
  it("keeps the monitors apart", () => {
    for (let a = 0; a < SLOTS.length; a++) {
      for (let b = a + 1; b < SLOTS.length; b++) {
        const A = SLOTS[a];
        const B = SLOTS[b];
        const apart =
          Math.abs(A.x - B.x) > A.hw + B.hw + 0.02 || Math.abs(A.y - B.y) > A.hh + B.hh + 0.02;
        expect([a, b, apart]).toEqual([a, b, true]);
      }
    }
  });

  it("adds screens at the ends of the arrangement", () => {
    expect([...ADD_ORDER].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(ADD_ORDER[0]).toBe(CENTRE_SLOT);
    expect(ADD_ORDER.slice(5).toSorted((a, b) => a - b)).toEqual([0, MAX_SCREENS - 1]);
  });

  it.each(Array.from({ length: 40 }, (_, i) => i * 7919 + 1))(
    "gives every screen its own kind, the map in the middle (seed %i)",
    (seed) => {
      const kinds = assignKinds(seed);
      expect(kinds.toSorted()).toEqual([...SCREEN_KINDS].toSorted());
      expect(kinds[CENTRE_SLOT]).toBe("map");
      // The terminal shows at every screen count.
      expect(ADD_ORDER.slice(0, 5)).toContain(kinds.indexOf("terminal"));
    },
  );

  it("is the same every time for a seed", () => {
    expect(assignKinds(42)).toEqual(assignKinds(42));
  });
});

describe("hacker den screens", () => {
  it.each([0.2, 0.5, 1])("ticks at most %s x 6 times a second", (pace) => {
    expect(1 / tickSeconds(pace)).toBeCloseTo(MAX_TICK_HZ * pace);
    expect(1 / tickSeconds(pace)).toBeLessThanOrEqual(MAX_TICK_HZ);
  });

  it("types into the last line and steps up a line at a time", () => {
    const t = createTerminal(3, 12);
    let steps = 0;
    let typed = 0;
    for (let i = 0; i < 30 * 60; i++) {
      t.dirty = DIRTY_NONE;
      const age = t.stepAge;
      stepScreen(t, DT, 1);
      if (t.stepAge < age) {
        steps++;
      } else if (t.dirty >= 0) {
        typed++;
      }
      expect(t.lines.length).toBeLessThanOrEqual(t.rows + 1);
      expect(terminalLine(t, t.rows - 1)).toBe(t.lines.length - 1);
    }
    expect(steps).toBeGreaterThan(20);
    expect(typed).toBeGreaterThan(50);
  });

  it("eases a line step without jumps", () => {
    expect(lineStepOffset(0)).toBe(1);
    expect(lineStepOffset(LINE_STEP_SECONDS)).toBe(0);
    for (let t = 0; t < LINE_STEP_SECONDS; t += DT) {
      expect(lineStepOffset(t) - lineStepOffset(t + DT)).toBeLessThan(0.25);
    }
  });

  it.each([0.2, 1])("steps code no faster than its ease at pace %s", (pace) => {
    const c = createCode(9, 12);
    const steps: number[] = [];
    for (let i = 0; i < 30 * 30; i++) {
      stepScreen(c, DT, pace);
      if (c.stepAge === 0) {
        steps.push(i * DT);
      }
    }
    const gaps = steps.slice(1).map((t, i) => t - steps[i]);
    expect(steps.length).toBeGreaterThan(5);
    expect(Math.min(...gaps)).toBeGreaterThan(LINE_STEP_SECONDS);
  });

  it("changes a few hex cells a tick and settles column by column", () => {
    const d = createDecrypt(11, 8, 10);
    d.dirtyAll = false;
    const redrawsAll = (x: typeof d) => x.dirtyAll;
    let most = 0;
    for (let i = 0; i < 30 * 40; i++) {
      d.changedCount = 0;
      d.dirtyAll = false;
      stepScreen(d, DT, 1);
      most = Math.max(most, redrawsAll(d) ? 0 : d.changedCount);
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(4);
    expect(d.settledCount).toBeGreaterThan(d.rows);
    // Each settled column is whole before the next starts.
    for (let c = 0; c < d.cols; c++) {
      const col = Array.from({ length: d.rows }, (_, r) => d.settled[r * d.cols + c]);
      const settledHere = Math.min(d.rows, Math.max(0, d.settledCount - c * d.rows));
      expect(col.filter((v) => v === 1).length).toBe(settledHere);
    }
  });

  it("runs every kind for ten minutes without trouble", () => {
    for (const kind of SCREEN_KINDS) {
      const s = createScreen(kind, SLOTS[1], 5);
      for (let i = 0; i < 30 * 600; i++) {
        stepScreen(s, DT, 0.5 + 0.5 * Math.sin(i / 500));
      }
      expect(s.clock.wait).toBeGreaterThan(0);
    }
  });

  it("keeps the network's pulse on its links and under the motion limit", () => {
    const n = createNetwork(2, 0.3, 0.16);
    for (let i = 1; i < n.pathLen; i++) {
      expect(networkLinked(n, n.path[i - 1], n.path[i])).toBe(true);
    }
    expect(pxPerReferenceFrame(PULSE_SPEED)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    let x = n.pulseX;
    let y = n.pulseY;
    let paths = n.paths;
    let fastest = 0;
    let levelAtNewPath = 0;
    for (let i = 0; i < 30 * 60; i++) {
      stepScreen(n, DT, 0.5);
      // A new path starts while the pulse is faded out.
      if (n.paths === paths) {
        const moved = Math.hypot((n.pulseX - x) * n.width, (n.pulseY - y) * n.height);
        fastest = Math.max(fastest, moved * 1080);
      } else {
        levelAtNewPath = Math.max(levelAtNewPath, n.pulseLevel);
        paths = n.paths;
      }
      x = n.pulseX;
      y = n.pulseY;
    }
    expect(paths).toBeGreaterThan(2);
    expect(levelAtNewPath).toBe(0);
    expect(fastest).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });

  it("keeps the waveform's crests under the pattern limit", () => {
    for (const hz of WAVE_HZ) {
      expect(hz).toBeLessThan(MAX_PATTERN_HZ);
    }
  });

  it("hops the trace within reach, never back, under the motion limit", () => {
    const slot = SLOTS[CENTRE_SLOT];
    const m = createMap(4, 2 * slot.hw, 2 * slot.hh);
    expect(hopPeakPx(HOP_SPEED * 2)).toBeLessThanOrEqual(8 + 1e-9);
    const first = m.trace;
    let most = 0;
    let shortest = Infinity;
    let longest = 0;
    for (let i = 0; i < 30 * 600; i++) {
      stepScreen(m, DT, 0.5);
      most = Math.max(most, m.count);
      shortest = Math.min(shortest, m.hopSeconds);
      longest = Math.max(longest, m.hopSeconds);
    }
    expect(m.trace - first).toBeGreaterThan(5);
    expect(most).toBeLessThanOrEqual(MAX_HOPS + 1);
    expect(shortest).toBeGreaterThanOrEqual(1);
    expect(longest).toBeLessThanOrEqual(2);
    const from = (i: number) =>
      Math.hypot(
        (m.points[2 * i] - m.points[0]) * m.width,
        (m.points[2 * i + 1] - m.points[1]) * m.height,
      );
    for (let i = 1; i < m.count; i++) {
      expect(from(i)).toBeGreaterThan(from(i - 1));
    }
  });
});

describe("hacker den alerts", () => {
  const shown = new Float32Array(MAX_SCREENS).fill(1);

  it("comes every 60-120 s, ramps in, holds and fades without jumps", () => {
    const a = createAlerts(17);
    const starts: number[] = [];
    const slots: number[] = [];
    const holds: number[] = [];
    let prev = 0;
    let jump = 0;
    let shownFor = 0;
    for (let i = 0; i < 30 * 1200; i++) {
      const phase = a.phase;
      stepAlerts(a, DT, true, shown);
      if (phase === 0 && a.phase === 1) {
        starts.push(i * DT);
        slots.push(a.slot);
        holds.push(a.hold);
      }
      const level = alertLevel(a);
      jump = Math.max(jump, Math.abs(level - prev));
      prev = level;
      shownFor += level > 0 ? DT : 0;
    }
    // A smoothstep peaks at 1.5x its mean rate.
    expect(jump).toBeLessThanOrEqual((1.5 * DT) / Math.min(ALERT_IN, ALERT_OUT) + 1e-6);
    expect(slots).not.toContain(CENTRE_SLOT);
    expect(Math.min(...holds)).toBeGreaterThanOrEqual(ALERT_MIN_HOLD);
    expect(Math.max(...holds)).toBeLessThanOrEqual(ALERT_MAX_HOLD);
    expect(starts[0]).toBeGreaterThanOrEqual(ALERT_MIN_GAP / 2);
    expect(starts[0]).toBeLessThanOrEqual(ALERT_MAX_GAP / 2);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(ALERT_MIN_GAP);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(
      ALERT_MAX_GAP + ALERT_IN + ALERT_MAX_HOLD + ALERT_OUT + 1,
    );
    expect(starts.length).toBeGreaterThan(8);
    expect(shownFor / 1200).toBeLessThan(0.1);
  });

  it("fades the banner showing when alerts are turned off, and shows none while off", () => {
    const a = createAlerts(17);
    while (a.phase !== 2) {
      stepAlerts(a, DT, true, shown);
    }
    let prev = alertLevel(a);
    let rose = false;
    for (let i = 0; i < 30 * 300; i++) {
      stepAlerts(a, DT, false, shown);
      rose ||= alertLevel(a) > prev;
      prev = alertLevel(a);
    }
    expect(rose).toBe(false);
    expect(prev).toBe(0);
    expect(a.phase).toBe(0);
  });
});

describe("hacker den", () => {
  it("keeps the existing screens in place when the count changes", () => {
    const den = createDen(1);
    stepDen(den, DT, 0.5, 5, true);
    const before = den.screens.slice();
    expect(Array.from(den.life)).toEqual([0, 1, 1, 1, 1, 1, 0]);
    for (let i = 0; i < 60; i++) {
      stepDen(den, DT, 0.5, 7, true);
    }
    expect(den.screens).toEqual(before);
    expect(Array.from(den.life)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    // Fading out, the other screens stay fully shown.
    stepDen(den, 0.2, 0.5, 6, true);
    expect(den.life[0]).toBeGreaterThan(0);
    expect(den.life[0]).toBeLessThan(1);
    expect(Array.from(den.life.slice(1))).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("fades an added screen in rather than popping it", () => {
    const den = createDen(1);
    stepDen(den, DT, 0.5, 6, true);
    let prev = den.life[0];
    let step = 0;
    for (let i = 0; i < 40; i++) {
      stepDen(den, DT, 0.5, 7, true);
      step = Math.max(step, den.life[0] - prev);
      prev = den.life[0];
    }
    expect(prev).toBe(1);
    expect(step).toBeLessThanOrEqual(DT + 1e-6);
  });

  it.each([
    [4, 5],
    [6.4, 6],
    [9, 7],
    [Number.NaN, 6],
  ])("reads screens %s as %i", (raw, count) => {
    expect(screenCount(raw)).toBe(count);
  });

  it("starts with every screen marked for drawing", () => {
    const den = createDen(3);
    const dirty = den.screens.flatMap((s) =>
      s.kind === "terminal" || s.kind === "code" ? [s.dirty] : [],
    );
    expect(dirty).toEqual([DIRTY_ALL, DIRTY_ALL]);
  });
});
