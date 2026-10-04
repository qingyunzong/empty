import {
  Expr, Span, BinOp,
  constExpr, varExpr, binExpr, logExpr, ifExpr, letExpr,
  isPure, canRaise, freeVars, countNodes, structuralKey,
} from './ast.js';

/** A single recorded rewrite: which source span was replaced, and which
 *  source span the replacement maps back to. */
export interface Rewrite {
  rule: 'const-fold' | 'dead-branch' | 'identity' | 'cse';
  before: Span;
  after: Span;
  detail: string;
}

export interface OptimizeResult {
  expr: Expr;
  rewrites: Rewrite[];
}

let cseCounter = 0;

export function optimize(root: Expr): OptimizeResult {
  const rewrites: Rewrite[] = [];
  cseCounter = 0;
  let expr = root;
  for (let i = 0; i < 20; i++) {
    const before = rewrites.length;
    expr = constFold(expr, rewrites);
    expr = deadBranch(expr, rewrites);
    expr = identities(expr, rewrites);
    expr = cseRegion(expr, rewrites);
    if (rewrites.length === before) break;
  }
  return { expr, rewrites };
}

function constFold(e: Expr, rw: Rewrite[]): Expr {
  switch (e.kind) {
    case 'const':
    case 'var':
      return e;
    case 'log':
      return logExpr(constFold(e.expr, rw), e.span);
    case 'if':
      return ifExpr(constFold(e.cond, rw), constFold(e.then, rw), constFold(e.else, rw), e.span);
    case 'let':
      return letExpr(e.name, constFold(e.value, rw), constFold(e.body, rw), e.span);
    case 'bin': {
      const left = constFold(e.left, rw);
      const right = constFold(e.right, rw);
      if (left.kind === 'const' && right.kind === 'const') {
        // Never fold a raising operation: the integer error must survive.
        if ((e.op === '/' || e.op === '%') && right.value === 0) {
          return binExpr(e.op, left, right, e.span);
        }
        const value = evalConst(e.op, left.value, right.value);
        const folded = constExpr(value, e.span);
        rw.push({
          rule: 'const-fold',
          before: e.span,
          after: folded.span,
          detail: `fold ${left.value} ${e.op} ${right.value} -> ${value}`,
        });
        return folded;
      }
      return binExpr(e.op, left, right, e.span);
    }
  }
}

function evalConst(op: BinOp, l: number, r: number): number {
  switch (op) {
    case '+': return (l + r) | 0;
    case '-': return (l - r) | 0;
    case '*': return Math.imul(l, r);
    case '/': return Math.trunc(l / r) | 0;
    case '%': return (l % r) | 0;
  }
}

function deadBranch(e: Expr, rw: Rewrite[]): Expr {
  switch (e.kind) {
    case 'const':
    case 'var':
      return e;
    case 'log':
      return logExpr(deadBranch(e.expr, rw), e.span);
    case 'bin':
      return binExpr(e.op, deadBranch(e.left, rw), deadBranch(e.right, rw), e.span);
    case 'let':
      return letExpr(e.name, deadBranch(e.value, rw), deadBranch(e.body, rw), e.span);
    case 'if': {
      const cond = deadBranch(e.cond, rw);
      const then = deadBranch(e.then, rw);
      const els = deadBranch(e.else, rw);
      if (cond.kind === 'const') {
        // The untaken branch never executes: dropping it cannot change the
        // value, the first error, or the action log.
        const taken = cond.value !== 0 ? then : els;
        rw.push({
          rule: 'dead-branch',
          before: e.span,
          after: taken.span,
          detail: `condition is constant ${cond.value}`,
        });
        return taken;
      }
      return ifExpr(cond, then, els, e.span);
    }
  }
}

