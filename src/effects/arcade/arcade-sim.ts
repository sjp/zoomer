/**
 * The Arcade Attract Mode's logic, all pure so it can be tested and scrubbed:
 * the attract loop's phase clock, the demo world (the tug's autopilot route,
 * the crates it collects, the mines and debris drifting round) as a function of
 * the demo's time and the seed, and the high-score table.
 *
 * Lengths are game px (y down, the HUD band at the top); times are loop seconds,
 * which run at `effectivePace` times real time.
 */
import { glyphCell } from "./arcade-art";
import { clamp, fract, smoothstep, wrap } from "../math";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import { createRng, hash32 } from "../noise";
import { MAX_PACE, MIN_PACE } from "./arcade.meta";

// ---------------------------------------------------------------------------
// The game's resolution

/** Scanlines of a landscape game image, and the least width of a portrait one. */
export const GAME_LINES = 224;
const GAME_MIN_WIDTH = 256;
/** The widest and tallest the game image gets, for extreme aspects. */
const GAME_MAX_WIDTH = 640;
const GAME_MAX_HEIGHT = 560;

/** The game's size for a screen of `width` x `height`: 224 lines, or 256 px wide when narrower. */
export function gameSize(width: number, height: number): { width: number; height: number } {
  const a = width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : 16 / 9;
  if (a >= GAME_MIN_WIDTH / GAME_LINES) {
    return { width: Math.min(GAME_MAX_WIDTH, Math.round(GAME_LINES * a)), height: GAME_LINES };
  }
  return {
    width: GAME_MIN_WIDTH,
    height: Math.min(GAME_MAX_HEIGHT, Math.round(GAME_MIN_WIDTH / a)),
  };
}

/** Whether a game this size splits its text into the outer thirds, round the speaker. */
export const isWide = (width: number, height: number) => width >= 1.5 * height;

// ---------------------------------------------------------------------------
// The attract loop

export const PHASES = [
  { id: "title", seconds: 6 },
  { id: "demo", seconds: 20 },
  { id: "scores", seconds: 8 },
  { id: "coin", seconds: 4 },
] as const;

/** Loop seconds of the whole attract loop. */
export const LOOP_SECONDS = PHASES.reduce((s, p) => s + p.seconds, 0);
/** Loop seconds a phase's scanline wipe takes, at the start of the phase. */
export const WIPE_SECONDS = 0.8;

export interface PhaseState {
  /** Index into `PHASES`. */
  index: number;
  /** Loop seconds since the phase began. */
  local: number;
}

/** The phase at `loopTime` (any value; wrapped to the loop), written into `out`. */
export function phaseAt(loopTime: number, out: PhaseState): PhaseState {
  let t = wrap(Number.isFinite(loopTime) ? loopTime : 0, 0, LOOP_SECONDS);
  for (let i = 0; i < PHASES.length; i++) {
    const s = PHASES[i].seconds;
    if (t < s || i === PHASES.length - 1) {
      out.index = i;
      out.local = Math.min(t, s);
      return out;
    }
    t -= s;
  }
  return out;
}

/** The tug's top speed, game px per loop second. */
export const TUG_SPEED = 40;

/**
 * The pace the loop runs at: the slider's value, clamped to its range and to
 * the fastest pace at which the tug (the fastest sprite) stays within the
 * codec's per-frame motion limit on a full-frame screen of `GAME_LINES` lines.
 */
export function effectivePace(pace: number): number {
  const p = Number.isFinite(pace) ? clamp(pace, MIN_PACE, MAX_PACE) : 1;
  const cap = MAX_FEATURE_PX_PER_FRAME / pxPerReferenceFrame(TUG_SPEED / GAME_LINES);
  return Math.min(p, cap);
}

/** Loop seconds per blink of "INSERT COIN": at the fastest pace, still under 1 Hz. */
export const BLINK_PERIOD = 1.6;

/**
 * "INSERT COIN"'s brightness `local` loop seconds into its phase: a soft
 * trapezoid that is fully lit over most of each period, ramping in and out.
 */
export function blinkLevel(local: number): number {
  const p = fract(local / BLINK_PERIOD);
  return 0.12 + 0.88 * smoothstep(0, 0.18, p) * (1 - smoothstep(0.6, 0.78, p));
}

