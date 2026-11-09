/**
 * The animation loop that hosts one effect on one canvas: creates the instance,
 * sizes the drawing buffer, draws at the chosen frame rate, reports stats, and
 * survives a crashing effect or a lost context. Framework-free so it can be tested
 * with a fake clock and the fake GL context; `EffectCanvas` is a thin wrapper.
 */
import { beginFrame } from "../effects/gl";
import type { AnyParamValues, EffectDefinition, EffectInstance, Viewport } from "../effects/types";
import { describeError } from "./errors";
import { createFrameLimiter, frameDelta, FRAME_RATES, type FrameRate } from "./frameRate";
import { createGpuTimer, type GpuTimer } from "./gpuTimer";
import { RESOLUTIONS, type Resolution } from "./resolution";
import { WEBGL_OPTIONS } from "./webgl";

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
export const STATS_INTERVAL = 500;

const MAX_DPR = 2;
/**
 * "Fit window" renders at most this many pixels (1080p). Video calls never send more,
 * and on high-DPI screens it avoids drawing 3-4× the pixels for no visible gain.
 */
export const MAX_FIT_PIXELS = 1920 * 1080;

/** The parts of the canvas element the loop uses. */
export type LoopCanvas = Pick<
  HTMLCanvasElement,
  | "width"
  | "height"
  | "clientWidth"
  | "clientHeight"
  | "getContext"
  | "addEventListener"
  | "removeEventListener"
>;

/** The browser services the loop uses, injectable for tests. */
export interface LoopHost {
  requestFrame: (callback: (now: number) => void) => number;
  cancelFrame: (id: number) => void;
  /** High-resolution time in ms, on the same clock as the frame callback's `now`. */
  now: () => number;
  devicePixelRatio: () => number;
  /** Calls `callback` when the canvas's layout size may have changed; returns a disconnect. */
  observeResize: (canvas: LoopCanvas, callback: () => void) => () => void;
}

const browserHost: LoopHost = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => {
    cancelAnimationFrame(id);
  },
  now: () => performance.now(),
  devicePixelRatio: () => window.devicePixelRatio || 1,
  observeResize: (canvas, callback) => {
    if (!(canvas instanceof Element)) {
      return () => undefined;
    }
    const observer = new ResizeObserver(callback);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  },
};

export interface RenderLoopOptions {
  canvas: LoopCanvas;
  effect: EffectDefinition;
  resolution: Resolution;
  /** Read every frame, so param changes never recreate the effect. */
  getParams: () => AnyParamValues;
  getFrameRate: () => FrameRate;
  /** Receives stats a few times a second, and `undefined` while no effect is running. */
  onStats?: (stats: FrameStats | undefined) => void;
  /**
   * Receives a message when the effect fails to start or crashes while running, and
   * `undefined` when the loop starts.
   */
  onError?: (message: string | undefined) => void;
  /**
   * Called with the frame time right after each frame is drawn, while the drawing
   * buffer still holds it (the clip recorder copies it from here).
   */
  onFrame?: (now: number) => void;
  /** Starts with the buffer size locked (see `RenderLoop.setSizeLocked`). */
  sizeLocked?: boolean;
  host?: LoopHost;
}

export interface RenderLoop {
  /**
   * While locked, the drawing buffer keeps its size whatever the layout does (CSS
   * still stretches the canvas), so a recording captures one size throughout.
   * Unlocking applies the current layout size.
   */
  setSizeLocked: (locked: boolean) => void;
  /** Stops the loop and disposes the effect. */
  dispose: () => void;
}

/**
 * The buffer size for "Fit window": the layout size times the device pixel ratio
 * (at most `MAX_DPR`), scaled down to stay within `MAX_FIT_PIXELS`.
 */
export function fitSize(
  clientWidth: number,
  clientHeight: number,
  devicePixelRatio: number,
): { width: number; height: number } {
  const cssPixels = Math.max(1, clientWidth * clientHeight);
  const dpr = Math.min(devicePixelRatio, MAX_DPR, Math.sqrt(MAX_FIT_PIXELS / cssPixels));
  return {
    width: Math.max(1, Math.round(clientWidth * dpr)),
    height: Math.max(1, Math.round(clientHeight * dpr)),
  };
}

function getWebGl(canvas: LoopCanvas): WebGL2RenderingContext | null {
  return canvas.getContext("webgl2", WEBGL_OPTIONS);
}

/**
 * Gets the context the effect asks for and creates its renderer. Returns null if the
 * context is unavailable or the renderer fails to build (e.g. a shader error), so a
 * broken effect leaves a blank canvas rather than crashing the app. Failures are
 * logged and passed to `onError` as a message for the user.
 */
