'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

const occupy = (id, resource, start, end, baseVersion) => ({
  op: 'command',
  command: { id, kind: 'occupy', resource, start, end, baseVersion },
});

test('acceptance 1: overlapping command rejected with certificate, adjacent succeeds', () => {
  const e = new Engine();
  const r1 = e.process(occupy('A', 'dev-1', 0, 100, 0));
  assert.equal(r1.ok, true);
  assert.equal(r1.version, 1);

  const r2 = e.process(occupy('B', 'dev-1', 50, 150, 0));
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'REVISION');
  assert.deepEqual(r2.error.certificate, {
    commandId: 'B',
    conflictCommandId: 'A',
    resource: 'dev-1',
    firstOverlapMs: 50,
  });

  // Adjacent half-open intervals do not overlap.
  const r3 = e.process(occupy('C', 'dev-1', 100, 200, 0));
  assert.equal(r3.ok, true);
  assert.equal(r3.version, 2);

  // Different resource: no conflict.
  const r4 = e.process(occupy('D', 'dev-2', 50, 150, 0));
  assert.equal(r4.ok, true);

  // baseVersion at/after the conflicting write: no conflict.
  const r5 = e.process(occupy('E', 'dev-1', 0, 50, 1));
  assert.equal(r5.ok, true);

  // First overlapping millisecond is max of the two starts.
  const r6 = e.process(occupy('F', 'dev-1', 120, 180, 0));
  assert.equal(r6.error.certificate.firstOverlapMs, 120);
  assert.equal(r6.error.certificate.conflictCommandId, 'C');
});

test('acceptance 2: inner failure rolls back only inner writes; outer commits (partial keep)', () => {
  const e = new Engine();
  e.process(occupy('base', 'dev-1', 0, 10, 0)); // version 1

  const results = e.processAll([
    { op: 'begin', tx: 'outer' },
    occupy('o1', 'dev-1', 10, 20, 1),
    { op: 'begin', tx: 'inner' },
    occupy('i1', 'dev-1', 20, 30, 1),
    occupy('i2', 'dev-1', 5, 15, 0), // baseVersion 0 < version of committed 'base'
  ]);
  const failed = results[4];
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'REVISION');
  assert.equal(failed.error.certificate.commandId, 'i2');
  assert.equal(failed.error.certificate.conflictCommandId, 'base');
  assert.equal(failed.error.certificate.firstOverlapMs, 5);
  assert.equal(failed.rolledBackTx, 'inner');

  // Outer transaction is still open and can commit its own writes.
  const more = e.processAll([
    occupy('o2', 'dev-1', 30, 40, 1),
    { op: 'commit' },
  ]);
  assert.equal(more[0].ok, true);
  assert.equal(more[1].ok, true);

  const committed = e.committedIntervals('dev-1').map((iv) => iv.commandId).sort();
  assert.deepEqual(committed, ['base', 'o1', 'o2']); // i1 discarded with inner tx
});

test('acceptance 2: outer rollback discards everything, savepoint keeps prefix', () => {
  const e = new Engine();
  const r = e.processAll([
    { op: 'begin', tx: 't1' },
    occupy('a', 'dev-1', 0, 10, 0),
    { op: 'savepoint', name: 'sp1' },
    occupy('b', 'dev-1', 10, 20, 0),
    { op: 'rollbackTo', name: 'sp1' },
    occupy('c', 'dev-1', 20, 30, 0),
    { op: 'commit' },
  ]);
  assert.ok(r.every((x) => x.ok));
  assert.deepEqual(e.committedIntervals('dev-1').map((iv) => iv.commandId), ['a', 'c']);

  const e2 = new Engine();
  e2.processAll([
    { op: 'begin', tx: 't1' },
    occupy('x', 'dev-1', 0, 10, 0),
    { op: 'rollback' },
  ]);
  assert.deepEqual(e2.committedIntervals(), []);
  assert.equal(e2.version, 0);
});

test('errors: zero duration, inverted interval, unknown savepoint', () => {
  const e = new Engine();
  const z = e.process(occupy('z', 'dev-1', 10, 10, 0));
  assert.equal(z.error.code, 'ZERO_DURATION');

  const inv = e.process(occupy('inv', 'dev-1', 20, 10, 0));
  assert.equal(inv.error.code, 'INVERTED_INTERVAL');

  e.process({ op: 'begin', tx: 't' });
  const us = e.process({ op: 'rollbackTo', name: 'nope' });
  assert.equal(us.error.code, 'UNKNOWN_SAVEPOINT');
  const rel = e.process({ op: 'release', name: 'nope' });
  assert.equal(rel.error.code, 'UNKNOWN_SAVEPOINT');
  e.process({ op: 'rollback' });
});

test('override and release kinds commit with status', () => {
  const e = new Engine();
  const r = e.process({
    op: 'command',
    command: { id: 'ov', kind: 'override', resource: 'dev-1', start: 0, end: 5, baseVersion: 0, status: 'maintenance' },
  });
  assert.equal(r.ok, true);
  assert.equal(e.committedIntervals('dev-1')[0].status, 'maintenance');
  const rel = e.process(occupy('rel', 'dev-1', 5, 8, 1));
  assert.equal(rel.ok, true);
});
