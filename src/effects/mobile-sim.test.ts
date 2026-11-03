import { describe, expect, it } from "vitest";
import {
  armYaw,
  createMobile,
  createMotion,
  gustAt,
  MAX_ARMS,
  MAX_SHAPES,
  MAX_WIRES,
  maxYawOffset,
  type Mobile,
  type MobileArm,
  PALETTE_SLOTS,
  paletteFor,
  poseMobile,
  SHAPE_CRESCENT,
  SHAPE_DISC,
  SHAPE_PETAL,
  shapeArea,
  shapeSdf,
  type ShapeKind,
  stepMotion,
  WIRE_FLOATS,
  writeWires,
} from "./mobile-sim";
import { PALETTE_OPTIONS, SIDE_OPTIONS } from "./mobile.meta";

const SIDES = SIDE_OPTIONS.map((o) => o.value);
const SEEDS = [0, 7, 42, 123, 999];
const LEVELS = [2, 3, 4];
const ASPECTS = [16 / 9, 4 / 3];
const KINDS: ShapeKind[] = [SHAPE_DISC, SHAPE_PETAL, SHAPE_CRESCENT];

const mobiles = SIDES.flatMap((side) =>
  LEVELS.flatMap((levels) =>
    ASPECTS.flatMap((aspect) =>
      SEEDS.map((seed) => ({
        label: `${side} L${levels} ${aspect.toFixed(2)} #${seed}`,
        mobile: createMobile(seed, levels, side, aspect),
      })),
    ),
  ),
);

function mass(arm: MobileArm): number {
  let m = 0;
  for (const end of arm.ends) m += end.arm ? mass(end.arm) : (end.shape?.mass ?? 0);
  return m;
}

function depth(arm: MobileArm): number {
  let d = 1;
  for (const end of arm.ends) if (end.arm) d = Math.max(d, 1 + depth(end.arm));
  return d;
}

function signature(m: Mobile): string {
  return m.arms.map((a) => `${a.a.toFixed(6)}/${a.b.toFixed(6)}/${a.drop.toFixed(6)}`).join(",");
}

