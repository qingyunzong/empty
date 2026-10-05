import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Node, IdGen, lit, bin, logN, ifN, vaR, render, collectIds,
} from '../src/ast';
import { interpret, Result } from '../src/interp';
import { optimize } from '../src/optimize';
import { mulberry32, genTree, genInput } from '../src/gen';

function ids(): IdGen { return new IdGen(1); }

function containsKind(node: Node, kind: Node['kind']): boolean {
  if (node.kind === kind) return true;
  switch (node.kind) {
    case 'log': case 'bind': return containsKind(node.expr, kind);
    case 'bin': return containsKind(node.left, kind) || containsKind(node.right, kind);
    case 'if':
      return containsKind(node.cond, kind) || containsKind(node.then, kind)
        || containsKind(node.else, kind);
    default: return false;
  }
}

test('constant folding keeps value, first error and log order', () => {
  const g = ids();
  // (add (log (mul 2 2)) (div 1 0)): logs 4, then div-by-zero.
  const tree = bin(g.next(), 'add',
    logN(g.next(), bin(g.next(), 'mul', lit(g.next(), 2n), lit(g.next(), 2n))),
    bin(g.next(), 'div', lit(g.next(), 1n), lit(g.next(), 0n)));
  const before = interpret(tree);
  const opt = optimize(tree);
  const after = interpret(opt.node);
  assert.deepStrictEqual(after, before);
  assert.deepStrictEqual(after, { ok: false, error: 'div-by-zero', log: [4n] });
  assert.ok(opt.rewrites.some((r) => r.rule === 'fold-const'));
  assert.ok(opt.rewrites.some((r) => r.rule === 'fold-error'));
  assert.ok(containsKind(opt.node, 'err'), 'folded error literal remains in place');
});

test('identity rewrites keep side effects of the kept operand', () => {
  const g = ids();
  // (mul 1 (log a)) -> (log a); effect must survive.
  const tree = bin(g.next(), 'mul', lit(g.next(), 1n), logN(g.next(), vaR(g.next(), 'a')));
  const input = { a: 7n };
  const opt = optimize(tree);
  assert.deepStrictEqual(interpret(opt.node, input), interpret(tree, input));
  assert.deepStrictEqual(interpret(opt.node, input), { ok: true, value: 7n, log: [7n] });
});

test('cse shares pure always-executed duplicates via bind/ref', () => {
  const g = ids();
  // (add (mul a 2) (mul a 2))
  const dup = () => bin(g.next(), 'mul', vaR(g.next(), 'a'), lit(g.next(), 2n));
  const tree = bin(g.next(), 'add', dup(), dup());
  const opt = optimize(tree);
  assert.ok(containsKind(opt.node, 'bind'));
  assert.ok(containsKind(opt.node, 'ref'));
  assert.ok(opt.rewrites.some((r) => r.rule === 'cse-bind'));
  assert.ok(opt.rewrites.some((r) => r.rule === 'cse-ref'));
  for (const a of [-3n, 0n, 5n]) {
    assert.deepStrictEqual(interpret(opt.node, { a }), interpret(tree, { a }));
  }
});

test('cse never shares conditional-branch, impure, or maybe-not-executed exprs', () => {
  // if-branches are not always executed.
  let g = ids();
  const branchy = ifN(g.next(), vaR(g.next(), 'a'),
    bin(g.next(), 'mul', vaR(g.next(), 'b'), lit(g.next(), 3n)),
    bin(g.next(), 'mul', vaR(g.next(), 'b'), lit(g.next(), 3n)));
  assert.ok(!containsKind(optimize(branchy).node, 'bind'));

  // log is a side effect: (add (log a) (log a)) must evaluate both logs.
  g = ids();
  const impure = bin(g.next(), 'add',
    logN(g.next(), vaR(g.next(), 'a')), logN(g.next(), vaR(g.next(), 'a')));
  const optImpure = optimize(impure);
  assert.ok(!containsKind(optImpure.node, 'bind'));
  assert.deepStrictEqual(interpret(optImpure.node, { a: 4n }), { ok: true, value: 8n, log: [4n, 4n] });

  // Right of a possible div-by-zero is not guaranteed to execute.
  g = ids();
  const afterError = bin(g.next(), 'add',
    bin(g.next(), 'div', lit(g.next(), 10n), vaR(g.next(), 'a')),
    bin(g.next(), 'add',
      bin(g.next(), 'mul', vaR(g.next(), 'b'), lit(g.next(), 3n)),
      bin(g.next(), 'mul', vaR(g.next(), 'b'), lit(g.next(), 3n))));
  assert.ok(!containsKind(optimize(afterError).node, 'bind'));
});

test('every rewrite records before/after source mapping', () => {
  const g = ids();
  const tree = bin(g.next(), 'add',
    bin(g.next(), 'add', lit(g.next(), 1n), lit(g.next(), 2n)),
    bin(g.next(), 'mul', vaR(g.next(), 'a'), lit(g.next(), 1n)));
  const opt = optimize(tree);
  assert.ok(opt.rewrites.length >= 2);
  const origIds = new Set(collectIds(tree));
  for (const r of opt.rewrites) {
    assert.ok(origIds.has(r.before.id), `before id ${r.before.id} from original tree`);
    assert.ok(r.before.src.length > 0 && r.after.src.length > 0);
    const mapped = opt.sourceMap.get(r.before.id);
    assert.ok(mapped && mapped.includes(r.after.id),
      `sourceMap ${r.before.id} -> ${r.after.id}`);
  }
});

test('differential: random small trees preserve value, first error, action log', () => {
  const N = 3000;
  const stats: Record<string, number> = {};
  let errorResults = 0;
  let loggedActions = 0;
  for (let seed = 1; seed <= N; seed++) {
    const rand = mulberry32(seed);
    const tree = genTree(rand, new IdGen(1), 4);
    const input = genInput(rand);
    const before: Result = interpret(tree, input);
    const opt = optimize(tree);
    const after: Result = interpret(opt.node, input);
    for (const r of opt.rewrites) stats[r.rule] = (stats[r.rule] ?? 0) + 1;
    if (!before.ok) errorResults++;
    if (before.log.length > 0) loggedActions++;
    assert.deepStrictEqual(
      after, before,
      `seed=${seed} input=${JSON.stringify(input, (_, v) => typeof v === 'bigint' ? v.toString() : v)}\n` +
      `before: ${render(tree)}\nafter:  ${render(opt.node)}`,
    );
  }
  assert.ok(errorResults > 0, 'corpus exercises integer errors');
  assert.ok(loggedActions > 0, 'corpus exercises action logs');
  assert.ok((stats['fold-const'] ?? 0) > 0, 'corpus exercises constant folding');
  assert.ok((stats['cse-bind'] ?? 0) > 0, 'corpus exercises CSE');
  console.log(`differential ok: ${N} trees, ${errorResults} with integer errors, ` +
    `${loggedActions} with action logs; rewrites by rule:`, stats);
});
