// Tokenizer shared by indexing and querying.
// - CJK ideographs become single-character tokens.
// - ASCII letter/digit runs become one lowercased token.
// - Everything else (whitespace, punctuation) is a separator.
// Positions increment by 1 per emitted token.

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[A-Za-z0-9]/;

export function tokenize(text) {
  const tokens = [];
  let pos = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (CJK_RE.test(ch)) {
      tokens.push({ term: ch, pos: pos++ });
      i += 1;
    } else if (WORD_RE.test(ch)) {
      let j = i;
      while (j < text.length && WORD_RE.test(text[j])) j += 1;
      tokens.push({ term: text.slice(i, j).toLowerCase(), pos: pos++ });
      i = j;
    } else {
      i += 1;
    }
  }
  return tokens;
}

// Compile a query term (e.g. "轴承" or "Pump2") into the token-term
// sequence it must match consecutively.
export function compileTerm(term) {
  return tokenize(term).map((t) => t.term);
}
