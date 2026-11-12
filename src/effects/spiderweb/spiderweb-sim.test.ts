import { describe, expect, it } from "vitest";
import {
  backdropPositions,
  bowLowestT,
  buildBackdrop,
  buildWeb,
  DROP_FLOATS,
  dropGlint,
  dropLowness,
  KIND_ANCHOR,
  KIND_HUB,
  KIND_SPIRAL,
  LIGHTS,
  MAX_BLOBS,
  REF_HEIGHT,
  swayOffset,
  THREAD_FLOATS,
  type WebCorner,
  type WebFrame,
  type WebGeometry,
  webRadius,
  webTilt,
  writeDrops,
  writeThreads,
  RADIUS_FLOOR,
} from "./spiderweb-sim";

const CORNERS: WebCorner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];
/** 4:3, 16:9 and 21:9 at 1080 reference px tall. */
const WIDTHS = [1440, 1920, 2520];

const frame = (over: Partial<WebFrame> = {}): WebFrame => ({
  time: 0,
  sway: 1,
  dew: 1,
  scale: 1,
  light: LIGHTS.dawn,
  ...over,
});

const threadsOut = (g: WebGeometry) => new Float32Array(g.segments * THREAD_FLOATS);
const dropsOut = (g: WebGeometry) => new Float32Array(g.drops * DROP_FLOATS);

/** Even-odd point-in-polygon against a ring of x, y pairs. */
function inside(ring: Float32Array, x: number, y: number): boolean {
  let c = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      c = !c;
    }
  }
  return c;
}

