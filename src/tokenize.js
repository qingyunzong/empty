const TOKEN_RE = /[\p{L}\p{N}]+/gu;

// Splits free text into lowercase terms; a token's position is its 0-based
// ordinal among tokens, which is what the positional index stores.
export function tokenize(text) {
  const tokens = [];
  const re = new RegExp(TOKEN_RE.source, 'gu');
  let match;
  while ((match = re.exec(String(text))) !== null) {
    tokens.push(match[0].toLowerCase());
  }
  return tokens;
}

export function normalizeTerm(term) {
  const tokens = tokenize(term);
  if (tokens.length !== 1) {
    throw new Error(`query term must be a single token, got: ${JSON.stringify(term)}`);
  }
  return tokens[0];
}
