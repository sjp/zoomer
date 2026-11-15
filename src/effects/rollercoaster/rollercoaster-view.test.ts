import { describe, expect, it } from "vitest";
import { buildTrack, frameAt } from "./rollercoaster-track";
import {
  type Camera,
  createCamera,
  rideCamera,
  rideSpeeds,
  sideCamera,
  sideSpeeds,
  tableAt,
  TIE_SPACING,
} from "./rollercoaster-view";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";

const track = buildTrack();
const ASPECTS = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["21:9", 21 / 9],
  ["9:16", 9 / 16],
] as const;

/** NDC of a world point. */
function project(cam: Camera, x: number, y: number, z: number): [number, number, number] {
  const m = cam.viewProj;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    w,
  ];
}

const sample = (cam: Camera, i: number) =>
  project(cam, track.pos[i * 3], track.pos[i * 3 + 1], track.pos[i * 3 + 2]);

/** Sample index of the highest point, and of the loop's top (the most inverted sample). */
function landmarks(): { crest: number; loopTop: number } {
  let crest = 0;
  let loopTop = 0;
  for (let i = 0; i < track.count; i++) {
    if (track.pos[i * 3 + 1] > track.pos[crest * 3 + 1]) {
      crest = i;
    }
    if (track.nrm[i * 3 + 1] < track.nrm[loopTop * 3 + 1]) {
      loopTop = i;
    }
  }
  return { crest, loopTop };
}

describe("sideCamera", () => {
  it.each(ASPECTS)("keeps the lift's crest and the loop in frame at %s", (_name, aspect) => {
    const cam = createCamera();
    sideCamera(track, aspect, cam);
    const { crest, loopTop } = landmarks();
    for (const i of [crest, loopTop]) {
      const [x, y, w] = sample(cam, i);
      expect(w).toBeGreaterThan(0);
      expect(Math.abs(x)).toBeLessThan(0.95);
      expect(Math.abs(y)).toBeLessThan(0.95);
    }
  });

  it.each(ASPECTS.slice(0, 3))("shows nearly all the circuit at %s", (_name, aspect) => {
    const cam = createCamera();
    sideCamera(track, aspect, cam);
    let inside = 0;
    for (let i = 0; i < track.count; i++) {
      const [x, y] = sample(cam, i);
      if (Math.abs(x) <= 1 && Math.abs(y) <= 1) {
        inside++;
      }
    }
    expect(inside / track.count).toBeGreaterThan(0.9);
  });

  it.each(ASPECTS)("puts the horizon in the upper part of the frame at %s", (_name, aspect) => {
    const cam = createCamera();
    sideCamera(track, aspect, cam);
    // A point far away at eye height, straight ahead.
    const [, y] = project(cam, cam.eye[0], cam.eye[1], cam.eye[2] - 1e5);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(0.6);
  });

  it.each(ASPECTS)(
    "keeps the track low and the tall parts out of the middle at %s",
    (_n, aspect) => {
      const cam = createCamera();
      sideCamera(track, aspect, cam);
      let highest = -Infinity;
      for (let i = 0; i < track.count; i++) {
        const [x, y] = sample(cam, i);
        highest = Math.max(highest, Math.abs(x) < 1 / 3 ? y : -Infinity);
      }
      // Above the speaker's head height, the middle third shows only sky.
      expect(highest).toBeLessThan(0.15);
    },
  );
});

describe("sideSpeeds", () => {
  it.each(ASPECTS)("keeps the train within the codec limit at %s", (_name, aspect) => {
    const cam = createCamera();
    sideCamera(track, aspect, cam);
    const table = new Float64Array(track.count);
    sideSpeeds(track, aspect, table);
    for (let i = 0; i < track.count; i++) {
      const v = table[i];
      expect(v).toBeGreaterThan(0.5);
      expect(v).toBeLessThanOrEqual(track.speed[i] + 1e-9);
      const a = sample(cam, i);
      const b = sample(cam, (i + 1) % track.count);
      const heights = Math.hypot((b[0] - a[0]) * aspect, b[1] - a[1]) / 2 / track.step;
      expect(pxPerReferenceFrame(heights * v)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME + 1e-6);
    }
  });

  it("shows the physics on a wide screen: slow on the lift, fast at the bottom of the drop", () => {
    const table = new Float64Array(track.count);
    sideSpeeds(track, 16 / 9, table);
    const lift = tableAt(track, table, track.crest - 20);
    let fastest = 0;
    for (const v of table) {
      fastest = Math.max(fastest, v);
    }
    expect(fastest).toBeGreaterThan(lift * 3);
  });
});

describe("rideCamera", () => {
  it("sits above the rails, looking a little down the track", () => {
    const cam = createCamera();
    const frame = new Float64Array(12);
    for (let s = 0; s < track.length; s += 7.3) {
      rideCamera(track, s, 16 / 9, cam);
      frameAt(track, s, frame);
      const up =
        (cam.eye[0] - frame[0]) * frame[6] +
        (cam.eye[1] - frame[1]) * frame[7] +
        (cam.eye[2] - frame[2]) * frame[8];
      expect(up).toBeGreaterThan(1);
      const ahead = cam.fwd[0] * frame[3] + cam.fwd[1] * frame[4] + cam.fwd[2] * frame[5];
      expect(ahead).toBeGreaterThan(0.95);
      expect(Math.hypot(cam.fwd[0], cam.fwd[1], cam.fwd[2])).toBeCloseTo(1, 5);
      // The track a few car lengths ahead is in view.
      frameAt(track, s + 6, frame);
      const [x, y, w] = project(cam, frame[0], frame[1], frame[2]);
      expect(w).toBeGreaterThan(0);
      expect(Math.abs(x)).toBeLessThan(1);
      expect(Math.abs(y)).toBeLessThan(1);
    }
  });
});

describe("rideSpeeds", () => {
  it.each(ASPECTS)("turns the view and passes the ties within the codec limits at %s", (_n, a) => {
    const table = new Float64Array(track.count);
    rideSpeeds(track, a, table);
    const cam = createCamera();
    rideCamera(track, 0, a, cam);
    const heightsPerRadian = Math.max(1 / (2 * cam.tanHalf), Math.hypot(a, 1) / 2);
    const fa = new Float64Array(12);
    const fb = new Float64Array(12);
    for (let i = 0; i < track.count; i++) {
      const v = table[i];
      expect(v).toBeGreaterThan(0.3);
      expect(v / TIE_SPACING).toBeLessThanOrEqual(MAX_PATTERN_HZ + 1e-9);
      frameAt(track, i * track.step, fa);
      frameAt(track, (i + 1) * track.step, fb);
      let sum = 0;
      for (let k = 3; k < 12; k++) {
        sum += (fb[k] - fa[k]) ** 2;
      }
      const turn = (Math.sqrt(sum / 2) / track.step) * v;
      expect(pxPerReferenceFrame(turn * heightsPerRadian)).toBeLessThanOrEqual(
        MAX_FEATURE_PX_PER_FRAME + 1e-6,
      );
    }
  });
});

describe("tableAt", () => {
  it("interpolates and wraps", () => {
    const table = new Float64Array(track.count).map((_v, i) => i);
    expect(tableAt(track, table, 2.5 * track.step)).toBeCloseTo(2.5, 9);
    expect(tableAt(track, table, track.length + 2 * track.step)).toBeCloseTo(2, 9);
    expect(tableAt(track, table, -track.step)).toBeCloseTo(track.count - 1, 9);
  });
});
