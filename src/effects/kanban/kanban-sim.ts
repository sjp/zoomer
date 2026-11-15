/**
 * The Kanban Board's work: columns as ordered lists of task cards (top first), a
 * scheduler that every `pace` seconds lifts one card and glides it on to the next
 * column, new tasks arriving at the top of the first column, finished ones
 * archived from the bottom of the last, and checklists ticking along in the
 * column before last. Cards never move backwards.
 *
 * Every card carries its own eased move (from, to, start, duration), so a pose
 * can be read at any time; columns reflow by retargeting their cards. Pure and
 * deterministic per seed: card contents come from a hash of the seed and the
 * card's id, the schedule from one seeded stream.
 */
import { minTweenSeconds } from "../charts";
import { clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { type BoardLayout, cardHeight } from "./kanban-layout";

/** Seconds a picked-up card takes to lift, and again to settle. */
const LIFT_SECONDS = 0.3;
/** The shortest glide to the next column, s. */
const MIN_GLIDE_SECONDS = 1.5;
/** The shortest reflow slide (cards closing up or making room), s. */
const MIN_SLIDE_SECONDS = 0.7;
/** How far a gliding card's path arcs upwards, px at 1080p. */
const ARC_PX = 30;
/** Headroom on the codec limit for every move: durations are this much longer than the minimum. */
const SPEED_MARGIN = 1.1;
/** A new card fades in while it drops this far (px at 1080p) into place. */
const ARRIVE_SECONDS = 0.9;
const ARRIVE_DROP_PX = 24;
/** An archived card fades out over this long. */
const ARCHIVE_SECONDS = 1.2;
/** Cards a column holds at most, and cards alive (fading ones included) at most. */
export const MAX_PER_COLUMN = 8;
export const MAX_CARDS = 40;
/** A column scheduler waits this long before trying again when nothing can move. */
const RETRY_SECONDS = 1;

/** Card labels: a name and a chip colour. */
export const LABELS: readonly { readonly name: string; readonly color: string }[] = [
  { name: "Design", color: "#8b5cf6" },
  { name: "Bug", color: "#e5484d" },
  { name: "Backend", color: "#2f7de1" },
  { name: "Frontend", color: "#0e9f8e" },
  { name: "Research", color: "#d97706" },
  { name: "Ops", color: "#64748b" },
  { name: "Docs", color: "#16a34a" },
  { name: "Marketing", color: "#db2777" },
];

/** Assignees' initials. */
export const PEOPLE: readonly string[] = [
  "AK",
  "JM",
  "SR",
  "LP",
  "TN",
  "CW",
  "DB",
  "EV",
  "HO",
  "RG",
  "MF",
  "NS",
];

const TITLES: readonly string[] = [
  "Update onboarding copy",
  "Fix login timeout",
  "Q4 planning",
  "Refresh pricing page",
  "Migrate billing to the new API",
  "Write release notes",
  "Customer interview synthesis",
  "Reduce dashboard load time",
  "Add dark mode to settings",
  "Clean up feature flags",
  "Audit accessibility on forms",
  "Draft hiring plan",
  "Fix flaky export test",
  "Design empty states",
  "Set up staging alerts",
  "Review vendor contract",
  "Plan team offsite",
  "Localise checkout",
  "Archive old campaigns",
  "Improve search relevance",
  "Update security policy",
  "Prepare board deck",
  "Fix avatar upload on mobile",
  "Rotate API keys",
  "Benchmark new database",
  "Sketch mobile navigation",
  "Write onboarding emails",
  "Tidy up the style guide",
  "Retro action items",
  "Investigate memory spike",
  "Spec the reporting page",
  "Update help centre articles",
  "Usability test the new flow",
  "Upgrade build tooling",
  "Social media calendar",
  "Fix timezone bug in reminders",
  "Partner integration kickoff",
  "Budget review",
  "Polish invoice template",
  "Add CSV import",
];

const MONTHS = ["Nov", "Dec", "Jan", "Feb"];

/** Title characters per line before wrapping. */
const LINE_CHARS = 26;

/** Splits a title into one or two lines at a word boundary. */
export function wrapTitle(title: string, lineChars = LINE_CHARS): string[] {
  if (title.length <= lineChars) {
    return [title];
  }
  let cut = title.lastIndexOf(" ", lineChars);
  if (cut <= 0) {
    cut = lineChars;
  }
  return [title.slice(0, cut).trimEnd(), title.slice(cut).trimStart()];
}

export interface Card {
  readonly id: number;
  /** Atlas slot, unique among live cards. */
  readonly slot: number;
  readonly lines: readonly string[];
  /** Indices into `LABELS`, one or two. */
  readonly labels: readonly number[];
  /** Index into `PEOPLE`. */
  readonly person: number;
  /** A due date ("Nov 18"), or "". */
  readonly due: string;
  /** Checklist items, 0 for none, and how many are ticked. */
  readonly checkTotal: number;
  checkDone: number;
  /** Bumped whenever what the card shows changes. */
  version: number;
  /** Column, or -1 once archived. */
  col: number;
  /** The current move: from (`fx`, `fy`) to (`tx`, `ty`) top-left, starting at `t0` for `dur` seconds. */
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number;
  dur: number;
  /** Whether the move is a pick-up (lift, glide on an arc of `arc` px, settle) rather than a slide. */
  lifted: boolean;
  arc: number;
  /** When the card arrived (it fades in), was archived (it fades out), and last ticked its checklist. */
  born: number;
  gone: number;
  tint: number;
  /** Ticks its checklist to the end once its move settles. */
  completeOnLand: boolean;
}

export interface Board {
  readonly seed: number;
  /** Seconds since the board began. */
  time: number;
  layout: BoardLayout;
  /** Every card, archived ones included until they have faded. */
  readonly cards: Card[];
  /** Live cards per column, top first. */
  cols: Card[][];
  nextId: number;
  readonly slotUsed: Uint8Array;
  readonly rng: () => number;
  nextMove: number;
  nextArrival: number;
  nextCheck: number;
  nextArchive: number;
  /** The card being carried, until its settle ends at `moveEnd`. */
  mover: Card | null;
  moveEnd: number;
  /** Moves, arrivals and archived cards so far, and the last move's columns (for tests). */
  moveCount: number;
  arrivals: number;
  archives: number;
  lastFrom: number;
  lastTo: number;
}

/** A card's pose at some moment. */
interface Pose {
  /** Top-left, px. */
  x: number;
  y: number;
  /** 0 at rest, 1 fully lifted. */
  lift: number;
  alpha: number;
  /** Whether the card is between places (it may sit off the pixel grid). */
  moving: boolean;
}

export const createPose = (): Pose => ({ x: 0, y: 0, lift: 0, alpha: 1, moving: false });

/** Seconds for a lifted glide of `dist` px with an arc of `arc` px, at scale `s`. */
function glideSeconds(dist: number, arc: number, s: number): number {
  // The arc adds at most pi * arc to the speed's bound (its derivative peaks there).
  const ref = (dist + Math.PI * arc) / (s > 0 ? s : 1);
  return Math.max(MIN_GLIDE_SECONDS, minTweenSeconds(ref) * SPEED_MARGIN);
}

/** Seconds for a reflow slide of `dist` px at scale `s`. */
function slideSeconds(dist: number, s: number): number {
  return Math.max(MIN_SLIDE_SECONDS, minTweenSeconds(dist / (s > 0 ? s : 1)) * SPEED_MARGIN);
}

/** Writes card `c`'s pose at time `now` into `out`. */
export function cardPose(c: Card, now: number, out: Pose): Pose {
  let u = 1;
  let lift = 0;
  if (c.lifted) {
    const t = now - c.t0;
    const glideEnd = LIFT_SECONDS + c.dur;
    lift =
      t <= 0
        ? 0
        : t < LIFT_SECONDS
          ? smoothstep(0, 1, t / LIFT_SECONDS)
          : t < glideEnd
            ? 1
            : 1 - smoothstep(0, 1, (t - glideEnd) / LIFT_SECONDS);
    u = c.dur > 0 ? smoothstep(0, 1, (t - LIFT_SECONDS) / c.dur) : 1;
  } else if (c.dur > 0) {
    u = smoothstep(0, 1, (now - c.t0) / c.dur);
  }
  out.x = c.fx + (c.tx - c.fx) * u;
  out.y = c.fy + (c.ty - c.fy) * u - (c.lifted ? c.arc * Math.sin(Math.PI * u) : 0);
  out.lift = lift;
  out.moving = (u > 0 && u < 1) || lift > 0;
  let a = 1;
  if (now < c.born + ARRIVE_SECONDS) {
    a = smoothstep(0, 1, (now - c.born) / ARRIVE_SECONDS);
  }
  if (now > c.gone) {
    a *= 1 - smoothstep(0, 1, (now - c.gone) / ARCHIVE_SECONDS);
  }
  out.alpha = a;
  return out;
}

const scratch = createPose();

/** The sum of the heights and gaps of cards above index `index` in column `c`, from the top. */
function slotY(b: Board, c: number, index: number): number {
  const L = b.layout;
  let y = L.cardsTop;
  const col = b.cols[c];
  for (let i = 0; i < index; i++) {
    y += cardHeight(L, col[i].lines.length) + L.cardGap;
  }
  return y;
}

const columnX = (b: Board, c: number) => b.layout.colX[c] + b.layout.cardInset;

/** Whether column `c` has room for one more card of height `h` (and fewer than the most cards). */
function hasRoom(b: Board, c: number, h: number): boolean {
  const col = b.cols[c];
  if (col.length >= MAX_PER_COLUMN) {
    return false;
  }
  const L = b.layout;
  const bottom = slotY(b, c, col.length) + h;
  return bottom <= L.capBottom[c];
}

/** The tallest card's height in this layout. */
const tallest = (b: Board) => cardHeight(b.layout, 2);

/** Sends card `c` to (`x`, `y`): at once if `snap`, else as a slide starting `delay` seconds from now. */
function retarget(b: Board, c: Card, x: number, y: number, snap: boolean, delay = 0): void {
  if (snap) {
    c.fx = c.tx = x;
    c.fy = c.ty = y;
    c.dur = 0;
    c.lifted = false;
    return;
  }
  if (c.tx === x && c.ty === y) {
    return;
  }
  const now = b.time;
  const p = cardPose(c, now, scratch);
  const s = b.layout.s;
  if (c.lifted && now < c.t0 + LIFT_SECONDS + c.dur) {
    // Still carried: keep it lifted and glide on from where it is.
    if (now >= c.t0 + LIFT_SECONDS) {
      c.fx = p.x;
      c.fy = p.y;
      c.t0 = now - LIFT_SECONDS;
      c.arc = 0;
    }
    c.tx = x;
    c.ty = y;
    c.dur = glideSeconds(Math.hypot(x - c.fx, y - c.fy), c.arc, s);
    if (b.mover === c) {
      // The carry lasts as long as the new glide; the next move waits for it.
      b.moveEnd = c.t0 + 2 * LIFT_SECONDS + c.dur;
      b.nextMove = Math.max(b.nextMove, b.moveEnd + 1);
    }
    return;
  }
  c.fx = p.x;
  c.fy = p.y;
  c.tx = x;
  c.ty = y;
  c.t0 = now + delay;
  c.lifted = false;
  c.arc = 0;
  c.dur = slideSeconds(Math.hypot(x - p.x, y - p.y), s);
}

/** Retargets every card in column `c` to its place. */
function reflow(b: Board, c: number, snap: boolean, delay = 0): void {
  const col = b.cols[c];
  const x = columnX(b, c);
  let y = b.layout.cardsTop;
  for (const card of col) {
    retarget(b, card, x, y, snap, delay);
    y += cardHeight(b.layout, card.lines.length) + b.layout.cardGap;
  }
}

function takeSlot(b: Board): number {
  for (let i = 0; i < MAX_CARDS; i++) {
    if (b.slotUsed[i] === 0) {
      b.slotUsed[i] = 1;
      return i;
    }
  }
  return -1;
}

/** A new card with id `b.nextId`, its contents a hash of the seed and id, or null when no slot is free. */
function makeCard(b: Board, col: number): Card | null {
  const slot = takeSlot(b);
  if (slot < 0) {
    return null;
  }
  const id = b.nextId++;
  const rng = createRng(hash32(Math.imul(b.seed + 1, 0x9e3779b1) ^ hash32(id + 0x51f15e)));
  const title = TITLES[Math.floor(rng() * TITLES.length)];
  const first = Math.floor(rng() * LABELS.length);
  const labels = [first];
  if (rng() < 0.4) {
    labels.push((first + 1 + Math.floor(rng() * (LABELS.length - 1))) % LABELS.length);
  }
  const person = Math.floor(rng() * PEOPLE.length);
  const due =
    rng() < 0.45
      ? MONTHS[Math.floor(rng() * MONTHS.length)] + " " + String(1 + Math.floor(rng() * 28))
      : "";
  const checkTotal = rng() < 0.5 ? 3 + Math.floor(rng() * 4) : 0;
  return {
    id,
    slot,
    lines: wrapTitle(title),
    labels,
    person,
    due,
    checkTotal,
    checkDone: 0,
    version: 0,
    col,
    fx: 0,
    fy: 0,
    tx: 0,
    ty: 0,
    t0: 0,
    dur: 0,
    lifted: false,
    arc: 0,
    born: -Infinity,
    gone: Infinity,
    tint: -Infinity,
    completeOnLand: false,
  };
}

/** A board for `seed`, its columns part-filled to fit `layout`, the first move a little way off. */
export function createBoard(seed: number, layout: BoardLayout, pace: number): Board {
  const n = layout.columns;
  const b: Board = {
    seed,
    time: 0,
    layout,
    cards: [],
    cols: [],
    nextId: 0,
    slotUsed: new Uint8Array(MAX_CARDS),
    rng: createRng(hash32(seed ^ 0x4b414e)),
    nextMove: 0,
    nextArrival: 0,
    nextCheck: 0,
    nextArchive: 0,
    mover: null,
    moveEnd: 0,
    moveCount: 0,
    arrivals: 0,
    archives: 0,
    lastFrom: -1,
    lastTo: -1,
  };
  for (let c = 0; c < n; c++) {
    b.cols.push([]);
  }
  for (let c = 0; c < n; c++) {
    // Fill, then leave some room: a gap or two in the outer columns, maybe none in the inner ones.
    for (;;) {
      const card = makeCard(b, c);
      if (!card) {
        break;
      }
      if (!hasRoom(b, c, cardHeight(layout, card.lines.length))) {
        b.slotUsed[card.slot] = 0;
        break;
      }
      const progress = n > 1 ? c / (n - 1) : 1;
      card.checkDone =
        c === n - 1 ? card.checkTotal : Math.floor(card.checkTotal * progress * b.rng());
      b.cols[c].push(card);
      b.cards.push(card);
    }
    const leave = c === n - 1 ? 1 + Math.floor(b.rng() * 2) : c === 0 ? 1 : Math.floor(b.rng() * 2);
    for (let i = 0; i < leave && b.cols[c].length > 0; i++) {
      const card = b.cols[c].pop();
      if (card) {
        b.cards.splice(b.cards.indexOf(card), 1);
        b.slotUsed[card.slot] = 0;
      }
    }
    reflow(b, c, true);
  }
  const p = clamp(pace, 1, 1e6);
  b.nextMove = 0.5 * p;
  b.nextArrival = 1.3 * p;
  b.nextCheck = 0.7 * p;
  return b;
}

/** Starts card `card`'s fade out and takes it off its column. */
function archive(b: Board, card: Card): void {
  if (card.col >= 0) {
    const col = b.cols[card.col];
    const i = col.indexOf(card);
    if (i >= 0) {
      col.splice(i, 1);
    }
  }
  card.col = -1;
  card.gone = b.time;
  b.archives++;
  if (b.mover === card) {
    b.mover = null;
  }
}

/** Frees a card's slot and forgets it. */
function drop(b: Board, i: number): void {
  b.slotUsed[b.cards[i].slot] = 0;
  b.cards.splice(i, 1);
}

/** Picks one card to move on and starts its pick-up, or returns false if nothing can move. */
function tryMove(b: Board): boolean {
  const n = b.cols.length;
  const rng = b.rng;
  let total = 0;
  // Candidates: each column's chosen card (usually its oldest, the bottom one).
  const pick = scratchPicks;
  const weight = scratchWeights;
  for (let c = 0; c < n - 1; c++) {
    pick[c] = -1;
    weight[c] = 0;
    const col = b.cols[c];
    if (col.length === 0) {
      continue;
    }
    const r = rng();
    const i = r < 0.7 ? col.length - 1 : Math.floor(((r - 0.7) / 0.3) * col.length);
    const card = col[Math.min(col.length - 1, i)];
    if (
      b.time < card.born + ARRIVE_SECONDS ||
      !hasRoom(b, c + 1, cardHeight(b.layout, card.lines.length))
    ) {
      continue;
    }
    // Fuller columns move more often, and work in progress leans towards getting finished.
    let w = col.length * (c === n - 2 ? 1.5 : 1);
    if (c === n - 2 && card.checkDone < card.checkTotal) {
      w *= 0.4;
    }
    pick[c] = col.indexOf(card);
    weight[c] = w;
    total += w;
  }
  if (!(total > 0)) {
    return false;
  }
  let r = rng() * total;
  let from = 0;
  for (let c = 0; c < n - 1; c++) {
    if (weight[c] <= 0) {
      continue;
    }
    from = c;
    r -= weight[c];
    if (r < 0) {
      break;
    }
  }
  const to = from + 1;
  const card = b.cols[from][pick[from]];
  b.cols[from].splice(pick[from], 1);
  b.cols[to].unshift(card);
  card.col = to;
  if (to === n - 1 && card.checkDone < card.checkTotal) {
    card.completeOnLand = true;
  }
  const now = b.time;
  const p = cardPose(card, now, scratch);
  card.fx = p.x;
  card.fy = p.y;
  card.tx = columnX(b, to);
  card.ty = b.layout.cardsTop;
  card.t0 = now;
  card.lifted = true;
  card.arc = ARC_PX * b.layout.s;
  card.dur = glideSeconds(Math.hypot(card.tx - card.fx, card.ty - card.fy), card.arc, b.layout.s);
  b.mover = card;
  b.moveEnd = now + 2 * LIFT_SECONDS + card.dur;
  b.moveCount++;
  b.lastFrom = from;
  b.lastTo = to;
  // The target makes room at once; the gap closes once the card is up.
  reflow(b, to, false);
  reflow(b, from, false, LIFT_SECONDS);
  return true;
}

const scratchPicks = new Int32Array(8);
const scratchWeights = new Float64Array(8);

/** Advances the board by `dt` seconds, with `pace` seconds between moves (latched per move). */
export function stepBoard(b: Board, dt: number, pace: number): void {
  if (!(dt > 0) || !Number.isFinite(dt)) {
    return;
  }
  b.time += dt;
  const now = b.time;
  const p = clamp(pace, 1, 1e6);
  const n = b.cols.length;
  const rng = b.rng;

  for (let i = b.cards.length - 1; i >= 0; i--) {
    if (now >= b.cards[i].gone + ARCHIVE_SECONDS) {
      drop(b, i);
    }
  }

  const m = b.mover;
  if (m && now >= b.moveEnd) {
    b.mover = null;
    if (m.completeOnLand) {
      m.completeOnLand = false;
      m.checkDone = m.checkTotal;
      m.version++;
      m.tint = now;
    }
  }

  if (b.mover === null && now >= b.nextMove) {
    const start = now;
    if (tryMove(b)) {
      b.nextMove = start + Math.max(p, b.moveEnd - start + 1);
    } else {
      b.nextMove = now + RETRY_SECONDS;
    }
  }

  // Archive the oldest finished card once the last column can't take another.
  const last = n - 1;
  if (
    n > 1 &&
    b.mover === null &&
    now >= b.nextArchive &&
    b.cols[last].length > 0 &&
    !hasRoom(b, last, tallest(b))
  ) {
    archive(b, b.cols[last][b.cols[last].length - 1]);
    b.nextArchive = now + ARCHIVE_SECONDS + 0.5;
  }

  if (now >= b.nextArrival) {
    if (hasRoom(b, 0, tallest(b))) {
      const card = makeCard(b, 0);
      if (card) {
        card.born = now;
        b.arrivals++;
        b.cols[0].unshift(card);
        b.cards.push(card);
        const x = columnX(b, 0);
        const y = b.layout.cardsTop;
        retarget(b, card, x, y - ARRIVE_DROP_PX * b.layout.s, true);
        card.tx = x;
        card.ty = y;
        card.t0 = now;
        card.dur = ARRIVE_SECONDS;
        reflow(b, 0, false);
      }
      b.nextArrival = now + p * (1.1 + 0.6 * rng());
    } else {
      b.nextArrival = now + RETRY_SECONDS;
    }
  }

  if (now >= b.nextCheck) {
    b.nextCheck = now + p * (0.6 + 0.6 * rng());
    const col = n > 1 ? b.cols[n - 2] : null;
    if (col && col.length > 0) {
      const card = col[Math.floor(rng() * col.length)];
      if (card !== b.mover && card.checkDone < card.checkTotal - 1) {
        card.checkDone++;
        card.version++;
        card.tint = now;
      }
    }
  }
}

/**
 * Fits the board to a new layout. A change in the number of columns merges the
 * first two (the second's cards on top) or opens an empty first column; cards a
 * column can no longer hold are archived from the bottom. With `snap` (a resize)
 * everything jumps to its place and overflow goes at once; otherwise cards glide.
 */
export function applyLayout(b: Board, layout: BoardLayout, snap: boolean): void {
  const before = b.cols.length;
  const n = layout.columns;
  b.layout = layout;
  if (n < before) {
    const cols = b.cols;
    while (cols.length > n) {
      const merged = cols[1].concat(cols[0]);
      cols.splice(0, 2, merged);
    }
  } else {
    while (b.cols.length < n) {
      b.cols.unshift([]);
    }
  }
  for (let c = 0; c < n; c++) {
    for (const card of b.cols[c]) {
      card.col = c;
    }
  }
  if (snap) {
    b.mover = null;
    for (const card of b.cards) {
      card.lifted = false;
    }
  }
  for (let c = 0; c < n; c++) {
    const col = b.cols[c];
    let y = layout.cardsTop;
    for (let i = 0; i < col.length; i++) {
      y += cardHeight(layout, col[i].lines.length);
      if (y > layout.capBottom[c] || i >= MAX_PER_COLUMN) {
        while (col.length > i) {
          const last = col[col.length - 1];
          archive(b, last);
          if (snap) {
            drop(b, b.cards.indexOf(last));
          }
        }
        break;
      }
      y += layout.cardGap;
    }
    reflow(b, c, snap);
  }
  if (snap) {
    for (let i = b.cards.length - 1; i >= 0; i--) {
      if (b.cards[i].col < 0) {
        drop(b, i);
      }
    }
  }
}
