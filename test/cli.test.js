'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// NOTE: the CLI is exercised in-process via run() because this offline
// sandbox blocks child-process spawning; cli.js itself is a thin wrapper
// around run() (see RESULTS.md for real `node cli.js ...` invocations).
const { run } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
}

const SKIP = '[^|]*';
const rulesDoc = {
  rules: [
    { id: 'cny-credit', pattern: [SKIP, SKIP, 'CNY', SKIP, 'credit', SKIP].join('\\|'), decision: 'flag' },
  ],
};

function writeFixtures(dir) {
  const rulesPath = path.join(dir, 'rules.json');
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(rulesPath, JSON.stringify(rulesDoc));
  const rec = (over) => JSON.stringify({
    batch: 'B1', account: 'A1', currency: 'CNY', amount: 10,
    direction: 'credit', timestamp: '2026-10-01T08:00:00Z', ...over,
  });
  fs.writeFileSync(ledgerPath, [rec({ amount: 10 }), rec({ amount: 20.5 }), rec({ currency: 'USD' })].join('\n') + '\n');
  return { rulesPath, ledgerPath };
}

test('CLI audit prints match and summary as JSON', () => {
  const dir = tmpdir();
  const { rulesPath, ledgerPath } = writeFixtures(dir);
  const res = run(['audit', rulesPath, ledgerPath]);
  assert.strictEqual(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.match.length, 3);
  assert.deepStrictEqual(out.match.map((m) => m.decision), ['flag', 'flag', 'none']);
  assert.deepStrictEqual(out.summary.flaggedByCurrency, { CNY: 30.5 });
});

test('CLI equiv prints equiv and witness', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  fs.writeFileSync(a, JSON.stringify({ rules: [{ id: 'x', pattern: '0*1*', decision: 'flag' }] }));
  fs.writeFileSync(b, JSON.stringify({ rules: [{ id: 'y', pattern: '0*', decision: 'flag' }, { id: 'z', pattern: '1*', decision: 'flag' }] }));
  const res = run(['equiv', a, b]);
  assert.strictEqual(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.equiv, false);
  assert.strictEqual(out.witness, '01');
  assert.strictEqual(out.side, 'A');

  const res2 = run(['equiv', b, b]);
  assert.strictEqual(JSON.parse(res2.stdout).equiv, true);
});

test('CLI minimize prints a verifiable certificate', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'rules.json');
  fs.writeFileSync(p, JSON.stringify({ rules: [{ id: 'x', pattern: 'a*', decision: 'flag' }] }));
  const res = run(['minimize', p]);
  assert.strictEqual(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.minimized.states, 2);
  assert.strictEqual(out.minimized.certificateValid, true);
  assert.ok(Array.isArray(out.minimized.certificate.distinguishing));
});

test('CLI apply/snapshot/undo round-trip and error codes', () => {
  const dir = tmpdir();
  const { rulesPath } = writeFixtures(dir);
  const statePath = path.join(dir, 'state.json');

  let res = run(['apply', rulesPath, '--state', statePath]);
  assert.strictEqual(res.code, 0, res.stderr);
  const hash1 = JSON.parse(res.stdout).hash;

  res = run(['snapshot', '--state', statePath]);
  assert.strictEqual(JSON.parse(res.stdout).snapshots, 1);

  const rules2 = path.join(dir, 'rules2.json');
  fs.writeFileSync(rules2, JSON.stringify({ rules: [{ id: 'r2', pattern: 'b*', decision: 'pass' }] }));
  res = run(['apply', rules2, '--state', statePath]);
  assert.notStrictEqual(JSON.parse(res.stdout).hash, hash1);

  res = run(['undo', '--state', statePath]);
  assert.strictEqual(JSON.parse(res.stdout).hash, hash1);

  res = run(['undo', '--state', statePath]);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(JSON.parse(res.stderr).error.code, 'NO_SNAPSHOT');
});

test('CLI apply with a bad regex exits 1 with BAD_REGEX and writes no state', () => {
  const dir = tmpdir();
  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, JSON.stringify({ rules: [{ id: 'bad', pattern: 'a+', decision: 'flag' }] }));
  const statePath = path.join(dir, 'state.json');
  const res = run(['apply', badPath, '--state', statePath]);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(JSON.parse(res.stderr).error.code, 'BAD_REGEX');
  assert.ok(!fs.existsSync(statePath));
});

test('CLI audit with a bad ledger line exits 1 with BAD_LINE', () => {
  const dir = tmpdir();
  const { rulesPath, ledgerPath } = writeFixtures(dir);
  fs.appendFileSync(ledgerPath, '{broken\n');
  const res = run(['audit', rulesPath, ledgerPath]);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(JSON.parse(res.stderr).error.code, 'BAD_LINE');
});
