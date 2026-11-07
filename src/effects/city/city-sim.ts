/**
 * Pure JS logic for the city-at-night effect: skyline generation (building
 * quads, window grids, beacons and stars, all in 1080p reference pixels) and the
 * window toggle scheduler that owns the per-window data texture contents.
 */
import { clamp, smoothstep } from "../math";
import { createRng } from "../noise";

/** Reference frame height; every layout coordinate is in these units, y down. */
export const REF_HEIGHT = 1080;
/** Data texture width, in texels (windows). Window `i` is at `(i & 255, i >> 8)`. */
export const WINDOW_TEX_WIDTH = 256;
export const WINDOW_TEX_ROWS = 128;
export const MAX_WINDOWS = WINDOW_TEX_WIDTH * WINDOW_TEX_ROWS;
/** Building quads (bodies, stepped tops, antennas, water towers) across all layers. */
export const MAX_QUADS = 1024;
export const MAX_BEACONS = 96;
export const MAX_STARS = 120;
/**
 * Fade slots; the shader reads their progress from `uFade[FADE_SLOTS / 4]`
 * (vec4s), so a multiple of 4. Windows that start fading within JOIN_SECONDS of
 * each other share a slot, so the slots cover a full fade at up to
 * (FADE_SLOTS - 4) / FADE_SECONDS new slots a second, however many windows toggle.
 */
export const FADE_SLOTS = 64;
/** Seconds a toggled window takes to fade on or off. */
export const FADE_SECONDS = 0.5;
/** Fades starting this close together share a slot: well under a frame's worth of difference. */
const JOIN_SECONDS = FADE_SECONDS / (FADE_SLOTS - 4);
/** Most toggles started in one frame, so a long hitch doesn't start a burst. */
const MAX_TOGGLES_PER_FRAME = 48;
/** Windows one slot can carry: a frame's worth of toggles. */
const SLOT_CAPACITY = MAX_TOGGLES_PER_FRAME;

/**
 * Floats per building quad instance, as four vec4 attributes:
 * - rect: x, top, width, height;
 * - grid: cell width, cell height, columns, rows (0 columns: no windows);
 * - win: grid left margin, grid top margin, window width and height as fractions of a cell;
 * - misc: first window index, haze (mix toward the sky), window brightness, unused.
 */
export const QUAD_STRIDE = 16;
/** Floats per beacon: x, y, radius, phase (0..1, shared by a building's beacons). */
export const BEACON_STRIDE = 4;
/** Floats per star: x, y, radius, intensity. */
export const STAR_STRIDE = 4;

interface LayerSpec {
  /** Main body height range, as fractions of the frame height. */
  lo: number;
  hi: number;
  /** Building width range at density 0 and 1. */
  widthSparse: [number, number];
  widthDense: [number, number];
  cellW: number;
  cellH: number;
  haze: number;
  windowDim: number;
  beaconRadius: number;
}

/** Far to near. Far layers are lower, hazier and have smaller, dimmer windows. */
export const LAYERS: readonly LayerSpec[] = [
  {
    lo: 0.16,
    hi: 0.36,
    widthSparse: [70, 150],
    widthDense: [28, 70],
    cellW: 6,
    cellH: 8,
    haze: 0.55,
    windowDim: 0.5,
    beaconRadius: 4,
  },
  {
    lo: 0.2,
    hi: 0.48,
    widthSparse: [90, 190],
    widthDense: [36, 90],
    cellW: 9,
    cellH: 12,
    haze: 0.28,
    windowDim: 0.72,
    beaconRadius: 5.5,
  },
  {
    lo: 0.14,
    hi: 0.58,
    widthSparse: [110, 230],
    widthDense: [45, 115],
    cellW: 14,
    cellH: 19,
    haze: 0,
    windowDim: 1,
    beaconRadius: 7,
  },
];

/** A main building body, for tests and debugging. */
export interface Building {
  layer: number;
  x: number;
  width: number;
  /** Height of the body including any stepped top (antennas and tanks excluded). */
  height: number;
}

export interface CityLayout {
  refWidth: number;
  buildings: Building[];
  /** `quadCount * QUAD_STRIDE` floats, far layer first. */
  quads: Float32Array;
  quadCount: number;
  windowCount: number;
  beacons: Float32Array;
  beaconCount: number;
  stars: Float32Array;
  starCount: number;
}

