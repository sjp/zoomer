import { describe, expect, it } from "vitest";
import {
  BLEND_SIZE,
  blendPose,
  FOOT,
  FOREARM,
  J_BACK_ANKLE,
  J_BACK_ELBOW,
  J_BACK_HAND,
  J_BACK_KNEE,
  J_BACK_TOE,
  J_BACK_WRIST,
  J_FRONT_ANKLE,
  J_FRONT_ELBOW,
  J_FRONT_HAND,
  J_FRONT_KNEE,
  J_FRONT_TOE,
  J_FRONT_WRIST,
  J_HEAD,
  J_HIP,
  J_NECK,
  J_SHOULDER,
  JOINT_COUNT,
  NECK_TO_HEAD,
  POSE_COUNT,
  POSE_HIGH_FIVE,
  POSE_LAPTOP,
  POSE_SIZE,
  POSES,
  poseWeight,
  SHIN,
  solveRig,
  STRETCH_FORE,
  STRETCH_UPPER,
  THIGH,
  TORSO,
  UPPER_ARM,
} from "./memphis-figures";

const pose = new Float64Array(BLEND_SIZE);
const joints = new Float64Array(2 * JOINT_COUNT);
const dist = (a: number, b: number) =>
  Math.hypot(joints[2 * a] - joints[2 * b], joints[2 * a + 1] - joints[2 * b + 1]);

const pairs: [number, number][] = [];
for (let a = 0; a < POSE_COUNT; a++) {
  for (let b = 0; b < POSE_COUNT; b++) {
    if (a !== b) {
      pairs.push([a, b]);
    }
  }
}
const steps = Array.from({ length: 21 }, (_, i) => i / 20);

describe("corporate memphis poses", () => {
  it("has every pose the same size", () => {
    expect(POSES).toHaveLength(POSE_COUNT);
    for (const p of POSES) {
      expect(p).toHaveLength(POSE_SIZE);
    }
  });

  it.each(pairs)("tweens pose %i to %i with limbs attached and lengths fixed", (from, to) => {
    const upper = 5;
    const fore = 7;
    const hf = from === POSE_HIGH_FIVE || to === POSE_HIGH_FIVE;
    for (const t of steps) {
      blendPose(from, to, t, upper, fore, pose);
      solveRig(pose, joints);
      expect(dist(J_HIP, J_NECK)).toBeCloseTo(TORSO, 9);
      expect(dist(J_NECK, J_HEAD)).toBeCloseTo(NECK_TO_HEAD, 9);
      expect(dist(J_SHOULDER, J_BACK_ELBOW)).toBeCloseTo(UPPER_ARM, 9);
      expect(dist(J_BACK_ELBOW, J_BACK_WRIST)).toBeCloseTo(FOREARM, 9);
      expect(dist(J_HIP, J_BACK_KNEE)).toBeCloseTo(THIGH, 9);
      expect(dist(J_BACK_KNEE, J_BACK_ANKLE)).toBeCloseTo(SHIN, 9);
      expect(dist(J_BACK_ANKLE, J_BACK_TOE)).toBeCloseTo(FOOT, 9);
      expect(dist(J_HIP, J_FRONT_KNEE)).toBeCloseTo(THIGH, 9);
      expect(dist(J_FRONT_KNEE, J_FRONT_ANKLE)).toBeCloseTo(SHIN, 9);
      expect(dist(J_FRONT_ANKLE, J_FRONT_TOE)).toBeCloseTo(FOOT, 9);
      // The front arm only stretches in the high five, never past its target.
      const su = pose[STRETCH_UPPER];
      const sf = pose[STRETCH_FORE];
      expect(hf || (su === 1 && sf === 1)).toBe(true);
      expect(su).toBeGreaterThanOrEqual(1);
      expect(su).toBeLessThanOrEqual(upper);
      expect(sf).toBeLessThanOrEqual(fore);
      expect(dist(J_SHOULDER, J_FRONT_ELBOW)).toBeCloseTo(UPPER_ARM * su, 9);
      expect(dist(J_FRONT_ELBOW, J_FRONT_WRIST)).toBeCloseTo(FOREARM * sf, 9);
    }
    // Starts and ends exactly on the library's poses.
    blendPose(from, to, 0, upper, fore, pose);
    expect(Array.from(pose.subarray(0, POSE_SIZE))).toEqual(POSES[from]);
    blendPose(from, to, 1, upper, fore, pose);
    expect(Array.from(pose.subarray(0, POSE_SIZE))).toEqual(POSES[to]);
    expect(pose[STRETCH_UPPER]).toBe(to === POSE_HIGH_FIVE ? upper : 1);
  });

  it("raises the high-five arm before stretching it, and shrinks it before lowering", () => {
    const from = 0;
    // A quarter in, the arm is up but no longer.
    blendPose(from, POSE_HIGH_FIVE, 0.25, 5, 7, pose);
    expect(pose[STRETCH_UPPER]).toBe(1);
    expect(pose[STRETCH_FORE]).toBe(1);
    solveRig(pose, joints);
    expect(joints[2 * J_FRONT_ELBOW + 1]).toBeGreaterThan(joints[2 * J_SHOULDER + 1]);
    // Undone the same way.
    blendPose(POSE_HIGH_FIVE, from, 0.75, 5, 7, pose);
    expect(pose[STRETCH_UPPER]).toBe(1);
    blendPose(POSE_HIGH_FIVE, from, 0.2, 5, 7, pose);
    expect(pose[STRETCH_UPPER]).toBeGreaterThan(1);
    expect(pose[STRETCH_FORE]).toBeGreaterThan(1);
    solveRig(pose, joints);
    // Still up and reaching forward while it shrinks.
    expect(joints[2 * J_FRONT_ELBOW + 1]).toBeGreaterThan(joints[2 * J_SHOULDER + 1]);
    expect(dist(J_FRONT_ELBOW, J_FRONT_WRIST)).toBeGreaterThan(FOREARM);
    expect(joints[2 * J_FRONT_WRIST]).toBeGreaterThan(joints[2 * J_BACK_WRIST]);
    expect(joints[2 * J_BACK_HAND]).toBeLessThan(joints[2 * J_FRONT_HAND]);
  });

  it("weights props by pose", () => {
    expect(poseWeight(POSE_LAPTOP, POSE_LAPTOP, POSE_LAPTOP, 1)).toBe(1);
    expect(poseWeight(POSE_LAPTOP, 0, POSE_LAPTOP, 0)).toBe(0);
    expect(poseWeight(POSE_LAPTOP, 0, POSE_LAPTOP, 0.5)).toBeCloseTo(0.5, 9);
    expect(poseWeight(POSE_LAPTOP, POSE_LAPTOP, 0, 1)).toBe(0);
  });
});
