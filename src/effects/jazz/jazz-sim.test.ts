import { describe, expect, it } from "vitest";
import { hexToRgb } from "../color";
import { smoothstep } from "../math";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ } from "../motion-limits";
import {
  C_BG,
  C_SQUIGGLE,
  C_SWASH,
  clearEllipse,
  createJazz,
  createPose,
  driftSpeed,
  type Element,
  type Ellipse,
  FINEST_PERIOD,
  forEachVisible,
  G_CONFETTI,
  G_SHAPE,
  G_SPLAT,
  G_SWASH,
  isChanging,
  type Jazz,
  type JazzParams,
  liveElements,
  PALETTES,
  REF_HEIGHT,
  resizeJazz,
  stepJazz,
} from "./jazz-sim";
import { jazzMeta, MIN_SCALE } from "./jazz.meta";

const base: JazzParams = {
  animation: "paint",
  speed: 0.5,
  scale: 1,
  confetti: true,
  shapes: true,
  splatter: true,
  seed: 1,
};

function make(aspect: number, p: Partial<JazzParams> = {}): { jazz: Jazz; params: JazzParams } {
  const jazz = createJazz();
  const params = { ...base, ...p };
  resizeJazz(jazz, REF_HEIGHT * aspect, REF_HEIGHT);
  stepJazz(jazz, 0, params);
  return { jazz, params };
}

/** Points round the ellipse's edge, densely. */
function edge(c: Ellipse): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 1440; i++) {
    const a = (i / 1440) * Math.PI * 2;
    out.push([c.cx + c.rx * Math.cos(a), c.cy + c.ry * Math.sin(a)]);
  }
  return out;
}

/** Distance from a point to the filled ellipse (0 inside), or `r` when it is surely further. */
function distanceTo(
  c: Ellipse,
  ring: [number, number][],
  x: number,
  y: number,
  r = Infinity,
): number {
  const n = Math.hypot((x - c.cx) / c.rx, (y - c.cy) / c.ry);
  if (n <= 1) {
    return 0;
  }
  // Scaling to the unit circle shrinks distances by at most 1 / min(rx, ry).
  if ((n - 1) * Math.min(c.rx, c.ry) >= r) {
    return r;
  }
  let min = Infinity;
  for (const [ex, ey] of ring) {
    min = Math.min(min, Math.hypot(x - ex, y - ey));
  }
  return min;
}

/** Samples of an element's body: centreline points (or its centre) and the radius about each. */
function body(el: Element, x: number, y: number, angle: number): [number, number, number][] {
  if (el.half <= 0) {
    return [[x, y, el.radius]];
  }
  const out: [number, number, number][] = [];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i <= 40; i++) {
    const t = -1 + i / 20;
    const lx = t * el.half;
    const ly = el.p0 * (1 - t * t);
    out.push([x + lx * c - ly * s, y + lx * s + ly * c, el.thick]);
  }
  return out;
}

const isBig = (el: Element) => el.group === G_SWASH || el.group === G_SHAPE || el.group === G_SPLAT;

const ASPECTS = [16 / 9, 4 / 3, 21 / 9, 9 / 16];

