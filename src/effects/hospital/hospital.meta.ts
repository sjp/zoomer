import { defineEffectMeta } from "../types";

export type Lighting = "day" | "night";
export type MonitorSide = "left" | "right";

export const LIGHTING_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "night", label: "Night" },
] as const satisfies readonly { value: Lighting; label: string }[];

export const MONITOR_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: MonitorSide; label: string }[];

/** The care board's text: a few short handwritten lines. */
export const BOARD_MAX_LENGTH = 16;
export const BOARD_MAX_LINES = 4;

export const hospitalMeta = defineEffectMeta({
  id: "hospital",
  name: "Hospital Room",
  description:
    "Propped up in a hospital bed: a bedside monitor tracing your heartbeat, pulse and breathing, an IV bag dripping into its pump, a care board and an obs chart on the wall, a clock, and the privacy curtain drawn back.",
  params: {
    lighting: { kind: "select", label: "Lighting", options: LIGHTING_OPTIONS, default: "day" },
    heartRate: {
      kind: "number",
      label: "Heart rate (bpm)",
      min: 40,
      max: 140,
      step: 1,
      default: 72,
    },
    board: {
      kind: "text",
      label: "Care board",
      default: "Room 7\nNurse: Alex\nRest + fluids\nGet well soon!",
      maxLength: BOARD_MAX_LENGTH,
      maxLines: BOARD_MAX_LINES,
    },
    monitor: { kind: "select", label: "Monitor", options: MONITOR_OPTIONS, default: "left" },
    clock: { kind: "boolean", label: "Wall clock (local time)", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["medical", "ward", "patient", "ecg", "heart", "sick", "nurse", "doctor", "drip"],
  cost: "low",
  context: "webgl2",
});
