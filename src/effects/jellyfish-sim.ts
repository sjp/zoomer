/**
 * Jellyfish simulation, kept free of GL so it can be tested: the pulse and thrust
 * curves, rope-like tentacle chains that follow an anchor on the bell, triangle
 * strips built from the chains, and a swarm of jellyfish that swim, sink, turn and
 * wrap around the frame. Positions are in reference units (1 = 1080
 * device-independent pixels, y down).
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { clamp, wrap } from "./math";
import { createNoise } from "./noise";
import { MAX_JELLIES } from "./jellyfish.meta";

export const MAX_TENTACLES = 8;
export const MAX_ARMS = 4;
export const CHAINS_PER_JELLY = MAX_TENTACLES + MAX_ARMS;
/** Points per chain, the anchor included. */
export const CHAIN_POINTS = 14;
/** Floats per strip vertex: x, y (device px), across (-1..1), premultiplied r, g, b. */
export const STRIP_FLOATS = 6;
/** Strip vertices per chain: two per point plus a degenerate join at each end. */
export const STRIP_VERTS = 2 * CHAIN_POINTS + 2;
/** Floats per bell instance: x, y, quad half-width, half-height (device px); r, g, b, contraction. */
export const BELL_FLOATS = 8;
/** Seconds a jellyfish takes to fade in when the count is raised. */
export const FADE_IN = 1.5;
const TAU = Math.PI * 2;

// --- Bell geometry, in quad-local units (corners at ±1, y down) --------------
// The fragment shader uses the same constants, so tentacles hang from the rim it draws.

/** Bell half-width as a fraction of the quad's half-width; the margin holds the halo. */
export const BELL_A = 0.8;
/** Local y of the rim ellipse's centre. */
export const RIM_Y = 0.4;
/** Height of the dome above the rim. */
export const DOME_H = 1.15;
/** Half-height of the rim ellipse (the bell's mouth, seen slightly from below). */
export const RIM_E = 0.18;
/** The quad's lower edge: nothing (halo included) reaches below it. */
export const QUAD_BOTTOM = 0.7;

// --- Pulse ---------------------------------------------------------------------

/** Fraction of the cycle spent contracting; the bell relaxes for the rest. */
export const CONTRACT = 0.3;
/** Fraction of the cycle with thrust: the contraction and the start of the relaxation. */
export const THRUST_SPAN = 0.45;

/**
 * Bell contraction for pulse `phase` (any real; period 1): 0 relaxed, 1 fully
 * contracted. A quick sin² squeeze over `CONTRACT`, then a slow cos² release.
 */
export function pulseCurve(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p < CONTRACT) {
    const s = Math.sin((Math.PI / 2) * (p / CONTRACT));
    return s * s;
  }
  const c = Math.cos((Math.PI / 2) * ((p - CONTRACT) / (1 - CONTRACT)));
  return c * c;
}

/** Thrust for pulse `phase` (period 1), in [0, 1]: a sin² push, then coasting. */
export function thrustCurve(phase: number): number {
  const p = phase - Math.floor(phase);
  if (p >= THRUST_SPAN) return 0;
  const s = Math.sin(Math.PI * (p / THRUST_SPAN));
  return s * s;
}

// --- Chains --------------------------------------------------------------------

/**
 * Lays chain `c` (points `c * n .. c * n + n - 1` of `pos`, as x, y pairs) out
 * straight down from (x, y), `seg` apart, at rest.
 */
export function resetChain(
  pos: Float32Array,
  vel: Float32Array,
  c: number,
  n: number,
  x: number,
  y: number,
  seg: number,
): void {
  for (let k = 0; k < n; k++) {
    const o = (c * n + k) * 2;
    pos[o] = x;
    pos[o + 1] = y + k * seg;
    vel[o] = 0;
    vel[o + 1] = 0;
  }
}

