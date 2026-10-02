'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store, StoreError } = require('../lib/store');

function set(doc, field, value) {
  return { type: 'set', doc, field, value };
}

function capture(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

// Independent re-implementations used only to cross-check the store.
function independentClosure(versions, id) {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of byId.get(cur).parents) stack.push(p);
  }
  return seen;
}

function independentDocs(versions, asOf) {
  const closure = independentClosure(versions, asOf);
  const ordered = versions
    .filter((v) => closure.has(v.id))
    .sort((a, b) => a.clock - b.clock || a.seq - b.seq);
  const docs = {};
  for (const v of ordered) {
    for (const op of v.ops) {
      if (op.type === 'set') {
        (docs[op.doc] ||= {})[op.field] = op.value;
      } else if (docs[op.doc]) {
        delete docs[op.doc][op.field];
        if (Object.keys(docs[op.doc]).length === 0) delete docs[op.doc];
      }
    }
  }
  return docs;
}

function buildBranchedHistory() {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'title', '泵P-1检修'), set('WO-1', 'notes', '轴承正常')] });
  s.commit({ branch: 'main', ops: [set('WO-1', 'status', 'open')] });
  s.createBranch('dev', 'main');
  s.commit({ branch: 'dev', ops: [set('WO-1', 'notes', '轴承磨损需观察')] });
  s.commit({ branch: 'main', ops: [set('WO-1', 'status', 'in-progress')] });
  s.commit({ branch: 'dev', ops: [set('WO-2', 'title', '阀V-2更换'), set('WO-2', 'notes', '密封圈老化')] });
  s.merge({ into: 'main', from: 'dev' });
  return s;
}

test('acceptance 1: ancestor closures and visible docs match independent enumeration', () => {
  const s = buildBranchedHistory();
  const json = s.toJSON();
  assert.equal(json.versions.length, 6);
  for (const v of json.versions) {
    const expected = independentClosure(json.versions, v.id);
    const actual = s.visibleVersions(v.id);
    assert.deepEqual([...actual].sort(), [...expected].sort(), `closure of ${v.id}`);
    assert.deepEqual(s.documentsAt(v.id), independentDocs(json.versions, v.id), `docs at ${v.id}`);
  }
  // as_of only contains ancestors: pre-merge main tip must not see dev-only doc.
  assert.equal(s.documentsAt('v4')['WO-2'], undefined);
  assert.ok(s.documentsAt('v6')['WO-2']);
  // merge commit has both parents; its closure is the union of both histories.
  assert.deepEqual([...s.visibleVersions('v6')].sort(), ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']);
});

test('acceptance 2: concurrent same-field edits conflict; resolution merges', () => {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'notes', '轴承正常')] });
  s.createBranch('dev', 'main');
  s.commit({ branch: 'dev', ops: [set('WO-1', 'notes', '轴承磨损')] });
  s.commit({ branch: 'main', ops: [set('WO-1', 'notes', '轴承过热')] });

  assert.equal(s.areConcurrent('v2', 'v3'), true);
  assert.equal(s.areConcurrent('v1', 'v2'), false);
  assert.equal(s.areConcurrent('v1', 'v3'), false);

  const err = capture(() => s.merge({ into: 'main', from: 'dev' }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'E_CONFLICT');
  assert.deepEqual(err.details.conflicts, [
    { doc: 'WO-1', field: 'notes', base: '轴承正常', ours: '轴承过热', theirs: '轴承磨损' },
  ]);
  // Failed merge leaves no trace.
  assert.equal(s.versions.size, 3);

  const result = s.merge({ into: 'main', from: 'dev', resolutions: { 'WO-1.notes': '轴承过热，复测后更换' } });
  assert.equal(result.merged, true);
  assert.equal(s.documentsAt(result.version.id)['WO-1'].notes, '轴承过热，复测后更换');
  assert.deepEqual(result.version.parents, ['v3', 'v2']);
});

test('concurrency is causal, never arrival-ordered', () => {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'a', '1')] });
  s.createBranch('dev', 'main');
  // Arrive later but carry a lower clock; arrival order must not matter.
  s.commit({ branch: 'dev', ops: [set('WO-1', 'b', '2')], clock: 9 });
  s.commit({ branch: 'main', ops: [set('WO-1', 'c', '3')], clock: 4 });
  assert.equal(s.areConcurrent('v2', 'v3'), true);
  assert.ok(!s.visibleVersions('v3').has('v2'));
  assert.ok(!s.visibleVersions('v2').has('v3'));
  // Each side only sees its own ancestor chain.
  assert.deepEqual(Object.keys(s.documentsAt('v2')['WO-1']).sort(), ['a', 'b']);
  assert.deepEqual(Object.keys(s.documentsAt('v3')['WO-1']).sort(), ['a', 'c']);
});

