import { streamOverlayParams } from "../stream-overlay/overlay-params.meta";
import { defineEffectMeta, type ParamSchema } from "../types";
import type { Genre } from "./monitorglow-schedule";

const GENRE_OPTIONS = [
  { value: "adventure", label: "Adventure" },
  { value: "shooter", label: "Shooter" },
  { value: "racing", label: "Racing" },
  { value: "horror", label: "Horror" },
  { value: "cosy", label: "Cosy" },
  { value: "film", label: "Film" },
] as const satisfies readonly { value: Genre; label: string }[];

/** The scene's own params, before the stream overlays'. */
export const MONITOR_GLOW_PARAMS = {
  genre: { kind: "select", label: "On screen", options: GENRE_OPTIONS, default: "adventure" },
  intensity: {
    kind: "number",
    label: "Screen brightness",
    min: 0.2,
    max: 1,
    step: 0.05,
    default: 0.7,
  },
  seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  wall: { kind: "color", label: "Wall", default: "#2c3646" },
  strip: { kind: "color", label: "Desk light strip", default: "#8a5cff" },
} as const satisfies ParamSchema;

export const monitorglowMeta = defineEffectMeta({
  id: "monitorglow",
  name: "Monitor Glow",
  description:
    "A dark bedroom wall at night, lit only by a big screen just out of shot: the light shifts with whatever is playing, from a long cool blue level to a warm burst, a green menu or a white loading screen.",
  params: {
    ...MONITOR_GLOW_PARAMS,
    ...streamOverlayParams(),
  },
  categories: ["Scenes", "Night", "Cosy"],
  tags: ["stream", "streamer", "gaming", "twitch", "monitor", "glow", "bedroom"],
  cost: "very low",
  context: "webgl2",
});