/**
 * Builds a skyline for `seed`, `density` (0..1) and a frame `refWidth` reference
 * pixels wide. Deterministic; allocates, so call only when an input changes.
 */
export function generateCity(seed: number, density: number, refWidth: number): CityLayout {
  const rng = createRng(seed);
  const between = (a: number, b: number) => a + (b - a) * rng();
  const d = clamp(density, 0, 1);
  const W = refWidth;
  const H = REF_HEIGHT;
  const quads = new Float32Array(MAX_QUADS * QUAD_STRIDE);
  const beacons = new Float32Array(MAX_BEACONS * BEACON_STRIDE);
  const buildings: Building[] = [];
  let quadCount = 0;
  let windowCount = 0;
  let beaconCount = 0;

  /** Appends a quad; `cellW <= 0` means no windows. Returns false when full. */
  const addQuad = (
    x: number,
    top: number,
    w: number,
    h: number,
    layer: number,
    cellW = 0,
    cellH = 0,
    winW = 0,
    winH = 0,
  ): boolean => {
    if (quadCount >= MAX_QUADS) {
      return false;
    }
    const spec = LAYERS[layer];
    let cols = 0;
    let rows = 0;
    let marginX = 0;
    let marginTop = 0;
    if (cellW > 0) {
      const side = Math.max(2, cellW * 0.4);
      cols = Math.floor((w - 2 * side) / cellW);
      marginTop = cellH * 0.7;
      rows = Math.floor((h - marginTop) / cellH);
      if (cols < 1 || rows < 1 || windowCount + cols * rows > MAX_WINDOWS) {
        cols = 0;
        rows = 0;
      }
      marginX = (w - cols * cellW) / 2;
    }
    const o = quadCount * QUAD_STRIDE;
    quads[o] = x;
    quads[o + 1] = top;
    quads[o + 2] = w;
    quads[o + 3] = h;
    quads[o + 4] = cellW;
    quads[o + 5] = cellH;
    quads[o + 6] = cols;
    quads[o + 7] = rows;
    quads[o + 8] = marginX;
    quads[o + 9] = marginTop;
    quads[o + 10] = winW;
    quads[o + 11] = winH;
    quads[o + 12] = windowCount;
    quads[o + 13] = spec.haze;
    quads[o + 14] = spec.windowDim;
    quads[o + 15] = 0;
    windowCount += cols * rows;
    quadCount++;
    return true;
  };

  const addBeacon = (x: number, y: number, radius: number, phase: number) => {
    if (beaconCount >= MAX_BEACONS) {
      return;
    }
    const o = beaconCount * BEACON_STRIDE;
    beacons[o] = x;
    beacons[o + 1] = y;
    beacons[o + 2] = radius;
    beacons[o + 3] = phase;
    beaconCount++;
  };

  for (let layer = 0; layer < LAYERS.length; layer++) {
    const spec = LAYERS[layer];
    const minW = spec.widthSparse[0] + (spec.widthDense[0] - spec.widthSparse[0]) * d;
    const maxW = spec.widthSparse[1] + (spec.widthDense[1] - spec.widthSparse[1]) * d;
    const lo = spec.lo * H;
    const hi = spec.hi * H;
    let x = 0;
    while (x < W - minW * 0.4) {
      // quadCount grows in the quad helpers, which the loop condition can't see.
      if (quadCount >= MAX_QUADS) {
        break;
      }
      let w = between(minW, maxW);
      // Close a narrow leftover by widening the last building to the edge.
      if (W - (x + w) < minW * 0.4) {
        w = W - x;
      }
      w = Math.min(w, W - x);
      // Taller toward the edges: the speaker covers the middle of the frame.
      const edge = Math.abs(((x + w / 2) / W) * 2 - 1);
      const h = lo + (hi - lo) * rng() * (0.55 + 0.45 * edge);
      const top = H - h;

      // Window style: tall residential windows or wide office strips; some dark.
      const dark = rng() < 0.08;
      const office = rng() < 0.4;
      const cellScale = between(0.85, 1.15);
      const cellW = spec.cellW * cellScale * (office ? 1.2 : 1);
      const cellH = spec.cellH * cellScale;
      const winW = office ? between(0.7, 0.85) : between(0.42, 0.6);
      const winH = office ? between(0.4, 0.55) : between(0.5, 0.68);
      const grid = dark ? 0 : cellW;

      // Stepped top: a narrower block making up the top of the total height.
      const stepped = layer > 0 && w >= 60 && h > lo + 0.3 * (hi - lo) && rng() < 0.3;
      let bodyTop = top;
      let roofX = x;
      let roofW = w;
      if (stepped) {
        const stepH = Math.min(between(0.04, 0.1) * H, h * 0.3);
        roofW = w * between(0.5, 0.75);
        roofX = x + (w - roofW) * between(0.3, 0.7);
        bodyTop = top + stepH;
        if (!addQuad(roofX, top, roofW, stepH, layer, grid, cellH, winW, winH)) {
          break;
        }
      }
      if (!addQuad(x, bodyTop, w, H - bodyTop, layer, grid, cellH, winW, winH)) {
        break;
      }
      buildings.push({ layer, x, width: w, height: h });

      // Roof details on the taller buildings, beacons on the tallest.
      const tall = (h - lo) / (hi - lo);
      const phase = rng();
      const r = spec.beaconRadius;
      if (layer > 0 && tall > 0.7 && rng() < 0.5) {
        const aw = layer === 2 ? 3 : 2;
        const ah = between(25, 70) * (layer === 2 ? 1 : 0.7);
        const ax = roofX + roofW * between(0.3, 0.7) - aw / 2;
        if (addQuad(ax, top - ah, aw, ah, layer)) {
          addBeacon(ax + aw / 2, top - ah, r, phase);
        }
      } else if (tall > (layer === 0 ? 0.85 : 0.65) && rng() < (layer === 0 ? 0.3 : 0.6)) {
        const inset = Math.min(4, roofW * 0.1);
        addBeacon(roofX + inset, top - 1, r * 0.8, phase);
        if (roofW > 40) {
          addBeacon(roofX + roofW - inset, top - 1, r * 0.8, phase);
        }
      } else if (layer === 2 && tall < 0.6 && w >= 70 && rng() < 0.15) {
        // Water tower: a tank on short legs.
        const tw = between(16, 22);
        const tx = x + between(0.15, 0.85) * (w - tw);
        addQuad(tx + tw * 0.2, top - 6, tw * 0.6, 6, layer);
        const th = between(14, 20);
        addQuad(tx, top - 6 - th, tw, th, layer);
      }

      const gap = rng() < (1 - d) * 0.5 ? between(4, 30) : 0;
      x += w + gap;
    }
  }

  // A few faint stars at the top of the sky.
  const starCount = Math.min(MAX_STARS, Math.round((45 * W) / 1920));
  const stars = new Float32Array(MAX_STARS * STAR_STRIDE);
  for (let i = 0; i < starCount; i++) {
    const o = i * STAR_STRIDE;
    stars[o] = rng() * W;
    // Denser toward the top.
    const v = rng();
    stars[o + 1] = v * v * 0.36 * H;
    stars[o + 2] = between(1.6, 2.6);
    stars[o + 3] = between(0.06, 0.3);
  }

  return {
    refWidth: W,
    buildings,
    quads,
    quadCount,
    windowCount,
    beacons,
    beaconCount,
    stars,
    starCount,
  };
}

