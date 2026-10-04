import { Token } from "./lexer.js";

export class ParseError extends Error {}

export interface Block {
  type: "Block";
  body: Stmt[];
}

export type Expr =
  | { type: "Ident"; token: Token }
  | { type: "Literal"; token: Token }
  | { type: "Binary"; op: string; left: Expr; right: Expr }
  | { type: "Unary"; op: string; argument: Expr }
  | { type: "Assign"; left: Expr; right: Expr }
  | { type: "Call"; callee: Expr; args: Expr[] }
  | { type: "Member"; object: Expr; property: Token | null; computed: Expr | null }
  | { type: "Arrow"; params: Token[]; body: Block | Expr }
  | { type: "FunctionExpr"; name: Token | null; params: Token[]; body: Block }
  | { type: "Object"; props: Prop[] }
  | { type: "Array"; elements: Expr[] };

export type Prop =
  | { kind: "kv"; key: Token; value: Expr }
  | { kind: "shorthand"; name: Token }
  | { kind: "spread"; value: Expr };

export interface VarDeclarator {
  name: Token;
  init: Expr | null;
}

export type Stmt =
  | Block
  | { type: "VarDecl"; kind: "let" | "const"; decls: VarDeclarator[] }
  | { type: "FunctionDecl"; name: Token; params: Token[]; body: Block }
  | { type: "If"; test: Expr; consequent: Stmt; alternate: Stmt | null }
  | { type: "While"; test: Expr; body: Stmt }
  | {
      type: "For";
      init: Stmt | Expr | null;
      test: Expr | null;
      update: Expr | null;
      body: Stmt;
    }
  | { type: "ForOf"; kind: "let" | "const"; name: Token; iter: Expr; body: Stmt }
  | { type: "Return"; argument: Expr | null }
  | { type: "ExprStmt"; expr: Expr };

export interface Program {
  type: "Program";
  body: Stmt[];
}

