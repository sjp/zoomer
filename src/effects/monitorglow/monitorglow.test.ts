import { describe, expect, it } from "vitest";
import { overlayKeyClashes, OVERLAY_METAS } from "../stream-overlay/overlay-params.meta";
import type { ParamSchema } from "../types";
import { MONITOR_GLOW_PARAMS, monitorglowMeta } from "./monitorglow.meta";

describe("Monitor Glow's params", () => {
  it("share no key with the stream overlays", () => {
    expect(overlayKeyClashes(MONITOR_GLOW_PARAMS)).toEqual([]);
  });

  it("include every overlay, each off by default", () => {
    const params: ParamSchema = monitorglowMeta.params;
    for (const meta of OVERLAY_METAS) {
      expect(params[meta.toggle]).toMatchObject({
        kind: "boolean",
        default: false,
      });
    }
    expect(Object.keys(params)).toEqual(
      expect.arrayContaining(["ovAccent", "ovOpacity", ...Object.keys(MONITOR_GLOW_PARAMS)]),
    );
  });
});
