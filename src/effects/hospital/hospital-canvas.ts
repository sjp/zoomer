/**
 * The Hospital Room's text, drawn with Canvas 2D and uploaded as textures: the
 * monitor's screen (everything on it but the moving traces and the beating
 * heart, which the shader draws) and the handwriting on the care board.
 *
 * Positions on the screen are in "screen uv": 0..1 across, 0..1 down. The
 * shader reads the same constants to put the traces in their rows.
 */
import type { Vitals } from "./hospital-sim";
import { SANS_FONT_STACK } from "../canvas-texture";

/** A system font stack, a clean grotesque like a monitor's. */
const SANS = SANS_FONT_STACK;
/** Marker-pen handwriting, from whichever casual face the system has. */
const HAND = `"Segoe Print", "Bradley Hand", "Marker Felt", "Chalkboard SE", "Comic Sans MS", "Comic Neue", cursive`;

/** The waveforms' area, left to right. */
export const WAVE_X0 = 0.018;
export const WAVE_X1 = 0.652;
/** Each trace's row, top and bottom: ECG, pleth, breathing. */
export const TRACE_ROWS = [
  [0.1, 0.4],
  [0.43, 0.68],
  [0.71, 0.96],
] as const;
/** The trace colours: ECG green, pleth cyan, breathing yellow. */
export const TRACE_RGB = [
  [0.32, 1.0, 0.42],
  [0.3, 0.9, 1.0],
  [1.0, 0.88, 0.3],
] as const;
/** The beating heart by the heart rate, and its size (share of the screen's height). */
export const HEART_UV = [0.79, 0.118] as const;
export const HEART_SIZE = 0.045;

/** The numbers column starts here. */
const NUM_X0 = 0.665;

const css = ([r, g, b]: readonly [number, number, number], a = 1) =>
  `rgba(${String(Math.round(r * 255))}, ${String(Math.round(g * 255))}, ${String(Math.round(b * 255))}, ${String(a)})`;

/**
 * Draws the monitor's screen at `w` x `h` pixels: a status bar, each trace's
 * label and scale, and the numbers (heart rate, SpO2, blood pressure and
 * breathing rate) in their boxes down the right.
 */
