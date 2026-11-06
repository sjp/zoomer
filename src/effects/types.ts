/**
 * Effects are plain TypeScript canvas renderers (2D or WebGL2) with no React dependency.
 * Each effect declares a parameter schema; the UI builds its controls from that
 * schema and the URL hash stores the values.
 */

export interface NumberParam {
  kind: "number";
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface ColorParam {
  kind: "color";
  label: string;
  default: string;
}

export interface BooleanParam {
  kind: "boolean";
  label: string;
  default: boolean;
}

export interface SelectParam {
  kind: "select";
  label: string;
  options: readonly { value: string; label: string }[];
  default: string;
}

/**
 * Free text the effect shows, such as a name or a status. The value is one string
 * with `\n` between lines, kept sanitised by `sanitizeText` in `params.ts`: NFC,
 * no control or bidi characters, no emoji, at most `maxLines` lines of at most
 * `maxLength` code points each (longer lines are truncated, not wrapped).
 */
export interface TextParam {
  kind: "text";
  label: string;
  default: string;
  /** Code points per line. */
  maxLength: number;
  maxLines: number;
}

export type ParamDef = NumberParam | ColorParam | BooleanParam | SelectParam | TextParam;
export type ParamSchema = Record<string, ParamDef>;
export type ParamValue = number | string | boolean;
export type AnyParamValues = Record<string, ParamValue>;

type ValueOf<D extends ParamDef> = D extends NumberParam
  ? number
  : D extends BooleanParam
    ? boolean
    : string;

export type ParamValues<S extends ParamSchema> = { [K in keyof S]: ValueOf<S[K]> };

export interface Viewport {
  /** Canvas size in device pixels. */
  width: number;
  height: number;
  /**
   * Device pixels per reference unit, where the reference is a 1080px-tall frame.
   * Multiply sizes by this so output looks the same at any resolution.
   */
  scale: number;
}

export interface EffectInstance<V> {
  resize: (viewport: Viewport) => void;
  /**
   * Draws one frame. `dt` is seconds since the previous frame, clamped by the host to [0, 0.1].
   *
   * Declared as a method on purpose: method parameters are bivariant, which lets an
   * effect for a specific schema be stored as a plain `EffectDefinition`. The host
   * only ever passes values parsed from that same effect's own `params`.
   */
  // oxlint-disable-next-line typescript/method-signature-style -- bivariance is needed to erase the schema type, see above
  frame(dt: number, params: V): void;
  /**
   * Releases resources such as GPU buffers, textures and programs. Called when the
   * effect changes or the canvas unmounts. Not called after a lost WebGL context,
   * since the context's resources are already gone.
   */
  dispose?: () => void;
}

/** Rendering context types an effect can draw with, keyed by `getContext` name. */
export interface ContextMap {
  "2d": CanvasRenderingContext2D;
  webgl2: WebGL2RenderingContext;
}
export type ContextKind = keyof ContextMap;

/**
 * The categories the effect list groups by, in display order. Add one only when
 * several effects need it.
 */
export const EFFECT_CATEGORIES = [
  "Space",
  "Sky & weather",
  "Water",
  "Nature",
  "Cosy",
  "Abstract",
  "Science",
  "Retro",
] as const;
export type EffectCategory = (typeof EFFECT_CATEGORIES)[number];

/**
 * Rough GPU cost at 4K with default params, lightest first, for the "Lightest first"
 * sort, judged from the effect's per-pixel work.
 */
export const EFFECT_COSTS = ["very low", "low", "medium"] as const;
export type EffectCost = (typeof EFFECT_COSTS)[number];

/**
 * What the app knows about an effect before its code loads: enough to list it, build
 * its controls and read its params from the URL. Lives in `<id>.meta.ts`, which the
 * entry chunk imports, so it must not import the implementation or any GL helper.
 */
interface EffectMetaBase<S extends ParamSchema> {
  id: string;
  name: string;
  description: string;
  category: EffectCategory;
  /**
   * A few lowercase search words that aren't already in the name or description,
   * such as "stars" and "sci-fi" for Warp Speed.
   */
  tags: readonly string[];
  cost?: EffectCost;
  params: S;
}

export interface EffectMeta2D<S extends ParamSchema = ParamSchema> extends EffectMetaBase<S> {
  /** Defaults to "2d". */
  context?: "2d";
}

export interface EffectMetaWebGL2<S extends ParamSchema = ParamSchema> extends EffectMetaBase<S> {
  context: "webgl2";
}

export type EffectMeta<S extends ParamSchema = ParamSchema> = EffectMeta2D<S> | EffectMetaWebGL2<S>;

export interface Effect2D<S extends ParamSchema = ParamSchema> extends EffectMeta2D<S> {
  create: (ctx: CanvasRenderingContext2D) => EffectInstance<ParamValues<S>>;
}

export interface EffectWebGL2<S extends ParamSchema = ParamSchema> extends EffectMetaWebGL2<S> {
  /**
   * Called again with the same context after it is lost and restored, so build all
   * GPU resources here. GL state persists across effects sharing a canvas, so set
   * every piece of state you rely on rather than assuming defaults.
   */
  create: (gl: WebGL2RenderingContext) => EffectInstance<ParamValues<S>>;
}

/** A loaded effect: its metadata plus the `create` from its implementation module. */
export type EffectDefinition<S extends ParamSchema = ParamSchema> = Effect2D<S> | EffectWebGL2<S>;

export function contextKind(effect: EffectMeta): ContextKind {
  return effect.context ?? "2d";
}

/** Identity helper that keeps the literal param schema, for {@link defineEffect}. */
export function defineEffectMeta<const S extends ParamSchema>(
  meta: EffectMeta2D<S>,
): EffectMeta2D<S>;
export function defineEffectMeta<const S extends ParamSchema>(
  meta: EffectMetaWebGL2<S>,
): EffectMetaWebGL2<S>;
export function defineEffectMeta<const S extends ParamSchema>(meta: EffectMeta<S>) {
  return meta;
}

/**
 * Joins an effect's metadata with its `create`. The param value types `frame` sees
 * come from the metadata's schema, so a schema change is a type error in `create`.
 */
export function defineEffect<S extends ParamSchema>(
  meta: EffectMeta2D<S>,
  impl: Pick<Effect2D<S>, "create">,
): Effect2D<S>;
export function defineEffect<S extends ParamSchema>(
  meta: EffectMetaWebGL2<S>,
  impl: Pick<EffectWebGL2<S>, "create">,
): EffectWebGL2<S>;
export function defineEffect<S extends ParamSchema>(
  meta: EffectMeta<S>,
  impl: { create: EffectDefinition<S>["create"] },
) {
  return { ...meta, create: impl.create };
}
