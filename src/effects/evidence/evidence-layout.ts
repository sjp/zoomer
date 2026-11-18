/**
 * Detective Evidence Board's layout and its pure logic: where the title card
 * and each pinned item go, their pins, the red-string graph between them, and
 * the schedule by which the case grows (a new card and its string every minute
 * or two, then, once the board is full, the oldest added ones taken down).
 *
 * Positions are fractions of the frame (`u` right, `v` down, 0..1); sizes are in
 * board units, frame heights at 16:9 (`height * fitScale(aspect)` pixels). The
 * layout is checked in design units, the 16:9 frame with x = u * DESIGN_W and
 * y = v: any other aspect spreads the positions at least as far apart as that
 * relative to the items' sizes, so what doesn't overlap at 16:9 doesn't
 * overlap anywhere.
 *
 * Every item draws from its own random stream, so the layout of item `i`
 * depends only on items before it: a density change adds or removes items at
 * the end and leaves the rest where they were.
 */
import { EASE_PEAK, MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { createRng, hash32 } from "../noise";

/** The design frame's width in board units (its height is 1). */
const DESIGN_W = 16 / 9;

/** Items laid out: the most the density slider pins up. */
export const MAX_DENSITY = 30;
/** How many items the board ever holds, added cards included. */
export const MAX_ITEMS = 40;
/** Most cards the growing case adds at once: enough to fill the board from the slider's lowest, 15. */
export const MAX_ADDED = 25;

/** Strings a pin takes from the board as laid out, and from the growing case. */
const MAX_BASE_STRINGS = 3;
/** The most strings any pin ever holds. */
export const MAX_PIN_STRINGS = MAX_BASE_STRINGS + 1;

export const KIND_PHOTO = 0;
export const KIND_POLAROID = 1;
export const KIND_INDEX = 2;
export const KIND_STICKY = 3;
export const KIND_CLIPPING = 4;
export const KIND_MAP = 5;
export const KIND_TITLE = 6;
type ItemKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Half sizes per kind (board units), before a clipping's own height. */
const HALF_SIZES: Readonly<Record<ItemKind, readonly [number, number]>> = {
  [KIND_PHOTO]: [0.075, 0.053],
  [KIND_POLAROID]: [0.057, 0.069],
  [KIND_INDEX]: [0.078, 0.048],
  [KIND_STICKY]: [0.043, 0.043],
  [KIND_CLIPPING]: [0.06, 0.08],
  [KIND_MAP]: [0.1, 0.075],
  [KIND_TITLE]: [0.17, 0.05],
};

/** Largest half size of anything the growing case adds (index cards and sticky notes). */
export const ADDED_HALF: readonly [number, number] = [
  Math.max(HALF_SIZES[KIND_INDEX][0], HALF_SIZES[KIND_STICKY][0]),
  Math.max(HALF_SIZES[KIND_INDEX][1], HALF_SIZES[KIND_STICKY][1]),
];

/** Words written on cards and sticky notes. */
export const WORDS = [
  "WHO?",
  "ALIBI?",
  "MOTIVE",
  "9:40 PM",
  "CHECK",
  "WHERE?",
  "WITNESS",
  "WHY?",
  "TUESDAY?",
  "2ND KEY",
  "NO RECORD",
  "FOLLOW UP",
  "SEEN 11 PM",
  "LIED?",
  "CONNECTED?",
  "RECEIPT",
] as const;

/** Indices of the words short enough for a sticky note. */
const SHORT_WORDS: readonly number[] = WORDS.flatMap((w, i) => (w.length <= 7 ? [i] : []));

/** What a photo shows: someone's outline, a car, a building, or (3) a face with a question mark. */
export const SUBJECT_PERSON = 0;
export const SUBJECT_CAR = 1;
export const SUBJECT_BUILDING = 2;
const SUBJECTS = 4;
/** Sticky-note colours and pin colours to pick from. */
const STICKY_TINTS = 4;
const PIN_COLORS = 5;

/** How far a pin sits below its item's top edge (board units). */
const PIN_INSET = 0.013;

/** The title card's centre and tilt. */
const TITLE_U = 0.5;
const TITLE_V = 0.105;
const TITLE_ANGLE = -0.018;

/** Where items may be centred, as fractions of the frame. */
const U_MIN = 0.06;
const U_MAX = 0.94;
const V_MIN = 0.09;
const V_MAX = 0.92;
/** Room kept clear round the title card (design units). */
const TITLE_GAP = 0.012;
/** Candidate spots tried per item; the one furthest from the rest wins. */
const CANDIDATES = 14;
/** Where the speaker stands (fractions): items there would be hidden, so few go there. */
const SPEAKER_U = 0.17;
const SPEAKER_V = 0.3;
/** Chance a new item also takes a long string across the board. */
const CROSS_CHANCE = 0.4;
/** How far apart (u) a cross string's ends are at least. */
const CROSS_SPAN = 0.32;

/** A pinned item: where it is, what it is, and its pin. */
export interface Item {
  kind: ItemKind;
  u: number;
  v: number;
  /** Half width and half height (board units). */
  hw: number;
  hh: number;
  /** Tilt, radians, clockwise on screen. */
  angle: number;
  /** Photo subject, sticky tint or clipping style, by kind. */
  variant: number;
  /** Index into `WORDS` for cards and sticky notes. */
  word: number;
  pinColor: number;
  /** Seeds the item's own drawing (grain, column lines, the map's roads). */
  seed: number;
}

/** A string between two items' pins: `a` placed after `b`. */
interface BoardString {
  a: number;
  b: number;
}

export interface BoardLayout {
  readonly seed: number;
  readonly title: Item;
  /** All MAX_DENSITY items; the density shows the first ones. */
  readonly items: readonly Item[];
  /** Strings in the order their newer end was placed. */
  readonly strings: readonly BoardString[];
}

const newItem = (): Item => ({
  kind: KIND_PHOTO,
  u: 0,
  v: 0,
  hw: 0,
  hh: 0,
  angle: 0,
  variant: 0,
  word: 0,
  pinColor: 0,
  seed: 0,
});

/** Half extents (design units) of `item`'s tilted rectangle's bounding box. */
export function itemExtents(item: Item): [number, number] {
  const c = Math.abs(Math.cos(item.angle));
  const s = Math.abs(Math.sin(item.angle));
  return [c * item.hw + s * item.hh, s * item.hw + c * item.hh];
}

/** Area (design units squared) where two items' bounding boxes overlap. */
function overlapArea(a: Item, b: Item): number {
  const [ax, ay] = itemExtents(a);
  const [bx, by] = itemExtents(b);
  const ox =
    Math.min(a.u * DESIGN_W + ax, b.u * DESIGN_W + bx) -
    Math.max(a.u * DESIGN_W - ax, b.u * DESIGN_W - bx);
  const oy = Math.min(a.v + ay, b.v + by) - Math.max(a.v - ay, b.v - by);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

/** Whether `item`'s bounding box comes within `gap` of the title card's. */
export function coversTitle(item: Item, title: Item, gap = 0): boolean {
  const [ax, ay] = itemExtents(item);
  const [tx, ty] = itemExtents(title);
  return (
    Math.abs(item.u - title.u) * DESIGN_W < ax + tx + gap &&
    Math.abs(item.v - title.v) < ay + ty + gap
  );
}

/**
 * The pin's position in pixels for an item in a `width` x `height` frame with
 * `unitPx` pixels per board unit (y down): near the top edge's middle, turned
 * with the item.
 */
export function pinPoint(
  item: Item,
  width: number,
  height: number,
  unitPx: number,
  out: Float64Array,
): Float64Array {
  const dy = (-item.hh + PIN_INSET) * unitPx;
  out[0] = item.u * width - Math.sin(item.angle) * dy;
  out[1] = item.v * height + Math.cos(item.angle) * dy;
  return out;
}

/** The kind of item `i`: the map and the loose clipping first, then a seeded mix. */
function kindFor(i: number, r: number): ItemKind {
  if (i === 0) {
    return KIND_MAP;
  }
  if (i === LOOSE_ITEM) {
    return KIND_CLIPPING;
  }
  if (i === 2) {
    return KIND_POLAROID;
  }
  return r < 0.22
    ? KIND_PHOTO
    : r < 0.42
      ? KIND_POLAROID
      : r < 0.62
        ? KIND_INDEX
        : r < 0.82
          ? KIND_STICKY
          : KIND_CLIPPING;
}

/** The clipping whose corner lifts in the draught. */
export const LOOSE_ITEM = 1;

/** A seed for stream `n` of layout `seed`. */
const stream = (seed: number, n: number) =>
  hash32((Math.imul(Math.trunc(seed), 0x9e3779b1) ^ n) >>> 0);

/** Sets the item's shape and look from its kind and its stream. */
function dress(item: Item, kind: ItemKind, rng: () => number): void {
  item.kind = kind;
  const half = HALF_SIZES[kind];
  item.hw = half[0];
  item.hh = half[1];
  item.variant = 0;
  if (kind === KIND_PHOTO || kind === KIND_POLAROID) {
    item.variant = Math.floor(rng() * SUBJECTS);
  } else if (kind === KIND_STICKY) {
    item.variant = Math.floor(rng() * STICKY_TINTS);
  } else if (kind === KIND_CLIPPING) {
    // Some are taller, some squatter.
    item.hh = half[1] * (0.8 + 0.35 * rng());
    item.variant = Math.floor(rng() * 2);
  }
  // Sticky notes are small: they take the short words.
  const r = rng();
  item.word =
    kind === KIND_STICKY
      ? SHORT_WORDS[Math.floor(r * SHORT_WORDS.length)]
      : Math.floor(r * WORDS.length);
  item.angle = (rng() - 0.5) * (kind === KIND_STICKY ? 0.3 : 0.22);
  item.seed = Math.floor(rng() * 0xffff);
}

/** Squared distance (design units) between two items' centres. */
const dist2 = (a: Item, b: Item) => {
  const dx = (a.u - b.u) * DESIGN_W;
  const dy = a.v - b.v;
  return dx * dx + dy * dy;
};

/**
 * How good a spot `c` is among `placed[0..count)`: the distance to the nearest
 * item, less a penalty for overlapping one heavily or for standing where the
 * speaker will hide it. -Infinity for a spot on the title card.
 */
function spotScore(
  c: Item,
  title: Item,
  placed: readonly Item[],
  count: number,
  speakerZone: boolean,
): number {
  if (coversTitle(c, title, TITLE_GAP)) {
    return -Infinity;
  }
  let nearest = 1;
  let overlap = 0;
  const area = 4 * c.hw * c.hh;
  for (let j = 0; j < count; j++) {
    const o = placed[j];
    nearest = Math.min(nearest, Math.sqrt(dist2(c, o)));
    overlap = Math.max(overlap, overlapArea(c, o) / Math.min(area, 4 * o.hw * o.hh));
  }
  let score = nearest - 0.3 * Math.max(0, overlap - 0.15);
  if (speakerZone && Math.abs(c.u - 0.5) < SPEAKER_U && c.v > SPEAKER_V) {
    score -= 0.12;
  }
  return score;
}

/** Places `item` (already dressed) at the best of a few spots drawn from `rng` within the u and v ranges. */
function place(
  item: Item,
  rng: () => number,
  title: Item,
  placed: readonly Item[],
  count: number,
  side: (r: number) => number,
  speakerZone: boolean,
): void {
  let best = -Infinity;
  let bu = 0.5;
  let bv = 0.5;
  for (let k = 0; k < CANDIDATES; k++) {
    item.u = side(rng());
    item.v = V_MIN + (V_MAX - V_MIN) * rng();
    const s = spotScore(item, title, placed, count, speakerZone);
    if (s > best) {
      best = s;
      bu = item.u;
      bv = item.v;
    }
  }
  if (best === -Infinity) {
    // Every spot drawn landed on the title card: put it in the bottom corner on its side.
    bu = bu < 0.5 ? U_MIN : U_MAX;
    bv = V_MAX;
  }
  item.u = bu;
  item.v = bv;
}

const anywhere = (r: number) => U_MIN + (U_MAX - U_MIN) * r;

/** Lays out the board for `seed`: the title card, MAX_DENSITY items and the strings between them. */
export function layoutBoard(seed: number): BoardLayout {
  const s = Math.floor(Number.isFinite(seed) ? seed : 0);
  const title = newItem();
  title.kind = KIND_TITLE;
  title.u = TITLE_U;
  title.v = TITLE_V;
  title.hw = HALF_SIZES[KIND_TITLE][0];
  title.hh = HALF_SIZES[KIND_TITLE][1];
  title.angle = TITLE_ANGLE;
  title.pinColor = hash32(stream(s, 0x7171)) % PIN_COLORS;

  const items: Item[] = [];
  const strings: BoardString[] = [];
  const degree = new Int32Array(MAX_DENSITY);
  for (let i = 0; i < MAX_DENSITY; i++) {
    const rng = createRng(stream(s, i + 1));
    const item = newItem();
    dress(item, kindFor(i, rng()), rng);
    item.pinColor = hash32(stream(s, 0x5000 + i)) % PIN_COLORS;
    place(item, rng, title, items, i, anywhere, true);
    items.push(item);
    if (i === 0) {
      continue;
    }
    // Tie it to the nearest earlier item with room on its pin. The item just
    // before has at most two strings (only its own), so there always is one,
    // and the graph stays connected.
    let near = -1;
    let nearD = Infinity;
    for (let j = 0; j < i; j++) {
      const d = dist2(item, items[j]);
      if (degree[j] < MAX_BASE_STRINGS && d < nearD) {
        nearD = d;
        near = j;
      }
    }
    strings.push({ a: i, b: near });
    degree[i]++;
    degree[near]++;
    // Sometimes a long string across the board, behind the speaker.
    if (rng() < CROSS_CHANCE) {
      const pick = rng();
      let n = 0;
      for (let j = 0; j < i; j++) {
        if (
          j !== near &&
          degree[j] < MAX_BASE_STRINGS &&
          Math.abs(items[j].u - item.u) > CROSS_SPAN
        ) {
          n++;
        }
      }
      let k = Math.floor(pick * n);
      for (let j = 0; j < i; j++) {
        if (
          j !== near &&
          degree[j] < MAX_BASE_STRINGS &&
          Math.abs(items[j].u - item.u) > CROSS_SPAN
        ) {
          if (k-- === 0) {
            strings.push({ a: i, b: j });
            degree[i]++;
            degree[j]++;
            break;
          }
        }
      }
    }
  }
  return { seed: s, title, items, strings };
}

/** How many of the layout's strings join items within the first `count`. */
export function stringsShown(layout: BoardLayout, count: number): number {
  let n = 0;
  while (n < layout.strings.length && layout.strings[n].a < count) {
    n++;
  }
  return n;
}

// --- The growing case ---

/** Seconds between growth events, and before the first. */
export const GROW_GAP_MIN = 60;
export const GROW_GAP_MAX = 120;
const FIRST_GAP_MIN = 30;
const FIRST_GAP_MAX = 60;
/** Seconds a card takes to fade in (before its string starts) and to come down. */
const CARD_FADE_IN = 1;
const CARD_FADE_OUT = 1.5;
/** Seconds a new string takes to draw itself, at least. */
const DRAW_MIN = 3;
const DRAW_MAX = 4;
/** Added cards go in the outer thirds, this far in from the edges at most. */
const OUTER_U = 1 / 3;

/** A card the growing case pinned up. */
interface AddedCard {
  /** Whether this slot holds a card. */
  live: boolean;
  /** Which card this is, counting from 0; older cards have smaller ids. */
  id: number;
  readonly item: Item;
  /** The board item its string runs to. */
  target: number;
  /** When it went up, and when it started coming down (-1 while up). */
  born: number;
  leaving: number;
  /** Seconds its string takes to draw, before the motion cap. */
  drawTime: number;
}

export interface GrowState {
  readonly seed: number;
  /** Seconds since the start, unwrapped. */
  time: number;
  /** When the next card goes up or comes down. */
  next: number;
  /** Events so far, for their gaps' random draws. */
  events: number;
  /** Whether the board is full and the oldest cards are coming down. */
  clearing: boolean;
  /** Cards pinned up so far. */
  spawned: number;
  /** MAX_ADDED slots. */
  readonly cards: readonly AddedCard[];
}

const unit = (seed: number, n: number) => stream(seed, n) / 4294967296;

export function createGrow(seed: number): GrowState {
  const s = Math.floor(Number.isFinite(seed) ? seed : 0);
  const cards: AddedCard[] = [];
  for (let i = 0; i < MAX_ADDED; i++) {
    cards.push({
      live: false,
      id: -1,
      item: newItem(),
      target: 0,
      born: 0,
      leaving: -1,
      drawTime: DRAW_MIN,
    });
  }
  return {
    seed: s,
    time: 0,
    next: FIRST_GAP_MIN + (FIRST_GAP_MAX - FIRST_GAP_MIN) * unit(s, 0x6a00),
    events: 0,
    clearing: false,
    spawned: 0,
    cards,
  };
}

/** Cards up and not coming down. */
export function cardsUp(g: GrowState): number {
  let n = 0;
  for (const c of g.cards) {
    if (c.live && c.leaving < 0) {
      n++;
    }
  }
  return n;
}

/** Whether board item `j` already has an added card's string. */
function pinTaken(g: GrowState, j: number): boolean {
  for (const c of g.cards) {
    if (c.live && c.target === j) {
      return true;
    }
  }
  return false;
}

/** Pins up a new card in a free slot, tied to the nearest board pin with room. Returns false if there's none. */
function spawn(g: GrowState, layout: BoardLayout, density: number): boolean {
  let slot = -1;
  for (let i = 0; i < g.cards.length; i++) {
    if (!g.cards[i].live) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    return false;
  }
  const card = g.cards[slot];
  const item = card.item;
  const rng = createRng(stream(g.seed, 0x10000 + g.spawned));
  dress(item, rng() < 0.5 ? KIND_INDEX : KIND_STICKY, rng);
  item.pinColor = Math.floor(rng() * PIN_COLORS);
  // Spots near the board's items and the other added cards count as crowded.
  const others: Item[] = [];
  for (let j = 0; j < density; j++) {
    others.push(layout.items[j]);
  }
  for (const c of g.cards) {
    if (c.live && c !== card) {
      others.push(c.item);
    }
  }
  place(
    item,
    rng,
    layout.title,
    others,
    others.length,
    (r) =>
      r < 0.5
        ? U_MIN + (OUTER_U - U_MIN) * 2 * r
        : 1 - OUTER_U + (U_MAX - 1 + OUTER_U) * (2 * r - 1),
    false,
  );
  let target = -1;
  let best = Infinity;
  for (let j = 0; j < density; j++) {
    const d = dist2(item, layout.items[j]);
    if (d < best && !pinTaken(g, j)) {
      best = d;
      target = j;
    }
  }
  if (target < 0) {
    return false;
  }
  card.live = true;
  card.id = g.spawned++;
  card.target = target;
  card.born = g.time;
  card.leaving = -1;
  card.drawTime = DRAW_MIN + (DRAW_MAX - DRAW_MIN) * rng();
  return true;
}

/** Starts taking down the oldest card still up. Returns false if none is. */
function takeDownOldest(g: GrowState): boolean {
  let oldest: AddedCard | null = null;
  for (const c of g.cards) {
    if (c.live && c.leaving < 0 && (!oldest || c.id < oldest.id)) {
      oldest = c;
    }
  }
  if (!oldest) {
    return false;
  }
  oldest.leaving = g.time;
  return true;
}

/**
 * Advances the growing case by `dt` seconds with `density` items on the board.
 * With `on` false every added card comes down and the schedule starts again.
 * While growing, each event pins up a card until the board holds MAX_ITEMS or
 * no pin has room; then each event takes the oldest down until none is left,
 * and it grows again. A card whose board item goes (the density falls) comes
 * down with it.
 */
export function advanceGrow(
  g: GrowState,
  layout: BoardLayout,
  dt: number,
  density: number,
  on: boolean,
): void {
  g.time += Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const n = Math.max(0, Math.min(MAX_DENSITY, Math.floor(density)));
  for (const c of g.cards) {
    if (!c.live) {
      continue;
    }
    if (c.leaving < 0 && (!on || c.target >= n)) {
      c.leaving = g.time;
    }
    if (c.leaving >= 0 && g.time - c.leaving >= CARD_FADE_OUT) {
      c.live = false;
    }
  }
  if (!on) {
    g.clearing = false;
    g.next =
      g.time + FIRST_GAP_MIN + (FIRST_GAP_MAX - FIRST_GAP_MIN) * unit(g.seed, 0x6a00 + g.events);
    return;
  }
  if (g.time < g.next) {
    return;
  }
  g.events++;
  g.next = g.time + GROW_GAP_MIN + (GROW_GAP_MAX - GROW_GAP_MIN) * unit(g.seed, 0x7b00 + g.events);
  if (!g.clearing) {
    if (n + cardsUp(g) < MAX_ITEMS && spawn(g, layout, n)) {
      return;
    }
    g.clearing = true;
  }
  if (takeDownOldest(g)) {
    if (cardsUp(g) === 0) {
      g.clearing = false;
    }
    return;
  }
  g.clearing = false;
  spawn(g, layout, n);
}

/** How opaque an added card is now: fading in, up, or coming down. */
export function cardAlpha(c: AddedCard, time: number): number {
  if (!c.live) {
    return 0;
  }
  const up = Math.min(1, Math.max(0, (time - c.born) / CARD_FADE_IN));
  const down = c.leaving < 0 ? 1 : Math.max(0, 1 - (time - c.leaving) / CARD_FADE_OUT);
  return up * down;
}

/**
 * Seconds a string `lengthFrames` frame heights long takes to draw itself: its
 * card's own time, or longer if its eased tip would otherwise outrun the codec
 * limit on a thin feature's travel.
 */
export function drawDuration(c: AddedCard, lengthFrames: number): number {
  const minimum = (Math.abs(lengthFrames) * EASE_PEAK * 1080) / (30 * MAX_FEATURE_PX_PER_FRAME);
  return Math.max(c.drawTime, minimum);
}

/** How much of an added card's string is drawn (0..1), eased: it starts once the card is in. */
export function stringProgress(c: AddedCard, time: number, lengthFrames: number): number {
  if (!c.live) {
    return 0;
  }
  const t = Math.min(
    1,
    Math.max(0, (time - c.born - CARD_FADE_IN) / drawDuration(c, lengthFrames)),
  );
  return t * t * (3 - 2 * t);
}

// --- The atlas ---

/**
 * Packs `count` rects (w, h pairs in `sizes`) into rows `width` wide, in order,
 * `gap` apart and from the edges, writing each one's top-left x and y into
 * `out`. Returns the height used. A rect wider than the row gets one to itself.
 */
export function shelfPack(
  sizes: Float64Array,
  count: number,
  width: number,
  gap: number,
  out: Float64Array,
): number {
  let x = gap;
  let y = gap;
  let row = 0;
  for (let i = 0; i < count; i++) {
    const w = sizes[2 * i];
    const h = sizes[2 * i + 1];
    if (x > gap && x + w + gap > width) {
      x = gap;
      y += row + gap;
      row = 0;
    }
    out[2 * i] = x;
    out[2 * i + 1] = y;
    x += w + gap;
    row = Math.max(row, h);
  }
  return y + row + gap;
}
