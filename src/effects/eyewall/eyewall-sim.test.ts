import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import {
  advanceEvents,
  BLINK_GAP_MAX,
  BLINK_GAP_MIN,
  BLINK_TOTAL,
  blinkClosure,
  clearingOval,
  createLayout,
  createWall,
  densityCount,
  EVENT_ALL,
  EVENT_LOOK,
  EVENT_NONE,
  EVENT_WAVE,
  eyeClosure,
  eyePupil,
  gazeTarget,
  inFrame,
  IRIS_TRAVEL_X,
  layOut,
  MAX_EYES,
  MAX_PUPIL_SPEED,
  MIN_EVENT_GAP,
  MIN_LAG,
  openEyeShare,
  SOCKET_ASPECT,
  startEvent,
  stepWall,
  type Wall,
  type WallParams,
} from "./eyewall-sim";

const SEEDS = [0, 1, 2, 7, 42, 123, 500, 999];
const DT = 1 / 30;
const WIDE = 16 / 18;

const params = (over: Partial<WallParams> = {}): WallParams => ({
  density: 0.75,
  clearing: 0.5,
  blink: 0.5,
  events: 0.4,
  seed: 1,
  halfWidth: WIDE,
  ...over,
});

function run(wall: Wall, seconds: number, p: WallParams, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    stepWall(wall, DT, p);
    each?.();
  }
}

