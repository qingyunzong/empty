'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');
const { Journal, recover, SimulatedCrash } = require('../src/journal');

function baseJournal() {
  const journal = new Journal();
  journal.commit({ id: 'e1', op: 'open', account: 'a', balance: 100 });
  journal.commit({ id: 'e2', op: 'debit', account: 'a', amount: 40 }); // balance 60
  return journal;
}

const EVENT_E3 = { id: 'e3', op: 'credit', account: 'a', amount: 10 };

test('E: crash before writing the event -> journal unchanged, recovers to previous head', () => {
  const journal = baseJournal();
  assert.throws(
    () => journal.commit(EVENT_E3, { fault: 'beforeEvent' }),
    (err) => err instanceof SimulatedCrash && err.point === 'beforeEvent',
  );
  const result = recover(journal.toJSONL().split('\n'));
  assert.equal(result.head, 'e2');
  assert.deepEqual(result.ledger.getAccount('a'), { state: 'OPEN', balance: 60, held: 0 });
  assert.equal(result.ignored, 0);
});

test('E: crash after event, before snapshot -> trailing event ignored on recovery', () => {
  const journal = baseJournal();
  assert.throws(
    () => journal.commit(EVENT_E3, { fault: 'afterEvent' }),
    (err) => err.point === 'afterEvent',
  );
  const result = recover(journal.toJSONL().split('\n'));
  assert.equal(result.head, 'e2');
  assert.deepEqual(result.ledger.getAccount('a'), { state: 'OPEN', balance: 60, held: 0 });
  assert.equal(result.ignored, 1);
});

test('E: crash after snapshot, before head update -> recovers to last consistent head', () => {
  const journal = baseJournal();
  assert.throws(
    () => journal.commit(EVENT_E3, { fault: 'afterSnapshot' }),
    (err) => err.point === 'afterSnapshot',
  );
  const result = recover(journal.toJSONL().split('\n'));
  assert.equal(result.head, 'e2');
  assert.deepEqual(result.ledger.getAccount('a'), { state: 'OPEN', balance: 60, held: 0 });
  assert.equal(result.ignored, 1);
});

test('E: clean recovery replays to the exact live state', () => {
  const journal = baseJournal();
  journal.commit(EVENT_E3);
  journal.commit({ id: 'e4', op: 'hold', account: 'a', amount: 15 });
  const result = recover(journal.toJSONL().split('\n'));
  assert.equal(result.head, 'e4');
  assert.deepEqual(result.ledger.getState(), journal.ledger.getState());
});

test('E: duplicate events are idempotent by id', () => {
  const journal = baseJournal();
  journal.commit(EVENT_E3);
  const lines = journal.toJSONL().split('\n').filter((l) => l !== '');
  const duplicated = lines.flatMap((l) => [l, l]); // every record written twice
  const result = recover(duplicated);
  assert.equal(result.head, 'e3');
  assert.deepEqual(result.ledger.getAccount('a'), { state: 'OPEN', balance: 70, held: 0 });
});

test('E: failed events are replayed deterministically (ERROR reproduced)', () => {
  const journal = baseJournal();
  const failed = journal.commit({ id: 'e3', op: 'debit', account: 'a', amount: 500 });
  assert.equal(failed.error.code, 'NEGATIVE');
  journal.commit({ id: 'e4', op: 'repair', account: 'a' });
  journal.commit({ id: 'e5', op: 'credit', account: 'a', amount: 5 });
  const result = recover(journal.toJSONL().split('\n'));
  assert.equal(result.head, 'e5');
  assert.deepEqual(result.ledger.getAccount('a'), { state: 'OPEN', balance: 65, held: 0 });
});

test('E: corrupt journal is rejected with CORRUPT_JOURNAL', () => {
  const journal = baseJournal();
  const lines = journal.toJSONL().split('\n').filter((l) => l !== '');
  const garbageMid = [...lines.slice(0, 2), '{"type":"event"', ...lines.slice(2)];
  assert.throws(() => recover(garbageMid), (err) => err.code === 'CORRUPT_JOURNAL');

  const conflicting = [...lines, JSON.stringify({ type: 'event', event: { id: 'e2', op: 'credit', account: 'a', amount: 1 } })];
  assert.throws(() => recover(conflicting), (err) => err.code === 'CORRUPT_JOURNAL');

  const danglingHead = [...lines, JSON.stringify({ type: 'head', event: 'nope' })];
  assert.throws(() => recover(danglingHead), (err) => err.code === 'CORRUPT_JOURNAL');
});

test('E: torn final line is tolerated as a crashed tail write', () => {
  const journal = baseJournal();
  const lines = journal.toJSONL().split('\n').filter((l) => l !== '');
  lines.push('{"type":"event","event":{"id":"e3"'); // partial write
  const result = recover(lines);
  assert.equal(result.head, 'e2');
  assert.equal(result.ledger.getAccount('a').balance, 60);
});

test('E: recovery is deterministic across all three fault points', () => {
  const states = [];
  for (const fault of ['beforeEvent', 'afterEvent', 'afterSnapshot']) {
    const journal = baseJournal();
    assert.throws(() => journal.commit(EVENT_E3, { fault }));
    states.push(recover(journal.toJSONL().split('\n')).ledger.getState());
  }
  assert.deepEqual(states[0], states[1]);
  assert.deepEqual(states[1], states[2]);
});
