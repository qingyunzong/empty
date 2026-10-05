import { SyntaxError_ } from "./errors.js";

export type TokenType = "num" | "op" | "lparen" | "rparen" | "question" | "colon" | "eof";

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
}

const MULTI_OPS = ["**", "&&", "||", "<=", ">=", "==", "!="];
const SINGLE_OPS = ["+", "-", "*", "<", ">"];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const start = i;
      while (i < source.length && source[i]! >= "0" && source[i]! <= "9") i++;
      tokens.push({ type: "num", value: source.slice(start, i), start, end: i });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: "op", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.includes(ch)) {
      tokens.push({ type: "op", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "?") {
      tokens.push({ type: "question", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: "colon", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new SyntaxError_(`unexpected character ${JSON.stringify(ch)}`, { start: i, end: i + 1 }, source);
  }
  tokens.push({ type: "eof", value: "", start: source.length, end: source.length });
  return tokens;
}
