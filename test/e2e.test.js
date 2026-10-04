'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { sha256 } = require('../src/hash');

const BIN = path.join(__dirname, '..', 'bin', 'settle.js');
const RULES = path.join(__dirname, '..', 'examples', 'rules.stl');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
}

// NOTE: this sandbox drops piped stdout of grandchild node processes,
// so capture output via files instead of stdio pipes.
function runCli(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));
  const out = path.join(dir, 'out.txt');
  const err = path.join(dir, 'err.txt');
  const quoted = [process.execPath, BIN, ...args].map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const r = spawnSync('bash', ['-c', `${quoted} > '${out}' 2> '${err}'`], { encoding: 'utf8' });
  return {
    status: r.status,
    stdout: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '',
    stderr: fs.existsSync(err) ? fs.readFileSync(err, 'utf8') : '',
  };
}

test('run produces certificate and verify replays it', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  const cert = path.join(dir, 'cert.json');
  const rulesHash = sha256(fs.readFileSync(RULES, 'utf8'));
  fs.writeFileSync(input, JSON.stringify({
    rules_hash: rulesHash,
    flows: [
      { id: 'a', amount: '1234.56', date: '2026-10-01' },
      { id: 'b', amount: '5.00', date: '2026-10-02' },
    ],
  }));

  const run = runCli(['run', RULES, input, '--cert', cert]);
  assert.equal(run.status, 0, run.stderr);
  const certJson = JSON.parse(fs.readFileSync(cert, 'utf8'));
  assert.equal(certJson.rules_hash, rulesHash);
  assert.match(certJson.input_hash, /^[0-9a-f]{64}$/);
  assert.match(certJson.bytecode_hash, /^[0-9a-f]{64}$/);
  assert.match(certJson.trace.digest, /^[0-9a-f]{64}$/);
  assert.ok(certJson.trace.instructions > 0);
  assert.deepEqual(certJson.results, [
    { id: 'a', fee: '1.85', tax: '0.11', net: '1232.60' },
    { id: 'b', fee: '0.01', tax: '0.00', net: '4.99' },
  ]);

  const verify = runCli(['verify', RULES, input, '--cert', cert]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.deepEqual(JSON.parse(verify.stdout), { ok: true, flows: 2 });
});

test('verify fails when the certificate is tampered with', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  const cert = path.join(dir, 'cert.json');
  fs.writeFileSync(input, JSON.stringify({ flows: [{ id: 'a', amount: '10.00', date: '2026-10-01' }] }));
  assert.equal(runCli(['run', RULES, input, '--cert', cert]).status, 0);
  const tampered = JSON.parse(fs.readFileSync(cert, 'utf8'));
  tampered.results[0].fee = '999.99';
  fs.writeFileSync(cert, JSON.stringify(tampered));
  const verify = runCli(['verify', RULES, input, '--cert', cert]);
  assert.equal(verify.status, 1);
  assert.equal(JSON.parse(verify.stdout).ok, false);
});

test('rules hash mismatch in input is E_RT with non-zero exit', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(input, JSON.stringify({
    rules_hash: '0'.repeat(64),
    flows: [{ id: 'a', amount: '10.00', date: '2026-10-01' }],
  }));
  const r = runCli(['run', RULES, input, '--cert', path.join(dir, 'c.json')]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stderr);
  assert.equal(err.code, 'E_RT');
  assert.match(err.message, /rules hash mismatch/);
});

test('CLI reports lex/scope errors as JSON with code, line, col', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'input.json');
  fs.writeFileSync(input, JSON.stringify({ flows: [] }));

  const lexRules = path.join(dir, 'lex.stl');
  fs.writeFileSync(lexRules, 'let x: money = 1.005m;\n');
  const r1 = runCli(['run', lexRules, input, '--cert', path.join(dir, 'c1.json')]);
  assert.equal(r1.status, 1);
  const e1 = JSON.parse(r1.stderr);
  assert.equal(e1.code, 'E_LEX');
  assert.equal(e1.line, 1);
  assert.ok(e1.col > 0);

  const scopeRules = path.join(dir, 'scope.stl');
  fs.writeFileSync(scopeRules, 'let x: money = missing + 1m;\n');
  const r2 = runCli(['run', scopeRules, input, '--cert', path.join(dir, 'c2.json')]);
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stderr).code, 'E_SCOPE');
});
