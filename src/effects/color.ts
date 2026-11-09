import { smoothstep } from "./math";

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    return [0, 0, 0];
  }
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Colour channels in 0..1, e.g. for a WebGL `vec3` uniform. */
export function hexToUnitRgb(hex: string): Rgb {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/** Gamma used to mix in (approximately) linear light; a shader re-encodes with 1 / LINEAR_GAMMA. */
export const LINEAR_GAMMA = 2.2;

/** sRGB-ish (gamma 2.2) hex colour to linear-light channels in 0..1. */
export function hexToLinear(hex: string): Rgb {
  const [r, g, b] = hexToUnitRgb(hex);
  return [r ** LINEAR_GAMMA, g ** LINEAR_GAMMA, b ** LINEAR_GAMMA];
}

/**
 * `hexToUnitRgb` for one colour param, remembering the last colour so a steady
 * value costs no parsing or allocation per frame: re-parses only when the string
 * changes. The returned array must not be modified.
 */
export function unitRgbMemo(): (hex: string) => Rgb {
  let lastHex: string | undefined;
  let lastRgb: Rgb = [0, 0, 0];
  return (hex) => {
    if (hex !== lastHex) {
      lastHex = hex;
      lastRgb = hexToUnitRgb(hex);
    }
    return lastRgb;
  };
}

/** A gradient stop: position in 0..1 and a `#rrggbb` colour. Stops ascend in position. */
type GradientStop = readonly [number, string];

/**
 * Fills `out` with an RGBA8 lookup table of `out.length / 4` texels across the
 * gradient `stops` (at least two), eased with a smoothstep between each pair of
 * stops, alpha 255. Returns `out`.
 */
export function buildGradientLut(stops: readonly GradientStop[], out: Uint8Array): Uint8Array {
  const size = out.length >> 2;
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) {
      s++;
    }
    const [t0, c0] = stops[s];
    const [t1, c1] = stops[s + 1];
    const f = smoothstep(t0, t1, t);
    const a = hexToRgb(c0);
    const b = hexToRgb(c1);
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A block of floats (colours, typically) that eases towards a target; see `createColorEase`. */
interface ColorEase {
  /** The eased values, ready to upload as uniforms. Don't modify. */
  readonly value: Float32Array;
  /**
   * Eases `value` towards the first `n` floats of `target` and returns `value`.
   * A new target starts a smoothstep crossfade from the current values lasting
   * `seconds`, so every channel arrives together; a target that changes again
   * mid-way restarts from where the values are. The first call, and the first
   * after `snap`, jumps straight to the target.
   */
  step: (target: ArrayLike<number>, dt: number, seconds: number) => Float32Array;
  /** Makes the next `step` jump to its target, after a cut where easing would look wrong. */
  snap: () => void;
  /** Whether a crossfade is under way: the next `step` may change `value`. */
  readonly moving: boolean;
}

/** Eases a block of `n` floats towards a target, allocating nothing per step. */
export function createColorEase(n: number): ColorEase {
  const value = new Float32Array(n);
  const from = new Float32Array(n);
  const to = new Float32Array(n);
  /** Crossfade progress, 0..1; 1 when settled. */
  let t = 1;
  let snapNext = true;
  return {
    value,
    get moving() {
      return t < 1;
    },
    step(target, dt, seconds) {
      if (snapNext) {
        snapNext = false;
        for (let i = 0; i < n; i++) {
          to[i] = target[i];
        }
        value.set(to);
        t = 1;
        return value;
      }
      for (let i = 0; i < n; i++) {
        // Compared as stored, so a target that float32 can't hold still counts as reached.
        if (to[i] !== Math.fround(target[i])) {
          from.set(value);
          for (let k = 0; k < n; k++) {
            to[k] = target[k];
          }
          t = 0;
          break;
        }
      }
      if (t >= 1) {
        return value;
      }
      const s = seconds > 0 ? Math.max(0, dt) / seconds : 1;
      t = Number.isFinite(s) ? Math.min(1, t + s) : 1;
      const f = smoothstep(0, 1, t);
      for (let i = 0; i < n; i++) {
        value[i] = t >= 1 ? to[i] : from[i] + (to[i] - from[i]) * f;
      }
      return value;
    },
    snap() {
      snapNext = true;
    },
  };
}
