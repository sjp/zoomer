import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import {
  advanceTape,
  BAND_HALF,
  BAND_MIX,
  bandCentre,
  bandProfile,
  BAND_SPEED,
  BURST_MAX,
  BURST_MIN,
  COVER_HOLD,
  COVER_MIX,
  COVER_RAMP,
  coverLevel,
  createTape,
  DEPTHS,
  feetY,
  FIGURE_HALF_WIDTH,
  FIGURE_HEIGHT,
  figureX,
  FIRST_GAP,
  GAP_SPREAD,
  GRAIN_HZ,
  HALL_HALF_WIDTH,
  hallFlipped,
  hallVanishX,
  HORIZON,
  jitterAt,
  JITTER_HZ,
  JITTER_PX,
  MAX_MEAN_STEP,
  NEAR,
  placeParam,
  requestBurst,
  reseedTape,
  SPLIT,
  stampStart,
  STATIC_GAIN,
  STATIC_LIFT,
  STATIC_NOISE,
  stationDepth,
  STATIONS,
  type Tape,
  troubleLevel,
  WOBBLE_AMP,
  WOBBLE_HZ,
  WOBBLE_WAVES,
  INTERVAL_MAX,
  INTERVAL_MIN,
  type Place,
} from "./staticfigure-sim";
import { staticfigureMeta } from "./staticfigure.meta";

const SEEDS = [0, 1, 7, 42, 999];
const PLACES: readonly Place[] = ["field", "carpark", "hallway"];
const ASPECTS = [9 / 16, 3 / 4, 1, 4 / 3, 16 / 9, 21 / 9];
const DT = 1 / 30;

/** Runs `tape` at `dt` until `bursts` more bursts have finished, calling `each` per step. */
function run(
  tape: Tape,
  bursts: number,
  each: (swapped: boolean) => void = () => {},
  interval = INTERVAL_MIN,
  presence = 1,
  dt = DT,
) {
  const end = tape.bursts + bursts;
  let guard = 0;
  while ((tape.bursts < end || tape.at >= 0) && guard++ < 1e7) {
    each(advanceTape(tape, dt, interval, presence));
  }
}

/** The times bursts start over `bursts` bursts. */
function burstStarts(seed: number, bursts: number, interval = 45): number[] {
  const tape = createTape(seed);
  const starts: number[] = [];
  let was = 0;
  run(
    tape,
    bursts,
    () => {
      if (tape.bursts !== was) {
        was = tape.bursts;
        starts.push(Math.round((tape.time - tape.at) * 1000) / 1000);
      }
    },
    interval,
  );
  return starts;
}

