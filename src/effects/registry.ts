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
import { blinds } from "./blinds";
import { frosted } from "./frosted";
import { city } from "./city";
import { dunes } from "./dunes";
import { nebula } from "./nebula";
import { ink } from "./ink";
import { reaction } from "./reaction";
import { terrain } from "./terrain";
import { leaves } from "./leaves";
import { horizon } from "./horizon";
import { silk } from "./silk";
import { film } from "./film";
import { ripples } from "./ripples";
import { lanterns } from "./lanterns";
import { dapple } from "./dapple";
import { glass } from "./glass";
import { smoke } from "./smoke";
import { sea } from "./sea";
import { bubbles } from "./bubbles";
import { beach } from "./beach";
import { ridges } from "./ridges";
import { startrails } from "./startrails";
import { candlelight } from "./candlelight";

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
  blinds,
  frosted,
  city,
  dunes,
  nebula,
  ink,
  reaction,
  terrain,
  leaves,
  horizon,
  silk,
  film,
  ripples,
  lanterns,
  dapple,
  glass,
  smoke,
  sea,
  bubbles,
  beach,
  ridges,
  startrails,
  candlelight,
];

export function getEffect(id: string | undefined): EffectDefinition | undefined {
  return effects.find((e) => e.id === id);
}
