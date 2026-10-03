import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

const EX_RULES = new URL('../examples/rules.net', import.meta.url).pathname;
const EX_OBS = new URL('../examples/obs.json', import.meta.url).pathname;

function runCli(args) {
  const out = [];
  const err = [];
  const code = main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('net run writes a proof and prints a summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-'));
  const proofPath = join(dir, 'proof.json');
  const r = runCli(['run', EX_RULES, EX_OBS, '--proof', proofPath]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /USD: obligations=5 gross=49750 minCash=0 solutions=1/);
  assert.match(r.stdout, /cycle M1>M2>M3>M4>M5 amount=9950/);
  assert.ok(existsSync(proofPath));
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  assert.equal(proof.currencies.USD.minCash, 0);
  assert.equal(proof.currencies.USD.solutions[0].cycles[0].cycle, 'M1>M2>M3>M4>M5');
});

test('CLI exits 1 with E_PARSE on broken rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-'));
  const rules = join(dir, 'bad.net');
  writeFileSync(rules, 'nettable = amount +;\n');
  const r = runCli(['run', rules, EX_OBS]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_PARSE/);
});

test('CLI exits 1 with E_CCY on currency mixing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-'));
  const rules = join(dir, 'ccy.net');
  writeFileSync(rules, 'const X = 1 USD + 1 EUR;\n');
  const r = runCli(['run', rules, EX_OBS]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_CCY/);
});

test('CLI exits 1 with E_NO_SOL when nothing is selected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'net-'));
  const rules = join(dir, 'none.net');
  writeFileSync(rules, 'filter currency == JPY;\n');
  const r = runCli(['run', rules, EX_OBS]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /E_NO_SOL/);
});

test('CLI usage error exits 2', () => {
  const r = runCli([]);
  assert.equal(r.code, 2);
});
