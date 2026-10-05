/**
 * Parser for a small Datalog surface syntax:
 *
 *   edge("a", "b").                       % fact clause (ignored by parseRules)
 *   reachable(X) :- start(X).             % rule
 *   blocked(X) :- node(X), not reachable(X).
 *
 * Variables start with an uppercase letter or `_`. Lowercase identifiers are
 * symbolic constants; numbers and double-quoted strings are constants.
 */

import {
  Atom,
  Const,
  Literal,
  Rule,
  Term,
  constant,
  formatAtom,
  isVariable,
  variable,
} from "./core.js";

interface Token {
  readonly kind: "ident" | "number" | "string" | "symbol";
  readonly text: string;
  readonly pos: number;
}

export class ParseError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Token["kind"], text: string, pos: number) =>
    tokens.push({ kind, text, pos });
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "%") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === ":" && src[i + 1] === "-") {
      push("symbol", ":-", i);
      i += 2;
      continue;
    }
    if ("(),.".includes(ch)) {
      push("symbol", ch, i);
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let out = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          const esc = src[i + 1];
          out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new ParseError(`unterminated string at ${start}`);
      i++;
      tokens.push({ kind: "string", text: out, pos: start });
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && /[\d-]/.test(ch)) {
      push("number", num[0], i);
      i += num[0].length;
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (ident) {
      push("ident", ident[0], i);
      i += ident[0].length;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  return tokens;
}

export interface ParsedClause {
  readonly head: Atom;
  readonly body: readonly Literal[];
  readonly text: string;
}

class Parser {
  private pos = 0;
  private anonCount = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new ParseError("unexpected end of input");
    this.pos++;
    return t;
  }

  private expectSymbol(sym: string): void {
    const t = this.next();
    if (t.kind !== "symbol" || t.text !== sym)
      throw new ParseError(`expected '${sym}' but found '${t.text}' at ${t.pos}`);
  }

  parseProgram(): ParsedClause[] {
    const clauses: ParsedClause[] = [];
    while (this.peek()) clauses.push(this.parseClause());
    return clauses;
  }

  private parseClause(): ParsedClause {
    const head = this.parseAtom();
    const body: Literal[] = [];
    const sep = this.peek();
    if (sep && sep.kind === "symbol" && sep.text === ":-") {
      this.next();
      for (;;) {
        body.push(this.parseLiteral());
        const t = this.peek();
        if (t && t.kind === "symbol" && t.text === ",") {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectSymbol(".");
    return { head, body, text: "" };
  }

  private parseLiteral(): Literal {
    const t = this.peek();
    if (t && t.kind === "ident" && t.text === "not") {
      this.next();
      return { atom: this.parseAtom(), negated: true };
    }
    return { atom: this.parseAtom(), negated: false };
  }

  private parseAtom(): Atom {
    const t = this.next();
    if (t.kind !== "ident" || t.text === "not")
      throw new ParseError(`expected predicate name at ${t.pos}`);
    if (isVariable(t.text))
      throw new ParseError(`predicate names must be lowercase, got '${t.text}'`);
    const args: Term[] = [];
    const open = this.peek();
    if (open && open.kind === "symbol" && open.text === "(") {
      this.next();
      for (;;) {
        args.push(this.parseTerm());
        const t2 = this.peek();
        if (t2 && t2.kind === "symbol" && t2.text === ",") {
          this.next();
          continue;
        }
        break;
      }
      this.expectSymbol(")");
    }
    return { pred: t.text, args };
  }

  private parseTerm(): Term {
    const t = this.next();
    if (t.kind === "number") return constant(Number(t.text));
    if (t.kind === "string") return constant(t.text);
    if (t.kind === "ident") {
      if (isVariable(t.text)) {
        if (t.text === "_") return variable(`_anon${this.anonCount++}`);
        return variable(t.text);
      }
      return constant(t.text);
    }
    throw new ParseError(`expected term at ${t.pos}`);
  }
}

export function parseProgram(src: string): ParsedClause[] {
  return new Parser(tokenize(src)).parseProgram();
}

let ruleCounter = 0;

/** Compile-time counter reset, only used by tests that need stable rule ids. */
export function resetRuleCounterForTests(): void {
  ruleCounter = 0;
}

/** Parse rule clauses (clauses with a body). Facts are rejected. */
export function parseRules(src: string): Rule[] {
  const clauses = parseProgram(src);
  const rules: Rule[] = [];
  for (const c of clauses) {
    if (c.body.length === 0)
      throw new ParseError(
        `expected a rule but found a fact: ${c.head.pred}(...) — add facts via addFact`,
      );
    rules.push(makeRule(c.head, c.body, clauseText(c.head, c.body)));
  }
  return rules;
}

function clauseText(head: Atom, body: readonly Literal[]): string {
  const b = body
    .map((l) => (l.negated ? `not ${formatAtom(l.atom)}` : formatAtom(l.atom)))
    .join(", ");
  return `${formatAtom(head)} :- ${b}.`;
}

/** Parse a single ground fact clause, returning [pred, args]. */
export function parseFact(src: string): { pred: string; args: Const[] } {
  const clauses = parseProgram(src);
  if (clauses.length !== 1 || clauses[0]!.body.length !== 0)
    throw new ParseError(`expected a single ground fact, got: ${src}`);
  const { head } = clauses[0]!;
  const args = head.args.map((t) => {
    if (t.kind === "var")
      throw new ParseError(`facts must be ground, got variable ${t.name}`);
    return t.value;
  });
  return { pred: head.pred, args };
}

export function makeRule(head: Atom, body: readonly Literal[], text: string): Rule {
  const posBody = body.filter((l) => !l.negated);
  const negBody = body.filter((l) => l.negated);
  return {
    id: ruleCounter++,
    head,
    body,
    posBody,
    negBody,
    text: text.trim(),
  };
}
