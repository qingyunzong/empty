import { Token } from "./lexer.js";
import * as ast from "./parser.js";

export type DeclKind = "let" | "const" | "param" | "function";

export interface Decl {
  /** Current binding name. Mutated transiently during rename simulation. */
  name: string;
  /** Token of the declaration's name occurrence. */
  token: Token;
  kind: DeclKind;
  scope: Scope;
}

export class Scope {
  readonly decls = new Map<string, Decl>();
  constructor(readonly parent: Scope | null) {}
  lookup(name: string): Decl | null {
    let scope: Scope | null = this;
    while (scope !== null) {
      const decl = scope.decls.get(name);
      if (decl !== undefined) return decl;
      scope = scope.parent;
    }
    return null;
  }
}

export interface Ref {
  token: Token;
  /** The declaration this reference resolves to, or null for a global name. */
  decl: Decl | null;
  /** The scope the reference appears in (resolution starts here). */
  scope: Scope;
}

export interface Analysis {
  refs: Ref[];
  decls: Decl[];
  globalScope: Scope;
}

/**
 * Builds the scope tree and resolves every identifier reference.
 *
 * Scope rules (documented in README):
 * - `let`/`const` and function declarations are block scoped.
 * - A block-scoped declaration is visible throughout its ENTIRE block,
 *   including textually earlier positions (use-before-define resolves to it).
 * - Inner declarations shadow outer ones within the inner block.
 * - Function parameters live in a scope wrapping the function body block.
 */
export function analyze(program: ast.Program): Analysis {
  const refs: Ref[] = [];
  const decls: Decl[] = [];
  const globalScope = new Scope(null);

  function declare(scope: Scope, token: Token, kind: DeclKind): void {
    if (scope.decls.has(token.value)) return; // duplicate in one scope: keep first
    const decl: Decl = { name: token.value, token, kind, scope };
    scope.decls.set(token.value, decl);
    decls.push(decl);
  }

  function resolveIdent(scope: Scope, token: Token): void {
    refs.push({ token, decl: scope.lookup(token.value), scope });
  }

  // Whole-block visibility: collect all declarations directly owned by a
  // block before resolving any reference inside it.
  function hoistBlock(body: ast.Stmt[], scope: Scope): void {
    for (const stmt of body) {
      if (stmt.type === "VarDecl") {
        for (const d of stmt.decls) declare(scope, d.name, stmt.kind);
      } else if (stmt.type === "FunctionDecl") {
        declare(scope, stmt.name, "function");
      }
    }
  }

  function visitBlock(body: ast.Stmt[], parent: Scope): Scope {
    const scope = new Scope(parent);
    hoistBlock(body, scope);
    for (const stmt of body) visitStmt(stmt, scope);
    return scope;
  }

  function visitFunction(
    name: Token | null,
    params: Token[],
    body: ast.Block,
    scope: Scope,
  ): void {
    const fnScope = new Scope(scope);
    if (name !== null) declare(fnScope, name, "function"); // named function expression
    for (const param of params) declare(fnScope, param, "param");
    visitBlock(body.body, fnScope);
  }

  function visitNested(stmt: ast.Stmt, scope: Scope): void {
    if (stmt.type === "Block") visitBlock(stmt.body, scope);
    else visitStmt(stmt, scope);
  }

  function visitStmt(stmt: ast.Stmt, scope: Scope): void {
    switch (stmt.type) {
      case "Block":
        visitBlock(stmt.body, scope);
        break;
      case "VarDecl":
        for (const d of stmt.decls) if (d.init) visitExpr(d.init, scope);
        break;
      case "FunctionDecl":
        visitFunction(null, stmt.params, stmt.body, scope);
        break;
      case "If":
        visitExpr(stmt.test, scope);
        visitNested(stmt.consequent, scope);
        if (stmt.alternate) visitNested(stmt.alternate, scope);
        break;
      case "While":
        visitExpr(stmt.test, scope);
        visitNested(stmt.body, scope);
        break;
      case "For": {
        const forScope = new Scope(scope);
        if (stmt.init) {
          if (stmt.init.type === "VarDecl") {
            for (const d of stmt.init.decls) {
              declare(forScope, d.name, stmt.init.kind);
              if (d.init) visitExpr(d.init, forScope);
            }
          } else if (stmt.init.type !== "Block") {
            visitExpr(stmt.init as ast.Expr, forScope);
          }
        }
        if (stmt.test) visitExpr(stmt.test, forScope);
        if (stmt.update) visitExpr(stmt.update, forScope);
        visitNested(stmt.body, forScope);
        break;
      }
      case "ForOf": {
        const forScope = new Scope(scope);
        declare(forScope, stmt.name, stmt.kind);
        visitExpr(stmt.iter, forScope);
        visitNested(stmt.body, forScope);
        break;
      }
      case "Return":
        if (stmt.argument) visitExpr(stmt.argument, scope);
        break;
      case "ExprStmt":
        visitExpr(stmt.expr, scope);
        break;
    }
  }

  function visitExpr(expr: ast.Expr, scope: Scope): void {
    switch (expr.type) {
      case "Ident":
        resolveIdent(scope, expr.token);
        break;
      case "Literal":
        break;
      case "Binary":
        visitExpr(expr.left, scope);
        visitExpr(expr.right, scope);
        break;
      case "Unary":
        visitExpr(expr.argument, scope);
        break;
      case "Assign":
        visitExpr(expr.left, scope);
        visitExpr(expr.right, scope);
        break;
      case "Call":
        visitExpr(expr.callee, scope);
        for (const arg of expr.args) visitExpr(arg, scope);
        break;
      case "Member":
        visitExpr(expr.object, scope);
        if (expr.computed) visitExpr(expr.computed, scope);
        break;
      case "Arrow": {
        const fnScope = new Scope(scope);
        for (const param of expr.params) declare(fnScope, param, "param");
        if (expr.body.type === "Block") visitBlock(expr.body.body, fnScope);
        else visitExpr(expr.body, fnScope);
        break;
      }
      case "FunctionExpr":
        visitFunction(expr.name, expr.params, expr.body, scope);
        break;
      case "Object":
        for (const prop of expr.props) {
          if (prop.kind === "kv") visitExpr(prop.value, scope);
          else if (prop.kind === "shorthand") resolveIdent(scope, prop.name);
          else visitExpr(prop.value, scope);
        }
        break;
      case "Array":
        for (const el of expr.elements) visitExpr(el, scope);
        break;
    }
  }

  // The program itself is the top-level block.
  hoistBlock(program.body, globalScope);
  for (const stmt of program.body) visitStmt(stmt, globalScope);

  return { refs, decls, globalScope };
}
