import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import {
  BLINK_LENGTH,
  BLINK_MAX,
  BLINK_MIN,
  BOB_AMPLITUDE,
  BOB_HZ,
  bobOffset,
  BREATH_HZ,
  BREATH_SCALE,
  CAPTION_BOTTOM,
  CAPTION_MAX_WIDTH,
  type CaptionLayout,
  type CaptionStyle,
  captionLines,
  CLOUD_HEIGHT,
  CLOUD_MARGIN,
  CLOUD_SPEED_MAX,
  CLOUD_WIDTH,
  cloudCount,
  createBlinkClock,
  createCloudLayout,
  createCritterState,
  createMotionClock,
  CRITTER_FADE,
  CRITTER_FEET,
  CRITTER_SIZE,
  critterBox,
  type CritterBox,
  critterIndex,
  critterSide,
  FRAME_BLINK,
  groundEdge,
  IDLE_LENGTH,
  layoutCaption,
  MAX_CLOUDS,
  MAX_SPARKLES,
  packShelves,
  REF_HEIGHT,
  SIDE_FADE,
  type Sparkle,
  sparkleAt,
  stepBlink,
  stepClouds,
  stepCritter,
  stepMotion,
  WORD_COLORS,
  wordColors,
} from "./passion-sim";
import { CAPTION_LENGTH, CRITTER_OPTIONS, passionMeta } from "./passion.meta";

const DT = 1 / 30;

/** Every character half an em wide, a little wider than most cheesy fonts. */
const measure = (w: string) => 0.6 * Array.from(w).length;

const DEFAULT_TEXT = passionMeta.params.text.default;
const FULL_LINE = "WWWW WWWWW WWWW WWWWW WWWWWW".slice(0, CAPTION_LENGTH);
const FULL_TEXT = `${FULL_LINE}\n${FULL_LINE}`;
const ONE_LONG_WORD = "W".repeat(CAPTION_LENGTH);

/** Reference widths for 16:9, 4:3, 21:9 and 9:16 portrait. */
const ASPECTS = [
  ["16:9", (REF_HEIGHT * 16) / 9],
  ["4:3", (REF_HEIGHT * 4) / 3],
  ["21:9", (REF_HEIGHT * 21) / 9],
  ["9:16", (REF_HEIGHT * 9) / 16],
] as const;
const TEXTS = [
  ["default", DEFAULT_TEXT],
  ["2 x 28", FULL_TEXT],
  ["one long word", ONE_LONG_WORD],
] as const;
const STYLES: readonly CaptionStyle[] = ["meme", "wordart"];

/** Every rotated word box's corners lie in the layout's box. */
function wordsOutsideBox(c: CaptionLayout): string[] {
  const out: string[] = [];
  for (const w of c.words) {
    const cos = Math.cos(w.angle);
    const sin = Math.sin(w.angle);
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const dx = (sx * w.width) / 2;
      const dy = (sy * w.height) / 2;
      const x = w.x + dx * cos - dy * sin;
      const y = w.y + dx * sin + dy * cos;
      if (x < c.left - 1e-6 || x > c.right + 1e-6 || y < c.top - 1e-6 || y > c.bottom + 1e-6) {
        out.push(`${w.text} corner ${String(sx)},${String(sy)}`);
      }
    }
  }
  return out;
}

describe("word colours", () => {
  const cases = [0, 1, 7, 42, 500, 999].flatMap((seed) =>
    [1, 2, 5, 28].map((count) => [seed, count] as const),
  );

  it.each(cases)("never repeat between neighbours (seed %i, %i words)", (seed, count) => {
    const colors = wordColors(seed, count);
    expect(colors).toHaveLength(count);
    expect(colors.every((c) => c >= 0 && c < WORD_COLORS.length)).toBe(true);
    expect(colors.filter((c, i) => i > 0 && c === colors[i - 1])).toEqual([]);
  });

  it.each([1, 42])("keep earlier words' colours when words are added (seed %i)", (seed) => {
    expect(wordColors(seed, 28).slice(0, 5)).toEqual(wordColors(seed, 5));
  });

  it("change with the seed", () => {
    expect(wordColors(1, 8)).not.toEqual(wordColors(2, 8));
  });
});

