import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError, applyOp } from '../src/store.js';

// Build a small branched history (deterministic, no conflicts):
//
//   v1 (main)   set w1.note=更换轴承
//   v2 (main)   set w2.note=检查皮带
//   v3 (feat)   set w1.note=更换皮带        (branch from v2)
//   v4 (main)   set w3.note=紧固螺栓
//   v5 (main)   merge feat -> main          (parents v4, v3)
//   v6 (main)   delete w2                   (versioned tombstone)
function buildHistory() {
  const s = new Store();
  s.createBranch('main');
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '更换轴承' }], message: 'c1' });
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w2', field: 'note', value: '检查皮带' }], message: 'c2' });
  s.createBranch('feat', 'v2');
  s.commit({ branch: 'feat', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '更换皮带' }], message: 'f1' });
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w3', field: 'note', value: '紧固螺栓' }], message: 'c3' });
  s.merge({ branch: 'main', from: 'feat' });
  s.commit({ branch: 'main', ops: [{ op: 'delete', doc: 'w2' }], message: 'c4' });
  return s;
}

// Independent reference implementation used only by the tests.
function naiveClosure(store, id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...store.versions.get(cur).parents);
  }
  return seen;
}

function naiveMaterialize(store, id) {
  const vs = [...naiveClosure(store, id)]
    .map((v) => store.versions.get(v))
    .sort((a, b) => a.lamport - b.lamport || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const docs = new Map();
  for (const v of vs) for (const op of v.ops) applyOp(docs, op);
  const out = new Map();
  for (const [doc, d] of docs) {
    if (!d.deleted && Object.keys(d.fields).length > 0) out.set(doc, d.fields);
  }
  return out;
}

test('acceptance 1: enumerate all ancestor closures and cross-check visible docs', () => {
  const s = buildHistory();
  const allIds = [...s.versions.keys()];
  assert.equal(allIds.length, 6);
  for (const id of allIds) {
    // ancestor closure matches the naive parent-walk
    assert.deepEqual([...s.ancestors(id)].sort(), [...naiveClosure(s, id)].sort(), `closure ${id}`);
    // visible documents match naive replay over exactly that closure
    assert.deepEqual(s.materialize(id), naiveMaterialize(s, id), `materialize ${id}`);
    // phrase query only returns docs visible at this version
    for (const phrase of ['更换', '皮带', '螺栓', '检查']) {
      const expected = [...naiveMaterialize(s, id).entries()]
        .filter(([, f]) => Object.values(f).some((v) => String(v).includes(phrase)))
        .map(([doc]) => doc)
        .sort();
      assert.deepEqual(s.query(phrase, { asOf: id }), expected, `query "${phrase}" as_of ${id}`);
    }
  }
  // causality: v3 and v4 are concurrent, v1 causally precedes everything
  assert.ok(s.concurrent('v3', 'v4'));
  assert.ok(s.concurrent('v4', 'v3'));
  assert.ok(!s.concurrent('v1', 'v6'));
  assert.ok(s.isAncestor('v3', 'v5'));
  assert.ok(!s.isAncestor('v3', 'v4'));
  // tombstone: w2 gone at head, still visible as_of v2
  assert.ok(!s.materialize('v6').has('w2'));
  assert.equal(s.materialize('v2').get('w2').note, '检查皮带');
});

test('acceptance 2: concurrent edits to the same field conflict; unresolved merge -> E_CONFLICT', () => {
  const s = new Store();
  s.createBranch('main');
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '待检查' }] });
  s.createBranch('a', 'v1');
  s.createBranch('b', 'v1');
  s.commit({ branch: 'a', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '更换轴承' }] });
  s.commit({ branch: 'b', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '更换皮带' }] });
  assert.ok(s.concurrent('v2', 'v3'));

  let err;
  try {
    s.merge({ branch: 'a', from: 'b' });
    assert.fail('expected E_CONFLICT');
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'E_CONFLICT');
  assert.deepEqual(
    err.conflicts.map((c) => `${c.doc}.${c.field}`),
    ['w1.note'],
  );
  assert.equal(err.conflicts[0].ours, '更换轴承');
  assert.equal(err.conflicts[0].theirs, '更换皮带');

  // resolved merge succeeds and records both parents
  const m = s.merge({ branch: 'a', from: 'b', resolutions: { 'w1.note': '更换轴承' } });
  assert.deepEqual(m.parents, ['v2', 'v3']);
  assert.equal(s.materialize(m.id).get('w1').note, '更换轴承');
});

