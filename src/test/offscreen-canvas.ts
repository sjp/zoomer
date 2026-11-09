/**
 * A stand-in for `OffscreenCanvas`, which Node lacks: effects that draw glyph or
 * sprite atlases on one get a 2D context whose every method does nothing.
 */
export class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return new Proxy({}, { get: (_, key) => (key === "then" ? undefined : () => undefined) });
  }
}

/** A 2D context method call recorded by `MeasuringCanvas`, with the font and fill set at the time. */
interface CanvasCall {
  method: string;
  args: unknown[];
  font: string;
  fillStyle: unknown;
}

/**
 * A stand-in for `OffscreenCanvas` whose 2D context records every method call
 * and measures text at a fixed `emPerChar` font sizes per character (the font
 * size read from `ctx.font`), for testing layout that depends on measured text.
 * Set `MeasuringCanvas.emPerChar` and read `MeasuringCanvas.calls` and
 * `MeasuringCanvas.made` (every canvas created, in order).
 */
export class MeasuringCanvas {
  static emPerChar = 0.5;
  static calls: CanvasCall[] = [];
  static made: MeasuringCanvas[] = [];

  /** Clears the recorded calls and canvases. */
  static reset(emPerChar = 0.5): void {
    MeasuringCanvas.emPerChar = emPerChar;
    MeasuringCanvas.calls = [];
    MeasuringCanvas.made = [];
  }

  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    MeasuringCanvas.made.push(this);
  }

  getContext() {
    const state: Record<string | symbol, unknown> = { font: "10px sans-serif", fillStyle: "#000" };
    const font = () => String(state.font);
    const fontPx = () => Number(/([\d.]+)px/.exec(font())?.[1] ?? 10);
    return new Proxy(state, {
      get: (target, key) => {
        if (key === "then") {
          return undefined;
        }
        if (key in target) {
          return target[key];
        }
        return (...args: unknown[]) => {
          MeasuringCanvas.calls.push({
            method: String(key),
            args,
            font: font(),
            fillStyle: target.fillStyle,
          });
          if (key === "measureText") {
            const chars = Array.from(String(args[0])).length;
            return { width: chars * fontPx() * MeasuringCanvas.emPerChar };
          }
          return undefined;
        };
      },
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    });
  }
}
