import { describe, expect, it } from "vitest";
import {
  argumentAt,
  consoleStates,
  COUNTDOWN,
  countdownText,
  createConsoleScratch,
  createLaunchState,
  createTrackEdges,
  EARTH_RATIO,
  fillTrackRow,
  FIRST_LIFTOFF,
  groundTrack,
  LAUNCH_SITE,
  launchAt,
  launchOrbit,
  liftoffTime,
  localTimeText,
  missionOffset,
  missionOrbit,
  missionTimeText,
  NO_TRACK,
  type Orbit,
  orbitNumber,
  padReset,
  stepLaunch,
  rocketClimb,
  timeAtArgument,
  TRACK_BINS,
  unwrappedLon,
} from "./missioncontrol-sim";
import { BLOCK_COUNT, consoleLayout } from "./missioncontrol-room";
import { MAX_LAUNCH_GAP, MIN_LAUNCH_GAP } from "./missioncontrol.meta";

/** Longitude difference a - b in degrees, wrapped to [-180, 180). */
const lonDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

describe("ground track", () => {
  const orbits: Orbit[] = [missionOrbit(0), missionOrbit(7), missionOrbit(999), launchOrbit(7, 3)];

  it("is continuous, stays within the inclination and wraps longitude into [-180, 180)", () => {
    for (const o of orbits) {
      const pos = { lat: 0, lon: 0 };
      const prev = { lat: 0, lon: 0 };
      groundTrack(o, 0, prev);
      const maxLat = (o.incl * 180) / Math.PI;
      let wraps = 0;
      let travelled = 0;
      const dt = 0.5;
      for (let t = dt; t < o.period * 3; t += dt) {
        groundTrack(o, t, pos);
        expect(pos.lon).toBeGreaterThanOrEqual(-180);
        expect(pos.lon).toBeLessThan(180);
        expect(Math.abs(pos.lat)).toBeLessThanOrEqual(maxLat + 1e-9);
        // Small steps everywhere, including across the date line.
        const dLon = lonDiff(pos.lon, prev.lon);
        expect(Math.abs(dLon)).toBeLessThan(2);
        expect(Math.abs(pos.lat - prev.lat)).toBeLessThan(1);
        // Always eastward over the ground.
        expect(dLon).toBeGreaterThan(0);
        if (pos.lon < prev.lon) {
          wraps++;
        }
        travelled += dLon;
        prev.lat = pos.lat;
        prev.lon = pos.lon;
      }
      // The wrapped steps add up to the unwrapped longitude, once round per wrap.
      const tEnd = Math.floor((o.period * 3) / dt - 1e-9) * dt;
      expect(travelled).toBeCloseTo(unwrappedLon(o, tEnd) - unwrappedLon(o, 0), 6);
      // It crossed the date line each time the unwrapped longitude passed 180 + 360 k.
      const start = groundTrack(o, 0, { lat: 0, lon: 0 }).lon;
      expect(wraps).toBeGreaterThan(0);
      expect(wraps).toBe(Math.floor((start + travelled + 180) / 360));
    }
  });

  it("shifts each orbit's track west as the Earth turns beneath it", () => {
    const o = missionOrbit(7);
    const node = (n: number) =>
      groundTrack(o, timeAtArgument(o, n * 2 * Math.PI), { lat: 0, lon: 0 });
    for (let n = 0; n < 4; n++) {
      const a = node(n);
      const b = node(n + 1);
      expect(a.lat).toBeCloseTo(0, 9);
      expect(lonDiff(b.lon, a.lon)).toBeCloseTo(-360 / EARTH_RATIO, 6);
    }
  });

  it("starts a launched craft's track at the launch site, heading north-east", () => {
    for (const n of [0, 1, 5]) {
      const o = launchOrbit(12, n);
      const p = groundTrack(o, 0, { lat: 0, lon: 0 });
      expect(p.lat).toBeCloseTo(LAUNCH_SITE.lat, 6);
      expect(lonDiff(p.lon, LAUNCH_SITE.lon)).toBeCloseTo(0, 6);
      const q = groundTrack(o, 5, { lat: 0, lon: 0 });
      expect(q.lat).toBeGreaterThan(p.lat);
      expect(lonDiff(q.lon, p.lon)).toBeGreaterThan(0);
      expect(orbitNumber(o, 0)).toBe(0);
    }
  });

  it("takes several minutes per orbit", () => {
    for (const s of [0, 1, 500, 999]) {
      expect(missionOrbit(s).period).toBeGreaterThanOrEqual(180);
    }
    expect(launchOrbit(0, 0).period).toBeGreaterThanOrEqual(180);
  });
});

