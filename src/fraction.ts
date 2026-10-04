/**
 * Fractional position keys: dense, totally-ordered strings.
 * `fracBetween(a, b)` always returns a key strictly between `a` and `b`
 * (`""` as `a` means -inf, `""` as `b` means +inf), so a new position
 * record can always be minted between two neighbours without coordination.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length; // 36

function rank(ch: string): number {
  const r = ALPHABET.indexOf(ch);
  if (r < 0) throw new Error(`invalid fraction character: ${ch}`);
  return r;
}

export function fracBetween(a: string, b: string): string {
  if (a !== "" && b !== "" && a >= b) {
    throw new Error(`fracBetween requires a < b, got ${a} >= ${b}`);
  }
  let result = "";
  let i = 0;
  // Once we emit a digit below b's digit, the rest of b no longer bounds us.
  let bReleased = b === "";
  while (true) {
    const da = i < a.length ? rank(a[i]!) : 0;
    const db = bReleased || i >= b.length ? BASE : rank(b[i]!);
    if (db - da > 1) {
      return result + ALPHABET[(da + db) >> 1];
    }
    result += ALPHABET[da];
    if (db - da === 1) bReleased = true;
    i++;
  }
}
