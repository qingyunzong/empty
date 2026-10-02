import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { tmpdir, writePack } from './helpers.mjs';

function run(args, opts = {}) {
  const { code, stdout, stderr } = runCli(args, {});
  return { code, stdout, stderr, json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null };
}

function setupPack() {
  const dir = tmpdir();
  writePack(dir, [
    { key: 'd1', attrs: { type: 'kyc', amount: 10 } },
    { key: 'd2', attrs: { type: 'kyc', amount: 20 } },
    { key: 'd3', attrs: { type: 'kyc', amount: 30 } },
    { key: 'u1', state: 'unknown', attrs: { type: 'kyc', amount: 5 } },
  ]);
  assert.equal(run(['load', dir]).code, 0);
  return dir;
}

const CLAIM = JSON.stringify({
  where: [{ field: 'type', op: 'eq', value: 'kyc' }],
  aggregate: { op: 'count', field: '*' },
  expect: { op: 'gte', value: 3 },
});

test('cli: load -> verify -> cert -> cert --check happy path', () => {
  const dir = setupPack();
  const v = run(['verify', CLAIM, '--dir', dir]);
  assert.equal(v.code, 0);
  assert.equal(v.json.conclusion, 'pass'); // 3 asserted + 1 unknown, threshold 3
  assert.deepEqual(v.json.hits, ['d1', 'd2', 'd3']);
  assert.deepEqual(v.json.undecided, ['u1']);

  const certFile = path.join(dir, 'cert.json');
  const c = run(['cert', CLAIM, '--dir', dir, '--out', certFile]);
  assert.equal(c.code, 0);
  assert.equal(c.json.conclusion, 'pass');
  assert.ok(fs.existsSync(certFile));

  const chk = run(['cert', '--check', certFile, '--dir', dir]);
  assert.equal(chk.code, 0, chk.stderr);
  assert.equal(chk.json.ok, true);
});

test('cli: rule add, E_DUP_RULE exit 2, rule list', () => {
  const dir = setupPack();
  const rule = JSON.stringify({ id: 'r1', priority: 5, where: [{ field: 'amount', op: 'lt', value: 15 }] });
  const add = run(['rule', 'add', rule, '--dir', dir]);
  assert.equal(add.code, 0, add.stderr);
  assert.equal(add.json.ruleVersion, 1);
  const dup = run(['rule', 'add', rule, '--dir', dir]);
  assert.equal(dup.code, 2);
  assert.match(dup.stderr, /E_DUP_RULE/);
  const list = run(['rule', 'list', '--dir', dir]);
  assert.equal(list.json.rules.length, 1);
  // rule r1 excludes d1 (amount 10 < 15)
  const v = run(['verify', CLAIM, '--dir', dir]);
  assert.deepEqual(v.json.hits, ['d2', 'd3']);
  assert.deepEqual(v.json.excluded.d1, ['r1']);
});

test('cli: retract -> pass becomes undecided; E_EVIDENCE_GONE exit 3', () => {
  const dir = setupPack();
  const r = run(['retract', 'd3', '--dir', dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.scannedRows, 0);
  const v = run(['verify', CLAIM, '--dir', dir]);
  assert.equal(v.json.conclusion, 'undecided'); // not fail
  const gone = run(['retract', 'd3', '--dir', dir]);
  assert.equal(gone.code, 3);
  assert.match(gone.stderr, /E_EVIDENCE_GONE/);
});

test('cli: cert on undecided claim exits 4 with E_UNDECIDED', () => {
  const dir = setupPack();
  run(['retract', 'd3', '--dir', dir]);
  const c = run(['cert', CLAIM, '--dir', dir]);
  assert.equal(c.code, 4);
  assert.match(c.stderr, /E_UNDECIDED/);
});

test('cli: tampered cert exits 5 with E_CERT_MISMATCH', () => {
  const dir = setupPack();
  const certFile = path.join(dir, 'cert.json');
  run(['cert', CLAIM, '--dir', dir, '--out', certFile]);
  const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  cert.conclusion = 'fail'; // tamper
  fs.writeFileSync(certFile, JSON.stringify(cert, null, 2));
  const chk = run(['cert', '--check', certFile, '--dir', dir]);
  assert.equal(chk.code, 5);
  assert.match(chk.stderr, /E_CERT_MISMATCH/);
  // staleness: retract after issuance
  run(['cert', CLAIM, '--dir', dir, '--out', certFile]); // fresh cert
  run(['retract', 'd1', '--dir', dir]);
  const stale = run(['cert', '--check', certFile, '--dir', dir]);
  assert.equal(stale.code, 5);
});

test('cli: claim via @file and missing store error', () => {
  const dir = setupPack();
  const claimFile = path.join(dir, 'claim.json');
  fs.writeFileSync(claimFile, CLAIM);
  const v = run(['verify', `@${claimFile}`, '--dir', dir]);
  assert.equal(v.code, 0);
  assert.equal(v.json.conclusion, 'pass');
  const empty = tmpdir();
  const bad = run(['verify', CLAIM, '--dir', empty]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /run 'load <dir>' first/);
});
