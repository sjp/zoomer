import { describe, expect, it } from "vitest";
import { defaults, encodeHash, stateFromHash } from "./params";
import { defaultEffect, effects } from "./registry";

describe.each(effects.map((e) => [e.id, e] as const))("%s", (_, entry) => {
  it("loads an implementation that matches its metadata", async () => {
    const effect = await entry.load();
    expect(effect.id).toBe(entry.id);
    expect(effect.name).toBe(entry.name);
    expect(effect.description).toBe(entry.description);
    expect(effect.context).toBe(entry.context);
    expect(effect.params).toBe(entry.params);
    expect(typeof effect.create).toBe("function");
  });

  it("round-trips through the URL hash using metadata only", () => {
    const values = defaults(entry.params);
    const state = stateFromHash(encodeHash(entry, values), effects, defaultEffect);
    expect(state.effect).toBe(entry);
    expect(state.values).toEqual(values);
  });
});