describe("90s jazz layout", () => {
  it.each(ASPECTS.map((a) => [a]))(
    "keeps swashes, shapes and splatter out of the centre at aspect %f",
    (aspect) => {
      for (const seed of [0, 1, 7, 42, 333]) {
        for (const scale of [MIN_SCALE, 1]) {
          const { jazz } = make(aspect, { seed, scale });
          const ring = edge(jazz.clear);
          const els = liveElements(jazz);
          expect(els.filter((e) => e.group === G_SWASH).length).toBeGreaterThan(0);
          for (const el of els.filter((e) => isBig(e))) {
            for (const [x, y, r] of body(el, el.x, el.y, el.angle)) {
              expect(distanceTo(jazz.clear, ring, x, y)).toBeGreaterThanOrEqual(r);
            }
          }
        }
      }
    },
  );

  it("is sparser in the middle", () => {
    const { jazz } = make(16 / 9, { seed: 3 });
    const c = jazz.clear;
    const confetti = liveElements(jazz).filter((e) => e.group === G_CONFETTI);
    const inside = confetti.filter(
      (e) => ((e.x - c.cx) / c.rx) ** 2 + ((e.y - c.cy) / c.ry) ** 2 < 1,
    );
    const ellipseShare = (Math.PI * c.rx * c.ry) / (jazz.width * jazz.height);
    expect(inside.length / confetti.length).toBeLessThan(0.6 * ellipseShare);
  });

  it("is the same for the same seed and different for another", () => {
    const shape = (els: readonly Element[]) => els.map((e) => [e.kind, e.x, e.y, e.angle]);
    const a = make(16 / 9, { seed: 5 });
    const b = make(16 / 9, { seed: 5 });
    const c = make(16 / 9, { seed: 6 });
    expect(shape(liveElements(a.jazz))).toEqual(shape(liveElements(b.jazz)));
    expect(shape(liveElements(c.jazz))).not.toEqual(shape(liveElements(a.jazz)));
  });

  it("puts the speaker's clear area higher in portrait", () => {
    const land = clearEllipse(1920, 1080, { cx: 0, cy: 0, rx: 0, ry: 0 });
    const port = clearEllipse(608, 1080, { cx: 0, cy: 0, rx: 0, ry: 0 });
    expect(port.cy).toBeLessThan(land.cy);
  });

  it("has more, smaller elements at a smaller scale", () => {
    const big = liveElements(make(16 / 9, { scale: 1 }).jazz);
    const small = liveElements(make(16 / 9, { scale: MIN_SCALE }).jazz);
    expect(small.length).toBeGreaterThan(2 * big.length);
    const longest = (els: readonly Element[]) => Math.max(...els.map((e) => e.half));
    expect(longest(small)).toBeLessThan(longest(big));
  });

  it("keeps the scale within the slider's range", () => {
    expect(make(16 / 9, { scale: 0.1 }).jazz.current?.k).toBe(MIN_SCALE);
    expect(make(16 / 9, { scale: 3 }).jazz.current?.k).toBe(1);
  });
});

describe("90s jazz palettes", () => {
  it.each(Object.keys(PALETTES).map((k) => [k]))(
    "%s keeps paper, swash and squiggle clearly apart",
    (key) => {
      const roles = [C_BG, C_SWASH, C_SQUIGGLE].map((r) => hexToRgb(PALETTES[key][r]));
      for (let i = 0; i < roles.length; i++) {
        for (let j = i + 1; j < roles.length; j++) {
          const [a, b] = [roles[i], roles[j]];
          expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(80);
        }
      }
    },
  );

  it("offers every palette in the meta", () => {
    const param = jazzMeta.params.palette;
    expect(param.options.map((o) => o.value).toSorted()).toEqual(Object.keys(PALETTES).toSorted());
  });
});

