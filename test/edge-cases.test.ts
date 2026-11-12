import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputFingerprint } from '../src/canonical.ts';
import { createJoinIterator, resumeJoinIterator } from '../src/iterator.ts';
import { reduceJoin } from '../src/reduction.ts';
import type { JoinInput } from '../src/types.ts';
import {
  allAttributes,
  bruteForceJoin,
  emptySharedKeyInput,
  joinKey,
  relation,
} from './helpers.ts';

test('relations without attributes contribute a single distinct empty row', () => {
  const input: JoinInput = {
    relations: [
      relation('unit', [], [{}, {}, {}]),
      relation('data', ['x'], [{ x: 1n }, { x: 2n }]),
    ],
    edges: [['unit', 'data']],
  };
  const result = reduceJoin(input);
  assert.equal(result.reports['unit'].rowReports.length, 1);
  assert.equal(result.reduced['unit'].length, 1);
  assert.equal(result.reduced['data'].length, 2);

  const { iterator } = createJoinIterator(input);
  const batch = iterator.next();
  assert.equal(batch.done, true);
  assert.equal(batch.rows.length, 2);
});

test('fingerprint is stable under row and relation reordering', () => {
  const base: JoinInput = {
    relations: [
      relation('r1', ['k'], [{ k: 2n }, { k: 1n }]),
      relation('r2', ['k', 'v'], [{ k: 1n, v: 'a' }]),
    ],
    edges: [['r1', 'r2']],
  };
  const reordered: JoinInput = {
    relations: [
      relation('r2', ['k', 'v'], [{ k: 1n, v: 'a' }]),
      relation('r1', ['k'], [{ k: 1n }, { k: 2n }]),
    ],
    edges: [['r2', 'r1']],
  };
  assert.equal(inputFingerprint(base), inputFingerprint(reordered));
});

test('chained resumable pages each return a token until the final page', () => {
  const input: JoinInput = {
    relations: [
      relation('a', ['k'], [{ k: 1n }, { k: 2n }, { k: 3n }, { k: 4n }]),
      relation('b', ['k'], [{ k: 1n }, { k: 2n }, { k: 3n }]),
    ],
    edges: [['a', 'b']],
  };
  const expected = bruteForceJoin(input).map((row) => joinKey(row, allAttributes(input))).sort();

  let token: string | undefined;
  const seen: string[] = [];
  for (let page = 0; page < 3; page += 1) {
    const batch = resumeJoinIterator(input, token, 1);
    seen.push(...batch.rows.map((row) => joinKey(row, allAttributes(input))));
    assert.equal(batch.done, false);
    assert.ok(batch.token);
    token = batch.token;
  }
  const tail = resumeJoinIterator(input, token!);
  seen.push(...tail.rows.map((row) => joinKey(row, allAttributes(input))));
  assert.equal(tail.done, true);
  assert.equal(tail.token, undefined);
  assert.deepEqual(seen.sort(), expected);
});

test('empty shared attributes still enumerate a Cartesian product exactly once', () => {
  const input = emptySharedKeyInput(
    [{ a: 1n }, { a: 2n }, { a: 3n }],
    [{ b: 'p' }, { b: 'q' }],
  );
  const reference = bruteForceJoin(input);
  const { iterator } = createJoinIterator(input);
  const batch = iterator.next();
  assert.equal(batch.rows.length, reference.length);
  const keys = batch.rows.map((row) => joinKey(row, allAttributes(input)));
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys.sort(), reference.map((row) => joinKey(row, allAttributes(input))).sort());
});

test('empty input and invalid names are rejected with explicit errors', () => {
  assert.throws(
    () => reduceJoin({ relations: [], edges: [] }),
    /at least one relation/,
  );
  assert.throws(
    () =>
      reduceJoin({
        relations: [relation('', ['x'], [{ x: 1n }])],
        edges: [],
      }),
    /non-empty/,
  );
});
