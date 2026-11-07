/**
 * Library Window simulation: room palettes, the sunbeam's geometry and soft mask
 * (mirrored in the room shader), the seeded cloud-pass schedule, and dust motes
 * drifting on a slow divergence-free field inside the beam's box.
 *
 * Units are 1080p reference px, y up.
 */
import { shelfSideWidth, type ShelfPalette } from "../bookshelf";
import type { BeamId, PaletteId } from "./library.meta";
import { createRng, hash32 } from "../noise";
import { smoothstep, wrap } from "../math";

export const REF_HEIGHT = 1080;

export interface RoomPalette extends ShelfPalette {
  /** Back wall between the bookcases. */
  wall: string;
  floor: string;
  /** Lamp light and bokeh colour. */
  lamp: string;
}

export const ROOM_PALETTES: Readonly<Record<PaletteId, RoomPalette>> = {
  oak: {
    wall: "#7d6a55",
    floor: "#4a3526",
    lamp: "#ffb35c",
    wood: "#8a6440",
    back: "#3a2a1e",
    spines: [
      "#6b3a26",
      "#4a5a3a",
      "#7a2c2c",
      "#d8c9a3",
      "#5a4030",
      "#2f4a45",
      "#9c7a4a",
      "#3c2a22",
    ],
  },
  walnut: {
    wall: "#5c4a3c",
    floor: "#2e2019",
    lamp: "#ffad55",
    wood: "#4e3424",
    back: "#22170f",
    spines: [
      "#5a2a1e",
      "#2c3d2c",
      "#6a1f24",
      "#c7b38a",
      "#3d2a20",
      "#1f3333",
      "#7a5a32",
      "#2a1d18",
    ],
  },
  painted: {
    wall: "#a39a86",
    floor: "#5a4636",
    lamp: "#ffbf6e",
    wood: "#3f5b57",
    back: "#24302e",
    spines: [
      "#b0503a",
      "#d9c7a0",
      "#3d5f7a",
      "#c49a3a",
      "#6d3550",
      "#7a8a5a",
      "#e3dccb",
      "#2f3b4f",
    ],
  },
  archive: {
    wall: "#7a7468",
    floor: "#3f3a33",
    lamp: "#ffc070",
    wood: "#6b6254",
    back: "#2c2924",
    spines: [
      "#a89c84",
      "#8a8070",
      "#c9bfa6",
      "#6e6658",
      "#8c6f55",
      "#5f6a66",
      "#b7aa8c",
      "#7d5f4c",
    ],
  },
};

/** Sunlight colour (beam, motes). */
export const SUN = [1, 0.86, 0.62] as const;

// ---------------------------------------------------------------------------
// Beam
// ---------------------------------------------------------------------------

/** Beam angle below the horizontal, radians. */
const BEAM_ANGLE = (22 * Math.PI) / 180;
/** Window position off-frame, beyond the top corner (reference px). */
const BEAM_OFFSET_X = 150;
const BEAM_OFFSET_Y = 200;
/** Half-width at the window and its growth per px along the beam. */
export const BEAM_W0 = 60;
export const BEAM_SPREAD = 0.12;
/** The beam fades in over this range of distance from the window (it enters the frame). */
export const BEAM_IN = [150, 550] as const;
/** It fades out from this fraction of its length to the end. */
export const BEAM_OUT = 0.6;
/** Across the beam, the mask falls from 1 to 0 between these fractions of the half-width. */
export const BEAM_CORE = 0.35;
/** Where the beam ends, as a fraction of the frame width from its window side. */
const BEAM_REACH = 0.78;

export interface BeamGeometry {
  /** Window point (reference px, y up). */
  ox: number;
  oy: number;
  /** Unit direction along the beam and its normal. */
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  /** Length along the beam (reference px). */
  length: number;
  /** The box's half-height across the beam: the half-width at the end. */
  halfBox: number;
}

export function createBeamGeometry(): BeamGeometry {
  return { ox: 0, oy: 0, dx: 1, dy: 0, nx: 0, ny: 1, length: 1, halfBox: 1 };
}

