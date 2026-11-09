import { useEffect, useRef, type Ref } from "react";
import { contextKind, type AnyParamValues, type EffectDefinition } from "../effects/types";
import type { FrameRate } from "../lib/frameRate";
import { createRenderLoop, type FrameStats } from "../lib/renderLoop";
import type { Resolution } from "../lib/resolution";

export type { FrameStats } from "../lib/renderLoop";

interface Props {
  /** The loaded effect to run; undefined leaves the canvas blank (first load). */
  effect: EffectDefinition | undefined;
  params: AnyParamValues;
  resolution: Resolution;
  frameRate: FrameRate;
  /** Receives stats a few times a second, and `undefined` while no effect is running. */
  onStats?: (stats: FrameStats | undefined) => void;
  /**
   * Receives a message when the effect fails to start or crashes while running, and
   * `undefined` when a new effect starts.
   */
  onError?: (message: string | undefined) => void;
  /**
   * Called with the rAF time right after each frame is drawn, while the drawing buffer
   * still holds it (the clip recorder copies it from here).
   */
  onFrame?: (now: number) => void;
  ref?: Ref<HTMLCanvasElement>;
}

/** Hosts one effect instance and drives its animation loop (see `createRenderLoop`). */
export function EffectCanvas({
  effect,
  params,
  resolution,
  frameRate,
  onStats,
  onError,
  onFrame,
  ref,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read the latest params each frame without recreating the effect.
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);
  const frameRateRef = useRef(frameRate);
  useEffect(() => {
    frameRateRef.current = frameRate;
  }, [frameRate]);
  const onStatsRef = useRef(onStats);
  useEffect(() => {
    onStatsRef.current = onStats;
  }, [onStats]);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !effect) {
      return undefined;
    }
    const loop = createRenderLoop({
      canvas,
      effect,
      resolution,
      getParams: () => paramsRef.current,
      getFrameRate: () => frameRateRef.current,
      onStats: (stats) => onStatsRef.current?.(stats),
      onError: (message) => onErrorRef.current?.(message),
      onFrame: (now) => onFrameRef.current?.(now),
    });
    return () => {
      loop.dispose();
    };
  }, [effect, resolution]);

  return (
    <canvas
      // A canvas holds one context type for life, so switching kind needs a new element.
      key={effect && contextKind(effect)}
      className="effect-canvas"
      ref={(node) => {
        canvasRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      }}
    />
  );
}