// ---------------------------------------------------------------------------
// The high-score table

/** Made-up initials the table draws from. */
const INITIALS_POOL: readonly string[] = [
  "JRM",
  "KTB",
  "LNS",
  "MPW",
  "DGH",
  "RVC",
  "AJP",
  "BSK",
  "CLT",
  "EMR",
  "FNG",
  "GWH",
  "HRB",
  "JDV",
  "KLM",
  "NRD",
  "PTS",
  "RKW",
  "SJB",
  "TDL",
  "VGN",
  "WPC",
  "ZRK",
  "ACE",
  "JET",
  "ROB",
  "SAM",
  "DAN",
  "LIZ",
  "MAX",
];

export const SCORE_ROWS = 10;

export interface ScoreRow {
  name: string;
  score: number;
  /** Whether this is the owner's entry. */
  owner: boolean;
}

/** The owner's initials as the table shows them: up to three characters the font has, in capitals. */
export function sanitizeInitials(raw: string): string {
  let out = "";
  for (const ch of raw.toUpperCase()) {
    if (out.length < 3 && glyphCell(ch) >= 0) {
      out += ch;
    }
  }
  return out;
}

const round50 = (n: number) => Math.round(n / 50) * 50;

/**
 * Ten rows, best first: seeded made-up initials and scores, or with the
 * owner's `initials` (already sanitised) at the top, a little ahead of the rest.
 */