describe("caption layout", () => {
  const cases = ASPECTS.flatMap(([aspect, w]) =>
    TEXTS.flatMap(([name, text]) => STYLES.map((style) => [aspect, w, name, text, style] as const)),
  );

  it.each(cases)("fits the frame's upper third at %s (%s text, %s)", (_a, w, _n, text, style) => {
    const c = layoutCaption(text, style, 3, w, measure);
    expect(c.words.length).toBeGreaterThan(0);
    expect(c.left).toBeGreaterThanOrEqual(0);
    expect(c.right).toBeLessThanOrEqual(w);
    expect(c.right - c.left).toBeLessThanOrEqual(CAPTION_MAX_WIDTH * w + 1e-6);
    expect(c.top - BOB_AMPLITUDE).toBeGreaterThanOrEqual(0);
    expect(c.bottom + BOB_AMPLITUDE).toBeLessThanOrEqual(CAPTION_BOTTOM + 1e-6);
    expect(wordsOutsideBox(c)).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 99])("tilts a little and sits off-centre (seed %i)", (seed) => {
    const w = ASPECTS[0][1];
    const c = layoutCaption(DEFAULT_TEXT, "meme", seed, w, measure);
    const tilt = Math.abs(c.words[0].angle);
    expect(tilt).toBeGreaterThan(0.02);
    expect(tilt).toBeLessThan(0.07);
    expect(Math.abs((c.left + c.right) / 2 - w / 2)).toBeLessThanOrEqual(0.06 * w);
  });

  it.each([
    ["16:9", ASPECTS[0][1], 1],
    ["9:16", ASPECTS[3][1], 2],
  ] as const)("wraps the default caption on a %s frame to %i line(s)", (_a, w, lines) => {
    const c = layoutCaption(DEFAULT_TEXT, "meme", 1, w, measure);
    expect(new Set(c.words.map((word) => word.line)).size).toBe(lines);
  });

  it("keeps the text's own line break", () => {
    const c = layoutCaption("graphic design\nis my passion", "meme", 1, 1920, measure);
    expect(c.words.map((w) => w.line)).toEqual([0, 0, 1, 1, 1]);
  });

  it("arches WordArt lines: the middle word rides highest", () => {
    // Seed 0's tilt is taken out by comparing against the Meme layout.
    const meme = layoutCaption("aa bb cc dd ee", "meme", 0, 1920, measure);
    const art = layoutCaption("aa bb cc dd ee", "wordart", 0, 1920, measure);
    const rise = art.words.map((w, i) => w.y - meme.words[i].y - (art.top - meme.top));
    expect(rise[2]).toBeLessThan(rise[0]);
    expect(rise[2]).toBeLessThan(rise[4]);
    expect(art.words[0].angle).toBeLessThan(art.words[4].angle);
  });

  it("spans WordArt's rainbow across each line", () => {
    const c = layoutCaption(DEFAULT_TEXT, "wordart", 1, 1920, measure);
    expect(c.words[0].span0).toBeCloseTo(0);
    expect(c.words[c.words.length - 1].span1).toBeCloseTo(1);
  });

  it("measures by code point where the font can't be measured", () => {
    const c = layoutCaption(DEFAULT_TEXT, "meme", 1, 1920, () => undefined);
    expect(c.words.map((w) => w.text)).toEqual(DEFAULT_TEXT.split(" "));
    expect(c.words.every((w) => w.width > 0)).toBe(true);
  });

  it.each(["", "   ", "\n"])("lays out no words for %j", (text) => {
    expect(layoutCaption(text, "meme", 1, 1920, measure).words).toEqual([]);
  });

  it("splits lines into words and drops empty lines", () => {
    expect(captionLines("  a  b\n\nc\nd")).toEqual([["a", "b"], ["c"]]);
  });
});

