import { defineEffectMeta } from "../types";

export type RideTime = "sunrise" | "midday" | "sunset";
export type EnvelopeScheme = "rainbow" | "redyellow" | "bluewhite" | "patchwork";

export const RIDE_TIME_OPTIONS = [
  { value: "sunrise", label: "Sunrise" },
  { value: "midday", label: "Midday" },
  { value: "sunset", label: "Sunset" },
] as const satisfies readonly { value: RideTime; label: string }[];

export const ENVELOPE_OPTIONS = [
  { value: "rainbow", label: "Rainbow" },
  { value: "redyellow", label: "Red and yellow" },
  { value: "bluewhite", label: "Blue and white" },
  { value: "patchwork", label: "Patchwork" },
] as const satisfies readonly { value: EnvelopeScheme; label: string }[];

/** The most distant balloons in view. */
export const MAX_OTHERS = 8;

export const balloonrideMeta = defineEffectMeta({
  id: "balloonride",
  name: "Hot-Air Balloon Ride",
  description:
    "Standing in the basket of a hot-air balloon: the padded rim and suede-wrapped uprights round you, the burner and the glowing envelope overhead, and patchwork fields, a river and villages drifting by far below, with other balloons in the distance.",
  params: {
    time: { kind: "select", label: "Time", options: RIDE_TIME_OPTIONS, default: "sunrise" },
    envelope: { kind: "select", label: "Envelope", options: ENVELOPE_OPTIONS, default: "rainbow" },
    others: {
      kind: "number",
      label: "Other balloons",
      min: 0,
      max: MAX_OTHERS,
      step: 1,
      default: 4,
    },
    burner: {
      kind: "number",
      label: "Seconds between burns",
      min: 10,
      max: 120,
      step: 1,
      default: 35,
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: [
    "flight",
    "countryside",
    "sunrise",
    "travel",
    "adventure",
    "ballooning",
    "basket",
    "landscape",
  ],
  cost: "low",
  context: "webgl2",
});
