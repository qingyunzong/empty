export interface NthExpr {
  a: number;
  b: number;
}

export interface AttrCond {
  name: string;
  value?: string;
}

export interface Compound {
  tag: string | null;
  classes: string[];
  attrs: AttrCond[];
  nth: NthExpr | null;
}

export type Combinator = " " | ">";

export interface Complex {
  parts: Compound[];
  /** combs[i] sits between parts[i] and parts[i + 1]. */
  combs: Combinator[];
}

export type SelectorList = Complex[];

export function parseNth(expr: string): NthExpr {
  const s = expr.trim().toLowerCase().replace(/\s+/g, "");
  if (s === "odd") return { a: 2, b: 1 };
  if (s === "even") return { a: 2, b: 0 };
  const intOnly = /^[+-]?\d+$/.exec(s);
  if (intOnly) return { a: 0, b: parseInt(s, 10) };
  const anPlusB = /^([+-]?\d*)n(?:([+-])(\d+))?$/.exec(s);
  if (!anPlusB) throw new Error(`invalid nth-child expression: "${expr}"`);
  const aRaw = anPlusB[1] ?? "";
  const a = aRaw === "" || aRaw === "+" ? 1 : aRaw === "-" ? -1 : parseInt(aRaw, 10);
  const sign = anPlusB[2];
  const bDigits = anPlusB[3];
  const b = bDigits === undefined ? 0 : (sign === "-" ? -1 : 1) * parseInt(bDigits, 10);
  return { a, b };
}

/** True when 1-based position pos belongs to the an+b sequence. */
export function nthMatches(pos: number, nth: NthExpr): boolean {
  const { a, b } = nth;
  if (a === 0) return pos === b;
  const d = pos - b;
  return d % a === 0 && d / a >= 0;
}

function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of input) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseAttr(inner: string): AttrCond {
  const m = /^([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*)?$/.exec(inner.trim());
  if (!m) throw new Error(`invalid attribute selector: [${inner}]`);
  const value = m[2] ?? m[3] ?? m[4];
  return value === undefined ? { name: m[1]! } : { name: m[1]!, value };
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parseComplex(): Complex {
    const parts: Compound[] = [];
    const combs: Combinator[] = [];
    this.skipWs();
    parts.push(this.parseCompound());
    for (;;) {
      const sawSpace = this.skipWs();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] === ">") {
        this.i++;
        this.skipWs();
        combs.push(">");
      } else if (sawSpace) {
        combs.push(" ");
      } else {
        throw new Error(`unexpected "${this.s[this.i]}" in selector "${this.s}"`);
      }
      parts.push(this.parseCompound());
    }
    return { parts, combs };
  }

  private skipWs(): boolean {
    let saw = false;
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) {
      this.i++;
      saw = true;
    }
    return saw;
  }

  private parseCompound(): Compound {
    const c: Compound = { tag: null, classes: [], attrs: [], nth: null };
    const rest = () => this.s.slice(this.i);
    const tag = /^[a-zA-Z][\w-]*/.exec(rest());
    if (tag) {
      c.tag = tag[0];
      this.i += tag[0].length;
    } else if (this.s[this.i] === "*") {
      this.i++;
    }
    for (;;) {
      const ch = this.s[this.i];
      if (ch === ".") {
        const m = /^\.([a-zA-Z][\w-]*)/.exec(rest());
        if (!m) throw new Error(`invalid class selector in "${this.s}"`);
        c.classes.push(m[1]!);
        this.i += m[0].length;
      } else if (ch === "[") {
        const end = this.findAttrEnd();
        c.attrs.push(parseAttr(this.s.slice(this.i + 1, end)));
        this.i = end + 1;
      } else if (ch === ":") {
        const m = /^:nth-child\(\s*([^)]*?)\s*\)/.exec(rest());
        if (!m) throw new Error(`only :nth-child(...) is supported, in "${this.s}"`);
        c.nth = parseNth(m[1]!);
        this.i += m[0].length;
      } else {
        break;
      }
    }
    if (c.tag === null && c.classes.length === 0 && c.attrs.length === 0 && c.nth === null) {
      throw new Error(`empty compound selector in "${this.s}"`);
    }
    return c;
  }

  private findAttrEnd(): number {
    let quote: string | null = null;
    for (let j = this.i + 1; j < this.s.length; j++) {
      const ch = this.s[j]!;
      if (quote !== null) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "]") {
        return j;
      }
    }
    throw new Error(`unterminated attribute selector in "${this.s}"`);
  }
}

export function parseSelectorList(input: string): SelectorList {
  const chunks = splitTopLevel(input, ",");
  const list = chunks.map((chunk) => {
    const trimmed = chunk.trim();
    if (trimmed === "") throw new Error(`empty selector in list "${input}"`);
    return new Parser(trimmed).parseComplex();
  });
  return list;
}