export function highScores(seed: number, initials: string): ScoreRow[] {
  const rng = createRng(hash32(Math.floor(seed) ^ 0x5c0e5));
  const pool = [...INITIALS_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const rows: ScoreRow[] = [];
  let score = round50(42000 + rng() * 48000);
  const owner = initials !== "";
  if (owner) {
    rows.push({ name: initials, score: round50(score * 1.12) + 50, owner: true });
  }
  for (let i = 0; rows.length < SCORE_ROWS; i++) {
    rows.push({ name: pool[i], score, owner: false });
    score = round50(score * (0.8 + 0.1 * rng()));
  }
  return rows;
}

/** A rank as an ordinal: 1ST, 2ND, 3RD, 4TH... */
export function ordinal(rank: number): string {
  const tens = rank % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "TH"
      : rank % 10 === 1
        ? "ST"
        : rank % 10 === 2
          ? "ND"
          : rank % 10 === 3
            ? "RD"
            : "TH";
  return `${String(rank)}${suffix}`;
}

// ---------------------------------------------------------------------------
// The demo world

/** Height of the HUD band at the top of the demo, px. */
const HUD_HEIGHT = 22;
/** Margin the tug keeps from the playfield's edges, px. */
const TUG_MARGIN = 14;
/** Distance between the tug's and a mine's centres that would be a collision, px. */
export const CONTACT = 12;
/** Clearance the autopilot keeps, and the range at which it starts steering away. */
const SAFE = 24;
const AVOID = 42;
/** Tug acceleration, px/s². */
const ACCEL = 70;
/** The simulation step, s, and the loop seconds the plan covers (the demo plus its wipe out). */
const STEP = 1 / 60;
const PLAN_SECONDS = PHASES[1].seconds + WIPE_SECONDS + 0.2;
/** Most crates on the field at once, and the delay before a collected one is replaced. */
const LIVE_CRATES = 3;
const RESPAWN = 1.2;
/** Seconds a crate takes to appear. */
export const CRATE_FADE = 0.4;
/** Points per crate, and the seconds the score takes to count up. */
const CRATE_POINTS = 250;
const COUNT_UP = 0.6;
/** Seconds, on top of the time the trip should take, before the tug gives up on a crate. */
const GIVE_UP = 3;
const MAX_CRATES = 48;
/** The fastest a mine drifts, px/s. */
const MINE_SPEED = 9;
const DEBRIS_COUNT = 7;

interface Mine {
  cx: number;
  cy: number;
  ax: number;
  ay: number;
  wx: number;
  wy: number;
  px: number;
  py: number;
  spin: number;
}

interface Debris {
  kind: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
}

/** The demo, planned once per seed and game size. */
export interface DemoPlan {
  width: number;
  height: number;
  mines: Mine[];
  debris: Debris[];
  /** The tug at each step: x, y, heading (radians, 0 along +x), thrust (0..1). */
  tug: Float32Array;
  steps: number;
  /** Crates in order of appearance: position, the time each appears and is collected (Infinity if never). */
  crateX: Float32Array;
  crateY: Float32Array;
  crateIn: Float64Array;
  crateOut: Float64Array;
  crates: number;
}

/** A mine's centre at demo time `t`, into `out` (x, y). */
export function minePosition(m: Mine, t: number, out: Float64Array | number[]): void {
  out[0] = m.cx + m.ax * Math.sin(m.wx * t + m.px);
  out[1] = m.cy + m.ay * Math.sin(m.wy * t + m.py);
}

/** Margin past the edges a piece of debris drifts before it wraps round. */
const DEBRIS_PAD = 12;

/** A piece of debris's centre at demo time `t`, into `out` (x, y, angle). */
export function debrisPosition(d: Debris, plan: DemoPlan, t: number, out: Float64Array): void {
  out[0] = wrap(d.x + d.vx * t, -DEBRIS_PAD, plan.width + 2 * DEBRIS_PAD);
  out[1] = wrap(d.y + d.vy * t, HUD_HEIGHT - DEBRIS_PAD, plan.height - HUD_HEIGHT + 2 * DEBRIS_PAD);
  out[2] = d.angle + d.spin * t;
}

/** The playfield's bounds for the tug: x0, y0, x1, y1. */
function tugBounds(w: number, h: number): [number, number, number, number] {
  const x0 = Math.min(TUG_MARGIN, w / 2);
  const y0 = Math.min(HUD_HEIGHT + TUG_MARGIN, (HUD_HEIGHT + h) / 2);
  return [x0, y0, Math.max(x0, w - TUG_MARGIN), Math.max(y0, h - TUG_MARGIN)];
}

function planMines(rng: () => number, w: number, h: number): Mine[] {
  const fieldH = Math.max(1, h - HUD_HEIGHT);
  const count = clamp(Math.round((w * fieldH) / 24000), 3, 5);
  const mines: Mine[] = [];
  const margin = 26;
  for (let i = 0; i < count; i++) {
    // Best of a few candidates: the one furthest from the mines so far.
    let bx = w / 2;
    let by = HUD_HEIGHT + fieldH / 2;
    let best = -1;
    for (let c = 0; c < 12; c++) {
      const x = margin + rng() * Math.max(0, w - 2 * margin);
      const y = HUD_HEIGHT + margin + rng() * Math.max(0, fieldH - 2 * margin);
      let d = Infinity;
      for (const m of mines) {
        d = Math.min(d, Math.hypot(m.cx - x, m.cy - y));
      }
      if (d > best) {
        best = d;
        bx = x;
        by = y;
      }
    }
    // Swing as far as the walls allow, but no further than a fraction of the field.
    const ax = Math.max(0, Math.min(bx - margin, w - margin - bx, 0.12 * w * (0.5 + rng())));
    const ay = Math.max(
      0,
      Math.min(by - HUD_HEIGHT - margin, h - margin - by, 0.14 * fieldH * (0.5 + rng())),
    );
    let wx = 0.12 + 0.2 * rng();
    let wy = 0.12 + 0.2 * rng();
    const top = ax * wx + ay * wy;
    if (top > MINE_SPEED) {
      wx *= MINE_SPEED / top;
      wy *= MINE_SPEED / top;
    }
    mines.push({
      cx: bx,
      cy: by,
      ax,
      ay,
      wx,
      wy,
      px: rng() * Math.PI * 2,
      py: rng() * Math.PI * 2,
      spin: (rng() < 0.5 ? -1 : 1) * (0.2 + 0.3 * rng()),
    });
  }
  return mines;
}

function planDebris(rng: () => number, w: number, h: number): Debris[] {
  const out: Debris[] = [];
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const speed = 3 + 4 * rng();
    const dir = (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.9;
    out.push({
      kind: i % 3,
      x: rng() * w,
      y: HUD_HEIGHT + rng() * Math.max(1, h - HUD_HEIGHT),
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      angle: rng() * Math.PI * 2,
      spin: (rng() < 0.5 ? -1 : 1) * (0.08 + 0.25 * rng()),
    });
  }
  return out;
}

/** Chance a new crate turns up on the far side of the screen from the tug. */
const FAR_SIDE = 0.2;

/**
 * Crate `k`'s spot, from its own stream: in the outer third on the tug's side
 * (`left`), or now and then the other one.
 */
function crateSpot(
  seed: number,
  k: number,
  attempt: number,
  left: boolean,
  w: number,
  h: number,
): [number, number] {
  const rng = createRng(hash32(seed * 7919 + k * 104729 + attempt * 31 + 0xc4a7e));
  const [x0, y0, x1, y1] = tugBounds(w, h);
  const onLeft = rng() < (k < LIVE_CRATES ? 0 : FAR_SIDE) ? !left : left;
  const third = (x1 - x0) / 3;
  const u = 0.1 + 0.8 * rng();
  const x = onLeft ? x0 + u * third : x1 - u * third;
  return [x, y0 + (y1 - y0) * (0.08 + 0.84 * rng())];
}

/** The shortest signed angle from `a` to `b`. */
const angleTo = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  } else if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return d;
};

