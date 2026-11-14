/**
 * The Dashboard's made-up business: every figure is a slow random walk with a
 * weekly rhythm, so the numbers drift plausibly and never run off the scale.
 *
 * A walk is mean-reverting in log space around its base value (an
 * Ornstein-Uhlenbeck step with a hard limit on the log offset), times a seasonal
 * factor with a seven-step period. Each walk has its own seeded random stream,
 * so the data is deterministic per seed and one walk's steps never shift
 * another's.
 *
 * The dashboard updates in ticks (one every `pace` seconds). Every tick the line
 * chart gains a point, one KPI tile steps (round robin), and one of the bar
 * chart, donut and table steps (also round robin), so a few things change at a
 * time and each card changes every few ticks. `stepDashboard` reports which.
 *
 * Labels come from a small built-in vocabulary; the seed picks the KPIs, the
 * chart topics and the starting data. Allocates nothing per tick.
 */
import { createRng, hash32 } from "../noise";
import { smoothstep } from "../math";

/** Values kept per walk, newest last. */
export const WALK_HISTORY = 64;
/** KPI tiles, series in the line chart, groups in the bar chart, donut segments, table rows. */
export const KPI_COUNT = 4;
export const LINE_SERIES = 3;
export const BAR_GROUPS = 4;
export const DONUT_SEGMENTS = 4;
export const TABLE_ROWS = 6;
/** The seasonal period, in steps: a week of daily points. */
const SEASON = 7;

/** Steps for a walk's log offset to relax halfway back, roughly. */
const REVERT_STEPS = 20;
/** Per-step noise of the log offset. */
const SIGMA = 0.045;
/** The log offset never strays further than this: about 0.6x to 1.6x the base. */
const LOG_LIMIT = 0.45;

export interface Walk {
  readonly base: number;
  /** Seasonal amplitude (share of the value) and phase (steps). */
  readonly amp: number;
  readonly phase: number;
  readonly rng: () => number;
  /** Log offset from the base. */
  x: number;
  /** Steps taken. */
  steps: number;
  /** Values in a ring of `WALK_HISTORY`: step k is at slot `k % WALK_HISTORY`. */
  readonly history: Float64Array;
}

/** A standard normal from `rng` (Box-Muller, one of the pair). */
function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** A walk around `base`, its stream seeded by `seed` and `key`, with `warm` steps already taken. */
export function createWalk(
  seed: number,
  key: number,
  base: number,
  amp: number,
  warm: number,
): Walk {
  const rng = createRng(hash32(hash32(Math.floor(seed) ^ 0x7a3d) + Math.imul(key, 0x9e3779b1)));
  const w: Walk = {
    base,
    amp,
    phase: Math.floor(rng() * SEASON),
    rng,
    x: (rng() - 0.5) * 0.3,
    steps: 0,
    history: new Float64Array(WALK_HISTORY),
  };
  for (let i = 0; i < warm; i++) {
    stepWalk(w);
  }
  return w;
}

/** The seasonal factor at step `k`: a smooth weekly rise and fall. */
const season = (w: Walk, k: number) => 1 + w.amp * Math.sin((2 * Math.PI * (k + w.phase)) / SEASON);

/** Takes one step and returns the new value. */
export function stepWalk(w: Walk): number {
  const k = 1 / REVERT_STEPS;
  let x = w.x * (1 - k) + SIGMA * normal(w.rng);
  // A soft wall well inside the hard one, then the hard one.
  if (Math.abs(x) > LOG_LIMIT * 0.8) {
    x *= 0.9;
  }
  w.x = Math.max(-LOG_LIMIT, Math.min(LOG_LIMIT, x));
  const v = w.base * Math.exp(w.x) * season(w, w.steps);
  w.history[w.steps % WALK_HISTORY] = v;
  w.steps++;
  return v;
}

