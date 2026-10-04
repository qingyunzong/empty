export type TokenType = "ident" | "keyword" | "number" | "string" | "punct" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  /** Byte/UTF-16 code-unit offset of the first character (inclusive). */
  start: number;
  /** Offset one past the last character (exclusive). */
  end: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  "let",
  "var",
  "const",
  "function",
  "return",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const TWO_CHAR_PUNCT = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const ONE_CHAR_PUNCT = new Set([..."{}()=;,.+-*/<>"]);

export function isIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !KEYWORDS.has(name);
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      if (i >= n) throw new SyntaxError(`Unterminated block comment at offset ${i}`);
      i += 2;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_PART.test(source[i]!)) i++;
      const value = source.slice(start, i);
      tokens.push({ type: KEYWORDS.has(value) ? "keyword" : "ident", value, start, end: i });
      continue;
    }
    if (DIGIT.test(c)) {
      const start = i;
      while (i < n && /[0-9.]/.test(source[i]!)) i++;
      tokens.push({ type: "number", value: source.slice(start, i), start, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
      if (i >= n) throw new SyntaxError(`Unterminated string at offset ${start}`);
      i++;
      tokens.push({ type: "string", value: source.slice(start, i), start, end: i });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_PUNCT.has(two)) {
      tokens.push({ type: "punct", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (ONE_CHAR_PUNCT.has(c)) {
      tokens.push({ type: "punct", value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new SyntaxError(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ type: "eof", value: "", start: n, end: n });
  return tokens;
}
