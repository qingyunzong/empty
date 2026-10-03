// Tokenizer: produces tokens with global position and paragraph id.
// Paragraphs are separated by blank lines. Tokens are maximal runs of
// unicode letters/numbers, lowercased. Positions increase globally so a
// phrase can only match across a paragraph boundary if the paragraph
// check is skipped -- the engine always checks paragraph equality.

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text) {
  const tokens = [];
  const paragraphs = String(text).split(/\r?\n[ \t]*\r?\n/);
  let pos = 0;
  paragraphs.forEach((paraText, para) => {
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(paraText)) !== null) {
      tokens.push({ term: m[0].toLowerCase(), pos: pos++, para });
    }
  });
  return tokens;
}

// Tokenize a query string into terms (positions/paragraphs irrelevant).
export function queryTerms(text) {
  return tokenize(text).map((t) => t.term);
}
