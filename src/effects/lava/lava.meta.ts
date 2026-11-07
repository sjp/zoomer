import type { CameraName, SkyName } from "./lava-sim";
import { defineEffectMeta } from "../types";

export const SKY_OPTIONS = [
  { value: "night", label: "Night" },
  { value: "dusk", label: "Dusk" },
  { value: "smoky", label: "Smoky" },
] as const satisfies readonly { value: SkyName; label: string }[];

export const CAMERA_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
] as const satisfies readonly { value: CameraName; label: string }[];

export const lavaMeta = defineEffectMeta({
  id: "lava",
  name: "Lava Field at Night",
  description:
    "A plain of cooled black crust crazed with glowing orange seams that slowly breathe, heat haze over the hottest cracks and a red glow on low smoke at the horizon.",
  params: {
    heat: { kind: "number", label: "Heat", min: 0, max: 1, step: 0.01, default: 0.7 },
    pulse: { kind: "number", label: "Breathing speed", min: 0, max: 2, step: 0.05, default: 1 },
    haze: { kind: "number", label: "Heat haze", min: 0, max: 1, step: 0.01, default: 0.4 },
    sky: { kind: "select", label: "Sky", options: SKY_OPTIONS, default: "night" },
    camera: { kind: "select", label: "Camera", options: CAMERA_OPTIONS, default: "low" },
  },
  category: "Nature",
  tags: ["volcano", "magma", "volcanic", "embers", "glow", "iceland", "hawaii", "warm"],
  cost: "low",
  context: "webgl2",
});
