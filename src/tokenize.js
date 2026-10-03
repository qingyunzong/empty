// Tokenizer: whitespace split only. Codes like "M-101" stay intact.
// Position of a token is its index in the returned array.
export function tokenize(text) {
  return text.split(/\s+/u).filter((t) => t.length > 0);
}
