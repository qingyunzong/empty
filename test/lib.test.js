'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger, LedgerError, processJsonl } = require('../lib');

function buildLedger(spec) {
  const ledger = new Ledger();
  for (const node of spec) ledger.addNode(node);
  return ledger;
}

test('acceptance 1: child rule overrides inherited parent rule', () => {
  const ledger = buildLedger([
    { id: 'm1', parent: null, balance: 1000, rule: 'self' },
    { id: 's1', parent: 'm1', balance: 500, rule: 'parent' },
    { id: 't1', parent: 's1', balance: 100 },
    { id: 't2', parent: 's1', balance: 100, rule: 'self' },
  ]);

  // t1 inherits s1's "parent" rule: t1 and s1 are skipped, m1 bears.
  const r1 = ledger.chargeback({ id: 'cb1', node: 't1', amount: 50 });
  assert.equal(r1.ok, true);
  assert.deepEqual(
    r1.steps.map((s) => [s.node, s.amount]),
    [['m1', 50]],
  );
  assert.equal(ledger.getNode('m1').balance, 950);
  assert.equal(ledger.getNode('s1').balance, 500);
  assert.equal(ledger.getNode('t1').balance, 100);

  // t2 overrides with "self": t2 bears first despite s1's "parent" rule.
  const r2 = ledger.chargeback({ id: 'cb2', node: 't2', amount: 60 });
  assert.deepEqual(
    r2.steps.map((s) => [s.node, s.amount]),
    [['t2', 60]],
  );
  assert.equal(ledger.getNode('t2').balance, 40);
});

test('acceptance 2: insufficient balance splits across multiple levels', () => {
  const ledger = buildLedger([
    { id: 'm1', parent: null, balance: 100, rule: 'self' },
    { id: 's1', parent: 'm1', balance: 40, rule: 'self' },
    { id: 't1', parent: 's1', balance: 30, rule: 'self' },
  ]);

  const r1 = ledger.chargeback({ id: 'cb1', node: 't1', amount: 90 });
  assert.equal(r1.ok, true);
  assert.equal(r1.status, 'settled');
  assert.equal(r1.code, null);
  assert.deepEqual(
    r1.steps.map((s) => [s.node, s.amount, s.balanceAfter]),
    [['t1', 30, 0], ['s1', 40, 0], ['m1', 20, 80]],
  );

  // Whole chain cannot cover: partial bear plus E_INSUFFICIENT.
  const r2 = ledger.chargeback({ id: 'cb2', node: 't1', amount: 200 });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 'partial');
  assert.equal(r2.code, 'E_INSUFFICIENT');
  assert.equal(r2.covered, 80);
  assert.equal(r2.uncovered, 120);
  assert.deepEqual(
    r2.steps.map((s) => [s.node, s.amount]),
    [['m1', 80]],
  );
  assert.equal(ledger.getNode('m1').balance, 0);
});

