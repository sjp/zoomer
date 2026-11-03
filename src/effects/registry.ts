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
 *
 * The order is the list's hand-picked "Featured" sort, so place a new effect where
 * it fits rather than always at the end. The default effect stays first.
 */
export const effects: readonly EffectEntry[] = [
  { ...warpMeta, load: () => import("./warp").then((m) => m.warp) },
  { ...auroraMeta, load: () => import("./aurora").then((m) => m.aurora) },
  { ...fireplaceMeta, load: () => import("./fireplace").then((m) => m.fireplace) },
  { ...synthwaveMeta, load: () => import("./synthwave").then((m) => m.synthwave) },
  { ...cloudsMeta, load: () => import("./clouds").then((m) => m.clouds) },
  { ...seaMeta, load: () => import("./sea").then((m) => m.sea) },
  { ...blobsMeta, load: () => import("./blobs").then((m) => m.blobs) },
  { ...startrailsMeta, load: () => import("./startrails").then((m) => m.startrails) },
  { ...windowRainMeta, load: () => import("./windowrain").then((m) => m.windowRain) },
  { ...nebulaMeta, load: () => import("./nebula").then((m) => m.nebula) },
  { ...dappleMeta, load: () => import("./dapple").then((m) => m.dapple) },
  { ...koiMeta, load: () => import("./koi").then((m) => m.koi) },
  { ...lanternsMeta, load: () => import("./lanterns").then((m) => m.lanterns) },
  { ...horizonMeta, load: () => import("./horizon").then((m) => m.horizon) },
  { ...causticsMeta, load: () => import("./caustics").then((m) => m.caustics) },
  { ...cityMeta, load: () => import("./city").then((m) => m.city) },
  { ...jellyfishMeta, load: () => import("./jellyfish").then((m) => m.jellyfish) },
  { ...leavesMeta, load: () => import("./leaves").then((m) => m.leaves) },
  { ...blindsMeta, load: () => import("./blinds").then((m) => m.blinds) },
  { ...planetMeta, load: () => import("./planet").then((m) => m.planet) },
  { ...filmMeta, load: () => import("./film").then((m) => m.film) },
  { ...ridgesMeta, load: () => import("./ridges").then((m) => m.ridges) },
  { ...candlelightMeta, load: () => import("./candlelight").then((m) => m.candlelight) },
  { ...snowMeta, load: () => import("./snow").then((m) => m.snow) },
  { ...bokehMeta, load: () => import("./bokeh").then((m) => m.bokeh) },
  { ...inkMeta, load: () => import("./ink").then((m) => m.ink) },
  { ...grassMeta, load: () => import("./grass").then((m) => m.grass) },
  { ...hyperspaceMeta, load: () => import("./hyperspace").then((m) => m.hyperspace) },
  { ...zenMeta, load: () => import("./zen").then((m) => m.zen) },
  { ...frostedMeta, load: () => import("./frosted").then((m) => m.frosted) },
  { ...dunesMeta, load: () => import("./dunes").then((m) => m.dunes) },
  { ...rainMeta, load: () => import("./rain").then((m) => m.rain) },
  { ...papercutMeta, load: () => import("./papercut").then((m) => m.papercut) },
  { ...silkMeta, load: () => import("./silk").then((m) => m.silk) },
  { ...physarumMeta, load: () => import("./physarum").then((m) => m.physarum) },
  { ...beachMeta, load: () => import("./beach").then((m) => m.beach) },
  { ...tunnelMeta, load: () => import("./tunnel").then((m) => m.tunnel) },
  { ...glassMeta, load: () => import("./glass").then((m) => m.glass) },
  { ...smokeMeta, load: () => import("./smoke").then((m) => m.smoke) },
  { ...daymapMeta, load: () => import("./daymap").then((m) => m.daymap) },
  { ...lavalampMeta, load: () => import("./lavalamp").then((m) => m.lavalamp) },
  { ...reactionMeta, load: () => import("./reaction").then((m) => m.reaction) },
  { ...firefliesMeta, load: () => import("./fireflies").then((m) => m.fireflies) },
  { ...harmonographMeta, load: () => import("./harmonograph").then((m) => m.harmonograph) },
  { ...ripplesMeta, load: () => import("./ripples").then((m) => m.ripples) },
  { ...flowfieldMeta, load: () => import("./flowfield").then((m) => m.flowfield) },
  { ...bubblesMeta, load: () => import("./bubbles").then((m) => m.bubbles) },
  { ...terrainMeta, load: () => import("./terrain").then((m) => m.terrain) },
  { ...vinesMeta, load: () => import("./vines").then((m) => m.vines) },
  { ...contoursMeta, load: () => import("./contours").then((m) => m.contours) },
  { ...constellationMeta, load: () => import("./constellation").then((m) => m.constellation) },
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
