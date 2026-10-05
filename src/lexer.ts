import { ParseError } from "./errors.js";

export type TokenType =
  | "num"
  | "ident"
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "("
  | ")"
  | "eof";

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const NUMBER_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-zµμΩ°]+/uy;

const PUNCT: Record<string, TokenType> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "^": "^",
  "(": "(",
  ")": ")",
};

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    NUMBER_RE.lastIndex = i;
    const numMatch = NUMBER_RE.exec(src);
    if (numMatch !== null) {
      tokens.push({ type: "num", text: numMatch[0], start: i, end: i + numMatch[0].length });
      i += numMatch[0].length;
      continue;
    }
    IDENT_RE.lastIndex = i;
    const identMatch = IDENT_RE.exec(src);
    if (identMatch !== null) {
      tokens.push({ type: "ident", text: identMatch[0], start: i, end: i + identMatch[0].length });
      i += identMatch[0].length;
      continue;
    }
    const punct = PUNCT[ch];
    if (punct !== undefined) {
      tokens.push({ type: punct, text: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`, i, i + 1);
  }
  tokens.push({ type: "eof", text: "", start: src.length, end: src.length });
  return tokens;
}