function identities(e: Expr, rw: Rewrite[]): Expr {
  switch (e.kind) {
    case 'const':
    case 'var':
      return e;
    case 'log':
      return logExpr(identities(e.expr, rw), e.span);
    case 'if':
      return ifExpr(identities(e.cond, rw), identities(e.then, rw), identities(e.else, rw), e.span);
    case 'let':
      return letExpr(e.name, identities(e.value, rw), identities(e.body, rw), e.span);
    case 'bin': {
      const left = identities(e.left, rw);
      const right = identities(e.right, rw);
      const node = binExpr(e.op, left, right, e.span);
      const replace = (result: Expr, detail: string): Expr => {
        rw.push({ rule: 'identity', before: e.span, after: result.span, detail });
        return result;
      };
      const isConst = (x: Expr, v: number): boolean => x.kind === 'const' && x.value === v;
      // Dropping a subexpression is only allowed when it is pure and cannot
      // raise, so no log action or integer error is lost.
      const droppable = (x: Expr): boolean => isPure(x) && !canRaise(x);
      switch (e.op) {
        case '+':
          if (isConst(right, 0)) return replace(left, 'x + 0 -> x');
          if (isConst(left, 0)) return replace(right, '0 + x -> x');
          break;
        case '-':
          if (isConst(right, 0)) return replace(left, 'x - 0 -> x');
          break;
        case '*':
          if (isConst(right, 1)) return replace(left, 'x * 1 -> x');
          if (isConst(left, 1)) return replace(right, '1 * x -> x');
          if (isConst(right, 0) && droppable(left)) return replace(constExpr(0, e.span), 'x * 0 -> 0');
          if (isConst(left, 0) && droppable(right)) return replace(constExpr(0, e.span), '0 * x -> 0');
          break;
        case '/':
          if (isConst(right, 1)) return replace(left, 'x / 1 -> x');
          break;
        case '%':
          if (isConst(right, 1) && droppable(left)) return replace(constExpr(0, e.span), 'x % 1 -> 0');
          break;
      }
      return node;
    }
  }
}

/**
 * Children of `e` that are evaluated whenever `e` is evaluated, in
 * evaluation order. If-branches are excluded: they are conditional, so
 * expressions inside them are not must-execute.
 */
function regionChildren(e: Expr): Expr[] {
  switch (e.kind) {
    case 'const':
    case 'var': return [];
    case 'log': return [e.expr];
    case 'bin': return [e.left, e.right];
    case 'if': return [e.cond];
    case 'let': return [e.value, e.body];
  }
}

function collectRegion(e: Expr, out: Expr[]): void {
  out.push(e);
  for (const c of regionChildren(e)) collectRegion(c, out);
}

/** Path of region nodes from `root` to `target` (both inclusive), or null. */
function regionPath(root: Expr, target: Expr): Expr[] | null {
  if (root === target) return [root];
  for (const c of regionChildren(root)) {
    const p = regionPath(c, target);
    if (p) return [root, ...p];
  }
  return null;
}

/** Rebuild `root` with the node whose id is `id` replaced by `replacement`. */
function substitute(root: Expr, id: number, replacement: Expr): Expr {
  if (root.id === id) return replacement;
  switch (root.kind) {
    case 'const':
    case 'var':
      return root;
    case 'log':
      return logExpr(substitute(root.expr, id, replacement), root.span);
    case 'bin':
      return binExpr(root.op, substitute(root.left, id, replacement), substitute(root.right, id, replacement), root.span);
    case 'if':
      return ifExpr(
        substitute(root.cond, id, replacement),
        substitute(root.then, id, replacement),
        substitute(root.else, id, replacement), root.span);
    case 'let':
      return letExpr(root.name, substitute(root.value, id, replacement), substitute(root.body, id, replacement), root.span);
  }
}

/**
 * Hoisting `target` to the top of its region is safe when nothing evaluated
 * before it can be disturbed. A pure, non-raising target can always move.
 * A raising target may only move if everything fully evaluated before its
 * first occurrence is pure and non-raising, so the first error and the log
 * prefix stay identical.
 */
function hoistSafe(root: Expr, target: Expr): boolean {
  if (!canRaise(target)) return true;
  let bad = false;
  const visit = (n: Expr): boolean => {
    if (n === target) return true;
    for (const c of regionChildren(n)) {
      if (visit(c)) return true;
      if (!isPure(c) || canRaise(c)) bad = true;
    }
    return false;
  };
  visit(root);
  return !bad;
}