/**
 * Plans the demo for a seed and game size: steps the autopilot at 60 Hz from
 * the left third. It flies to the cheapest crate (near, on its own side of
 * the screen, clear of mines), steers round any mine in range, and whenever
 * its course would bring a mine within `SAFE` in the next half second takes
 * the heading that keeps the most clearance instead. Mines drift slower than
 * the tug flies, so it can always get away.
 */
export function planDemo(seed: number, width: number, height: number): DemoPlan {
  const w = Math.max(32, width);
  const h = Math.max(HUD_HEIGHT + 32, height);
  const s = Math.floor(seed);
  const mines = planMines(createRng(hash32(s ^ 0x3133)), w, h);
  const debris = planDebris(createRng(hash32(s ^ 0xdeb7)), w, h);
  const steps = Math.ceil(PLAN_SECONDS / STEP) + 1;
  const tug = new Float32Array(steps * 4);
  const crateX = new Float32Array(MAX_CRATES);
  const crateY = new Float32Array(MAX_CRATES);
  const crateIn = new Float64Array(MAX_CRATES).fill(Infinity);
  const crateOut = new Float64Array(MAX_CRATES).fill(Infinity);
  const [bx0, by0, bx1, by1] = tugBounds(w, h);
  const minePos = mines.map(() => [0, 0]);
  const setMines = (t: number) => {
    mines.forEach((m, i) => {
      minePosition(m, t, minePos[i]);
    });
  };
  /** The least distance to a mine over the next half second, flying at (vx, vy) from (x, y). */
  const clearance = (x: number, y: number, vx: number, vy: number, t: number) => {
    let least = Infinity;
    const p = [0, 0];
    for (let k = 0; k <= 5; k++) {
      const dt = k * 0.1;
      const px = clamp(x + vx * dt, bx0, bx1);
      const py = clamp(y + vy * dt, by0, by1);
      for (const m of mines) {
        minePosition(m, t + dt, p);
        least = Math.min(least, Math.hypot(px - p[0], py - p[1]));
      }
    }
    return least;
  };
  /** How far a spot is from every mine's swing (the box each one drifts round in). */
  const mineRoom = (px: number, py: number) => {
    let least = Infinity;
    for (const m of mines) {
      const dx = Math.max(0, Math.abs(px - m.cx) - m.ax);
      const dy = Math.max(0, Math.abs(py - m.cy) - m.ay);
      least = Math.min(least, Math.hypot(dx, dy));
    }
    return least;
  };
  /** Places crate `k` at the best of a few spots on the tug's side, the one furthest from the mines' swings. */
  const placeCrate = (k: number, t: number, left: boolean) => {
    let spot = crateSpot(s, k, 0, left, w, h);
    let room = mineRoom(spot[0], spot[1]);
    for (let a = 1; a < 10 && room < AVOID; a++) {
      const next = crateSpot(s, k, a, left, w, h);
      const r = mineRoom(next[0], next[1]);
      if (r > room) {
        spot = next;
        room = r;
      }
    }
    crateX[k] = spot[0];
    crateY[k] = spot[1];
    crateIn[k] = t;
  };

  // Start in the left third, at whichever of a few spots is furthest from the mines.
  let x = bx0;
  let y = by0;
  let room = -1;
  for (let k = 0; k < 9; k++) {
    const cx = bx0 + (bx1 - bx0) * (0.06 + 0.1 * (k % 3));
    const cy = by0 + (by1 - by0) * (0.3 + 0.2 * Math.floor(k / 3));
    const c = clearance(cx, cy, 0, 0, 0);
    if (c > room) {
      room = c;
      x = cx;
      y = cy;
    }
  }
  let vx = 0;
  let vy = 0;
  let heading = 0;
  let target = -1;
  /** When the tug gives up on its target for another. */
  let deadline = 0;
  let given = -1;
  let crates = 0;
  for (; crates < LIVE_CRATES; crates++) {
    placeCrate(crates, 0.3 + 0.5 * crates, true);
  }
  const respawns: number[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i * STEP;
    while (respawns.length > 0 && respawns[0] <= t && crates < MAX_CRATES) {
      respawns.shift();
      placeCrate(crates++, t, x < w / 2);
    }
    setMines(t);
    const live = (k: number) => crateIn[k] + CRATE_FADE <= t && crateOut[k] === Infinity;
    if (target < 0 || !live(target) || t > deadline) {
      const old = target;
      target = -1;
      let best = Infinity;
      const side = x < w / 2;
      // Cross the middle only when nothing is waiting, or about to be, on this side.
      let ownSide = respawns.length > 0;
      for (let k = 0; k < crates; k++) {
        ownSide ||= crateOut[k] === Infinity && k !== given && crateX[k] < w / 2 === side;
      }
      for (let k = 0; k < crates; k++) {
        if (!live(k) || (k === old && t > deadline) || k === given) {
          continue;
        }
        const far = crateX[k] < w / 2 !== side;
        if (far && ownSide) {
          continue;
        }
        let cost = Math.hypot(crateX[k] - x, crateY[k] - y);
        for (const p of minePos) {
          if (Math.hypot(p[0] - crateX[k], p[1] - crateY[k]) < AVOID) {
            cost += w;
          }
        }
        if (cost < best) {
          best = cost;
          target = k;
        }
      }
      if (old >= 0 && target !== old && live(old)) {
        given = old;
      }
      deadline =
        target >= 0
          ? t + GIVE_UP + Math.hypot(crateX[target] - x, crateY[target] - y) / (0.7 * TUG_SPEED)
          : t;
    }
    // Where it would like to go.
    let dx = 0;
    let dy = 0;
    if (target >= 0) {
      const tx = crateX[target] - x;
      const ty = crateY[target] - y;
      const d = Math.hypot(tx, ty);
      const speed = TUG_SPEED * Math.min(1, d / 30);
      if (d > 1e-6) {
        dx = (tx / d) * speed;
        dy = (ty / d) * speed;
      }
    } else {
      // Nothing to fetch: drift gently back towards its own side's middle.
      const hx = (x < w / 2 ? bx0 + (bx1 - bx0) * 0.17 : bx1 - (bx1 - bx0) * 0.17) - x;
      const hy = (by0 + by1) / 2 - y;
      dx = clamp(hx * 0.5, -TUG_SPEED / 3, TUG_SPEED / 3);
      dy = clamp(hy * 0.5, -TUG_SPEED / 3, TUG_SPEED / 3);
    }
    // Keep out of the middle third, where the speaker sits, unless crossing it.
    const mid = (x - w / 2) / (w / 6);
    if (Math.abs(mid) < 1 && (target < 0 || crateX[target] < w / 2 === x < w / 2)) {
      dx += Math.sign(mid || -1) * TUG_SPEED * (1 - Math.abs(mid)) * 1.5;
    }
    for (const p of minePos) {
      const rx = x - p[0];
      const ry = y - p[1];
      const d = Math.hypot(rx, ry);
      if (d < AVOID && d > 1e-6) {
        const push = 2 * TUG_SPEED * (1 - d / AVOID);
        dx += (rx / d) * push;
        dy += (ry / d) * push;
      }
    }
    let ax = dx - vx;
    let ay = dy - vy;
    const a = Math.hypot(ax, ay);
    const amax = ACCEL * STEP;
    if (a > amax) {
      ax *= amax / a;
      ay *= amax / a;
    }
    vx += ax;
    vy += ay;
    const v = Math.hypot(vx, vy);
    if (v > TUG_SPEED) {
      vx *= TUG_SPEED / v;
      vy *= TUG_SPEED / v;
    }
    let thrust = Math.min(1, a / amax);
    if (clearance(x, y, vx, vy, t) < SAFE) {
      // Take the heading (or standing still) that keeps most clear, nearest the wish.
      let bestVx = 0;
      let bestVy = 0;
      let bestScore = -Infinity;
      for (let k = -1; k < 24; k++) {
        const ang = (k / 24) * Math.PI * 2;
        const cvx = k < 0 ? 0 : Math.cos(ang) * TUG_SPEED;
        const cvy = k < 0 ? 0 : Math.sin(ang) * TUG_SPEED;
        const c = Math.min(clearance(x, y, cvx, cvy, t), SAFE * 1.5);
        const score = c * 10 + (cvx * dx + cvy * dy) / (TUG_SPEED * TUG_SPEED + 1);
        if (score > bestScore) {
          bestScore = score;
          bestVx = cvx;
          bestVy = cvy;
        }
      }
      vx = bestVx;
      vy = bestVy;
      thrust = 1;
    }
    x = clamp(x + vx * STEP, bx0, bx1);
    y = clamp(y + vy * STEP, by0, by1);
    if (Math.hypot(vx, vy) > 6) {
      const d = angleTo(heading, Math.atan2(vy, vx));
      heading += clamp(d, -5 * STEP, 5 * STEP);
    }
    // Any crate it passes over is collected, not just the one it was after.
    for (let k = 0; k < crates; k++) {
      if (live(k) && Math.hypot(crateX[k] - x, crateY[k] - y) < 8) {
        crateOut[k] = t;
        respawns.push(t + RESPAWN);
        if (k === target) {
          target = -1;
        }
        if (k === given) {
          given = -1;
        }
      }
    }
    tug[i * 4] = x;
    tug[i * 4 + 1] = y;
    tug[i * 4 + 2] = heading;
    tug[i * 4 + 3] = thrust;
  }
  return {
    width: w,
    height: h,
    mines,
    debris,
    tug,
    steps,
    crateX,
    crateY,
    crateIn,
    crateOut,
    crates,
  };
}

