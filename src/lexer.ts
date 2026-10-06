import { RuleSyntaxError } from "./errors.js";

export type TokenType =
  | "ident"
  | "number"
  | "string"
  | "boolean"
  | "null"
  | "and"
  | "or"
  | "not"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "lparen"
  | "rparen"
  | "eof";

export interface Token {
  type: TokenType;
  /** UTF-8 byte offset of the token in the source. */
  pos: number;
  value?: string | bigint | boolean;
}

function utf8Length(codeUnit: number): number {
  if (codeUnit < 0x80) return 1;
  if (codeUnit < 0x800) return 2;
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) return 4; // surrogate pair
  return 3;
}

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0; // code-unit index
  let pos = 0; // UTF-8 byte offset

  const at = (offset = 0): string => source[index + offset] ?? "";
  const advance = (): void => {
    const len = utf8Length(source.charCodeAt(index));
    index += len === 4 ? 2 : 1;
    pos += len;
  };

  const lexString = (quote: string): void => {
    const start = pos;
    advance();
    let out = "";
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\") {
        advance();
        const esc = source[index];
        if (esc === undefined || !(esc in ESCAPES)) {
          throw new RuleSyntaxError(`invalid escape sequence '\\${esc ?? ""}'`, pos);
        }
        out += ESCAPES[esc];
        advance();
      } else {
        out += source[index];
        advance();
      }
    }
    if (index >= source.length) {
      throw new RuleSyntaxError("unterminated string literal", start);
    }
    advance();
    tokens.push({ type: "string", value: out, pos: start });
  };

  const lexNumber = (): void => {
    const start = pos;
    let text = "";
    while (isDigit(at())) {
      text += at();
      advance();
    }
    if (at() === "n") {
      advance();
    } else if (at() === "." && isDigit(at(1))) {
      throw new RuleSyntaxError(
        "only integer literals are allowed (numbers are bigint)",
        pos
      );
    }
    tokens.push({ type: "number", value: BigInt(text), pos: start });
  };

  const lexIdent = (): void => {
    const start = pos;
    let name = "";
    while (index < source.length) {
      const c = at();
      if (isIdentPart(c) || (c === "." && isIdentStart(at(1)))) {
        name += c;
        advance();
      } else {
        break;
      }
    }
    if (name === "true" || name === "false") {
      tokens.push({ type: "boolean", value: name === "true", pos: start });
    } else if (name === "null") {
      tokens.push({ type: "null", pos: start });
    } else {
      tokens.push({ type: "ident", value: name, pos: start });
    }
  };

  while (index < source.length) {
    const c = at();
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      advance();
    } else if (isDigit(c)) {
      lexNumber();
    } else if (isIdentStart(c)) {
      lexIdent();
    } else if (c === "'" || c === '"') {
      lexString(c);
    } else if (c === "&") {
      const start = pos;
      advance();
      if (at() !== "&") throw new RuleSyntaxError("expected '&&'", start);
      advance();
      tokens.push({ type: "and", pos: start });
    } else if (c === "|") {
      const start = pos;
      advance();
      if (at() !== "|") throw new RuleSyntaxError("expected '||'", start);
      advance();
      tokens.push({ type: "or", pos: start });
    } else if (c === "!") {
      const start = pos;
      advance();
      if (at() === "=") {
        advance();
        tokens.push({ type: "ne", pos: start });
      } else {
        tokens.push({ type: "not", pos: start });
      }
    } else if (c === "=") {
      const start = pos;
      advance();
      if (at() !== "=") {
        throw new RuleSyntaxError("use '==' for equality comparison", start);
      }
      advance();
      tokens.push({ type: "eq", pos: start });
    } else if (c === "<") {
      const start = pos;
      advance();
      if (at() === "=") {
        advance();
        tokens.push({ type: "le", pos: start });
      } else {
        tokens.push({ type: "lt", pos: start });
      }
    } else if (c === ">") {
      const start = pos;
      advance();
      if (at() === "=") {
        advance();
        tokens.push({ type: "ge", pos: start });
      } else {
        tokens.push({ type: "gt", pos: start });
      }
    } else if (c === "(") {
      tokens.push({ type: "lparen", pos });
      advance();
    } else if (c === ")") {
      tokens.push({ type: "rparen", pos });
      advance();
    } else {
      throw new RuleSyntaxError(`unexpected character '${c}'`, pos);
    }
  }
  tokens.push({ type: "eof", pos });
  return tokens;
}
