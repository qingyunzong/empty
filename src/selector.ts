/**
 * Selector syntax:
 *   selector-list := complex ("," complex)*
 *   complex       := compound (combinator compound)*
 *   combinator    := whitespace+ | whitespace* ">" whitespace*
 *   compound      := (ident | "*")? attr*        (at least one component)
 *   attr          := "[" ident ("=" (ident | string))? "]"
 *   string        := '"' ... '"' | "'" ... "'"
 */

export interface AttrSelector {
  readonly name: string;
  /** null means "attribute presence" (no `=value` part). */
  readonly value: string | null;
}

export interface Compound {
  /** null means "any tag" (either `*` or no type selector written). */
  readonly tag: string | null;
  readonly attrs: readonly AttrSelector[];
}

export type Combinator = "child" | "descendant";

export interface ComplexSelector {
  readonly compounds: readonly Compound[];
  /** combinators[i] sits between compounds[i] and compounds[i+1]. */
  readonly combinators: readonly Combinator[];
}

export interface SelectorList {
  readonly complexes: readonly ComplexSelector[];
}

export class SelectorSyntaxError extends Error {
  /** Inclusive start offset (0-based character index) of the offending region. */
  readonly start: number;
  /** Exclusive end offset of the offending region. */
  readonly end: number;

  constructor(message: string, start: number, end: number) {
    super(`${message} (at characters ${start}..${end})`);
    this.name = "SelectorSyntaxError";
    this.start = start;
    this.end = end;
  }
}

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isIdentStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || ch === "_";
}

function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    (c >= 48 && c <= 57) ||
    ch === "_" ||
    ch === "-"
  );
}

class Parser {
  private pos = 0;

  constructor(private readonly source: string) {}

  parseSelectorList(): SelectorList {
    this.skipWs();
    if (this.eof()) {
      throw this.error("expected a selector, found end of input", this.pos, this.pos);
    }
    const complexes: ComplexSelector[] = [];
    for (;;) {
      complexes.push(this.parseComplex());
      this.skipWs();
      if (this.eof()) break;
      if (this.peek() === ",") {
        const commaPos = this.pos;
        this.pos++;
        this.skipWs();
        if (this.eof()) {
          throw this.error("expected a selector after ','", commaPos, this.pos);
        }
        continue;
      }
      throw this.error(
        `unexpected character '${this.peek()}'`,
        this.pos,
        this.pos + 1,
      );
    }
    return { complexes };
  }

  private parseComplex(): ComplexSelector {
    const compounds: Compound[] = [this.parseCompound()];
    const combinators: Combinator[] = [];
    for (;;) {
      const hadWs = this.skipWs();
      if (this.eof() || this.peek() === ",") break;
      if (this.peek() === ">") {
        const gtPos = this.pos;
        this.pos++;
        this.skipWs();
        if (this.eof() || this.peek() === ",") {
          throw this.error("expected a selector after '>'", gtPos, this.pos);
        }
        combinators.push("child");
        compounds.push(this.parseCompound());
      } else if (hadWs) {
        combinators.push("descendant");
        compounds.push(this.parseCompound());
      } else {
        throw this.error(
          `unexpected character '${this.peek()}'`,
          this.pos,
          this.pos + 1,
        );
      }
    }
    return { compounds, combinators };
  }

  private parseCompound(): Compound {
    const start = this.pos;
    let tag: string | null = null;
    let hasAny = false;
    if (this.peek() === "*") {
      this.pos++;
      hasAny = true;
    } else if (isIdentStart(this.peek())) {
      tag = this.parseIdent();
      hasAny = true;
    }
    const attrs: AttrSelector[] = [];
    while (this.peek() === "[") {
      attrs.push(this.parseAttr());
      hasAny = true;
    }
    if (!hasAny) {
      throw this.error(
        "expected a tag name, '*' or '['",
        start,
        Math.max(start + 1, this.pos),
      );
    }
    return { tag, attrs };
  }

  private parseAttr(): AttrSelector {
    this.pos++; // consume '['
    this.skipWs();
    if (!isIdentStart(this.peek())) {
      throw this.error("expected an attribute name", this.pos, this.pos + 1);
    }
    const name = this.parseIdent();
    this.skipWs();
    if (this.peek() === "]") {
      this.pos++;
      return { name, value: null };
    }
    if (this.peek() !== "=") {
      throw this.error("expected '=' or ']'", this.pos, this.pos + 1);
    }
    this.pos++; // consume '='
    this.skipWs();
    let value: string;
    const ch = this.peek();
    if (ch === '"' || ch === "'") {
      value = this.parseString(ch);
    } else if (isIdentChar(ch)) {
      // bare values may start with a digit (e.g. [data-x=1])
      value = this.parseIdent();
    } else {
      throw this.error("expected an attribute value", this.pos, this.pos + 1);
    }
    this.skipWs();
    if (this.peek() !== "]") {
      throw this.error("expected ']'", this.pos, this.pos + 1);
    }
    this.pos++; // consume ']'
    return { name, value };
  }

  private parseString(quote: string): string {
    const start = this.pos;
    this.pos++; // consume opening quote
    let out = "";
    while (!this.eof() && this.peek() !== quote) {
      out += this.peek();
      this.pos++;
    }
    if (this.eof()) {
      throw this.error("unterminated string", start, this.pos);
    }
    this.pos++; // consume closing quote
    return out;
  }

  private parseIdent(): string {
    const start = this.pos;
    while (isIdentChar(this.peek())) this.pos++;
    return this.source.slice(start, this.pos);
  }

  private skipWs(): boolean {
    const before = this.pos;
    while (isWs(this.peek())) this.pos++;
    return this.pos !== before;
  }

  private peek(): string | undefined {
    return this.source[this.pos];
  }

  private eof(): boolean {
    return this.pos >= this.source.length;
  }

  private error(message: string, start: number, end: number): SelectorSyntaxError {
    return new SelectorSyntaxError(message, start, end);
  }
}

/** Parse a selector list, throwing {@link SelectorSyntaxError} with a character range on failure. */
export function parseSelector(source: string): SelectorList {
  return new Parser(source).parseSelectorList();
}
