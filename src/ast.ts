export interface Span {
  start: number;
  end: number;
}

export type BinOp = '+' | '-' | '*' | '/' | '%';

interface Base {
  id: number;
  span: Span;
}

export interface ConstExpr extends Base { kind: 'const'; value: number }
export interface VarExpr extends Base { kind: 'var'; name: string }
export interface BinExpr extends Base { kind: 'bin'; op: BinOp; left: Expr; right: Expr }
export interface LogExpr extends Base { kind: 'log'; expr: Expr }
export interface IfExpr extends Base { kind: 'if'; cond: Expr; then: Expr; else: Expr }
export interface LetExpr extends Base { kind: 'let'; name: string; value: Expr; body: Expr }

export type Expr = ConstExpr | VarExpr | BinExpr | LogExpr | IfExpr | LetExpr;

let nextId = 1;
export function freshId(): number {
  return nextId++;
}

export function constExpr(value: number, span: Span): ConstExpr {
  return { kind: 'const', id: freshId(), span, value };
}
export function varExpr(name: string, span: Span): VarExpr {
  return { kind: 'var', id: freshId(), span, name };
}
export function binExpr(op: BinOp, left: Expr, right: Expr, span: Span): BinExpr {
  return { kind: 'bin', id: freshId(), span, op, left, right };
}
export function logExpr(expr: Expr, span: Span): LogExpr {
  return { kind: 'log', id: freshId(), span, expr };
}
export function ifExpr(cond: Expr, then: Expr, els: Expr, span: Span): IfExpr {
  return { kind: 'if', id: freshId(), span, cond, then, else: els };
}
export function letExpr(name: string, value: Expr, body: Expr, span: Span): LetExpr {
  return { kind: 'let', id: freshId(), span, name, value, body };
}

/** Deep clone with fresh node ids, keeping spans. */
export function cloneExpr(e: Expr): Expr {
  switch (e.kind) {
    case 'const': return constExpr(e.value, e.span);
    case 'var': return varExpr(e.name, e.span);
    case 'bin': return binExpr(e.op, cloneExpr(e.left), cloneExpr(e.right), e.span);
    case 'log': return logExpr(cloneExpr(e.expr), e.span);
    case 'if': return ifExpr(cloneExpr(e.cond), cloneExpr(e.then), cloneExpr(e.else), e.span);
    case 'let': return letExpr(e.name, cloneExpr(e.value), cloneExpr(e.body), e.span);
  }
}

/** Pure = performs no side-effecting log action anywhere inside. */
export function isPure(e: Expr): boolean {
  switch (e.kind) {
    case 'const':
    case 'var': return true;
    case 'log': return false;
    case 'bin': return isPure(e.left) && isPure(e.right);
    case 'if': return isPure(e.cond) && isPure(e.then) && isPure(e.else);
    case 'let': return isPure(e.value) && isPure(e.body);
  }
}

/** Can raise an integer error (division / modulo by zero). */
export function canRaise(e: Expr): boolean {
  switch (e.kind) {
    case 'const':
    case 'var': return false;
    case 'log': return canRaise(e.expr);
    case 'bin': return e.op === '/' || e.op === '%' || canRaise(e.left) || canRaise(e.right);
    case 'if': return canRaise(e.cond) || canRaise(e.then) || canRaise(e.else);
    case 'let': return canRaise(e.value) || canRaise(e.body);
  }
}

export function freeVars(e: Expr, bound: Set<string> = new Set(), out: Set<string> = new Set()): Set<string> {
  switch (e.kind) {
    case 'const': break;
    case 'var': if (!bound.has(e.name)) out.add(e.name); break;
    case 'log': freeVars(e.expr, bound, out); break;
    case 'bin': freeVars(e.left, bound, out); freeVars(e.right, bound, out); break;
    case 'if':
      freeVars(e.cond, bound, out);
      freeVars(e.then, bound, out);
      freeVars(e.else, bound, out);
      break;
    case 'let': {
      freeVars(e.value, bound, out);
      const inner = new Set(bound);
      inner.add(e.name);
      freeVars(e.body, inner, out);
      break;
    }
  }
  return out;
}

export function countNodes(e: Expr): number {
  switch (e.kind) {
    case 'const':
    case 'var': return 1;
    case 'log': return 1 + countNodes(e.expr);
    case 'bin': return 1 + countNodes(e.left) + countNodes(e.right);
    case 'if': return 1 + countNodes(e.cond) + countNodes(e.then) + countNodes(e.else);
    case 'let': return 1 + countNodes(e.value) + countNodes(e.body);
  }
}

/** Structural identity, ignoring node ids and spans. */
export function structuralKey(e: Expr): string {
  switch (e.kind) {
    case 'const': return `c:${e.value}`;
    case 'var': return `v:${e.name}`;
    case 'bin': return `b:${e.op}(${structuralKey(e.left)},${structuralKey(e.right)})`;
    case 'log': return `log(${structuralKey(e.expr)})`;
    case 'if': return `if(${structuralKey(e.cond)},${structuralKey(e.then)},${structuralKey(e.else)})`;
    case 'let': return `let:${e.name}(${structuralKey(e.value)},${structuralKey(e.body)})`;
  }
}
