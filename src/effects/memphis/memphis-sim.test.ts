import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import {
  BLEND_SIZE,
  J_FRONT_HAND,
  JOINT_COUNT,
  POSE_COUNT,
  POSE_HIGH_FIVE,
  POSE_WAVE,
  SOLO_POSES,
  solveRig,
  TIP_JOINTS,
} from "./memphis-figures";
import {
  createShapeList,
  emitScene,
  shapeBounds,
  TAG_BACKGROUND,
  TAG_HIGH_FIVE,
} from "./memphis-shapes";
import {
  BOTTOMS,
  changePoseNow,
  createLayout,
  createScene,
  figurePose,
  type Layout,
  MIN_TWEEN,
  PALETTES,
  REF_HEIGHT,
  ROLE_COUNT,
  type Scene,
  SKINS,
  stepScene,
  TOP_BAND,
  TOPS,
  tweenSeconds,
  updateLayout,
  highFiveStretch,
} from "./memphis-sim";
import { MAX_PEOPLE } from "./memphis.meta";

const ASPECTS: [string, number, number][] = [
  ["16:9", 1920, 1080],
  ["4:3", 1440, 1080],
  ["21:9", 2520, 1080],
  ["portrait", 608, 1080],
];

const layoutFor = (w: number, h: number) => updateLayout(createLayout(), w, h);
const params = (
  o: Partial<{ people: number; props: boolean; motion: number; seed: number }> = {},
) => ({
  people: 4,
  props: true,
  motion: 1,
  seed: 1,
  ...o,
});

/** A started scene for `layout`. */
function sceneFor(layout: Layout, seed = 1, people = 4): Scene {
  const scene = createScene(seed);
  stepScene(scene, layout, 0, params({ seed, people }));
  return scene;
}

describe("corporate memphis palettes", () => {
  it.each(Object.keys(PALETTES))("gives every role in %s its own colour", (key) => {
    const colors = PALETTES[key].map((c) => c.toLowerCase());
    expect(colors).toHaveLength(ROLE_COUNT);
    expect(new Set(colors).size).toBe(ROLE_COUNT);
  });

  it.each([0, 1, 2, 7, 99, 500])("dresses neighbours differently for seed %i", (seed) => {
    const scene = createScene(seed);
    const f = scene.figures;
    expect(new Set(f.map((x) => x.skin)).size).toBe(MAX_PEOPLE);
    expect(new Set(f.map((x) => x.top)).size).toBe(MAX_PEOPLE);
    for (const x of f) {
      expect(x.skin).toBeLessThan(SKINS);
      expect(x.top).toBeLessThan(TOPS);
      expect(x.bottom).toBeLessThan(BOTTOMS);
    }
    // The two at each side stand overlapping: trousers and shoes differ too.
    for (const [a, b] of [
      [0, 2],
      [1, 3],
    ]) {
      expect(f[a].bottom).not.toBe(f[b].bottom);
      expect(f[a].shoe).not.toBe(f[b].shoe);
    }
    // Neighbouring blobs and leaves.
    expect(scene.blobColors[0]).not.toBe(scene.blobColors[1]);
    expect(scene.blobColors[2]).not.toBe(scene.blobColors[3]);
  });
});

const palette = new Float32Array(ROLE_COUNT * 3).fill(0.5);
const bounds = new Float64Array(4);

/** Shapes that break the speaker's area, as messages. */
function intrusions(scene: Scene, layout: Layout): string[] {
  const list = createShapeList();
  emitScene(list, scene, layout, palette);
  const c = layout.clear;
  const out: string[] = [];
  for (let i = 0; i < list.count; i++) {
    const tag = list.tags[i];
    if (tag === TAG_BACKGROUND) {
      continue;
    }
    shapeBounds(list, i, bounds);
    const [x0, y0, x1, y1] = bounds;
    // People and props keep out of the middle columns at any height (in
    // portrait, out of the clear box); the high five's arms keep to the top band.
    const top = tag === TAG_HIGH_FIVE || layout.portrait ? c.y0 : 0;
    if (x1 > c.x0 && x0 < c.x1 && y1 > top && y0 < c.y1) {
      out.push(`shape ${String(i)} (tag ${String(tag)}) at ${bounds.join(", ")}`);
    }
  }
  return out;
}

