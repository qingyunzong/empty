export type ErrorKind = 'div-by-zero' | 'mod-by-zero';
export type Op = 'add' | 'sub' | 'mul' | 'div' | 'mod';

export interface Lit { kind: 'lit'; id: number; value: bigint }
export interface Err { kind: 'err'; id: number; error: ErrorKind }
export interface Var { kind: 'var'; id: number; name: string }
export interface Bin { kind: 'bin'; id: number; op: Op; left: Node; right: Node }
export interface LogN { kind: 'log'; id: number; expr: Node }
export interface If { kind: 'if'; id: number; cond: Node; then: Node; else: Node }
/** Evaluates expr, memoizes the result under name, returns it. Introduced by CSE. */
export interface Bind { kind: 'bind'; id: number; name: string; expr: Node }
/** Reads a value previously stored by bind. Introduced by CSE. */
export interface Ref { kind: 'ref'; id: number; name: string }

export type Node = Lit | Err | Var | Bin | LogN | If | Bind | Ref;

export class IdGen {
  private n: number;
  constructor(start = 1) { this.n = start; }
  next(): number { return this.n++; }
}

export function lit(id: number, value: bigint): Lit { return { kind: 'lit', id, value }; }
export function err(id: number, error: ErrorKind): Err { return { kind: 'err', id, error }; }
export function vaR(id: number, name: string): Var { return { kind: 'var', id, name }; }
export function bin(id: number, op: Op, left: Node, right: Node): Bin {
  return { kind: 'bin', id, op, left, right };
}
export function logN(id: number, expr: Node): LogN { return { kind: 'log', id, expr }; }
export function ifN(id: number, cond: Node, then: Node, els: Node): If {
  return { kind: 'if', id, cond, then, else: els };
}

/** Canonical source text for a subtree; also used as the structural CSE key. */
export function render(node: Node): string {
  switch (node.kind) {
    case 'lit': return node.value.toString();
    case 'err': return `<err:${node.error}>`;
    case 'var': return node.name;
    case 'bin': return `(${node.op} ${render(node.left)} ${render(node.right)})`;
    case 'log': return `(log ${render(node.expr)})`;
    case 'if': return `(if ${render(node.cond)} ${render(node.then)} ${render(node.else)})`;
    case 'bind': return `(bind ${node.name} ${render(node.expr)})`;
    case 'ref': return `(ref ${node.name})`;
  }
}

export function size(node: Node): number {
  switch (node.kind) {
    case 'lit': case 'err': case 'var': case 'ref': return 1;
    case 'log': case 'bind': return 1 + size(node.expr);
    case 'bin': return 1 + size(node.left) + size(node.right);
    case 'if': return 1 + size(node.cond) + size(node.then) + size(node.else);
  }
}

export function maxId(node: Node): number {
  let m = node.id;
  forEachChild(node, (c) => { m = Math.max(m, maxId(c)); });
  return m;
}

export function collectIds(node: Node, out: number[] = []): number[] {
  out.push(node.id);
  forEachChild(node, (c) => collectIds(c, out));
  return out;
}

export function forEachChild(node: Node, f: (c: Node) => void): void {
  switch (node.kind) {
    case 'lit': case 'err': case 'var': case 'ref': return;
    case 'log': case 'bind': f(node.expr); return;
    case 'bin': f(node.left); f(node.right); return;
    case 'if': f(node.cond); f(node.then); f(node.else); return;
  }
}

/** Pure = contains no side-effecting log node. */
export function isPure(node: Node): boolean {
  if (node.kind === 'log') return false;
  let pure = true;
  forEachChild(node, (c) => { if (!isPure(c)) pure = false; });
  return pure;
}

/** May raise an integer error (div/mod by zero, or a folded error literal). */
export function mayError(node: Node): boolean {
  if (node.kind === 'err') return true;
  if (node.kind === 'bin' && (node.op === 'div' || node.op === 'mod')) return true;
  let may = false;
  forEachChild(node, (c) => { if (mayError(c)) may = true; });
  return may;
}

export function containsBindOrRef(node: Node): boolean {
  if (node.kind === 'bind' || node.kind === 'ref') return true;
  let found = false;
  forEachChild(node, (c) => { if (containsBindOrRef(c)) found = true; });
  return found;
}
