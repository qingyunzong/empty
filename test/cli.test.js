import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cli-'));
  const home = path.join(dir, 'home');
  return { home: dir, gateHome: home, run: (args) => run(args, { home }) };
}

const errCode = (r) => {
  try {
    return JSON.parse(r.stderr.trim()).error.code;
  } catch {
    return null;
  }
};

const outJson = (r) => JSON.parse(r.stdout.trim().split('\n').at(-1));

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

const flowRules = {
  windows: { w: { size: 100, hop: 10, bounds: '(]' } },
  rules: [
    { id: 'temp_max', expr: 'temp <= 100' },
    { id: 'avg_ok', expr: 'avg(v) over w <= 50' },
  ],
  exemptions: [],
};

const flowObs = [
  { key: 'o1', ts: 10, metrics: { temp: 80, v: 10 } },
  { key: 'o2', ts: 20, metrics: { temp: 200, v: 20 } },
  { key: 'o3', ts: 30, metrics: { v: 30 } },
];

test('no arguments prints usage and exits 64', () => {
  const { run } = setup();
  const r = run([]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /usage:/);
});

test('init validates rules: E_RULE for bad expression, E_WINDOW for bad window', () => {
  const { home, run } = setup();
  const badExpr = writeJson(home, 'bad-expr.json', { rules: [{ id: 'r', expr: 'x <=' }] });
  let r = run(['init', badExpr]);
  assert.equal(r.code, 2);
  assert.equal(errCode(r), 'E_RULE');

  const badWindow = writeJson(home, 'bad-window.json', {
    windows: { w: { size: 100, bounds: '<>' } },
    rules: [{ id: 'r', expr: 'avg(v) over w <= 1' }],
  });
  r = run(['init', badWindow]);
  assert.equal(r.code, 3);
  assert.equal(errCode(r), 'E_WINDOW');
});

test('full CLI flow: init, obs, decide pass/fail/undecided, correct, replay', () => {
  const { home, run } = setup();
  const rulesFile = writeJson(home, 'rules.json', flowRules);
  let r = run(['init', rulesFile]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(outJson(r).ok, true);
  assert.match(outJson(r).rulesHash, /^[0-9a-f]{64}$/);

  const obsFile = path.join(home, 'obs.jsonl');
  fs.writeFileSync(obsFile, flowObs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  r = run(['obs', obsFile]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(outJson(r).ingested, 3);

  r = run(['decide', 'o1']);
  assert.equal(r.code, 0, r.stderr);
  let cert = outJson(r);
  assert.equal(cert.decision, 'pass');
  assert.deepEqual(cert.windowKeys, ['w:-90:10:(]']);
  assert.equal(cert.evaluations.find((e) => e.ruleId === 'temp_max').astHash.length, 64);

  r = run(['decide', 'o2']);
  assert.equal(r.code, 1);
  cert = outJson(r);
  assert.equal(cert.decision, 'fail');
  assert.deepEqual(cert.violations, ['temp_max']);

  // undecided blocks admission (exit 4 + E_UNDECIDED_BLOCK) but is not a violation
  r = run(['decide', 'o3']);
  assert.equal(r.code, 4);
  assert.equal(errCode(r), 'E_UNDECIDED_BLOCK');
  cert = outJson(r);
  assert.equal(cert.decision, 'undecided');
  assert.deepEqual(cert.violations, []);
  assert.deepEqual(cert.undecided, ['temp_max']);

  // correction brings o2 back into compliance through the same decision path
  r = run(['correct', 'o2', '{"metrics":{"temp":50}}']);
  assert.equal(r.code, 0, r.stderr);
  r = run(['decide', 'o2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(outJson(r).decision, 'pass');

  // replay after correction agrees with the incremental state
  r = run(['replay', '0', '100']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  const summary = lines.at(-1);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.count, 3);
  assert.equal(summary.consistent, true);
  assert.deepEqual(summary.decisions, { pass: 2, fail: 0, undecided: 1 });
  for (const c of lines.slice(0, -1)) assert.equal(c.consistent, true);

  // replay range filtering
  r = run(['replay', '15', '25']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(outJson(r).count, 1);
});

test('exemption tie exits 5 with E_EXEMPT', () => {
  const { home, run } = setup();
  const rulesFile = writeJson(home, 'rules.json', {
    rules: [{ id: 'temp_max', expr: 'temp <= 100' }],
    exemptions: [
      { id: 'x1', priority: 5, rules: ['temp_max'] },
      { id: 'x2', priority: 5, rules: ['temp_max'] },
    ],
  });
  assert.equal(run(['init', rulesFile]).code, 0);
  const obsFile = path.join(home, 'obs.jsonl');
  fs.writeFileSync(obsFile, JSON.stringify({ key: 'o1', ts: 1, metrics: { temp: 200 } }) + '\n');
  assert.equal(run(['obs', obsFile]).code, 0);
  const r = run(['decide', 'o1']);
  assert.equal(r.code, 5);
  assert.equal(errCode(r), 'E_EXEMPT');
});

test('exemption applies and decision passes with exemption chain', () => {
  const { home, run } = setup();
  const rulesFile = writeJson(home, 'rules.json', {
    rules: [{ id: 'temp_max', expr: 'temp <= 100' }],
    exemptions: [{ id: 'maint', priority: 5, rules: ['temp_max'], when: "site == 'A'" }],
  });
  assert.equal(run(['init', rulesFile]).code, 0);
  const obsFile = path.join(home, 'obs.jsonl');
  fs.writeFileSync(obsFile, JSON.stringify({ key: 'o1', ts: 1, metrics: { temp: 200, site: 'A' } }) + '\n');
  assert.equal(run(['obs', obsFile]).code, 0);
  const r = run(['decide', 'o1']);
  assert.equal(r.code, 0, r.stderr);
  const cert = outJson(r);
  assert.equal(cert.decision, 'pass');
  assert.equal(cert.exemptionChain[0].id, 'maint');
  assert.equal(cert.evaluations[0].exempted, true);
});

test('input errors exit 6 with E_INPUT', () => {
  const { home, run } = setup();
  const rulesFile = writeJson(home, 'rules.json', flowRules);
  assert.equal(run(['init', rulesFile]).code, 0);
  let r = run(['decide', 'missing']);
  assert.equal(r.code, 6);
  assert.equal(errCode(r), 'E_INPUT');
  r = run(['correct', 'missing', '{}']);
  assert.equal(r.code, 6);
  assert.equal(errCode(r), 'E_INPUT');
});
