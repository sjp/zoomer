/**
 * The stream overlays' own emotes: sixteen little round faces and symbols in
 * flat colours with a dark outline, so they read on any scene and at any size
 * from a chat line's 20 px to a 128 px sprite. All original designs.
 *
 * `paintEmote` draws one into a square at the origin: chat draws them inline
 * on the panel canvas, and sprite overlays paint them into the shared atlas
 * (`reserveSprites(EMOTE_IDS.length, paintEmote)`). Chat text refers to one
 * as `:id:`, such as `:heart:`.
 */
import { SANS_FONT_STACK } from "../canvas-texture";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Every emote's id, in atlas order. */
export const EMOTE_IDS = [
  "happy",
  "laugh",
  "wow",
  "hearteyes",
  "cool",
  "sleepy",
  "lol",
  "heart",
  "star",
  "fire",
  "trophy",
  "gg",
  "wave",
  "cat",
  "ghost",
  "party",
] as const;

type EmoteId = (typeof EMOTE_IDS)[number];

/** The index of the emote called `id`, or -1. */
export function emoteIndex(id: string): number {
  return (EMOTE_IDS as readonly string[]).indexOf(id);
}

/** Colours, shared by the designs. */
const OUTLINE = "#2a1f33";
const FACE = "#ffcc4d";
const FACE_SHADE = "#f2a93b";
const RED = "#ff5a6e";
const MOUTH = "#5a2333";
const TEAR = "#6ec8ff";
const WHITE = "#ffffff";
const GOLD = "#ffc23d";
const ORANGE = "#ff8a3d";

/** Outline width, in the 128-unit design space. */
const LINE = 6;