/** Moves every point of chain `c` by (dx, dy), keeping its shape and velocity. */
export function shiftChain(pos: Float32Array, c: number, n: number, dx: number, dy: number): void {
  for (let k = 0; k < n; k++) {
    const o = (c * n + k) * 2;
    pos[o] += dx;
    pos[o + 1] += dy;
  }
}

/**
 * One step of chain `c` as a damped rope: the anchor jumps to (ax, ay); every
 * other point moves by its velocity plus the force (fx, fy), then is pulled back
 * to exactly `seg` from its parent (follow-the-leader). Velocity comes from the
 * corrected move, scaled by `damp` (0..1, per step), so the chain settles. With
 * `dt` = 0 only the lengths are enforced. A point on top of its parent hangs
 * straight down rather than producing NaN.
 */
export function stepChain(
  pos: Float32Array,
  vel: Float32Array,
  c: number,
  n: number,
  ax: number,
  ay: number,
  seg: number,
  dt: number,
  fx: number,
  fy: number,
  damp: number,
): void {
  const base = c * n * 2;
  pos[base] = ax;
  pos[base + 1] = ay;
  let px = ax;
  let py = ay;
  const moving = dt > 0;
  const inv = moving ? damp / dt : 0;
  for (let k = 1; k < n; k++) {
    const o = base + k * 2;
    const ox = pos[o];
    const oy = pos[o + 1];
    let x = ox;
    let y = oy;
    if (moving) {
      x += (vel[o] + fx * dt) * dt;
      y += (vel[o + 1] + fy * dt) * dt;
    }
    const qx = x;
    const qy = y;
    let dx = x - px;
    let dy = y - py;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1e-6) {
      dx *= seg / len;
      dy *= seg / len;
    } else {
      dx = 0;
      dy = seg;
    }
    x = px + dx;
    y = py + dy;
    pos[o] = x;
    pos[o + 1] = y;
    if (moving) {
      vel[o] = (x - ox) * inv;
      vel[o + 1] = (y - oy) * inv;
      // Dynamic follow-the-leader (Müller 2012): the parent takes back most of
      // the correction, so the rope can't pump energy down to its tip.
      if (k > 1) {
        vel[o - 2] -= FTL_DAMP * (x - qx) * inv;
        vel[o - 1] -= FTL_DAMP * (y - qy) * inv;
      }
    }
    px = x;
    py = y;
  }
}

/** Share of each point's length correction taken back from its parent's velocity. */
const FTL_DAMP = 0.9;

/** How one chain is drawn by `writeStrip`. Widths are half-widths in reference px. */
export interface StripStyle {
  /** Half-width at the anchor. */
  width: number;
  /** Fraction of the width lost by the tip. */
  taper: number;
  /** Smallest half-width, so thin tentacles survive video codecs. */
  minWidth: number;
  /** Width ripple amplitude (0..1) for frilly oral arms, and its phase. */
  frill: number;
  frillPhase: number;
  /** Premultiplied colour at the anchor; it fades to zero at the tip. */
  r: number;
  g: number;
  b: number;
  /** Exponent of the fade toward the tip. */
  fade: number;
}

/**
 * Writes chain `c` (`n` points) into `out` from vertex `v` as a triangle strip
 * with degenerate joins: the first and last vertices are repeated, so chains
 * written back to back draw as one strip. `scale` converts reference px to device
 * px. Returns the next vertex index (`v + 2n + 2`).
 */
