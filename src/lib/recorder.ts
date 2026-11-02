import type { FrameSubscriber } from "./mp4-recorder";

export type { FrameSubscriber };

/**
 * H.264 levels from Table A-1 of the spec: the largest frame (in 16×16 macroblocks)
 * and macroblock rate each allows, with its `avc1` level byte. Levels below 4.0 are
 * left out: 4.0 was the old fixed choice and every H.264 encoder supports it.
 */
const AVC_LEVELS = [
  { level: 0x28, maxFrame: 8192, maxRate: 245_760 }, // 4.0: 1080p30
  { level: 0x2a, maxFrame: 8704, maxRate: 522_240 }, // 4.2: 1080p60
  { level: 0x32, maxFrame: 22_080, maxRate: 589_824 }, // 5.0: 1440p30
  { level: 0x33, maxFrame: 36_864, maxRate: 983_040 }, // 5.1: 4K30
  { level: 0x34, maxFrame: 36_864, maxRate: 2_073_600 }, // 5.2: 4K60
  { level: 0x3c, maxFrame: 139_264, maxRate: 4_177_920 }, // 6.0: 8K30
] as const;

/**
 * The lowest H.264 level that fits `width`×`height` at `fps`, as two hex digits for an
 * `avc1.6400xx` (High profile) codec string. Each side must also be at most
 * √(8·maxFrame) macroblocks. Sizes beyond level 6.0 get 6.0 and are left to the encoder.
 */
export function avcLevel(width: number, height: number, fps: number): string {
  const mbW = Math.ceil(width / 16);
  const mbH = Math.ceil(height / 16);
  const frame = mbW * mbH;
  const fit = AVC_LEVELS.find(
    (l) =>
      frame <= l.maxFrame &&
      frame * fps <= l.maxRate &&
      Math.max(mbW, mbH) <= Math.sqrt(8 * l.maxFrame),
  );
  return (fit ?? AVC_LEVELS[AVC_LEVELS.length - 1]).level.toString(16);
}

/** MIME types to try, best first. Prefers MP4 (Zoom accepts it) at a level that fits. */
export function candidateTypes(width: number, height: number, fps: number): string[] {
  return [
    `video/mp4;codecs=avc1.6400${avcLevel(width, height, fps)}`,
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
}

/** Bitrate at 1920×1080, in bits per second. */
const BITRATE_1080P = 12_000_000;
const MIN_BITRATE = 2_000_000;
const MAX_BITRATE = 80_000_000;

/**
 * Video bitrate for a `width`×`height` clip: 12 Mbps at 1080p, scaled with pixel
 * count (48 Mbps at 4K), clamped so tiny canvases still look clean and huge ones
 * stay within what browser encoders accept.
 */
export function videoBitrate(width: number, height: number): number {
  const scaled = (BITRATE_1080P * width * height) / (1920 * 1080);
  return Math.round(Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, scaled)));
}

export interface Recording {
  blob: Blob;
  extension: "mp4" | "webm";
}

/**
 * Records the canvas for `seconds`, as MP4 where possible. Uses MediaRecorder when it
 * can write MP4 (Chrome, Edge, Safari); otherwise, given `frames` (which reports each
 * drawn frame), encodes MP4 through WebCodecs (Firefox); otherwise MediaRecorder WebM.
 */
export function recordCanvas(
  canvas: HTMLCanvasElement,
  seconds: number,
  fps = 30,
  frames?: FrameSubscriber,
): Promise<Recording> {
  const { width, height } = canvas;
  const supported = candidateTypes(width, height, fps).filter(
    (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
  );
  const mediaRecorderType = supported[0];
  if (
    mediaRecorderType?.startsWith("video/mp4") ||
    !frames ||
    typeof VideoEncoder === "undefined"
  ) {
    return mediaRecorderType
      ? recordWithMediaRecorder(canvas, seconds, fps, mediaRecorderType)
      : Promise.reject(new Error("This browser cannot record video."));
  }
  return (async () => {
    const { canRecordMp4, recordMp4 } = await import("./mp4-recorder");
    const opts = { seconds, fps, bitrate: videoBitrate(width, height) };
    if (await canRecordMp4(width, height, opts)) {
      return { blob: await recordMp4(canvas, opts, frames), extension: "mp4" as const };
    }
    if (!mediaRecorderType) throw new Error("This browser cannot record video.");
    return recordWithMediaRecorder(canvas, seconds, fps, mediaRecorderType);
  })();
}

/**
 * Records the canvas for `seconds` using MediaRecorder. The stop deadline is a
 * `setTimeout`, which browsers throttle in background tabs, so a clip recorded while
 * the tab is hidden can run long; the UI asks the user to keep the tab visible.
 */
function recordWithMediaRecorder(
  canvas: HTMLCanvasElement,
  seconds: number,
  fps: number,
  mimeType: string,
): Promise<Recording> {
  const { width, height } = canvas;
  return new Promise((resolve, reject) => {
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const chunks: Blob[] = [];

    /** Releases the capture and the timer, and settles the promise once. */
    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Already stopping; the tracks are stopped below either way.
        }
      }
      if (stream) for (const track of stream.getTracks()) track.stop();
      if (err !== undefined) reject(err instanceof Error ? err : new Error(String(err)));
      else
        resolve({
          blob: new Blob(chunks, { type: mimeType }),
          extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
        });
    };

    try {
      stream = canvas.captureStream(fps);
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: videoBitrate(width, height),
      });
      const rec = recorder;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      rec.onerror = () => finish(new Error("Recording failed."));
      rec.onstop = () => finish();
      rec.start(1000);
      timer = setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, seconds * 1000);
    } catch (err) {
      finish(err ?? new Error("Recording failed."));
    }
  });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