/** The tug at demo time `t` (interpolated between steps), into `out` (x, y, heading, thrust). */
export function tugAt(plan: DemoPlan, t: number, out: Float64Array): void {
  const f = clamp(t / STEP, 0, plan.steps - 1);
  const i = Math.min(plan.steps - 2, Math.floor(f));
  const k = f - i;
  const a = i * 4;
  const b = a + 4;
  const tug = plan.tug;
  out[0] = tug[a] + (tug[b] - tug[a]) * k;
  out[1] = tug[a + 1] + (tug[b + 1] - tug[a + 1]) * k;
  out[2] = tug[a + 2] + angleTo(tug[a + 2], tug[b + 2]) * k;
  out[3] = tug[a + 3] + (tug[b + 3] - tug[a + 3]) * k;
}

/** The score shown at demo time `t`: each crate's points counting up over `COUNT_UP` s. */
export function scoreAt(plan: DemoPlan, t: number): number {
  let score = 0;
  for (let k = 0; k < plan.crates; k++) {
    const out = plan.crateOut[k];
    if (out <= t) {
      score += CRATE_POINTS * Math.min(1, (t - out) / COUNT_UP);
    }
  }
  return Math.floor(score / 10) * 10;
}

// ---------------------------------------------------------------------------
// The starfield

export const STAR_COUNT = 56;
/** Drift speed of each of the three layers, px per loop second, leftwards. */
const STAR_SPEEDS = [3, 5, 8] as const;
export const STAR_LEVELS = [0.22, 0.38, 0.6] as const;

/** Star `i`'s layer (0 far to 2 near) and position at star time `t`, into `out` (x, y, layer). */
export function starAt(
  i: number,
  seed: number,
  w: number,
  h: number,
  t: number,
  out: Float64Array,
): void {
  const k = hash32(i * 2654435761 + Math.floor(seed) * 97 + 0x57a2);
  const layer = k % 3;
  const u = (hash32(k ^ 0x1234567) / 4294967296) * w;
  out[0] = wrap(u - STAR_SPEEDS[layer] * t, 0, Math.max(1, w));
  out[1] = (hash32(k ^ 0x7654321) / 4294967296) * h;
  out[2] = layer;
}
