import { describe, expect, expectTypeOf, it } from "vitest";
import { RESERVED_KEYS, sanitizeText } from "../params";
import { effects } from "../registry";
import { defineEffectMeta, type ParamSchema, type ParamValues } from "../types";
import { parseClockTime } from "./clock-time";
import {
  CLOCK_TIME_HINT,
  OVERLAY_ACCENT_KEY,
  OVERLAY_METAS,
  OVERLAY_OPACITY_KEY,
  type OverlayToggleDefaults,
  OVERLAYS_GROUP,
  overlayKeyClashes,
  streamOverlayParams,
} from "./overlay-params.meta";
import {
  OVERLAY_SIDE_OPTIONS,
  type OverlayMeta,
  type OverlaySide,
  type OverlaySlot,
} from "./overlay-types.meta";

const side = (label: string, def: OverlaySide) =>
  ({
    kind: "select",
    label: "Side",
    group: label,
    options: OVERLAY_SIDE_OPTIONS,
    default: def,
  }) as const;

/** Stand-ins shaped like the planned overlays: two columns, the top band, a border and the edges. */
const PLANNED: readonly OverlayMeta[] = [
  {
    id: "splits",
    toggle: "ovSplits",
    label: "Splits",
    slots: ["column"],
    sideKey: "splitsSide",
    params: {
      splitsSide: side("Splits", "right"),
      splitsTitle: {
        kind: "text",
        label: "Title",
        group: "Splits",
        default: "Speedrun",
        maxLength: 28,
        maxLines: 2,
      },
    },
  },
  {
    id: "chat",
    toggle: "ovChat",
    label: "Chat",
    slots: ["column"],
    sideKey: "chatSide",
    params: { chatSide: side("Chat", "left") },
  },
  {
    id: "frame",
    toggle: "ovFrame",
    label: "Frame",
    slots: ["border", "topLeft", "topRight"],
    params: { ticker: { kind: "boolean", label: "Ticker", group: "Frame", default: true } },
  },
  {
    id: "alerts",
    toggle: "ovAlerts",
    label: "Alerts",
    slots: ["topCentre"],
    params: {
      alertEvery: {
        kind: "number",
        label: "Every (s)",
        group: "Alerts",
        min: 20,
        max: 300,
        step: 5,
        default: 60,
      },
    },
  },
  {
    id: "emotes",
    toggle: "ovEmotes",
    label: "Emotes",
    slots: ["edges"],
    params: {
      emoteRate: {
        kind: "number",
        label: "Rate",
        group: "Emotes",
        min: 0,
        max: 1,
        step: 0.05,
        default: 0.3,
      },
    },
  },
];

describe("streamOverlayParams", () => {
  it("puts the toggles, accent and opacity in the Overlays group, then each overlay's own", () => {
    const defaults: OverlayToggleDefaults = { ovChat: true, ovFrame: true };
    const schema = streamOverlayParams(defaults, PLANNED);
    expect(Object.keys(schema)).toEqual([
      "ovSplits",
      "ovChat",
      "ovFrame",
      "ovAlerts",
      "ovEmotes",
      OVERLAY_ACCENT_KEY,
      OVERLAY_OPACITY_KEY,
      "splitsSide",
      "splitsTitle",
      "chatSide",
      "ticker",
      "alertEvery",
      "emoteRate",
    ]);
    const overlays = Object.entries(schema).filter(([, d]) => d.group === OVERLAYS_GROUP);
    expect(overlays.map(([k]) => k)).toEqual(Object.keys(schema).slice(0, 7));
    expect(schema.ovChat).toMatchObject({ kind: "boolean", label: "Chat", default: true });
    expect(schema.ovFrame).toMatchObject({ default: true });
    expect(schema.ovSplits).toMatchObject({ default: false });
    expect(schema[OVERLAY_OPACITY_KEY]).toMatchObject({
      kind: "number",
      min: 0.4,
      max: 1,
      default: 0.85,
    });
    expect(schema[OVERLAY_ACCENT_KEY]).toMatchObject({ kind: "color" });
  });

  it("gives the accent and opacity even with no overlays registered", () => {
    expect(Object.keys(streamOverlayParams({}, []))).toEqual([
      OVERLAY_ACCENT_KEY,
      OVERLAY_OPACITY_KEY,
    ]);
  });

  it("uses the registry by default", () => {
    expect(Object.keys(streamOverlayParams())).toEqual(
      Object.keys(streamOverlayParams({}, OVERLAY_METAS)),
    );
  });

  it("rejects a default for a toggle no overlay has", () => {
    expect(() => streamOverlayParams({ ovChatt: true }, PLANNED)).toThrow(/ovChatt/);
  });

  it("rejects a key used twice", () => {
    const twice: OverlayMeta = { ...PLANNED[3], id: "again", toggle: "ovAgain" };
    expect(() => streamOverlayParams({}, [...PLANNED, twice])).toThrow(/alertEvery/);
    const shadow: OverlayMeta = {
      ...PLANNED[3],
      params: { ovAccent: PLANNED[3].params.alertEvery },
    };
    expect(() => streamOverlayParams({}, [shadow])).toThrow(/ovAccent/);
  });

  it("needs a side select exactly for column overlays", () => {
    const { sideKey: _, ...noSide } = PLANNED[1];
    expect(() => streamOverlayParams({}, [noSide])).toThrow(/side select/);
    const wrongKind: OverlayMeta = {
      ...PLANNED[1],
      params: { chatSide: { kind: "boolean", label: "Side", group: "Chat", default: true } },
    };
    expect(() => streamOverlayParams({}, [wrongKind])).toThrow(/side select/);
    const extra: OverlayMeta = { ...PLANNED[3], sideKey: "alertEvery" };
    expect(() => streamOverlayParams({}, [extra])).toThrow(/side select/);
  });

  it("has keys that can't clash with the app's own hash keys", () => {
    const keys = Object.keys(streamOverlayParams({}, PLANNED));
    expect(keys.filter((k) => RESERVED_KEYS.includes(k))).toEqual([]);
  });

  it("spreads into a scene's params with their types intact", () => {
    const meta = defineEffectMeta({
      id: "scene",
      name: "Scene",
      description: "A scene.",
      categories: ["Scenes"],
      tags: [],
      context: "webgl2",
      params: {
        genre: {
          kind: "select",
          label: "Genre",
          options: [{ value: "a", label: "A" }],
          default: "a",
        },
        intensity: { kind: "number", label: "Intensity", min: 0, max: 1, step: 0.1, default: 0.5 },
        ...streamOverlayParams({}, PLANNED),
      },
    });
    type V = ParamValues<typeof meta.params>;
    expectTypeOf<V["genre"]>().toEqualTypeOf<string>();
    expectTypeOf<V["intensity"]>().toEqualTypeOf<number>();
    expect(Object.keys(meta.params)).toContain("ovChat");
  });
});

