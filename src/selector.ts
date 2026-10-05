/**
 * Selector parser.
 *
 * Supported grammar (CSS subset):
 *   selector-list  := complex ("," complex)*
 *   complex        := compound (combinator compound)*
 *   combinator     := ">" | whitespace          (child / descendant)
 *   compound       := [tag|"*"] (class | attr | nth)*
 *   class          := "." ident
 *   attr           := "[" ident ("=" (ident | string))? "]"
 *   nth            := ":nth-child(" (odd | even | An+B) ")"
 */

export interface AttrCond {
  name: string;
  /** null means "presence only". */
  value: string | null;
}

/** :nth-child(an+b). */
export interface Nth {
  a: number;
  b: number;
}

export interface Compound {
  /** null = no tag constraint; "*" is normalized to null. */
  tag: string | null;
  classes: string[];
  attrs: AttrCond[];
  nth: Nth | null;
}

export type Combinator = "child" | "descendant";

export interface Complex {
  compounds: Compound[];
  /** combinators[i] joins compounds[i] (left) with compounds[i+1] (right). */
  combinators: Combinator[];
}

export type SelectorList = Complex[];

const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*/;

export function parseNth(expr: string): Nth {
  const s = expr.replace(/\s+/g, "").toLowerCase();
  if (s === "odd") return { a: 2, b: 1 };
  if (s === "even") return { a: 2, b: 0 };
  if (/^[+-]?\d+$/.test(s)) return { a: 0, b: parseInt(s, 10) };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(s);
  if (m !== null) {
    const coef = m[1] ?? "";
    const a = coef === "" || coef === "+" ? 1 : coef === "-" ? -1 : parseInt(coef, 10);
    const b = m[2] !== undefined ? parseInt(m[2], 10) : 0;
    return { a, b };
  }
  throw new SyntaxError(`invalid :nth-child expression: "${expr}"`);
}

/** 1-based index test for an+b. */
export function nthMatches(index: number, nth: Nth): boolean {
  if (index < 1) return false;
  const { a, b } = nth;
  if (a === 0) return index === b;
  const d = index - b;
  return d % a === 0 && d / a >= 0;
}

/** Split a selector list on top-level commas (commas inside [] or () are kept). */
function splitList(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "(") {
      depth++;
    } else if (ch === "]" || ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

class CompoundParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parseComplex(): Complex {
    const compounds: Compound[] = [];
    const combinators: Combinator[] = [];
    let pendingDescendant = false;
    for (;;) {
      const sawSpace = this.skipWs();
      if (this.eof()) break;
      if (this.peek() === ">") {
        this.pos++;
        this.skipWs();
        if (compounds.length === 0 || combinators.length === compounds.length) {
          throw new SyntaxError(`dangling ">" in selector: "${this.src}"`);
        }
        combinators.push("child");
        pendingDescendant = false;
        continue;
      }
      if (compounds.length > 0 && combinators.length < compounds.length) {
        if (!sawSpace && !pendingDescendant) {
          throw new SyntaxError(`missing combinator in selector: "${this.src}"`);
        }
        combinators.push("descendant");
      }
      pendingDescendant = false;
      compounds.push(this.parseCompound());
    }
    if (compounds.length === 0 || combinators.length !== compounds.length - 1) {
      throw new SyntaxError(`invalid selector: "${this.src}"`);
    }
    return { compounds, combinators };
  }

  private parseCompound(): Compound {
    const compound: Compound = { tag: null, classes: [], attrs: [], nth: null };
    let consumed = false;
    if (!this.eof() && this.peek() === "*") {
      this.pos++;
      consumed = true;
    } else {
      const tag = this.readIdent();
      if (tag !== null) {
        compound.tag = tag;
        consumed = true;
      }
    }
    for (;;) {
      if (this.eof()) break;
      const ch = this.peek();
      if (ch === ".") {
        this.pos++;
        const name = this.readIdent();
        if (name === null) throw new SyntaxError(`bad class selector in "${this.src}"`);
        compound.classes.push(name);
        consumed = true;
      } else if (ch === "[") {
        compound.attrs.push(this.readAttr());
        consumed = true;
      } else if (ch === ":") {
        this.readNth(compound);
        consumed = true;
      } else {
        break;
      }
    }
    if (!consumed) {
      throw new SyntaxError(`expected compound selector at "${this.src.slice(this.pos)}"`);
    }
    return compound;
  }

  private readAttr(): AttrCond {
    this.pos++; // consume "["
    this.skipWs();
    const name = this.readIdent();
    if (name === null) throw new SyntaxError(`bad attribute selector in "${this.src}"`);
    this.skipWs();
    if (this.peek() === "]") {
      this.pos++;
      return { name, value: null };
    }
    if (this.peek() !== "=") throw new SyntaxError(`expected "=" or "]" in "${this.src}"`);
    this.pos++;
    this.skipWs();
    let value: string;
    const ch = this.peek();
    if (ch === '"' || ch === "'") {
      this.pos++;
      const end = this.src.indexOf(ch, this.pos);
      if (end < 0) throw new SyntaxError(`unterminated string in "${this.src}"`);
      value = this.src.slice(this.pos, end);
      this.pos = end + 1;
    } else {
      const ident = this.readIdent();
      if (ident === null) throw new SyntaxError(`bad attribute value in "${this.src}"`);
      value = ident;
    }
    this.skipWs();
    if (this.peek() !== "]") throw new SyntaxError(`expected "]" in "${this.src}"`);
    this.pos++;
    return { name, value };
  }

  private readNth(compound: Compound): void {
    const rest = this.src.slice(this.pos);
    if (!rest.startsWith(":nth-child(")) {
      throw new SyntaxError(`unsupported pseudo-class in "${this.src}"`);
    }
    const open = this.pos + ":nth-child".length;
    const close = this.src.indexOf(")", open);
    if (close < 0) throw new SyntaxError(`unterminated :nth-child in "${this.src}"`);
    if (compound.nth !== null) {
      throw new SyntaxError(`duplicate :nth-child in "${this.src}"`);
    }
    compound.nth = parseNth(this.src.slice(open + 1, close));
    this.pos = close + 1;
  }

  private readIdent(): string | null {
    const m = IDENT.exec(this.src.slice(this.pos));
    if (m === null) return null;
    this.pos += m[0].length;
    return m[0];
  }

  private skipWs(): boolean {
    const start = this.pos;
    while (!this.eof() && /\s/.test(this.peek())) this.pos++;
    return this.pos > start;
  }

  private peek(): string {
    return this.src[this.pos]!;
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }
}

export function parseSelectorList(src: string): SelectorList {
  const parts = splitList(src)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) throw new SyntaxError("empty selector");
  return parts.map((p) => new CompoundParser(p).parseComplex());
}