describe("track rows", () => {
  const edges = createTrackEdges();
  const row = new Float32Array(TRACK_BINS * 4);
  const edgeLon = (i: number) => -180 + (360 * i) / TRACK_BINS;

  it("join up bin to bin, across the date line, and follow the craft's latitude", () => {
    const o = missionOrbit(7);
    for (const tau of [100, 5000, 123456]) {
      const n = orbitNumber(o, tau);
      fillTrackRow(o, n, Number.NEGATIVE_INFINITY, edges, row, 0);
      for (const ch of [0, 2]) {
        const bins = Array.from({ length: TRACK_BINS }, (_, j) => ({
          left: row[j * 4 + ch],
          right: row[j * 4 + ch + 1],
          nextLeft: row[((j + 1) % TRACK_BINS) * 4 + ch],
        }));
        const joins = bins.filter((b) => b.right < NO_TRACK && b.nextLeft < NO_TRACK);
        expect(joins.every((b) => b.nextLeft === b.right)).toBe(true);
        const drawn = bins.filter((b) => b.left < NO_TRACK && b.right < NO_TRACK);
        expect(Math.max(...drawn.map((b) => Math.abs(b.right - b.left)))).toBeLessThan(1.5);
        const valid = drawn.length;
        // Each orbit covers most of the map: the Earth turns 22.5 degrees under it.
        expect(valid).toBeGreaterThan(TRACK_BINS * 0.9);
        expect(valid).toBeLessThan(TRACK_BINS);
      }
      // The current orbit passes through the craft.
      const p = groundTrack(o, tau, { lat: 0, lon: 0 });
      const j = Math.floor(((p.lon + 180) / 360) * TRACK_BINS);
      const k = ((p.lon - edgeLon(j)) / 360) * TRACK_BINS;
      const lat = row[j * 4 + 2] + (row[j * 4 + 3] - row[j * 4 + 2]) * k;
      expect(lat).toBeCloseTo(p.lat, 1);
    }
  });

  it("has no previous orbit, and starts at the site, for a craft on its first orbit", () => {
    const o = launchOrbit(7, 0);
    fillTrackRow(o, 0, o.phase, edges, row, 0);
    for (let j = 0; j < TRACK_BINS; j++) {
      expect(row[j * 4]).toBe(NO_TRACK);
    }
    const j = Math.floor(((LAUNCH_SITE.lon + 180) / 360) * TRACK_BINS);
    // Drawn east of the site, not just west of it.
    expect(row[(j + 2) * 4 + 2]).toBeLessThan(NO_TRACK);
    expect(row[(j - 2) * 4 + 3]).toBe(NO_TRACK);
    expect(argumentAt(o, 0)).toBe(o.phase);
  });
});

