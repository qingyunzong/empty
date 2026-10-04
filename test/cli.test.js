import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCommand } from '../src/commands.js';
import { QueryError } from '../src/query.js';

const load = (dir, name) =>
  JSON.parse(readFileSync(new URL(`../examples/${dir}/${name}`, import.meta.url), 'utf8'));

test('cli explain prints plan and cost', () => {
  const out = runCommand('explain', {
    catalog: load('scenario1', 'catalog.json'),
    query: load('scenario1', 'query.json'),
  });
  assert.match(out, /plan \(cost 105300\):/);
  assert.match(out, /InnerJoin\(b\.id=c\.b_id\)/);
  assert.match(out, /plan-string: InnerJoin\(/);
});

test('cli execute prints rows and hash', () => {
  const out = runCommand('execute', {
    catalog: load('scenario2', 'catalog.json'),
    data: load('scenario2', 'data.json'),
    query: load('scenario2', 'query.json'),
  });
  assert.match(out, /Filter\(profiles\.city="bj"\)/);
  assert.match(out, /LeftJoin\(users\.id=profiles\.user_id\)/);
  assert.match(out, /hash: [0-9a-f]{64}/);
});

test('cli update-stats reports old/new plan, cost and hash delta', () => {
  const out = runCommand('update-stats', {
    catalog: load('scenario1', 'catalog.json'),
    data: load('scenario1', 'data.json'),
    query: load('scenario1', 'query.json'),
    table: 'c',
    stats: load('scenario1', 'stats-update.json'),
  });
  assert.match(out, /invalidated plans: 1/);
  assert.match(out, /old plan \(cost 105300\)/);
  assert.match(out, /new plan \(cost 22300\)/);
  assert.match(out, /hash delta: unchanged/);
});

test('cli commands raise QueryError for illegal queries', () => {
  const catalog = load('scenario3', 'catalog.json');
  assert.throws(
    () => runCommand('explain', { catalog, query: load('scenario3', 'query-unknown-column.json') }),
    (e) => e instanceof QueryError && /unknown column: users\.nope/.test(e.message),
  );
  assert.throws(
    () => runCommand('explain', { catalog, query: load('scenario3', 'query-nested-aggregate.json') }),
    (e) => e instanceof QueryError && /nested aggregate is not allowed/.test(e.message),
  );
});
