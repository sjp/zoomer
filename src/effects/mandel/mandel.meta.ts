import type { PaletteName, TargetName } from "./mandel-sim";
import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

export const TARGET_OPTIONS = [
  { value: "seahorse", label: "Seahorse" },
  { value: "elephant", label: "Elephant" },
  { value: "spiral", label: "Spiral" },
  { value: "minibrot", label: "Mini-brot" },
] as const satisfies readonly { value: TargetName; label: string }[];

export const PALETTE_OPTIONS = [
  { value: "ocean", label: "Ocean" },
  { value: "fire", label: "Fire" },
  { value: "pastel", label: "Pastel" },
  { value: "mono", label: "Mono" },
] as const satisfies readonly { value: PaletteName; label: string }[];

/** `speed` param range: seconds per doubling of zoom. */
export const MIN_SECONDS_PER_DOUBLING = 4;
export const MAX_SECONDS_PER_DOUBLING = 60;
/** `detail` param range: iterations above the view's typical escape count. */
export const MIN_DETAIL = 40;
export const MAX_DETAIL = 400;
/** About 200 iterations at the deep end of the loop. */
export const DEFAULT_DETAIL = 160;
/** `spin` limit, degrees per second either way. */
const SPIN_MAX = 6;

export const mandelMeta = defineEffectMeta({
  id: "mandel",
  name: "Mandelbrot Zoom",
  description:
    "An endless, very slow dive into the Mandelbrot set, toward a point where spirals and tiny copies of the set keep unfolding in softly shifting colour.",
  params: {
    target: { kind: "select", label: "Target", options: TARGET_OPTIONS, default: "seahorse" },
    speed: {
      kind: "number",
      label: "Seconds per doubling",
      min: MIN_SECONDS_PER_DOUBLING,
      max: MAX_SECONDS_PER_DOUBLING,
      step: 1,
      default: 15,
    },
    spin: {
      kind: "number",
      label: "Spin (°/s)",
      min: -SPIN_MAX,
      max: SPIN_MAX,
      step: 0.25,
      default: 1,
    },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "ocean" },
    detail: {
      kind: "number",
      label: "Detail (iterations)",
      min: MIN_DETAIL,
      max: MAX_DETAIL,
      step: 10,
      default: DEFAULT_DETAIL,
    },
    dim: { kind: "number", label: "Centre dimming", min: 0, max: 1, step: 0.05, default: 0.35 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Abstract",
  tags: ["fractal", "mandelbrot", "infinite", "math", "seahorse", "spiral", "psychedelic"],
  cost: "medium",
  context: "webgl2",
});