describe("burst schedule", () => {
  it("has the interval slider's range", () => {
    expect(staticfigureMeta.params.interval.min).toBe(INTERVAL_MIN);
    expect(staticfigureMeta.params.interval.max).toBe(INTERVAL_MAX);
  });

  it.each(SEEDS)("is the same for the same seed (seed %d)", (seed) => {
    expect(burstStarts(seed, 8)).toEqual(burstStarts(seed, 8));
  });

  it("differs between seeds", () => {
    expect(burstStarts(1, 4)).not.toEqual(burstStarts(2, 4));
  });

  it.each(SEEDS)("starts the first burst after 8-16 s (seed %d)", (seed) => {
    const [first] = burstStarts(seed, 1);
    expect(first).toBeGreaterThanOrEqual(FIRST_GAP[0] - DT);
    expect(first).toBeLessThanOrEqual(FIRST_GAP[1] + DT);
  });

  it.each([INTERVAL_MIN, 45, INTERVAL_MAX])(
    "spaces bursts 0.5-1.5 times the interval apart, %d s on average",
    (interval) => {
      const tape = createTape(3);
      run(tape, 1, undefined, interval);
      const gaps: number[] = [];
      for (let i = 0; i < 60; i++) {
        gaps.push(tape.wait);
        run(tape, 1, undefined, interval);
      }
      for (const g of gaps) {
        expect(g).toBeGreaterThanOrEqual(interval * GAP_SPREAD[0]);
        expect(g).toBeLessThanOrEqual(interval * GAP_SPREAD[1]);
      }
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      expect(mean).toBeGreaterThan(interval * 0.85);
      expect(mean).toBeLessThan(interval * 1.15);
    },
  );

  it("latches the interval for the gap under way", () => {
    const tape = createTape(5);
    run(tape, 1, undefined, INTERVAL_MIN);
    const wait = tape.wait;
    // A new interval mid-gap leaves this gap alone...
    advanceTape(tape, 1, INTERVAL_MAX, 1);
    expect(tape.wait).toBeCloseTo(wait - 1, 9);
    expect(wait).toBeLessThanOrEqual(INTERVAL_MIN * GAP_SPREAD[1]);
    // ...and sets the next.
    run(tape, 1, undefined, INTERVAL_MAX);
    expect(tape.wait).toBeGreaterThanOrEqual(INTERVAL_MAX * GAP_SPREAD[0]);
  });

  it("clamps the interval to its range", () => {
    const tape = createTape(5);
    run(tape, 1, undefined, 1);
    expect(tape.wait).toBeGreaterThanOrEqual(INTERVAL_MIN * GAP_SPREAD[0]);
    run(tape, 1, undefined, 1e6);
    expect(tape.wait).toBeLessThanOrEqual(INTERVAL_MAX * GAP_SPREAD[1]);
    run(tape, 1, undefined, Number.NaN);
    expect(Number.isFinite(tape.wait)).toBe(true);
  });

  it.each(SEEDS)("plays bursts of 0.5-1.5 s, each with one swap (seed %d)", (seed) => {
    const tape = createTape(seed);
    for (let i = 0; i < 20; i++) {
      let swaps = 0;
      let length = 0;
      run(tape, 1, (swapped) => {
        if (tape.at >= 0) {
          length = tape.duration;
        }
        swaps += swapped ? 1 : 0;
      });
      expect(swaps).toBe(1);
      expect(length).toBeGreaterThanOrEqual(BURST_MIN);
      expect(length).toBeLessThanOrEqual(BURST_MAX);
    }
  });

  it("starts a requested burst at once while idle", () => {
    const tape = createTape(1);
    advanceTape(tape, DT, 45, 1);
    requestBurst(tape);
    advanceTape(tape, DT, 45, 1);
    expect(tape.at).toBe(0);
    expect(tape.bursts).toBe(1);
  });

  it("lets the burst under way serve a request made before its swap, and queues one after", () => {
    const tape = createTape(1);
    requestBurst(tape);
    advanceTape(tape, DT, 45, 1);
    requestBurst(tape);
    expect(tape.forced).toBe(false);
    run(tape, 0, () => {
      if (tape.swapped && tape.at >= 0 && !tape.forced) {
        requestBurst(tape);
      }
    });
    expect(tape.forced).toBe(true);
    advanceTape(tape, DT, 45, 1);
    expect(tape.bursts).toBe(2);
    expect(tape.at).toBe(0);
  });
});

