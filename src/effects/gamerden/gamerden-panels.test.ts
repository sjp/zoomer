import { describe, expect, it } from "vitest";
import { fitScale } from "../scene-layout";
import {
  breatheColour,
  BREATHE_PERIOD,
  createPanelShow,
  createRipples,
  MAX_PANEL_RATE,
  MAX_RIPPLES,
  PALETTE_STOPS,
  type PaletteId,
  PANEL_CELLS,
  PANEL_COUNT,
  PANEL_HOPS,
  PANEL_NEIGHBOURS,
  PANEL_RADIUS,
  PANEL_SPACING,
  panelCentres,
  paletteStops,
  type PanelMode,
  RIPPLE_FADE,
  RIPPLE_GAP_MIN,
  RIPPLE_LIFE,
  RIPPLE_RISE,
  rippleEnvelope,
  rippleGap,
  samplePalette,
  staticColour,
  waveColour,
} from "./gamerden-panels";

const MODES: readonly PanelMode[] = ["wave", "breathe", "static", "reactive"];
const PALETTES: readonly PaletteId[] = ["rainbow", "synth", "ocean", "ember", "forest", "mono"];
const ACCENT = [0.6, 0.3, 1] as const;
const ASPECTS = [9 / 16, 3 / 4, 1, 4 / 3, 16 / 9, 2, 21 / 9, 32 / 9];

function stopsOf(palette: PaletteId): Float32Array {
  return paletteStops(palette, ACCENT, new Float32Array(3 * PALETTE_STOPS));
}

describe("the panel cluster", () => {
  it("has 8 to 14 panels on distinct cells", () => {
    expect(PANEL_COUNT).toBeGreaterThanOrEqual(8);
    expect(PANEL_COUNT).toBeLessThanOrEqual(14);
    expect(new Set(PANEL_CELLS.map(([q, r]) => `${String(q)},${String(r)}`)).size).toBe(
      PANEL_COUNT,
    );
  });

  it("is connected, every panel reaching every other through its neighbours", () => {
    expect(PANEL_HOPS.every((h) => h < 255)).toBe(true);
    for (let i = 0; i < PANEL_COUNT; i++) {
      expect(PANEL_NEIGHBOURS[i].length).toBeGreaterThan(0);
      for (const n of PANEL_NEIGHBOURS[i]) {
        expect(PANEL_NEIGHBOURS[n]).toContain(i);
      }
    }
  });

  it("is irregular: some panels have fewer neighbours than others", () => {
    const counts = PANEL_NEIGHBOURS.map((n) => n.length);
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });

  it.each(ASPECTS)("fits the upper outer third at aspect %f", (aspect) => {
    const k = fitScale(aspect);
    const centres = panelCentres(aspect, new Float32Array(2 * PANEL_COUNT));
    // A flat-topped hexagon's corners reach PANEL_RADIUS across and √3/2 of it up.
    const rx = PANEL_RADIUS;
    const ry = (PANEL_RADIUS * Math.sqrt(3)) / 2;
    for (let i = 0; i < PANEL_COUNT; i++) {
      // Frame units: frame heights from the centre.
      const x = centres[2 * i] * k;
      const y = centres[2 * i + 1] * k;
      expect(x - rx * k).toBeGreaterThanOrEqual(aspect / 6);
      expect(x + rx * k).toBeLessThanOrEqual(aspect / 2);
      expect(y - ry * k).toBeGreaterThanOrEqual(0);
      expect(y + ry * k).toBeLessThanOrEqual(0.5);
    }
  });

  it("keeps neighbours a cell apart and other panels further", () => {
    const c = panelCentres(16 / 9, new Float32Array(2 * PANEL_COUNT));
    for (let a = 0; a < PANEL_COUNT; a++) {
      for (let b = a + 1; b < PANEL_COUNT; b++) {
        const d = Math.hypot(c[2 * a] - c[2 * b], c[2 * a + 1] - c[2 * b + 1]);
        // Neighbours are exactly one cell apart (√3 spacings), everything else further.
        expect(d > PANEL_SPACING * Math.sqrt(3) + 1e-6).toBe(!PANEL_NEIGHBOURS[a].includes(b));
        expect(d).toBeGreaterThan(PANEL_SPACING * Math.sqrt(3) - 1e-6);
      }
    }
  });
});

