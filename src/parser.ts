import { lex, type Token } from "./lexer.js";
import type {
  Block,
  DeclKind,
  DeclStmt,
  Expr,
  ExprStmt,
  FuncDecl,
  Ident,
  Program,
  ReturnStmt,
  Stmt,
} from "./ast.js";

/**
 * Grammar (a small JS-like language):
 *
 *   program    := stmt*
 *   stmt       := decl | funcDecl | block | returnStmt | exprStmt
 *   decl       := ("let" | "var" | "const") IDENT "=" expr ";"
 *   funcDecl   := "function" IDENT "(" [IDENT ("," IDENT)*] ")" block
 *   block      := "{" stmt* "}"
 *   returnStmt := "return" [expr] ";"
 *   exprStmt   := expr ";"
 *   expr       := IDENT "=" expr | equality
 *   equality   := additive (("=="|"!="|"<"|">"|"<="|">=") additive)*
 *   additive   := multiplicative (("+"|"-") multiplicative)*
 *   multiplicative := postfix (("*"|"/") postfix)*
 *   postfix    := primary ("(" [expr ("," expr)*] ")")*
 *   primary    := NUMBER | STRING | IDENT | "(" expr ")"
 */
export function parse(source: string): Program {
  const tokens = lex(source);
  let pos = 0;

  function peek(): Token {
    return tokens[pos]!;
  }
  function next(): Token {
    return tokens[pos++]!;
  }
  function atPunct(value: string): boolean {
    const t = peek();
    return t.type === "punct" && t.value === value;
  }
  function atKeyword(value: string): boolean {
    const t = peek();
    return t.type === "keyword" && t.value === value;
  }
  function expectPunct(value: string): Token {
    const t = peek();
    if (t.type !== "punct" || t.value !== value) {
      throw new SyntaxError(
        `Expected '${value}' but found '${t.value || t.type}' at offset ${t.start}`,
      );
    }
    return next();
  }
  function parseIdent(): Ident {
    const t = peek();
    if (t.type !== "ident") {
      throw new SyntaxError(
        `Expected identifier but found '${t.value || t.type}' at offset ${t.start}`,
      );
    }
    next();
    return { kind: "Ident", name: t.value, start: t.start, end: t.end };
  }

  function parseStmt(): Stmt {
    const t = peek();
    if (t.type === "keyword") {
      if (t.value === "let" || t.value === "var" || t.value === "const") return parseDecl();
      if (t.value === "function") return parseFuncDecl();
      if (t.value === "return") return parseReturn();
    }
    if (atPunct("{")) return parseBlock();
    return parseExprStmt();
  }

  function parseDecl(): DeclStmt {
    const kw = next();
    const name = parseIdent();
    expectPunct("=");
    const init = parseExpr();
    const semi = expectPunct(";");
    return {
      kind: "Decl",
      declKind: kw.value as DeclKind,
      name,
      init,
      start: kw.start,
      end: semi.end,
    };
  }

  function parseFuncDecl(): FuncDecl {
    const kw = next();
    const name = parseIdent();
    expectPunct("(");
    const params: Ident[] = [];
    if (!atPunct(")")) {
      params.push(parseIdent());
      while (atPunct(",")) {
        next();
        params.push(parseIdent());
      }
    }
    expectPunct(")");
    const body = parseBlock();
    return { kind: "FuncDecl", name, params, body, start: kw.start, end: body.end };
  }

  function parseBlock(): Block {
    const open = expectPunct("{");
    const body: Stmt[] = [];
    while (!atPunct("}")) {
      if (peek().type === "eof") {
        throw new SyntaxError(`Unterminated block starting at offset ${open.start}`);
      }
      body.push(parseStmt());
    }
    const close = expectPunct("}");
    return { kind: "Block", body, start: open.start, end: close.end };
  }

  function parseReturn(): ReturnStmt {
    const kw = next();
    if (atPunct(";")) {
      const semi = next();
      return { kind: "Return", arg: null, start: kw.start, end: semi.end };
    }
    const arg = parseExpr();
    const semi = expectPunct(";");
    return { kind: "Return", arg, start: kw.start, end: semi.end };
  }

  function parseExprStmt(): ExprStmt {
    const expr = parseExpr();
    const semi = expectPunct(";");
    return { kind: "ExprStmt", expr, start: expr.start, end: semi.end };
  }

  function parseExpr(): Expr {
    return parseAssign();
  }

  function parseAssign(): Expr {
    const left = parseEquality();
    if (atPunct("=")) {
      if (left.kind !== "Ident") {
        throw new SyntaxError(`Invalid assignment target at offset ${left.start}`);
      }
      next();
      const value = parseAssign();
      return { kind: "Assign", target: left, value, start: left.start, end: value.end };
    }
    return left;
  }

  function parseBinaryLevel(
    sub: () => Expr,
    ops: ReadonlySet<string>,
  ): Expr {
    let left = sub();
    for (;;) {
      const t = peek();
      if (t.type !== "punct" || !ops.has(t.value)) return left;
      next();
      const right = sub();
      left = { kind: "Binary", op: t.value, left, right, start: left.start, end: right.end };
    }
  }

  const EQUALITY_OPS = new Set(["==", "!=", "<", ">", "<=", ">="]);
  const ADDITIVE_OPS = new Set(["+", "-"]);
  const MULTIPLICATIVE_OPS = new Set(["*", "/"]);

  function parseEquality(): Expr {
    return parseBinaryLevel(parseAdditive, EQUALITY_OPS);
  }
  function parseAdditive(): Expr {
    return parseBinaryLevel(parseMultiplicative, ADDITIVE_OPS);
  }
  function parseMultiplicative(): Expr {
    return parseBinaryLevel(parsePostfix, MULTIPLICATIVE_OPS);
  }

  function parsePostfix(): Expr {
    let expr = parsePrimary();
    while (atPunct("(")) {
      const open = next();
      const args: Expr[] = [];
      if (!atPunct(")")) {
        args.push(parseExpr());
        while (atPunct(",")) {
          next();
          args.push(parseExpr());
        }
      }
      const close = expectPunct(")");
      expr = { kind: "Call", callee: expr, args, start: expr.start, end: close.end };
      void open;
    }
    return expr;
  }

  function parsePrimary(): Expr {
    const t = peek();
    if (t.type === "number") {
      next();
      return { kind: "Num", value: t.value, start: t.start, end: t.end };
    }
    if (t.type === "string") {
      next();
      return { kind: "Str", value: t.value, start: t.start, end: t.end };
    }
    if (t.type === "ident") return parseIdent();
    if (atPunct("(")) {
      next();
      const expr = parseExpr();
      expectPunct(")");
      return expr;
    }
    throw new SyntaxError(
      `Unexpected token '${t.value || t.type}' at offset ${t.start}`,
    );
  }

  const body: Stmt[] = [];
  while (peek().type !== "eof") body.push(parseStmt());
  return { kind: "Program", body, start: 0, end: source.length };
}
