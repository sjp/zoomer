const CANDIDATE_TYPES = [
  "video/mp4;codecs=avc1.640028",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm",
];

export interface Recording {
  blob: Blob;
  extension: "mp4" | "webm";
}

/**
 * Records the canvas for `seconds` using MediaRecorder. The stop deadline is a
 * `setTimeout`, which browsers throttle in background tabs, so a clip recorded while
 * the tab is hidden can run long; the UI asks the user to keep the tab visible.
 */
export function recordCanvas(
  canvas: HTMLCanvasElement,
  seconds: number,
  fps = 30,
): Promise<Recording> {
  const mimeType = CANDIDATE_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) return Promise.reject(new Error("This browser cannot record video."));

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
        videoBitsPerSecond: 12_000_000,
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