test('acceptance 3: undo appends inverse ops; old versions stay readable', () => {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'notes', '轴承过热需更换')] });
  s.commit({ branch: 'main', ops: [set('WO-1', 'notes', '已更换轴承')] });
  const undoV = s.undo({ branch: 'main', version: 'v2' });

  assert.equal(undoV.message, 'undo v2');
  assert.deepEqual(undoV.ops, [set('WO-1', 'notes', '轴承过热需更换')]);
  // History is preserved: all three versions exist.
  assert.equal(s.versions.size, 3);
  assert.ok(s.versions.has('v2'));
  // Tip shows the reverted state...
  assert.equal(s.documentsAt('v3')['WO-1'].notes, '轴承过热需更换');
  // ...but as_of the old version the pre-undo state is still readable.
  assert.equal(s.documentsAt('v2')['WO-1'].notes, '已更换轴承');
  assert.deepEqual(s.queryPhrase('已更换', { asOf: 'v2' }), ['WO-1']);
  assert.deepEqual(s.queryPhrase('已更换', { asOf: 'v3' }), []);
  assert.deepEqual(s.queryPhrase('过热', { asOf: 'v3' }), ['WO-1']);
});

test('acceptance 4: compaction preserves every as_of query result', () => {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'notes', '轴承 正常 运行'), set('WO-1', 'status', 'open')] });
  s.commit({ branch: 'main', ops: [set('WO-1', 'notes', '轴承 过热 报警')] });
  s.createBranch('dev', 'main');
  s.commit({ branch: 'dev', ops: [set('WO-1', 'notes', '轴承 已更换 复测 正常')] });
  s.commit({ branch: 'main', ops: [set('WO-1', 'status', 'closed')] });
  s.commit({ branch: 'main', ops: [{ type: 'del', doc: 'WO-1', field: 'status' }] });
  s.merge({ into: 'main', from: 'dev' });

  let postingCount = 0;
  for (const docMap of s.index.values()) {
    for (const list of docMap.values()) postingCount += list.length;
  }

  const phrases = ['轴承', '过热', '正常', '复测 正常', '报警', '已更换', '不存在的词'];
  const snapshot = {};
  for (const id of s.versions.keys()) {
    for (const phrase of phrases) {
      snapshot[`${id}|${phrase}`] = s.queryPhrase(phrase, { asOf: id });
    }
  }

  const stats = s.compact();
  assert.ok(stats.removed > 0, 'compaction should remove redundant postings');

  let remaining = 0;
  for (const docMap of s.index.values()) {
    for (const list of docMap.values()) remaining += list.length;
  }
  assert.equal(remaining, postingCount - stats.removed);

  for (const id of s.versions.keys()) {
    for (const phrase of phrases) {
      assert.deepEqual(
        s.queryPhrase(phrase, { asOf: id }),
        snapshot[`${id}|${phrase}`],
        `query ${phrase} as_of ${id}`
      );
    }
  }
});

test('compaction keeps tombstones that are still visible somewhere', () => {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'notes', '密封圈老化')] });
  s.commit({ branch: 'main', ops: [{ type: 'del', doc: 'WO-1', field: 'notes' }] });
  const before = s.queryPhrase('密封圈', { asOf: 'v1' });
  const stats = s.compact();
  assert.deepEqual(s.queryPhrase('密封圈', { asOf: 'v1' }), before);
  assert.deepEqual(before, ['WO-1']);
  assert.deepEqual(s.queryPhrase('密封圈', { asOf: 'v2' }), []);
  // add@v1 and del@v2 are each the latest visible entry at their own version,
  // so nothing here is removable.
  assert.equal(stats.removed, 0);
});

test('E_CLOCK: clock must exceed every parent clock', () => {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'a', '1')], clock: 5 });
  const err = capture(() => s.commit({ branch: 'main', ops: [set('WO-1', 'a', '2')], clock: 5 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'E_CLOCK');
  const err2 = capture(() => s.commit({ branch: 'main', ops: [set('WO-1', 'a', '2')], clock: 3 }));
  assert.ok(err2 instanceof StoreError);
  assert.equal(err2.code, 'E_CLOCK');
  const ok = s.commit({ branch: 'main', ops: [set('WO-1', 'a', '2')], clock: 6 });
  assert.equal(ok.clock, 6);
  // Auto clock continues from the parent.
  assert.equal(s.commit({ branch: 'main', ops: [] }).clock, 7);
});

test('E_VERSION: unknown versions and branches', () => {
  const s = new Store();
  s.commit({ branch: 'main', ops: [set('WO-1', 'a', '1')] });
  for (const fn of [
    () => s.visibleVersions('v99'),
    () => s.queryPhrase('x', { asOf: 'v99' }),
    () => s.undo({ branch: 'main', version: 'v99' }),
    () => s.commit({ branch: 'ghost', ops: [] }),
    () => s.createBranch('b2', 'nowhere'),
    () => s.merge({ into: 'main', from: 'ghost' }),
  ]) {
    const err = capture(fn);
    assert.ok(err instanceof StoreError, String(err));
    assert.equal(err.code, 'E_VERSION');
  }
});

test('persistence round-trip preserves queries and history', () => {
  const s = buildBranchedHistory();
  const restored = Store.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  for (const id of s.versions.keys()) {
    assert.deepEqual(restored.documentsAt(id), s.documentsAt(id), `docs at ${id}`);
    assert.deepEqual(
      restored.queryPhrase('轴承', { asOf: id }),
      s.queryPhrase('轴承', { asOf: id }),
      `query at ${id}`
    );
  }
  assert.deepEqual([...restored.branches.entries()], [...s.branches.entries()]);
});
