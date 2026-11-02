import { describe, expect, it } from "vitest";
import { coerce, decodeHash, encodeHash, parseValues } from "./params";
import { effects } from "./registry";
import type { ParamSchema } from "./types";

const schema = {
  speed: { kind: "number", label: "Speed", min: 0, max: 10, step: 0.1, default: 3 },
  color: { kind: "color", label: "Colour", default: "#ffffff" },
  on: { kind: "boolean", label: "On", default: true },
  mode: {
    kind: "select",
    label: "Mode",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    default: "a",
  },
} satisfies ParamSchema;

describe("coerce", () => {
  it("clamps numbers and rejects junk", () => {
    expect(coerce(schema.speed, "50")).toBe(10);
    expect(coerce(schema.speed, "abc")).toBeUndefined();
    expect(coerce(schema.speed, "")).toBeUndefined();
  });

  it("accepts colours with or without #", () => {
    expect(coerce(schema.color, "FF0000")).toBe("#ff0000");
    expect(coerce(schema.color, "#00ff00")).toBe("#00ff00");
    expect(coerce(schema.color, "red")).toBeUndefined();
  });

  it("parses booleans and select options", () => {
    expect(coerce(schema.on, "0")).toBe(false);
    expect(coerce(schema.mode, "b")).toBe("b");
    expect(coerce(schema.mode, "z")).toBeUndefined();
  });
});

describe("hash round trip", () => {
  it("only encodes non-default values and decodes them back", () => {
    const effect = { ...effects[0], params: schema };
    const values = { speed: 5, color: "#ff0000", on: true, mode: "b" };
    const hash = encodeHash(effect, values);
    expect(hash).toBe(`#effect=${effect.id}&speed=5&color=ff0000&mode=b`);

    const { effectId, raw } = decodeHash(hash);
    expect(effectId).toBe(effect.id);
    expect(parseValues(schema, raw)).toEqual(values);
  });
});

describe("registry", () => {
  it("has unique ids and valid defaults", () => {
    const ids = effects.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const numbers = effects.flatMap((e) =>
      Object.values(e.params).filter((def) => def.kind === "number"),
    );
    for (const def of numbers) {
      expect(def.default).toBeGreaterThanOrEqual(def.min);
      expect(def.default).toBeLessThanOrEqual(def.max);
    }
  });
});
