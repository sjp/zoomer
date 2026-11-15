import { defineEffectMeta } from "../types";

type CoasterView = "side" | "ride";
export type CoasterTime = "day" | "sunset" | "night";
export type CoasterColour = "red" | "teal" | "yellow" | "purple";

const VIEW_OPTIONS = [
  { value: "side", label: "Side view" },
  { value: "ride", label: "Ride along" },
] as const satisfies readonly { value: CoasterView; label: string }[];

const TIME_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "sunset", label: "Sunset" },
  { value: "night", label: "Night" },
] as const satisfies readonly { value: CoasterTime; label: string }[];

const COLOUR_OPTIONS = [
  { value: "red", label: "Red" },
  { value: "teal", label: "Teal" },
  { value: "yellow", label: "Yellow" },
  { value: "purple", label: "Purple" },
] as const satisfies readonly { value: CoasterColour; label: string }[];

/** Longest train. */
export const MAX_CARS = 7;

export const rollercoasterMeta = defineEffectMeta({
  id: "rollercoaster",
  name: "Rollercoaster",
  description:
    "A steel coaster in a park: a train clanks up the lift hill, plunges down the drop, through a vertical loop and round the banked turns, with a Ferris wheel turning behind. Watch from the side or ride along in the front seat.",
  params: {
    view: { kind: "select", label: "View", options: VIEW_OPTIONS, default: "side" },
    time: { kind: "select", label: "Time of day", options: TIME_OPTIONS, default: "sunset" },
    colour: { kind: "select", label: "Track colour", options: COLOUR_OPTIONS, default: "red" },
    cars: { kind: "number", label: "Cars", min: 3, max: MAX_CARS, step: 1, default: 5 },
    speed: { kind: "number", label: "Speed", min: 0.1, max: 1, step: 0.05, default: 0.7 },
    lights: { kind: "boolean", label: "Track lights", default: true },
  },
  categories: ["Scenes", "Fun"],
  tags: [
    "theme park",
    "amusement park",
    "fairground",
    "thrill ride",
    "funfair",
    "summer",
    "carnival",
  ],
  cost: "low",
  context: "webgl2",
});
