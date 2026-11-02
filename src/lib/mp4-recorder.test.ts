import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the fake mediabunny saw, reset per test. */
const seen = vi.hoisted(() => ({
  added: [] as { timestamp: number; visibleRect?: unknown }[],
  closed: 0,
  finalized: false,
  canceled: false,
  addError: undefined as Error | undefined,
  canEncode: true,
}));

vi.mock("mediabunny", () => {
  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }
  class Output {
    opts: { target: BufferTarget };
    constructor(opts: { target: BufferTarget }) {
      this.opts = opts;
    }
    addVideoTrack() {}
    start() {
      return Promise.resolve();
    }
    finalize() {
      seen.finalized = true;
      this.opts.target.buffer = new ArrayBuffer(seen.added.length);
      return Promise.resolve();
    }
    cancel() {
      seen.canceled = true;
      return Promise.resolve();
    }
  }
  class VideoSample {
    frame: { timestamp: number; visibleRect?: unknown };
    constructor(frame: { timestamp: number; visibleRect?: unknown }) {
      this.frame = frame;
    }
    close() {
      seen.closed++;
    }
  }
  class VideoSampleSource {
    add(sample: VideoSample) {
      if (seen.addError) return Promise.reject(seen.addError);
      seen.added.push(sample.frame);
      return Promise.resolve();
    }
  }
  return {
    BufferTarget,
    Output,
    VideoSample,
    VideoSampleSource,
    Mp4OutputFormat: class {},
    Quality: class {},
    canEncodeVideo: () => Promise.resolve(seen.canEncode),
  };
});

const { canRecordMp4, recordMp4 } = await import("./mp4-recorder");

class FakeVideoFrame {
  timestamp: number;
  visibleRect?: unknown;
  constructor(_source: unknown, init: { timestamp: number; visibleRect?: unknown }) {
    this.timestamp = init.timestamp;
    this.visibleRect = init.visibleRect;
  }
}

/** A frame source the test drives by hand, like EffectCanvas's onFrame. */
function frameSource() {
  const listeners = new Set<(now: number) => void>();
  return {
    subscribe: (l: (now: number) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    draw: (now: number) => {
      for (const l of listeners) l(now);
    },
    get count() {
      return listeners.size;
    },
  };
}

const canvas = (width = 640, height = 360) => ({ width, height }) as HTMLCanvasElement;
const opts = { seconds: 1, fps: 30, bitrate: 2_000_000 };

/** Lets queued encoder promises run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  Object.assign(seen, {
    added: [],
    closed: 0,
    finalized: false,
    canceled: false,
    addError: undefined,
    canEncode: true,
  });
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("VideoEncoder", class {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("canRecordMp4", () => {
  it("is false without WebCodecs", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await canRecordMp4(640, 360, opts)).toBe(false);
  });

  it("asks mediabunny whether H.264 encodes", async () => {
    expect(await canRecordMp4(640, 360, opts)).toBe(true);
    seen.canEncode = false;
    expect(await canRecordMp4(640, 360, opts)).toBe(false);
  });
});

describe("recordMp4", () => {
  it("timestamps frames from the first, skips extras, and stops at the clip length", async () => {
    const frames = frameSource();
    const result = recordMp4(canvas(), opts, frames.subscribe);
    await flush();
    // 60 Hz display, 30 fps clip: every other frame is kept, until 1 s has passed.
    for (let i = 0; i <= 61; i++) {
      frames.draw(1000 + (i * 1000) / 60);
      await flush();
    }
    const blob = await result;
    expect(blob.type).toBe("video/mp4");
    expect(seen.added).toHaveLength(30);
    expect(seen.added[0].timestamp).toBe(0);
    expect(seen.added[1].timestamp).toBe(33_333);
    expect(seen.added.at(-1)!.timestamp).toBe(966_667);
    expect(seen.closed).toBe(30);
    expect(seen.finalized).toBe(true);
    expect(frames.count).toBe(0);
  });

  it("drops frames while the encoder is backed up", async () => {
    const frames = frameSource();
    const result = recordMp4(canvas(), opts, frames.subscribe);
    await flush();
    // No yielding between draws, so the encoder never catches up.
    for (let i = 0; i < 20; i++) frames.draw(i * 50);
    await flush();
    frames.draw(5000);
    await result;
    expect(seen.added).toHaveLength(8);
    expect(seen.closed).toBe(8);
  });

  it("crops an odd-sized canvas to even sides", async () => {
    const frames = frameSource();
    const result = recordMp4(canvas(641, 361), opts, frames.subscribe);
    await flush();
    frames.draw(0);
    frames.draw(2000);
    await result;
    expect(seen.added[0].visibleRect).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  it("cancels and rejects when the encoder fails", async () => {
    seen.addError = new Error("EncodingError");
    const frames = frameSource();
    const result = recordMp4(canvas(), opts, frames.subscribe);
    await flush();
    frames.draw(0);
    await expect(result).rejects.toThrow("EncodingError");
    expect(seen.canceled).toBe(true);
    expect(seen.closed).toBe(1);
    expect(frames.count).toBe(0);
  });

  it("ends with what it has when frames stop arriving", async () => {
    vi.useFakeTimers();
    const frames = frameSource();
    const result = recordMp4(canvas(), opts, frames.subscribe);
    await vi.advanceTimersByTimeAsync(0);
    frames.draw(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).size).toBe(1);
  });

  it("rejects when no frame ever arrives", async () => {
    vi.useFakeTimers();
    const result = recordMp4(canvas(), opts, frameSource().subscribe);
    const settled = result.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(3000);
    expect(String(await settled)).toMatch("no frames");
    expect(seen.canceled).toBe(true);
  });
});
