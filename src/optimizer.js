import { mkNode, schemaOf, collectRefs, exprToString } from './plan.js';

function splitAnd(expr) {
  return expr.kind === 'and' ? expr.args.flatMap(splitAnd) : [expr];
}

function makeAnd(exprs) {
  return exprs.length === 1 ? exprs[0] : { kind: 'and', args: exprs };
}

const subset = (refs, allowed) => [...refs].every((r) => allowed.has(r));

// Rule 1: predicate pushdown. Only top-level AND conjuncts are moved, never
// anything under OR/NOT, so three-valued semantics are preserved exactly.
function pushdown(node, rules) {
  switch (node.type) {
    case 'select': node = { ...node, input: pushdown(node.input, rules) }; break;
    case 'join':
      node = { ...node, left: pushdown(node.left, rules), right: pushdown(node.right, rules) };
      break;
    case 'groupby': node = { ...node, input: pushdown(node.input, rules) }; break;
    case 'project': node = { ...node, input: pushdown(node.input, rules) }; break;
    default: return node;
  }
  if (node.type === 'groupby' && node.having) {
    // HAVING conjuncts that reference only GROUP BY keys can be evaluated before
    // aggregation: every row in a group shares the same key values, so filtering
    // whole groups early is equivalent and preserves NULL/duplicate semantics.
    const keySet = new Set(node.keys);
    const conjuncts = splitAnd(node.having);
    const push = [], rest = [];
    for (const c of conjuncts) {
      const refs = collectRefs(c);
      if (refs.size && subset(refs, keySet)) push.push(c);
      else rest.push(c);
    }
    if (push.length) {
      rules.push({
        rule: 'predicate_pushdown',
        detail: {
          predicate: exprToString(makeAnd(push)), target: 'groupby.input',
          refs: [...new Set(push.flatMap((c) => [...collectRefs(c)]))],
          targetSchema: [...keySet],
        },
      });
      const newInput = mkNode('select', { input: node.input, predicate: makeAnd(push) });
      return { ...node, input: newInput, having: rest.length ? makeAnd(rest) : null };
    }
    return node;
  }
  if (node.type !== 'select') return node;
  const conjuncts = splitAnd(node.predicate);
  const input = node.input;

  if (input.type === 'join') {
    const leftRefs = new Set(schemaOf(input.left).map((s) => s.ref));
    const rightRefs = new Set(schemaOf(input.right).map((s) => s.ref));
    const toLeft = [], toRight = [], rest = [];
    for (const c of conjuncts) {
      const refs = collectRefs(c);
      if (refs.size && subset(refs, leftRefs)) toLeft.push(c);
      else if (refs.size && subset(refs, rightRefs)) toRight.push(c);
      else rest.push(c);
    }
    let newLeft = input.left, newRight = input.right;
    if (toLeft.length) {
      newLeft = mkNode('select', { input: input.left, predicate: makeAnd(toLeft) });
      rules.push({
        rule: 'predicate_pushdown',
        detail: {
          predicate: exprToString(makeAnd(toLeft)), target: 'join.left',
          refs: [...new Set(toLeft.flatMap((c) => [...collectRefs(c)]))],
          targetSchema: [...leftRefs],
        },
      });
    }
    if (toRight.length) {
      newRight = mkNode('select', { input: input.right, predicate: makeAnd(toRight) });
      rules.push({
        rule: 'predicate_pushdown',
        detail: {
          predicate: exprToString(makeAnd(toRight)), target: 'join.right',
          refs: [...new Set(toRight.flatMap((c) => [...collectRefs(c)]))],
          targetSchema: [...rightRefs],
        },
      });
    }
    const newInput = (toLeft.length || toRight.length) ? { ...input, left: newLeft, right: newRight } : input;
    return rest.length ? { ...node, input: newInput, predicate: makeAnd(rest) } : newInput;
  }

  if (input.type === 'groupby') {
    const keySet = new Set(input.keys);
    const push = [], rest = [];
    for (const c of conjuncts) {
      const refs = collectRefs(c);
      if (refs.size && subset(refs, keySet)) push.push(c);
      else rest.push(c);
    }
    let newInput = input;
    if (push.length) {
      newInput = { ...input, input: mkNode('select', { input: input.input, predicate: makeAnd(push) }) };
      rules.push({
        rule: 'predicate_pushdown',
        detail: {
          predicate: exprToString(makeAnd(push)), target: 'groupby.input',
          refs: [...new Set(push.flatMap((c) => [...collectRefs(c)]))],
          targetSchema: [...keySet],
        },
      });
    }
    return rest.length ? { ...node, input: newInput, predicate: makeAnd(rest) } : newInput;
  }

  return node;
}

