import { describe, expect, it } from "vitest";
import {
  ASTEROID_SLOT,
  asteroidAt,
  createAsteroid,
  createRateLatch,
  createJumpState,
  createLampScratch,
  createScenery,
  ENTER_SECONDS,
  type JumpPhase,
  jumpAt,
  jumpLength,
  jumpSlot,
  jumpStart,
  lampStates,
  LEAVE_SECONDS,
  sceneryAt,
  screenSetup,
  slotRate,
  SCREEN_KINDS,
  TUNNEL_MAX,
  TUNNEL_MIN,
  tunnelSeconds,
} from "./cockpit-sim";
import { cockpitLayout, MAX_LIGHTS } from "./cockpit-layout";
import { MAX_JUMP_GAP, MIN_JUMP_GAP } from "./cockpit.meta";

const NEXT: Record<JumpPhase, JumpPhase> = {
  sublight: "entering",
  entering: "tunnel",
  tunnel: "leaving",
  leaving: "sublight",
};

describe("jump schedule", () => {
  it("is deterministic per seed", () => {
    const a = createJumpState();
    const b = createJumpState();
    for (let t = 0; t < 2000; t += 3.7) {
      expect(jumpAt(t, "cycle", 60, 5, a)).toEqual(jumpAt(t, "cycle", 60, 5, b));
    }
    let differs = false;
    for (let t = 0; t < 2000; t += 3.7) {
      differs ||= jumpAt(t, "cycle", 60, 5, a).phase !== jumpAt(t, "cycle", 60, 6, b).phase;
    }
    expect(differs).toBe(true);
  });

  it("runs through its phases in order, with levels that ramp over at least a second", () => {
    for (const [gap, seed] of [
      [MIN_JUMP_GAP, 0],
      [90, 7],
      [150, 3],
    ]) {
      const s = createJumpState();
      const dt = 0.01;
      jumpAt(0, "cycle", gap, seed, s);
      let { phase, stretch, tunnel, leg } = s;
      const seen = new Set<JumpPhase>([phase]);
      const bad: string[] = [];
      for (let t = dt; t < 6 * jumpSlot(gap); t += dt) {
        jumpAt(t, "cycle", gap, seed, s);
        if (s.phase !== phase && s.phase !== NEXT[phase]) {
          bad.push(`${phase} -> ${s.phase} at ${String(t)}`);
        }
        seen.add(s.phase);
        // Smoothstep ramps peak at 1.5 / duration.
        if (Math.abs(s.stretch - stretch) > (1.5 * dt) / ENTER_SECONDS + 1e-9) {
          bad.push(`stretch jumps at ${String(t)}`);
        }
        if (Math.abs(s.tunnel - tunnel) > dt + 1e-9) {
          bad.push(`tunnel jumps at ${String(t)}`);
        }
        if (s.stretch < 0 || s.stretch > 1 || s.tunnel < 0 || s.tunnel > 1) {
          bad.push(`level out of range at ${String(t)}`);
        }
        // The scenery moves on only while the tunnel hides it.
        if (s.leg !== leg && (s.leg !== leg + 1 || s.phase !== "tunnel" || s.tunnel !== 1)) {
          bad.push(`leg changes in view at ${String(t)}`);
        }
        ({ phase, stretch, tunnel, leg } = s);
      }
      expect(bad).toEqual([]);
      expect(seen.size).toBe(4);
    }
  });

  it("keeps the gaps between jumps near jumpGap", () => {
    for (const gap of [MIN_JUMP_GAP, 45, 150, 300, MAX_JUMP_GAP]) {
      for (const seed of [0, 1, 42, 999]) {
        expect(jumpStart(0, gap, seed)).toBeGreaterThanOrEqual(0.5 * gap);
        for (let k = 0; k < 50; k++) {
          const sublight =
            jumpStart(k + 1, gap, seed) - jumpStart(k, gap, seed) - jumpLength(k, seed);
          expect(sublight).toBeGreaterThanOrEqual(0.7 * gap - 1e-9);
          expect(sublight).toBeLessThanOrEqual(1.3 * gap + (TUNNEL_MAX - TUNNEL_MIN) + 1e-9);
        }
      }
    }
  });

  it("measures the same gaps by sampling", () => {
    const gap = 60;
    const s = createJumpState();
    let last = "sublight";
    let since = 0;
    const runs: number[] = [];
    for (let t = 0; t < 20 * jumpSlot(gap); t += 0.05) {
      jumpAt(t, "cycle", gap, 11, s);
      if (s.phase === "sublight" && last !== "sublight") {
        since = t;
      } else if (s.phase !== "sublight" && last === "sublight" && since > 0) {
        runs.push(t - since);
      }
      last = s.phase;
    }
    expect(runs.length).toBeGreaterThan(15);
    for (const r of runs) {
      expect(r).toBeGreaterThanOrEqual(0.7 * gap - 0.1);
      expect(r).toBeLessThanOrEqual(1.3 * gap + TUNNEL_MAX - TUNNEL_MIN + 0.1);
    }
  });

  it("enters and leaves in about a second, and tunnels for 20-40 s", () => {
    expect(ENTER_SECONDS).toBeGreaterThanOrEqual(1);
    expect(LEAVE_SECONDS).toBeGreaterThanOrEqual(1);
    for (let k = 0; k < 100; k++) {
      const t = tunnelSeconds(k, 3);
      expect(t).toBeGreaterThanOrEqual(TUNNEL_MIN);
      expect(t).toBeLessThanOrEqual(TUNNEL_MAX);
    }
  });

  it("never changes phase in Sublight only or Hyperspace only", () => {
    const s = createJumpState();
    for (const [view, phase, level] of [
      ["sublight", "sublight", 0],
      ["hyperspace", "tunnel", 1],
    ] as const) {
      for (let t = -5; t < 5000; t += 0.37) {
        jumpAt(t, view, MIN_JUMP_GAP, 7, s);
        expect(s.phase).toBe(phase);
        expect(s.stretch).toBe(level);
        expect(s.tunnel).toBe(level);
        expect(s.leg).toBe(0);
      }
    }
  });
});

