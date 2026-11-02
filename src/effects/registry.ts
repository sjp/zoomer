import { bokeh } from "./bokeh";
import { hyperspace } from "./hyperspace";
import { rain } from "./rain";
import { synthwave } from "./synthwave";
import { tunnel } from "./tunnel";
import type { EffectDefinition } from "./types";
import { warp } from "./warp";
import { lavalamp } from "./lavalamp";
import { snow } from "./snow";
import { flowfield } from "./flowfield";
import { blobs } from "./blobs";
import { aurora } from "./aurora";
import { contours } from "./contours";
import { caustics } from "./caustics";
import { windowRain } from "./windowrain";
import { fireflies } from "./fireflies";
import { constellation } from "./constellation";
import { fireplace } from "./fireplace";
import { clouds } from "./clouds";

/** Add new effects here; the UI picks them up automatically. */
export const effects: readonly EffectDefinition[] = [
  warp,
  hyperspace,
  rain,
  synthwave,
  bokeh,
  tunnel,
  lavalamp,
  snow,
  flowfield,
  blobs,
  aurora,
  contours,
  caustics,
  windowRain,
  fireflies,
  constellation,
  fireplace,
  clouds,
];

export function getEffect(id: string | undefined): EffectDefinition | undefined {
  return effects.find((e) => e.id === id);
}