// Rule 2: projection pruning. Only columns provably unreferenced downstream are
// dropped; join keys, predicate columns, group keys and aggregate args are kept.
// Rows are never deduplicated, so duplicate semantics are preserved.
function prune(node, needed, rules) {
  switch (node.type) {
    case 'project': {
      const reqs = new Set(node.items.map((it) => it.ref));
      return { ...node, input: prune(node.input, reqs, rules) };
    }
    case 'select': {
      const reqs = needed === null ? null : new Set([...needed, ...collectRefs(node.predicate)]);
      return { ...node, input: prune(node.input, reqs, rules) };
    }
    case 'join': {
      if (needed === null) {
        return { ...node, left: prune(node.left, null, rules), right: prune(node.right, null, rules) };
      }
      const reqs = new Set([...needed, ...node.leftKeys, ...node.rightKeys]);
      const leftSchema = new Set(schemaOf(node.left).map((s) => s.ref));
      const rightSchema = new Set(schemaOf(node.right).map((s) => s.ref));
      const leftNeeded = new Set([...reqs].filter((r) => leftSchema.has(r)));
      const rightNeeded = new Set([...reqs].filter((r) => rightSchema.has(r)));
      return { ...node, left: prune(node.left, leftNeeded, rules), right: prune(node.right, rightNeeded, rules) };
    }
    case 'groupby': {
      const reqs = new Set([...node.keys, ...node.aggs.filter((a) => a.arg !== '*').map((a) => a.arg)]);
      return { ...node, input: prune(node.input, reqs, rules) };
    }
    case 'scan': {
      if (needed === null) return node;
      const kept = node.columns.filter((c) => needed.has(`${node.alias}.${c}`));
      const pruned = node.columns.filter((c) => !needed.has(`${node.alias}.${c}`));
      if (pruned.length) {
        rules.push({
          rule: 'projection_pruning',
          detail: {
            table: node.alias,
            pruned: pruned.map((c) => `${node.alias}.${c}`),
            retained: kept.map((c) => `${node.alias}.${c}`),
          },
        });
      }
      return { ...node, columns: kept };
    }
    default:
      return node;
  }
}

// Rule 3: aggregate pushdown as two-phase aggregation (partial -> final).
// Valid only for decomposable aggregates; NULL handling (ignore NULLs, NULL
// result when no non-NULL input) and duplicate semantics are preserved by
// carrying per-group non-null counts in the partial state.
const DECOMPOSABLE = new Set(['count', 'sum', 'min', 'max', 'avg']);
function aggPushdown(node, rules) {
  switch (node.type) {
    case 'select': node = { ...node, input: aggPushdown(node.input, rules) }; break;
    case 'join':
      node = { ...node, left: aggPushdown(node.left, rules), right: aggPushdown(node.right, rules) };
      break;
    case 'project': node = { ...node, input: aggPushdown(node.input, rules) }; break;
    case 'groupby': node = { ...node, input: aggPushdown(node.input, rules) }; break;
    default: return node;
  }
  if (node.type !== 'groupby') return node;
  if (!node.aggs.every((a) => DECOMPOSABLE.has(a.func))) return node;
  rules.push({
    rule: 'aggregate_pushdown',
    detail: { aggregates: node.aggs.map((a) => a.func), mode: 'partial-final' },
  });
  const partial = mkNode('aggpartial', { input: node.input, keys: node.keys, keyCols: node.keyCols, aggs: node.aggs });
  return mkNode('aggfinal', { input: partial, keys: node.keys, keyCols: node.keyCols, aggs: node.aggs, having: node.having });
}

export function optimize(logical) {
  const rules = [];
  let plan = pushdown(logical, rules);
  plan = prune(plan, null, rules);
  plan = aggPushdown(plan, rules);
  return { plan, rules };
}
