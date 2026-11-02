import { useEffect, useRef, type Ref } from "react";
import {
  contextKind,
  type AnyParamValues,
  type EffectDefinition,
  type EffectInstance,
  type Viewport,
} from "../effects/types";
import { beginFrame } from "../effects/gl";
import { createFrameLimiter, frameDelta, FRAME_RATES, type FrameRate } from "../lib/frameRate";
import { describeError } from "../lib/errors";
import { createGpuTimer, type GpuTimer } from "../lib/gpuTimer";
import { RESOLUTIONS, type Resolution } from "../lib/resolution";

export interface FrameStats {
  /** Frames drawn per second, averaged over the last sample window. */
  fps: number;
  /**
   * Average time per frame in ms: GPU time for the effect's commands when the browser
   * supports timer queries, otherwise CPU time spent inside its `frame` call (which
   * covers only command submission, so it understates GPU-bound effects).
   */
  frameMs: number;
  /** Which clock `frameMs` comes from. */
  source: "gpu" | "cpu";
}

/** How often stats are reported, in ms. */
const STATS_INTERVAL = 500;

interface Props {
  effect: EffectDefinition;
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
 * broken effect leaves a blank canvas rather than crashing the app. Failures are
 * logged and passed to `onError` as a message for the user.
 */
function createInstance(
  effect: EffectDefinition,
  canvas: HTMLCanvasElement,
  onError: (message: string) => void,
): EffectInstance<AnyParamValues> | null {
  const fail = (reason: string, err?: unknown) => {
    console.error(
      `Failed to start "${effect.name}": ${reason}`,
      ...(err === undefined ? [] : [err]),
    );
    onError(`This effect failed to start: ${reason}`);
    return null;
  };
  try {
    if (effect.context === "webgl2") {
      const gl = canvas.getContext("webgl2", WEBGL_OPTIONS);
      if (!gl) return fail("WebGL2 is unavailable in this browser.");
      // A lost context is restored later, which retries creation; not an error.
      return gl.isContextLost() ? null : effect.create(gl);
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    return ctx ? effect.create(ctx) : fail("a 2D canvas is unavailable in this browser.");
  } catch (err) {
    return fail(describeError(err), err);
  }
}

/** Hosts one effect instance and drives its animation loop. */
export function EffectCanvas({
  effect,
  params,
  resolution,
  frameRate,
  onStats,
  onError,
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reportError = (message: string) => onErrorRef.current?.(message);
    onErrorRef.current?.(undefined);
    let instance = createInstance(effect, canvas, reportError);

    // Times the effect's GL commands on the GPU, when the browser allows it.
    let gpuTimer: GpuTimer | undefined;
    const startGpuTimer = () => {
      if (!instance || effect.context !== "webgl2") return;
      try {
        // Returns the context createInstance already made.
        const gl = canvas.getContext("webgl2", WEBGL_OPTIONS);
        gpuTimer = gl && !gl.isContextLost() ? createGpuTimer(gl) : undefined;
      } catch (err) {
        console.warn("GPU timer unavailable:", err);
      }
    };
    const stopGpuTimer = () => {
      try {
        gpuTimer?.dispose();
      } catch {
        // Only the meter depends on it.
      }
      gpuTimer = undefined;
    };
    startGpuTimer();

    /**
     * Stops a running effect after it throws, so one bad frame logs once instead of
     * 60-120 times a second. Disposes it (which may itself throw) and tells the UI.
     */
    const crash = (stage: string, err: unknown) => {
      const failed = instance;
      instance = null;
      console.error(`"${effect.name}" crashed in ${stage}():`, err);
      stopGpuTimer();
      try {
        failed?.dispose?.();
      } catch (disposeErr) {
        console.error(`"${effect.name}" also failed to dispose:`, disposeErr);
      }
      // A throw midway through a frame can leave an FBO bound, scissor or blending
      // on, and so on. Every frame starts with beginFrame anyway; resetting here as
      // well means whatever runs next on this context never inherits that state.
      if (effect.context === "webgl2") {
        try {
          const gl = canvas.getContext("webgl2", WEBGL_OPTIONS);
          if (gl && !gl.isContextLost()) beginFrame(gl, canvas.width, canvas.height);
        } catch {
          // Best effort: the next effect resets its own state each frame.
        }
      }
      reportError(`This effect stopped after an error: ${describeError(err)}`);
    };
    let viewport: Viewport | undefined;
    const fixed = RESOLUTIONS[resolution].size;

    const resizeInstance = () => {
      if (!instance || !viewport) return;
      try {
        instance.resize(viewport);
      } catch (err) {
        crash("resize", err);
      }
    };
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
      resizeInstance();
    };
    applySize();

    // A lost WebGL context takes every GPU resource with it. Drop the renderer
    // (its resources are gone, so no dispose) and build a fresh one on restore.
    const onLost = (e: Event) => {
      e.preventDefault(); // Required for the browser to ever restore the context.
      instance = null;
      gpuTimer = undefined; // Its queries went with the context.
    };
    const onRestored = () => {
      instance = createInstance(effect, canvas, reportError);
      startGpuTimer();
      resizeInstance();
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
    // The last GPU average, shown until fresh results arrive (they lag a few frames).
    let gpuMs: number | undefined;
    // Whether the meter currently shows this effect's stats.
    let statsShown = false;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!instance) {
        // Failed, crashed, or waiting for a lost context: hide the meter and restart
        // the sample window so stale numbers never show.
        if (statsShown) onStatsRef.current?.(undefined);
        statsShown = false;
        statsStart = now;
        statsFrames = 0;
        statsWork = 0;
        gpuMs = undefined;
        last = now;
        return;
      }
      if (!shouldDraw(now, FRAME_RATES[frameRateRef.current].fps)) return;
      const dt = frameDelta(now, last);
      last = now;
      const start = performance.now();
      gpuTimer?.begin();
      try {
        instance.frame(dt, paramsRef.current);
      } catch (err) {
        gpuTimer?.end();
        crash("frame", err);
        return;
      }
      gpuTimer?.end();
      statsWork += performance.now() - start;
      statsFrames++;
      const elapsed = now - statsStart;
      if (elapsed >= STATS_INTERVAL) {
        gpuMs = gpuTimer?.takeAverage() ?? gpuMs;
        onStatsRef.current?.({
          fps: (statsFrames * 1000) / elapsed,
          frameMs: gpuMs ?? statsWork / statsFrames,
          source: gpuMs === undefined ? "cpu" : "gpu",
        });
        statsShown = true;
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
      stopGpuTimer();
      try {
        instance?.dispose?.();
      } catch (err) {
        console.error(`Failed to dispose "${effect.name}":`, err);
      }
      onStatsRef.current?.(undefined);
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