describe("burst envelope", () => {
  it.each(SEEDS)("fits the heavy static inside every burst (seed %d)", (seed) => {
    expect(2 * COVER_RAMP + COVER_HOLD).toBeLessThanOrEqual(BURST_MIN);
    const tape = createTape(seed);
    let idle = 0;
    run(tape, 10, () => {
      idle = Math.max(idle, tape.at < 0 ? coverLevel(tape) + troubleLevel(tape) : 0);
    });
    expect(idle).toBe(0);
  });

  it("starts and ends each burst at nothing", () => {
    const tape = createTape(2);
    run(tape, 0);
    advanceTape(tape, 0, 45, 1);
    requestBurst(tape);
    advanceTape(tape, 0, 45, 1);
    expect(tape.at).toBe(0);
    expect(troubleLevel(tape)).toBe(0);
    expect(coverLevel(tape)).toBe(0);
    tape.at = tape.duration / 2;
    expect(troubleLevel(tape)).toBe(1);
    expect(coverLevel(tape)).toBe(1);
    tape.at = tape.duration;
    expect(troubleLevel(tape)).toBeCloseTo(0, 9);
    expect(coverLevel(tape)).toBeCloseTo(0, 9);
  });

  it.each(SEEDS)("swaps only under full static (seed %d)", (seed) => {
    const tape = createTape(seed);
    const covers: number[] = [];
    run(tape, 20, (swapped) => {
      if (swapped) {
        covers.push(coverLevel(tape));
      }
    });
    expect(covers).toEqual(Array.from({ length: 20 }, () => 1));
  });

  it.each(SEEDS)("keeps the frame's mean change under the cap at 30 fps (seed %d)", (seed) => {
    // The frame's mean of the static's mix (see the tape pass): the heavy static
    // covers the whole frame, the band only its rows, the two combined as
    // 1 - (1 - a)(1 - b). Static's mean is the picture's plus STATIC_LIFT, so
    // the mean moves by STATIC_LIFT times the mix's mean.
    const rows = 270;
    const meanMix = (t: Tape) => {
      const a = COVER_MIX * coverLevel(t);
      const b = BAND_MIX * troubleLevel(t);
      const centre = bandCentre(t);
      let band = 0;
      for (let j = 0; j < rows; j++) {
        band += bandProfile((j + 0.5) / rows, centre);
      }
      return a + b * (band / rows) * (1 - a);
    };
    // The figure swaps under at least COVER_MIX of static: its box at the
    // narrowest frame, from black to the brightest the scenes get.
    const figure = (2 * FIGURE_HALF_WIDTH * FIGURE_HEIGHT[NEAR] ** 2) / (9 / 16);
    const swapStep = figure * 0.8 * (1 - COVER_MIX);
    const tape = createTape(seed);
    let prev = 0;
    let worst = 0;
    run(tape, 12, (swapped) => {
      const m = STATIC_LIFT * meanMix(tape);
      worst = Math.max(worst, Math.abs(m - prev) + (swapped ? swapStep : 0));
      prev = m;
    });
    expect(worst).toBeLessThan(MAX_MEAN_STEP);
    expect(worst).toBeGreaterThan(0.005);
  });

  it("keeps the static's noise above black and its mean at the lift", () => {
    // Darkest static: blurred picture 0, lift minus half the noise's swing.
    expect(STATIC_LIFT - STATIC_NOISE / 2).toBeGreaterThanOrEqual(0);
    expect(STATIC_GAIN).toBeLessThanOrEqual(2);
  });

  it.each([
    [INTERVAL_MIN, 0],
    [INTERVAL_MAX, 1],
  ])("rolls the band under the feature-speed limit (interval %d, presence %d)", (interval, p) => {
    expect(pxPerReferenceFrame(BAND_SPEED)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    const tape = createTape(4);
    let prev = Number.NaN;
    let fastest = 0;
    let rose = 0;
    run(
      tape,
      6,
      () => {
        if (tape.at < 0) {
          prev = Number.NaN;
          return;
        }
        const c = bandCentre(tape);
        if (!Number.isNaN(prev)) {
          fastest = Math.max(fastest, Math.abs(c - prev) * 1080);
          rose = Math.max(rose, c - prev);
        }
        prev = c;
      },
      interval,
      p,
    );
    expect(fastest).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    expect(rose).toBeGreaterThan(0);
  });

  it("keeps the band within the frame's height while it plays", () => {
    const tape = createTape(8);
    let low = Infinity;
    let high = -Infinity;
    run(tape, 20, () => {
      if (tape.at >= 0) {
        low = Math.min(low, bandCentre(tape));
        high = Math.max(high, bandCentre(tape));
      }
    });
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThan(1 + BAND_HALF);
  });

  it("keeps the tracking wobble and colour split slow and small", () => {
    // Rows swing sideways at most this fast, frame heights a second.
    expect(pxPerReferenceFrame(WOBBLE_AMP * 2 * Math.PI * WOBBLE_HZ)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
    // The wobble's waves pass a row at WOBBLE_HZ.
    expect(WOBBLE_HZ).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    expect(WOBBLE_WAVES).toBeGreaterThan(0);
    expect(SPLIT * 1080).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });
});

describe("the figure's walk", () => {
  it.each(SEEDS)("changes station only at a burst's swap (seed %d)", (seed) => {
    const tape = createTape(seed);
    let station = tape.station;
    let changes = 0;
    let outside = 0;
    run(tape, 40, (swapped) => {
      if (tape.station !== station) {
        changes++;
        outside += swapped && tape.at >= 0 ? 0 : 1;
      }
      station = tape.station;
    });
    expect(changes).toBeGreaterThan(5);
    expect(outside).toBe(0);
  });

  it.each(SEEDS.flatMap((s) => [0.25, 0.5, 1].map((p) => [s, p] as const)))(
    "never comes more than a step nearer a burst (seed %d, presence %d)",
    (seed, presence) => {
      const tape = createTape(seed);
      let depth = -1;
      let leaps = 0;
      const seen = new Set<number>();
      run(
        tape,
        200,
        (swapped) => {
          if (!swapped) {
            return;
          }
          const d = stationDepth(tape.station);
          leaps += d > depth + 1 ? 1 : 0;
          seen.add(d);
          depth = d;
        },
        INTERVAL_MIN,
        presence,
        0.25,
      );
      expect(leaps).toBe(0);
      // Over 200 bursts it comes, and unless it's rarely there, reaches every depth.
      expect(seen.has(0)).toBe(true);
      expect(seen.has(NEAR) || presence < 0.5).toBe(true);
    },
  );

  it("moves to another station when it stays at a depth", () => {
    const tape = createTape(11);
    let prev = -1;
    let stays = 0;
    let stuck = 0;
    run(
      tape,
      200,
      (swapped) => {
        if (!swapped) {
          return;
        }
        if (prev >= 0 && stationDepth(prev) === stationDepth(tape.station)) {
          stays++;
          stuck += tape.station === prev ? 1 : 0;
        }
        prev = tape.station;
      },
      INTERVAL_MIN,
      1,
      0.25,
    );
    expect(stays).toBeGreaterThan(0);
    expect(stuck).toBe(0);
  });

  it.each(SEEDS)("never appears with presence 0 (seed %d)", (seed) => {
    const tape = createTape(seed);
    let shown = 0;
    run(
      tape,
      200,
      () => {
        shown += tape.station >= 0 ? 1 : 0;
      },
      INTERVAL_MIN,
      0,
      0.25,
    );
    expect(shown).toBe(0);
  });

  it("is there after more bursts the higher the presence", () => {
    const share = (presence: number) => {
      const tape = createTape(6);
      let there = 0;
      run(
        tape,
        400,
        (swapped) => {
          there += swapped && tape.station >= 0 ? 1 : 0;
        },
        INTERVAL_MIN,
        presence,
        0.25,
      );
      return there / 400;
    };
    expect(share(0.2)).toBeLessThan(share(0.5));
    expect(share(0.5)).toBeLessThan(share(1));
    expect(share(1)).toBeGreaterThan(0.7);
  });

  it("starts gone, and a new variation leaves it gone", () => {
    const tape = createTape(3);
    expect(tape.station).toBe(-1);
    run(tape, 30, undefined, INTERVAL_MIN, 1, 0.25);
    reseedTape(tape, 4);
    expect(tape.station).toBe(-1);
  });

  it.each(SEEDS)("lays out stations on both sides at every depth (seed %d)", (seed) => {
    const tape = createTape(seed);
    expect(tape.side.length).toBe(STATIONS);
    for (let d = 0; d < DEPTHS; d++) {
      const stations = Array.from({ length: STATIONS }, (_, i) => i).filter(
        (i) => stationDepth(i) === d,
      );
      expect(new Set(stations.map((i) => tape.side[i]))).toEqual(new Set([-1, 1]));
    }
    for (let i = 0; i < STATIONS; i++) {
      expect(tape.u[i]).toBeGreaterThanOrEqual(0);
      expect(tape.u[i]).toBeLessThan(1);
      expect(Math.abs(tape.tilt[i])).toBeGreaterThan(0.05);
      expect(Math.abs(tape.tilt[i])).toBeLessThan(0.25);
    }
  });
});

describe("the figure's place", () => {
  const cases = PLACES.flatMap((place) =>
    ASPECTS.flatMap((aspect) => [false, true].map((flip) => [place, aspect, flip] as const)),
  );

  it.each(cases)(
    "stands in an outer third, inside the frame (%s, aspect %d, flipped %s)",
    (place, aspect, flip) => {
      for (let depth = 0; depth < DEPTHS; depth++) {
        const hw = FIGURE_HEIGHT[depth] * FIGURE_HALF_WIDTH;
        for (const side of [-1, 1]) {
          for (let k = 0; k <= 10; k++) {
            const x = figureX(place, depth, side, k / 10, aspect, flip);
            expect(Number.isFinite(x)).toBe(true);
            expect(Math.abs(x) - hw).toBeGreaterThanOrEqual(aspect / 6);
            expect(Math.abs(x) + hw).toBeLessThanOrEqual(aspect / 2);
            // In the hallway on its floor; elsewhere on the side asked for.
            const floor = HALL_HALF_WIDTH * (HORIZON.hallway - feetY(place, depth));
            const onFloor = Math.abs(x - hallVanishX(aspect, flip)) <= floor;
            expect(place === "hallway" ? onFloor : Math.sign(x) === side).toBe(true);
          }
        }
      }
    },
  );

  it("is never more than about a third of the frame tall, and stands on the ground", () => {
    expect(Math.max(...FIGURE_HEIGHT)).toBeLessThanOrEqual(0.34);
    for (const place of PLACES) {
      for (let d = 0; d < DEPTHS; d++) {
        expect(feetY(place, d)).toBeLessThan(HORIZON[place]);
        expect(feetY(place, d)).toBeGreaterThan(-0.5);
        expect(feetY(place, d) + FIGURE_HEIGHT[d]).toBeLessThan(0.5);
        expect(feetY(place, d)).toBeLessThan(d > 0 ? feetY(place, d - 1) : HORIZON[place]);
      }
    }
  });

  it("has no room in frames far narrower than any screen", () => {
    expect(figureX("field", NEAR, 1, 0.5, 0.2, false)).toBeNaN();
  });

  it("flips the hallway for some variations and not others", () => {
    const flips = new Set(SEEDS.map((s) => hallFlipped(s)));
    expect(flips.size).toBe(2);
  });

  it("reads unknown places as the field", () => {
    expect(placeParam("carpark")).toBe("carpark");
    expect(placeParam("hallway")).toBe("hallway");
    expect(placeParam("moon")).toBe("field");
  });
});

describe("tape wear", () => {
  it("jitters by a step at most, never at no wear, more with more", () => {
    const count = (tape: number) => {
      let n = 0;
      for (let i = 0; i < 2000; i++) {
        const j = jitterAt(i / JITTER_HZ, 3, tape);
        expect([-1, 0, 1]).toContain(j);
        n += j === 0 ? 0 : 1;
      }
      return n;
    };
    expect(count(0)).toBe(0);
    expect(JITTER_PX).toBeLessThanOrEqual(2);
    expect(count(0.5)).toBeLessThan(count(1));
    expect(count(1)).toBeLessThan(1400);
    expect(JITTER_HZ).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    expect(GRAIN_HZ).toBeLessThanOrEqual(MAX_PATTERN_HZ);
  });

  it("holds the jitter through each step", () => {
    const a = jitterAt(10.01, 2, 1);
    expect(jitterAt(10.01 + 0.9 / (JITTER_HZ * 3), 2, 1)).toBe(a);
  });

  it.each(PLACES)("stamps the tape in the evening or night of a 1990s autumn (%s)", (place) => {
    for (const seed of SEEDS) {
      const d = new Date(stampStart(seed, place));
      expect(d.getFullYear()).toBeGreaterThanOrEqual(1991);
      expect(d.getFullYear()).toBeLessThanOrEqual(1999);
      expect(d.getMonth()).toBeGreaterThanOrEqual(8);
      expect(d.getMonth()).toBeLessThanOrEqual(10);
      expect(stampStart(seed, place)).toBe(stampStart(seed, place));
    }
  });
});