const BINARY_PREC: Readonly<Record<string, number>> = {
  "||": 1, "??": 1,
  "&&": 2,
  "==": 3, "===": 3, "!=": 3, "!==": 3,
  "<": 4, ">": 4, "<=": 4, ">=": 4, in: 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6, "%": 6,
};

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%="]);
const UNARY_OPS = new Set(["!", "-", "+", "~", "typeof", "void", "delete"]);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    const idx = Math.min(this.pos + offset, this.tokens.length - 1);
    return this.tokens[idx];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private at(value: string): boolean {
    return this.peek().value === value;
  }

  private eat(value: string): boolean {
    if (this.at(value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(value: string): Token {
    const tok = this.advance();
    if (tok.value !== value) {
      throw new ParseError(
        `expected ${JSON.stringify(value)} but found ${JSON.stringify(tok.value)} at offset ${tok.start}`,
      );
    }
    return tok;
  }

  private expectIdent(): Token {
    const tok = this.advance();
    if (tok.kind !== "ident") {
      throw new ParseError(`expected identifier but found ${JSON.stringify(tok.value)} at offset ${tok.start}`);
    }
    return tok;
  }

  parseProgram(): Program {
    const body: Stmt[] = [];
    while (this.peek().kind !== "eof") body.push(this.parseStatement());
    return { type: "Program", body };
  }

  private parseStatement(): Stmt {
    const tok = this.peek();
    if (tok.value === "{") return this.parseBlock();
    if (tok.kind === "keyword") {
      switch (tok.value) {
        case "let":
        case "const":
          return this.parseVarDecl();
        case "function":
          return this.parseFunctionDecl();
        case "if":
          return this.parseIf();
        case "while":
          return this.parseWhile();
        case "for":
          return this.parseFor();
        case "return": {
          this.advance();
          const argument = this.at(";") || this.at("}") || this.peek().kind === "eof"
            ? null
            : this.parseExpression();
          this.eat(";");
          return { type: "Return", argument };
        }
        case "break":
        case "continue":
          this.advance();
          this.eat(";");
          return { type: "ExprStmt", expr: { type: "Literal", token: tok } };
      }
    }
    if (tok.value === ";") {
      this.advance();
      return { type: "ExprStmt", expr: { type: "Literal", token: tok } };
    }
    const expr = this.parseExpression();
    this.eat(";");
    return { type: "ExprStmt", expr };
  }

  private parseBlock(): Block {
    this.expect("{");
    const body: Stmt[] = [];
    while (!this.at("}")) {
      if (this.peek().kind === "eof") {
        throw new ParseError(`unterminated block at offset ${this.peek().start}`);
      }
      body.push(this.parseStatement());
    }
    this.expect("}");
    return { type: "Block", body };
  }

  private parseVarDecl(): Stmt {
    const kind = this.advance().value as "let" | "const";
    const decls: VarDeclarator[] = [];
    do {
      const name = this.expectIdent();
      const init = this.eat("=") ? this.parseExpression() : null;
      decls.push({ name, init });
    } while (this.eat(","));
    this.eat(";");
    return { type: "VarDecl", kind, decls };
  }

  private parseParams(): Token[] {
    this.expect("(");
    const params: Token[] = [];
    if (!this.at(")")) {
      do {
        params.push(this.expectIdent());
      } while (this.eat(","));
    }
    this.expect(")");
    return params;
  }

  private parseFunctionDecl(): Stmt {
    this.expect("function");
    const name = this.expectIdent();
    const params = this.parseParams();
    const body = this.parseBlock();
    return { type: "FunctionDecl", name, params, body };
  }

  private parseIf(): Stmt {
    this.expect("if");
    this.expect("(");
    const test = this.parseExpression();
    this.expect(")");
    const consequent = this.parseStatement();
    const alternate = this.eat("else") ? this.parseStatement() : null;
    return { type: "If", test, consequent, alternate };
  }

  private parseWhile(): Stmt {
    this.expect("while");
    this.expect("(");
    const test = this.parseExpression();
    this.expect(")");
    const body = this.parseStatement();
    return { type: "While", test, body };
  }

  private parseFor(): Stmt {
    this.expect("for");
    this.expect("(");

    // for (let x of xs) ...
    const head = this.peek();
    if (head.kind === "keyword" && (head.value === "let" || head.value === "const")) {
      const next = this.peek(1);
      const after = this.peek(2);
      if (next.kind === "ident" && after.value === "of") {
        const kind = this.advance().value as "let" | "const";
        const name = this.expectIdent();
        this.expect("of");
        const iter = this.parseExpression();
        this.expect(")");
        const body = this.parseStatement();
        return { type: "ForOf", kind, name, iter, body };
      }
    }

    let init: Stmt | Expr | null = null;
    if (!this.at(";")) {
      const t = this.peek();
      init = t.kind === "keyword" && (t.value === "let" || t.value === "const")
        ? this.parseVarDecl()
        : this.parseExpression();
    }
    if (init === null || (init as Stmt).type !== "VarDecl") this.expect(";");
    const test = this.at(";") ? null : this.parseExpression();
    this.expect(";");
    const update = this.at(")") ? null : this.parseExpression();
    this.expect(")");
    const body = this.parseStatement();
    return { type: "For", init, test, update, body };
  }

  private parseExpression(): Expr {
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    const arrow = this.tryParseArrow();
    if (arrow) return arrow;
    const left = this.parseBinary(0);
    if (ASSIGN_OPS.has(this.peek().value)) {
      this.advance();
      const right = this.parseAssign();
      return { type: "Assign", left, right };
    }
    return left;
  }

  private tryParseArrow(): Expr | null {
    const tok = this.peek();
    // x => body
    if (tok.kind === "ident" && this.peek(1).value === "=>") {
      const param = this.advance();
      this.advance();
      return { type: "Arrow", params: [param], body: this.parseArrowBody() };
    }
    // (a, b) => body — speculative parse with backtracking
    if (tok.value === "(") {
      const save = this.pos;
      const params: Token[] = [];
      let ok = true;
      this.advance();
      if (!this.at(")")) {
        for (;;) {
          if (this.peek().kind !== "ident") { ok = false; break; }
          params.push(this.advance());
          if (!this.eat(",")) break;
        }
      }
      if (ok && this.eat(")") && this.eat("=>")) {
        return { type: "Arrow", params, body: this.parseArrowBody() };
      }
      this.pos = save;
    }
    return null;
  }

  private parseArrowBody(): Block | Expr {
    if (this.at("{")) return this.parseBlock();
    return this.parseAssign();
  }

  private parseBinary(minPrec: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const op = this.peek().value;
      const prec = BINARY_PREC[op];
      if (prec === undefined || prec < minPrec) return left;
      this.advance();
      const right = this.parseBinary(prec + 1);
      left = { type: "Binary", op, left, right };
    }
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (UNARY_OPS.has(tok.value) && (tok.kind === "punct" || tok.kind === "keyword")) {
      this.advance();
      return { type: "Unary", op: tok.value, argument: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.eat(".")) {
        const property = this.advance();
        if (property.kind !== "ident" && property.kind !== "keyword") {
          throw new ParseError(`expected property name at offset ${property.start}`);
        }
        expr = { type: "Member", object: expr, property, computed: null };
      } else if (this.eat("[")) {
        const computed = this.parseExpression();
        this.expect("]");
        expr = { type: "Member", object: expr, property: null, computed };
      } else if (this.eat("(")) {
        const args: Expr[] = [];
        if (!this.at(")")) {
          do {
            args.push(this.parseExpression());
          } while (this.eat(","));
        }
        this.expect(")");
        expr = { type: "Call", callee: expr, args };
      } else if (this.at("++") || this.at("--")) {
        this.advance();
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    if (tok.kind === "number" || tok.kind === "string") {
      this.advance();
      return { type: "Literal", token: tok };
    }
    if (tok.kind === "ident") {
      this.advance();
      return { type: "Ident", token: tok };
    }
    if (tok.kind === "keyword") {
      if (["true", "false", "null", "this", "undefined"].includes(tok.value)) {
        this.advance();
        return { type: "Literal", token: tok };
      }
      if (tok.value === "function") {
        this.advance();
        const name = this.peek().kind === "ident" ? this.advance() : null;
        const params = this.parseParams();
        const body = this.parseBlock();
        return { type: "FunctionExpr", name, params, body };
      }
      if (tok.value === "new") {
        this.advance();
        return this.parsePostfix();
      }
    }
    if (tok.value === "(") {
      this.advance();
      const expr = this.parseExpression();
      this.expect(")");
      return expr;
    }
    if (tok.value === "[") {
      this.advance();
      const elements: Expr[] = [];
      if (!this.at("]")) {
        do {
          elements.push(this.parseExpression());
        } while (this.eat(","));
      }
      this.expect("]");
      return { type: "Array", elements };
    }
    if (tok.value === "{") {
      this.advance();
      const props: Prop[] = [];
      if (!this.at("}")) {
        do {
          if (this.eat("...")) {
            props.push({ kind: "spread", value: this.parseExpression() });
            continue;
          }
          const key = this.advance();
          if (key.kind !== "ident" && key.kind !== "keyword" && key.kind !== "string") {
            throw new ParseError(`expected object key at offset ${key.start}`);
          }
          if (this.eat(":")) {
            props.push({ kind: "kv", key, value: this.parseExpression() });
          } else if (this.at("(")) {
            const params = this.parseParams();
            const body = this.parseBlock();
            props.push({ kind: "kv", key, value: { type: "FunctionExpr", name: null, params, body } });
          } else if (key.kind === "ident") {
            props.push({ kind: "shorthand", name: key });
          } else {
            throw new ParseError(`expected ":" after object key at offset ${key.end}`);
          }
        } while (this.eat(","));
      }
      this.expect("}");
      return { type: "Object", props };
    }
    throw new ParseError(`unexpected token ${JSON.stringify(tok.value)} at offset ${tok.start}`);
  }
}

export function parse(tokens: Token[]): Program {
  return new Parser(tokens).parseProgram();
}
