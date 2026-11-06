/**
 * Pure JS side of Orbiting Bodies: seeded planetary systems on Kepler
 * orbits, their positions at any time, and the per-frame instance data for the
 * bodies and star glows. Nothing here touches GL.
 *
 * Every body follows a fixed Kepler ellipse about its parent (the system's
 * centre of mass, or a planet for a moon), so the system is stable forever and
 * a position at any time costs one Kepler solve per level. The trails' vertex
 * shader evaluates the same orbits (`KEPLER_ITERATIONS`, `orbitPoint`).
 *
 * Coordinates: the orbit plane in reference pixels of a 1080-tall frame, y up,
 * origin at the centre of mass. The view tilts that plane about its x axis by
 * `tilt`, so a point (x, y) appears at (x, y cos tilt) and lies y sin tilt
 * farther from the viewer.
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { createRng, hash32 } from "./noise";
import { MAX_PLANETS, MIN_PLANETS } from "./orbits.meta";

export const TAU = Math.PI * 2;

/** Newton steps from Danby's starting guess; ample for e <= 0.7 in float32 too. */
export const KEPLER_ITERATIONS = 5;

/** Planet period (s at speed 1) at `A_REF` reference px; periods follow a^1.5. */
export const PERIOD_REF = 30;
export const A_REF = 100;
/** The same for moons about their planet (a much lighter parent). */
export const MOON_PERIOD_REF = 9;
export const MOON_A_REF = 24;

/** Nothing of a planet comes closer than this to a single star's centre, reference px. */
export const SINGLE_CLEAR = 60;
/** Circumbinary planets keep this many binary apoapses away, so the pair can't disturb them. */
export const BINARY_CLEAR = 3;
/** The innermost planet's semi-major axis lies this far beyond the clearance, reference px. */
export const INNER_OFFSET = 40;
/** Outermost semi-major axis for 2 and for 7 planets, reference px. */
export const SPREAD_MIN = 300;
export const SPREAD_MAX = 560;
/** Empty gap between the reaches of neighbouring planets, reference px. */
export const ORBIT_GAP = 8;
/** Most eccentric planet orbit, and binary orbit. */
export const PLANET_E_MAX = 0.16;
export const BINARY_E_MAX = 0.3;
/** Binary semi-major axis (relative orbit), reference px. */
export const BINARY_A = 44;
/** Planet radius range, reference px. */
export const PLANET_RADIUS = [4, 11.5] as const;
/** Ring inner radius as a multiple of the planet's. */
export const RING_INNER = 1.3;
/** Most moons in a system. */
export const MAX_MOONS = 8;
/** Most planets and moons: the size of the GPU arrays and body batch. */
export const MAX_BODIES = MAX_PLANETS + MAX_MOONS;
/** Glow octagon radius as a multiple of the star's core radius. */
export const GLOW_RATIO = 14;

/** Floats per body instance: centre x, y, radius, extent (device px); rgb, band phase; light xyz, ring outer. */
export const BODY_FLOATS = 12;
/** Floats per star-glow instance: centre x, y, core radius, glow radius (device px); rgb, gain. */
export const GLOW_FLOATS = 8;

export type SystemKind = "single" | "binary";
export type BodyKind = "star" | "planet" | "moon";

export interface Body {
  kind: BodyKind;
  /** Semi-major axis about the parent, reference px (0: sits at the parent). */
  a: number;
  e: number;
  /** Argument of periapsis, radians. */
  omega: number;
  /** Mean anomaly at time 0, radians. */
  m0: number;
  /** Mean motion, radians per second at speed 1. */
  n: number;
  /** Parent body index, or -1 for the centre of mass. */
  parent: number;
  /** Disc (or star core) radius, reference px. */
  radius: number;
  /** Mass in arbitrary units (stars only matter: they fix the centre of mass). */
  mass: number;
  /** Linear-ish 0..1 colour. */
  color: Rgb;
  /** Ring outer radius as a multiple of the disc's, 0 for none. */
  ring: number;
  /** Cloud-band phase for banded giants, -1 for plain discs. */
  band: number;
  /** Farthest anything of this body (disc, ring, moons) reaches from its centre, reference px. */
  reach: number;
}

/** A system: stars first, then planets (innermost first), then moons. */
export interface OrbitSystem {
  kind: SystemKind;
  bodies: Body[];
  stars: number;
  planets: number;
  moons: number;
}

/** `a` wrapped to [0, 2π). */
export function wrapAngle(a: number): number {
  const w = a - TAU * Math.floor(a / TAU);
  return w < TAU ? w : 0;
}

/** Orbital period (s at speed 1) of a planet or star at `a` reference px about the centre of mass. */
export const planetPeriod = (a: number) => PERIOD_REF * (a / A_REF) ** 1.5;
/** Orbital period (s at speed 1) of a moon at `a` reference px about its planet. */
export const moonPeriod = (a: number) => MOON_PERIOD_REF * (a / MOON_A_REF) ** 1.5;