describe("atlas packing", () => {
  it.each([64, 300, 4096])("keeps boxes apart and inside %i px rows", (maxWidth) => {
    const widths = [120, 80, 300, 40, 200, 260];
    const heights = widths.map(() => 50);
    const p = packShelves(widths, heights, maxWidth, 2);
    for (let i = 0; i < widths.length; i++) {
      expect(p.x[i] + widths[i]).toBeLessThanOrEqual(p.width);
      expect(p.y[i] + heights[i]).toBeLessThanOrEqual(p.height);
      for (let j = 0; j < i; j++) {
        const apart =
          p.x[i] >= p.x[j] + widths[j] ||
          p.x[j] >= p.x[i] + widths[i] ||
          p.y[i] >= p.y[j] + heights[j] ||
          p.y[j] >= p.y[i] + heights[i];
        expect(apart).toBe(true);
      }
    }
  });
});

describe("critter", () => {
  it("has one atlas row per select option, in order", () => {
    expect(CRITTER_OPTIONS.map((o) => critterIndex(o.value))).toEqual(
      CRITTER_OPTIONS.map((_, i) => i),
    );
    expect(critterIndex("unicorn")).toBe(0);
  });

  it.each([
    ["left", "left"],
    ["none", "none"],
    ["right", "right"],
    ["", "right"],
  ])("reads side %j as %s", (value, side) => {
    expect(critterSide(value)).toBe(side);
  });

  const cases = ASPECTS.flatMap(([aspect, w]) =>
    (["left", "right"] as const).map((side) => [aspect, w, side] as const),
  );

  it.each(cases)("sits inside a %s frame on the %s, clear of the caption", (_a, w, side) => {
    const box: CritterBox = critterBox(side, w, { x: 0, y: 0, size: 0 });
    const half = (box.size * (1 + BREATH_SCALE)) / 2;
    expect(box.x - half).toBeGreaterThanOrEqual(0);
    expect(box.x + half).toBeLessThanOrEqual(w);
    expect(box.y + half).toBeLessThanOrEqual(REF_HEIGHT);
    expect(box.size).toBeGreaterThan(0.15 * REF_HEIGHT);
    expect(box.size).toBeLessThanOrEqual(CRITTER_SIZE);
    for (const [, text] of TEXTS) {
      const c = layoutCaption(text, "wordart", 1, w, measure);
      expect(box.y - half).toBeGreaterThan(c.bottom + BOB_AMPLITUDE);
    }
    // Feet on the grass, below its wobbly edge.
    expect(box.y + box.size * (CRITTER_FEET - 0.5)).toBeGreaterThan(groundEdge(box.x));
    expect(side === "left" ? box.x < w / 2 : box.x > w / 2).toBe(true);
  });

  it("crossfades a new critter in place, latching a change made mid-fade", () => {
    const s = createCritterState();
    stepCritter(s, DT, 0, "right");
    stepCritter(s, DT, 2, "right");
    expect(s.next).toBe(2);
    stepCritter(s, CRITTER_FADE / 2, 4, "right");
    expect(s.next).toBe(2);
    stepCritter(s, CRITTER_FADE / 2, 4, "right");
    expect([s.shown, s.next]).toEqual([2, -1]);
    stepCritter(s, DT, 4, "right");
    expect(s.next).toBe(4);
  });

  it("fades out before moving to the other side, then fades back in", () => {
    const s = createCritterState();
    stepCritter(s, DT, 0, "right");
    expect(s.presence).toBe(1);
    stepCritter(s, SIDE_FADE / 2, 0, "left");
    expect([s.side, s.presence]).toEqual(["right", 0.5]);
    stepCritter(s, SIDE_FADE / 2, 0, "left");
    expect([s.side, s.presence]).toEqual(["left", 0]);
    stepCritter(s, SIDE_FADE, 0, "left");
    expect(s.presence).toBe(1);
  });

  it("hides on side None", () => {
    const s = createCritterState();
    stepCritter(s, DT, 0, "none");
    expect(s.presence).toBe(0);
    stepCritter(s, 1, 0, "none");
    expect(s.presence).toBe(0);
  });
});

