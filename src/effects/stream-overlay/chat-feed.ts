/**
 * The chat column's made-up chat, without any drawing: who says what, when
 * messages arrive, and how they are batched into the column's steps.
 *
 * Message number `i` is fixed by the seed alone (its viewer, badge, words, and
 * whether it is a follow or subscribe event), so the chat reads the same
 * whatever the busy slider does; only the arrival times depend on it. The
 * viewer's own lines, when given, are mixed in among the built-in ones.
 */
import { hash32 } from "../noise";
import { sanitizeText } from "../params";
import { chatMeta } from "./chat.meta";
import { emoteIndex } from "./emote-art";
import { makeUsername } from "./usernames";

/**
 * Built-in messages: short, friendly and generic, about no real game, person,
 * brand or platform. `:id:` is one of the emotes in `emote-art.ts`.
 */
export const CHAT_MESSAGES: readonly string[] = [
  "hi chat",
  "hello everyone :wave:",
  "hey hey :wave:",
  "good morning from the night shift",
  "evening all",
  "hi! just got here",
  "first time here, love the vibe",
  "back again :happy:",
  "that jump was clean",
  "gg",
  "gg :gg:",
  "lol",
  "lol :lol:",
  ":laugh: :laugh:",
  ":lol: :lol: :lol:",
  ":heart:",
  ":heart: :heart:",
  ":fire: :fire:",
  ":wow:",
  ":hearteyes:",
  ":cool:",
  ":wave:",
  ":party: :party:",
  ":star:",
  ":ghost:",
  ":cat:",
  ":trophy:",
  ":sleepy:",
  "how long have you been live today?",
  "the music is so good today",
  "what's this song? :hearteyes:",
  "this is so relaxing",
  "love the setup",
  "the lighting in here is lovely",
  "cozy stream tonight :happy:",
  "so close!",
  "nooo :lol:",
  "almost had it",
  "you've got this :fire:",
  "clean :cool:",
  "that was smooth",
  "nice nice nice",
  "wait what just happened :wow:",
  "how did that work lol",
  "big brain move",
  "calm and collected as always",
  "let's goooo :party:",
  "that was huge",
  "no way :wow:",
  "called it",
  "I knew it",
  "hydration check :happy:",
  "remember to stretch!",
  "posture check",
  "snack break soon?",
  "just made tea, ready for the stream",
  "brought snacks :party:",
  "working and watching, perfect combo",
  "studying with the stream on :happy:",
  "lurking but loving it",
  "lurk mode on :sleepy:",
  "back from lunch, what did I miss?",
  "what did I miss?",
  "chat is so wholesome today :heart:",
  "this chat is the best",
  "hi to everyone in chat :wave:",
  "welcome in, new folks :wave:",
  "cat cameo when? :cat:",
  "is that a new chair?",
  "the plant is thriving",
  "the new overlay looks great",
  "the colours today are so nice",
  "best part of my day",
  "needed this today :heart:",
  "thanks for streaming :heart:",
  "appreciate you :heart:",
  "such a chill vibe",
  "good luck on this one",
  "fingers crossed",
  "one more try!",
  "you'll get it next time",
  "that was so close lol",
  "the comeback is real",
  "okay that was impressive",
  "textbook :cool:",
  "smooth as butter",
  "I'm learning so much",
  "how do you stay so calm",
  "that timing though",
  "perfect timing",
  "clutch :fire:",
  "huge",
  "nice :happy:",
  "nice one",
  "wow :wow:",
  "amazing",
  "beautiful :hearteyes:",
  "so good",
  "spooky :ghost:",
  "we're so back",
  "cheering from the couch :party:",
  "chat, we believe :star:",
  "greetings from a rainy afternoon",
  "sunny here today, hi all",
  "it's 2am here and I'm not leaving lol",
  "early bird crew :wave:",
  "night owls unite :sleepy:",
  "who else is up late?",
  "any plans for the weekend?",
  "what are we doing next?",
  "can we see that again?",
  "replay that please :lol:",
  "my heart :heart:",
  "okay I'm invested now",
  "the suspense :wow:",
  "you make it look easy",
  "did not see that coming",
  "ha! classic",
  "that's going in the highlights",
  "clip it :star:",
  "ten out of ten",
  "a masterpiece :trophy:",
  "champion behaviour :trophy:",
  "gg well played :gg:",
  "victory dance :party:",
  "so wholesome",
  "hi from the kitchen, cooking along",
  "my dog says hi",
  "my cat is watching too :cat:",
  "the vibes are immaculate",
  "I love this community :heart:",
  "happy to be here :happy:",
  "long time no see!",
  "missed the last stream, glad I caught this one",
  "same time next week?",
  "this background is so pretty",
  "ok this is my comfort stream now",
  "can't stop smiling :happy:",
  "haha",
  "hahaha :laugh:",
  "lmao :lol:",
  "oof",
  "oops lol",
  "it happens",
  "all good, shake it off",
  "deep breaths, you've got it",
  "focus mode :cool:",
  "locked in :fire:",
  "on fire today :fire:",
  "the confidence :cool:",
  "legendary",
  "iconic",
  "sending good vibes :star:",
  "cheers :party:",
  "hello from across the ocean :wave:",
  "just here for the good company",
  "quiet day in chat, I like it",
  "peaceful :sleepy:",
  "o7",
  "gg everyone",
];