describe("shapes", () => {
  it("have the areas the balance uses, and fit the unit disc", () => {
    const n = 400;
    const bad: string[] = [];
    for (const kind of KINDS) {
      let inside = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = -1 + (2 * (i + 0.5)) / n;
          const y = -1 + (2 * (j + 0.5)) / n;
          if (shapeSdf(kind, x, y) < 0) inside++;
        }
      }
      const area = (inside * 4) / (n * n);
      if (Math.abs(area / shapeArea(kind) - 1) > 0.01) bad.push(`kind ${kind}: ${area}`);
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        if (shapeSdf(kind, 1.001 * Math.cos(a), 1.001 * Math.sin(a)) <= 0) bad.push(`kind ${kind}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("have a full palette for every option", () => {
    for (const o of PALETTE_OPTIONS) expect(paletteFor(o.value)).toHaveLength(PALETTE_SLOTS);
    expect(paletteFor("nope")).toBe(paletteFor("primary"));
  });
});

describe("createMobile", () => {
  it("balances every arm: zero net torque about its pivot", () => {
    const bad: string[] = [];
    for (const { label, mobile } of mobiles) {
      for (const arm of mobile.arms) {
        const m0 = arm.ends[0].arm ? mass(arm.ends[0].arm) : (arm.ends[0].shape?.mass ?? 0);
        const m1 = arm.ends[1].arm ? mass(arm.ends[1].arm) : (arm.ends[1].shape?.mass ?? 0);
        const torque = m0 * arm.a - m1 * arm.b;
        if (!(Math.abs(torque) <= 1e-9 * (m0 + m1) * (arm.a + arm.b))) bad.push(label);
        if (!(arm.a > 0 && arm.b > 0)) bad.push(`${label}: arm sides ${arm.a}, ${arm.b}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("has as many levels as asked, within the buffer limits", () => {
    const bad: string[] = [];
    for (const { label, mobile } of mobiles) {
      const levels = Number(label.split(" L")[1].split(" ")[0]);
      if (depth(mobile.root) !== levels) bad.push(`${label}: depth ${depth(mobile.root)}`);
      if (mobile.arms.length > MAX_ARMS || mobile.shapes.length > MAX_SHAPES) bad.push(label);
      if (mobile.shapes.length !== mobile.arms.length + 1) bad.push(label);
    }
    expect(bad).toEqual([]);
  });

  it("is deterministic per seed", () => {
    expect(signature(createMobile(5, 3, "right", 16 / 9))).toBe(
      signature(createMobile(5, 3, "right", 16 / 9)),
    );
    expect(signature(createMobile(5, 3, "right", 16 / 9))).not.toBe(
      signature(createMobile(6, 3, "right", 16 / 9)),
    );
  });

  it("copes with odd levels and a portrait frame", () => {
    expect(depth(createMobile(1, Number.NaN, "left", 16 / 9).root)).toBe(2);
    expect(depth(createMobile(1, 9, "left", 16 / 9).root)).toBe(4);
    const tall = createMobile(1, 4, "across", 9 / 16);
    expect(tall.x0).toBeGreaterThanOrEqual(0);
    expect(tall.x1).toBeLessThanOrEqual(9 / 16);
  });
});

describe("motion", () => {
  it("keeps every part in its region, continuous, bounded and clear of the others", () => {
    const wires = new Float32Array(MAX_WIRES * WIRE_FLOATS);
    const dt = 1 / 20;
    const steps = 2400;
    const eps = 1e-6;
    const bad: string[] = [];
    // A few mobiles over two minutes, with the draught moving across its range.
    for (const { label, mobile } of mobiles.filter((_, i) => i % 6 === 0)) {
      const motion = createMotion(0);
      const prev = new Float64Array(mobile.shapes.length * 3);
      let maxJump = 0;
      let minGap = Infinity;
      let outside = 0;
      let yawOver = 0;
      for (let s = 0; s <= steps; s++) {
        stepMotion(motion, dt, s < steps / 2 ? 1 : 0.2);
        poseMobile(mobile, motion);
        for (const arm of mobile.arms) {
          if (Math.abs(arm.yaw - arm.yaw0) > maxYawOffset(arm) + eps) yawOver++;
        }
        const shapes = mobile.shapes;
        for (let i = 0; i < shapes.length; i++) {
          const sh = shapes[i];
          if (
            sh.x - sh.r < mobile.x0 - eps ||
            sh.x + sh.r > mobile.x1 + eps ||
            sh.y - sh.r < mobile.y0 - eps ||
            sh.y + sh.r > mobile.y1 + eps ||
            sh.z - sh.r <= mobile.wallZ
          ) {
            outside++;
          }
          if (s > 0) {
            const jump = Math.hypot(
              sh.x - prev[i * 3],
              sh.y - prev[i * 3 + 1],
              sh.z - prev[i * 3 + 2],
            );
            maxJump = Math.max(maxJump, jump);
          }
          prev[i * 3] = sh.x;
          prev[i * 3 + 1] = sh.y;
          prev[i * 3 + 2] = sh.z;
          for (let j = 0; j < i; j++) {
            const o = shapes[j];
            const gap = Math.hypot(sh.x - o.x, sh.y - o.y, sh.z - o.z) - sh.r - o.r;
            minGap = Math.min(minGap, gap);
          }
        }
        const n = writeWires(mobile, wires);
        for (let k = 0; k < n * 2; k++) {
          const x = wires[k * 3];
          const y = wires[k * 3 + 1];
          const z = wires[k * 3 + 2];
          if (x < mobile.x0 - eps || x > mobile.x1 + eps || y < mobile.y0 - eps || y > 1 + eps) {
            outside++;
          }
          if (z <= mobile.wallZ) outside++;
        }
      }
      // Shapes move at most a few thousandths of the frame height per twentieth of a second.
      if (maxJump > 0.006) bad.push(`${label}: jump ${maxJump}`);
      if (outside > 0) bad.push(`${label}: ${outside} parts outside`);
      if (yawOver > 0) bad.push(`${label}: yaw out of bounds`);
      if (!(minGap > 0)) bad.push(`${label}: shapes touch (${minGap})`);
    }
    expect(bad).toEqual([]);
  });

  it("follows the draught smoothly and only swings while a gust passes", () => {
    const m = createMotion(0);
    stepMotion(m, 0.1, 1);
    expect(m.level).toBeCloseTo(0.02, 10);
    stepMotion(m, 0.1, Number.NaN);
    expect(m.level).toBeCloseTo(0, 10);
    const mobile = createMobile(3, 3, "left", 16 / 9);
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 600; t += 0.5) {
      const g = gustAt(mobile, t);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0.5);
    expect(hi).toBeLessThanOrEqual(1);
    // Still air: hanging wires stay vertical.
    const still = createMotion(0);
    still.t = 1234;
    poseMobile(mobile, still);
    expect(mobile.root.px).toBe(mobile.hookX);
    expect(armYaw(mobile.root, 0)).toBeCloseTo(mobile.root.yaw, 12);
  });
});