/**
 * Per-window state and its RGBA8 texel data (`data`, 4 bytes per window, in
 * window order): R = level faded from, G = level faded to, B = colour pick
 * (0..255; the shader maps it to the palette using the warmth), A = fade slot + 1
 * (0 when settled, when the shader shows G). The CPU writes a texel only when a
 * fade starts or settles; the shader reads fade progress from `fade`.
 */
export interface WindowState {
  readonly data: Uint8Array;
  /** Smoothstepped progress (0..1) of each fade slot, for `uFade`. */
  readonly fade: Float32Array;
  /** Window indices whose texels changed since the last `step`/`reset`. */
  readonly dirty: Int32Array;
  readonly dirtyCount: number;
  readonly windowCount: number;
  readonly litCount: number;
  /** Whether any fade is in progress (or just settled), so `fade` needs uploading. */
  readonly fading: boolean;
  /** Assigns new random colours and levels, then lights `litFraction` of the windows. */
  reset: (windowCount: number, seed: number, litFraction: number) => void;
  /** Lights exactly round(fraction * count) windows (instantly) and cancels fades. */
  setLit: (fraction: number) => void;
  /**
   * Moves the lit target to round(fraction * count) without touching any window,
   * so `step` fades windows on or off towards it at its toggle rate.
   */
  setTarget: (fraction: number) => void;
  /**
   * Advances fades and, at `rate` toggles per second, starts new ones that keep
   * the lit count near the target. Fills `dirty` with the texels that changed.
   */
  step: (dt: number, rate: number) => void;
  isLit: (i: number) => boolean;
}

