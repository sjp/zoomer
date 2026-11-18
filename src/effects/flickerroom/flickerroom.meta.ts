import { defineEffectMeta } from "../types";

const TINT_OPTIONS = [
  { value: "green", label: "Hospital green" },
  { value: "beige", label: "Office beige" },
  { value: "night", label: "Night" },
] as const;

export const flickerroomMeta = defineEffectMeta({
  id: "flickerroom",
  name: "Flicker Room",
  description:
    "An empty, run-down room of plastic chairs under buzzing ceiling tubes. One tube is failing: every so often it stutters off and on again, and each time it comes back something in the room is not quite where it was.",
  params: {
    interval: {
      kind: "number",
      label: "Seconds between flickers",
      min: 15,
      max: 120,
      step: 5,
      default: 40,
    },
    presence: {
      kind: "number",
      label: "Something in the corridor",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.3,
    },
    tint: { kind: "select", label: "Light", options: TINT_OPTIONS, default: "green" },
    hum: { kind: "number", label: "Tube hum", min: 0, max: 1, step: 0.05, default: 0.5 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Creepy", "Scenes", "Fun"],
  tags: [
    "liminal",
    "waiting room",
    "fluorescent",
    "horror",
    "spooky",
    "eerie",
    "uncanny",
    "halloween",
  ],
  cost: "very low",
  context: "webgl2",
});