export function writeStrip(
  out: Float32Array,
  v: number,
  pos: Float32Array,
  c: number,
  n: number,
  scale: number,
  s: StripStyle,
): number {
  const base = c * n * 2;
  // Fallback normal for a chain with no direction yet: horizontal.
  let nx = 1;
  let ny = 0;
  let o = v * STRIP_FLOATS;
  for (let k = 0; k < n; k++) {
    const a = base + Math.max(0, k - 1) * 2;
    const b = base + Math.min(n - 1, k + 1) * 2;
    const tx = pos[b] - pos[a];
    const ty = pos[b + 1] - pos[a + 1];
    const len = Math.sqrt(tx * tx + ty * ty);
    if (len > 1e-6) {
      nx = -ty / len;
      ny = tx / len;
    }
    const t = k / (n - 1);
    let w = s.width * (1 - s.taper * t);
    if (s.frill > 0) w *= 1 - s.frill + s.frill * Math.abs(Math.sin(k * 1.9 + s.frillPhase));
    w = Math.max(w, s.minWidth) * scale;
    const f = (1 - t) ** s.fade;
    const x = pos[base + k * 2] * scale;
    const y = pos[base + k * 2 + 1] * scale;
    const r = s.r * f;
    const g = s.g * f;
    const bl = s.b * f;
    // Left, then right; the first left and the last right are written twice.
    const reps = k === 0 ? 2 : 1;
    for (let i = 0; i < reps; i++) {
      out[o] = x + nx * w;
      out[o + 1] = y + ny * w;
      out[o + 2] = 1;
      out[o + 3] = r;
      out[o + 4] = g;
      out[o + 5] = bl;
      o += STRIP_FLOATS;
    }
    const repsR = k === n - 1 ? 2 : 1;
    for (let i = 0; i < repsR; i++) {
      out[o] = x - nx * w;
      out[o + 1] = y - ny * w;
      out[o + 2] = -1;
      out[o + 3] = r;
      out[o + 4] = g;
      out[o + 5] = bl;
      o += STRIP_FLOATS;
    }
  }
  return v + 2 * n + 2;
}

// --- Palettes ------------------------------------------------------------------

export const PALETTES: Record<string, readonly Rgb[]> = {
  moon: ["#a8dcff", "#cdeaff", "#8cc8ff"].map(hexToUnitRgb),
  violet: ["#b58cff", "#d8a8ff", "#9a86ff"].map(hexToUnitRgb),
  sunset: ["#ff9ccf", "#ffb46b", "#ff8fa6"].map(hexToUnitRgb),
  mixed: ["#a8dcff", "#c19bff", "#ff9ccf", "#ffbf73"].map(hexToUnitRgb),
};

/** The palette named `name`, or "mixed" for an unknown name. */
export function paletteFor(name: string): readonly Rgb[] {
  return Object.hasOwn(PALETTES, name) ? PALETTES[name] : PALETTES.mixed;
}

/** Far jellyfish fade toward this blue as well as dimming. */
const FAR_TINT: Rgb = [0.35, 0.6, 1];

// --- Swarm ---------------------------------------------------------------------

/** Per-frame inputs to `Swarm.step`. */
export interface SwarmFrame {
  refWidth: number;
  scale: number;
  count: number;
  /** Bell radius in reference px for the nearest jellyfish. */
  size: number;
  /** Pulse rate multiplier. */
  pulse: number;
  /** Tentacle length, 0..1. */
  tentacles: number;
  /** Glow, 0..1. */
  glow: number;
  palette: readonly Rgb[];
}

/** Peak thrust, as accelerations in bell radii per s², and the drag rate per s. */
const THRUST = 2.2;
const DRAG = 1.1;
/** Sinking between pulses, in bell radii per s². */
const SINK = 0.09;
/** Largest tilt of the swimming direction away from straight up, in radians. */
const MAX_TILT = 0.75;
/** Tentacle length in bell radii at `tentacles` = 1, and the oral arms' length. */
const TENTACLE_LEN = 3.4;
const ARM_LEN = 1.5;
/** Tentacle force (bell radii per s²): a light pull down, and a slow sideways sway. */
const HANG = 0.9;
const SWAY = 0.35;
/** Chain velocity damping per second. */
const CHAIN_DAMP = 1.6;

