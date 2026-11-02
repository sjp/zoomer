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

export type ParamDef = NumberParam | ColorParam | BooleanParam | SelectParam;
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
  resize(viewport: Viewport): void;
  /** Draws one frame. `dt` is seconds since the previous frame, clamped by the host to [0, 0.1]. */
  frame(dt: number, params: V): void;
  /**
   * Releases resources such as GPU buffers, textures and programs. Called when the
   * effect changes or the canvas unmounts. Not called after a lost WebGL context,
   * since the context's resources are already gone.
   */
  dispose?(): void;
}

/** Rendering context types an effect can draw with, keyed by `getContext` name. */
export interface ContextMap {
  "2d": CanvasRenderingContext2D;
  webgl2: WebGL2RenderingContext;
}
export type ContextKind = keyof ContextMap;

interface EffectBase<S extends ParamSchema> {
  id: string;
  name: string;
  description: string;
  params: S;
}

export interface Effect2D<S extends ParamSchema = ParamSchema> extends EffectBase<S> {
  /** Defaults to "2d". */
  context?: "2d";
  create(ctx: CanvasRenderingContext2D): EffectInstance<ParamValues<S>>;
}

export interface EffectWebGL2<S extends ParamSchema = ParamSchema> extends EffectBase<S> {
  context: "webgl2";
  /**
   * Called again with the same context after it is lost and restored, so build all
   * GPU resources here. GL state persists across effects sharing a canvas, so set
   * every piece of state you rely on rather than assuming defaults.
   */
  create(gl: WebGL2RenderingContext): EffectInstance<ParamValues<S>>;
}

export type EffectDefinition<S extends ParamSchema = ParamSchema> = Effect2D<S> | EffectWebGL2<S>;

export function contextKind(effect: EffectDefinition): ContextKind {
  return effect.context ?? "2d";
}

/** Identity helper that infers precise param value types for `frame`. */
export function defineEffect<const S extends ParamSchema>(def: Effect2D<S>): Effect2D<S>;
export function defineEffect<const S extends ParamSchema>(def: EffectWebGL2<S>): EffectWebGL2<S>;
export function defineEffect<const S extends ParamSchema>(def: EffectDefinition<S>) {
  return def;
}
