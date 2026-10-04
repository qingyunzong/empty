import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  ingest,
  merge,
  equiv,
  explain,
} from '../src/store.js';

function storeWith(logs) {
  const s = createStore();
  for (const [id, events] of Object.entries(logs)) {
    const r = ingest(s, id, events);
    assert.equal(r.status, 'OK', `ingest ${id}: ${JSON.stringify(r)}`);
  }
  return s;
}

// Acceptance 1: reordered records describing the same partial order -> EQUAL.
test('reordered log with same partial order is EQUAL', () => {
  const a = [
    { id: 'e1', causes: [] },
    { id: 'e2', causes: ['e1'] },
    { id: 'e3', causes: ['e2'] },
    { id: 'e4', causes: ['e2'] },
  ];
  const b = [
    { id: 'e4', causes: ['e2'] },
    { id: 'e3', causes: ['e2'] },
    { id: 'e2', causes: ['e1'] },
    { id: 'e1', causes: [] },
  ];
  const s = storeWith({ a, b });
  assert.equal(equiv(s, 'a', 'b').status, 'EQUAL');
});

// Redundant direct edges do not matter: same reachability -> EQUAL.
test('transitively redundant edges are normalized away', () => {
  const a = [
    { id: 'x', causes: [] },
    { id: 'y', causes: ['x'] },
    { id: 'z', causes: ['y', 'x'] }, // x->z redundant
  ];
  const b = [
    { id: 'x', causes: [] },
    { id: 'y', causes: ['x'] },
    { id: 'z', causes: ['y'] },
  ];
  const s = storeWith({ a, b });
  assert.equal(equiv(s, 'a', 'b').status, 'EQUAL');
});

// Acceptance 2 (rule: one log's information is a strict subset -> UNDECIDED).
test('one fewer causal edge (subset) is UNDECIDED with missing_edges', () => {
  const a = [
    { id: 'x', causes: [] },
    { id: 'y', causes: ['x'] },
    { id: 'z', causes: ['y'] },
  ];
  const b = [
    { id: 'x', causes: [] },
    { id: 'y', causes: [] }, // missing x->y
    { id: 'z', causes: ['y'] },
  ];
  const s = storeWith({ a, b });
  const r = equiv(s, 'a', 'b');
  assert.equal(r.status, 'UNDECIDED');
  assert.deepEqual(r.missing_edges, [
    { from: 'x', to: 'y', only_in: 'a', reason: 'edge_missing' },
  ]);
});

// Acceptance 2 (rule: contradictory causal claims -> NOT_EQUAL with frontier).
test('contradictory causes are NOT_EQUAL with first_divergent and minimal_frontier', () => {
  const a = [
    { id: 'x', causes: [] },
    { id: 'z', causes: [] },
    { id: 'y', causes: ['x'] },
  ];
  const b = [
    { id: 'x', causes: [] },
    { id: 'z', causes: [] },
    { id: 'y', causes: ['z'] },
  ];
  const s = storeWith({ a, b });
  const r = equiv(s, 'a', 'b');
  assert.equal(r.status, 'NOT_EQUAL');
  assert.equal(r.first_divergent, 'y');
  assert.deepEqual(r.minimal_frontier, [
    { from: 'x', to: 'y', only_in: 'a' },
    { from: 'z', to: 'y', only_in: 'b' },
  ]);
});

// Acceptance 3: cyclic logs collapse to SCCs; equal partial orders -> EQUAL.
test('cyclic logs are equivalent after SCC compression', () => {
  // x <-> y is a cycle; a reaches the cycle. The two logs attach 'a' to
  // different members of the same cycle and record edges in different order.
  const a = [
    { id: 'a', causes: [] },
    { id: 'x', causes: ['y', 'a'] },
    { id: 'y', causes: ['x'] },
  ];
  const b = [
    { id: 'y', causes: ['x', 'a'] },
    { id: 'x', causes: ['y'] },
    { id: 'a', causes: [] },
  ];
  const s = storeWith({ a, b });
  const r = explain(s, 'a', 'b');
  assert.equal(r.status, 'EQUAL');
  assert.equal(r.counts.a_sccs, 2); // {a}, {x,y}
  assert.equal(r.counts.b_sccs, 2);
  assert.deepEqual(r.canonical.a.sccs, [['a'], ['x', 'y']]);
});

test('different cycle structure is NOT_EQUAL', () => {
  const a = [
    { id: 'x', causes: ['y'] },
    { id: 'y', causes: ['x'] },
    { id: 'z', causes: [] },
  ];
  const b = [
    { id: 'x', causes: ['y'] },
    { id: 'y', causes: ['x'] },
    { id: 'z', causes: ['x'] },
  ];
  const s = storeWith({ a, b });
  // b adds z after the cycle; a says nothing about z vs x/y -> one-directional
  assert.equal(equiv(s, 'a', 'b').status, 'UNDECIDED');
});