/** The value `back` steps before the newest (0 is the newest); the oldest kept for older. */
export function walkAt(w: Walk, back: number): number {
  if (w.steps === 0) {
    return w.base;
  }
  const b = Math.min(Math.max(0, Math.floor(back)), Math.min(w.steps, WALK_HISTORY) - 1);
  return w.history[(w.steps - 1 - b) % WALK_HISTORY];
}

/** The lowest and highest value a walk can take. */
export const walkBounds = (w: Walk): [number, number] => [
  w.base * Math.exp(-LOG_LIMIT) * (1 - w.amp),
  w.base * Math.exp(LOG_LIMIT) * (1 + w.amp),
];

// ---------------------------------------------------------------------------
// Vocabulary

/** How a figure is written. */
type ValueKind = "money" | "count" | "percent";

export interface KpiDef {
  readonly label: string;
  readonly kind: ValueKind;
  readonly base: number;
  /** Decimal places shown. */
  readonly decimals: number;
  /** Whether a rise is good news (false for churn). */
  readonly goodUp: boolean;
}

const KPIS: readonly KpiDef[] = [
  { label: "Revenue", kind: "money", base: 128_400, decimals: 0, goodUp: true },
  { label: "Active users", kind: "count", base: 48_200, decimals: 0, goodUp: true },
  { label: "Conversion", kind: "percent", base: 3.42, decimals: 2, goodUp: true },
  { label: "Churn", kind: "percent", base: 1.86, decimals: 2, goodUp: false },
  { label: "Orders", kind: "count", base: 3_120, decimals: 0, goodUp: true },
  { label: "Avg. order value", kind: "money", base: 64.5, decimals: 2, goodUp: true },
  { label: "Sessions", kind: "count", base: 182_000, decimals: 0, goodUp: true },
  { label: "New signups", kind: "count", base: 1_240, decimals: 0, goodUp: true },
];

interface LineTopic {
  readonly title: string;
  readonly money: boolean;
  readonly series: readonly string[];
  readonly bases: readonly number[];
}

const LINE_TOPICS: readonly LineTopic[] = [
  {
    title: "Revenue by channel",
    money: true,
    series: ["Online", "Retail", "Partners"],
    bases: [52_000, 31_000, 14_000],
  },
  {
    title: "Sessions by device",
    money: false,
    series: ["Desktop", "Mobile", "Tablet"],
    bases: [74_000, 58_000, 12_000],
  },
  {
    title: "Signups by plan",
    money: false,
    series: ["Free", "Pro", "Team"],
    bases: [820, 310, 120],
  },
];

interface GroupTopic {
  readonly title: string;
  /** Whether the figures are sums of money (written with a currency sign). */
  readonly money: boolean;
  readonly groups: readonly string[];
  readonly base: number;
}

const BAR_TOPICS: readonly GroupTopic[] = [
  {
    title: "Sales by region",
    money: true,
    groups: ["North", "South", "East", "West"],
    base: 24_000,
  },
  {
    title: "Sales by region",
    money: true,
    groups: ["EMEA", "Americas", "APAC", "LatAm"],
    base: 36_000,
  },
  {
    title: "Orders by region",
    money: false,
    groups: ["North", "Central", "South", "Online"],
    base: 820,
  },
];

const DONUT_TOPICS: readonly GroupTopic[] = [
  {
    title: "Traffic sources",
    money: false,
    groups: ["Direct", "Search", "Social", "Email"],
    base: 12_000,
  },
  {
    title: "Revenue mix",
    money: true,
    groups: ["Subscriptions", "Services", "Hardware", "Support"],
    base: 30_000,
  },
  { title: "Users by plan", money: false, groups: ["Free", "Starter", "Pro", "Team"], base: 9_000 },
];

