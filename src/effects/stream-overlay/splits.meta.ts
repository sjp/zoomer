/**
 * The speedrun splits overlay's metadata: a timer panel in a side column
 * with the viewer's own split names and, optionally, comparison times.
 */
import { OVERLAY_SIDE_OPTIONS, type OverlayMeta } from "./overlay-types.meta";

/** The splits shown until the viewer types their own: generic, no real game. */
const DEFAULT_SPLITS = ["Tutorial", "Forest", "Boss 1", "Caves", "Castle", "Final Boss"];

export const splitsMeta: OverlayMeta = {
  id: "splits",
  toggle: "ovSplits",
  label: "Splits",
  slots: ["column"],
  sideKey: "splitsSide",
  params: {
    splitsTitle: {
      kind: "text",
      label: "Title",
      group: "Splits",
      default: "Speedrun\nAny%",
      maxLength: 28,
      maxLines: 2,
    },
    splitsList: {
      kind: "text",
      label: "Splits, one per line (add a time like 4:32 after two spaces)",
      group: "Splits",
      default: DEFAULT_SPLITS.join("\n"),
      maxLength: 32,
      maxLines: 20,
    },
    splitsSide: {
      kind: "select",
      label: "Side",
      group: "Splits",
      options: OVERLAY_SIDE_OPTIONS,
      default: "right",
    },
    splitsLength: {
      kind: "number",
      label: "Run length (minutes)",
      group: "Splits",
      min: 1,
      max: 30,
      step: 1,
      default: 5,
    },
    splitsLuck: {
      kind: "number",
      label: "Luck",
      group: "Splits",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
    },
  },
};