/**
 * The eccentric anomaly E with M = E - e sin E: Newton's method from Danby's
 * guess E = M + 0.85 e sign(sin M), `KEPLER_ITERATIONS` steps (the shader's twin).
 */
export function solveKepler(m: number, e: number, iterations = KEPLER_ITERATIONS): number {
  const mw = m - TAU * Math.floor((m + Math.PI) / TAU);
  let ea = mw + 0.85 * e * Math.sign(mw);
  for (let i = 0; i < iterations; i++) {
    ea -= (ea - e * Math.sin(ea) - mw) / (1 - e * Math.cos(ea));
  }
  return ea;
}

/**
 * Position on the ellipse (a, e, omega) at eccentric anomaly `ea`, relative to
 * the focus (the parent), written into `out` at `o`. Twin of `orbitPoint` in GLSL.
 */
export function orbitPoint(
  a: number,
  e: number,
  omega: number,
  ea: number,
  out: Float64Array | number[],
  o = 0,
) {
  const x = a * (Math.cos(ea) - e);
  const y = a * Math.sqrt(1 - e * e) * Math.sin(ea);
  const c = Math.cos(omega);
  const s = Math.sin(omega);
  out[o] = c * x - s * y;
  out[o + 1] = s * x + c * y;
}

/** Mean anomaly of `b` at time `t` (s at speed 1, float64), wrapped to [0, 2π) for upload. */
export const meanAnomaly = (b: Body, t: number) => wrapAngle(b.m0 + b.n * t);

/**
 * Orbit-plane positions of every body at time `t` into `out` (x, y per body).
 * Parents come before their children, so one pass resolves the nesting.
 */
export function systemPositions(sys: OrbitSystem, t: number, out: Float64Array): Float64Array {
  const bodies = sys.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.a > 0) {
      orbitPoint(b.a, b.e, b.omega, solveKepler(b.m0 + b.n * t, b.e), out, 2 * i);
    } else {
      out[2 * i] = 0;
      out[2 * i + 1] = 0;
    }
    if (b.parent >= 0) {
      out[2 * i] += out[2 * b.parent];
      out[2 * i + 1] += out[2 * b.parent + 1];
    }
  }
  return out;
}

const PLANET_COLORS = [
  "#c9a27a",
  "#d8714c",
  "#7fb4e0",
  "#e3c07c",
  "#6cc2ae",
  "#b39ad8",
  "#dfe3ea",
  "#a3c06e",
  "#e08aa0",
] as const;
const MOON_COLORS = ["#b8b4ae", "#c8c2b6", "#a9b0ba"] as const;
const SINGLE_STAR = "#ffe0a6";
const BINARY_STARS = [
  ["#fff0cc", "#ffaa66"],
  ["#fff0cc", "#b8ccff"],
  ["#ffd9a0", "#ff9a5c"],
] as const;

/** "random" resolved per seed; anything else as given. */
export function resolveKind(system: string, seed: number): SystemKind {
  if (system === "binary" || system === "single") return system;
  return (hash32(Math.floor(seed) + 0x51ed) & 1) === 1 ? "binary" : "single";
}

/** Planets clamped to the meta's range and rounded. */
const planetCount = (n: number) => Math.max(MIN_PLANETS, Math.min(MAX_PLANETS, Math.round(n)));

/**
 * A seeded system of `planets` (2..7) planets about one star or a binary pair.
 * Planets sit on prograde, non-crossing ellipses (with their moons and rings
 * included in the spacing), spread geometrically outward; the larger ones may
 * have moons, and one giant may have a ring instead. Deterministic per
 * (kind, planets, seed).
 */