describe("corporate memphis layout", () => {
  it.each(ASPECTS)("keeps people and props out of the middle at %s", (_, w, h) => {
    const layout = layoutFor(w, h);
    for (const seed of [0, 1, 2, 3]) {
      const scene = sceneFor(layout, seed);
      for (let from = 0; from < POSE_COUNT; from++) {
        for (let to = 0; to < POSE_COUNT; to++) {
          for (const t of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]) {
            scene.figures.forEach((f, i) => {
              const hf = layout.highFive && i < 2;
              f.from = hf || from !== POSE_HIGH_FIVE ? from : 0;
              f.to = hf || to !== POSE_HIGH_FIVE ? to : 0;
              f.t = t;
            });
            scene.clock = t * 37 + from;
            expect(intrusions(scene, layout)).toEqual([]);
          }
        }
      }
    }
  });

  it.each(ASPECTS)("keeps everything on screen vertically at %s", (_, w, h) => {
    const layout = layoutFor(w, h);
    const scene = sceneFor(layout);
    const list = createShapeList();
    emitScene(list, scene, layout, palette);
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < list.count; i++) {
      shapeBounds(list, i, bounds);
      if (list.tags[i] !== TAG_BACKGROUND) {
        top = Math.min(top, bounds[1]);
        bottom = Math.max(bottom, bounds[3]);
      }
    }
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeLessThan(h + 1);
  });

  it("meets the high five's hands in the middle of the top band", () => {
    const layout = layoutFor(1920, 1080);
    const scene = sceneFor(layout);
    const pose = new Float64Array(BLEND_SIZE);
    const joints = new Float64Array(2 * JOINT_COUNT);
    const hands: number[] = [];
    for (const i of [0, 1]) {
      const f = scene.figures[i];
      f.from = POSE_HIGH_FIVE;
      f.to = POSE_HIGH_FIVE;
      f.t = 1;
      solveRig(figurePose(scene, layout, i, pose), joints);
      const s = layout.figures[i];
      const x = s.x + s.facing * s.size * joints[2 * J_FRONT_HAND];
      const y = s.ground - s.size * joints[2 * J_FRONT_HAND + 1];
      expect(y).toBeCloseTo(layout.handY, 6);
      expect(y).toBeLessThan(TOP_BAND * REF_HEIGHT);
      hands.push(x);
    }
    expect(hands[0]).toBeLessThan(layout.width / 2);
    expect(hands[1]).toBeGreaterThan(layout.width / 2);
    // Touching: the hands overlap a little.
    const s = layout.figures[0].size;
    expect(hands[1] - hands[0]).toBeLessThan(2 * 0.042 * s);
    expect(highFiveStretch(layout, 0, new Float64Array(2))[1]).toBeGreaterThan(3);
  });
});

describe("corporate memphis motion", () => {
  const limit = MAX_FEATURE_PX_PER_FRAME;
  const pose = new Float64Array(BLEND_SIZE);
  const joints = new Float64Array(2 * JOINT_COUNT);

  /** The largest move of a hand, foot or head in one 30 fps frame, ref px (1080p px). */
  function peakStep(scene: Scene, layout: Layout, index: number, seconds: number): number {
    const dt = 1 / 30;
    const s = layout.figures[index];
    let peak = 0;
    const last = new Float64Array(2 * JOINT_COUNT);
    for (let k = 0; k * dt <= seconds; k++) {
      solveRig(figurePose(scene, layout, index, pose), joints);
      if (k > 0) {
        for (const j of TIP_JOINTS) {
          const d = Math.hypot(joints[2 * j] - last[2 * j], joints[2 * j + 1] - last[2 * j + 1]);
          peak = Math.max(peak, d * s.size);
        }
      }
      last.set(joints);
      const f = scene.figures[index];
      f.t = Math.min(1, f.t + dt / f.duration);
      scene.clock += dt;
    }
    return peak;
  }

  const tweenCases: [string, number, number][] = [];
  for (const [name] of ASPECTS) {
    for (let a = 0; a < POSE_COUNT; a++) {
      for (let b = 0; b < POSE_COUNT; b++) {
        if (a !== b) {
          tweenCases.push([name, a, b]);
        }
      }
    }
  }

  it.each(tweenCases)(
    "keeps the %s tween from pose %i to %i within the codec limit",
    (name, a, b) => {
      const [, w, h] = ASPECTS.find(([n]) => n === name) ?? ASPECTS[0];
      const layout = layoutFor(w, h);
      if (!layout.highFive && (a === POSE_HIGH_FIVE || b === POSE_HIGH_FIVE)) {
        return;
      }
      const scene = sceneFor(layout);
      const f = scene.figures[0];
      const stretch = highFiveStretch(layout, 0, new Float64Array(2));
      f.from = a;
      f.to = b;
      f.t = 0;
      f.duration = tweenSeconds(a, b, stretch[0], stretch[1], layout.figures[0].size);
      expect(f.duration).toBeGreaterThanOrEqual(MIN_TWEEN);
      expect(peakStep(scene, layout, 0, f.duration + 0.1)).toBeLessThan(limit);
    },
  );

  it.each(ASPECTS)("waves within the codec limit at %s", (_, w, h) => {
    const layout = layoutFor(w, h);
    const scene = sceneFor(layout);
    const f = scene.figures[1];
    f.from = POSE_WAVE;
    f.to = POSE_WAVE;
    f.t = 1;
    expect(peakStep(scene, layout, 1, 10)).toBeLessThan(limit);
  });
});

