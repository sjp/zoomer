/**
 * MP4 recording through WebCodecs, for browsers whose MediaRecorder only writes WebM
 * (Firefox). Each frame is copied from the canvas right after the effect draws it, so
 * a WebGL canvas without `preserveDrawingBuffer` still has its pixels, then encoded as
 * H.264 and muxed into an MP4 in memory. Loaded on demand: most browsers never need it.
 */
import { toError } from "./errors";
import {
  BufferTarget,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
} from "mediabunny";

/** Calls `listener` with the rAF time after each frame the canvas draws; returns an unsubscribe. */
export type FrameSubscriber = (listener: (now: number) => void) => () => void;

export interface Mp4Options {
  seconds: number;
  fps: number;
  bitrate: number;
}

/** H.264 in 4:2:0 needs even sides, so an odd canvas loses its last row or column. */
const even = (n: number) => Math.max(2, n - (n % 2));

/** Frames still waiting on the encoder beyond which new ones are dropped. */
const MAX_PENDING = 8;
/**
 * Extra wall-clock time, past the clip length, after which a recording that has
 * stopped receiving frames (a crashed effect, a hidden tab) ends with what it has.
 */
const STALL_GRACE_MS = 2000;

/** Whether this browser can encode the canvas as H.264 through WebCodecs. */
export async function canRecordMp4(width: number, height: number, opts: Mp4Options) {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    return false;
  }
  try {
    return await canEncodeVideo("avc", {
      width: even(width),
      height: even(height),
      quality: new Quality(opts.bitrate),
      frameRate: opts.fps,
    });
  } catch {
    return false;
  }
}

/**
 * Records `opts.seconds` of the canvas, in media time: frames are timestamped by when
 * they were drawn, and the clip ends once a frame lands past the clip length. Frames
 * drawn faster than `opts.fps` are skipped.
 */
export async function recordMp4(
  canvas: HTMLCanvasElement,
  opts: Mp4Options,
  subscribe: FrameSubscriber,
): Promise<Blob> {
  const width = even(canvas.width);
  const height = even(canvas.height);
  const cropped = width !== canvas.width || height !== canvas.height;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const source = new VideoSampleSource({ codec: "avc", quality: new Quality(opts.bitrate) });
  output.addVideoTrack(source, { frameRate: opts.fps });
  await output.start();

  return new Promise<Blob>((resolve, reject) => {
    const interval = 1000 / opts.fps;
    let start: number | undefined;
    let lastKept = 0;
    let frames = 0;
    let pending = 0;
    let done = false;
    // Encodes run one after another, each waiting for the encoder to take the last.
    let queue = Promise.resolve();
    let unsubscribe = () => {};

    const stop = async (reason?: unknown) => {
      if (done) {
        return;
      }
      done = true;
      unsubscribe();
      clearTimeout(stall);
      try {
        if (reason === undefined && frames === 0) {
          reason = new Error("Recording captured no frames.");
        }
        if (reason !== undefined) {
          throw toError(reason);
        }
        await queue;
        await output.finalize();
        resolve(new Blob([target.buffer ?? new ArrayBuffer(0)], { type: "video/mp4" }));
      } catch (e) {
        void output.cancel().catch(() => undefined);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };

    const stall = setTimeout(() => void stop(), opts.seconds * 1000 + STALL_GRACE_MS);

    unsubscribe = subscribe((now) => {
      if (done) {
        return;
      }
      start ??= now;
      const time = (now - start) / 1000;
      if (time >= opts.seconds) {
        void stop();
        return;
      }
      // A small tolerance so a frame a hair early (rAF jitter) still counts.
      if (frames > 0 && now - lastKept < interval * 0.8) {
        return;
      }
      if (pending >= MAX_PENDING) {
        return;
      }
      lastKept = now;
      let sample: VideoSample;
      try {
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round(time * 1e6),
          duration: Math.round(interval * 1000),
          ...(cropped && { visibleRect: { x: 0, y: 0, width, height } }),
        });
        sample = new VideoSample(frame);
      } catch (err) {
        void stop(err);
        return;
      }
      frames++;
      pending++;
      queue = queue
        .then(() => source.add(sample))
        .finally(() => {
          sample.close();
          pending--;
        });
      queue.catch((err: unknown) => void stop(err));
    });
  });
}
