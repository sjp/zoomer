import { auroraMeta } from "./aurora.meta";
import { beachMeta } from "./beach.meta";
import { blindsMeta } from "./blinds.meta";
import { blobsMeta } from "./blobs.meta";
import { bokehMeta } from "./bokeh.meta";
import { bubblesMeta } from "./bubbles.meta";
import { candlelightMeta } from "./candlelight.meta";
import { causticsMeta } from "./caustics.meta";
import { cityMeta } from "./city.meta";
import { cloudsMeta } from "./clouds.meta";
import { constellationMeta } from "./constellation.meta";
import { contoursMeta } from "./contours.meta";
import { dappleMeta } from "./dapple.meta";
import { daymapMeta } from "./daymap.meta";
import { dunesMeta } from "./dunes.meta";
import { filmMeta } from "./film.meta";
import { firefliesMeta } from "./fireflies.meta";
import { fireplaceMeta } from "./fireplace.meta";
import { flowfieldMeta } from "./flowfield.meta";
import { frostedMeta } from "./frosted.meta";
import { glassMeta } from "./glass.meta";
import { grassMeta } from "./grass.meta";
import { harmonographMeta } from "./harmonograph.meta";
import { horizonMeta } from "./horizon.meta";
import { hyperspaceMeta } from "./hyperspace.meta";
import { inkMeta } from "./ink.meta";
import { jellyfishMeta } from "./jellyfish.meta";
import { koiMeta } from "./koi.meta";
import { lanternsMeta } from "./lanterns.meta";
import { lavalampMeta } from "./lavalamp.meta";
import { leavesMeta } from "./leaves.meta";
import { nebulaMeta } from "./nebula.meta";
import { papercutMeta } from "./papercut.meta";
import { physarumMeta } from "./physarum.meta";
import { planetMeta } from "./planet.meta";
import { rainMeta } from "./rain.meta";
import { reactionMeta } from "./reaction.meta";
import { ridgesMeta } from "./ridges.meta";
import { ripplesMeta } from "./ripples.meta";
import { seaMeta } from "./sea.meta";
import { silkMeta } from "./silk.meta";
import { smokeMeta } from "./smoke.meta";
import { snowMeta } from "./snow.meta";
import { startrailsMeta } from "./startrails.meta";
import { synthwaveMeta } from "./synthwave.meta";
import { terrainMeta } from "./terrain.meta";
import { tunnelMeta } from "./tunnel.meta";
import { vinesMeta } from "./vines.meta";
import { warpMeta } from "./warp.meta";
import { windowRainMeta } from "./windowrain.meta";
import { zenMeta } from "./zen.meta";
import { createEffectLoader, type EffectEntry } from "./loader";

/**
 * Add new effects here; the UI picks them up automatically. Only the metadata is
 * bundled up front: each implementation is a separate chunk, imported on first use.
 */
