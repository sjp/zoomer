import { defineEffectMeta } from "./types";

export type PhylloStyleId = "sunflower" | "pinecone" | "succulent" | "abstract";
export type PhylloPositionId = "bottomLeft" | "bottomRight" | "side";

export const STYLE_OPTIONS = [
  { value: "sunflower", label: "Sunflower" },
  { value: "pinecone", label: "Pine cone" },
  { value: "succulent", label: "Succulent" },
  { value: "abstract", label: "Abstract" },
] as const satisfies readonly { value: PhylloStyleId; label: string }[];

export const POSITION_OPTIONS = [
  { value: "bottomLeft", label: "Bottom left" },
  { value: "bottomRight", label: "Bottom right" },
  { value: "side", label: "Side" },
] as const satisfies readonly { value: PhylloPositionId; label: string }[];

/** Most seeds the head can show. */
export const MAX_SEEDS = 3000;

export const phyllotaxisMeta = defineEffectMeta({
  id: "phyllotaxis",
  name: "Sunflower Spiral",
  description:
    "Seeds placed one by one at the golden angle form the interlocking spirals of a sunflower head, slowly growing outward and turning in a corner of the frame.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "sunflower" },
    seeds: { kind: "number", label: "Seeds", min: 200, max: MAX_SEEDS, step: 10, default: 1200 },
    growth: {
      kind: "number",
      label: "Growth (seeds per second)",
      min: 0,
      max: 3,
      step: 0.05,
      default: 0.6,
    },
    spin: {
      kind: "number",
      label: "Rotation (negative = anticlockwise)",
      min: -1,
      max: 1,
      step: 0.01,
      default: 0.2,
    },
    angle: {
      kind: "number",
      label: "Divergence offset (degrees)",
      min: -2,
      max: 2,
      step: 0.01,
      default: 0,
    },
    position: {
      kind: "select",
      label: "Position",
      options: POSITION_OPTIONS,
      default: "bottomRight",
    },
  },
  category: "Nature",
  tags: [
    "phyllotaxis",
    "fibonacci",
    "golden ratio",
    "flower",
    "pine cone",
    "succulent",
    "botany",
    "maths",
    "calm",
  ],
  cost: "very low",
  context: "webgl2",
});
