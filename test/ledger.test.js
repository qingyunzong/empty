import test from 'node:test';
import assert from 'node:assert/strict';
import {Ledger, comparePlans} from '../lib.js';

const stepPairs = (record) => record.steps.map((s) => [s.node, s.amount]);

test('child rule overrides parent rule', () => {
  // parent liable, store opts out -> terminal/store skipped, merchant bears
  const a = new Ledger();
  a.addNode({id: 'm1', balance: 1000, rule: {liable: true}});
  a.addNode({id: 's1', parent: 'm1', balance: 200, rule: {liable: false}});
  a.addNode({id: 't1', parent: 's1', balance: 50});
  const r1 = a.chargeback({id: 'cb1', node: 't1', amount: 30});
  assert.equal(r1.code, 'OK');
  assert.deepEqual(r1.steps, [
    {node: 'm1', amount: 30, balanceBefore: 1000, balanceAfter: 970},
  ]);
  assert.equal(a.balance('t1'), 50);
  assert.equal(a.balance('s1'), 200);

  // parent opts out, store opts in -> terminal/store bear, merchant untouched
  const b = new Ledger();
  b.addNode({id: 'm1', balance: 1000, rule: {liable: false}});
  b.addNode({id: 's1', parent: 'm1', balance: 200, rule: {liable: true}});
  b.addNode({id: 't1', parent: 's1', balance: 50});
  const r2 = b.chargeback({id: 'cb1', node: 't1', amount: 120});
  assert.equal(r2.code, 'OK');
  assert.deepEqual(stepPairs(r2), [['t1', 50], ['s1', 70]]);
  assert.equal(b.balance('m1'), 1000);

  // terminal-level rule overrides inherited store/merchant rule
  const c = new Ledger();
  c.addNode({id: 'm1', balance: 1000, rule: {liable: true}});
  c.addNode({id: 's1', parent: 'm1', balance: 200});
  c.addNode({id: 't1', parent: 's1', balance: 50, rule: {liable: false}});
  const r3 = c.chargeback({id: 'cb1', node: 't1', amount: 80});
  assert.equal(r3.code, 'OK');
  assert.deepEqual(stepPairs(r3), [['s1', 80]]);
  assert.equal(c.balance('t1'), 50);
});

test('insufficient balance splits across multiple levels', () => {
  const l = new Ledger();
  l.addNode({id: 'm1', balance: 1000});
  l.addNode({id: 's1', parent: 'm1', balance: 200});
  l.addNode({id: 't1', parent: 's1', balance: 50});

  const r1 = l.chargeback({id: 'cb1', node: 't1', amount: 1200});
  assert.equal(r1.code, 'OK');
  assert.deepEqual(stepPairs(r1), [['t1', 50], ['s1', 200], ['m1', 950]]);
  assert.equal(r1.covered, 1200);
  assert.equal(r1.uncovered, 0);

  // only 50 left on the whole chain -> partial cover with E_INSUFFICIENT
  const r2 = l.chargeback({id: 'cb2', node: 't1', amount: 100});
  assert.equal(r2.code, 'E_INSUFFICIENT');
  assert.equal(r2.covered, 50);
  assert.equal(r2.uncovered, 50);
  assert.deepEqual(stepPairs(r2), [['m1', 50]]);
  assert.deepEqual(l.balances(), {m1: 0, s1: 0, t1: 0});
});

test('reverse fails with E_RESTORE when an intermediate balance changed', () => {
  const l = new Ledger();
  l.addNode({id: 'm1', balance: 1000});
  l.addNode({id: 's1', parent: 'm1', balance: 200});
  l.addNode({id: 't1', parent: 's1', balance: 50});
  l.addNode({id: 't2', parent: 's1', balance: 80});

  const cb1 = l.chargeback({id: 'cb1', node: 't1', amount: 150});
  assert.deepEqual(stepPairs(cb1), [['t1', 50], ['s1', 100]]);
  const cb2 = l.chargeback({id: 'cb2', node: 't2', amount: 120});
  assert.deepEqual(stepPairs(cb2), [['t2', 80], ['s1', 40]]);
  assert.equal(l.balance('s1'), 60);

  // s1 balance moved since cb1 (60 != 100) -> restore fails, nothing changes
  const rv1 = l.reverse({id: 'rv1', chargeback: 'cb1'});
  assert.equal(rv1.code, 'E_RESTORE');
  assert.deepEqual(rv1.drift, [{node: 's1', expected: 100, actual: 60}]);
  assert.deepEqual(l.balances(), {m1: 1000, s1: 60, t1: 0, t2: 0});
  assert.equal(l.chargebackRecord('cb1').restored.code, 'E_RESTORE');

  // audit keeps the failed attempt
  const failed = l.audit.filter((e) => e.type === 'restore' && e.code === 'E_RESTORE');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].chargeback, 'cb1');

  // reverse cb2 first (reverse path order: s1 then t2), then cb1 succeeds
  const rv2 = l.reverse({id: 'rv2', chargeback: 'cb2'});
  assert.equal(rv2.code, 'OK');
  assert.deepEqual(stepPairs(rv2), [['s1', 40], ['t2', 80]]);
  const rv3 = l.reverse({id: 'rv3', chargeback: 'cb1'});
  assert.equal(rv3.code, 'OK');
  assert.deepEqual(stepPairs(rv3), [['s1', 100], ['t1', 50]]);
  assert.deepEqual(l.balances(), {m1: 1000, s1: 200, t1: 50, t2: 80});

  // double reverse is rejected
  const rv4 = l.reverse({id: 'rv4', chargeback: 'cb1'});
  assert.equal(rv4.code, 'E_STATE');
});

