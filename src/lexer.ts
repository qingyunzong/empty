import { TemplateSyntaxError } from "./errors";
import type { SourcePosition } from "./errors";

export type TokenKind =
  | "text"
  | "openVar"
  | "closeVar"
  | "openTag"
  | "closeTag"
  | "ident"
  | "number"
  | "string"
  | "dot"
  | "pipe"
  | "lparen"
  | "rparen"
  | "comma"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  pos: SourcePosition;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const pos = (): SourcePosition => ({ offset: index, line, column });
  const advance = (count: number): void => {
    for (let n = 0; n < count; n++) {
      if (source[index] === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  let openToken: Token | undefined;

  const lexText = (): void => {
    const start = pos();
    let value = "";
    while (index < source.length) {
      const two = source.slice(index, index + 2);
      if (two === "{{" || two === "{%") break;
      value += source[index];
      advance(1);
    }
    if (value.length > 0) tokens.push({ kind: "text", value, pos: start });
  };

  const lexExpression = (): void => {
    for (;;) {
      while (index < source.length && /\s/.test(source[index] as string)) advance(1);
      if (index >= source.length) {
        throw new TemplateSyntaxError(
          `unterminated ${openToken?.kind === "openVar" ? "{{ ... }}" : "{% ... %}"}`,
          openToken?.pos
        );
      }
      const ch = source[index] as string;
      const here = pos();
      if (ch === "}" && source[index + 1] === "}") {
        tokens.push({ kind: "closeVar", value: "}}", pos: here });
        advance(2);
        return;
      }
      if (ch === "%" && source[index + 1] === "}") {
        tokens.push({ kind: "closeTag", value: "%}", pos: here });
        advance(2);
        return;
      }
      if (IDENT_START.test(ch)) {
        let value = "";
        while (index < source.length && IDENT_PART.test(source[index] as string)) {
          value += source[index];
          advance(1);
        }
        tokens.push({ kind: "ident", value, pos: here });
        continue;
      }
      if (DIGIT.test(ch)) {
        let value = "";
        while (index < source.length && DIGIT.test(source[index] as string)) {
          value += source[index];
          advance(1);
        }
        if (source[index] === "." && DIGIT.test(source[index + 1] ?? "")) {
          value += source[index];
          advance(1);
          while (index < source.length && DIGIT.test(source[index] as string)) {
            value += source[index];
            advance(1);
          }
        }
        tokens.push({ kind: "number", value, pos: here });
        continue;
      }
      if (ch === '"' || ch === "'") {
        advance(1);
        let value = "";
        for (;;) {
          if (index >= source.length) {
            throw new TemplateSyntaxError("unterminated string literal", here);
          }
          const c = source[index] as string;
          if (c === ch) {
            advance(1);
            break;
          }
          if (c === "\\") {
            advance(1);
            if (index >= source.length) {
              throw new TemplateSyntaxError("unterminated string literal", here);
            }
            const esc = source[index] as string;
            value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
            advance(1);
            continue;
          }
          value += c;
          advance(1);
        }
        tokens.push({ kind: "string", value, pos: here });
        continue;
      }
      const singles: Record<string, TokenKind> = {
        ".": "dot",
        "|": "pipe",
        "(": "lparen",
        ")": "rparen",
        ",": "comma",
      };
      const single = singles[ch];
      if (single !== undefined) {
        tokens.push({ kind: single, value: ch, pos: here });
        advance(1);
        continue;
      }
      throw new TemplateSyntaxError(`unexpected character ${JSON.stringify(ch)}`, here);
    }
  };

  while (index < source.length) {
    lexText();
    if (index >= source.length) break;
    const two = source.slice(index, index + 2);
    const here = pos();
    openToken = {
      kind: two === "{{" ? "openVar" : "openTag",
      value: two,
      pos: here,
    };
    tokens.push(openToken);
    advance(2);
    lexExpression();
  }
  tokens.push({ kind: "eof", value: "", pos: pos() });
  return tokens;
}