describe("corporate memphis schedule", () => {
  const layout = layoutFor(1920, 1080);

  it("changes one pose every 20 to 40 s", () => {
    const scene = sceneFor(layout, 5, 1);
    const start = scene.figures[0].to;
    let changedAt = -1;
    for (let k = 0; k < 41 * 30; k++) {
      stepScene(scene, layout, 1 / 30, params({ seed: 5, people: 1 }));
      if (changedAt < 0 && scene.figures[0].to !== start) {
        changedAt = k / 30;
      }
    }
    expect(changedAt).toBeGreaterThanOrEqual(19.9);
    expect(changedAt).toBeLessThanOrEqual(40.1);
  });

  it("holds still at Motion 0", () => {
    const scene = sceneFor(layout, 5);
    const before = scene.figures.map((f) => [f.from, f.to, f.t]);
    for (let k = 0; k < 60 * 30; k++) {
      stepScene(scene, layout, 1 / 30, params({ seed: 5, motion: 0 }));
    }
    expect(scene.figures.map((f) => [f.from, f.to, f.t])).toEqual(before);
  });

  it("high-fives only in pairs, and ends one when a partner leaves", () => {
    const scene = sceneFor(layout, 3);
    let seen = false;
    for (let k = 0; k < 400 && !seen; k++) {
      changePoseNow(scene, layout, 4);
      const [a, b] = scene.figures;
      expect(a.to === POSE_HIGH_FIVE).toBe(b.to === POSE_HIGH_FIVE);
      seen = a.to === POSE_HIGH_FIVE;
      for (const f of scene.figures) {
        f.t = 1;
      }
    }
    expect(seen).toBe(true);
    for (const f of scene.figures.slice(2)) {
      expect(f.to).toBeLessThan(SOLO_POSES);
    }
    stepScene(scene, layout, 1 / 30, params({ seed: 3, people: 1 }));
    expect(scene.figures[0].to).not.toBe(POSE_HIGH_FIVE);
    expect(scene.figures[1].to).not.toBe(POSE_HIGH_FIVE);
  });

  it("reverses a high five still reaching without a jump", () => {
    const scene = sceneFor(layout, 3);
    const [a] = scene.figures;
    a.from = 0;
    a.to = POSE_HIGH_FIVE;
    a.t = 0.4;
    scene.figures[1].from = 0;
    scene.figures[1].to = POSE_HIGH_FIVE;
    scene.figures[1].t = 0.4;
    const pose = new Float64Array(BLEND_SIZE);
    const before = Array.from(figurePose(scene, layout, 0, pose));
    // A portrait frame has no room for it.
    const tall = layoutFor(608, 1080);
    stepScene(scene, tall, 0, params({ seed: 3 }));
    expect(a.to).toBe(0);
    expect(a.from).toBe(POSE_HIGH_FIVE);
    const after = Array.from(figurePose(scene, layout, 0, pose));
    after.forEach((v, i) => {
      expect(v).toBeCloseTo(before[i], 9);
    });
  });

  it("fades people in and out with the slider", () => {
    const scene = sceneFor(layout, 1, 2);
    expect(scene.figures.map((f) => f.alpha)).toEqual([1, 1, 0, 0]);
    stepScene(scene, layout, 0.4, params({ people: 3 }));
    expect(scene.figures[2].alpha).toBeCloseTo(0.5, 6);
    stepScene(scene, layout, 1, params({ people: 3 }));
    expect(scene.figures[2].alpha).toBe(1);
  });

  it("fades through to a new variation", () => {
    const scene = sceneFor(layout, 1);
    stepScene(scene, layout, 0.3, params({ seed: 2 }));
    expect(scene.swap).toBeCloseTo(0.5, 6);
    expect(scene.seed).toBe(1);
    stepScene(scene, layout, 0.3, params({ seed: 2 }));
    expect(scene.seed).toBe(2);
    stepScene(scene, layout, 0.6, params({ seed: 2 }));
    expect(scene.swap).toBe(1);
  });
});