/** Fills `g` for a beam from the top-left or top-right corner of a `refWidth`-wide frame. */
export function beamGeometry(
  g: BeamGeometry,
  side: Exclude<BeamId, "off">,
  refWidth: number,
): BeamGeometry {
  const sx = side === "left" ? 1 : -1;
  const c = Math.cos(BEAM_ANGLE);
  const s = Math.sin(BEAM_ANGLE);
  g.ox = side === "left" ? -BEAM_OFFSET_X : refWidth + BEAM_OFFSET_X;
  g.oy = REF_HEIGHT + BEAM_OFFSET_Y;
  g.dx = sx * c;
  g.dy = -s;
  g.nx = -g.dy;
  g.ny = g.dx;
  g.length = (BEAM_REACH * refWidth + BEAM_OFFSET_X) / c;
  g.halfBox = beamHalfWidth(g.length);
  return g;
}

export function beamHalfWidth(s: number): number {
  return BEAM_W0 + BEAM_SPREAD * Math.max(0, s);
}

/** Fade along the beam: in as it enters the frame, out towards its end. */
export function beamAlong(s: number, length: number): number {
  return smoothstep(BEAM_IN[0], BEAM_IN[1], s) * (1 - smoothstep(BEAM_OUT * length, length, s));
}

/**
 * The beam's soft mask in [0, 1] at `s` px along it and `t` px across, from the
 * window. 0 at and beyond the box's edges. The room shader computes the same.
 */
export function beamMaskLocal(g: BeamGeometry, s: number, t: number): number {
  const across = 1 - smoothstep(BEAM_CORE, 1, Math.abs(t) / beamHalfWidth(s));
  return across * beamAlong(s, g.length);
}

/** Lamp height (reference px): on a table in front of the lower shelves. */
export const LAMP_Y = 330;

/**
 * The lamp stands in front of the bookcase opposite the window (on the right
 * when the beam is off), a little in from the frame edge. Writes into `out`.
 */
