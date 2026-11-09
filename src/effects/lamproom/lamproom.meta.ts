import { defineEffectMeta } from "../types";

export type Weather = "calm" | "clouds" | "storm";
export type LensSide = "left" | "right";

const WEATHER_OPTIONS = [
  { value: "calm", label: "Calm" },
  { value: "clouds", label: "Clouds" },
  { value: "storm", label: "Storm" },
] as const satisfies readonly { value: Weather; label: string }[];

const LENS_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: LensSide; label: string }[];

/** Shortest and longest time between two passes of the beam, seconds. */
export const MIN_PERIOD = 10;
export const MAX_PERIOD = 60;

export const lamproomMeta = defineEffectMeta({
  id: "lamproom",
  name: "Lighthouse Lamp Room",
  description:
    "Inside the lamp room at the top of a lighthouse at night: a great faceted glass lens turns slowly in a ring of iron-framed windows, sweeping its beam out over a moonlit sea while bands of refracted light slide over the brass.",
  params: {
    period: {
      kind: "number",
      label: "Seconds between beams",
      min: MIN_PERIOD,
      max: MAX_PERIOD,
      step: 1,
      default: 20,
    },
    weather: { kind: "select", label: "Weather", options: WEATHER_OPTIONS, default: "clouds" },
    lens: { kind: "select", label: "Lens", options: LENS_OPTIONS, default: "left" },
    beam: { kind: "number", label: "Beam brightness", min: 0, max: 1, step: 0.05, default: 0.6 },
  },
  category: "Scenes",
  tags: ["coast", "storm", "keeper", "maritime", "ocean", "beacon", "fresnel"],
  cost: "medium",
  context: "webgl2",
});
