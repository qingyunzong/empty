import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';
import { QueryError } from '../src/query.js';

const load = (dir, name) =>
  JSON.parse(readFileSync(new URL(`../examples/${dir}/${name}`, import.meta.url), 'utf8'));

test('updateStats invalidates only plans referencing the updated table', () => {
  const engine = new Engine(load('scenario1', 'catalog.json'), load('scenario1', 'data.json'));
  const joinQuery = load('scenario1', 'query.json');
  const scanOnlyQuery = { scan: 'a', filter: [{ col: 'a.id', op: '>', value: 1 }] };

  engine.explain(joinQuery);
  engine.explain(scanOnlyQuery);
  assert.equal(engine.cache.size, 2);

  const report = engine.updateStats('c', { rowCount: 400 });
  assert.equal(report.invalidated, 1);
  assert.equal(report.affected[0].query.scan, 'a');
  assert.equal(report.affected[0].query.joins.length, 2);

  // The untouched plan survived invalidation (cache still holds both).
  assert.equal(engine.cache.size, 2);
  const scanPlan = engine.explain(scanOnlyQuery);
  assert.match(scanPlan.planString, /^SeqScan\(a\)\[/);
});

test('updateStats on unknown table is an error', () => {
  const engine = new Engine(load('scenario1', 'catalog.json'));
  assert.throws(() => engine.updateStats('ghost', {}), QueryError);
});

test('updateStats with no dependent cached plans invalidates nothing', () => {
  const engine = new Engine(load('scenario1', 'catalog.json'), load('scenario1', 'data.json'));
  engine.explain({ scan: 'a' });
  const report = engine.updateStats('c', { rowCount: 10 });
  assert.equal(report.invalidated, 0);
  assert.deepEqual(report.affected, []);
});