describe("asteroids", () => {
  it("never come with rate 0", () => {
    const a = createAsteroid();
    for (let t = 0; t < 3000; t += 0.5) {
      expect(asteroidAt(t, 4, 0, a).visible).toBe(false);
    }
  });

  it("keep the rate each slot began with, so a slider drag never pops one in or out", () => {
    const a = createAsteroid();
    const latch = createRateLatch();
    let alpha = 0;
    let jump = 0;
    let seen = 0;
    const dt = 0.05;
    for (let t = 0; t < 60 * ASTEROID_SLOT; t += dt) {
      // The slider swings between none and every slot, three times a slot.
      const rate = Math.floor(t / (ASTEROID_SLOT / 3)) % 2;
      asteroidAt(t, 9, slotRate(latch, t, rate), a);
      const now = a.visible ? a.alpha : 0;
      jump = Math.max(jump, Math.abs(now - alpha));
      seen += a.visible ? 1 : 0;
      alpha = now;
    }
    expect(seen).toBeGreaterThan(0);
    expect(jump).toBeLessThan(dt);
  });

  it("are deterministic, slow, and fade in and out", () => {
    const a = createAsteroid();
    const b = createAsteroid();
    const dt = 0.05;
    let px = 0;
    let py = 0;
    let alpha = 0;
    let was = false;
    let passes = 0;
    let fastest = 0;
    let alphaStep = 0;
    let startAlpha = 0;
    let startDist = 0;
    let endAlpha = 0;
    let largest = 0;
    let differs = 0;
    for (let t = 0; t < 100 * ASTEROID_SLOT; t += dt) {
      asteroidAt(t, 9, 1, a);
      asteroidAt(t, 9, 1, b);
      differs += JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
      if (a.visible && was) {
        fastest = Math.max(fastest, Math.hypot(a.x - px, a.y - py) / dt);
        alphaStep = Math.max(alphaStep, Math.abs(a.alpha - alpha));
      } else if (a.visible) {
        passes++;
        startAlpha = Math.max(startAlpha, a.alpha);
        startDist = Math.max(startDist, Math.hypot(a.x, a.y));
      } else if (was) {
        endAlpha = Math.max(endAlpha, alpha);
      }
      largest = Math.max(largest, a.visible ? a.radius : 0);
      ({ x: px, y: py, alpha } = a);
      was = a.visible;
    }
    expect(differs).toBe(0);
    expect(fastest).toBeLessThan(0.16);
    expect(alphaStep).toBeLessThan(dt);
    expect(startAlpha).toBeLessThan(0.05);
    expect(endAlpha).toBeLessThan(0.05);
    // It starts far ahead, behind the speaker.
    expect(startDist).toBeLessThan(0.15);
    expect(largest).toBeGreaterThan(0.03);
    expect(largest).toBeLessThan(0.11);
    // At rate 1 there is one per slot.
    expect(passes).toBe(100);
  });

  it("come less often at lower rates", () => {
    const a = createAsteroid();
    const count = (rate: number) => {
      let n = 0;
      for (let s = 0; s < 400; s++) {
        let any = false;
        for (let t = s * ASTEROID_SLOT; t < (s + 1) * ASTEROID_SLOT && !any; t += 1) {
          any = asteroidAt(t, 2, rate, a).visible;
        }
        n += any ? 1 : 0;
      }
      return n;
    };
    const low = count(0.25);
    const high = count(0.75);
    expect(low).toBeGreaterThan(60);
    expect(low).toBeLessThan(140);
    expect(high).toBeGreaterThan(low);
  });
});