/** What an event line says after the viewer's name. */
export const CHAT_EVENT_TEXTS: readonly string[] = ["followed!", "subscribed!"];

/** Badge shapes a viewer may wear before their name (`ChatMessage.badge` 1 to this). */
export const CHAT_BADGE_COUNT = 4;

/** One chat line. Plain data, made once when the line arrives. */
export interface ChatMessage {
  /** Its number in the chat, from 0. */
  readonly index: number;
  /** Who said it: their number (for `makeUsername`) and name. */
  readonly user: number;
  readonly name: string;
  /** 0 for none, else which badge shape (1 to `CHAT_BADGE_COUNT`). */
  readonly badge: number;
  /** The message, or for an event what happened ("followed!"). */
  readonly text: string;
  /** A highlighted event line rather than something said. */
  readonly event: boolean;
}

/** Messages per minute: about 4 at `busy` 0, 120 at 1, evenly spaced on a log scale. */
export function chatRate(busy: number): number {
  const b = Number.isFinite(busy) ? Math.min(1, Math.max(0, busy)) : 0.3;
  return 4 * 30 ** b;
}

/** Messages already in the column when it starts, so it never begins empty. */
export const CHAT_PREFILL = 24;

/** The column moves at most once in this many seconds, so under twice a second. */
export const CHAT_STEP_SECONDS = 0.6;

/** The most messages one step brings in. */
export const CHAT_MAX_BATCH = 2;

/** Messages waiting beyond this many are dropped, oldest first. */
const MAX_BACKLOG = 6;

/** Regulars: viewers who chat again and again, numbered from 0. Others are new each time. */
const REGULARS = 24;
const REGULAR_SHARE = 0.7;
/** Viewer numbers for one-off viewers start here, plus the message number. */
const NEW_VIEWER_BASE = 1000;

/** Share of messages that are follow or subscribe events. */
const EVENT_SHARE = 0.05;
/**
 * Share of messages taken from the viewer's own lines: this much per line,
 * up to `OWN_SHARE_MAX`, so a single line doesn't come round too often.
 */
const OWN_SHARE_PER_LINE = 0.06;
const OWN_SHARE_MAX = 0.3;
/** Share of viewers wearing a badge. */
const BADGE_SHARE = 0.45;

/** Salts that keep each seeded choice independent of the others. */
const SALT_GAP = 1;
const SALT_EVENT = 2;
const SALT_REGULAR = 3;
const SALT_REGULAR_PICK = 4;
const SALT_OWN = 5;
const SALT_OWN_PICK = 6;
const SALT_EVENT_TEXT = 7;
const SALT_BADGE = 8;
const SALT_ORDER = 9;

/** A seeded unit value in [0, 1) for `seed`, `salt` and the integer `i`. */
function unit(seed: number, salt: number, i: number): number {
  return hashOf(seed, salt, i) / 4294967296;
}

