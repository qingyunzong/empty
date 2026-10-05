import {
  Node, IdGen, render, size, collectIds, maxId,
  isPure, mayError, containsBindOrRef,
} from './ast';
import { applyOp } from './interp';

/** One rewrite step, with the before/after source of the affected subtree. */
export interface RewriteRecord {
  rule: 'fold-const' | 'fold-error' | 'fold-if' | 'identity' | 'cse-bind' | 'cse-ref';
  before: { id: number; src: string };
  after: { id: number; src: string };
}

export interface OptimizeResult {
  node: Node;
  rewrites: RewriteRecord[];
  /** Every node id in each replaced subtree -> ids of the replacement subtree. */
  sourceMap: Map<number, number[]>;
}

class Ctx {
  rewrites: RewriteRecord[] = [];
  sourceMap = new Map<number, number[]>();
  cseCount = 0;
  constructor(public ids: IdGen) {}
  record(rule: RewriteRecord['rule'], before: Node, after: Node): void {
    this.rewrites.push({
      rule,
      before: { id: before.id, src: render(before) },
      after: { id: after.id, src: render(after) },
    });
    const afterIds = collectIds(after);
    for (const id of collectIds(before)) {
      const prev = this.sourceMap.get(id);
      this.sourceMap.set(id, prev ? prev.concat(afterIds) : afterIds);
    }
  }
}

export function optimize(root: Node): OptimizeResult {
  const ctx = new Ctx(new IdGen(maxId(root) + 1));
  let node = fold(root, ctx);
  node = cse(node, ctx);
  return { node, rewrites: ctx.rewrites, sourceMap: ctx.sourceMap };
}

/** Bottom-up constant folding, if-folding and safe identities. */
function fold(node: Node, ctx: Ctx): Node {
  switch (node.kind) {
    case 'lit':
    case 'err':
    case 'var':
    case 'ref':
      return node;
    case 'log': {
      const expr = fold(node.expr, ctx);
      return expr === node.expr ? node : { ...node, expr };
    }
    case 'bind': {
      const expr = fold(node.expr, ctx);
      return expr === node.expr ? node : { ...node, expr };
    }
    case 'if': {
      const cond = fold(node.cond, ctx);
      const then = fold(node.then, ctx);
      const els = fold(node.else, ctx);
      const cur: Node =
        cond === node.cond && then === node.then && els === node.else
          ? node
          : { kind: 'if', id: node.id, cond, then, else: els };
      if (cond.kind === 'lit') {
        const taken = cond.value !== 0n ? then : els;
        ctx.record('fold-if', cur, taken);
        return taken;
      }
      return cur;
    }
    case 'bin': {
      const left = fold(node.left, ctx);
      const right = fold(node.right, ctx);
      const cur: Node =
        left === node.left && right === node.right
          ? node
          : { kind: 'bin', id: node.id, op: node.op, left, right };
      if (left.kind === 'lit' && right.kind === 'lit') {
        if ((node.op === 'div' || node.op === 'mod') && right.value === 0n) {
          // Fold to an error literal: the error still fires at the same
          // evaluation position, preserving first-error and log ordering.
          const e: Node = {
            kind: 'err',
            id: ctx.ids.next(),
            error: node.op === 'div' ? 'div-by-zero' : 'mod-by-zero',
          };
          ctx.record('fold-error', cur, e);
          return e;
        }
        const v: Node = { kind: 'lit', id: ctx.ids.next(), value: applyOp(node.op, left.value, right.value) };
        ctx.record('fold-const', cur, v);
        return v;
      }
      // Identities that keep the remaining operand (and its effects) intact.
      const zeroOf = (n: Node) => n.kind === 'lit' && n.value === 0n;
      const oneOf = (n: Node) => n.kind === 'lit' && n.value === 1n;
      let kept: Node | null = null;
      if (node.op === 'add' && zeroOf(left)) kept = right;
      else if ((node.op === 'add' || node.op === 'sub') && zeroOf(right)) kept = left;
      else if (node.op === 'mul' && oneOf(left)) kept = right;
      else if ((node.op === 'mul' || node.op === 'div') && oneOf(right)) kept = left;
      if (kept) {
        ctx.record('identity', cur, kept);
        return kept;
      }
      return cur;
    }
  }
}

