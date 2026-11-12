import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JoinIterator, createJoinIterator } from '../src/iterator.ts';
import { reduceJoin } from '../src/reduction.ts';
import type { JoinInput, Row } from '../src/types.ts';
import {
  allAttributes,
  bruteForceJoin,
  joinKey,
  relation,
} from './helpers.ts';

test('full pipeline: validation, reduction, paged enumeration and reference agreement', () => {
  const input: JoinInput = {
    relations: [
      relation('orders', ['oid', 'cid', 'pid'], [
        { oid: 1n, cid: 7n, pid: 3n },
        { oid: 2n, cid: 8n, pid: 3n },
        { oid: 3n, cid: 7n, pid: 4n },
        { oid: 4n, cid: 9n, pid: 5n },
        { oid: 4n, cid: 9n, pid: 5n },
      ]),
      relation('customers', ['cid', 'city'], [
        { cid: 7n, city: 'BJ' },
        { cid: 8n, city: 'SH' },
        { cid: 10n, city: 'GZ' },
      ]),
      relation('products', ['pid', 'pname'], [
        { pid: 3n, pname: 'bolt' },
        { pid: 4n, pname: 'nut' },
        { pid: 6n, pname: 'washer' },
      ]),
    ],
    edges: [
      ['orders', 'customers'],
      ['orders', 'products'],
    ],
  };

  const reduction = reduceJoin(input);
  assert.equal(reduction.plan.root, 'customers');
  assert.deepEqual(
    reduction.reports['orders'].rowReports
      .filter((report) => !report.alive)
      .map((report) => report.row.oid),
    [4n],
  );
  assert.deepEqual(
    reduction.reports['customers'].rowReports
      .filter((report) => !report.alive)
      .map((report) => report.row.cid),
    [10n],
  );
  assert.deepEqual(
    reduction.reports['products'].rowReports
      .filter((report) => !report.alive)
      .map((report) => report.row.pid),
    [6n],
  );

  const { result, iterator } = createJoinIterator(input);
  const attributes = allAttributes(input);
  const referenceKeys = bruteForceJoin(input)
    .map((row: Row) => joinKey(row, attributes))
    .sort();

  const gathered: string[] = [];
  let token: string | undefined;
  let rounds = 0;
  while (rounds < 10) {
    rounds += 1;
    const batch: ReturnType<JoinIterator['next']> = iterator.next(2, token);
    gathered.push(...batch.rows.map((row) => joinKey(row, attributes)));
    if (batch.done) {
      break;
    }
    token = batch.token;
  }

  assert.deepEqual(gathered.sort(), referenceKeys);
  assert.equal(new Set(gathered).size, gathered.length);
  assert.equal(gathered.length, result.reduced['orders'].length);
});

test('string-only natural join orders results by UTF-8 byte order at every vector level', () => {
  const input: JoinInput = {
    relations: [
      relation('a', ['k', 'av'], [
        { k: 'x', av: 'é' },
        { k: 'x', av: 'a' },
        { k: 'ä', av: 'z' },
      ]),
      relation('b', ['k', 'bv'], [
        { k: 'x', bv: '1' },
        { k: 'ä', bv: '2' },
      ]),
    ],
    edges: [['a', 'b']],
  };

  const { iterator } = createJoinIterator(input);
  const batch = iterator.next();
  assert.equal(batch.done, true);
  assert.deepEqual(
    batch.vectors,
    [
      [0, 0],
      [1, 1],
      [2, 0],
    ],
  );
  assert.deepEqual(
    batch.rows.map((row) => row.av),
    ['a', 'z', 'é'],
  );
  assert.deepEqual(
    batch.rows.map((row) => row.bv),
    ['1', '2', '1'],
  );
});

test('reduction is idempotent on its own reduced relations', () => {
  const input: JoinInput = {
    relations: [
      relation('r1', ['k'], [{ k: 1n }, { k: 2n }, { k: 3n }]),
      relation('r2', ['k', 'v'], [
        { k: 1n, v: 'a' },
        { k: 2n, v: 'b' },
      ]),
    ],
    edges: [['r1', 'r2']],
  };
  const first = reduceJoin(input);
  const secondInput: JoinInput = {
    relations: input.relations.map((item) => ({
      name: item.name,
      attributes: item.attributes,
      rows: first.reduced[item.name],
    })),
    edges: input.edges,
  };
  const second = reduceJoin(secondInput);
  for (const name of first.plan.relations) {
    assert.equal(second.reduced[name].length, first.reduced[name].length);
    assert.ok(second.reports[name].rowReports.every((report) => report.alive));
  }
});