test('acceptance 3: restore fails with E_RESTORE when a mid-level balance changed', () => {
  const ledger = buildLedger([
    { id: 'm1', parent: null, balance: 100, rule: 'self' },
    { id: 's1', parent: 'm1', balance: 40, rule: 'self' },
    { id: 't1', parent: 's1', balance: 30, rule: 'self' },
  ]);
  const cb = ledger.chargeback({ id: 'cb1', node: 't1', amount: 90 });
  assert.deepEqual(
    cb.steps.map((s) => [s.node, s.amount]),
    [['t1', 30], ['s1', 40], ['m1', 20]],
  );

  // Mid-level balance changes after the chargeback.
  ledger.adjust({ node: 's1', delta: 15 });

  const failed = ledger.reverse({ chargeback: 'cb1' });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'E_RESTORE');
  assert.equal(failed.failedNode, 's1');
  assert.equal(failed.expected, 0);
  assert.equal(failed.actual, 15);

  // Balances stay untouched and the audit trail is preserved.
  assert.equal(ledger.getNode('t1').balance, 0);
  assert.equal(ledger.getNode('s1').balance, 15);
  assert.equal(ledger.getNode('m1').balance, 80);
  const record = ledger.chargebacks.get('cb1');
  assert.equal(record.status, 'settled');
  assert.deepEqual(record.audit.map((a) => a.event), ['chargeback', 'restore_failed']);
  assert.equal(record.audit[1].code, 'E_RESTORE');

  // Undo the external change, then restore succeeds in reverse path order.
  ledger.adjust({ node: 's1', delta: -15 });
  const ok = ledger.reverse({ chargeback: 'cb1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.code, null);
  assert.deepEqual(
    ok.restored.map((s) => [s.node, s.amount, s.balanceAfter]),
    [['m1', 20, 100], ['s1', 40, 40], ['t1', 30, 30]],
  );
  assert.equal(record.status, 'reversed');
  assert.deepEqual(record.audit.map((a) => a.event), ['chargeback', 'restore_failed', 'restored']);

  assert.throws(
    () => ledger.reverse({ chargeback: 'cb1' }),
    (e) => e.code === 'E_ALREADY_REVERSED',
  );
});

test('reverse restores a partial chargeback exactly along the original path', () => {
  const ledger = buildLedger([
    { id: 'm1', parent: null, balance: 10, rule: 'self' },
    { id: 's1', parent: 'm1', balance: 5, rule: 'self' },
  ]);
  const cb = ledger.chargeback({ id: 'cb1', node: 's1', amount: 50 });
  assert.equal(cb.code, 'E_INSUFFICIENT');
  const restored = ledger.reverse({ chargeback: 'cb1' });
  assert.equal(restored.ok, true);
  assert.deepEqual(
    restored.restored.map((s) => [s.node, s.amount]),
    [['m1', 10], ['s1', 5]],
  );
  assert.equal(ledger.getNode('m1').balance, 10);
  assert.equal(ledger.getNode('s1').balance, 5);
});

// Reference implementation used to cross-check the library on a small graph.
function referenceEnumerate(nodes, amount) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthOf = (id) => {
    let d = 0;
    let cur = byId.get(id);
    while (cur.parent !== null) {
      d += 1;
      cur = byId.get(cur.parent);
    }
    return d;
  };
  const effectiveRule = (id) => {
    let cur = byId.get(id);
    while (cur) {
      if (cur.rule != null) return cur.rule;
      cur = cur.parent === null ? null : byId.get(cur.parent);
    }
    return 'self';
  };
  const out = [];
  for (const n of nodes) {
    let remaining = amount;
    const steps = [];
    let cur = n;
    while (cur && remaining > 0) {
      if (effectiveRule(cur.id) === 'self') {
        const take = Math.min(cur.balance, remaining);
        if (take > 0) steps.push({ node: cur.id, amount: take });
        remaining -= take;
      }
      cur = cur.parent === null ? null : byId.get(cur.parent);
    }
    out.push({
      node: n.id,
      depth: depthOf(n.id),
      covered: amount - remaining,
      uncovered: remaining,
      steps,
    });
  }
  out.sort((a, b) =>
    b.covered - a.covered ||
    a.depth - b.depth ||
    (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  return out;
}

const SMALL_GRAPH = [
  { id: 'm1', parent: null, balance: 100, rule: 'self' },
  { id: 'm2', parent: null, balance: 0, rule: 'self' },
  { id: 's1', parent: 'm1', balance: 40, rule: 'parent' },
  { id: 's2', parent: 'm1', balance: 50 },
  { id: 's3', parent: 'm2', balance: 25, rule: 'self' },
  { id: 't1', parent: 's1', balance: 10 },
  { id: 't2', parent: 's1', balance: 20, rule: 'self' },
  { id: 't3', parent: 's2', balance: 0 },
  { id: 't4', parent: 's3', balance: 5, rule: 'parent' },
];

test('acceptance 4: enumerate matches brute-force reference on a small graph', () => {
  for (const amount of [1, 30, 75, 200]) {
    const ledger = buildLedger(SMALL_GRAPH);
    const actual = ledger.enumerate({ amount }).paths;
    const expected = referenceEnumerate(SMALL_GRAPH, amount);
    assert.deepEqual(actual, expected, `amount=${amount}`);
  }
});

test('acceptance 4: ties on equal covered amount break by depth, then node id', () => {
  const ledger = buildLedger([
    { id: 'r1', parent: null, balance: 10, rule: 'self' },
    { id: 'b2', parent: 'r1', balance: 10, rule: 'self' },
    { id: 'a1', parent: 'r1', balance: 10, rule: 'self' },
    { id: 'z9', parent: 'a1', balance: 10, rule: 'self' },
  ]);
  const { paths } = ledger.enumerate({ amount: 10 });
  // All four nodes fully cover 10; r1 (depth 0) first, then depth-1 nodes
  // in id order, then the deepest node.
  assert.deepEqual(paths.map((p) => p.node), ['r1', 'a1', 'b2', 'z9']);
  // Larger amount: nodes differ in covered, sorted by covered desc first.
  const ledger2 = buildLedger([
    { id: 'r1', parent: null, balance: 100, rule: 'self' },
    { id: 'a1', parent: 'r1', balance: 10, rule: 'self' },
  ]);
  const deep = ledger2.enumerate({ amount: 50 }).paths;
  assert.deepEqual(deep.map((p) => [p.node, p.covered]), [['r1', 50], ['a1', 50]]);
  const mixed = ledger2.enumerate({ amount: 150 }).paths;
  assert.deepEqual(mixed.map((p) => [p.node, p.covered]), [['a1', 110], ['r1', 100]]);
});

test('input validation raises coded LedgerError', () => {
  const ledger = new Ledger();
  assert.throws(() => ledger.addNode({ id: 'a', balance: -1 }), (e) => e.code === 'E_INVALID_AMOUNT');
  assert.throws(() => ledger.addNode({ id: 'a', rule: 'up' }), (e) => e.code === 'E_INVALID_RULE');
  ledger.addNode({ id: 'a', balance: 10 });
  assert.throws(() => ledger.addNode({ id: 'a' }), (e) => e.code === 'E_DUPLICATE_NODE');
  assert.throws(() => ledger.addNode({ id: 'b', parent: 'nope' }), (e) => e.code === 'E_UNKNOWN_NODE');
  assert.throws(() => ledger.chargeback({ id: 'c1', node: 'nope', amount: 1 }), (e) => e.code === 'E_UNKNOWN_NODE');
  assert.throws(() => ledger.chargeback({ id: 'c1', node: 'a', amount: 0 }), (e) => e.code === 'E_INVALID_AMOUNT');
  assert.throws(() => ledger.reverse({ chargeback: 'nope' }), (e) => e.code === 'E_UNKNOWN_CHARGEBACK');
  assert.throws(() => ledger.adjust({ node: 'a', delta: -11 }), (e) => e.code === 'E_BALANCE');
  assert.throws(() => ledger.apply({ op: 'bogus' }), (e) => e.code === 'E_UNKNOWN_OP');
});

test('processJsonl tags results with line numbers and skips blank lines', () => {
  const { results } = processJsonl([
    '{"op":"add_node","id":"m1","balance":100,"rule":"self"}',
    '',
    '{"op":"add_node","id":"t1","parent":"m1","balance":10,"rule":"self"}',
    '{"op":"chargeback","id":"cb1","node":"t1","amount":25}',
    '{"op":"reverse","chargeback":"cb1"}',
  ].join('\n'));
  assert.deepEqual(results.map((r) => r.line), [1, 3, 4, 5]);
  const cb = results[2];
  assert.deepEqual(cb.steps.map((s) => [s.node, s.amount]), [['t1', 10], ['m1', 15]]);
  assert.equal(results[3].ok, true);
});

test('processJsonl reports parse and semantic errors with line numbers', () => {
  assert.throws(
    () => processJsonl('{"op":"add_node","id":"a"}\nnot json'),
    (e) => e.code === 'E_PARSE' && e.message.includes('line 2'),
  );
  assert.throws(
    () => processJsonl('{"op":"add_node","id":"a"}\n{"op":"adjust","node":"b","delta":1}'),
    (e) => e.code === 'E_UNKNOWN_NODE' && e.message.includes('line 2'),
  );
});

test('LedgerError is an Error subclass', () => {
  const err = new LedgerError('E_X', 'msg');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'E_X');
});
