import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../src/canonical.ts';
import { JoinEngineError } from '../src/errors.ts';
import { JoinIterator, createJoinIterator, resumeJoinIterator } from '../src/iterator.ts';
import { reduceJoin } from '../src/reduction.ts';
import type { JoinInput } from '../src/types.ts';
import {
  allAttributes,
  bruteForceJoin,
  emptyRelationInput,
  joinKey,
  lineInput,
  relation,
  sameAttributeAcrossPathInput,
  starInput,
} from './helpers.ts';

function collectedKeys(input: JoinInput): string[] {
  const { iterator } = createJoinIterator(input);
  const batch = iterator.next();
  assert.equal(batch.done, true);
  assert.equal(batch.token, undefined);
  return batch.rows.map((row) => joinKey(row, allAttributes(input)));
}

test('enumeration equals the brute-force natural join with every result exactly once', () => {
  for (const input of [
    lineInput(),
    starInput(),
    sameAttributeAcrossPathInput(),
    {
      relations: [relation('solo', ['x'], [{ x: 1n }, { x: 2n }, { x: 3n }])],
      edges: [],
    } satisfies JoinInput,
  ]) {
    const expected = bruteForceJoin(input)
      .map((row) => joinKey(row, allAttributes(input)))
      .sort();
    assert.deepEqual(collectedKeys(input).sort(), expected);
    assert.equal(new Set(collectedKeys(input)).size, collectedKeys(input).length);
  }
});

test('selection vectors follow lexicographic order over relation names and canonical row order', () => {
  const { result, iterator } = createJoinIterator(starInput());
  const batch = iterator.next();
  assert.deepEqual(result.plan.relations, ['center', 'leaf_a', 'leaf_b']);
  for (let index = 1; index < batch.vectors.length; index += 1) {
    const previous = batch.vectors[index - 1];
    const current = batch.vectors[index];
    let compared = 0;
    for (let position = 0; position < previous.length; position += 1) {
      compared = Math.sign(current[position] - previous[position]);
      if (compared !== 0) {
        break;
      }
    }
    assert.equal(compared, 1);
  }
});

test('hitting a limit returns a resumable pause rather than claiming completeness', () => {
  const input = lineInput();
  const { iterator } = createJoinIterator(input);
  const first = iterator.next(1);
  assert.equal(first.done, false);
  assert.equal(first.vectors.length, 1);
  assert.ok(first.token);

  const second = iterator.next(1, first.token);
  assert.equal(second.vectors.length, 1);
  assert.notDeepEqual(second.vectors, first.vectors);

  const rest = iterator.next(undefined, second.token!);
  assert.equal(rest.done, true);

  const expected = bruteForceJoin(input).map((row) => joinKey(row, allAttributes(input))).sort();
  const gathered = [...first.rows, ...second.rows, ...rest.rows]
    .map((row) => joinKey(row, allAttributes(input)))
    .sort();
  assert.deepEqual(gathered, expected);
});

test('every pause position resumes without skipping or repeating a vector', () => {
  const input = starInput();
  const expected = bruteForceJoin(input).map((row) => joinKey(row, allAttributes(input))).sort();

  for (const pageSize of [1, 2, 3]) {
    const { iterator } = createJoinIterator(input);
    const seen: string[] = [];
    let token: string | undefined;
    let guard = 0;
    while (guard < 100) {
      guard += 1;
      const batch = iterator.next(pageSize, token);
      seen.push(...batch.rows.map((row) => joinKey(row, allAttributes(input))));
      if (batch.done) {
        assert.equal(batch.token, undefined);
        break;
      }
      token = batch.token;
    }
    assert.deepEqual(seen.sort(), expected);
    assert.equal(new Set(seen).size, seen.length);
  }
});

test('a fresh iterator can resume directly from a persisted token', () => {
  const input = lineInput();
  const first = createJoinIterator(input).iterator.next(1);
  assert.ok(first.token);
  const continued = resumeJoinIterator(input, first.token!, 1);
  const tail = resumeJoinIterator(input, continued.token!);

  const all = [...first.rows, ...continued.rows, ...tail.rows]
    .map((row) => joinKey(row, allAttributes(input)))
    .sort();
  assert.deepEqual(all, bruteForceJoin(input).map((row) => joinKey(row, allAttributes(input))).sort());
  assert.equal(tail.done, true);
});

test('resuming after the final batch yields an empty done batch', () => {
  const { iterator } = createJoinIterator(starInput());
  const finished = iterator.next();
  assert.equal(finished.done, true);
  const again = iterator.next(3);
  assert.equal(again.done, true);
  assert.deepEqual(again.vectors, []);
});

test('empty reduced relations produce no join rows and require no token', () => {
  const { result, iterator } = createJoinIterator(emptyRelationInput());
  assert.equal(result.isEmpty, true);
  const batch = iterator.next(5);
  assert.equal(batch.done, true);
  assert.deepEqual(batch.rows, []);
  assert.equal(batch.token, undefined);
});

test('tokens reject a changed immutable input', () => {
  const input = lineInput();
  const token = createJoinIterator(input).iterator.next(1).token!;
  const modified: JoinInput = {
    ...input,
    relations: input.relations.map((item) =>
      item.name === 'supplier'
        ? { ...item, rows: [...item.rows, { sid: 77n, city: 'SZ' }] }
        : item,
    ),
  };
  assert.throws(
    () => resumeJoinIterator(modified, token),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'TOKEN_INPUT_MISMATCH',
  );
});

test('tokens reject checksum corruption and malformed payloads', () => {
  const token = createJoinIterator(lineInput()).iterator.next(1).token!;
  const [payload, checksum] = token.split('.');
  const tamperedChecksum = `${payload}.${sha256Hex(checksum)}`;
  assert.throws(
    () => resumeJoinIterator(lineInput(), tamperedChecksum),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'TOKEN_CORRUPT',
  );

  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const changedJson = decoded.replace('"index":0', '"index":999999');
  const reencoded = Buffer.from(changedJson, 'utf8').toString('base64url');
  const staleChecksumToken = `${reencoded}.${checksum}`;
  assert.throws(
    () => resumeJoinIterator(lineInput(), staleChecksumToken),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'TOKEN_CORRUPT',
  );

  assert.throws(
    () => resumeJoinIterator(lineInput(), 'garbage'),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'TOKEN_CORRUPT',
  );
});

test('a structurally valid but checksum-correct cursor outside the table is rejected', () => {
  const result = reduceJoin(lineInput());
  const iterator = new JoinIterator(result);
  const token = iterator.next(1).token!;
  const [payload] = token.split('.');
  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const changed = decoded.replace('"index":0', '"index":999999');
  const reencoded = Buffer.from(changed, 'utf8').toString('base64url');
  const reChecksummed = `${reencoded}.${sha256Hex(changed)}`;
  assert.throws(
    () => resumeJoinIterator(lineInput(), reChecksummed),
    (error: unknown) => error instanceof JoinEngineError && error.code === 'TOKEN_CORRUPT',
  );
});

test('limits must be positive integers', () => {
  const { iterator } = createJoinIterator(lineInput());
  for (const bad of [0, -1, 1.5]) {
    assert.throws(
      () => iterator.next(bad),
      (error: unknown) => error instanceof JoinEngineError && error.code === 'INVALID_LIMIT',
    );
  }
});