describe("console lamps", () => {
  const layout = cockpitLayout(3);
  const scratch = () => createLampScratch(layout.groups);
  const states = (lights: number, t: number) => {
    const out = new Uint8Array((MAX_LIGHTS + 1) * 4);
    lampStates(layout.lamps, 3, lights, t, scratch(), out);
    return out;
  };

  it("burn steadily at activity 0, with some lit and some dark", () => {
    const first = states(0, 0);
    for (let t = 0.5; t < 600; t += 7.3) {
      expect(states(0, t)).toEqual(first);
    }
    let lit = 0;
    for (let i = 1; i <= layout.lamps.length; i++) {
      lit += first[i * 4] + first[i * 4 + 1] + first[i * 4 + 2] > 0 ? 1 : 0;
    }
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(layout.lamps.length * 0.6);
  });

  it("blink and change at high activity, and dead lamps stay dark", () => {
    let changes = 0;
    let deadLight = 0;
    let prev = states(1, 0);
    for (let t = 0.25; t < 60; t += 0.25) {
      const s = states(1, t);
      for (let i = 1; i <= layout.lamps.length; i++) {
        changes += s[i * 4] === prev[i * 4] ? 0 : 1;
        deadLight += layout.lamps[i - 1].dead ? s[i * 4] + s[i * 4 + 1] + s[i * 4 + 2] : 0;
      }
      prev = s;
    }
    expect(changes).toBeGreaterThan(100);
    expect(deadLight).toBe(0);
  });

  it("leave texel 0 dark", () => {
    const s = states(1, 12);
    expect([...s.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  });
});

describe("scenery and screens", () => {
  it("puts any planet in an upper side window, deterministically", () => {
    const a = createScenery();
    const b = createScenery();
    let planets = 0;
    let nearestX = 1;
    let lowestY = 1;
    for (let leg = 0; leg < 200; leg++) {
      sceneryAt(leg, 5, a);
      expect(sceneryAt(leg, 5, b)).toEqual(a);
      expect(Math.hypot(a.sunX, a.sunY)).toBeCloseTo(1, 9);
      const has = a.planetR > 0;
      planets += has ? 1 : 0;
      nearestX = Math.min(nearestX, has ? Math.abs(a.planetX) : 1);
      lowestY = Math.min(lowestY, has ? a.planetY : 1);
    }
    expect(nearestX).toBeGreaterThan(0.4);
    expect(lowestY).toBeGreaterThan(0.1);
    expect(planets).toBeGreaterThan(40);
    expect(planets).toBeLessThan(120);
  });

  it("gives each screen a known picture", () => {
    const out = new Float32Array(4);
    for (let n = 0; n < 50; n++) {
      screenSetup(n, 8, out, 0);
      expect(Number.isInteger(out[0])).toBe(true);
      expect(out[0]).toBeGreaterThanOrEqual(0);
      expect(out[0]).toBeLessThan(SCREEN_KINDS);
      expect([0, 1]).toContain(out[1]);
    }
  });
});