export interface Swarm {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Depth, 0 far .. 1 near. Fixed for each jellyfish; wrapping keeps it. */
  readonly depth: Float32Array;
  readonly life: Float32Array;
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  /** Jellyfish being simulated: the count plus any still fading out. */
  readonly live: number;
  /** Bell instances and strip vertices written by the last `step`. */
  readonly bells: number;
  readonly stripVerts: number;
  /** Total wraps so far (for tests). */
  readonly wraps: number;
  /** Rescales x positions (and tentacles) by `k` after a width change. */
  rescaleX(k: number): void;
  /**
   * Advances the swarm by `dt` seconds, then writes the visible bells into
   * `bellData` (`bellStride` floats each, the spin pair at `spinOffset`) and the
   * tentacle strips into `strips`, in device px.
   */
  step(
    dt: number,
    f: SwarmFrame,
    bellData: Float32Array,
    bellStride: number,
    spinOffset: number,
    strips: Float32Array,
  ): void;
}

export function createSwarm(rng: () => number, refWidth: number): Swarm {
  const n = MAX_JELLIES;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const tilt = new Float32Array(n);
  const depth = new Float32Array(n);
  const phase = new Float32Array(n);
  const period = new Float32Array(n);
  const colour = new Float32Array(n);
  const seed = new Float32Array(n);
  const tentacleCount = new Uint8Array(n);
  const armCount = new Uint8Array(n);
  const tentacleOffset = new Float32Array(n);
  /** Per chain: length factor and sway phase. */
  const chainLen = new Float32Array(n * CHAINS_PER_JELLY);
  const chainSeed = new Float32Array(n * CHAINS_PER_JELLY);
  const life = new Float32Array(n);
  const pos = new Float32Array(n * CHAINS_PER_JELLY * CHAIN_POINTS * 2);
  const vel = new Float32Array(pos.length);
  const noise = createNoise(47);
  const style: StripStyle = {
    width: 0,
    taper: 0,
    minWidth: 0,
    frill: 0,
    frillPhase: 0,
    r: 0,
    g: 0,
    b: 0,
    fade: 1,
  };

  /** An x position biased toward the sides, away from the speaker in the middle. */
  const sideX = (w: number) => {
    const u = rng();
    const side = u < 0.5 ? u * 2 : (u - 0.5) * 2;
    // 80% within the outer 35% on either side.
    const edge = rng() < 0.8 ? side * 0.35 : 0.35 + side * 0.15;
    return u < 0.5 ? edge * w : (1 - edge) * w;
  };

  for (let i = 0; i < n; i++) {
    x[i] = sideX(refWidth);
    y[i] = rng() * 1080;
    tilt[i] = (rng() * 2 - 1) * MAX_TILT * 0.5;
    // Stratified depths, so even a few jellyfish spread from far to near.
    depth[i] = clamp(((i * 7) % n) / (n - 1) + (rng() - 0.5) * 0.08, 0, 1);
    phase[i] = rng();
    period[i] = 2 + rng() * 2;
    colour[i] = rng();
    seed[i] = rng() * 100;
    tentacleCount[i] = 4 + Math.floor(rng() * 5);
    armCount[i] = 2 + Math.floor(rng() * 3);
    tentacleOffset[i] = rng() * TAU;
    for (let c = 0; c < CHAINS_PER_JELLY; c++) {
      chainLen[i * CHAINS_PER_JELLY + c] = 0.75 + rng() * 0.5;
      chainSeed[i * CHAINS_PER_JELLY + c] = rng() * TAU;
    }
  }

  let live = 0;
  let bells = 0;
  let stripVerts = 0;
  let wraps = 0;
  let time = 0;
  /** 1 until a jellyfish's chains have been laid out from its rim. */
  const fresh = new Uint8Array(n).fill(1);

  // Scratch for the bell's transform, set per jellyfish.
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cosA = 1;
  let sinA = 0;
  let anchorX = 0;
  let anchorY = 0;
  /** Bell-local (quad units) to reference px, into anchorX / anchorY. */
  const toWorld = (lx: number, ly: number) => {
    const px = lx * sx;
    const py = ly * sy;
    anchorX = cx + px * cosA - py * sinA;
    anchorY = cy + px * sinA + py * cosA;
  };
  /** Sets anchorX / anchorY to chain `c`'s anchor on jellyfish `i`'s rim. */
  const anchor = (i: number, c: number) => {
    const t = tentacleCount[i];
    if (c < t) {
      const a = tentacleOffset[i] + (c * TAU) / t;
      toWorld(BELL_A * 0.9 * Math.cos(a), RIM_Y + RIM_E * 0.85 * Math.sin(a));
    } else {
      const arms = armCount[i];
      const j = c - MAX_TENTACLES;
      toWorld(BELL_A * 0.28 * (((j + 0.5) / arms) * 2 - 1), RIM_Y + 0.04);
    }
  };
  const chainActive = (i: number, c: number) =>
    c < MAX_TENTACLES ? c < tentacleCount[i] : c - MAX_TENTACLES < armCount[i];

  return {
    x,
    y,
    depth,
    life,
    pos,
    vel,
    get live() {
      return live;
    },
    get bells() {
      return bells;
    },
    get stripVerts() {
      return stripVerts;
    },
    get wraps() {
      return wraps;
    },
    rescaleX(k) {
      for (let i = 0; i < n; i++) x[i] *= k;
      for (let p = 0; p < pos.length; p += 2) pos[p] *= k;
    },
    step(dt, f, bellData, bellStride, spinOffset, strips) {
      time += dt;
      const target = clamp(Math.floor(f.count), 0, n);
      live = growLive(life, live, target);
      const inStep = dt / FADE_IN;
      const outStep = dt / FADE_OUT;
      const drag = Math.exp(-DRAG * dt);
      const damp = Math.exp(-CHAIN_DAMP * dt);
      const turn = 1 - Math.exp(-0.4 * dt);
      const tent = clamp(f.tentacles, 0, 1);
      const glow = clamp(f.glow, 0, 1);
      const palette = f.palette;
      const scale = f.scale;
      bells = 0;
      let v = 0;

      for (let i = 0; i < live; i++) {
        const z = depth[i];
        const radius = f.size * (0.4 + 0.6 * z);
        const tentLen = radius * TENTACLE_LEN * tent;
        const armLen = radius * ARM_LEN * (0.35 + 0.65 * tent);

        // Swim: thrust along the heading during each pulse, drag and sinking always.
        let ph = phase[i] + (dt * f.pulse) / period[i];
        ph -= Math.floor(ph);
        phase[i] = ph;
        const aim = noise.noise2(time * 0.05, seed[i]) * MAX_TILT;
        tilt[i] += (aim - tilt[i]) * turn;
        const heading = tilt[i] - Math.PI / 2;
        const dirX = Math.cos(heading);
        const dirY = Math.sin(heading);
        // Faster pulsing swims faster: the thrust curve's average is fixed per cycle.
        const th = thrustCurve(ph) * THRUST * radius * f.pulse;
        vx[i] = vx[i] * drag + dirX * th * dt;
        vy[i] = vy[i] * drag + (dirY * th + SINK * radius) * dt;
        const mx = x[i] + vx[i] * dt;
        const my = y[i] + vy[i] * dt;
        // Wrap only once bell and tentacles are fully off-screen.
        const margin = (radius / BELL_A) * 1.2 + Math.max(tentLen, armLen);
        let nx = wrap(mx, -margin, f.refWidth + 2 * margin);
        const ny = wrap(my, -margin, 1080 + 2 * margin);
        // Re-enter from the bottom (or top) toward the sides, not behind the speaker.
        if (ny !== my) nx = sideX(f.refWidth);
        x[i] = nx;
        y[i] = ny;
        if (nx !== mx || ny !== my) {
          wraps++;
          const dx = nx - mx;
          const dy = ny - my;
          for (let c = 0; c < CHAINS_PER_JELLY; c++) {
            shiftChain(pos, i * CHAINS_PER_JELLY + c, CHAIN_POINTS, dx, dy);
          }
        }
        const l = stepLife(life, i, target, inStep, outStep);

        // Bell transform: narrower and longer while contracted.
        const con = pulseCurve(ph);
        cx = nx;
        cy = ny;
        sx = (radius * (1 - 0.18 * con)) / BELL_A;
        sy = (radius * (1 + 0.15 * con)) / BELL_A;
        const angle = tilt[i];
        cosA = Math.cos(angle);
        sinA = Math.sin(angle);

        // Tentacles and oral arms.
        const sway = Math.sin(time * 0.6 + seed[i]);
        for (let c = 0; c < CHAINS_PER_JELLY; c++) {
          if (!chainActive(i, c)) continue;
          const ci = i * CHAINS_PER_JELLY + c;
          const arm = c >= MAX_TENTACLES;
          const len = (arm ? armLen : tentLen) * chainLen[ci];
          const seg = len / (CHAIN_POINTS - 1);
          anchor(i, c);
          if (fresh[i]) resetChain(pos, vel, ci, CHAIN_POINTS, anchorX, anchorY, seg);
          const fx = SWAY * radius * Math.sin(time * 0.9 + chainSeed[ci]) * (0.5 + 0.5 * sway);
          stepChain(pos, vel, ci, CHAIN_POINTS, anchorX, anchorY, seg, dt, fx, HANG * radius, damp);
        }

        fresh[i] = 0;
        if (l <= 0) continue;

        // Colour: palette, then far ones dimmer and bluer.
        const base = palette[Math.floor(colour[i] * palette.length) % palette.length];
        const far = (1 - z) * 0.55;
        const bright = (0.35 + 0.65 * z) * l;
        const r = (base[0] + (FAR_TINT[0] - base[0]) * far) * bright;
        const g = (base[1] + (FAR_TINT[1] - base[1]) * far) * bright;
        const b = (base[2] + (FAR_TINT[2] - base[2]) * far) * bright;

        const o = bells * bellStride;
        bellData[o] = nx * scale;
        bellData[o + 1] = ny * scale;
        bellData[o + 2] = sx * scale;
        bellData[o + 3] = sy * scale;
        bellData[o + 4] = r;
        bellData[o + 5] = g;
        bellData[o + 6] = b;
        bellData[o + 7] = con;
        bellData[o + spinOffset] = angle;
        bellData[o + spinOffset + 1] = 1;
        bells++;

        const tentAlpha = (0.45 + 0.4 * glow) * smoothTent(tent);
        const armAlpha = 0.4 + 0.35 * glow;
        for (let c = 0; c < CHAINS_PER_JELLY; c++) {
          if (!chainActive(i, c)) continue;
          const arm = c >= MAX_TENTACLES;
          const a = arm ? armAlpha : tentAlpha;
          if (a <= 0) continue;
          style.width = arm ? radius * 0.09 : Math.max(1.6, radius * 0.03);
          style.taper = arm ? 0.6 : 0.45;
          style.minWidth = arm ? 1.6 : 1.3;
          style.frill = arm ? 0.35 : 0;
          style.frillPhase = time * 1.3 + chainSeed[i * CHAINS_PER_JELLY + c];
          style.fade = arm ? 1 : 1.4;
          style.r = r * a;
          style.g = g * a;
          style.b = b * a;
          v = writeStrip(strips, v, pos, i * CHAINS_PER_JELLY + c, CHAIN_POINTS, scale, style);
        }
      }
      live = trimLive(life, live, target);
      stripVerts = v;
    },
  };
}

/** Tentacles fade out as their length goes to zero, rather than shrinking to dots. */
function smoothTent(t: number): number {
  return clamp(t / 0.15, 0, 1);
}
