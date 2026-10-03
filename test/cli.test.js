'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cli-'));
}

function runCli(args) {
  const out = { stdout: '', stderr: '' };
  const code = run(['node', 'cli.js', ...args], {
    stdout: (s) => { out.stdout += s; },
    stderr: (s) => { out.stderr += s; },
  });
  return { code, ...out };
}

function writeEvents(dir, events) {
  const file = path.join(dir, `events-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(events), 'utf8');
  return file;
}

const INIT = {
  type: 'init',
  tolerance: 10,
  bankEntries: [{ id: 'B1', amount: 100 }],
  ledgerEntries: [{ id: 'L1', amount: 60 }, { id: 'L2', amount: 40 }],
};

test('CLI applies events, persists them, and replays to the same state hash', () => {
  const dir = makeWorkspace();
  const workdir = path.join(dir, 'work');
  const eventsFile = writeEvents(dir, [INIT, { type: 'suggest' }, { type: 'confirm', candidate: 1 }]);

  const first = runCli([eventsFile, workdir]);
  assert.equal(first.code, 0, first.stderr);
  const out1 = JSON.parse(first.stdout);
  assert.equal(out1.ok, true);
  assert.equal(out1.matches.length, 1);
  assert.equal(out1.matches[0].id, 'M1');
  assert.deepEqual(out1.matches[0].ledgerIds, ['L1', 'L2']);
  assert.match(out1.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(out1.eventsApplied, 3);

  const logLines = fs.readFileSync(path.join(workdir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(logLines.length, 3);
  const suggestRecord = JSON.parse(logLines[1]);
  assert.equal(suggestRecord.event.type, 'suggest');
  assert.equal(suggestRecord.result.candidates.length, 1);
  assert.equal(suggestRecord.result.candidates[0].status, 'suggested');

  const second = runCli([writeEvents(dir, []), workdir]);
  assert.equal(second.code, 0, second.stderr);
  const out2 = JSON.parse(second.stdout);
  assert.equal(out2.stateHash, out1.stateHash);
  assert.deepEqual(out2.certificate, out1.certificate);
  assert.equal(out2.eventsApplied, 3);
});

test('CLI reports errors as JSON on stderr with exit code 1', () => {
  const dir = makeWorkspace();
  const workdir = path.join(dir, 'work');

  const badConfirm = writeEvents(dir, [INIT, { type: 'confirm', candidate: 99 }]);
  const res1 = runCli([badConfirm, workdir]);
  assert.equal(res1.code, 1);
  assert.equal(res1.stdout, '');
  const err1 = JSON.parse(res1.stderr);
  assert.equal(err1.ok, false);
  assert.equal(err1.error.code, 'CANDIDATE_NOT_FOUND');
  assert.equal(fs.existsSync(path.join(workdir, 'events.jsonl')), false);

  const res2 = runCli([path.join(dir, 'missing.json'), workdir]);
  assert.equal(res2.code, 1);
  assert.equal(JSON.parse(res2.stderr).error.code, 'EVENTS_FILE_UNREADABLE');

  const notJson = path.join(dir, 'not.json');
  fs.writeFileSync(notJson, '{oops', 'utf8');
  const res3 = runCli([notJson, workdir]);
  assert.equal(res3.code, 1);
  assert.equal(JSON.parse(res3.stderr).error.code, 'EVENTS_FILE_INVALID_JSON');

  const res4 = runCli([badConfirm]);
  assert.equal(res4.code, 1);
  assert.equal(JSON.parse(res4.stderr).error.code, 'USAGE');
});

test('CLI rejects a tampered log instead of replaying it silently', () => {
  const dir = makeWorkspace();
  const workdir = path.join(dir, 'work');
  const eventsFile = writeEvents(dir, [INIT, { type: 'suggest' }]);
  const first = runCli([eventsFile, workdir]);
  assert.equal(first.code, 0, first.stderr);

  const logPath = path.join(workdir, 'events.jsonl');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.result.candidates[0].status = 'confirmed';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');

  const second = runCli([writeEvents(dir, []), workdir]);
  assert.equal(second.code, 1);
  assert.equal(JSON.parse(second.stderr).error.code, 'LOG_MISMATCH');
});
