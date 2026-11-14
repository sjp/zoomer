/**
 * The Document Page's made-up report and the off-screen writer typing it.
 *
 * A document is a list of blocks (a title, section headings, paragraphs, bullet
 * lists and small tables), each made of one or more segments: the strings the
 * writer types one after another (a paragraph is one segment, a list one per
 * item, a table one per cell). Body text is pseudo-Latin built from a word list,
 * so it reads as prose from across the room without anyone reading it; headings,
 * table labels and comments are short and generic.
 *
 * The typist steps through the segments a character at a time at the `speed`
 * param, with natural pauses: a little jitter between letters, longer after
 * commas and full stops, and a breath at the end of each segment. Now and then a
 * finished word gets a spelling squiggle that fades a moment later, or the typist
 * stops on a squiggled word, backspaces it and types it again. Stepping
 * allocates nothing; a document is built once per variation, title or new draft.
 */
import { createRng, hash32 } from "../noise";

export const BLOCK_TITLE = 0;
export const BLOCK_HEADING = 1;
const BLOCK_PARAGRAPH = 2;
export const BLOCK_BULLETS = 3;
export const BLOCK_TABLE = 4;

/** A string typed in one go: a paragraph, a list item, a table cell. */
interface Segment {
  readonly block: number;
  readonly text: string;
  /** Words in `text`. */
  readonly words: number;
  /** A table cell's row (0 is the header) and column; -1 elsewhere. */
  readonly row: number;
  readonly col: number;
}

interface DocComment {
  /** Index into `AUTHORS`. */
  readonly author: number;
  readonly text: string;
}

interface Block {
  readonly kind: number;
  readonly firstSeg: number;
  readonly segCount: number;
  /** A table's rows (header included) and columns; 0 elsewhere. */
  readonly rows: number;
  readonly cols: number;
  /** A margin comment that shows once the block is typed, or null. */
  readonly comment: DocComment | null;
}

export interface Doc {
  readonly seed: number;
  /** Which draft this is: each finished document is followed by the next. */
  readonly generation: number;
  readonly title: string;
  readonly blocks: readonly Block[];
  readonly segments: readonly Segment[];
  /** Words in the segments before each one; one more entry than segments, ending in the total. */
  readonly wordsBefore: Int32Array;
}

/** Comment authors' names, shown above each comment. */
export const AUTHORS = ["Alex M.", "Sam R.", "Jordan K."] as const;

/** Title used when the title param is blank. */
export const UNTITLED = "Untitled document";

const LATIN = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "ex",
  "ea",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "in",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "non",
  "proident",
  "sunt",
  "culpa",
  "qui",
  "officia",
  "deserunt",
  "mollit",
  "anim",
  "id",
  "est",
  "laborum",
  "pellentesque",
  "habitant",
  "morbi",
  "tristique",
  "senectus",
  "netus",
  "malesuada",
  "fames",
  "turpis",
  "egestas",
  "vestibulum",
  "ante",
  "primis",
  "faucibus",
  "orci",
  "luctus",
  "ultrices",
  "posuere",
  "cubilia",
  "curae",
  "donec",
  "vitae",
  "mauris",
  "viverra",
  "accumsan",
  "lacus",
  "vel",
  "facilisis",
  "volutpat",
  "blandit",
  "cursus",
  "risus",
  "ultricies",
  "tortor",
] as const;

const HEADINGS = [
  "Summary",
  "Background",
  "Objectives",
  "Approach",
  "Findings",
  "Results",
  "Discussion",
  "Risks",
  "Timeline",
  "Budget",
  "Next steps",
  "Recommendations",
  "Outlook",
  "Scope",
  "Methods",
  "Key figures",
] as const;

const TABLE_LABELS = [
  "North",
  "South",
  "East",
  "West",
  "Central",
  "Online",
  "Phase 1",
  "Phase 2",
  "Phase 3",
  "Team A",
  "Team B",
  "Team C",
] as const;

const TABLE_HEADS = [
  ["Region", "Q1", "Q2", "Change"],
  ["Item", "Plan", "Actual", "Variance"],
  ["Stage", "Start", "End", "Status"],
] as const;

const STATUS_WORDS = ["Done", "On track", "Pending", "Review"] as const;