test('comparePlans: covered desc, then shallow depth, then node id', () => {
  const plans = [
    {start: 'b', depth: 1, covered: 10},
    {start: 'a', depth: 1, covered: 10},
    {start: 'c', depth: 0, covered: 10},
    {start: 'd', depth: 0, covered: 5},
  ];
  const sorted = [...plans].sort(comparePlans);
  assert.deepEqual(sorted.map((p) => p.start), ['c', 'a', 'b', 'd']);
});

test('small graph: enumerate all paths and cross-check against brute force', () => {
  // reference topology: s2 opts out, t3 overrides back in
  const ref = {
    m1: {parent: null, balance: 500, rule: null},
    s1: {parent: 'm1', balance: 100, rule: null},
    t1: {parent: 's1', balance: 10, rule: null},
    t2: {parent: 's1', balance: 20, rule: null},
    s2: {parent: 'm1', balance: 0, rule: false},
    t3: {parent: 's2', balance: 30, rule: true},
  };
  const effectiveLiable = (id) => {
    let cur = id;
    for (;;) {
      if (ref[cur].rule !== null) return ref[cur].rule;
      if (ref[cur].parent === null) return true;
      cur = ref[cur].parent;
    }
  };
  const depthOf = (id) => {
    let d = 0;
    let cur = id;
    while (ref[cur].parent !== null) {
      d += 1;
      cur = ref[cur].parent;
    }
    return d;
  };
  const brutePlan = (start, amount) => {
    let remaining = amount;
    const steps = [];
    let cur = start;
    while (cur !== null && remaining > 0) {
      if (effectiveLiable(cur)) {
        const take = Math.min(ref[cur].balance, remaining);
        if (take > 0) steps.push([cur, take]);
        remaining -= take;
      }
      cur = ref[cur].parent;
    }
    return {covered: amount - remaining, steps};
  };
  const bruteBest = (amount) =>
    Object.keys(ref)
      .map((s) => ({start: s, ...brutePlan(s, amount)}))
      .sort(
        (x, y) =>
          y.covered - x.covered ||
          depthOf(x.start) - depthOf(y.start) ||
          (x.start < y.start ? -1 : 1),
      )[0];

  const build = () => {
    const l = new Ledger();
    l.addNode({id: 'm1', balance: 500});
    l.addNode({id: 's1', parent: 'm1', balance: 100});
    l.addNode({id: 't1', parent: 's1', balance: 10});
    l.addNode({id: 't2', parent: 's1', balance: 20});
    l.addNode({id: 's2', parent: 'm1', balance: 0, rule: {liable: false}});
    l.addNode({id: 't3', parent: 's2', balance: 30, rule: {liable: true}});
    return l;
  };

  for (const amount of [1, 10, 15, 25, 40, 100, 610, 660, 1000]) {
    const l = build();
    const plans = l.enumeratePlans(amount);

    // enumeration covers every node and comes out sorted by the tie-break rule
    assert.deepEqual(
      plans.map((p) => p.start).sort(),
      Object.keys(ref).sort(),
    );
    assert.deepEqual(plans, [...plans].sort(comparePlans));

    // every enumerated path matches the brute-force reference
    for (const p of plans) {
      const bp = brutePlan(p.start, amount);
      assert.equal(p.covered, bp.covered, `covered ${p.start}@${amount}`);
      assert.deepEqual(
        p.steps.map((s) => [s.node, s.amount]),
        bp.steps,
        `steps ${p.start}@${amount}`,
      );
      assert.equal(p.depth, depthOf(p.start));
    }

    // route and candidate chargeback both pick the brute-force best path
    const best = bruteBest(amount);
    const route = l.route({id: `rt-${amount}`, amount});
    assert.equal(route.chosen.start, best.start, `route @${amount}`);
    assert.equal(route.chosen.covered, best.covered);
    const cb = l.chargeback({id: `cb-${amount}`, candidates: Object.keys(ref), amount});
    assert.equal(cb.start, best.start, `chargeback @${amount}`);
  }
});
