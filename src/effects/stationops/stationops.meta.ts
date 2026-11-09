import { defineEffectMeta } from "../types";

export type OutsideId = "station" | "anomaly" | "planet";
type TrafficId = "off" | "quiet" | "busy";
type LightingId = "normal" | "night" | "red";

const OUTSIDE_OPTIONS = [
  { value: "station", label: "Station and stars" },
  { value: "anomaly", label: "Anomaly nearby" },
  { value: "planet", label: "Planet below" },
] as const satisfies readonly { value: OutsideId; label: string }[];

const TRAFFIC_OPTIONS = [
  { value: "quiet", label: "Now and then" },
  { value: "busy", label: "Busy" },
  { value: "off", label: "None" },
] as const satisfies readonly { value: TrafficId; label: string }[];

const LIGHTING_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "night", label: "Night shift" },
  { value: "red", label: "Red alert" },
] as const satisfies readonly { value: LightingId; label: string }[];

export const stationopsMeta = defineEffectMeta({
  id: "stationops",
  name: "Station Ops",
  description:
    "The operations room of an alien-built space station: dark ribbed bronze bulkheads, sloping consoles glowing amber and teal, and two great oval viewports looking out on the docking ring, with ships coming and going and, now and then, a swirling blue-white anomaly slowly opening in the distance.",
  params: {
    outside: { kind: "select", label: "Outside", options: OUTSIDE_OPTIONS, default: "station" },
    traffic: { kind: "select", label: "Ships", options: TRAFFIC_OPTIONS, default: "quiet" },
    anomaly: { kind: "boolean", label: "Anomaly opens now and then", default: true },
    lighting: { kind: "select", label: "Lighting", options: LIGHTING_OPTIONS, default: "normal" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 9 },
  },
  category: "Scenes",
  tags: ["space station", "sci-fi", "operations", "starbase", "wormhole", "docking", "command"],
  cost: "low",
  context: "webgl2",
});