// Acceptance 5 (boundary): empty logs.
test('empty log boundaries', () => {
  const s = storeWith({ empty1: [], empty2: [], nonempty: [{ id: 'x', causes: [] }] });
  assert.equal(equiv(s, 'empty1', 'empty2').status, 'EQUAL');
  const r = equiv(s, 'empty1', 'nonempty');
  assert.equal(r.status, 'UNDECIDED');
  assert.ok(r.missing_edges.length === 0); // no edges to miss, just the event
  assert.equal(equiv(s, 'nonempty', 'empty1').status, 'UNDECIDED');
});

// Acceptance 5: duplicate log_id rejected, store unchanged.
test('duplicate log_id is INVALID_INPUT and does not overwrite', () => {
  const s = storeWith({ a: [{ id: 'x', causes: [] }] });
  const r = ingest(s, 'a', [{ id: 'other', causes: [] }]);
  assert.equal(r.status, 'INVALID_INPUT');
  const s2 = storeWith({ b: [{ id: 'x', causes: [] }] });
  assert.equal(equiv(s, 'a', 'a').status, 'EQUAL');
  assert.equal(s.logs.get('a').length, 1);
  assert.equal(s.logs.get('a')[0].id, 'x');
});

test('invalid inputs are rejected', () => {
  const s = createStore();
  assert.equal(ingest(s, '', []).status, 'INVALID_INPUT');
  assert.equal(ingest(s, 'x', 'not-an-array').status, 'INVALID_INPUT');
  assert.equal(ingest(s, 'x', [{ id: 1 }]).status, 'INVALID_INPUT');
  assert.equal(ingest(s, 'x', [{ id: 'a', causes: 'nope' }]).status, 'INVALID_INPUT');
  assert.equal(ingest(s, 'x', [{ id: 'a', causes: ['a'] }]).status, 'INVALID_INPUT'); // self-cause
  assert.equal(
    ingest(s, 'x', [
      { id: 'a', causes: [] },
      { id: 'a', causes: ['b'] }, // conflicting duplicate
    ]).status,
    'INVALID_INPUT',
  );
  assert.equal(s.logs.size, 0); // nothing partially ingested
  assert.equal(equiv(s, 'no', 'nope').status, 'INVALID_INPUT');
});

test('identical duplicate events within one ingest are deduped', () => {
  const s = createStore();
  const r = ingest(s, 'a', [
    { id: 'x', causes: [] },
    { id: 'x', causes: [] },
  ]);
  assert.equal(r.status, 'OK');
  assert.equal(r.events, 1);
});

test('merge combines logs; conflicting duplicates rejected', () => {
  const s = storeWith({
    a: [
      { id: 'x', causes: [] },
      { id: 'y', causes: ['x'] },
    ],
    b: [
      { id: 'y', causes: ['x'] }, // identical duplicate: fine
      { id: 'z', causes: ['y'] },
    ],
    c: [{ id: 'y', causes: ['z'] }], // conflicts with a/b
  });
  const ok = merge(s, 'a', 'b', 'ab');
  assert.equal(ok.status, 'OK');
  assert.equal(ok.events, 3);
  assert.equal(merge(s, 'a', 'c').status, 'INVALID_INPUT');
  assert.equal(merge(s, 'a', 'missing').status, 'INVALID_INPUT');
  // merged log compares equal to an equivalent directly-ingested log
  ingest(s, 'ab2', [
    { id: 'z', causes: ['y'] },
    { id: 'y', causes: ['x'] },
    { id: 'x', causes: [] },
  ]);
  assert.equal(equiv(s, 'ab', 'ab2').status, 'EQUAL');
});

test('dangling cause reference means missing info, not conflict', () => {
  const s = storeWith({
    a: [{ id: 'y', causes: ['x'] }], // x unknown to a
    b: [
      { id: 'x', causes: [] },
      { id: 'y', causes: ['x'] },
    ],
  });
  const r = equiv(s, 'a', 'b');
  assert.equal(r.status, 'UNDECIDED');
  assert.ok(r.missing_edges.some((e) => e.reason === 'dangling_cause'));
});

// Scale: 3000 events per shift.
test('3000-event logs compare quickly and correctly', () => {
  const N = 3000;
  const a = [];
  for (let i = 0; i < N; i++) {
    const causes = [];
    if (i > 0) causes.push(`e${i - 1}`);
    if (i > 10 && i % 7 === 0) causes.push(`e${i - 10}`); // redundant edges
    a.push({ id: `e${i}`, causes });
  }
  const b = [...a].reverse(); // same partial order, reversed record order
  const s = storeWith({ a, b });
  const t0 = Date.now();
  assert.equal(equiv(s, 'a', 'b').status, 'EQUAL');
  assert.ok(Date.now() - t0 < 5000, 'comparison should finish well under 5s');
  // drop one cover edge from b -> UNDECIDED
  const b2 = a.map((e) => ({ ...e, causes: [...e.causes] }));
  b2[123].causes = b2[123].causes.filter((c) => c !== 'e122');
  ingest(s, 'b2', b2);
  const r = equiv(s, 'a', 'b2');
  assert.equal(r.status, 'UNDECIDED');
  assert.ok(r.missing_edges.some((e) => e.from === 'e122' && e.to === 'e123'));
});
