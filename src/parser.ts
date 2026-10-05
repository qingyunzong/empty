import { Atom, Const, ConstTerm, Literal, Rule, Term, VarTerm } from "./types.js";

/**
 * Parser for a small Datalog dialect:
 *
 *   edge(a, b).                        % fact
 *   path(X, Y) :- edge(X, Y).          % rule
 *   unreachable(X) :- node(X), not reach(X).   % stratified negation
 *
 * Variables start with an uppercase letter or `_`. Constants are numbers,
 * 'quoted strings', or bare lowercase symbols. `%` starts a line comment.
 */

export interface ParsedProgram {
  rules: Rule[];
  facts: { pred: string; args: Const[] }[];
}

interface Token {
  kind: "ident" | "number" | "string" | "punct";
  text: string;
  pos: number;
}

const PUNCT = new Set(["(", ")", ",", ".", ":-", "\\+"]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "%") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (src.startsWith(":-", i)) {
      tokens.push({ kind: "punct", text: ":-", pos: i });
      i += 2;
      continue;
    }
    if (src.startsWith("\\+", i)) {
      tokens.push({ kind: "punct", text: "\\+", pos: i });
      i += 2;
      continue;
    }
    if (c === "(" || c === ")" || c === "," || c === ".") {
      tokens.push({ kind: "punct", text: c, pos: i });
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < n) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= n) throw new Error(`Unterminated string at position ${i}`);
      tokens.push({ kind: "string", text: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && i + 1 < n && /[0-9]/.test(src[i + 1]!))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j]!)) j++;
      tokens.push({ kind: "number", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      tokens.push({ kind: "ident", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${c}' at position ${i}`);
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private anonCount = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error("Unexpected end of input");
    this.pos++;
    return t;
  }

  private expect(text: string): void {
    const t = this.next();
    if (t.text !== text)
      throw new Error(`Expected '${text}' but found '${t.text}' at position ${t.pos}`);
  }

  parseProgram(): ParsedProgram {
    const rules: Rule[] = [];
    const facts: { pred: string; args: Const[] }[] = [];
    let ruleId = 0;
    while (this.peek()) {
      const start = this.peek()!.pos;
      const head = this.parseAtom();
      if (this.peek()?.text === ":-") {
        this.next();
        const body: Literal[] = [];
        body.push(this.parseLiteral());
        while (this.peek()?.text === ",") {
          this.next();
          body.push(this.parseLiteral());
        }
        this.expect(".");
        const end = this.tokens[this.pos - 1]!.pos + 1;
        rules.push({ id: ruleId++, head, body, text: this.sliceSource(start, end) });
      } else {
        this.expect(".");
        const args: Const[] = [];
        for (const a of head.args) {
          if (a.kind === "var")
            throw new Error(`Fact '${head.pred}' contains a variable; facts must be ground`);
          args.push((a as ConstTerm).value);
        }
        facts.push({ pred: head.pred, args });
      }
    }
    return { rules, facts };
  }

  private source: string = "";

  private sliceSource(start: number, end: number): string {
    return this.source.slice(start, end).replace(/\s+/g, " ").trim();
  }

  static parse(src: string): ParsedProgram {
    const p = new Parser(src);
    p.source = src;
    return p.parseProgram();
  }

  private parseLiteral(): Literal {
    let negated = false;
    if (this.peek()?.text === "\\+") {
      this.next();
      negated = true;
    } else if (this.peek()?.kind === "ident" && this.peek()!.text === "not") {
      this.next();
      negated = true;
    }
    return { atom: this.parseAtom(), negated };
  }

  private parseAtom(): Atom {
    const t = this.next();
    if (t.kind !== "ident")
      throw new Error(`Expected predicate name at position ${t.pos}, found '${t.text}'`);
    const pred = t.text;
    if (/^[A-Z_]/.test(pred))
      throw new Error(`Predicate names must start lowercase: '${pred}' at position ${t.pos}`);
    const args: Term[] = [];
    if (this.peek()?.text === "(") {
      this.next();
      args.push(this.parseTerm());
      while (this.peek()?.text === ",") {
        this.next();
        args.push(this.parseTerm());
      }
      this.expect(")");
    }
    return { pred, args };
  }

  private parseTerm(): Term {
    const t = this.next();
    if (t.kind === "number") {
      const v = Number(t.text);
      if (!Number.isFinite(v)) throw new Error(`Bad number '${t.text}'`);
      return { kind: "const", value: v };
    }
    if (t.kind === "string") return { kind: "const", value: t.text };
    if (t.kind === "ident") {
      if (t.text === "_") {
        return { kind: "var", name: `_${this.anonCount++}` };
      }
      if (/^[A-Z_]/.test(t.text)) return { kind: "var", name: t.text } as VarTerm;
      return { kind: "const", value: t.text };
    }
    throw new Error(`Expected term at position ${t.pos}, found '${t.text}'`);
  }
}

export function parseProgram(src: string): ParsedProgram {
  return Parser.parse(src);
}

/** Parse a single ground fact such as `edge(a,b)` or `edge(a,b).` */
export function parseFact(src: string): { pred: string; args: Const[] } {
  const trimmed = src.trim().replace(/\.$/, "");
  const { rules, facts } = parseProgram(trimmed + ".");
  if (rules.length !== 0 || facts.length !== 1)
    throw new Error(`'${src}' is not a single ground fact`);
  return facts[0]!;
}