describe("blinks", () => {
  it.each([0, 1, 2, 3, 77])("come every 4 to 8 seconds (seed %i)", (seed) => {
    const c = createBlinkClock(seed);
    const starts: number[] = [];
    let was = false;
    for (let t = 0; t < 120; t += DT) {
      const blink = stepBlink(c, DT) === FRAME_BLINK;
      if (blink && !was) {
        starts.push(c.time);
      }
      was = blink;
    }
    expect(starts.length).toBeGreaterThan(120 / BLINK_MAX - 2);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      expect(gap).toBeGreaterThanOrEqual(BLINK_MIN - DT);
      expect(gap).toBeLessThanOrEqual(BLINK_MAX + DT);
    }
  });

  it("are brief, and slower than the pattern limit", () => {
    expect(BLINK_LENGTH).toBeLessThan(0.3);
    expect(IDLE_LENGTH).toBeLessThan(1);
    expect(1 / BLINK_MIN).toBeLessThan(MAX_PATTERN_HZ);
  });
});

describe("clouds", () => {
  it.each([
    [600, 2],
    [1920, 5],
    [4000, MAX_CLOUDS],
  ])("number a few for a %i px wide frame", (w, n) => {
    expect(cloudCount(w)).toBe(n);
  });

  it.each([0, 1, 2, 3])("are seeded, the same for the same seed (seed %i)", (seed) => {
    const a = createCloudLayout(seed, 1920);
    expect(Array.from(a.x)).not.toEqual(Array.from(createCloudLayout(seed + 1, 1920).x));
    expect(Array.from(createCloudLayout(seed, 1920).y)).toEqual(Array.from(a.y));
  });

  const wrapCases = [0, 1, 2].flatMap((seed) =>
    ASPECTS.map(([aspect, w]) => [seed, aspect, w] as const),
  );

  it.each(wrapCases)("wrap only while out of view (seed %i, %s)", (seed, _a, w) => {
    const c = createCloudLayout(seed, w);
    const problems: string[] = [];
    const wraps = Array.from({ length: MAX_CLOUDS }, () => 0);
    const prev = Float64Array.from(c.x);
    // Long enough for the slowest cloud to cross the whole span once.
    const crossing = (w + 2 * CLOUD_MARGIN) / Math.min(...c.speed) + 1;
    for (let t = DT; t < crossing; t += DT) {
      stepClouds(c, DT, 1, w);
      for (let i = 0; i < MAX_CLOUDS; i++) {
        const half = (CLOUD_WIDTH * c.size[i]) / 2;
        if (c.x[i] < prev[i]) {
          wraps[i]++;
          if (prev[i] - half < w || c.x[i] + half > 0) {
            problems.push(
              `cloud ${String(i)} wrapped from ${String(prev[i])} to ${String(c.x[i])}`,
            );
          }
        }
        prev[i] = c.x[i];
      }
    }
    expect(wraps.every((n) => n > 0)).toBe(true);
    expect(problems).toEqual([]);
  });

  const resizeCases = [
    ["a few px", 1920, 1910],
    ["16:9 to 4:3", (REF_HEIGHT * 16) / 9, (REF_HEIGHT * 4) / 3],
    ["16:9 to 21:9", (REF_HEIGHT * 16) / 9, (REF_HEIGHT * 21) / 9],
  ] as const;

  it.each(resizeCases)(
    "keep their place across the frame after an hour, resized %s",
    (_n, from, to) => {
      const c = createCloudLayout(3, from);
      for (let t = 0; t < 3600; t += 0.1) {
        stepClouds(c, 0.1, 1, from);
      }
      const before = Array.from(c.x, (x) => (x + CLOUD_MARGIN) / (from + 2 * CLOUD_MARGIN));
      stepClouds(c, 0, 1, to);
      const after = Array.from(c.x, (x) => (x + CLOUD_MARGIN) / (to + 2 * CLOUD_MARGIN));
      // The same fraction of the way across; in px, at most the change in width.
      const moved = after.map((a, i) => Math.abs(a - before[i]) * (to + 2 * CLOUD_MARGIN));
      expect(Math.max(...moved)).toBeLessThan(0.01);
      const px = Array.from(c.x, (x, i) =>
        Math.abs(x - (before[i] * (from + 2 * CLOUD_MARGIN) - CLOUD_MARGIN)),
      );
      expect(Math.max(...px)).toBeLessThanOrEqual(Math.abs(to - from) + 0.01);
    },
  );

  it("stay in the sky", () => {
    const c = createCloudLayout(5, 1920);
    for (let i = 0; i < MAX_CLOUDS; i++) {
      expect(c.y[i] - (CLOUD_HEIGHT * c.size[i]) / 2).toBeGreaterThan(0);
      expect(c.y[i] + (CLOUD_HEIGHT * c.size[i]) / 2).toBeLessThan(groundEdge(0) - 50);
      expect(CLOUD_MARGIN).toBeGreaterThanOrEqual((CLOUD_WIDTH * c.size[i]) / 2);
    }
  });
});

