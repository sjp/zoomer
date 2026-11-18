import { defineEffectMeta } from "../types";
import type { Place } from "./staticfigure-sim";

const PLACE_OPTIONS = [
  { value: "field", label: "Field" },
  { value: "carpark", label: "Car park" },
  { value: "hallway", label: "Hallway" },
] as const satisfies readonly { value: Place; label: string }[];

export const staticfigureMeta = defineEffectMeta({
  id: "staticfigure",
  name: "Static Figure",
  description:
    "A washed-out videotape of an empty place: a field at dusk, a car park under a sodium lamp or a long hallway. Every so often the picture breaks up, and when it clears a tall, thin shape is standing somewhere in the scene. Sometimes it's a little closer. Sometimes it's gone.",
  params: {
    place: { kind: "select", label: "Place", options: PLACE_OPTIONS, default: "field" },
    interval: {
      kind: "number",
      label: "Seconds between glitches",
      // The sim's INTERVAL_MIN and INTERVAL_MAX.
      min: 20,
      max: 90,
      step: 5,
      default: 45,
    },
    presence: {
      kind: "number",
      label: "Something there",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
    },
    tape: { kind: "number", label: "Tape wear", min: 0, max: 1, step: 0.05, default: 0.5 },
    overlay: { kind: "boolean", label: "Timestamp", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Creepy", "Retro"],
  tags: [
    "analog horror",
    "vhs",
    "found footage",
    "horror",
    "spooky",
    "halloween",
    "liminal",
    "glitch",
    "eerie",
  ],
  cost: "very low",
  context: "webgl2",
});
