import { defineEffectMeta } from "../types";

export type AlertId = "normal" | "yellow" | "red";
export type ExteriorId = "stars" | "planet" | "warp" | "off";
export type ShiftId = "day" | "night";
export type DisplaySide = "left" | "right";

export const ALERT_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "yellow", label: "Yellow alert" },
  { value: "red", label: "Red alert" },
] as const satisfies readonly { value: AlertId; label: string }[];

export const EXTERIOR_OPTIONS = [
  { value: "stars", label: "Stars" },
  { value: "planet", label: "Planet in orbit" },
  { value: "warp", label: "Warp" },
  { value: "off", label: "Off" },
] as const satisfies readonly { value: ExteriorId; label: string }[];

export type ShipId =
  | "cycle"
  | "none"
  | "borg"
  | "bird-of-prey"
  | "federation"
  | "warbird"
  | "marauder"
  | "galor"
  | "shuttle";

/** The ships after "cycle" and "none" are in `SHIP_KINDS` order. */
export const SHIP_OPTIONS = [
  { value: "cycle", label: "Cycle through all" },
  { value: "none", label: "None" },
  { value: "borg", label: "Borg cube" },
  { value: "bird-of-prey", label: "Bird-of-Prey" },
  { value: "federation", label: "Federation starship" },
  { value: "warbird", label: "Warbird" },
  { value: "marauder", label: "Marauder" },
  { value: "galor", label: "Galor" },
  { value: "shuttle", label: "Shuttlecraft" },
] as const satisfies readonly { value: ShipId; label: string }[];

export const SHIFT_OPTIONS = [
  { value: "day", label: "Day shift" },
  { value: "night", label: "Night shift" },
] as const satisfies readonly { value: ShiftId; label: string }[];

export const DISPLAY_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: DisplaySide; label: string }[];

export const bridgeMeta = defineEffectMeta({
  id: "bridge",
  name: "Starship Bridge",
  description:
    "The back of a starship bridge: a wooden rail in front of the aft stations, whose touch panels light up and tick over as the crew works.",
  params: {
    alert: { kind: "select", label: "Alert", options: ALERT_OPTIONS, default: "normal" },
    activity: { kind: "number", label: "Activity", min: 0, max: 1, step: 0.05, default: 0.4 },
    exterior: {
      kind: "select",
      label: "Outside view",
      options: EXTERIOR_OPTIONS,
      default: "stars",
    },
    ship: { kind: "select", label: "Visiting ship", options: SHIP_OPTIONS, default: "cycle" },
    shipStay: { kind: "boolean", label: "Ship stays once arrived", default: false },
    shipGap: {
      kind: "number",
      label: "Seconds between ships",
      min: 10,
      max: 600,
      step: 10,
      default: 240,
    },
    lighting: { kind: "select", label: "Lighting", options: SHIFT_OPTIONS, default: "day" },
    display: { kind: "select", label: "Display side", options: DISPLAY_OPTIONS, default: "left" },
    showTime: { kind: "boolean", label: "Show local time", default: true },
    showDate: { kind: "boolean", label: "Show local date", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 12 },
  },
  category: "Scenes",
  tags: ["sci-fi", "spaceship", "control room", "console", "command deck", "television", "future"],
  cost: "low",
  context: "webgl2",
});
