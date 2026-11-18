import { defineEffectMeta } from "../types";

const COURSE_OPTIONS = [
  { value: "coast", label: "Coast" },
  { value: "sunset", label: "Sunset" },
  { value: "night", label: "Night city" },
] as const;

const LANE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const;

/** The speed slider's range: a share of the top cruising speed. */
export const MIN_SPEED = 0.2;
export const MAX_SPEED = 1;

/** The pixel slider's range: px per low-res pixel at 1080p. */
export const MIN_PIXEL = 1;
export const MAX_PIXEL = 4;

export const roadRacerMeta = defineEffectMeta({
  id: "roadracer",
  name: "Road Racer",
  description:
    "The view from behind a sports car in an old sprite-scaling arcade racer, cruising a winding coastal road: the road bends and crests hills, palms, huts and signs flick past, slower cars are eased past, and the hills behind slide sideways on the bends. Nobody's racing.",
  params: {
    course: { kind: "select", label: "Course", options: COURSE_OPTIONS, default: "coast" },
    speed: {
      kind: "number",
      label: "Speed",
      min: MIN_SPEED,
      max: MAX_SPEED,
      step: 0.05,
      default: 0.5,
    },
    lane: { kind: "select", label: "Lane", options: LANE_OPTIONS, default: "right" },
    hud: { kind: "boolean", label: "HUD", default: true },
    pixel: {
      kind: "number",
      label: "Pixel size",
      min: MIN_PIXEL,
      max: MAX_PIXEL,
      step: 1,
      default: 2,
    },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Retro", "Fun"],
  tags: [
    "racing",
    "driving",
    "road trip",
    "arcade racer",
    "outrun-style",
    "pseudo 3d",
    "80s",
    "retro gaming",
  ],
  cost: "low",
  context: "webgl2",
});