const COMMENTS = [
  "Can we add a source here?",
  "Shorten this paragraph?",
  "Check these figures",
  "Agreed, keep this",
  "Move this to the summary?",
  "Needs a chart",
  "Reword the opening",
  "Nice, very clear",
  "Confirm with finance",
  "Add last year for comparison",
  "Is this still current?",
  "Expand a little?",
] as const;

/** The UTF-16 code unit's value at `i` (0 past the end). */
const code = (s: string, i: number): number => s.codePointAt(i) ?? 0;

const pick = <T>(rng: () => number, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const between = (rng: () => number, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));

/** Words in `s`: runs of non-space characters. */
export function countWords(s: string, end = s.length): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < end; i++) {
    const space = code(s, i) === 32;
    if (!space && !inWord) {
      n++;
    }
    inWord = !space;
  }
  return n;
}

function sentence(rng: () => number): string {
  const n = between(rng, 6, 15);
  let s = "";
  for (let i = 0; i < n; i++) {
    let w: string = pick(rng, LATIN);
    if (i === 0) {
      w = w[0].toUpperCase() + w.slice(1);
    }
    s += (i > 0 ? " " : "") + w;
    if (i > 1 && i < n - 2 && rng() < 0.1) {
      s += ",";
    }
  }
  return s + ".";
}

function paragraph(rng: () => number, sentences: number): string {
  let s = "";
  for (let i = 0; i < sentences; i++) {
    s += (i > 0 ? " " : "") + sentence(rng);
  }
  return s;
}

/** A phrase of `lo`..`hi` words, capitalised, with no full stop: a list item. */
function phrase(rng: () => number, lo: number, hi: number): string {
  const s = sentence(rng);
  const words = s.slice(0, -1).replaceAll(",", "").split(" ");
  return words.slice(0, Math.min(words.length, between(rng, lo, hi))).join(" ");
}

function tableCell(rng: () => number, kind: number, col: number): string {
  if (col === 3) {
    if (kind === 2) {
      return pick(rng, STATUS_WORDS);
    }
    const v = (rng() * 24 - 6).toFixed(1);
    return (v.startsWith("-") ? "" : "+") + v + "%";
  }
  if (kind === 2) {
    return "Wk " + String(between(rng, 1, 52));
  }
  return String(between(rng, 12, 980)) + "." + String(between(rng, 0, 9));
}

