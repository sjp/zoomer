/**
 * Made-up viewer names for the stream overlays (chat, alerts, the goal bar's
 * ticker): a word from each of two short, hand-picked lists, written in one of
 * a few common styles (`mossy_kettle`, `PixelOtter42`, `quietcomet`), with an
 * optional number from a third list.
 *
 * Built only from these lists, never from random letters, so a name can't
 * spell anything unkind or belong to a real person. Seeded and stable: the
 * same seed and viewer number always give the same name.
 */
import { hash32 } from "../noise";

/** The first word: gentle describing words. */
export const USERNAME_FIRST_WORDS: readonly string[] = [
  "amber",
  "bouncy",
  "breezy",
  "cheery",
  "cloudy",
  "cocoa",
  "comfy",
  "cosmic",
  "cozy",
  "crispy",
  "dusky",
  "fizzy",
  "frosty",
  "fuzzy",
  "gentle",
  "golden",
  "happy",
  "honey",
  "jolly",
  "lucky",
  "lunar",
  "maple",
  "mellow",
  "minty",
  "misty",
  "mossy",
  "neon",
  "nimble",
  "pixel",
  "plucky",
  "quiet",
  "retro",
  "rosy",
  "rusty",
  "shiny",
  "silly",
  "silver",
  "sleepy",
  "snowy",
  "soft",
  "sparkly",
  "starry",
  "stormy",
  "sunny",
  "tidy",
  "tiny",
  "toasty",
  "twinkly",
  "velvet",
  "windy",
  "wobbly",
  "zesty",
];

/** The second word: small animals, snacks and everyday things. */
export const USERNAME_SECOND_WORDS: readonly string[] = [
  "acorn",
  "badger",
  "beetle",
  "biscuit",
  "bramble",
  "button",
  "cactus",
  "comet",
  "crumpet",
  "dumpling",
  "falcon",
  "fern",
  "firefly",
  "gecko",
  "goose",
  "hedgehog",
  "heron",
  "kettle",
  "kiwi",
  "koala",
  "lantern",
  "lemur",
  "llama",
  "mango",
  "marble",
  "meadow",
  "mitten",
  "moth",
  "muffin",
  "newt",
  "noodle",
  "otter",
  "owl",
  "panda",
  "parsnip",
  "pebble",
  "penguin",
  "pickle",
  "pigeon",
  "pinecone",
  "pretzel",
  "puffin",
  "quokka",
  "radish",
  "raven",
  "robin",
  "rocket",
  "sparrow",
  "sprout",
  "teapot",
  "thimble",
  "toad",
  "tofu",
  "turnip",
  "waffle",
  "walrus",
  "wombat",
];

/** Numbers a name may end with: picked by hand, leaving out ones with unkind meanings. */
export const USERNAME_NUMBERS: readonly string[] = [
  "2",
  "3",
  "5",
  "7",
  "8",
  "9",
  "11",
  "12",
  "21",
  "22",
  "27",
  "42",
  "64",
  "77",
  "99",
  "101",
  "123",
  "256",
  "404",
  "777",
];

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** Hashes of `seed`, `user` and a small salt, so each choice is independent of the others. */
const hashOf = (seed: number, user: number, salt: number) =>
  hash32(hash32(seed ^ Math.imul(salt + 1, 0x9e3779b1)) ^ hash32(user + 0x632be5ab));

/**
 * The name of viewer number `user` (any integer) under `seed`. Allocates a
 * string: call it when a name is first needed, not every frame.
 */
export function makeUsername(seed: number, user: number): string {
  const a = USERNAME_FIRST_WORDS[hashOf(seed, user, 0) % USERNAME_FIRST_WORDS.length];
  const b = USERNAME_SECOND_WORDS[hashOf(seed, user, 1) % USERNAME_SECOND_WORDS.length];
  const n = USERNAME_NUMBERS[hashOf(seed, user, 2) % USERNAME_NUMBERS.length];
  switch (hashOf(seed, user, 3) % 6) {
    case 0:
      return `${a}_${b}`;
    case 1:
      return `${capital(a)}${capital(b)}${n}`;
    case 2:
      return `${a}${b}`;
    case 3:
      return `${a}${b}${n}`;
    case 4:
      return `${capital(a)}${capital(b)}`;
    default:
      return `${a}_${b}${n}`;
  }
}