function stroke(ctx: Ctx, width = LINE) {
  ctx.lineWidth = width;
  ctx.strokeStyle = OUTLINE;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

function fillStroke(ctx: Ctx, fill: string, width = LINE) {
  ctx.fillStyle = fill;
  ctx.fill();
  stroke(ctx, width);
}

function circle(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/** The round face most emotes are built on, with a soft shade along its bottom. */
function face(ctx: Ctx, fill = FACE) {
  circle(ctx, 64, 66, 54);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.save();
  ctx.clip();
  circle(ctx, 64, 30, 72);
  ctx.rect(0, 0, 128, 128);
  ctx.fillStyle = FACE_SHADE;
  ctx.globalAlpha = 0.35;
  ctx.fill("evenodd");
  ctx.restore();
  circle(ctx, 64, 66, 54);
  stroke(ctx);
}

function dotEyes(ctx: Ctx, y = 56, r = 7) {
  ctx.fillStyle = OUTLINE;
  circle(ctx, 46, y, r);
  ctx.fill();
  circle(ctx, 82, y, r);
  ctx.fill();
}

/** Eyes shut in a happy curve (`^ ^`), or a sleepy one with `down`. */
function shutEyes(ctx: Ctx, y = 56, down = false) {
  for (const x of [46, 82]) {
    ctx.beginPath();
    if (down) {
      ctx.arc(x, y - 4, 10, 0.15 * Math.PI, 0.85 * Math.PI);
    } else {
      ctx.arc(x, y + 6, 10, 1.15 * Math.PI, 1.85 * Math.PI);
    }
    stroke(ctx);
  }
}

function smile(ctx: Ctx, y = 74, r = 22) {
  ctx.beginPath();
  ctx.arc(64, y, r, 0.2 * Math.PI, 0.8 * Math.PI);
  stroke(ctx);
}

/** A wide open laughing mouth with a tongue. */
function openMouth(ctx: Ctx) {
  ctx.beginPath();
  ctx.moveTo(36, 76);
  ctx.lineTo(92, 76);
  ctx.arc(64, 76, 28, 0, Math.PI);
  ctx.closePath();
  ctx.fillStyle = MOUTH;
  ctx.fill();
  ctx.save();
  ctx.clip();
  circle(ctx, 64, 108, 16);
  ctx.fillStyle = RED;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(36, 76);
  ctx.lineTo(92, 76);
  ctx.arc(64, 76, 28, 0, Math.PI);
  ctx.closePath();
  stroke(ctx);
}

/** A heart centred on (`x`, `y`), `s` wide. */
function heartPath(ctx: Ctx, x: number, y: number, s: number) {
  const k = s / 100;
  ctx.beginPath();
  ctx.moveTo(x, y + 38 * k);
  ctx.bezierCurveTo(x - 60 * k, y - 2 * k, x - 44 * k, y - 52 * k, x, y - 26 * k);
  ctx.bezierCurveTo(x + 44 * k, y - 52 * k, x + 60 * k, y - 2 * k, x, y + 38 * k);
  ctx.closePath();
}

/** A five-pointed star centred on (`x`, `y`), outer radius `r`. */
function starPath(ctx: Ctx, x: number, y: number, r: number, inner = 0.45) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * inner;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

const DESIGNS: Record<EmoteId, (ctx: Ctx) => void> = {
  happy(ctx) {
    face(ctx);
    dotEyes(ctx);
    smile(ctx);
  },
  laugh(ctx) {
    face(ctx);
    shutEyes(ctx, 50);
    openMouth(ctx);
  },
  wow(ctx) {
    face(ctx);
    for (const x of [46, 82]) {
      circle(ctx, x, 52, 12);
      fillStroke(ctx, WHITE, 5);
      circle(ctx, x, 54, 6);
      ctx.fillStyle = OUTLINE;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(64, 90, 11, 14, 0, 0, Math.PI * 2);
    fillStroke(ctx, MOUTH);
  },
  hearteyes(ctx) {
    face(ctx);
    for (const x of [44, 84]) {
      heartPath(ctx, x, 54, 34);
      fillStroke(ctx, RED, 4);
    }
    smile(ctx, 76, 20);
  },
  cool(ctx) {
    face(ctx);
    // Shades: two lenses on a bar.
    ctx.beginPath();
    ctx.moveTo(18, 48);
    ctx.lineTo(110, 48);
    stroke(ctx, 8);
    for (const x of [44, 84]) {
      ctx.beginPath();
      ctx.roundRect(x - 20, 44, 40, 24, [4, 4, 14, 14]);
      fillStroke(ctx, OUTLINE, 4);
      ctx.beginPath();
      ctx.moveTo(x - 12, 52);
      ctx.lineTo(x - 4, 52);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.stroke();
    }
    // A sideways smirk.
    ctx.beginPath();
    ctx.moveTo(48, 90);
    ctx.quadraticCurveTo(70, 98, 88, 82);
    stroke(ctx);
  },
  sleepy(ctx) {
    face(ctx, "#ffe08a");
    shutEyes(ctx, 62, true);
    circle(ctx, 64, 90, 6);
    fillStroke(ctx, MOUTH, 4);
    // A small "z" drifting off.
    ctx.beginPath();
    ctx.moveTo(92, 12);
    ctx.lineTo(112, 12);
    ctx.lineTo(92, 32);
    ctx.lineTo(112, 32);
    ctx.lineWidth = 12;
    ctx.strokeStyle = OUTLINE;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.lineWidth = 5;
    ctx.strokeStyle = WHITE;
    ctx.stroke();
  },
  lol(ctx) {
    face(ctx);
    shutEyes(ctx, 50);
    openMouth(ctx);
    // Happy tears.
    for (const dir of [-1, 1]) {
      const x = 64 + dir * 50;
      ctx.beginPath();
      ctx.moveTo(x - dir * 10, 50);
      ctx.quadraticCurveTo(x + dir * 14, 62, x + dir * 6, 78);
      ctx.quadraticCurveTo(x - dir * 6, 80, x - dir * 10, 50);
      ctx.closePath();
      fillStroke(ctx, TEAR, 4);
    }
  },
  heart(ctx) {
    heartPath(ctx, 64, 66, 108);
    fillStroke(ctx, RED);
    // A highlight.
    ctx.beginPath();
    ctx.ellipse(40, 46, 10, 6, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fill();
  },
  star(ctx) {
    starPath(ctx, 64, 68, 58);
    fillStroke(ctx, GOLD);
    dotEyes(ctx, 66, 5);
  },
  fire(ctx) {
    ctx.beginPath();
    ctx.moveTo(64, 120);
    ctx.bezierCurveTo(22, 120, 14, 84, 30, 58);
    ctx.bezierCurveTo(36, 72, 42, 76, 48, 76);
    ctx.bezierCurveTo(40, 46, 56, 22, 70, 8);
    ctx.bezierCurveTo(72, 34, 104, 48, 104, 84);
    ctx.bezierCurveTo(104, 106, 88, 120, 64, 120);
    ctx.closePath();
    fillStroke(ctx, ORANGE);
    ctx.beginPath();
    ctx.moveTo(64, 114);
    ctx.bezierCurveTo(46, 114, 40, 98, 48, 84);
    ctx.bezierCurveTo(54, 92, 58, 90, 60, 88);
    ctx.bezierCurveTo(58, 72, 66, 60, 74, 54);
    ctx.bezierCurveTo(74, 70, 88, 80, 86, 96);
    ctx.bezierCurveTo(84, 108, 76, 114, 64, 114);
    ctx.closePath();
    ctx.fillStyle = "#ffd94d";
    ctx.fill();
  },
  trophy(ctx) {
    // Handles behind the cup.
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(64 + dir * 38, 40, 16, 0, Math.PI * 2);
      stroke(ctx, 8);
    }
    ctx.beginPath();
    ctx.moveTo(28, 18);
    ctx.lineTo(100, 18);
    ctx.lineTo(96, 52);
    ctx.quadraticCurveTo(90, 80, 64, 82);
    ctx.quadraticCurveTo(38, 80, 32, 52);
    ctx.closePath();
    fillStroke(ctx, GOLD);
    ctx.beginPath();
    ctx.rect(56, 82, 16, 16);
    fillStroke(ctx, GOLD);
    ctx.beginPath();
    ctx.roundRect(36, 98, 56, 18, 4);
    fillStroke(ctx, "#b07a3c");
    starPath(ctx, 64, 46, 16);
    ctx.fillStyle = WHITE;
    ctx.fill();
  },
  gg(ctx) {
    ctx.beginPath();
    ctx.roundRect(10, 16, 108, 76, 22);
    ctx.moveTo(36, 90);
    ctx.lineTo(30, 116);
    ctx.lineTo(60, 90);
    fillStroke(ctx, WHITE);
    // Cover the outline where the tail meets the bubble.
    ctx.beginPath();
    ctx.rect(34, 84, 24, 6);
    ctx.fillStyle = WHITE;
    ctx.fill();
    ctx.fillStyle = OUTLINE;
    ctx.font = `900 50px ${SANS_FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GG", 64, 56);
  },
  wave(ctx) {
    ctx.save();
    ctx.translate(64, 70);
    ctx.rotate(-0.25);
    // Fingers, then the palm over their roots, then the thumb.
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.roundRect(-34 + i * 17, -54, 15, 56 - Math.abs(i - 1.3) * 7, 8);
      fillStroke(ctx, FACE, 5);
    }
    ctx.beginPath();
    ctx.roundRect(-36, -14, 70, 60, 22);
    fillStroke(ctx, FACE, 5);
    ctx.save();
    ctx.translate(32, 8);
    ctx.rotate(0.6);
    ctx.translate(-32, -8);
    ctx.beginPath();
    ctx.roundRect(24, -14, 16, 40, 8);
    fillStroke(ctx, FACE, 5);
    ctx.restore();
    ctx.restore();
    // Motion marks.
    for (const [x0, y0, x1, y1] of [
      [10, 34, 18, 46],
      [8, 58, 16, 66],
      [108, 24, 116, 36],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      stroke(ctx, 5);
    }
  },
  cat(ctx) {
    const fur = "#ffa95c";
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(64 + dir * 50, 56);
      ctx.lineTo(64 + dir * 46, 10);
      ctx.lineTo(64 + dir * 14, 26);
      ctx.closePath();
      fillStroke(ctx, fur);
    }
    ctx.beginPath();
    ctx.ellipse(64, 70, 54, 48, 0, 0, Math.PI * 2);
    fillStroke(ctx, fur);
    dotEyes(ctx, 64, 7);
    // Nose and mouth.
    ctx.beginPath();
    ctx.moveTo(58, 78);
    ctx.lineTo(70, 78);
    ctx.lineTo(64, 85);
    ctx.closePath();
    fillStroke(ctx, "#ff7a8a", 3);
    ctx.beginPath();
    ctx.moveTo(64, 86);
    ctx.quadraticCurveTo(58, 96, 50, 90);
    ctx.moveTo(64, 86);
    ctx.quadraticCurveTo(70, 96, 78, 90);
    stroke(ctx, 4);
    // Whiskers.
    for (const dir of [-1, 1]) {
      for (const dy of [-4, 6]) {
        ctx.beginPath();
        ctx.moveTo(64 + dir * 26, 84 + dy / 2);
        ctx.lineTo(64 + dir * 50, 80 + dy);
        stroke(ctx, 3);
      }
    }
  },
  ghost(ctx) {
    ctx.beginPath();
    ctx.moveTo(18, 116);
    ctx.lineTo(18, 60);
    ctx.arc(64, 60, 46, Math.PI, 0);
    ctx.lineTo(110, 116);
    // A wavy hem.
    for (let i = 0; i < 4; i++) {
      const x = 110 - i * 23;
      ctx.quadraticCurveTo(x - 6, 100, x - 11.5, 108);
      ctx.quadraticCurveTo(x - 17, 118, x - 23, 116);
    }
    ctx.closePath();
    fillStroke(ctx, "#f4f2ff");
    for (const x of [48, 80]) {
      ctx.beginPath();
      ctx.ellipse(x, 58, 8, 11, 0, 0, Math.PI * 2);
      ctx.fillStyle = OUTLINE;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(64, 84, 8, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
  },
  party(ctx) {
    ctx.save();
    ctx.translate(0, 8);
    ctx.scale(0.94, 0.88);
    ctx.translate(4, 10);
    face(ctx);
    dotEyes(ctx);
    smile(ctx);
    ctx.restore();
    // A striped hat, tipped to one side, with a pompom.
    ctx.save();
    ctx.translate(76, 26);
    ctx.rotate(0.35);
    ctx.beginPath();
    ctx.moveTo(-22, 16);
    ctx.lineTo(0, -26);
    ctx.lineTo(22, 16);
    ctx.closePath();
    ctx.fillStyle = "#7f9cff";
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "#ff8cc6";
    for (const y of [-14, 2]) {
      ctx.fillRect(-30, y, 60, 7);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(-22, 16);
    ctx.lineTo(0, -26);
    ctx.lineTo(22, 16);
    ctx.closePath();
    stroke(ctx, 5);
    circle(ctx, 0, -28, 8);
    fillStroke(ctx, GOLD, 4);
    ctx.restore();
  },
};

/**
 * Paints emote `index` (into `EMOTE_IDS`, wrapped) filling a `size`-pixel
 * square at the origin. Leaves the context's state as it found it.
 */
export function paintEmote(ctx: Ctx, index: number, size: number): void {
  const n = EMOTE_IDS.length;
  const id = EMOTE_IDS[((Math.floor(index) % n) + n) % n];
  ctx.save();
  ctx.scale(size / 128, size / 128);
  DESIGNS[id](ctx);
  ctx.restore();
}
