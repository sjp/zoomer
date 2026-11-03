import { describe, expect, it } from "vitest";
import { createRng } from "./noise";
import {
  buildSlopeMap,
  createMotes,
  criticalAngle,
  decodeSlope,
  encodeSlope,
  eyeDepth,
  fresnelTransmit,
  LEAF_CROSS,
  LEAF_CYCLE,
  LEAF_LENGTH,
  leafAt,
  leafReach,
  MOTE_MARGIN,
  moteBrightness,
  refractUp,
  rescaleMotes,
  RGB_IOR,
  shaftCoord,
  SKY,
  stepMotes,
  sunDirection,
  WATER,
  WATER_IOR,
  windowRadius,
  WINDOW_Y,
  type LeafPose,
} from "./snell-sim";
import { ABOVE_OPTIONS, WATER_OPTIONS } from "./snell.meta";

const DEG = Math.PI / 180;

describe("optics", () => {
  it("has the analytic critical angle of about 48.6 degrees", () => {
    expect(criticalAngle() / DEG).toBeCloseTo(48.6, 1);
    expect(Math.sin(criticalAngle(WATER_IOR)) * WATER_IOR).toBeCloseTo(1, 12);
  });

  it("refracts through a flat surface exactly up to the critical angle", () => {
    const out = new Float64Array(3);
    const depthPx = 300;
    const thetaC = criticalAngle();
    let bad = 0;
    for (let k = 0; k <= 200; k++) {
      const theta = (k / 200) * 80 * DEG;
      if (Math.abs(theta - thetaC) < 1e-6) continue;
      const r = depthPx * Math.tan(theta);
      const t = refractUp(out, r * 0.6, r * 0.8, depthPx, 0, 0);
      const inside = theta < thetaC;
      if (inside !== t > 0) bad++;
      if (inside) {
        // Snell: sin(theta_air) = n sin(theta_water), azimuth unchanged.
        const sinAir = Math.hypot(out[0], out[1]);
        if (Math.abs(sinAir - WATER_IOR * Math.sin(theta)) > 1e-9) bad++;
        if (Math.abs(Math.hypot(out[0], out[1], out[2]) - 1) > 1e-9) bad++;
        if (theta > 0 && Math.abs(out[1] / out[0] - 0.8 / 0.6) > 1e-9) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("goes straight up at the centre and passes nearly everything", () => {
    const out = new Float64Array(3);
    const t = refractUp(out, 0, 0, 300, 0, 0);
    expect([...out]).toEqual([0, 0, 1]);
    // Normal incidence: R = ((n - 1) / (n + 1))^2, about 2 %.
    expect(t).toBeCloseTo(1 - ((WATER_IOR - 1) / (WATER_IOR + 1)) ** 2, 9);
  });

  it("transmits less towards the rim and nothing past it", () => {
    let prev = 1;
    let rising = 0;
    for (let deg = 0; deg <= 60; deg += 0.5) {
      const t = fresnelTransmit(Math.cos(deg * DEG), WATER_IOR);
      if (t > prev + 1e-12) rising++;
      prev = t;
    }
    expect(rising).toBe(0);
    expect(fresnelTransmit(Math.cos(criticalAngle() + 1e-6), WATER_IOR)).toBe(0);
    expect(fresnelTransmit(Math.cos(criticalAngle() - 0.02), WATER_IOR)).toBeGreaterThan(0.3);
  });

  it("splits the rim: red reaches furthest out, blue cuts off first", () => {
    const [r, g, b] = RGB_IOR;
    expect(r).toBeLessThan(g);
    expect(g).toBeLessThan(b);
    const out = new Float64Array(3);
    const between = (windowRadius(1, b) + windowRadius(1, r)) / 2;
    expect(refractUp(out, between, 0, eyeDepth(1), 0, 0, r)).toBeGreaterThan(0);
    expect(refractUp(out, between, 0, eyeDepth(1), 0, 0, b)).toBe(0);
    // A thin fringe: a few reference px.
    const fringe = windowRadius(1, r) - windowRadius(1, b);
    expect(fringe).toBeGreaterThan(3);
    expect(fringe).toBeLessThan(20);
  });

  it("tilts the cutoff with the surface slope", () => {
    const out = new Float64Array(3);
    const r = windowRadius(1) * 1.02;
    // Just outside the flat window, a surface sloping down away from the centre (normal
    // tilted outwards, towards the ray) lets light through; the opposite slope does not.
    expect(refractUp(out, r, 0, eyeDepth(1), 0, 0)).toBe(0);
    expect(refractUp(out, r, 0, eyeDepth(1), -0.1, 0)).toBeGreaterThan(0);
    expect(refractUp(out, r * 0.97, 0, eyeDepth(1), 0.1, 0)).toBe(0);
  });
});

describe("window radius", () => {
  it("scales linearly with depth as D tan(theta_c)", () => {
    const tanC = Math.tan(criticalAngle());
    for (const depth of [0.6, 1, 1.4]) {
      expect(windowRadius(depth)).toBeCloseTo(eyeDepth(depth) * tanC, 9);
    }
    expect(windowRadius(1.4) / windowRadius(0.7)).toBeCloseTo(2, 9);
    // Default depth: the window sits in the top part of the frame.
    expect(WINDOW_Y + windowRadius(1)).toBeLessThan(720);
  });
});

describe("slope map", () => {
  const size = 64;
  const map = buildSlopeMap(size, 7);

  it("round-trips the encoding with zero exactly at 128", () => {
    expect(encodeSlope(0)).toBe(128);
    expect(decodeSlope(128)).toBe(0);
    expect(decodeSlope(encodeSlope(1))).toBe(1);
    expect(decodeSlope(encodeSlope(-1))).toBe(-1);
    expect(encodeSlope(5)).toBe(255);
    expect(encodeSlope(-5)).toBe(1);
  });

  it("is normalised, roughly zero-mean, and tiles without a seam", () => {
    let peak = 0;
    let sx = 0;
    let sy = 0;
    let seam = 0;
    let inner = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 2;
        const gx = decodeSlope(map[i]);
        const gy = decodeSlope(map[i + 1]);
        peak = Math.max(peak, Math.abs(gx), Math.abs(gy));
        sx += gx;
        sy += gy;
        const j = (y * size + ((x + 1) % size)) * 2;
        const step = Math.abs(map[j] - map[i]);
        if (x === size - 1) seam = Math.max(seam, step);
        else inner = Math.max(inner, step);
      }
    }
    expect(peak).toBe(1);
    // Gradients of a periodic field sum to zero.
    expect(Math.abs(sx / (size * size))).toBeLessThan(0.01);
    expect(Math.abs(sy / (size * size))).toBeLessThan(0.01);
    // The wrap from the last column to the first is no rougher than any other step.
    expect(seam).toBeLessThanOrEqual(inner);
  });

  it("is deterministic per seed", () => {
    expect(buildSlopeMap(size, 7)).toEqual(map);
    expect(buildSlopeMap(size, 8)).not.toEqual(map);
  });
});

describe("palettes", () => {
  it("has one for every select option, in range", () => {
    let bad = 0;
    const unit = (c: readonly number[]) => c.every((v) => v >= 0 && v <= 1);
    for (const o of WATER_OPTIONS) {
      const w = WATER[o.value];
      if (!w || !unit(w.deep) || !unit(w.haze) || !unit(w.ray)) bad++;
      // The reflected deep water frames the window darker than the haze.
      if (w.deep.some((v, c) => v > w.haze[c])) bad++;
    }
    for (const o of ABOVE_OPTIONS) {
      const s = SKY[o.value];
      if (!s || !unit(s.zenith) || !unit(s.horizon) || !(s.cloudLo < s.cloudHi)) bad++;
    }
    expect(bad).toBe(0);
  });

  it("puts the sun at the given elevation and azimuth", () => {
    const out = new Float64Array(3);
    sunDirection(out, 30, 0);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 12);
    expect(out[2]).toBeCloseTo(0.5, 12);
    // Azimuth 0 points up the frame (negative y).
    expect(out[1]).toBeLessThan(0);
    expect(out[0]).toBeCloseTo(0, 12);
    sunDirection(out, 0, 90);
    expect(out[0]).toBeCloseTo(1, 12);
  });
});

describe("shaftCoord", () => {
  it("puts straight down in the middle and the seam straight up", () => {
    expect(shaftCoord(0, 1)).toBeCloseTo(0.5, 12);
    expect(shaftCoord(1, 0)).toBeCloseTo(0.75, 12);
    expect(shaftCoord(-1, 0)).toBeCloseTo(0.25, 12);
    expect(shaftCoord(-1e-9, -1)).toBeCloseTo(0, 6);
  });
});

describe("motes", () => {
  it("drift slowly and wrap around the frame", () => {
    const s = createMotes(createRng(1), 30, 1920);
    let bad = 0;
    for (let k = 0; k < 2000; k++) {
      const x0 = s.x[0];
      stepMotes(s, 1 / 60, 1920);
      const dx = Math.abs(s.x[0] - x0);
      // Under a pixel per frame unless it just wrapped.
      if (dx > 0.5 && dx < 1000) bad++;
      for (let i = 0; i < 30; i++) {
        if (s.x[i] < -MOTE_MARGIN || s.x[i] >= 1920 + MOTE_MARGIN) bad++;
        if (s.y[i] < -MOTE_MARGIN || s.y[i] >= 1080 + MOTE_MARGIN) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("are brighter near the window and keep their place on resize", () => {
    const s = createMotes(createRng(2), 2, 1920);
    s.x[0] = 960;
    s.y[0] = WINDOW_Y;
    s.x[1] = 100;
    s.y[1] = 1000;
    s.phase[0] = s.phase[1] = 0;
    s.freq[0] = s.freq[1] = 1;
    expect(moteBrightness(s, 0, 0, 960, WINDOW_Y, 340)).toBeGreaterThan(
      2 * moteBrightness(s, 1, 0, 960, WINDOW_Y, 340),
    );
    rescaleMotes(s, 0.5);
    expect(s.x[0]).toBe(480);
  });
});

describe("leafAt", () => {
  const pose: LeafPose = { x: 0, y: 0, angle: 0 };

  it("crosses from off-frame to off-frame, then pauses", () => {
    const refWidth = 1920;
    const reach = leafReach(refWidth);
    const offFrame = (p: LeafPose) =>
      Math.abs(p.x) > refWidth / 2 + LEAF_LENGTH ||
      p.y < -WINDOW_Y - LEAF_LENGTH ||
      p.y > 1080 - WINDOW_Y + LEAF_LENGTH;
    let bad = 0;
    for (let cycle = 0; cycle < 20; cycle++) {
      const t0 = cycle * LEAF_CYCLE;
      if (!leafAt(pose, t0, refWidth) || !offFrame(pose)) bad++;
      if (Math.abs(Math.hypot(pose.x, pose.y) - reach) > 200) bad++;
      if (!leafAt(pose, t0 + LEAF_CROSS - 1e-6, refWidth) || !offFrame(pose)) bad++;
      if (leafAt(pose, t0 + LEAF_CROSS + 1, refWidth)) bad++;
      // Halfway, it is near the window centre.
      leafAt(pose, t0 + LEAF_CROSS / 2, refWidth);
      if (Math.hypot(pose.x, pose.y) > 200) bad++;
    }
    expect(bad).toBe(0);
  });

  it("moves slowly and smoothly within a crossing", () => {
    let bad = 0;
    let prevX = 0;
    let prevY = 0;
    for (let t = 0; t < LEAF_CROSS; t += 0.25) {
      leafAt(pose, t, 1920);
      if (t > 0 && Math.hypot(pose.x - prevX, pose.y - prevY) > 15) bad++;
      prevX = pose.x;
      prevY = pose.y;
    }
    expect(bad).toBe(0);
  });

  it("takes a different track each cycle", () => {
    leafAt(pose, LEAF_CROSS / 4, 1920);
    const a = { ...pose };
    leafAt(pose, LEAF_CYCLE + LEAF_CROSS / 4, 1920);
    expect(Math.hypot(pose.x - a.x, pose.y - a.y)).toBeGreaterThan(1);
  });
});
