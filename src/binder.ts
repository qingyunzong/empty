import type { Expr, Ident, Program, Span, Stmt } from "./ast.js";

export type ScopeKind = "global" | "block" | "function";

export interface Scope {
  id: number;
  kind: ScopeKind;
  parent: Scope | null;
  /** First declaration per name in this scope (block-wide visible). */
  declarations: Map<string, Decl>;
  children: Scope[];
}

export type DeclKindFull = "let" | "var" | "const" | "function" | "param";

export interface Decl {
  id: number;
  name: string;
  /** Byte span of the declared identifier (the edit site for renames). */
  nameSpan: Span;
  scope: Scope;
  kind: DeclKindFull;
  /** All references that resolve to this declaration. */
  refs: Ref[];
}

export interface Ref {
  name: string;
  /** Byte span of the referencing identifier. */
  span: Span;
  /** Scope in which the reference textually occurs. */
  scope: Scope;
  /** Resolved declaration, or null when the name is undeclared. */
  decl: Decl | null;
}

export interface BindResult {
  program: Program;
  globalScope: Scope;
  declarations: Decl[];
  references: Ref[];
}

/**
 * Builds the scope tree and resolves every reference.
 *
 * Scoping rules (explicit):
 *  - Every `{ ... }` block, every function body, and the top level introduce a
 *    scope. Function parameters are declared in the function's scope.
 *  - Declarations are visible throughout the ENTIRE enclosing block, including
 *    textually before the declaration statement (use-before-define resolves
 *    within the whole block). This is implemented by hoisting all declarations
 *    of a block before resolving any of its references.
 *  - An inner declaration shadows any outer declaration of the same name for
 *    references inside the inner block.
 */
export function bind(program: Program): BindResult {
  let nextScopeId = 0;
  let nextDeclId = 0;
  const declarations: Decl[] = [];
  const references: Ref[] = [];

  function createScope(kind: ScopeKind, parent: Scope | null): Scope {
    const scope: Scope = {
      id: nextScopeId++,
      kind,
      parent,
      declarations: new Map(),
      children: [],
    };
    if (parent) parent.children.push(scope);
    return scope;
  }

  function declare(scope: Scope, ident: Ident, kind: DeclKindFull): Decl {
    const decl: Decl = {
      id: nextDeclId++,
      name: ident.name,
      nameSpan: { start: ident.start, end: ident.end },
      scope,
      kind,
      refs: [],
    };
    // A duplicate name in the same block is a program error; the first
    // declaration wins for resolution purposes.
    if (!scope.declarations.has(ident.name)) {
      scope.declarations.set(ident.name, decl);
    }
    declarations.push(decl);
    return decl;
  }

  function resolve(ident: Ident, scope: Scope): void {
    let cursor: Scope | null = scope;
    while (cursor) {
      const decl = cursor.declarations.get(ident.name);
      if (decl) {
        const ref: Ref = {
          name: ident.name,
          span: { start: ident.start, end: ident.end },
          scope,
          decl,
        };
        decl.refs.push(ref);
        references.push(ref);
        return;
      }
      cursor = cursor.parent;
    }
    references.push({
      name: ident.name,
      span: { start: ident.start, end: ident.end },
      scope,
      decl: null,
    });
  }

  function bindBlockBody(stmts: Stmt[], scope: Scope): void {
    // Pass 1: hoist every declaration of the block so that names are visible
    // across the whole block, before any reference is resolved.
    for (const stmt of stmts) {
      if (stmt.kind === "Decl") declare(scope, stmt.name, stmt.declKind);
      else if (stmt.kind === "FuncDecl") declare(scope, stmt.name, "function");
    }
    // Pass 2: walk statements and resolve references.
    for (const stmt of stmts) bindStmt(stmt, scope);
  }

  function bindStmt(stmt: Stmt, scope: Scope): void {
    switch (stmt.kind) {
      case "Decl":
        bindExpr(stmt.init, scope);
        break;
      case "FuncDecl": {
        const fnScope = createScope("function", scope);
        for (const param of stmt.params) declare(fnScope, param, "param");
        bindBlockBody(stmt.body.body, fnScope);
        break;
      }
      case "Block": {
        const child = createScope("block", scope);
        bindBlockBody(stmt.body, child);
        break;
      }
      case "ExprStmt":
        bindExpr(stmt.expr, scope);
        break;
      case "Return":
        if (stmt.arg) bindExpr(stmt.arg, scope);
        break;
    }
  }

  function bindExpr(expr: Expr, scope: Scope): void {
    switch (expr.kind) {
      case "Ident":
        resolve(expr, scope);
        break;
      case "Assign":
        resolve(expr.target, scope);
        bindExpr(expr.value, scope);
        break;
      case "Binary":
        bindExpr(expr.left, scope);
        bindExpr(expr.right, scope);
        break;
      case "Call":
        bindExpr(expr.callee, scope);
        for (const arg of expr.args) bindExpr(arg, scope);
        break;
      case "Num":
      case "Str":
        break;
    }
  }

  const globalScope = createScope("global", null);
  bindBlockBody(program.body, globalScope);
  return { program, globalScope, declarations, references };
}
