import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../src/cli.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'qcert.js');

// Runs the CLI in-process and captures output (spawning node children is
// restricted in some sandboxes; exit-code propagation is covered separately).
function run(args) {
  const out = [];
  const err = [];
  const status = execute(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qcert-cli-'));
  const rule = join(dir, 'rule.dsl');
  const samples = join(dir, 'samples.jsonl');
  const cert = join(dir, 'cert.json');
  writeFileSync(rule, `
rule "cli" version 1 {
  param sampled: quantity
  param defects: quantity
  const max_defects: quantity = 1
  const min_sample: quantity = 2
  when defects > max_defects => REJECT
  when sampled >= min_sample and defects <= max_defects => ACCEPT
  otherwise => CONTINUE
}
`);
  writeFileSync(samples, `
{"type":"sample","id":"S1","defects":0}
{"type":"sample","id":"S2","defects":2}
`);
  return { dir, rule, samples, cert };
}

test('decide then verify: exit 0 and correct verdicts', () => {
  const { rule, samples, cert } = setup();
  const decided = run(['decide', rule, samples, '--cert', cert]);
  assert.equal(decided.status, 0, decided.stderr);
  assert.match(decided.stdout, /v1 REJECT \(ACTIVE\)/);

  const verified = run(['verify', cert]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /v1 REJECT ACTIVE ok/);
  assert.match(verified.stdout, /OK: 1 certificate\(s\) verified/);
});

test('correction then re-decide: old cert SUPERSEDED, still verifiable', () => {
  const { rule, samples, cert } = setup();
  assert.equal(run(['decide', rule, samples, '--cert', cert]).status, 0);
  writeFileSync(samples, `
{"type":"sample","id":"S1","defects":0}
{"type":"sample","id":"S2","defects":2}
{"type":"correction","id":"S2","defects":0,"reason":"label misread"}
`);
  const decided = run(['decide', rule, samples, '--cert', cert]);
  assert.equal(decided.status, 0, decided.stderr);
  assert.match(decided.stdout, /v2 ACCEPT \(ACTIVE\)/);

  const verified = run(['verify', cert]);
  assert.equal(verified.status, 0);
  assert.match(verified.stdout, /v1 REJECT SUPERSEDED ok/);
  assert.match(verified.stdout, /v2 ACCEPT ACTIVE ok/);
});

test('dsl parse error exits 2 and names the line', () => {
  const { rule, samples, cert } = setup();
  writeFileSync(rule, 'rule "x" version 1 {\n  param a: quantity\n  when a > => ACCEPT\n}\n');
  const result = run(['decide', rule, samples, '--cert', cert]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rule\.dsl:3:/);
});

test('dsl type error exits 2 with line number', () => {
  const { rule, samples, cert } = setup();
  writeFileSync(rule, 'rule "x" version 1 {\n  param a: quantity\n  when a > 5% => ACCEPT\n  otherwise => CONTINUE\n}\n');
  const result = run(['decide', rule, samples, '--cert', cert]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /rule\.dsl:3: cannot order-compare quantity with ratio/);
});

test('jsonl error exits 2 and names the line', () => {
  const { rule, samples, cert } = setup();
  writeFileSync(samples, '{"type":"sample","id":"S1"}\n{"bogus"\n');
  const result = run(['decide', rule, samples, '--cert', cert]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /samples\.jsonl:2: invalid JSON/);
});

test('illegal rollback exits 2, published decisions stay traceable', () => {
  const { rule, samples, cert } = setup();
  writeFileSync(samples, `
{"type":"sample","id":"S1","defects":0}
{"type":"sample","id":"S2","defects":2}
{"type":"correction","id":"S2","defects":0}
`);
  assert.equal(run(['decide', rule, samples, '--cert', cert]).status, 0);
  const result = run(['rollback', cert, '--to', '1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /illegal rollback/);
  const chain = JSON.parse(readFileSync(cert, 'utf8'));
  assert.equal(chain.certs.length, 2);
});

test('legal rollback of a draft exits 0', () => {
  const { rule, samples, cert } = setup();
  assert.equal(run(['decide', rule, samples, '--cert', cert]).status, 0);
  writeFileSync(samples, `
{"type":"sample","id":"S1","defects":0}
{"type":"sample","id":"S2","defects":2}
{"type":"correction","id":"S2","defects":0}
`);
  assert.equal(run(['decide', rule, samples, '--cert', cert, '--draft']).status, 0);
  const result = run(['rollback', cert, '--to', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /discarded 1 draft/);
  assert.equal(run(['verify', cert]).status, 0);
});

test('verify of a tampered chain exits 1', () => {
  const { rule, samples, cert } = setup();
  assert.equal(run(['decide', rule, samples, '--cert', cert]).status, 0);
  const chain = JSON.parse(readFileSync(cert, 'utf8'));
  chain.certs[0].decision = 'ACCEPT';
  writeFileSync(cert, JSON.stringify(chain, null, 2));
  const result = run(['verify', cert]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED/);
});

test('usage errors exit 2', () => {
  assert.equal(run(['decide']).status, 2);
  assert.equal(run(['verify']).status, 2);
  assert.equal(run(['frobnicate']).status, 2);
  assert.equal(run(['decide', 'missing.dsl', 'missing.jsonl', '--cert', 'x.json']).status, 2);
});

test('bin entry propagates exit codes to the process', () => {
  const { rule, samples, cert } = setup();
  const ok = spawnSync(process.execPath, [CLI, 'decide', rule, samples, '--cert', cert]);
  assert.equal(ok.status, 0);
  const verified = spawnSync(process.execPath, [CLI, 'verify', cert]);
  assert.equal(verified.status, 0);
  writeFileSync(rule, 'rule "x" version 1 {\n  when => ACCEPT\n}\n');
  const bad = spawnSync(process.execPath, [CLI, 'decide', rule, samples, '--cert', cert]);
  assert.equal(bad.status, 2);
});
