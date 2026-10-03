// Positional inverted index over batch remark text.
// Tokens: ASCII alnum runs, or single CJK characters; all lowercased.

export function tokenize(text) {
  const tokens = [];
  const re = /[A-Za-z0-9]+|[一-鿿]/g;
  let m;
  while ((m = re.exec(String(text))) !== null) tokens.push(m[0].toLowerCase());
  return tokens;
}

export class TextIndex {
  constructor() {
    this.docs = new Map(); // id -> token array (positions are array indices)
  }

  add(id, text) {
    this.docs.set(id, tokenize(text));
  }

  // Exact phrase: query tokens must appear consecutively.
  phrase(query) {
    const qt = tokenize(query);
    if (qt.length === 0) return [];
    const hits = [];
    for (const [id, tokens] of this.docs) {
      outer: for (let i = 0; i + qt.length <= tokens.length; i++) {
        for (let j = 0; j < qt.length; j++) {
          if (tokens[i + j] !== qt[j]) continue outer;
        }
        hits.push(id);
        break;
      }
    }
    return hits;
  }

  // NEAR/k: first token of a and first token of b occur within |pa - pb| <= k.
  near(a, b, k = 3) {
    const [ta] = tokenize(a);
    const [tb] = tokenize(b);
    if (ta === undefined || tb === undefined) return [];
    const hits = [];
    for (const [id, tokens] of this.docs) {
      let best = Infinity;
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== ta) continue;
        for (let j = 0; j < tokens.length; j++) {
          if (tokens[j] !== tb) continue;
          const d = Math.abs(i - j);
          if (d < best) best = d;
        }
      }
      if (best <= k) hits.push(id);
    }
    return hits;
  }
}