function createInstance(
  effect: EffectDefinition,
  canvas: LoopCanvas,
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
      const gl = getWebGl(canvas);
      if (!gl) {
        return fail("WebGL2 is unavailable in this browser.");
      }
      // A lost context is restored later, which retries creation; not an error.
      return gl.isContextLost() ? null : effect.create(gl);
    }
    const ctx = canvas.getContext("2d", { alpha: false });
    return ctx ? effect.create(ctx) : fail("a 2D canvas is unavailable in this browser.");
  } catch (err) {
    return fail(describeError(err), err);
  }
}

/** Starts hosting `effect` on `canvas`; runs until `dispose`. */
export function createRenderLoop(options: RenderLoopOptions): RenderLoop {
  const { canvas, effect, resolution, getParams, getFrameRate } = options;
  const host = options.host ?? browserHost;
  const reportError = (message: string) => options.onError?.(message);
  const reportStats = (stats: FrameStats | undefined) => options.onStats?.(stats);
  options.onError?.(undefined);
  let instance = createInstance(effect, canvas, reportError);

  // Times the effect's GL commands on the GPU, when the browser allows it.
  let gpuTimer: GpuTimer | undefined;
  const startGpuTimer = () => {
    if (!instance || effect.context !== "webgl2") {
      return;
    }
    try {
      // Returns the context createInstance already made.
      const gl = getWebGl(canvas);
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
        const gl = getWebGl(canvas);
        if (gl && !gl.isContextLost()) {
          beginFrame(gl, canvas.width, canvas.height);
        }
      } catch {
        // Best effort: the next effect resets its own state each frame.
      }
    }
    reportError(`This effect stopped after an error: ${describeError(err)}`);
  };
  let viewport: Viewport | undefined;
  const fixed = RESOLUTIONS[resolution].size;
  let sizeLocked = options.sizeLocked ?? false;

  const resizeInstance = () => {
    if (!instance || !viewport) {
      return;
    }
    try {
      instance.resize(viewport);
    } catch (err) {
      crash("resize", err);
    }
  };
  const applySize = () => {
    // A recording captures one size; the layout size is picked up on unlock.
    if (sizeLocked && viewport) {
      return;
    }
    const { width, height } =
      fixed ?? fitSize(canvas.clientWidth, canvas.clientHeight, host.devicePixelRatio());
    // ResizeObserver fires once on observe, and for layout changes that don't alter
    // the buffer size. Assigning width/height reallocates the drawing buffer even when
    // unchanged, and effects may rebuild framebuffers on resize, so skip no-ops.
    if (viewport?.width === width && viewport.height === height) {
      return;
    }
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

  const disconnect = fixed ? undefined : host.observeResize(canvas, applySize);

  let raf = 0;
  let last = host.now();
  const shouldDraw = createFrameLimiter();
  let statsStart = last;
  let statsFrames = 0;
  let statsWork = 0;
  // The last GPU average, shown until fresh results arrive (they lag a few frames).
  let gpuMs: number | undefined;
  // Whether the meter currently shows this effect's stats.
  let statsShown = false;
  const tick = (now: number) => {
    raf = host.requestFrame(tick);
    if (!instance) {
      // Failed, crashed, or waiting for a lost context: hide the meter and restart
      // the sample window so stale numbers never show.
      if (statsShown) {
        reportStats(undefined);
      }
      statsShown = false;
      statsStart = now;
      statsFrames = 0;
      statsWork = 0;
      gpuMs = undefined;
      last = now;
      return;
    }
    if (!shouldDraw(now, FRAME_RATES[getFrameRate()].fps)) {
      return;
    }
    const dt = frameDelta(now, last);
    last = now;
    const start = host.now();
    gpuTimer?.begin();
    try {
      instance.frame(dt, getParams());
    } catch (err) {
      gpuTimer?.end();
      crash("frame", err);
      return;
    }
    gpuTimer?.end();
    statsWork += host.now() - start;
    options.onFrame?.(now);
    statsFrames++;
    const elapsed = now - statsStart;
    if (elapsed >= STATS_INTERVAL) {
      gpuMs = gpuTimer?.takeAverage() ?? gpuMs;
      reportStats({
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
  raf = host.requestFrame(tick);

  return {
    setSizeLocked(locked) {
      if (locked === sizeLocked) {
        return;
      }
      sizeLocked = locked;
      if (!locked && !fixed) {
        applySize();
      }
    },
    dispose() {
      host.cancelFrame(raf);
      disconnect?.();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      stopGpuTimer();
      try {
        instance?.dispose?.();
      } catch (err) {
        console.error(`Failed to dispose "${effect.name}":`, err);
      }
      reportStats(undefined);
    },
  };
}
