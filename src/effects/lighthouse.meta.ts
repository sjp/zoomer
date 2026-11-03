import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const lighthouseMeta = defineEffectMeta({
  id: "lighthouse",
  name: "Lighthouse in Fog",
  description:
    "A lighthouse on a headland at night, its beam sweeping slowly through banks of drifting sea fog.",
  params: {
    side: {
      kind: "select",
      label: "Side",
      options: [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ],
      default: "right",
    },
    period: { kind: "number", label: "Seconds per turn", min: 4, max: 40, step: 1, default: 12 },
    beams: {
      kind: "select",
      label: "Beams",
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ],
      default: "one",
    },
    fog: { kind: "number", label: "Fog", min: 0, max: 1, step: 0.01, default: 0.6 },
    drift: { kind: "number", label: "Fog drift", min: 0, max: 3, step: 0.05, default: 1 },
    beamColor: { kind: "color", label: "Beam colour", default: "#ffeccc" },
    flare: { kind: "number", label: "Flare", min: 0, max: 1, step: 0.01, default: 0.5 },
    stars: { kind: "boolean", label: "Stars", default: true },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Water",
  tags: ["coast", "beacon", "mist", "maritime", "harbour", "calm"],
  cost: "low",
  context: "webgl2",
});