describe("web geometry", () => {
  it("is deterministic per seed and has 20–30 spokes", () => {
    const a = buildWeb({ corner: "topLeft", size: 0.6, seed: 3, refWidth: 1920 });
    const b = buildWeb({ corner: "topLeft", size: 0.6, seed: 3, refWidth: 1920 });
    const c = buildWeb({ corner: "topLeft", size: 0.6, seed: 4, refWidth: 1920 });
    expect(Array.from(a.ax)).toEqual(Array.from(b.ax));
    expect(Array.from(a.dropR)).toEqual(Array.from(b.dropR));
    expect(Array.from(a.ax)).not.toEqual(Array.from(c.ax));
    let bad = 0;
    for (let seed = 0; seed < 30; seed++) {
      const g = buildWeb({ corner: "topLeft", size: 0.6, seed, refWidth: 1920 });
      if (g.spokes < 20 || g.spokes > 30) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("keeps the spiral and hub threads inside the frame of spokes", () => {
    let bad = 0;
    let checked = 0;
    for (const corner of CORNERS) {
      for (let seed = 0; seed < 8; seed++) {
        const g = buildWeb({ corner, size: seed / 7, seed, refWidth: 1920 });
        for (let i = 0; i < g.segments; i++) {
          if (g.kind[i] !== KIND_SPIRAL && g.kind[i] !== KIND_HUB) {
            continue;
          }
          checked++;
          if (!inside(g.frameRing, g.ax[i], g.ay[i]) || !inside(g.frameRing, g.bx[i], g.by[i])) {
            bad++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });

  it("puts many spiral threads around the hub", () => {
    const g = buildWeb({ corner: "topRight", size: 0.6, seed: 9, refWidth: 1920 });
    let spiral = 0;
    for (let i = 0; i < g.segments; i++) {
      if (g.kind[i] === KIND_SPIRAL) {
        spiral++;
      }
    }
    expect(spiral).toBeGreaterThan(600);
    expect(g.segments).toBeLessThan(4096);
  });

  it("stays inside its corner at 4:3, 16:9 and 21:9 as it sways", () => {
    let bad = 0;
    const slack = 8;
    for (const refWidth of WIDTHS) {
      for (const corner of CORNERS) {
        for (let seed = 0; seed < 4; seed++) {
          const g = buildWeb({ corner, size: 1, seed, refWidth });
          // The speaker's middle third stays clear, and so does the far half of the height.
          const right = corner.endsWith("Right");
          if (right ? g.boxX0 < (refWidth * 2) / 3 - 1e-3 : g.boxX1 > refWidth / 3 + 1e-3) {
            bad++;
          }
          if (g.boxY1 - g.boxY0 > REF_HEIGHT * 0.65) {
            bad++;
          }
          const out = threadsOut(g);
          for (let t = 0; t < 60; t += 2.5) {
            const n = writeThreads(g, frame({ time: t }), out);
            let worst = 0;
            for (let i = 0; i < n; i++) {
              const o = i * THREAD_FLOATS;
              for (const k of [0, 2]) {
                const x = out[o + k];
                const y = out[o + k + 1];
                worst = Math.max(worst, g.boxX0 - x, x - g.boxX1, g.boxY0 - y, y - g.boxY1);
              }
            }
            if (worst > slack) {
              bad++;
            }
          }
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("shrinks to fit narrow frames", () => {
    expect(webRadius(1, 1440)).toBeLessThan(webRadius(1, 1920));
    expect(webRadius(0, 2520)).toBeLessThan(webRadius(1, 2520));
  });
});

describe("dew", () => {
  it("lies on the threads as they sway", () => {
    const g = buildWeb({ corner: "bottomLeft", size: 0.7, seed: 2, refWidth: 1920 });
    const threads = threadsOut(g);
    const drops = dropsOut(g);
    let worst = 0;
    for (let t = 0; t < 30; t += 3.7) {
      const f = frame({ time: t, scale: 2 });
      writeThreads(g, f, threads);
      const n = writeDrops(g, f, drops);
      for (let i = 0; i < n; i++) {
        const seg = g.dropSeg[i];
        const o = seg * THREAD_FLOATS;
        const ax = threads[o];
        const ay = threads[o + 1];
        const ex = threads[o + 2] - ax;
        const ey = threads[o + 3] - ay;
        const px = drops[i * DROP_FLOATS] - ax;
        const py = drops[i * DROP_FLOATS + 1] - ay;
        const len = Math.hypot(ex, ey);
        const along = (px * ex + py * ey) / len;
        const across = Math.abs(px * ey - py * ex) / len;
        worst = Math.max(worst, across, -along, along - len);
      }
    }
    expect(g.drops).toBeGreaterThan(1500);
    expect(worst).toBeLessThan(1e-2);
  });

  it("thins out with the dew param, keeping the same drops", () => {
    const g = buildWeb({ corner: "topLeft", size: 0.6, seed: 1, refWidth: 1920 });
    const out = dropsOut(g);
    const all = writeDrops(g, frame({ dew: 1 }), out);
    const half = writeDrops(g, frame({ dew: 0.5 }), out);
    const none = writeDrops(g, frame({ dew: 0 }), out);
    expect(all).toBe(g.drops);
    expect(half / all).toBeGreaterThan(0.4);
    expect(half / all).toBeLessThan(0.6);
    expect(none).toBe(0);
  });

  it("collects at the bottom of each bow", () => {
    // A horizontal bowed thread is lowest at its middle; a rising one, nearer its low end.
    expect(bowLowestT(0, 3)).toBe(0.5);
    expect(bowLowestT(-10, 3)).toBeLessThan(0.5);
    expect(bowLowestT(10, 3)).toBeGreaterThan(0.5);
    expect(bowLowestT(5, 0)).toBe(1);
    expect(dropLowness(0.5, 0.5, 3)).toBe(1);
    expect(dropLowness(0.1, 0.5, 3)).toBeLessThan(0.1);
    expect(dropLowness(0.5, 0.5, 0.12)).toBeCloseTo(0.1);
  });

  it("makes drops at the bottom of sagging spiral threads bigger on average", () => {
    const g = buildWeb({ corner: "topLeft", size: 1, seed: 5, refWidth: 1920 });
    let mid = 0;
    let midN = 0;
    let ends = 0;
    let endsN = 0;
    const firstSpiral = g.kind.indexOf(KIND_SPIRAL);
    for (let i = 0; i < g.drops; i++) {
      const seg = g.dropSeg[i];
      if (g.kind[seg] !== KIND_SPIRAL) {
        continue;
      }
      // Spiral threads come last, three pieces each. On a near-level thread at
      // least 30 px long, the middle piece holds the bow's bottom.
      const piece = (seg - firstSpiral) % 3;
      const a = seg - piece;
      const dx = g.bx[a + 2] - g.ax[a];
      const dy = g.by[a + 2] - g.ay[a];
      if (Math.abs(dy) > 0.05 * Math.abs(dx) || Math.abs(dx) < 30) {
        continue;
      }
      if (piece === 1) {
        mid += g.dropR[i];
        midN++;
      } else {
        ends += g.dropR[i];
        endsN++;
      }
    }
    expect(midN).toBeGreaterThan(20);
    expect(endsN).toBeGreaterThan(20);
    expect(mid / midN).toBeGreaterThan((ends / endsN) * 1.15);
  });

  it("glints between a floor and 1, twinkling as the web tilts", () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = 0; p < 6.3; p += 0.05) {
      const v = dropGlint(p, 0);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeCloseTo(0.2, 3);
    expect(hi).toBeCloseTo(1, 3);
    // Over a minute of full sway, a drop's glint passes through most of its range.
    let gLo = Infinity;
    let gHi = -Infinity;
    for (let t = 0; t < 60; t += 0.25) {
      const v = dropGlint(1, webTilt(t, 1));
      gLo = Math.min(gLo, v);
      gHi = Math.max(gHi, v);
    }
    expect(gHi - gLo).toBeGreaterThan(0.6);
  });
});

describe("sway", () => {
  it("is continuous and zero at sway 0", () => {
    const a: [number, number] = [0, 0];
    const b: [number, number] = [0, 0];
    let worst = 0;
    let tiltJump = 0;
    for (let t = 0; t < 600; t += 0.37) {
      swayOffset(t, 1, a);
      swayOffset(t + 1 / 120, 1, b);
      worst = Math.max(worst, Math.hypot(b[0] - a[0], b[1] - a[1]));
      tiltJump = Math.max(tiltJump, Math.abs(webTilt(t + 1 / 120, 1) - webTilt(t, 1)));
    }
    // Under 0.1 reference px per 120 Hz frame at full sway.
    expect(worst).toBeLessThan(0.1);
    expect(tiltJump).toBeLessThan(0.01);
    swayOffset(12.3, 0, a);
    expect(Math.hypot(a[0], a[1])).toBe(0);
  });

  it("moves the hub most and never moves the anchors", () => {
    const g = buildWeb({ corner: "topRight", size: 0.6, seed: 8, refWidth: 1920 });
    const out = threadsOut(g);
    writeThreads(g, frame({ time: 0 }), out);
    const before = Float32Array.from(out);
    writeThreads(g, frame({ time: 7.3 }), out);
    let anchors = 0;
    let anchorMoved = 0;
    let hubMove = 0;
    let frameMove = 0;
    for (let i = 0; i < g.segments; i++) {
      const o = i * THREAD_FLOATS;
      const moved = Math.hypot(out[o] - before[o], out[o + 1] - before[o + 1]);
      if (g.kind[i] === KIND_ANCHOR && g.aw[i] === 0) {
        anchors++;
        anchorMoved = Math.max(anchorMoved, moved);
      }
      if (g.aw[i] === 1) {
        hubMove = Math.max(hubMove, moved);
      }
      if (g.kind[i] === KIND_ANCHOR && g.aw[i] > 0) {
        frameMove = Math.max(frameMove, moved);
      }
    }
    expect(anchors).toBeGreaterThanOrEqual(3);
    expect(anchorMoved).toBe(0);
    expect(hubMove).toBeGreaterThan(1);
    expect(hubMove).toBeGreaterThan(frameMove * 2);
  });
});

describe("backdrop", () => {
  it("is deterministic, bounded and drifts only a little", () => {
    const a = buildBackdrop(LIGHTS.dawn, "topLeft", 4, 1920);
    const b = buildBackdrop(LIGHTS.dawn, "topLeft", 4, 1920);
    expect(Array.from(a.base)).toEqual(Array.from(b.base));
    expect(a.count).toBeLessThanOrEqual(MAX_BLOBS);
    const out = new Float32Array(MAX_BLOBS * 4);
    let worst = 0;
    for (let t = 0; t < 1000; t += 13) {
      backdropPositions(a, t, out);
      for (let i = 0; i < a.count; i++) {
        worst = Math.max(
          worst,
          Math.hypot(out[i * 4] - a.base[i * 4], out[i * 4 + 1] - a.base[i * 4 + 1]),
        );
      }
    }
    expect(worst).toBeLessThanOrEqual(16);
  });

  it("puts the highlights toward the sun's side", () => {
    const meanX = (corner: WebCorner) => {
      const b = buildBackdrop(LIGHTS.cool, corner, 2, 1920);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < b.count; i++) {
        if (b.base[i * 4 + 3] !== 1) {
          continue;
        }
        sum += b.base[i * 4];
        n++;
      }
      return sum / n;
    };
    expect(meanX("topLeft")).toBeLessThan(960);
    expect(meanX("bottomRight")).toBeGreaterThan(960);
  });
});

describe("narrow canvases", () => {
  it.each([1, 40, 80, 200])("builds a bounded web at reference width %d", (refWidth) => {
    for (const corner of ["topLeft", "bottomRight"] as const) {
      const g = buildWeb({ corner, size: 1, seed: 5, refWidth });
      expect(g.segments).toBeGreaterThan(0);
      // The renderer's buffers hold 4096 segments and 8192 drops.
      expect(g.segments).toBeLessThan(4096);
      expect(g.drops).toBeLessThan(8192);
      expect(Number.isFinite(g.ax[0]) && Number.isFinite(g.by[g.segments - 1])).toBe(true);
    }
  });

  it("never shrinks the web below its floor", () => {
    expect(webRadius(1, 60)).toBe(RADIUS_FLOOR);
    expect(webRadius(0, 1)).toBe(RADIUS_FLOOR);
    expect(webRadius(1, Number.NaN)).toBe(RADIUS_FLOOR);
  });
});
