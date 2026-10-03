'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { run } = require(path.join(ROOT, 'cli.js'));

const FLOW = {
  states: ['draft', 'reviewed', 'cleared', 'archived'],
  roles: ['经办', '复核', '清算', '归档'],
  start: 'draft',
  accept: ['archived'],
  transitions: [
    { from: 'draft', role: '经办', to: 'reviewed' },
    { from: 'reviewed', role: '复核', to: 'cleared' },
    { from: 'cleared', role: '清算', to: 'archived' },
    { from: 'archived', role: '归档', to: 'archived' },
  ],
};

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-cli-'));
  const flowPath = path.join(dir, 'flow.json');
  fs.writeFileSync(flowPath, JSON.stringify(FLOW));
  const writeLog = (name, events) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return p;
  };
  return { dir, flowPath, writeLog };
}

function runCli(args) {
  return run(args);
}

test('CLI judge accepts a compliant log and exits 0', () => {
  const { flowPath, writeLog } = makeWorkspace();
  const logPath = writeLog('ok.jsonl', [
    { id: 'e1', ts: 1, role: '经办' },
    { id: 'e2', ts: 2, role: '复核' },
    { id: 'e3', ts: 3, role: '清算' },
  ]);
  const res = runCli(['judge', flowPath, logPath]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.verdict, 'accept');
  assert.equal(out.path.length, 4);
  assert.equal(out.proof.verdict, 'accept');
  assert.ok(out.proof.dfaHash.startsWith('sha256:'));
  assert.deepEqual(out.proof.eventIds, ['e1', 'e2', 'e3']);
});

test('CLI judge rejects with prefix and continuations, exit 1', () => {
  const { flowPath, writeLog } = makeWorkspace();
  const logPath = writeLog('bad.jsonl', [
    { id: 'e1', ts: 1, role: '经办' },
    { id: 'e2', ts: 2, role: '清算' },
  ]);
  const res = runCli(['judge', flowPath, logPath]);
  assert.equal(res.code, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.verdict, 'reject');
  assert.deepEqual(out.prefix, ['e1', 'e2']);
  assert.deepEqual(out.continuations, ['复核']);
});

test('CLI proof round-trip: --proof writes, --verify validates; tampering fails', () => {
  const { dir, flowPath, writeLog } = makeWorkspace();
  const logPath = writeLog('ok.jsonl', [
    { id: 'e1', ts: 1, role: '经办' },
    { id: 'e2', ts: 2, role: '复核' },
    { id: 'e3', ts: 3, role: '清算' },
  ]);
  const proofPath = path.join(dir, 'proof.json');
  const res1 = runCli(['judge', flowPath, logPath, '--proof', proofPath]);
  assert.equal(res1.code, 0, res1.stderr);
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  assert.equal(proof.verdict, 'accept');

  const res2 = runCli(['judge', flowPath, logPath, '--verify', proofPath]);
  assert.equal(res2.code, 0, res2.stderr);
  assert.equal(JSON.parse(res2.stdout).verification.ok, true);

  const tamperedPath = path.join(dir, 'tampered.json');
  const tampered = { ...proof, eventIds: proof.eventIds.slice() };
  tampered.eventIds[1] = 'forged';
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const res3 = runCli(['judge', flowPath, logPath, '--verify', tamperedPath]);
  assert.equal(res3.code, 1, res3.stderr);
  const out3 = JSON.parse(res3.stdout);
  assert.equal(out3.verification.ok, false);
  assert.equal(out3.verification.reason, 'EVENT_SEQUENCE_MISMATCH');
});

test('CLI reports TIME_REORDER with exit code 2', () => {
  const { flowPath, writeLog } = makeWorkspace();
  const logPath = writeLog('reorder.jsonl', [
    { id: 'e1', ts: 9, role: '经办' },
    { id: 'e2', ts: 3, role: '复核' },
  ]);
  const res = runCli(['judge', flowPath, logPath]);
  assert.equal(res.code, 2);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error, 'TIME_REORDER');
});

test('CLI reports NFA_EPSILON_ONLY with exit code 2', () => {
  const { dir, writeLog } = makeWorkspace();
  const flowPath = path.join(dir, 'eps.json');
  fs.writeFileSync(
    flowPath,
    JSON.stringify({
      states: ['a', 'b'],
      start: 'a',
      accept: ['b'],
      transitions: [{ from: 'a', to: 'b', epsilon: true }],
    })
  );
  const logPath = writeLog('any.jsonl', [{ id: 'e1', ts: 1, role: '经办' }]);
  const res = runCli(['judge', flowPath, logPath]);
  assert.equal(res.code, 2);
  assert.equal(JSON.parse(res.stderr).error, 'NFA_EPSILON_ONLY');
});