describe("launch schedule", () => {
  const s = createLaunchState();

  it("lifts off every launchGap seconds", () => {
    for (const gap of [MIN_LAUNCH_GAP, 300, 547, MAX_LAUNCH_GAP]) {
      for (let n = 0; n < 5; n++) {
        expect(liftoffTime(n + 1, gap) - liftoffTime(n, gap)).toBeCloseTo(gap, 9);
        launchAt(liftoffTime(n, gap), gap, s);
        expect(s.index).toBe(n);
      }
      expect(liftoffTime(0, gap)).toBe(FIRST_LIFTOFF);
    }
  });

  it("counts down from 30 and hits zero exactly at liftoff", () => {
    for (const gap of [MIN_LAUNCH_GAP, 300, MAX_LAUNCH_GAP]) {
      const l = liftoffTime(2, gap);
      launchAt(l - COUNTDOWN - 0.01, gap, s);
      expect(s.phase).toBe("idle");
      launchAt(l - COUNTDOWN, gap, s);
      expect(s.phase).toBe("countdown");
      expect(s.display).toBe(30);
      expect(countdownText(s, true)).toBe("t-00:30");
      launchAt(l - 0.001, gap, s);
      expect(s.phase).toBe("countdown");
      expect(s.display).toBe(1);
      launchAt(l, gap, s);
      expect(s.phase).toBe("flight");
      expect(s.sinceLiftoff).toBe(0);
      expect(s.display).toBe(0);
      expect(countdownText(s, true)).toBe("t-00:00");
      launchAt(l + 5.5, gap, s);
      expect(countdownText(s, true)).toBe("t+00:05");
    }
    launchAt(liftoffTime(0, 300) + 65, 300, s);
    expect(countdownText(s, true)).toBe("t+01:05");
  });

  it("counts every second of the countdown once, in order", () => {
    const gap = 300;
    const l = liftoffTime(1, gap);
    const seen: number[] = [];
    for (let i = 0; i <= COUNTDOWN * 20; i++) {
      launchAt(l - COUNTDOWN + i / 20, gap, s);
      if (seen.at(-1) !== s.display) {
        seen.push(s.display);
      }
    }
    expect(seen).toEqual(Array.from({ length: 31 }, (_, i) => 30 - i));
  });

  it("is back on the pad before the next countdown", () => {
    for (const gap of [MIN_LAUNCH_GAP, 90, 300, MAX_LAUNCH_GAP]) {
      expect(padReset(gap)).toBeLessThan(gap - COUNTDOWN);
      launchAt(liftoffTime(0, gap) + padReset(gap) + 0.5, gap, s);
      expect(s.phase).toBe("idle");
      expect(countdownText(s, true)).toBe(" HOLD");
    }
    launchAt(0, 300, s);
    expect(s.index).toBe(-1);
    expect(countdownText(s, true)).toBe(" HOLD");
  });

  it("keeps the launch under way when the gap changes, and times the next from it", () => {
    const run = (from: number, to: number, change: number, end: number) => {
      const st = createLaunchState();
      const log: [number, string, number][] = [];
      for (let t = 0; t <= end; t += 0.25) {
        stepLaunch(st, t, t < change ? from : to);
        log.push([st.index, st.phase, st.display]);
      }
      return { st, log };
    };
    // Mid-flight of launch 1 the gap drops from 600 to 60.
    const change = liftoffTime(1, 600) + 10;
    const steady = run(600, 600, Infinity, change + 200);
    const changed = run(600, 60, change, change + 200);
    const at = (t: number) => Math.round(t / 0.25);
    // Until its cut to the pad, launch 1 runs exactly as before.
    const cut = liftoffTime(1, 600) + padReset(600);
    expect(changed.log.slice(0, at(cut))).toEqual(steady.log.slice(0, at(cut)));
    // Then the next countdown starts at once, as the new gap has passed.
    const next = changed.log.findIndex(([i]) => i === 2);
    expect(next).toBeGreaterThanOrEqual(at(cut));
    expect(next).toBeLessThan(at(cut) + 2);
    expect(changed.log[next]).toEqual([2, "countdown", 30]);
    // And from then on liftoffs come every 60 s.
    expect(changed.st.next - changed.st.liftoff).toBe(60);
  });

  it("follows a new gap from the last liftoff while waiting on the pad", () => {
    const st = createLaunchState();
    const idle = liftoffTime(0, 600) + padReset(600) + 5;
    for (let t = 0; t <= idle; t += 0.5) {
      stepLaunch(st, t, 600);
    }
    expect(st.phase).toBe("idle");
    stepLaunch(st, idle + 0.5, 300);
    expect(st.next).toBe(liftoffTime(0, 600) + 300);
    stepLaunch(st, liftoffTime(0, 600) + 300 - COUNTDOWN, 300);
    expect([st.index, st.phase, st.display]).toEqual([1, "countdown", 30]);
  });

  it("holds when launches are off", () => {
    launchAt(liftoffTime(0, 300) - 10, 300, s);
    expect(countdownText(s, false)).toBe(" HOLD");
  });

  it("climbs only after the engines have built up, and leaves the screen", () => {
    expect(rocketClimb(0)).toBe(0);
    expect(rocketClimb(2.9)).toBe(0);
    expect(rocketClimb(10)).toBeGreaterThan(rocketClimb(6));
    expect(rocketClimb(20)).toBeGreaterThan(1.5);
  });
});

