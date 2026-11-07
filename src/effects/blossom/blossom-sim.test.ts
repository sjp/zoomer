import { describe, expect, it } from "vitest";
import {
  BACKDROP_FLOATS,
  BLOSSOM_FLOATS,
  BLOSSOM_PALETTES,
  blossomBudget,
  BLOSSOMS_PER_BRANCH,
  buildBranch,
  buildScene,
  createPetalSource,
  createPose,
  createShedder,
  KIND_BLOSSOM,
  MAX_BACKDROP,
  MAX_BLOSSOMS,
  MAX_PENDING,
  MAX_SEGMENTS_PER_BRANCH,
  PETAL_SEASONS,
  poseScene,
  REGION_H,
  REGION_W,
  type Scene,
  SEGMENT_FLOATS,
  SKIES,
  writeBackdrop,
  writeBlossoms,
  writeSegments,
} from "./blossom-sim";
import { createPieces, PIECE_FLOATS, type PieceFrame } from "../leaves/leaves-sim";

const SEEDS = [0, 1, 5, 42, 999];

/** Corner-space position of every blossom at rest (breeze 0, left side). */
const restPose = (scene: Scene) => {
  const pose = createPose(scene.segments.length, scene.blossoms.length);
  poseScene(scene, 0, 0, 1920, pose);
  return pose;
};

