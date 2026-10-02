import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjudicate, lex, parse, compile, run, ParseError } from '../src/index.js';

// ---------- Acceptance 1: three-node causal chain yields a unique order ----------
test('three-node causal chain produces one unique causal order', () => {
  const source = [
    'note: chain a -> b -> c across three observer nodes',
    'evt node=c clock=3 seq=1 op=commit key=gamma value=3',
    'evt node=a clock=1 seq=1 op=commit key=alpha value=1',
    'evt node=b clock=2 seq=1 op=commit key=beta value=2',
  ].join('\n');

  const first = adjudicate(source);
  assert.deepEqual(first.order, ['a#1@1', 'b#1@2', 'c#1@3']);
  assert.deepEqual(first.state, { alpha: '1', beta: '2', gamma: '3' });
  assert.equal(first.conflict, null);
  assert.equal(first.applied, 3);

  // causal edges explain the chain (transitively reduced)
  assert.deepEqual(
    first.edges.map((e) => `${e.from}->${e.to}`),
    ['a#1@1->b#1@2', 'b#1@2->c#1@3'],
  );

  // every input permutation yields the identical unique order
  const lines = source.split('\n').filter((l) => l.startsWith('evt'));
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const p of perms) {
    const reshuffled = p.map((i) => lines[i]).join('\n');
    assert.deepEqual(adjudicate(reshuffled).order, first.order);
  }
});

// ---------- Acceptance 2: concurrent same-key different-value writes conflict ----------
test('concurrent commits on one key with different values raise a conflict certificate', () => {
  const source = [
    'evt node=a clock=1 seq=1 op=commit key=prefix value=kept',
    'evt node=b clock=2 seq=1 op=commit key=temp value=20',
    'evt node=c clock=2 seq=1 op=commit key=temp value=99',
    'note: b and c are concurrent (equal clocks, different nodes)',
  ].join('\n');

  const result = adjudicate(source);

  // conflict certificate
  assert.ok(result.conflict, 'expected a conflict certificate');
  assert.equal(result.conflict.kind, 'conflict');
  assert.equal(result.conflict.key, 'temp');
  assert.equal(result.conflict.clock, 2);
  assert.deepEqual(
    result.conflict.events.map((e) => `${e.node}:${e.value}`).sort(),
    ['b:20', 'c:99'],
  );

  // committed prefix preserved
  assert.equal(result.state.prefix, 'kept');
  assert.equal(result.applied, 1);

  // conflicting events never entered the state — no arbitrary winner
  assert.equal('temp' in result.state, false);
});

// ---------- Acceptance 3: enumerate all topological orders, deterministic tie-break ----------
function allTopoOrders(events, edges) {
  const preds = new Map(events.map((e) => [e.id, new Set()]));
  for (const { from, to } of edges) preds.get(to).add(from);
  const out = [];
  const walk = (acc, remaining) => {
    if (remaining.length === 0) { out.push(acc); return; }
    for (const e of remaining) {
      const blocked = [...preds.get(e.id)].some((p) => remaining.some((r) => r.id === p));
      if (blocked) continue;
      walk([...acc, e.id], remaining.filter((r) => r !== e));
    }
  };
  walk([], events);
  return out;
}

test('three concurrent events: all topological orders enumerated, tie-break is deterministic', () => {
  const source = [
    'evt node=c clock=5 seq=1 op=commit key=zulu value=z',
    'evt node=a clock=5 seq=1 op=commit key=alpha value=a',
    'evt node=b clock=5 seq=1 op=commit key=mike value=m',
  ].join('\n');
  const { events } = parse(lex(source));
  const { edges } = compile(events);

  // no causal edges among concurrent events -> all 3! = 6 orders are valid
  const topo = allTopoOrders(events, edges);
  assert.equal(edges.length, 0);
  assert.equal(topo.length, 6);

  // library order is deterministic and one of the valid topological orders
  const expected = ['a#1@5', 'b#1@5', 'c#1@5']; // key lexicographic: alpha < mike < zulu
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(adjudicate(source).order, expected);
  }
  assert.ok(topo.some((order) => order.join() === expected.join()));

  // final state is order-independent and complete
  assert.deepEqual(adjudicate(source).state, { alpha: 'a', mike: 'm', zulu: 'z' });
});

test('missing clock is rejected', () => {
  assert.throws(
    () => adjudicate('evt node=a seq=1 op=commit key=k value=v'),
    (err) => err instanceof ParseError && /missing clock/.test(err.message),
  );
});

test('duplicate timestamp (node, clock) is rejected', () => {
  const source = [
    'evt node=a clock=1 seq=1 op=commit key=k value=1',
    'evt node=a clock=1 seq=2 op=commit key=k value=2',
  ].join('\n');
  assert.throws(
    () => adjudicate(source),
    (err) => err instanceof ParseError && /duplicate event/.test(err.message),
  );
});

test('duplicate node sequence number is rejected', () => {
  const source = [
    'evt node=a clock=1 seq=1 op=commit key=k value=1',
    'evt node=a clock=2 seq=1 op=commit key=k value=2',
  ].join('\n');
  assert.throws(
    () => adjudicate(source),
    (err) => err instanceof ParseError && /duplicate event/.test(err.message),
  );
});

// ---------- Supporting behavior: mask / rollback / notes / bytecode replay ----------
test('mask hides a key and rollback restores the previous commit', () => {
  const source = [
    'evt node=a clock=1 seq=1 op=commit key=k value=v1',
    'evt node=a clock=2 seq=2 op=commit key=k value=v2',
    'evt node=a clock=3 seq=3 op=mask key=k',
    'evt node=b clock=4 seq=1 op=commit key=other value=x',
    'evt node=a clock=5 seq=4 op=rollback key=k',
  ].join('\n');
  const { events } = parse(lex(source));
  const { bytecode } = compile(events);
  assert.deepEqual(bytecode.map((b) => b.op), ['COMMIT', 'COMMIT', 'MASK', 'COMMIT', 'ROLLBACK']);
  const { state } = run(bytecode);
  // rollback pops v2; k stays masked, so only "other" is visible
  assert.deepEqual(state, { other: 'x' });
});

test('note: lines are lexed as free text and never executed', () => {
  const source = 'note: evt node=x clock=9 seq=9 op=commit key=evil value=1\nevt node=a clock=1 seq=1 op=commit key=k value=v';
  const result = adjudicate(source);
  assert.equal(result.notes.length, 1);
  assert.equal(result.eventCount, 1);
  assert.deepEqual(result.state, { k: 'v' });
});

test('same-value concurrent commits are benign (no conflict)', () => {
  const source = [
    'evt node=a clock=1 seq=1 op=commit key=k value=same',
    'evt node=b clock=1 seq=1 op=commit key=k value=same',
  ].join('\n');
  const result = adjudicate(source);
  assert.equal(result.conflict, null);
  assert.deepEqual(result.state, { k: 'same' });
});
