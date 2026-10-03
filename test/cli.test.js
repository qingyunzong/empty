import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCliSafe } from '../src/cli-main.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakeq-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'users.json'), JSON.stringify([
    { id: 1, name: 'ann', age: 30 },
    { id: 2, name: 'bob', age: null },
    { id: 3, name: 'cid', age: 40 },
  ]));
  fs.writeFileSync(path.join(dir, 'data', 'orders.json'), JSON.stringify([
    { id: 10, uid: 1, amount: 100 },
    { id: 11, uid: 1, amount: null },
    { id: 12, uid: null, amount: 50 },
  ]));
  fs.writeFileSync(path.join(dir, 'q.sql'),
    'SELECT u.name, COUNT(o.id) AS n FROM users u JOIN orders o ON o.uid = u.id GROUP BY u.name HAVING COUNT(o.id) > 0');
  return dir;
}

const run = (args) => {
  const r = runCliSafe(args);
  assert.equal(r.stderr, '', `unexpected stderr: ${r.stderr}`);
  assert.equal(r.code, 0);
  return JSON.parse(r.stdout);
};
const runFail = (args) => {
  const r = runCliSafe(args);
  assert.equal(r.code, 1, `expected failure, got stdout: ${r.stdout}`);
  return JSON.parse(r.stderr).error;
};

test('cli: sql runs a query and prints rows plus certificate', () => {
  const dir = setup();
  const out = run(['sql', path.join(dir, 'q.sql'), '--data', path.join(dir, 'data')]);
  assert.equal(out.rowCount, 1);
  assert.equal(out.rows[0].name, 'ann');
  assert.equal(out.rows[0].n, 2);
  assert.equal(out.unknownCount, 0);
  assert.equal(out.certificate.fullCheck.equal, true);
  assert.ok(out.certificate.rules.length >= 2);
});

test('cli: explain prints plans and writes plan files; verify proves equivalence', () => {
  const dir = setup();
  const q = path.join(dir, 'q.sql');
  const data = path.join(dir, 'data');
  const logicalFile = path.join(dir, 'logical.json');
  const optimizedFile = path.join(dir, 'optimized.json');
  const explained = run(['explain', q, '--data', data, '--stage', 'logical', '--out', logicalFile]);
  assert.ok(explained.logicalPlan);
  assert.ok(explained.optimizedPlan);
  assert.ok(Array.isArray(explained.physicalPlans));
  assert.ok(explained.physicalPlans.some((p) => p.chosen));
  run(['explain', q, '--data', data, '--out', optimizedFile]);
  const verified = run(['verify', logicalFile, optimizedFile, '--data', data]);
  assert.equal(verified.equivalent, true);
  assert.match(verified.hash, /^[0-9a-f]{64}$/);
});

test('cli: verify rejects a non-equivalent plan with E_NON_EQUIV', () => {
  const dir = setup();
  const data = path.join(dir, 'data');
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  run(['explain', path.join(dir, 'q.sql'), '--data', data, '--stage', 'logical', '--out', a]);
  const payload = JSON.parse(fs.readFileSync(a, 'utf8'));
  // corrupt the plan: change the HAVING threshold so results differ
  payload.plan.input.having.right.value = 99;
  fs.writeFileSync(b, JSON.stringify(payload));
  const err = runFail(['verify', a, b, '--data', data]);
  assert.equal(err.code, 'E_NON_EQUIV');
});

test('cli: verify accepts two SQL files with equivalent queries', () => {
  const dir = setup();
  const data = path.join(dir, 'data');
  fs.writeFileSync(path.join(dir, 'q2.sql'),
    'SELECT u.name, COUNT(o.id) AS n FROM users u JOIN orders o ON o.uid = u.id WHERE u.name IS NOT NULL GROUP BY u.name HAVING COUNT(o.id) > 0 AND 1 = 1');
  const out = run(['verify', path.join(dir, 'q.sql'), path.join(dir, 'q2.sql'), '--data', data]);
  assert.equal(out.equivalent, true);
});

test('cli: bench --rows N reports consistent hashes', () => {
  const out = run(['bench', '--rows', '5000']);
  assert.equal(out.rows, 5000);
  assert.equal(out.equal, true);
  assert.equal(out.directHash, out.optimizedHash);
  assert.ok(out.optimizedMs >= 0 && out.directMs >= 0);
});

test('cli: error codes E_PARSE, E_TYPE, E_UNSUPPORTED', () => {
  const dir = setup();
  const data = path.join(dir, 'data');
  fs.writeFileSync(path.join(dir, 'bad.sql'), 'SELECT FROM WHERE');
  assert.equal(runFail(['sql', path.join(dir, 'bad.sql'), '--data', data]).code, 'E_PARSE');

  fs.writeFileSync(path.join(dir, 'unsup.sql'), 'SELECT u.name FROM users u ORDER BY u.name');
  assert.equal(runFail(['sql', path.join(dir, 'unsup.sql'), '--data', data]).code, 'E_UNSUPPORTED');

  fs.writeFileSync(path.join(dir, 'type.sql'), 'SELECT SUM(u.name) AS s FROM users u');
  assert.equal(runFail(['sql', path.join(dir, 'type.sql'), '--data', data]).code, 'E_TYPE');

  fs.writeFileSync(path.join(dir, 'unknowncol.sql'), 'SELECT u.nope FROM users u');
  assert.equal(runFail(['sql', path.join(dir, 'unknowncol.sql'), '--data', data]).code, 'E_TYPE');

  fs.writeFileSync(path.join(dir, 'mixed.sql'), "SELECT u.id FROM users u WHERE u.age > 'abc'");
  assert.equal(runFail(['sql', path.join(dir, 'mixed.sql'), '--data', data]).code, 'E_TYPE');
});
