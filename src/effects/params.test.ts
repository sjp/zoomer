import { describe, expect, it } from "vitest";
import { coerce, decodeHash, encodeHash, parseValues, snap } from "./params";
import { effects } from "./registry";
import type { ParamDef, ParamSchema } from "./types";

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

  it("snaps numbers to the slider's step", () => {
    const count = {
      kind: "number",
      label: "Count",
      min: 50,
      max: 400,
      step: 10,
      default: 140,
    } as const;
    expect(coerce(count, "150.5")).toBe(150);
    expect(coerce(count, "156")).toBe(160);
    expect(coerce(count, "401")).toBe(400);
    expect(coerce(schema.speed, "0.3")).toBe(0.3);
    expect(coerce(schema.speed, "0.34")).toBe(0.3);
    expect(coerce(schema.speed, "7.77")).toBe(7.8);
  });

  it("stays on the grid below an off-grid max, like a range input", () => {
    const def = { kind: "number", label: "X", min: 0, max: 1, step: 0.4, default: 0 } as const;
    expect(snap(def, 0.5)).toBe(0.4);
    expect(snap(def, 1)).toBe(0.8);
    expect(snap(def, -3)).toBe(0);
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
  it("has unique ids", () => {
    const ids = effects.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(effects.map((e) => [e.id, e] as const))(
    "%s has a name, description and params",
    (_, e) => {
      expect(e.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(e.name.trim()).not.toBe("");
      expect(e.description.trim()).not.toBe("");
      expect(Object.keys(e.params).length).toBeGreaterThan(0);
    },
  );

  const params = effects.flatMap((e) =>
    Object.entries(e.params).map(([key, def]): [string, ParamDef] => [`${e.id}.${key}`, def]),
  );
  const ofKind = <K extends ParamDef["kind"]>(kind: K) =>
    params.flatMap(([where, def]): [string, Extract<ParamDef, { kind: K }>][] =>
      def.kind === kind ? [[where, def as Extract<ParamDef, { kind: K }>]] : [],
    );

  it.each(params)("%s has a label", (_, def) => {
    expect(def.label.trim()).not.toBe("");
  });

  it.each(ofKind("number"))("%s has a valid range with the default on its grid", (_, def) => {
    expect(def.min).toBeLessThan(def.max);
    expect(def.step).toBeGreaterThan(0);
    expect(def.default).toBeGreaterThanOrEqual(def.min);
    expect(def.default).toBeLessThanOrEqual(def.max);
    // On the step grid, so a default survives a URL round trip unchanged.
    expect(snap(def, def.default)).toBe(def.default);
    expect(coerce(def, String(def.default))).toBe(def.default);
  });

  it.each(ofKind("color"))("%s defaults to a lower-case six-digit hex colour", (_, def) => {
    expect(def.default).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(ofKind("select"))("%s defaults to one of its distinct, labelled options", (_, def) => {
    const values = def.options.map((o) => o.value);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain(def.default);
    expect(def.options.every((o) => o.label.trim() !== "")).toBe(true);
  });

  it.each(ofKind("boolean"))("%s defaults to a boolean", (_, def) => {
    expect(typeof def.default).toBe("boolean");
  });
});
