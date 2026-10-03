import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDir, write, runCli } from './helpers.js';
import { sha256Hex } from '../src/hash.js';

const RULES = `
param fee_rate: rate = 0.0015r
param vat_rate: rate = 0.06r

rule fee(amount: money, day: date) -> money {
  amount * fee_rate
}

rule tax(amount: money, day: date) -> money {
  fee(amount, day) * vat_rate
}

rule net(amount: money, day: date) -> money {
  amount - fee(amount, day) - tax(amount, day)
}
`;

function setup(inputOverrides = {}) {
  const dir = makeDir();
  const rules = write(dir, 'rules.stl', RULES);
  const input = write(dir, 'input.json', JSON.stringify({
    rulesHash: sha256Hex(RULES),
    flows: [{ id: 't1', amount: '1000.00', date: '2024-01-15' }],
    ...inputOverrides,
  }));
  return { dir, rules, input };
}

test('run writes a certificate and prints per-flow results', async () => {
  const { dir, rules, input } = setup();
  const cert = `${dir}/cert.json`;
  const res = await runCli(['run', rules, input, '--cert', cert]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.results, [{ id: 't1', fee: '1.50', tax: '0.09', net: '998.41' }]);
  const certJson = JSON.parse(readFileSync(cert, 'utf8'));
  assert.equal(certJson.version, 1);
  assert.ok(certJson.rulesHash.fee.startsWith('sha256:'));
  assert.ok(certJson.inputHash.startsWith('sha256:'));
  assert.ok(certJson.bytecodeHash.net.startsWith('sha256:'));
  assert.equal(typeof certJson.traceSummary.steps, 'number');
  assert.ok(certJson.traceSummary.hash.startsWith('sha256:'));
});

test('verify replays a certificate; tampering is detected', async () => {
  const { dir, rules, input } = setup();
  const cert = `${dir}/cert.json`;
  assert.equal((await runCli(['run', rules, input, '--cert', cert])).status, 0);
  const ok = await runCli(['verify', rules, input, '--cert', cert]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);

  const tampered = JSON.parse(readFileSync(cert, 'utf8'));
  tampered.results[0].fee = '9.99';
  write(dir, 'cert.json', JSON.stringify(tampered));
  const bad = await runCli(['verify', rules, input, '--cert', cert]);
  assert.notEqual(bad.status, 0);
  assert.equal(JSON.parse(bad.stderr).error.code, 'E_RT');
});

test('rules hash mismatch between input and rules file is E_RT', async () => {
  const { rules, input } = setup({ rulesHash: 'sha256:deadbeef' });
  const res = await runCli(['run', rules, input, '--cert', '/tmp/nope.json']);
  assert.notEqual(res.status, 0);
  const err = JSON.parse(res.stderr).error;
  assert.equal(err.code, 'E_RT');
  assert.match(err.message, /rules hash mismatch/);
});

test('DSL errors are reported as JSON with code, line and col; exit code is non-zero', async () => {
  const dir = makeDir();
  const rules = write(dir, 'bad.stl', 'let x: money = 1.005\n');
  const input = write(dir, 'input.json', JSON.stringify({ rulesHash: sha256Hex('let x: money = 1.005\n'), flows: [] }));
  const res = await runCli(['run', rules, input, '--cert', `${dir}/c.json`]);
  assert.notEqual(res.status, 0);
  const err = JSON.parse(res.stderr).error;
  assert.equal(err.code, 'E_LEX');
  assert.equal(err.line, 1);
  assert.equal(err.col, 16);
});

test('invalid money amount in input flows is E_LEX', async () => {
  const { rules, input } = setup({ flows: [{ id: 'bad', amount: '1.005', date: '2024-01-15' }] });
  const res = await runCli(['run', rules, input, '--cert', '/tmp/nope.json']);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).error.code, 'E_LEX');
});

test('hash command prints file and per-rule hashes', async () => {
  const { rules } = setup();
  const res = await runCli(['hash', rules]);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.file, sha256Hex(RULES));
  assert.ok(out.rules.fee.startsWith('sha256:'));
  assert.ok(out.globals.fee_rate.startsWith('sha256:'));
});
