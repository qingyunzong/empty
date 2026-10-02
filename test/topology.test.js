'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEffective } = require('../src/sync');

let counter = 0;
function ev(kind, causes, amount) {
  counter += 1;
  const e = { id: `e${counter}`, kind, causes, lamport: counter, node: 'T' };
  if (kind === 'post') e.amount = amount;
  return e;
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function* legalTopoOrders(events) {
  const ids = events.map((e) => e.id);
  for (const perm of permutations(ids)) {
    const pos = new Map(perm.map((id, i) => [id, i]));
    let ok = true;
    for (const e of events) {
      for (const c of e.causes) {
        if (pos.get(c) > pos.get(e.id)) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (ok) yield perm.map((id) => events[pos.get(id)]);
  }
}

function keyOf(effective) {
  return effective.map((e) => `${e.id}=${e.amount}`).join(',');
}

function runScenario(name, events, expectedKey) {
  assert.ok(events.length <= 10);
  const orders = [...legalTopoOrders(events)];
  assert.ok(orders.length > 0, `${name}: no legal topo order`);
  const keys = new Set(orders.map((o) => keyOf(computeEffective(o))));
  assert.deepEqual([...keys], [expectedKey], `${name}: effective set diverged across ${orders.length} orders`);
  return orders.length;
}

test('3) n<=10: enumerate all legal topological orders, effective set is invariant', () => {
  counter = 0;
  let total = 0;

  // post -> void -> revive chain
  const p1 = ev('post', [], 100);
  const v1 = ev('void', [p1.id]);
  const r1 = ev('revive', [v1.id]);
  total += runScenario('post-void-revive', [p1, v1, r1], `${p1.id}=100`);

  // post -> void (stays voided), plus independent post
  const p2 = ev('post', [], 50);
  const v2 = ev('void', [p2.id]);
  const p3 = ev('post', [], 7);
  total += runScenario('voided-plus-independent', [p2, v2, p3], `${p3.id}=7`);

  // diamond: p -> v, p -> x(void of unrelated? no) -- use p, then two voids of p, revive after both
  const p4 = ev('post', [], 200);
  const v4a = ev('void', [p4.id]);
  const v4b = ev('void', [p4.id]);
  const r4 = ev('revive', [v4a.id, v4b.id]);
  total += runScenario('double-void-revive', [p4, v4a, v4b, r4], `${p4.id}=200`);

  // void of a voided post is a no-op; revive of active post is a no-op
  const p5 = ev('post', [], 30);
  const v5 = ev('void', [p5.id]);
  const v5b = ev('void', [p5.id, v5.id]);
  const r5 = ev('revive', [v5b.id]);
  const r5b = ev('revive', [r5.id]);
  total += runScenario('noop-edges', [p5, v5, v5b, r5, r5b], `${p5.id}=30`);

  // larger chain, n=8
  const chain = [ev('post', [], 1)];
  for (let i = 0; i < 7; i++) {
    chain.push(ev(i % 2 === 0 ? 'void' : 'revive', [chain[chain.length - 1].id]));
  }
  // post,void,revive,void,revive,void,revive,void -> final voided
  total += runScenario('chain-of-8', chain, '');

  // wide: one post+void pair plus 3 independent posts -> 5!/2 = 60 orders
  const w1 = ev('post', [], 11);
  const w1v = ev('void', [w1.id]);
  const w2 = ev('post', [], 22);
  const w3 = ev('post', [], 33);
  const w4 = ev('post', [], 44);
  total += runScenario('wide-5', [w1, w1v, w2, w3, w4], `${w2.id}=22,${w3.id}=33,${w4.id}=44`);

  // two independent post->void->revive chains -> C(6,3) = 20 interleavings
  const c1p = ev('post', [], 5);
  const c1v = ev('void', [c1p.id]);
  const c1r = ev('revive', [c1v.id]);
  const c2p = ev('post', [], 6);
  const c2v = ev('void', [c2p.id]);
  const c2r = ev('revive', [c2v.id]);
  total += runScenario('two-chains', [c1p, c1v, c1r, c2p, c2v, c2r], `${c1p.id}=5,${c2p.id}=6`);

  // 5 mutually concurrent posts -> 120 orders
  const ind = [ev('post', [], 1), ev('post', [], 2), ev('post', [], 3), ev('post', [], 4), ev('post', [], 5)];
  total += runScenario(
    'independent-5',
    ind,
    ind.map((e) => `${e.id}=${e.amount}`).join(',')
  );

  assert.ok(total > 200, `expected many enumerated orders, got ${total}`);
});