export function drawScreen(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  v: Vitals,
): void {
  const font = (size: number, weight = "normal") => {
    ctx.font = `${weight} ${String(Math.max(1, size * h))}px ${SANS}`;
  };
  const text = (s: string, x: number, y: number, align: CanvasTextAlign = "left") => {
    ctx.textAlign = align;
    ctx.fillText(s, x * w, y * h);
  };
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.beginPath();
    ctx.moveTo(x0 * w, y0 * h);
    ctx.lineTo(x1 * w, y1 * h);
    ctx.stroke();
  };
  const [green, cyan, yellow] = TRACE_RGB;

  ctx.fillStyle = "#03050a";
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = "alphabetic";

  // The status bar.
  ctx.fillStyle = "#16263b";
  ctx.fillRect(0, 0, w, 0.072 * h);
  ctx.fillStyle = "#d8e2ee";
  font(0.045, "bold");
  text("Bed 7", 0.018, 0.054);
  font(0.04);
  ctx.fillStyle = "#9fb3c8";
  text("Adult", 0.16, 0.054);
  text("Monitoring", 0.3, 0.054);
  ctx.fillStyle = "#6fd27c";
  text("Alarms on", 0.98, 0.054, "right");

  // Dividers.
  ctx.strokeStyle = "#26303c";
  ctx.lineWidth = Math.max(1, 0.004 * h);
  line(NUM_X0, 0.085, NUM_X0, 0.985);
  for (const y of [0.415, 0.69, 0.865]) {
    line(NUM_X0 + 0.01, y, 0.985, y);
  }
  ctx.setLineDash([0.008 * w, 0.012 * w]);
  ctx.strokeStyle = "#1a222c";
  for (const [, bottom] of TRACE_ROWS) {
    line(WAVE_X0, bottom + 0.008, WAVE_X1, bottom + 0.008);
  }
  ctx.setLineDash([]);

  // Trace labels, and the ECG's 1 mV scale bar.
  font(0.042, "bold");
  ctx.fillStyle = css(green);
  text("II", WAVE_X0 + 0.004, TRACE_ROWS[0][0] + 0.045);
  font(0.034);
  text("x1", WAVE_X0 + 0.04, TRACE_ROWS[0][0] + 0.045);
  ctx.strokeStyle = css(green, 0.8);
  ctx.lineWidth = Math.max(1, 0.006 * h);
  const sx = WAVE_X1 - 0.03;
  const [rt, rb] = TRACE_ROWS[0];
  const base = rt + (rb - rt) * 0.66;
  const top = rt + (rb - rt) * 0.2;
  ctx.beginPath();
  ctx.moveTo((sx - 0.012) * w, base * h);
  ctx.lineTo(sx * w, base * h);
  ctx.lineTo(sx * w, top * h);
  ctx.lineTo((sx + 0.012) * w, top * h);
  ctx.stroke();
  font(0.03);
  ctx.fillStyle = css(green, 0.8);
  text("1 mV", sx - 0.012, top - 0.012, "right");
  font(0.042, "bold");
  ctx.fillStyle = css(cyan);
  text("Pleth", WAVE_X0 + 0.004, TRACE_ROWS[1][0] + 0.045);
  ctx.fillStyle = css(yellow);
  text("Resp", WAVE_X0 + 0.004, TRACE_ROWS[2][0] + 0.045);

  // Heart rate.
  const right = 0.975;
  const label = (s: string, unit: string, y: number, rgb: readonly [number, number, number]) => {
    ctx.fillStyle = css(rgb);
    font(0.05, "bold");
    text(s, NUM_X0 + 0.018, y);
    ctx.fillStyle = css(rgb, 0.7);
    font(0.034);
    text(unit, NUM_X0 + 0.018, y + 0.045);
  };
  const limits = (hi: string, lo: string, y: number, rgb: readonly [number, number, number]) => {
    ctx.fillStyle = css(rgb, 0.6);
    font(0.03);
    text(hi, NUM_X0 + 0.018, y);
    text(lo, NUM_X0 + 0.018, y + 0.04);
  };
  label("HR", "bpm", 0.155, green);
  limits("120", "50", 0.29, green);
  ctx.fillStyle = css(green);
  font(0.235);
  text(String(v.hr), right, 0.385, "right");

  // SpO2.
  label("SpO₂", "%", 0.48, cyan);
  limits("100", "90", 0.59, cyan);
  ctx.fillStyle = css(cyan);
  font(0.2);
  text(String(v.spo2), right, 0.665, "right");

  // Blood pressure.
  ctx.fillStyle = "#e8edf2";
  font(0.04, "bold");
  text("NIBP", NUM_X0 + 0.018, 0.735);
  ctx.fillStyle = "#9aa6b2";
  font(0.03);
  text("mmHg  Auto 5 min", NUM_X0 + 0.018, 0.772);
  ctx.fillStyle = "#e8edf2";
  font(0.085);
  text(`${String(v.sys)}/${String(v.dia)}`, right - 0.065, 0.85, "right");
  font(0.045);
  ctx.fillStyle = "#b8c2cc";
  text(`(${String(v.map)})`, right, 0.85, "right");

  // Breathing rate.
  label("RR", "rpm", 0.915, yellow);
  ctx.fillStyle = css(yellow);
  font(0.1);
  text(String(v.rr), right, 0.97, "right");
}

/** The care board's printed heading. */
export const BOARD_HEADING = "MY CARE TODAY";
/** Share of the board's height the printed heading's band takes. */
export const BOARD_BAND = 0.2;

/**
 * Draws the care board's ink at `w` x `h` pixels on black, one ink per
 * channel for the shader to colour: red is blue marker, green is red marker
 * (the first line), blue is the printed heading's band with its letters
 * knocked out. Each line is sized to fit the board.
 */
export function drawBoard(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  const band = BOARD_BAND * h;
  ctx.fillStyle = "#00f";
  ctx.fillRect(0, 0, w, band);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${String(Math.max(1, band * 0.55))}px ${SANS}`;
  ctx.fillText(BOARD_HEADING, w / 2, band * 0.54, w * 0.9);

  const lines = text.split("\n").map((l) => l.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return;
  }
  ctx.globalCompositeOperation = "lighter";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const rows = Math.max(lines.length, 3);
  const pitch = (h - band) / (rows + 0.35);
  const left = w * 0.07;
  const room = w * 0.86;
  lines.forEach((line, i) => {
    let size = pitch * 0.78;
    ctx.font = `${String(size)}px ${HAND}`;
    // Typed loosely: the tests' fake 2D context returns undefined from every method.
    const metrics = ctx.measureText(line) as TextMetrics | undefined;
    const width = metrics?.width;
    if (typeof width === "number" && width > room) {
      size *= room / width;
      ctx.font = `${String(size)}px ${HAND}`;
    }
    ctx.fillStyle = i === 0 ? "#0f0" : "#f00";
    ctx.fillText(line, left, band + pitch * (i + 0.95));
  });
  ctx.globalCompositeOperation = "source-over";
}
