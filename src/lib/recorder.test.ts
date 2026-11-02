import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { avcLevel, candidateTypes, recordCanvas, videoBitrate } from "./recorder";

describe("avcLevel", () => {
  it.each([
    [1280, 720, 60, "28"],
    [1920, 1080, 30, "28"],
    [1920, 1080, 60, "2a"],
    [2560, 1440, 30, "32"],
    [2560, 1440, 60, "33"],
    [3840, 2160, 30, "33"],
    [3840, 2160, 60, "34"],
    [4096, 2160, 60, "34"],
    [7680, 4320, 30, "3c"],
  ])("picks the lowest level for %d×%d at %d fps", (w, h, fps, level) => {
    expect(avcLevel(w, h, fps)).toBe(level);
  });

  it("rejects a level whose frame size fits but whose sides are too long", () => {
    // 5000×200 is only 4069 macroblocks, but 313 wide exceeds 4.x's √(8·8192) = 256.
    expect(avcLevel(5000, 200, 30)).toBe("32");
  });

  it("falls back to the highest level for sizes beyond it", () => {
    expect(avcLevel(16_384, 16_384, 60)).toBe("3c");
  });
});

describe("candidateTypes", () => {
  it("puts the size-matched MP4 first and WebM last", () => {
    expect(candidateTypes(3840, 2160, 60)).toEqual([
      "video/mp4;codecs=avc1.640034",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm",
    ]);
  });
});

describe("videoBitrate", () => {
  it("is 12 Mbps at 1080p and scales with pixel count", () => {
    expect(videoBitrate(1920, 1080)).toBe(12_000_000);
    expect(videoBitrate(3840, 2160)).toBe(48_000_000);
  });

  it("is clamped at both ends", () => {
    expect(videoBitrate(320, 180)).toBe(2_000_000);
    expect(videoBitrate(7680, 4320)).toBe(80_000_000);
  });
});

/** A MediaRecorder stand-in that the test drives by hand. */
class FakeRecorder {
  static last: FakeRecorder;
  static isTypeSupported = (type: string) => type.startsWith("video/webm");
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  stopCalls = 0;
  readonly options: { mimeType: string; videoBitsPerSecond: number };
  constructor(_stream: unknown, options: { mimeType: string; videoBitsPerSecond: number }) {
    this.options = options;
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.stopCalls++;
    if (this.state === "inactive") throw new Error("InvalidStateError");
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["frame"]) });
    this.onstop?.();
  }
}

function fakeCanvas() {
  const track = { stop: vi.fn<() => void>() };
  const canvas = {
    width: 1920,
    height: 1080,
    captureStream: vi.fn<() => { getTracks: () => (typeof track)[] }>(() => ({
      getTracks: () => [track],
    })),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, track };
}

describe("recordCanvas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaRecorder", FakeRecorder);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops after the clip length and releases the stream", async () => {
    const { canvas, track } = fakeCanvas();
    const result = recordCanvas(canvas, 5, 60);
    expect(FakeRecorder.last.options).toEqual({
      mimeType: "video/webm;codecs=vp9",
      videoBitsPerSecond: 12_000_000,
    });
    vi.advanceTimersByTime(5000);
    const { blob, extension } = await result;
    expect(extension).toBe("webm");
    expect(blob.size).toBe(5);
    expect(track.stop).toHaveBeenCalled();
  });

  it("on error, stops the tracks and cancels the stop timer", async () => {
    const { canvas, track } = fakeCanvas();
    const result = recordCanvas(canvas, 5);
    const recorder = FakeRecorder.last;
    // Browsers stop the recorder themselves before firing error.
    recorder.state = "inactive";
    recorder.onerror?.();
    await expect(result).rejects.toThrow("Recording failed.");
    expect(track.stop).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(recorder.stopCalls).toBe(0);
  });

  it("stops a recorder that is still running when it reports an error", async () => {
    const { canvas } = fakeCanvas();
    const result = recordCanvas(canvas, 5);
    FakeRecorder.last.onerror?.();
    await expect(result).rejects.toThrow("Recording failed.");
    expect(FakeRecorder.last.state).toBe("inactive");
  });

  it("does not stop a recorder that went inactive before the deadline", async () => {
    const { canvas } = fakeCanvas();
    const result = recordCanvas(canvas, 5);
    const recorder = FakeRecorder.last;
    recorder.stop();
    await result;
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
    expect(recorder.stopCalls).toBe(1);
  });

  it("releases the stream when the recorder cannot be created", async () => {
    const { canvas, track } = fakeCanvas();
    vi.stubGlobal(
      "MediaRecorder",
      Object.assign(
        function () {
          throw new Error("NotSupportedError");
        },
        { isTypeSupported: () => true },
      ),
    );
    await expect(recordCanvas(canvas, 5)).rejects.toThrow("NotSupportedError");
    expect(track.stop).toHaveBeenCalled();
  });

  it("rejects when no format is supported", async () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    const { canvas } = fakeCanvas();
    await expect(recordCanvas(canvas, 5)).rejects.toThrow("cannot record");
  });
});
