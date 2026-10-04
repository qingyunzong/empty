import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ReplaceSession } from '../src/session';
import { BudgetExceededError } from '../src/replace';
import { InvalidReferenceError } from '../src/template';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

test('each round binds a pre-image summary and can be rolled back', () => {
  const session = new ReplaceSession('foo bar');
  const r1 = session.applyRound(
    [{ start: 4, end: 7, captures: [{ start: 4, end: 7 }] }],
    ['baz-$1'],
  );
  assert.equal(session.current, 'foo baz-bar');
  assert.equal(r1.summary.round, 0);
  assert.equal(r1.summary.length, 7);
  assert.equal(r1.summary.sha256, sha256('foo bar'));
  assert.equal(session.roundCount, 1);

  const r2 = session.applyRound([{ start: 0, end: 3, captures: [] }], ['FOO']);
  assert.equal(session.current, 'FOO baz-bar');
  assert.equal(r2.summary.sha256, sha256('foo baz-bar'));
  assert.deepEqual(
    session.history().map((s) => s.length),
    [7, 11],
  );

  const undone2 = session.rollback();
  assert.equal(undone2?.sha256, sha256('foo baz-bar'));
  assert.equal(session.current, 'foo baz-bar');
  const undone1 = session.rollback();
  assert.equal(undone1?.sha256, sha256('foo bar'));
  assert.equal(session.current, 'foo bar');
  assert.equal(session.rollback(), null);
  assert.equal(session.composedMap(), null);
});

test('composed map spans all applied rounds', () => {
  const session = new ReplaceSession('abc');
  session.applyRound([{ start: 1, end: 2, captures: [] }], ['XY']); // aXYc
  session.applyRound([{ start: 3, end: 4, captures: [{ start: 3, end: 4 }] }], ['$1$1']); // aXYcc
  const map = session.composedMap();
  assert.ok(map);
  assert.equal(map.inLength, 3);
  assert.equal(map.outLength, 5);
  assert.equal(map.forward(0), 0);
  assert.equal(map.forward(1), null);
  assert.equal(map.forward(3), 2);
  assert.equal(map.forward(4), 2); // duplicated 'c'
  assert.deepEqual(map.inverse(2), [
    { start: 3, end: 4 },
    { start: 4, end: 5 },
  ]);
});

test('failed rounds (invalid reference, budget) do not modify the session', () => {
  const session = new ReplaceSession('keep me');
  session.applyRound([{ start: 0, end: 4, captures: [] }], ['keep']);
  const before = session.current;
  const rounds = session.roundCount;
  assert.throws(
    () => session.applyRound([{ start: 0, end: 4, captures: [] }], ['$1']),
    InvalidReferenceError,
  );
  assert.throws(
    () => session.applyRound([{ start: 0, end: 4, captures: [] }], ['way too long'], {
      maxOutputLength: 3,
    }),
    BudgetExceededError,
  );
  assert.equal(session.current, before);
  assert.equal(session.roundCount, rounds);
  assert.equal(session.history().length, rounds);
});