/** A table block's segments: a header row, then 2–4 rows of label and three figures. */
function table(rng: () => number): string[][] {
  const kind = Math.floor(rng() * TABLE_HEADS.length);
  const rows: string[][] = [[...TABLE_HEADS[kind]]];
  const n = between(rng, 2, 4);
  const start = Math.floor(rng() * TABLE_LABELS.length);
  for (let r = 0; r < n; r++) {
    const row: string[] = [TABLE_LABELS[(start + r) % TABLE_LABELS.length]];
    for (let c = 1; c < 4; c++) {
      row.push(tableCell(rng, kind, c));
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The document for a seed, draft number and title (blank gives `UNTITLED`). The
 * same inputs always give the same document, and no block or segment is empty.
 */
export function createDoc(seed: number, generation: number, title: string): Doc {
  const rng = createRng(hash32(hash32(Math.floor(seed) + 0x5d0c) ^ Math.floor(generation)));
  const blocks: Block[] = [];
  const segments: Segment[] = [];
  const add = (
    kind: number,
    texts: readonly string[],
    cols: number,
    comment: DocComment | null,
  ) => {
    const b = blocks.length;
    const firstSeg = segments.length;
    texts.forEach((text, i) => {
      segments.push({
        block: b,
        text,
        words: countWords(text),
        row: cols > 0 ? Math.floor(i / cols) : -1,
        col: cols > 0 ? i % cols : -1,
      });
    });
    blocks.push({
      kind,
      firstSeg,
      segCount: texts.length,
      rows: cols > 0 ? texts.length / cols : 0,
      cols,
      comment,
    });
  };
  const maybeComment = (chance: number): DocComment | null =>
    rng() < chance
      ? { author: Math.floor(rng() * AUTHORS.length), text: pick(rng, COMMENTS) }
      : null;

  const trimmed = title.trim();
  const name = trimmed === "" ? UNTITLED : trimmed;
  add(BLOCK_TITLE, [name], 0, null);
  add(BLOCK_PARAGRAPH, [paragraph(rng, between(rng, 2, 3))], 0, maybeComment(0.5));
  const sections = between(rng, 5, 7);
  const headStart = Math.floor(rng() * HEADINGS.length);
  for (let s = 0; s < sections; s++) {
    add(BLOCK_HEADING, [HEADINGS[(headStart + s * 3) % HEADINGS.length]], 0, null);
    const paragraphs = between(rng, 2, 4);
    const extra = rng();
    const extraAt = between(rng, 1, paragraphs - 1);
    for (let p = 0; p < paragraphs; p++) {
      if (p === extraAt && extra < 0.3) {
        const items = between(rng, 3, 5);
        const texts: string[] = [];
        for (let i = 0; i < items; i++) {
          texts.push(phrase(rng, 3, 9));
        }
        add(BLOCK_BULLETS, texts, 0, maybeComment(0.2));
      } else if (p === extraAt && extra < 0.55) {
        add(BLOCK_TABLE, table(rng).flat(), 4, maybeComment(0.3));
      }
      add(BLOCK_PARAGRAPH, [paragraph(rng, between(rng, 3, 6))], 0, maybeComment(0.22));
    }
  }

  const wordsBefore = new Int32Array(segments.length + 1);
  for (let i = 0; i < segments.length; i++) {
    wordsBefore[i + 1] = wordsBefore[i] + segments[i].words;
  }
  return { seed, generation, title: name, blocks, segments, wordsBefore };
}

// ---------------------------------------------------------------------------
// The typist

const PHASE_TYPE = 0;
/** Resting on a squiggled word before backspacing it. */
const PHASE_NOTICE = 1;
export const PHASE_BACKSPACE = 2;
const PHASE_DONE = 3;

/** Squiggles showing at once, at most. */
export const MAX_SQUIGGLES = 6;
/** Seconds a squiggle takes to fade in and out. */
const SQUIGGLE_FADE = 0.25;
/** Seconds a passing squiggle shows before it fades, as if corrected automatically. */
const SQUIGGLE_LIFE = 2.4;

/** Chance a finished word is backspaced and retyped, or just squiggled for a moment. */
const FIX_CHANCE = 0.025;
const SQUIGGLE_CHANCE = 0.02;
/** Shortest word that gets corrected or squiggled. */
const MIN_FIX_LENGTH = 4;
/** Pauses: letter jitter, after punctuation, at a segment's end, before a backspace (s or char times). */
const COMMA_PAUSE = 4;
const STOP_PAUSE = 8;
const SEGMENT_PAUSE = 0.6;
const SEGMENT_CHARS = 8;
const NOTICE_SECONDS = 0.8;
const RETYPE_PAUSE = 0.35;
/** Backspaces run this many times faster than typing. */
const BACKSPACE_RATE = 2.5;
/** Actions taken in one step at most, so a long frame can't run away. */
const MAX_ACTIONS = 64;

export interface Typist {
  readonly rng: () => number;
  phase: number;
  /** The segment being typed and its characters typed so far. */
  seg: number;
  chars: number;
  /** Seconds until the next action. */
  wait: number;
  /** Seconds since the last key. */
  idle: number;
  /** The word being corrected: its first character and end, in the segment. */
  fixFrom: number;
  fixTo: number;
  /** Retyping a corrected word (no new correction until it is done). */
  fixing: boolean;
  /** Words typed so far in the whole document. */
  words: number;
  /** Squiggle slots: segment, character range, age and life (s), and an id (0 = empty). */
  readonly sqSeg: Int32Array;
  readonly sqFrom: Int32Array;
  readonly sqTo: Int32Array;
  readonly sqAge: Float64Array;
  readonly sqLife: Float64Array;
  readonly sqId: Int32Array;
  nextId: number;
}

/** A typist starting at segment `startSeg` (clamped) of `doc`, with everything before it typed. */
export function createTypist(doc: Doc, seed: number, startSeg = 0): Typist {
  const seg = Math.max(0, Math.min(doc.segments.length, Math.floor(startSeg)));
  return {
    rng: createRng(hash32(Math.floor(seed) ^ 0x7e3a1c55) ^ doc.generation),
    phase: seg >= doc.segments.length ? PHASE_DONE : PHASE_TYPE,
    seg,
    chars: 0,
    wait: 0.5,
    idle: 0,
    fixFrom: 0,
    fixTo: 0,
    fixing: false,
    words: doc.wordsBefore[seg],
    sqSeg: new Int32Array(MAX_SQUIGGLES),
    sqFrom: new Int32Array(MAX_SQUIGGLES),
    sqTo: new Int32Array(MAX_SQUIGGLES),
    sqAge: new Float64Array(MAX_SQUIGGLES),
    sqLife: new Float64Array(MAX_SQUIGGLES),
    sqId: new Int32Array(MAX_SQUIGGLES),
    nextId: 1,
  };
}

/**
 * A typist for `doc` at `old`'s place: the same segment (clamped to `doc`, and
 * to the segment's length), for a document rebuilt with another title. Squiggles
 * are dropped.
 */
export function carryTypist(doc: Doc, old: Typist, seed: number): Typist {
  const t = createTypist(doc, seed, old.seg);
  if (t.seg < doc.segments.length && old.seg === t.seg) {
    const text = doc.segments[t.seg].text;
    t.chars = Math.min(old.phase === PHASE_TYPE ? old.chars : old.fixFrom, text.length);
    t.words = doc.wordsBefore[t.seg] + countWords(text, t.chars);
  }
  return t;
}

/** Whether all of `doc` is typed. */
export const typistDone = (t: Typist): boolean => t.phase === PHASE_DONE;

/** Characters typed of segment `seg`: all, some (the current one) or none. */
export function typedChars(doc: Doc, t: Typist, seg: number): number {
  if (seg < t.seg) {
    return doc.segments[seg].text.length;
  }
  return seg === t.seg ? t.chars : 0;
}

/** Whether block `b` is fully typed. */
export const blockTyped = (doc: Doc, t: Typist, b: number): boolean =>
  t.seg >= doc.blocks[b].firstSeg + doc.blocks[b].segCount;

const isSpace = (c: number) => c === 32;
const isLetter = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);

function addSquiggle(t: Typist, from: number, to: number, life: number): void {
  // An empty slot, or else the oldest.
  let slot = 0;
  for (let i = 0; i < MAX_SQUIGGLES; i++) {
    if (t.sqId[i] === 0) {
      slot = i;
      break;
    }
    if (t.sqAge[i] > t.sqAge[slot]) {
      slot = i;
    }
  }
  t.sqSeg[slot] = t.seg;
  t.sqFrom[slot] = from;
  t.sqTo[slot] = to;
  t.sqAge[slot] = 0;
  t.sqLife[slot] = life;
  t.sqId[slot] = t.nextId++;
}

/** Starts fading every squiggle on segment `seg` from character `from` on. */
function dropSquiggles(t: Typist, seg: number, from: number): void {
  for (let i = 0; i < MAX_SQUIGGLES; i++) {
    if (t.sqId[i] !== 0 && t.sqSeg[i] === seg && t.sqTo[i] > from) {
      t.sqLife[i] = Math.min(t.sqLife[i], t.sqAge[i]);
    }
  }
}

/** Squiggle `i`'s opacity, 0 for an empty slot. */
export function squiggleAlpha(t: Typist, i: number): number {
  if (t.sqId[i] === 0) {
    return 0;
  }
  const age = t.sqAge[i];
  const fadeIn = Math.min(1, age / SQUIGGLE_FADE);
  const fadeOut = 1 - Math.min(1, Math.max(0, age - t.sqLife[i]) / SQUIGGLE_FADE);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}

/** Seconds to wait after typing `c`, at `base` seconds per character. */
function charDelay(t: Typist, c: number, base: number): number {
  if (c === 44 || c === 59) {
    return base * COMMA_PAUSE;
  }
  if (c === 46) {
    return base * STOP_PAUSE;
  }
  return base * (0.55 + 0.9 * t.rng());
}

/** Types one character, or moves to the next segment; returns the wait after it. */
function typeOne(doc: Doc, t: Typist, base: number): number {
  const text = doc.segments[t.seg].text;
  if (t.chars >= text.length) {
    t.seg++;
    t.chars = 0;
    t.fixing = false;
    if (t.seg >= doc.segments.length) {
      t.phase = PHASE_DONE;
    }
    return 0;
  }
  const c = code(text, t.chars);
  if (!isSpace(c) && (t.chars === 0 || isSpace(code(text, t.chars - 1)))) {
    t.words++;
  }
  t.chars++;
  t.idle = 0;
  if (t.chars >= text.length) {
    return SEGMENT_PAUSE + base * SEGMENT_CHARS;
  }
  if (t.fixing && t.chars >= t.fixTo) {
    t.fixing = false;
  } else if (!t.fixing && isLetter(c) && !isLetter(code(text, t.chars))) {
    // A word just ended: maybe squiggle it, and maybe go back and retype it.
    const kind = doc.blocks[doc.segments[t.seg].block].kind;
    let from = t.chars - 1;
    while (from > 0 && isLetter(code(text, from - 1))) {
      from--;
    }
    if (
      (kind === BLOCK_PARAGRAPH || kind === BLOCK_BULLETS) &&
      t.chars - from >= MIN_FIX_LENGTH &&
      (from === 0 || isSpace(code(text, from - 1)))
    ) {
      const roll = t.rng();
      if (roll < FIX_CHANCE) {
        addSquiggle(t, from, t.chars, Infinity);
        t.phase = PHASE_NOTICE;
        t.fixFrom = from;
        t.fixTo = t.chars;
        return NOTICE_SECONDS;
      }
      if (roll < FIX_CHANCE + SQUIGGLE_CHANCE) {
        addSquiggle(t, from, t.chars, SQUIGGLE_LIFE);
      }
    }
  }
  return charDelay(t, c, base);
}

/** Takes one action; returns the seconds to wait before the next. */
function act(doc: Doc, t: Typist, base: number): number {
  switch (t.phase) {
    case PHASE_TYPE:
      return typeOne(doc, t, base);
    case PHASE_NOTICE:
      dropSquiggles(t, t.seg, t.fixFrom);
      t.phase = PHASE_BACKSPACE;
      return base / BACKSPACE_RATE;
    case PHASE_BACKSPACE: {
      const text = doc.segments[t.seg].text;
      t.chars--;
      t.idle = 0;
      if (t.chars === 0 || isSpace(code(text, t.chars - 1))) {
        t.words--;
      }
      if (t.chars <= t.fixFrom) {
        t.phase = PHASE_TYPE;
        t.fixing = true;
        return RETYPE_PAUSE;
      }
      return (base / BACKSPACE_RATE) * (0.7 + 0.6 * t.rng());
    }
    default:
      return Infinity;
  }
}

/** Advances the typist by `dt` seconds at `speed` characters a second. */
export function stepTypist(doc: Doc, t: Typist, dt: number, speed: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const base = 1 / Math.max(0.5, Number.isFinite(speed) ? speed : 8);
  t.idle += step;
  t.wait -= step;
  for (let n = 0; n < MAX_ACTIONS && t.wait <= 0 && t.phase !== PHASE_DONE; n++) {
    t.wait += act(doc, t, base);
  }
  if (t.phase === PHASE_DONE) {
    t.wait = 0;
  }
  for (let i = 0; i < MAX_SQUIGGLES; i++) {
    if (t.sqId[i] !== 0) {
      t.sqAge[i] += step;
      if (t.sqAge[i] > t.sqLife[i] + SQUIGGLE_FADE) {
        t.sqId[i] = 0;
      }
    }
  }
}

/**
 * Where a typist joins a document already under way: the first segment of a
 * paragraph a tenth to a fifth of the way in, so the first frame shows a
 * page part-written rather than a blank one.
 */
export function startSegment(doc: Doc, seed: number): number {
  const f = 0.08 + 0.1 * (hash32(Math.floor(seed) ^ 0x2b1d) / 4294967296);
  const want = Math.floor(doc.segments.length * f);
  for (const block of doc.blocks) {
    if (block.kind === BLOCK_PARAGRAPH && block.firstSeg >= want) {
      return block.firstSeg;
    }
  }
  return 0;
}