interface Occurrence { node: Node }

/**
 * Collect pure, always-executed candidate subexpressions in evaluation order.
 * A position is always-executed iff every ancestor evaluates it
 * unconditionally (not an if-branch) and no preceding sibling may raise an
 * integer error.
 */
function collect(node: Node, guaranteed: boolean, out: Map<string, Occurrence[]>): void {
  if (
    guaranteed &&
    size(node) >= 2 &&
    isPure(node) &&
    !containsBindOrRef(node) &&
    (node.kind === 'bin' || node.kind === 'if')
  ) {
    const key = render(node);
    const list = out.get(key);
    const occ = { node };
    if (list) list.push(occ);
    else out.set(key, [occ]);
  }
  switch (node.kind) {
    case 'bin':
      collect(node.left, guaranteed, out);
      collect(node.right, guaranteed && !mayError(node.left), out);
      return;
    case 'log':
    case 'bind':
      collect(node.expr, guaranteed, out);
      return;
    case 'if':
      collect(node.cond, guaranteed, out);
      collect(node.then, false, out);
      collect(node.else, false, out);
      return;
    default:
      return;
  }
}

/**
 * Common subexpression elimination. Only pure subexpressions occurring at
 * least twice in always-executed positions are shared: the first occurrence
 * (in evaluation order) becomes `bind`, the rest become `ref`. Evaluation
 * stays at the original first-occurrence point, so error and log ordering
 * are preserved.
 */
function cse(root: Node, ctx: Ctx): Node {
  for (let iter = 0; iter < 1000; iter++) {
    const candidates = new Map<string, Occurrence[]>();
    collect(root, true, candidates);
    let best: Occurrence[] | null = null;
    let bestSize = 0;
    for (const occs of candidates.values()) {
      if (occs.length < 2) continue;
      const s = size(occs[0].node);
      if (s > bestSize) { best = occs; bestSize = s; }
    }
    if (!best) return root;
    const name = `cse${ctx.cseCount++}`;
    const firstId = best[0].node.id;
    const restIds = new Set(best.slice(1).map((o) => o.node.id));
    root = share(root, firstId, restIds, name, ctx);
  }
  return root;
}

function share(node: Node, firstId: number, restIds: Set<number>, name: string, ctx: Ctx): Node {
  if (node.id === firstId) {
    const bound: Node = { kind: 'bind', id: ctx.ids.next(), name, expr: node };
    ctx.record('cse-bind', node, bound);
    return bound;
  }
  if (restIds.has(node.id)) {
    const ref: Node = { kind: 'ref', id: ctx.ids.next(), name };
    ctx.record('cse-ref', node, ref);
    return ref;
  }
  switch (node.kind) {
    case 'lit': case 'err': case 'var': case 'ref': return node;
    case 'log': case 'bind': {
      const expr = share(node.expr, firstId, restIds, name, ctx);
      return expr === node.expr ? node : { ...node, expr };
    }
    case 'bin': {
      const left = share(node.left, firstId, restIds, name, ctx);
      const right = share(node.right, firstId, restIds, name, ctx);
      return left === node.left && right === node.right ? node : { ...node, left, right };
    }
    case 'if': {
      const cond = share(node.cond, firstId, restIds, name, ctx);
      const then = share(node.then, firstId, restIds, name, ctx);
      const els = share(node.else, firstId, restIds, name, ctx);
      return cond === node.cond && then === node.then && els === node.else
        ? node
        : { ...node, cond, then, else: els };
    }
  }
}
