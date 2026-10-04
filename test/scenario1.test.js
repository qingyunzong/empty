import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`../examples/scenario1/${name}`, import.meta.url), 'utf8'));

test('scenario 1: stats change crossing the join-order threshold flips the plan, result identical', () => {
  const engine = new Engine(load('catalog.json'), load('data.json'));
  const query = load('query.json');

  const before = engine.execute(query);
  assert.equal(before.cost, 105300); // pages 300 + 5000 + 100000
  assert.match(before.planString, /^InnerJoin\(b\.id=c\.b_id;InnerJoin\(a\.id=b\.a_id/);
  assert.equal(before.rows.length, 4);

  const report = engine.updateStats('c', load('stats-update.json'));
  assert.equal(report.table, 'c');
  assert.equal(report.invalidated, 1);

  const [chg] = report.affected;
  assert.notEqual(chg.oldPlan, chg.newPlan); // plan changed
  assert.equal(chg.oldCost, 105300);
  assert.equal(chg.newCost, 22300); // pages 300 + 2000 + 20000
  assert.match(chg.newPlan, /^InnerJoin\(a\.id=b\.a_id;InnerJoin\(b\.id=c\.b_id/);
  assert.equal(chg.hashChanged, false); // result identical
  assert.equal(chg.oldHash, chg.newHash);

  const after = engine.execute(query);
  assert.deepEqual(after.rows, before.rows);
  assert.equal(after.hash, before.hash);
});