export function createSystem(kind: SystemKind, planets: number, seed: number): OrbitSystem {
  const count = planetCount(planets);
  const rng = createRng(hash32(Math.floor(seed) * 31 + count * 7 + (kind === "binary" ? 1 : 0)));
  const bodies: Body[] = [];
  const range = (lo: number, hi: number) => lo + (hi - lo) * rng();

  // Stars.
  let clear = SINGLE_CLEAR;
  if (kind === "single") {
    bodies.push(star(0, 0, 0, 0, 0, 15, 1, SINGLE_STAR));
  } else {
    const pair = BINARY_STARS[Math.floor(rng() * BINARY_STARS.length)];
    const q = range(0.55, 0.95);
    const e = rng() * BINARY_E_MAX;
    const omega = rng() * TAU;
    const m0 = rng() * TAU;
    const n = TAU / planetPeriod(BINARY_A);
    // Each star follows the relative orbit scaled by the other's mass share, on opposite sides.
    bodies.push(star((BINARY_A * q) / (1 + q), e, omega + Math.PI, m0, n, 9, 1, pair[0]));
    bodies.push(star(BINARY_A / (1 + q), e, omega, m0, n, 9 * Math.sqrt(q), q, pair[1]));
    clear = BINARY_CLEAR * BINARY_A * (1 + e);
  }
  const stars = bodies.length;

  // Semi-major axes: geometric from just outside the clearance to the spread.
  const spread =
    SPREAD_MIN + ((SPREAD_MAX - SPREAD_MIN) * (count - 2)) / (MAX_PLANETS - MIN_PLANETS);
  const inner = clear + INNER_OFFSET;
  const ratio = Math.max(spread / inner, 1.2) ** (1 / (count - 1));
  const axes: number[] = [];
  for (let i = 0; i < count; i++) axes.push(inner * ratio ** i * (i > 0 ? range(0.96, 1.04) : 1));

  // Each planet then gets the room halfway to its neighbours (less the gap) and
  // spends it on eccentricity, then its disc, then a ring or moons, so nothing
  // ever reaches a neighbour's room.
  const ringed =
    count >= 3 && rng() < 0.75 ? count - 1 - Math.floor(rng() * Math.ceil(count / 2)) : -1;
  const colors = PLANET_COLORS.slice();
  const moonSpecs: { planet: number; a: number; e: number; radius: number }[] = [];
  for (let i = 0; i < count; i++) {
    const a = axes[i];
    const below = i === 0 ? a - clear - ORBIT_GAP : (a - axes[i - 1] - ORBIT_GAP) / 2;
    const above = i === count - 1 ? below : (axes[i + 1] - a - ORBIT_GAP) / 2;
    const room = Math.min(below, above);
    const e = Math.min(rng() * PLANET_E_MAX, (0.3 * room) / a);
    const left = room - a * e;
    let radius = Math.min(range(PLANET_RADIUS[0], PLANET_RADIUS[1]), left);
    let ring = 0;
    let reach = radius;
    if (i === ringed && left >= 6 * 2.4) {
      // A ringed giant: as large as its room allows, ring included.
      radius = Math.min(Math.max(radius, 9), left / 2.4);
      ring = range(2.05, 2.4);
      reach = radius * ring;
    } else if (radius >= 6.5 && rng() < 0.7) {
      let ma = radius * 2.2 + range(3, 6);
      for (let k = 0; k < 2 && moonSpecs.length < MAX_MOONS; k++) {
        const me = rng() * 0.08;
        const mr = range(1.8, 3);
        if (ma * (1 + me) + mr > left) break;
        moonSpecs.push({ planet: i, a: ma, e: me, radius: mr });
        reach = ma * (1 + me) + mr;
        ma *= range(1.45, 1.6);
      }
    }
    const pick = Math.floor(rng() * colors.length);
    const hex = colors.splice(pick, 1)[0];
    bodies.push({
      kind: "planet",
      a,
      e,
      omega: rng() * TAU,
      m0: rng() * TAU,
      n: TAU / planetPeriod(a),
      parent: -1,
      radius,
      mass: 0,
      color: hexToUnitRgb(hex),
      ring,
      band: radius >= 8.5 ? rng() * TAU : -1,
      reach,
    });
  }

  for (const m of moonSpecs) {
    bodies.push({
      kind: "moon",
      a: m.a,
      e: m.e,
      omega: rng() * TAU,
      m0: rng() * TAU,
      n: TAU / moonPeriod(m.a),
      parent: stars + m.planet,
      radius: m.radius,
      mass: 0,
      color: hexToUnitRgb(MOON_COLORS[Math.floor(rng() * MOON_COLORS.length)]),
      ring: 0,
      band: -1,
      reach: m.radius,
    });
  }
  return { kind, bodies, stars, planets: count, moons: moonSpecs.length };
}

function star(
  a: number,
  e: number,
  omega: number,
  m0: number,
  n: number,
  radius: number,
  mass: number,
  hex: string,
): Body {
  return {
    kind: "star",
    a,
    e,
    omega,
    m0,
    n,
    parent: -1,
    radius,
    mass,
    color: hexToUnitRgb(hex),
    ring: 0,
    band: -1,
    reach: radius,
  };
}

/** Where the system's centre sits, as a fraction of the frame width. */
export function centreFraction(centre: string): number {
  if (centre === "left") return 0.27;
  if (centre === "centre") return 0.5;
  return 0.73;
}

/** The view, in device pixels (y down). Keep one and update it. */
export interface OrbitView {
  /** Centre of mass on screen. */
  cx: number;
  cy: number;
  /** Device px per reference px. */
  scale: number;
  /** Tilt of the orbit plane, radians. */
  tilt: number;
}

