import { describe, expect, it } from "vitest";
import {
  advanceArm,
  advanceRotation,
  ARM_FLOATS,
  ARM_HEAD,
  armGeometry,
  armPose,
  BOKEH_COUNT,
  BOKEH_R,
  bokehLights,
  createArmPose,
  createArmState,
  createLayout,
  GROOVE_IN,
  GROOVE_OUT,
  LABEL_R,
  LIFT_S,
  lightDir,
  MAX_WIDTH_FRAC,
  PIVOT_BASE_R,
  PIVOT_X,
  PIVOT_Z,
  PLINTH_BACK,
  PLINTH_LEFT,
  PLINTH_RIGHT,
  plinthFor,
  PLINTHS,
  project,
  RECORD_R,
  recordToScreen,
  RETURN_S,
  revsPerSecond,
  roomFor,
  ROOMS,
  RUNOUT_S,
  screenToRecord,
  SIDE_REVS,
  START_REVS,
  stylusAt,
  SURFACE_BACK,
  turntableLayout,
  VIEW_K,
  WEIGHT_FAR,
} from "./turntable-sim";
import { PLINTH_OPTIONS, POSITION_OPTIONS, ROOM_OPTIONS, RPM_OPTIONS } from "./turntable.meta";

const ASPECTS = [4 / 3, 16 / 9, 21 / 9];