describe("clocks", () => {
  it("formats mission elapsed time as days, hours, minutes and seconds", () => {
    expect(missionTimeText(0)).toBe("000:00:00:00");
    expect(missionTimeText(59.99)).toBe("000:00:00:59");
    expect(missionTimeText(3 * 86400 + 4 * 3600 + 5 * 60 + 6)).toBe("003:04:05:06");
    expect(missionTimeText(123 * 86400 + 23 * 3600 + 59 * 60 + 59)).toBe("123:23:59:59");
    expect(missionTimeText(-5)).toBe("000:00:00:00");
  });

  it("formats local time as 24-hour HH:MM:SS", () => {
    expect(localTimeText(new Date(2026, 0, 2, 9, 5, 7))).toBe("09:05:07");
    expect(localTimeText(new Date(2026, 5, 30, 23, 59, 59, 999))).toBe("23:59:59");
    expect(localTimeText(new Date(2026, 5, 30, 0, 0, 0))).toBe("00:00:00");
  });

  it("starts each variation's mission some hours or days in", () => {
    for (const seed of [0, 1, 42, 999]) {
      const m = missionOffset(seed);
      expect(m).toBe(missionOffset(seed));
      expect(m).toBeGreaterThanOrEqual(7200);
      expect(m).toBeLessThanOrEqual(5 * 86400);
      expect(Number.isInteger(m)).toBe(true);
    }
  });
});

describe("console activity", () => {
  const layout = consoleLayout(7);
  const run = (activity: number, seconds: number, step = 0.25) => {
    const scratch = createConsoleScratch(BLOCK_COUNT, layout.groups);
    const out = new Uint8Array(BLOCK_COUNT * 4);
    for (let t = 0; t <= seconds; t += step) {
      consoleStates(layout.blocks, 7, activity, t, scratch, out);
    }
    let scrolled = 0;
    for (let i = 1; i < layout.blocks.length; i++) {
      if (layout.blocks[i].kind === "readout") {
        scrolled += scratch.scroll[i];
      }
    }
    return { out, scrolled };
  };

  it("scrolls the CRTs more as activity rises, and not at all at 0", () => {
    // Scroll counts depend only on the slots passed, so a step that ends on the
    // same time and is shorter than the shortest slot (18 s) counts the same ticks.
    const step = 10;
    expect(run(0.4, 120, step).scrolled).toBe(run(0.4, 120).scrolled);
    const quiet = run(0, 300, step);
    const some = run(0.4, 300, step);
    const busy = run(1, 300, step);
    expect(quiet.scrolled).toBe(0);
    expect(some.scrolled).toBeGreaterThan(0);
    expect(busy.scrolled).toBeGreaterThan(some.scrolled);
  });

  it("gives each button its lens colours and lights only buttons that exist", () => {
    const { out } = run(0.5, 20);
    const indexed = layout.blocks.map((b, i) => ({ b, i }));
    for (const { b, i } of indexed.filter((e) => e.b.kind === "button")) {
      expect(out[i * 4 + 3]).toBe(b.colour + 8 * b.alt);
    }
    for (const { i } of indexed.filter((e) => e.b.kind === "widget")) {
      expect(out[i * 4]).toBe(0);
    }
  });

  it("is deterministic", () => {
    expect(run(0.6, 60).out).toEqual(run(0.6, 60).out);
  });
});
