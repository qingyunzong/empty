import type {
  CorrCtx,
  LogicalTree,
  PhysicalPlan,
  Predicate,
  Scalar,
} from './types.ts';

/**
 * Stable fingerprints.
 *
 * A fingerprint is the canonical, deterministic string rendering of a plan or
 * expression. Equal structures always produce identical fingerprints, and the
 * rendering is order-stable so it can be used as a total-order tie breaker for
 * equal-cost plans. A compact 32-bit FNV-1a hash of the canonical string is
 * also exposed for callers that prefer an integer identity.
 */

function scalarCanon(s: Scalar): string {
  switch (s.kind) {
    case 'col':
      return `col:${s.name}`;
    case 'lit':
      return `lit:${JSON.stringify(s.value)}`;
    case 'param':
      return `param:${s.name}`;
    case 'fn':
      return `fn:${s.fn}(${s.args.map(scalarCanon).join(',')})`;
  }
}

function predicateCanon(p: Predicate): string {
  if (p.kind === 'and') {
    const parts = p.preds.map(predicateCanon).sort();
    return `and(${parts.join('&')})`;
  }
  const left = scalarCanon(p.left);
  const right = scalarCanon(p.right);
  // Equality is symmetric: normalize operand order so equivalent predicates
  // share a fingerprint regardless of textual orientation.
  const [a, b] = p.op === 'eq' ? [left, right].sort() : [left, right];
  return `cmp:${p.op}(${a},${b})`;
}

export function predicatesCanon(preds: Predicate[]): string {
  return preds.map(predicateCanon).sort().join('&');
}

export function ctxCanon(ctx: CorrCtx): string {
  return `ctx(${ctx.pathId};[${[...ctx.params].sort().join(',')}])`;
}

export function logicalFingerprint(tree: LogicalTree): string {
  const op = tree.op;
  let head: string;
  switch (op.kind) {
    case 'Get':
      head = `Get(${op.relation})`;
      break;
    case 'Select':
      head = `Select(${predicatesCanon(op.predicates)})`;
      break;
    case 'InnerJoin':
      head = `InnerJoin(${predicatesCanon(op.predicates)})`;
      break;
    case 'Aggregate': {
      const aggs = op.aggs
        .map((a) => `${a.fn}(${a.input}) AS ${a.alias}`)
        .sort()
        .join(',');
      head = `Aggregate([${[...op.groupCols].sort().join(',')}],[${aggs}])`;
      break;
    }
    case 'Apply':
      head = `Apply([${[...op.params].sort().join(',')}])`;
      break;
  }
  const kids = tree.children.map(logicalFingerprint).join(';');
  return `${head}{${kids}}@${ctxCanon(tree.ctx)}`;
}

export function planFingerprint(plan: PhysicalPlan): string {
  const parts: string[] = [plan.op];
  if (plan.relation !== undefined) parts.push(`rel=${plan.relation}`);
  if (plan.predicates !== undefined) parts.push(`pred=${predicatesCanon(plan.predicates)}`);
  if (plan.groupCols !== undefined) parts.push(`grp=[${plan.groupCols.join(',')}]`);
  if (plan.indexCols !== undefined) parts.push(`idx=[${plan.indexCols.join(',')}]`);
  if (plan.params !== undefined) parts.push(`params=[${[...plan.params].sort().join(',')}]`);
  if (plan.order !== undefined && plan.order !== null) parts.push(`ord=[${plan.order.join(',')}]`);
  if (plan.distribution !== undefined) parts.push(`dist=${plan.distribution}`);
  const kids = plan.children.map(planFingerprint).join(';');
  return `${parts.join('|')}{${kids}}@${ctxCanon(plan.ctx)}`;
}

/** 32-bit FNV-1a hash of a canonical fingerprint; deterministic across runs. */
export function fnv1aHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function planHash(plan: PhysicalPlan): number {
  return fnv1aHash(planFingerprint(plan));
}

/**
 * Total-order tie breaker for equal-cost plans: lexicographic comparison of
 * canonical fingerprints. The result is stable across processes and insertion
 * order.
 */
export function fingerprintLess(a: PhysicalPlan, b: PhysicalPlan): boolean {
  return planFingerprint(a) < planFingerprint(b);
}
