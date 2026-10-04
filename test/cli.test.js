'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../src/cli');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lakeql-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 't.json'), JSON.stringify([
    { id: 1, k: 1, v: 10 },
    { id: 2, k: 1, v: 20 },
    { id: 3, k: 2, v: 30 },
  ]));
  fs.writeFileSync(path.join(data, 'u.json'), JSON.stringify([
    { k: 1, w: 5 },
    { k: 2, w: 7 },
  ]));
  const q1 = path.join(dir, 'q1.sql');
  fs.writeFileSync(q1, 'SELECT t.k, SUM(t.v) AS s FROM t JOIN u ON t.k = u.k GROUP BY t.k');
  const q1b = path.join(dir, 'q1b.sql');
  fs.writeFileSync(q1b, 'SELECT t.k, SUM(t.v) AS s FROM t JOIN u ON t.k = u.k WHERE t.v > 0 GROUP BY t.k');
  const q2 = path.join(dir, 'q2.sql');
  fs.writeFileSync(q2, 'SELECT t.k, COUNT(*) AS c FROM t GROUP BY t.k');
  const bad = path.join(dir, 'bad.sql');
  fs.writeFileSync(bad, 'SELECT FROM WHERE');
  return { dir, data, q1, q1b, q2, bad };
}

test('cli: sql runs a query and emits a certificate', () => {
  const { data, q1 } = setup();
  const r = run(['sql', q1, '--data', data]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.rows.length, 2);
  assert.equal(out.certificate.equal, true);
  assert.ok(out.certificate.rules.some((x) => x.rule === 'aggregate_pushdown'));
});

test('cli: explain shows plans, rules, ties and certificate', () => {
  const { data, q1 } = setup();
  const r = run(['explain', q1, '--data', data]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /== Logical Plan ==/);
  assert.match(r.stdout, /== Optimized Plan ==/);
  assert.match(r.stdout, /min cost = \d+, \d+ plan\(s\) tied/);
  assert.match(r.stdout, /equal: true/);
});

test('cli: verify accepts equivalent plans and rejects different ones', () => {
  const { data, q1, q1b, q2 } = setup();
  const same = run(['verify', q1, q1b, '--data', data]);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /EQUIV/);
  const diff = run(['verify', q1, q2, '--data', data]);
  assert.equal(diff.code, 1);
  assert.match(diff.stderr, /E_NON_EQUIV/);
});

test('cli: verify rejects a corrupted (wrongly rewritten) plan instead of approximating', () => {
  const { dir, data, q1 } = setup();
  // Produce the optimized plan JSON, then corrupt it: SUM -> COUNT changes results.
  const ex = run(['explain', q1, '--data', data, '--json']);
  assert.equal(ex.code, 0, ex.stderr);
  const planObj = JSON.parse(ex.stdout);
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify(planObj.optimized));
  const ok = run(['verify', q1, good, '--data', data]);
  assert.equal(ok.code, 0, ok.stderr);

  const corrupted = JSON.parse(JSON.stringify(planObj.optimized));
  // wrong rewrite: SUM -> COUNT, wherever the groupby sits in the plan
  const findGroupby = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (n.op === 'groupby') return n;
    return findGroupby(n.input) || findGroupby(n.left) || findGroupby(n.right);
  };
  findGroupby(corrupted).aggs[0].func = 'COUNT';
  const badPlan = path.join(dir, 'bad.json');
  fs.writeFileSync(badPlan, JSON.stringify(corrupted));
  const rej = run(['verify', q1, badPlan, '--data', data]);
  assert.equal(rej.code, 1);
  assert.match(rej.stderr, /E_NON_EQUIV/);
});

test('cli: parse errors exit 1 with E_PARSE', () => {
  const { data, bad } = setup();
  const r = run(['sql', bad, '--data', data]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_PARSE/);
});

test('cli: bench runs hash vs nested loop', () => {
  const r = run(['bench', '--rows', '500']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.rows, 500);
  assert.ok(out.matched > 0);
  assert.ok(out.hashJoinMs >= 0 && out.nestedLoopMs >= 0);
});
