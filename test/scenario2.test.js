import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../examples/scenario2/${name}`, import.meta.url), 'utf8'));

test('scenario 2: predicate on null-padded column stays above the left join (no inner-join rewrite)', () => {
  const engine = new Engine(load('catalog.json'), load('data.json'));
  const r = engine.execute(load('query.json'));

  // The plan keeps the LeftJoin and evaluates the predicate above it.
  assert.equal(
    r.planString,
    'Filter(profiles.city="bj";LeftJoin(users.id=profiles.user_id;SeqScan(users);SeqScan(profiles)))',
  );
  assert.ok(!r.planString.includes('InnerJoin'));
  // The predicate is not pushed into the null-supplying scan.
  assert.ok(!r.planString.includes('SeqScan(profiles)['));

  // Null-padded rows (users 3 and 4) are produced by the join, then filtered
  // out above it; only genuinely matching rows survive.
  assert.equal(r.rows.length, 2);
  assert.deepEqual(
    r.rows.map((row) => [row['users.name'], row['profiles.city']]),
    [['ann', 'bj'], ['bob', 'bj']],
  );
});

test('scenario 2: left join without the predicate keeps null-padded rows', () => {
  const engine = new Engine(load('catalog.json'), load('data.json'));
  const r = engine.execute({
    scan: 'users',
    joins: [{ type: 'left', table: 'profiles', on: [['users.id', 'profiles.user_id']] }],
  });
  assert.equal(r.rows.length, 5); // bob matches two profiles
  const padded = r.rows.filter((row) => row['profiles.city'] === null);
  assert.deepEqual(padded.map((row) => row['users.name']).sort(), ['cat', 'dan']);
});
