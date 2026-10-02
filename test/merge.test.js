'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { mergeVersions } = require('../lib/merge');
const { computeHash, LineageError } = require('../lib/version');

function tmpStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-')));
}

function version(overrides) {
  return {
    author: 'tester',
    clock: {},
    parents: [],
    results: {},
    evidence: [],
    ...overrides,
  };
}

test('fast-forward: ancestor version merges into descendant without a new commit', () => {
  const store = tmpStore();
  const hashA = store.put(version({ author: 'n1', clock: { n1: 1 }, results: { x: 1 } }));
  const hashB = store.put(version({
    author: 'n1',
    clock: { n1: 2 },
    parents: [hashA],
    results: { x: 1, y: 2 },
  }));

  const result = mergeVersions(store, hashA, hashB);
  assert.equal(result.status, 'fast-forward');
  assert.equal(result.head.hash, hashB);

  const reverse = mergeVersions(store, hashB, hashA);
  assert.equal(reverse.status, 'fast-forward');
  assert.equal(reverse.head.hash, hashB);

  assert.equal(store.list().length, 2, 'no merge commit may be created');
});

test('up-to-date: merging a version with itself', () => {
  const store = tmpStore();
  const hashA = store.put(version({ author: 'n1', clock: { n1: 1 } }));
  const result = mergeVersions(store, hashA, hashA);
  assert.equal(result.status, 'up-to-date');
  assert.equal(store.list().length, 1);
});

test('compatible concurrent versions merge: field union, max clock, recomputed hash', () => {
  const store = tmpStore();
  const base = store.put(version({ author: 'n1', clock: { n1: 1 }, results: { shared: 0.5 } }));
  const left = store.put(version({
    author: 'n1',
    clock: { n1: 2 },
    parents: [base],
    results: { shared: 0.5, alpha: 1 },
    evidence: [{ id: 'e1', label: 'replicated' }],
  }));
  const right = store.put(version({
    author: 'n2',
    clock: { n1: 1, n2: 1 },
    parents: [base],
    results: { shared: 0.5, beta: 2 },
    evidence: [{ id: 'e2', label: 'calibrated' }, { id: 'e1', label: 'replicated' }],
  }));

  const result = mergeVersions(store, left, right);
  assert.equal(result.status, 'merged');

  const head = result.head;
  assert.deepEqual(head.results, { shared: 0.5, alpha: 1, beta: 2 });
  assert.deepEqual(head.clock, { n1: 2, n2: 1 });
  assert.deepEqual(head.parents, [left, right].sort());
  assert.deepEqual(head.evidence.map((e) => e.id).sort(), ['e1', 'e2']);
  assert.equal(head.hash, computeHash(head), 'lineage hash recomputed over merged payload');
  assert.ok(store.has(head.hash), 'merge commit persisted');
  assert.equal(store.list().length, 4);

  // The merge commit is a valid descendant of both parents.
  const again = mergeVersions(store, head.hash, left);
  assert.equal(again.status, 'fast-forward');
  assert.equal(again.head.hash, head.hash);
});

test('contradictory numeric fields produce a conflict certificate and no commit', () => {
  const store = tmpStore();
  const base = store.put(version({ author: 'n1', clock: { n1: 1 } }));
  const left = store.put(version({
    author: 'n1', clock: { n1: 2 }, parents: [base], results: { accuracy: 0.91 },
  }));
  const right = store.put(version({
    author: 'n2', clock: { n1: 1, n2: 1 }, parents: [base], results: { accuracy: 0.72 },
  }));

  const result = mergeVersions(store, left, right);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.versions, [left, right]);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].kind, 'numeric-contradiction');
  assert.equal(result.conflicts[0].field, 'accuracy');
  assert.equal(result.conflicts[0].valueA, 0.91);
  assert.equal(result.conflicts[0].valueB, 0.72);
  assert.equal(store.list().length, 3, 'no merge commit may be created');
});

test('mutually exclusive evidence labels conflict; compatible labels merge', () => {
  const store = tmpStore();
  const base = store.put(version({ author: 'n1', clock: { n1: 1 } }));
  const left = store.put(version({
    author: 'n1',
    clock: { n1: 2 },
    parents: [base],
    evidence: [{ id: 'e1', label: 'positive' }],
  }));
  const right = store.put(version({
    author: 'n2',
    clock: { n1: 1, n2: 1 },
    parents: [base],
    evidence: [{ id: 'e2', label: 'negative' }],
  }));

  const result = mergeVersions(store, left, right);
  assert.equal(result.status, 'conflict');
  assert.equal(result.conflicts[0].kind, 'exclusive-evidence');
  assert.deepEqual(result.conflicts[0].labels, ['positive', 'negative']);
  assert.equal(store.list().length, 3);

  const ok = store.put(version({
    author: 'n2',
    clock: { n1: 1, n2: 2 },
    parents: [base],
    evidence: [{ id: 'e3', label: 'replicated' }],
  }));
  const merged = mergeVersions(store, left, ok);
  assert.equal(merged.status, 'merged');
  assert.deepEqual(merged.head.evidence.map((e) => e.id).sort(), ['e1', 'e3']);
});

test('unknown parent reference is rejected', () => {
  const store = tmpStore();
  assert.throws(
    () => store.put(version({ clock: { n1: 1 }, parents: ['deadbeef'] })),
    (err) => err instanceof LineageError && err.code === 'UNKNOWN_PARENT',
  );
});

test('clock regression relative to a parent is rejected', () => {
  const store = tmpStore();
  const base = store.put(version({ author: 'n1', clock: { n1: 2 } }));
  assert.throws(
    () => store.put(version({ author: 'n1', clock: { n1: 1 }, parents: [base] })),
    (err) => err instanceof LineageError && err.code === 'CLOCK_REGRESSION',
  );
});

test('duplicate evidence ids are rejected', () => {
  const store = tmpStore();
  assert.throws(
    () => store.put(version({
      clock: { n1: 1 },
      evidence: [{ id: 'e1', label: 'a' }, { id: 'e1', label: 'b' }],
    })),
    (err) => err instanceof LineageError && err.code === 'DUPLICATE_EVIDENCE',
  );
});
