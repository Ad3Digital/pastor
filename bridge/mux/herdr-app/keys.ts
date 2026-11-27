import { parseMuxKey } from "../keys.ts";

// The contract's neutral key spelling → herdr-core's own key names.
//
// Probed against herdr-core 0.1.22 on 2026-11-27 (MUX_CONTRACT.md, source **HA**), by pressing every
// key below into a terminal that swallows input:
//
//  • Every NAMED key of the contract has an hc name, and hc reads names without regard to case:
//    `Enter`, `Escape`, `PageUp`, `Insert` and `F12` are all taken as spelled.
//  • Modifiers join with `+`, as the contract spells them: `ctrl+c`, `alt+Up`, `shift+Tab`,
//    `meta+a`, and two at once (`ctrl+alt+a`).
//  • A single character is a key only when it is one an unshifted US key prints: letters, digits and
//    `'` `,` `-` `.` `/` `;` `=` `[` `\` `]` and the backtick. hc answers `unknown key` for the shifted
//    ones and for every character outside ASCII, so those are refused here before anything is sent.

/**
 * The single characters hc has no key for. Each is what a US keyboard prints with Shift held.
 *
 * Declared as the adapter's `unsupportedKeys`, so the Keys tray greys them rather than letting a
 * press fail on the wire.
 */
export const HERDR_APP_UNSENDABLE_KEYS: readonly string[] = [
  "!",
  '"',
  "#",
  "$",
  "%",
  "&",
  "(",
  ")",
  "*",
  "+",
  ":",
  "<",
  ">",
  "?",
  "@",
  "^",
  "_",
  "{",
  "|",
  "}",
  "~",
];

const UNSENDABLE = new Set<string>(HERDR_APP_UNSENDABLE_KEYS);

/** Printable ASCII, the only single characters hc has key names for. */
const ASCII_KEY = /^[\x21-\x7e]$/u;

export type HerdrAppKeyRejection = "unparsed" | "unsendable";

export type HerdrAppKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: HerdrAppKeyRejection };

/** One neutral key spelling as hc names it, or why hc has no such key. */
export function toHerdrAppKey(spelling: string): HerdrAppKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  // A space character is the Space key, which hc names.
  if (parsed.key === " ") return { ok: true, key: [...parsed.modifiers, "space"].join("+") };
  const single = [...parsed.key].length === 1;
  if (single && (UNSENDABLE.has(parsed.key) || !ASCII_KEY.test(parsed.key))) return { ok: false, reason: "unsendable" };
  // A named key is lower-cased to hc's own spelling. A character keeps its case: `A` is its own key.
  const key = single ? parsed.key : parsed.key.toLowerCase();
  return { ok: true, key: [...parsed.modifiers, key].join("+") };
}
