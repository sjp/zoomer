import { defineEffectMeta } from "../types";

export const REGION_OPTIONS = [
  { value: "british", label: "British Isles" },
  { value: "europe", label: "Western Europe" },
  { value: "america", label: "North America" },
  { value: "australia", label: "Australia" },
  { value: "japan", label: "Japan" },
] as const;
export type RegionId = (typeof REGION_OPTIONS)[number]["value"];

const STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const;

export const SEASON_OPTIONS = [
  { value: "spring", label: "Spring" },
  { value: "summer", label: "Summer" },
  { value: "autumn", label: "Autumn" },
  { value: "winter", label: "Winter" },
] as const;
export type SeasonId = (typeof SEASON_OPTIONS)[number]["value"];

const UNIT_OPTIONS = [
  { value: "c", label: "°C" },
  { value: "f", label: "°F" },
] as const;

/** Seconds each day's forecast shows. */
export const MIN_PACE = 10;
export const MAX_PACE = 60;

export const weathermapMeta = defineEffectMeta({
  id: "weathermap",
  name: "Weather Forecast Map",
  description:
    "Present the forecast in front of a regional weather map: pressure lines drift, cold and warm fronts sweep slowly across with rain on the radar, and every so often the forecast moves on to the next day, with new symbols and temperatures over the cities.",
  params: {
    region: { kind: "select", label: "Region", options: REGION_OPTIONS, default: "british" },
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "classic" },
    season: { kind: "select", label: "Season", options: SEASON_OPTIONS, default: "autumn" },
    units: { kind: "select", label: "Units", options: UNIT_OPTIONS, default: "c" },
    radar: { kind: "boolean", label: "Rain radar", default: true },
    pace: {
      kind: "number",
      label: "Seconds per day",
      min: MIN_PACE,
      max: MAX_PACE,
      step: 1,
      default: 25,
    },
  },
  categories: ["Scenes", "Sky & weather", "Work"],
  tags: [
    "isobars",
    "meteorologist",
    "weatherman",
    "tv",
    "presenter",
    "high pressure",
    "low pressure",
    "temperature",
  ],
  cost: "low",
  context: "webgl2",
});