describe("overlayKeyClashes", () => {
  it("finds a scene key the overlays also use", () => {
    const own: ParamSchema = {
      accent: { kind: "color", label: "Accent", default: "#ffffff" },
      ticker: { kind: "boolean", label: "Ticker", default: false },
      ovChat: { kind: "boolean", label: "Chat", default: false },
    };
    expect(overlayKeyClashes(own, PLANNED)).toEqual(["ticker", "ovChat"]);
    expect(overlayKeyClashes({ accent: own.accent }, PLANNED)).toEqual([]);
  });
});

describe("the registry", () => {
  const schema = streamOverlayParams();

  it("has unique ids and toggles", () => {
    expect(new Set(OVERLAY_METAS.map((m) => m.id)).size).toBe(OVERLAY_METAS.length);
    expect(new Set(OVERLAY_METAS.map((m) => m.toggle)).size).toBe(OVERLAY_METAS.length);
  });

  it.each(OVERLAY_METAS.map((m) => [m.id, m] as const))(
    "%s has an ov toggle, grouped options and a slot of its own",
    (_, meta) => {
      expect(meta.toggle).toMatch(/^ov[A-Z]\w*$/);
      for (const def of Object.values(meta.params)) {
        expect(def.group).toBeTruthy();
        expect(def.group).not.toBe(OVERLAYS_GROUP);
      }
      for (const def of Object.values(meta.params).filter((d) => d.kind === "text")) {
        expect(sanitizeText(def, def.default)).toBe(def.default);
      }
      const own: OverlaySlot[] = meta.slots.filter((slot) => slot !== "column");
      for (const slot of own) {
        expect(OVERLAY_METAS.filter((m) => m.slots.includes(slot)).map((m) => m.id)).toEqual([
          meta.id,
        ]);
      }
    },
  );

  // Every scene that spreads the overlay params in, spread them last and whole: a
  // scene key that shadowed one would show up as a changed definition here.
  it("is carried unchanged by every scene that uses it", () => {
    const changed: string[] = [];
    for (const effect of effects.filter((e) => Object.hasOwn(e.params, OVERLAY_ACCENT_KEY))) {
      for (const [key, def] of Object.entries(schema)) {
        // Toggle defaults are each scene's own choice.
        const theirs: unknown =
          def.kind === "boolean" && def.group === OVERLAYS_GROUP
            ? { ...effect.params[key], default: def.default }
            : effect.params[key];
        if (JSON.stringify(theirs) !== JSON.stringify(def)) {
          changed.push(`${effect.id}.${key}`);
        }
      }
    }
    expect(changed).toEqual([]);
  });
});

describe("CLOCK_TIME_HINT", () => {
  it("gives examples that parse", () => {
    const examples = CLOCK_TIME_HINT.match(/\d{1,2}:\d{2}(?:\s?[ap]m)?/gi) ?? [];
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const e of examples) {
      expect([e, parseClockTime(e)]).not.toEqual([e, null]);
    }
  });
});
