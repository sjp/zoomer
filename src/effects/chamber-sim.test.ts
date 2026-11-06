import { describe, expect, it } from "vitest";
import {
  ALPHA,
  ALPHA_LENGTH,
  CENTRE_HALF,
  CENTRE_KEEP,
  createChamber,
  createEventSchedule,
  createTrackPose,
  ELECTRON,
  FRAME_MARGIN,
  MAX_POINTS,
  MAX_TRACKS,
  MIN_LENGTH,
  MIX_WEIGHTS,
  MUON,
  MUON_MIN,
  pickKind,
  REF_HEIGHT,
  SCHEDULE_MAX_LAG,
  SPIRAL_MIN_RADIUS,
  spawnTrack,
  spiralRadius,
  stepChamber,
  takeEvent,
  trackAt,
  trackEnvelope,
  type Track,
  type TrackKind,
} from "./chamber-sim";
import { createRng } from "./noise";

/** Event times from 0 to `t1` (s), polled every `dt`. */
function collect(seed: number, rate: number, t1: number, dt = 1 / 30): number[] {
  const s = createEventSchedule(seed);
  const out: number[] = [];
  for (let t = 0; t <= t1; t += dt) {
    for (let at = takeEvent(s, t, rate); !Number.isNaN(at); at = takeEvent(s, t, rate)) {
      out.push(at);
    }
  }
  return out;
}

/** A fresh track, as the chamber's pool makes them. */
const newTrack = (): Track => createChamber(0).list[0];

describe("event schedule", () => {
  it("is deterministic for a seed and differs between seeds", () => {
    expect(collect(4, 1.5, 120)).toEqual(collect(4, 1.5, 120));
    expect(collect(4, 1.5, 120)).not.toEqual(collect(5, 1.5, 120));
  });

  it("matches the rate on average", () => {
    const rate = 2;
    const span = 2000;
    const n = collect(9, rate, span, 0.5).length;
    // Poisson: sd = sqrt(4000) ~ 63, so ±5% is about 3 sd.
    expect(Math.abs(n / (rate * span) - 1)).toBeLessThan(0.05);
  });

  it("schedules nothing at rate 0 and drops a stale backlog", () => {
    const s = createEventSchedule(1);
    expect(takeEvent(s, 0, 0)).toBeNaN();
    expect(takeEvent(s, 1, 1)).toBeNaN();
    let released = 0;
    let stale = 0;
    for (let at = takeEvent(s, 1000, 1); !Number.isNaN(at); at = takeEvent(s, 1000, 1)) {
      if (at < 1000 - SCHEDULE_MAX_LAG) {
        stale++;
      }
      released++;
    }
    expect(stale).toBe(0);
    expect(released).toBeLessThan(10);
  });
});

describe("particle mix", () => {
  it("has weights summing to one", () => {
    for (const w of Object.values(MIX_WEIGHTS)) {
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 9);
    }
  });

  it("matches the mix on average in a running chamber", () => {
    for (const mix of ["natural", "alpha", "muon"] as const) {
      const c = createChamber(11);
      for (let t = 0; t <= 600; t += 0.25) {
        stepChamber(c, t, 4, mix, false, 1920);
      }
      const total = c.started[0] + c.started[1] + c.started[2];
      const w = MIX_WEIGHTS[mix];
      let worst = 0;
      for (let k = 0; k < 3; k++) {
        worst = Math.max(worst, Math.abs(c.started[k] / total - w[k]));
      }
      expect(total).toBeGreaterThan(1500);
      expect(worst).toBeLessThan(0.04);
    }
  });

  it("falls back to the natural mix for an unknown id", () => {
    expect(pickKind("nope", 0.29)).toBe(ALPHA);
    expect(pickKind("nope", 0.5)).toBe(ELECTRON);
    expect(pickKind("nope", 0.9)).toBe(MUON);
  });
});

/** Spawns `n` tracks of `kind` and returns them (copied), with how many spawns failed. */
function spawnMany(kind: TrackKind, magnetic: boolean, n: number, w = 1920, seed = 3) {
  const rand = createRng(seed);
  const tracks: { pts: Float32Array; count: number; length: number; spiral: boolean }[] = [];
  let failed = 0;
  const tr = newTrack();
  for (let i = 0; i < n; i++) {
    if (!spawnTrack(tr, kind, 0, w, magnetic, rand)) {
      failed++;
      continue;
    }
    tracks.push({
      pts: tr.pts.slice(0, tr.count * 2),
      count: tr.count,
      length: tr.length,
      spiral: tr.spiral,
    });
  }
  return { tracks, failed };
}

