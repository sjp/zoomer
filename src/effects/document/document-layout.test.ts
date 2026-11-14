import { describe, expect, it } from "vitest";
import { tweenPeakPxPerFrame } from "../charts";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import {
  caretLine,
  type DocLayout,
  layoutDocument,
  maxScroll,
  type Measure,
  pageAt,
  pageGeometry,
  pageTop,
  type ScreenLayout,
  screenLayout,
  scrollSeconds,
  scrollTarget,
  settledScroll,
  ZOOM_MARGINS,
  ZOOM_PAGE,
} from "./document-layout";
import { createDoc, type Doc } from "./document-sim";

/** Half an em per character, like a narrow proportional font. */
const measureFor =
  (fontPx: Float64Array): Measure =>
  (text, style) =>
    Array.from(text).length * fontPx[style] * 0.5;

const SIZES = [
  [1920, 1080],
  [1440, 1080],
  [3840, 2160],
  [1280, 720],
] as const;
const ZOOMS = [ZOOM_PAGE, ZOOM_MARGINS];

function build(seed: number, w: number, h: number, zoom: number) {
  const doc = createDoc(seed, 0, "Quarterly Report");
  const scale = h / 1080;
  const g = pageGeometry(scale, zoom);
  const L = layoutDocument(doc, g, measureFor(g.fontPx));
  const S = screenLayout(w, h, scale, g);
  return { doc, g, L, S, scale };
}

const cases = SIZES.flatMap(([w, h]) => ZOOMS.map((z) => [w, h, z] as const));

describe("layoutDocument", () => {
  it.each(cases)("keeps every line inside a page's text area at %d x %d, zoom %d", (w, h, z) => {
    const { doc, g, L } = build(3, w, h, z);
    const measure = measureFor(g.fontPx);
    for (let i = 0; i < L.lineCount; i++) {
      const p = pageAt(g, L.lineY[i]);
      expect(L.lineY[i]).toBeGreaterThanOrEqual(pageTop(g, p) + g.margin);
      expect(L.lineY[i] + L.lineH[i]).toBeLessThanOrEqual(pageTop(g, p) + g.pageH - g.margin + 1);
      expect(Number.isInteger(L.lineY[i])).toBe(true);
      const text = doc.segments[L.lineSeg[i]].text.slice(L.lineStart[i], L.lineEnd[i]);
      expect(text.length).toBeGreaterThan(0);
      // Only a single over-long word may overflow its line.
      expect(!text.includes(" ") || measure(text, L.lineStyle[i]) <= L.lineW[i] + 0.01).toBe(true);
    }
  });

  it("covers every character of every segment, in order", () => {
    const { doc, L } = build(8, 1920, 1080, ZOOM_PAGE);
    for (let s = 0; s < doc.segments.length; s++) {
      const text = doc.segments[s].text;
      const parts: string[] = [];
      for (let i = L.segLine[s]; i < L.segLine[s] + L.segLines[s]; i++) {
        expect(L.lineSeg[i]).toBe(s);
        parts.push(text.slice(L.lineStart[i], L.lineEnd[i]));
      }
      expect(parts.join(" ")).toBe(text);
    }
    for (let i = 1; i < L.lineCount; i++) {
      expect(L.lineY[i]).toBeGreaterThanOrEqual(L.lineY[i - 1]);
    }
  });

  it("runs over several pages and stacks comments without overlap", () => {
    const { L } = build(1, 1920, 1080, ZOOM_PAGE);
    expect(L.pages).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < L.comments.length; i++) {
      expect(L.comments[i].y).toBeGreaterThanOrEqual(L.comments[i - 1].y + L.comments[i - 1].h);
    }
    for (const c of L.comments) {
      expect(c.y).toBeGreaterThanOrEqual(c.anchor);
    }
  });

  it("puts the caret on the line holding the next character", () => {
    const { doc, L } = build(2, 1920, 1080, ZOOM_PAGE);
    const s = doc.segments.findIndex((x, i) => L.segLines[i] > 2 && x.text.length > 0);
    const second = L.segLine[s] + 1;
    expect(caretLine(L, s, 0)).toBe(L.segLine[s]);
    expect(caretLine(L, s, L.lineStart[second] - 1)).toBe(L.segLine[s]);
    expect(caretLine(L, s, L.lineStart[second])).toBe(second);
  });
});

/** Every scroll step a typist makes from the top to the end of `doc`. */
function scrollSteps(doc: Doc, L: DocLayout, S: ScreenLayout): [number, number][] {
  const steps: [number, number][] = [];
  let scroll = S.minScroll;
  for (let s = 0; s < doc.segments.length; s++) {
    for (let i = L.segLine[s]; i < L.segLine[s] + L.segLines[s]; i++) {
      for (;;) {
        const next = scrollTarget(L, S, scroll, i);
        if (next === scroll) {
          break;
        }
        steps.push([scroll, next]);
        scroll = next;
      }
      // The caret's line is in view once the steps settle.
      expect(L.lineY[i]).toBeGreaterThanOrEqual(scroll);
      expect(L.lineY[i] + L.lineH[i]).toBeLessThanOrEqual(scroll + S.viewH);
    }
  }
  return steps;
}

describe("scrolling", () => {
  it.each(cases)(
    "steps land on a whole line and stop at the end at %d x %d, zoom %d",
    (w, h, z) => {
      const { doc, L, S, g } = build(5, w, h, z);
      const steps = scrollSteps(doc, L, S);
      expect(steps.length).toBeGreaterThan(2);
      const tops = new Set(Array.from(L.lineY, (y) => y - g.lineH[2]));
      for (const [from, to] of steps) {
        expect(to).toBeGreaterThan(from);
        expect(to - from).toBeLessThanOrEqual(S.maxStep);
        expect(to).toBeLessThanOrEqual(maxScroll(L, S));
        expect(tops.has(to)).toBe(true);
      }
    },
  );

  it.each(cases)("moves text within the codec motion limits at %d x %d, zoom %d", (w, h, z) => {
    const { doc, L, S, scale } = build(5, w, h, z);
    for (const [from, to] of scrollSteps(doc, L, S)) {
      const px = to - from;
      expect(tweenPeakPxPerFrame(px / scale, scrollSeconds(px, scale))).toBeLessThanOrEqual(
        MAX_FEATURE_PX_PER_FRAME + 1e-9,
      );
    }
    expect(scrollSeconds(S.maxStep, scale)).toBeLessThan(4);
  });

  it("settles straight to a view showing a caret far down", () => {
    const { L, S } = build(5, 1920, 1080, ZOOM_PAGE);
    const line = Math.floor(L.lineCount * 0.6);
    const scroll = settledScroll(L, S, line);
    expect(L.lineY[line]).toBeGreaterThanOrEqual(scroll);
    expect(L.lineY[line] + L.lineH[line]).toBeLessThanOrEqual(scroll + S.viewH);
    expect(settledScroll(L, S, 0)).toBe(S.minScroll);
  });

  it.each(SIZES)(
    "keeps the page's text and (where there is room) the comment pane on screen at %d x %d",
    (w, h) => {
      for (const z of ZOOMS) {
        const { g, S } = build(1, w, h, z);
        expect(S.pageX + g.margin).toBeGreaterThan(0);
        const roomy = z === ZOOM_PAGE || w / h >= 16 / 9;
        expect(!roomy || S.paneX + g.commentW <= w).toBe(true);
        expect(z !== ZOOM_PAGE || S.pageX > 0).toBe(true);
      }
    },
  );
});