test('acceptance 3: undo appends inverse ops; old versions stay readable via as_of', () => {
  const s = new Store();
  s.createBranch('main');
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '初始结论' }] });
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '临时结论' }] });
  const u = s.undo({ branch: 'main', version: 'v2' });

  // history not deleted: v2 still exists with its original content
  assert.equal(s.materialize('v2').get('w1').note, '临时结论');
  assert.deepEqual(s.query('临时结论', { asOf: 'v2' }), ['w1']);
  // head shows the reverted value
  const head = s.branchHead('main');
  assert.equal(head, u.id);
  assert.equal(s.materialize(head).get('w1').note, '初始结论');
  assert.deepEqual(s.query('临时结论', { asOf: head }), []);
  // undo of a merge version is rejected
  const s2 = buildHistory();
  assert.throws(() => s2.undo({ branch: 'main', version: 'v5' }), (e) => e.code === 'E_VERSION');
});

test('acceptance 4: index compaction preserves every as_of query result', () => {
  const s = buildHistory();
  // extra churn so the index has several segments and a tombstone
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w1', field: 'note', value: '更换轴承并复测' }] });
  s.commit({ branch: 'main', ops: [{ op: 'delete', doc: 'w1' }] });

  const phrases = ['更换', '皮带', '螺栓', '复测', '检查'];
  const ids = [...s.versions.keys()];
  const before = new Map();
  for (const id of ids) {
    for (const p of phrases) before.set(`${id}${p}`, s.query(p, { asOf: id }));
  }
  const segmentsBefore = s.segments.length;
  assert.ok(segmentsBefore > 1);

  s.compact();
  assert.equal(s.segments.length, 1);

  for (const id of ids) {
    for (const p of phrases) {
      assert.deepEqual(s.query(p, { asOf: id }), before.get(`${id}${p}`), `compact changed ${p} @ ${id}`);
    }
  }
  // materialization is unaffected too
  for (const id of ids) assert.deepEqual(s.materialize(id), naiveMaterialize(s, id));
});

test('error codes: E_CLOCK and E_VERSION', () => {
  const s = new Store();
  s.createBranch('main');
  s.commit({ branch: 'main', ops: [{ op: 'set', doc: 'w1', field: 'note', value: 'x' }] });

  // lamport not greater than parent's -> E_CLOCK
  assert.throws(
    () => s.commit({ branch: 'main', ops: [], lamport: 1 }),
    (e) => e instanceof StoreError && e.code === 'E_CLOCK',
  );
  assert.throws(
    () => s.commit({ branch: 'main', ops: [], lamport: 0 }),
    (e) => e.code === 'E_CLOCK',
  );
  // explicit valid lamport accepted
  const ok = s.commit({ branch: 'main', ops: [], lamport: 10 });
  assert.equal(ok.lamport, 10);
  // auto lamport keeps increasing past the max seen
  const next = s.commit({ branch: 'main', ops: [] });
  assert.ok(next.lamport > 10);

  // unknown version / branch -> E_VERSION
  assert.throws(() => s.ancestors('v999'), (e) => e.code === 'E_VERSION');
  assert.throws(() => s.query('x', { asOf: 'v999' }), (e) => e.code === 'E_VERSION');
  assert.throws(() => s.commit({ branch: 'nope', ops: [] }), (e) => e.code === 'E_VERSION');
  assert.throws(() => s.merge({ branch: 'main', from: 'nope' }), (e) => e.code === 'E_VERSION');
  assert.throws(() => s.createBranch('main'), (e) => e.code === 'E_VERSION');
});

test('persistence round-trip preserves queries', () => {
  const s = buildHistory();
  const restored = Store.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  for (const id of s.versions.keys()) {
    assert.deepEqual(restored.materialize(id), s.materialize(id));
    assert.deepEqual(restored.query('皮带', { asOf: id }), s.query('皮带', { asOf: id }));
  }
});