describe("layout", () => {
  it.each(SEEDS)("never overlaps two sockets (seed %d)", (seed) => {
    const l = createLayout();
    layOut(l, seed);
    expect(l.count).toBeGreaterThan(300);
    expect(l.count).toBeLessThan(MAX_EYES);
    for (let i = 0; i < l.count; i++) {
      for (let j = 0; j < i; j++) {
        const d = Math.hypot(l.x[i] - l.x[j], (l.y[i] - l.y[j]) / SOCKET_ASPECT);
        expect(d).toBeGreaterThan(l.r[i] + l.r[j]);
      }
    }
  });

  it.each(SEEDS)("is the same every time for a seed (seed %d)", (seed) => {
    const a = createLayout();
    const b = createLayout();
    layOut(a, seed);
    layOut(b, seed);
    expect(a.count).toBe(b.count);
    expect(a.x).toEqual(b.x);
    expect(a.r).toEqual(b.r);
  });

  it("packs a 16:9 frame with eyes of several sizes, bigger ones nearer the middle", () => {
    const l = createLayout();
    layOut(l, 3);
    const sizes = new Set<number>();
    let near = 0;
    let nearN = 0;
    let far = 0;
    let farN = 0;
    for (let i = 0; i < l.count; i++) {
      if (!inFrame(l.x[i], l.y[i], l.r[i], WIDE)) {
        continue;
      }
      sizes.add(Math.floor(l.r[i] / 0.02));
      if (Math.abs(l.x[i]) < 0.6) {
        near += l.r[i];
        nearN++;
      } else {
        far += l.r[i];
        farN++;
      }
    }
    expect(sizes.size).toBeGreaterThanOrEqual(3);
    expect(near / nearN).toBeGreaterThan((far / farN) * 1.1);
  });

  it("shows a prefix of the layout that grows with density", () => {
    let last = 0;
    for (let d = 0; d <= 1; d += 0.05) {
      const n = densityCount(500, d);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
    expect(densityCount(500, 1)).toBe(500);
    expect(densityCount(500, 0)).toBeGreaterThan(0);
  });

  it.each(SEEDS)("keeps every eye in place when density rises (seed %d)", (seed) => {
    const wall = createWall(seed);
    const low = params({ seed, density: 0.3 });
    run(wall, 4, low);
    const shown: number[] = [];
    const xs: number[] = [];
    for (let i = 0; i < wall.layout.count; i++) {
      if (wall.life[i] === 1) {
        shown.push(i);
        xs.push(wall.layout.x[i]);
      }
    }
    expect(shown.length).toBeGreaterThan(20);
    let added = 0;
    run(wall, 4, { ...low, density: 0.9 }, () => {
      for (const i of shown) {
        expect(wall.life[i]).toBe(1);
      }
    });
    shown.forEach((i, k) => {
      expect(wall.layout.x[i]).toBe(xs[k]);
    });
    for (let i = 0; i < wall.layout.count; i++) {
      added += wall.life[i] === 1 && !shown.includes(i) ? 1 : 0;
    }
    expect(added).toBeGreaterThan(20);
  });
});

describe("clearing", () => {
  const cases = SEEDS.flatMap((seed) =>
    [0.25, 0.5, 1].flatMap((clearing) => [WIDE, 0.5, 1.2].map((hw) => [seed, clearing, hw])),
  );

  it.each(cases)(
    "keeps every eye out of the oval (seed %d, clearing %d, half-width %d)",
    (seed, clearing, hw) => {
      const wall = createWall(seed);
      const p = params({ seed, clearing, halfWidth: hw, density: 1 });
      run(wall, 3, p);
      const c = clearingOval(clearing, hw, { cx: 0, cy: 0, rx: 0, ry: 0 });
      let visible = 0;
      for (let i = 0; i < wall.layout.count; i++) {
        if (wall.life[i] === 0) {
          continue;
        }
        visible++;
        const { x, y, r } = { x: wall.layout.x[i], y: wall.layout.y[i], r: wall.layout.r[i] };
        for (let k = 0; k < 64; k++) {
          const a = (k / 64) * 2 * Math.PI;
          const px = x + r * Math.cos(a);
          const py = y + SOCKET_ASPECT * r * Math.sin(a);
          expect(((px - c.cx) / c.rx) ** 2 + ((py - c.cy) / c.ry) ** 2).toBeGreaterThanOrEqual(1);
        }
      }
      expect(visible).toBeGreaterThan(10);
    },
  );

  it("is empty at 0, and grows with the amount", () => {
    const c = { cx: 0, cy: 0, rx: 0, ry: 0 };
    expect(clearingOval(0, WIDE, c).rx).toBe(0);
    const half = clearingOval(0.5, WIDE, c).rx;
    expect(clearingOval(1, WIDE, c).rx).toBeGreaterThan(half);
    // Wide enough at the default to free the speaker's head and shoulders.
    expect(half).toBeGreaterThan(0.25);
  });
});

describe("gaze", () => {
  it.each([0.28, WIDE, 1.2])("drifts inside the middle third (half-width %d)", (hw) => {
    const out = { x: 0, y: 0 };
    let lastX = Number.NaN;
    let maxStep = 0;
    for (let t = 0; t < 600; t += DT) {
      gazeTarget(5, t, hw, out);
      expect(Math.abs(out.x)).toBeLessThanOrEqual(hw / 3);
      expect(Math.abs(out.y)).toBeLessThanOrEqual(1 / 6);
      if (!Number.isNaN(lastX)) {
        maxStep = Math.max(maxStep, Math.abs(out.x - lastX));
      }
      lastX = out.x;
    }
    // Slow: a couple of pixels a frame at 1080p30 at most, before the eyes' lag.
    expect(maxStep * 1080).toBeLessThan(3);
  });

  it.each(SEEDS)("keeps every pupil inside its travel, and moving slowly (seed %d)", (seed) => {
    const wall = createWall(seed);
    const p = params({ seed, density: 1, clearing: 0, events: 1, halfWidth: 1.4 });
    const prevX = new Float32Array(MAX_EYES);
    const prevY = new Float32Array(MAX_EYES);
    let worst = 0;
    let furthest = 0;
    let looked = false;
    run(wall, 3, p);
    prevX.set(wall.px);
    prevY.set(wall.py);
    startEvent(wall.events, EVENT_LOOK);
    run(wall, 40, p, () => {
      looked ||= wall.events.kind === EVENT_LOOK;
      for (let i = 0; i < wall.layout.count; i++) {
        furthest = Math.max(furthest, Math.hypot(wall.px[i], wall.py[i]));
        worst = Math.max(worst, Math.hypot(wall.px[i] - prevX[i], wall.py[i] - prevY[i]));
        prevX[i] = wall.px[i];
        prevY[i] = wall.py[i];
      }
    });
    expect(looked).toBe(true);
    expect(furthest).toBeLessThanOrEqual(1 + 1e-6);
    expect(furthest).toBeGreaterThan(0.8);
    expect(worst).toBeLessThanOrEqual(MAX_PUPIL_SPEED * DT + 1e-6);
    // A travel unit is under 0.05 frame heights on the largest eye, so a
    // pupil's dark disc moves a few pixels a frame at most at 1080p30.
    const largest = Math.max(...wall.layout.r);
    const unitTravel = largest * IRIS_TRAVEL_X;
    expect(unitTravel).toBeLessThan(0.05);
    expect(pxPerReferenceFrame(MAX_PUPIL_SPEED * unitTravel)).toBeLessThan(
      MAX_FEATURE_PX_PER_FRAME / 3,
    );
  });

  it("lags the target by at least a few tenths of a second", () => {
    const wall = createWall(2);
    const p = params({ seed: 2, events: 0 });
    run(wall, 5, p);
    // A sudden look: after one lag time constant an eye is still well short.
    startEvent(wall.events, EVENT_LOOK);
    wall.events.lookIn = 0.001;
    const i = wall.life.indexOf(1);
    const start = Math.hypot(wall.px[i], wall.py[i]);
    run(wall, MIN_LAG, { ...p, events: 0 });
    expect(Math.hypot(wall.px[i], wall.py[i])).toBeGreaterThan(start * 0.2);
  });

  it("turns every eye to look straight out, dilated, then back", () => {
    const wall = createWall(4);
    const p = params({ seed: 4, events: 0 });
    run(wall, 5, p);
    const i = wall.life.findIndex((l, k) => l === 1 && Math.abs(wall.layout.x[k]) > 0.6);
    const before = Math.hypot(wall.px[i], wall.py[i]);
    const pupil = eyePupil(wall, i);
    expect(before).toBeGreaterThan(0.3);
    startEvent(wall.events, EVENT_LOOK);
    run(wall, wall.events.lookIn + 2.5, p);
    expect(Math.hypot(wall.px[i], wall.py[i])).toBeLessThan(0.02);
    expect(eyePupil(wall, i)).toBeGreaterThan(pupil * 1.2);
    run(wall, 12, p);
    expect(wall.events.kind).toBe(EVENT_NONE);
    expect(Math.hypot(wall.px[i], wall.py[i])).toBeGreaterThan(0.3);
  });
});

describe("blinks", () => {
  it("close fast, hold, and open more slowly", () => {
    expect(blinkClosure(0)).toBe(0);
    expect(blinkClosure(0.14)).toBe(1);
    expect(blinkClosure(BLINK_TOTAL)).toBe(0);
    expect(blinkClosure(0.06)).toBeCloseTo(0.5, 5);
    expect(blinkClosure(0.27)).toBeCloseTo(0.5, 5);
  });

  it("are the same every run for a variation", () => {
    const record = () => {
      const wall = createWall(9);
      const out: number[] = [];
      run(wall, 40, params({ seed: 9, events: 1 }), () => {
        for (let i = 0; i < wall.layout.count; i += 7) {
          out.push(eyeClosure(wall, i));
        }
      });
      return out;
    };
    expect(record()).toEqual(record());
  });

  it("latch each gap: a rate change doesn't redraw the gap under way", () => {
    const wall = createWall(3);
    const p = params({ seed: 3, events: 0 });
    run(wall, 2, p);
    const due = Float32Array.from(wall.due);
    const blinks = Uint32Array.from(wall.blinks);
    stepWall(wall, DT, { ...p, blink: 1 });
    const redrawn: number[] = [];
    for (let i = 0; i < wall.layout.count; i++) {
      if (wall.blinks[i] === blinks[i] && wall.due[i] !== due[i]) {
        redrawn.push(i);
      }
    }
    expect(redrawn).toEqual([]);
  });

  it.each(SEEDS)(
    "come every 30 to 120 s at the default rate, sometimes in pairs (seed %d)",
    (seed) => {
      const wall = createWall(seed);
      const p = params({ seed, events: 0 });
      const n = wall.layout.count;
      // When each eye's last blink (or pair) ended; NaN before the first.
      const ended = new Float64Array(n).fill(Number.NaN);
      const was = new Uint8Array(n);
      const count = Uint32Array.from(wall.blinks);
      let time = 0;
      let gaps = 0;
      let pairs = 0;
      let shortest = Number.POSITIVE_INFINITY;
      let longest = 0;
      run(wall, 900, p, () => {
        time += DT;
        for (let i = 0; i < n; i++) {
          if (wall.blinks[i] !== count[i]) {
            count[i] = wall.blinks[i];
            if (!Number.isNaN(ended[i])) {
              const gap = time - ended[i];
              gaps++;
              shortest = Math.min(shortest, gap);
              longest = Math.max(longest, gap);
            }
          }
          if (wall.blinking[i] === 1 && wall.blinkT[i] < 0 && wall.blinkT[i] > -2 * DT) {
            pairs++;
          }
          if (was[i] === 1 && wall.blinking[i] === 0) {
            ended[i] = time;
          }
          was[i] = wall.blinking[i];
        }
      });
      expect(shortest).toBeGreaterThanOrEqual(BLINK_GAP_MIN - 2 * DT);
      expect(longest).toBeLessThanOrEqual(BLINK_GAP_MAX + 2 * DT);
      expect(gaps).toBeGreaterThan(200);
      expect(pairs).toBeGreaterThan(10);
    },
  );

  it("stop at a blink rate of 0", () => {
    const wall = createWall(1);
    run(wall, 60, params({ blink: 0, events: 0 }), () => {
      expect(wall.blinking.every((b) => b === 0)).toBe(true);
    });
  });
});

describe("events", () => {
  it.each(SEEDS)("leave at least the minimum gap and never overlap (seed %d)", (seed) => {
    const wall = createWall(seed);
    const ev = wall.events;
    const spans: [number, number][] = [];
    let time = 0;
    let kind = EVENT_NONE;
    let overlaps = 0;
    for (let i = 0; i < 30 * 1200; i++) {
      time += DT;
      advanceEvents(ev, DT, 1);
      if (ev.kind !== kind) {
        if (ev.kind !== EVENT_NONE) {
          // Only ever from none to an event, never from one event to another.
          overlaps += kind === EVENT_NONE ? 0 : 1;
          spans.push([time, time]);
        } else {
          spans[spans.length - 1][1] = time;
        }
        kind = ev.kind;
      }
    }
    expect(overlaps).toBe(0);
    expect(spans.length).toBeGreaterThan(20);
    for (let k = 1; k < spans.length; k++) {
      expect(spans[k][0] - spans[k - 1][1]).toBeGreaterThanOrEqual(MIN_EVENT_GAP - DT);
    }
  });

  it("plays all three kinds", () => {
    const ev = createWall(5).events;
    const seen = new Set<number>();
    for (let i = 0; i < 30 * 1200; i++) {
      advanceEvents(ev, DT, 1);
      seen.add(ev.kind);
    }
    expect([...seen].toSorted((a, b) => a - b)).toEqual([
      EVENT_NONE,
      EVENT_WAVE,
      EVENT_ALL,
      EVENT_LOOK,
    ]);
  });

  it("never start at 0", () => {
    const ev = createWall(5).events;
    for (let i = 0; i < 30 * 600; i++) {
      advanceEvents(ev, DT, 0);
      expect(ev.kind).toBe(EVENT_NONE);
    }
  });

  it.each([EVENT_ALL, EVENT_WAVE])(
    "blink every shown eye once in a synchronised blink (kind %d)",
    (kind) => {
      const wall = createWall(6);
      const p = params({ seed: 6, blink: 0, events: 0 });
      run(wall, 3, p);
      const before = Uint32Array.from(wall.blinks);
      startEvent(wall.events, kind);
      run(wall, 3, p);
      let shown = 0;
      const wrong: number[] = [];
      for (let i = 0; i < wall.layout.count; i++) {
        if (wall.life[i] === 1) {
          shown++;
          if (wall.blinks[i] - before[i] !== 1) {
            wrong.push(i);
          }
        }
      }
      expect(wrong).toEqual([]);
      expect(shown).toBeGreaterThan(50);
    },
  );
});

describe("brightness", () => {
  /**
   * The most an open eye's sclera and iris can differ from the shut lid over
   * it, as a share of full brightness: the sclera is a dimmed off-white and the
   * lids are the surface's colour, lit.
   */
  const EYE_CONTRAST = 0.6;
  const CAP = 0.03;

  const worstStep = (wall: Wall, p: WallParams, seconds: number) => {
    let last = openEyeShare(wall, p.halfWidth);
    let worst = 0;
    run(wall, seconds, p, () => {
      const share = openEyeShare(wall, p.halfWidth);
      worst = Math.max(worst, Math.abs(share - last) * EYE_CONTRAST);
      last = share;
    });
    return worst;
  };

  it.each(SEEDS)(
    "an all-at-once blink changes the frame's mean by a few percent a frame at most (seed %d)",
    (seed) => {
      const wall = createWall(seed);
      const p = params({ seed, density: 1, clearing: 0, blink: 0, events: 0 });
      run(wall, 3, p);
      const open = openEyeShare(wall, WIDE);
      // The eyes carry a fair share of the frame, so the test bites.
      expect(open * EYE_CONTRAST).toBeGreaterThan(0.1);
      startEvent(wall.events, EVENT_ALL);
      expect(worstStep(wall, p, 1)).toBeLessThan(CAP);
    },
  );

  it.each(SEEDS)("so does a wave blink, and eyes appearing (seed %d)", (seed) => {
    const wall = createWall(seed);
    const p = params({ seed, density: 1, clearing: 0, blink: 1, events: 0 });
    expect(worstStep(wall, p, 3)).toBeLessThan(CAP);
    startEvent(wall.events, EVENT_WAVE);
    expect(worstStep(wall, p, 3)).toBeLessThan(CAP);
  });
});

describe("variation change", () => {
  it("closes the old wall, then opens a new one", () => {
    const wall = createWall(1);
    run(wall, 3, params({ seed: 1 }));
    const oldX = wall.layout.x[0];
    run(wall, 0.5, params({ seed: 2 }));
    expect(wall.layout.seed).toBe(1);
    run(wall, 1.5, params({ seed: 2 }));
    expect(wall.layout.seed).toBe(2);
    expect(wall.layout.x[0]).not.toBe(oldX);
    run(wall, 2, params({ seed: 2 }));
    expect(wall.life.some((l) => l === 1)).toBe(true);
  });
});