export function createWindowState(maxWindows = MAX_WINDOWS): WindowState {
  const data = new Uint8Array(maxWindows * 4);
  /** Lit level of each window when on, 0..255. */
  const level = new Uint8Array(maxWindows);
  /** A permutation rank in [0, 1), so `rank < fraction` lights an exact count. */
  const rank = new Float32Array(maxWindows);
  const lit = new Uint8Array(maxWindows);
  const fade = new Float32Array(FADE_SLOTS);
  /** Windows fading in each slot: SLOT_CAPACITY entries per slot, the first `slotCount` used. */
  const slotWindows = new Int32Array(FADE_SLOTS * SLOT_CAPACITY);
  const slotCount = new Int32Array(FADE_SLOTS);
  const slotAge = new Float32Array(FADE_SLOTS);
  /** Slot most recently opened, which new fades join while it is young; -1 for none. */
  let latest = -1;
  /** Each fade dirties a texel when it starts and when it settles: at most every window in flight settling plus a frame's new starts. */
  const dirty = new Int32Array(FADE_SLOTS * SLOT_CAPACITY + MAX_TOGGLES_PER_FRAME);
  let dirtyCount = 0;
  let count = 0;
  let litCount = 0;
  let target = 0;
  let active = 0;
  let fading = false;
  let rng = createRng(0);
  let untilToggle = 1;

  const markDirty = (i: number) => {
    if (dirtyCount < dirty.length) {
      dirty[dirtyCount++] = i;
    }
  };

  const clearFades = () => {
    slotCount.fill(0);
    fade.fill(1);
    latest = -1;
    active = 0;
  };

  const setLit = (fraction: number) => {
    clearFades();
    const f = clamp(fraction, 0, 1);
    target = Math.round(f * count);
    litCount = 0;
    for (let i = 0; i < count; i++) {
      const on = rank[i] < target / Math.max(1, count) ? 1 : 0;
      lit[i] = on;
      litCount += on;
      const v = on ? level[i] : 0;
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 3] = 0;
    }
  };

  /** Starts fading window `i` to the opposite state; false if no slot is free. */
  const toggle = (i: number): boolean => {
    let slot = -1;
    if (
      latest >= 0 &&
      slotCount[latest] > 0 &&
      slotCount[latest] < SLOT_CAPACITY &&
      slotAge[latest] < JOIN_SECONDS
    ) {
      slot = latest;
    } else {
      for (let s = 0; s < FADE_SLOTS; s++) {
        if (slotCount[s] === 0) {
          slot = s;
          break;
        }
      }
      if (slot < 0) {
        return false;
      }
      slotAge[slot] = 0;
      fade[slot] = 0;
      latest = slot;
      active++;
    }
    const on = lit[i] ? 0 : 1;
    lit[i] = on;
    litCount += on ? 1 : -1;
    const o = i * 4;
    data[o] = data[o + 1];
    data[o + 1] = on ? level[i] : 0;
    data[o + 3] = slot + 1;
    slotWindows[slot * SLOT_CAPACITY + slotCount[slot]++] = i;
    markDirty(i);
    return true;
  };

  /** Picks a random settled window that is `wantLit` and toggles it. */
  const toggleOne = (wantLit: boolean) => {
    for (let tries = 0; tries < 64; tries++) {
      const i = Math.floor(rng() * count);
      if ((lit[i] === 1) === wantLit && data[i * 4 + 3] === 0) {
        toggle(i);
        return;
      }
    }
  };

  return {
    data,
    fade,
    dirty,
    get dirtyCount() {
      return dirtyCount;
    },
    get windowCount() {
      return count;
    },
    get litCount() {
      return litCount;
    },
    get fading() {
      return fading;
    },
    reset(windowCount, seed, litFraction) {
      count = Math.max(0, Math.min(maxWindows, Math.floor(windowCount)));
      rng = createRng(seed ^ 0x5bd1e995);
      // Shuffled ranks, so the lit set for each fraction is a random subset.
      for (let i = 0; i < count; i++) {
        rank[i] = i;
      }
      for (let i = count - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = rank[i];
        rank[i] = rank[j];
        rank[j] = t;
      }
      for (let i = 0; i < count; i++) {
        rank[i] = (rank[i] + 0.5) / count;
        level[i] = 150 + Math.floor(rng() * 106);
        data[i * 4 + 2] = Math.floor(rng() * 256);
      }
      untilToggle = 0.5 + rng();
      dirtyCount = 0;
      setLit(litFraction);
      fading = true;
    },
    setLit(fraction) {
      setLit(fraction);
      dirtyCount = 0;
      fading = true;
    },
    setTarget(fraction) {
      target = Math.round(clamp(fraction, 0, 1) * count);
    },
    step(dt, rate) {
      dirtyCount = 0;
      fading = active > 0;
      for (let s = 0; s < FADE_SLOTS; s++) {
        const n = slotCount[s];
        if (n === 0) {
          continue;
        }
        slotAge[s] += dt;
        fade[s] = smoothstep(0, FADE_SECONDS, slotAge[s]);
        if (slotAge[s] >= FADE_SECONDS) {
          // Settle: the texels show their targets without a slot, freeing the slot.
          for (let k = 0; k < n; k++) {
            const i = slotWindows[s * SLOT_CAPACITY + k];
            const o = i * 4;
            data[o] = data[o + 1];
            data[o + 3] = 0;
            markDirty(i);
          }
          slotCount[s] = 0;
          active--;
        }
      }
      if (!(rate > 0) || count === 0) {
        return;
      }
      untilToggle -= dt * rate;
      // A bounded number of toggles per frame, even after a long hitch.
      for (let n = 0; untilToggle <= 0 && n < MAX_TOGGLES_PER_FRAME; n++) {
        untilToggle += 0.4 + 1.2 * rng();
        if (litCount > target) {
          toggleOne(true);
        } else if (litCount < target) {
          toggleOne(false);
        } else if (target > 0 && target < count) {
          toggleOne(rng() < 0.5);
        }
      }
      if (untilToggle <= 0) {
        untilToggle = 0.4 + 1.2 * rng();
      }
      fading = fading || active > 0;
    },
    isLit: (i) => lit[i] === 1,
  };
}