function replaceMany(e: Expr, ids: Set<number>, name: string, sharedSpan: Span, rw: Rewrite[]): Expr {
  if (ids.has(e.id)) {
    rw.push({ rule: 'cse', before: e.span, after: sharedSpan, detail: `shared as ${name}` });
    return varExpr(name, e.span);
  }
  switch (e.kind) {
    case 'const':
    case 'var':
      return e;
    case 'log':
      return logExpr(replaceMany(e.expr, ids, name, sharedSpan, rw), e.span);
    case 'bin':
      return binExpr(e.op,
        replaceMany(e.left, ids, name, sharedSpan, rw),
        replaceMany(e.right, ids, name, sharedSpan, rw), e.span);
    case 'if':
      return ifExpr(
        replaceMany(e.cond, ids, name, sharedSpan, rw),
        replaceMany(e.then, ids, name, sharedSpan, rw),
        replaceMany(e.else, ids, name, sharedSpan, rw), e.span);
    case 'let':
      return letExpr(e.name,
        replaceMany(e.value, ids, name, sharedSpan, rw),
        replaceMany(e.body, ids, name, sharedSpan, rw), e.span);
  }
}

/** One CSE step within a single must-execute region. The shared expression
 *  is bound at the deepest point that still dominates every occurrence and
 *  keeps its free variables in scope. Returns null when no profitable, safe
 *  sharing opportunity exists. */
function cseOnce(root: Expr, rw: Rewrite[]): Expr | null {
  const region: Expr[] = [];
  collectRegion(root, region);
  const byKey = new Map<string, Expr[]>();
  for (const n of region) {
    if (n.kind !== 'bin' || !isPure(n)) continue;
    const key = structuralKey(n);
    const list = byKey.get(key);
    if (list) list.push(n);
    else byKey.set(key, [n]);
  }
  const candidates = [...byKey.values()]
    .filter((list) => list.length >= 2)
    .sort((a, b) => countNodes(b[0] as Expr) - countNodes(a[0] as Expr));
  if (candidates.length === 0) return null;

  for (const nodes of candidates) {
    const target = nodes[0] as Expr;
    if (!hoistSafe(root, target)) continue;
    const fv = freeVars(target);
    const paths = nodes.map((n) => regionPath(root, n) as Expr[]);
    // Deepest region node that dominates every occurrence.
    let depth = 0;
    while (paths.every((p) => p[depth] === (paths[0] as Expr[])[depth])) depth++;
    let sIdx = depth - 1;
    // The binding let for any free variable of `target` must stay above the
    // hoist point; descend into let bodies to satisfy that.
    let hoist: Expr | null = null;
    for (;;) {
      const s = (paths[0] as Expr[])[sIdx] as Expr;
      const conflict = paths.some((p) =>
        p.slice(sIdx).some((n) => n.kind === 'let' && fv.has((n as { name: string }).name)));
      if (!conflict) {
        hoist = s;
        break;
      }
      const nexts = paths.map((p) => p[sIdx + 1]);
      if (s.kind === 'let' && nexts.every((n) => n === s.body)) {
        sIdx++;
        continue;
      }
      break;
    }
    if (!hoist) continue;
    const name = `$cse${cseCounter++}`;
    const ids = new Set(nodes.map((n) => n.id));
    const shared = letExpr(name, target, replaceMany(hoist, ids, name, target.span, rw), hoist.span);
    return substitute(root, hoist.id, shared);
  }
  return null;
}

/** Apply CSE to the must-execute region rooted at `e`, recursing into
 *  if-branches as independent regions. */
function cseRegion(e: Expr, rw: Rewrite[]): Expr {
  e = transformSubregions(e, rw);
  for (;;) {
    const next = cseOnce(e, rw);
    if (!next) return e;
    e = next;
  }
}

function transformSubregions(e: Expr, rw: Rewrite[]): Expr {
  switch (e.kind) {
    case 'const':
    case 'var':
      return e;
    case 'log':
      return logExpr(transformSubregions(e.expr, rw), e.span);
    case 'bin':
      return binExpr(e.op, transformSubregions(e.left, rw), transformSubregions(e.right, rw), e.span);
    case 'let':
      return letExpr(e.name, transformSubregions(e.value, rw), transformSubregions(e.body, rw), e.span);
    case 'if':
      return ifExpr(
        transformSubregions(e.cond, rw),
        cseRegion(e.then, rw),
        cseRegion(e.else, rw),
        e.span);
  }
}