function hashOf(seed: number, salt: number, i: number): number {
  return hash32(hash32(seed ^ Math.imul(salt, 0x9e3779b1)) ^ hash32(i + 0x632be5ab));
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Which built-in message number `index` uses: the list in a seeded order that
 * changes every pass through it, so a message doesn't come back until the rest
 * have been used.
 */
function builtIn(seed: number, index: number): string {
  const n = CHAT_MESSAGES.length;
  const pass = Math.floor(index / n);
  let stride = 1 + (hashOf(seed, SALT_ORDER, 2 * pass) % (n - 1));
  while (gcd(stride, n) !== 1) {
    stride = (stride % (n - 1)) + 1;
  }
  const offset = hashOf(seed, SALT_ORDER, 2 * pass + 1) % n;
  return CHAT_MESSAGES[(offset + stride * (index - pass * n)) % n];
}

/**
 * The viewer's own messages from the `chatLines` text: sanitised as the text
 * param is (so a value that didn't come through the panel is safe too), with
 * runs of spaces collapsed and blank lines dropped.
 */
export function parseChatLines(text: string): string[] {
  const def = chatMeta.params.chatLines;
  if (def.kind !== "text") {
    return [];
  }
  return sanitizeText(def, text)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

/** Viewer `user`'s badge: 0 for none, else a shape from 1 to `CHAT_BADGE_COUNT`. */
export function chatBadge(seed: number, user: number): number {
  return unit(seed, SALT_BADGE, user) < BADGE_SHARE
    ? 1 + (hashOf(seed, SALT_BADGE + 100, user) % CHAT_BADGE_COUNT)
    : 0;
}

/**
 * Chat message number `index` under `seed`, sometimes one of `own` (the
 * viewer's own lines, from `parseChatLines`): 6 % of messages per line, up to
 * 30 % from five lines on. Allocates: call it once per message, when it arrives.
 */
export function chatMessage(seed: number, index: number, own: readonly string[]): ChatMessage {
  const event = index >= CHAT_PREFILL && unit(seed, SALT_EVENT, index) < EVENT_SHARE;
  const regular = !event && unit(seed, SALT_REGULAR, index) < REGULAR_SHARE;
  const user = regular
    ? hashOf(seed, SALT_REGULAR_PICK, index) % REGULARS
    : NEW_VIEWER_BASE + index;
  let text: string;
  if (event) {
    text = CHAT_EVENT_TEXTS[hashOf(seed, SALT_EVENT_TEXT, index) % CHAT_EVENT_TEXTS.length];
  } else if (
    own.length > 0 &&
    unit(seed, SALT_OWN, index) < Math.min(OWN_SHARE_MAX, OWN_SHARE_PER_LINE * own.length)
  ) {
    text = own[hashOf(seed, SALT_OWN_PICK, index) % own.length];
  } else {
    text = builtIn(seed, index);
  }
  return {
    index,
    user,
    name: makeUsername(seed, user),
    badge: chatBadge(seed, user),
    text,
    event,
  };
}

/**
 * Seconds from message `index`'s arrival to the next, at `busy`: the mean gap
 * for `chatRate(busy)`, spread from 0.3 to 1.7 times it.
 */
export function arrivalGap(seed: number, index: number, busy: number): number {
  return (60 / chatRate(busy)) * (0.3 + 1.4 * unit(seed, SALT_GAP, index));
}

/** A word of a chat line, or an emote (`emote` >= 0, an index into `EMOTE_IDS`). */
export interface ChatToken {
  readonly text: string;
  readonly emote: number;
}

/**
 * Splits a message into words and emotes: a word written `:id:` with `id` an
 * emote is that emote, anything else is a word. Allocates.
 */
export function chatTokens(text: string): ChatToken[] {
  const out: ChatToken[] = [];
  for (const word of text.split(" ")) {
    if (word === "") {
      continue;
    }
    const m = /^:([a-z]+):$/.exec(word);
    out.push({ text: word, emote: m === null ? -1 : emoteIndex(m[1]) });
  }
  return out;
}

/** The chat's clock: messages arriving, and steps of the column bringing them in. */
interface ChatFeed {
  /** Messages that have arrived (including `CHAT_PREFILL` from the start). */
  readonly arrived: number;
  /** Messages the column has brought in: numbers 0 to `released - 1`. */
  readonly released: number;
  /** Seconds since the feed started. */
  readonly time: number;
  /**
   * Advances `dt` seconds at `busy`. Returns how many messages the column
   * brings in now (0 for no step). Each gap between arrivals uses the busy
   * value at the arrival that starts it, so a change applies from the next
   * message on. Steps come at least `CHAT_STEP_SECONDS` apart and bring at
   * most `CHAT_MAX_BATCH` messages, the rest waiting for the next.
   */
  step: (dt: number, busy: number) => number;
}

/** A feed under `seed`, starting with `CHAT_PREFILL` messages already in. */
export function createChatFeed(seed: number): ChatFeed {
  let time = 0;
  let arrived = CHAT_PREFILL;
  let released = CHAT_PREFILL;
  let nextAt = -1;
  let lastStep = -Infinity;
  return {
    get arrived() {
      return arrived;
    },
    get released() {
      return released;
    },
    get time() {
      return time;
    },
    step(dt, busy) {
      time += Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (nextAt < 0) {
        nextAt = arrivalGap(seed, arrived - 1, busy);
      }
      // After a long pause (a stalled tab), start counting again from now.
      if (time - nextAt > 60) {
        nextAt = time;
      }
      while (time >= nextAt) {
        nextAt += arrivalGap(seed, arrived, busy);
        arrived++;
      }
      released = Math.max(released, arrived - MAX_BACKLOG);
      if (arrived > released && time - lastStep >= CHAT_STEP_SECONDS) {
        const n = Math.min(CHAT_MAX_BATCH, arrived - released);
        released += n;
        lastStep = time;
        return n;
      }
      return 0;
    },
  };
}