/**
 * Fills the body instances (planets and moons, `BODY_FLOATS` each) into `out`,
 * farthest first so nearer bodies draw over them, and returns the count.
 * `pos` holds `systemPositions`; `depth` and `order` are scratch arrays with a
 * slot per body. Each body is lit from the stars' luminosity-weighted direction
 * in view space (x right, y up, z toward the viewer).
 */
export function fillBodies(
  sys: OrbitSystem,
  pos: Float64Array,
  view: OrbitView,
  out: Float32Array,
  depth: Float64Array,
  order: Int32Array,
): number {
  const bodies = sys.bodies;
  const cosT = Math.cos(view.tilt);
  const sinT = Math.sin(view.tilt);
  let count = 0;
  for (let i = sys.stars; i < bodies.length; i++) {
    // Insertion sort by depth (negative = farther), farthest first.
    const d = -pos[2 * i + 1] * sinT;
    let j = count;
    while (j > 0 && depth[j - 1] > d) {
      depth[j] = depth[j - 1];
      order[j] = order[j - 1];
      j--;
    }
    depth[j] = d;
    order[j] = i;
    count++;
  }
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const b = bodies[i];
    const x = pos[2 * i];
    const y = pos[2 * i + 1];
    let lx = 0;
    let ly = 0;
    let lz = 0;
    for (let s = 0; s < sys.stars; s++) {
      const dx = pos[2 * s] - x;
      const dy = pos[2 * s + 1] - y;
      const len = Math.hypot(dx, dy) || 1;
      const w = bodies[s].mass / len;
      lx += dx * w;
      ly += dy * cosT * w;
      lz -= dy * sinT * w;
    }
    const ll = Math.hypot(lx, ly, lz) || 1;
    const r = b.radius * view.scale;
    const o = k * BODY_FLOATS;
    out[o] = view.cx + x * view.scale;
    out[o + 1] = view.cy - y * cosT * view.scale;
    out[o + 2] = r;
    // Room for the ring (squashed only vertically, so its x extent bounds it) or the edge's AA.
    out[o + 3] = b.ring > 0 ? r * b.ring + 1 : r + 1;
    out[o + 4] = b.color[0];
    out[o + 5] = b.color[1];
    out[o + 6] = b.color[2];
    out[o + 7] = b.band;
    out[o + 8] = lx / ll;
    out[o + 9] = ly / ll;
    out[o + 10] = lz / ll;
    out[o + 11] = b.ring;
  }
  return count;
}

/** Fills the star glows (`GLOW_FLOATS` each) into `out` and returns the count. */
export function fillGlows(
  sys: OrbitSystem,
  pos: Float64Array,
  view: OrbitView,
  out: Float32Array,
): number {
  const cosT = Math.cos(view.tilt);
  for (let s = 0; s < sys.stars; s++) {
    const b = sys.bodies[s];
    const o = s * GLOW_FLOATS;
    const r = b.radius * view.scale;
    out[o] = view.cx + pos[2 * s] * view.scale;
    out[o + 1] = view.cy - pos[2 * s + 1] * cosT * view.scale;
    out[o + 2] = r;
    out[o + 3] = r * GLOW_RATIO;
    out[o + 4] = b.color[0];
    out[o + 5] = b.color[1];
    out[o + 6] = b.color[2];
    out[o + 7] = sys.stars > 1 ? 0.8 : 1;
  }
  return sys.stars;
}

/**
 * The trail and orbit-line uniforms for the non-star bodies (GPU index = body
 * index - stars): `elem` (a, e, omega, parent GPU index or -1) and `color`
 * (rgb, half-width in reference px) per body. Fill on a rebuild.
 */
export function fillOrbitElements(
  sys: OrbitSystem,
  elem: Float32Array,
  color: Float32Array,
): number {
  const n = sys.bodies.length - sys.stars;
  for (let g = 0; g < n; g++) {
    const b = sys.bodies[sys.stars + g];
    elem[4 * g] = b.a;
    elem[4 * g + 1] = b.e;
    elem[4 * g + 2] = b.omega;
    elem[4 * g + 3] = b.parent >= 0 ? b.parent - sys.stars : -1;
    color[4 * g] = b.color[0];
    color[4 * g + 1] = b.color[1];
    color[4 * g + 2] = b.color[2];
    color[4 * g + 3] = b.kind === "moon" ? 0.7 : 1.1;
  }
  return n;
}

/** Per frame: `motion` (wrapped mean anomaly, mean motion, 0, 0) per non-star body at time `t`. */
export function fillOrbitMotion(sys: OrbitSystem, t: number, motion: Float32Array): void {
  const n = sys.bodies.length - sys.stars;
  for (let g = 0; g < n; g++) {
    const b = sys.bodies[sys.stars + g];
    motion[4 * g] = meanAnomaly(b, t);
    motion[4 * g + 1] = b.n;
  }
}
