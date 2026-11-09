import { defineEffectMeta } from "../types";

type CradleCorner = "left" | "right";
export type CradleScene = "studio" | "lamp" | "office";
export type CradleFinish = "chrome" | "brass" | "glass";

const CORNER_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: CradleCorner; label: string }[];

export const SCENE_OPTIONS = [
  { value: "studio", label: "Studio" },
  { value: "lamp", label: "Desk lamp" },
  { value: "office", label: "Office" },
] as const satisfies readonly { value: CradleScene; label: string }[];

export const FINISH_OPTIONS = [
  { value: "chrome", label: "Chrome" },
  { value: "brass", label: "Brass" },
  { value: "glass", label: "Black glass" },
] as const satisfies readonly { value: CradleFinish; label: string }[];

/** Bounds of the `balls` param. */
export const BALLS_RANGE = [3, 7] as const;
/** Bounds of the `swing` param (degrees from vertical). */
export const SWING_RANGE = [10, 40] as const;
/** Bounds of the `size` param. */
export const SIZE_RANGE = [0.7, 1.5] as const;

export const cradleMeta = defineEffectMeta({
  id: "cradle",
  name: "Newton's Cradle",
  description:
    "A polished Newton's cradle on a desk in a bottom corner: the end balls swing out and click back in turn while the middle ones stay still, mirroring a soft studio light.",
  params: {
    balls: {
      kind: "number",
      label: "Balls",
      min: BALLS_RANGE[0],
      max: BALLS_RANGE[1],
      step: 1,
      default: 5,
    },
    lifted: { kind: "number", label: "Balls swinging", min: 1, max: 2, step: 1, default: 1 },
    swing: {
      kind: "number",
      label: "Swing (°)",
      min: SWING_RANGE[0],
      max: SWING_RANGE[1],
      step: 1,
      default: 25,
    },
    corner: { kind: "select", label: "Corner", options: CORNER_OPTIONS, default: "right" },
    scene: { kind: "select", label: "Scene", options: SCENE_OPTIONS, default: "studio" },
    finish: { kind: "select", label: "Finish", options: FINISH_OPTIONS, default: "chrome" },
    size: {
      kind: "number",
      label: "Size",
      min: SIZE_RANGE[0],
      max: SIZE_RANGE[1],
      step: 0.05,
      default: 1,
    },
  },
  category: "Science",
  tags: [
    "physics",
    "momentum",
    "desk toy",
    "executive toy",
    "pendulum",
    "kinetic",
    "metal",
    "click",
  ],
  cost: "very low",
  context: "webgl2",
});
