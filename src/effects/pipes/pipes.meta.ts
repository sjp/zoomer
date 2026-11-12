import { defineEffectMeta } from "../types";

type PipesStyle = "classic" | "modern";
export type PipesJoints = "balls" | "elbows" | "mixed";

const PIPES_STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const satisfies readonly { value: PipesStyle; label: string }[];

const PIPES_JOINT_OPTIONS = [
  { value: "balls", label: "Balls" },
  { value: "elbows", label: "Elbows" },
  { value: "mixed", label: "Mixed" },
] as const satisfies readonly { value: PipesJoints; label: string }[];

/** Most pipes growing at once. */
export const MAX_PIPES = 6;
/** The largest fraction of the volume the pipes fill before it fades and starts again. */
export const MAX_FILL = 0.5;

export const pipesMeta = defineEffectMeta({
  id: "pipes",
  name: "3D Pipes",
  description:
    "Shiny coloured pipes growing a segment at a time through an invisible 3D grid, turning at right angles, until the picture fades and starts again.",
  params: {
    style: { kind: "select", label: "Style", options: PIPES_STYLE_OPTIONS, default: "modern" },
    speed: {
      kind: "number",
      label: "Speed (segments/s)",
      min: 1,
      max: 5,
      step: 0.5,
      default: 4,
    },
    count: { kind: "number", label: "Pipes at once", min: 1, max: MAX_PIPES, step: 1, default: 3 },
    joints: { kind: "select", label: "Joints", options: PIPES_JOINT_OPTIONS, default: "mixed" },
    fill: {
      kind: "number",
      label: "Fill before reset",
      min: 0.05,
      max: MAX_FILL,
      step: 0.05,
      default: 0.2,
    },
    orbit: { kind: "boolean", label: "Slow camera orbit", default: false },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Retro",
  tags: ["screensaver", "windows", "plumbing", "maze", "90s", "opengl", "tubes", "nostalgia"],
  cost: "low",
  context: "webgl2",
});