const TABLE_TOPICS: readonly GroupTopic[] = [
  {
    title: "Top products",
    money: true,
    groups: ["Starter plan", "Pro plan", "Team plan", "Enterprise", "Add-ons", "Training"],
    base: 18_000,
  },
  {
    title: "Top pages",
    money: false,
    groups: ["/home", "/pricing", "/features", "/blog", "/docs", "/signup"],
    base: 9_500,
  },
  {
    title: "Top campaigns",
    money: true,
    groups: [
      "Spring launch",
      "Webinar series",
      "Newsletter",
      "Partner promo",
      "Retargeting",
      "Referral",
    ],
    base: 6_400,
  },
];

/** Relative sizes of a group's members, largest first, so totals and tables look natural. */
const SHARES = [1, 0.74, 0.55, 0.42, 0.33, 0.27];

/** Seasonal amplitude of each kind of walk. */
const AMP = 0.08;

export interface Dashboard {
  readonly seed: number;
  /** Ticks so far. */
  tick: number;
  readonly kpis: readonly KpiDef[];
  readonly kpiWalks: readonly Walk[];
  readonly lineTitle: string;
  readonly lineMoney: boolean;
  readonly lineNames: readonly string[];
  readonly lineWalks: readonly Walk[];
  readonly barTitle: string;
  readonly barMoney: boolean;
  readonly barGroups: readonly string[];
  /** This period's and the previous period's bar values. */
  readonly barNow: Float64Array;
  readonly barPrev: Float64Array;
  readonly barWalks: readonly Walk[];
  readonly donutTitle: string;
  readonly donutMoney: boolean;
  readonly donutNames: readonly string[];
  readonly donutWalks: readonly Walk[];
  readonly tableTitle: string;
  readonly tableMoney: boolean;
  readonly tableNames: readonly string[];
  readonly tableWalks: readonly Walk[];
}

/** What a tick changed, as flags. */
export const UPDATE_LINE = 1;
export const UPDATE_BARS = 2;
export const UPDATE_DONUT = 4;
export const UPDATE_TABLE = 8;
/** KPI tile `i` changed: `UPDATE_KPI << i`. */
export const UPDATE_KPI = 16;

/** Picks `n` distinct indices below `of` with `rng`, in a shuffled order. */
function pick(rng: () => number, n: number, of: number): number[] {
  const all = Array.from({ length: of }, (_, i) => i);
  for (let i = of - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n);
}

/** Walk keys: one block per card, so each walk's stream is its own. */
const KEY_KPI = 0;
const KEY_LINE = 100;
const KEY_BAR = 200;
const KEY_DONUT = 300;
const KEY_TABLE = 400;

/** A dashboard for `seed`, its histories already full. */
export function createDashboard(seed: number): Dashboard {
  const rng = createRng(hash32(Math.floor(seed) ^ 0x2b0d));
  const kpis = pick(rng, KPI_COUNT, KPIS.length).map((i) => KPIS[i]);
  const line = LINE_TOPICS[Math.floor(rng() * LINE_TOPICS.length)];
  const bar = BAR_TOPICS[Math.floor(rng() * BAR_TOPICS.length)];
  const donut = DONUT_TOPICS[Math.floor(rng() * DONUT_TOPICS.length)];
  const table = TABLE_TOPICS[Math.floor(rng() * TABLE_TOPICS.length)];
  /** A little spread on each base, so seeds differ in their numbers too. */
  const jitter = () => 0.8 + 0.4 * rng();
  const warm = WALK_HISTORY;
  const barWalks = bar.groups.map((_, i) =>
    createWalk(seed, KEY_BAR + i, bar.base * (0.6 + 0.8 * rng()), AMP, warm),
  );
  const d: Dashboard = {
    seed,
    tick: 0,
    kpis,
    kpiWalks: kpis.map((k, i) => createWalk(seed, KEY_KPI + i, k.base * jitter(), AMP, warm)),
    lineTitle: line.title,
    lineMoney: line.money,
    lineNames: line.series,
    lineWalks: line.series.map((_, i) =>
      createWalk(seed, KEY_LINE + i, line.bases[i] * jitter(), AMP * 1.5, warm),
    ),
    barTitle: bar.title,
    barMoney: bar.money,
    barGroups: bar.groups,
    barNow: new Float64Array(BAR_GROUPS),
    barPrev: new Float64Array(BAR_GROUPS),
    barWalks,
    donutTitle: donut.title,
    donutMoney: donut.money,
    donutNames: donut.groups,
    donutWalks: donut.groups.map((_, i) =>
      createWalk(seed, KEY_DONUT + i, donut.base * SHARES[i] * jitter(), AMP, warm),
    ),
    tableTitle: table.title,
    tableMoney: table.money,
    tableNames: table.groups,
    tableWalks: table.groups.map((_, i) =>
      createWalk(seed, KEY_TABLE + i, table.base * SHARES[i] * jitter(), AMP, warm),
    ),
  };
  for (let i = 0; i < BAR_GROUPS; i++) {
    d.barNow[i] = walkAt(barWalks[i], 0);
    d.barPrev[i] = walkAt(barWalks[i], 1);
  }
  return d;
}

