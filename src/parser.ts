import type { BinaryOp, Expr } from "./ast.js";

type Token =
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "not" }
  | { kind: "op"; op: BinaryOp }
  | { kind: "const"; value: boolean }
  | { kind: "ident"; name: string };

const KEYWORD_OPS: Record<string, BinaryOp> = {
  and: "and",
  or: "or",
  xor: "xor",
  implies: "implies",
  iff: "iff",
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const pushOp = (op: BinaryOp): void => {
    tokens.push({ kind: "op", op });
  };
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i++;
    } else if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i++;
    } else if (ch === "!" || ch === "~") {
      tokens.push({ kind: "not" });
      i++;
    } else if (ch === "&") {
      pushOp("and");
      i += input[i + 1] === "&" ? 2 : 1;
    } else if (ch === "|") {
      pushOp("or");
      i += input[i + 1] === "|" ? 2 : 1;
    } else if (ch === "^") {
      pushOp("xor");
      i++;
    } else if (ch === "<" && input.startsWith("<->", i)) {
      pushOp("iff");
      i += 3;
    } else if (ch === "-" && input.startsWith("->", i)) {
      pushOp("implies");
      i += 2;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j++;
      const word = input.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === "true") tokens.push({ kind: "const", value: true });
      else if (lower === "false") tokens.push({ kind: "const", value: false });
      else if (lower === "not") tokens.push({ kind: "not" });
      else if (KEYWORD_OPS[lower] !== undefined) pushOp(KEYWORD_OPS[lower]);
      else tokens.push({ kind: "ident", name: word });
      i = j;
    } else if (ch === "0" || ch === "1") {
      tokens.push({ kind: "const", value: ch === "1" });
      i++;
    } else {
      throw new Error(`parse error: unexpected character '${ch}' at offset ${i}`);
    }
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error("parse error: unexpected end of expression");
    this.pos++;
    return t;
  }

  private eatOp(op: BinaryOp): boolean {
    const t = this.peek();
    if (t !== undefined && t.kind === "op" && t.op === op) {
      this.pos++;
      return true;
    }
    return false;
  }

  parseExpr(): Expr {
    const e = this.parseIff();
    if (this.pos !== this.tokens.length) {
      throw new Error(`parse error: trailing tokens at position ${this.pos}`);
    }
    return e;
  }

  private parseIff(): Expr {
    let left = this.parseImplies();
    while (this.eatOp("iff")) {
      left = { kind: "binary", op: "iff", left, right: this.parseImplies() };
    }
    return left;
  }

  private parseImplies(): Expr {
    const left = this.parseOr();
    if (this.eatOp("implies")) {
      // right-associative, as is conventional for implication
      return { kind: "binary", op: "implies", left, right: this.parseImplies() };
    }
    return left;
  }

  private parseOr(): Expr {
    let left = this.parseXor();
    while (this.eatOp("or")) {
      left = { kind: "binary", op: "or", left, right: this.parseXor() };
    }
    return left;
  }

  private parseXor(): Expr {
    let left = this.parseAnd();
    while (this.eatOp("xor")) {
      left = { kind: "binary", op: "xor", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseUnary();
    while (this.eatOp("and")) {
      left = { kind: "binary", op: "and", left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t !== undefined && t.kind === "not") {
      this.next();
      return { kind: "not", operand: this.parseUnary() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Expr {
    const t = this.next();
    switch (t.kind) {
      case "const":
        return { kind: "const", value: t.value };
      case "ident":
        return { kind: "var", name: t.name };
      case "lparen": {
        const e = this.parseIff();
        const closing = this.next();
        if (closing.kind !== "rparen") throw new Error("parse error: expected ')'");
        return e;
      }
      default:
        throw new Error("parse error: expected an operand");
    }
  }
}

export function parseExpr(input: string): Expr {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new Error("parse error: empty expression");
  return new Parser(tokens).parseExpr();
}
