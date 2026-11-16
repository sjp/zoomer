import { describe, expect, it } from "vitest";
import { overlayKeyClashes, OVERLAY_METAS } from "../stream-overlay/overlay-params.meta";
import type { ParamSchema } from "../types";
import { GAMER_DEN_PARAMS, gamerdenMeta } from "./gamerden.meta";

describe("Gamer Den's params", () => {
  it("share no key with the stream overlays", () => {
    expect(overlayKeyClashes(GAMER_DEN_PARAMS)).toEqual([]);
  });

  it("include every overlay, each off by default", () => {
    const params: ParamSchema = gamerdenMeta.params;
    for (const meta of OVERLAY_METAS) {
      expect(params[meta.toggle]).toMatchObject({
        kind: "boolean",
        default: false,
      });
    }
    expect(Object.keys(params)).toEqual(
      expect.arrayContaining(["ovAccent", "ovOpacity", ...Object.keys(GAMER_DEN_PARAMS)]),
    );
  });
});