describe("motion limits", () => {
  it("drifts the clouds a fraction of a pixel per frame at motion 1", () => {
    expect(pxPerReferenceFrame(CLOUD_SPEED_MAX / REF_HEIGHT)).toBeLessThan(1);
  });

  it("bobs the caption slowly at motion 1", () => {
    const speed = 2 * Math.PI * BOB_HZ * BOB_AMPLITUDE;
    expect(pxPerReferenceFrame(speed / REF_HEIGHT)).toBeLessThan(MAX_FEATURE_PX_PER_FRAME / 10);
    expect(BOB_HZ).toBeLessThan(MAX_PATTERN_HZ);
  });

  it("breathes slowly at motion 1", () => {
    const speed = 2 * Math.PI * BREATH_HZ * BREATH_SCALE * CRITTER_SIZE;
    expect(pxPerReferenceFrame(speed / REF_HEIGHT)).toBeLessThan(MAX_FEATURE_PX_PER_FRAME / 10);
    expect(BREATH_HZ).toBeLessThan(MAX_PATTERN_HZ);
  });

  it("bobs neighbouring words out of phase", () => {
    expect(bobOffset(0, 0.1, 1)).not.toBeCloseTo(bobOffset(1, 0.1, 1));
    expect(Math.abs(bobOffset(3, 0.37, 1))).toBeLessThanOrEqual(BOB_AMPLITUDE);
  });

  it("fades sparkles in and out slowly", () => {
    const out: Sparkle = { x: 0, y: 0, alpha: 0 };
    let maxStep = 0;
    let prev = sparkleAt(1, 0, 0, 1920, out).alpha;
    for (let t = DT; t < 30; t += DT) {
      const a = sparkleAt(1, 0, t, 1920, out).alpha;
      maxStep = Math.max(maxStep, Math.abs(a - prev));
      prev = a;
    }
    expect(maxStep).toBeLessThan(0.05);
  });
});

describe("motion 0", () => {
  /** Everything the clocks move, sampled. */
  function sample(
    seed: number,
    m: ReturnType<typeof createMotionClock>,
    clouds: ReturnType<typeof createCloudLayout>,
  ) {
    const out: Sparkle = { x: 0, y: 0, alpha: 0 };
    const sparkles = Array.from({ length: MAX_SPARKLES }, (_, k) => {
      const s = sparkleAt(seed, k, m.sparkle, 1920, out);
      return [s.x, s.y, s.alpha];
    });
    return {
      clouds: Array.from(clouds.x),
      bob: Array.from({ length: 5 }, (_, i) => bobOffset(i, m.bob, 1)),
      breath: m.breath,
      frame: m.frame,
      sparkles,
    };
  }

  it.each([0, 1, 2, 42])("gives identical frames over time (seed %i)", (seed) => {
    const m = createMotionClock(seed);
    const clouds = createCloudLayout(seed, 1920);
    // Some motion first, so the clocks aren't at their starting values.
    for (let i = 0; i < 100; i++) {
      stepMotion(m, DT, 1);
      stepClouds(clouds, DT, 1, 1920);
    }
    stepMotion(m, DT, 0);
    stepClouds(clouds, DT, 0, 1920);
    const first = sample(seed, m, clouds);
    for (let i = 0; i < 600; i++) {
      stepMotion(m, DT, 0);
      stepClouds(clouds, DT, 0, 1920);
    }
    expect(sample(seed, m, clouds)).toEqual(first);
    expect(m.frame).not.toBe(FRAME_BLINK);
  });

  it("is a valid slider value", () => {
    expect(passionMeta.params.motion.min).toBe(0);
  });
});
