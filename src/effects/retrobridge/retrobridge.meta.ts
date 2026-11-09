import { defineEffectMeta } from "../types";

type AlertMode = "normal" | "red";
export type Lighting = "classic" | "cool" | "warm";
type DoorSide = "right" | "left";

const ALERT_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "red", label: "Red alert" },
] as const satisfies readonly { value: AlertMode; label: string }[];

const LIGHTING_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "cool", label: "Cool" },
  { value: "warm", label: "Warm" },
] as const satisfies readonly { value: Lighting; label: string }[];

const DOOR_OPTIONS = [
  { value: "right", label: "Right" },
  { value: "left", label: "Left" },
] as const satisfies readonly { value: DoorSide; label: string }[];

export const retrobridgeMeta = defineEffectMeta({
  id: "retrobridge",
  name: "Retro Starship Bridge",
  description:
    "In the command chair of a 1960s TV starship: three black consoles with framed blocks of coloured lamp tiles and jewel buttons, each with a swivel chair and a large viewscreen above, a thick red padded railing, a red lift door, and bright, flat studio lighting.",
  params: {
    alert: { kind: "select", label: "Alert", options: ALERT_OPTIONS, default: "normal" },
    activity: { kind: "number", label: "Activity", min: 0, max: 1, step: 0.05, default: 0.5 },
    lighting: { kind: "select", label: "Lighting", options: LIGHTING_OPTIONS, default: "classic" },
    door: { kind: "select", label: "Lift door", options: DOOR_OPTIONS, default: "right" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["retro", "sci-fi", "starship", "1960s", "space", "captain", "spaceship", "command"],
  cost: "low",
  context: "webgl2",
});
