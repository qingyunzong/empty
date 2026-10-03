import { tokenize } from './tokenize.js';

// Independent precise verification: a plain linear scan over the token
// array. It deliberately does NOT reuse index positions, so index bugs
// cannot mask verification bugs.
//
// A job matches when:
//   1. the phrase (e.g. "低温 固化") occurs as consecutive tokens, AND
//   2. material code and equipment code both occur, with at least one
//      pair whose distance |posA - posB| <= maxDistance (in words).
// hits = (#phrase occurrences) + (#qualifying material/equipment pairs)
export function verifyTokens(tokens, { phrase, material, equipment, maxDistance }) {
  const phraseTokens = tokenize(phrase);

  const phraseHits = [];
  for (let i = 0; i + phraseTokens.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) {
        ok = false;
        break;
      }
    }
    if (ok) phraseHits.push(i);
  }

  const materialPos = [];
  const equipmentPos = [];
  tokens.forEach((t, i) => {
    if (t === material) materialPos.push(i);
    if (t === equipment) equipmentPos.push(i);
  });

  const pairs = [];
  for (const m of materialPos) {
    for (const e of equipmentPos) {
      const distance = Math.abs(m - e);
      if (distance <= maxDistance) {
        pairs.push({ materialPos: m, equipmentPos: e, distance });
      }
    }
  }

  const matched = phraseHits.length > 0 && pairs.length > 0;
  const hits = phraseHits.length + pairs.length;
  return { matched, phraseHits, pairs, hits };
}
