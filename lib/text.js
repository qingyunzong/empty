// Tokenizer shared by indexing, querying and brute-force verification.
// Tokens: single CJK characters, or ASCII alphanumeric words (lowercased).

const TOKEN_RE = /[㐀-鿿]|[A-Za-z0-9]+/gu;
const CJK_RE = /^[㐀-鿿]$/u;

export function tokenize(text) {
  const tokens = [];
  for (const match of String(text).matchAll(TOKEN_RE)) {
    const tok = match[0];
    tokens.push(tok.length === 1 && CJK_RE.test(tok) ? tok : tok.toLowerCase());
  }
  return tokens;
}

// Brute-force phrase check: token sequence must appear contiguously.
export function containsPhrase(text, phrase) {
  const tokens = tokenize(text);
  const needle = tokenize(phrase);
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= tokens.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (tokens[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
