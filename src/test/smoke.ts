/**
 * Browser smoke test page: creates each registered effect on a real WebGL2
 * context, draws it with its default params and with every param set from
 * `paramSets`, and reports anything a real driver rejects that the fake context
 * in the unit tests can't see: shader compile and link errors, GL errors after a
 * frame, uniform names with no location (misspelt, or optimised out because the
 * shader never uses them), and a frame that comes out as one flat colour.
 *
 * Loaded by `e2e/smoke.html`; `e2e/smoke.spec.ts` drives it through
 * `window.smoke(id)` in headless Chromium.
 */
import { WEBGL_OPTIONS } from "../lib/webgl";
import { describeError } from "../lib/errors";
import { effects } from "../effects/registry";
import { contextKind, type AnyParamValues, type EffectInstance } from "../effects/types";
import { paramSets } from "./param-sets";

export interface SmokeOptions {
  /** Frames drawn with the defaults before the flat-colour check. */
  warmupFrames: number;
  /** Skip the flat-colour check, for effects that may legitimately start as one colour. */
  allowFlat: boolean;
}

export interface SmokeResult {
  /** Exceptions and GL errors, each prefixed with the stage it happened in. */
  errors: string[];
  /**
   * Uniform names the effect looked up that no program it linked has: misspelt, or
   * optimised out because no shader reads them.
   */
  missingUniforms: string[];
  /** Set when the frame after warm-up is a single colour: the colour, as `r,g,b`. */
  flat: string | null;
  /** Milliseconds the whole run took. */
  ms: number;
}

const WIDTH = 320;
const HEIGHT = 180;
const DT = 1 / 30;

const GL_ERRORS: Record<number, string> = {
  0x0500: "INVALID_ENUM",
  0x0501: "INVALID_VALUE",
  0x0502: "INVALID_OPERATION",
  0x0505: "OUT_OF_MEMORY",
  0x0506: "INVALID_FRAMEBUFFER_OPERATION",
  0x9242: "CONTEXT_LOST_WEBGL",
};

/**
 * Records every uniform name looked up on `gl`, split by whether it had a location.
 * The wrapper is an own property of this one context, so nothing else is affected.
 */
function trackUniforms(gl: WebGL2RenderingContext, found: Set<string>, missing: Set<string>) {
  const lookup = gl.getUniformLocation.bind(gl);
  gl.getUniformLocation = (program, name) => {
    const loc = lookup(program, name);
    if (!gl.isContextLost()) {
      (loc === null ? missing : found).add(name);
    }
    return loc;
  };
}

/** The colour of the drawing buffer as `r,g,b` when every pixel is (near enough) the same. */
function flatColour(gl: WebGL2RenderingContext, width: number, height: number): string | null {
  const px = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = px[i + c];
      if (v < min[c]) {
        min[c] = v;
      }
      if (v > max[c]) {
        max[c] = v;
      }
    }
  }
  // A couple of levels of spread is dither, not content.
  const spread = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return spread <= 2 ? `${String(min[0])},${String(min[1])},${String(min[2])}` : null;
}

