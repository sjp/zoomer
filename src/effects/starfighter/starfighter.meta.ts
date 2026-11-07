import { defineEffectMeta } from "../types";

export type DroidSide = "left" | "right";
export type OutsideId = "space" | "planet" | "nebula";

export const DROID_SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: DroidSide; label: string }[];

export const OUTSIDE_OPTIONS = [
  { value: "space", label: "Deep space" },
  { value: "planet", label: "Over a planet" },
  { value: "nebula", label: "Nebula" },
] as const satisfies readonly { value: OutsideId; label: string }[];

export const starfighterMeta = defineEffectMeta({
  id: "starfighter",
  name: "Starfighter Cockpit",
  description:
    "Seen from the nose of a single-seat starfighter, looking back at the pilot: the canopy frame arches overhead, a dome-headed droid looks about from its socket behind the seat, and the stars stream away behind the ship.",
  params: {
    droid: { kind: "color", label: "Droid colour", default: "#e0782c" },
    droidSide: { kind: "select", label: "Droid", options: DROID_SIDE_OPTIONS, default: "left" },
    outside: { kind: "select", label: "Outside", options: OUTSIDE_OPTIONS, default: "planet" },
    wingman: { kind: "boolean", label: "Wingman", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 4 },
  },
  category: "Scenes",
  tags: [
    "sci-fi",
    "pilot",
    "droid",
    "robot",
    "space battle",
    "fighter",
    "spaceship",
    "space travel",
  ],
  cost: "low",
  context: "webgl2",
});
