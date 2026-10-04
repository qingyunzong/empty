export type TokenKind = "num" | "ident" | "op" | "eof";

export interface Token {
  kind: TokenKind;
  text: string;
  /** Half-open character range [start, end) in the source. */
  start: number;
  end: number;
}

export class LexError extends Error {
  constructor(message: string, readonly start: number, readonly end: number) {
    super(message);
    this.name = "LexError";
  }
}

const OPS = new Set(["+", "-", "*", "/", "^", "(", ")"]);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    const start = i;
    if (ch >= "0" && ch <= "9") {
      i++;
      while (i < src.length && src[i]! >= "0" && src[i]! <= "9") i++;
      if (src[i] === "." && src[i + 1] !== undefined && src[i + 1]! >= "0" && src[i + 1]! <= "9") {
        i++;
        while (i < src.length && src[i]! >= "0" && src[i]! <= "9") i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j++;
        if (src[j] !== undefined && src[j]! >= "0" && src[j]! <= "9") {
          j++;
          while (j < src.length && src[j]! >= "0" && src[j]! <= "9") j++;
          i = j;
        }
      }
      tokens.push({ kind: "num", text: src.slice(start, i), start, end: i });
      continue;
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      i++;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      tokens.push({ kind: "ident", text: src.slice(start, i), start, end: i });
      continue;
    }
    if (OPS.has(ch)) {
      i++;
      tokens.push({ kind: "op", text: ch, start, end: i });
      continue;
    }
    throw new LexError(`unexpected character '${ch}'`, start, start + 1);
  }
  tokens.push({ kind: "eof", text: "", start: src.length, end: src.length });
  return tokens;
}