describe("projection", () => {
  it("maps screen points back to the record's polar coordinates", () => {
    const s = new Float64Array(2);
    const pr = new Float64Array(2);
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const r = (RECORD_R * (i % 20)) / 19;
      const a = -Math.PI + (2 * Math.PI * Math.floor(i / 20)) / 20 + 0.01;
      recordToScreen(r, a, s);
      screenToRecord(s[0], s[1], pr);
      worst = Math.max(worst, Math.abs(pr[0] - r));
      if (r > 1e-6) {
        const da = Math.abs(Math.atan2(Math.sin(pr[1] - a), Math.cos(pr[1] - a)));
        worst = Math.max(worst, da);
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("foreshortens depth into an ellipse and lifts with height", () => {
    const s = new Float64Array(2);
    project(0, 0, 1, s);
    expect(s[1]).toBeCloseTo(VIEW_K);
    project(0.1, 0.02, 0, s);
    expect(s[0]).toBe(0.1);
    expect(s[1]).toBeGreaterThan(0);
  });
});

describe("rotation", () => {
  it("uses the real speeds", () => {
    expect(revsPerSecond("33")).toBe(100 / 3 / 60);
    expect(revsPerSecond("45")).toBe(0.75);
    expect(revsPerSecond("78")).toBe(revsPerSecond("33"));
    expect(RPM_OPTIONS.map((o) => o.label)).toEqual(["33⅓", "45"]);
  });

  it("stays in [0, 1) and wraps without a jump", () => {
    const rps = revsPerSecond("33");
    let rot = 0;
    let bad = 0;
    let wraps = 0;
    for (let i = 0; i < 2000; i++) {
      const dt = 1 / 60 + (i % 7) * 0.003;
      const next = advanceRotation(rot, rps, dt);
      // The step, measured round the circle, is always the expected one.
      const step = next - rot + (next < rot ? 1 : 0);
      if (next < rot) {
        wraps++;
      }
      if (!(next >= 0 && next < 1) || Math.abs(step - rps * dt) > 1e-9) {
        bad++;
      }
      rot = next;
    }
    expect(bad).toBe(0);
    expect(wraps).toBeGreaterThan(10);
  });

  it("holds still for bad steps", () => {
    expect(advanceRotation(0.25, 0.75, Number.NaN)).toBe(0.25);
    expect(advanceRotation(0.25, 0.75, -1)).toBe(0.25);
    expect(advanceRotation(Number.NaN, 0.75, 0.1)).toBe(0);
  });
});

describe("turntableLayout", () => {
  it("stays in its bottom corner at 4:3, 16:9 and 21:9", () => {
    for (const aspect of ASPECTS) {
      for (const { value } of POSITION_OPTIONS) {
        const l = turntableLayout(aspect, value, createLayout());
        const [x0, y0, x1, y1] = l.box;
        expect(l.side).toBe(value === "left" ? -1 : 1);
        expect(x0).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(aspect);
        expect(y0).toBeGreaterThanOrEqual(0);
        expect(y1).toBeLessThan(0.35);
        const inner = value === "left" ? x1 : aspect - x0;
        expect(inner).toBeLessThanOrEqual(aspect * MAX_WIDTH_FRAC + 1e-9);
        // The plinth sits inside the box, with its outer edge near the frame edge.
        const plinthL = l.ox - PLINTH_LEFT * l.scale;
        const plinthR = l.ox + PLINTH_RIGHT * l.scale;
        expect(plinthL).toBeGreaterThan(x0);
        expect(plinthR).toBeLessThan(x1);
        expect(value === "left" ? plinthL : aspect - plinthR).toBeLessThan(0.1);
        // The sideboard's back edge is behind the plinth.
        expect(l.oy + SURFACE_BACK * l.scale).toBeGreaterThan(l.oy);
      }
    }
  });

  it("shrinks only when the frame is narrow", () => {
    expect(turntableLayout(16 / 9, "right", createLayout()).scale).toBe(1);
    expect(turntableLayout(21 / 9, "left", createLayout()).scale).toBe(1);
    expect(turntableLayout(4 / 3, "left", createLayout()).scale).toBeLessThan(1);
  });

  it("keeps the arm, lifted or not, inside the box", () => {
    const light = new Float64Array(3);
    const arm = new Float32Array(ARM_FLOATS);
    const pose = createArmPose();
    for (const aspect of ASPECTS) {
      for (const { value } of POSITION_OPTIONS) {
        const l = turntableLayout(aspect, value, createLayout());
        lightDir(l.side, light);
        let outside = 0;
        for (const r of [GROOVE_IN, GROOVE_OUT]) {
          for (const lift of [0, 1]) {
            pose.r = r;
            pose.lift = lift;
            armGeometry(pose, light, arm);
            for (let i = 0; i < ARM_FLOATS; i += 2) {
              const x = l.ox + arm[i] * l.scale;
              const y = l.oy + arm[i + 1] * l.scale;
              if (x < l.box[0] || x > l.box[2] || y < l.box[1] || y > l.box[3]) {
                outside++;
              }
            }
          }
        }
        expect(outside).toBe(0);
      }
    }
  });
});

describe("tonearm", () => {
  it("puts the stylus on the groove radius, on the record's front right", () => {
    const s = new Float64Array(2);
    let bad = 0;
    for (let i = 0; i <= 50; i++) {
      const r = GROOVE_IN + ((GROOVE_OUT - GROOVE_IN) * i) / 50;
      stylusAt(r, s);
      if (Math.abs(Math.hypot(s[0], s[1]) - r) > 1e-9 || s[0] <= 0 || s[1] >= 0) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    expect(GROOVE_IN).toBeGreaterThan(LABEL_R);
    expect(GROOVE_OUT).toBeLessThan(RECORD_R);
  });

  it("keeps the pivot and counterweight on the plinth, clear of the record", () => {
    expect(PIVOT_X + PIVOT_BASE_R).toBeLessThan(PLINTH_RIGHT);
    expect(PIVOT_Z + WEIGHT_FAR).toBeLessThan(PLINTH_BACK);
    expect(PIVOT_X + WEIGHT_FAR).toBeLessThan(PLINTH_RIGHT);
    expect(Math.hypot(PIVOT_X, PIVOT_Z) - PIVOT_BASE_R).toBeGreaterThan(RECORD_R);
  });

  it("creeps inwards over a side, then lifts, swings back and lowers, smoothly", () => {
    const s = createArmState();
    const pose = armPose(s, createArmPose());
    const rps = revsPerSecond("33");
    const dt = 0.1;
    let prevR = pose.r;
    let prevLift = pose.lift;
    let maxDr = 0;
    let maxDl = 0;
    let maxLift = 0;
    let lowestR = Infinity;
    let restarted = false;
    const steps = Math.ceil(((SIDE_REVS - START_REVS) / rps + RETURN_S) / dt) + 50;
    for (let i = 0; i < steps; i++) {
      advanceArm(s, dt, rps);
      armPose(s, pose);
      maxDr = Math.max(maxDr, Math.abs(pose.r - prevR));
      maxDl = Math.max(maxDl, Math.abs(pose.lift - prevLift));
      maxLift = Math.max(maxLift, pose.lift);
      lowestR = Math.min(lowestR, pose.r);
      if (s.ret < 0 && s.revs < 50 && maxLift === 1) {
        restarted = true;
      }
      prevR = pose.r;
      prevLift = pose.lift;
    }
    expect(restarted).toBe(true);
    expect(maxLift).toBe(1);
    expect(lowestR).toBeCloseTo(GROOVE_IN, 9);
    // The swing back is the fastest move: about 0.03 world units per second at most.
    expect(maxDr).toBeLessThan(0.004);
    expect(maxDl).toBeLessThan(0.11);
  });

  it("stays down in the groove until the run-out, and lifts there", () => {
    const s = createArmState();
    const pose = createArmPose();
    s.revs = SIDE_REVS;
    s.ret = RUNOUT_S - 0.01;
    expect(armPose(s, pose).lift).toBe(0);
    s.ret = RUNOUT_S + LIFT_S;
    expect(armPose(s, pose).lift).toBe(1);
    expect(pose.r).toBe(GROOVE_IN);
  });

  it("carries leftover time across the end of the side", () => {
    const s = createArmState();
    s.revs = SIDE_REVS - 0.75 * 0.05;
    advanceArm(s, 0.1, 0.75);
    expect(s.ret).toBeCloseTo(0.05, 9);
    s.ret = RETURN_S - 0.02;
    advanceArm(s, 0.1, 0.75);
    expect(s.ret).toBe(-1);
    expect(s.revs).toBeCloseTo(0.08 * 0.75, 9);
  });

  it("doesn't jump when the speed changes", () => {
    const s = createArmState();
    const a = armPose(advanceArm(s, 0.1, revsPerSecond("33")), createArmPose()).r;
    const b = armPose(advanceArm(s, 0.1, revsPerSecond("45")), createArmPose()).r;
    expect(Math.abs(b - a)).toBeLessThan(1e-4);
  });

  it("drops the arm's shadow away from the light, further when lifted", () => {
    const light = new Float64Array(3);
    lightDir(1, light);
    const arm = new Float32Array(ARM_FLOATS);
    const pose = createArmPose();
    armGeometry(pose, light, arm);
    const down = arm[20 + 2] - arm[ARM_HEAD + 2];
    pose.lift = 1;
    armGeometry(pose, light, arm);
    const up = arm[20 + 2] - arm[ARM_HEAD + 2];
    // Light from the right: the shadow falls to the left.
    expect(down).toBeLessThan(0);
    expect(up).toBeLessThan(down);
  });
});

describe("looks", () => {
  it("has a look for every option, with fallbacks", () => {
    for (const { value } of PLINTH_OPTIONS) {
      expect(plinthFor(value)).toBe(PLINTHS[value]);
    }
    for (const { value } of ROOM_OPTIONS) {
      expect(roomFor(value)).toBe(ROOMS[value]);
    }
    expect(plinthFor("oak")).toBe(PLINTHS.walnut);
    expect(roomFor("toString")).toBe(ROOMS.lamp);
  });

  it("lays out the bokeh deterministically, in range, above the turntable", () => {
    const a = bokehLights(3, new Float32Array(BOKEH_COUNT * 4));
    const b = bokehLights(3, new Float32Array(BOKEH_COUNT * 4));
    expect(Array.from(a)).toEqual(Array.from(b));
    let bad = 0;
    for (let i = 0; i < BOKEH_COUNT; i++) {
      const [x, y, r, w] = a.subarray(i * 4, i * 4 + 4);
      if (x < 0 || x > 1 || y < 0.4 || y > 1 || r < BOKEH_R[0] || r > BOKEH_R[1]) {
        bad++;
      }
      if (w <= 0 || w > 1) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });
});
