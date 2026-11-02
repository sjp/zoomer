export const RESOLUTIONS = {
  window: { label: "Fit window (max 1080p)", size: undefined },
  "1080p": { label: "1920 × 1080", size: { width: 1920, height: 1080 } },
  "720p": { label: "1280 × 720", size: { width: 1280, height: 720 } },
  "4k": { label: "3840 × 2160", size: { width: 3840, height: 2160 } },
} as const;

export type Resolution = keyof typeof RESOLUTIONS;
