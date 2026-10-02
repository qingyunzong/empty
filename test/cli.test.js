'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../cli');
const { GENESIS, chainHash } = require('../lib/audit');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-'));
}

// Invoke the CLI entry in-process, capturing stderr and the exit code.
function runCli(args) {
  let errBuf = '';
  const code = run(args, { stderr: (s) => { errBuf += s; } });
  return { code, stderr: errBuf };
}

const POLICY = [
  '{"type":"role","role":"ops","inherits":["base"]}',
  '{"type":"role","role":"base"}',
  '{"type":"rule","id":"r1","role":"base","resource":"merchant:*","effect":"allow"}',
  '{"type":"rule","id":"r2","role":"ops","resource":"merchant:9","effect":"deny"}',
  '{"type":"revoke","role":"ops","at":"2026-02-01T00:00:00Z"}',
].join('\n') + '\n';

const EVENTS = [
  '{"type":"authorize","id":"e1","role":"ops","resource":"merchant:1","at":"2026-01-10T00:00:00Z"}',
  '{"type":"authorize","id":"e2","role":"ops","resource":"merchant:9","at":"2026-01-10T00:00:00Z"}',
  '{"type":"authorize","id":"e3","role":"ops","resource":"merchant:1","at":"2026-02-10T00:00:00Z"}',
].join('\n') + '\n';

function setup(policyText, eventsText) {
  const dir = tmpdir();
  const policyPath = path.join(dir, 'policy.jsonl');
  const eventsPath = path.join(dir, 'events.jsonl');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(policyPath, policyText);
  fs.writeFileSync(eventsPath, eventsText);
  return { dir, policyPath, eventsPath, outDir };
}

test('CLI writes decisions.jsonl and a verifiable audit.json hash chain', () => {
  const { policyPath, eventsPath, outDir } = setup(POLICY, EVENTS);
  const res = runCli([policyPath, eventsPath, outDir]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');

  const lines = fs.readFileSync(path.join(outDir, 'decisions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const decisions = lines.map((l) => JSON.parse(l));
  assert.equal(decisions[0].decision, 'allow');
  assert.deepEqual(decisions[0].path, ['ops', 'base']);
  assert.equal(decisions[1].decision, 'deny');
  assert.equal(decisions[1].rule, 'r2');
  assert.equal(decisions[2].decision, 'deny');
  assert.equal(decisions[2].reason, 'role_revoked');

  const audit = JSON.parse(fs.readFileSync(path.join(outDir, 'audit.json'), 'utf8'));
  assert.equal(audit.count, 3);
  assert.equal(audit.entries.length, 3);
  let prev = GENESIS;
  lines.forEach((line, i) => {
    prev = chainHash(prev, line);
    assert.equal(audit.entries[i].hash, prev);
  });
  assert.equal(audit.finalHash, prev);
});

test('CLI reports malformed JSONL line as {error:{code,line}} on stderr, exit 1', () => {
  const { policyPath, eventsPath, outDir } = setup('{"type":"role","role":"a"}\nnot json\n', '');
  const res = runCli([policyPath, eventsPath, outDir]);
  assert.equal(res.code, 1);
  assert.deepEqual(JSON.parse(res.stderr.trim()), { error: { code: 'E_PARSE', line: 2 } });
  assert.ok(!fs.existsSync(path.join(outDir, 'decisions.jsonl')));
});

test('CLI reports E_CYCLE from policy file with line number', () => {
  const { policyPath, eventsPath, outDir } = setup([
    '{"type":"role","role":"a","inherits":["b"]}',
    '{"type":"role","role":"b","inherits":["a"]}',
  ].join('\n'), '');
  const res = runCli([policyPath, eventsPath, outDir]);
  assert.equal(res.code, 1);
  assert.deepEqual(JSON.parse(res.stderr.trim()), { error: { code: 'E_CYCLE', line: 2 } });
});

test('CLI reports schema errors in events with line number', () => {
  const { policyPath, eventsPath, outDir } = setup('{"type":"role","role":"a"}\n', [
    '{"type":"authorize","id":"e1","role":"a","resource":"r","at":"2026-01-01T00:00:00Z"}',
    '{"type":"authorize","id":"e2","role":"a","resource":"r"}',
  ].join('\n'));
  const res = runCli([policyPath, eventsPath, outDir]);
  assert.equal(res.code, 1);
  assert.deepEqual(JSON.parse(res.stderr.trim()), { error: { code: 'E_SCHEMA', line: 2 } });
});

test('CLI works as a real subprocess: node cli.js policy.jsonl events.jsonl out/', (t) => {
  const { policyPath, eventsPath, outDir } = setup(POLICY, EVENTS);
  const res = spawnSync(process.execPath, [CLI, policyPath, eventsPath, outDir], { encoding: 'utf8' });
  if (res.error && res.error.code === 'EPERM') {
    t.skip('sandbox blocks child processes');
    return;
  }
  assert.equal(res.status, 0, res.stderr);
  const lines = fs.readFileSync(path.join(outDir, 'decisions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(fs.existsSync(path.join(outDir, 'audit.json')));
});
