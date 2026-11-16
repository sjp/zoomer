import { describe, expect, it } from "vitest";
import { overlayKeyClashes, OVERLAY_METAS } from "../stream-overlay/overlay-params.meta";
import { CLOCK_TIME_HINT } from "../stream-overlay/overlay-types.meta";
import type { ParamSchema } from "../types";
import { STARTING_SOON_PARAMS, startingsoonMeta } from "./startingsoon.meta";

describe("Starting Soon's params", () => {
  it("share no key with the stream overlays", () => {
    expect(overlayKeyClashes(STARTING_SOON_PARAMS)).toEqual([]);
  });

  it("include every overlay, with only chat and the frame on by default", () => {
    const params: ParamSchema = startingsoonMeta.params;
    const on = OVERLAY_METAS.filter((m) => params[m.toggle].default === true).map((m) => m.toggle);
    expect(on).toEqual(["ovChat", "ovFrame"]);
    for (const meta of OVERLAY_METAS) {
      expect(params[meta.toggle].kind).toBe("boolean");
    }
    expect(Object.keys(params)).toEqual(
      expect.arrayContaining(["ovAccent", "ovOpacity", ...Object.keys(STARTING_SOON_PARAMS)]),
    );
  });

  it("explain the time format and the fallback in the Until label", () => {
    expect(STARTING_SOON_PARAMS.endsAt.label).toContain(CLOCK_TIME_HINT);
  });
});
