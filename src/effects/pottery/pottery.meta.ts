import { defineEffectMeta } from "../types";

export type PotteryCorner = "left" | "right";
export type PotteryFormId = "vase" | "bowl" | "jar" | "cycle";
export type ClayId = "terracotta" | "stoneware" | "porcelain";

export const FORM_OPTIONS = [
  { value: "vase", label: "Vase" },
  { value: "bowl", label: "Bowl" },
  { value: "jar", label: "Jar" },
  { value: "cycle", label: "Cycle" },
] as const satisfies readonly { value: PotteryFormId; label: string }[];

export const CLAY_OPTIONS = [
  { value: "terracotta", label: "Terracotta" },
  { value: "stoneware", label: "Stoneware" },
  { value: "porcelain", label: "Porcelain" },
] as const satisfies readonly { value: ClayId; label: string }[];

export const CORNER_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: PotteryCorner; label: string }[];

export const potteryMeta = defineEffectMeta({
  id: "pottery",
  name: "Pottery Wheel",
  description:
    "Wet clay turning on a potter's wheel in the corner of a quiet studio, slowly rising from a mound into a vase, a bowl or a jar, then sinking back to start again.",
  params: {
    form: { kind: "select", label: "Form", options: FORM_OPTIONS, default: "cycle" },
    clay: { kind: "select", label: "Clay", options: CLAY_OPTIONS, default: "terracotta" },
    cycle: { kind: "number", label: "Cycle (s)", min: 20, max: 180, step: 5, default: 60 },
    spin: { kind: "number", label: "Wheel speed", min: 0, max: 2, step: 0.05, default: 0.6 },
    corner: { kind: "select", label: "Corner", options: CORNER_OPTIONS, default: "right" },
  },
  category: "Cosy",
  tags: ["ceramics", "clay", "potter", "studio", "craft", "handmade", "throwing", "calm"],
  cost: "very low",
  context: "webgl2",
});
