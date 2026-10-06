/**
 * Selector parser.
 *
 * Grammar (whitespace separates descendant combinators):
 *
 *   selector  := complex (WS? ',' WS? complex)*
 *   complex   := compound ((WS? '>' WS? | WS+) compound)*
 *   compound  := simple+
 *   simple    := tag | attr
 *   tag       := '*' | IDENT
 *   attr      := '[' WS? IDENT WS? '=' WS? (STRING | IDENT) WS? ']'
 *   IDENT     := [a-zA-Z_][a-zA-Z0-9_-]*
 *   STRING    := '"' ... '"' | "'" ... "'"
 *
 * Every parse error reports a half-open character range [start, end).
 */

export interface AttrCondition {
  name: string;
  value: string;
}

export interface Compound {
  /** null means the universal selector '*'. */
  tag: string | null;
  attrs: AttrCondition[];
}

export type Combinator = 'child' | 'descendant';

export interface SelectorStep {
  combinator: Combinator;
  compound: Compound;
}

/** One comma-free chain: first compound, then combinator+compound steps. */
export interface SelectorChain {
  first: Compound;
  rest: SelectorStep[];
}

export interface Selector {
  chains: SelectorChain[];
}

export class SelectorSyntaxError extends Error {
  readonly start: number;
  readonly end: number;
  constructor(message: string, start: number, end: number) {
    super(`${message} (at ${start}..${end})`);
    this.name = 'SelectorSyntaxError';
    this.start = start;
    this.end = end;
  }
}

const IDENT_START = /[a-zA-Z_*]/;
const IDENT_CHAR = /[a-zA-Z0-9_-]/;

class Cursor {
  pos = 0;
  readonly input: string;
  constructor(input: string) {
    this.input = input;
  }

  get done(): boolean {
    return this.pos >= this.input.length;
  }

  peek(): string {
    return this.input[this.pos] ?? '';
  }

  error(message: string, start = this.pos, end = this.pos + 1): SelectorSyntaxError {
    return new SelectorSyntaxError(message, start, Math.min(end, this.input.length));
  }

  skipWhitespace(): boolean {
    let skipped = false;
    while (!this.done && /\s/.test(this.peek())) {
      this.pos++;
      skipped = true;
    }
    return skipped;
  }

  parseBareValue(): string {
    const start = this.pos;
    if (this.done || !IDENT_CHAR.test(this.peek())) {
      throw this.error('expected attribute value', start, start + 1);
    }
    while (!this.done && IDENT_CHAR.test(this.peek())) this.pos++;
    return this.input.slice(start, this.pos);
  }

  parseIdent(what: string): string {
    const start = this.pos;
    if (this.done || !IDENT_START.test(this.peek()) || this.peek() === '*') {
      throw this.error(`expected ${what}`, start, start + 1);
    }
    this.pos++;
    while (!this.done && IDENT_CHAR.test(this.peek())) this.pos++;
    return this.input.slice(start, this.pos);
  }
}

function parseCompound(cursor: Cursor): Compound {
  const compound: Compound = { tag: null, attrs: [] };
  let consumed = false;

  if (cursor.peek() === '*') {
    cursor.pos++;
    consumed = true;
  } else if (IDENT_START.test(cursor.peek())) {
    compound.tag = cursor.parseIdent('tag name');
    consumed = true;
  }

  while (cursor.peek() === '[') {
    const bracketStart = cursor.pos;
    cursor.pos++;
    cursor.skipWhitespace();
    const name = cursor.parseIdent('attribute name');
    cursor.skipWhitespace();
    if (cursor.peek() !== '=') {
      throw cursor.error("expected '=' in attribute selector");
    }
    cursor.pos++;
    cursor.skipWhitespace();
    let value: string;
    const quote = cursor.peek();
    if (quote === '"' || quote === "'") {
      cursor.pos++;
      const valueStart = cursor.pos;
      while (!cursor.done && cursor.peek() !== quote) cursor.pos++;
      if (cursor.done) {
        throw cursor.error('unterminated string in attribute selector', valueStart, cursor.pos);
      }
      value = cursor.input.slice(valueStart, cursor.pos);
      cursor.pos++;
    } else {
      value = cursor.parseBareValue();
    }
    cursor.skipWhitespace();
    if (cursor.peek() !== ']') {
      throw cursor.error("expected ']'", bracketStart, cursor.pos + 1);
    }
    cursor.pos++;
    compound.attrs.push({ name, value });
    consumed = true;
  }

  if (!consumed) {
    throw cursor.error('expected a tag name, "*", or "[attr=value]"');
  }
  return compound;
}

function parseChain(cursor: Cursor): SelectorChain {
  const first = parseCompound(cursor);
  const rest: SelectorStep[] = [];

  for (;;) {
    const hadWhitespace = cursor.skipWhitespace();
    if (cursor.done || cursor.peek() === ',') break;
    let combinator: Combinator;
    if (cursor.peek() === '>') {
      cursor.pos++;
      cursor.skipWhitespace();
      combinator = 'child';
    } else if (hadWhitespace) {
      combinator = 'descendant';
    } else {
      throw cursor.error("expected '>', whitespace, or ','");
    }
    rest.push({ combinator, compound: parseCompound(cursor) });
  }
  return { first, rest };
}

export function parseSelector(input: string): Selector {
  const cursor = new Cursor(input);
  const chains: SelectorChain[] = [];
  cursor.skipWhitespace();
  if (cursor.done) throw cursor.error('empty selector', 0, 0);
  chains.push(parseChain(cursor));
  for (;;) {
    cursor.skipWhitespace();
    if (cursor.done) break;
    if (cursor.peek() !== ',') throw cursor.error("expected ','");
    cursor.pos++;
    cursor.skipWhitespace();
    if (cursor.done) throw cursor.error('expected a selector after ","');
    chains.push(parseChain(cursor));
  }
  return { chains };
}
