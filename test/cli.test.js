// CLI tests run the command dispatcher in-process (the sandbox forbids
// spawning child processes); bin/evpack.js is a thin wrapper around run().
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

let tmp;
let packDir;
let home;
let savedHome;

function cli(args) {
  let stdout = '';
  let stderr = '';
  const code = run(
    args,
    { write: (s) => { stdout += s; } },
    { write: (s) => { stderr += s; } },
  );
  return { code, stdout, stderr };
}

// a+b=110 asserted, c=50 unknown: completions 110 (fail) and 160 (pass)
const CLAIM = JSON.stringify({
  select: { op: 'notnull', field: 'amount' },
  aggregate: { op: 'sum', field: 'amount' },
  cmp: { op: 'gte', value: 150 },
});

// a+b=110 passes at threshold 100; retracting b leaves 60/110 -> undecided
const CLAIM_PASS = JSON.stringify({
  select: { op: 'notnull', field: 'amount' },
  aggregate: { op: 'sum', field: 'amount' },
  cmp: { op: 'gte', value: 100 },
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evpack-'));
  packDir = path.join(tmp, 'pack');
  home = path.join(tmp, 'state');
  fs.mkdirSync(packDir);
  fs.writeFileSync(path.join(packDir, 'evidence.jsonl'), [
    JSON.stringify({ key: 'a', status: 'asserted', fields: { amount: 60 } }),
    JSON.stringify({ key: 'b', status: 'asserted', fields: { amount: 50 } }),
    JSON.stringify({ key: 'c', status: 'unknown', fields: { amount: 50 } }),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(packDir, 'rules.json'), JSON.stringify([
    { id: 'r1', priority: 3, when: { op: 'lt', field: 'amount', value: 0 } },
  ]));
  savedHome = process.env.EVPACK_HOME;
  process.env.EVPACK_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.EVPACK_HOME;
  else process.env.EVPACK_HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('load imports evidence and rules into the state dir', () => {
  const r = cli(['load', packDir]);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.loaded, { evidence: 3, rules: 1 });
  assert.ok(fs.existsSync(path.join(home, 'state.json')));
});

test('verify exits with E_UNDECIDED when unknown evidence is pending', () => {
  cli(['load', packDir]);
  const r = cli(['verify', CLAIM]);
  assert.equal(r.code, 4);
  assert.match(r.stderr, /E_UNDECIDED/);
  assert.equal(JSON.parse(r.stdout).conclusion, 'undecided');
});

test('retract flips a passing claim to undecided, not fail', () => {
  fs.writeFileSync(path.join(packDir, 'evidence.jsonl'), [
    JSON.stringify({ key: 'a', status: 'asserted', fields: { amount: 60 } }),
    JSON.stringify({ key: 'b', status: 'asserted', fields: { amount: 50 } }),
    '',
  ].join('\n'));
  cli(['load', packDir]);
  assert.equal(JSON.parse(cli(['verify', CLAIM_PASS]).stdout).conclusion, 'pass');
  assert.equal(cli(['retract', 'b']).code, 0);
  const r = cli(['verify', CLAIM_PASS]);
  assert.equal(r.code, 4);
  const out = JSON.parse(r.stdout);
  assert.equal(out.conclusion, 'undecided');
  assert.notEqual(out.conclusion, 'fail');
  assert.deepEqual(out.undecided, ['b']);
});

test('retract of unknown key exits with E_EVIDENCE_GONE', () => {
  cli(['load', packDir]);
  const r = cli(['retract', 'nope']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /E_EVIDENCE_GONE/);
});

test('rule add persists; duplicate exits with E_DUP_RULE', () => {
  cli(['load', packDir]);
  const added = JSON.parse(cli(['rule', 'add', JSON.stringify({ id: 'r2', priority: 9, when: { op: 'true' } })]).stdout);
  assert.equal(added.added, 'r2');
  const dup = cli(['rule', 'add', JSON.stringify({ id: 'r2', priority: 1 })]);
  assert.equal(dup.code, 2);
  assert.match(dup.stderr, /E_DUP_RULE/);
});

test('cert issues a certificate; check accepts it and rejects tampering', () => {
  cli(['load', packDir]);
  const certFile = path.join(tmp, 'cert.json');
  assert.equal(cli(['cert', CLAIM, certFile]).code, 0);
  const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  assert.equal(cert.conclusion, 'undecided');
  assert.deepEqual(cert.undecided, ['c']);
  assert.ok(cert.inputHash && cert.rulesVersion && cert.certHash);

  const ok = cli(['check', certFile]);
  assert.equal(ok.code, 0);
  assert.equal(JSON.parse(ok.stdout).cert, 'ok');

  const tampered = { ...cert, conclusion: 'pass' };
  const tamperedFile = path.join(tmp, 'tampered.json');
  fs.writeFileSync(tamperedFile, JSON.stringify(tampered));
  const bad = cli(['check', tamperedFile]);
  assert.equal(bad.code, 5);
  assert.match(bad.stderr, /E_CERT_MISMATCH/);
});

test('check fails with E_CERT_MISMATCH after evidence changes', () => {
  cli(['load', packDir]);
  const certFile = path.join(tmp, 'cert.json');
  cli(['cert', CLAIM, certFile]);
  cli(['retract', 'a']);
  const r = cli(['check', certFile]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /E_CERT_MISMATCH/);
});