/** The KPI tile and the card (0 bars, 1 donut, 2 table) that step on tick `tick`. */
const kpiOnTick = (tick: number): number => tick % KPI_COUNT;
const cardOnTick = (tick: number): number => tick % 3;

/** Advances one tick and returns what changed (`UPDATE_*` flags). */
export function stepDashboard(d: Dashboard): number {
  const t = d.tick;
  d.tick++;
  for (const w of d.lineWalks) {
    stepWalk(w);
  }
  const k = kpiOnTick(t);
  stepWalk(d.kpiWalks[k]);
  let flags = UPDATE_LINE | (UPDATE_KPI << k);
  const card = cardOnTick(t);
  if (card === 0) {
    for (let i = 0; i < BAR_GROUPS; i++) {
      d.barPrev[i] = d.barNow[i];
      d.barNow[i] = stepWalk(d.barWalks[i]);
    }
    flags |= UPDATE_BARS;
  } else if (card === 1) {
    for (const w of d.donutWalks) {
      stepWalk(w);
    }
    flags |= UPDATE_DONUT;
  } else {
    for (const w of d.tableWalks) {
      stepWalk(w);
    }
    flags |= UPDATE_TABLE;
  }
  return flags;
}

/** Change of a KPI's newest value against the one a season (a week) before, as a fraction. */
export function kpiChange(w: Walk): number {
  const now = walkAt(w, 0);
  const before = walkAt(w, SEASON);
  return before > 0 ? (now - before) / before : 0;
}

// ---------------------------------------------------------------------------
// Count-up

/** A number easing from one value to another, as a KPI counts to its new figure. */
export interface CountUp {
  value: number;
  from: number;
  to: number;
  /** Progress, 0..1; 1 at rest. */
  t: number;
  seconds: number;
}

export const createCountUp = (value: number, seconds: number): CountUp => ({
  value,
  from: value,
  to: value,
  t: 1,
  seconds,
});

/** Starts counting from the shown value to `to`. */
export function countTo(c: CountUp, to: number): void {
  c.from = c.value;
  c.to = to;
  c.t = c.from === to ? 1 : 0;
}

/** Shows `v` at once. */
export function snapCount(c: CountUp, v: number): void {
  c.value = c.from = c.to = v;
  c.t = 1;
}

/** Advances by `dt` seconds; returns whether the shown value changed. Lands exactly on `to`. */
export function stepCount(c: CountUp, dt: number): boolean {
  if (c.t >= 1) {
    return false;
  }
  c.t = c.seconds > 0 && dt >= 0 ? Math.min(1, c.t + dt / c.seconds) : 1;
  c.value = c.t >= 1 ? c.to : c.from + (c.to - c.from) * smoothstep(0, 1, c.t);
  return true;
}
