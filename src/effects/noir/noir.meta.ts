import { defineEffectMeta } from "../types";

export type AdvertSide = "left" | "right" | "off";

export const ADVERT_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "off", label: "Off" },
] as const satisfies readonly { value: AdvertSide; label: string }[];

export const noirMeta = defineEffectMeta({
  id: "noir",
  name: "Neon-Noir Apartment",
  description:
    "A dark high-rise apartment on a rainy night: through half-closed blinds, lit towers fade into smog, flying cars drift past a giant advert screen, and now and then a searchlight sweeps its striped light across the room.",
  params: {
    blinds: { kind: "number", label: "Blinds closed", min: 0, max: 1, step: 0.05, default: 0.5 },
    rain: { kind: "number", label: "Rain", min: 0, max: 1, step: 0.05, default: 0.5 },
    traffic: { kind: "number", label: "Traffic", min: 0, max: 1, step: 0.05, default: 0.5 },
    advert: { kind: "select", label: "Advert", options: ADVERT_OPTIONS, default: "left" },
    search: { kind: "boolean", label: "Searchlight", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["cyberpunk", "rain", "neon", "city", "night", "sci-fi", "film noir", "skyscrapers"],
  cost: "medium",
  context: "webgl2",
});
