import type { MarbleSide } from "./marblerun-sim";
import { defineEffectMeta } from "../types";

export type MarbleGlass = "clear" | "mixed" | "cats";

const SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: MarbleSide; label: string }[];

const GLASS_OPTIONS = [
  { value: "clear", label: "Clear" },
  { value: "mixed", label: "Mixed colours" },
  { value: "cats", label: "Cat's eyes" },
] as const satisfies readonly { value: MarbleGlass; label: string }[];

/** Most marbles in the loop. */
export const MAX_MARBLES = 16;

export const marblerunMeta = defineEffectMeta({
  id: "marblerun",
  name: "Marble Run",
  description:
    "Glass marbles roll down a wooden marble run that zigzags down one side of the frame, drop from track to track, and ride a slow screw lift back to the top.",
  params: {
    marbles: { kind: "number", label: "Marbles", min: 1, max: MAX_MARBLES, step: 1, default: 7 },
    speed: { kind: "number", label: "Speed", min: 0.25, max: 2, step: 0.05, default: 1 },
    levels: { kind: "number", label: "Levels", min: 3, max: 6, step: 1, default: 5 },
    side: { kind: "select", label: "Side", options: SIDE_OPTIONS, default: "right" },
    glass: { kind: "select", label: "Glass", options: GLASS_OPTIONS, default: "mixed" },
  },
  category: "Cosy",
  tags: ["toy", "playroom", "kinetic", "rollercoaster", "mechanical", "satisfying", "beech"],
  cost: "very low",
  context: "webgl2",
});