describe("90s jazz motion", () => {
  it.each([[0.5], [1]])("paints on and off without emptying at speed %f", (speed) => {
    const { jazz, params } = make(16 / 9, { speed });
    const start = liveElements(jazz).length;
    const first = new Set(liveElements(jazz));
    let fresh = 0;
    for (let i = 0; i < 30 * 240; i++) {
      stepJazz(jazz, 1 / 30, params);
      const els = liveElements(jazz);
      expect(els.length).toBeGreaterThanOrEqual(start - 1);
      expect(els.filter((e) => isChanging(e)).length).toBeLessThanOrEqual(2);
      fresh = els.filter((e) => !first.has(e)).length;
    }
    // Several elements were swapped in four minutes.
    expect(fresh).toBeGreaterThan(10);
  });

  it("mostly paints strokes on and off, starting within a couple of seconds", () => {
    const { jazz, params } = make(16 / 9);
    const pose = createPose();
    let firstChange = Infinity;
    const painted = new Set<Element>();
    const unpainted = new Set<Element>();
    for (let f = 0; f < 30 * 60; f++) {
      stepJazz(jazz, 1 / 30, params);
      forEachVisible(jazz, pose, (el, p) => {
        if (el.half > 0 && p.reveal < 1) {
          painted.add(el);
        }
        if (el.half > 0 && p.reveal > 1) {
          unpainted.add(el);
        }
      });
      if (firstChange === Infinity && liveElements(jazz).some((e) => isChanging(e))) {
        firstChange = f / 30;
      }
    }
    expect(firstChange).toBeLessThan(2.5);
    // About one change every 4-6 s, most of them strokes.
    expect(painted.size).toBeGreaterThanOrEqual(4);
    expect(unpainted.size).toBeGreaterThanOrEqual(4);
  });

  it("never pauses for long between changes, even when a spot is hard to find", () => {
    for (const aspect of [16 / 9, 21 / 9]) {
      for (const scale of [MIN_SCALE, 1]) {
        for (const seed of [0, 1, 2, 3]) {
          const { jazz, params } = make(aspect, { seed, scale });
          let idle = 0;
          let worst = 0;
          for (let f = 0; f < 30 * 120; f++) {
            stepJazz(jazz, 1 / 30, params);
            const busy =
              (jazz.current?.pending ?? null) !== null ||
              liveElements(jazz).some((e) => isChanging(e));
            idle = busy ? 0 : idle + 1 / 30;
            worst = Math.max(worst, idle);
          }
          // The longest pause is 3 s, plus a few quick retries.
          expect(worst).toBeLessThan(4.5);
        }
      }
    }
  });

  it("drifts no faster than the pattern limit for the finest feature", () => {
    for (const scale of [MIN_SCALE, 0.7, 1]) {
      const v = driftSpeed(1, scale);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(MAX_PATTERN_HZ * FINEST_PERIOD * scale + 1e-9);
    }
    expect(driftSpeed(0, 1)).toBe(0);
  });

  it("keeps the centre clear while drifting", () => {
    // The closest any body comes to the clear centre, in body radii (one expect, not thousands).
    let closest = Infinity;
    for (const aspect of [16 / 9, 9 / 16]) {
      const { jazz, params } = make(aspect, { animation: "drift", speed: 1, scale: MIN_SCALE });
      const ring = edge(jazz.clear);
      const pose = createPose();
      for (let f = 0; f < 30 * 60; f++) {
        stepJazz(jazz, 1 / 30, params);
        if (f % 15 !== 0) {
          continue;
        }
        const bodies: [number, number, number][] = [];
        forEachVisible(jazz, pose, (el, p) => {
          if (isBig(el) && p.alpha > 0) {
            bodies.push(...body(el, p.x, p.y, p.angle));
          }
        });
        for (const [x, y, r] of bodies) {
          closest = Math.min(closest, distanceTo(jazz.clear, ring, x, y, r) / r);
        }
      }
    }
    expect(closest).toBeGreaterThanOrEqual(0.999);
  });

  it.each([["paint"], ["wobble"], ["drift"]])(
    "moves every tip and edge within the codec limit in %s",
    (animation) => {
      for (const scale of [MIN_SCALE, 1]) {
        const { jazz, params } = make(16 / 9, { animation, speed: 1, scale });
        const pose = createPose();
        const last = new Map<Element, [number, number, number, number, number, number]>();
        let worst = 0;
        const seen: [Element, number, number, number, number, number][] = [];
        for (let f = 0; f < 30 * 120; f++) {
          stepJazz(jazz, 1 / 30, params);
          seen.length = 0;
          forEachVisible(jazz, pose, (el, p) => {
            seen.push([el, p.x, p.y, p.angle, p.pop, p.reveal]);
          });
          for (const [el, x, y, angle, pop, reveal] of seen) {
            const reach = el.half > 0 ? el.half : el.radius;
            const prev = last.get(el);
            // Only frame to frame; a drift wrap jumps off screen, not on it.
            if (prev?.[5] === f - 1 && Math.hypot(x - prev[0], y - prev[1]) < 100) {
              const move =
                Math.hypot(x - prev[0], y - prev[1]) +
                reach * Math.abs(angle - prev[2]) * Math.max(pop, prev[3]) +
                reach * Math.abs(pop - prev[3]) +
                2 * el.half * Math.abs(reveal - prev[4]);
              worst = Math.max(worst, move);
            }
            last.set(el, [x, y, angle, pop, reveal, f]);
          }
        }
        expect(worst).toBeGreaterThan(0);
        expect(worst).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
      }
    },
  );

  it("doesn't move at speed 0 or in Still", () => {
    for (const p of [{ speed: 0 }, { animation: "still" }, { animation: "wobble", speed: 0 }]) {
      const { jazz, params } = make(16 / 9, p);
      const pose = createPose();
      const snap = () => {
        const out: number[] = [];
        forEachVisible(jazz, pose, (_, q) => {
          out.push(q.x, q.y, q.angle, q.pop, q.reveal, q.alpha);
        });
        return out;
      };
      stepJazz(jazz, 1 / 30, params);
      const first = snap();
      for (let i = 0; i < 30 * 30; i++) {
        stepJazz(jazz, 1 / 30, params);
      }
      expect(snap()).toEqual(first);
    }
  });

  it("crossfades to a new seed once it settles, and fades toggled groups", () => {
    const { jazz, params } = make(16 / 9, { animation: "still" });
    const old = liveElements(jazz);
    const next = { ...params, seed: 9, confetti: false };
    stepJazz(jazz, 1 / 30, next);
    expect(jazz.previous).toBeNull();
    expect(jazz.groupAlpha[G_CONFETTI]).toBeGreaterThan(0.9);
    for (let i = 0; i < 10; i++) {
      stepJazz(jazz, 1 / 30, next);
    }
    expect(jazz.previous).not.toBeNull();
    expect(liveElements(jazz)).not.toBe(old);
    for (let i = 0; i < 40; i++) {
      stepJazz(jazz, 1 / 30, next);
    }
    expect(jazz.previous).toBeNull();
    expect(jazz.groupAlpha[G_CONFETTI]).toBe(0);
  });
});

