// Latin/digit runs become one lowercase token; each CJK char is its own
// token so Chinese phrases like "换模后延迟" match positionally.
const TOKEN_RE = /[A-Za-z0-9]+|[一-鿿]/g;

export function tokenize(text) {
  const tokens = [];
  for (const m of String(text).matchAll(TOKEN_RE)) {
    tokens.push(m[0].length > 1 && /[A-Za-z0-9]/.test(m[0]) ? m[0].toLowerCase() : m[0]);
  }
  return tokens;
}
