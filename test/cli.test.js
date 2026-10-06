import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qcert.js');

const RULE = `rule "AQL" version 1 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param worst: defect_level
  let accept_max: quantity = 1
  decide {
    when worst >= critical -> REJECT
    when defects >= accept_max + 1 -> REJECT
    when sampled >= batch_size and defects <= accept_max -> ACCEPT
    otherwise -> CONTINUE
  }
}`;

const SAMPLES_ACCEPT = `{"type":"batch","id":"B-1","size":2}
{"id":"s1","defects":0}
{"id":"s2","defects":1,"level":"minor"}
`;
const SAMPLES_CORRECTED = `{"type":"batch","id":"B-1","size":2}
{"id":"s1","defects":0}
{"id":"s2","defects":0}
`;
const SAMPLES_REJECT = `{"type":"batch","id":"B-1","size":2}
{"id":"s1","defects":2,"level":"major"}
{"id":"s2","defects":0}
`;
const SAMPLES_CONTINUE = `{"type":"batch","id":"B-1","size":5}
{"id":"s1","defects":0}
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qcert-'));
  const rule = join(dir, 'rule.dsl');
  const samples = join(dir, 'samples.jsonl');
  const cert = join(dir, 'c.json');
  const store = join(dir, 's.store.json');
  const journal = join(dir, 'j.jsonl');
  writeFileSync(rule, RULE);
  return { dir, rule, samples, cert, store, journal };
}

function qcert(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('decide ACCEPT path exits 0 and writes a verifiable cert', () => {
  const { rule, samples, cert, store, journal } = setup();
  writeFileSync(samples, SAMPLES_ACCEPT);
  const d = qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /decision=ACCEPT/);
  const v = qcert(['verify', cert, '--journal', journal]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /status=ACTIVE/);
});

test('decide REJECT and CONTINUE paths exit 0 (CONTINUE is pending, not failure)', () => {
  const { rule, samples, cert, store, journal } = setup();
  writeFileSync(samples, SAMPLES_REJECT);
  const d1 = qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  assert.equal(d1.status, 0, d1.stderr);
  assert.match(d1.stdout, /decision=REJECT/);
  writeFileSync(samples, SAMPLES_CONTINUE);
  const d2 = qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  assert.equal(d2.status, 0, d2.stderr);
  assert.match(d2.stdout, /decision=CONTINUE/);
  assert.match(d2.stdout, /pending/);
});

test('correction re-decides: old cert stays verifiable but SUPERSEDED', () => {
  const { rule, samples, cert, store, journal } = setup();
  const cert2 = join(dirname(cert), 'c2.json');
  writeFileSync(samples, SAMPLES_ACCEPT);
  const d1 = qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  assert.equal(d1.status, 0, d1.stderr);
  assert.match(d1.stdout, /sample_version=1/);
  // label correction: s2 defects 1 -> 0
  writeFileSync(samples, SAMPLES_CORRECTED);
  const d2 = qcert(['decide', rule, samples, '--cert', cert2, '--store', store, '--journal', journal]);
  assert.equal(d2.status, 0, d2.stderr);
  assert.match(d2.stdout, /sample_version=2/);
  assert.match(d2.stdout, /superseded=1/);
  const vOld = qcert(['verify', cert, '--journal', journal]);
  assert.equal(vOld.status, 0, vOld.stderr);
  assert.match(vOld.stdout, /status=SUPERSEDED/);
  const vNew = qcert(['verify', cert2, '--journal', journal]);
  assert.match(vNew.stdout, /status=ACTIVE/);
  // old cert file was not deleted or rewritten
  const oldCert = JSON.parse(readFileSync(cert, 'utf8'));
  assert.equal(oldCert.sample_version, 1);
});

test('DSL syntax error exits 2 with line number', () => {
  const { rule, samples, cert, store, journal } = setup();
  writeFileSync(rule, 'rule "T" version 1 {\n  param n: quantity\n  decide { when n >= -> ACCEPT otherwise -> CONTINUE }\n}\n');
  writeFileSync(samples, SAMPLES_ACCEPT);
  const d = qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  assert.equal(d.status, 2);
  assert.match(d.stderr, /:3:/);
});

test('DSL type error exits 2 with line number', () => {
  const { rule, samples, cert, store, journal } = setup();
  writeFileSync(rule, 'rule "T" version 1 {\n  param n: quantity\n  decide { when n >= 5% -> ACCEPT otherwise -> CONTINUE }\n}\n');
  writeFileSync(samples, SAMPLES_ACCEPT);
  const d = qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  assert.equal(d.status, 2);
  assert.match(d.stderr, /:3:/);
});

test('bad samples line exits 2 with line number', () => {
  const { rule, samples, cert, store, journal } = setup();
  writeFileSync(samples, '{"type":"batch","id":"B-1","size":2}\n{"id":"s1","defects":}\n');
  const d = qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  assert.equal(d.status, 2);
  assert.match(d.stderr, /samples\.jsonl:2:/);
});

test('tampered certificate exits 1 on verify', () => {
  const { rule, samples, cert, store, journal } = setup();
  writeFileSync(samples, SAMPLES_ACCEPT);
  qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  const tampered = JSON.parse(readFileSync(cert, 'utf8'));
  tampered.decision = 'REJECT';
  writeFileSync(cert, JSON.stringify(tampered));
  const v = qcert(['verify', cert, '--journal', journal]);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /integrity check failed/);
});

test('illegal rollback (no uncommitted draft) exits 2', () => {
  const { rule, samples, cert, store, journal } = setup();
  writeFileSync(samples, SAMPLES_ACCEPT);
  qcert(['decide', rule, samples, '--cert', cert, '--store', store, '--journal', journal]);
  const r = qcert(['rollback', '--store', store]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /illegal rollback/);
});

test('draft then rollback succeeds and keeps committed versions', () => {
  const { samples, store } = setup();
  writeFileSync(samples, SAMPLES_ACCEPT);
  const c = qcert(['commit', samples, '--store', store]);
  assert.equal(c.status, 0, c.stderr);
  writeFileSync(samples, SAMPLES_CORRECTED);
  const d = qcert(['draft', samples, '--store', store]);
  assert.equal(d.status, 0, d.stderr);
  const r = qcert(['rollback', '--store', store]);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(readFileSync(store, 'utf8'));
  assert.equal(data.versions.length, 1);
  assert.equal(data.draft, null);
});

test('missing files and unknown commands exit 2', () => {
  const d = qcert(['decide', '/nonexistent.dsl', '/nonexistent.jsonl', '--cert', '/tmp/x.json']);
  assert.equal(d.status, 2);
  const u = qcert(['frobnicate']);
  assert.equal(u.status, 2);
});
