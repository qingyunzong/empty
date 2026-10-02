'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../cli');
const { flowLinear } = require('./helpers');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-'));
}

function writeFixtures(dir, events) {
  const flowPath = path.join(dir, 'flow.json');
  const logPath = path.join(dir, 'log.jsonl');
  fs.writeFileSync(flowPath, JSON.stringify(flowLinear));
  fs.writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { flowPath, logPath };
}

const okEvents = [
  { id: 'e1', ts: 1, role: '经办' },
  { id: 'e2', ts: 2, role: '复核' },
  { id: 'e3', ts: 3, role: '清算' },
  { id: 'e4', ts: 4, role: '归档' },
];

test('cli judge accept: exit 0 with verdict/proof/path', () => {
  const dir = tmpdir();
  const { flowPath, logPath } = writeFixtures(dir, okEvents);
  const { code, output } = run(['judge', flowPath, logPath]);
  assert.equal(code, 0);
  assert.equal(output.verdict, 'accept');
  assert.equal(output.proof.eventIds.length, 4);
  assert.match(output.proof.dfaHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(output.path.roles, ['经办', '复核', '清算', '归档']);
});

test('cli judge reject: exit 1 with prefix and continuations', () => {
  const dir = tmpdir();
  const { flowPath, logPath } = writeFixtures(dir, okEvents.slice(0, 2));
  const { code, output } = run(['judge', flowPath, logPath]);
  assert.equal(code, 1);
  assert.equal(output.verdict, 'reject');
  assert.deepEqual(output.prefix.map((e) => e.id), ['e1', 'e2']);
  assert.deepEqual(output.continuations, ['清算']);
});

test('cli judge TIME_REORDER: exit 2 with error code', () => {
  const dir = tmpdir();
  const bad = [okEvents[0], { id: 'e2', ts: 0, role: '复核' }];
  const { flowPath, logPath } = writeFixtures(dir, bad);
  const { code, output } = run(['judge', flowPath, logPath]);
  assert.equal(code, 2);
  assert.equal(output.error, 'TIME_REORDER');
});

test('cli judge ID_REUSE: exit 2 with error code', () => {
  const dir = tmpdir();
  const bad = [okEvents[0], { id: 'e1', ts: 2, role: '复核' }];
  const { flowPath, logPath } = writeFixtures(dir, bad);
  const { code, output } = run(['judge', flowPath, logPath]);
  assert.equal(code, 2);
  assert.equal(output.error, 'ID_REUSE');
});

test('cli NFA_EPSILON_ONLY: exit 2 with error code', () => {
  const dir = tmpdir();
  const { flowPath, logPath } = writeFixtures(dir, okEvents);
  fs.writeFileSync(flowPath, JSON.stringify({
    states: ['a', 'b'], start: 'a', accept: ['b'], transitions: [['a', 'ε', 'b']],
  }));
  const { code, output } = run(['judge', flowPath, logPath]);
  assert.equal(code, 2);
  assert.equal(output.error, 'NFA_EPSILON_ONLY');
});

test('cli --verify: valid proof passes, tampered proof fails with exit 3', () => {
  const dir = tmpdir();
  const { flowPath, logPath } = writeFixtures(dir, okEvents);
  const first = run(['judge', flowPath, logPath]);
  const proof = first.output.proof;

  const proofPath = path.join(dir, 'proof.json');
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  const okRun = run(['judge', flowPath, logPath, '--verify', proofPath]);
  assert.equal(okRun.code, 0);
  assert.equal(okRun.output.verification.ok, true);

  const tampered = { ...proof, eventIds: [...proof.eventIds] };
  tampered.eventIds[1] = 'forged';
  fs.writeFileSync(proofPath, JSON.stringify(tampered));
  const badRun = run(['judge', flowPath, logPath, '--verify', proofPath]);
  assert.equal(badRun.code, 3);
  assert.equal(badRun.output.verification.ok, false);
});

test('cli usage error: exit 2', () => {
  const { code, output } = run(['judge']);
  assert.equal(code, 2);
  assert.equal(output.error, 'USAGE');
});
