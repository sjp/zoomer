import { defineEffectMeta } from "../types";

export type JetTime = "day" | "dusk" | "night";

export const JET_TIME_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "dusk", label: "Dusk" },
  { value: "night", label: "Night" },
] as const satisfies readonly { value: JetTime; label: string }[];

export const jetcockpitMeta = defineEffectMeta({
  id: "jetcockpit",
  name: "Jet Cockpit",
  description:
    "Seen from the nose of a fighter jet, looking back at the pilot: the ejection seat's headrest and the canopy frame behind them, twin tail fins beyond, and a sea of cloud racing away below as the jet banks gently.",
  params: {
    time: { kind: "select", label: "Time", options: JET_TIME_OPTIONS, default: "day" },
    clouds: { kind: "number", label: "Cloud cover", min: 0, max: 1, step: 0.05, default: 0.7 },
    bank: { kind: "number", label: "Bank", min: 0, max: 1, step: 0.05, default: 0.5 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: ["aircraft", "pilot", "flying", "aviation", "clouds", "air force", "fighter", "sky"],
  cost: "low",
  context: "webgl2",
});