type Scene = NonNullable<Jazz["current"]>;

/** How much each layout on screen shows. */
function weights(jazz: Jazz): Map<Scene, number> {
  const out = new Map<Scene, number>();
  const fade = jazz.previous ? smoothstep(0, 1, jazz.fade) : 1;
  if (jazz.current) {
    out.set(jazz.current, fade);
  }
  if (jazz.previous) {
    out.set(jazz.previous, 1 - fade);
  }
  return out;
}

/** The most a crossfade changes a layout's share in a frame: smoothstep's slope is at most 1.5. */
const MAX_JUMP = 1.5 / 30 + 1e-9;

/**
 * Steps `frames` frames with the params `change` gives for each; returns every
 * layout shown and the most any layout's share of the frame changed in a frame.
 */
function stepWatching(
  jazz: Jazz,
  frames: number,
  change: (f: number) => JazzParams,
): { scenes: Set<Scene>; jump: number } {
  let last = weights(jazz);
  const scenes = new Set(last.keys());
  let jump = 0;
  for (let f = 0; f < frames; f++) {
    stepJazz(jazz, 1 / 30, change(f));
    const now = weights(jazz);
    for (const scene of new Set([...now.keys(), ...last.keys()])) {
      scenes.add(scene);
      jump = Math.max(jump, Math.abs((now.get(scene) ?? 0) - (last.get(scene) ?? 0)));
    }
    last = now;
  }
  return { scenes, jump };
}

describe("90s jazz rebuilds", () => {
  it("lays out once after a slider drag, crossfading without a cut", () => {
    const { jazz, params } = make(16 / 9);
    // Seed and scale dragged a step every frame for a second, then let go.
    const { scenes, jump } = stepWatching(jazz, 30 * 4, (f) => {
      const t = Math.min(f, 30);
      return { ...params, seed: 1 + t, scale: 1 - t / 60 };
    });
    expect(jump).toBeLessThanOrEqual(MAX_JUMP);
    expect(scenes.size).toBe(2);
    expect(jazz.previous).toBeNull();
    expect(jazz.current?.seed).toBe(31);
    expect(jazz.current?.k).toBeCloseTo(0.5);
  });

  it("finishes one crossfade before starting the next", () => {
    const { jazz, params } = make(16 / 9);
    const first = jazz.current;
    // A new seed every half second, slower than the settle time.
    const { scenes, jump } = stepWatching(jazz, 30 * 6, (f) => ({
      ...params,
      seed: f < 30 * 2 ? 2 + Math.floor(f / 15) : 9,
    }));
    expect(jump).toBeLessThanOrEqual(MAX_JUMP);
    expect(scenes.has(first as Scene)).toBe(true);
    // Never more than one crossfade a second, plus the settle.
    expect(scenes.size).toBeLessThanOrEqual(1 + 4);
    expect(jazz.current?.seed).toBe(9);
  });

  it("lays out again for a resize once it settles, crossfading", () => {
    const { jazz, params } = make(16 / 9);
    const first = jazz.current;
    const during = new Set<Scene | null>();
    const { scenes, jump } = stepWatching(jazz, 30 * 3, (f) => {
      if (f < 30) {
        // A window drag: a new width every frame.
        resizeJazz(jazz, REF_HEIGHT * (16 / 9 - f / 60), REF_HEIGHT);
      }
      if (f < 30 + 5) {
        during.add(jazz.current);
      }
      return params;
    });
    expect([...during]).toEqual([first]);
    expect(jump).toBeLessThanOrEqual(MAX_JUMP);
    expect(scenes.size).toBe(2);
    expect(jazz.previous).toBeNull();
    expect(jazz.width).toBeCloseTo(REF_HEIGHT * (16 / 9 - 29 / 60));
    expect(jazz.clear.cx).toBeCloseTo(jazz.width / 2);
  });
});
