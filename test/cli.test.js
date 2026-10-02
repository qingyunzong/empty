'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main } = require('../cli');
const { txHashOf } = require('../lib/machine');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'revoke-test-'));
}

// In-process CLI invocation with captured JSONL stdout / stderr text.
function runCli(args) {
  const stdoutLines = [];
  let stderr = '';
  const status = main(args, {
    stdout: (obj) => stdoutLines.push(JSON.stringify(obj)),
    stderr: (text) => { stderr += text + '\n'; },
  });
  return { status, stdout: stdoutLines.join('\n'), stderr };
}

function writeEvents(dir, events) {
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const t1 = { id: 't1', type: 'tx', logicalClock: 1, amount: 100 };
const r1 = { id: 'r1', type: 'revoke', logicalClock: 2, txHash: txHashOf(t1), amount: 100 };
const u1 = { id: 'u1', type: 'unrevoke', logicalClock: 3, revokeId: 'r1', amount: 100 };

test('cli apply emits cert JSONL and final summary; verify passes', () => {
  const dir = tmpdir();
  const eventsFile = writeEvents(dir, [t1, r1, u1]);
  const stateFile = path.join(dir, 'state.json');

  const apply = runCli(['apply', eventsFile, stateFile]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(apply.stderr, '');

  const lines = apply.stdout.split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4); // 3 certs + final
  assert.deepEqual(lines.slice(0, 3).map((l) => l.type), ['cert', 'cert', 'cert']);
  assert.equal(lines[0].prevHash, '0'.repeat(64));
  assert.equal(lines[1].prevHash, lines[0].hash);
  assert.equal(lines[2].prevHash, lines[1].hash);
  const final = lines[3];
  assert.equal(final.type, 'final');
  assert.equal(final.balance, 100);
  assert.equal(final.revocable, 100);
  assert.match(final.head, /^[0-9a-f]{64}$/);

  const verify = runCli(['verify', stateFile]);
  assert.equal(verify.status, 0, verify.stderr);
  const v = JSON.parse(verify.stdout);
  assert.equal(v.type, 'verify');
  assert.equal(v.ok, true);
  assert.equal(v.steps, 3);
});

test('cli apply handles out-of-order events identically', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  assert.equal(runCli(['apply', writeEvents(dir, [t1, r1, u1]), a]).status, 0);
  assert.equal(runCli(['apply', writeEvents(dir, [u1, t1, r1]), b]).status, 0);
  const sa = JSON.parse(fs.readFileSync(a, 'utf8'));
  const sb = JSON.parse(fs.readFileSync(b, 'utf8'));
  assert.equal(sa.head, sb.head);
  assert.deepEqual(sa.state, sb.state);
});

test('cli verify rejects forged prevHash with E_CERT on stderr, exit 1', () => {
  const dir = tmpdir();
  const eventsFile = writeEvents(dir, [t1, r1, u1]);
  const stateFile = path.join(dir, 'state.json');
  assert.equal(runCli(['apply', eventsFile, stateFile]).status, 0);

  const bundle = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  bundle.certs[1].prevHash = 'f'.repeat(64);
  fs.writeFileSync(stateFile, JSON.stringify(bundle, null, 2));

  const verify = runCli(['verify', stateFile]);
  assert.equal(verify.status, 1);
  assert.match(verify.stderr, /^E_CERT: /);
  assert.equal(verify.stdout, '');
});

test('cli apply rejects over-revoke with E_AMOUNT on stderr, exit 1', () => {
  const dir = tmpdir();
  const rBad = { id: 'r2', type: 'revoke', logicalClock: 2, txHash: txHashOf(t1), amount: 101 };
  const eventsFile = writeEvents(dir, [t1, rBad]);
  const stateFile = path.join(dir, 'state.json');
  const res = runCli(['apply', eventsFile, stateFile]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^E_AMOUNT: /);
  assert.equal(fs.existsSync(stateFile), false);
});

test('cli with no args prints usage error and exits 1', () => {
  const res = runCli([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^E_USAGE: /);
});

test('cli apply rejects malformed JSONL with E_PARSE, exit 1', () => {
  const dir = tmpdir();
  const eventsFile = path.join(dir, 'events.jsonl');
  fs.writeFileSync(eventsFile, '{"id":"t1"\n');
  const res = runCli(['apply', eventsFile, path.join(dir, 'state.json')]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^E_PARSE: /);
});

test('spawned CLI process: apply then verify, exit codes and JSONL', (t) => {
  const dir = tmpdir();
  const eventsFile = writeEvents(dir, [t1, r1, u1]);
  const stateFile = path.join(dir, 'state.json');
  const apply = spawnSync(process.execPath, [CLI, 'apply', eventsFile, stateFile], { encoding: 'utf8' });
  if (apply.error && apply.error.code === 'EPERM') {
    t.skip('sandbox disallows spawning child processes');
    return;
  }
  assert.equal(apply.status, 0, apply.stderr);
  const lines = apply.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.equal(lines[3].type, 'final');

  const verify = spawnSync(process.execPath, [CLI, 'verify', stateFile], { encoding: 'utf8' });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout.trim()).ok, true);

  const bundle = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  bundle.certs[0].stateHash = '0'.repeat(64);
  fs.writeFileSync(stateFile, JSON.stringify(bundle));
  const forged = spawnSync(process.execPath, [CLI, 'verify', stateFile], { encoding: 'utf8' });
  assert.equal(forged.status, 1);
  assert.match(forged.stderr, /^E_CERT: /);
});