async function smoke(id: string, options: SmokeOptions): Promise<SmokeResult> {
  const start = performance.now();
  const errors: string[] = [];
  const found = new Set<string>();
  const missing = new Set<string>();
  let flat: string | null = null;
  const meta = effects.find((e) => e.id === id);
  if (!meta) {
    return { errors: [`no effect "${id}"`], missingUniforms: [], flat, ms: 0 };
  }
  const effect = await meta.load();
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  if (contextKind(effect) !== "webgl2" || effect.context !== "webgl2") {
    return { errors: ["only WebGL2 effects are smoke-tested"], missingUniforms: [], flat, ms: 0 };
  }
  const gl = canvas.getContext("webgl2", WEBGL_OPTIONS);
  if (!gl) {
    return { errors: ["WebGL2 is unavailable"], missingUniforms: [], flat, ms: 0 };
  }
  trackUniforms(gl, found, missing);
  const glError = (stage: string) => {
    for (let e = gl.getError(); e !== gl.NO_ERROR; e = gl.getError()) {
      errors.push(`${stage}: GL ${GL_ERRORS[e] ?? `0x${e.toString(16)}`}`);
      if (e === 0x9242) {
        break;
      }
    }
  };

  let instance: EffectInstance<AnyParamValues> | null = null;
  let stage = "create";
  try {
    instance = effect.create(gl);
    glError(stage);
    const resize = (width: number, height: number) => {
      canvas.width = width;
      canvas.height = height;
      instance?.resize({ width, height, scale: height / 1080 });
    };
    const frames = (n: number, params: AnyParamValues, dt: number) => {
      for (let i = 0; i < n; i++) {
        instance?.frame(dt, params);
        glError(stage);
      }
    };
    const sets = paramSets(effect.params);
    stage = "defaults";
    resize(WIDTH, HEIGHT);
    frames(1, sets[0], 0);
    frames(options.warmupFrames, sets[0], DT);
    if (!options.allowFlat) {
      flat = flatColour(gl, WIDTH, HEIGHT);
    }
    for (const [i, params] of sets.entries()) {
      stage = `param set ${String(i)} ${JSON.stringify(params)}`;
      frames(3, params, DT);
    }
    stage = "resize";
    resize(640, 360);
    frames(2, sets[0], 0.1);
    resize(16, 9);
    frames(2, sets[1], DT);
    resize(WIDTH, HEIGHT);
    frames(2, sets[0], DT);
  } catch (err) {
    errors.push(`${stage}: ${describeError(err)}`);
  }
  try {
    instance?.dispose?.();
    glError("dispose");
  } catch (err) {
    errors.push(`dispose: ${describeError(err)}`);
  }
  // Free the context now rather than waiting for the browser's context limit.
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return {
    errors: [...new Set(errors)],
    // Variant programs often share one name list, each using only some of the
    // names, so a name counts as missing only when no program had it.
    missingUniforms: [...missing].filter((n) => !found.has(n)).toSorted(),
    flat,
    ms: Math.round(performance.now() - start),
  };
}

/** A seeded stand-in for `Math.random` (mulberry32), so captures repeat exactly. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The wall-clock time captures run at: 2026-03-14 15:09:26 UTC. */
const CAPTURE_TIME = Date.UTC(2026, 2, 14, 15, 9, 26);

/** `Date`, except that `new Date()` and `Date.now()` give `time`. */
function fixedDate(RealDate: DateConstructor, time: number): DateConstructor {
  return new Proxy(RealDate, {
    construct(target, args: unknown[]) {
      return args.length === 0 ? new target(time) : (Reflect.construct(target, args) as object);
    },
    get(target, key, receiver) {
      return key === "now" ? () => time : (Reflect.get(target, key, receiver) as unknown);
    },
  });
}

export interface Capture {
  width: number;
  height: number;
  /** RGBA rows, bottom row first (as `readPixels` returns them), base64-encoded. */
  rgba: string;
}

/**
 * Draws `frames` frames of an effect with its default params at `width` x `height`,
 * with `Math.random` seeded, and returns the last frame's pixels: for comparing an
 * effect before and after a refactor (`e2e/capture.spec.ts`).
 */
async function capture(id: string, frames: number, width = 480, height = 270): Promise<Capture> {
  const meta = effects.find((e) => e.id === id);
  if (!meta) {
    throw new Error(`no effect "${id}"`);
  }
  const effect = await meta.load();
  if (effect.context !== "webgl2") {
    throw new Error("only WebGL2 effects can be captured");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", WEBGL_OPTIONS);
  if (!gl) {
    throw new Error("WebGL2 is unavailable");
  }
  // Everything an effect might read that changes between runs: randomness, the
  // wall clock (clocks and news tickers in the Scenes) and the high-resolution
  // timer (builds spread over frames by a time budget, which then advance by
  // the same number of steps every run).
  const random = Math.random;
  const RealDate = Date;
  const now = performance.now.bind(performance);
  Math.random = seededRandom(1234);
  let fakeNow = 0;
  performance.now = () => {
    fakeNow += 0.1;
    return fakeNow;
  };
  globalThis.Date = fixedDate(RealDate, CAPTURE_TIME);
  try {
    const instance = effect.create(gl);
    instance.resize({ width, height, scale: height / 1080 });
    const params = paramSets(effect.params)[0];
    instance.frame(0, params);
    for (let i = 0; i < frames; i++) {
      instance.frame(DT, params);
    }
    const px = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    instance.dispose?.();
    let binary = "";
    for (let i = 0; i < px.length; i += 0x8000) {
      binary += String.fromCodePoint(...px.subarray(i, i + 0x8000));
    }
    return { width, height, rgba: btoa(binary) };
  } finally {
    Math.random = random;
    globalThis.Date = RealDate;
    performance.now = now;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

declare global {
  interface Window {
    smoke: typeof smoke;
    capture: typeof capture;
    smokeIds: string[];
  }
}

window.smoke = smoke;
window.capture = capture;
window.smokeIds = effects.map((e) => e.id);