/** Beacon brightness (0..1) at `phase` cycles: a slow, smooth pulse with a dim floor. */
export function beaconPulse(phase: number): number {
  const s = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
  return 0.06 + 0.94 * s * s * s;
}

/** Aircraft strobe brightness (0..1) `age` seconds into its flight: a soft blink every 1.5 s. */
export function strobe(age: number): number {
  const s = ((age / 1.5) % 1) - 0.08;
  return Math.exp(-(s * s) / (2 * 0.035 * 0.035));
}

/** One aircraft crossing the sky at a time, rarely. Positions are reference px. */
export interface Aircraft {
  active: boolean;
  x: number;
  y: number;
  age: number;
  /** Advances the flight, or the wait for the next one. `refWidth` is the frame width. */
  step: (dt: number, refWidth: number, enabled: boolean) => void;
}

export function createAircraft(seed: number): Aircraft {
  const rng = createRng(seed ^ 0x2c1b3c6d);
  let wait = 4 + 8 * rng();
  let vx = 0;
  let vy = 0;
  const plane: Aircraft = {
    active: false,
    x: 0,
    y: 0,
    age: 0,
    step(dt, refWidth, enabled) {
      if (!enabled) {
        plane.active = false;
        return;
      }
      if (!plane.active) {
        wait -= dt;
        if (wait > 0) {
          return;
        }
        // Cross the frame in about 30 s, high in the sky, either way.
        const duration = 26 + 8 * rng();
        const dir = rng() < 0.5 ? 1 : -1;
        const margin = 20;
        plane.x = dir > 0 ? -margin : refWidth + margin;
        plane.y = (0.06 + 0.22 * rng()) * REF_HEIGHT;
        vx = (dir * (refWidth + 2 * margin)) / duration;
        vy = ((rng() - 0.5) * 80) / duration;
        plane.age = 0;
        plane.active = true;
        wait = 30 + 50 * rng();
        return;
      }
      plane.age += dt;
      plane.x += vx * dt;
      plane.y += vy * dt;
      if (plane.x < -40 || plane.x > refWidth + 40) {
        plane.active = false;
      }
    },
  };
  return plane;
}
