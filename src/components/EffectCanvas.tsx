import { useEffect, useRef, type Ref } from "react";
import {
  contextKind,
  type AnyParamValues,
  type EffectDefinition,
  type EffectInstance,
  type Viewport,
} from "../effects/types";
import { createFrameLimiter, FRAME_RATES, type FrameRate } from "../lib/frameRate";
import { RESOLUTIONS, type Resolution } from "../lib/resolution";

export interface FrameStats {
  /** Frames drawn per second, averaged over the last sample window. */
  fps: number;
  /** Average CPU time spent inside the effect's `frame` call, in ms. */
  frameMs: number;
}

/** How often stats are reported, in ms. */
const STATS_INTERVAL = 500;

interface Props {
  effect: EffectDefinition;
  params: AnyParamValues;
  resolution: Resolution;
  frameRate: FrameRate;
  onStats?: (stats: FrameStats) => void;
  ref?: Ref<HTMLCanvasElement>;
}

const MAX_DPR = 2;
/**
 * "Fit window" renders at most this many pixels (1080p). Video calls never send more,
 * and on high-DPI screens it avoids drawing 3-4× the pixels for no visible gain.
 */
const MAX_FIT_PIXELS = 1920 * 1080;

/**
 * WebGL2 context settings. Without `preserveDrawingBuffer` the buffer is cleared
 * after each composite; `captureStream` still records, since it samples on composite.
 */
const WEBGL_OPTIONS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
};

/**
 * Gets the context the effect asks for and creates its renderer. Returns null if the
 * context is unavailable or the renderer fails to build (e.g. a shader error), so a
 * broken effect leaves a blank canvas rather than crashing the app.
 */
function createInstance(
  effect: EffectDefinition,
  canvas: HTMLCanvasElement,
): EffectInstance<AnyParamValues> | null {
  try {
    if (effect.context === "webgl2") {
      const gl = canvas.getContext("webgl2", WEBGL_OPTIONS);
      if (!gl) {
        console.error(`"${effect.name}" needs WebGL2, which this browser cannot provide.`);
        return null;
      }
      return gl.isContextLost() ? null : effect.create(gl);
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    return ctx ? effect.create(ctx) : null;
  } catch (err) {
    console.error(`Failed to start "${effect.name}":`, err);
    return null;
  }
}

/** Hosts one effect instance and drives its animation loop. */
export function EffectCanvas({ effect, params, resolution, frameRate, onStats, ref }: Props) {
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let instance = createInstance(effect, canvas);
    let viewport: Viewport | undefined;
    const fixed = RESOLUTIONS[resolution].size;

    const applySize = () => {
      let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const cssPixels = Math.max(1, canvas.clientWidth * canvas.clientHeight);
      dpr = Math.min(dpr, Math.sqrt(MAX_FIT_PIXELS / cssPixels));
      const width = fixed?.width ?? Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = fixed?.height ?? Math.max(1, Math.round(canvas.clientHeight * dpr));
      // ResizeObserver fires once on observe, and for layout changes that don't alter
      // the buffer size. Assigning width/height reallocates the drawing buffer even when
      // unchanged, and effects may rebuild framebuffers on resize, so skip no-ops.
      if (viewport && viewport.width === width && viewport.height === height) return;
      canvas.width = width;
      canvas.height = height;
      viewport = { width, height, scale: height / 1080 };
      instance?.resize(viewport);
    };
    applySize();

    // A lost WebGL context takes every GPU resource with it. Drop the renderer
    // (its resources are gone, so no dispose) and build a fresh one on restore.
    const onLost = (e: Event) => {
      e.preventDefault(); // Required for the browser to ever restore the context.
      instance = null;
    };
    const onRestored = () => {
      instance = createInstance(effect, canvas);
      if (viewport) instance?.resize(viewport);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    const observer = fixed ? undefined : new ResizeObserver(applySize);
    observer?.observe(canvas);

    let raf = 0;
    let last = performance.now();
    const shouldDraw = createFrameLimiter();
    let statsStart = last;
    let statsFrames = 0;
    let statsWork = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!instance || !shouldDraw(now, FRAME_RATES[frameRateRef.current].fps)) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const start = performance.now();
      instance.frame(dt, paramsRef.current);
      statsWork += performance.now() - start;
      statsFrames++;
      const elapsed = now - statsStart;
      if (elapsed >= STATS_INTERVAL) {
        onStatsRef.current?.({
          fps: (statsFrames * 1000) / elapsed,
          frameMs: statsWork / statsFrames,
        });
        statsStart = now;
        statsFrames = 0;
        statsWork = 0;
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      instance?.dispose?.();
    };
  }, [effect, resolution]);

  return (
    <canvas
      // A canvas holds one context type for life, so switching kind needs a new element.
      key={contextKind(effect)}
      className="effect-canvas"
      ref={(node) => {
        canvasRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
    />
  );
}