describe("buildBranch", () => {
  it("is deterministic per seed and varies between seeds", () => {
    expect(buildBranch(7, 0)).toEqual(buildBranch(7, 0));
    expect(buildBranch(8, 0)).not.toEqual(buildBranch(7, 0));
  });

  it("has one root, parents before children, and a few levels of twigs", () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const segs = buildBranch(seed, 0);
      if (segs.length < 20 || segs.length > MAX_SEGMENTS_PER_BRANCH) {
        bad.push(`count ${String(seed)}`);
      }
      if (segs.filter((s) => s.parent < 0).length !== 1) {
        bad.push(`roots ${String(seed)}`);
      }
      if (Math.max(...segs.map((s) => s.depth)) < 2) {
        bad.push(`depth ${String(seed)}`);
      }
      segs.forEach((s, i) => {
        if (s.parent >= i) {
          bad.push(`order ${String(seed)}:${String(i)}`);
        }
        if (s.parent >= 0 && s.depth < segs[s.parent].depth) {
          bad.push(`depth ${String(seed)}:${String(i)}`);
        }
        const hasChild = segs.some((c) => c.parent === i);
        if (hasChild === s.tip) {
          bad.push(`tip flag ${String(seed)}:${String(i)}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it("joins every segment to the end of its parent", () => {
    let worst = 0;
    for (const seed of SEEDS) {
      const segs = buildBranch(seed, 0);
      for (const s of segs) {
        if (s.parent < 0) {
          continue;
        }
        const p = segs[s.parent];
        worst = Math.max(worst, Math.hypot(s.x0 - p.x1, s.y0 - p.y1));
        worst = Math.max(worst, Math.abs(Math.hypot(s.x1 - s.x0, s.y1 - s.y0) - s.length));
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("tapers along every path", () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const segs = buildBranch(seed, 0);
      segs.forEach((s, i) => {
        if (!(s.r1 <= s.r0) || !(s.r1 > 0)) {
          bad.push(`${String(seed)}:${String(i)} ${String(s.r0)} -> ${String(s.r1)}`);
        }
        if (s.parent >= 0 && s.r0 > segs[s.parent].r1) {
          bad.push(`${String(seed)}:${String(i)} thicker than parent`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it("stays in its corner region", () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      for (const s of buildBranch(seed, 0)) {
        if (s.x1 + s.r1 > REGION_W || s.y1 + s.r1 > REGION_H) {
          bad.push(`${String(seed)}: ${String(s.x1)}, ${String(s.y1)}`);
        }
        if (s.x0 + s.r0 > REGION_W || s.y0 + s.r0 > REGION_H) {
          bad.push(`${String(seed)}: ${String(s.x0)}, ${String(s.y0)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("buildScene", () => {
  it("keeps every blossom attached to a segment and inside the region", () => {
    const bad: string[] = [];
    for (const seed of SEEDS) {
      const scene = buildScene("topLeft", seed, 2);
      const pose = restPose(scene);
      scene.blossoms.forEach((b, j) => {
        const s = scene.segments[b.segment];
        if (b.segment < 0 || b.segment >= scene.segments.length || b.t < 0 || b.t > 1) {
          bad.push(`${String(seed)}:${String(j)} detached`);
        }
        const x = pose.bx[j];
        const y = pose.by[j];
        if (x + b.radius > REGION_W || y + b.radius > REGION_H) {
          bad.push(`${String(seed)}:${String(j)} at ${String(x)}, ${String(y)}`);
        }
        // Its distance from the segment's axis is its offset across it.
        const ax = s.x0 + (s.x1 - s.x0) * b.t;
        const ay = s.y0 + (s.y1 - s.y0) * b.t;
        if (Math.abs(Math.hypot(x - ax, y - ay) - Math.abs(b.across)) > 1e-6) {
          bad.push(`${String(seed)}:${String(j)} off its segment`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it("puts more blossoms towards the tips", () => {
    let onTwigs = 0;
    let onMain = 0;
    for (const seed of SEEDS) {
      const scene = buildScene("topLeft", seed, 1);
      for (const b of scene.blossoms) {
        if (scene.segments[b.segment].depth >= 2) {
          onTwigs++;
        } else if (scene.segments[b.segment].depth === 0) {
          onMain++;
        }
      }
    }
    expect(onTwigs).toBeGreaterThan(onMain * 3);
  });

  it("caps the total blossom count, one branch or both", () => {
    expect(blossomBudget("topLeft", 1)).toBe(BLOSSOMS_PER_BRANCH);
    for (const corner of ["topLeft", "topRight", "both"] as const) {
      for (const density of [0.3, 1, 2, 50]) {
        const scene = buildScene(corner, 3, density);
        expect(scene.blossoms.length).toBeLessThanOrEqual(MAX_BLOSSOMS);
        expect(scene.blossoms.length).toBe(
          blossomBudget(corner, density) * (corner === "both" ? 2 : 1),
        );
      }
    }
    expect(buildScene("both", 3, 2).blossoms.length).toBe(MAX_BLOSSOMS);
  });

  it("builds two different branches for both corners, and keeps them when the density changes", () => {
    const both = buildScene("both", 4, 1);
    const left = both.segments.filter((s) => s.side === 0);
    const right = both.segments.filter((s) => s.side === 1);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    expect(right.map((s) => s.x1)).not.toEqual(left.map((s) => s.x1).slice(0, right.length));
    expect(buildScene("both", 4, 1.8).segments).toEqual(both.segments);
    expect(both.open.every((j) => both.blossoms[j].kind === KIND_BLOSSOM)).toBe(true);
  });
});

describe("poseScene", () => {
  const scene = buildScene("topLeft", 5, 1);
  const pose = createPose(scene.segments.length, scene.blossoms.length);
  const tips = scene.segments.flatMap((s, i) => (s.tip && s.depth >= 2 ? [i] : []));
  const main = scene.segments.flatMap((s, i) => (s.depth === 0 ? [i] : []));

  it("is the rest pose without a breeze", () => {
    poseScene(scene, 0.37, 0, 1920, pose);
    let worst = 0;
    scene.segments.forEach((s, i) => {
      worst = Math.max(worst, Math.abs(pose.ex[i] - s.x1), Math.abs(pose.ey[i] - s.y1));
    });
    expect(worst).toBeLessThan(1e-9);
  });

  it("is continuous in phase, across the wrap too", () => {
    const step = 1e-4;
    const a = createPose(scene.segments.length, scene.blossoms.length);
    let worst = 0;
    for (let k = 0; k <= 200; k++) {
      const ph = k / 200 - step / 2;
      poseScene(scene, ph, 1, 1920, a);
      poseScene(scene, ph + step, 1, 1920, pose);
      for (let j = 0; j < scene.blossoms.length; j++) {
        worst = Math.max(worst, Math.hypot(a.bx[j] - pose.bx[j], a.by[j] - pose.by[j]));
      }
    }
    // 6 ms of swell at speed 1: well under a pixel.
    expect(worst).toBeLessThan(0.2);
  });

  it("sways most at the tips, and the main branch barely at all", () => {
    const most = new Float64Array(scene.segments.length);
    for (let k = 0; k < 400; k++) {
      poseScene(scene, k / 400, 1, 1920, pose);
      scene.segments.forEach((s, i) => {
        most[i] = Math.max(most[i], Math.hypot(pose.ex[i] - s.x1, pose.ey[i] - s.y1));
      });
    }
    const mean = (ids: number[]) => ids.reduce((s, i) => s + most[i], 0) / ids.length;
    expect(mean(tips)).toBeGreaterThan(2 * mean(main));
    expect(Math.min(...tips.map((i) => most[i]))).toBeGreaterThan(most[main[0]]);
    // Gentle: tens of pixels at most at full breeze.
    expect(Math.max(...most)).toBeLessThan(80);
  });

  it("mirrors the right-hand branch", () => {
    const right = buildScene("topRight", 9, 1);
    const left = { ...right, segments: right.segments.map((s) => ({ ...s, side: 0 })) };
    const pl = createPose(left.segments.length, left.blossoms.length);
    const pr = createPose(right.segments.length, right.blossoms.length);
    poseScene(left, 0.2, 0.5, 1600, pl);
    poseScene(right, 0.2, 0.5, 1600, pr);
    let worst = 0;
    for (let j = 0; j < left.blossoms.length; j++) {
      worst = Math.max(
        worst,
        Math.abs(pl.bx[j] - (1600 - pr.bx[j])),
        Math.abs(pl.by[j] - pr.by[j]),
      );
    }
    expect(worst).toBeLessThan(1e-9);
  });
});

describe("writers", () => {
  it("write every segment and blossom in device px, mirrored on the right", () => {
    const scene = buildScene("both", 2, 1);
    const pose = createPose(scene.segments.length, scene.blossoms.length);
    poseScene(scene, 0.4, 0.6, 1920, pose);
    const segData = new Float32Array(scene.segments.length * SEGMENT_FLOATS);
    expect(writeSegments(scene, pose, 1920, 2, segData)).toBe(scene.segments.length);
    const bad: string[] = [];
    scene.segments.forEach((s, i) => {
      const x = segData[i * SEGMENT_FLOATS + 2] / 2;
      const want = s.side === 1 ? 1920 - pose.ex[i] : pose.ex[i];
      if (Math.abs(x - want) > 1e-3) {
        bad.push(`segment ${String(i)}`);
      }
      if (segData[i * SEGMENT_FLOATS + 5] > segData[i * SEGMENT_FLOATS + 4]) {
        bad.push(`taper ${String(i)}`);
      }
    });
    const data = new Float32Array(scene.blossoms.length * BLOSSOM_FLOATS);
    expect(writeBlossoms(scene, pose, BLOSSOM_PALETTES.deep, 2, data)).toBe(scene.blossoms.length);
    scene.blossoms.forEach((b, j) => {
      const o = j * BLOSSOM_FLOATS;
      if (Math.abs(data[o] - pose.bx[j] * 2) > 1e-3) {
        bad.push(`blossom ${String(j)}`);
      }
      if (data[o + 7] !== b.kind) {
        bad.push(`kind ${String(j)}`);
      }
      for (let k = 4; k < 7; k++) {
        if (!(data[o + k] >= 0 && data[o + k] <= 1)) {
          bad.push(`colour ${String(j)}`);
        }
      }
    });
    expect(bad).toEqual([]);
  });

  it("keeps the backdrop tree to the side, clear of the speaker", () => {
    const data = new Float32Array(MAX_BACKDROP * BACKDROP_FLOATS);
    for (const side of [0, 1]) {
      const n = writeBackdrop(data, side, 12, 1920, 1, SKIES.dusk, BLOSSOM_PALETTES.pink);
      expect(n).toBe(MAX_BACKDROP);
      for (let b = 0; b < n; b++) {
        const x = data[b * BACKDROP_FLOATS];
        expect(side === 0 ? x < 0.35 * 1920 : x > 0.65 * 1920).toBe(true);
      }
    }
  });
});

describe("createShedder", () => {
  it("sheds at the requested rate on average", () => {
    for (const rate of [0.5, 2, 4]) {
      const shedder = createShedder(11);
      let shed = 0;
      const seconds = 2000;
      for (let k = 0; k < seconds * 30; k++) {
        shedder.advance(1 / 30, rate);
        while (shedder.take()) {
          shed++;
        }
      }
      expect(Math.abs(shed / seconds - rate) / rate).toBeLessThan(0.05);
    }
  });

  it("sheds nothing at rate 0 and holds at most a few petals back", () => {
    const shedder = createShedder(1);
    shedder.advance(100, 0);
    expect(shedder.pending).toBe(0);
    shedder.advance(100, 4);
    expect(shedder.pending).toBe(MAX_PENDING);
    shedder.advance(Number.NaN, 4);
    expect(shedder.pending).toBe(MAX_PENDING);
  });
});

describe("createPetalSource", () => {
  it("starts shed petals at blossom positions, at the shed rate", () => {
    const state = { scene: buildScene("topRight", 6, 1), pose: createPose(0, 0) };
    state.pose = createPose(state.scene.segments.length, state.scene.blossoms.length);
    const shedder = createShedder(3);
    const source = createPetalSource(shedder, 4, state);
    const bad: string[] = [];
    let spawned = 0;
    const pieces = createPieces(160, 1920, 2, {
      spawn(out, layer) {
        if (!source(out, layer)) {
          return false;
        }
        spawned++;
        if (layer === 0) {
          bad.push("far layer");
        }
        const at = state.scene.open.some(
          (j) => state.pose.bx[j] === out.x && state.pose.by[j] === out.y,
        );
        if (!at) {
          bad.push(`spawned at ${String(out.x)}, ${String(out.y)}`);
        }
        return true;
      },
    });
    const f: PieceFrame = {
      refWidth: 1920,
      scale: 1,
      season: PETAL_SEASONS.pink,
      count: 160,
      size: 6,
      speed: 0.8,
      wind: -0.2,
      gusts: 0.2,
      hazeTop: SKIES.morning.top,
      hazeBottom: SKIES.morning.bottom,
    };
    const data = new Float32Array(160 * PIECE_FLOATS);
    const rate = 2;
    let phase = 0;
    const seconds = 240;
    const dt = 1 / 10;
    for (let k = 0; k < seconds / dt; k++) {
      phase = (phase + dt / 60) % 1;
      poseScene(state.scene, phase, 0.6, 1920, state.pose);
      shedder.advance(dt, rate);
      pieces.step(dt, f, data, PIECE_FLOATS);
    }
    expect(bad).toEqual([]);
    expect(Math.abs(spawned / seconds - rate) / rate).toBeLessThan(0.1);
  });
});
