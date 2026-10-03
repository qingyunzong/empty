// Tokens: maximal runs of ASCII alphanumerics and CJK ideographs, so alarm
// codes like 原因码C101 or T201 stay a single term. Everything else
// (punctuation, whitespace) is a separator, never a token.
const TOKEN_RE = /[0-9A-Za-z一-鿿]+/g;

function normalize(raw) {
  return raw.toLowerCase();
}

// Splits text into tokens with monotonically increasing positions (0-based,
// document-global). Paragraphs are separated by blank lines; `paragraphs`
// holds the token position at which each paragraph starts.
export function tokenize(text) {
  if (typeof text !== 'string') {
    throw new TypeError('tokenize expects a string');
  }
  const tokens = [];
  const paragraphs = [];
  let pos = 0;
  for (const para of text.split(/\r?\n(?:[ \t]*\r?\n)+/)) {
    paragraphs.push(pos);
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(para)) !== null) {
      tokens.push(normalize(m[0]));
      pos += 1;
    }
  }
  return { tokens, paragraphs };
}

// True iff token positions a..b (inclusive, a <= b) lie in one paragraph.
export function sameParagraph(paragraphs, a, b) {
  for (const start of paragraphs) {
    if (start > a && start <= b) return false;
  }
  return true;
}