export const effects: readonly EffectEntry[] = [
  { ...warpMeta, load: () => import("./warp").then((m) => m.warp) },
  { ...hyperspaceMeta, load: () => import("./hyperspace").then((m) => m.hyperspace) },
  { ...rainMeta, load: () => import("./rain").then((m) => m.rain) },
  { ...synthwaveMeta, load: () => import("./synthwave").then((m) => m.synthwave) },
  { ...bokehMeta, load: () => import("./bokeh").then((m) => m.bokeh) },
  { ...tunnelMeta, load: () => import("./tunnel").then((m) => m.tunnel) },
  { ...lavalampMeta, load: () => import("./lavalamp").then((m) => m.lavalamp) },
  { ...snowMeta, load: () => import("./snow").then((m) => m.snow) },
  { ...flowfieldMeta, load: () => import("./flowfield").then((m) => m.flowfield) },
  { ...blobsMeta, load: () => import("./blobs").then((m) => m.blobs) },
  { ...auroraMeta, load: () => import("./aurora").then((m) => m.aurora) },
  { ...contoursMeta, load: () => import("./contours").then((m) => m.contours) },
  { ...causticsMeta, load: () => import("./caustics").then((m) => m.caustics) },
  { ...windowRainMeta, load: () => import("./windowrain").then((m) => m.windowRain) },
  { ...firefliesMeta, load: () => import("./fireflies").then((m) => m.fireflies) },
  { ...constellationMeta, load: () => import("./constellation").then((m) => m.constellation) },
  { ...fireplaceMeta, load: () => import("./fireplace").then((m) => m.fireplace) },
  { ...cloudsMeta, load: () => import("./clouds").then((m) => m.clouds) },
  { ...blindsMeta, load: () => import("./blinds").then((m) => m.blinds) },
  { ...frostedMeta, load: () => import("./frosted").then((m) => m.frosted) },
  { ...cityMeta, load: () => import("./city").then((m) => m.city) },
  { ...dunesMeta, load: () => import("./dunes").then((m) => m.dunes) },
  { ...nebulaMeta, load: () => import("./nebula").then((m) => m.nebula) },
  { ...inkMeta, load: () => import("./ink").then((m) => m.ink) },
  { ...reactionMeta, load: () => import("./reaction").then((m) => m.reaction) },
  { ...terrainMeta, load: () => import("./terrain").then((m) => m.terrain) },
  { ...leavesMeta, load: () => import("./leaves").then((m) => m.leaves) },
  { ...horizonMeta, load: () => import("./horizon").then((m) => m.horizon) },
  { ...silkMeta, load: () => import("./silk").then((m) => m.silk) },
  { ...filmMeta, load: () => import("./film").then((m) => m.film) },
  { ...ripplesMeta, load: () => import("./ripples").then((m) => m.ripples) },
  { ...lanternsMeta, load: () => import("./lanterns").then((m) => m.lanterns) },
  { ...dappleMeta, load: () => import("./dapple").then((m) => m.dapple) },
  { ...glassMeta, load: () => import("./glass").then((m) => m.glass) },
  { ...smokeMeta, load: () => import("./smoke").then((m) => m.smoke) },
  { ...seaMeta, load: () => import("./sea").then((m) => m.sea) },
  { ...bubblesMeta, load: () => import("./bubbles").then((m) => m.bubbles) },
  { ...beachMeta, load: () => import("./beach").then((m) => m.beach) },
  { ...ridgesMeta, load: () => import("./ridges").then((m) => m.ridges) },
  { ...startrailsMeta, load: () => import("./startrails").then((m) => m.startrails) },
  { ...candlelightMeta, load: () => import("./candlelight").then((m) => m.candlelight) },
  { ...daymapMeta, load: () => import("./daymap").then((m) => m.daymap) },
  { ...harmonographMeta, load: () => import("./harmonograph").then((m) => m.harmonograph) },
  { ...jellyfishMeta, load: () => import("./jellyfish").then((m) => m.jellyfish) },
  { ...koiMeta, load: () => import("./koi").then((m) => m.koi) },
  { ...grassMeta, load: () => import("./grass").then((m) => m.grass) },
  { ...papercutMeta, load: () => import("./papercut").then((m) => m.papercut) },
  { ...vinesMeta, load: () => import("./vines").then((m) => m.vines) },
  { ...planetMeta, load: () => import("./planet").then((m) => m.planet) },
  { ...physarumMeta, load: () => import("./physarum").then((m) => m.physarum) },
  { ...zenMeta, load: () => import("./zen").then((m) => m.zen) },
];

/** Shares, caches and retries effect imports for the whole app. */
export const effectLoader = createEffectLoader();

export function getEffect(id: string | undefined): EffectEntry | undefined {
  return effects.find((e) => e.id === id);
}

/** The effect shown when the URL names none, or one that doesn't exist. */
export const DEFAULT_EFFECT_ID = "warp";

/** Resolves {@link DEFAULT_EFFECT_ID}; throws at load so a rename can't break it silently. */
export const defaultEffect: EffectEntry = (() => {
  const effect = getEffect(DEFAULT_EFFECT_ID);
  if (!effect) throw new Error(`Default effect "${DEFAULT_EFFECT_ID}" is not in the registry`);
  return effect;
})();
