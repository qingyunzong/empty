export type TokenKind = "ident" | "keyword" | "number" | "string" | "punct" | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  /** Start offset, in UTF-16 code units, into the source string. */
  start: number;
  /** End offset (exclusive), in UTF-16 code units. */
  end: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  "let", "const", "function", "return", "if", "else", "while", "for", "of",
  "break", "continue", "true", "false", "null", "this", "typeof", "void",
  "delete", "in", "new", "do", "undefined",
]);

export class LexError extends Error {}

const PUNCT3 = ["===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??=", "..."];
const PUNCT2 = [
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "<<", ">>", "**",
];
const PUNCT1 = "{}()[];,.:+-*/%<>=!&|?~^";

function isIdStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const ch = source[i];

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) throw new LexError(`unterminated block comment at offset ${i}`);
      i = close + 2;
      continue;
    }
    if (isIdStart(ch)) {
      const start = i;
      while (i < n && isIdPart(source[i])) i++;
      const value = source.slice(start, i);
      tokens.push({ kind: KEYWORDS.has(value) ? "keyword" : "ident", value, start, end: i });
      continue;
    }
    if (isDigit(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_.]/.test(source[i])) i++;
      tokens.push({ kind: "number", value: source.slice(start, i), start, end: i });
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      i++;
      while (i < n && source[i] !== ch) {
        if (source[i] === "\\") i++;
        i++;
      }
      if (i >= n) throw new LexError(`unterminated string at offset ${start}`);
      i++;
      tokens.push({ kind: "string", value: source.slice(start, i), start, end: i });
      continue;
    }
    const three = source.slice(i, i + 3);
    if (PUNCT3.includes(three)) {
      tokens.push({ kind: "punct", value: three, start: i, end: i + 3 });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      tokens.push({ kind: "punct", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (PUNCT1.includes(ch)) {
      tokens.push({ kind: "punct", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new LexError(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }

  tokens.push({ kind: "eof", value: "", start: n, end: n });
  return tokens;
}