describe("the palettes", () => {
  it.each(PALETTES)("%s stays in range", (palette) => {
    for (const v of stopsOf(palette)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("loop back to the first stop without a jump", () => {
    const stops = stopsOf("rainbow");
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    samplePalette(stops, 1 - 1e-6, a, 0);
    samplePalette(stops, 0, b, 0);
    for (let c = 0; c < 3; c++) {
      expect(a[c]).toBeCloseTo(b[c], 4);
    }
  });

  it("Mono follows the accent colour", () => {
    const stops = paletteStops("mono", [1, 0, 0], new Float32Array(3 * PALETTE_STOPS));
    expect(Array.from(stops.subarray(0, 3))).toEqual([1, 0, 0]);
    for (let s = 0; s < PALETTE_STOPS; s++) {
      expect(stops[3 * s]).toBeGreaterThan(stops[3 * s + 1]);
    }
  });
});

/** Largest change of any channel between two samples `dt` apart, over `seconds` of `colour(t, out)`. */
function largestStep(
  colour: (t: number, out: Float32Array) => void,
  seconds: number,
  dt: number,
): number {
  const a = new Float32Array(3);
  const b = new Float32Array(3);
  colour(0, a);
  let most = 0;
  for (let t = dt; t <= seconds; t += dt) {
    colour(t, b);
    for (let c = 0; c < 3; c++) {
      most = Math.max(most, Math.abs(b[c] - a[c]));
    }
    a.set(b);
  }
  return most;
}

describe("the mode colours", () => {
  const stops = stopsOf("synth");

  it.each([0, 4, 10])("Wave is continuous in time for panel %i", (i) => {
    // Phase in palette loops; a hundred loops in tiny steps.
    expect(
      largestStep(
        (t, out) => {
          waveColour(stops, i, t, out, 0);
        },
        100,
        1e-3,
      ),
    ).toBeLessThan(0.02);
  });

  it("Breathe is continuous in time and cycles no faster than every 6 s", () => {
    expect(
      largestStep(
        (t, out) => {
          breatheColour(stops, t, out, 0);
        },
        20,
        1e-3,
      ),
    ).toBeLessThan(0.02);
    expect(BREATHE_PERIOD).toBeGreaterThanOrEqual(6);
  });

  it("Static gives each panel its own steady colour", () => {
    const seen = new Set<string>();
    const out = new Float32Array(3);
    for (let i = 0; i < PANEL_COUNT; i++) {
      staticColour(stops, i, out, 0);
      seen.add(Array.from(out, (v) => v.toFixed(3)).join(","));
    }
    expect(seen.size).toBeGreaterThan(PANEL_COUNT / 2);
  });

  it("Reactive is continuous in time", () => {
    const ripples = createRipples();
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    let most = 0;
    for (let f = 0; f < 120 * 60; f++) {
      ripples.step(1 / 120, 1);
      ripples.colour(stops, 3, b, 0);
      if (f > 0) {
        for (let c = 0; c < 3; c++) {
          most = Math.max(most, Math.abs(b[c] - a[c]));
        }
      }
      a.set(b);
    }
    expect(ripples.count).toBeGreaterThan(10);
    expect(most).toBeLessThan(0.1);
  });
});

describe("the Reactive ripples", () => {
  it("rise over 0.3 s and fade over 1.5 s or more", () => {
    expect(RIPPLE_RISE).toBeGreaterThanOrEqual(0.3);
    expect(RIPPLE_FADE).toBeGreaterThanOrEqual(1.5);
    expect(rippleEnvelope(0)).toBe(0);
    expect(rippleEnvelope(RIPPLE_RISE)).toBeCloseTo(1, 9);
    expect(rippleEnvelope(RIPPLE_RISE + RIPPLE_FADE)).toBeCloseTo(0, 9);
    expect(rippleEnvelope(-1)).toBe(0);
    expect(rippleEnvelope(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("rise and fall smoothly, one way each", () => {
    let prev = 0;
    for (let t = 0.001; t < RIPPLE_RISE; t += 0.001) {
      const e = rippleEnvelope(t);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
    prev = rippleEnvelope(RIPPLE_RISE);
    for (let t = RIPPLE_RISE; t < RIPPLE_RISE + RIPPLE_FADE + 0.1; t += 0.001) {
      const e = rippleEnvelope(t);
      expect(e).toBeLessThanOrEqual(prev + 1e-12);
      prev = e;
    }
  });

  it("are finished before their slot is reused", () => {
    expect(MAX_RIPPLES * RIPPLE_GAP_MIN).toBeGreaterThan(RIPPLE_LIFE);
  });

  it.each([0.1, 0.4, 1])("leave calm gaps at speed %f", (speed) => {
    for (let n = 0; n < 200; n++) {
      expect(rippleGap(n, speed)).toBeGreaterThanOrEqual(RIPPLE_GAP_MIN);
    }
  });

  it("spread to the neighbours after the source", () => {
    const ripples = createRipples();
    const stops = stopsOf("synth");
    const out = new Float32Array(3);
    // Step to just after the first ripple has reached its source's neighbours.
    while (ripples.count === 0) {
      ripples.step(1 / 120, 1);
    }
    const level = (i: number) => {
      ripples.colour(stops, i, out, 0);
      return out[0] + out[1] + out[2];
    };
    const calm = new Float64Array(PANEL_COUNT).map((_, i) => level(i));
    for (let f = 0; f < 120 * 0.6; f++) {
      ripples.step(1 / 120, 1);
    }
    let brighter = 0;
    for (let i = 0; i < PANEL_COUNT; i++) {
      if (level(i) > calm[i] + 0.05) {
        brighter++;
      }
    }
    expect(brighter).toBeGreaterThan(1);
  });
});

describe("the panel show", () => {
  /** Largest per-second change of any panel channel over `seconds` at `fps`, with `modeAt(t)` choosing the mode. */
  function fastest(
    palette: PaletteId,
    seconds: number,
    modeAt: (t: number) => PanelMode,
    fps = 120,
  ): number {
    const show = createPanelShow();
    const prev = new Float32Array(3 * PANEL_COUNT);
    let most = 0;
    for (let f = 0; f < seconds * fps; f++) {
      const colours = show.step(1 / fps, modeAt(f / fps), palette, ACCENT, 1);
      if (f > 0) {
        for (let k = 0; k < colours.length; k++) {
          most = Math.max(most, Math.abs(colours[k] - prev[k]) * fps);
        }
      }
      prev.set(colours);
    }
    return most;
  }

  it.each(MODES.flatMap((mode) => PALETTES.map((palette) => [mode, palette] as const)))(
    "keeps %s in %s within the pattern limit at speed 1",
    (mode, palette) => {
      expect(fastest(palette, 40, () => mode)).toBeLessThanOrEqual(MAX_PANEL_RATE);
    },
  );

  it("eases mode changes, even quick ones in a row", () => {
    // A new mode every 0.7 s, so each change interrupts the last.
    const rate = fastest("rainbow", 20, (t) => MODES[Math.floor(t / 0.7) % MODES.length]);
    expect(rate).toBeLessThanOrEqual(MAX_PANEL_RATE);
  });

  it("eases a palette change over a second or more", () => {
    const show = createPanelShow();
    show.step(1 / 60, "static", "ember", ACCENT, 0.4);
    const before = Float32Array.from(show.colours);
    const after = createPanelShow().step(1 / 60, "static", "ocean", ACCENT, 0.4);
    for (let f = 0; f < 59; f++) {
      show.step(1 / 60, "static", "ocean", ACCENT, 0.4);
    }
    // One second in, still part-way between the two palettes.
    let between = 0;
    for (let k = 0; k < show.colours.length; k++) {
      if (
        Math.abs(show.colours[k] - after[k]) > 1e-3 &&
        Math.abs(show.colours[k] - before[k]) > 1e-3
      ) {
        between++;
      }
    }
    expect(between).toBeGreaterThan(0);
  });

  it("keeps every colour in range", () => {
    const show = createPanelShow();
    for (let f = 0; f < 60 * 60; f++) {
      const colours = show.step(
        1 / 60,
        MODES[Math.floor(f / 600) % MODES.length],
        "rainbow",
        ACCENT,
        1,
      );
      for (const v of colours) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