export function lampPosition(
  out: { x: number; y: number },
  beam: BeamId,
  refWidth: number,
): { x: number; y: number } {
  const inset = shelfSideWidth(refWidth) * 0.45;
  out.x = beam === "right" ? inset : refWidth - inset;
  out.y = LAMP_Y;
  return out;
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/** One cloud pass per slot, starting somewhere in its first `CLOUD_START` seconds. */
export const CLOUD_SLOT = 120;
const CLOUD_START = 60;
/** Dim depth range (fraction of the beam lost at the deepest). */
export const CLOUD_DEPTH = [0.4, 0.7] as const;
/** Fade in, hold and fade out ranges, seconds. */
const CLOUD_FADE = [3, 6] as const;
const CLOUD_HOLD = [2, 8] as const;
/** Longest pass: it always ends well inside its slot. */
export const CLOUD_MAX_PASS = 2 * CLOUD_FADE[1] + CLOUD_HOLD[1];

const unit = (h: number) => h / 4294967296;

/**
 * Sunlight through the window at `time` seconds: 1 in clear sky, dipping
 * smoothly by 40–70% for a few seconds during each cloud pass. Passes start
 * 60–180 s apart (one per 2-minute slot, early in the slot). A pure, C1
 * function of time; allocates nothing.
 */
export function cloudLight(seed: number, time: number): number {
  const slot = Math.floor(Math.max(0, time) / CLOUD_SLOT);
  // `hash32` reads its argument as an int32 anyway, so `seed` needs no `| 0` first.
  let h = hash32((hash32(seed) ^ Math.imul(slot + 1, 0x9e3779b1)) >>> 0);
  const start = unit(h) * CLOUD_START;
  h = hash32(h);
  const depth = CLOUD_DEPTH[0] + (CLOUD_DEPTH[1] - CLOUD_DEPTH[0]) * unit(h);
  h = hash32(h);
  const fadeIn = CLOUD_FADE[0] + (CLOUD_FADE[1] - CLOUD_FADE[0]) * unit(h);
  h = hash32(h);
  const hold = CLOUD_HOLD[0] + (CLOUD_HOLD[1] - CLOUD_HOLD[0]) * unit(h);
  h = hash32(h);
  const fadeOut = CLOUD_FADE[0] + (CLOUD_FADE[1] - CLOUD_FADE[0]) * unit(h);
  const local = time - slot * CLOUD_SLOT - start;
  const bump =
    smoothstep(0, fadeIn, local) * (1 - smoothstep(fadeIn + hold, fadeIn + hold + fadeOut, local));
  return 1 - depth * bump;
}

// ---------------------------------------------------------------------------
// Dust motes
// ---------------------------------------------------------------------------

/**
 * Stream function terms for the air currents: wave vector (per px), angular
 * speed (rad/s) and amplitude (px²/s). The velocity is its curl, so the flow
 * neither bunches motes up nor thins them out. Peak speed is about 10 px/s.
 */
const FLOW = [
  [0.0061, 0.0043, 0.11, 520],
  [-0.0037, 0.0072, 0.07, 460],
  [0.0089, -0.0028, 0.13, 300],
] as const;
/** Slow settling, px/s straight down the screen. */
const SETTLE = 1.2;
/** Glint spin speed range, rad/s. */
const SPIN = [0.5, 1.3] as const;

export interface Motes {
  readonly max: number;
  /** Position along the beam as a fraction of its length, in [0, 1). */
  readonly s: Float64Array;
  /** Position across the beam as a fraction of the box's half-height, in [-1, 1). */
  readonly t: Float64Array;
  /** 0 = in the focal plane (small, crisp), 1 = far out of focus. */
  readonly depth: Float32Array;
  /** Glint phase (radians) and its rate. */
  readonly phase: Float64Array;
  readonly spin: Float32Array;
  /** Flow phase offsets per term, from the seed. */
  readonly flowPhase: Float64Array;
}

/** `max` motes spread evenly through the beam's box, deterministic per seed. */
export function createMotes(seed: number, max: number): Motes {
  const rng = createRng(seed ^ 0xd057);
  const m: Motes = {
    max,
    s: new Float64Array(max),
    t: new Float64Array(max),
    depth: new Float32Array(max),
    phase: new Float64Array(max),
    spin: new Float32Array(max),
    flowPhase: new Float64Array(FLOW.length),
  };
  for (let i = 0; i < max; i++) {
    m.s[i] = rng();
    m.t[i] = rng() * 2 - 1;
    m.depth[i] = rng();
    m.phase[i] = rng() * 2 * Math.PI;
    m.spin[i] = SPIN[0] + (SPIN[1] - SPIN[0]) * rng();
  }
  for (let k = 0; k < FLOW.length; k++) {
    m.flowPhase[k] = rng() * 2 * Math.PI;
  }
  return m;
}

/** Flow velocity scratch: px/s along and across the beam. */
const vel = { s: 0, t: 0 };

/**
 * Air velocity at `s`, `t` px in the beam's frame: the curl of a sum of slowly
 * travelling sine waves, plus a slow settle down the screen. Writes into `out`.
 */
export function flowAt(
  g: BeamGeometry,
  phase: Float64Array,
  s: number,
  t: number,
  time: number,
  out: { s: number; t: number },
): void {
  let vs = 0;
  let vt = 0;
  for (let k = 0; k < FLOW.length; k++) {
    const f = FLOW[k];
    const c = f[3] * Math.cos(f[0] * s + f[1] * t + f[2] * time + phase[k]);
    // psi = a sin(kx s + ky t + ...): v = (d psi / dt, -d psi / ds).
    vs += c * f[1];
    vt -= c * f[0];
  }
  // Screen-down (0, -1) in the beam's frame.
  out.s = vs - SETTLE * g.dy;
  out.t = vt - SETTLE * g.ny;
}

/**
 * Moves the first `count` motes along the flow for `dt` seconds, wrapping them
 * inside the beam's box (they wrap where the mask is 0, so unseen), and spins
 * their glints.
 */
export function stepMotes(
  m: Motes,
  g: BeamGeometry,
  count: number,
  time: number,
  dt: number,
): void {
  const n = Math.min(count, m.max);
  for (let i = 0; i < n; i++) {
    const s = m.s[i] * g.length;
    const t = m.t[i] * g.halfBox;
    flowAt(g, m.flowPhase, s, t, time, vel);
    m.s[i] = wrap(m.s[i] + (vel.s * dt) / g.length, 0, 1);
    m.t[i] = wrap(m.t[i] + (vel.t * dt) / g.halfBox, -1, 2);
    m.phase[i] += m.spin[i] * dt;
    if (m.phase[i] > 2 * Math.PI) {
      m.phase[i] -= 2 * Math.PI;
    }
  }
}

/**
 * A mote's glint in [0, 1]: mostly dim, briefly bright once per turn, and more
 * so where the beam is strongest. Never faster than a few seconds per glint.
 */
export function moteGlint(phase: number, mask: number): number {
  const p = 0.5 + 0.5 * Math.sin(phase);
  const p2 = p * p;
  return 0.55 + 0.9 * p2 * p2 * p2 * mask;
}