describe("track geometry", () => {
  it("keeps every polyline continuous, in frame and within the point limit", () => {
    const bad: string[] = [];
    let checked = 0;
    // Points are stored as float32, so allow a hair past the margin.
    const lo = FRAME_MARGIN - 0.01;
    for (const w of [1440, 1920, 2520]) {
      for (const kind of [ALPHA, ELECTRON, MUON] as const) {
        for (const magnetic of [false, true]) {
          const { tracks, failed } = spawnMany(kind, magnetic, 120, w);
          const where = `${String(w)} ${String(kind)} ${String(magnetic)}`;
          if (failed > 6) {
            bad.push(`${where}: ${String(failed)} failed`);
          }
          for (const t of tracks) {
            checked++;
            if (t.count < 2 || t.count > MAX_POINTS || t.length < MIN_LENGTH) {
              bad.push(`${where}: ${String(t.count)} points, ${String(t.length)} long`);
            }
            let sum = 0;
            for (let i = 0; i < t.count; i++) {
              const x = t.pts[2 * i];
              const y = t.pts[2 * i + 1];
              if (!(x >= lo && x <= w - lo && y >= lo && y <= REF_HEIGHT - lo)) {
                bad.push(`${where}: (${String(x)}, ${String(y)}) out of frame`);
              }
              if (i === 0) {
                continue;
              }
              const step = Math.hypot(x - t.pts[2 * i - 2], y - t.pts[2 * i - 1]);
              // Continuous: no zero-length steps, and electrons step at most 14 px.
              if (!(step > 0) || (kind === ELECTRON && step > 14.01)) {
                bad.push(`${where}: step ${String(step)}`);
              }
              sum += step;
            }
            if (Math.abs(sum - t.length) > 0.01 * t.length + 0.1) {
              bad.push(`${where}: length`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });

  it("makes alphas short and straight, muons long and electrons wiggly", () => {
    const alphas = spawnMany(ALPHA, true, 100).tracks;
    const muons = spawnMany(MUON, false, 100).tracks;
    const electrons = spawnMany(ELECTRON, false, 100).tracks;
    let bad = 0;
    for (const t of alphas) {
      if (t.count !== 2 || t.length < ALPHA_LENGTH[0] - 0.01 || t.length > ALPHA_LENGTH[1] + 0.01) {
        bad++;
      }
    }
    for (const t of muons) {
      if (t.count !== 2 || t.length < MUON_MIN - 0.01) {
        bad++;
      }
    }
    let wiggle = 0;
    for (const t of electrons) {
      const n = t.count - 1;
      const chord = Math.hypot(t.pts[2 * n] - t.pts[0], t.pts[2 * n + 1] - t.pts[1]);
      wiggle += chord / t.length;
    }
    expect(bad).toBe(0);
    // Wiggly on average, though not a tangle.
    const mean = wiggle / electrons.length;
    expect(mean).toBeLessThan(0.9);
    expect(mean).toBeGreaterThan(0.3);
  });

  it("spirals electrons in the field, tightening monotonically", () => {
    const { tracks } = spawnMany(ELECTRON, true, 150);
    let bad = 0;
    let longOnes = 0;
    let complete = 0;
    for (const t of tracks) {
      if (!t.spiral) {
        bad++;
      }
      if (t.count < 12) {
        continue;
      }
      longOnes++;
      // Curvature (turn per unit length) from successive points must not fall.
      let prev = 0;
      let total = 0;
      for (let i = 1; i + 1 < t.count; i++) {
        const ax = t.pts[2 * i] - t.pts[2 * i - 2];
        const ay = t.pts[2 * i + 1] - t.pts[2 * i - 1];
        const bx = t.pts[2 * i + 2] - t.pts[2 * i];
        const by = t.pts[2 * i + 3] - t.pts[2 * i + 1];
        const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
        // Each step turns before it moves, so its turn belongs to its own length.
        const k = turn / Math.hypot(bx, by);
        if (k < prev * 0.97 - 1e-4) {
          bad++;
        }
        prev = Math.max(prev, k);
        total += turn;
      }
      // One that tightened to its smallest radius (the frame didn't cut it short)
      // turned all the way round at least once.
      if (prev > 1 / (1.5 * SPIRAL_MIN_RADIUS)) {
        complete++;
        if (total < 2 * Math.PI) {
          bad++;
        }
      }
    }
    expect(longOnes).toBeGreaterThan(100);
    expect(complete).toBeGreaterThan(longOnes / 2);
    expect(bad).toBe(0);
  });

  it("has a spiral radius that never grows", () => {
    let prev = Infinity;
    let ok = true;
    for (let s = 0; s <= 1000; s += 5) {
      const r = spiralRadius(200, 800, s);
      if (r > prev) {
        ok = false;
      }
      prev = r;
    }
    expect(ok).toBe(true);
  });

  it("spawns fewer tracks in the central band", () => {
    const rand = createRng(5);
    const tr = newTrack();
    const w = 1920;
    let centre = 0;
    let total = 0;
    for (let i = 0; i < 3000; i++) {
      if (!spawnTrack(tr, ALPHA, 0, w, false, rand)) {
        continue;
      }
      const mx = 0.5 * (tr.pts[0] + tr.pts[2]);
      total++;
      if (Math.abs(mx / w - 0.5) < CENTRE_HALF) {
        centre++;
      }
    }
    // Uniform anchors would put 2 * CENTRE_HALF of them in the band; keeping
    // CENTRE_KEEP of those cuts that share to well under 60% of it.
    const uniform = 2 * CENTRE_HALF;
    const kept = (uniform * CENTRE_KEEP) / (uniform * CENTRE_KEEP + 1 - uniform);
    expect(Math.abs(centre / total - kept)).toBeLessThan(0.03);
    expect(kept).toBeLessThan(0.6 * uniform);
  });

  it("keeps tracks inside a narrow frame's margin", () => {
    const { tracks } = spawnMany(ELECTRON, false, 50, 4 * FRAME_MARGIN + 300);
    expect(tracks.length).toBeGreaterThan(30);
  });
});

describe("track look", () => {
  it("starts and ends the envelope at zero and never exceeds one", () => {
    let bad = 0;
    for (const [grow, life] of [
      [0.2, 3],
      [0.45, 2],
      [0.12, 4.5],
    ]) {
      if (trackEnvelope(0, grow, life) !== 0 || trackEnvelope(life, grow, life) !== 0) {
        bad++;
      }
      if (trackEnvelope(-1, grow, life) !== 0 || trackEnvelope(life + 1, grow, life) !== 0) {
        bad++;
      }
      if (!(trackEnvelope(1e-3, grow, life) < 0.01)) {
        bad++;
      }
      if (!(trackEnvelope(life - 1e-3, grow, life) < 0.01)) {
        bad++;
      }
      if (Math.abs(trackEnvelope(grow, grow, life) - 1) > 1e-9) {
        bad++;
      }
      for (let a = 0; a <= life; a += 0.01) {
        const e = trackEnvelope(a, grow, life);
        if (!(e >= 0 && e <= 1)) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("reveals the path over its growth time, then widens and drifts", () => {
    const rand = createRng(8);
    const tr = newTrack();
    expect(spawnTrack(tr, ELECTRON, 10, 1920, false, rand)).toBe(true);
    const pose = createTrackPose();
    trackAt(tr, 10, pose);
    expect(pose.reveal).toBe(0);
    expect(pose.brightness).toBe(0);
    trackAt(tr, 10 + tr.grow / 2, pose);
    expect(pose.reveal).toBeGreaterThan(0);
    expect(pose.reveal).toBeLessThan(tr.length);
    const w0 = tr.halfWidth;
    trackAt(tr, 10 + tr.grow, pose);
    expect(pose.reveal).toBeCloseTo(tr.length, 6);
    expect(pose.halfWidth).toBeCloseTo(w0, 9);
    trackAt(tr, 10 + tr.life * 0.9, pose);
    expect(pose.halfWidth).toBeGreaterThan(w0 * 1.5);
    expect(Math.hypot(pose.dx, pose.dy)).toBeGreaterThan(0);
    trackAt(tr, 10 + tr.life, pose);
    expect(pose.brightness).toBe(0);
  });
});

describe("chamber", () => {
  it("is deterministic for a seed", () => {
    const run = (seed: number) => {
      const c = createChamber(seed);
      for (let t = 0; t <= 60; t += 1 / 30) {
        stepChamber(c, t, 2, "natural", true, 1920);
      }
      return [c.count, ...c.started, c.list[0].pts[0], c.list[0].start];
    };
    expect(run(4)).toEqual(run(4));
    expect(run(4)).not.toEqual(run(5));
  });

  it("retires faded tracks and never exceeds the pool", () => {
    const c = createChamber(2);
    let over = false;
    let last = 0;
    for (let t = 0; t <= 120; t += 0.1) {
      stepChamber(c, t, 6, "alpha", false, 1920);
      if (c.count > MAX_TRACKS) {
        over = true;
      }
      last = t;
    }
    expect(over).toBe(false);
    let stale = 0;
    for (let i = 0; i < c.count; i++) {
      if (last - c.list[i].start >= c.list[i].life) {
        stale++;
      }
    }
    expect(c.count).toBeGreaterThan(0);
    expect(stale).toBe(0);
    stepChamber(c, 200, 0, "alpha", false, 1920);
    expect(c.count).toBe(0);
  });
});
