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

/** Records the canvas for `seconds` using MediaRecorder. Prefers MP4 (Zoom accepts it). */
export function recordCanvas(
  canvas: HTMLCanvasElement,
  seconds: number,
  fps = 30,
): Promise<Recording> {
  const mimeType = CANDIDATE_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) return Promise.reject(new Error("This browser cannot record video."));

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];

  return new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () => reject(new Error("Recording failed."));
    recorder.onstop = () => {
      for (const track of stream.getTracks()) track.stop();
      resolve({
        blob: new Blob(chunks, { type: mimeType }),
        extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
      });
    };
    recorder.start(1000);
    setTimeout(() => recorder.stop(), seconds * 1000);
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
